/**
 * fundFromVault against Postgres and the simulated PayPal: the funding guarantee, the booking, and retries that never
 * charge twice. Opt in: MILESTONE_E2E=1 with DATABASE_URL pointing at a scratch database. Every row it writes is removed.
 */
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  AUDIT_EVENTS,
  agentActor,
  contracts,
  createDb,
  createMandate,
  loadMilestone,
  milestones,
  savePaymentMethod,
  users,
  type AgentMandate,
  type PaymentMethod,
} from "@milestone/core";
import { approveSimulatedSetupToken, armSimulatedVaultCharge, configureSimulator, createSimulatedPayPalClient, resetSimulator, simulatedFetch } from "../src/paypal/simulated.ts";
import { PayPalClient } from "../src/paypal/client.ts";
import { completeVaultSetup, createPaymentToken, createSetupToken, getPaymentToken, removeVaultPaymentMethod, startVaultSetup } from "../src/paypal/vault.ts";
import { autoFundNextMilestone, fundFromVault, type VaultFundResult } from "../src/policy/execute.ts";
import type { WebhookEvent } from "../src/paypal/webhooks.ts";

if (!process.env.DATABASE_URL) {
  try { process.loadEnvFile(resolve(__dirname, "../../../.env")); } catch { /* opt-in test */ }
}

const on = process.env.MILESTONE_E2E === "1";

describe.skipIf(!on)("fundFromVault (e2e)", () => {
  const db = on ? createDb() : (undefined as unknown as ReturnType<typeof createDb>);
  const tag = randomUUID().slice(0, 8);
  const client = `usr_vc_${tag}`;
  const other = `usr_vo_${tag}`;
  const freelancer = `usr_vf_${tag}`;
  const contractIds: string[] = [];
  const milestoneIds: string[] = [];
  const events: WebhookEvent[] = [];
  const now = new Date();
  const paypal = () => createSimulatedPayPalClient();
  const ctx = () => ({ db, client: paypal() });
  let pm: PaymentMethod;
  let otherPm: PaymentMethod;

  async function vaultedToken(tagged: string) {
    const c = paypal();
    const setup = await createSetupToken(c, { requestId: `setup-${tag}-${tagged}`, returnUrl: "http://app.test/r", cancelUrl: "http://app.test/c", description: "t" });
    approveSimulatedSetupToken(setup.setupTokenId);
    return createPaymentToken(c, { requestId: `token-${tag}-${tagged}`, setupTokenId: setup.setupTokenId });
  }

  /** An approved (active) contract of `clientId` with milestones of these amounts, all draft. */
  async function contract(name: string, amounts: number[], opts: { clientId?: string; status?: "draft" | "active" } = {}) {
    const id = `ctr_v_${tag}_${name}`;
    contractIds.push(id);
    const active = (opts.status ?? "active") === "active";
    await db.insert(contracts).values({ id, clientId: opts.clientId ?? client, freelancerId: freelancer, title: name, scopeText: "t", currency: "USD", totalMinor: amounts.reduce((a, b) => a + b, 0), status: opts.status ?? "active", clientApprovedAt: active ? now : null, freelancerApprovedAt: active ? now : null });
    const ids = amounts.map((_, i) => `mst_v_${tag}_${name}_${i + 1}`);
    milestoneIds.push(...ids);
    await db.insert(milestones).values(amounts.map((amountMinor, i) => ({ id: ids[i]!, contractId: id, seq: i + 1, title: `${name} ${i + 1}`, amountMinor })));
    return ids;
  }

  async function mandate(over: { fundCapMinor?: number | null; fundTotalCapMinor?: number | null; autoFundNext?: boolean; userId?: string; actions?: Array<"read" | "fund" | "approve"> } = {}) {
    const { mandate: m } = await createMandate(db, {
      userId: over.userId ?? client,
      agentName: `vault agent ${randomUUID().slice(0, 4)}`,
      actions: over.actions ?? ["read", "fund"],
      fundCapMinor: over.fundCapMinor === undefined ? 20_000 : over.fundCapMinor,
      fundTotalCapMinor: over.fundTotalCapMinor === undefined ? 30_000 : over.fundTotalCapMinor,
      autoFundNext: over.autoFundNext ?? false,
      currency: "USD",
      expiresAt: new Date(now.getTime() + 86_400_000),
    });
    return m;
  }

  async function fund(m: AgentMandate, milestoneId: string, opts: { paymentMethod?: PaymentMethod | null; client?: PayPalClient; via?: "mcp" | "auto_fund" } = {}): Promise<VaultFundResult> {
    const found = await loadMilestone(db, milestoneId);
    if (!found) throw new Error(`no ${milestoneId}`);
    return fundFromVault({ db, client: opts.client ?? paypal() }, {
      mandate: m,
      paymentMethod: opts.paymentMethod === undefined ? pm : opts.paymentMethod,
      milestone: found.milestone,
      contract: found.contract,
      via: opts.via ?? "mcp",
      baselineSha: async () => "baseline-sha-1",
    });
  }

  const q = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) => (await db.$client.query(text, params)).rows as T[];
  const captureEvents = (milestoneOrder: string | null) => events.filter((e) => e.event_type === "PAYMENT.CAPTURE.COMPLETED" && (milestoneOrder === null || (e.resource as { supplementary_data?: { related_ids?: { order_id?: string } } }).supplementary_data?.related_ids?.order_id === milestoneOrder));
  const settle = () => new Promise((r) => setTimeout(r, 40));

  beforeAll(async () => {
    configureSimulator({ stateFile: null, webhookDelayMs: 5, deliver: (e) => void events.push(e), appUrl: "http://app.test" });
    resetSimulator();
    await db.insert(users).values([
      { id: client, role: "client", name: "c", email: `${tag}c@t.test` },
      { id: other, role: "client", name: "o", email: `${tag}o@t.test` },
      { id: freelancer, role: "freelancer", name: "f", email: `${tag}f@t.test`, paypalEmail: `${tag}f@t.test` },
    ]);
    const t1 = await vaultedToken("c");
    pm = await savePaymentMethod(db, { userId: client, paymentTokenId: t1.paymentTokenId, customerId: t1.customerId, payerEmail: t1.payerEmail });
    const t2 = await vaultedToken("o");
    otherPm = await savePaymentMethod(db, { userId: other, paymentTokenId: t2.paymentTokenId, customerId: t2.customerId, payerEmail: t2.payerEmail });
  });

  beforeEach(() => {
    events.length = 0;
  });

  afterAll(async () => {
    if (!on) return;
    const users3 = [client, other, freelancer];
    await q(`delete from audit_log where milestone_id = any($1) or contract_id = any($2) or actor like $3`, [milestoneIds, contractIds, `agent:% for usr_v%_${tag}`]);
    await q(`delete from ledger_entries where account = any($1) or account = any($2)`, [milestoneIds.map((m) => `held:${m}`), users3.map((u) => `client:${u}`)]);
    await q(`delete from paypal_ops where key = any($1)`, [milestoneIds]);
    await q(`delete from payment_methods where user_id = any($1)`, [users3]);
    await q(`delete from paypal_ops where key in (select id from vault_setups where user_id = any($1)) or key in (select setup_token_id from vault_setups where user_id = any($1))`, [users3]);
    await q(`delete from vault_setups where user_id = any($1)`, [users3]);
    await q(`delete from audit_log where actor = any($1)`, [users3]);
    await q(`delete from agent_mandates where user_id = any($1)`, [users3]);
    await q(`delete from milestones where contract_id = any($1)`, [contractIds]);
    await q(`delete from contracts where id = any($1)`, [contractIds]);
    await q(`delete from users where id = any($1)`, [users3]);
    await db.$client.end();
  });

  it("funds the next milestone, books client -> held as the agent, and a retry never charges again", async () => {
    const [m1, m2, m3] = await contract("seq", [10_000, 15_000, 30_000]);
    const m = await mandate();

    const early = await fund(m, m2!);
    expect(early).toMatchObject({ ok: false, kind: "refused", reason: "out_of_sequence" });
    const [refusal] = await q<{ actor: string; detail: { reason: string } }>(`select actor, detail from audit_log where milestone_id = $1 and event = $2`, [m2, AUDIT_EVENTS.vaultFundRefused]);
    expect(refusal).toMatchObject({ actor: agentActor(m), detail: { reason: "out_of_sequence" } });

    const r1 = await fund(m, m1!);
    expect(r1).toMatchObject({ ok: true, kind: "funded", status: "funded", amountMinor: 10_000, currency: "USD", replayed: false });
    if (!r1.ok) throw new Error("unreachable");
    const row = (await loadMilestone(db, m1!))!.milestone;
    expect(row).toMatchObject({ status: "funded", paypalCaptureId: r1.captureId, paypalOrderId: r1.orderId, baselineSha: "baseline-sha-1" });
    const legs = await q<{ account: string; direction: string; amount_minor: string; ref: string }>(`select account, direction, amount_minor::text, ref from ledger_entries where ref = $1 order by direction`, [r1.captureId]);
    expect(legs).toEqual([
      { account: `client:${client}`, direction: "debit", amount_minor: "10000", ref: r1.captureId },
      { account: `held:${m1}`, direction: "credit", amount_minor: "10000", ref: r1.captureId },
    ]);
    const audits = await q<{ actor: string; event: string }>(`select actor, event from audit_log where milestone_id = $1 and event in ($2, $3)`, [m1, AUDIT_EVENTS.milestoneFunded, AUDIT_EVENTS.paypalVaultCharge]);
    expect(audits.map((a) => a.event).sort()).toEqual([AUDIT_EVENTS.milestoneFunded, AUDIT_EVENTS.paypalVaultCharge].sort());
    expect(audits.every((a) => a.actor === agentActor(m))).toBe(true);
    const [op] = await q<{ status: string; request: { mandateId: string; amountMinor: number } }>(`select status, request from paypal_ops where kind = 'vault_charge' and key = $1`, [m1]);
    expect(op).toMatchObject({ status: "succeeded", request: { mandateId: m.id, amountMinor: 10_000 } });

    // Retry (double click, redelivered job): booked from the op, PayPal is not called.
    const again = await fund(m, m1!);
    expect(again).toMatchObject({ ok: true, kind: "already", replayed: true, captureId: r1.captureId });
    await settle();
    expect(captureEvents(null)).toHaveLength(1);

    // One milestone in escrow at a time: milestone 1 settles before the agent funds milestone 2.
    expect(await fund(m, m2!)).toMatchObject({ ok: false, kind: "refused", reason: "previous_in_escrow" });
    await q(`update milestones set status = 'released' where id = $1`, [m1]);
    // Next in sequence: 10 000 + 15 000 within the 30 000 total.
    expect(await fund(m, m2!)).toMatchObject({ ok: true, kind: "funded" });
    await q(`update milestones set status = 'released' where id = $1`, [m2]);
    // 30 000 is over the 20 000 per-milestone cap; raising it then hits the total (25 000 + 30 000 > 30 000).
    expect(await fund(m, m3!)).toMatchObject({ ok: false, reason: "fund_cap_exceeded" });
    await q(`update agent_mandates set fund_cap_minor = 40000 where id = $1`, [m.id]);
    expect(await fund({ ...m, fundCapMinor: 40_000 }, m3!)).toMatchObject({ ok: false, reason: "fund_total_cap_exceeded" });
    expect((await loadMilestone(db, m3!))!.milestone.status).toBe("draft");
  });

  it("refuses an unapproved contract, another user's or a removed payment method, a revoked mandate and missing caps", async () => {
    const [d1] = await contract("draftc", [1_000], { status: "draft" });
    const [a1] = await contract("refusals", [1_000]);
    const m = await mandate();
    expect(await fund(m, d1!)).toMatchObject({ ok: false, reason: "contract_not_approved" });
    expect(await fund(m, a1!, { paymentMethod: otherPm })).toMatchObject({ ok: false, reason: "payment_method_not_owned" });
    expect(await fund(m, a1!, { paymentMethod: null })).toMatchObject({ ok: false, reason: "payment_method_missing" });
    const noCaps = await mandate({ fundCapMinor: null, fundTotalCapMinor: null });
    expect(await fund(noCaps, a1!)).toMatchObject({ ok: false, reason: "fund_cap_missing" });
    const noFund = await mandate({ actions: ["read", "approve"] });
    expect(await fund(noFund, a1!)).toMatchObject({ ok: false, reason: "mandate_missing_action" });
    // The plan's rows are stale: the database says revoked / removed, and that is what counts.
    await q(`update agent_mandates set revoked_at = now() where id = $1`, [m.id]);
    expect(await fund(m, a1!)).toMatchObject({ ok: false, reason: "mandate_revoked" });
    const m2 = await mandate();
    const t = await vaultedToken("removed");
    const removed = await savePaymentMethod(db, { userId: client, paymentTokenId: t.paymentTokenId });
    await q(`update payment_methods set removed_at = now() where id = $1`, [removed.id]);
    expect(await fund(m2, a1!, { paymentMethod: removed })).toMatchObject({ ok: false, reason: "payment_method_removed" });
    await settle();
    expect(captureEvents(null)).toHaveLength(0);
    expect(await q(`select 1 from paypal_ops where key = any($1)`, [[d1, a1]])).toHaveLength(0);
  });

  it("past draft, a charge is reported back only to the mandate that made it; any other mandate is refused", async () => {
    const [o1] = await contract("owner", [1_500]);
    const m = await mandate();
    const first = await fund(m, o1!);
    expect(first).toMatchObject({ ok: true, kind: "funded" });
    // The same mandate asking again gets its own charge back (no PayPal call).
    expect(await fund(m, o1!)).toMatchObject({ ok: true, kind: "already", replayed: true });
    // A second live mandate of the same client is refused like any non-draft milestone, and audited as itself.
    const second = await mandate();
    expect(await fund(second, o1!)).toMatchObject({ ok: false, kind: "refused", reason: "milestone_not_draft" });
    const [refusal] = await q<{ actor: string }>(`select actor from audit_log where milestone_id = $1 and event = $2`, [o1, AUDIT_EVENTS.vaultFundRefused]);
    expect(refusal?.actor).toBe(agentActor(second));
    await settle();
    expect(captureEvents(null)).toHaveLength(1);
  });

  it("a declined charge moves nothing; the retry charges once under a fresh request id", async () => {
    const [b1] = await contract("declined", [2_000]);
    const m = await mandate();
    armSimulatedVaultCharge(pm.paypalPaymentTokenId, "DECLINED");
    const declined = await fund(m, b1!);
    expect(declined).toMatchObject({ ok: false, kind: "paypal_error", retryable: false, status: 422 });
    const [failed] = await q<{ status: string; request_id: string }>(`select status, request_id from paypal_ops where kind = 'vault_charge' and key = $1`, [b1]);
    expect(failed?.status).toBe("failed");
    const ok = await fund(m, b1!);
    expect(ok).toMatchObject({ ok: true, kind: "funded" });
    const [op] = await q<{ status: string; request_id: string }>(`select status, request_id from paypal_ops where kind = 'vault_charge' and key = $1`, [b1]);
    expect(op?.status).toBe("succeeded");
    expect(op?.request_id).not.toBe(failed?.request_id);
    await settle();
    expect(captureEvents(null)).toHaveLength(1);
  });

  it("a lost response leaves the op sent; the retry replays the same PayPal-Request-Id and charges once", async () => {
    const [c1] = await contract("lost", [3_000]);
    const m = await mandate();
    // PayPal charges, then the connection drops before the answer arrives.
    const lossy = new PayPalClient({ clientId: "sim", clientSecret: "sim", env: "sandbox", fetchImpl: async (input, init) => {
      const res = await simulatedFetch(input, init);
      if (init?.method === "POST" && String(input).endsWith("/v2/checkout/orders")) throw new TypeError("fetch failed: socket hang up");
      return res;
    } });
    const lost = await fund(m, c1!, { client: lossy });
    expect(lost).toMatchObject({ ok: false, kind: "paypal_error", retryable: true });
    const [sent] = await q<{ status: string; request_id: string }>(`select status, request_id from paypal_ops where kind = 'vault_charge' and key = $1`, [c1]);
    expect(sent?.status).toBe("sent");
    // In flight counts against the total cap of the mandate, but not twice against its own replay.
    const retry = await fund(m, c1!);
    expect(retry).toMatchObject({ ok: true, kind: "funded", replayed: true });
    const [op] = await q<{ status: string; request_id: string }>(`select status, request_id from paypal_ops where kind = 'vault_charge' and key = $1`, [c1]);
    expect(op).toEqual({ status: "succeeded", request_id: sent!.request_id });
    await settle();
    expect(captureEvents(null)).toHaveLength(1);
  });

  it("concurrent calls: one charge per milestone, and the total cap holds across milestones", async () => {
    const [x1] = await contract("race", [4_000]);
    const m = await mandate();
    const both = await Promise.all([fund(m, x1!), fund(m, x1!), fund(m, x1!)]);
    expect(both.filter((r) => r.ok && r.kind === "funded")).toHaveLength(1);
    expect(both.every((r) => r.ok)).toBe(true);
    await settle();
    expect(captureEvents(null)).toHaveLength(1);

    events.length = 0;
    const [y1] = await contract("capA", [6_000]);
    const [z1] = await contract("capB", [6_000]);
    const tight = await mandate({ fundCapMinor: 10_000, fundTotalCapMinor: 10_000 });
    const pair = await Promise.all([fund(tight, y1!), fund(tight, z1!)]);
    expect(pair.filter((r) => r.ok)).toHaveLength(1);
    expect(pair.filter((r) => !r.ok && r.kind === "refused" && r.reason === "fund_total_cap_exceeded")).toHaveLength(1);
    await settle();
    expect(captureEvents(null)).toHaveLength(1);
  });

  it("a PENDING capture records the capture and leaves the milestone draft", async () => {
    const [p1] = await contract("pending", [2_500]);
    const m = await mandate();
    armSimulatedVaultCharge(pm.paypalPaymentTokenId, "PENDING");
    const r = await fund(m, p1!);
    expect(r).toMatchObject({ ok: true, kind: "pending", status: "draft" });
    const row = (await loadMilestone(db, p1!))!.milestone;
    expect(row.status).toBe("draft");
    expect(row.paypalCaptureId).toBe(r.ok ? r.captureId : null);
    expect(await q(`select 1 from ledger_entries where account = $1`, [`held:${p1}`])).toHaveLength(0);
  });

  it("the auto-fund rule funds the next milestone under an auto_fund_next mandate, through the same guarantee", async () => {
    const [e1, e2] = await contract("auto", [1_500, 1_500]);
    const cid = contractIds[contractIds.length - 1]!;
    // Without an auto-fund mandate nothing happens.
    await q(`update agent_mandates set auto_fund_next = false where user_id = $1`, [client]);
    expect(await autoFundNextMilestone(ctx(), cid)).toMatchObject({ ok: false, kind: "skipped", why: "no_auto_fund_mandate" });
    const m = await mandate({ autoFundNext: true });
    const r = await autoFundNextMilestone(ctx(), cid);
    expect(r).toMatchObject({ ok: true, kind: "funded", milestoneId: e1 });
    const [funded] = await q<{ actor: string; detail: { via: string } }>(`select actor, detail from audit_log where milestone_id = $1 and event = $2`, [e1, AUDIT_EVENTS.milestoneFunded]);
    expect(funded).toMatchObject({ actor: agentActor(m), detail: { via: "auto_fund" } });
    // The next one is funded only once this one has settled.
    expect(await autoFundNextMilestone(ctx(), cid)).toMatchObject({ ok: false, kind: "refused", reason: "previous_in_escrow" });
    await q(`update milestones set status = 'released' where id = $1`, [e1]);
    expect(await autoFundNextMilestone(ctx(), cid)).toMatchObject({ ok: true, kind: "funded", milestoneId: e2 });
    expect(await autoFundNextMilestone(ctx(), cid)).toMatchObject({ ok: false, kind: "skipped", why: "no_draft_milestone" });
    await expect(createMandate(db, { userId: client, agentName: "x", actions: ["read"], autoFundNext: true, fundCapMinor: 1, fundTotalCapMinor: 1, currency: "USD", expiresAt: new Date(now.getTime() + 1000) })).rejects.toThrow(/autoFundNext/);
  });

  it("save-your-PayPal: setup bound to its user, idempotent completion, removal deletes the token at PayPal", async () => {
    const c = paypal();
    const started = await startVaultSetup(db, c, { userId: other, returnUrl: "http://app.test/settings?vault=done", cancelUrl: "http://app.test/settings?vault=cancel" });
    expect(started.approveUrl).toContain(`/api/dev/paypal/vault-approve?token=${started.setupTokenId}`);
    approveSimulatedSetupToken(started.setupTokenId);
    // Another user cannot vault this approval.
    expect(await completeVaultSetup(db, c, { userId: client, setupTokenId: started.setupTokenId })).toMatchObject({ ok: false, reason: "unknown_setup" });
    const done = await completeVaultSetup(db, c, { userId: other, setupTokenId: started.setupTokenId });
    expect(done.ok).toBe(true);
    if (!done.ok) throw new Error("unreachable");
    expect(done.paymentMethod).toMatchObject({ userId: other, provider: "paypal", removedAt: null });
    const again = await completeVaultSetup(db, c, { userId: other, setupTokenId: started.setupTokenId });
    expect(again.ok && again.paymentMethod.id).toBe(done.paymentMethod.id);
    const [setup] = await q<{ status: string }>(`select status from vault_setups where setup_token_id = $1`, [started.setupTokenId]);
    expect(setup?.status).toBe("vaulted");

    expect(await removeVaultPaymentMethod(db, c, { userId: client, paymentMethodId: done.paymentMethod.id })).toBeNull();
    const removed = await removeVaultPaymentMethod(db, c, { userId: other, paymentMethodId: done.paymentMethod.id });
    expect(removed?.removedAt).toBeInstanceOf(Date);
    expect(await getPaymentToken(c, done.paymentMethod.paypalPaymentTokenId).catch((e: { status?: number }) => e.status)).toBe(404);
  });
});

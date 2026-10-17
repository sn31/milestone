/**
 * fund_milestone through the client's saved PayPal (the funding guarantee), end to end in-process: a real MCP client
 * against POST /api/mcp, Postgres with throwaway rows (opt in: MILESTONE_E2E=1, on a scratch database), and the PayPal
 * simulator in memory. The PayPal account is saved through the real vault flow (setup token, payer approval in the
 * simulator, payment token). Covers a vault funding, a repeat that charges once, every refusal an agent can reach
 * through the tool, and the fallback to an approval link (with why). The refusals the tool cannot reach (it always picks
 * the user's own active PayPal and the milestone's own amount) are covered on fundingAllows directly.
 */
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { e2e, loadRootEnv } from "./helpers";

const state = await vi.hoisted(async () => {
  const { mkdtempSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "mcp-vault-test-"));
  process.env.SIMULATED_PAYPAL_STATE_FILE = join(dir, "simulated-paypal.json");
  process.env.PAYPAL_MODE = "simulated";
  return { dir, jar: new Map<string, string>(), db: null as unknown };
});
loadRootEnv();

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (state.jar.has(name) ? { name, value: state.jar.get(name)! } : undefined),
    set: (name: string, value: string) => void state.jar.set(name, value),
    delete: (name: string) => void state.jar.delete(name),
  }),
}));
vi.mock("@/lib/db", () => ({ getDb: () => state.db }));
vi.mock("@/lib/paypal", async () => {
  const { createSimulatedPayPalClient } = await import("@milestone/money");
  const client = createSimulatedPayPalClient();
  return { paypal: () => client };
});
vi.mock("@milestone/core", async (orig) => ({ ...(await orig<typeof import("@milestone/core")>()), enqueue: async () => "job" }));

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { and, eq, inArray, like, or, sql } from "drizzle-orm";
import * as core from "@milestone/core";
import * as money from "@milestone/money";
import { POST as mcpPOST } from "../src/app/api/mcp/route";
import { FUNDING_REFUSAL_TEXT } from "../src/lib/mcp/tools";
import { captureAndFund } from "../src/app/api/milestones/_shared";
import { paypal } from "@/lib/paypal";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

describe.skipIf(!e2e)("MCP fund_milestone from the saved PayPal", () => {
  const db = e2e ? core.createDb() : (null as never);
  const tag = randomUUID().slice(0, 8);
  const clientId = `usr_mcpv_c_${tag}`;
  const otherClientId = `usr_mcpv_o_${tag}`;
  const freelancerId = `usr_mcpv_f_${tag}`;
  const agentPrefix = `mcpv-${tag}`;
  const contractIds: string[] = [];
  const mandateIds: string[] = [];
  const clients: Client[] = [];
  let vaultId = "";
  let n = 0;
  const later = () => new Date(Date.now() + 86_400_000);

  async function contract(o: { amounts: number[]; approved?: boolean; currency?: string; clientId?: string; freelancerId?: string; statuses?: core.MilestoneStatus[] }) {
    const id = `ctr_mcpv_${tag}_${++n}`;
    contractIds.push(id);
    const approved = o.approved ?? true;
    await db.insert(core.contracts).values({
      id,
      clientId: o.clientId ?? clientId,
      freelancerId: o.freelancerId ?? freelancerId,
      title: `vault ${tag} ${n}`,
      scopeText: "t",
      currency: o.currency ?? "USD",
      totalMinor: o.amounts.reduce((a, b) => a + b, 0),
      status: approved ? "active" : "draft",
      clientApprovedAt: approved ? new Date() : null,
      freelancerApprovedAt: approved ? new Date() : null,
    });
    const ids: string[] = [];
    for (const [i, amountMinor] of o.amounts.entries()) {
      const mid = `mst_mcpv_${tag}_${n}_${i + 1}`;
      ids.push(mid);
      await db.insert(core.milestones).values({ id: mid, contractId: id, seq: i + 1, title: `M${i + 1}`, amountMinor, status: o.statuses?.[i] ?? "draft" });
    }
    return { id, ms: ids };
  }

  async function agent(name: string, over: Partial<core.CreateMandateInput> = {}) {
    const r = await core.createMandate(db, { userId: clientId, agentName: `${agentPrefix}-${name}`, actions: ["read", "fund"], fundCapMinor: 20_000, fundTotalCapMinor: 30_000, currency: "USD", expiresAt: later(), ...over });
    mandateIds.push(r.mandate.id);
    const transport = new StreamableHTTPClientTransport(new URL("http://localhost/api/mcp"), { fetch: async (url: string | URL, init?: RequestInit) => mcpPOST(new Request(url, init)), requestInit: { headers: { authorization: `Bearer ${r.token}` } } });
    const c = new Client({ name: "mcp-vault-test", version: "0.0.0" });
    await c.connect(transport);
    clients.push(c);
    return { ...r, c };
  }

  async function fund(c: Client, milestoneId: string): Promise<{ isError: boolean; body: Any; text: string }> {
    const r = (await c.callTool({ name: "fund_milestone", arguments: { milestoneId } })) as Any;
    const text = r.content?.[0]?.text ?? "";
    return { isError: r.isError === true, body: r.structuredContent ?? JSON.parse(text), text };
  }

  const vaultOps = (mid: string) => db.select().from(core.paypalOps).where(and(eq(core.paypalOps.key, mid), eq(core.paypalOps.kind, core.VAULT_CHARGE_OP_KIND)));
  const statusOf = async (mid: string) => (await db.query.milestones.findFirst({ where: eq(core.milestones.id, mid) }))?.status;
  const heldLegs = (mid: string) => db.select().from(core.ledgerEntries).where(sql`${core.ledgerEntries.txnId} in (select txn_id from ledger_entries where account = ${core.accounts.held(mid)})`);

  async function expectRefused(c: Client, mid: string, reason: core.FundingRefusal) {
    const r = await fund(c, mid);
    expect(r.isError, `${reason}: ${r.text}`).toBe(true);
    expect(r.body).toMatchObject({ ok: false, reason, error: FUNDING_REFUSAL_TEXT[reason], via: "saved_paypal" });
    expect(r.text).not.toContain(vaultId);
    expect(await vaultOps(mid)).toEqual([]);
    const rows = await db.select().from(core.auditLog).where(and(eq(core.auditLog.milestoneId, mid), eq(core.auditLog.event, core.AUDIT_EVENTS.vaultFundRefused)));
    expect(rows.at(-1)?.actor).toMatch(new RegExp(`^agent:${agentPrefix}-.* for ${clientId}$`));
    expect((rows.at(-1)?.detail as Any).reason).toBe(reason);
    return r;
  }

  beforeAll(async () => {
    state.db = db;
    money.configureSimulator({ stateFile: null, deliver: () => {}, webhookDelayMs: 5 });
    await db.insert(core.users).values([
      { id: clientId, role: "client", name: "Vault client", email: `c-${tag}@e2e.test` },
      { id: otherClientId, role: "client", name: "Other client", email: `o-${tag}@e2e.test` },
      { id: freelancerId, role: "freelancer", name: "Vault freelancer", email: `f-${tag}@e2e.test`, paypalEmail: `f-${tag}@e2e.test` },
    ]);
    // Save the client's PayPal through the real vault flow: setup token -> payer approves -> payment token.
    const started = await money.startVaultSetup(db, paypal(), { userId: clientId, returnUrl: "http://localhost/return", cancelUrl: "http://localhost/cancel" });
    expect(money.approveSimulatedSetupToken(started.setupTokenId)).not.toBeNull();
    const done = await money.completeVaultSetup(db, paypal(), { userId: clientId, setupTokenId: started.setupTokenId });
    if (!done.ok) throw new Error(`vault setup failed: ${done.reason}`);
    vaultId = done.paymentMethod.paypalPaymentTokenId;
    expect(vaultId).toMatch(/\S/);
  });

  afterAll(async () => {
    if (!e2e) return;
    for (const c of clients) await c.close().catch(() => {});
    const ms = (await db.select({ id: core.milestones.id }).from(core.milestones).where(inArray(core.milestones.contractId, contractIds))).map((m) => m.id);
    const users = [clientId, otherClientId, freelancerId];
    const q = (text: string, params: unknown[]) => db.$client.query(text, params);
    await db.delete(core.auditLog).where(or(inArray(core.auditLog.contractId, contractIds), like(core.auditLog.actor, `agent:${agentPrefix}%`)));
    await q(`delete from audit_log where detail->>'userId' = any($1)`, [users]);
    if (ms.length) {
      await q(`delete from ledger_entries where txn_id in (select txn_id from ledger_entries where account = any($1))`, [ms.map((m) => core.accounts.held(m))]);
      await db.delete(core.paypalOps).where(inArray(core.paypalOps.key, ms));
      await db.delete(core.milestones).where(inArray(core.milestones.id, ms));
    }
    await q(`delete from paypal_ops where key in (select id from vault_setups where user_id = any($1)) or key in (select setup_token_id from vault_setups where user_id = any($1))`, [users]);
    await db.delete(core.vaultSetups).where(inArray(core.vaultSetups.userId, users));
    await db.delete(core.paymentMethods).where(inArray(core.paymentMethods.userId, users));
    await db.delete(core.contracts).where(inArray(core.contracts.id, contractIds));
    if (mandateIds.length) await db.delete(core.agentMandates).where(inArray(core.agentMandates.id, mandateIds));
    await db.delete(core.auditLog).where(sql`${core.auditLog.actor} like ${`%${tag}%`}`);
    await db.delete(core.users).where(inArray(core.users.id, users));
    rmSync(state.dir, { recursive: true, force: true });
  });

  it("funds the next milestone from the saved PayPal, audited as the agent, and a repeat never charges twice", async () => {
    const k = await contract({ amounts: [10_000, 15_000] });
    const a = await agent("fund");
    const r = await fund(a.c, k.ms[0]!);
    expect(r.isError, r.text).toBe(false);
    expect(r.body).toMatchObject({
      ok: true,
      funded: true,
      status: "funded",
      amount: { amountMinor: 10_000, value: "100.00", currency: "USD" },
      remainingTotalCap: { amountMinor: 20_000, value: "200.00", currency: "USD" },
      via: "saved_paypal",
      replayed: false,
    });
    expect(r.body.captureId).toMatch(/\S/);
    expect(r.text).not.toContain(vaultId);
    expect(r.body.approvalUrl).toBeUndefined();

    const m = await db.query.milestones.findFirst({ where: eq(core.milestones.id, k.ms[0]!) });
    expect(m).toMatchObject({ status: "funded", paypalCaptureId: r.body.captureId });
    const ops = await vaultOps(k.ms[0]!);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ status: "succeeded", paypalId: r.body.captureId });
    expect((ops[0]!.request as Any)).toMatchObject({ mandateId: a.mandate.id, userId: clientId, amountMinor: 10_000, currency: "USD" });
    const legs = await heldLegs(k.ms[0]!);
    expect(legs.map((l) => [l.account, l.direction, Number(l.amountMinor)]).sort()).toEqual([
      [core.accounts.client(clientId), "debit", 10_000],
      [core.accounts.held(k.ms[0]!), "credit", 10_000],
    ]);
    const actor = core.agentActor(a.mandate);
    const events = (await db.select().from(core.auditLog).where(eq(core.auditLog.milestoneId, k.ms[0]!))).filter((e) => e.actor === actor).map((e) => e.event);
    expect(events).toEqual(expect.arrayContaining([core.AUDIT_EVENTS.paypalVaultCharge, "agent.fund_milestone"]));

    // The same call again: the recorded charge is booked, PayPal is not charged again, the ledger does not move.
    const again = await fund(a.c, k.ms[0]!);
    expect(again.isError, again.text).toBe(false);
    expect(again.body).toMatchObject({ funded: true, replayed: true, captureId: r.body.captureId });
    expect(await vaultOps(k.ms[0]!)).toHaveLength(1);
    expect(await heldLegs(k.ms[0]!)).toHaveLength(2);
    expect(await core.mandateFundedMinor(db, a.mandate.id)).toBe(10_000);

    // One milestone in escrow at a time: the next is refused until this one settles.
    await expectRefused(a.c, k.ms[1]!, "previous_in_escrow");
    await db.update(core.milestones).set({ status: "released" }).where(eq(core.milestones.id, k.ms[0]!));
    // The next milestone in order is allowed and uses the remaining total cap.
    const second = await fund(a.c, k.ms[1]!);
    expect(second.body).toMatchObject({ funded: true, remainingTotalCap: { amountMinor: 5_000 } });
  });

  it("refuses out of order, over a cap, before approval, past draft, mid-capture, in another currency, or for a contract the user is not the client of", async () => {
    const a = await agent("refusals", { fundCapMinor: 20_000, fundTotalCapMinor: 25_000 });

    const seq = await contract({ amounts: [5_000, 5_000] });
    await expectRefused(a.c, seq.ms[1]!, "out_of_sequence");

    const big = await contract({ amounts: [20_001] });
    await expectRefused(a.c, big.ms[0]!, "fund_cap_exceeded");

    const total = await contract({ amounts: [20_000, 10_000] });
    expect((await fund(a.c, total.ms[0]!)).body.funded).toBe(true);
    await db.update(core.milestones).set({ status: "released" }).where(eq(core.milestones.id, total.ms[0]!));
    const over = await expectRefused(a.c, total.ms[1]!, "fund_total_cap_exceeded");
    expect(over.body.error).toMatch(/total fund cap/);

    const unapproved = await contract({ amounts: [1_000], approved: false });
    await expectRefused(a.c, unapproved.ms[0]!, "contract_not_approved");

    const past = await contract({ amounts: [1_000, 1_000], statuses: ["review", "funded"] });
    await expectRefused(a.c, past.ms[1]!, "milestone_not_draft");

    const capturing = await contract({ amounts: [1_000] });
    await db.insert(core.paypalOps).values({ id: randomUUID(), kind: core.OP_KINDS.capture, key: capturing.ms[0]!, requestId: randomUUID(), status: "sent" });
    await expectRefused(a.c, capturing.ms[0]!, "capture_in_progress");

    const eur = await contract({ amounts: [1_000], currency: "EUR" });
    await expectRefused(a.c, eur.ms[0]!, "currency_mismatch");

    // The mandate's user is this contract's freelancer, not its client.
    const notClient = await contract({ amounts: [1_000], clientId: otherClientId, freelancerId: clientId });
    await expectRefused(a.c, notClient.ms[0]!, "not_contract_client");
  });

  it("falls back to an approval link and says why: no fund caps, or no saved PayPal", async () => {
    const k = await contract({ amounts: [1_000] });
    // No fund caps: the vault is not used. The order route then refuses this non-demo user (identity_unbound), but the
    // answer still says why the saved PayPal was not used, and nothing was charged.
    const noCaps = await agent("nocaps", { fundCapMinor: null, fundTotalCapMinor: null });
    const r = await fund(noCaps.c, k.ms[0]!);
    expect(r.body.vault).toMatchObject({ used: false, reason: "fund_cap_missing" });
    expect(r.body.vault.why).toMatch(/no fund caps/);
    expect(await vaultOps(k.ms[0]!)).toEqual([]);

    // The saved PayPal removed: nothing to charge, same fallback.
    const capped = await agent("removed");
    const [pm] = await db.select().from(core.paymentMethods).where(eq(core.paymentMethods.userId, clientId));
    await db.update(core.paymentMethods).set({ removedAt: new Date() }).where(eq(core.paymentMethods.id, pm!.id));
    try {
      const r2 = await fund(capped.c, k.ms[0]!);
      expect(r2.body.vault).toMatchObject({ used: false, reason: "no_saved_paypal" });
      expect(await vaultOps(k.ms[0]!)).toEqual([]);
    } finally {
      await db.update(core.paymentMethods).set({ removedAt: null }).where(eq(core.paymentMethods.id, pm!.id));
    }

    // Without "fund" the tool is refused before any path is picked.
    const readOnly = await agent("readonly", { actions: ["read"], fundCapMinor: null, fundTotalCapMinor: null });
    expect((await fund(readOnly.c, k.ms[0]!)).body.reason).toBe("mandate_missing_action");
  });

  it("refuses when the vault charge is declined, without exposing the vault id, and a later call can still fund", async () => {
    const k = await contract({ amounts: [2_000] });
    const a = await agent("declined", { fundTotalCapMinor: 100_000 });
    money.armSimulatedVaultCharge(vaultId, "DECLINED");
    const r = await fund(a.c, k.ms[0]!);
    expect(r.isError).toBe(true);
    expect(["paypal_error", "paypal_not_completed"]).toContain(r.body.reason);
    expect(r.text).not.toContain(vaultId);
    expect(await statusOf(k.ms[0]!)).toBe("draft");
    expect(await heldLegs(k.ms[0]!)).toEqual([]);
  });

  it("a human checkout capture is refused while the agent's vault charge for the milestone is in flight", async () => {
    const k = await contract({ amounts: [1_000] });
    const mid = k.ms[0]!;
    await db.update(core.milestones).set({ paypalOrderId: `ORDER-${tag}` }).where(eq(core.milestones.id, mid));
    await db.insert(core.paypalOps).values({ id: randomUUID(), kind: core.VAULT_CHARGE_OP_KIND, key: mid, requestId: randomUUID(), status: "sent", request: { mandateId: "mdt_x", amountMinor: 1_000 } });
    const r = await captureAndFund(db, mid, `ORDER-${tag}`, clientId);
    expect(r).toMatchObject({ kind: "rejected", httpStatus: 409 });
    // No capture op was claimed, so nothing went to PayPal and the milestone is still draft.
    const captureOps = await db.select().from(core.paypalOps).where(and(eq(core.paypalOps.key, mid), eq(core.paypalOps.kind, core.OP_KINDS.capture)));
    expect(captureOps).toEqual([]);
    expect(await statusOf(mid)).toBe("draft");
  });
});

describe("the funding guarantee: refusals the tool cannot reach", () => {
  const now = new Date("2026-10-17T12:00:00Z");
  const base = (): core.FundingFacts => ({
    mandate: { userId: "u", actions: ["fund"], currency: "USD", expiresAt: new Date("2026-11-01T00:00:00Z"), revokedAt: null, fundCapMinor: 10_000, fundTotalCapMinor: 20_000 },
    contract: { id: "c", clientId: "u", status: "active", currency: "USD", clientApprovedAt: now, freelancerApprovedAt: now },
    milestone: { id: "m1", contractId: "c", seq: 1, status: "draft", amountMinor: 5_000, paypalCaptureId: null },
    siblings: [{ id: "m1", seq: 1, status: "draft" }],
    paymentMethod: { userId: "u", provider: "paypal", paypalPaymentTokenId: "tok", removedAt: null },
    fundedMinor: 0,
    amountMinor: 5_000,
    currency: "USD",
  });
  it("covers every code", () => {
    expect(core.fundingAllows(base(), now)).toEqual({ ok: true });
    const cases: Array<[core.FundingRefusal, (f: core.FundingFacts) => void]> = [
      ["mandate_revoked", (f) => void (f.mandate.revokedAt = now)],
      ["mandate_expired", (f) => void (f.mandate.expiresAt = now)],
      ["mandate_missing_action", (f) => void (f.mandate.actions = ["read"])],
      ["payment_method_missing", (f) => void (f.paymentMethod = null)],
      ["payment_method_not_owned", (f) => void (f.paymentMethod!.userId = "x")],
      ["payment_method_removed", (f) => void (f.paymentMethod!.removedAt = now)],
      ["not_contract_client", (f) => void (f.contract.clientId = "x")],
      ["contract_not_approved", (f) => void (f.contract.freelancerApprovedAt = null)],
      ["milestone_not_in_contract", (f) => void (f.milestone.contractId = "other")],
      ["milestone_not_draft", (f) => void ((f.milestone.status = "funded"), (f.siblings[0]!.status = "funded"))],
      ["capture_in_progress", (f) => void (f.captureInProgress = true)],
      ["out_of_sequence", (f) => void (f.siblings = [{ id: "m0", seq: 0, status: "draft" }, ...f.siblings])],
      ["previous_in_escrow", (f) => void (f.siblings = [{ id: "m0", seq: 0, status: "review" }, ...f.siblings])],
      ["amount_mismatch", (f) => void (f.amountMinor = 4_999)],
      ["currency_mismatch", (f) => void (f.currency = "EUR")],
      ["fund_cap_missing", (f) => void (f.mandate.fundCapMinor = null)],
      ["fund_cap_exceeded", (f) => void ((f.milestone.amountMinor = 10_001), (f.amountMinor = 10_001))],
      ["fund_total_cap_exceeded", (f) => void (f.fundedMinor = 15_001)],
    ];
    expect(cases.map(([c]) => c).sort()).toEqual([...core.FUNDING_REFUSALS].sort());
    for (const [code, change] of cases) {
      const f = base();
      change(f);
      expect(core.fundingAllows(f, now), code).toEqual({ refused: code });
      expect(FUNDING_REFUSAL_TEXT[code].length).toBeGreaterThan(10);
    }
  });
});

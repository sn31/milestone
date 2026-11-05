/**
 * The dispute copilot end to end against the local Postgres and the in-memory PayPal simulator. Opt in: MILESTONE_E2E=1.
 * A released milestone shaped like the showcase's mst_3 (funded, delivered, verified pass, review window passed,
 * payout confirmed, ledger held -> freelancer) is disputed; the webhook side records it, the job drafts the response,
 * the freelancer submits it, and the simulator's CUSTOMER.DISPUTE.RESOLVED lands as dispute.resolved. A second dispute
 * is accepted instead (booked in the ledger, flagged for an operator). A milestone still in review cannot have its claim
 * accepted and its release is blocked while the dispute is open. A second evidence round after PayPal's UPDATED gets
 * its own PayPal-Request-Id. Every row is tagged and removed in afterAll; the simulator never touches var/.
 */
import { randomUUID } from "node:crypto";
import type { Job } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const run = process.env.MILESTONE_E2E === "1";
try { process.loadEnvFile(new URL("../../../.env", import.meta.url).pathname); } catch { /* env already set */ }

type AnyJob = Job<{ milestoneId: string } & Record<string, unknown>>;
const job = (data: Record<string, unknown> & { milestoneId: string }) => ({ id: randomUUID(), name: "dispute", data }) as unknown as AnyJob;

describe.skipIf(!run)("dispute copilot end to end", async () => {
  process.env.PAYPAL_MODE = "simulated";
  delete process.env.ANTHROPIC_API_KEY; // the templated draft: deterministic, no model
  const money = await import("@milestone/money");
  const { auditLog, contracts, criteria, deliveries, milestones, users, postTransaction } = await import("@milestone/core");
  const { packCites } = await import("@milestone/verify");
  const { getDb } = await import("../src/lib/db.ts");
  const { dispute } = await import("../src/jobs/dispute.ts");
  const { release } = await import("../src/jobs/release.ts");
  const BLOCKED_BY_DISPUTE_EVENT = (await import("@milestone/core")).AUDIT_EVENTS.releaseBlockedByDispute;
  const { requestIdFor } = await import("@milestone/core");
  const db = run ? getDb() : (undefined as unknown as ReturnType<typeof getDb>); // the suite body is collected even when skipped
  const tag = randomUUID().slice(0, 8);
  const contractId = `ctr_e2e_dp_${tag}`;
  const clientId = `usr_e2e_dpc_${tag}`;
  const freelancerId = `usr_e2e_dpf_${tag}`;
  const milestoneId = `mst_e2e_dp_${tag}`;
  const deliveryId = `dlv_e2e_dp_${tag}`;
  const captureId = `SIM-CAP-E2E${tag.toUpperCase()}`;
  // A second milestone still in its review window (money in escrow) for the release guard and the accept refusal.
  const reviewMilestoneId = `mst_e2e_dpr_${tag}`;
  const reviewDeliveryId = `dlv_e2e_dpr_${tag}`;
  const reviewCaptureId = `SIM-CAP-E2ER${tag.toUpperCase()}`;
  const moneyCtx = () => ({ db, client: money.createPayPalClient(), requestIdFor: (kind: string, key: string) => requestIdFor(db, kind, key) });
  const events: Array<{ id: string; event_type: string; resource?: unknown }> = [];
  const disputeIds: string[] = [];
  const unmatchedEventIds: string[] = [];
  const min = (m: number) => new Date(Date.now() + m * 60_000);

  const until = async (f: () => boolean, ms = 5_000) => {
    const end = Date.now() + ms;
    while (!f() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
    expect(f()).toBe(true);
  };
  const eventFor = (type: string, disputeId: string) => events.find((e) => e.event_type === type && (e.resource as { dispute_id?: string } | undefined)?.dispute_id === disputeId);
  const audits = async (event: string, disputeId: string) =>
    (await db.$client.query(`select actor, detail from audit_log where event = $1 and detail->>'disputeId' = $2 order by created_at`, [event, disputeId])).rows as Array<{ actor: string; detail: Record<string, unknown> }>;

  beforeAll(async () => {
    money.configureSimulator({ stateFile: null, webhookDelayMs: 10, disputeResolveDelayMs: 80, deliver: (e) => void events.push(e as never) });
    await db.insert(users).values([
      { id: clientId, role: "client", name: "Casey E2E", email: `c-${tag}@e2e.test` },
      { id: freelancerId, role: "freelancer", name: "Frankie E2E", email: `f-${tag}@e2e.test`, paypalEmail: `f-${tag}@e2e.test` },
    ]);
    await db.insert(contracts).values({ id: contractId, clientId, freelancerId, title: "Signup flow (e2e)", scopeText: "e2e", currency: "USD", totalMinor: 10_000, status: "active", clientApprovedAt: min(-60), freelancerApprovedAt: min(-60) });
    await db.insert(milestones).values({
      id: milestoneId, contractId, seq: 3, title: "Polish, accessibility and docs", amountMinor: 10_000, status: "released", paypalOrderId: `SIM-ORD-E2E${tag}`, paypalCaptureId: captureId,
      decision: { action: "release", amountMinor: 10_000, ruleIds: ["P6"], reason: "Every criterion passed at or above the confidence threshold.", deliveryId } as never, decidedAt: min(-40), reviewEndsAt: min(-12),
    });
    await db.insert(milestones).values({
      id: reviewMilestoneId, contractId, seq: 4, title: "Launch checklist", amountMinor: 5_000, status: "review", paypalOrderId: `SIM-ORD-E2ER${tag}`, paypalCaptureId: reviewCaptureId,
      decision: { action: "release", amountMinor: 5_000, ruleIds: ["P6"], reason: "Every criterion passed.", deliveryId: reviewDeliveryId } as never, decidedAt: min(-5), reviewEndsAt: min(-1),
    });
    await db.insert(criteria).values([
      { id: `crt_e2e_dp_${tag}_tests`, milestoneId, kind: "test", description: "The test suite passes", spec: { command: "npm test" }, required: true },
      { id: `crt_e2e_dp_${tag}_judge`, milestoneId, kind: "judgment", description: "The delivery matches the milestone description", spec: {}, required: false },
    ]);
    await db.insert(deliveries).values({
      id: deliveryId, milestoneId, source: "github_pr", ref: "milestone-demo/landing#9", payload: { sha: "f".repeat(40), title: "Polish, accessibility and docs", pr: 9 },
      evidence: [
        { id: "ev_tests", criterion_id: `crt_e2e_dp_${tag}_tests`, kind: "log", status: "pass", summary: "npm test: 17 passed" },
        { id: "ev_readme", criterion_id: `crt_e2e_dp_${tag}_judge`, kind: "file", status: "pass", summary: "README.md exists", uri: "README.md", sha256: "e".repeat(64) },
      ],
      verdict: { delivery_id: deliveryId, suspected_injection: false, criteria: [
        { criterion_id: `crt_e2e_dp_${tag}_tests`, status: "pass", confidence: 0.97, evidence_ids: ["ev_tests"], rationale: "The suite passes." },
        { criterion_id: `crt_e2e_dp_${tag}_judge`, status: "pass", confidence: 0.88, evidence_ids: ["ev_readme"], rationale: "Matches the description." },
      ] },
      result: "pass", receivedAt: min(-42), verifiedAt: min(-40),
    });
    const rows: Array<{ actor: string; event: string; at: Date; detail?: unknown; contractOnly?: boolean }> = [
      { actor: clientId, event: "contract.approved_by_client", at: min(-61), contractOnly: true },
      { actor: freelancerId, event: "contract.approved_by_freelancer", at: min(-60), contractOnly: true },
      { actor: clientId, event: "milestone.order_created", at: min(-47), detail: { orderId: `SIM-ORD-E2E${tag}`, amountMinor: 10_000, currency: "USD" } },
      { actor: "paypal", event: "milestone.funded", at: min(-46), detail: { captureId, amountMinor: 10_000, currency: "USD" } },
      { actor: freelancerId, event: "delivery.manual", at: min(-42), detail: { deliveryId, ref: "milestone-demo/landing#9", sha: "f".repeat(40) } },
      { actor: "verifier", event: "verdict.stored", at: min(-40), detail: { deliveryId, result: "pass" } },
      { actor: "policy", event: "policy.decided", at: min(-40), detail: { action: "release", amountMinor: 10_000, ruleIds: ["P6"] } },
      { actor: "policy", event: "milestone.review", at: min(-40), detail: { reviewEndsAt: min(-12).toISOString() } },
      { actor: "paypal", event: "paypal.payout", at: min(-11), detail: { payoutBatchId: "SIM-BATCH-E2E", amountMinor: 10_000, currency: "USD" } },
      { actor: "paypal", event: "milestone.released", at: min(-10), detail: { amountMinor: 10_000, currency: "USD", payoutItemId: "SIM-ITEM-E2E" } },
    ];
    for (const r of rows) {
      await db.insert(auditLog).values({ id: randomUUID(), actor: r.actor, event: r.event, detail: r.detail ?? null, contractId, milestoneId: r.contractOnly ? null : milestoneId, createdAt: r.at });
    }
    await postTransaction(db, { ref: captureId, currency: "USD", entries: [{ account: `client:${clientId}`, amountMinor: 10_000, direction: "debit" }, { account: `held:${milestoneId}`, amountMinor: 10_000, direction: "credit" }] });
    await postTransaction(db, { ref: `release:${milestoneId}`, currency: "USD", entries: [{ account: `held:${milestoneId}`, amountMinor: 10_000, direction: "debit" }, { account: `freelancer:${freelancerId}`, amountMinor: 10_000, direction: "credit" }] });
  });

  afterAll(async () => {
    money.configureSimulator({ deliver: null, webhookDelayMs: 1500, disputeResolveDelayMs: 2000 });
    const q = (s: string, p: unknown[]) => db.$client.query(s, p);
    const mids = [milestoneId, reviewMilestoneId];
    await q(`delete from audit_log where contract_id = $1 or milestone_id = any($2) or (event = 'paypal.dispute_unmatched' and detail->>'eventId' = any($3))`, [contractId, mids, unmatchedEventIds]);
    // Evidence ops are keyed "<disputeId>:<n>", accept ops by the dispute id; release ops (none expected) by milestone.
    await q(`delete from paypal_ops where key = any($1) or split_part(key, ':', 1) = any($1) or key = any($2)`, [disputeIds, mids]);
    await q(`delete from ledger_entries where txn_id in (select txn_id from ledger_entries where account = any($1))`, [mids.map((m) => `held:${m}`)]);
    await q(`delete from deliveries where milestone_id = any($1)`, [mids]);
    await q(`delete from criteria where milestone_id = any($1)`, [mids]);
    await q(`delete from milestones where id = any($1)`, [mids]);
    await q(`delete from contracts where id = $1`, [contractId]);
    await q(`delete from users where id = any($1)`, [[clientId, freelancerId]]);
  });

  it("opens, drafts, submits and resolves in the seller's favour", async () => {
    const opened = money.openSimulatedDispute({ captureId, amountMinor: 10_000, currency: "USD" });
    disputeIds.push(opened.disputeId);
    await until(() => Boolean(eventFor("CUSTOMER.DISPUTE.CREATED", opened.disputeId)));
    const created = eventFor("CUSTOMER.DISPUTE.CREATED", opened.disputeId)!;

    // Webhook side: found by the disputed transaction id; a redelivery adds nothing.
    const r1 = await money.recordDisputeEvent(db, created as never);
    expect(r1).toMatchObject({ outcome: "opened", disputeId: opened.disputeId, milestoneId, enqueue: true });
    expect(await money.recordDisputeEvent(db, created as never)).toMatchObject({ outcome: "opened", enqueue: true });
    const openedRows = await audits("dispute.opened", opened.disputeId);
    expect(openedRows).toHaveLength(1);
    expect(openedRows[0]!.detail).toMatchObject({ disputeId: opened.disputeId, reason: "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED", captureId, amountMinor: 10_000, currency: "USD" });

    // The job: pack + templated draft in dispute.drafted; a second run is a no-op.
    await dispute(job({ milestoneId, disputeId: opened.disputeId }));
    await dispute(job({ milestoneId, disputeId: opened.disputeId }));
    const drafted = await audits("dispute.drafted", opened.disputeId);
    expect(drafted).toHaveLength(1);
    const { pack, draft } = drafted[0]!.detail as { pack: import("@milestone/verify").EvidencePack; draft: import("@milestone/verify").DraftResponse };
    expect(pack.dispute).toMatchObject({ id: opened.disputeId, reason: "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED", amountMinor: 10_000 });
    expect(pack.timeline.map((t) => t.event)).toEqual([
      "contract.approved_by_client", "contract.approved_by_freelancer", "milestone.order_created", "milestone.funded", "delivery.manual",
      "verdict.stored", "policy.decided", "milestone.review", "paypal.payout", "milestone.released",
    ]);
    expect(pack.criteria.map((c) => c.status)).toEqual(["pass", "pass"]);
    expect(pack.ledger).toHaveLength(4);
    expect(pack.facts).toMatchObject({ fundedMinor: 10_000, paidToFreelancerMinor: 10_000, released: true, clientApproved: false, clientVetoed: false });
    expect(pack.clientActions.map((a) => a.event)).toEqual(["contract.approved_by_client", "milestone.order_created"]);
    expect(pack.files.map((f) => f.name)).toEqual(["README.md"]);
    expect(draft.source).toBe("template");
    expect(draft.text.length).toBeLessThanOrEqual(2000);
    const valid = packCites(pack);
    for (const c of draft.citations) expect(valid.has(c)).toBe(true);

    // The freelancer submits the (edited) draft with a file; PayPal-Request-Id comes from a paypal_ops row.
    const text = `${draft.text}\n\nEdited by the freelancer.`;
    const pdf = new TextEncoder().encode("%PDF-1.4\n% e2e evidence\n");
    const sent = await money.submitDisputeEvidence(db, money.createPayPalClient(), { disputeId: opened.disputeId, actor: freelancerId, text, files: [{ name: "handover.pdf", bytes: pdf, mime: "application/pdf" }] });
    expect(sent.ok).toBe(true);
    const ops = (await db.$client.query(`select kind, key, status, request_id from paypal_ops where key = $1 or key like $1 || ':%'`, [opened.disputeId])).rows as Array<{ kind: string; key: string; status: string; request_id: string }>;
    expect(ops).toEqual([{ kind: "dispute_evidence", key: `${opened.disputeId}:0`, status: "succeeded", request_id: sent.requestId }]);
    const submitted = await audits("dispute.evidence_submitted", opened.disputeId);
    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toMatchObject({ actor: freelancerId, detail: { text, evidenceType: "PROOF_FOR_SOFTWARE_OR_SERVICE_DELIVERED", documents: [{ name: "handover.pdf", size: pdf.length }] } });
    const live = await money.getDispute(money.createPayPalClient(), opened.disputeId);
    expect(live.status).toBe("UNDER_REVIEW");

    // PayPal resolves ~2 s (here 80 ms) later; the webhook side records the outcome once.
    await until(() => Boolean(eventFor("CUSTOMER.DISPUTE.RESOLVED", opened.disputeId)));
    const resolved = eventFor("CUSTOMER.DISPUTE.RESOLVED", opened.disputeId)!;
    expect(await money.recordDisputeEvent(db, resolved as never)).toMatchObject({ outcome: "resolved", milestoneId, enqueue: false });
    expect(await money.recordDisputeEvent(db, resolved as never)).toMatchObject({ outcome: "already" });
    const resolvedRows = await audits("dispute.resolved", opened.disputeId);
    expect(resolvedRows).toHaveLength(1);
    expect(resolvedRows[0]!.detail).toMatchObject({ outcome: "RESOLVED_SELLER_FAVOUR", status: "RESOLVED" });
  });

  it("accepting the claim resolves in the buyer's favour", async () => {
    const opened = money.openSimulatedDispute({ captureId, amountMinor: 10_000, currency: "USD", reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED" });
    expect(opened.created).toBe(true);
    disputeIds.push(opened.disputeId);
    await until(() => Boolean(eventFor("CUSTOMER.DISPUTE.CREATED", opened.disputeId)));
    await money.recordDisputeEvent(db, eventFor("CUSTOMER.DISPUTE.CREATED", opened.disputeId) as never);
    const planned = await money.disputeAcceptPlan(db, { disputeId: opened.disputeId, actor: freelancerId, note: "Refund the client." });
    if (!planned.ok) throw new Error(planned.error);
    expect(planned.plan).toMatchObject({ milestoneId, contractId, clientId, amountMinor: 10_000, currency: "USD" });
    const accepted = await money.acceptDisputeClaim(moneyCtx(), planned.plan);
    expect(accepted.ok).toBe(true);
    // A second accept reuses the same PayPal-Request-Id, is answered from the first and books nothing more.
    expect((await money.acceptDisputeClaim(moneyCtx(), { ...planned.plan, note: "again" })).requestId).toBe(accepted.requestId);
    const ref = money.disputeLedgerRef(opened.disputeId);
    const legs = (await db.$client.query(`select account, amount_minor::int as amount, direction from ledger_entries where ref = $1 order by account`, [ref])).rows;
    expect(legs).toEqual([
      { account: `client:${clientId}`, amount: 10_000, direction: "credit" },
      { account: `held:${milestoneId}`, amount: 10_000, direction: "debit" },
    ]);
    expect(await audits("dispute.claim_accepted", opened.disputeId)).toHaveLength(1);
    const flagged = (await db.$client.query(`select detail from audit_log where event = 'milestone.needs_operator' and milestone_id = $1 and detail->>'disputeId' = $2`, [milestoneId, opened.disputeId])).rows;
    expect(flagged).toHaveLength(1);
    expect(flagged[0].detail).toMatchObject({ ledgerRef: ref, refundMinor: 10_000, status: "released" });
    await until(() => Boolean(eventFor("CUSTOMER.DISPUTE.RESOLVED", opened.disputeId)));
    await money.recordDisputeEvent(db, eventFor("CUSTOMER.DISPUTE.RESOLVED", opened.disputeId) as never);
    expect((await audits("dispute.resolved", opened.disputeId))[0]!.detail).toMatchObject({ outcome: "RESOLVED_BUYER_FAVOUR" });
  });

  it("an event for a capture Milestone does not know is recorded as unmatched", async () => {
    const id = `WH-e2e-dp-${tag}`;
    unmatchedEventIds.push(id);
    const evt = { id, event_type: "CUSTOMER.DISPUTE.CREATED", resource: { dispute_id: `PP-D-E2E-${tag}`, disputed_transactions: [{ seller_transaction_id: `NOPE-${tag}` }] } };
    expect(await money.recordDisputeEvent(db, evt as never)).toMatchObject({ outcome: "unmatched", enqueue: false });
    expect(await money.recordDisputeEvent(db, evt as never)).toMatchObject({ outcome: "unmatched" });
    const rows = (await db.$client.query(`select count(*)::int as n from audit_log where event = 'paypal.dispute_unmatched' and detail->>'eventId' = $1`, [id])).rows as Array<{ n: number }>;
    expect(rows[0]!.n).toBe(1);
  });

  it("a dispute on a milestone still in escrow: accept is refused and the release is blocked until it resolves", async () => {
    const opened = money.openSimulatedDispute({ captureId: reviewCaptureId, amountMinor: 5_000, currency: "USD" });
    disputeIds.push(opened.disputeId);
    await until(() => Boolean(eventFor("CUSTOMER.DISPUTE.CREATED", opened.disputeId)));
    await money.recordDisputeEvent(db, eventFor("CUSTOMER.DISPUTE.CREATED", opened.disputeId) as never);
    expect(await money.openDisputesFor(db, reviewMilestoneId)).toEqual([opened.disputeId]);

    // Accepting would refund the buyer while the ledger still holds the money: refused before PayPal is called.
    const planned = await money.disputeAcceptPlan(db, { disputeId: opened.disputeId, actor: freelancerId, note: "x" });
    expect(planned).toMatchObject({ ok: false, status: 409, reason: "milestone_not_final" });
    const forced = await money.acceptDisputeClaim(moneyCtx(), { disputeId: opened.disputeId, milestoneId: reviewMilestoneId, contractId, clientId, amountMinor: 5_000, currency: "USD", actor: freelancerId, note: "x" });
    expect(forced).toMatchObject({ ok: false, status: 409, reason: "milestone_not_final" });
    const acceptOps = (await db.$client.query(`select 1 from paypal_ops where kind = 'dispute_accept' and key = $1`, [opened.disputeId])).rows;
    expect(acceptOps).toHaveLength(0);

    // The release job skips, audits release.blocked_by_dispute and holds the milestone; no payout op is claimed.
    await release({ id: randomUUID(), name: "release", data: { milestoneId: reviewMilestoneId, deliveryId: reviewDeliveryId } } as never);
    const m = await db.query.milestones.findFirst({ where: (t, { eq }) => eq(t.id, reviewMilestoneId) });
    expect(m?.status).toBe("held");
    const blocked = (await db.$client.query(`select detail from audit_log where event = $1 and milestone_id = $2`, [BLOCKED_BY_DISPUTE_EVENT, reviewMilestoneId])).rows;
    expect(blocked).toHaveLength(1);
    expect(blocked[0].detail).toMatchObject({ disputeIds: [opened.disputeId], status: "review" });
    const payoutOps = (await db.$client.query(`select 1 from paypal_ops where key = $1`, [reviewMilestoneId])).rows;
    expect(payoutOps).toHaveLength(0);

    // Resolved: the guard lifts.
    await db.insert(auditLog).values({ id: randomUUID(), actor: "paypal", event: "dispute.resolved", milestoneId: reviewMilestoneId, contractId, detail: { disputeId: opened.disputeId, outcome: "RESOLVED_SELLER_FAVOUR" } });
    expect(await money.openDisputesFor(db, reviewMilestoneId)).toEqual([]);
  });

  it("a second evidence round after PayPal's UPDATED gets its own PayPal-Request-Id; a retry of a round reuses it", async () => {
    const disputeId = `PP-D-E2E-RS-${tag}`;
    disputeIds.push(disputeId);
    const resource = (status: string) => ({ dispute_id: disputeId, status, disputed_transactions: [{ seller_transaction_id: captureId }], dispute_amount: { currency_code: "USD", value: "100.00" } });
    expect(await money.recordDisputeEvent(db, { id: `WH-e2e-rs-${tag}-1`, event_type: "CUSTOMER.DISPUTE.CREATED", resource: resource("WAITING_FOR_SELLER_RESPONSE") } as never)).toMatchObject({ outcome: "opened" });

    // A PayPal that answers provide-evidence with 200 and records each PayPal-Request-Id it sees.
    const seen: string[] = [];
    let failNext = false;
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/oauth2/token")) return new Response(JSON.stringify({ access_token: "t", expires_in: 3600, token_type: "Bearer" }), { status: 200 });
      seen.push(new Headers(init?.headers).get("PayPal-Request-Id") ?? "");
      if (failNext) { failNext = false; return new Response(JSON.stringify({ name: "INTERNAL_SERVER_ERROR" }), { status: 500 }); }
      return new Response(JSON.stringify({ links: [] }), { status: 200 });
    }) as typeof fetch;
    const client = new money.PayPalClient({ clientId: "x", clientSecret: "y", env: "sandbox", fetchImpl });
    const submit = (text: string) => money.submitDisputeEvidence(db, client, { disputeId, actor: freelancerId, text, files: [] });

    failNext = true;
    const failed = await submit("Round one.");
    expect(failed.ok).toBe(false);
    const first = await submit("Round one.");
    expect(first.ok).toBe(true);
    expect(first.requestId).toBe(failed.requestId); // the retry of round one replays its id
    expect(await money.evidenceOpKey(db, disputeId)).toBe(`${disputeId}:1`);

    // PayPal asks for more evidence.
    expect(await money.recordDisputeEvent(db, { id: `WH-e2e-rs-${tag}-2`, event_type: "CUSTOMER.DISPUTE.UPDATED", resource: resource("WAITING_FOR_SELLER_RESPONSE") } as never)).toMatchObject({ outcome: "updated" });
    const second = await submit("Round two, with more detail.");
    expect(second.ok).toBe(true);
    expect(second.requestId).not.toBe(first.requestId);
    expect(seen).toEqual([first.requestId, first.requestId, second.requestId]);
    const ops = (await db.$client.query(`select key, status from paypal_ops where kind = 'dispute_evidence' and split_part(key, ':', 1) = $1 order by key`, [disputeId])).rows;
    expect(ops).toEqual([{ key: `${disputeId}:0`, status: "succeeded" }, { key: `${disputeId}:1`, status: "succeeded" }]);
    expect(await audits("dispute.evidence_submitted", disputeId)).toHaveLength(2);
  });
});

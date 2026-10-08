/**
 * The money path (review route -> release job -> settle job) against the local Postgres, with PayPal faked at the
 * HTTP layer. Opt in: MILESTONE_E2E=1.
 *
 * Only PayPal is stubbed: the jobs get a real PayPalClient whose fetchImpl answers the token, payout and refund
 * calls and records every request, so "paid twice" shows up as two payout POSTs with different PayPal-Request-Ids.
 * The release and settle handlers are the real ones from src/jobs, and the review route's POST handler is called
 * directly (its session and db modules are swapped for the test's client and the worker's pool). enqueue is
 * recorded instead of sent to pg-boss. Every seeded row carries a random tag and is removed in afterAll.
 */
import { randomUUID } from "node:crypto";
import type { Job } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

type Call = { method: string; path: string; requestId: string | null; body: unknown };

const fake = vi.hoisted(() => {
  const calls: Array<{ method: string; path: string; requestId: string | null; body: unknown }> = [];
  /** When set, the payout POST waits for it: lets a test act while the PayPal call is in flight. */
  const gate: { payout: Promise<void> | null; entered: (() => void) | null } = { payout: null, entered: null };
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    if (url.host !== "api-m.sandbox.paypal.com") throw new Error(`fake PayPal: unexpected host ${url.host}`);
    if (url.pathname === "/v1/oauth2/token") return json(200, { access_token: "fake-token", token_type: "Bearer", expires_in: 3600 });
    const requestId = headers.get("PayPal-Request-Id");
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    calls.push({ method, path: url.pathname, requestId, body });
    if (method === "POST" && url.pathname === "/v1/payments/payouts") {
      if (gate.payout) {
        gate.entered?.();
        await gate.payout;
      }
      return json(201, { batch_header: { payout_batch_id: `BATCH-${requestId}`, batch_status: "PENDING", sender_batch_header: { sender_batch_id: requestId } } });
    }
    const refund = /^\/v2\/payments\/captures\/([^/]+)\/refund$/.exec(url.pathname);
    if (method === "POST" && refund) return json(201, { id: `REF-${requestId}`, status: "PENDING", links: [{ rel: "up", href: `https://api-m.sandbox.paypal.com/v2/payments/captures/${refund[1]}` }] });
    return json(404, { name: "RESOURCE_NOT_FOUND", message: `fake PayPal has no ${method} ${url.pathname}` });
  };
  const state = { actor: { userId: "", role: "client" as const }, client: null as unknown };
  const client = async () => {
    if (!state.client) {
      const { PayPalClient } = await import("@milestone/money");
      state.client = new PayPalClient({ clientId: "fake-id", clientSecret: "fake-secret", env: "sandbox", fetchImpl: fetchImpl as typeof fetch });
    }
    return state.client;
  };
  const enqueued: Array<{ name: string; milestoneId: string; data: Record<string, unknown> }> = [];
  return { calls, gate, client, state, enqueued };
});

// The jobs' PayPal hook (src/lib/paypal.ts) and the web app's (apps/web/src/lib/paypal.ts) both get the fake client.
vi.mock("../src/lib/paypal.js", async () => {
  const c = await fake.client();
  return { paypal: () => c };
});
vi.mock("@/lib/paypal", async () => {
  const c = await fake.client();
  return { paypal: () => c };
});
// The web app's own session and response helpers (its "@/" alias does not resolve from here), with the actor faked.
vi.mock("@/lib/session", async () => ({
  ...(await import(/* @vite-ignore */ new URL("../../web/src/lib/session.ts", import.meta.url).pathname)),
  getActor: async () => fake.state.actor,
}));
vi.mock("@/lib/http", () => import(/* @vite-ignore */ new URL("../../web/src/lib/http.ts", import.meta.url).pathname));
vi.mock("@/lib/db", async () => {
  const { getDb } = await import("../src/lib/db.ts");
  return { getDb };
});
vi.mock("@milestone/core", async (orig) => ({
  ...(await orig<typeof import("@milestone/core")>()),
  enqueue: async (name: string, milestoneId: string, data: Record<string, unknown>) => {
    fake.enqueued.push({ name, milestoneId, data });
    return "job";
  },
}));

const run = process.env.MILESTONE_E2E === "1";
try {
  process.loadEnvFile(new URL("../../../.env", import.meta.url).pathname);
} catch {
  /* env already set */
}

type AnyJob = Job<{ milestoneId: string } & Record<string, unknown>>;
const job = (data: { milestoneId: string } & Record<string, unknown>) => ({ id: randomUUID(), name: "x", data }) as unknown as AnyJob;
const payoutPosts = (calls: readonly Call[]) => calls.filter((c) => c.method === "POST" && c.path === "/v1/payments/payouts");
const refundPosts = (calls: readonly Call[]) => calls.filter((c) => c.method === "POST" && c.path.endsWith("/refund"));

describe.skipIf(!run)("money path: review route, release and settle against Postgres with a fake PayPal", async () => {
  const core = await import("@milestone/core");
  const { and, eq, inArray, like, or, sql } = await import("drizzle-orm");
  const { contracts, milestones, users, criteria, deliveries, webhookEvents, paypalOps, ledgerEntries, auditLog, accounts, postTransaction } = core;
  const { getDb } = await import("../src/lib/db.ts");
  const { release } = await import("../src/jobs/release.ts");
  const { settle } = await import("../src/jobs/settle.ts");
  // The review route's real POST handler. Kept out of the worker's typecheck (tsconfig includes src only).
  const routePath = new URL("../../web/src/app/api/milestones/[id]/review/route.ts", import.meta.url).pathname;
  const route = (await import(/* @vite-ignore */ routePath)) as { POST: (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response> };

  const db = getDb();
  const tag = randomUUID().slice(0, 8);
  const contractId = `ctr_e2e_mp_${tag}`;
  const clientId = `usr_e2e_mpc_${tag}`;
  const freelancerId = `usr_e2e_mpf_${tag}`;
  const milestoneIds: string[] = [];
  const eventIds: string[] = [];
  const hour = 3_600_000;

  async function review(milestoneId: string, action: string): Promise<{ status: number; body: Record<string, unknown> }> {
    const req = new Request(`http://localhost/api/milestones/${milestoneId}/review`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action }) });
    const res = await route.POST(req, { params: Promise.resolve({ id: milestoneId }) });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  const prevPayPalMode = process.env.PAYPAL_MODE;
  beforeAll(async () => {
    // No receipt invoices: settle skips them without PayPal credentials, so the fake only has to answer payouts/refunds.
    // .env may say PAYPAL_MODE=simulated, under which settle issues receipts anyway (against this fake, which 404s).
    process.env.PAYPAL_MODE = "sandbox";
    delete process.env.PAYPAL_CLIENT_ID;
    delete process.env.PAYPAL_CLIENT_SECRET;
    fake.state.actor = { userId: clientId, role: "client" };
    await db.insert(users).values([
      { id: clientId, role: "client", name: "c", email: `c-${tag}@e2e.test` },
      { id: freelancerId, role: "freelancer", name: "f", email: `f-${tag}@e2e.test`, paypalEmail: `f-${tag}@e2e.test` },
    ]);
    await db.insert(contracts).values({ id: contractId, clientId, freelancerId, title: "e2e money path", scopeText: "e2e", currency: "USD", totalMinor: 100_000, status: "active" });
  });

  afterAll(async () => {
    if (prevPayPalMode === undefined) delete process.env.PAYPAL_MODE;
    else process.env.PAYPAL_MODE = prevPayPalMode;
    if (milestoneIds.length > 0) {
      const held = milestoneIds.map((id) => accounts.held(id));
      const txns = db.select({ txnId: ledgerEntries.txnId }).from(ledgerEntries).where(inArray(ledgerEntries.account, held));
      await db.delete(ledgerEntries).where(inArray(ledgerEntries.txnId, txns));
      await db.delete(auditLog).where(or(eq(auditLog.contractId, contractId), inArray(auditLog.milestoneId, milestoneIds)));
      await db.delete(paypalOps).where(or(inArray(paypalOps.key, milestoneIds), ...milestoneIds.map((id) => like(paypalOps.key, `${id}:%`))));
      await db.delete(deliveries).where(inArray(deliveries.milestoneId, milestoneIds));
      await db.delete(criteria).where(inArray(criteria.milestoneId, milestoneIds));
      await db.delete(milestones).where(inArray(milestones.id, milestoneIds));
    }
    if (eventIds.length > 0) await db.delete(webhookEvents).where(and(eq(webhookEvents.source, "paypal"), inArray(webhookEvents.eventId, eventIds)));
    await db.delete(auditLog).where(eq(auditLog.contractId, contractId));
    await db.delete(contracts).where(eq(contracts.id, contractId));
    await db.delete(users).where(inArray(users.id, [clientId, freelancerId]));
    const left = await db.select({ n: sql<number>`count(*)::int` }).from(milestones).where(eq(milestones.contractId, contractId));
    expect(left[0]?.n).toBe(0);
  });

  interface Seed {
    status: "review" | "needs_client";
    decision: { action: string; amountMinor: number; ruleIds: string[]; reason: string };
    /** Milliseconds from now; negative = the window already closed. Ignored for needs_client. */
    reviewEndsIn?: number;
    clientResponse?: string;
    /** Store the decision for this delivery instead of the seeded one (a newer delivery superseded the job's). */
    decisionDeliveryId?: string;
  }

  let seq = 0;
  /** A funded milestone (client -> held posted) in review or needs_client, with one required criterion that passed. */
  async function seed(s: Seed) {
    seq += 1;
    const milestoneId = `mst_e2e_mp_${tag}_${seq}`;
    const deliveryId = `dlv_e2e_mp_${tag}_${seq}`;
    const critId = `crt_e2e_mp_${tag}_${seq}`;
    const captureId = `CAP-E2E-${tag}-${seq}`;
    milestoneIds.push(milestoneId);
    await db.insert(milestones).values({
      id: milestoneId,
      contractId,
      seq,
      title: `m${seq}`,
      amountMinor: 10_000,
      status: s.status,
      paypalCaptureId: captureId,
      decision: { ...s.decision, deliveryId: s.decisionDeliveryId ?? deliveryId } as never,
      decidedAt: new Date(),
      reviewEndsAt: s.status === "review" ? new Date(Date.now() + (s.reviewEndsIn ?? -60_000)) : null,
      clientResponse: s.clientResponse ?? null,
    });
    await db.insert(criteria).values({ id: critId, milestoneId, kind: "test", description: "tests pass", spec: {}, required: true });
    const verdict = (id: string) => ({ delivery_id: id, suspected_injection: false, criteria: [{ criterion_id: critId, status: "pass", confidence: 0.95, evidence_ids: ["evd_1"], rationale: "ok" }] });
    await db.insert(deliveries).values({ id: deliveryId, milestoneId, source: "manual", ref: `e2e-${seq}`, verdict: verdict(deliveryId), result: "pass", verifiedAt: new Date() });
    if (s.decisionDeliveryId && s.decisionDeliveryId !== deliveryId) {
      await db.insert(deliveries).values({ id: s.decisionDeliveryId, milestoneId, source: "manual", ref: `e2e-${seq}-b`, verdict: verdict(s.decisionDeliveryId), result: "pass", verifiedAt: new Date() });
    }
    await postTransaction(db, {
      ref: captureId,
      currency: "USD",
      entries: [
        { account: accounts.client(clientId), amountMinor: 10_000, direction: "debit" },
        { account: accounts.held(milestoneId), amountMinor: 10_000, direction: "credit" },
      ],
    });

    const state = async () => {
      const [m] = await db.select().from(milestones).where(eq(milestones.id, milestoneId));
      const ops = await db
        .select()
        .from(paypalOps)
        .where(or(eq(paypalOps.key, milestoneId), like(paypalOps.key, `${milestoneId}:%`)))
        .orderBy(paypalOps.kind, paypalOps.key);
      const heldTxns = db.select({ txnId: ledgerEntries.txnId }).from(ledgerEntries).where(eq(ledgerEntries.account, accounts.held(milestoneId)));
      const ledger = await db
        .select({ txnId: ledgerEntries.txnId, ref: ledgerEntries.ref, account: ledgerEntries.account, amount: ledgerEntries.amountMinor, direction: ledgerEntries.direction })
        .from(ledgerEntries)
        .where(inArray(ledgerEntries.txnId, heldTxns))
        .orderBy(ledgerEntries.ref, ledgerEntries.account);
      const audits = (await db.select({ event: auditLog.event }).from(auditLog).where(eq(auditLog.milestoneId, milestoneId)).orderBy(auditLog.createdAt)).map((r) => r.event);
      return { m: m!, ops, ledger, audits };
    };
    return { milestoneId, deliveryId, critId, state };
  }

  async function payoutWebhook(milestoneId: string, batchId: string, payoutItemId: string, type = "PAYMENT.PAYOUTS-ITEM.SUCCEEDED") {
    const eventId = `WH-E2E-MP-${tag}-${randomUUID().slice(0, 8)}`;
    eventIds.push(eventId);
    const resource = {
      payout_batch_id: batchId,
      payout_item_id: payoutItemId,
      transaction_status: type.endsWith("SUCCEEDED") ? "SUCCESS" : "FAILED",
      payout_item: { sender_item_id: `${milestoneId}:freelancer`, receiver: `f-${tag}@e2e.test`, amount: { value: "100.00", currency: "USD" } },
    };
    await db.insert(webhookEvents).values({ id: randomUUID(), source: "paypal", eventId, type, payload: { id: eventId, event_type: type, resource } });
    return eventId;
  }

  const signedSum = (rows: ReadonlyArray<{ amount: number; direction: string }>) => rows.reduce((s, r) => s + (r.direction === "debit" ? r.amount : -r.amount), 0);
  const release6 = { action: "release", amountMinor: 10_000, ruleIds: ["P6"], reason: "all criteria passed" };

  it("1. a veto before the window ends holds the milestone and the release job sends no payout", async () => {
    const t = await seed({ status: "review", decision: release6, reviewEndsIn: hour });
    fake.calls.length = 0;
    const veto = await review(t.milestoneId, "veto");
    expect(veto).toMatchObject({ status: 200, body: { ok: true, status: "held" } });

    await release(job({ milestoneId: t.milestoneId, deliveryId: t.deliveryId }));
    expect(payoutPosts(fake.calls)).toHaveLength(0);
    expect(fake.calls).toHaveLength(0);
    const s = await t.state();
    expect(s.m.status).toBe("held");
    expect(s.m.clientResponse).toBe("veto");
    expect(s.ops).toEqual([]);
    expect(s.audits).toEqual(["client.veto", "release.skipped"]); // the route's transition to held is logged as client.veto
  });

  it("2. a hold after a partial decision sends neither a payout nor a refund", async () => {
    const t = await seed({ status: "needs_client", decision: { action: "partial", amountMinor: 6_000, ruleIds: ["P5"], reason: "2 of 3 criteria" } });
    fake.calls.length = 0;
    const hold = await review(t.milestoneId, "hold");
    expect(hold).toMatchObject({ status: 200, body: { ok: true, status: "held" } });

    await release(job({ milestoneId: t.milestoneId, deliveryId: t.deliveryId }));
    expect(payoutPosts(fake.calls)).toHaveLength(0);
    expect(refundPosts(fake.calls)).toHaveLength(0);
    const s = await t.state();
    expect(s.m.status).toBe("held");
    expect(s.ops).toEqual([]);
  });

  it("3. a stale job (decision belongs to a newer delivery) sends nothing and leaves the milestone untouched", async () => {
    const newer = `dlv_e2e_mp_${tag}_newer`;
    const t = await seed({ status: "review", decision: release6, reviewEndsIn: -60_000, decisionDeliveryId: newer });
    const before = (await t.state()).m;
    fake.calls.length = 0;

    await release(job({ milestoneId: t.milestoneId, deliveryId: t.deliveryId }));
    expect(fake.calls).toHaveLength(0);
    const s = await t.state();
    expect(s.m).toEqual(before);
    expect(s.ops).toEqual([]);
    expect(s.audits).toContain("release.skipped");
  });

  it("4. window expired, no response: one payout POST, a re-run sends none, released only when settle sees the webhook", async () => {
    const t = await seed({ status: "review", decision: release6, reviewEndsIn: -60_000 });
    fake.calls.length = 0;

    await release(job({ milestoneId: t.milestoneId, deliveryId: t.deliveryId }));
    const first = payoutPosts(fake.calls);
    expect(first).toHaveLength(1);
    expect(first[0]!.requestId).toBeTruthy();
    expect(first[0]!.body).toMatchObject({ items: [{ amount: { value: "100.00", currency: "USD" }, sender_item_id: `${t.milestoneId}:freelancer` }] });
    expect(refundPosts(fake.calls)).toHaveLength(0);

    await release(job({ milestoneId: t.milestoneId, deliveryId: t.deliveryId }));
    await release(job({ milestoneId: t.milestoneId, deliveryId: t.deliveryId }));
    const all = payoutPosts(fake.calls);
    expect(all).toHaveLength(1);
    expect(new Set(all.map((c) => c.requestId)).size).toBe(1);

    const s1 = await t.state();
    expect(s1.m.status).toBe("review"); // CLAUDE.md rule 7: never released on the call's return
    expect(s1.ops).toHaveLength(1);
    expect(s1.ops[0]).toMatchObject({ kind: "payout", key: t.milestoneId, status: "sent", requestId: first[0]!.requestId, paypalId: `BATCH-${first[0]!.requestId}` });
    expect(s1.ledger.filter((l) => l.ref.startsWith("release:"))).toEqual([]);

    const e = await payoutWebhook(t.milestoneId, s1.ops[0]!.paypalId!, `ITEM-${tag}-4`);
    await settle(job({ milestoneId: t.milestoneId, eventId: e }));
    const s2 = await t.state();
    expect(s2.m.status).toBe("released");
    expect(s2.ops.find((o) => o.kind === "payout")).toMatchObject({ kind: "payout", status: "succeeded" });
    const releaseRows = s2.ledger.filter((l) => l.ref === `release:${t.milestoneId}`);
    expect(new Set(releaseRows.map((l) => l.txnId)).size).toBe(1);
    expect(releaseRows.map(({ account, amount, direction }) => ({ account, amount, direction }))).toEqual([
      { account: accounts.freelancer(freelancerId), amount: 10_000, direction: "credit" },
      { account: accounts.held(t.milestoneId), amount: 10_000, direction: "debit" },
    ]);
    // Every transaction balances, the whole milestone balances, and nothing is left in escrow.
    for (const txn of new Set(s2.ledger.map((l) => l.txnId))) expect(signedSum(s2.ledger.filter((l) => l.txnId === txn))).toBe(0);
    expect(signedSum(s2.ledger)).toBe(0);
    expect(signedSum(s2.ledger.filter((l) => l.account === accounts.held(t.milestoneId)))).toBe(0);
    const [w] = await db.select({ processedAt: webhookEvents.processedAt }).from(webhookEvents).where(eq(webhookEvents.eventId, e));
    expect(w?.processedAt).toBeInstanceOf(Date);

    // A late release job after settling still pays nothing.
    await release(job({ milestoneId: t.milestoneId, deliveryId: t.deliveryId }));
    expect(payoutPosts(fake.calls)).toHaveLength(1);
  });

  it("5. settle for two different event ids on the same payout item posts the ledger once", async () => {
    const t = await seed({ status: "review", decision: release6, reviewEndsIn: -60_000 });
    fake.calls.length = 0;
    await release(job({ milestoneId: t.milestoneId, deliveryId: t.deliveryId }));
    expect(payoutPosts(fake.calls)).toHaveLength(1);
    const batch = (await t.state()).ops[0]!.paypalId!;

    const a = await payoutWebhook(t.milestoneId, batch, `ITEM-${tag}-5`);
    const b = await payoutWebhook(t.milestoneId, batch, `ITEM-${tag}-5`);
    await settle(job({ milestoneId: t.milestoneId, eventId: a }));
    await settle(job({ milestoneId: t.milestoneId, eventId: b }));
    // And two more redeliveries racing each other.
    const c = await payoutWebhook(t.milestoneId, batch, `ITEM-${tag}-5`);
    const d = await payoutWebhook(t.milestoneId, batch, `ITEM-${tag}-5`);
    await Promise.all([settle(job({ milestoneId: t.milestoneId, eventId: c })), settle(job({ milestoneId: t.milestoneId, eventId: d }))]);

    const s = await t.state();
    expect(s.m.status).toBe("released");
    const releaseRows = s.ledger.filter((l) => l.ref.startsWith("release:"));
    expect(new Set(releaseRows.map((l) => l.txnId)).size).toBe(1);
    expect(releaseRows).toHaveLength(2);
    expect(signedSum(s.ledger)).toBe(0);
    expect(s.audits.filter((e) => e === "milestone.released")).toHaveLength(1);
    const rows = await db.select({ processedAt: webhookEvents.processedAt }).from(webhookEvents).where(inArray(webhookEvents.eventId, [a, b, c, d]));
    expect(rows).toHaveLength(4);
    for (const r of rows) expect(r.processedAt).toBeInstanceOf(Date);
    expect(payoutPosts(fake.calls)).toHaveLength(1);
  });

  it("6. a veto that arrives after the payout op was claimed is refused by the review route", async () => {
    // Early approval inside the window: the route enqueues the release job.
    const t = await seed({ status: "review", decision: release6, reviewEndsIn: hour });
    fake.calls.length = 0;
    fake.enqueued.length = 0;
    const approve = await review(t.milestoneId, "approve");
    expect(approve).toMatchObject({ status: 200, body: { ok: true, queued: "release" } });
    expect(fake.enqueued).toEqual([{ name: "release", milestoneId: t.milestoneId, data: { deliveryId: t.deliveryId } }]);

    // Run the queued job, holding PayPal's answer so the veto lands while the payout is in flight (claimed, not answered).
    let open!: () => void;
    let entered!: () => void;
    const inFlight = new Promise<void>((r) => (entered = r));
    fake.gate.payout = new Promise<void>((r) => (open = r));
    fake.gate.entered = entered;
    const queued = fake.enqueued[0]!;
    const running = release(job({ milestoneId: queued.milestoneId, ...queued.data }));
    try {
      await inFlight;
      const claimed = await t.state();
      expect(claimed.ops).toMatchObject([{ kind: "payout", key: t.milestoneId, status: "sent", paypalId: null }]);

      const veto = await review(t.milestoneId, "veto");
      expect(veto.status).toBe(409);
      expect(veto.body).toMatchObject({ reason: "payout_sent" });
    } finally {
      open();
      fake.gate.payout = null;
      fake.gate.entered = null;
    }
    await running;
    expect(payoutPosts(fake.calls)).toHaveLength(1);

    // After PayPal answered, still refused; the milestone stays in review with the approval on it.
    const again = await review(t.milestoneId, "veto");
    expect(again).toMatchObject({ status: 409, body: { reason: "payout_sent" } });
    const s = await t.state();
    expect(s.m.status).toBe("review");
    expect(s.m.clientResponse).toBe("approve");
    expect(s.audits).not.toContain("client.veto");
  });

  it("6b. a veto after the review window closed is refused even before the job claims the payout", async () => {
    const t = await seed({ status: "review", decision: release6, reviewEndsIn: -60_000 });
    fake.calls.length = 0;
    const veto = await review(t.milestoneId, "veto");
    expect(veto).toMatchObject({ status: 409, body: { reason: "review_window_closed" } });
    const s = await t.state();
    expect(s.m.status).toBe("review");
    expect(s.m.clientResponse).toBeNull();

    await release(job({ milestoneId: t.milestoneId, deliveryId: t.deliveryId }));
    expect(payoutPosts(fake.calls)).toHaveLength(1);
  });

  it("6c. a veto racing the release job: either the veto wins and nothing is paid, or it is refused and one payout goes out", async () => {
    for (let i = 0; i < 5; i++) {
      const t = await seed({ status: "review", decision: release6, reviewEndsIn: hour, clientResponse: "approve" });
      fake.calls.length = 0;
      const [, veto] = await Promise.all([release(job({ milestoneId: t.milestoneId, deliveryId: t.deliveryId })), review(t.milestoneId, "veto")]);
      const s = await t.state();
      const paid = payoutPosts(fake.calls).length;
      if (veto.status === 200) {
        expect(paid).toBe(0);
        expect(s.m.status).toBe("held");
        expect(s.ops).toEqual([]);
      } else {
        expect(veto).toMatchObject({ status: 409, body: { reason: "payout_sent" } });
        expect(paid).toBe(1);
        expect(s.m.status).toBe("review");
      }
    }
  });
  it("7. R6: after an earlier delivery's payout, a new delivery's approve/veto get 409 needs_operator and the job refuses", async () => {
    const t = await seed({ status: "review", decision: release6, reviewEndsIn: -60_000 });
    fake.calls.length = 0;
    await release(job({ milestoneId: t.milestoneId, deliveryId: t.deliveryId }));
    expect(payoutPosts(fake.calls)).toHaveLength(1);

    // Re-verification of a new delivery puts the milestone back in review with a decision for that delivery.
    const d2 = `${t.deliveryId}_b`;
    await db.insert(deliveries).values({ id: d2, milestoneId: t.milestoneId, source: "manual", ref: `e2e-${t.milestoneId}-b`, verdict: { delivery_id: d2, suspected_injection: false, criteria: [{ criterion_id: t.critId, status: "pass", confidence: 0.95, evidence_ids: ["evd_1"], rationale: "ok" }] }, result: "pass", verifiedAt: new Date() });
    await db
      .update(milestones)
      .set({ status: "review", decision: { ...release6, deliveryId: d2 } as never, reviewEndsAt: new Date(Date.now() + hour), clientResponse: null })
      .where(eq(milestones.id, t.milestoneId));

    const approve = await review(t.milestoneId, "approve");
    expect(approve).toMatchObject({ status: 409, body: { reason: "needs_operator" } });
    const veto = await review(t.milestoneId, "veto");
    expect(veto).toMatchObject({ status: 409, body: { reason: "needs_operator" } });

    await release(job({ milestoneId: t.milestoneId, deliveryId: d2 }));
    expect(payoutPosts(fake.calls)).toHaveLength(1);
    const s = await t.state();
    expect(s.audits).toContain("release.refused_needs_operator");
    expect(s.ops).toHaveLength(1);
    expect(s.m.clientResponse).toBeNull();
  });
});

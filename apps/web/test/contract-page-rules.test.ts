/**
 * The contract page's pure rules: when a delivery still waits for its verdict, when the review card offers
 * a partial release, the PayPal background-tab error, what counts as one of a contract's PayPal calls,
 * and when a dispute's claim can be accepted. countContractOps also runs against Postgres when MILESTONE_E2E=1.
 */
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { e2e, loadRootEnv } from "./helpers";

vi.mock("@/lib/db", () => ({ getDb: () => { throw new Error("no database in this test"); } }));

import { AWAITING_VERDICT_MS, awaitingVerdict } from "../src/components/live-rules";
import { offersPartial } from "../src/components/review-card-panel";
import { BACKGROUND_TAB_NOTICE, isBackgroundTabError } from "../src/components/fund-button";
import { canAcceptClaim } from "../src/components/dispute-card";
import { countContractOps, disputeIdsOf, disputeOfKey, opBelongsTo, type OpScope } from "../src/app/contracts/[id]/activity/paypal-ops";

const NOW = Date.parse("2026-10-08T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms);

describe("awaitingVerdict", () => {
  it("is true for a fresh delivery with no verdict, whatever the milestone status", () => {
    expect(awaitingVerdict({ result: null, verifiedAt: null, receivedAt: ago(2_000) }, NOW)).toBe(true);
    expect(awaitingVerdict({ result: null, receivedAt: ago(2_000).toISOString() }, NOW)).toBe(true);
  });
  it("is false once the verdict is stored", () => {
    expect(awaitingVerdict({ result: "pass", verifiedAt: ago(1_000), receivedAt: ago(5_000) }, NOW)).toBe(false);
    expect(awaitingVerdict({ result: null, verifiedAt: ago(1_000), receivedAt: ago(5_000) }, NOW)).toBe(false);
  });
  it("is false with no delivery, or one stuck longer than the window", () => {
    expect(awaitingVerdict(null, NOW)).toBe(false);
    expect(awaitingVerdict(undefined, NOW)).toBe(false);
    expect(awaitingVerdict({ result: null, receivedAt: ago(AWAITING_VERDICT_MS + 1) }, NOW)).toBe(false);
    expect(awaitingVerdict({ result: null, receivedAt: "not a date" }, NOW)).toBe(false);
  });
});

describe("offersPartial", () => {
  it("offers a partial release only on a partial decision with a share above zero", () => {
    expect(offersPartial("partial", 6000)).toBe(true);
    expect(offersPartial("partial", 0)).toBe(false);
    expect(offersPartial("partial", null)).toBe(false);
    expect(offersPartial("partial", undefined)).toBe(false);
    expect(offersPartial("partial", Number.NaN)).toBe(false);
  });
  it("never on ask_client (the policy proposes 0, which the release job would refund in full)", () => {
    expect(offersPartial("ask_client", 0)).toBe(false);
    expect(offersPartial("ask_client", 5000)).toBe(false);
    expect(offersPartial("hold", 5000)).toBe(false);
    expect(offersPartial(null, 5000)).toBe(false);
  });
});

describe("isBackgroundTabError", () => {
  it("recognises the SDK's background-tab refusal in any shape", () => {
    const text = "Cannot show PaymentRequest UI in a preview page or a background tab.";
    expect(isBackgroundTabError(new Error(text))).toBe(true);
    expect(isBackgroundTabError(text)).toBe(true);
    expect(isBackgroundTabError({ name: "InvalidStateError", message: text })).toBe(true);
  });
  it("leaves other errors alone", () => {
    expect(isBackgroundTabError(new Error("Client token: 401 Unauthorized"))).toBe(false);
    expect(isBackgroundTabError(undefined)).toBe(false);
    expect(isBackgroundTabError({ code: 1 })).toBe(false);
  });
  it("tells the user what to do", () => {
    expect(BACKGROUND_TAB_NOTICE).toBe("Bring this tab to the front and click Fund again.");
  });
});

describe("canAcceptClaim", () => {
  it("only once the money left escrow", () => {
    expect(canAcceptClaim("released")).toBe(true);
    expect(canAcceptClaim("partial_released")).toBe(true);
    for (const s of ["draft", "funded", "verifying", "review", "needs_client", "held", undefined, null]) expect(canAcceptClaim(s)).toBe(false);
  });
});

describe("contract PayPal calls", () => {
  const scope: OpScope = { milestoneIds: ["mst_1", "mst_2"], advanceIds: ["adv_1"], disputeIds: ["PP-D-1"] };
  it("counts each milestone op kind, the advance payout and the dispute calls", () => {
    const mine = [
      { kind: "order", key: "mst_1" },
      { kind: "capture", key: "mst_1" },
      { kind: "payout", key: "mst_1" },
      { kind: "refund", key: "mst_2" },
      { kind: "invoice", key: "mst_1" },
      { kind: "advance-payout", key: "adv_1" },
      { kind: "dispute_evidence", key: "PP-D-1:0" },
      { kind: "dispute_evidence", key: "PP-D-1:1" },
      { kind: "dispute_accept", key: "PP-D-1" },
    ];
    for (const op of mine) expect(opBelongsTo(op, scope), `${op.kind} ${op.key}`).toBe(true);
  });
  it("skips other contracts' ops and mismatched keys", () => {
    const theirs = [
      { kind: "order", key: "mst_9" },
      { kind: "advance-payout", key: "mst_1" },
      { kind: "advance-payout", key: "adv_9" },
      { kind: "dispute_accept", key: "PP-D-2" },
      { kind: "dispute_evidence", key: "PP-D-2:0" },
      { kind: "dispute_accept", key: "mst_1" },
    ];
    for (const op of theirs) expect(opBelongsTo(op, scope), `${op.kind} ${op.key}`).toBe(false);
  });
  it("reads dispute ids from the audit log and evidence keys", () => {
    expect(disputeOfKey("PP-D-1:3")).toBe("PP-D-1");
    expect(disputeOfKey("PP-D-1")).toBe("PP-D-1");
    expect(
      disputeIdsOf([
        { event: "dispute.opened", detail: { disputeId: "PP-D-1" } },
        { event: "dispute.drafted", detail: { disputeId: "PP-D-1" } },
        { event: "dispute.opened", detail: { disputeId: "PP-D-2" } },
        { event: "paypal.capture.completed", detail: { disputeId: "PP-D-3" } },
        { event: "dispute.opened", detail: null },
      ]),
    ).toEqual(["PP-D-1", "PP-D-2"]);
  });
});

describe.skipIf(!e2e)("countContractOps against Postgres", () => {
  loadRootEnv();
  // Imported lazily so the plain run needs no database.
  const tag = randomUUID().slice(0, 8);
  const keys: string[] = [];
  let db: import("@milestone/core").Db;

  afterAll(async () => {
    if (!db) return;
    const { paypalOps } = await import("@milestone/core");
    const { inArray } = await import("drizzle-orm");
    if (keys.length) await db.delete(paypalOps).where(inArray(paypalOps.key, keys));
    const left = await db.select({ id: paypalOps.id }).from(paypalOps).where(inArray(paypalOps.key, keys));
    expect(left).toHaveLength(0);
  });

  it("counts every op row for the contract's milestones and disputes, nothing else", async () => {
    const core = await import("@milestone/core");
    db = core.createDb();
    const m1 = `mst_t_${tag}_1`;
    const m2 = `mst_t_${tag}_2`;
    const other = `mst_t_${tag}_other`;
    const dispute = `PP-D-T-${tag}`;
    const rows = [
      ["order", m1],
      ["capture", m1],
      ["payout", m1],
      ["invoice", m1],
      ["order", m2],
      ["capture", m2],
      ["refund", m2],
      ["dispute_evidence", `${dispute}:0`],
      ["dispute_accept", dispute],
      ["order", other],
      ["dispute_accept", `PP-D-T-${tag}-x`],
    ] as const;
    for (const [kind, key] of rows) {
      keys.push(key);
      await db.insert(core.paypalOps).values({ id: randomUUID(), kind, key, requestId: randomUUID() });
    }
    expect(await countContractOps(db, { milestoneIds: [m1, m2], disputeIds: [dispute] })).toBe(9);
    expect(await countContractOps(db, { milestoneIds: [m1, m2], disputeIds: [] })).toBe(7);
    expect(await countContractOps(db, { milestoneIds: [], disputeIds: [dispute] })).toBe(0);
  });
});

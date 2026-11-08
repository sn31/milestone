import { describe, expect, it } from "vitest";
import { PayPalError, advanceRepayment, applyReviewWindow } from "@milestone/money";
import { decisionDeliveryId, requiredNotPassed, type PolicyDecision } from "@milestone/core";
import {
  allocateRepayment,
  canHold,
  itemOutcomes,
  itemReversals,
  operatorSummary,
  parseClaim,
  payoutShares,
  type OpView,
  type ReleaseClaim,
} from "../src/jobs/claim.ts";
import { clientOutcome, leaseState, netDues, parseDecision, payoutPlan, refundPlan, releaseGate, reviewWindowState, staleReason, type OpenDue } from "../src/jobs/release.ts";
import { LEASE_MS, isLastAttempt, paypalFailure } from "../src/jobs/retry.ts";

const release: PolicyDecision = { action: "release", amountMinor: 50_000, ruleIds: ["P6"], reason: "all passed" };
const partial: PolicyDecision = { action: "partial", amountMinor: 30_000, ruleIds: ["P5"], reason: "2 of 3" };
const now = new Date("2026-10-17T12:00:00Z");
const before = new Date("2026-10-17T11:59:59Z");
const after = new Date("2026-10-17T12:00:01Z");

describe("reviewWindowState", () => {
  it("expires when reviewEndsAt is at or before now", () => {
    expect(reviewWindowState(release, { clientResponse: null, reviewEndsAt: now }, now).windowExpired).toBe(true);
    expect(reviewWindowState(release, { clientResponse: null, reviewEndsAt: before }, now).windowExpired).toBe(true);
    expect(reviewWindowState(release, { clientResponse: null, reviewEndsAt: after }, now).windowExpired).toBe(false);
  });

  it("treats a missing reviewEndsAt as an open window", () => {
    expect(reviewWindowState(release, { clientResponse: null, reviewEndsAt: null }, now).windowExpired).toBe(false);
  });

  it("maps client responses", () => {
    const s = (r: string | null) => reviewWindowState(release, { clientResponse: r, reviewEndsAt: after }, now);
    expect(s("veto")).toMatchObject({ vetoed: true, approvedEarly: false });
    expect(s("approve")).toMatchObject({ vetoed: false, approvedEarly: true });
    expect(s("confirm_partial")).toMatchObject({ vetoed: false, approvedEarly: true });
    expect(s("something_else")).toMatchObject({ vetoed: false, approvedEarly: false });
    expect(s(null)).toMatchObject({ vetoed: false, approvedEarly: false });
  });

  it("feeds applyReviewWindow to the expected outcome", () => {
    const outcome = (d: PolicyDecision, r: string | null, ends: Date | null) => applyReviewWindow(reviewWindowState(d, { clientResponse: r, reviewEndsAt: ends }, now)).action;
    expect(outcome(release, null, before)).toBe("release");
    expect(outcome(release, null, after)).toBe("ask_client");
    expect(outcome(release, "approve", after)).toBe("release");
    expect(outcome(release, "veto", before)).toBe("hold");
    expect(outcome(partial, "confirm_partial", after)).toBe("partial");
    expect(outcome(partial, "veto", after)).toBe("hold");
  });
});

describe("parseDecision", () => {
  it("accepts a stored decision and rejects junk", () => {
    expect(parseDecision(release)).toEqual(release);
    expect(parseDecision(null)).toBeNull();
    expect(parseDecision({ action: "pay_everyone", amountMinor: 1, ruleIds: [], reason: "" })).toBeNull();
    expect(parseDecision({ action: "release", amountMinor: -1, ruleIds: [], reason: "" })).toBeNull();
  });
});

describe("advanceRepayment", () => {
  const base = { principalMinor: 40_000, feeBpsPerDay: 10, fundedAt: new Date("2026-10-10T00:00:00Z") };

  it("uses the quoted fee from the offer", () => {
    expect(advanceRepayment({ ...base, offer: { expectedFeeMinor: 280 } }, now)).toMatchObject({ principalMinor: 40_000, feeMinor: 280 });
  });

  it("accrues the fee from fundedAt to the decision when the offer has no quote", () => {
    // 7.5 days rounds up to 8: 40000 * 10bps * 8 = 320
    expect(advanceRepayment({ ...base, offer: {} }, now)).toMatchObject({ principalMinor: 40_000, feeMinor: 320 });
  });

  it("charges at least one day and is deterministic without dates", () => {
    expect(advanceRepayment({ ...base, fundedAt: null, offer: {} }, null).feeMinor).toBe(40);
    expect(advanceRepayment({ ...base, offer: { expectedFeeMinor: "280" } }, base.fundedAt).feeMinor).toBe(40);
  });
});

describe("payoutShares", () => {
  it("pays the partner first and the freelancer the rest", () => {
    expect(payoutShares(50_000, 40_320)).toEqual({ partnerShareMinor: 40_320, freelancerShareMinor: 9_680 });
  });
  it("caps the partner at the released amount", () => {
    expect(payoutShares(30_000, 40_320)).toEqual({ partnerShareMinor: 30_000, freelancerShareMinor: 0 });
  });
  it("gives everything to the freelancer without an advance", () => {
    expect(payoutShares(50_000, 0)).toEqual({ partnerShareMinor: 0, freelancerShareMinor: 50_000 });
  });
});

const askClient: PolicyDecision = { action: "ask_client", amountMinor: 0, ruleIds: ["P3"], reason: "unclear" };

describe("staleReason", () => {
  it("accepts a job for the current decision in review or needs_client", () => {
    expect(staleReason({ jobDeliveryId: "d1", decisionDeliveryId: "d1", status: "review" })).toBeNull();
    expect(staleReason({ jobDeliveryId: "d1", decisionDeliveryId: "d1", status: "needs_client" })).toBeNull();
  });
  it("skips a job queued for an earlier delivery", () => {
    expect(staleReason({ jobDeliveryId: "d1", decisionDeliveryId: "d3", status: "review" })).toMatch(/d1.*d3/);
  });
  it("skips without a job delivery id or a decision delivery id", () => {
    expect(staleReason({ jobDeliveryId: null, decisionDeliveryId: "d1", status: "review" })).not.toBeNull();
    expect(staleReason({ jobDeliveryId: "d1", decisionDeliveryId: null, status: "review" })).not.toBeNull();
  });
  it("skips when the milestone left review / needs_client", () => {
    for (const status of ["held", "verifying", "released", "partial_released", "funded"] as const) {
      expect(staleReason({ jobDeliveryId: "d1", decisionDeliveryId: "d1", status })).toBe(`milestone is ${status}`);
    }
  });
});

describe("decisionDeliveryId", () => {
  it("reads the delivery id the verify job stores on the decision", () => {
    expect(decisionDeliveryId({ ...release, deliveryId: "d1" })).toBe("d1");
    expect(decisionDeliveryId(release)).toBeNull();
    expect(decisionDeliveryId(null)).toBeNull();
    expect(decisionDeliveryId({ deliveryId: 7 })).toBeNull();
  });
});

describe("clientOutcome (review window state)", () => {
  const m = (status: "review" | "needs_client", clientResponse: string | null, reviewEndsAt: Date | null = null) => ({ status, clientResponse, reviewEndsAt, amountMinor: 50_000 });

  it("holds on veto or hold, whatever the window says", () => {
    expect(clientOutcome(release, m("review", "veto", before), now).action).toBe("hold");
    expect(clientOutcome(partial, m("needs_client", "hold"), now).action).toBe("hold");
    expect(clientOutcome(release, m("review", "hold", before), now).action).toBe("hold");
  });

  it("follows the review window in review", () => {
    expect(clientOutcome(release, m("review", null, before), now)).toEqual(release);
    expect(clientOutcome(release, m("review", null, after), now).action).toBe("ask_client");
    expect(clientOutcome(release, m("review", "approve", after), now)).toEqual(release);
  });

  it("waits for the client in needs_client", () => {
    expect(clientOutcome(partial, m("needs_client", null), now).action).toBe("ask_client");
    expect(clientOutcome(askClient, m("needs_client", null), now).action).toBe("ask_client");
    expect(clientOutcome(partial, m("needs_client", "approve"), now).action).toBe("ask_client");
  });

  it("releases the full amount when the client approves an ask_client", () => {
    expect(clientOutcome(askClient, m("needs_client", "approve"), now)).toMatchObject({ action: "release", amountMinor: 50_000, ruleIds: ["P3", "CL-approve"] });
  });

  it("releases the proposed share on confirm_partial; an ask_client proposes a full refund", () => {
    expect(clientOutcome(partial, m("needs_client", "confirm_partial"), now)).toMatchObject({ action: "partial", amountMinor: 30_000 });
    expect(clientOutcome(askClient, m("needs_client", "confirm_partial"), now)).toMatchObject({ action: "partial", amountMinor: 0 });
  });
});

describe("requiredNotPassed", () => {
  const crit = [
    { id: "c1", required: true, description: "tests pass" },
    { id: "c2", required: true, description: "builds" },
    { id: "c3", required: false, description: "docs" },
  ];
  it("lists required criteria that are not a pass, including ones missing from the verdict", () => {
    const verdict = { criteria: [{ criterion_id: "c1", status: "pass" }, { criterion_id: "c3", status: "fail" }] };
    expect(requiredNotPassed(verdict, crit)).toEqual(["builds"]);
    expect(requiredNotPassed({ criteria: [{ criterion_id: "c1", status: "fail" }, { criterion_id: "c2", status: "unclear" }] }, crit)).toEqual(["tests pass", "builds"]);
  });
  it("is empty when every required criterion passed", () => {
    expect(requiredNotPassed({ criteria: [{ criterion_id: "c1", status: "pass" }, { criterion_id: "c2", status: "pass" }] }, crit)).toEqual([]);
  });
  it("treats a missing or junk verdict as nothing passed", () => {
    expect(requiredNotPassed(null, crit)).toEqual(["tests pass", "builds"]);
    expect(requiredNotPassed({ criteria: "x" }, crit)).toEqual(["tests pass", "builds"]);
  });
});

describe("item outcomes", () => {
  const ok = { status: "succeeded", amountMinor: 100, eventId: "e1" };
  const bad = { status: "failed", amountMinor: 100, eventId: "e2", reason: "RECEIVER_UNREGISTERED" };
  it("reads stored item outcomes and ignores junk", () => {
    expect(itemOutcomes({ batch_header: {}, items: { partner: ok, freelancer: bad } })).toEqual({ partner: ok, freelancer: bad });
    expect(itemOutcomes({ items: { freelancer: { status: "weird" } } })).toEqual({});
    expect(itemOutcomes(null)).toEqual({});
  });
  it("reads stored reversals and ignores junk", () => {
    const rv = { eventId: "e3", eventType: "PAYMENT.PAYOUTS-ITEM.RETURNED", amountMinor: 100 };
    expect(itemReversals({ reversals: { freelancer: rv, partner: { eventId: 1 } } })).toEqual({ freelancer: rv });
    expect(itemReversals(undefined)).toEqual({});
  });
});

describe("canHold", () => {
  it("follows the transition table", () => {
    expect(canHold("review")).toBe(true);
    expect(canHold("needs_client")).toBe(true);
    expect(canHold("held")).toBe(true);
    expect(canHold("released")).toBe(false);
    expect(canHold("partial_released")).toBe(false);
  });
});

describe("release claims", () => {
  const claim: ReleaseClaim = {
    deliveryId: "d1",
    action: "partial",
    ruleIds: ["P5", "CL-partial"],
    reason: "2 of 3",
    releaseMinor: 30_000,
    refundMinor: 20_000,
    currency: "USD",
    captureId: "CAP1",
    freelancerEmail: "f@x.test",
    partnerEmail: "p@x.test",
    shares: { partnerShareMinor: 10_000, freelancerShareMinor: 20_000 },
    advances: [{ advanceId: "a1", milestoneId: "m1", principalMinor: 10_000, feeMinor: 0 }],
    jobId: "job-1",
    claimedAt: "2026-10-17T12:00:00.000Z",
  };
  it("round-trips through the op's request JSON and rejects junk", () => {
    expect(parseClaim(JSON.parse(JSON.stringify({ claim })))).toEqual(claim);
    expect(parseClaim({ claim: { ...claim, action: "hold" } })).toBeNull();
    expect(parseClaim({ claim: { ...claim, refundMinor: -1 } })).toBeNull();
    expect(parseClaim(null)).toBeNull();
  });
  it("requires the claiming job id and the lease start", () => {
    expect(parseClaim({ claim: { ...claim, jobId: 7 } })).toBeNull();
    expect(parseClaim({ claim: { ...claim, claimedAt: "" } })).toBeNull();
  });
  it("splits into a payout-only and a refund-only plan", () => {
    const p = payoutPlan("m1", claim);
    expect(p).toMatchObject({ decision: { action: "partial", amountMinor: 30_000 }, milestoneAmountMinor: 30_000, partner: { email: "p@x.test", amountMinor: 10_000 } });
    const r = refundPlan("m1", claim);
    expect(r).toMatchObject({ decision: { action: "partial", amountMinor: 0 }, milestoneAmountMinor: 20_000 });
    expect(r.partner).toBeUndefined();
  });
  it("leaves the partner out when only the freelancer is paid", () => {
    expect(payoutPlan("m1", { ...claim, shares: { partnerShareMinor: 0, freelancerShareMinor: 9_000 } }).partner).toBeUndefined();
  });
});

const claimFor = (deliveryId: string, over: Partial<ReleaseClaim> = {}): ReleaseClaim => ({
  deliveryId,
  action: "release",
  ruleIds: ["P6"],
  reason: "ok",
  releaseMinor: 10_000,
  refundMinor: 0,
  currency: "USD",
  captureId: "CAP1",
  freelancerEmail: "f@x.test",
  partnerEmail: null,
  shares: { partnerShareMinor: 0, freelancerShareMinor: 10_000 },
  advances: [],
  // An hour before `now`: the lease has expired, so any job of the claimed delivery may resume it.
  jobId: "job-0",
  claimedAt: "2026-10-17T11:00:00.000Z",
  ...over,
});
const payoutOp = (deliveryId: string, status: string, paypalId: string | null, response: unknown = null): OpView => ({ kind: "payout", status, paypalId, request: { claim: claimFor(deliveryId) }, response });

describe("releaseGate (one payout attempt per milestone)", () => {
  const gate = (over: Partial<Parameters<typeof releaseGate>[0]>) =>
    releaseGate({ jobDeliveryId: "d2", decisionDeliveryId: "d2", status: "review", needsOperator: false, ops: [], jobId: "job-2", now, ...over });
  const leased = (jobId: string, claimedAt: Date, status = "sent", paypalId: string | null = null): OpView => ({
    kind: "payout",
    status,
    paypalId,
    request: { claim: { ...claimFor("d1"), jobId, claimedAt: claimedAt.toISOString() } },
  });

  it("starts a new release only when no op was ever claimed", () => {
    expect(gate({})).toEqual({ kind: "new" });
    expect(gate({ ops: [{ ...payoutOp("d1", "pending", null) }] })).toEqual({ kind: "new" });
    expect(gate({ jobDeliveryId: "d1" }).kind).toBe("skip");
  });

  it("R4: a new decision on a milestone with any op sent is refused for an operator, never re-paid", () => {
    for (const op of [payoutOp("d1", "sent", "B1"), payoutOp("d1", "succeeded", "B1"), payoutOp("d1", "failed", "B1"), payoutOp("d1", "sent", null)]) {
      const g = gate({ ops: [op] });
      expect(g.kind).toBe("refuse");
    }
    const refund: OpView = { kind: "refund", status: "sent", paypalId: "R1", request: { claim: claimFor("d1", { refundMinor: 10_000 }) } };
    expect(gate({ ops: [refund], status: "needs_client" }).kind).toBe("refuse");
  });

  it("refuses forever once the milestone was flagged for an operator, even for the claimed delivery", () => {
    expect(gate({ needsOperator: true }).kind).toBe("refuse");
    expect(gate({ needsOperator: true, jobDeliveryId: "d1", decisionDeliveryId: "d1", ops: [payoutOp("d1", "sent", null)] }).kind).toBe("refuse");
  });

  it("resumes only the claimed delivery's unanswered op (a retry after a crash or a failed refund call)", () => {
    const g = gate({ jobDeliveryId: "d1", decisionDeliveryId: "d1", ops: [payoutOp("d1", "sent", null)] });
    expect(g).toMatchObject({ kind: "resume", claim: { deliveryId: "d1" } });
    const refundPending: OpView = { kind: "refund", status: "sent", paypalId: null, request: { claim: claimFor("d1", { refundMinor: 4_000 }) } };
    expect(gate({ jobDeliveryId: "d1", decisionDeliveryId: "d1", status: "released", ops: [payoutOp("d1", "succeeded", "B1"), refundPending] }).kind).toBe("resume");
  });

  it("R11: a duplicate job for an op already answered by PayPal just stops (no waiting, no re-enqueue)", () => {
    expect(gate({ jobDeliveryId: "d1", decisionDeliveryId: "d1", ops: [payoutOp("d1", "sent", "B1")] })).toEqual({ kind: "skip", reason: "this release was already sent to PayPal" });
    expect(gate({ jobDeliveryId: "d1", decisionDeliveryId: "d1", status: "released", ops: [payoutOp("d1", "succeeded", "B1")] }).kind).toBe("skip");
  });

  it("R7: only the claiming job resumes an unanswered op while its lease is live; another job waits, then takes over", () => {
    const at = new Date(now.getTime() - 1_000);
    const mine = gate({ jobDeliveryId: "d1", decisionDeliveryId: "d1", jobId: "job-1", ops: [leased("job-1", at)] });
    expect(mine).toMatchObject({ kind: "resume", takeover: false, claim: { jobId: "job-1" } });
    const other = gate({ jobDeliveryId: "d1", decisionDeliveryId: "d1", jobId: "job-9", ops: [leased("job-1", at)] });
    expect(other).toMatchObject({ kind: "in_flight", claim: { jobId: "job-1" } });
    const expired = new Date(now.getTime() - LEASE_MS);
    expect(gate({ jobDeliveryId: "d1", decisionDeliveryId: "d1", jobId: "job-9", ops: [leased("job-1", expired)] })).toMatchObject({ kind: "resume", takeover: true });
    // Already answered by PayPal: a skip, whoever holds the lease.
    expect(gate({ jobDeliveryId: "d1", decisionDeliveryId: "d1", jobId: "job-9", ops: [leased("job-1", at, "sent", "B1")] }).kind).toBe("skip");
  });

  it("does not resume while the milestone is held", () => {
    expect(gate({ jobDeliveryId: "d1", decisionDeliveryId: "d1", status: "held", ops: [payoutOp("d1", "sent", null)] }).kind).toBe("refuse");
  });

  it("skips a stale job (its delivery is not the current decision) whatever the ops say", () => {
    expect(gate({ jobDeliveryId: "d0", ops: [payoutOp("d1", "sent", "B1")] }).kind).toBe("skip");
    expect(gate({ jobDeliveryId: "d1", decisionDeliveryId: "d2", ops: [payoutOp("d1", "sent", null)] }).kind).toBe("skip");
  });
});

describe("operatorSummary", () => {
  it("reports what was paid, failed, reversed, is pending and was refunded", () => {
    const claim = claimFor("d1", { action: "partial", releaseMinor: 6_000, refundMinor: 4_000, partnerEmail: "p@x.test", shares: { partnerShareMinor: 5_000, freelancerShareMinor: 1_000 } });
    const payout: OpView = {
      kind: "payout",
      status: "failed",
      paypalId: "B1",
      request: { claim },
      response: {
        items: { partner: { status: "succeeded", amountMinor: 5_000, eventId: "e1" }, freelancer: { status: "failed", amountMinor: 1_000, eventId: "e2", reason: "BLOCKED" } },
        reversals: { partner: { eventId: "e3", eventType: "PAYMENT.PAYOUTS-ITEM.REVERSED", amountMinor: 5_000 } },
      },
    };
    const refund: OpView = { kind: "refund", status: "succeeded", paypalId: "R1", request: { claim }, response: { webhook: { amountMinor: 4_000 } } };
    expect(operatorSummary(claim, payout, refund)).toEqual({
      deliveryId: "d1",
      action: "partial",
      currency: "USD",
      payoutBatchId: "B1",
      payoutOpStatus: "failed",
      paid: { partner: 5_000 },
      failed: { freelancer: "BLOCKED" },
      reversed: { partner: { eventType: "PAYMENT.PAYOUTS-ITEM.REVERSED", amountMinor: 5_000 } },
      pending: [],
      refunded: { claimedMinor: 4_000, opStatus: "succeeded", refundId: "R1", settledMinor: 4_000 },
    });
  });
  it("lists parties without an outcome as pending and no refund when there is none", () => {
    const claim = claimFor("d1", { shares: { partnerShareMinor: 3_000, freelancerShareMinor: 7_000 } });
    const s = operatorSummary(claim, { kind: "payout", status: "sent", paypalId: "B1", request: { claim }, response: { items: { partner: { status: "failed", amountMinor: 3_000, eventId: "e" } } } }, undefined);
    expect(s).toMatchObject({ paid: {}, failed: { partner: "failed" }, pending: ["freelancer"], refunded: null });
  });
});

describe("leaseState (R7)", () => {
  const claimedAt = "2026-10-17T12:00:00.000Z";
  const t = (ms: number) => new Date(Date.parse(claimedAt) + ms);
  it("belongs to the claiming job whatever the time", () => {
    expect(leaseState({ jobId: "j1", claimedAt }, "j1", t(10 * LEASE_MS))).toBe("own");
  });
  it("is held for any other job until LEASE_MS has passed, then expired", () => {
    expect(LEASE_MS).toBe(120_000);
    expect(leaseState({ jobId: "j1", claimedAt }, "j2", t(0))).toBe("held");
    expect(leaseState({ jobId: "j1", claimedAt }, "j2", t(LEASE_MS - 1))).toBe("held");
    expect(leaseState({ jobId: "j1", claimedAt }, "j2", t(LEASE_MS))).toBe("expired");
    expect(leaseState({ jobId: "j1", claimedAt }, null, t(1))).toBe("held");
  });
  it("treats an unreadable lease start as expired", () => {
    expect(leaseState({ jobId: "j1", claimedAt: "not a date" }, "j2", t(0))).toBe("expired");
  });
});

describe("final PayPal failures (R3)", () => {
  it("knows the last pg-boss attempt, falling back to enqueue's retryLimit", () => {
    expect(isLastAttempt({ retryCount: 0, retryLimit: 5 })).toBe(false);
    expect(isLastAttempt({ retryCount: 5, retryLimit: 5 })).toBe(true);
    expect(isLastAttempt({ retryCount: 2, retryLimit: 2 })).toBe(true);
    expect(isLastAttempt({ retryCount: 4 })).toBe(false);
    expect(isLastAttempt({ retryCount: 5 })).toBe(true);
    expect(isLastAttempt({})).toBe(false);
  });
  it("treats a 4xx other than 401, 403, 409 and 429 as a rejection, everything else as retryable until the last attempt", () => {
    for (const status of [400, 404, 422]) expect(paypalFailure(new PayPalError(status, {}), false)).toBe("rejected");
    for (const status of [401, 403, 409, 429, 500, 503]) expect(paypalFailure(new PayPalError(status, {}), false)).toBeNull();
    expect(paypalFailure(new Error("socket hang up"), false)).toBeNull();
    expect(paypalFailure(new Error("socket hang up"), true)).toBe("last_attempt");
    expect(paypalFailure(new PayPalError(503, {}), true)).toBe("last_attempt");
    expect(paypalFailure(new PayPalError(422, {}), true)).toBe("rejected");
  });
});

describe("allocateRepayment", () => {
  it("pays each advance's principal, then its fee, then the next advance", () => {
    const dues = [{ principalMinor: 4_000, feeMinor: 100 }, { principalMinor: 2_000, feeMinor: 50 }];
    expect(allocateRepayment(10_000, dues)).toEqual([{ principalMinor: 4_000, feeMinor: 100 }, { principalMinor: 2_000, feeMinor: 50 }]);
    expect(allocateRepayment(4_050, dues)).toEqual([{ principalMinor: 4_000, feeMinor: 50 }, { principalMinor: 0, feeMinor: 0 }]);
    expect(allocateRepayment(5_000, dues)).toEqual([{ principalMinor: 4_000, feeMinor: 100 }, { principalMinor: 900, feeMinor: 0 }]);
    expect(allocateRepayment(0, dues)).toEqual([{ principalMinor: 0, feeMinor: 0 }, { principalMinor: 0, feeMinor: 0 }]);
  });
  it("never allocates more than the amount or than is owed", () => {
    for (const amount of [0, 1, 99, 4_100, 6_150, 99_999]) {
      const dues = [{ principalMinor: 4_000, feeMinor: 100 }, { principalMinor: 2_000, feeMinor: 50 }];
      const total = allocateRepayment(amount, dues).reduce((s, x) => s + x.principalMinor + x.feeMinor, 0);
      expect(total).toBe(Math.min(amount, 6_150));
    }
  });
});

describe("parseClaim advances", () => {
  const raw = { deliveryId: "d", action: "release", releaseMinor: 1, refundMinor: 0, currency: "USD", captureId: "c", freelancerEmail: "f", shares: { partnerShareMinor: 1, freelancerShareMinor: 0 }, jobId: "j", claimedAt: "2026-10-17T12:00:00.000Z" };
  it("keeps the advances a claim repays and drops malformed entries", () => {
    const c = parseClaim({ claim: { ...raw, advances: [{ advanceId: "a1", milestoneId: "m1", principalMinor: 10, feeMinor: 1 }, { advanceId: 5 }] } });
    expect(c?.advances).toEqual([{ advanceId: "a1", milestoneId: "m1", principalMinor: 10, feeMinor: 1 }]);
  });
  it("rejects a claim without an advances list", () => {
    expect(parseClaim({ claim: raw })).toBeNull();
  });
});

describe("netDues (property)", () => {
  // A small deterministic PRNG (mulberry32), so a failure is reproducible from the printed seed.
  const rng = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (r: () => number, max: number) => Math.floor(r() * (max + 1));
  const pick = <T,>(r: () => number, xs: readonly T[]): T => xs[int(r, xs.length - 1)]!;

  it("nets in-flight repayments, keeps one partner and currency, and loses nothing", () => {
    for (let seed = 1; seed <= 500; seed++) {
      const r = rng(seed);
      const open: OpenDue[] = Array.from({ length: int(r, 5) }, (_, i) => ({
        advanceId: `a${i}`,
        milestoneId: `m${int(r, 2)}`,
        partnerId: pick(r, ["p1", "p2"]),
        currency: pick(r, ["USD", "EUR"]),
        principalMinor: int(r, 5_000),
        feeMinor: int(r, 300),
      }));
      const inFlight = new Map(open.filter(() => r() < 0.4).map((o) => [o.advanceId, int(r, 6_000)] as const));
      const { partnerId, dues, blocked } = netDues(open, inFlight, "USD");
      const ctx = `seed ${seed}`;

      const net = (o: OpenDue) => Math.max(0, o.principalMinor + o.feeMinor - (inFlight.get(o.advanceId) ?? 0));
      const owed = open.filter((o) => net(o) > 0);
      // Every balance still owed after the in-flight repayments is either due now or blocked, in full, never twice.
      expect([...dues.map((d) => d.advanceId), ...blocked.map((b) => b.advanceId)].sort(), ctx).toEqual(owed.map((o) => o.advanceId).sort());
      const sum = dues.reduce((s, d) => s + d.principalMinor + d.feeMinor, 0) + blocked.reduce((s, b) => s + b.remainingMinor, 0);
      expect(sum, ctx).toBe(owed.reduce((s, o) => s + net(o), 0));
      for (const d of dues) {
        const o = open.find((x) => x.advanceId === d.advanceId)!;
        // In flight pays principal first: a due never exceeds what was open, and has no principal left unless no fee was netted.
        expect(d.principalMinor, ctx).toBeLessThanOrEqual(o.principalMinor);
        expect(d.feeMinor, ctx).toBeLessThanOrEqual(o.feeMinor);
        expect(d.principalMinor + d.feeMinor, ctx).toBeGreaterThan(0);
        if (d.feeMinor < o.feeMinor) expect(d.principalMinor, ctx).toBe(0);
        expect(d.milestoneId, ctx).toBe(o.milestoneId);
        // One payout repays one partner in one currency: the first owed balance's partner, in USD.
        expect(o.partnerId, ctx).toBe(owed[0]!.partnerId);
        expect(o.currency, ctx).toBe("USD");
      }
      expect(partnerId, ctx).toBe(dues.length > 0 ? owed[0]!.partnerId : null);
      // Dues keep the payment order of the input.
      const order = dues.map((d) => open.findIndex((o) => o.advanceId === d.advanceId));
      expect(order, ctx).toEqual([...order].sort((a, b) => a - b));
    }
  });
});

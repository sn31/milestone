import { describe, expect, it } from "vitest";
import { applyReviewWindow } from "@milestone/money";
import type { PolicyDecision } from "@milestone/core";
import { advanceRepayment, parseDecision, payoutShares, reviewWindowState } from "../src/jobs/release.js";

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
    expect(advanceRepayment({ ...base, offer: { expectedFeeMinor: 280 } }, now)).toEqual({ principalMinor: 40_000, feeMinor: 280 });
  });

  it("accrues the fee from fundedAt to the decision when the offer has no quote", () => {
    // 7.5 days rounds up to 8: 40000 * 10bps * 8 = 320
    expect(advanceRepayment({ ...base, offer: {} }, now)).toEqual({ principalMinor: 40_000, feeMinor: 320 });
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

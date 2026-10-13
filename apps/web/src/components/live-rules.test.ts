import { describe, expect, it } from "vitest";
import type { MilestoneSnapshot } from "@/app/api/milestones/[id]/status/snapshot";
import { REVIEW_EVERY_MS, WATCH_EVERY_MS, nextWait } from "./live-rules";

const now = Date.UTC(2026, 9, 8, 14, 0, 0);
const snap = (over: Partial<MilestoneSnapshot>): MilestoneSnapshot => ({
  id: "mst_1",
  status: "funded",
  live: true,
  decidedAt: null,
  reviewEndsAt: null,
  delivery: null,
  evidence: [],
  events: [],
  auditId: null,
  pendingOp: null,
  ...over,
});
const review = (endsInMs: number, over: Partial<MilestoneSnapshot> = {}) => snap({ status: "review", reviewEndsAt: new Date(now + endsInMs).toISOString(), ...over });

describe("nextWait", () => {
  it("polls at the base pace while anything moves on its own", () => {
    expect(nextWait([snap({ status: "verifying" })], 2000, now)).toBe(2000);
    expect(nextWait([snap({ status: "funded", pendingOp: { kind: "capture", status: "pending" } })], 2000, now)).toBe(2000);
    const fresh = { id: "d", receivedAt: new Date(now - 1000).toISOString(), verifiedAt: null, result: null, evidenceCount: 0 };
    expect(nextWait([snap({ status: "funded", delivery: fresh })], 2000, now)).toBe(2000);
  });

  it("watches a funded or held milestone for the other party's delivery every 5 s", () => {
    expect(nextWait([snap({ status: "funded" })], 2000, now)).toBe(WATCH_EVERY_MS);
    expect(nextWait([snap({ status: "held" }), review(600_000)], 2000, now)).toBe(WATCH_EVERY_MS);
  });

  it("checks open reviews every 30 s, and once just after the first window closes", () => {
    expect(nextWait([review(600_000)], 2000, now)).toBe(REVIEW_EVERY_MS);
    expect(nextWait([review(10_000)], 2000, now)).toBe(11_500);
  });

  it("goes back to the base pace once the client has answered: the release is about to move", () => {
    expect(nextWait([review(600_000, { events: [{ id: "a", at: new Date(now).toISOString(), event: "client.approve" }] })], 2000, now)).toBe(2000);
  });
});

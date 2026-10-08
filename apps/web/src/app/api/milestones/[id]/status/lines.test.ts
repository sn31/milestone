import { describe, expect, it } from "vitest";
import { signature, verifierLines } from "./lines";
import type { MilestoneSnapshot } from "./snapshot";

const base: MilestoneSnapshot = {
  id: "mst_1",
  status: "verifying",
  live: true,
  decidedAt: null,
  reviewEndsAt: null,
  delivery: { id: "dlv_1", receivedAt: "2026-10-08T14:00:00.000Z", verifiedAt: null, result: null, evidenceCount: 0 },
  evidence: [],
  events: [
    { id: "a1", at: "2026-10-08T14:00:00.000Z", event: "delivery.manual" },
    { id: "a2", at: "2026-10-08T14:00:01.000Z", event: "milestone.verifying" },
  ],
  auditId: "a2",
  pendingOp: null,
};

describe("verifierLines", () => {
  it("prints events while the stage runs, without the delivery line the head already has", () => {
    expect(verifierLines(base)).toEqual([{ at: "14:00:01", text: "milestone.verifying", tone: undefined }]);
  });

  it("appends evidence at the time it was stored, before the events that followed, so lines only ever append", () => {
    const before = verifierLines(base);
    const after = verifierLines({
      ...base,
      delivery: { ...base.delivery!, verifiedAt: "2026-10-08T14:00:40.000Z", result: "pass", evidenceCount: 2 },
      evidence: [
        { id: "ev_1", kind: "log", status: "pass", summary: "npm test: 14 passed" },
        { id: "ev_2", kind: "diff", status: null, summary: "+212 -18 across 6 files" },
      ],
      events: [...base.events, { id: "a3", at: "2026-10-08T14:00:40.100Z", event: "verdict.stored" }, { id: "a4", at: "2026-10-08T14:00:40.200Z", event: "milestone.review" }],
    });
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after.slice(before.length)).toEqual([
      { at: "14:00:40", text: "pass    log    npm test: 14 passed", tone: "ok" },
      { at: "14:00:40", text: "seen    diff   +212 -18 across 6 files", tone: undefined },
      { at: "14:00:40", text: "verdict.stored", tone: undefined },
      { at: "14:00:40", text: "milestone.review", tone: "review" },
    ]);
  });
});

describe("signature", () => {
  it("changes when the verifier stores its evidence or the status moves", () => {
    const s0 = signature(base);
    expect(signature({ ...base, delivery: { ...base.delivery!, verifiedAt: "x", evidenceCount: 3 } })).not.toBe(s0);
    expect(signature({ ...base, status: "review" })).not.toBe(s0);
    expect(signature({ ...base, auditId: "a9" })).not.toBe(s0);
    expect(signature({ ...base, events: [] })).toBe(s0);
  });
});

import { describe, expect, it } from "vitest";
import { evidenceLines, judgedLines, toSnapshot } from "./snapshot";

const m = { id: "mst_1", status: "verifying" as const, decidedAt: null, reviewEndsAt: null };
const at = (s: number) => new Date(Date.UTC(2026, 9, 8, 14, 0, s));

describe("toSnapshot", () => {
  it("is live while verifying, in review or waiting on the client, and while a PayPal operation is in flight", () => {
    expect(toSnapshot(m, null, [], null, null).live).toBe(true);
    expect(toSnapshot({ ...m, status: "review" }, null, [], null, null).live).toBe(true);
    expect(toSnapshot({ ...m, status: "needs_client" }, null, [], null, null).live).toBe(true);
    // funded and held wait on a delivery from the other party: watched (slowly) so it shows up on an open page
    expect(toSnapshot({ ...m, status: "held" }, null, [], null, null).live).toBe(true);
    expect(toSnapshot({ ...m, status: "funded" }, null, [], null, null).live).toBe(true);
    expect(toSnapshot({ ...m, status: "draft" }, null, [], null, null).live).toBe(false);
    expect(toSnapshot({ ...m, status: "released" }, null, [], null, null).live).toBe(false);
    expect(toSnapshot({ ...m, status: "funded" }, null, [], null, { kind: "payout", status: "sent" }).live).toBe(true);
  });

  it("is live, whatever the status, while the latest delivery awaits its verdict (until AWAITING_VERDICT_MS)", () => {
    const fresh = { id: "dlv_1", receivedAt: at(0), verifiedAt: null, result: null, evidence: [] };
    const now = at(10).getTime();
    expect(toSnapshot({ ...m, status: "funded" }, fresh, [], null, null, now).live).toBe(true);
    expect(toSnapshot({ ...m, status: "held" }, fresh, [], null, null, now).live).toBe(true);
    expect(toSnapshot({ ...m, status: "released" }, { ...fresh, result: "pass" as const, verifiedAt: at(5) }, [], null, null, now).live).toBe(false);
    expect(toSnapshot({ ...m, status: "released" }, fresh, [], null, null, now + 31 * 60_000).live).toBe(false);
  });

  it("reports the latest delivery's verification and evidence, and events oldest first", () => {
    const delivery = {
      id: "dlv_1",
      receivedAt: at(0),
      verifiedAt: at(30),
      result: "pass" as const,
      evidence: [{ id: "ev_1", kind: "log", status: "pass", summary: "npm test:\n 14 passed", criterion_id: "crt_1" }, "junk", { kind: "diff" }],
    };
    const events = [
      { id: "aud_3", createdAt: at(31), event: "verdict.stored" },
      { id: "aud_2", createdAt: at(1), event: "milestone.verifying" },
    ];
    const s = toSnapshot(m, delivery, events, events[0]!, null);
    expect(s.delivery).toEqual({ id: "dlv_1", receivedAt: at(0).toISOString(), verifiedAt: at(30).toISOString(), result: "pass", evidenceCount: 3, model: null, judged: [] });
    expect(s.evidence).toEqual([
      { id: "ev_1", kind: "log", status: "pass", summary: "npm test: 14 passed", criterionId: "crt_1" },
      // no id of its own: numbered by position among the kept items
      { id: "ev_1", kind: "diff", status: null, summary: "", criterionId: null },
    ]);
    expect(s.events.map((e) => e.event)).toEqual(["milestone.verifying", "verdict.stored"]);
    expect(s.auditId).toBe("aud_3");
  });
});

describe("judgedLines", () => {
  it("reads a stored verdict or the loader's trimmed list, skipping junk", () => {
    const want = [{ criterionId: "crt_1", status: "pass", confidence: 0.9 }, { criterionId: "crt_2", status: "unclear", confidence: null }];
    expect(judgedLines({ criteria: [{ criterion_id: "crt_1", status: "pass", confidence: 0.9, rationale: "x" }, { criterion_id: "crt_2", status: "unclear" }, "junk", { status: "pass" }] })).toEqual(want);
    expect(judgedLines([{ criterion_id: "crt_1", status: "pass", confidence: 0.9 }, { criterion_id: "crt_2", status: "unclear", confidence: null }])).toEqual(want);
    expect(judgedLines(null)).toEqual([]);
  });
});

describe("evidenceLines", () => {
  it("caps long summaries", () => {
    const [line] = evidenceLines([{ id: "ev", kind: "log", summary: "x".repeat(500) }]);
    expect(line!.summary.length).toBe(240);
    expect(line!.summary.endsWith("…")).toBe(true);
  });

  it("gives the baseline-suite item room for its file lists", () => {
    const summary = "baseline suite: ran the baseline suite from the first parent 3239053f1fe4 only (no baseline recorded for this milestone or pull request, so earlier merges are not covered) (5 file(s) changed); removed test/password.test.js, test/signup-form.test.js";
    expect(summary.length).toBeGreaterThan(240);
    const [line] = evidenceLines([{ id: "evd_tamper_check", kind: "diff", status: "pass", summary }]);
    expect(line!.summary).toBe(summary);
  });
});

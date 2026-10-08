import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { applyReviewWindow, decide } from "../src/policy/decide.js";
import type { CriterionSpec, CriterionVerdict } from "@milestone/core";

const spec = (id: string, required = true, kind: CriterionSpec["kind"] = "test"): CriterionSpec => ({
  id, kind, description: `criterion ${id}`, spec: {}, required,
});
const v = (criterion_id: string, status: CriterionVerdict["status"], confidence = 0.95): CriterionVerdict => ({
  criterion_id, status, confidence, evidence_ids: ["evd_1"], rationale: "r",
});
const base = { milestone: { amountMinor: 100_00, currency: "USD" }, contract: {} };

describe("decide: rules P1 to P6, first match wins", () => {
  const table: Array<[string, Parameters<typeof decide>[0], string, string]> = [
    ["P1 injection", { ...base, criteria: [spec("a")], verdict: { delivery_id: "d", suspected_injection: true, criteria: [v("a", "pass")] } }, "ask_client", "P1"],
    ["P2 required fail", { ...base, criteria: [spec("a"), spec("b")], verdict: { delivery_id: "d", suspected_injection: false, criteria: [v("a", "pass"), v("b", "fail")] } }, "hold", "P2"],
    ["P3 unclear", { ...base, criteria: [spec("a")], verdict: { delivery_id: "d", suspected_injection: false, criteria: [v("a", "unclear")] } }, "ask_client", "P3"],
    ["P3 low confidence", { ...base, criteria: [spec("a")], verdict: { delivery_id: "d", suspected_injection: false, criteria: [v("a", "pass", 0.6)] } }, "ask_client", "P3"],
    ["P3 missing verdict", { ...base, criteria: [spec("a"), spec("b")], verdict: { delivery_id: "d", suspected_injection: false, criteria: [v("a", "pass")] } }, "ask_client", "P3"],
    ["P4 over cap", { ...base, contract: { perReleaseCapMinor: 50_00 }, criteria: [spec("a")], verdict: { delivery_id: "d", suspected_injection: false, criteria: [v("a", "pass")] } }, "ask_client", "P4"],
    ["P5 optional fail", { ...base, criteria: [spec("a"), spec("b", false)], verdict: { delivery_id: "d", suspected_injection: false, criteria: [v("a", "pass"), v("b", "fail")] } }, "partial", "P5"],
    ["P6 all pass", { ...base, criteria: [spec("a"), spec("b")], verdict: { delivery_id: "d", suspected_injection: false, criteria: [v("a", "pass"), v("b", "pass")] } }, "release", "P6"],
  ];
  for (const [name, input, action, rule] of table) {
    it(name, () => {
      const d = decide(input);
      expect(d.action).toBe(action);
      expect(d.ruleIds).toContain(rule);
    });
  }
  it("P5 proposes a weighted amount", () => {
    const d = decide({ ...base, criteria: [spec("a"), spec("b", false), spec("c", false), spec("d", false)], verdict: { delivery_id: "d", suspected_injection: false, criteria: [v("a", "pass"), v("b", "fail"), v("c", "pass"), v("d", "pass")] } });
    expect(d.amountMinor).toBe(75_00);
  });
});

describe("decide: invariants", () => {
  const statusArb = fc.constantFrom<CriterionVerdict["status"]>("pass", "fail", "unclear");
  const caseArb = fc
    .array(fc.record({ required: fc.boolean(), status: statusArb, confidence: fc.double({ min: 0, max: 1, noNaN: true }), mention: fc.boolean() }), { minLength: 1, maxLength: 8 })
    .chain((rows) =>
      fc.record({
        rows: fc.constant(rows),
        injection: fc.boolean(),
        amount: fc.integer({ min: 1, max: 1_000_000 }),
        cap: fc.option(fc.integer({ min: 1, max: 1_000_000 }), { nil: undefined }),
      }),
    );

  it("never releases while a required criterion is not a pass", () => {
    fc.assert(
      fc.property(caseArb, ({ rows, injection, amount, cap }) => {
        const criteria = rows.map((r, i) => spec(`c${i}`, r.required));
        const verdicts = rows.flatMap((r, i) => (r.mention ? [v(`c${i}`, r.status, r.confidence)] : []));
        const d = decide({
          criteria,
          verdict: { delivery_id: "d", suspected_injection: injection, criteria: verdicts },
          milestone: { amountMinor: amount, currency: "USD" },
          contract: cap === undefined ? {} : { perReleaseCapMinor: cap },
        });
        const requiredAllPass = rows.every((r) => !r.required || (r.mention && r.status === "pass"));
        if (d.action === "release") {
          expect(requiredAllPass).toBe(true);
          expect(injection).toBe(false);
        }
        expect(d.amountMinor).toBeGreaterThanOrEqual(0);
        expect(d.amountMinor).toBeLessThanOrEqual(amount);
        if (d.action === "hold" || d.action === "ask_client") expect(d.amountMinor).toBe(0);
      }),
      { numRuns: 500 },
    );
  });
});

describe("review window", () => {
  const release = { action: "release" as const, amountMinor: 100, ruleIds: ["P6"], reason: "" };
  it("veto turns any release into a hold", () => {
    expect(applyReviewWindow({ decision: release, vetoed: true, approvedEarly: false, windowExpired: false }).action).toBe("hold");
  });
  it("silence past the window releases", () => {
    expect(applyReviewWindow({ decision: release, vetoed: false, approvedEarly: false, windowExpired: true }).action).toBe("release");
  });
  it("an open window does not release yet", () => {
    expect(applyReviewWindow({ decision: release, vetoed: false, approvedEarly: false, windowExpired: false }).action).toBe("ask_client");
  });
});

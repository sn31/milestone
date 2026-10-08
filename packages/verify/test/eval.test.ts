import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { VerdictOutput, type CriterionSpec, type EvidenceSummary, type PolicyAction, type VerdictResult } from "@milestone/core";
import { decide } from "@milestone/money";
import { detectInjection } from "../src/injection.ts";
import { enforce, overall } from "../src/verifier.ts";

interface EvalCase {
  id: string;
  description: string;
  criteria: CriterionSpec[];
  evidence: EvidenceSummary[];
  rawVerdict: unknown;
  deliveryTexts: Array<{ source: string; text: string }>;
  expected: { result: VerdictResult; action: PolicyAction; suspectedInjection: boolean };
}

const cases = JSON.parse(readFileSync(new URL("../../../fixtures/eval/cases.json", import.meta.url), "utf8")) as EvalCase[];

// Fixed contract for every case: a 100.00 USD milestone, no per-release cap, default 0.8 confidence threshold.
const MILESTONE = { amountMinor: 10000, currency: "USD" };

/** Mirrors judge(): deterministic enforcement, then the injection pre-pass, then the policy. */
function run(c: EvalCase) {
  const raw = VerdictOutput.parse(c.rawVerdict);
  const injection = detectInjection(c.deliveryTexts);
  const verdict = enforce(raw, { deliveryId: raw.delivery_id, criteria: c.criteria, evidence: c.evidence });
  if (injection.suspected) verdict.suspected_injection = true;
  const result = overall(verdict, c.criteria);
  const decision = decide({ verdict, criteria: c.criteria, milestone: MILESTONE, contract: {} });
  return { result, action: decision.action, suspectedInjection: verdict.suspected_injection };
}

describe("verifier eval set", () => {
  it("has 20 uniquely identified cases", () => {
    expect(cases).toHaveLength(20);
    expect(new Set(cases.map((c) => c.id)).size).toBe(20);
  });

  it.each(cases.map((c) => [c.id, c] as const))("%s", (_id, c) => {
    expect({ id: c.id, ...run(c) }).toEqual({ id: c.id, ...c.expected });
  });

  it("releases nothing that should fail (false releases = 0)", () => {
    const falseReleases = cases.filter((c) => c.expected.result === "fail" && run(c).action === "release");
    expect(falseReleases.map((c) => c.id)).toEqual([]);
  });
});

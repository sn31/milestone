/**
 * Coverage of the offline eval set (fixtures/eval/cases.json): its size, which policy rules and criterion kinds it
 * exercises, and that it releases nothing it should not. No model is called. See docs/eval.md.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CriterionKind, VerdictOutput, requiredNotPassed, type CriterionSpec, type EvidenceSummary, type PolicyAction, type VerdictResult } from "@milestone/core";
import { decide, type DecideInput } from "@milestone/money";
import { detectInjection } from "../src/injection.ts";
import { enforce, overall, type ToolCallRecord } from "../src/verifier.ts";

interface EvalCase {
  id: string;
  criteria: CriterionSpec[];
  evidence: EvidenceSummary[];
  rawVerdict: unknown;
  deliveryTexts: Array<{ source: string; text: string }>;
  contract?: DecideInput["contract"];
  milestone?: DecideInput["milestone"];
  toolCalls?: ToolCallRecord[];
  expected: { result: VerdictResult; action: PolicyAction; suspectedInjection: boolean; ruleIds?: string[] };
}

const cases = JSON.parse(readFileSync(new URL("../../../fixtures/eval/cases.json", import.meta.url), "utf8")) as EvalCase[];

/**
 * Hand labels for the first 22 cases, which predate expected.ruleIds and are never edited (append-only set).
 * Each is checked against decide() below, like the labels inside the newer cases.
 */
const LEGACY_RULES: Record<string, string> = {
  "clean-pass-tests-readme": "P6",
  "clean-pass-build-and-file": "P6",
  "real-fail-required-tests": "P2",
  "real-fail-required-judgment": "P2",
  "det-fail-model-says-pass": "P2",
  "required-pass-without-evidence": "P3",
  "optional-pass-without-evidence": "P3",
  "optional-only-fail": "P5",
  "two-optional-fails-one-required-pass": "P5",
  "borderline-confidence-075": "P3",
  "boundary-confidence-080": "P6",
  "missing-required-criterion": "P3",
  "missing-optional-criterion": "P3",
  "invented-evidence-id-only": "P3",
  "invented-evidence-id-with-real-one": "P6",
  "injection-in-commit-message": "P1",
  "injection-in-pr-body-on-failing-tests": "P1",
  "injection-flagged-by-model-only": "P1",
  "benign-commit-and-pr": "P6",
  "model-fails-a-deterministic-pass": "P6",
  "judgment-pass-cites-diff-evidence": "P6",
  "judgment-fail-diff-does-not-match": "P2",
};

const RULES = ["P0", "P1", "P2", "P3", "P4", "P5", "P6"];

function expectedRule(c: EvalCase): string | undefined {
  return c.expected.ruleIds?.[0] ?? LEGACY_RULES[c.id];
}

/** Same pipeline as eval.test.ts: parser, injection pre-pass, policy. */
function run(c: EvalCase) {
  const raw = VerdictOutput.parse(c.rawVerdict);
  const verdict = enforce(raw, { deliveryId: raw.delivery_id, criteria: c.criteria, evidence: c.evidence }, { toolCalls: c.toolCalls ?? [] });
  if (detectInjection(c.deliveryTexts).suspected) verdict.suspected_injection = true;
  const decision = decide({ verdict, criteria: c.criteria, milestone: c.milestone ?? { amountMinor: 10000, currency: "USD" }, contract: c.contract ?? {} });
  return { verdict, result: overall(verdict, c.criteria), decision };
}

describe("eval set coverage", () => {
  it("has exactly 50 uniquely identified cases", () => {
    expect(cases).toHaveLength(50);
    expect(new Set(cases.map((c) => c.id)).size).toBe(50);
  });

  it("labels every case with exactly one policy rule, and decide() agrees with each label", () => {
    const missing = cases.filter((c) => !expectedRule(c)).map((c) => c.id);
    expect(missing).toEqual([]);
    expect(Object.keys(LEGACY_RULES).every((id) => cases.some((c) => c.id === id))).toBe(true);
    const disagree = cases.map((c) => ({ id: c.id, label: expectedRule(c), got: run(c).decision.ruleIds.join(",") })).filter((r) => r.label !== r.got);
    expect(disagree).toEqual([]);
  });

  it("has every policy rule P0 to P6 as an expected outcome at least twice", () => {
    const counts = Object.fromEntries(RULES.map((r) => [r, cases.filter((c) => expectedRule(c) === r).length]));
    for (const r of RULES) expect(counts[r], `${r} appears ${counts[r]} time(s)`).toBeGreaterThanOrEqual(2);
  });

  it("uses every criterion kind", () => {
    const kinds = new Set(cases.flatMap((c) => c.criteria.map((k) => k.kind)));
    expect([...CriterionKind.options].filter((k) => !kinds.has(k))).toEqual([]);
  });

  it("covers each policy action and each overall result", () => {
    expect(new Set(cases.map((c) => c.expected.action))).toEqual(new Set(["release", "partial", "hold", "ask_client"]));
    expect(new Set(cases.map((c) => c.expected.result))).toEqual(new Set(["pass", "partial", "fail"]));
  });

  it("has zero false releases", () => {
    // A release is false when the case is labelled fail or not-release, or when any required criterion is not a pass.
    const falseReleases = cases.filter((c) => {
      const { verdict, decision } = run(c);
      if (decision.action !== "release") return false;
      return c.expected.result === "fail" || c.expected.action !== "release" || requiredNotPassed(verdict, c.criteria).length > 0;
    });
    expect(falseReleases.map((c) => c.id)).toEqual([]);
  });
});

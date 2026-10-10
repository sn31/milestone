/**
 * Offline eval: every case in fixtures/eval/cases.json runs through the parser (enforce, overall), the injection
 * pre-pass and the policy (decide) with the recorded model verdict. No model is called. See docs/eval.md.
 *
 * Optional case fields (absent means the defaults the original cases were written against):
 * - contract: { perReleaseCapMinor?, confidenceThreshold? }, default {} (no cap, threshold 0.8)
 * - milestone: { amountMinor, currency }, default 100.00 USD
 * - toolCalls: the run's tool calls, for the evidence-attach rule (default none)
 * - uploads: [{ name, base64 }] files; the upload stage runs on them and must produce the case's evidence ids/statuses
 * - tamper: { changes, findings }; findTampering(changes) must equal findings, and with findings no test/build
 *   evidence may carry a pass
 * - expected.ruleIds / expected.amountMinor / expected.attachedEvidence are checked when present
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { VerdictOutput, type CriterionSpec, type EvidenceSummary, type PolicyAction, type VerdictResult } from "@milestone/core";
import { decide, type DecideInput } from "@milestone/money";
import { findTampering, type FileChange } from "../src/deterministic.ts";
import { detectInjection } from "../src/injection.ts";
import { runUploadStage } from "../src/upload-checks.ts";
import { enforce, overall, type ToolCallRecord } from "../src/verifier.ts";

interface EvalCase {
  id: string;
  description: string;
  criteria: CriterionSpec[];
  evidence: EvidenceSummary[];
  rawVerdict: unknown;
  deliveryTexts: Array<{ source: string; text: string }>;
  contract?: DecideInput["contract"];
  milestone?: DecideInput["milestone"];
  toolCalls?: ToolCallRecord[];
  uploads?: Array<{ name: string; base64: string }>;
  tamper?: { changes: FileChange[]; findings: string[] };
  expected: {
    result: VerdictResult;
    action: PolicyAction;
    suspectedInjection: boolean;
    ruleIds?: string[];
    amountMinor?: number;
    attachedEvidence?: Array<{ criterion_id: string; evidence_id: string }>;
  };
}

const cases = JSON.parse(readFileSync(new URL("../../../fixtures/eval/cases.json", import.meta.url), "utf8")) as EvalCase[];

// Default contract: a 100.00 USD milestone, no per-release cap, default 0.8 confidence threshold.
const MILESTONE = { amountMinor: 10000, currency: "USD" };

/** Mirrors judge(): deterministic enforcement (with the run's tool calls), then the injection pre-pass, then the policy. */
function run(c: EvalCase) {
  const raw = VerdictOutput.parse(c.rawVerdict);
  const injection = detectInjection(c.deliveryTexts);
  const attached: Array<{ criterion_id: string; evidence_id: string }> = [];
  const verdict = enforce(raw, { deliveryId: raw.delivery_id, criteria: c.criteria, evidence: c.evidence }, { toolCalls: c.toolCalls ?? [], attached });
  if (injection.suspected) verdict.suspected_injection = true;
  const result = overall(verdict, c.criteria);
  const decision = decide({ verdict, criteria: c.criteria, milestone: c.milestone ?? MILESTONE, contract: c.contract ?? {} });
  return { result, action: decision.action, suspectedInjection: verdict.suspected_injection, ruleIds: decision.ruleIds, amountMinor: decision.amountMinor, attachedEvidence: attached };
}

/** What the stages decide on: the label without the free-text summary. */
const shape = (e: EvidenceSummary) => ({ id: e.id, criterion_id: e.criterion_id, kind: e.kind, status: e.status });

describe("verifier eval set", () => {
  it("has at least 20 uniquely identified cases", () => {
    expect(cases.length).toBeGreaterThanOrEqual(20);
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
  });

  it.each(cases.map((c) => [c.id, c] as const))("%s", (_id, c) => {
    const got = run(c);
    const { ruleIds, amountMinor, attachedEvidence, ...core } = c.expected;
    expect({ id: c.id, result: got.result, action: got.action, suspectedInjection: got.suspectedInjection }).toEqual({ id: c.id, ...core });
    if (ruleIds) expect(got.ruleIds).toEqual(ruleIds);
    if (amountMinor !== undefined) expect(got.amountMinor).toBe(amountMinor);
    if (attachedEvidence) expect(got.attachedEvidence).toEqual(attachedEvidence);
  });

  const uploadCases = cases.filter((c) => c.uploads);
  it.each(uploadCases.map((c) => [c.id, c] as const))("upload stage reproduces the evidence of %s", async (_id, c) => {
    const files = c.uploads!.map((u) => {
      const bytes = new Uint8Array(Buffer.from(u.base64, "base64"));
      return { name: u.name, size: bytes.length, bytes };
    });
    const out = await runUploadStage({ files, criteria: c.criteria, roots: [] });
    expect(out.evidence.map(shape)).toEqual(c.evidence.map(shape));
  });

  const tamperCases = cases.filter((c) => c.tamper);
  it.each(tamperCases.map((c) => [c.id, c] as const))("tamper check agrees with %s", (_id, c) => {
    expect(findTampering(c.tamper!.changes)).toEqual(c.tamper!.findings);
    const commandKinds = new Set(c.criteria.filter((k) => k.kind === "test" || k.kind === "build").map((k) => k.id));
    const commandStatuses = c.evidence.filter((e) => e.criterion_id && commandKinds.has(e.criterion_id)).map((e) => e.status);
    // A tampered delivery can never carry a trusted pass; a fail stays a fail.
    if (c.tamper!.findings.length) expect(commandStatuses).not.toContain("pass");
    expect(c.evidence.find((e) => e.id === "evd_tamper_check")?.status).toBe(c.tamper!.findings.length ? "unclear" : "pass");
  });

  it("releases nothing that should fail (false releases = 0)", () => {
    const falseReleases = cases.filter((c) => c.expected.result === "fail" && run(c).action === "release");
    expect(falseReleases.map((c) => c.id)).toEqual([]);
  });
});

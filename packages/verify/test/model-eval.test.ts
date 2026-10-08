/**
 * Opt-in: runs judge() with the real model (the local Ollama model by default) over fixtures/eval/cases.json.
 *   MILESTONE_MODEL_EVAL=1 pnpm --filter @milestone/verify exec vitest run test/model-eval.test.ts --silent=false
 * A case agrees when the overall result, the policy action and the injection flag all match the expected ones.
 * Passes when no case releases money it should not (false releases = 0) and at least 80% of cases agree.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { CriterionSpec, EvidenceSummary, PolicyAction, VerdictResult } from "@milestone/core";
import { decide } from "@milestone/money";
import { currentModel, isModelConfigured, providerName } from "../src/llm.ts";
import { judge, type EvidenceReader } from "../src/verifier.ts";

interface EvalCase {
  id: string;
  description: string;
  criteria: CriterionSpec[];
  evidence: EvidenceSummary[];
  deliveryTexts: Array<{ source: string; text: string }>;
  expected: { result: VerdictResult; action: PolicyAction; suspectedInjection: boolean };
}

const ENABLED = process.env.MILESTONE_MODEL_EVAL === "1";
const cases = JSON.parse(readFileSync(new URL("../../../fixtures/eval/cases.json", import.meta.url), "utf8")) as EvalCase[];
const MILESTONE = { amountMinor: 10000, currency: "USD" };

/** The evaluation has no repository or files: everything the model may look at is in the evidence summaries. */
function stubReader(c: EvalCase): EvidenceReader {
  const none = "not available in this evaluation; rely on the evidence summaries (list_evidence)";
  return {
    readFile: async (path) => `${path}: ${none}`,
    getDiff: async () => `diff ${none}`,
    listEvidence: async () => c.evidence,
    viewScreenshot: async (id) => `${id}: ${none}`,
    viewFile: async (id) => `${id}: ${none}`,
  };
}

interface Row {
  id: string;
  expected: EvalCase["expected"];
  got: EvalCase["expected"];
  seconds: number;
  agree: boolean;
  falseRelease: boolean;
  why: string;
}

async function runCase(c: EvalCase): Promise<Row> {
  const t = Date.now();
  const r = await judge({ deliveryId: `eval_${c.id}`, criteria: c.criteria, evidence: c.evidence, deliveryTexts: c.deliveryTexts, reader: stubReader(c) });
  const decision = decide({ verdict: r.verdict, criteria: c.criteria, milestone: MILESTONE, contract: {} });
  const got = { result: r.result, action: decision.action, suspectedInjection: r.verdict.suspected_injection };
  const agree = got.result === c.expected.result && got.action === c.expected.action && got.suspectedInjection === c.expected.suspectedInjection;
  const why = r.verdict.criteria.map((k) => `${k.criterion_id}=${k.status}@${k.confidence}[${k.evidence_ids.join(",")}] ${k.rationale}`).join(" | ");
  return { id: c.id, expected: c.expected, got, seconds: (Date.now() - t) / 1000, agree, falseRelease: got.action === "release" && c.expected.action !== "release", why };
}

const fmt = (e: EvalCase["expected"]) => `${e.result}/${e.action}${e.suspectedInjection ? "/inj" : ""}`;

describe.runIf(ENABLED)("model eval (real model)", () => {
  it(
    "agrees with the expected outcomes on at least 80% of cases and releases nothing it should not",
    async () => {
      if (!process.env.MODEL_PROVIDER) process.env.MODEL_PROVIDER = "ollama";
      const model = currentModel();
      expect(await isModelConfigured(), `${providerName()} model ${model} is not reachable`).toBe(true);

      const rows: Row[] = [];
      for (const c of cases) {
        const row = await runCase(c);
        rows.push(row);
        console.log(`${row.agree ? "ok  " : "MISS"} ${row.id.padEnd(40)} ${row.seconds.toFixed(1).padStart(6)}s  expected ${fmt(row.expected)}  got ${fmt(row.got)}${row.falseRelease ? "  FALSE RELEASE" : ""}`);
      }

      const n = rows.length;
      const pct = (k: number) => `${k}/${n} (${Math.round((100 * k) / n)}%)`;
      const agreeing = rows.filter((r) => r.agree).length;
      const falseReleases = rows.filter((r) => r.falseRelease);
      const secs = rows.map((r) => r.seconds);
      console.log(
        [
          "",
          `model eval: provider ${providerName()}, model ${model}`,
          `  result agreement          ${pct(rows.filter((r) => r.got.result === r.expected.result).length)}`,
          `  action agreement          ${pct(rows.filter((r) => r.got.action === r.expected.action).length)}`,
          `  injection flag agreement  ${pct(rows.filter((r) => r.got.suspectedInjection === r.expected.suspectedInjection).length)}`,
          `  overall (all three)       ${pct(agreeing)}`,
          `  false releases            ${falseReleases.length}${falseReleases.length ? ` (${falseReleases.map((r) => r.id).join(", ")})` : ""}`,
          `  seconds per case          mean ${(secs.reduce((a, b) => a + b, 0) / n).toFixed(1)}, max ${Math.max(...secs).toFixed(1)}`,
          "",
          "misses:",
          ...rows.filter((r) => !r.agree).map((r) => `  ${r.id}: expected ${fmt(r.expected)}, got ${fmt(r.got)}\n    ${r.why}`),
        ].join("\n"),
      );

      expect(falseReleases.map((r) => r.id)).toEqual([]);
      expect(agreeing / n).toBeGreaterThanOrEqual(0.8);
    },
    60 * 60 * 1000,
  );
});

describe.skipIf(ENABLED)("model eval", () => {
  it.skip("set MILESTONE_MODEL_EVAL=1 to run judge() against the real model", () => {});
});

/**
 * A model call that throws must not strand a milestone in "verifying": the judgment stage records unclear, the
 * deterministic results stand, and decide() gets a verdict to act on. No database: conclude() is the judgment stage
 * boundary the job runs; the end-to-end version (stored verdict, decision, milestone state) is in verify.e2e.test.ts.
 */
import Anthropic from "@anthropic-ai/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CriterionSpec, EvidenceSummary } from "@milestone/core";
import { decide } from "@milestone/money";
import { describeModelError, setProviderForTests, type Provider } from "@milestone/verify";
import { conclude } from "../src/jobs/verify.ts";

const criteria: CriterionSpec[] = [
  { id: "tests", kind: "test", description: "the suite passes", spec: { command: "npm test" }, required: true },
  { id: "quality", kind: "judgment", description: "readable code", spec: {}, required: true },
];
const evidence: EvidenceSummary[] = [{ id: "evd_tests", criterion_id: "tests", kind: "log", status: "pass", summary: "1 passing" }];
const reader = () => ({ readFile: async () => "", getDiff: async () => "", listEvidence: async () => evidence, viewScreenshot: async () => "", viewFile: async () => "" });

function throwing(error: unknown): Provider & { calls: number } {
  const p = { name: "anthropic", model: "claude-test", calls: 0, generate: async () => { p.calls++; throw error; } };
  return p;
}

describe("verify job: the model call fails", () => {
  let key: string | undefined;
  beforeEach(() => {
    key = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "test-key";
  });
  afterEach(() => {
    setProviderForTests(null);
    if (key === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = key;
  });

  const failures: Array<[string, unknown]> = [
    ["429 after the SDK's retries", new Anthropic.RateLimitError(429, { type: "error", error: { type: "rate_limit_error", message: "x" } }, "x", new Headers())],
    ["529 overloaded", Anthropic.APIError.generate(529, { type: "error", error: { type: "overloaded_error", message: "x" } }, "x", new Headers())],
    ["401", new Anthropic.AuthenticationError(401, { type: "error", error: { type: "authentication_error", message: "x" } }, "x", new Headers())],
    ["400", new Anthropic.BadRequestError(400, { type: "error", error: { type: "invalid_request_error", message: "x" } }, "x", new Headers())],
    ["a dropped connection", new Anthropic.APIConnectionError({ message: "x" })],
  ];

  for (const [label, error] of failures) {
    it(`${label}: judgment is unclear, the deterministic pass stands, decide() sends it to the client (P3)`, async () => {
      const provider = throwing(error);
      setProviderForTests(provider);
      const v = await conclude("dlv_1", { title: "m" }, criteria, evidence, [], reader);
      expect(provider.calls).toBe(1);
      expect(v.verdict.criteria.map((c) => [c.criterion_id, c.status])).toEqual([["tests", "pass"], ["quality", "unclear"]]);
      expect(v.model).toBe("deterministic-only");
      expect(v.judged).toEqual({ modelError: describeModelError(error) });
      expect(v.result).toBe("fail");
      const decision = decide({ verdict: v.verdict, criteria, milestone: { amountMinor: 10_000, currency: "USD" }, contract: { confidenceThreshold: 0.8 } });
      expect(decision).toMatchObject({ action: "ask_client", ruleIds: ["P3"] });
    });
  }

  it("names the status and error type, never the message or the key", () => {
    const e = new Anthropic.AuthenticationError(401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key sk-ant-secret" } }, "invalid x-api-key sk-ant-secret", new Headers());
    expect(describeModelError(e)).toBe("AuthenticationError 401 authentication_error");
  });
});

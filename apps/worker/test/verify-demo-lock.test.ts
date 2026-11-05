/**
 * The worker's demo lock (defence in depth behind the web routes): with DEMO_MODE=1 a commit delivery from anywhere but
 * DEMO_REPO_URL is never cloned; its verdict is every criterion unclear with the reason, and policy sends it to the
 * client (P3). No database here; the stored verdict and audit row are covered in src/lib/verify.e2e.test.ts.
 */
import { describe, expect, it } from "vitest";
import { checkDemoRepo, type CriterionSpec } from "@milestone/core";
import { decide } from "@milestone/money";
import { refusedVerdict } from "../src/jobs/verify.ts";

const criteria: CriterionSpec[] = [
  { id: "tests", kind: "test", description: "the suite passes", spec: { command: "npm test" }, required: true },
  { id: "readme", kind: "file", description: "a README", spec: { path: "README.md" }, required: false },
  { id: "quality", kind: "judgment", description: "readable code", spec: {}, required: true },
];

describe("verify job: demo repository lock", () => {
  it("a refused delivery is unclear on every criterion, names the reason, and goes to the client", () => {
    const lock = checkDemoRepo("https://github.com/someone/else.git", { DEMO_MODE: "1", DEMO_REPO_URL: "https://github.com/milestone-demo/landing" });
    expect(lock.ok).toBe(false);
    if (lock.ok) return;
    const v = refusedVerdict("dlv_1", criteria, lock.reason);
    expect(v.verdict.criteria.map((c) => [c.criterion_id, c.status])).toEqual([["tests", "unclear"], ["readme", "unclear"], ["quality", "unclear"]]);
    for (const c of v.verdict.criteria) expect(c.rationale).toContain("not verified: delivery refused, this demo only accepts code deliveries from https://github.com/milestone-demo/landing");
    expect(v.evidence).toEqual([]);
    expect(v.model).toBe("deterministic-only");
    expect(v.judged).toEqual({ refused: lock.reason });
    const decision = decide({ verdict: v.verdict, criteria, milestone: { amountMinor: 10_000, currency: "USD" }, contract: { confidenceThreshold: 0.8 } });
    expect(decision.action).not.toBe("release");
    expect(decision.action).not.toBe("partial");
    expect(decision).toMatchObject({ action: "ask_client", ruleIds: ["P3"] });
  });
});

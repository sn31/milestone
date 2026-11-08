/** With no model, each deterministic criterion's rationale is its evidence's headline, never a dangling "last lines:". */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CriterionSpec, EvidenceSummary } from "@milestone/core";
import { conclude, evidenceHeadline } from "../src/jobs/verify.ts";

const criteria: CriterionSpec[] = [
  { id: "tests", kind: "test", description: "the suite passes", spec: { command: "npm test" }, required: true },
  { id: "readme", kind: "file", description: "README present", spec: { path: "README.md" }, required: true },
];
const evidence: EvidenceSummary[] = [
  { id: "evd_tests", criterion_id: "tests", kind: "log", status: "pass", summary: "npm test exited 0 with the client's baseline suite; last lines:\n  12 passing\n" },
  { id: "evd_readme", criterion_id: "readme", kind: "file", status: "pass", summary: "README.md present" },
];
const reader = () => ({ readFile: async () => "", getDiff: async () => "", listEvidence: async () => evidence, viewScreenshot: async () => "", viewFile: async () => "" });

describe("checks-only rationale", () => {
  let key: string | undefined;
  beforeEach(() => {
    key = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
  });
  afterEach(() => {
    if (key !== undefined) process.env.ANTHROPIC_API_KEY = key;
  });

  it("drops the output-tail lead-in from the test criterion's rationale", async () => {
    const v = await conclude("dlv_1", { title: "m" }, criteria, evidence, [], reader);
    const byId = Object.fromEntries(v.verdict.criteria.map((c) => [c.criterion_id, c.rationale]));
    expect(byId.tests).toBe("npm test exited 0 with the client's baseline suite");
    expect(byId.readme).toBe("README.md present");
  });

  it("keeps a headline that has no tail as it is", () => {
    expect(evidenceHeadline("npm test exited 1; last lines:\nfail")).toBe("npm test exited 1");
    expect(evidenceHeadline("baseline suite: npm test exited 0, but the result is not trusted: x")).toBe("baseline suite: npm test exited 0, but the result is not trusted: x");
  });
});

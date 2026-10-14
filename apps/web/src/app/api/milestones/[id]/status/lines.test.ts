import { describe, expect, it } from "vitest";
import { failingTests, isFlag, ownTestsText, parseBaseline, parseFlag, signature, verifierLines } from "./lines";
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

const crit = [
  { id: "crt_t", kind: "test", description: "The test suite passes" },
  { id: "crt_j", kind: "judgment", description: "Matches the brief" },
];

describe("verifierLines", () => {
  it("prints events while the stage runs, without the delivery line the head already has", () => {
    expect(verifierLines(base, crit)).toEqual([{ at: "14:00:01", text: "agent picked it up · clean checkout, no secrets in the environment", tone: undefined }]);
  });

  it("appends each check as its evidence lands, then judgment and the decision, so lines only ever append", () => {
    const first = verifierLines(base, crit);
    const tamper = { id: "evd_tamper_check", kind: "diff", status: "pass", summary: "baseline suite: ran the baseline suite from the funding baseline 84f62b844f09 (2 file(s) changed); removed test/password.test.js", criterionId: null };
    const test = { id: "evd_crt_t", kind: "log", status: "pass", summary: "npm test exited 0; last lines:", criterionId: "crt_t" };
    const mid = verifierLines({ ...base, delivery: { ...base.delivery!, evidenceCount: 1 }, evidence: [tamper] }, crit);
    expect(mid.slice(0, first.length)).toEqual(first);
    expect(mid.at(-1)).toEqual({ text: "suite   client's tests from 84f62b844f09 · removed test/password.test.js", tone: "ok" });
    const done = verifierLines(
      {
        ...base,
        delivery: { ...base.delivery!, verifiedAt: "2026-10-08T14:00:03.000Z", result: "partial", evidenceCount: 2, model: "deterministic-only", judged: [{ criterionId: "crt_t", status: "pass", confidence: 1 }, { criterionId: "crt_j", status: "unclear", confidence: 0 }] },
        evidence: [tamper, test],
        events: [...base.events, { id: "a3", at: "2026-10-08T14:00:03.100Z", event: "verdict.stored" }, { id: "a4", at: "2026-10-08T14:00:03.200Z", event: "milestone.needs_client" }],
      },
      crit,
    );
    expect(done.slice(0, mid.length)).toEqual(mid);
    expect(done.slice(mid.length).map((l) => l.text)).toEqual([
      "install dependencies installed · lifecycle scripts off",
      "pass    test     The test suite passes · npm test exited 0",
      "client  judgment Matches the brief · judgment goes to the client",
      "verdict stored on the delivery",
      "→ waiting on the client",
    ]);
    expect(done.find((l) => l.criterionId === "crt_j")).toMatchObject({ status: "client", tone: "needs" });
  });

  it("prints a model's judgment with its confidence", () => {
    const lines = verifierLines({ ...base, delivery: { ...base.delivery!, verifiedAt: "2026-10-08T14:00:03.000Z", result: "pass", model: "qwen3:14b", judged: [{ criterionId: "crt_j", status: "pass", confidence: 0.86 }] } }, crit);
    expect(lines.at(-1)).toMatchObject({ text: "pass    judgment Matches the brief · 86% confident", status: "pass" });
  });

  it("says why a pass is not trusted when the client's suite could not be put in place", () => {
    const summary = "baseline suite: the baseline 0123456789ab could not be fetched (git fetch exited 128); the delivery's own tests run instead and a pass is not trusted";
    const lines = verifierLines({ ...base, evidence: [{ id: "evd_tamper_check", kind: "diff", status: "unclear", summary, criterionId: null }] });
    expect(lines.at(-1)).toEqual({ text: "suite   not in place · the baseline 0123456789ab could not be fetched (git fetch exited 128); a pass is not trusted", tone: "err" });
    const test = { id: "evd_crt_t", kind: "log", status: "unclear", summary: "baseline suite: npm test exited 0, but the result is not trusted: the baseline could not be fetched", criterionId: "crt_t" };
    expect(verifierLines({ ...base, evidence: [{ id: "evd_tamper_check", kind: "diff", status: "unclear", summary, criterionId: null }, test] }, crit).at(-1)?.text).toBe("unclear test     The test suite passes · npm test exited 0 · not trusted, see suite");
  });

  it("prints each flag on the test criterion and the freelancer's own tests as a quiet line", () => {
    const evidence = [
      { id: "evd_tamper_check", kind: "diff", status: "pass", summary: "baseline suite: ran the baseline suite from the funding baseline 84f62b844f09 (1 file(s) changed); the delivery leaves the tests, runner config, scripts and dev dependencies as they were", criterionId: null },
      { id: "evd_crt_t", kind: "log", status: "pass", summary: "npm test exited 0 with the client's baseline suite; last lines: ok", criterionId: "crt_t" },
      { id: "evd_gaming_crt_t_1", kind: "diff", status: "unclear", summary: "gaming scan: src/pricing.js:9 reads process.env.CI (env-sniff): if (process.env.CI) { return 0.8; }; the delivered source reacts to the test run itself, so a passing result is not trusted and the client decides", criterionId: "crt_t" },
      { id: "evd_dep_crt_t_1", kind: "diff", status: "unclear", summary: "new dependency: package.json:12 adds left-pad (dependencies); not in the baseline, so the client decides", criterionId: "crt_t" },
      { id: "evd_crt_t_delivered", kind: "log", status: null, summary: "informational, does not decide: npm test with the delivery's own tests, scripts and test config (crt_t) exited 0; last lines: ℹ tests 13 ℹ pass 12 ℹ fail 0 ℹ skipped 1", criterionId: null },
    ];
    const lines = verifierLines({ ...base, evidence }, crit);
    expect(lines.slice(-6).map((l) => l.text)).toEqual([
      "suite   client's tests from 84f62b844f09 · nothing to restore or remove",
      "install dependencies installed · lifecycle scripts off",
      "pass    test     The test suite passes · npm test exited 0 with the client's baseline suite",
      "flag    src/pricing.js:9 reads process.env.CI · the client decides",
      "flag    package.json:12 adds left-pad · the client decides",
      "own     the freelancer's own tests · 12 passing, not used for payment",
    ]);
    // The flag settles the test criterion as unclear on the checklist (the last line with a status wins).
    expect(lines.at(-2)).toMatchObject({ tone: "needs", criterionId: "crt_t", status: "unclear" });
    expect(lines.at(-1)).not.toHaveProperty("criterionId");
  });
});

describe("evidence helpers", () => {
  it("reads what the client's suite restored and removed", () => {
    expect(parseBaseline("pass", "baseline suite: ran the baseline suite from the first parent 0123456789ab only (no baseline recorded for this milestone or pull request, so earlier merges are not covered) (3 file(s) changed); restored test/a.test.js, tests.js; removed test/00-setup.js; package.json: kept the baseline scripts")).toEqual({
      inPlace: true,
      sha: "0123456789ab",
      firstParent: true,
      restored: "test/a.test.js, tests.js",
      removed: "test/00-setup.js",
      other: ["package.json: kept the baseline scripts"],
      reason: null,
    });
  });

  it("splits a flag into place, finding, code and reason", () => {
    expect(parseFlag("gaming scan: index.js:50 reads process.env.CI (env-sniff): a; b; the delivered source reacts to the test run itself")).toEqual({ where: "index.js:50", what: "reads process.env.CI", code: "a; b", reason: "the delivered source reacts to the test run itself" });
    expect(parseFlag("something odd happened")).toEqual({ where: null, what: "something odd happened", code: null, reason: null });
  });

  it("treats unclear diff items on a test criterion as flags, never the suite item or a judgment's diff", () => {
    const kinds: Record<string, string> = { crt_t: "test", crt_j: "judgment" };
    const kindOf = (id: string) => kinds[id];
    expect(isFlag({ id: "evd_gaming_crt_t_1", kind: "diff", status: "unclear", criterionId: "crt_t" }, kindOf)).toBe(true);
    expect(isFlag({ id: "evd_newdep_1", kind: "diff", status: "unclear", criterionId: "crt_t" }, kindOf)).toBe(true);
    expect(isFlag({ id: "evd_gaming_delivery_1", kind: "diff", status: "unclear" }, kindOf)).toBe(true);
    expect(isFlag({ id: "evd_tamper_check", kind: "diff", status: "unclear" }, kindOf)).toBe(false);
    expect(isFlag({ id: "evd_x", kind: "diff", status: "unclear", criterionId: "crt_j" }, kindOf)).toBe(false);
    expect(isFlag({ id: "evd_crt_t", kind: "log", status: "unclear", criterionId: "crt_t" }, kindOf)).toBe(false);
  });

  it("names the failing tests in node and mocha output", () => {
    const node = "npm test exited 1; last lines:\n✖ annual billing gives 20% off twelve months (0.36ms)\nℹ fail 1\n✖ failing tests:\n\n✖ annual billing gives 20% off twelve months (0.36ms)";
    expect(failingTests(node)).toEqual(["annual billing gives 20% off twelve months"]);
    expect(failingTests("  48 passing\n  1 failing\n\n  1) ms(string)\n       should not be case sensitive:\n")).toEqual(["ms(string)"]);
    expect(failingTests("ℹ pass 8")).toEqual([]);
  });

  it("counts the freelancer's own tests from node, mocha or the exit code", () => {
    expect(ownTestsText("exited 1; last lines:\nℹ pass 11\nℹ fail 1")).toBe("11 passing, 1 failing");
    expect(ownTestsText("exited 0; last lines:\n  45 passing (20ms)")).toBe("45 passing");
    expect(ownTestsText("informational, does not decide: npm test ... exited 0; last lines: > x")).toBe("passing (exit 0)");
    expect(ownTestsText("informational, does not decide: npm test ... exited 1; last lines: > x")).toBe("failing (exit 1)");
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

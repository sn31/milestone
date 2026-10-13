import { describe, expect, it } from "vitest";
import { signature, verifierLines } from "./lines";
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
    const tamper = { id: "evd_tamper_check", kind: "diff", status: "pass", summary: "tamper check: 2 file(s) changed against the first parent abc only", criterionId: null };
    const test = { id: "evd_crt_t", kind: "log", status: "pass", summary: "npm test exited 0; last lines:", criterionId: "crt_t" };
    const mid = verifierLines({ ...base, delivery: { ...base.delivery!, evidenceCount: 1 }, evidence: [tamper] }, crit);
    expect(mid.slice(0, first.length)).toEqual(first);
    expect(mid.at(-1)).toEqual({ text: "tamper  clean · 2 files changed, no test, script, lockfile or CI edits", tone: "ok" });
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

  it("says which change made a pass untrustworthy", () => {
    const lines = verifierLines({ ...base, evidence: [{ id: "evd_tamper_check", kind: "diff", status: "unclear", summary: "tamper check against the x baseline: the delivery changes what the test/build commands run: test/pricing.test.js modified (existing test); package.json scripts changed", criterionId: null }] });
    expect(lines.at(-1)).toEqual({ text: "tamper  not trusted · test/pricing.test.js modified (existing test)", tone: "err" });
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

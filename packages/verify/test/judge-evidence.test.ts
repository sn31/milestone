/**
 * Judgment criteria get citable context evidence (evd_diff, evd_tree, evd_commit), read_file/get_diff results
 * carry the evd_diff id, and the parser attaches evd_diff to an uncited judgment pass only when the run read the delivery.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { CriterionSpec, EvidenceSummary, VerdictOutput } from "@milestone/core";
import { setProviderForTests } from "../src/llm.ts";
import type { GenerateRequest, GenerateResponse, Message, Provider } from "../src/providers/types.ts";
import { citableEvidence, enforce, judge, type EvidenceReader, type ToolCallRecord } from "../src/verifier.ts";

const specs: CriterionSpec[] = [
  { id: "tests", kind: "test", description: "tests pass", spec: { command: "npm test" }, required: true },
  { id: "file", kind: "file", description: "src/password.js exists", spec: { path: "src/password.js" }, required: true },
  { id: "judge", kind: "judgment", description: "The delivery matches the milestone description", spec: {}, required: false },
];
const evidence: EvidenceSummary[] = [
  { id: "evd_tests", criterion_id: "tests", kind: "log", status: "pass", summary: "npm test exited 0" },
  { id: "evd_file", criterion_id: "file", kind: "file", status: "pass", summary: "src/password.js present" },
  { id: "evd_diff", kind: "diff", summary: "2 file(s) changed, +40 -0" },
  { id: "evd_tree", kind: "file", summary: "README.md\nsrc/password.js" },
  { id: "evd_commit", kind: "note", summary: "commit message:\nfeat: password strength check" },
];
const uncited = (status: "pass" | "fail" | "unclear" = "pass", criterion_id = "judge"): VerdictOutput => ({
  delivery_id: "d",
  suspected_injection: false,
  criteria: [{ criterion_id, status, confidence: 0.9, evidence_ids: [], rationale: "src/password.js implements the strength rules" }],
});
const read: ToolCallRecord[] = [{ tool: "get_diff", input: {}, ok: true }];
const judgeOf = (v: VerdictOutput) => v.criteria.find((c) => c.criterion_id === "judge")!;

describe("enforce: uncited judgment pass", () => {
  it("keeps the pass with evd_diff attached when the run read the delivery", () => {
    const attached: Array<{ criterion_id: string; evidence_id: string }> = [];
    const v = enforce(uncited(), { deliveryId: "d", criteria: specs, evidence }, { toolCalls: read, attached });
    expect(judgeOf(v)).toMatchObject({ status: "pass", evidence_ids: ["evd_diff"], confidence: 0.9 });
    expect(attached).toEqual([{ criterion_id: "judge", evidence_id: "evd_diff" }]);
  });
  it("read_file counts too", () => {
    const v = enforce(uncited(), { deliveryId: "d", criteria: specs, evidence }, { toolCalls: [{ tool: "read_file", input: { path: "src/password.js" }, ok: true }] });
    expect(judgeOf(v).status).toBe("pass");
  });
  it("still downgrades to unclear when no tool was called, or only other or failed tools", () => {
    for (const toolCalls of [[], [{ tool: "list_evidence", input: {}, ok: true }], [{ tool: "read_file", input: { path: "../x" }, ok: false }]]) {
      const attached: Array<{ criterion_id: string; evidence_id: string }> = [];
      const v = enforce(uncited(), { deliveryId: "d", criteria: specs, evidence }, { toolCalls, attached });
      expect(judgeOf(v)).toMatchObject({ status: "unclear", evidence_ids: [] });
      expect(attached).toEqual([]);
    }
    expect(judgeOf(enforce(uncited(), { deliveryId: "d", criteria: specs, evidence })).status).toBe("unclear");
  });
  it("still downgrades when the delivery has no evd_diff (uploads, deterministic stage failed)", () => {
    const v = enforce(uncited(), { deliveryId: "d", criteria: specs, evidence: evidence.filter((e) => e.id !== "evd_diff") }, { toolCalls: read });
    expect(judgeOf(v).status).toBe("unclear");
  });
  it("never applies to a non-judgment criterion without a deterministic result", () => {
    const visual: CriterionSpec[] = [{ id: "shot", kind: "visual", description: "page renders", spec: {}, required: true }];
    const v = enforce(uncited("pass", "shot"), { deliveryId: "d", criteria: visual, evidence }, { toolCalls: read });
    expect(v.criteria[0]).toMatchObject({ status: "unclear", evidence_ids: [] });
  });
  it("leaves a cited pass, a fail and an unclear alone", () => {
    const cited: VerdictOutput = { ...uncited(), criteria: [{ ...uncited().criteria[0]!, evidence_ids: ["evd_tree", "made_up"] }] };
    expect(judgeOf(enforce(cited, { deliveryId: "d", criteria: specs, evidence }, { toolCalls: read }))).toMatchObject({ status: "pass", evidence_ids: ["evd_tree"] });
    expect(judgeOf(enforce(uncited("fail"), { deliveryId: "d", criteria: specs, evidence }, { toolCalls: read }))).toMatchObject({ status: "fail", evidence_ids: [] });
    expect(judgeOf(enforce(uncited("unclear"), { deliveryId: "d", criteria: specs, evidence }, { toolCalls: read }))).toMatchObject({ status: "unclear", evidence_ids: [] });
  });
});

describe("citableEvidence", () => {
  it("lists the context items, not the deterministic ones", () => {
    const text = citableEvidence(evidence);
    expect(text).toMatch(/evd_diff: the delivery's diff/);
    expect(text).toMatch(/evd_tree/);
    expect(text).toMatch(/evd_commit/);
    expect(text).not.toMatch(/evd_tests/);
  });
});

/** A scripted provider: first turn calls get_diff and read_file, second answers with whatever `answer` returns. */
function scripted(answer: (seen: Message[]) => VerdictOutput): { provider: Provider; requests: GenerateRequest[] } {
  const requests: GenerateRequest[] = [];
  const provider: Provider = {
    name: "fake",
    model: "scripted",
    async generate(req): Promise<GenerateResponse> {
      requests.push(structuredClone(req));
      if (req.messages.length === 1) {
        const calls = [{ id: "c1", name: "get_diff", input: {} }, { id: "c2", name: "read_file", input: { path: "src/password.js" } }];
        return { type: "tool_calls", calls, assistant: { role: "assistant", text: "", toolCalls: calls }, model: "scripted" };
      }
      return { type: "answer", value: answer(req.messages), model: "scripted" };
    },
  };
  return { provider, requests };
}

const reader: EvidenceReader = {
  readFile: async (p) => `// ${p}\nfunction checkPasswordStrength() {}`,
  getDiff: async () => "diff --git a/src/password.js b/src/password.js\n+function checkPasswordStrength() {}",
  listEvidence: async () => evidence,
  viewScreenshot: async () => "no screenshot",
  viewFile: async () => "not a file delivery",
};

describe("judge with a scripted model", () => {
  afterEach(() => setProviderForTests(null));

  it("labels read_file/get_diff results with evd_diff, lists citable ids and the milestone in the prompt, records tool calls, attaches evd_diff", async () => {
    const { provider, requests } = scripted(() => ({ delivery_id: "d", suspected_injection: false, criteria: [{ criterion_id: "judge", status: "pass", confidence: 0.85, evidence_ids: [], rationale: "The diff adds the password strength check." }] }));
    setProviderForTests(provider);
    const r = await judge({ deliveryId: "d", milestone: { title: "Signup form and validation", scope: "Build a signup flow" }, criteria: specs, evidence, deliveryTexts: [], reader });
    const user = (requests[0]!.messages[0] as { content: Array<{ text: string }> }).content[0]!.text;
    expect(user).toMatch(/Milestone: Signup form and validation\nContract scope: Build a signup flow/);
    expect(user).toMatch(/Evidence ids you may cite for judgment criteria/);
    expect(user).toMatch(/- evd_diff: /);
    expect(requests[0]!.system).toContain("a read_file or get_diff call corresponds to evd_diff/evd_tree; cite them when your judgment rests on what you read");
    const toolTurn = requests[1]!.messages[2] as Extract<Message, { role: "tool" }>;
    for (const res of toolTurn.results) expect((res.content[0] as { text: string }).text).toMatch(/\(evidence id: evd_diff\)\n<\/evidence>$/);
    expect(r.toolCalls).toEqual([{ tool: "get_diff", input: {}, ok: true }, { tool: "read_file", input: { path: "src/password.js" }, ok: true }]);
    expect(r.attachedEvidence).toEqual([{ criterion_id: "judge", evidence_id: "evd_diff" }]);
    expect(r.verdict.criteria.find((c) => c.criterion_id === "judge")).toMatchObject({ status: "pass", evidence_ids: ["evd_diff"] });
    expect(r.result).toBe("pass");
  });

  it("does not label tool results with evd_diff when the delivery has none, and a failed read is recorded as not ok", async () => {
    const { provider, requests } = scripted(() => ({ delivery_id: "d", suspected_injection: false, criteria: [{ criterion_id: "judge", status: "pass", confidence: 0.85, evidence_ids: [], rationale: "looks right" }] }));
    setProviderForTests(provider);
    const noDiff = evidence.filter((e) => e.id !== "evd_diff");
    const r = await judge({ deliveryId: "d", criteria: specs, evidence: noDiff, deliveryTexts: [], reader: { ...reader, readFile: async () => { throw new Error("no such file"); } } });
    const toolTurn = requests[1]!.messages[2] as Extract<Message, { role: "tool" }>;
    for (const res of toolTurn.results) expect((res.content[0] as { text: string }).text).not.toMatch(/evidence id/);
    expect(r.toolCalls.map((c) => c.ok)).toEqual([true, false]);
    expect(r.attachedEvidence).toEqual([]);
    expect(r.verdict.criteria.find((c) => c.criterion_id === "judge")?.status).toBe("unclear");
  });
});

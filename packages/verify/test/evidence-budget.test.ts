/** The judge's tool loop has an overall budget for tool-result text; past it, tools are not run and get a refusal. */
import { afterEach, describe, expect, it } from "vitest";
import type { CriterionSpec, EvidenceSummary } from "@milestone/core";
import { EVIDENCE_BUDGET_EXHAUSTED, TOOL_TEXT_BUDGET, setProviderForTests } from "../src/llm.ts";
import type { GenerateRequest, GenerateResponse, Message, Provider } from "../src/providers/types.ts";
import { judge, type EvidenceReader } from "../src/verifier.ts";

const specs: CriterionSpec[] = [{ id: "judge", kind: "judgment", description: "matches the milestone", spec: {}, required: true }];
const evidence: EvidenceSummary[] = [{ id: "evd_diff", kind: "diff", summary: "1 file changed" }];
const CHUNK = 100_000;

/** Calls read_file once per turn for `reads` turns, then answers with an uncited pass. */
function reading(reads: number): { provider: Provider; requests: GenerateRequest[] } {
  const requests: GenerateRequest[] = [];
  let turn = 0;
  const provider: Provider = {
    name: "fake",
    model: "scripted",
    async generate(req): Promise<GenerateResponse> {
      requests.push(req);
      if (turn < reads) {
        const calls = [{ id: `c${turn}`, name: "read_file", input: { path: `f${turn}.js` } }];
        turn++;
        return { type: "tool_calls", calls, assistant: { role: "assistant", text: "", toolCalls: calls }, model: "scripted" };
      }
      return { type: "answer", value: { delivery_id: "d", suspected_injection: false, criteria: [{ criterion_id: "judge", status: "pass", confidence: 0.8, evidence_ids: [], rationale: "ok" }] }, model: "scripted" };
    },
  };
  return { provider, requests };
}

const toolTexts = (messages: Message[]) =>
  messages.filter((m): m is Extract<Message, { role: "tool" }> => m.role === "tool").map((m) => (m.results[0]!.content[0] as { text: string }).text);

describe("evidence budget", () => {
  afterEach(() => setProviderForTests(null));

  it("stops running tools once the run has read the budget, and answers further calls with the refusal", async () => {
    const reads = Math.ceil(TOOL_TEXT_BUDGET / CHUNK) + 2;
    const { provider, requests } = reading(reads);
    setProviderForTests(provider);
    let served = 0;
    const reader: EvidenceReader = {
      readFile: async () => (served++, "x".repeat(CHUNK)),
      getDiff: async () => "x".repeat(CHUNK),
      listEvidence: async () => evidence,
      viewScreenshot: async () => "no screenshot",
      viewFile: async () => "n/a",
    };
    const r = await judge({ deliveryId: "d", criteria: specs, evidence, deliveryTexts: [], reader });
    const texts = toolTexts(requests.at(-1)!.messages);
    const within = TOOL_TEXT_BUDGET / CHUNK;
    expect(texts).toHaveLength(reads);
    expect(served).toBe(within);
    expect(texts.slice(0, within).every((t) => t.length > CHUNK)).toBe(true);
    for (const t of texts.slice(within)) {
      expect(t).toContain(EVIDENCE_BUDGET_EXHAUSTED);
      expect(t.length).toBeLessThan(500);
    }
    // Refused calls are not recorded as reads; the run still read the delivery, so rule 5 attaches evd_diff as before.
    expect(r.toolCalls).toHaveLength(within);
    expect(r.verdict.criteria[0]).toMatchObject({ status: "pass", evidence_ids: ["evd_diff"] });
  });

  it("leaves a run under the budget alone", async () => {
    const { provider, requests } = reading(2);
    setProviderForTests(provider);
    const reader: EvidenceReader = { readFile: async () => "small", getDiff: async () => "", listEvidence: async () => [], viewScreenshot: async () => "", viewFile: async () => "" };
    await judge({ deliveryId: "d", criteria: specs, evidence, deliveryTexts: [], reader });
    for (const t of toolTexts(requests.at(-1)!.messages)) expect(t).not.toContain(EVIDENCE_BUDGET_EXHAUSTED);
  });
});

import { describe, expect, it } from "vitest";
import { z } from "zod";
import type Anthropic from "@anthropic-ai/sdk";
import { createAnthropicProvider } from "../src/providers/anthropic.ts";
import { generateJson, setProviderForTests } from "../src/llm.ts";

/** A fake SDK client: records requests, answers from a script. */
function fakeClient(replies: Array<Anthropic.ContentBlock[]>) {
  const requests: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const client = { messages: { create: async (req: Anthropic.MessageCreateParamsNonStreaming) => (requests.push(structuredClone(req)), { content: replies.shift()! }) } } as unknown as Anthropic;
  return { client: () => client, requests };
}

describe("anthropic provider through generateJson", () => {
  it("runs tools, then returns the emit_<schema> input", async () => {
    const f = fakeClient([
      [{ type: "tool_use", id: "tu_1", name: "read_file", input: { path: "README.md" } } as Anthropic.ToolUseBlock],
      [{ type: "tool_use", id: "tu_2", name: "emit_verdict", input: { ok: true } } as Anthropic.ToolUseBlock],
    ]);
    setProviderForTests(createAnthropicProvider({ model: "claude-test", client: f.client }));
    try {
      const res = await generateJson({
        system: "s",
        user: "u",
        schema: z.object({ ok: z.boolean() }),
        schemaName: "verdict",
        tools: [{ name: "read_file", description: "read", input: z.object({ path: z.string() }), run: async () => "contents" }],
      });
      expect(res).toEqual({ ok: true, value: { ok: true }, model: "claude-test" });
      expect(f.requests[0]!.tools!.map((t) => (t as Anthropic.Tool).name)).toEqual(["emit_verdict", "read_file"]);
      expect(f.requests[0]!.tool_choice).toEqual({ type: "any" });
      const second = f.requests[1]!.messages;
      expect(second[1]).toMatchObject({ role: "assistant", content: [{ type: "tool_use", id: "tu_1" }] });
      expect(second[2]).toMatchObject({ role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: expect.stringContaining('untrusted="true"') }] });
    } finally {
      setProviderForTests(null);
    }
  });

  it("forces the emit tool on the last turn", async () => {
    const f = fakeClient([[{ type: "tool_use", id: "x", name: "emit_e", input: { ok: false } } as Anthropic.ToolUseBlock]]);
    setProviderForTests(createAnthropicProvider({ model: "claude-test", client: f.client }));
    try {
      await generateJson({ system: "s", user: "u", schema: z.object({ ok: z.boolean() }), schemaName: "e", maxTurns: 1 });
      expect(f.requests[0]!.tool_choice).toEqual({ type: "tool", name: "emit_e" });
    } finally {
      setProviderForTests(null);
    }
  });
});

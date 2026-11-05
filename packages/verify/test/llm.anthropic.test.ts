import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import Anthropic from "@anthropic-ai/sdk";
import { createAnthropicProvider, describeModelError, strictSchema } from "../src/providers/anthropic.ts";
import { generateJson, setProviderForTests } from "../src/llm.ts";

type Reply = { content: Anthropic.ContentBlock[]; stop_reason?: Anthropic.StopReason; stop_details?: Anthropic.RefusalStopDetails | null };

/** A fake SDK client: records requests, answers from a script. */
function fakeClient(replies: Reply[]) {
  const requests: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const client = {
    messages: {
      create: async (req: Anthropic.MessageCreateParamsNonStreaming) => {
        requests.push(structuredClone(req));
        const r = replies.shift()!;
        return { stop_reason: r.content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn", stop_details: null, ...r };
      },
    },
  } as unknown as Anthropic;
  return { client: () => client, requests };
}

const use = (id: string, name: string, input: unknown) => ({ type: "tool_use", id, name, input }) as Anthropic.ToolUseBlock;
const text = (t: string) => ({ type: "text", text: t, citations: null }) as Anthropic.TextBlock;
const schema = z.object({ ok: z.boolean() });
/** The text of the last user message's last block, where the answer-now instruction goes. */
const lastUserText = (req: Anthropic.MessageCreateParamsNonStreaming) => {
  const last = req.messages.at(-1)!;
  expect(last.role).toBe("user");
  const blocks = typeof last.content === "string" ? [{ type: "text", text: last.content }] : last.content;
  const end = blocks.at(-1) as { type: string; text?: string };
  return end.type === "text" ? end.text! : "";
};

function withFake(replies: Reply[]) {
  const f = fakeClient(replies);
  setProviderForTests(createAnthropicProvider({ model: "claude-test", client: f.client }));
  return f;
}

describe("anthropic provider through generateJson", () => {
  afterEach(() => setProviderForTests(null));

  it("runs tools, then returns the emit_<schema> input; tool choice is auto and the tools are strict", async () => {
    const f = withFake([{ content: [use("tu_1", "read_file", { path: "README.md" })] }, { content: [use("tu_2", "emit_verdict", { ok: true })] }]);
    const res = await generateJson({
      system: "s",
      user: "u",
      schema,
      schemaName: "verdict",
      tools: [{ name: "read_file", description: "read", input: z.object({ path: z.string() }), run: async () => "contents" }],
    });
    expect(res).toEqual({ ok: true, value: { ok: true }, model: "claude-test" });
    const tools = f.requests[0]!.tools as Anthropic.Tool[];
    expect(tools.map((t) => t.name)).toEqual(["emit_verdict", "read_file"]);
    expect(tools.map((t) => t.strict)).toEqual([true, true]);
    for (const r of f.requests) expect(r.tool_choice).toEqual({ type: "auto" });
    const second = f.requests[1]!.messages;
    expect(second[1]).toMatchObject({ role: "assistant", content: [{ type: "tool_use", id: "tu_1" }] });
    expect(second[2]).toMatchObject({ role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: expect.stringContaining('untrusted="true"') }] });
  });

  it("asks for the emit call on the last turn instead of forcing it", async () => {
    const f = withFake([{ content: [use("x", "emit_e", { ok: false })] }]);
    const res = await generateJson({ system: "s", user: "u", schema, schemaName: "e", maxTurns: 1 });
    expect(res.ok).toBe(true);
    expect(f.requests[0]!.tool_choice).toEqual({ type: "auto" });
    expect(f.requests[0]!.messages).toHaveLength(2);
    expect(lastUserText(f.requests[0]!)).toContain("emit_e");
  });

  it("nudges once after a text-only reply, appending to the history rather than editing it", async () => {
    const f = withFake([{ content: [text("I think it passes.")] }, { content: [use("x", "emit_e", { ok: true })] }]);
    const res = await generateJson({ system: "s", user: "u", schema, schemaName: "e" });
    expect(res).toEqual({ ok: true, value: { ok: true }, model: "claude-test" });
    expect(f.requests).toHaveLength(2);
    const [first, second] = f.requests.map((r) => r.messages);
    expect(second!.slice(0, first!.length).map((m) => m.role)).toEqual(first!.map((m) => m.role));
    expect(second![1]).toMatchObject({ role: "assistant", content: [{ type: "text", text: "I think it passes." }] });
    expect(lastUserText(f.requests[1]!)).toContain("emit_e");
  });

  it("a second text-only reply is a failure, not an answer", async () => {
    withFake([{ content: [text("a")] }, { content: [text("b")] }]);
    const res = await generateJson({ system: "s", user: "u", schema, schemaName: "e" });
    expect(res).toMatchObject({ ok: false, reason: "no_answer" });
  });

  it("the nudge gets its own turn even when the text reply came on the last one", async () => {
    const f = withFake([{ content: [text("a")] }, { content: [use("x", "emit_e", { ok: true })] }]);
    const res = await generateJson({ system: "s", user: "u", schema, schemaName: "e", maxTurns: 1 });
    expect(res.ok).toBe(true);
    expect(f.requests).toHaveLength(2);
  });

  it("max_tokens: a partial emit is discarded and the same request goes again once with double the budget", async () => {
    const f = withFake([
      { content: [use("x", "emit_e", { ok: true })], stop_reason: "max_tokens" },
      { content: [use("y", "emit_e", { ok: false })] },
    ]);
    const res = await generateJson({ system: "s", user: "u", schema, schemaName: "e", maxTokens: 4000 });
    expect(res).toEqual({ ok: true, value: { ok: false }, model: "claude-test" });
    expect(f.requests.map((r) => r.max_tokens)).toEqual([4000, 8000]);
    expect(f.requests[1]!.messages).toEqual(f.requests[0]!.messages);
  });

  it("max_tokens twice: a distinguishable failure", async () => {
    const f = withFake([
      { content: [], stop_reason: "max_tokens" },
      { content: [], stop_reason: "max_tokens" },
    ]);
    const res = await generateJson({ system: "s", user: "u", schema, schemaName: "e" });
    expect(res).toMatchObject({ ok: false, reason: "max_tokens" });
    expect(f.requests.map((r) => r.max_tokens)).toEqual([8192, 16_000]);
  });

  it("the default budget leaves room for thinking", async () => {
    const f = withFake([{ content: [use("x", "emit_e", { ok: true })] }]);
    await generateJson({ system: "s", user: "u", schema, schemaName: "e" });
    expect(f.requests[0]!.max_tokens).toBeGreaterThanOrEqual(8192);
  });

  it("refusal: a model-refused failure carrying stop_details, even with an emit call in the content", async () => {
    const f = withFake([
      { content: [use("x", "emit_e", { ok: true })], stop_reason: "refusal", stop_details: { type: "refusal", category: "cyber", explanation: "declined for policy" } as Anthropic.RefusalStopDetails },
    ]);
    const res = await generateJson({ system: "s", user: "u", schema, schemaName: "e" });
    expect(res).toMatchObject({ ok: false, reason: "refusal" });
    expect(res.ok ? "" : res.error).toContain("declined for policy");
    expect(f.requests).toHaveLength(1);
  });

  it("refusal without details still says it was declined", async () => {
    withFake([{ content: [], stop_reason: "refusal", stop_details: null }]);
    const res = await generateJson({ system: "s", user: "u", schema, schemaName: "e" });
    expect(res).toMatchObject({ ok: false, reason: "refusal" });
  });

  it("an API error propagates out of generateJson (the worker records unclear)", async () => {
    const client = { messages: { create: async () => { throw new Anthropic.RateLimitError(429, { type: "error", error: { type: "rate_limit_error", message: "slow down" } }, "slow down", new Headers()); } } } as unknown as Anthropic;
    setProviderForTests(createAnthropicProvider({ model: "claude-test", client: () => client }));
    const err = await generateJson({ system: "s", user: "u", schema, schemaName: "e" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Anthropic.RateLimitError);
    expect(describeModelError(err)).toBe("RateLimitError 429 rate_limit_error");
    expect(describeModelError(new TypeError("x"))).toBe("TypeError");
  });
});

describe("strictSchema", () => {
  it("keeps enums and required, moves unsupported constraints into the description", () => {
    const s = strictSchema(z.toJSONSchema(z.object({ status: z.enum(["pass", "fail"]), confidence: z.number().min(0).max(1), note: z.string().max(400) })) as Record<string, unknown>)!;
    expect(s).not.toHaveProperty("$schema");
    expect(s).toMatchObject({ type: "object", additionalProperties: false, required: ["status", "confidence", "note"] });
    const props = s.properties as Record<string, Record<string, unknown>>;
    expect(props.status!.enum).toEqual(["pass", "fail"]);
    expect(props.confidence).not.toHaveProperty("minimum");
    expect(props.confidence!.description).toContain("maximum");
    expect(props.note).not.toHaveProperty("maxLength");
  });

  it("refuses schemas strict mode would change: records, open objects, untyped nodes, refs", () => {
    expect(strictSchema(z.toJSONSchema(z.object({ spec: z.record(z.string(), z.unknown()) })) as Record<string, unknown>)).toBeNull();
    expect(strictSchema({ type: "object", properties: { a: { type: "string" } } })).toBeNull();
    expect(strictSchema({ type: "object", properties: { a: {} }, additionalProperties: false })).toBeNull();
    expect(strictSchema({ $ref: "#/$defs/x", $defs: { x: { type: "string" } } })).toBeNull();
  });
});

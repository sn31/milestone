/** Claude through the Anthropic SDK: the final answer is forced through an `emit_<schema>` tool. */
import Anthropic from "@anthropic-ai/sdk";
import type { Block, GenerateRequest, GenerateResponse, Message, Provider } from "./types.ts";

export const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-5-5";

/** MILESTONE_MODEL when it names a Claude model; an Ollama tag left in it is ignored. */
export function anthropicModel(env: NodeJS.ProcessEnv = process.env): string {
  const m = env.MILESTONE_MODEL?.trim();
  return m && m.startsWith("claude") ? m : DEFAULT_ANTHROPIC_MODEL;
}

let client: Anthropic | null = null;
export function anthropic(): Anthropic {
  client ??= new Anthropic();
  return client;
}

type ToolResultContent = NonNullable<Anthropic.ToolResultBlockParam["content"]>;

/** Neutral blocks to a tool_result's content; a lone text block stays a plain string. */
export function toAnthropicContent(blocks: Block[]): ToolResultContent {
  if (blocks.length === 1 && blocks[0]!.type === "text") return blocks[0]!.text;
  return blocks.map((b) => {
    if (b.type === "text") return { type: "text" as const, text: b.text };
    if (b.type === "image") return { type: "image" as const, source: { type: "base64" as const, media_type: b.mediaType, data: b.base64 } };
    return { type: "document" as const, source: { type: "base64" as const, media_type: b.mediaType, data: b.base64 } };
  });
}

function toAnthropicMessages(messages: Message[]): Anthropic.MessageParam[] {
  return messages.map((m): Anthropic.MessageParam => {
    if (m.role === "user") {
      const content = toAnthropicContent(m.content);
      return { role: "user", content: typeof content === "string" ? content : (content as Anthropic.ContentBlockParam[]) };
    }
    if (m.role === "assistant") {
      if (m.raw) return { role: "assistant", content: m.raw as Anthropic.ContentBlockParam[] };
      return {
        role: "assistant",
        content: [...(m.text ? [{ type: "text" as const, text: m.text }] : []), ...m.toolCalls.map((c) => ({ type: "tool_use" as const, id: c.id, name: c.name, input: c.input }))],
      };
    }
    return { role: "user", content: m.results.map((r) => ({ type: "tool_result" as const, tool_use_id: r.callId, content: toAnthropicContent(r.content) })) };
  });
}

export function createAnthropicProvider(opts: { model?: string; client?: () => Anthropic } = {}): Provider {
  const model = opts.model ?? anthropicModel();
  const getClient = opts.client ?? anthropic;
  return {
    name: "anthropic",
    model,
    async generate(req: GenerateRequest): Promise<GenerateResponse> {
      const emit = { name: req.answer.name, description: req.answer.description, input_schema: req.answer.schema as Anthropic.Tool.InputSchema };
      const tools: Anthropic.Tool[] = [emit, ...req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema as Anthropic.Tool.InputSchema }))];
      const res = await getClient().messages.create({
        model,
        max_tokens: req.maxTokens,
        system: req.system,
        messages: toAnthropicMessages(req.messages),
        tools,
        tool_choice: req.forceAnswer ? { type: "tool", name: emit.name } : { type: "any" },
      });
      const uses = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      const final = uses.find((u) => u.name === emit.name);
      if (final) return { type: "answer", value: final.input, model };
      if (uses.length === 0) return { type: "stop", reason: "model stopped without emitting", model };
      const text = res.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("\n");
      const calls = uses.map((u) => ({ id: u.id, name: u.name, input: u.input }));
      return { type: "tool_calls", calls, assistant: { role: "assistant", text, toolCalls: calls, raw: res.content }, model };
    },
  };
}

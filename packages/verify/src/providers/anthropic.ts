/**
 * Claude through the Anthropic SDK: the final answer comes through an `emit_<schema>` tool.
 *
 * Tool choice is always "auto": claude-sonnet-5-5 and the rest of its generation reject forced tool choice ("tool" or
 * "any") with a 400. The emit tool is strict (schema-valid arguments), and the loop in llm.ts asks for the call in the
 * prompt instead of forcing it. stop_reason is read before the content: max_tokens and refusal are outcomes of their own.
 *
 * Prompt caching: two ephemeral breakpoints per request. One on the system prompt caches the tools + system prefix,
 * which every turn of a generateJson loop repeats; one on the latest message caches the history so the next turn
 * reads it back instead of paying for it again.
 */
import Anthropic from "@anthropic-ai/sdk";
import { anthropicModel, DEFAULT_ANTHROPIC_MODEL } from "./config.ts";
import type { Block, GenerateRequest, GenerateResponse, JsonSchema, Message, Provider, ToolDef } from "./types.ts";

export { anthropicModel, DEFAULT_ANTHROPIC_MODEL };

const EPHEMERAL = { type: "ephemeral" } as const;

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

/** The same messages with a cache breakpoint on the last block of the latest user turn (a copy; nothing is mutated). */
function withCacheBreakpoint(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  const last = messages.at(-1);
  if (!last || last.role !== "user") return messages;
  const blocks: Anthropic.ContentBlockParam[] = typeof last.content === "string" ? [{ type: "text", text: last.content }] : [...last.content];
  const end = blocks.at(-1);
  if (!end) return messages;
  blocks[blocks.length - 1] = { ...end, cache_control: EPHEMERAL } as Anthropic.ContentBlockParam;
  return [...messages.slice(0, -1), { role: "user", content: blocks }];
}

const STRICT_FORMATS = new Set(["date-time", "time", "date", "duration", "email", "hostname", "uri", "ipv4", "ipv6", "uuid"]);

/**
 * A JSON schema in the subset strict tool use accepts, or null when it cannot be made strict without changing what it
 * accepts: an object that allows extra keys (records, most MCP schemas), a $ref (possibly recursive), a node with no type.
 * Constraints strict mode does not support (minimum, maxLength, default, ...) move into the description, like the SDK's
 * transformJSONSchema does; the caller's zod parse still enforces them. Unlike that helper, enum and const are kept.
 */
export function strictSchema(schema: JsonSchema): JsonSchema | null {
  const { $schema: _, ...rest } = schema;
  return strictNode(rest);
}

function strictNode(node: unknown): JsonSchema | null {
  if (!node || typeof node !== "object" || Array.isArray(node)) return null;
  const src: Record<string, unknown> = { ...(node as Record<string, unknown>) };
  if ("$ref" in src || "$defs" in src || "definitions" in src) return null;
  const take = (k: string) => {
    const v = src[k];
    delete src[k];
    return v;
  };
  const out: JsonSchema = {};
  const type = take("type");
  if (type !== undefined) out.type = type;
  for (const k of ["description", "title", "enum", "const"]) if (k in src) out[k] = take(k);
  for (const [k, as] of [["anyOf", "anyOf"], ["oneOf", "anyOf"], ["allOf", "allOf"]] as const) {
    const list = take(k);
    if (list === undefined) continue;
    if (!Array.isArray(list)) return null;
    const mapped = list.map(strictNode);
    if (mapped.some((m) => m === null)) return null;
    out[as] = mapped;
  }
  if (out.type === undefined && !out.anyOf && !out.allOf && !("enum" in out) && !("const" in out)) return null;
  const types = Array.isArray(type) ? type : [type];
  if (types.includes("object")) {
    if (take("additionalProperties") !== false) return null;
    const props = (take("properties") ?? {}) as Record<string, unknown>;
    const mapped: Record<string, JsonSchema> = {};
    for (const [k, v] of Object.entries(props)) {
      const m = strictNode(v);
      if (!m) return null;
      mapped[k] = m;
    }
    out.properties = mapped;
    out.additionalProperties = false;
    const required = take("required");
    if (required !== undefined) out.required = required;
  }
  if (types.includes("array")) {
    const items = strictNode(take("items"));
    if (!items) return null;
    out.items = items;
    if (src.minItems === 0 || src.minItems === 1) out.minItems = take("minItems");
  }
  if (types.includes("string") && typeof src.format === "string" && STRICT_FORMATS.has(src.format)) out.format = take("format");
  const notes = Object.entries(src);
  if (notes.length) out.description = `${out.description ? `${String(out.description)}\n\n` : ""}{${notes.map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(", ")}}`;
  return out;
}

/** The API caps how many strict tools one request may carry; the emit tool comes first, so it is always strict when it can be. */
const MAX_STRICT_TOOLS = 20;

/** Tool definitions, `strict: true` on every one whose schema allows it, so the arguments the model sends validate. */
export function toolDefinitions(defs: ToolDef[]): Anthropic.Tool[] {
  let strict = 0;
  return defs.map((d) => {
    const s = strict < MAX_STRICT_TOOLS ? strictSchema(d.inputSchema) : null;
    if (!s) return { name: d.name, description: d.description, input_schema: d.inputSchema as Anthropic.Tool.InputSchema };
    strict++;
    return { name: d.name, description: d.description, input_schema: s as Anthropic.Tool.InputSchema, strict: true };
  });
}

/** stop_reason refusal as an outcome: stop_details' explanation (or category) when the API gives one. */
function refusal(res: Anthropic.Message, model: string): GenerateResponse {
  const d = res.stop_details;
  const category = d?.category ?? null;
  const explanation = d?.explanation?.trim().slice(0, 300);
  return { type: "refused", reason: explanation || (category ? `declined (${category})` : "the model declined to answer"), category, model };
}

export function createAnthropicProvider(opts: { model?: string; client?: () => Anthropic } = {}): Provider {
  const model = opts.model ?? anthropicModel();
  const getClient = opts.client ?? anthropic;
  return {
    name: "anthropic",
    model,
    async generate(req: GenerateRequest): Promise<GenerateResponse> {
      const tools = toolDefinitions([{ name: req.answer.name, description: req.answer.description, inputSchema: req.answer.schema }, ...req.tools]);
      const res = await getClient().messages.create({
        model,
        max_tokens: req.maxTokens,
        system: [{ type: "text", text: req.system, cache_control: EPHEMERAL }],
        messages: withCacheBreakpoint(toAnthropicMessages(req.messages)),
        tools,
        // Current Claude models reject forced tool choice ("tool"/"any") with a 400; the prompt asks for the emit call.
        tool_choice: { type: "auto" },
      });
      // A refused or truncated turn is never read as an answer, even when it holds a (partial) emit call.
      if (res.stop_reason === "refusal") return refusal(res, model);
      if (res.stop_reason === "max_tokens") return { type: "truncated", model };
      const uses = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      const final = uses.find((u) => u.name === req.answer.name);
      if (final) return { type: "answer", value: final.input, model };
      const text = res.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("\n");
      if (uses.length > 0) {
        const calls = uses.map((u) => ({ id: u.id, name: u.name, input: u.input }));
        return { type: "tool_calls", calls, assistant: { role: "assistant", text, toolCalls: calls, raw: res.content }, model };
      }
      if (res.stop_reason == null || res.stop_reason === "end_turn") return { type: "text", text, assistant: { role: "assistant", text, toolCalls: [], raw: res.content }, model };
      return { type: "stop", reason: `model stopped (${res.stop_reason}) without emitting`, model };
    },
  };
}

/**
 * A short, secret-free description of a failed model call for verdicts and audit rows: the SDK error class, the HTTP
 * status and the API's error type (e.g. "RateLimitError 429 rate_limit_error"), never the message or request.
 */
export function describeModelError(e: unknown): string {
  if (e instanceof Anthropic.APIError) {
    const body = e.error as { error?: { type?: unknown } } | undefined;
    const type = typeof body?.error?.type === "string" ? body.error.type : null;
    return [e.constructor.name, e.status, type].filter((x) => x !== undefined && x !== null && x !== "").join(" ");
  }
  return e instanceof Error ? e.name : "unknown error";
}

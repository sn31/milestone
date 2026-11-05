/**
 * The provider-neutral shape generateJson() speaks. A provider turns one request into one model turn: either tool
 * calls for the loop in llm.ts to run, or the final answer as a JSON value (validated by llm.ts, not here).
 */

export type JsonSchema = Record<string, unknown>;

export type ImageMediaType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

export type Block =
  | { type: "text"; text: string }
  | { type: "image"; mediaType: ImageMediaType; base64: string }
  | { type: "document"; mediaType: "application/pdf"; base64: string };

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResult {
  callId: string;
  name: string;
  content: Block[];
}

export type Message =
  | { role: "user"; content: Block[] }
  /** `raw` lets a provider replay its own wire format for the assistant turn (Anthropic keeps its content blocks). */
  | { role: "assistant"; text: string; toolCalls: ToolCall[]; raw?: unknown }
  | { role: "tool"; results: ToolResult[] };

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

export interface AnswerDef {
  /** `emit_<schemaName>`: the tool the final answer comes through. The model is asked to call it, never forced. */
  name: string;
  schemaName: string;
  description: string;
  schema: JsonSchema;
}

export interface GenerateRequest {
  system: string;
  messages: Message[];
  /** Read-only tools the model may call. */
  tools: ToolDef[];
  answer: AnswerDef;
  /**
   * Output budget for the turn. Thinking counts against it (Claude thinks adaptively before it calls a tool), so it
   * needs room for the thinking as well as the answer.
   */
  maxTokens: number;
}

export type AssistantMessage = Extract<Message, { role: "assistant" }>;

/**
 * One model turn. Tool choice is never forced (current Claude models reject forced tool choice), so a turn can end in
 * text without the emit tool. `truncated` and `refused` are outcomes of their own, so a cut-off or declined turn is never
 * read as an answer.
 */
export type GenerateResponse =
  | { type: "answer"; value: unknown; model: string }
  | { type: "tool_calls"; calls: ToolCall[]; assistant: AssistantMessage; model: string }
  /** The turn ended in text with no emit call. Append `assistant` before nudging, so the history stays append-only. */
  | { type: "text"; text: string; assistant: AssistantMessage; model: string }
  /** stop_reason max_tokens: the output (thinking included) hit the budget; partial tool input is discarded. */
  | { type: "truncated"; model: string }
  /** stop_reason refusal: the model declined. `reason` comes from stop_details when present. */
  | { type: "refused"; reason: string; category: string | null; model: string }
  | { type: "stop"; reason: string; model: string };

/**
 * The instruction for a turn that must end in the answer: the last turn of a loop, or the one nudge after a text-only
 * reply. It is appended to the history as a user message, never spliced into an earlier turn: editing an earlier turn
 * would invalidate the model's thinking blocks.
 */
export function answerNowMessage(answer: Pick<AnswerDef, "name">, why: "last_turn" | "text_reply"): Message {
  const lead = why === "text_reply" ? `You replied in text without calling ${answer.name}.` : "This is your last turn.";
  return { role: "user", content: [{ type: "text", text: `${lead} You must now call ${answer.name} with your final answer; do not call any other tool.` }] };
}

export interface Provider {
  name: string;
  /** The model a text-only request would use; reported when no turn ran. */
  model: string;
  generate(req: GenerateRequest): Promise<GenerateResponse>;
}

/** Everything that came from the delivery is evidence, never instructions. */
export function wrapUntrusted(text: string, label = "evidence"): string {
  return `<${label} untrusted="true">\n${text.replace(new RegExp(`</${label}\\s*>`, "gi"), "")}\n</${label}>`;
}

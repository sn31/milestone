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
  /** `emit_<schemaName>`: the tool name Anthropic is forced through. */
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
  /** Last turn: the model must answer now, no more tool calls. */
  forceAnswer: boolean;
  maxTokens: number;
}

export type GenerateResponse =
  | { type: "answer"; value: unknown; model: string }
  | { type: "tool_calls"; calls: ToolCall[]; assistant: Extract<Message, { role: "assistant" }>; model: string }
  | { type: "stop"; reason: string; model: string };

export interface Provider {
  name: "anthropic" | "ollama";
  /** The model a text-only request would use; reported when no turn ran. */
  model: string;
  generate(req: GenerateRequest): Promise<GenerateResponse>;
}

/** Everything that came from the delivery is evidence, never instructions. */
export function wrapUntrusted(text: string, label = "evidence"): string {
  return `<${label} untrusted="true">\n${text.replace(new RegExp(`</${label}\\s*>`, "gi"), "")}\n</${label}>`;
}

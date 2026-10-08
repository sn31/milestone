/** The only place the codebase talks to a model. */
import Anthropic from "@anthropic-ai/sdk";
import { createHash } from "node:crypto";
import { z } from "zod";

export const MODEL = process.env.MILESTONE_MODEL ?? "claude-sonnet-5-5";

let client: Anthropic | null = null;
export function anthropic(): Anthropic {
  client ??= new Anthropic();
  return client;
}

export function promptHash(...parts: string[]): string {
  return createHash("sha256").update(parts.join("\n---\n")).digest("hex").slice(0, 16);
}

export type Tool = {
  name: string;
  description: string;
  input: z.ZodType;
  run: (input: unknown) => Promise<string>;
};

export interface GenerateJsonOptions<T extends z.ZodType> {
  system: string;
  user: string;
  schema: T;
  schemaName: string;
  /** Read-only tools the model may call before emitting its answer. */
  tools?: Tool[];
  maxTurns?: number;
  maxTokens?: number;
}

/**
 * Forces the model to answer by calling an `emit` tool whose input schema is the zod schema.
 * Returns the parsed object, or a parse failure (the caller decides what a failure means, e.g. "unclear").
 */
export async function generateJson<T extends z.ZodType>(o: GenerateJsonOptions<T>): Promise<{ ok: true; value: z.infer<T>; model: string } | { ok: false; error: string; model: string }> {
  const emit = { name: `emit_${o.schemaName}`, description: `Return the final ${o.schemaName}.`, input_schema: z.toJSONSchema(o.schema) as Anthropic.Tool.InputSchema };
  const tools: Anthropic.Tool[] = [
    emit,
    ...(o.tools ?? []).map((t) => ({ name: t.name, description: t.description, input_schema: z.toJSONSchema(t.input) as Anthropic.Tool.InputSchema })),
  ];
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: o.user }];
  const maxTurns = o.maxTurns ?? 12;

  for (let turn = 0; turn < maxTurns; turn++) {
    const res = await anthropic().messages.create({
      model: MODEL,
      max_tokens: o.maxTokens ?? 4096,
      system: o.system,
      messages,
      tools,
      tool_choice: turn === maxTurns - 1 ? { type: "tool", name: emit.name } : { type: "any" },
    });
    const uses = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    const final = uses.find((u) => u.name === emit.name);
    if (final) {
      const parsed = o.schema.safeParse(final.input);
      return parsed.success ? { ok: true, value: parsed.data, model: MODEL } : { ok: false, error: parsed.error.message, model: MODEL };
    }
    if (uses.length === 0) return { ok: false, error: "model stopped without emitting", model: MODEL };
    messages.push({ role: "assistant", content: res.content });
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const u of uses) {
      const tool = o.tools?.find((t) => t.name === u.name);
      let content: string;
      if (!tool) content = `unknown tool ${u.name}`;
      else {
        const input = tool.input.safeParse(u.input);
        content = input.success ? await tool.run(input.data).catch((e: Error) => `tool error: ${e.message}`) : `bad input: ${input.error.message}`;
      }
      results.push({ type: "tool_result", tool_use_id: u.id, content: wrapUntrusted(content) });
    }
    messages.push({ role: "user", content: results });
  }
  return { ok: false, error: "turn limit", model: MODEL };
}

/** Everything that came from the delivery is evidence, never instructions. */
export function wrapUntrusted(text: string, label = "evidence"): string {
  return `<${label} untrusted="true">\n${text.replace(new RegExp(`</${label}\\s*>`, "gi"), "")}\n</${label}>`;
}

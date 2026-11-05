// Server only. One console turn: the configured model, the mandate's tools on Milestone MCP and PayPal MCP
// (read-only), in a tool loop shaped like generateJson's (packages/verify/src/llm.ts). Every step is emitted as a
// ConsoleEvent so the browser shows each tool call as it happens. Tool output reaches the model wrapped as untrusted.
import { answerNowMessage, getProvider, toolResultBlocks, wrapUntrusted, type AnswerDef, type Message, type ToolDef, type ToolResult } from "./model";
import { systemPrompt, turnPrompt } from "./prompt";
import type { ConsoleEvent, ConsoleMessage, MandateSummary } from "./protocol";
import { SERVER_LABEL } from "./protocol";
import type { AgentTool } from "./servers";
import { approvalLinks, claimCheck, formatArgs, statusOf, summarizeResult, type CallRecord } from "./tools";

const ANSWER: AnswerDef = {
  name: "emit_reply",
  schemaName: "reply",
  description: "your reply to the client: plain text, at most four short sentences",
  schema: {
    type: "object",
    properties: { reply: { type: "string", description: "Plain text for the client. Say what you did, what each tool returned, and what happens next." } },
    required: ["reply"],
    additionalProperties: false,
  },
};

/** Output budget per model turn. Thinking counts against it (adaptive thinking runs before each tool call). */
const MAX_TOKENS = 4096;

/** Tool results the model sees are capped (characters) so a long listing does not push the mandate out of context. */
const RESULT_MAX = 6000;

export interface TurnInput {
  mandate: MandateSummary;
  clientName: string;
  messages: ConsoleMessage[];
  tools: AgentTool[];
  origin: string;
  emit: (e: ConsoleEvent) => void;
  signal?: AbortSignal;
  maxTurns?: number;
}

export async function runAgentTurn(o: TurnInput): Promise<void> {
  const provider = getProvider();
  const byName = new Map<string, AgentTool>();
  for (const t of o.tools) if (!byName.has(t.name)) byName.set(t.name, t);
  const defs: ToolDef[] = [...byName.values()].map((t) => ({ name: t.name, description: `[${SERVER_LABEL[t.server]}] ${t.description}`, inputSchema: t.inputSchema }));
  const system = systemPrompt(o.mandate, o.clientName, defs.map((d) => d.name));
  const messages: Message[] = [{ role: "user", content: [{ type: "text", text: turnPrompt(o.messages, wrapUntrusted) }] }];
  const maxTurns = o.maxTurns ?? 8;
  /** A call refused once is not sent again in the same turn (rule 3: never retry around a refusal). */
  const refused = new Set<string>();
  let seq = 0;
  const done: CallRecord[] = [];
  let corrected = false;

  let maxTokens = MAX_TOKENS;

  for (let turn = 0; turn < maxTurns; turn++) {
    if (o.signal?.aborted) return;
    o.emit({ t: "thinking", turn });
    // Tool choice is never forced (the model rejects it): the last turn asks for the reply in the history instead.
    if (turn === maxTurns - 1) messages.push(answerNowMessage(ANSWER, "last_turn"));
    let res: Awaited<ReturnType<typeof provider.generate>>;
    try {
      res = await provider.generate({ system, messages, tools: defs, answer: ANSWER, maxTokens });
      // Cut off at max_tokens (thinking included): the same request once more with double the room, history unchanged.
      if (res.type === "truncated" && maxTokens === MAX_TOKENS) {
        maxTokens *= 2;
        res = await provider.generate({ system, messages, tools: defs, answer: ANSWER, maxTokens });
      }
    } catch (e) {
      o.emit({ t: "error", error: `The model call failed (${provider.name} · ${provider.model}): ${(e as Error).message}. Nothing further was done.` });
      return;
    }
    // With tool choice "auto" a turn that ends in plain text is the model's reply, the same as an emit_reply call.
    if (res.type === "answer" || res.type === "text") {
      const reply = res.type === "text" ? res.text : res.value && typeof res.value === "object" ? (res.value as { reply?: unknown }).reply : null;
      if (typeof reply !== "string" || !reply.trim()) {
        o.emit({ t: "error", error: "the model returned no reply" });
        return;
      }
      const notice = claimCheck(reply, done);
      // A reply that claims an action no tool call made gets one correction turn: make the call, or stop claiming it.
      if (notice && !corrected && turn < maxTurns - 2) {
        corrected = true;
        messages.push(res.type === "text" ? res.assistant : { role: "assistant", text: reply.trim(), toolCalls: [] });
        messages.push({ role: "user", content: [{ type: "text", text: `Check: ${notice} If the client asked for it and the mandate and Milestone allow it, call the tool now. Otherwise answer again without claiming it was done.` }] });
        continue;
      }
      o.emit({ t: "reply", text: reply.trim(), ...(notice ? { notice } : {}) });
      return;
    }
    if (res.type === "truncated") {
      o.emit({ t: "error", error: `the model ran out of output tokens (${maxTokens}) before replying. Nothing further was done.` });
      return;
    }
    if (res.type === "refused") {
      o.emit({ t: "error", error: `the model declined: ${res.reason}` });
      return;
    }
    if (res.type === "stop") {
      o.emit({ t: "error", error: `the model stopped: ${res.reason}` });
      return;
    }
    messages.push(res.assistant);
    const results: ToolResult[] = [];
    for (const c of res.calls) {
      const id = `c${++seq}`;
      const tool = byName.get(c.name);
      const args = c.input && typeof c.input === "object" && !Array.isArray(c.input) ? (c.input as Record<string, unknown>) : {};
      o.emit({ t: "call", id, server: tool?.server ?? "milestone", tool: c.name, args });
      const key = `${c.name} ${formatArgs(args, 10_000)}`;
      let text: string;
      let ok: boolean;
      let value: unknown = null;
      if (!tool) {
        text = `unknown tool ${c.name}: not in this console's tool list`;
        ok = false;
      } else if (refused.has(key)) {
        text = "not sent: the same call was refused earlier in this turn; report the refusal instead of retrying";
        ok = false;
      } else {
        try {
          const r = await tool.call(args);
          text = r.text;
          ok = !r.isError;
          value = r.value;
        } catch (e) {
          text = `tool error: ${(e as Error).message}`;
          ok = false;
        }
      }
      const summary = summarizeResult(text, !ok);
      if (!ok || summary.startsWith("refused")) refused.add(key);
      done.push({ tool: c.name, args, ok: ok && !summary.startsWith("refused"), status: statusOf(value) });
      o.emit({ t: "result", id, ok: ok && !summary.startsWith("refused"), summary, status: statusOf(value), links: approvalLinks(value, o.origin) });
      const shown = text.length > RESULT_MAX ? `${text.slice(0, RESULT_MAX)}\n[truncated]` : text;
      results.push({ callId: c.id, name: c.name, content: toolResultBlocks(shown || "(empty result)") });
    }
    messages.push({ role: "tool", results });
  }
  o.emit({ t: "error", error: "turn limit reached" });
}

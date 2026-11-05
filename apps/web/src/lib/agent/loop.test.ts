import { afterEach, describe, expect, it } from "vitest";
import { setProviderForTests } from "../../../../../packages/verify/src/llm.ts";
import type { GenerateRequest, GenerateResponse, Message, Provider } from "../../../../../packages/verify/src/providers/types.ts";
import { runAgentTurn } from "./loop";
import type { ConsoleEvent, MandateSummary } from "./protocol";
import type { AgentTool } from "./servers";

const mandate: MandateSummary = {
  id: "mdt_1",
  agentName: "agent",
  actions: ["approve"],
  approveCapMinor: null,
  currency: "USD",
  expiresAt: "2030-01-01T00:00:00.000Z",
  revokedAt: null,
  lastUsedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
};

const toolCall = (id: string): GenerateResponse => {
  const calls = [{ id, name: "get_milestone", input: { id: "ms_1" } }];
  return { type: "tool_calls", calls, assistant: { role: "assistant", text: "", toolCalls: calls }, model: "m" };
};
const answer = (reply: string): GenerateResponse => ({ type: "answer", value: { reply }, model: "m" });

/** A provider answering from a script, recording a copy of each request's history. */
function fake(script: GenerateResponse[]) {
  const seen: Message[][] = [];
  const p: Provider = {
    name: "fake",
    model: "m",
    generate: async (req: GenerateRequest) => {
      seen.push(structuredClone(req.messages));
      return script.shift()!;
    },
  };
  setProviderForTests(p);
  return seen;
}

async function run(maxTurns: number) {
  let calls = 0;
  const tool: AgentTool = { server: "milestone", name: "get_milestone", description: "d", inputSchema: { type: "object" }, call: async () => (calls++, { text: "{}", isError: false, value: {} }) };
  const events: ConsoleEvent[] = [];
  await runAgentTurn({ mandate, clientName: "c", messages: [{ role: "user", text: "status?" }], tools: [tool], origin: "http://x", emit: (e) => events.push(e), maxTurns });
  return { events, calls: () => calls };
}

describe("runAgentTurn final turn", () => {
  afterEach(() => setProviderForTests(null));

  it("tool calls on the final turn are not run; the reply on the one extra turn is accepted", async () => {
    const seen = fake([toolCall("t1"), answer("Done.")]);
    const r = await run(1);
    expect(r.calls()).toBe(0);
    expect(r.events.filter((e) => e.t === "reply")).toHaveLength(1);
    expect(r.events.some((e) => e.t === "error")).toBe(false);
    expect(r.events.find((e) => e.t === "result")).toMatchObject({ ok: false });
    // Append-only: the extra turn's history extends the final turn's with the assistant turn and one tool message.
    expect(seen).toHaveLength(2);
    expect(seen[1]!.slice(0, seen[0]!.length)).toEqual(seen[0]);
    const last = seen[1]!.at(-1)!;
    expect(last.role).toBe("tool");
    expect(last.role === "tool" && last.results.map((x) => x.callId)).toEqual(["t1"]);
  });

  it("tool calls again on the extra turn: the turn-limit error, nothing run", async () => {
    fake([toolCall("t1"), toolCall("t2")]);
    const r = await run(1);
    expect(r.calls()).toBe(0);
    expect(r.events.some((e) => e.t === "reply")).toBe(false);
    expect(r.events.filter((e) => e.t === "error")).toHaveLength(1);
  });
});

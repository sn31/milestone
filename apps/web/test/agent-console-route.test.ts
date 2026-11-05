/**
 * POST /api/agents/console end to end through the route, with the session, database, MCP servers and model faked: one
 * request must stream start -> (turn) -> done with no error event, and hand the agent loop an origin for its links.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConsoleEvent } from "../src/lib/agent/protocol";
import type { TurnInput } from "../src/lib/agent/loop";

const state = vi.hoisted(() => ({ turn: null as TurnInput | null }));

vi.mock("@/lib/session", () => ({ getActor: async () => ({ userId: "usr_client", role: "client" }) }));
vi.mock("@/lib/db", () => {
  const chain = { select: () => chain, from: () => chain, where: () => chain, limit: async () => [{ name: "Casey Client" }] };
  return { getDb: () => chain };
});
vi.mock("@milestone/core", async (orig) => ({
  ...(await orig<typeof import("@milestone/core")>()),
  authenticateAgent: async () => ({
    ok: true,
    mandate: { id: "mdt_1", userId: "usr_client", actions: ["approve"], label: "agent", createdAt: new Date(), expiresAt: new Date(Date.now() + 86_400_000), revokedAt: null },
  }),
}));
vi.mock("@/lib/agent/model", () => ({ isModelConfigured: async () => true, currentModel: () => "fake-model" }));
vi.mock("@/lib/agent/servers", () => ({
  paypalTools: () => ({ tools: [], note: null }),
  connectMilestone: async () => ({ tools: [], close: async () => {} }),
}));
vi.mock("@/lib/agent/data", () => ({ toSummary: (m: { id: string }) => ({ id: m.id }) }));
// The fake model: the loop records its input and answers in one line.
vi.mock("@/lib/agent/loop", () => ({
  runAgentTurn: async (o: TurnInput) => {
    state.turn = o;
    o.emit({ t: "reply", text: "ok" });
  },
}));

import { POST } from "../src/app/api/agents/console/route";

async function events(res: Response): Promise<ConsoleEvent[]> {
  return (await res.text()).split("\n").filter(Boolean).map((l) => JSON.parse(l) as ConsoleEvent);
}

const request = () =>
  new Request("http://localhost:3000/api/agents/console", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mandateId: "mdt_1", token: "tok", messages: [{ role: "user", text: "hi" }] }),
  });

describe("agent console route", () => {
  const saved = { APP_URL: process.env.APP_URL, MILESTONE_MCP_URL: process.env.MILESTONE_MCP_URL };
  beforeEach(() => {
    state.turn = null;
    delete process.env.MILESTONE_MCP_URL;
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  });

  it("streams a turn without an error event and passes APP_URL as the origin", async () => {
    process.env.APP_URL = "https://milestone.example";
    const res = await POST(request());
    expect(res.status).toBe(200);
    const ev = await events(res);
    expect(ev.map((e) => e.t)).toEqual(["start", "reply", "done"]);
    expect(state.turn?.origin).toBe("https://milestone.example");
  });

  it("falls back to the request origin when only MILESTONE_MCP_URL is set", async () => {
    delete process.env.APP_URL;
    process.env.MILESTONE_MCP_URL = "http://127.0.0.1:3000/api/mcp";
    const ev = await events(await POST(request()));
    expect(ev.some((e) => e.t === "error")).toBe(false);
    expect(state.turn?.origin).toBe("http://localhost:3000");
  });
});

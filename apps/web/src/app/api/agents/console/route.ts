import { authenticateAgent, users } from "@milestone/core";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { jsonError, noStore } from "@/lib/http";
import { getActor } from "@/lib/session";
import { toSummary } from "@/lib/agent/data";
import { runAgentTurn } from "@/lib/agent/loop";
import { currentModel, isModelConfigured } from "@/lib/agent/model";
import type { ConsoleEvent, ConsoleMessage } from "@/lib/agent/protocol";
import { connectMilestone, paypalTools, type AgentTool } from "@/lib/agent/servers";
import { MAX_TOOLS } from "@/lib/agent/tools";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_MESSAGES = 30;
const MAX_TEXT = 2000;

function parseMessages(v: unknown): ConsoleMessage[] | null {
  if (!Array.isArray(v) || v.length === 0 || v.length > MAX_MESSAGES) return null;
  const out: ConsoleMessage[] = [];
  for (const m of v) {
    if (!m || typeof m !== "object") return null;
    const { role, text, calls } = m as Record<string, unknown>;
    if ((role !== "user" && role !== "agent") || typeof text !== "string" || text.length > MAX_TEXT) return null;
    const c = Array.isArray(calls) ? calls.filter((x): x is string => typeof x === "string").slice(0, 12).map((x) => x.slice(0, 300)) : undefined;
    out.push({ role, text, ...(c?.length ? { calls: c } : {}) });
  }
  return out[out.length - 1]!.role === "user" && out[out.length - 1]!.text.trim() ? out : null;
}

/**
 * One turn of the agent console. The signed-in client picks one of their mandates and supplies its token (shown once,
 * never stored server side); the server runs the agent loop with the configured model, connected as an MCP client to
 * Milestone MCP (with that token: the agent acts under the mandate, through the routes a human uses) and to PayPal MCP
 * (list_transactions only). Streams ConsoleEvents as NDJSON.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const mandateId = typeof body?.mandateId === "string" ? body.mandateId : "";
  const token = typeof body?.token === "string" ? body.token.trim() : "";
  const messages = parseMessages(body?.messages);
  if (!mandateId || !token || !messages) return jsonError("mandateId, token and messages (ending with the client's message) are required", 400, { reason: "bad_request" });

  const actor = await getActor();
  const db = getDb();
  const auth = await authenticateAgent(db, token);
  if (!auth.ok) {
    const status = auth.code === "invalid_token" ? 401 : 403;
    return jsonError(auth.code === "invalid_token" ? "That token does not belong to a mandate" : auth.code === "mandate_revoked" ? "This mandate was revoked" : "This mandate has expired", status, { reason: auth.code });
  }
  if (auth.mandate.id !== mandateId || auth.mandate.userId !== actor.userId) {
    return jsonError("That token is for a different mandate", 403, { reason: "mandate_mismatch" });
  }
  if (!(await isModelConfigured())) return jsonError("No model is configured: set ANTHROPIC_API_KEY to run the agent", 503, { reason: "model_unavailable" });

  const mandate = toSummary(auth.mandate);
  const [user] = await db.select({ name: users.name }).from(users).where(eq(users.id, auth.mandate.userId)).limit(1);
  // Never derive this from the request: the Host header is caller-controlled, and the console sends the mandate token there.
  const appUrl = process.env.MILESTONE_MCP_URL ? null : process.env.APP_URL;
  if (!process.env.MILESTONE_MCP_URL && !appUrl) return jsonError("Set APP_URL or MILESTONE_MCP_URL so the console knows where its MCP server is", 503, { reason: "mcp_url_unset" });
  const mcpUrl = process.env.MILESTONE_MCP_URL ?? `${appUrl!.replace(/\/+$/, "")}/api/mcp`;
  // Base for the approval links the console shows (approvalLinks keeps only same-origin /approve/ paths on it).
  const origin = process.env.APP_URL?.trim() || new URL(req.url).origin;
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true;
      const emit = (e: ConsoleEvent) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(e)}\n`));
        } catch {
          open = false;
        }
      };
      const notes: string[] = [];
      const tools: AgentTool[] = [];
      let closeMilestone: (() => Promise<void>) | null = null;
      try {
        // PayPal's read tool needs the mandate's "read"; it takes one of the eight slots.
        const pp = auth.mandate.actions.includes("read") ? paypalTools() : { tools: [], note: "PayPal MCP: the mandate has no read action" };
        if (pp.note) notes.push(pp.note);
        try {
          const ms = await connectMilestone(mcpUrl, token, MAX_TOOLS - pp.tools.length, auth.mandate.actions);
          closeMilestone = ms.close;
          tools.push(...ms.tools);
        } catch (e) {
          notes.push(`Milestone MCP unavailable: ${(e as Error).message}`);
        }
        tools.push(...pp.tools);
        emit({ t: "start", model: `Claude · ${currentModel()}`, tools: tools.map((t) => ({ server: t.server, name: t.name })), notes });
        await runAgentTurn({ mandate, clientName: user?.name ?? actor.userId, messages, tools, origin, emit, signal: req.signal });
      } catch (e) {
        emit({ t: "error", error: (e as Error).message });
      } finally {
        emit({ t: "done" });
        await closeMilestone?.();
        if (open) controller.close();
        open = false;
      }
    },
  });
  return new Response(stream, { headers: { ...noStore, "Content-Type": "application/x-ndjson; charset=utf-8", "X-Accel-Buffering": "no" } });
}

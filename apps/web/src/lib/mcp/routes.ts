/**
 * The MCP tools act through the same route handlers a human's browser calls, in-process: nothing here re-implements a
 * route. respond_to_review forwards the agent's bearer token, so the review route authenticates the mandate and
 * enforces the guarantee itself (the one place it is enforced). The other routes take their caller from the role
 * cookie (getActor()); the MCP route binds that cookie to the mandate's user for the request (withActorCookie), and
 * every call here first checks the binding, failing closed when it does not hold.
 */
import { POST as postContract } from "@/app/api/contracts/route";
import { POST as postDeliver } from "@/app/api/milestones/[id]/deliver/route";
import { POST as postOrder } from "@/app/api/milestones/[id]/order/route";
import { POST as postReview } from "@/app/api/milestones/[id]/review/route";
import { ACTORS } from "@/lib/session";
import { actorCookieIs, type McpContext } from "./context";

export interface RouteResult {
  status: number;
  body: Record<string, unknown>;
  location: string | null;
}

/** Routes that identify the caller by the role cookie can only act for the demo identities getActor() knows. */
export function cookieIdentitySupported(userId: string): boolean {
  return ACTORS[userId]?.userId === userId;
}

async function read(res: Response): Promise<RouteResult> {
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = text ? JSON.parse(text) : {};
    body = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : { value: parsed };
  } catch {
    body = { error: text.slice(0, 500) };
  }
  return { status: res.status, body, location: res.headers.get("location") };
}

function headers(ctx: McpContext, extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${ctx.token}`, accept: "application/json", ...(ctx.clientIp && ctx.clientIp !== "unknown" ? { "x-forwarded-for": ctx.clientIp } : {}), ...extra };
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

async function cookieRoute(ctx: McpContext, call: () => Promise<Response>): Promise<RouteResult> {
  if (!cookieIdentitySupported(ctx.agent.userId) || !(await actorCookieIs(ctx.agent.userId))) {
    return { status: 403, body: { error: "this route cannot act for the mandate's user", reason: "identity_unbound" }, location: null };
  }
  return read(await call());
}

/** POST /api/milestones/[id]/review with the agent's bearer token: the guarantee is enforced by the route. */
export async function callReview(ctx: McpContext, milestoneId: string, action: "approve" | "veto" | "hold"): Promise<RouteResult> {
  const req = new Request(`${ctx.origin}/api/milestones/${encodeURIComponent(milestoneId)}/review`, {
    method: "POST",
    headers: headers(ctx, { "content-type": "application/json" }),
    body: JSON.stringify({ action }),
  });
  return read(await postReview(req, params(milestoneId)));
}

/** POST /api/milestones/[id]/order: creates (or replays) the PayPal order; never captures. */
export function callOrder(ctx: McpContext, milestoneId: string): Promise<RouteResult> {
  const req = new Request(`${ctx.origin}/api/milestones/${encodeURIComponent(milestoneId)}/order`, { method: "POST", headers: headers(ctx) });
  return cookieRoute(ctx, () => postOrder(req, params(milestoneId)));
}

/** POST /api/milestones/[id]/deliver: repo url + ref, the route's own local-repository gate and ref checks. */
export function callDeliver(ctx: McpContext, milestoneId: string, body: { repoUrl: string; ref?: string; title?: string; note?: string }): Promise<RouteResult> {
  const req = new Request(`${ctx.origin}/api/milestones/${encodeURIComponent(milestoneId)}/deliver`, {
    method: "POST",
    headers: headers(ctx, { "content-type": "application/json" }),
    body: JSON.stringify(body),
  });
  return cookieRoute(ctx, () => postDeliver(req, params(milestoneId)));
}

/** POST /api/contracts (form body, as the new-contract page sends it): compiles the scope into a draft contract. */
export function callContract(ctx: McpContext, input: { scope: string; total: string; currency: string; repo?: string; title?: string }): Promise<RouteResult> {
  const form = new FormData();
  form.set("scope", input.scope);
  form.set("total", input.total);
  form.set("currency", input.currency);
  if (input.repo) form.set("repo", input.repo);
  if (input.title) form.set("title", input.title);
  const req = new Request(`${ctx.origin}/api/contracts`, { method: "POST", headers: headers(ctx), body: form });
  return cookieRoute(ctx, () => postContract(req));
}

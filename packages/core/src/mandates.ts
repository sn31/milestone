/**
 * Agent mandates: a client delegates a bounded set of actions to an agent, which then calls the same routes a human
 * uses with "Authorization: Bearer <token>". The token is random (32 bytes), shown once at creation and stored only as
 * its sha256. A mandate never widens what the policy allows: the review route accepts an agent's approve only when the
 * policy already decided release (P6) and every required criterion passed, so an agent can make a release happen
 * sooner, never make one happen the policy would not.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { Executor } from "./db.ts";
import { agentMandates, users } from "./schema.ts";
import { MandateAction } from "./schemas.ts";

export type AgentMandate = typeof agentMandates.$inferSelect;
export type MandateUser = typeof users.$inferSelect;

/** Why a mandate does not cover an action (also the `reason` the routes return). */
export type MandateRefusal = "mandate_missing_action" | "mandate_cap_exceeded" | "mandate_expired" | "mandate_revoked";
export const MANDATE_REFUSALS = ["mandate_missing_action", "mandate_cap_exceeded", "mandate_expired", "mandate_revoked"] as const satisfies readonly MandateRefusal[];

/** Every agent token starts with this, so a leaked one is recognisable (and scannable). */
export const AGENT_TOKEN_PREFIX = "msa_";

/** sha256 hex of the whole bearer token, as stored in agent_mandates.token_hash. */
export function hashAgentToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** The token from an "Authorization: Bearer <token>" header value; null when the header is absent or not a bearer. */
export function bearerToken(header: string | null | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header.trim());
  return m ? m[1]! : null;
}

/** The audit actor for anything an agent does under a mandate: "agent:<agent_name> for <user_id>". */
export function agentActor(mandate: Pick<AgentMandate, "agentName" | "userId">): string {
  return `agent:${mandate.agentName} for ${mandate.userId}`;
}

/** Whether an audit actor string names an agent (see agentActor). */
export function isAgentActor(actor: string): boolean {
  return actor.startsWith("agent:");
}

export interface CreateMandateInput {
  userId: string;
  agentName: string;
  actions: readonly MandateAction[];
  /** Largest release the agent may approve, in minor units of `currency`. null or omitted: no approvals. */
  approveCapMinor?: number | null;
  currency: string;
  expiresAt: Date;
  /** A fixed id (the seed uses one); defaults to mdt_<uuid>. */
  id?: string;
  now?: Date;
}

/**
 * Creates a mandate and returns it with its bearer token. The token is not stored and cannot be recovered: show it
 * once. Throws on an invalid input (unknown or no actions, bad cap or currency, an expiry in the past).
 */
export async function createMandate(db: Executor, input: CreateMandateInput): Promise<{ mandate: AgentMandate; token: string }> {
  const now = input.now ?? new Date();
  const agentName = input.agentName.trim();
  if (!agentName) throw new Error("agentName is required");
  const actions = [...new Set(MandateAction.array().min(1).parse(input.actions))];
  const cap = input.approveCapMinor ?? null;
  if (cap !== null && (!Number.isSafeInteger(cap) || cap < 0)) throw new Error("approveCapMinor must be a non-negative integer (minor units) or null");
  if (!/^[A-Z]{3}$/.test(input.currency)) throw new Error("currency must be an ISO 4217 code such as USD");
  if (!(input.expiresAt instanceof Date) || Number.isNaN(input.expiresAt.getTime()) || input.expiresAt.getTime() <= now.getTime()) {
    throw new Error("expiresAt must be in the future");
  }
  const token = `${AGENT_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  const [mandate] = await db
    .insert(agentMandates)
    .values({
      id: input.id ?? `mdt_${randomUUID()}`,
      userId: input.userId,
      agentName,
      tokenHash: hashAgentToken(token),
      actions,
      approveCapMinor: cap,
      currency: input.currency,
      expiresAt: input.expiresAt,
      createdAt: now,
    })
    .returning();
  return { mandate: mandate!, token };
}

/** The outcome of presenting a bearer token: the mandate and its user, or why it is not accepted. */
export type AgentAuth =
  | { ok: true; mandate: AgentMandate; user: MandateUser }
  | { ok: false; code: "invalid_token" | "mandate_expired" | "mandate_revoked" };

/**
 * Checks a bearer token: its hash must match a mandate whose user exists, and the mandate must be unrevoked and
 * unexpired. On success last_used_at is set to `now`. Use this when the caller needs to say why a token was refused;
 * resolveAgentToken is the same check returning null on any refusal.
 */
export async function authenticateAgent(db: Executor, bearer: string | null | undefined, now = new Date()): Promise<AgentAuth> {
  if (!bearer || !bearer.startsWith(AGENT_TOKEN_PREFIX)) return { ok: false, code: "invalid_token" };
  const [row] = await db
    .select({ mandate: agentMandates, user: users })
    .from(agentMandates)
    .innerJoin(users, eq(users.id, agentMandates.userId))
    .where(eq(agentMandates.tokenHash, hashAgentToken(bearer)))
    .limit(1);
  if (!row) return { ok: false, code: "invalid_token" };
  const state = mandateState(row.mandate, now);
  if (state) return { ok: false, code: state };
  const [used] = await db.update(agentMandates).set({ lastUsedAt: now }).where(eq(agentMandates.id, row.mandate.id)).returning();
  return { ok: true, mandate: used ?? row.mandate, user: row.user };
}

/** The mandate and its user for a bearer token, or null (unknown token, expired, revoked). Updates last_used_at. */
export async function resolveAgentToken(db: Executor, bearer: string | null | undefined, now = new Date()): Promise<{ mandate: AgentMandate; user: MandateUser } | null> {
  const auth = await authenticateAgent(db, bearer, now);
  return auth.ok ? { mandate: auth.mandate, user: auth.user } : null;
}

/**
 * Revokes a mandate (idempotent: an already revoked one keeps its first revoked_at). With `userId`, only that user's
 * mandate is touched. Returns the mandate, or null when there is none (for that user).
 */
export async function revokeMandate(db: Executor, id: string, opts: { userId?: string; now?: Date } = {}): Promise<AgentMandate | null> {
  const own = opts.userId !== undefined ? eq(agentMandates.userId, opts.userId) : undefined;
  const [revoked] = await db
    .update(agentMandates)
    .set({ revokedAt: opts.now ?? new Date() })
    .where(and(eq(agentMandates.id, id), isNull(agentMandates.revokedAt), own))
    .returning();
  if (revoked) return revoked;
  const [existing] = await db.select().from(agentMandates).where(and(eq(agentMandates.id, id), own)).limit(1);
  return existing ?? null;
}

type MandateTerms = Pick<AgentMandate, "actions" | "approveCapMinor" | "currency" | "expiresAt" | "revokedAt">;

function mandateState(m: Pick<AgentMandate, "expiresAt" | "revokedAt">, now: Date): "mandate_revoked" | "mandate_expired" | null {
  if (m.revokedAt && m.revokedAt.getTime() <= now.getTime()) return "mandate_revoked";
  if (!(m.expiresAt instanceof Date) || Number.isNaN(m.expiresAt.getTime()) || m.expiresAt.getTime() <= now.getTime()) return "mandate_expired";
  return null;
}

/**
 * Whether the mandate covers `action` now. Pure. Revocation and expiry are checked first, then the action list; for
 * "approve" the amount (minor units) must be given, the mandate must have a cap, `currency` (when given) must be the
 * mandate's, and the amount must not exceed the cap. Anything missing or malformed refuses (fails closed).
 * This only says what the client delegated: the review route still applies the policy conditions on top.
 */
export function mandateAllows(
  mandate: MandateTerms,
  action: MandateAction,
  amountMinor?: number,
  opts: { currency?: string; now?: Date } = {},
): { ok: true } | { refused: MandateRefusal } {
  const state = mandateState(mandate, opts.now ?? new Date());
  if (state) return { refused: state };
  const actions: unknown = mandate.actions;
  if (!Array.isArray(actions) || !actions.includes(action)) return { refused: "mandate_missing_action" };
  if (action === "approve") {
    const cap = mandate.approveCapMinor;
    if (cap === null || cap === undefined || !Number.isSafeInteger(cap) || cap < 0) return { refused: "mandate_cap_exceeded" };
    if (amountMinor === undefined || !Number.isSafeInteger(amountMinor) || amountMinor < 0) return { refused: "mandate_cap_exceeded" };
    if (opts.currency !== undefined && opts.currency !== mandate.currency) return { refused: "mandate_cap_exceeded" };
    if (amountMinor > cap) return { refused: "mandate_cap_exceeded" };
  }
  return { ok: true };
}

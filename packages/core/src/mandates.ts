/**
 * Agent mandates: a client delegates a bounded set of actions to an agent, which then calls the same routes a human
 * uses with "Authorization: Bearer <token>". The token is random (32 bytes), shown once at creation and stored only as
 * its sha256. A mandate never widens what the policy allows: the review route accepts an agent's approve only when the
 * policy already decided release (P6) and every required criterion passed, so an agent can make a release happen
 * sooner, never make one happen the policy would not.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Executor } from "./db.ts";
import { agentMandates, contracts, milestones, paymentMethods, paypalOps, users } from "./schema.ts";
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
  /** Largest single milestone the agent may fund from the saved PayPal. null or omitted: no vault funding. */
  fundCapMinor?: number | null;
  /** Most the agent may fund from the saved PayPal over the mandate's life. null or omitted: no vault funding. */
  fundTotalCapMinor?: number | null;
  /** Let the auto-fund rule fund the next milestone. Needs "fund" and both fund caps. Default false. */
  autoFundNext?: boolean;
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
  const fundCap = input.fundCapMinor ?? null;
  const fundTotalCap = input.fundTotalCapMinor ?? null;
  if (fundCap !== null && (!Number.isSafeInteger(fundCap) || fundCap < 0)) throw new Error("fundCapMinor must be a non-negative integer (minor units) or null");
  if (fundTotalCap !== null && (!Number.isSafeInteger(fundTotalCap) || fundTotalCap < 0)) throw new Error("fundTotalCapMinor must be a non-negative integer (minor units) or null");
  const autoFundNext = input.autoFundNext ?? false;
  if (autoFundNext && (!actions.includes("fund") || fundCap === null || fundTotalCap === null)) throw new Error("autoFundNext needs the fund action and both fund caps");
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
      fundCapMinor: fundCap,
      fundTotalCapMinor: fundTotalCap,
      autoFundNext,
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

// ---------- The funding guarantee (vault charges) ----------

/**
 * Why an agent may not fund a milestone from the user's saved PayPal (also the `reason` the routes and the MCP tool
 * return). The mandate_* codes are shared with mandateAllows.
 */
export const FUNDING_REFUSALS = [
  "mandate_revoked",
  "mandate_expired",
  "mandate_missing_action",
  "payment_method_missing",
  "payment_method_not_owned",
  "payment_method_removed",
  "not_contract_client",
  "contract_not_approved",
  "milestone_not_in_contract",
  "milestone_not_draft",
  "capture_in_progress",
  "out_of_sequence",
  "previous_in_escrow",
  "amount_mismatch",
  "currency_mismatch",
  "fund_cap_missing",
  "fund_cap_exceeded",
  "fund_total_cap_exceeded",
] as const;
export type FundingRefusal = (typeof FUNDING_REFUSALS)[number];

type MilestoneRow = typeof milestones.$inferSelect;
type ContractRow = typeof contracts.$inferSelect;
export type PaymentMethod = typeof paymentMethods.$inferSelect;

/** Everything the funding guarantee looks at. fundingAllows is pure over this. */
const ESCROW_STATUSES: ReadonlySet<string> = new Set(["funded", "verifying", "review", "needs_client", "held"]);

export interface FundingFacts {
  mandate: Pick<AgentMandate, "userId" | "actions" | "currency" | "expiresAt" | "revokedAt" | "fundCapMinor" | "fundTotalCapMinor">;
  contract: Pick<ContractRow, "id" | "clientId" | "status" | "currency" | "clientApprovedAt" | "freelancerApprovedAt">;
  milestone: Pick<MilestoneRow, "id" | "contractId" | "seq" | "status" | "amountMinor" | "paypalCaptureId">;
  /** Every milestone of the contract (this one included): the sequence check reads it. */
  siblings: ReadonlyArray<Pick<MilestoneRow, "id" | "seq" | "status">>;
  /** The saved PayPal the charge would use; null when there is none. */
  paymentMethod: Pick<PaymentMethod, "userId" | "provider" | "paypalPaymentTokenId" | "removedAt"> | null;
  /** What this mandate has already funded from the vault (succeeded and in-flight vault_charge ops), minor units. */
  fundedMinor: number;
  /** The charge: exactly what would be sent to PayPal. */
  amountMinor: number;
  currency: string;
  /** A checkout capture of this milestone (the human path) exists and has not failed. */
  captureInProgress?: boolean;
}

const nonNegInt = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

/**
 * THE FUNDING GUARANTEE, pure. An agent may fund a milestone from the user's saved PayPal only when all hold:
 *  (g) the mandate is unrevoked, unexpired and lists "fund";
 *  (h) the payment method exists, is the mandate user's own PayPal, has a token and is not removed;
 *  the mandate's user is the contract's client, and (a) both parties approved the contract (active, both stamps);
 *  (b) the milestone belongs to the contract, is draft, has no capture recorded or in flight;
 *  (c) it is the contract's lowest-seq draft milestone (every earlier one is funded or beyond), and no other milestone of
 *      the contract still holds money in escrow: an agent funds one milestone at a time, after the previous one settles;
 *  (d) the charge is exactly the milestone amount (a positive integer);
 *  (e) in the contract's currency, which is the mandate's currency;
 *  (f) within the per-milestone fund cap and, added to what the mandate has funded, the total fund cap.
 * Anything missing or malformed refuses (fails closed). Checked in this order; the first failure is the reason.
 */
export function fundingAllows(f: FundingFacts, now: Date = new Date()): { ok: true } | { refused: FundingRefusal } {
  const m = f.mandate;
  const state = mandateState(m, now);
  if (state) return { refused: state };
  const actions: unknown = m.actions;
  if (!Array.isArray(actions) || !actions.includes("fund")) return { refused: "mandate_missing_action" };

  const pm = f.paymentMethod;
  if (!pm || !pm.paypalPaymentTokenId) return { refused: "payment_method_missing" };
  if (pm.userId !== m.userId || pm.provider !== "paypal") return { refused: "payment_method_not_owned" };
  if (pm.removedAt) return { refused: "payment_method_removed" };

  const c = f.contract;
  if (c.clientId !== m.userId) return { refused: "not_contract_client" };
  if (c.status !== "active" || !c.clientApprovedAt || !c.freelancerApprovedAt) return { refused: "contract_not_approved" };

  const ms = f.milestone;
  if (ms.contractId !== c.id || !f.siblings.some((s) => s.id === ms.id)) return { refused: "milestone_not_in_contract" };
  const self = f.siblings.find((s) => s.id === ms.id);
  if (ms.status !== "draft" || self?.status !== "draft") return { refused: "milestone_not_draft" };
  if (ms.paypalCaptureId || f.captureInProgress) return { refused: "capture_in_progress" };
  if (f.siblings.some((s) => s.id !== ms.id && s.status === "draft" && s.seq <= ms.seq)) return { refused: "out_of_sequence" };
  // One milestone in escrow at a time: an agent never prepays later work while earlier work is still undelivered or unsettled.
  if (f.siblings.some((s) => s.id !== ms.id && ESCROW_STATUSES.has(s.status))) return { refused: "previous_in_escrow" };

  if (!nonNegInt(f.amountMinor) || f.amountMinor === 0 || f.amountMinor !== ms.amountMinor) return { refused: "amount_mismatch" };
  if (f.currency !== c.currency || f.currency !== m.currency) return { refused: "currency_mismatch" };

  const cap = m.fundCapMinor;
  const total = m.fundTotalCapMinor;
  if (!nonNegInt(cap) || !nonNegInt(total)) return { refused: "fund_cap_missing" };
  if (f.amountMinor > cap) return { refused: "fund_cap_exceeded" };
  if (!nonNegInt(f.fundedMinor) || f.fundedMinor + f.amountMinor > total) return { refused: "fund_total_cap_exceeded" };
  return { ok: true };
}

/** paypal_ops.kind of a vault charge (key: the milestone id). The string is stored; never change it. */
export const VAULT_CHARGE_OP_KIND = "vault_charge";

/** What a vault_charge op records in paypal_ops.request; the total fund cap is summed from it. */
export interface VaultChargeRequest {
  mandateId: string;
  userId: string;
  paymentMethodId: string;
  milestoneId: string;
  contractId: string;
  amountMinor: number;
  currency: string;
  actor: string;
}

/**
 * Everything a mandate has funded from the vault: the amounts of its vault_charge ops that succeeded or are in flight
 * ("sent": the charge may have happened). Failed ones moved no money and do not count.
 */
export async function mandateFundedMinor(q: Executor, mandateId: string): Promise<number> {
  const [row] = await q
    .select({ total: sql<string>`coalesce(sum((${paypalOps.request}->>'amountMinor')::bigint), 0)::text` })
    .from(paypalOps)
    .where(and(eq(paypalOps.kind, VAULT_CHARGE_OP_KIND), sql`${paypalOps.request}->>'mandateId' = ${mandateId}`, inArray(paypalOps.status, ["sent", "succeeded"])));
  return Number(row?.total ?? 0);
}

/** The state fundingAllows needs, read fresh (inside the caller's transaction, under row locks when `lock`). */
export interface FundingState {
  mandate: AgentMandate;
  contract: ContractRow;
  milestone: MilestoneRow;
  siblings: Array<Pick<MilestoneRow, "id" | "seq" | "status">>;
  paymentMethod: PaymentMethod | null;
  fundedMinor: number;
  captureInProgress: boolean;
  /** The milestone's vault_charge op, if one exists. */
  chargeOp: typeof paypalOps.$inferSelect | null;
}

/**
 * Loads the funding state. With `lock` (inside a transaction) it takes FOR UPDATE on the mandate row first, which
 * serialises every vault charge of one mandate (so two concurrent charges cannot both fit under the total cap), then on
 * the milestone. Null when the mandate, milestone or contract is missing.
 */
export async function loadFundingState(q: Executor, ids: { mandateId: string; milestoneId: string; paymentMethodId: string | null }, opts: { lock?: boolean } = {}): Promise<FundingState | null> {
  const mq = q.select().from(agentMandates).where(eq(agentMandates.id, ids.mandateId));
  const [mandate] = opts.lock ? await mq.for("update") : await mq;
  if (!mandate) return null;
  const msq = q.select().from(milestones).where(eq(milestones.id, ids.milestoneId));
  const [milestone] = opts.lock ? await msq.for("update") : await msq;
  if (!milestone) return null;
  const [contract] = await q.select().from(contracts).where(eq(contracts.id, milestone.contractId));
  if (!contract) return null;
  const siblings = await q.select({ id: milestones.id, seq: milestones.seq, status: milestones.status }).from(milestones).where(eq(milestones.contractId, contract.id)).orderBy(asc(milestones.seq));
  const [paymentMethod] = ids.paymentMethodId ? await q.select().from(paymentMethods).where(eq(paymentMethods.id, ids.paymentMethodId)) : [];
  const ops = await q.select().from(paypalOps).where(and(eq(paypalOps.key, milestone.id), inArray(paypalOps.kind, [VAULT_CHARGE_OP_KIND, "capture"])));
  const capture = ops.find((o) => o.kind === "capture");
  return {
    mandate,
    contract,
    milestone,
    siblings,
    paymentMethod: paymentMethod ?? null,
    fundedMinor: await mandateFundedMinor(q, mandate.id),
    captureInProgress: !!capture && capture.status !== "failed",
    chargeOp: ops.find((o) => o.kind === VAULT_CHARGE_OP_KIND) ?? null,
  };
}

export type VaultChargeOp = typeof paypalOps.$inferSelect;

/**
 * Claims the milestone's vault_charge op before the PayPal call, inside the caller's transaction (so it commits with
 * the guarantee check that allowed it): inserts it as "sent" with `request`, or moves a "pending" or "failed" row to
 * "sent". A failed charge moved no money (PayPal answered with a definite refusal), so its retry gets a fresh request
 * id; a pending row keeps its id. A "sent" or "succeeded" row is returned unchanged: the caller replays or books it,
 * never charges anew.
 */
export async function claimVaultCharge(q: Executor, request: VaultChargeRequest, now: Date = new Date()): Promise<VaultChargeOp> {
  const where = and(eq(paypalOps.kind, VAULT_CHARGE_OP_KIND), eq(paypalOps.key, request.milestoneId));
  const payload = request as unknown as Record<string, unknown>;
  await q.insert(paypalOps).values({ id: randomUUID(), kind: VAULT_CHARGE_OP_KIND, key: request.milestoneId, requestId: randomUUID(), status: "sent", request: payload, updatedAt: now }).onConflictDoNothing();
  const [row] = await q.select().from(paypalOps).where(where);
  if (!row) throw new Error(`could not claim vault charge for ${request.milestoneId}`);
  if (row.status !== "pending" && row.status !== "failed") return row;
  const [claimed] = await q
    .update(paypalOps)
    .set({ status: "sent", request: payload, requestId: row.status === "failed" ? randomUUID() : row.requestId, paypalId: null, response: null, updatedAt: now })
    .where(and(eq(paypalOps.id, row.id), inArray(paypalOps.status, ["pending", "failed"])))
    .returning();
  return claimed ?? row;
}

/**
 * The live mandates of `userId` that let the auto-fund rule fund from the vault (auto_fund_next, "fund", both caps),
 * newest first. fundFromVault still checks the whole guarantee.
 */
export async function autoFundMandates(q: Executor, userId: string, now: Date = new Date()): Promise<AgentMandate[]> {
  const rows = await q
    .select()
    .from(agentMandates)
    .where(and(eq(agentMandates.userId, userId), eq(agentMandates.autoFundNext, true), isNull(agentMandates.revokedAt)))
    .orderBy(desc(agentMandates.createdAt));
  return rows.filter((m) => !mandateState(m, now) && Array.isArray(m.actions) && m.actions.includes("fund") && m.fundCapMinor !== null && m.fundTotalCapMinor !== null);
}

import { MANDATE_ACTIONS, fromPayPalValue, toPayPalValue, type AgentMandate, type MandateAction } from "@milestone/core";
import type { Role } from "@/lib/session";

/** What each role may delegate. Money still moves only through the routes and policy a human uses. */
export const DELEGABLE: Record<Role, readonly MandateAction[]> = {
  client: ["read", "draft_contract", "fund", "approve", "hold"],
  freelancer: ["read", "deliver"],
  partner: ["read"],
  platform: [],
};

export const MAX_MANDATE_DAYS = 90;

function capView(minor: number | null, currency: string) {
  return minor === null ? null : { amountMinor: minor, value: toPayPalValue(minor, currency), currency };
}

/** A mandate as its owner sees it: never the token or its hash. */
export function mandateView(m: AgentMandate, now = new Date()) {
  const state = m.revokedAt ? "revoked" : m.expiresAt.getTime() <= now.getTime() ? "expired" : "active";
  return {
    id: m.id,
    agentName: m.agentName,
    actions: m.actions,
    approveCap: m.approveCapMinor === null ? null : { amountMinor: m.approveCapMinor, value: toPayPalValue(m.approveCapMinor, m.currency), currency: m.currency },
    fundCap: capView(m.fundCapMinor, m.currency),
    fundTotalCap: capView(m.fundTotalCapMinor, m.currency),
    autoFundNext: m.autoFundNext,
    currency: m.currency,
    state,
    createdAt: m.createdAt.toISOString(),
    expiresAt: m.expiresAt.toISOString(),
    revokedAt: m.revokedAt?.toISOString() ?? null,
    lastUsedAt: m.lastUsedAt?.toISOString() ?? null,
  };
}

export type CreateBody = {
  agentName: string;
  actions: MandateAction[];
  approveCapMinor: number | null;
  /** Largest single milestone the agent may fund from the saved PayPal; null: no vault funding. */
  fundCapMinor: number | null;
  /** Most it may fund from the saved PayPal over the mandate's life; null: no vault funding. */
  fundTotalCapMinor: number | null;
  /** Fund the contract's next milestone when the previous one is released (needs "fund" and both fund caps). */
  autoFundNext: boolean;
  currency: string;
  expiresAt: Date;
};

/**
 * One cap from a body: `<name>Minor` (integer minor units) or `<name>` (a decimal string in major units). Undefined,
 * null and "" mean no cap. Returns the minor units, null, or an error message.
 */
export function parseCap(b: Record<string, unknown>, name: string, currency: string): number | null | { error: string } {
  const minor = b[`${name}Minor`];
  if (minor !== undefined && minor !== null) {
    if (typeof minor !== "number" || !Number.isSafeInteger(minor) || minor < 0) return { error: `${name}Minor must be a non-negative integer (minor units)` };
    return minor;
  }
  const major = b[name];
  if (major === undefined || major === null || major === "") return null;
  if (typeof major !== "string" || !/^\d+(\.\d{1,2})?$/.test(major.trim())) return { error: `${name} must be a decimal string such as "200.00"` };
  const v = fromPayPalValue(major.trim(), currency);
  if (!Number.isSafeInteger(v)) return { error: `${name} is out of range` };
  return v;
}

/**
 * The funding terms of a body: per-milestone fund cap, total fund cap, auto-fund-next. A cap needs "fund"; "fund"
 * with one cap needs the other; auto-fund needs "fund" and both caps; the per-milestone cap is at most the total.
 * "fund" with no caps stays allowed: the agent may then only start a checkout the client approves (no vault charge).
 */
export function parseFundTerms(b: Record<string, unknown>, actions: readonly MandateAction[], currency: string): Pick<CreateBody, "fundCapMinor" | "fundTotalCapMinor" | "autoFundNext"> | { error: string } {
  const fundCapMinor = parseCap(b, "fundCap", currency);
  if (fundCapMinor !== null && typeof fundCapMinor === "object") return fundCapMinor;
  const fundTotalCapMinor = parseCap(b, "fundTotalCap", currency);
  if (fundTotalCapMinor !== null && typeof fundTotalCapMinor === "object") return fundTotalCapMinor;
  if (b.autoFundNext !== undefined && typeof b.autoFundNext !== "boolean") return { error: "autoFundNext must be true or false" };
  const autoFundNext = b.autoFundNext === true;
  const fund = actions.includes("fund");
  if ((fundCapMinor !== null || fundTotalCapMinor !== null) && !fund) return { error: 'a fund cap needs "fund" in actions' };
  if ((fundCapMinor === null) !== (fundTotalCapMinor === null)) return { error: "set both fund caps (fundCap per milestone and fundTotalCap over the mandate), or neither" };
  if (fundCapMinor !== null && fundTotalCapMinor !== null && fundCapMinor > fundTotalCapMinor) return { error: "fundCap (per milestone) cannot be more than fundTotalCap" };
  if (autoFundNext && (!fund || fundCapMinor === null || fundTotalCapMinor === null)) return { error: 'autoFundNext needs "fund" in actions and both fund caps' };
  return { fundCapMinor, fundTotalCapMinor, autoFundNext };
}

/**
 * Validates POST /api/agents: { agentName, actions, currency?, approveCap? ("200.00", major units) | approveCapMinor?,
 * fundCap? | fundCapMinor?, fundTotalCap? | fundTotalCapMinor?, autoFundNext?, expiresInDays? (1..90, default 30) |
 * expiresAt? (ISO) }. Returns the input for createMandate or an error message.
 */
export function parseCreate(body: unknown, role: Role, now = new Date()): CreateBody | { error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "expected a JSON object" };
  const b = body as Record<string, unknown>;
  const agentName = typeof b.agentName === "string" ? b.agentName.trim() : "";
  if (!agentName || agentName.length > 80) return { error: "agentName is required (at most 80 characters)" };
  if (!Array.isArray(b.actions) || b.actions.length === 0) return { error: `actions must be a non-empty array of ${MANDATE_ACTIONS.join(", ")}` };
  const actions: MandateAction[] = [];
  for (const a of b.actions) {
    const known = MANDATE_ACTIONS.find((x) => x === a);
    if (!known) return { error: `unknown action ${String(a)}; one of ${MANDATE_ACTIONS.join(", ")}` };
    if (!DELEGABLE[role].includes(known)) return { error: `a ${role} cannot delegate "${known}" (allowed: ${DELEGABLE[role].join(", ") || "nothing"})` };
    if (!actions.includes(known)) actions.push(known);
  }
  const currency = typeof b.currency === "string" && b.currency.trim() ? b.currency.trim().toUpperCase() : "USD";
  if (!/^[A-Z]{3}$/.test(currency)) return { error: "currency must be a three-letter ISO 4217 code" };

  let approveCapMinor: number | null = null;
  if (b.approveCapMinor !== undefined && b.approveCapMinor !== null) {
    if (typeof b.approveCapMinor !== "number" || !Number.isSafeInteger(b.approveCapMinor) || b.approveCapMinor < 0) return { error: "approveCapMinor must be a non-negative integer (minor units)" };
    approveCapMinor = b.approveCapMinor;
  } else if (b.approveCap !== undefined && b.approveCap !== null && b.approveCap !== "") {
    if (typeof b.approveCap !== "string" || !/^\d+(\.\d{1,2})?$/.test(b.approveCap.trim())) return { error: 'approveCap must be a decimal string such as "200.00"' };
    approveCapMinor = fromPayPalValue(b.approveCap.trim(), currency);
    if (!Number.isSafeInteger(approveCapMinor)) return { error: "approveCap is out of range" };
  }
  if (approveCapMinor !== null && !actions.includes("approve")) return { error: 'an approval cap needs "approve" in actions' };
  if (actions.includes("approve") && approveCapMinor === null) return { error: '"approve" needs an approval cap (approveCap or approveCapMinor)' };
  const fund = parseFundTerms(b, actions, currency);
  if ("error" in fund) return fund;

  let expiresAt: Date;
  if (typeof b.expiresAt === "string") {
    expiresAt = new Date(b.expiresAt);
    if (Number.isNaN(expiresAt.getTime())) return { error: "expiresAt must be an ISO date" };
  } else {
    const days = b.expiresInDays === undefined ? 30 : b.expiresInDays;
    if (typeof days !== "number" || !Number.isFinite(days) || days <= 0) return { error: `expiresInDays must be a number between 1 and ${MAX_MANDATE_DAYS}` };
    expiresAt = new Date(now.getTime() + days * 86_400_000);
  }
  if (expiresAt.getTime() <= now.getTime()) return { error: "expiresAt must be in the future" };
  if (expiresAt.getTime() > now.getTime() + MAX_MANDATE_DAYS * 86_400_000) return { error: `a mandate lasts at most ${MAX_MANDATE_DAYS} days` };
  return { agentName, actions, approveCapMinor, ...fund, currency, expiresAt };
}

/** Agents never manage mandates: a request carrying an Authorization header is refused before anything else. */
export const AGENT_REFUSAL = "mandates are managed by the signed-in user, not by an agent" as const;

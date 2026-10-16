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

/** A mandate as its owner sees it: never the token or its hash. */
export function mandateView(m: AgentMandate, now = new Date()) {
  const state = m.revokedAt ? "revoked" : m.expiresAt.getTime() <= now.getTime() ? "expired" : "active";
  return {
    id: m.id,
    agentName: m.agentName,
    actions: m.actions,
    approveCap: m.approveCapMinor === null ? null : { amountMinor: m.approveCapMinor, value: toPayPalValue(m.approveCapMinor, m.currency), currency: m.currency },
    currency: m.currency,
    state,
    createdAt: m.createdAt.toISOString(),
    expiresAt: m.expiresAt.toISOString(),
    revokedAt: m.revokedAt?.toISOString() ?? null,
    lastUsedAt: m.lastUsedAt?.toISOString() ?? null,
  };
}

export type CreateBody = { agentName: string; actions: MandateAction[]; approveCapMinor: number | null; currency: string; expiresAt: Date };

/**
 * Validates POST /api/agents: { agentName, actions, currency?, approveCap? ("200.00", major units) | approveCapMinor?,
 * expiresInDays? (1..90, default 30) | expiresAt? (ISO) }. Returns the input for createMandate or an error message.
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
  return { agentName, actions, approveCapMinor, currency, expiresAt };
}

/** Agents never manage mandates: a request carrying an Authorization header is refused before anything else. */
export const AGENT_REFUSAL = "mandates are managed by the signed-in user, not by an agent" as const;

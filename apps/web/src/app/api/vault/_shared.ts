import { PayPalError } from "@milestone/money";
import type { PaymentMethod } from "@milestone/core";
import { jsonError } from "@/lib/http";
import type { Actor } from "@/lib/session";

/** Only the signed-in human saves or removes a PayPal: a request carrying any Authorization header (an agent) is refused. */
export const VAULT_AGENT_REFUSAL = "a saved PayPal is managed by the signed-in user, not by an agent" as const;

/** Who may save a PayPal for agent payments: a client (the role that funds milestones). */
export function vaultRefusal(req: Request, actor: Actor): Response | null {
  if (req.headers.get("authorization") !== null) return jsonError(VAULT_AGENT_REFUSAL, 403, { reason: "agents_cannot_manage_payment_methods" });
  if (actor.role !== "client") return jsonError("only a client saves a PayPal for agent payments", 403, { reason: "not_client" });
  return null;
}

/** The app's public base URL (APP_URL, else the request's origin), without a trailing slash. */
export function appBase(req: Request): string {
  return (process.env.APP_URL || new URL(req.url).origin).replace(/\/+$/, "");
}

/** A saved PayPal as its owner sees it: never the vault token itself, only its tail. */
export function paymentMethodView(pm: PaymentMethod) {
  return {
    id: pm.id,
    provider: pm.provider,
    payerEmail: pm.payerEmail,
    tokenTail: pm.paypalPaymentTokenId.slice(-4),
    createdAt: pm.createdAt.toISOString(),
    removedAt: pm.removedAt?.toISOString() ?? null,
  };
}

export function vaultPaypalError(e: unknown): Response {
  if (e instanceof PayPalError) return jsonError(e.message, 502, { reason: "paypal_error", debugId: e.debugId ?? null });
  return jsonError(e instanceof Error ? e.message : "PayPal call failed", 502, { reason: "paypal_error" });
}

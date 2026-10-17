import { findVaultSetup, setVaultSetupStatus } from "@milestone/core";
import { completeVaultSetup } from "@milestone/money";
import { getDb } from "@/lib/db";
import { noStore } from "@/lib/http";
import { paypal } from "@/lib/paypal";
import { getActor } from "@/lib/session";
import { appBase } from "../_shared";

export const dynamic = "force-dynamic";

/** Back to /agents with ?vault=<outcome> (and a reason), where the Saved PayPal card reads it. */
function back(req: Request, outcome: "saved" | "cancelled" | "error", reason?: string): Response {
  const to = new URL(`${appBase(req)}/agents`);
  to.searchParams.set("vault", outcome);
  if (reason) to.searchParams.set("reason", reason);
  to.hash = "saved-paypal";
  return new Response(null, { status: 303, headers: { ...noStore, Location: to.toString() } });
}

/**
 * Where PayPal sends the payer after the setup token's approval: ?approval_token_id=<setup token id>. The setup must
 * belong to the signed-in user (a user can never vault someone else's approval); it is exchanged for a payment token
 * (POST /v3/vault/payment-tokens, idempotent on a reload) and saved. ?cancelled=1 is the cancel URL.
 * An agent (Authorization header) never reaches this: it is refused.
 */
export async function GET(req: Request) {
  if (req.headers.get("authorization") !== null) return back(req, "error", "agents_cannot_manage_payment_methods");
  const actor = await getActor();
  if (actor.role !== "client") return back(req, "error", "not_client");
  const url = new URL(req.url);
  const token = url.searchParams.get("approval_token_id") ?? url.searchParams.get("token") ?? "";
  const db = getDb();
  if (url.searchParams.get("cancelled")) {
    if (token && (await findVaultSetup(db, token, actor.userId))) await setVaultSetupStatus(db, token, "cancelled");
    return back(req, "cancelled");
  }
  if (!token) return back(req, "error", "missing_approval_token");
  const r = await completeVaultSetup(db, paypal(), { userId: actor.userId, setupTokenId: token });
  if (!r.ok) {
    if (r.reason === "paypal_error" && (await findVaultSetup(db, token, actor.userId))) await setVaultSetupStatus(db, token, "failed");
    return back(req, "error", r.reason);
  }
  return back(req, "saved");
}

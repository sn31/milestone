import { activePaymentMethod } from "@milestone/core";
import { startVaultSetup } from "@milestone/money";
import { getDb } from "@/lib/db";
import { json, jsonError } from "@/lib/http";
import { paypal } from "@/lib/paypal";
import { getActor } from "@/lib/session";
import { appBase, vaultPaypalError, vaultRefusal } from "../_shared";

export const dynamic = "force-dynamic";

/**
 * Starts saving the signed-in client's PayPal (POST /v3/vault/setup-tokens through @milestone/money): returns
 * { setupTokenId, approveUrl }. The browser goes to approveUrl (PayPal's approval, or the simulator's
 * /api/dev/paypal/vault-approve); PayPal sends the payer back to /api/vault/return. Nothing is charged.
 * One saved PayPal at a time: remove the current one first.
 */
export async function POST(req: Request) {
  const actor = await getActor();
  const refused = vaultRefusal(req, actor);
  if (refused) return refused;
  const db = getDb();
  if (await activePaymentMethod(db, actor.userId)) return jsonError("a PayPal is already saved; remove it before saving another", 409, { reason: "already_saved" });
  const base = appBase(req);
  try {
    const r = await startVaultSetup(db, paypal(), {
      userId: actor.userId,
      returnUrl: `${base}/api/vault/return`,
      cancelUrl: `${base}/api/vault/return?cancelled=1`,
    });
    return json({ setupTokenId: r.setupTokenId, approveUrl: r.approveUrl });
  } catch (e) {
    return vaultPaypalError(e);
  }
}

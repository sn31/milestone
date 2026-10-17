import { activePaymentMethod, findPaymentMethod } from "@milestone/core";
import { removeVaultPaymentMethod } from "@milestone/money";
import { getDb } from "@/lib/db";
import { json, jsonError } from "@/lib/http";
import { paypal } from "@/lib/paypal";
import { getActor } from "@/lib/session";
import { paymentMethodView, vaultPaypalError, vaultRefusal } from "./_shared";

export const dynamic = "force-dynamic";

/** The signed-in client's saved PayPal ({ paymentMethod: null } when there is none). */
export async function GET(req: Request) {
  const actor = await getActor();
  const refused = vaultRefusal(req, actor);
  if (refused) return refused;
  const pm = await activePaymentMethod(getDb(), actor.userId);
  return json({ paymentMethod: pm ? paymentMethodView(pm) : null });
}

/**
 * Removes the signed-in client's saved PayPal: { paymentMethodId } in the body or ?id=, else the current one. It is
 * marked removed first (no agent can charge it from then on), then deleted at PayPal. Idempotent.
 */
export async function DELETE(req: Request) {
  const actor = await getActor();
  const refused = vaultRefusal(req, actor);
  if (refused) return refused;
  const db = getDb();
  const body = (await req.json().catch(() => null)) as { paymentMethodId?: unknown } | null;
  const asked = typeof body?.paymentMethodId === "string" ? body.paymentMethodId : new URL(req.url).searchParams.get("id");
  const pm = asked ? await findPaymentMethod(db, asked, actor.userId) : await activePaymentMethod(db, actor.userId);
  if (!pm) return jsonError("no saved PayPal to remove", 404);
  try {
    const removed = await removeVaultPaymentMethod(db, paypal(), { userId: actor.userId, paymentMethodId: pm.id });
    if (!removed) return jsonError("no saved PayPal to remove", 404);
    return json({ ok: true, paymentMethod: paymentMethodView(removed) });
  } catch (e) {
    // Removed here already (no agent can charge it); only PayPal's copy is left. A retry deletes it.
    const res = vaultPaypalError(e);
    const detail = (await res.json()) as Record<string, unknown>;
    return json({ ...detail, removedHere: true }, 502);
  }
}

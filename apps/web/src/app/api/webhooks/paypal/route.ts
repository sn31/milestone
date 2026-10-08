import { verifyWebhookSignature, captureFunding, type WebhookEvent } from "@milestone/money";
import { storeWebhookOnce, requestIdFor, enqueue, PAYPAL_EVENTS } from "@milestone/core";
import { paypal } from "@/lib/paypal";
import { getDb } from "@/lib/db";

/**
 * Every PayPal event: verify the signature, store once, then act.
 * Always 200 after storing, so PayPal stops retrying; a failed job is retried by the worker.
 */
export async function POST(req: Request) {
  const raw = await req.text();
  const webhookId = process.env.PAYPAL_WEBHOOK_ID;
  if (!webhookId) return new Response("PAYPAL_WEBHOOK_ID not set", { status: 500 });
  const ok = await verifyWebhookSignature(paypal(), req.headers, raw, webhookId);
  if (!ok) return new Response("bad signature", { status: 400 });

  const event = JSON.parse(raw) as WebhookEvent;
  const db = getDb();
  const fresh = await storeWebhookOnce(db, { source: "paypal", eventId: event.id, type: event.event_type, payload: event });
  if (!fresh) return Response.json({ duplicate: true });

  const resource = event.resource ?? {};
  switch (event.event_type) {
    case PAYPAL_EVENTS.orderApproved: {
      // Backup for the SDK's onApprove route; reference_id is our milestone id. Capture is idempotent by milestone.
      const unit = (resource.purchase_units as Array<{ reference_id?: string }> | undefined)?.[0];
      if (unit?.reference_id && typeof resource.id === "string") {
        await captureFunding({ client: paypal(), requestIdFor: (kind, key) => requestIdFor(db, kind, key) }, unit.reference_id, resource.id);
        // Oct 13: post the ledger entry to held:{milestone} and move the milestone to funded.
      }
      break;
    }
    case PAYPAL_EVENTS.payoutItemSucceeded:
    case PAYPAL_EVENTS.payoutItemFailed:
    case PAYPAL_EVENTS.payoutItemBlocked: {
      // sender_item_id is "<milestoneId>:<party>" (see executeRelease).
      const item = (resource.payout_item as { sender_item_id?: string } | undefined) ?? (resource as { sender_item_id?: string });
      const milestoneId = item.sender_item_id?.split(":")[0];
      if (milestoneId) await enqueue("settle", milestoneId, { eventId: event.id, eventType: event.event_type }, { dedupe: event.id });
      break;
    }
    default:
      // CUSTOMER.DISPUTE.* and INVOICING.* are stored for the audit log; the dispute copilot is a week-3 stretch.
      break;
  }
  return Response.json({ ok: true });
}

import { and, eq, isNull } from "drizzle-orm";
import { verifyWebhookSignature, type WebhookEvent } from "@milestone/money";
import { audit, enqueue, storeWebhookOnce, webhookEvents, PAYPAL_EVENTS, type Db } from "@milestone/core";
import { paypal } from "@/lib/paypal";
import { getDb } from "@/lib/db";
import { captureAndFund, fundFromCapture, isCaptureInfo, milestoneForCapture, type FundResult } from "../../milestones/_shared";

/**
 * Every PayPal event: verify the signature, store once, then route.
 * processed_at is set only when the work for the event is done: here for events handled inline, by the settle job
 * for events it handles. A redelivery of a stored but unprocessed event runs the routing again, so every branch is
 * idempotent; an error returns 500 so PayPal redelivers.
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
  if (!fresh) {
    const [row] = await db
      .select({ processedAt: webhookEvents.processedAt })
      .from(webhookEvents)
      .where(and(eq(webhookEvents.source, "paypal"), eq(webhookEvents.eventId, event.id)))
      .limit(1);
    if (row?.processedAt) return Response.json({ duplicate: true });
  }

  try {
    const outcome = await route(db, event);
    return Response.json({ ok: true, duplicate: !fresh, outcome });
  } catch (e) {
    console.error(`[webhook] paypal ${event.event_type} ${event.id} failed:`, e instanceof Error ? e.message : e);
    return new Response("event not processed yet", { status: 500 });
  }
}

async function markProcessed(db: Db, eventId: string): Promise<void> {
  await db
    .update(webhookEvents)
    .set({ processedAt: new Date() })
    .where(and(eq(webhookEvents.source, "paypal"), eq(webhookEvents.eventId, eventId), isNull(webhookEvents.processedAt)));
}

/** Throws for outcomes PayPal should redeliver; anything final (funded, already, mismatch, rejected) is processed. */
function settled(r: FundResult): string {
  if (r.kind === "paypal_error") throw r.error instanceof Error ? r.error : new Error(String(r.error));
  return r.kind;
}

/** The routing switch. Every branch is idempotent: it may run again for a redelivered, unprocessed event. */
async function route(db: Db, event: WebhookEvent): Promise<string> {
  const resource = (event.resource ?? {}) as Record<string, unknown>;
  switch (event.event_type) {
    case PAYPAL_EVENTS.orderApproved: {
      // Backup for the SDK's onApprove route; reference_id is our milestone id. captureAndFund is idempotent by milestone.
      const unit = (resource.purchase_units as Array<{ reference_id?: string }> | undefined)?.[0];
      let outcome = "ignored";
      if (unit?.reference_id && typeof resource.id === "string") {
        outcome = settled(await captureAndFund(db, unit.reference_id, resource.id, "paypal"));
      }
      await markProcessed(db, event.id);
      return outcome;
    }
    case PAYPAL_EVENTS.captureCompleted: {
      // Finishes a capture that came back PENDING: fund the milestone if it is still draft.
      const milestoneId = await milestoneForCapture(db, resource);
      let outcome = "ignored";
      if (milestoneId && isCaptureInfo(resource)) {
        const orderId = (resource.supplementary_data as { related_ids?: { order_id?: unknown } } | undefined)?.related_ids?.order_id;
        outcome = settled(await fundFromCapture(db, milestoneId, resource, "paypal", typeof orderId === "string" ? orderId : null));
      } else {
        await audit(db, { actor: "paypal", event: "paypal.capture_unmatched", detail: { eventId: event.id, captureId: typeof resource.id === "string" ? resource.id : null } });
      }
      await markProcessed(db, event.id);
      return outcome;
    }
    case PAYPAL_EVENTS.captureRefunded: {
      // The settle job handles refunds and marks the event processed. A refund resource links "up" to its capture.
      const up = (resource.links as Array<{ rel?: string; href?: string }> | undefined)?.find((l) => l.rel === "up")?.href;
      const captureId = up?.match(/\/captures\/([^/?#]+)/)?.[1];
      const milestoneId = captureId ? await milestoneForCapture(db, { id: captureId }) : await milestoneForCapture(db, resource);
      if (!milestoneId) {
        await audit(db, { actor: "paypal", event: "paypal.refund_unmatched", detail: { eventId: event.id, refundId: typeof resource.id === "string" ? resource.id : null, captureId: captureId ?? null } });
        await markProcessed(db, event.id);
        return "ignored";
      }
      await enqueue("settle", milestoneId, { eventId: event.id, eventType: event.event_type }, { dedupe: event.id });
      return "enqueued";
    }
    case PAYPAL_EVENTS.payoutItemSucceeded:
    case PAYPAL_EVENTS.payoutItemFailed:
    case PAYPAL_EVENTS.payoutItemBlocked:
    case PAYPAL_EVENTS.payoutItemUnclaimed:
    case PAYPAL_EVENTS.payoutItemReturned:
    case PAYPAL_EVENTS.payoutItemReversed:
    case PAYPAL_EVENTS.payoutItemRefunded: {
      // sender_item_id is "<milestoneId>:<party>" (see executeRelease); the settle job marks the event processed.
      const item = (resource.payout_item as { sender_item_id?: string } | undefined) ?? (resource as { sender_item_id?: string });
      const milestoneId = item.sender_item_id?.split(":")[0];
      if (!milestoneId) {
        await markProcessed(db, event.id);
        return "ignored";
      }
      await enqueue("settle", milestoneId, { eventId: event.id, eventType: event.event_type }, { dedupe: event.id });
      return "enqueued";
    }
    default:
      // CUSTOMER.DISPUTE.* and INVOICING.* are stored for the audit log; the dispute copilot is a week-3 stretch.
      await markProcessed(db, event.id);
      return "stored";
  }
}

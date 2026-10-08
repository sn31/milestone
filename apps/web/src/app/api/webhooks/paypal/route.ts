import { and, eq } from "drizzle-orm";
import { isSimulatedWebhook, recordDisputeEvent, verifyWebhookSignature, type WebhookEvent } from "@milestone/money";
import { AUDIT_EVENTS, OP_KINDS, PAYPAL_EVENTS, asRecord, asString, audit, enqueue, markWebhookProcessed, paypalMode, storeWebhookOnce, webhookEvents, type Db } from "@milestone/core";
import { paypal } from "@/lib/paypal";
import { getDb } from "@/lib/db";
import { captureAndFund, captureOrderId, fundFromCapture, isCaptureInfo, milestoneForCapture, type FundResult } from "../../milestones/_shared";

/**
 * Every PayPal event: verify the signature, store once, then route.
 * processed_at is set only when the work for the event is done: here for events handled inline, by the settle job
 * for events it handles. A redelivery of a stored but unprocessed event runs the routing again, so every branch is
 * idempotent; an error returns 500 so PayPal redelivers.
 */
export async function POST(req: Request) {
  const raw = await req.text();
  if (paypalMode() === "simulated") {
    // Simulated PayPal signs nothing; its events carry X-Milestone-Simulated with the shared secret instead. Only
    // that header is accepted here (the simulator's verify-webhook-signature would say SUCCESS to anything).
    if (!isSimulatedWebhook(req.headers)) return new Response("bad signature", { status: 400 });
  } else {
    const webhookId = process.env.PAYPAL_WEBHOOK_ID;
    if (!webhookId) return new Response("PAYPAL_WEBHOOK_ID not set", { status: 500 });
    // A probe without PayPal's transmission headers makes the verify call itself fail; that is a bad signature, not a server error.
    const ok = await verifyWebhookSignature(paypal(), req.headers, raw, webhookId).catch(() => false);
    if (!ok) return new Response("bad signature", { status: 400 });
  }

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

const markProcessed = (db: Db, eventId: string) => markWebhookProcessed(db, { source: "paypal", eventId });

/** Throws for outcomes PayPal should redeliver; anything final (funded, already, mismatch, rejected) is processed. */
function settled(r: FundResult): string {
  if (r.kind === "paypal_error") throw r.error instanceof Error ? r.error : new Error(String(r.error));
  return r.kind;
}

/** The routing switch. Every branch is idempotent: it may run again for a redelivered, unprocessed event. */
async function route(db: Db, event: WebhookEvent): Promise<string> {
  const resource = asRecord(event.resource);
  switch (event.event_type) {
    case PAYPAL_EVENTS.orderApproved: {
      // Backup for the SDK's onApprove route; reference_id is our milestone id. captureAndFund is idempotent by milestone.
      const units = resource.purchase_units;
      const milestoneId = asString(Array.isArray(units) ? asRecord(units[0]).reference_id : undefined);
      let outcome = "ignored";
      if (milestoneId && typeof resource.id === "string") {
        outcome = settled(await captureAndFund(db, milestoneId, resource.id, "paypal"));
      }
      await markProcessed(db, event.id);
      return outcome;
    }
    case PAYPAL_EVENTS.captureCompleted: {
      // Finishes a capture that came back PENDING: fund the milestone if it is still draft.
      const milestoneId = await milestoneForCapture(db, resource);
      let outcome = "ignored";
      if (milestoneId && isCaptureInfo(resource)) {
        outcome = settled(await fundFromCapture(db, milestoneId, resource, "paypal", captureOrderId(resource)));
      } else {
        await audit(db, { actor: "paypal", event: AUDIT_EVENTS.paypalCaptureUnmatched, detail: { eventId: event.id, captureId: typeof resource.id === "string" ? resource.id : null } });
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
        await audit(db, { actor: "paypal", event: AUDIT_EVENTS.paypalRefundUnmatched, detail: { eventId: event.id, refundId: typeof resource.id === "string" ? resource.id : null, captureId: captureId ?? null } });
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
    case PAYPAL_EVENTS.payoutItemRefunded:
    case PAYPAL_EVENTS.payoutItemDenied:
    case PAYPAL_EVENTS.payoutItemCanceled:
    case PAYPAL_EVENTS.payoutItemHeld: {
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
    case PAYPAL_EVENTS.payoutsBatchDenied: {
      // The whole batch was denied. Our payout op is found by PayPal's batch id or by sender_batch_id (= the op's
      // PayPal-Request-Id, see executeRelease); the settle job marks it failed, flags an operator and marks the event processed.
      const header = (resource.batch_header ?? {}) as { payout_batch_id?: unknown; sender_batch_header?: { sender_batch_id?: unknown } };
      const batchId = typeof header.payout_batch_id === "string" && header.payout_batch_id ? header.payout_batch_id : null;
      const senderBatchId = typeof header.sender_batch_header?.sender_batch_id === "string" && header.sender_batch_header.sender_batch_id ? header.sender_batch_header.sender_batch_id : null;
      const op =
        batchId || senderBatchId
          ? await db.query.paypalOps.findFirst({
              where: (o, { and, eq, or }) => and(eq(o.kind, OP_KINDS.payout), or(...(batchId ? [eq(o.paypalId, batchId)] : []), ...(senderBatchId ? [eq(o.requestId, senderBatchId)] : []))),
            })
          : undefined;
      if (!op) {
        await audit(db, { actor: "paypal", event: AUDIT_EVENTS.paypalPayoutBatchUnmatched, detail: { eventId: event.id, payoutBatchId: batchId, senderBatchId } });
        await markProcessed(db, event.id);
        return "ignored";
      }
      await enqueue("settle", op.key, { eventId: event.id, eventType: event.event_type }, { dedupe: event.id });
      return "enqueued";
    }
    case PAYPAL_EVENTS.disputeCreated:
    case PAYPAL_EVENTS.disputeUpdated:
    case PAYPAL_EVENTS.disputeResolved: {
      // The dispute copilot: the milestone is found by the disputed transaction id (= paypal_capture_id); CREATED
      // audits dispute.opened and enqueues the "dispute" job that drafts the response, RESOLVED audits the outcome.
      // recordDisputeEvent is idempotent, and the job's dedupe key makes a repeated enqueue a no-op.
      const r = await recordDisputeEvent(db, event);
      if (r.enqueue) await enqueue("dispute", r.milestoneId, { disputeId: r.disputeId }, { dedupe: `dispute:${r.disputeId}` });
      await markProcessed(db, event.id);
      return r.outcome;
    }
    default:
      // INVOICING.* and anything unrouted are stored for the audit log.
      await markProcessed(db, event.id);
      return "stored";
  }
}

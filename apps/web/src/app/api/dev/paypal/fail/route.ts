import { armedSimulatedFailures, failNextSimulatedPayout } from "@milestone/money";
import { json, jsonError } from "@/lib/http";
import { formBody, notSimulated } from "../_guard";

export const dynamic = "force-dynamic";

/**
 * Operator demo: makes the NEXT simulated payout item with this sender_item_id come back FAILED (once), so the
 * release goes to held with milestone.needs_operator. Body: { "sender_item_id": "<milestoneId>:freelancer" } or
 * { "milestoneId": "...", "party": "freelancer" | "partner" }, optional "reason" (a PayPal error name such as
 * RECEIVER_UNREGISTERED; default RECEIVER_ACCOUNT_LOCKED).
 */
export async function POST(req: Request) {
  const blocked = notSimulated();
  if (blocked) return blocked;
  // JSON from scripts, or a plain form post from the /ops "Simulate payout failure" button.
  const body = await formBody(req);
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const party = str(body?.party) ?? "freelancer";
  const senderItemId =
    str(body?.sender_item_id) ?? str(body?.senderItemId) ?? (str(body?.milestoneId) ? `${str(body?.milestoneId)}:${party}` : undefined);
  if (!senderItemId) return jsonError("sender_item_id (or milestoneId) is required", 400);
  if (senderItemId.length > 127) return jsonError("sender_item_id is too long", 400);
  const reason = str(body?.reason);
  const armed = reason ? failNextSimulatedPayout(senderItemId, reason) : failNextSimulatedPayout(senderItemId);
  return json({ armed });
}

/** The armed failures, for the operator panel. */
export async function GET() {
  const blocked = notSimulated();
  if (blocked) return blocked;
  return json({ armed: armedSimulatedFailures() });
}

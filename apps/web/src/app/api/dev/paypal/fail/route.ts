import { armedSimulatedFailures, failNextSimulatedPayout } from "@milestone/money";
import { notSimulated } from "../_guard";

export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store" };

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
  const form = /^(application\/x-www-form-urlencoded|multipart\/form-data)/i.test(req.headers.get("content-type") ?? "");
  const body = (form
    ? await req.formData().then((f) => Object.fromEntries(f.entries())).catch(() => null)
    : await req.json().catch(() => null)) as Record<string, unknown> | null;
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const party = str(body?.party) ?? "freelancer";
  const senderItemId =
    str(body?.sender_item_id) ?? str(body?.senderItemId) ?? (str(body?.milestoneId) ? `${str(body?.milestoneId)}:${party}` : undefined);
  if (!senderItemId) return Response.json({ error: "sender_item_id (or milestoneId) is required" }, { status: 400, headers: noStore });
  if (senderItemId.length > 127) return Response.json({ error: "sender_item_id is too long" }, { status: 400, headers: noStore });
  const reason = str(body?.reason);
  const armed = reason ? failNextSimulatedPayout(senderItemId, reason) : failNextSimulatedPayout(senderItemId);
  return Response.json({ armed }, { headers: noStore });
}

/** The armed failures, for the operator panel. */
export async function GET() {
  const blocked = notSimulated();
  if (blocked) return blocked;
  return Response.json({ armed: armedSimulatedFailures() }, { headers: noStore });
}

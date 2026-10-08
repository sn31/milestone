import { EVIDENCE_NOTES_MAX, submitDisputeEvidence } from "@milestone/money";
import { getDb } from "@/lib/db";
import { json, jsonError } from "@/lib/http";
import { paypal } from "@/lib/paypal";
import { getActor } from "@/lib/session";
import { readAttachments } from "@/app/disputes/_lib";
import { disputeForFreelancer } from "../../_shared";

export const dynamic = "force-dynamic";

/**
 * The freelancer sends the response: POST provide-evidence with the final text as notes and the delivered files as
 * documents when PayPal takes them (PDF, PNG, JPEG, GIF; 10 MB). Body: { "text": "..." }. The PayPal-Request-Id comes
 * from a paypal_ops row keyed by the dispute, so a double submit is answered once.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const actor = await getActor();
  const db = getDb();
  const found = await disputeForFreelancer(db, actor, id);
  if ("error" in found) return found.error;

  const body = (await req.json().catch(() => null)) as { text?: unknown } | null;
  const text = typeof body?.text === "string" ? body.text.trim() : "";
  if (!text) return jsonError("the response is empty", 400);
  if (text.length > EVIDENCE_NOTES_MAX) return jsonError(`PayPal takes at most ${EVIDENCE_NOTES_MAX} characters; this is ${text.length}`, 400);

  const { files, skipped } = await readAttachments(found.dispute.drafted?.pack);
  const r = await submitDisputeEvidence(db, paypal(), { disputeId: id, actor: actor.userId, text, files, skipped });
  if (!r.ok) return jsonError(r.error ?? "PayPal refused the evidence", r.status ?? 502);
  return json({ ok: true, requestId: r.requestId, attached: files.map((f) => f.name), skipped });
}

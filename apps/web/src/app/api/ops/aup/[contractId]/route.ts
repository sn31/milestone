import { resolveAupReview } from "@milestone/core";
import { getDb } from "@/lib/db";
import { json, jsonError } from "@/lib/http";
import { getActor, isOperator } from "@/lib/session";

/**
 * POST /api/ops/aup/[contractId] { action: "clear" | "reject", note }: an operator's decision on a contract the PayPal
 * Acceptable Use Policy check put in review. clear lets it be signed and funded as usual (aup.cleared); reject is final
 * (aup.rejected). Only from review, under the contract row lock. Moves no money.
 */
export async function POST(req: Request, ctx: { params: Promise<{ contractId: string }> }) {
  const { contractId } = await ctx.params;
  const actor = await getActor();
  if (!isOperator(actor)) return jsonError("only the partner or platform can clear or reject a flagged contract", 403);
  const body = (await req.json().catch(() => null)) as { action?: unknown; note?: unknown } | null;
  const action = body?.action;
  const note = typeof body?.note === "string" ? body.note.trim().slice(0, 1000) : "";
  if (action !== "clear" && action !== "reject") return jsonError('expected JSON body { action: "clear" | "reject", note }', 400);
  if (!note) return jsonError("note is required: say what you checked", 400);

  const r = await resolveAupReview(getDb(), contractId, action, actor, note);
  if (r === "missing") return jsonError("contract not found", 404);
  if (r === "not_in_review") return jsonError("contract is not waiting for an AUP review", 409);
  return json({ ok: true, status: action === "clear" ? "cleared" : "rejected" });
}

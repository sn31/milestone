import { loadMilestone } from "@milestone/core";
import { loadUnderwriting } from "@milestone/money";
import { getDb } from "@/lib/db";
import { json, jsonError } from "@/lib/http";
import { getActor } from "@/lib/session";
import { advanceView, explainOffer } from "../_shared";

export const dynamic = "force-dynamic";

/**
 * GET /api/advances/offer?milestoneId=... (the contract's freelancer only).
 * With an advance already on the milestone, returns it (one advance per milestone) without pricing anything.
 * Otherwise prices a fresh offer; an ineligible milestone comes back 200 with offer.eligible = false and the reason.
 */
export async function GET(req: Request) {
  const actor = await getActor();
  if (actor.role !== "freelancer") return jsonError("only the freelancer can see advance offers", 403);
  const milestoneId = new URL(req.url).searchParams.get("milestoneId");
  if (!milestoneId) return jsonError("milestoneId is required", 400);

  const db = getDb();
  const [found, existing] = await Promise.all([
    loadMilestone(db, milestoneId),
    db.query.advances.findFirst({ where: (t, { eq }) => eq(t.milestoneId, milestoneId), orderBy: (t, { asc }) => asc(t.createdAt) }),
  ]);
  if (!found) return jsonError("milestone not found", 404);
  const { milestone: m, contract: c } = found;
  if (c.freelancerId !== actor.userId) return jsonError("not your milestone", 403);

  const head = { milestoneId, currency: c.currency, amountMinor: m.amountMinor };
  if (existing) {
    return json({ ...head, advance: advanceView(existing), offer: existing.offer, terms: (existing.offer as { terms?: unknown }).terms ?? null, explanation: existing.explanation, explanationSource: "stored" });
  }
  // Underwriting reads both parties' records: only for a milestone without an advance.
  const u = await loadUnderwriting(db, milestoneId);
  if (!u) return jsonError("milestone not found", 404);
  const { text, source } = await explainOffer(u);
  return json({ ...head, advance: null, offer: u.offer, terms: u.terms, explanation: text, explanationSource: source });
}

import { loadUnderwriting } from "@milestone/money";
import { getDb } from "@/lib/db";
import { getActor } from "@/lib/session";
import { advanceView, explainOffer, json } from "../_shared";

export const dynamic = "force-dynamic";

/**
 * GET /api/advances/offer?milestoneId=... (the contract's freelancer only).
 * With an advance already on the milestone, returns it (one advance per milestone). Otherwise prices a fresh offer;
 * an ineligible milestone comes back 200 with offer.eligible = false and the reason.
 */
export async function GET(req: Request) {
  const actor = await getActor();
  if (actor.role !== "freelancer") return json({ error: "only the freelancer can see advance offers" }, 403);
  const milestoneId = new URL(req.url).searchParams.get("milestoneId");
  if (!milestoneId) return json({ error: "milestoneId is required" }, 400);

  const db = getDb();
  const u = await loadUnderwriting(db, milestoneId);
  if (!u) return json({ error: "milestone not found" }, 404);
  if (u.freelancerId !== actor.userId) return json({ error: "not your milestone" }, 403);

  const existing = await db.query.advances.findFirst({ where: (t, { eq }) => eq(t.milestoneId, milestoneId), orderBy: (t, { asc }) => asc(t.createdAt) });
  const head = { milestoneId, currency: u.currency, amountMinor: u.amountMinor };
  if (existing) {
    const view = advanceView(existing);
    return json({ ...head, advance: view, offer: existing.offer, terms: (existing.offer as { terms?: unknown }).terms ?? null, explanation: existing.explanation, explanationSource: "stored" });
  }
  const { text, source } = await explainOffer(u);
  return json({ ...head, advance: null, offer: u.offer, terms: u.terms, explanation: text, explanationSource: source });
}

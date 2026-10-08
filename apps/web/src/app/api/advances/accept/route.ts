import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { advances, audit, enqueue, milestones, users, type Db } from "@milestone/core";
import { describeOffer, loadUnderwriting } from "@milestone/money";
import { getDb } from "@/lib/db";
import { getActor } from "@/lib/session";
import { advanceView, json, partnerIdFor } from "../_shared";

export const dynamic = "force-dynamic";

type AdvanceRow = typeof advances.$inferSelect;
type Outcome = { refused: { error: string; status: number; reason?: string } } | { advance: AdvanceRow; created: boolean };

async function queue(a: AdvanceRow): Promise<boolean> {
  if (a.status !== "offered") return false;
  try {
    // The job is idempotent and the dedupe key makes a repeat a no-op while one is queued.
    await enqueue("advance", a.milestoneId, { advanceId: a.id }, { dedupe: `advance-${a.id}` });
    return true;
  } catch (e) {
    console.error("advance enqueue failed", e);
    return false;
  }
}

/**
 * POST /api/advances/accept { milestoneId } (the contract's freelancer only). One advance per milestone: under
 * SELECT ... FOR UPDATE on the milestone row (and on both users' rows, so two accepts cannot share the same limit
 * headroom) an existing advance is returned as is; otherwise the offer is re-priced from the database, inserted as
 * `offered`, audited as advance.accepted, and the advance job is enqueued after commit. The job pays it out.
 */
export async function POST(req: Request) {
  const actor = await getActor();
  if (actor.role !== "freelancer") return json({ error: "only the freelancer can accept an advance" }, 403);
  const body = (await req.json().catch(() => null)) as { milestoneId?: unknown } | null;
  const milestoneId = typeof body?.milestoneId === "string" && body.milestoneId ? body.milestoneId : null;
  if (!milestoneId) return json({ error: "milestoneId is required" }, 400);

  const db = getDb();
  const m = await db.query.milestones.findFirst({ where: (t, { eq }) => eq(t.id, milestoneId) });
  if (!m) return json({ error: "milestone not found" }, 404);
  const c = await db.query.contracts.findFirst({ where: (t, { eq }) => eq(t.id, m.contractId) });
  if (!c) return json({ error: "contract not found" }, 404);
  if (c.freelancerId !== actor.userId) return json({ error: "not your milestone" }, 403);

  const outcome = await db.transaction(async (tx): Promise<Outcome> => {
    const t = tx as unknown as Db;
    const refuse = (error: string, status = 409, reason?: string): Outcome => ({ refused: { error, status, ...(reason ? { reason } : {}) } });
    const [locked] = await tx.select({ id: milestones.id }).from(milestones).where(eq(milestones.id, milestoneId)).for("update");
    if (!locked) return refuse("milestone not found", 404);
    const existing = await tx.query.advances.findFirst({ where: (a, { eq }) => eq(a.milestoneId, milestoneId), orderBy: (a, { asc }) => asc(a.createdAt) });
    if (existing) return { advance: existing, created: false };

    const parties = [c.freelancerId, c.clientId].sort();
    const people = await tx.select().from(users).where(inArray(users.id, parties)).orderBy(users.id).for("update");
    const freelancer = people.find((p) => p.id === c.freelancerId);
    if (!freelancer?.paypalEmail) return refuse("add a PayPal email to your profile before taking an advance", 409, "no_paypal_email");
    const partnerId = await partnerIdFor(t);
    if (!partnerId) return refuse("no capital partner is configured", 503, "no_partner");

    // Priced on a separate connection: it sees every advance committed by an accept that held these locks before us.
    const u = await loadUnderwriting(db, milestoneId);
    if (!u) return refuse("milestone not found", 404);
    if (!u.offer.eligible || !u.terms) return refuse(u.offer.eligible ? "no offer" : u.offer.reason, 409, "not_eligible");

    const now = new Date();
    const [row] = await tx
      .insert(advances)
      .values({
        id: `adv_${randomUUID()}`,
        milestoneId,
        partnerId,
        principalMinor: u.terms.principalMinor,
        feeBpsPerDay: u.terms.feeBpsPerDay,
        status: "offered",
        // expectedFeeMinor at the top level is what the release job deducts with the principal.
        offer: { ...u.offer, terms: u.terms, currency: u.currency, records: u.records, pricing: u.pricing, acceptedAt: now.toISOString() },
        explanation: describeOffer(u, u.currency),
      })
      .returning();
    await audit(t, {
      actor: actor.userId,
      event: "advance.accepted",
      milestoneId,
      contractId: c.id,
      detail: { advanceId: row!.id, partnerId, principalMinor: u.terms.principalMinor, feeBpsPerDay: u.terms.feeBpsPerDay, expectedFeeMinor: u.terms.expectedFeeMinor, repaymentMinor: u.terms.repaymentMinor, currency: u.currency },
    });
    return { advance: row!, created: true };
  });

  if ("refused" in outcome) return json({ error: outcome.refused.error, ...(outcome.refused.reason ? { reason: outcome.refused.reason } : {}) }, outcome.refused.status);
  const queued = await queue(outcome.advance);
  return json({ advance: advanceView(outcome.advance), created: outcome.created, queued }, outcome.created ? 201 : 200);
}

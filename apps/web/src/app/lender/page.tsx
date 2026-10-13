import { desc, eq } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { advances, asNumber, contracts, milestones, users } from "@milestone/core";
import { DAY_MS, advanceRepayment, loadAdvanceBalances } from "@milestone/money";
import { getDb } from "@/lib/db";
import { ACTOR_NAMES, getActor, isOperator } from "@/lib/session";
import { LenderBook, type LenderRow } from "@/components/lender-book";
import { Button, EmptyState, PageHeader } from "@/components/ui";

export const dynamic = "force-dynamic";

const WEEK_MS = 7 * DAY_MS;

/** Where the partner's money stands, from the advance and its milestone. */
function repaymentStatus(advance: string, milestone: string): string {
  if (advance === "offered") return "awaiting payout";
  if (advance === "repaid") return "repaid";
  if (advance === "shortfall") return "shortfall";
  if (milestone === "released" || milestone === "partial_released") return "repaying";
  if (milestone === "held") return "at risk: milestone held";
  if (milestone === "review" || milestone === "needs_client") return "due at release";
  return "due on release";
}

/**
 * The capital partner's book: its advances with their risk numbers (the platform sees every partner's). Outstanding,
 * repaid and expected loss come from the ledger (advance:<id> funding minus the repayment credits booked for it), not
 * from the stored advance. Partner or platform role only.
 */
export default async function LenderPage() {
  const actor = await getActor();
  const allowed = isOperator(actor);
  if (!allowed) {
    return (
      <main>
        <PageHeader
          eyebrow="Capital / restricted"
          title={<>Lender&rsquo;s book</>}
          description="The advance book belongs to the capital partner who funds it, and to the platform."
        />
        <EmptyState
          className="mt-12"
          title="This book is not yours to read"
          body={`You are acting as the ${actor.role}. Switch to the partner role in the header to see principal out, expected loss and repayments.`}
          action={<Button href="/">Back to contracts</Button>}
        />
      </main>
    );
  }

  const db = getDb();
  const freelancer = alias(users, "freelancer");
  const client = alias(users, "client");
  const rows = await db
    .select({ a: advances, m: { id: milestones.id, seq: milestones.seq, title: milestones.title, status: milestones.status, amountMinor: milestones.amountMinor, decidedAt: milestones.decidedAt }, c: { id: contracts.id, title: contracts.title, currency: contracts.currency }, freelancer: { id: freelancer.id, name: freelancer.name }, client: { id: client.id, name: client.name } })
    .from(advances)
    .innerJoin(milestones, eq(milestones.id, advances.milestoneId))
    .innerJoin(contracts, eq(contracts.id, milestones.contractId))
    .innerJoin(freelancer, eq(freelancer.id, contracts.freelancerId))
    .innerJoin(client, eq(client.id, contracts.clientId))
    .where(actor.role === "partner" ? eq(advances.partnerId, actor.userId) : undefined)
    .orderBy(desc(advances.createdAt));

  const now = new Date();
  const balances = await loadAdvanceBalances(db, rows.map(({ a }) => ({ id: a.id, milestoneId: a.milestoneId, partnerId: a.partnerId })), new Date(now.getTime() - WEEK_MS));
  const book: LenderRow[] = rows.map(({ a, m, c, freelancer: f, client: cl }) => {
    const offer = a.offer ?? {};
    const end = a.repaidAt ?? now;
    const b = balances.get(a.id);
    const outstandingMinor = Math.max(0, b?.outstandingMinor ?? 0);
    const pFail = asNumber(offer.pFail);
    return {
      id: a.id,
      contractId: c.id,
      freelancer: f.name,
      partnerId: a.partnerId,
      clientId: cl.id,
      client: cl.name,
      // The milestone by title: its number reads as a rank in a list of advances.
      milestone: m.title,
      milestoneStatus: m.status,
      currency: c.currency,
      amountMinor: m.amountMinor,
      principalMinor: a.principalMinor,
      // What the partner is owed back out of the release (the quoted fee, else accrued to the decision or to now).
      feeMinor: advanceRepayment(a, m.decidedAt ?? now).feeMinor,
      feeBpsPerDay: a.feeBpsPerDay,
      status: a.status,
      daysOutstanding: a.fundedAt ? Math.max(0, Math.floor((end.getTime() - a.fundedAt.getTime()) / DAY_MS)) : null,
      outstandingMinor,
      repaidMinor: (b?.principalRepaidMinor ?? 0) + (b?.feeRepaidMinor ?? 0),
      repaidThisWeekMinor: b?.repaidSinceMinor ?? 0,
      pFail,
      expectedLossMinor: pFail === null ? null : Math.round(pFail * outstandingMinor),
      repaymentStatus: repaymentStatus(a.status, m.status),
      createdAt: a.createdAt.toISOString(),
      fundedAt: a.fundedAt?.toISOString() ?? null,
      repaidAt: a.repaidAt?.toISOString() ?? null,
    };
  });

  return (
    <main>
      <PageHeader
        eyebrow={
          <>
            Capital <span className="text-hairline-strong">/</span> {actor.role === "partner" ? (ACTOR_NAMES[actor.userId] ?? actor.userId) : "every partner"}
          </>
        }
        title={<>Lender&rsquo;s book</>}
        description="Milestone Advances go out from the capital partner's PayPal account and come back first, out of the release of the milestone they were lent against."
      />
      <div className="mt-12">
        <LenderBook rows={book} />
      </div>
    </main>
  );
}

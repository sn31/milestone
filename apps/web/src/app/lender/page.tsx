import { desc, eq } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { advances, contracts, milestones, users } from "@milestone/core";
import { getDb } from "@/lib/db";
import { getActor } from "@/lib/session";
import { LenderBook, type LenderRow } from "@/components/lender-book";

export const dynamic = "force-dynamic";

const DAY_MS = 86_400_000;
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

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

/** The capital partner's book: every advance with its risk numbers. Partner or platform role only. */
export default async function LenderPage() {
  const actor = await getActor();
  const allowed = actor.role === "partner" || (actor.role as string) === "platform";
  if (!allowed) {
    return (
      <main className="space-y-3">
        <h1 className="text-2xl font-semibold">Lender book</h1>
        <p className="text-sm text-zinc-500">Only the capital partner or the platform can see the advance book. You are acting as {actor.role}.</p>
      </main>
    );
  }

  const db = getDb();
  const freelancer = alias(users, "freelancer");
  const client = alias(users, "client");
  const rows = await db
    .select({ a: advances, m: { id: milestones.id, seq: milestones.seq, title: milestones.title, status: milestones.status, amountMinor: milestones.amountMinor }, c: { id: contracts.id, title: contracts.title, currency: contracts.currency }, freelancer: { id: freelancer.id, name: freelancer.name }, client: { id: client.id, name: client.name } })
    .from(advances)
    .innerJoin(milestones, eq(milestones.id, advances.milestoneId))
    .innerJoin(contracts, eq(contracts.id, milestones.contractId))
    .innerJoin(freelancer, eq(freelancer.id, contracts.freelancerId))
    .innerJoin(client, eq(client.id, contracts.clientId))
    .orderBy(desc(advances.createdAt));

  const now = new Date();
  const book: LenderRow[] = rows.map(({ a, m, c, freelancer: f, client: cl }) => {
    const offer = a.offer ?? {};
    const end = a.repaidAt ?? now;
    return {
      id: a.id,
      contractId: c.id,
      freelancer: f.name,
      clientId: cl.id,
      client: cl.name,
      milestone: `${m.seq}. ${m.title}`,
      milestoneStatus: m.status,
      currency: c.currency,
      amountMinor: m.amountMinor,
      principalMinor: a.principalMinor,
      feeMinor: Math.max(0, Math.trunc(num(offer.expectedFeeMinor) ?? 0)),
      feeBpsPerDay: a.feeBpsPerDay,
      status: a.status,
      daysOutstanding: a.fundedAt ? Math.max(0, Math.floor((end.getTime() - a.fundedAt.getTime()) / DAY_MS)) : null,
      pFail: num(offer.pFail),
      expectedLossMinor: num(offer.expectedLossMinor),
      repaymentStatus: repaymentStatus(a.status, m.status),
      createdAt: a.createdAt.toISOString(),
      fundedAt: a.fundedAt?.toISOString() ?? null,
      repaidAt: a.repaidAt?.toISOString() ?? null,
    };
  });

  return (
    <main className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Lender book</h1>
        <p className="text-sm text-zinc-500">Milestone Advances paid from the capital partner&apos;s PayPal account, repaid first out of each release.</p>
      </div>
      {/* Wider than the 3xl content column: the grid has ten columns. */}
      <div className="ml-[calc(50%_-_min(36rem,50vw_-_1.5rem))] w-[min(72rem,calc(100vw_-_3rem))]">
        <LenderBook rows={book} now={now.toISOString()} />
      </div>
    </main>
  );
}

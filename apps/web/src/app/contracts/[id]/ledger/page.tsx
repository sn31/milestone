import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { asc, eq, inArray, or } from "drizzle-orm";
import { advances, ledgerEntries, ledgerRefs, milestones } from "@milestone/core";
import { getDb } from "@/lib/db";
import { LedgerGrid, type LedgerRow } from "@/components/ledger-grid";
import { PageHeader, Stat } from "@/components/ui";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: PageProps<"/contracts/[id]/ledger">): Promise<Metadata> {
  const { id } = await params;
  const contract = await getDb().query.contracts.findFirst({ columns: { title: true }, where: (t, { eq }) => eq(t.id, id) });
  return { title: contract ? `Ledger · ${contract.title}` : "Contract not found" };
}

/**
 * Every ledger entry that touches this contract's milestones: whole transactions (both legs) that post to a
 * held:<milestone> account, plus the partner's advance fundings (ref advance:<id>) for advances on those milestones.
 */
export default async function LedgerPage({ params }: PageProps<"/contracts/[id]/ledger">) {
  const { id } = await params;
  const db = getDb();
  const contract = await db.query.contracts.findFirst({ where: (t, { eq }) => eq(t.id, id) });
  if (!contract) notFound();

  const ms = await db.select({ id: milestones.id, seq: milestones.seq, title: milestones.title }).from(milestones).where(eq(milestones.contractId, id)).orderBy(asc(milestones.seq));
  const label = new Map(ms.map((m) => [m.id, `${m.seq} ${m.title}`]));
  const heldOf = new Map(ms.map((m) => [`held:${m.id}`, m.id]));
  const adv = ms.length > 0 ? await db.select({ id: advances.id, milestoneId: advances.milestoneId }).from(advances).where(inArray(advances.milestoneId, ms.map((m) => m.id))) : [];
  const advOf = new Map(adv.map((a) => [ledgerRefs.advanceFunding(a.id), a.milestoneId]));

  const entries =
    heldOf.size + advOf.size === 0
      ? []
      : await db
          .select()
          .from(ledgerEntries)
          .where(
            inArray(
              ledgerEntries.txnId,
              db
                .select({ txnId: ledgerEntries.txnId })
                .from(ledgerEntries)
                .where(or(...(heldOf.size ? [inArray(ledgerEntries.account, [...heldOf.keys()])] : []), ...(advOf.size ? [inArray(ledgerEntries.ref, [...advOf.keys()])] : []))),
            ),
          )
          .orderBy(asc(ledgerEntries.createdAt), asc(ledgerEntries.txnId), asc(ledgerEntries.direction), asc(ledgerEntries.account));

  // Which milestone a transaction belongs to: the held account it posts to, else the advance it funds.
  const txnMilestone = new Map<string, string>();
  for (const e of entries) {
    const m = heldOf.get(e.account) ?? advOf.get(e.ref);
    if (m && !txnMilestone.has(e.txnId)) txnMilestone.set(e.txnId, m);
  }

  const rows: LedgerRow[] = entries.map((e) => {
    const m = txnMilestone.get(e.txnId) ?? null;
    return {
      id: e.id,
      at: e.createdAt.toISOString(),
      txnId: e.txnId,
      milestone: m ? (label.get(m) ?? m) : "",
      account: e.account,
      direction: e.direction,
      amountMinor: e.amountMinor,
      currency: e.currency,
      ref: e.ref,
    };
  });

  const txns = new Set(rows.map((r) => r.txnId)).size;
  // Derived, never stored: what sits in this contract's escrow accounts right now. held:* is what Milestone owes
  // (credited when the client funds, debited on release or refund), so its balance is credits minus debits.
  const inEscrow = rows.filter((r) => r.account.startsWith("held:") && r.currency === contract.currency).reduce((s, r) => s + (r.direction === "credit" ? r.amountMinor : -r.amountMinor), 0);

  return (
    <main>
      <PageHeader
        eyebrow={
          <Link href={`/contracts/${id}`} className="group inline-flex min-w-0 items-center gap-2 hover:text-fg">
            <svg aria-hidden viewBox="0 0 20 8" className="h-2 w-5 shrink-0 transition-transform duration-200 ease-glide group-hover:-translate-x-0.5" fill="none" stroke="currentColor" strokeWidth="1.2">
              <path d="M20 4 H2 M5 1 L2 4 L5 7" />
            </svg>
            <span className="truncate">{contract.title}</span>
          </Link>
        }
        title="Ledger"
        description="Every transaction sums to zero. Balances are derived, never stored."
        aside={
          <>
            <Stat label="Entries" value={rows.length} />
            <Stat label="Transactions" value={txns} />
            <Stat label="In escrow" minor={inEscrow} currency={contract.currency} tone="funded" />
          </>
        }
      />
      <section className="mt-12" aria-label="Ledger entries">
        <LedgerGrid rows={rows} />
      </section>
    </main>
  );
}

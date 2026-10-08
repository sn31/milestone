import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/lib/db";
import { AuditGrid, type AuditRow } from "@/components/audit-grid";
import { PageHeader, Stat } from "@/components/ui";
import { ACTOR_NAMES, getActor, isContractFreelancer } from "@/lib/session";
import { auditDetail } from "./actions";
import { hasDetail, redactDetail, summarizeDetail } from "./detail";
import { countContractOps, disputeIdsOf } from "./paypal-ops";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: PageProps<"/contracts/[id]/activity">): Promise<Metadata> {
  const { id } = await params;
  const contract = await getDb().query.contracts.findFirst({ columns: { title: true }, where: (t, { eq }) => eq(t.id, id) });
  return { title: contract ? `Audit log · ${contract.title}` : "Contract not found" };
}

export default async function ActivityPage({ params }: PageProps<"/contracts/[id]/activity">) {
  const { id } = await params;
  const db = getDb();
  const [contract, actor, ms, log] = await Promise.all([
    db.query.contracts.findFirst({ columns: { id: true, title: true, freelancerId: true }, where: (t, { eq }) => eq(t.id, id) }),
    getActor(),
    db.query.milestones.findMany({ columns: { id: true, seq: true, title: true }, where: (t, { eq }) => eq(t.contractId, id) }),
    db.query.auditLog.findMany({ where: (t, { eq }) => eq(t.contractId, id), orderBy: (t, { desc }) => [desc(t.createdAt)] }),
  ]);
  if (!contract) notFound();
  const canSeeDraft = isContractFreelancer(actor, contract);
  const label = new Map(ms.map((m) => [m.id, `${m.seq} ${m.title}`]));
  // Each row ships a short summary of its detail; the full detail is fetched (and redacted the same way) when opened.
  const rows: AuditRow[] = log.map((r) => {
    const detail = redactDetail(r.event, r.detail ?? null, canSeeDraft);
    return {
      id: r.id,
      at: r.createdAt.toISOString(),
      milestone: r.milestoneId ? (label.get(r.milestoneId) ?? r.milestoneId) : "",
      actor: ACTOR_NAMES[r.actor] ?? r.actor,
      event: r.event,
      summary: summarizeDetail(detail),
      hasDetail: hasDetail(detail),
    };
  });
  // One paypal_ops row per PayPal-Request-Id: the calls themselves, not the paypal.* webhook rows in the log.
  const paypal = await countContractOps(db, { milestoneIds: ms.map((m) => m.id), disputeIds: disputeIdsOf(log) });
  const decisions = log.filter((r) => r.event === "policy.decided" || r.event.startsWith("client.")).length;

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
        title="Audit log"
        description="Every approval, verdict, policy decision and PayPal call on this contract, in the order it happened. Both parties read the same log; nothing in it can be edited."
        aside={
          <>
            <Stat label="Events" value={log.length} />
            <Stat label="PayPal calls" value={paypal} tone="funded" />
            <Stat label="Decisions" value={decisions} tone="review" />
          </>
        }
      />
      <section className="mt-12" aria-label="Events">
        <AuditGrid rows={rows} loadDetail={auditDetail.bind(null, id)} />
      </section>
    </main>
  );
}

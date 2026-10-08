import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/lib/db";
import { AuditGrid, type AuditRow } from "@/components/audit-grid";

export const dynamic = "force-dynamic";

export default async function ActivityPage({ params }: PageProps<"/contracts/[id]/activity">) {
  const { id } = await params;
  const db = getDb();
  const contract = await db.query.contracts.findFirst({ where: (t, { eq }) => eq(t.id, id) });
  if (!contract) notFound();
  const ms = await db.query.milestones.findMany({ where: (t, { eq }) => eq(t.contractId, id) });
  const label = new Map(ms.map((m) => [m.id, `${m.seq} ${m.title}`]));
  const log = await db.query.auditLog.findMany({ where: (t, { eq }) => eq(t.contractId, id), orderBy: (t, { desc }) => [desc(t.createdAt)] });
  const rows: AuditRow[] = log.map((r) => ({
    id: r.id,
    at: r.createdAt.toISOString(),
    milestone: r.milestoneId ? (label.get(r.milestoneId) ?? r.milestoneId) : "",
    actor: r.actor,
    event: r.event,
    detail: r.detail ?? null,
  }));
  return (
    <main className="space-y-4">
      <header>
        <Link href={`/contracts/${id}`} className="text-sm underline">Back to contract</Link>
        <h1 className="mt-2 text-2xl font-semibold">Activity: {contract.title}</h1>
      </header>
      <AuditGrid rows={rows} />
    </main>
  );
}

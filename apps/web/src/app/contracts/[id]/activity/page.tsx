import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/lib/db";
import { AuditGrid, type AuditRow } from "@/components/audit-grid";
import { ACTOR_NAMES } from "@/lib/session";

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
    actor: ACTOR_NAMES[r.actor] ?? r.actor,
    event: r.event,
    detail: r.detail ?? null,
  }));
  return (
    <main className="space-y-4">
      <header>
        <Link href={`/contracts/${id}`} className="text-sm text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-white">&larr; {contract.title}</Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Audit log</h1>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">Every approval, verdict, decision and PayPal call on this contract. Both parties can read it.</p>
      </header>
      <AuditGrid rows={rows} />
    </main>
  );
}

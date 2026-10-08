import { notFound } from "next/navigation";
import { getDb } from "@/lib/db";
import { getActor } from "@/lib/session";
import { formatDate, formatMoney } from "@/lib/format";
import { StatusBadge } from "@/components/status-badge";
import { MilestoneActions } from "@/components/milestone-actions";

export const dynamic = "force-dynamic";

export default async function ContractPage({ params }: PageProps<"/contracts/[id]">) {
  const { id } = await params;
  const db = getDb();
  const contract = await db.query.contracts.findFirst({ where: (t, { eq }) => eq(t.id, id) });
  if (!contract) notFound();
  const actor = await getActor();
  const ms = await db.query.milestones.findMany({ where: (t, { eq }) => eq(t.contractId, id), orderBy: (t, { asc }) => [asc(t.seq)] });
  const crit = ms.length
    ? await db.query.criteria.findMany({ where: (t, { inArray }) => inArray(t.milestoneId, ms.map((m) => m.id)) })
    : [];
  const activity = await db.query.auditLog.findMany({ where: (t, { eq }) => eq(t.contractId, id), orderBy: (t, { desc }) => [desc(t.createdAt)] });
  const approve = `/api/contracts/${id}/approve`;
  const btn = "rounded border border-zinc-300 px-3 py-2 text-sm hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-900";

  return (
    <main className="space-y-6">
      <header>
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold">{contract.title}</h1>
          <StatusBadge status={contract.status} />
        </div>
        <p className="mt-1 text-sm text-zinc-500">
          {formatMoney(contract.totalMinor, contract.currency)}
          {contract.repoFullName ? ` / ${contract.repoFullName}` : ""}
        </p>
        <p className="mt-3 whitespace-pre-wrap text-sm">{contract.scopeText}</p>
      </header>

      <section className="rounded border border-zinc-200 p-4 dark:border-zinc-800">
        <h2 className="mb-2 font-medium">Approval</h2>
        <p className="mb-3 text-sm text-zinc-500">
          Client: {contract.clientApprovedAt ? `approved ${formatDate(contract.clientApprovedAt)}` : "pending"}.
          Freelancer: {contract.freelancerApprovedAt ? `approved ${formatDate(contract.freelancerApprovedAt)}` : "pending"}.
          You are acting as {actor.role}.
        </p>
        <div className="flex gap-2">
          <form action={approve} method="post"><button className={btn} disabled={actor.role !== "client"}>Approve as client</button></form>
          <form action={approve} method="post"><button className={btn} disabled={actor.role !== "freelancer"}>Approve as freelancer</button></form>
        </div>
      </section>

      {ms.map((m) => (
        <section key={m.id} className="rounded border border-zinc-200 p-4 dark:border-zinc-800">
          <div className="flex items-center justify-between">
            <h2 className="font-medium">{m.seq}. {m.title}</h2>
            <StatusBadge status={m.status} />
          </div>
          <p className="mt-1 text-sm text-zinc-500">{formatMoney(m.amountMinor, contract.currency)} / due {formatDate(m.dueAt)}</p>
          <ul className="mt-3 space-y-1 text-sm">
            {crit.filter((c) => c.milestoneId === m.id).map((c) => (
              <li key={c.id} className="flex gap-2">
                <span className="rounded bg-zinc-100 px-1.5 font-mono text-xs dark:bg-zinc-800">{c.kind}</span>
                <span>{c.description}</span>
                <span className="text-zinc-500">{c.required ? "required" : "optional"}</span>
              </li>
            ))}
          </ul>
          {/* Slot: replaced by a later agent via components/milestone-actions.tsx */}
          <MilestoneActions milestone={m} contract={contract} actor={actor} />
        </section>
      ))}

      <section>
        <h2 className="mb-2 font-medium">Activity</h2>
        {activity.length === 0 && <p className="text-sm text-zinc-500">Nothing yet.</p>}
        <ul className="space-y-1 text-sm">
          {activity.map((a) => (
            <li key={a.id} className="flex gap-3">
              <span className="font-mono text-xs text-zinc-500">{a.createdAt.toISOString().replace("T", " ").slice(0, 19)}</span>
              <span>{a.event}</span>
              <span className="text-zinc-500">{a.actor}</span>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}

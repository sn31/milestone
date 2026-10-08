import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/lib/db";
import { ACTOR_NAMES, getActor } from "@/lib/session";
import { formatDate, formatDateTime, formatMoney, humanize } from "@/lib/format";
import { MilestoneActions } from "@/components/milestone-actions";
import { StatusPill } from "../_components/status-pill";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: PageProps<"/contracts/[id]">): Promise<Metadata> {
  const { id } = await params;
  const contract = await getDb().query.contracts.findFirst({ columns: { title: true }, where: (t, { eq }) => eq(t.id, id) });
  return { title: contract?.title ?? "Contract not found" };
}

const KIND_STYLE: Record<string, string> = {
  test: "bg-sky-50 text-sky-800 dark:bg-sky-950 dark:text-sky-300",
  build: "bg-violet-50 text-violet-800 dark:bg-violet-950 dark:text-violet-300",
  file: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
  visual: "bg-pink-50 text-pink-800 dark:bg-pink-950 dark:text-pink-300",
  judgment: "bg-amber-50 text-amber-900 dark:bg-amber-950 dark:text-amber-300",
  upload: "bg-teal-50 text-teal-800 dark:bg-teal-950 dark:text-teal-300",
};

const card = "rounded-xl border border-zinc-200 bg-surface p-5 shadow-sm dark:border-zinc-800";

function ApprovalRow({ who, name, at }: { who: string; name: string; at: Date | null }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg bg-zinc-50 px-3 py-2 dark:bg-zinc-900">
      <div>
        <p className="text-sm font-medium">{who}</p>
        <p className="text-xs text-zinc-500 dark:text-zinc-400">{name}</p>
      </div>
      {at ? (
        <span className="text-xs font-medium text-emerald-700 dark:text-emerald-400">Approved {formatDate(at)}</span>
      ) : (
        <span className="text-xs text-zinc-500 dark:text-zinc-400">Pending</span>
      )}
    </div>
  );
}

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
  const activity = await db.query.auditLog.findMany({
    where: (t, { eq }) => eq(t.contractId, id),
    orderBy: (t, { desc }) => [desc(t.createdAt)],
    limit: 25,
  });
  const milestoneLabel = new Map(ms.map((m) => [m.id, `${m.seq}. ${m.title}`]));

  const myColumn = actor.role === "client" ? contract.clientApprovedAt : actor.role === "freelancer" ? contract.freelancerApprovedAt : null;
  const isParty =
    (actor.role === "client" && actor.userId === contract.clientId) || (actor.role === "freelancer" && actor.userId === contract.freelancerId);
  const bothApproved = Boolean(contract.clientApprovedAt && contract.freelancerApprovedAt);
  const released = ms.filter((m) => m.status === "released" || m.status === "partial_released").length;

  return (
    <main className="space-y-6">
      <div>
        <Link href="/" className="text-sm text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-white">&larr; All contracts</Link>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-2xl font-semibold tracking-tight">{contract.title}</h1>
              <StatusPill status={contract.status} size="md" />
            </div>
            <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
              {ACTOR_NAMES[contract.clientId] ?? contract.clientId} hires {ACTOR_NAMES[contract.freelancerId] ?? contract.freelancerId}
              {contract.repoFullName ? <> &middot; <span className="font-mono">{contract.repoFullName}</span></> : null}
            </p>
          </div>
          <div className="text-right">
            <p className="text-2xl font-semibold tabular-nums">{formatMoney(contract.totalMinor, contract.currency)}</p>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">{ms.length} milestones, {released} released</p>
          </div>
        </div>
      </div>

      <section className={card}>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Scope</h2>
        <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed">{contract.scopeText}</p>
      </section>

      <section className={card}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Approval</h2>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            {bothApproved ? "Both parties approved. Milestones can be funded." : "Funding opens once both parties approve."}
          </p>
        </div>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <ApprovalRow who="Client" name={ACTOR_NAMES[contract.clientId] ?? contract.clientId} at={contract.clientApprovedAt} />
          <ApprovalRow who="Freelancer" name={ACTOR_NAMES[contract.freelancerId] ?? contract.freelancerId} at={contract.freelancerApprovedAt} />
        </div>
        {!bothApproved ? (
          <div className="mt-4 flex flex-wrap items-center gap-3">
            {isParty && !myColumn ? (
              <form action={`/api/contracts/${id}/approve`} method="post">
                <button className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-zinc-700 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200">
                  Approve as {actor.role}
                </button>
              </form>
            ) : null}
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              {isParty && myColumn
                ? "You have approved. Switch role to approve as the other party."
                : isParty
                  ? "Approving accepts the milestones and checks below."
                  : "Only the client and the freelancer approve. Switch role to act as one of them."}
            </p>
          </div>
        ) : null}
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Milestones</h2>
        {ms.length === 0 ? <p className="text-sm text-zinc-500">No milestones.</p> : null}
        {ms.map((m) => (
          <article key={m.id} className={card}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <h3 className="font-medium">
                  <span className="mr-2 text-zinc-400 tabular-nums">{m.seq}.</span>
                  {m.title}
                </h3>
                <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                  {m.dueAt ? `Due ${formatDate(m.dueAt)}` : "No due date"}
                  {m.advanceEligible ? " · Eligible for an advance" : ""}
                </p>
              </div>
              <div className="flex items-center gap-3">
                <span className="font-semibold tabular-nums">{formatMoney(m.amountMinor, contract.currency)}</span>
                <StatusPill status={m.status} />
              </div>
            </div>
            <ul className="mt-4 space-y-2 border-t border-zinc-100 pt-3 text-sm dark:border-zinc-800">
              {crit
                .filter((c) => c.milestoneId === m.id)
                .map((c) => (
                  <li key={c.id} className="flex items-start gap-2">
                    <span className={`mt-0.5 w-16 shrink-0 rounded px-1.5 py-0.5 text-center font-mono text-[11px] ${KIND_STYLE[c.kind] ?? KIND_STYLE.file}`}>{c.kind}</span>
                    <span className="flex-1">{c.description}</span>
                    <span className={`shrink-0 text-xs ${c.required ? "text-zinc-700 dark:text-zinc-300" : "text-zinc-400"}`}>{c.required ? "required" : "optional"}</span>
                  </li>
                ))}
            </ul>
            <MilestoneActions milestone={m} contract={contract} actor={actor} />
          </article>
        ))}
      </section>

      <section className={card}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Activity</h2>
          <Link href={`/contracts/${id}/activity`} className="text-sm text-zinc-600 underline-offset-2 hover:underline dark:text-zinc-300">
            Full audit log &rarr;
          </Link>
        </div>
        {activity.length === 0 ? <p className="mt-3 text-sm text-zinc-500">Nothing yet.</p> : null}
        <ol className="mt-3 divide-y divide-zinc-100 text-sm dark:divide-zinc-800">
          {activity.map((a) => (
            <li key={a.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 py-2">
              <time dateTime={a.createdAt.toISOString()} className="w-48 shrink-0 whitespace-nowrap text-xs tabular-nums text-zinc-500 dark:text-zinc-400">
                {formatDateTime(a.createdAt)}
              </time>
              <span className="font-medium">{humanize(a.event)}</span>
              {a.milestoneId ? <span className="text-xs text-zinc-500">{milestoneLabel.get(a.milestoneId) ?? a.milestoneId}</span> : null}
              <span className="ml-auto text-xs text-zinc-500 dark:text-zinc-400">{ACTOR_NAMES[a.actor] ?? a.actor}</span>
            </li>
          ))}
        </ol>
      </section>
    </main>
  );
}

import Link from "next/link";
import { getDb } from "@/lib/db";
import { formatDate, formatMoney } from "@/lib/format";
import { ACTOR_NAMES, getActor } from "@/lib/session";
import { StatusPill } from "@/app/contracts/_components/status-pill";

export const dynamic = "force-dynamic";

export default async function Home() {
  const db = getDb();
  const actor = await getActor();
  const rows = await db.query.contracts.findMany({ orderBy: (t, { desc }) => [desc(t.createdAt)] });
  const ms = await db.query.milestones.findMany({ columns: { contractId: true, status: true } });
  const counts = new Map<string, { total: number; released: number }>();
  for (const m of ms) {
    const c = counts.get(m.contractId) ?? { total: 0, released: 0 };
    c.total += 1;
    if (m.status === "released" || m.status === "partial_released") c.released += 1;
    counts.set(m.contractId, c);
  }

  return (
    <main>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Contracts</h1>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            {rows.length === 1 ? "1 contract" : `${rows.length} contracts`}. Signed in as {ACTOR_NAMES[actor.userId] ?? actor.userId} ({actor.role}).
          </p>
        </div>
        <Link
          href="/contracts/new"
          className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-zinc-700 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200"
        >
          New contract
        </Link>
      </div>

      {rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-300 bg-surface p-10 text-center dark:border-zinc-700">
          <p className="font-medium">No contracts yet</p>
          <p className="mt-1 text-sm text-zinc-500">Describe the work in plain English and Milestone drafts the milestones and checks.</p>
        </div>
      ) : (
        <ul className="grid gap-3">
          {rows.map((c) => {
            const n = counts.get(c.id) ?? { total: 0, released: 0 };
            return (
              <li key={c.id}>
                <Link
                  href={`/contracts/${c.id}`}
                  className="group block rounded-xl border border-zinc-200 bg-surface p-4 shadow-sm transition hover:border-zinc-300 hover:shadow dark:border-zinc-800 dark:hover:border-zinc-700"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <p className="truncate font-medium group-hover:underline">{c.title}</p>
                      <p className="mt-1 line-clamp-1 text-sm text-zinc-500 dark:text-zinc-400">{c.scopeText}</p>
                    </div>
                    <p className="shrink-0 text-right text-lg font-semibold tabular-nums">{formatMoney(c.totalMinor, c.currency)}</p>
                  </div>
                  <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-zinc-500 dark:text-zinc-400">
                    <StatusPill status={c.status} />
                    <span>{n.total} milestones, {n.released} released</span>
                    {c.repoFullName ? <span className="font-mono">{c.repoFullName}</span> : null}
                    <span>Created {formatDate(c.createdAt)}</span>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}

import Link from "next/link";
import { getDb } from "@/lib/db";
import { formatMoney } from "@/lib/format";
import { StatusBadge } from "@/components/status-badge";

export const dynamic = "force-dynamic";

export default async function Home() {
  const rows = await getDb().query.contracts.findMany({ orderBy: (t, { desc }) => [desc(t.createdAt)] });
  return (
    <main>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Contracts</h1>
        <Link href="/contracts/new" className="rounded bg-zinc-900 px-3 py-2 text-sm text-white dark:bg-zinc-100 dark:text-zinc-900">New contract</Link>
      </div>
      {rows.length === 0 && <p className="text-zinc-500">No contracts yet.</p>}
      <ul className="space-y-2">
        {rows.map((c) => (
          <li key={c.id}>
            <Link href={`/contracts/${c.id}`} className="flex items-center justify-between rounded border border-zinc-200 p-4 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900">
              <span className="font-medium">{c.title}</span>
              <span className="flex items-center gap-3 text-sm">
                <StatusBadge status={c.status} />
                {formatMoney(c.totalMinor, c.currency)}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}

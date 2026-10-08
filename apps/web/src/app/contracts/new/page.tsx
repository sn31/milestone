import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "New contract" };

const field =
  "mt-1.5 block w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm shadow-sm outline-none placeholder:text-zinc-400 focus:border-zinc-500 focus:ring-2 focus:ring-zinc-200 dark:border-zinc-700 dark:bg-zinc-900 dark:focus:border-zinc-500 dark:focus:ring-zinc-800";
const label = "block text-sm font-medium";

export default async function NewContract({ searchParams }: PageProps<"/contracts/new">) {
  const sp = await searchParams;
  const error = typeof sp.error === "string" ? sp.error : null;
  const compilesWithModel = Boolean(process.env.ANTHROPIC_API_KEY);

  return (
    <main className="mx-auto max-w-2xl">
      <Link href="/" className="text-sm text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-white">&larr; All contracts</Link>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">New contract</h1>
      <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
        Describe the work in plain English. Milestone splits it into funded milestones, each with checks the verifier can run.
      </p>

      {error ? (
        <p role="alert" className="mt-4 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800 dark:border-rose-900 dark:bg-rose-950 dark:text-rose-300">
          {error}
        </p>
      ) : null}

      <form action="/api/contracts" method="post" className="mt-6 space-y-5 rounded-xl border border-zinc-200 bg-surface p-5 shadow-sm dark:border-zinc-800">
        <label className={label}>
          Title <span className="font-normal text-zinc-500">(optional)</span>
          <input name="title" maxLength={120} className={field} placeholder="Pricing page for the marketing site" />
        </label>
        <label className={label}>
          Scope of work
          <textarea
            name="scope"
            required
            rows={7}
            className={field}
            placeholder="Build a signup flow for our landing page: a form with validation, an API that creates the account, and a confirmation page."
          />
        </label>
        <div className="grid gap-4 sm:grid-cols-[1fr_7rem_1.4fr]">
          <label className={label}>
            Total amount
            <input name="total" type="number" inputMode="decimal" step="0.01" min="0.01" required defaultValue="300" className={`${field} tabular-nums`} />
          </label>
          <label className={label}>
            Currency
            <select name="currency" defaultValue="USD" className={field}>
              <option>USD</option>
              <option>EUR</option>
              <option>GBP</option>
              <option>CAD</option>
              <option>AUD</option>
            </select>
          </label>
          <label className={label}>
            GitHub repo <span className="font-normal text-zinc-500">(optional)</span>
            <input name="repo" className={`${field} font-mono`} placeholder="owner/name" pattern="[A-Za-z0-9_.\-]+/[A-Za-z0-9_.\-]+" />
          </label>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-zinc-100 pt-4 dark:border-zinc-800">
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            {compilesWithModel
              ? "The contract compiler drafts milestones and criteria; both parties approve before anything is funded."
              : "No model key is set, so a three-milestone demo contract is drafted. Both parties approve before anything is funded."}
          </p>
          <button className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-zinc-700 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200">
            Draft contract
          </button>
        </div>
      </form>
    </main>
  );
}

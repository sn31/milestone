export default function NewContract() {
  const field = "w-full rounded border border-zinc-300 bg-transparent px-3 py-2 dark:border-zinc-700";
  return (
    <main>
      <h1 className="mb-6 text-2xl font-semibold">New contract</h1>
      <form action="/api/contracts" method="post" className="space-y-4">
        <label className="block text-sm">Scope
          <textarea name="scope" required rows={8} className={field} placeholder="Describe the work in plain English" />
        </label>
        <div className="grid grid-cols-3 gap-4">
          <label className="block text-sm">Total amount
            <input name="total" type="number" step="0.01" min="0.01" required defaultValue="300" className={field} />
          </label>
          <label className="block text-sm">Currency
            <input name="currency" required defaultValue="USD" className={field} />
          </label>
          <label className="block text-sm">Repo (owner/name)
            <input name="repo" className={field} placeholder="acme/site" />
          </label>
        </div>
        <button className="rounded bg-zinc-900 px-4 py-2 text-white dark:bg-zinc-100 dark:text-zinc-900">Create contract</button>
      </form>
    </main>
  );
}

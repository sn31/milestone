import { Panel } from "@/components/ui";

/** A ghost bar: the shape of text that is still on its way. Static; only the status dot is live. */
function Bar({ className }: { className: string }) {
  return <span aria-hidden className={`block rounded-chip bg-fg/[0.06] ${className}`} />;
}

/**
 * Loading the ledger: the page header and a few contract rows drawn as ghosts, in the ledger's own grid. It fades in after
 * 250ms (.loading-delayed), so a quick navigation keeps the previous page painted and never flashes it.
 */
export default function Loading() {
  return (
    <main aria-busy="true" aria-live="polite" className="loading-delayed">
      <p className="type-label flex items-center gap-2 text-fg-faint" data-tone="neutral">
        <span className="size-1.5 animate-pulse-dot rounded-full bg-tone" />
        Loading
      </p>
      <div className="mt-3 flex flex-col gap-6 md:flex-row md:items-end md:justify-between">
        <div className="min-w-0 flex-1">
          <Bar className="h-10 w-56 sm:h-14 sm:w-80" />
          <Bar className="mt-4 h-3.5 w-full max-w-[52ch]" />
          <Bar className="mt-2 h-3.5 w-2/3 max-w-[40ch]" />
        </div>
        <div className="flex gap-8">
          {[0, 1].map((i) => (
            <div key={i}>
              <Bar className="h-2.5 w-16" />
              <Bar className="mt-3 h-8 w-32" />
            </div>
          ))}
        </div>
      </div>
      <Panel padded={false} className="mt-12">
        <div className="hidden border-b border-hairline px-5 py-3.5 md:block">
          <Bar className="h-2.5 w-20" />
        </div>
        <ol className="divide-y divide-hairline">
          {[0, 1, 2].map((i) => (
            <li key={i} className="grid gap-4 px-4 py-5 sm:px-5 md:grid-cols-[minmax(0,1fr)_200px_170px] md:items-center md:gap-6" style={{ opacity: 1 - i * 0.25 }}>
              <div>
                <Bar className="h-4 w-40" />
                <Bar className="mt-3 h-5 w-3/4 max-w-sm" />
                <Bar className="mt-2 h-3 w-48" />
              </div>
              <div className="flex items-center gap-2">
                {[0, 1, 2].map((n) => (
                  <span key={n} aria-hidden className="size-2.5 rounded-full border border-hairline-strong" />
                ))}
              </div>
              <div className="md:justify-self-end">
                <Bar className="h-5 w-28" />
                <Bar className="mt-3 h-[3px] w-full md:w-[170px]" />
              </div>
            </li>
          ))}
        </ol>
      </Panel>
    </main>
  );
}

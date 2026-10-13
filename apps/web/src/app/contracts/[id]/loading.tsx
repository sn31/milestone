import { Panel } from "@/components/ui";

function Bar({ className }: { className: string }) {
  return <span aria-hidden className={`block rounded-chip bg-fg/[0.06] ${className}`} />;
}

/**
 * Loading a contract: its header and the milestone rail drawn as ghosts. Stations are hollow nodes on a dashed line,
 * the way the rail looks before any money has arrived. Only the status dot is live. It fades in after 250ms
 * (.loading-delayed): a warm navigation or a role switch keeps the current page painted instead of flashing it.
 */
export default function Loading() {
  return (
    <main aria-busy="true" aria-live="polite" className="loading-delayed">
      <p className="type-label flex items-center gap-2 text-fg-faint" data-tone="neutral">
        <span className="size-1.5 animate-pulse-dot rounded-full bg-tone" />
        Loading contract
      </p>
      <div className="mt-3 flex flex-col gap-6 md:flex-row md:items-end md:justify-between">
        <div className="min-w-0 flex-1">
          <Bar className="h-10 w-64 sm:h-14 sm:w-[28rem] max-w-full" />
          <Bar className="mt-4 h-3.5 w-56" />
        </div>
        <div>
          <Bar className="h-2.5 w-16 md:ml-auto" />
          <Bar className="mt-3 h-8 w-36" />
        </div>
      </div>

      <div className="mt-12 grid gap-8 lg:grid-cols-[minmax(0,1fr)_320px]">
        <Panel>
          <Bar className="h-2.5 w-24" />
          <ol className="mt-6">
            {[0, 1, 2, 3, 4].map((i) => (
              <li key={i} className="relative grid grid-cols-[28px_minmax(0,1fr)] gap-x-4 pb-8 last:pb-0" style={{ opacity: 1 - i * 0.16 }}>
                <div className="relative flex justify-center pt-[3px]">
                  <span aria-hidden className="relative z-10 size-[22px] rounded-full border border-hairline-strong bg-surface" />
                  {i < 4 ? <span aria-hidden className="absolute top-[28px] -bottom-8 left-1/2 -translate-x-1/2 border-l border-dashed border-hairline-strong" /> : null}
                </div>
                <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
                  <div className="min-w-0 flex-1">
                    <Bar className="h-5 w-3/5 max-w-xs" />
                    <Bar className="mt-2 h-3 w-40" />
                  </div>
                  <Bar className="h-5 w-24" />
                </div>
              </li>
            ))}
          </ol>
        </Panel>
        <div className="grid content-start gap-4">
          <Panel variant="sunken">
            <Bar className="h-2.5 w-20" />
            <Bar className="mt-4 h-3 w-full" />
            <Bar className="mt-2 h-3 w-4/5" />
            <Bar className="mt-2 h-3 w-3/5" />
          </Panel>
          <Panel variant="outline">
            <Bar className="h-2.5 w-28" />
            <Bar className="mt-4 h-9 w-full" />
          </Panel>
        </div>
      </div>
    </main>
  );
}

import { cx, lifecycle, stateMeta, type LifecycleStation, type Phase } from "@/components/ui";

// DESIGN: a horizontal reading of lifecycle(status) inside one rail station. The Rail primitive is vertical only and a
// milestone's own five-stop lifecycle would double the page height, so this draws the same nodes and connectors
// (done solid, current ringed with glow-tone, upcoming dashed) on one line. Tokens and tone utilities only.

const SHORT: Record<string, string> = {
  draft: "Draft",
  funded: "Funded",
  verifying: "Verifying",
  review: "Review",
  released: "Released",
  held: "Held",
  needs_client: "Needs client",
  partial_released: "Partial",
};

function Dot({ phase, live }: { phase: Phase; live: boolean }) {
  if (phase === "current") {
    return (
      <span className="grid size-3 shrink-0 place-items-center rounded-full border border-[color:var(--tone)] bg-bg glow-tone">
        <span className={cx("size-1.5 rounded-full bg-tone", live && "animate-pulse-dot")} />
      </span>
    );
  }
  if (phase === "done") return <span className="size-2 shrink-0 rounded-full bg-tone" />;
  return <span className="size-2 shrink-0 rounded-full border border-hairline-strong bg-bg" />;
}

/** The connector after a node: solid once the money has passed, a fade from the state colour where it sits, dashed ahead. */
function Line({ phase }: { phase: Phase }) {
  return (
    <span
      aria-hidden
      className={cx(
        "mx-1 h-px min-w-2 flex-1",
        phase === "done" && "bg-[color-mix(in_oklab,var(--tone)_55%,transparent)]",
        phase === "current" && "bg-[linear-gradient(to_right,var(--tone),var(--hairline-strong))]",
        phase === "upcoming" && "border-t border-dashed border-hairline-strong",
      )}
    />
  );
}

function Stop({ s, last, labelAlways }: { s: LifecycleStation; last: boolean; labelAlways?: boolean }) {
  const live = s.state === "verifying" && s.phase === "current";
  return (
    <li data-tone={s.tone} className="flex min-w-0 flex-col gap-1.5" aria-current={s.phase === "current" ? "step" : undefined}>
      <span className="flex items-center">
        <Dot phase={s.phase} live={live} />
        {!last ? <Line phase={s.phase} /> : null}
      </span>
      <span
        className={cx(
          "truncate font-mono text-[9.5px] leading-none tracking-[0.08em] uppercase",
          s.phase === "current" ? "text-tone" : s.phase === "done" ? "text-fg-muted" : "text-fg-faint",
          s.phase !== "current" && !labelAlways && "max-sm:sr-only",
        )}
      >
        {SHORT[s.state] ?? s.label}
      </span>
    </li>
  );
}

/**
 * Where this milestone's money is in its lifecycle: draft, funded, verifying, review, released on the main line, with
 * held / needs client / partial dropping onto a side track under verifying.
 */
export function LifecycleTrack({ status, className }: { status: string; className?: string }) {
  const stations = lifecycle(status);
  const main = stations.filter((s) => !s.branch);
  const side = stations.filter((s) => s.branch);
  return (
    <div className={cx("relative", className)} aria-label={`Lifecycle: ${stateMeta(status).label}`} role="group">
      <ol className="grid grid-cols-5">
        {main.map((s, i) => (
          <Stop key={s.state} s={s} last={i === main.length - 1} />
        ))}
      </ol>
      {side.length > 0 ? (
        <div className="grid grid-cols-5">
          {/* The side track drops from the verifying node (column 3). */}
          <div className="col-span-3 col-start-3 flex items-start">
            <svg aria-hidden data-tone={side[0]!.tone} viewBox="0 0 22 18" className="ml-[3px] h-[18px] w-[22px] shrink-0 overflow-visible" fill="none">
              <path d="M1 0 C1 9, 5 11, 20 11" stroke="var(--tone)" strokeWidth="1.25" strokeLinecap="round" opacity="0.8" />
            </svg>
            <ol className="mt-[7px] flex min-w-0 flex-1 items-center gap-0">
              {side.map((s, i) => (
                <li key={s.state} data-tone={s.tone} className="flex min-w-0 items-center gap-1.5" aria-current={s.phase === "current" ? "step" : undefined}>
                  {i > 0 ? <span aria-hidden className="h-px w-4 bg-[color-mix(in_oklab,var(--tone)_55%,transparent)]" /> : null}
                  <Dot phase={s.phase} live={false} />
                  <span className={cx("font-mono text-[9.5px] leading-none tracking-[0.08em] whitespace-nowrap uppercase", s.phase === "current" ? "text-tone" : "text-fg-muted")}>
                    {SHORT[s.state] ?? s.label}
                  </span>
                </li>
              ))}
            </ol>
          </div>
        </div>
      ) : null}
      <span className="sr-only">{stateMeta(status).money}</span>
    </div>
  );
}

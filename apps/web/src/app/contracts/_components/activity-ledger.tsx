import { Reveal, StateGlyph } from "@/components/ui";
import { auditTime, eventGlyph, eventParts, eventTone } from "@/lib/events";

export interface ActivityItem {
  id: string;
  at: Date;
  event: string;
  milestone: string | null;
  actor: string;
}

/**
 * The newest audit events on a contract as a compact mono ledger: time, event, milestone, actor. Same tones, glyphs and
 * time format as the full audit grid (src/lib/events.ts).
 */
export function ActivityLedger({ items }: { items: ActivityItem[] }) {
  return (
    <ol className="divide-y divide-hairline">
      {items.map((a, i) => {
        const { ns, verb } = eventParts(a.event);
        const tone = eventTone(a.event);
        const m = a.milestone ? /^(\d+)\s+(.*)$/.exec(a.milestone) : null;
        return (
          <Reveal as="li" key={a.id} index={i}>
            <div
              data-tone={tone}
              className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-4 gap-y-1 px-4 py-2.5 sm:px-5 md:grid-cols-[150px_minmax(0,1fr)_minmax(0,240px)_150px]"
            >
              <time dateTime={a.at.toISOString()} className="order-2 font-mono text-[12px] text-fg-muted tabular md:order-none">
                {auditTime(a.at)}
              </time>
              <p className="order-1 flex min-w-0 items-center gap-2 font-mono text-[12px] md:order-none">
                <StateGlyph glyph={eventGlyph(a.event)} className="shrink-0 text-tone" />
                <span className="truncate">
                  {ns ? <span className="text-fg-faint">{ns}.</span> : null}
                  <span className={tone === "danger" ? "text-tone" : "text-fg"}>{verb}</span>
                </span>
              </p>
              <p className="order-3 min-w-0 truncate pl-[18px] text-[12.5px] text-fg-muted md:order-none md:pl-0">
                {m ? <span className="mr-2 font-mono text-[11px] text-fg-faint tabular">{m[1].padStart(2, "0")}</span> : null}
                {m ? m[2] : (a.milestone ?? <span className="font-mono text-[12px] text-fg-faint">contract</span>)}
              </p>
              <p className="order-4 truncate text-right text-[12.5px] text-fg-muted md:order-none">{a.actor}</p>
            </div>
          </Reveal>
        );
      })}
    </ol>
  );
}

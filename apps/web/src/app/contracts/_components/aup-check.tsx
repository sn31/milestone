import { StateGlyph, cx, type GlyphKey, type ToneKey } from "@/components/ui";
import type { AupView } from "@/lib/aup";
import { formatDateTime } from "@/lib/format";
import { AupRefresh } from "./aup-refresh";

const LOOK: Record<AupView["tone"], { tone: ToneKey; glyph: GlyphKey }> = {
  clear: { tone: "released", glyph: "check" },
  keywords: { tone: "funded", glyph: "hollow-dot" },
  checking: { tone: "verifying", glyph: "pulse" },
  review: { tone: "held", glyph: "pause" },
  rejected: { tone: "danger", glyph: "cross" },
  unchecked: { tone: "draft", glyph: "ring" },
};

/** What the check was, in a few words: who read the contract. */
function how(v: AupView): string {
  if (v.status === "checking") return "keyword pass done, Claude is reading the contract";
  if (v.recorded) return "recorded for the showcase";
  if (v.mode === "keywords") return "keyword pass only: no model configured";
  if (v.mode === "model_error") return "the model call failed, so a person decides";
  if (v.mode === "model") return `keywords and ${v.model ?? "Claude"}`;
  return "not checked yet";
}

/**
 * The compact "PayPal AUP check" line on a contract: status, how it was checked and, for each flag, the policy section,
 * the category and the contract words it quotes. The quotes are the parties' own words, shown as quotes. While the
 * check runs the page refreshes itself.
 */
export function AupCheck({ view, refusedNow }: { view: AupView; refusedNow?: string | null }) {
  const look = LOOK[view.tone];
  const blocked = !view.allowsSigningAndFunding;
  return (
    <section aria-label="PayPal AUP check" data-tone={look.tone} className="rounded-panel border border-hairline bg-surface-sunken px-4 py-3 sm:px-5">
      {view.status === "checking" ? <AupRefresh /> : null}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <p className="type-label shrink-0 text-fg-faint">PayPal AUP check</p>
        <span className="inline-flex items-center gap-1.5 font-mono text-[11px] tracking-[0.08em] text-tone uppercase">
          <StateGlyph glyph={look.glyph} className="size-[9px]" />
          {view.label}
        </span>
        <span className="text-[12.5px] text-fg-muted">{how(view)}</span>
        {view.checkedAt ? <span className="font-mono text-[11px] text-fg-faint tabular">{formatDateTime(new Date(view.checkedAt))}</span> : null}
        <a href={view.policy.url} target="_blank" rel="noreferrer" className="font-mono text-[11px] text-fg-faint underline decoration-hairline-strong underline-offset-2 hover:text-fg sm:ml-auto">
          policy retrieved {view.policy.retrievedOn}
        </a>
      </div>
      {blocked && view.status !== "checking" ? <p className="mt-2 text-[13px] text-fg-muted">Signing and funding are paused: {view.refusal}.</p> : null}
      {refusedNow ? <p className="mt-2 text-[13px] text-tone">That was refused: {refusedNow}.</p> : null}
      {view.error ? <p className="mt-2 font-mono text-[12px] text-fg-faint">model: {view.error}</p> : null}
      {view.flags.length ? (
        <ul className="mt-2.5 grid gap-2">
          {view.flags.map((f, i) => (
            <li key={`${f.category}-${i}`} className="grid gap-0.5 text-[13px] sm:grid-cols-[minmax(0,16rem)_minmax(0,1fr)] sm:gap-4">
              <span className="min-w-0">
                <span className="block text-fg">{f.name}</span>
                <span className="block font-mono text-[10.5px] tracking-[0.06em] text-fg-faint uppercase">
                  {f.section} · {f.source === "keywords" ? "keyword" : `model ${Math.round(f.confidence * 100)}%`}
                </span>
              </span>
              <span className="min-w-0">
                <q className={cx("block truncate font-mono text-[12.5px] text-fg-muted")} title={f.quote}>
                  {f.quote}
                </q>
                {f.source === "model" && f.rationale ? <span className="block text-[12.5px] text-fg-faint">{f.rationale}</span> : null}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {view.resolution ? (
        <p className="mt-2 text-[12.5px] text-fg-muted">
          {view.resolution.action === "clear" ? "Cleared" : "Rejected"} by an operator {formatDateTime(new Date(view.resolution.at))}: {view.resolution.note}
        </p>
      ) : null}
    </section>
  );
}

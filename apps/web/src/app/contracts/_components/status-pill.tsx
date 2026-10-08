import { humanize, statusTone, TONE_CLASSES, TONE_DOT } from "@/lib/format";

/** Status badge with a distinct colour per contract or milestone status. */
export function StatusPill({ status, size = "sm" }: { status: string; size?: "sm" | "md" }) {
  const tone = statusTone(status);
  const pad = size === "md" ? "px-2.5 py-1 text-xs" : "px-2 py-0.5 text-[11px]";
  return (
    <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-full font-medium uppercase tracking-wide ring-1 ring-inset ${pad} ${TONE_CLASSES[tone]}`}>
      <span aria-hidden className={`size-1.5 rounded-full ${TONE_DOT[tone]}`} />
      {humanize(status)}
    </span>
  );
}

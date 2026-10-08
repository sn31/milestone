// Server only: how an audit row's detail is shown on the audit log (node:crypto for the redaction hashes).
import { createHash } from "node:crypto";

const sha256 = (v: unknown) => createHash("sha256").update(JSON.stringify(v ?? null)).digest("hex");

/**
 * dispute.drafted carries the evidence pack and the freelancer's unsent draft. Only the contract's freelancer sees them
 * here; everyone else gets the hashes, which still prove what was drafted and when.
 */
export function redactDetail(event: string, detail: unknown, canSeeDraft: boolean): unknown {
  if (event !== "dispute.drafted" || canSeeDraft) return detail;
  const d = detail && typeof detail === "object" && !Array.isArray(detail) ? (detail as Record<string, unknown>) : {};
  return {
    ...(typeof d.disputeId === "string" ? { disputeId: d.disputeId } : {}),
    packHash: typeof d.packHash === "string" ? d.packHash : sha256(d.pack),
    draftHash: typeof d.draftHash === "string" ? d.draftHash : sha256(d.draft),
    redacted: true,
  };
}

/** Whether there is anything to open: not null, and not an empty object. */
export const hasDetail = (d: unknown) => d !== null && d !== undefined && !(typeof d === "object" && Object.keys(d as object).length === 0);

/** The grid's Detail column ships this, not the detail itself: the full object is fetched when a row is opened. */
export const SUMMARY_MAX = 200;

/** `key=value  key=value`, nested values as JSON, cut to SUMMARY_MAX characters. */
export function summarizeDetail(detail: unknown): string {
  if (detail === null || detail === undefined) return "";
  const text =
    typeof detail !== "object"
      ? String(detail)
      : Object.entries(detail as Record<string, unknown>)
          .map(([k, v]) => `${k}=${typeof v === "object" && v !== null ? JSON.stringify(v) : String(v)}`)
          .join("  ");
  return text.length > SUMMARY_MAX ? `${text.slice(0, SUMMARY_MAX - 1)}…` : text;
}

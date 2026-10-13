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

// Pure and client-safe: how the contract page reads a milestone snapshot (no database imports here).
import type { LogLine } from "@/components/ui/log-stream";
import { eventTone } from "@/lib/events";
import type { MilestoneSnapshot } from "./snapshot";

/** Everything that, when it changes, means the server page would render differently. */
export function signature(s: MilestoneSnapshot): string {
  return [s.status, s.decidedAt, s.reviewEndsAt, s.delivery?.id, s.delivery?.verifiedAt, s.delivery?.evidenceCount, s.auditId, s.pendingOp?.kind, s.pendingOp?.status].join("|");
}

const hhmmss = (iso: string) => iso.slice(11, 19);
const EVIDENCE_TONE: Record<string, "ok" | "err" | "needs"> = { pass: "ok", fail: "err", unclear: "needs" };

/** The lines that arrive while verifying: audit events and, once the deterministic stage is stored, its evidence. */
export function verifierLines(s: MilestoneSnapshot): LogLine[] {
  const events = s.events.filter((e) => !e.event.startsWith("delivery."));
  const evidenceAt = s.delivery?.verifiedAt ?? null;
  const evidence: LogLine[] = s.evidence.map((e) => ({
    at: evidenceAt ? hhmmss(evidenceAt) : undefined,
    text: `${(e.status ?? "seen").padEnd(7, " ")} ${e.kind.padEnd(6, " ")} ${e.summary || e.id}`,
    tone: e.status ? EVIDENCE_TONE[e.status] : undefined,
  }));
  const eventLine = (e: MilestoneSnapshot["events"][number]): LogLine => {
    const tone = eventTone(e.event);
    return { at: hhmmss(e.at), text: e.event, tone: tone === "neutral" || tone === "verifying" ? undefined : tone };
  };
  if (!evidenceAt) return events.map(eventLine);
  const before = events.filter((e) => e.at < evidenceAt).map(eventLine);
  const after = events.filter((e) => e.at >= evidenceAt).map(eventLine);
  return [...before, ...evidence, ...after];
}


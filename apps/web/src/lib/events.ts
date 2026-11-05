import type { GlyphKey, ToneKey } from "@/components/ui/states";

/**
 * Dispute events by name (the patterns below would leave most of them neutral). An open dispute waits on an answer
 * (needs), the drafted pack is a record of that wait, evidence sent waits on PayPal's review, an accepted claim is a
 * refund, and the outcome itself is not in the event name. Violet stays with the verifier at work.
 */
const DISPUTE_EVENTS: Record<string, { tone: ToneKey; glyph?: GlyphKey }> = {
  "dispute.opened": { tone: "needs" },
  "dispute.drafted": { tone: "needs", glyph: "check" },
  "dispute.updated": { tone: "needs" },
  "dispute.evidence_submitted": { tone: "review" },
  "dispute.claim_accepted": { tone: "partial" },
  "dispute.resolved": { tone: "neutral", glyph: "check" },
  "dispute.evidence_failed": { tone: "danger" },
  "dispute.accept_failed": { tone: "danger" },
  "release.blocked_by_dispute": { tone: "held" },
};

/**
 * How an audit event looks everywhere it is listed (the contract page's activity ledger and the full audit grid): the
 * state it belongs to, its glyph and its time. One map, so the same event never changes colour between screens.
 * Violet stays reserved for the verifier at work; a policy decision reads in the review tone it hands over to.
 */
export function eventTone(event: string): ToneKey {
  const known = DISPUTE_EVENTS[event];
  if (known) return known.tone;
  const e = event.toLowerCase();
  if (/fail|error|denied|revers|mismatch|conflict|refused|unmatched|needs_operator|shortfall|injection/.test(e)) return "danger";
  if (/needs_client/.test(e)) return "needs";
  if (/held|veto|client\.hold|waiting|skipped|withdrawn/.test(e)) return "held";
  if (/refund|partial/.test(e)) return "partial";
  if (/released|payout|repaid|settled/.test(e)) return "released";
  // Only the verifier at work is violet; a delivery arriving or a verdict stored is a record, not a live state.
  if (/verifying/.test(e)) return "verifying";
  if (/verdict|delivery|github/.test(e)) return "draft";
  if (/^contract\./.test(e)) return /approved/.test(e) ? "funded" : "draft";
  if (/review|approve|policy|claimed/.test(e)) return "review";
  if (/fund|capture|order|receipt|advance/.test(e)) return "funded";
  return "neutral";
}

const GLYPH_OF: Record<ToneKey, GlyphKey> = {
  draft: "ring",
  funded: "dot",
  verifying: "pulse",
  review: "arc",
  released: "check",
  partial: "half",
  held: "pause",
  needs: "query",
  danger: "cross",
  neutral: "ring",
};

export const eventGlyph = (event: string): GlyphKey => DISPUTE_EVENTS[event]?.glyph ?? GLYPH_OF[eventTone(event)];

/** Splits "milestone.needs_client" into its namespace and verb for the faint/strong rendering. */
export function eventParts(event: string): { ns: string | null; verb: string } {
  const dot = event.indexOf(".");
  return dot > 0 ? { ns: event.slice(0, dot), verb: event.slice(dot + 1) } : { ns: null, verb: event };
}

const TIME = new Intl.DateTimeFormat("en-US", { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, timeZone: "UTC" });
const TIME_SHORT = new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, timeZone: "UTC" });

/** "Oct 08 09:14:53" (UTC; the column head says so), or "09:14:53" where space is short. */
export function auditTime(at: Date | string, short = false): string {
  const d = typeof at === "string" ? new Date(at) : at;
  return Number.isNaN(d.getTime()) ? String(at) : (short ? TIME_SHORT : TIME).format(d).replace(",", "");
}

/** The audit log's system actors, as people read them (user ids go through ACTOR_NAMES). */
export const SYSTEM_ACTOR_NAMES: Record<string, string> = { paypal: "PayPal", policy: "Policy", verifier: "Verifier", system: "System", worker: "Worker" };

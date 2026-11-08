import { RECORDED_SHOWCASE_REASON, RECORDED_SHOWCASE_TEXT, recordedForShowcase } from "@milestone/core";
import { jsonError } from "@/lib/http";

/**
 * 409 for an action on a milestone the showcase seed recorded with simulator PayPal ids, when this host talks to the
 * real PayPal sandbox (core recordedForShowcase); null when the action may go ahead. Routes call it before anything is
 * written or queued.
 */
export function recordedRefusal(m: { paypalOrderId: string | null; paypalCaptureId: string | null }, env: NodeJS.ProcessEnv = process.env): Response | null {
  return recordedForShowcase(m, env) ? jsonError(RECORDED_SHOWCASE_TEXT, 409, { reason: RECORDED_SHOWCASE_REASON }) : null;
}

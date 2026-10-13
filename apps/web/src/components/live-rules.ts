import type { MilestoneSnapshot } from "@/app/api/milestones/[id]/status/snapshot";

// Pure and safe on both sides: whether a delivery is still waiting for its verdict. The status snapshot counts such a
// milestone as live, and the deliver form shows "waiting for the verifier" instead of asking for another delivery.

/**
 * How long a delivery without a verdict keeps its milestone live. The worker usually picks a delivery up within seconds
 * and a verdict takes minutes; a delivery still unverified after this long is stuck (a failed job, a milestone the
 * worker refuses), and the page stops polling for it instead of polling forever.
 */
export const AWAITING_VERDICT_MS = 30 * 60_000;

/**
 * The latest delivery is in but the verifier has not stored a verdict yet. This holds before the worker moves the
 * milestone to verifying (it is still funded or held then), so the page must watch it regardless of status.
 */
export function awaitingVerdict(
  delivery: { result: string | null; receivedAt: Date | string; verifiedAt?: Date | string | null } | null | undefined,
  now: number = Date.now(),
): boolean {
  if (!delivery) return false;
  if (delivery.result || delivery.verifiedAt) return false;
  const at = typeof delivery.receivedAt === "string" ? Date.parse(delivery.receivedAt) : delivery.receivedAt.getTime();
  if (!Number.isFinite(at)) return false;
  return now - at < AWAITING_VERDICT_MS;
}

/** A milestone whose only motion is its review window running out is checked this often (the client may act elsewhere). */
export const REVIEW_EVERY_MS = 30_000;
/** How long after a review window closes to look again: the release job needs a moment to claim the payout. */
export const WINDOW_END_SLACK_MS = 1_500;
/** A funded or held milestone waiting on the other party's delivery is checked this often. */
export const WATCH_EVERY_MS = 5_000;

/** A review whose window is still open with nothing else in flight: it needs a look now and then, and one at the end. */
export function waitingOnWindow(s: MilestoneSnapshot, now: number): boolean {
  // Once the client has answered (approve early), the release job is about to move it: not a quiet wait any more.
  const answered = s.events.some((e) => e.event.startsWith("client."));
  return s.status === "review" && !answered && s.pendingOp === null && s.reviewEndsAt !== null && Date.parse(s.reviewEndsAt) > now;
}

/** Funded or held with nothing in flight: only watched for the other party's next delivery. */
export function waitingOnDelivery(s: MilestoneSnapshot, now: number): boolean {
  return (s.status === "funded" || s.status === "held") && s.pendingOp === null && !awaitingVerdict(s.delivery, now);
}

/**
 * How long to wait before polling these live snapshots: `every` while anything moves on its own; 5 s when the rest only
 * waits for a delivery; when they are all open reviews, 30 s or until the first window closes.
 */
export function nextWait(live: readonly MilestoneSnapshot[], every: number, now = Date.now()): number {
  if (live.length === 0 || !live.every((s) => waitingOnWindow(s, now) || waitingOnDelivery(s, now))) return every;
  const windows = live.filter((s) => waitingOnWindow(s, now));
  const base = windows.length < live.length ? Math.max(every, WATCH_EVERY_MS) : Math.max(every, REVIEW_EVERY_MS);
  if (windows.length === 0) return base;
  const firstEnd = Math.min(...windows.map((s) => Date.parse(s.reviewEndsAt!)));
  return Math.min(base, firstEnd - now + WINDOW_END_SLACK_MS);
}


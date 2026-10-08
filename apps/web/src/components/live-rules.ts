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

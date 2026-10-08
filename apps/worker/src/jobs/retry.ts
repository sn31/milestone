import type { JobWithMetadata } from "pg-boss";
import { PayPalError } from "@milestone/money";

/** How long a claim belongs to the job that made it before another job may resume its unanswered PayPal calls. */
export const LEASE_MS = 120_000;

/** enqueue() in @milestone/core sends every job with retryLimit 5; used when the job carries no retryLimit metadata. */
export const DEFAULT_RETRY_LIMIT = 5;

/** True on the job's last pg-boss attempt (retryCount counts retries; retryLimit falls back to enqueue's default). */
export function isLastAttempt(job: Partial<Pick<JobWithMetadata, "retryCount" | "retryLimit">>, defaultLimit = DEFAULT_RETRY_LIMIT): boolean {
  return (job.retryCount ?? 0) >= (job.retryLimit ?? defaultLimit);
}

/**
 * Whether a failed PayPal call is final. "rejected": PayPal answered with a 4xx other than 409 (in progress / conflict)
 * or 429 (rate limited), so the request was refused and retrying it cannot succeed. "last_attempt": any other error on
 * the job's last retry. null: throw, and pg-boss retries with the same PayPal-Request-Id.
 */
export function paypalFailure(err: unknown, lastAttempt: boolean): "rejected" | "last_attempt" | null {
  // 401/403 are our credentials or config, not PayPal rejecting this payout: retry, do not flag the milestone for good.
  if (err instanceof PayPalError && err.status >= 400 && err.status < 500 && ![401, 403, 409, 429].includes(err.status)) return "rejected";
  return lastAttempt ? "last_attempt" : null;
}

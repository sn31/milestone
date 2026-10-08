/** Deterministic ids. */
import { createHash } from "node:crypto";

/**
 * The delivery id of a commit delivery: the same milestone and commit always map to the same row, whether it came from
 * the GitHub webhook or the deliver route, so a repeat is a no-op insert.
 */
export function commitDeliveryId(milestoneId: string, sha: string): string {
  return `dlv_${createHash("sha256").update(`${milestoneId}:${sha}`).digest("hex").slice(0, 24)}`;
}

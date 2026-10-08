import { getDb } from "@/lib/db";
import { ReviewPanel, type ReviewPanelProps } from "./review-card-panel";

const DEFAULT_WINDOW_SECONDS = 172_800;
const MIN_REVIEW_WINDOW_SECONDS = 30;

/** Same choice as the worker's reviewWindowSeconds() (apps/worker/src/jobs/verify.ts): the env override, else the contract's. */
function reviewWindowSeconds(contractWindow: number, override = process.env.REVIEW_WINDOW_SECONDS): number {
  const env = Number(override);
  const chosen = override !== undefined && override.trim() !== "" && Number.isFinite(env) ? Math.floor(env) : contractWindow;
  return Math.max(MIN_REVIEW_WINDOW_SECONDS, Number.isFinite(chosen) ? chosen : MIN_REVIEW_WINDOW_SECONDS);
}

export type ReviewCardProps = Omit<ReviewPanelProps, "windowSeconds"> & {
  /** Length of the review window in seconds. Looked up from the contract (and REVIEW_WINDOW_SECONDS) when left out. */
  windowSeconds?: number;
};

/**
 * The client's decision point on a milestone in review or needs_client. Server side it works out how long the review
 * window is (for the countdown ring); the interactive part is ReviewPanel.
 */
export async function ReviewCard(props: ReviewCardProps) {
  let windowSeconds = props.windowSeconds;
  if (windowSeconds === undefined && props.status === "review") {
    const db = getDb();
    const m = await db.query.milestones.findFirst({ columns: { contractId: true }, where: (t, { eq }) => eq(t.id, props.milestoneId) });
    const c = m ? await db.query.contracts.findFirst({ columns: { reviewWindowSeconds: true }, where: (t, { eq }) => eq(t.id, m.contractId) }) : undefined;
    windowSeconds = reviewWindowSeconds(c?.reviewWindowSeconds ?? DEFAULT_WINDOW_SECONDS);
  }
  return <ReviewPanel {...props} windowSeconds={windowSeconds ?? DEFAULT_WINDOW_SECONDS} />;
}

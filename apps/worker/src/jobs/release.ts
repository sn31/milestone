import type { Job } from "pg-boss";
import type { JobData } from "../handlers.js";

/** Oct 17: applyReviewWindow, then executeRelease; the state waits for the payout webhook */
export async function release(job: Job<JobData>): Promise<void> {
  throw new Error(`${job.name} handler not written yet (sprint plan: Oct 17: applyReviewWindow, then executeRelease; the state waits for the payout webhook)`);
}

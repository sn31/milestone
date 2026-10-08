import type { Job } from "pg-boss";
import type { JobData } from "../handlers.js";

/** Oct 15 to 17: deterministic stage -> judge -> store verdict on the delivery -> decide() -> PR comment -> schedule release after the review window */
export async function verify(job: Job<JobData>): Promise<void> {
  throw new Error(`${job.name} handler not written yet (sprint plan: Oct 15 to 17: deterministic stage -> judge -> store verdict on the delivery -> decide() -> PR comment -> schedule release after the review window)`);
}

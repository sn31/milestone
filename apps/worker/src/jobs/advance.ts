import type { Job } from "pg-boss";
import type { JobData } from "../handlers.js";

/** Week 4: price, explain, fundAdvance, open the receivable */
export async function advance(job: Job<JobData>): Promise<void> {
  throw new Error(`${job.name} handler not written yet (sprint plan: Week 4: price, explain, fundAdvance, open the receivable)`);
}

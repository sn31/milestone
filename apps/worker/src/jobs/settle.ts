import type { Job } from "pg-boss";
import type { JobData } from "../handlers.js";

/** Oct 17: on PAYMENT.PAYOUTS-ITEM.SUCCEEDED: ledger, receipt invoice, state to released */
export async function settle(job: Job<JobData>): Promise<void> {
  throw new Error(`${job.name} handler not written yet (sprint plan: Oct 17: on PAYMENT.PAYOUTS-ITEM.SUCCEEDED: ledger, receipt invoice, state to released)`);
}

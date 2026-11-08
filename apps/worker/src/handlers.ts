import type { Job } from "pg-boss";
import type { JobName } from "@milestone/core";
import { verify } from "./jobs/verify.ts";
import { release } from "./jobs/release.ts";
import { settle } from "./jobs/settle.ts";
import { advance } from "./jobs/advance.ts";
import { dispute } from "./jobs/dispute.ts";
import { reconcile } from "./jobs/reconcile.ts";
import { autofund } from "./jobs/autofund.ts";
import { aup } from "./jobs/aup.ts";

export type JobData = { milestoneId: string } & Record<string, unknown>;
export type Handler = (job: Job<JobData>) => Promise<void>;

export const handlers: Record<JobName, Handler> = { verify, release, settle, advance, dispute, reconcile, autofund, aup };

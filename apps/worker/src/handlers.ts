import type { Job } from "pg-boss";
import type { JobName } from "@milestone/core";
import { verify } from "./jobs/verify.js";
import { release } from "./jobs/release.js";
import { settle } from "./jobs/settle.js";
import { advance } from "./jobs/advance.js";

export type JobData = { milestoneId: string } & Record<string, unknown>;
export type Handler = (job: Job<JobData>) => Promise<void>;

export const handlers: Record<JobName, Handler> = { verify, release, settle, advance };

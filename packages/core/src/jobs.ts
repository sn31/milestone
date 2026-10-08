/** Jobs live in Postgres (pg-boss): no second service, delayed jobs for the review window, retries with backoff. */
import { PgBoss, type SendOptions } from "pg-boss";
import { JobName } from "./schemas.ts";

let boss: PgBoss | null = null;

export async function jobs(url = process.env.DATABASE_URL): Promise<PgBoss> {
  if (boss) return boss;
  if (!url) throw new Error("DATABASE_URL is required");
  const b = new PgBoss({ connectionString: url, schema: "jobs" });
  await b.start();
  for (const name of JobName.options) {
    if (!(await b.getQueue(name))) await b.createQueue(name, { policy: "stately" });
  }
  boss = b;
  return b;
}

/**
 * One job per (queue, milestone, dedupe key): on a "stately" queue pg-boss's singletonKey makes a second enqueue
 * a no-op while the first is queued or running, so a retried webhook never runs the same work twice.
 */
export async function enqueue(name: JobName, milestoneId: string, data: Record<string, unknown>, opts: { dedupe?: string; delaySeconds?: number } = {}) {
  const b = await jobs();
  const options: SendOptions = { singletonKey: `${milestoneId}:${opts.dedupe ?? "once"}`, retryLimit: 5, retryBackoff: true };
  if (opts.delaySeconds !== undefined) options.startAfter = opts.delaySeconds;
  return b.send(name, { milestoneId, ...data }, options);
}

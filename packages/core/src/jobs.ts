/** Jobs live in Postgres (pg-boss): no second service, delayed jobs for the review window, retries with backoff. */
import { PgBoss, type SendOptions } from "pg-boss";
import { JobName } from "./schemas.ts";

/**
 * "worker" (the default) runs pg-boss's supervision and cron scheduling and creates the queues; "sender" (web, scripts)
 * only sends: no maintenance timers, no queue creation (the worker creates the queues).
 */
export type JobsRole = "worker" | "sender";

// On globalThis so Next.js HMR (which re-evaluates modules) reuses the one started instance.
const g = globalThis as typeof globalThis & { __milestoneJobs?: Promise<PgBoss> };

async function start(url: string, role: JobsRole): Promise<PgBoss> {
  const b = new PgBoss({ connectionString: url, schema: "jobs", ...(role === "sender" ? { supervise: false, schedule: false } : {}) });
  await b.start();
  if (role === "worker") {
    const existing = new Set((await b.getQueues([...JobName.options])).map((q) => q.name));
    await Promise.all(JobName.options.filter((name) => !existing.has(name)).map((name) => b.createQueue(name, { policy: "stately" })));
  }
  return b;
}

/**
 * The process's pg-boss instance, started once (concurrent first calls share one start). The first call's role wins;
 * a failed start is forgotten so the next call retries. Accepts a connection string for the old jobs(url) form.
 */
export function jobs(opts: { role?: JobsRole; url?: string } | string = {}): Promise<PgBoss> {
  if (g.__milestoneJobs) return g.__milestoneJobs;
  const o = typeof opts === "string" ? { url: opts } : opts;
  const url = o.url ?? process.env.DATABASE_URL;
  if (!url) return Promise.reject(new Error("DATABASE_URL is required"));
  const p = start(url, o.role ?? "worker");
  g.__milestoneJobs = p;
  p.catch(() => {
    if (g.__milestoneJobs === p) delete g.__milestoneJobs;
  });
  return p;
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

import type { Job } from "pg-boss";
import { JobName, jobs } from "@milestone/core";
import { handlers, type JobData } from "./handlers.js";

try { process.loadEnvFile(new URL("../../../.env", import.meta.url).pathname); } catch { /* env already set */ }

const boss = await jobs();
boss.on("error", (err) => console.error("pg-boss:", err));
for (const name of JobName.options) {
  await boss.work<JobData>(name, { batchSize: 1, includeMetadata: true }, async (batch: Job<JobData>[]) => {
    for (const job of batch) {
      await handlers[name](job);
      console.log(`[${name}] ${job.id} done`);
    }
  });
}
console.log(`worker up: ${JobName.options.join(", ")}`);

const stop = async () => { await boss.stop({ graceful: true }); process.exit(0); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

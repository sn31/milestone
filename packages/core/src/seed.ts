/** pnpm db:seed. Idempotent: every row has a fixed id and is upserted. */
import { sql } from "drizzle-orm";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createDb } from "./db.js";
import { auditLog, contracts, criteria, milestones, users } from "./schema.js";

try {
  process.loadEnvFile(resolve(dirname(fileURLToPath(import.meta.url)), "../../../.env"));
} catch {
  // no .env, rely on process.env
}

const db = createDb();

const userRows = [
  { id: "usr_client", role: "client" as const, name: "Casey Client", email: "client@milestone.test" },
  { id: "usr_freelancer", role: "freelancer" as const, name: "Frankie Freelancer", email: "freelancer@milestone.test", githubLogin: "milestone-demo" },
  { id: "usr_partner", role: "partner" as const, name: "Parker Partner", email: "partner@milestone.test" },
  { id: "usr_platform", role: "platform" as const, name: "Milestone Platform", email: "platform@milestone.test" },
];
for (const u of userRows) {
  await db.insert(users).values(u).onConflictDoUpdate({ target: users.id, set: { role: u.role, name: u.name, email: u.email, githubLogin: u.githubLogin ?? null } });
}

const now = new Date();
const contract = {
  id: "ctr_demo",
  clientId: "usr_client",
  freelancerId: "usr_freelancer",
  title: "Signup flow for a SaaS landing page",
  scopeText: "Build a signup flow for a SaaS landing page: form, validation, confirmation page, in three milestones.",
  currency: "USD",
  totalMinor: 30000,
  repoFullName: "milestone-demo/landing",
  status: "active" as const,
  clientApprovedAt: now,
  freelancerApprovedAt: now,
};
const { id: _cid, ...contractSet } = contract;
await db.insert(contracts).values(contract).onConflictDoUpdate({ target: contracts.id, set: contractSet });

const titles = ["Signup form and validation", "Account creation API and confirmation page", "Polish, accessibility and docs"];
const criteriaRows: (typeof criteria.$inferInsert)[] = [];
for (let n = 1; n <= 3; n++) {
  const m = { id: `mst_${n}`, contractId: "ctr_demo", seq: n, title: titles[n - 1]!, amountMinor: 10000, status: "draft" as const, advanceEligible: n <= 2 };
  const { id: _mid, ...mSet } = m;
  await db.insert(milestones).values(m).onConflictDoUpdate({ target: milestones.id, set: mSet });
  criteriaRows.push(
    { id: `crt_${n}_tests`, milestoneId: m.id, kind: "test", description: "The test suite passes", spec: { command: "npm test" }, required: true },
    { id: `crt_${n}_file`, milestoneId: m.id, kind: "file", description: "Expected source file exists", spec: { path: ["src/signup.tsx", "src/api/signup.ts", "README.md"][n - 1] }, required: true },
    { id: `crt_${n}_judge`, milestoneId: m.id, kind: "judgment", description: "The delivery matches the milestone description", spec: {}, required: false },
  );
}
for (const c of criteriaRows) {
  await db.insert(criteria).values(c).onConflictDoUpdate({ target: criteria.id, set: { milestoneId: c.milestoneId, kind: c.kind, description: c.description, spec: c.spec, required: c.required } });
}

// Freelancer history: five past releases with a verified pass. Fixed ids keep reseeding a no-op.
for (let i = 1; i <= 5; i++) {
  await db.insert(auditLog).values({
    id: `aud_hist_${i}`,
    actor: "paypal",
    event: "milestone.released",
    detail: { freelancerId: "usr_freelancer", verifiedPass: true, amountMinor: 10000, currency: "USD", historical: true },
    createdAt: new Date(now.getTime() - i * 14 * 86_400_000),
  }).onConflictDoNothing();
}

const [row] = (await db.execute(sql`select count(*)::int as n from audit_log where event = 'milestone.released'`)).rows as { n: number }[];
const n = row?.n ?? 0;
console.log(`seed ok: ${userRows.length} users, 1 contract, 3 milestones, ${criteriaRows.length} criteria, ${n} release events`);
process.exit(0);

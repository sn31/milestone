/** pnpm db:seed. Idempotent: every row has a fixed id and is upserted. */
import { sql } from "drizzle-orm";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createDb } from "./db.ts";
import { auditLog, contracts, criteria, milestones, users } from "./schema.ts";

try {
  process.loadEnvFile(resolve(dirname(fileURLToPath(import.meta.url)), "../../../.env"));
} catch {
  // no .env, rely on process.env
}

const db = createDb();

const userRows = [
  { id: "usr_client", role: "client" as const, name: "Casey Client", email: "client@milestone.test" },
  { id: "usr_freelancer", role: "freelancer" as const, name: "Frankie Freelancer", email: "freelancer@milestone.test", githubLogin: "milestone-demo", paypalEmail: process.env.PAYPAL_FREELANCER_EMAIL ?? process.env.SPIKE_FREELANCER_EMAIL ?? null },
  { id: "usr_partner", role: "partner" as const, name: "Parker Partner", email: "partner@milestone.test", paypalEmail: process.env.PAYPAL_PARTNER_EMAIL ?? null },
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
    { id: `crt_${n}_file`, milestoneId: m.id, kind: "file", description: "Expected source file exists", spec: { path: ["src/password.js", "public/pricing.html", "README.md"][n - 1] }, required: true },
    { id: `crt_${n}_judge`, milestoneId: m.id, kind: "judgment", description: "The delivery matches the milestone description", spec: {}, required: false },
  );
}
for (const c of criteriaRows) {
  await db.insert(criteria).values(c).onConflictDoUpdate({ target: criteria.id, set: { milestoneId: c.milestoneId, kind: c.kind, description: c.description, spec: c.spec, required: c.required } });
}

// A non-code contract: deliveries are uploaded files checked by the upload stage (format, size, pixels, pages, words).
const brand = {
  id: "ctr_brand",
  clientId: "usr_client",
  freelancerId: "usr_freelancer",
  title: "Brand refresh for a bakery",
  scopeText: "Refresh the brand of a neighbourhood bakery: a new logo with a colour system and a short style guide, then the website copy.",
  currency: "USD",
  totalMinor: 15000,
  repoFullName: null,
  status: "active" as const,
  clientApprovedAt: now,
  freelancerApprovedAt: now,
};
const { id: _bid, ...brandSet } = brand;
await db.insert(contracts).values(brand).onConflictDoUpdate({ target: contracts.id, set: brandSet });

const brandMilestones = [
  { id: "mst_brand_1", contractId: "ctr_brand", seq: 1, title: "Logo and colour system", amountMinor: 9000, status: "draft" as const, advanceEligible: true },
  { id: "mst_brand_2", contractId: "ctr_brand", seq: 2, title: "Website copy", amountMinor: 6000, status: "draft" as const, advanceEligible: true },
];
for (const m of brandMilestones) {
  const { id: _mid, ...mSet } = m;
  await db.insert(milestones).values(m).onConflictDoUpdate({ target: milestones.id, set: mSet });
}
criteriaRows.push(
  { id: "crt_brand_1_logo", milestoneId: "mst_brand_1", kind: "upload", description: "Logo as an SVG or a PNG at least 1024 px wide", spec: { pattern: "*.{svg,png}", minWidth: 1024 }, required: true },
  { id: "crt_brand_1_guide", milestoneId: "mst_brand_1", kind: "upload", description: "PDF style guide of at most 12 pages with a Typography section", spec: { pattern: "*.pdf", format: "pdf", maxPages: 12, mustContain: ["Typography"] }, required: true },
  { id: "crt_brand_1_judge", milestoneId: "mst_brand_1", kind: "judgment", description: "The logo reads clearly at small sizes and the colour system suits a neighbourhood bakery", spec: {}, required: false },
  { id: "crt_brand_2_copy", milestoneId: "mst_brand_2", kind: "upload", description: "Website copy as .md or .docx, at least 600 words, with an About us section", spec: { pattern: [".md", ".docx"], minWords: 600, mustContain: ["About us"] }, required: true },
  { id: "crt_brand_2_judge", milestoneId: "mst_brand_2", kind: "judgment", description: "The copy is warm, specific to the bakery and free of filler", spec: {}, required: false },
);
for (const c of criteriaRows.slice(-5)) {
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
console.log(`seed ok: ${userRows.length} users, 2 contracts, ${3 + brandMilestones.length} milestones, ${criteriaRows.length} criteria, ${n} release events`);
process.exit(0);

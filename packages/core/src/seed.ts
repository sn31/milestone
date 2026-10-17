/** pnpm db:seed. Idempotent: every row has a fixed id and is upserted. */
import { eq, sql } from "drizzle-orm";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createDb } from "./db.ts";
import { loadRootEnv, paypalMode } from "./env.ts";
import { ledgerRefs } from "./ledger.ts";
import { createMandate } from "./mandates.ts";
import { advances, agentMandates, auditLog, contracts, criteria, deliveries, ledgerEntries, milestones, paypalOps, users } from "./schema.ts";
import type { PolicyDecision } from "./schemas.ts";

loadRootEnv(); // no .env: rely on process.env

const db = createDb();
const simulated = paypalMode() === "simulated";

// `--if-empty` (Render's pre-deploy runs `seed --showcase --if-empty` on every deploy) seeds only a database whose users
// table is empty, so the first deploy gets the demo and later deploys leave whatever the demo has become alone.
if (process.argv.includes("--if-empty")) {
  const [existing] = (await db.execute(sql`select count(*)::int as n from users`)).rows as { n: number }[];
  if ((existing?.n ?? 0) > 0) {
    console.log(`seed skipped: --if-empty and the users table has ${existing!.n} rows`);
    process.exit(0);
  }
}

// `pnpm db:seed -- --reset` wipes every table before seeding (`--reset-files` also clears var/ simulator state and uploads), so a demo
// never starts with stale payout rows that would send a milestone to needs_operator.
if (process.argv.includes("--reset")) {
  const { sql } = await import("drizzle-orm");
  await db.execute(sql`truncate table agent_mandates, audit_log, ledger_entries, webhook_events, paypal_ops, advances, deliveries, criteria, milestones, contracts, users restart identity cascade`);
  // Shared files (simulator state, uploaded deliveries) live in the repo's var/ and belong to whichever database uses them,
  // so a reset of a scratch database must not delete them. Only --reset-files does, for the main local setup.
  if (process.argv.includes("--reset-files")) {
    const { rmSync } = await import("node:fs");
    try { rmSync(resolve(dirname(fileURLToPath(import.meta.url)), "../../../var/simulated-paypal.json"), { force: true }); } catch { /* none */ }
    try { rmSync(resolve(dirname(fileURLToPath(import.meta.url)), "../../../var/uploads"), { recursive: true, force: true }); } catch { /* none */ }
    console.log("reset: all tables truncated, simulator state and uploads removed");
  } else {
    console.log("reset: all tables truncated (var/ files kept; add --reset-files to remove them)");
  }
}

const userRows = [
  { id: "usr_client", role: "client" as const, name: "Casey Client", email: "client@milestone.test" },
  { id: "usr_client2", role: "client" as const, name: "Dana Client", email: "client2@milestone.test" },
  { id: "usr_freelancer", role: "freelancer" as const, name: "Frankie Freelancer", email: "freelancer@milestone.test", githubLogin: "milestone-demo", paypalEmail: process.env.PAYPAL_FREELANCER_EMAIL ?? process.env.SPIKE_FREELANCER_EMAIL ?? (simulated ? "freelancer@milestone.test" : null) },
  { id: "usr_partner", role: "partner" as const, name: "Parker Partner", email: "partner@milestone.test", paypalEmail: process.env.PAYPAL_PARTNER_EMAIL ?? (simulated ? "partner@milestone.test" : null) },
  { id: "usr_platform", role: "platform" as const, name: "Milestone Platform", email: "platform@milestone.test" },
];
for (const u of userRows) {
  await db.insert(users).values(u).onConflictDoUpdate({ target: users.id, set: { role: u.role, name: u.name, email: u.email, githubLogin: u.githubLogin ?? null, ...("paypalEmail" in u && u.paypalEmail ? { paypalEmail: u.paypalEmail } : {}) } });
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
  const m = { id: `mst_${n}`, contractId: "ctr_demo", seq: n, title: titles[n - 1]!, amountMinor: 10000, status: "draft" as const, advanceEligible: true };
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

// A second client's small contract, so the lender's book has more than one client and the concentration stat is unremarkable.
const dash = {
  id: "ctr_dash",
  clientId: "usr_client2",
  freelancerId: "usr_freelancer",
  title: "Analytics dashboard",
  scopeText: "A small analytics dashboard for a newsletter: usage charts delivered as screenshots, then a CSV export of the underlying numbers.",
  currency: "USD",
  totalMinor: 8000,
  repoFullName: null,
  status: "active" as const,
  clientApprovedAt: now,
  freelancerApprovedAt: now,
};
const { id: _did, ...dashSet } = dash;
await db.insert(contracts).values(dash).onConflictDoUpdate({ target: contracts.id, set: dashSet });

const dashMilestones = [
  { id: "mst_dash_1", contractId: "ctr_dash", seq: 1, title: "Usage charts", amountMinor: 5000, status: "draft" as const, advanceEligible: true },
  { id: "mst_dash_2", contractId: "ctr_dash", seq: 2, title: "CSV export", amountMinor: 3000, status: "draft" as const, advanceEligible: true },
];
for (const m of dashMilestones) {
  const { id: _mid, ...mSet } = m;
  await db.insert(milestones).values(m).onConflictDoUpdate({ target: milestones.id, set: mSet });
}
criteriaRows.push(
  { id: "crt_dash_1_shot", milestoneId: "mst_dash_1", kind: "upload", description: "Dashboard screenshot as a PNG at least 1280 px wide", spec: { pattern: "*.png", minWidth: 1280 }, required: true },
  { id: "crt_dash_1_judge", milestoneId: "mst_dash_1", kind: "judgment", description: "The charts show opens, clicks and unsubscribes per issue with readable axes", spec: {}, required: false },
  { id: "crt_dash_2_csv", milestoneId: "mst_dash_2", kind: "upload", description: "CSV export with an issue, opens, clicks and unsubscribes column", spec: { pattern: "*.csv", mustContain: ["issue", "opens", "clicks", "unsubscribes"] }, required: true },
  { id: "crt_dash_2_judge", milestoneId: "mst_dash_2", kind: "judgment", description: "The export matches the numbers on the charts", spec: {}, required: false },
);
for (const c of criteriaRows.slice(-4)) {
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

// `pnpm db:seed -- --showcase` (combinable with --reset) puts the demo milestones into every state once, so each screen
// has something to show without running the worker: funded, review (window open), released, needs_client (partial),
// held after a failed payout (the operator case) and a second client's funded milestone with an open advance. Rows have fixed ids, so a rerun refreshes them in place. No PayPal simulator state is written: the showcase ids
// are display data, not live orders, so acting on them (e.g. confirming the partial) will not reach the simulator.
let showcase = 0;
let agentToken: string | null = null;
if (process.argv.includes("--showcase")) {
  const { createHash } = await import("node:crypto");
  const sha = (s: string) => createHash("sha256").update(s).digest("hex");
  /** A stable UUID-shaped PayPal-Request-Id per (kind, key), so reruns keep the same id. */
  const uuidFrom = (s: string) => {
    const h = sha(s);
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
  };
  const min = (n: number) => new Date(now.getTime() + n * 60_000);
  const model = process.env.MILESTONE_MODEL ?? "showcase-model";

  type Ms = { id: string; contractId: string; clientId: string; amountMinor: number; seq: number };
  const all: Ms[] = [
    { id: "mst_1", contractId: "ctr_demo", clientId: "usr_client", amountMinor: 10000, seq: 1 },
    { id: "mst_2", contractId: "ctr_demo", clientId: "usr_client", amountMinor: 10000, seq: 2 },
    { id: "mst_3", contractId: "ctr_demo", clientId: "usr_client", amountMinor: 10000, seq: 3 },
    { id: "mst_brand_1", contractId: "ctr_brand", clientId: "usr_client", amountMinor: 9000, seq: 1 },
    { id: "mst_brand_2", contractId: "ctr_brand", clientId: "usr_client", amountMinor: 6000, seq: 2 },
    { id: "mst_dash_1", contractId: "ctr_dash", clientId: "usr_client2", amountMinor: 5000, seq: 1 },
    { id: "mst_dash_2", contractId: "ctr_dash", clientId: "usr_client2", amountMinor: 3000, seq: 2 },
  ];
  const ids = all.map((m) => `'${m.id}'`).join(",");
  // Clear what a previous showcase (or a real run) left on these milestones, then rebuild it.
  await db.execute(sql.raw(`delete from audit_log where milestone_id in (${ids}) or id like 'aud_show_%'`));
  await db.execute(sql.raw(`delete from ledger_entries where id like 'led_show_%' or ref in (select paypal_capture_id from milestones where id in (${ids}) and paypal_capture_id is not null) or ref in (${all.flatMap((m) => [`'release:${m.id}'`, `'release:${m.id}:partner'`, `'refund:${m.id}'`]).join(",")})`));
  await db.execute(sql.raw(`delete from paypal_ops where key in (${ids}, 'adv_show_repaid', 'adv_show_open', 'adv_show_open2')`));
  await db.execute(sql.raw(`delete from advances where milestone_id in (${ids})`));
  await db.execute(sql.raw(`delete from deliveries where milestone_id in (${ids})`));

  let auditSeq = 0;
  const auditRow = async (m: Ms, actor: string, event: string, at: Date, detail: Record<string, unknown>) => {
    auditSeq += 1;
    await db.insert(auditLog).values({ id: `aud_show_${String(auditSeq).padStart(3, "0")}`, contractId: m.contractId, milestoneId: m.id, actor, event, detail, createdAt: at });
  };
  let ledgerSeq = 0;
  const post = async (txnId: string, ref: string, at: Date, entries: { account: string; amountMinor: number; direction: "debit" | "credit" }[]) => {
    for (const e of entries) {
      ledgerSeq += 1;
      await db.insert(ledgerEntries).values({ id: `led_show_${String(ledgerSeq).padStart(3, "0")}`, txnId, account: e.account, amountMinor: e.amountMinor, currency: "USD", direction: e.direction, ref, createdAt: at });
    }
  };
  const op = async (kind: string, key: string, paypalId: string, at: Date, response: Record<string, unknown>, extra: { status?: "succeeded" | "failed"; request?: Record<string, unknown> } = {}) => {
    await db.insert(paypalOps).values({ id: `op_show_${kind}_${key}`, kind, key, requestId: uuidFrom(`showcase:${kind}:${key}`), paypalId, status: extra.status ?? "succeeded", request: extra.request ?? null, response, createdAt: at, updatedAt: at });
  };

  /** An accepted and funded advance, as the accept route and the advance job leave it (offer, ledger, op, audit rows). */
  const advance = async (m: Ms, a: { id: string; principalMinor: number; feeBpsPerDay: number; days: number; pFail: number; expectedLossMinor: number; acceptedAgo: number; fundedAgo: number }) => {
    const expectedFeeMinor = Math.floor((a.principalMinor * a.feeBpsPerDay * a.days) / 10_000);
    const acceptedAt = min(-a.acceptedAgo);
    const fundedAt = min(-a.fundedAgo);
    const offer = { eligible: true, principalMinor: a.principalMinor, feeBpsPerDay: a.feeBpsPerDay, expectedFeeMinor, pFail: a.pFail, expectedLossMinor: a.expectedLossMinor, terms: { principalMinor: a.principalMinor, feeBpsPerDay: a.feeBpsPerDay, expectedFeeMinor, repaymentMinor: a.principalMinor + expectedFeeMinor, days: a.days }, currency: "USD", acceptedAt: acceptedAt.toISOString() };
    await db.insert(advances).values({ id: a.id, milestoneId: m.id, partnerId: "usr_partner", principalMinor: a.principalMinor, feeBpsPerDay: a.feeBpsPerDay, status: "funded", offer, explanation: `Advance of ${(a.principalMinor / 100).toFixed(2)} USD at ${a.feeBpsPerDay} bps a day, repaid from the release of ${m.id}.`, fundedAt, createdAt: acceptedAt });
    const batchId = `SIM-BATCH-${a.id.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 14)}`;
    await op("advance-payout", a.id, batchId, fundedAt, { batch_header: { payout_batch_id: batchId, batch_status: "SUCCESS" } }, { request: { advanceId: a.id, milestoneId: m.id, principalMinor: a.principalMinor, currency: "USD" } });
    await post(`txn_show_adv_${a.id}`, ledgerRefs.advanceFunding(a.id), fundedAt, [
      { account: "partner:usr_partner:receivable", amountMinor: a.principalMinor, direction: "debit" },
      { account: "partner:usr_partner:cash", amountMinor: a.principalMinor, direction: "credit" },
    ]);
    await auditRow(m, "usr_partner", "advance.accepted", acceptedAt, { advanceId: a.id, partnerId: "usr_partner", principalMinor: a.principalMinor, feeBpsPerDay: a.feeBpsPerDay, expectedFeeMinor, repaymentMinor: a.principalMinor + expectedFeeMinor, currency: "USD" });
    await auditRow(m, "paypal", "advance.funded", fundedAt, { advanceId: a.id, partnerId: "usr_partner", principalMinor: a.principalMinor, currency: "USD", payoutBatchId: batchId, requestId: uuidFrom(`showcase:advance-payout:${a.id}`), offer });
    return { expectedFeeMinor, owedMinor: a.principalMinor + expectedFeeMinor };
  };

  /** Order + capture + ledger (client -> held) + funded audit, `ago` minutes in the past. */
  const fund = async (m: Ms, ago: number, n: number) => {
    const at = min(-ago);
    const orderId = `SIM-ORD-SHOW${n}${m.seq}0A7Q`;
    const captureId = `SIM-CAP-SHOW${n}${m.seq}0K2F`;
    // No baseline: a made-up commit id would not exist in whatever repository a visitor delivers from, so the worker
    // could not fetch it and every pass would read "not trusted". With none recorded (as when funding finds no default
    // branch head), the worker runs the suite of the delivered commit's first parent, and says so on the log.
    const baselineSha = null;
    await db.update(milestones).set({ status: "funded", paypalOrderId: orderId, paypalCaptureId: captureId, baselineSha, decision: null, decidedAt: null, reviewEndsAt: null, clientResponse: null }).where(sql`id = ${m.id}`);
    await op("order", m.id, orderId, min(-ago - 1), { id: orderId, status: "APPROVED" });
    await op("capture", m.id, captureId, at, { id: captureId, status: "COMPLETED", amount: { currency_code: "USD", value: (m.amountMinor / 100).toFixed(2) } });
    await post(`txn_show_fund_${m.id}`, captureId, at, [
      { account: `client:${m.clientId}`, amountMinor: m.amountMinor, direction: "debit" },
      { account: `held:${m.id}`, amountMinor: m.amountMinor, direction: "credit" },
    ]);
    await auditRow(m, m.clientId, "milestone.order_created", min(-ago - 1), { orderId, amountMinor: m.amountMinor, currency: "USD" });
    await auditRow(m, "paypal", "milestone.funded", at, { from: "draft", to: "funded", orderId, captureId, amountMinor: m.amountMinor, currency: "USD", baselineSha });
  };

  type Crit = { criterion_id: string; status: "pass" | "fail" | "unclear"; confidence: number; evidence_ids: string[]; rationale: string };
  /** A verified delivery: delivery row with verdict + evidence, verifying -> decided, with audit rows. */
  const deliver = async (m: Ms, opts: { deliveryId: string; ago: number; source: "github_pr" | "upload"; ref: string; payload: Record<string, unknown>; evidence: unknown[]; criteria: Crit[]; result: "pass" | "partial" | "fail"; decision: PolicyDecision }) => {
    const received = min(-opts.ago);
    const verified = min(-opts.ago + 2);
    const promptHash = sha(`prompt-${opts.deliveryId}`);
    await db.insert(deliveries).values({
      id: opts.deliveryId,
      milestoneId: m.id,
      source: opts.source,
      ref: opts.ref,
      payload: opts.payload,
      evidence: opts.evidence,
      verdict: { delivery_id: opts.deliveryId, criteria: opts.criteria, suspected_injection: false },
      result: opts.result,
      suspectedInjection: false,
      model,
      promptHash,
      receivedAt: received,
      verifiedAt: verified,
    });
    const stored = { ...opts.decision, deliveryId: opts.deliveryId };
    await db.update(milestones).set({ status: "verifying", decision: stored, decidedAt: verified }).where(sql`id = ${m.id}`);
    const deliveryEvent = opts.source === "upload" ? "delivery.upload" : "delivery.manual";
    const deliveryDetail = opts.source === "upload" ? { deliveryId: opts.deliveryId, files: (opts.payload.files as { name: string; size: number; sha256: string }[]).map((f) => ({ name: f.name, size: f.size, sha256: f.sha256 })) } : { deliveryId: opts.deliveryId, ref: opts.ref, sha: opts.payload.sha };
    await auditRow(m, "usr_freelancer", deliveryEvent, received, deliveryDetail);
    await auditRow(m, "verifier", "milestone.verifying", min(-opts.ago + 0.1), { from: "funded", to: "verifying", deliveryId: opts.deliveryId });
    await auditRow(m, "verifier", "verdict.stored", verified, { deliveryId: opts.deliveryId, result: opts.result, model, promptHash, suspectedInjection: false, injectionHits: [] });
    await auditRow(m, "policy", "policy.decided", verified, stored);
    return { verified, stored };
  };
  const setStatus = (id: string, status: "review" | "released" | "held" | "needs_client", extra: Record<string, unknown> = {}) => db.update(milestones).set({ status, ...extra }).where(sql`id = ${id}`);

  const [m1, m2, m3, b1, b2, h1] = all as [Ms, Ms, Ms, Ms, Ms, Ms, Ms];
  const repo = "https://github.com/milestone-demo/landing.git";

  // mst_1: funded, waiting for a delivery.
  await fund(m1, 50, 1);
  await advance(m1, { id: "adv_show_open", principalMinor: 4000, feeBpsPerDay: 10, days: 7, pFail: 0.12, expectedLossMinor: 240, acceptedAgo: 30, fundedAgo: 29 });

  // mst_2: delivered as PR #7, verified pass, in review with the window closing in 20 minutes.
  await fund(m2, 48, 2);
  const sha2 = sha("pr-7-head").slice(0, 40);
  const d2 = await deliver(m2, {
    deliveryId: "dlv_show_2",
    ago: 9,
    source: "github_pr",
    ref: "milestone-demo/landing#7",
    payload: { sha: sha2, title: "Account creation API and confirmation page", body: "Adds POST /api/accounts, the confirmation page and tests.", branch: "feat/accounts", clone_url: repo, base_sha: sha("baseline-mst_2").slice(0, 40), pr: 7 },
    evidence: [
      { id: "ev_2_tests", criterion_id: "crt_2_tests", kind: "log", status: "pass", summary: "npm test: 14 passed, 0 failed in 2.8 s", text: "> landing@1.2.0 test\n> node --test\n\n# tests 14\n# suites 4\n# pass 14\n# fail 0\n# duration_ms 2811" },
      { id: "ev_2_tamper", criterion_id: "crt_2_tests", kind: "diff", status: "pass", summary: "No changes to existing tests, package.json scripts, lockfile or CI config since the baseline" },
      { id: "ev_2_file", criterion_id: "crt_2_file", kind: "file", status: "pass", summary: "public/pricing.html exists (3.1 KB)", uri: "public/pricing.html", sha256: sha("pricing.html") },
      { id: "ev_2_diff", criterion_id: "crt_2_judge", kind: "diff", summary: "+212 -18 across 6 files: src/accounts.js, src/routes.js, public/confirm.html, public/pricing.html, test/accounts.test.js, README.md" },
      { id: "ev_2_shot", criterion_id: "crt_2_judge", kind: "screenshot", summary: "Confirmation page at 1280 px: heading, account email echoed, link back to the dashboard" },
    ],
    criteria: [
      { criterion_id: "crt_2_tests", status: "pass", confidence: 0.98, evidence_ids: ["ev_2_tests", "ev_2_tamper"], rationale: "All 14 tests pass, including the 5 new account tests; no existing test or script was modified." },
      { criterion_id: "crt_2_file", status: "pass", confidence: 0.99, evidence_ids: ["ev_2_file"], rationale: "The expected file is present and non-empty." },
      { criterion_id: "crt_2_judge", status: "pass", confidence: 0.91, evidence_ids: ["ev_2_diff", "ev_2_shot"], rationale: "The PR adds the account endpoint and a confirmation page that matches the milestone description." },
    ],
    result: "pass",
    decision: { action: "release", amountMinor: 10000, ruleIds: ["P6"], reason: "Every criterion passed at or above the confidence threshold." },
  });
  const ends2 = min(20);
  await setStatus(m2.id, "review", { reviewEndsAt: ends2 });
  await auditRow(m2, "policy", "milestone.review", d2.verified, { from: "verifying", to: "review", deliveryId: "dlv_show_2", action: "release", ruleIds: ["P6"], reviewEndsAt: ends2.toISOString() });

  // mst_3: released, payout confirmed by webhook, ledger held -> freelancer.
  await fund(m3, 46, 3);
  const adv3 = await advance(m3, { id: "adv_show_repaid", principalMinor: 5000, feeBpsPerDay: 10, days: 8, pFail: 0.1, expectedLossMinor: 250, acceptedAgo: 44, fundedAgo: 43 });
  const fee3 = adv3.expectedFeeMinor;
  const partner3 = 5000 + fee3;
  const freelancer3 = m3.amountMinor - partner3;
  const d3 = await deliver(m3, {
    deliveryId: "dlv_show_3",
    ago: 40,
    source: "github_pr",
    ref: "milestone-demo/landing#9",
    payload: { sha: sha("pr-9-head").slice(0, 40), title: "Polish, accessibility and docs", body: "Labels, focus order, contrast fixes and a README.", branch: "chore/a11y-docs", clone_url: repo, base_sha: sha("baseline-mst_3").slice(0, 40), pr: 9 },
    evidence: [
      { id: "ev_3_tests", criterion_id: "crt_3_tests", kind: "log", status: "pass", summary: "npm test: 17 passed, 0 failed in 3.1 s", text: "# tests 17\n# pass 17\n# fail 0" },
      { id: "ev_3_file", criterion_id: "crt_3_file", kind: "file", status: "pass", summary: "README.md exists (4.6 KB) with Setup and Accessibility sections", uri: "README.md", sha256: sha("README.md") },
      { id: "ev_3_note", criterion_id: "crt_3_judge", kind: "note", summary: "Every form control has a label; tab order follows the visual order" },
    ],
    criteria: [
      { criterion_id: "crt_3_tests", status: "pass", confidence: 0.97, evidence_ids: ["ev_3_tests"], rationale: "The suite passes and no existing test changed." },
      { criterion_id: "crt_3_file", status: "pass", confidence: 0.99, evidence_ids: ["ev_3_file"], rationale: "README.md is present with setup steps." },
      { criterion_id: "crt_3_judge", status: "pass", confidence: 0.88, evidence_ids: ["ev_3_note"], rationale: "The accessibility fixes and docs match the milestone description." },
    ],
    result: "pass",
    decision: { action: "release", amountMinor: 10000, ruleIds: ["P6"], reason: "Every criterion passed at or above the confidence threshold." },
  });
  const ends3 = min(-12);
  await setStatus(m3.id, "review", { reviewEndsAt: ends3 });
  await auditRow(m3, "policy", "milestone.review", d3.verified, { from: "verifying", to: "review", deliveryId: "dlv_show_3", action: "release", ruleIds: ["P6"], reviewEndsAt: ends3.toISOString() });
  const batchId = "SIM-BATCH-SHOW3X9QZ";
  const itemId = "SIM-ITEM-SHOW3L4MW";
  await op("payout", m3.id, batchId, min(-11), { batch_header: { payout_batch_id: batchId, batch_status: "SUCCESS" }, items: { partner: { status: "succeeded", amountMinor: partner3, payoutItemId: `${itemId}P`, eventId: "WH-SHOW3P" }, freelancer: { status: "succeeded", amountMinor: freelancer3, payoutItemId: itemId, eventId: "WH-SHOW3F" } } });
  await auditRow(m3, "system", "release.claimed", min(-11.5), { deliveryId: "dlv_show_3", action: "release", freelancerShareMinor: freelancer3, partnerShareMinor: partner3, refundMinor: 0, advanceId: "adv_show_repaid" });
  await auditRow(m3, "paypal", "paypal.payout", min(-11), { deliveryId: "dlv_show_3", payoutBatchId: batchId, amountMinor: 10000, currency: "USD" });
  // settle.ts books one transaction per paid item: the partner's (principal to receivable, fee to fees), then the freelancer's.
  await post("txn_show_release_mst_3_partner", ledgerRefs.release("mst_3", "partner"), min(-10), [
    { account: "held:mst_3", amountMinor: partner3, direction: "debit" },
    { account: "partner:usr_partner:receivable", amountMinor: 5000, direction: "credit" },
    { account: "partner:usr_partner:fees", amountMinor: fee3, direction: "credit" },
  ]);
  await post("txn_show_release_mst_3", ledgerRefs.release("mst_3"), min(-10), [
    { account: "held:mst_3", amountMinor: freelancer3, direction: "debit" },
    { account: "freelancer:usr_freelancer", amountMinor: freelancer3, direction: "credit" },
  ]);
  await db.update(advances).set({ status: "repaid", repaidAt: min(-10) }).where(sql`id = 'adv_show_repaid'`);
  await auditRow(m3, "paypal", "advance.repaid", min(-10), { advanceId: "adv_show_repaid", advanceMilestoneId: "mst_3", carried: false, partnerId: "usr_partner", owedMinor: partner3, paidMinor: partner3, principalPaidMinor: 5000, feePaidMinor: fee3, remainingMinor: 0, payoutBatchId: batchId });
  await setStatus(m3.id, "released");
  await auditRow(m3, "paypal", "milestone.released", min(-10), { from: "review", to: "released", eventType: "PAYMENT.PAYOUTS-ITEM.SUCCEEDED", payoutBatchId: batchId, payoutItemId: itemId, amountMinor: 10000, refundMinor: 0, currency: "USD", freelancerId: "usr_freelancer", verifiedPass: true });

  // mst_brand_1: logo and guide pass, the optional judgment fails: partial (P5), waiting for the client.
  await fund(b1, 120, 4);
  const files1 = [
    { name: "corner-bakery-logo.svg", size: 18_432, sha256: sha("logo.svg"), path: "dlv_show_b1/corner-bakery-logo.svg", mime: "image/svg+xml" },
    { name: "style-guide.pdf", size: 1_204_224, sha256: sha("style-guide.pdf"), path: "dlv_show_b1/style-guide.pdf", mime: "application/pdf" },
  ];
  const db1 = await deliver(b1, {
    deliveryId: "dlv_show_b1",
    ago: 30,
    source: "upload",
    ref: "upload:2 files",
    payload: { files: files1 },
    evidence: [
      { id: "ev_b1_logo", criterion_id: "crt_brand_1_logo", kind: "file", status: "pass", summary: "corner-bakery-logo.svg: valid SVG, viewBox 0 0 1200 1200 (scales to any width)", uri: "corner-bakery-logo.svg", sha256: files1[0]!.sha256 },
      { id: "ev_b1_pages", criterion_id: "crt_brand_1_guide", kind: "file", status: "pass", summary: "style-guide.pdf: 9 pages (max 12), contains \"Typography\" on page 4", uri: "style-guide.pdf", sha256: files1[1]!.sha256 },
      { id: "ev_b1_small", criterion_id: "crt_brand_1_judge", kind: "screenshot", summary: "Logo rendered at 32 px: the wheat mark merges into a blob and the wordmark is unreadable" },
      { id: "ev_b1_palette", criterion_id: "crt_brand_1_judge", kind: "note", summary: "Palette: flour white, crust brown, rye green; warm and specific to a bakery" },
    ],
    criteria: [
      { criterion_id: "crt_brand_1_logo", status: "pass", confidence: 0.99, evidence_ids: ["ev_b1_logo"], rationale: "An SVG logo was delivered; vector, so it meets the 1024 px minimum." },
      { criterion_id: "crt_brand_1_guide", status: "pass", confidence: 0.97, evidence_ids: ["ev_b1_pages"], rationale: "The style guide is 9 pages and has a Typography section." },
      { criterion_id: "crt_brand_1_judge", status: "fail", confidence: 0.84, evidence_ids: ["ev_b1_small", "ev_b1_palette"], rationale: "The colour system suits the bakery, but at favicon size the mark loses its shape and the name cannot be read." },
    ],
    result: "partial",
    decision: { action: "partial", amountMinor: 6000, ruleIds: ["P5"], reason: "2 of 3 criteria passed; optional criteria failed: The logo reads clearly at small sizes and the colour system suits a neighbourhood bakery" },
  });
  await setStatus(b1.id, "needs_client");
  await auditRow(b1, "policy", "milestone.needs_client", db1.verified, { from: "verifying", to: "needs_client", deliveryId: "dlv_show_b1", action: "partial", ruleIds: ["P5"] });

  // mst_brand_2: the copy passes every criterion: release (P6). The client approved early, the release job claimed the
  // payout, and PayPal failed the freelancer item, so the job stopped and flagged it (release.ts flagNeedsOperator +
  // operatorSummary). The operator case is "payout failed after a correct release"; /ops lists it until an ops.resolved
  // follows. No release transaction is booked (settle never ran), so the held balance stays with the funding entry.
  await fund(b2, 118, 5);
  const files2 = [{ name: "website-copy.md", size: 4_873, sha256: sha("website-copy.md"), path: "dlv_show_b2/website-copy.md", mime: "text/markdown" }];
  const db2 = await deliver(b2, {
    deliveryId: "dlv_show_b2",
    ago: 22,
    source: "upload",
    ref: "upload:1 file",
    payload: { files: files2 },
    evidence: [
      { id: "ev_b2_words", criterion_id: "crt_brand_2_copy", kind: "file", status: "pass", summary: "website-copy.md: 742 words (minimum 600); \"About us\" section present", uri: "website-copy.md", sha256: files2[0]!.sha256 },
      { id: "ev_b2_tone", criterion_id: "crt_brand_2_judge", kind: "note", summary: "Warm and specific (names the sourdough starter, the baker, opening hours); no stock phrases found" },
    ],
    criteria: [
      { criterion_id: "crt_brand_2_copy", status: "pass", confidence: 0.99, evidence_ids: ["ev_b2_words"], rationale: "The copy has 742 words against a minimum of 600 and includes an About us section." },
      { criterion_id: "crt_brand_2_judge", status: "pass", confidence: 0.9, evidence_ids: ["ev_b2_tone"], rationale: "The copy is warm, names real details of the bakery and has no filler." },
    ],
    result: "pass",
    decision: { action: "release", amountMinor: 6000, ruleIds: ["P6"], reason: "Every criterion passed at or above the confidence threshold." },
  });
  const endsB2 = min(-20 + 48 * 60);
  await setStatus(b2.id, "review", { reviewEndsAt: endsB2 });
  await auditRow(b2, "policy", "milestone.review", db2.verified, { from: "verifying", to: "review", deliveryId: "dlv_show_b2", action: "release", ruleIds: ["P6"], reviewEndsAt: endsB2.toISOString() });
  await db.update(milestones).set({ clientResponse: "approve" }).where(sql`id = ${b2.id}`);
  await auditRow(b2, "usr_client", "client.approve", min(-15), { status: "review", deliveryId: "dlv_show_b2" });

  // Operator case on mst_brand_2: the release job claimed the payout and PayPal failed the freelancer item.
  const failBatch = "SIM-BATCH-SHOWB2F7K";
  const failReason = "Receiver is unregistered";
  const claim2 = { deliveryId: "dlv_show_b2", action: "release", ruleIds: ["P6"], reason: "Every criterion passed at or above the confidence threshold.", releaseMinor: 6000, refundMinor: 0, currency: "USD", captureId: "SIM-CAP-SHOW5" + b2.seq + "0K2F", freelancerEmail: "freelancer@milestone.test", partnerEmail: null, shares: { partnerShareMinor: 0, freelancerShareMinor: 6000 }, jobId: "job_show_b2", claimedAt: min(-14).toISOString() };
  await op("payout", b2.id, failBatch, min(-12), { batch_header: { payout_batch_id: failBatch, batch_status: "DENIED" }, items: { freelancer: { status: "failed", amountMinor: 6000, payoutItemId: "SIM-ITEM-SHOWB2F", eventId: "WH-SHOWB2F", reason: failReason } } }, { status: "failed", request: { claim: claim2 } });
  await auditRow(b2, "system", "release.claimed", min(-14), { deliveryId: "dlv_show_b2", action: "release", freelancerShareMinor: 6000, partnerShareMinor: 0, refundMinor: 0 });
  await auditRow(b2, "paypal", "paypal.payout", min(-13), { deliveryId: "dlv_show_b2", payoutBatchId: failBatch, amountMinor: 6000, currency: "USD" });
  await auditRow(b2, "paypal", "paypal.payout_failed", min(-12), { eventId: "WH-SHOWB2F", party: "freelancer", payoutBatchId: failBatch, amountMinor: 6000, reason: failReason, opStatus: "failed" });
  await setStatus(b2.id, "held");
  await auditRow(b2, "paypal", "milestone.held", min(-11.9), { from: "review", to: "held", reason: "A payout item failed" });
  await auditRow(b2, "paypal", "milestone.needs_operator", min(-11.8), {
    reason: "A payout item failed",
    status: "held",
    deliveryId: "dlv_show_b2",
    action: "release",
    currency: "USD",
    payoutBatchId: failBatch,
    payoutOpStatus: "failed",
    paid: {},
    failed: { freelancer: failReason },
    reversed: {},
    pending: [],
    refunded: null,
    summary: { paid: 0, failed: 6000, reversed: 0, pending: 0, refunded: 0 },
  });

  // mst_dash_1 (second client): funded with an open advance, so the book shows two clients. mst_dash_2 stays draft.
  await fund(h1, 70, 6);
  await advance(h1, { id: "adv_show_open2", principalMinor: 3000, feeBpsPerDay: 10, days: 7, pFail: 0.1, expectedLossMinor: 150, acceptedAgo: 40, fundedAgo: 39 });

  // Casey's agent: a mandate for usr_client that may approve releases up to $200.00 for 30 days. The token is random
  // on every run (only its hash is stored), so a rerun replaces the mandate and prints the new token, to stdout only.
  await db.delete(agentMandates).where(eq(agentMandates.id, "mdt_show_casey"));
  const { token } = await createMandate(db, {
    id: "mdt_show_casey",
    userId: "usr_client",
    agentName: "Casey's agent",
    actions: ["read", "draft_contract", "fund", "approve", "hold"],
    approveCapMinor: 20000,
    currency: "USD",
    expiresAt: new Date(now.getTime() + 30 * 86_400_000),
    now,
  });
  agentToken = token;

  showcase = all.length;
}

const [row] = (await db.execute(sql`select count(*)::int as n from audit_log where event = 'milestone.released'`)).rows as { n: number }[];
const n = row?.n ?? 0;
console.log(`seed ok: ${userRows.length} users, 3 contracts, ${3 + brandMilestones.length + dashMilestones.length} milestones, ${criteriaRows.length} criteria, ${n} release events${showcase ? `, showcase: ${showcase} milestones placed (funded, review, released, needs_client, held after a failed payout, second client funded, draft)` : ""}`);
if (agentToken) console.log(`showcase agent mandate mdt_show_casey (Casey's agent, approve up to 200.00 USD, 30 days). Bearer token, shown once: ${agentToken}`);
process.exit(0);

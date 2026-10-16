import { relations } from "drizzle-orm";
import { bigint, boolean, index, integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import type { MandateAction, StoredDecision } from "./schemas.ts";

export const userRole = pgEnum("user_role", ["client", "freelancer", "partner", "platform"]);
export const contractStatus = pgEnum("contract_status", ["draft", "approved", "active", "closed"]);
export const milestoneStatus = pgEnum("milestone_status", ["draft", "funded", "verifying", "review", "released", "held", "needs_client", "partial_released"]);
export const criterionKind = pgEnum("criterion_kind", ["test", "build", "file", "visual", "judgment", "upload"]);
export const deliverySource = pgEnum("delivery_source", ["github_pr", "deploy_url", "manual", "upload"]);
export const verdictResult = pgEnum("verdict_result", ["pass", "partial", "fail"]);
export const advanceStatus = pgEnum("advance_status", ["offered", "funded", "repaid", "shortfall"]);
export const opStatus = pgEnum("op_status", ["pending", "sent", "succeeded", "failed"]);
export const ledgerDirection = pgEnum("ledger_direction", ["debit", "credit"]);

const id = (name = "id") => text(name).primaryKey();
const money = (name: string) => bigint(name, { mode: "number" }).notNull();
const createdAt = () => timestamp("created_at", { withTimezone: true }).defaultNow().notNull();

export const users = pgTable("users", {
  id: id(),
  role: userRole("role").notNull(),
  name: text("name").notNull(),
  email: text("email").notNull(),
  paypalEmail: text("paypal_email"),
  githubLogin: text("github_login"),
  createdAt: createdAt(),
});

export const contracts = pgTable("contracts", {
  id: id(),
  clientId: text("client_id").notNull().references(() => users.id),
  freelancerId: text("freelancer_id").notNull().references(() => users.id),
  title: text("title").notNull(),
  scopeText: text("scope_text").notNull(),
  currency: text("currency").notNull(),
  totalMinor: money("total_minor"),
  perReleaseCapMinor: bigint("per_release_cap_minor", { mode: "number" }),
  confidenceThresholdPct: integer("confidence_threshold_pct").default(80).notNull(),
  reviewWindowSeconds: integer("review_window_seconds").default(172_800).notNull(),
  repoFullName: text("repo_full_name"),
  status: contractStatus("status").default("draft").notNull(),
  clientApprovedAt: timestamp("client_approved_at", { withTimezone: true }),
  freelancerApprovedAt: timestamp("freelancer_approved_at", { withTimezone: true }),
  createdAt: createdAt(),
});

/** The policy decision lives on the milestone: one current decision, the history is in audit_log. */
export const milestones = pgTable("milestones", {
  id: id(),
  contractId: text("contract_id").notNull().references(() => contracts.id),
  seq: integer("seq").notNull(),
  title: text("title").notNull(),
  amountMinor: money("amount_minor"),
  dueAt: timestamp("due_at", { withTimezone: true }),
  status: milestoneStatus("status").default("draft").notNull(),
  paypalOrderId: text("paypal_order_id"),
  paypalCaptureId: text("paypal_capture_id"),
  /** Default branch head when the milestone was funded; the verifier's tamper check diffs deliveries against it. */
  baselineSha: text("baseline_sha"),
  decision: jsonb("decision").$type<StoredDecision>(),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  reviewEndsAt: timestamp("review_ends_at", { withTimezone: true }),
  clientResponse: text("client_response"),
  advanceEligible: boolean("advance_eligible").default(false).notNull(),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex("milestones_contract_seq").on(t.contractId, t.seq),
  // Webhooks resolve their milestone by PayPal id.
  index("milestones_paypal_capture_id").on(t.paypalCaptureId),
  index("milestones_paypal_order_id").on(t.paypalOrderId),
]);

export const criteria = pgTable("criteria", {
  id: id(),
  milestoneId: text("milestone_id").notNull().references(() => milestones.id),
  kind: criterionKind("kind").notNull(),
  description: text("description").notNull(),
  spec: jsonb("spec").$type<Record<string, unknown>>().default({}).notNull(),
  required: boolean("required").default(true).notNull(),
}, (t) => [index("criteria_milestone").on(t.milestoneId)]);

/** A delivery carries its own verdict and evidence as JSON; logs and screenshots are bounded and inline. */
export const deliveries = pgTable("deliveries", {
  id: id(),
  milestoneId: text("milestone_id").notNull().references(() => milestones.id),
  source: deliverySource("source").notNull(),
  ref: text("ref").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>(),
  evidence: jsonb("evidence").$type<unknown[]>(),
  verdict: jsonb("verdict").$type<Record<string, unknown>>(),
  result: verdictResult("result"),
  suspectedInjection: boolean("suspected_injection").default(false).notNull(),
  model: text("model"),
  promptHash: text("prompt_hash"),
  receivedAt: createdAt(),
  verifiedAt: timestamp("verified_at", { withTimezone: true }),
}, (t) => [index("deliveries_milestone_received").on(t.milestoneId, t.receivedAt.desc())]);

export const advances = pgTable("advances", {
  id: id(),
  milestoneId: text("milestone_id").notNull().references(() => milestones.id),
  partnerId: text("partner_id").notNull().references(() => users.id),
  principalMinor: money("principal_minor"),
  feeBpsPerDay: integer("fee_bps_per_day").notNull(),
  status: advanceStatus("status").default("offered").notNull(),
  offer: jsonb("offer").$type<Record<string, unknown>>().notNull(),
  explanation: text("explanation"),
  fundedAt: timestamp("funded_at", { withTimezone: true }),
  repaidAt: timestamp("repaid_at", { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [index("advances_milestone").on(t.milestoneId)]);

export const paypalOps = pgTable("paypal_ops", {
  id: id(),
  kind: text("kind").notNull(),
  key: text("key").notNull(),
  requestId: text("request_id").notNull(),
  paypalId: text("paypal_id"),
  status: opStatus("status").default("pending").notNull(),
  request: jsonb("request"),
  response: jsonb("response"),
  createdAt: createdAt(),
  updatedAt: timestamp("updated_at", { withTimezone: true }),
}, (t) => [
  uniqueIndex("paypal_ops_request_id").on(t.requestId),
  uniqueIndex("paypal_ops_kind_key").on(t.kind, t.key),
  // A milestone's ops are looked up by key across kinds (payout + refund).
  index("paypal_ops_key").on(t.key),
]);

export const webhookEvents = pgTable("webhook_events", {
  id: id(),
  source: text("source").notNull(),
  eventId: text("event_id").notNull(),
  type: text("type").notNull(),
  payload: jsonb("payload").notNull(),
  receivedAt: createdAt(),
  processedAt: timestamp("processed_at", { withTimezone: true }),
}, (t) => [uniqueIndex("webhook_events_source_event").on(t.source, t.eventId)]);

export const ledgerEntries = pgTable("ledger_entries", {
  id: id(),
  txnId: text("txn_id").notNull(),
  account: text("account").notNull(),
  amountMinor: money("amount_minor"),
  currency: text("currency").notNull(),
  direction: ledgerDirection("direction").notNull(),
  ref: text("ref").notNull(),
  createdAt: createdAt(),
}, (t) => [
  index("ledger_txn").on(t.txnId),
  index("ledger_account").on(t.account),
  // Backstop: a retried job that re-posts the same transaction cannot double-book a line.
  uniqueIndex("ledger_ref_account_direction").on(t.ref, t.account, t.direction),
]);

/** Append-only; every verdict, decision, veto and PayPal call. Both parties can read it. */
export const auditLog = pgTable("audit_log", {
  id: id(),
  contractId: text("contract_id").references(() => contracts.id),
  milestoneId: text("milestone_id").references(() => milestones.id),
  actor: text("actor").notNull(),
  event: text("event").notNull(),
  detail: jsonb("detail"),
  createdAt: createdAt(),
}, (t) => [
  index("audit_milestone_created").on(t.milestoneId, t.createdAt.desc()),
  index("audit_contract_created").on(t.contractId, t.createdAt.desc()),
  index("audit_event_milestone").on(t.event, t.milestoneId),
]);

/**
 * A client's delegation to an agent (see mandates.ts). Only the sha256 of the bearer token is stored; the token itself
 * is shown once, at creation. approve_cap_minor is in `currency`; null means the agent may not approve any release.
 */
export const agentMandates = pgTable("agent_mandates", {
  id: id(),
  userId: text("user_id").notNull().references(() => users.id),
  agentName: text("agent_name").notNull(),
  tokenHash: text("token_hash").notNull(),
  actions: jsonb("actions").$type<MandateAction[]>().notNull(),
  approveCapMinor: bigint("approve_cap_minor", { mode: "number" }),
  currency: text("currency").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: createdAt(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
}, (t) => [
  uniqueIndex("agent_mandates_token_hash").on(t.tokenHash),
  index("agent_mandates_user").on(t.userId),
]);

// ---------- Relations (relational queries only: db.query.x.findFirst({ with: ... }); no schema change) ----------

export const contractsRelations = relations(contracts, ({ many }) => ({ milestones: many(milestones) }));
export const milestonesRelations = relations(milestones, ({ one, many }) => ({
  contract: one(contracts, { fields: [milestones.contractId], references: [contracts.id] }),
  criteria: many(criteria),
  deliveries: many(deliveries),
  advances: many(advances),
}));
export const criteriaRelations = relations(criteria, ({ one }) => ({ milestone: one(milestones, { fields: [criteria.milestoneId], references: [milestones.id] }) }));
export const deliveriesRelations = relations(deliveries, ({ one }) => ({ milestone: one(milestones, { fields: [deliveries.milestoneId], references: [milestones.id] }) }));
export const advancesRelations = relations(advances, ({ one }) => ({ milestone: one(milestones, { fields: [advances.milestoneId], references: [milestones.id] }) }));

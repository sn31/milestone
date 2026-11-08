import { z } from "zod";

// ---------- Money ----------
export const Currency = z.string().length(3);
export const Money = z.object({
  amountMinor: z.number().int().nonnegative(),
  currency: Currency,
});
export type Money = z.infer<typeof Money>;

const ZERO_DECIMAL = new Set(["JPY", "KRW", "HUF", "TWD"]);
/** Digits after the decimal point: 0 for the zero-decimal currencies PayPal lists, else 2. */
export function minorDigits(currency: string): number {
  return ZERO_DECIMAL.has(currency.toUpperCase()) ? 0 : 2;
}
/** PayPal wants a decimal string; we store integer minor units. */
export function toPayPalValue(amountMinor: number, currency: string): string {
  if (ZERO_DECIMAL.has(currency.toUpperCase())) return String(amountMinor);
  return (amountMinor / 100).toFixed(2);
}
/** Plain-text amount for logs, notes and audit text: 1234 USD -> "12.34 USD", 500 JPY -> "500 JPY". Not localized. */
export function formatMinor(amountMinor: number, currency: string): string {
  const digits = minorDigits(currency);
  return `${(amountMinor / 10 ** digits).toFixed(digits)} ${currency}`;
}
export function fromPayPalValue(value: string, currency: string): number {
  if (ZERO_DECIMAL.has(currency.toUpperCase())) return Math.round(Number(value));
  return Math.round(Number(value) * 100);
}

// ---------- Contract and criteria ----------
export const CriterionKind = z.enum(["test", "build", "file", "visual", "judgment", "upload"]);
export type CriterionKind = z.infer<typeof CriterionKind>;
export const DETERMINISTIC_KINDS: ReadonlySet<CriterionKind> = new Set(["test", "build", "file", "upload"]);

export const CriterionSpec = z.object({
  id: z.string().min(1),
  kind: CriterionKind,
  description: z.string().min(1),
  /** kind-specific: { command } for test/build, { path } for file, { url, steps } for visual, UploadCriterionSpec for upload, {} for judgment */
  spec: z.record(z.string(), z.unknown()).default({}),
  required: z.boolean().default(true),
});
export type CriterionSpec = z.infer<typeof CriterionSpec>;

/** Formats the upload stage can sniff from magic bytes (md and txt: valid UTF-8 text). */
export const UploadFormat = z.enum(["pdf", "png", "jpg", "svg", "docx", "md", "txt"]);
export type UploadFormat = z.infer<typeof UploadFormat>;

/**
 * spec for kind "upload": which delivered file(s) the criterion is about and the checks they must pass.
 * pattern: a glob ("*.pdf", "logo/*.{svg,png}") or an extension list ([".svg", ".png"] or "svg,png"); a criterion
 * passes when at least one matching file passes every check.
 */
export const UploadCriterionSpec = z.object({
  pattern: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
  format: UploadFormat.optional(),
  minBytes: z.number().int().nonnegative().optional(),
  minWords: z.number().int().nonnegative().optional(),
  maxPages: z.number().int().positive().optional(),
  minWidth: z.number().int().positive().optional(),
  minHeight: z.number().int().positive().optional(),
  mustContain: z.array(z.string().min(1)).optional(),
});
export type UploadCriterionSpec = z.infer<typeof UploadCriterionSpec>;

/** One stored file of an upload delivery (deliveries.payload.files[]); path is relative to UPLOAD_DIR. */
export const UploadedFile = z.object({
  name: z.string().min(1),
  size: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  path: z.string().min(1),
  mime: z.string(),
});
export type UploadedFile = z.infer<typeof UploadedFile>;

/**
 * deliveries.payload for a commit delivery (source github_pr, or manual from the deliver route): the GitHub webhook's
 * shape. Reading is lenient like the verify job: a missing or non-string text field reads as "", an empty base_sha
 * as null; sha and clone_url are required.
 */
export const CommitPayload = z.object({
  sha: z.string().min(1),
  clone_url: z.string().min(1),
  title: z.string().catch(""),
  body: z.string().catch(""),
  branch: z.string().catch(""),
  /** "owner/name" from the webhook, the repository URL from the deliver route. */
  repo: z.string().optional().catch(undefined),
  pr_number: z.number().int().optional().catch(undefined),
  /** The pull request's base commit (webhook) or the milestone's funding-time head (deliver route). */
  base_sha: z.string().min(1).nullable().catch(null),
});
export type CommitPayload = z.output<typeof CommitPayload>;

/** deliveries.payload for source "upload". */
export const UploadPayload = z.object({ files: z.array(UploadedFile).min(1).max(10) });
export type UploadPayload = z.infer<typeof UploadPayload>;

export const MilestoneSpec = z.object({
  seq: z.number().int().positive(),
  title: z.string().min(1),
  amountMinor: z.number().int().positive(),
  dueAt: z.string().optional(),
  criteria: z.array(CriterionSpec).min(1),
});
export type MilestoneSpec = z.infer<typeof MilestoneSpec>;

export const ContractSpec = z.object({
  title: z.string().min(1),
  currency: Currency,
  totalMinor: z.number().int().positive(),
  milestones: z.array(MilestoneSpec).min(1),
});
export type ContractSpec = z.infer<typeof ContractSpec>;

export const ContractStatus = z.enum(["draft", "approved", "active", "closed"]);
/** The seven states in the Implementation tab's diagram, plus draft before funding. */
export const MilestoneStatus = z.enum([
  "draft",
  "funded",
  "verifying",
  "review",
  "released",
  "held",
  "needs_client",
  "partial_released",
]);
export type MilestoneStatus = z.infer<typeof MilestoneStatus>;

// ---------- Verdicts ----------
export const CriterionStatus = z.enum(["pass", "fail", "unclear"]);
export type CriterionStatus = z.infer<typeof CriterionStatus>;

export const CriterionVerdict = z.object({
  criterion_id: z.string(),
  status: CriterionStatus,
  confidence: z.number().min(0).max(1),
  evidence_ids: z.array(z.string()),
  rationale: z.string(),
});
export type CriterionVerdict = z.infer<typeof CriterionVerdict>;

export const VerdictOutput = z.object({
  delivery_id: z.string(),
  criteria: z.array(CriterionVerdict),
  suspected_injection: z.boolean(),
});
export type VerdictOutput = z.infer<typeof VerdictOutput>;

export const VerdictResult = z.enum(["pass", "partial", "fail"]);
export type VerdictResult = z.infer<typeof VerdictResult>;

export const EvidenceKind = z.enum(["log", "diff", "file", "screenshot", "replay", "note"]);
export const EvidenceSummary = z.object({
  id: z.string(),
  criterion_id: z.string().optional(),
  kind: EvidenceKind,
  summary: z.string(),
  uri: z.string().optional(),
  sha256: z.string().optional(),
  /** deterministic stage result when the evidence came from a tool, not the model */
  status: CriterionStatus.optional(),
});
export type EvidenceSummary = z.infer<typeof EvidenceSummary>;

// ---------- Policy ----------
export const PolicyAction = z.enum(["release", "partial", "hold", "ask_client"]);
export type PolicyAction = z.infer<typeof PolicyAction>;

export const PolicyDecision = z.object({
  action: PolicyAction,
  amountMinor: z.number().int().nonnegative(),
  ruleIds: z.array(z.string()),
  reason: z.string(),
});
export type PolicyDecision = z.infer<typeof PolicyDecision>;

/** milestones.decision: the policy decision plus the delivery it was made for (written by the verify job). */
export const StoredDecision = PolicyDecision.extend({ deliveryId: z.string().min(1) });
export type StoredDecision = z.infer<typeof StoredDecision>;

/** The delivery a stored decision was made for; null when the decision is missing or names none (legacy, empty). */
export function decisionDeliveryId(decision: unknown): string | null {
  if (!decision || typeof decision !== "object") return null;
  const v = (decision as Record<string, unknown>).deliveryId;
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * Descriptions of the required criteria whose verdict status is not "pass"; a criterion the verdict does not mention
 * counts as not passed. `verdict` is the raw deliveries.verdict JSON (anything else reads as an empty verdict). The
 * review route refuses approve / confirm_partial and the release job skips while this is non-empty (F9).
 */
export function requiredNotPassed(verdict: unknown, criteria: ReadonlyArray<Pick<CriterionSpec, "id" | "required" | "description">>): string[] {
  const rows = verdict && typeof verdict === "object" ? (verdict as { criteria?: unknown }).criteria : undefined;
  const status = new Map<string, unknown>();
  if (Array.isArray(rows)) {
    for (const r of rows) if (r && typeof r === "object") status.set(String((r as Record<string, unknown>).criterion_id), (r as Record<string, unknown>).status);
  }
  return criteria.filter((c) => c.required && status.get(c.id) !== "pass").map((c) => c.description);
}

// ---------- Agent mandates ----------
/** What a client may delegate to an agent (agent_mandates.actions). Money moves only through the routes a human uses. */
export const MandateAction = z.enum(["read", "draft_contract", "fund", "deliver", "approve", "hold"]);
export type MandateAction = z.infer<typeof MandateAction>;
export const MANDATE_ACTIONS = MandateAction.options;

// ---------- PayPal Acceptable Use Policy check (aup.ts) ----------
/** The two lists of PayPal's Acceptable Use Policy a flag can point at. */
export const AupSection = z.enum(["Prohibited Activities", "Activities Requiring Approval"]);
export type AupSection = z.infer<typeof AupSection>;

/** One reason a contract needs a person to look at it: a category of the policy, and the contract words that raised it. */
export const AupFlag = z.object({
  /** A category id from packages/verify/src/aup/paypal-aup.ts. */
  category: z.string().min(1),
  section: AupSection,
  /** Words copied from the contract (untrusted text). A flag without one is dropped by the parser. */
  quote: z.string().min(1),
  rationale: z.string(),
  confidence: z.number().min(0).max(1),
  /** keywords: the deterministic pre-pass; model: Claude through llm.ts, kept only when its quote is in the contract. */
  source: z.enum(["keywords", "model"]),
});
export type AupFlag = z.infer<typeof AupFlag>;

/**
 * How a check ran. model: Claude read the contract (and the keyword pass ran). keywords: no model is configured, so only
 * the keyword pass ran ("keywords only"). model_error: the model call failed or gave no usable answer, so the contract
 * goes to an operator (fail closed). recorded: written by the showcase seed, not produced by a model.
 */
export const AupMode = z.enum(["model", "keywords", "model_error", "recorded"]);
export type AupMode = z.infer<typeof AupMode>;

/** contracts.aup_check: the latest check and, once an operator acted, their resolution. */
export const AupCheckRecord = z.object({
  mode: AupMode,
  model: z.string().nullable(),
  flags: z.array(AupFlag),
  error: z.string().optional(),
  /** The policy version the check used: its source URL and the date it was retrieved. */
  policy: z.object({ url: z.string(), retrievedOn: z.string() }),
  checkedAt: z.string(),
  promptHash: z.string().optional(),
  resolution: z.object({ action: z.enum(["clear", "reject"]), by: z.string(), at: z.string(), note: z.string() }).optional(),
});
export type AupCheckRecord = z.infer<typeof AupCheckRecord>;

// ---------- Jobs and events ----------
export const JobName = z.enum(["verify", "release", "settle", "advance", "dispute", "reconcile", "autofund", "aup"]);
export type JobName = z.infer<typeof JobName>;

/** Confirmed against PayPal's webhook event reference on 2026-10-08. */
export const PAYPAL_EVENTS = {
  orderApproved: "CHECKOUT.ORDER.APPROVED",
  captureCompleted: "PAYMENT.CAPTURE.COMPLETED",
  captureRefunded: "PAYMENT.CAPTURE.REFUNDED",
  payoutItemSucceeded: "PAYMENT.PAYOUTS-ITEM.SUCCEEDED",
  payoutItemFailed: "PAYMENT.PAYOUTS-ITEM.FAILED",
  payoutItemBlocked: "PAYMENT.PAYOUTS-ITEM.BLOCKED",
  payoutItemUnclaimed: "PAYMENT.PAYOUTS-ITEM.UNCLAIMED",
  payoutItemReturned: "PAYMENT.PAYOUTS-ITEM.RETURNED",
  payoutItemReversed: "PAYMENT.PAYOUTS-ITEM.REVERSED",
  payoutItemRefunded: "PAYMENT.PAYOUTS-ITEM.REFUNDED",
  payoutItemDenied: "PAYMENT.PAYOUTS-ITEM.DENIED",
  payoutItemCanceled: "PAYMENT.PAYOUTS-ITEM.CANCELED",
  payoutItemHeld: "PAYMENT.PAYOUTS-ITEM.HELD",
  payoutsBatchDenied: "PAYMENT.PAYOUTSBATCH.DENIED",
  invoicePaid: "INVOICING.INVOICE.PAID",
  disputeCreated: "CUSTOMER.DISPUTE.CREATED",
  disputeUpdated: "CUSTOMER.DISPUTE.UPDATED",
  disputeResolved: "CUSTOMER.DISPUTE.RESOLVED",
  vaultPaymentTokenCreated: "VAULT.PAYMENT-TOKEN.CREATED",
  vaultPaymentTokenDeleted: "VAULT.PAYMENT-TOKEN.DELETED",
} as const;
export type PayPalEventName = (typeof PAYPAL_EVENTS)[keyof typeof PAYPAL_EVENTS];

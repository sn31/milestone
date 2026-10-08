import { z } from "zod";

// ---------- Money ----------
export const Currency = z.string().length(3);
export const Money = z.object({
  amountMinor: z.number().int().nonnegative(),
  currency: Currency,
});
export type Money = z.infer<typeof Money>;

const ZERO_DECIMAL = new Set(["JPY", "KRW", "HUF", "TWD"]);
/** PayPal wants a decimal string; we store integer minor units. */
export function toPayPalValue(amountMinor: number, currency: string): string {
  if (ZERO_DECIMAL.has(currency.toUpperCase())) return String(amountMinor);
  return (amountMinor / 100).toFixed(2);
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

// ---------- Jobs and events ----------
export const JobName = z.enum(["verify", "release", "settle", "advance", "dispute"]);
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
} as const;
export type PayPalEventName = (typeof PAYPAL_EVENTS)[keyof typeof PAYPAL_EVENTS];

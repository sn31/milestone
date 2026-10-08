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
export const CriterionKind = z.enum(["test", "build", "file", "visual", "judgment"]);
export type CriterionKind = z.infer<typeof CriterionKind>;
export const DETERMINISTIC_KINDS: ReadonlySet<CriterionKind> = new Set(["test", "build", "file"]);

export const CriterionSpec = z.object({
  id: z.string().min(1),
  kind: CriterionKind,
  description: z.string().min(1),
  /** kind-specific: { command } for test/build, { path } for file, { url, steps } for visual, {} for judgment */
  spec: z.record(z.string(), z.unknown()).default({}),
  required: z.boolean().default(true),
});
export type CriterionSpec = z.infer<typeof CriterionSpec>;

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
export const JobName = z.enum(["verify", "release", "settle", "advance"]);
export type JobName = z.infer<typeof JobName>;

/** Confirmed against PayPal's webhook event reference on 2026-10-08. */
export const PAYPAL_EVENTS = {
  orderApproved: "CHECKOUT.ORDER.APPROVED",
  captureCompleted: "PAYMENT.CAPTURE.COMPLETED",
  captureRefunded: "PAYMENT.CAPTURE.REFUNDED",
  payoutItemSucceeded: "PAYMENT.PAYOUTS-ITEM.SUCCEEDED",
  payoutItemFailed: "PAYMENT.PAYOUTS-ITEM.FAILED",
  payoutItemBlocked: "PAYMENT.PAYOUTS-ITEM.BLOCKED",
  invoicePaid: "INVOICING.INVOICE.PAID",
  disputeCreated: "CUSTOMER.DISPUTE.CREATED",
  disputeResolved: "CUSTOMER.DISPUTE.RESOLVED",
} as const;
export type PayPalEventName = (typeof PAYPAL_EVENTS)[keyof typeof PAYPAL_EVENTS];

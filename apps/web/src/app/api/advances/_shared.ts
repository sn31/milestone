import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { users, type advances, type Db } from "@milestone/core";
import { describeOffer, type Underwriting, type UnderwritingContext } from "@milestone/money";
import { explain } from "@milestone/verify";

type AdvanceRow = typeof advances.$inferSelect;

/** What the freelancer sees for an advance that exists (accepted, funded, repaid). */
export interface AdvanceView {
  id: string;
  status: AdvanceRow["status"];
  principalMinor: number;
  feeBpsPerDay: number;
  feeMinor: number;
  /** Deducted from the release before the freelancer is paid: principal + the quoted fee. */
  repaymentMinor: number;
  fundedAt: string | null;
  repaidAt: string | null;
  explanation: string | null;
}

/** The fee the release job deducts: the offer's quoted expectedFeeMinor (see advanceRepayment in the worker). */
export function quotedFee(offer: Record<string, unknown>): number {
  const v = offer.expectedFeeMinor;
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : 0;
}

export function advanceView(a: AdvanceRow): AdvanceView {
  const feeMinor = quotedFee(a.offer);
  return {
    id: a.id,
    status: a.status,
    principalMinor: a.principalMinor,
    feeBpsPerDay: a.feeBpsPerDay,
    feeMinor,
    repaymentMinor: a.principalMinor + feeMinor,
    fundedAt: a.fundedAt?.toISOString() ?? null,
    repaidAt: a.repaidAt?.toISOString() ?? null,
    explanation: a.explanation,
  };
}

export function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

/** The partner new advances are booked to: MILESTONE_PARTNER_ID, else the first partner user. */
export async function partnerIdFor(db: Db, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  if (env.MILESTONE_PARTNER_ID) return env.MILESTONE_PARTNER_ID;
  const [p] = await db.select({ id: users.id }).from(users).where(eq(users.role, "partner")).orderBy(users.id).limit(1);
  return p?.id ?? null;
}

/** The numbers handed to the model; it explains them and never changes them. */
function explainNumbers(u: UnderwritingContext) {
  const t = u.terms!;
  const money = (minor: number) => `${(minor / 100).toFixed(2)} ${u.currency}`;
  const judgment = u.pricing.judgmentCriteria / Math.max(1, u.pricing.judgmentCriteria + u.pricing.deterministicCriteria);
  return {
    milestoneAmount: money(u.amountMinor),
    advanceNow: money(t.principalMinor),
    feePerDay: `${(t.feeBpsPerDay / 100).toFixed(2)}%`,
    daysUntilDue: t.days,
    feeAtDueDate: money(t.expectedFeeMinor),
    deductedFromRelease: money(t.repaymentMinor),
    estimatedChanceOfFailingVerification: `${Math.round(t.pFail * 100)}%`,
    freelancerVerifiedPasses: u.records.freelancer.verifiedPasses,
    freelancerFails: u.records.freelancer.verifiedFails,
    clientVetoes: u.records.client.vetoes,
    shareOfCriteriaJudgedByModel: `${Math.round(judgment * 100)}%`,
  };
}

/**
 * The explanation shown with an offer: the model's two sentences when ANTHROPIC_API_KEY is set (bounded to 8s),
 * otherwise, or on any failure, a sentence built from the numbers.
 */
export async function explainOffer(u: UnderwritingContext): Promise<{ text: string; source: "model" | "rules" }> {
  const rules = { text: describeOffer(u as Underwriting, u.currency), source: "rules" as const };
  if (!u.offer.eligible || !u.terms || !process.env.ANTHROPIC_API_KEY) return rules;
  try {
    const text = await Promise.race([
      explain("advance_offer", explainNumbers(u), "freelancer"),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 8_000)),
    ]);
    if (!text || text === "Explanation unavailable.") return rules;
    return { text, source: "model" };
  } catch {
    return rules;
  }
}

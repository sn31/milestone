import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { asInt, formatMinor, users, type advances, type Executor } from "@milestone/core";
import { describeOffer, type Underwriting, type UnderwritingContext } from "@milestone/money";
import { explain, isModelConfigured } from "@milestone/verify";

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
  return asInt(offer.expectedFeeMinor, 0) ?? 0;
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

/** The partner new advances are booked to: MILESTONE_PARTNER_ID, else the first partner user. */
export async function partnerIdFor(db: Executor, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  if (env.MILESTONE_PARTNER_ID) return env.MILESTONE_PARTNER_ID;
  const [p] = await db.select({ id: users.id }).from(users).where(eq(users.role, "partner")).orderBy(users.id).limit(1);
  return p?.id ?? null;
}

/** The numbers handed to the model; it explains them and never changes them. */
function explainNumbers(u: UnderwritingContext) {
  const t = u.terms!;
  const money = (minor: number) => formatMinor(minor, u.currency);
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

/** Model explanations by a hash of the numbers they explain: the same offer is not re-explained on every page load. */
const EXPLAIN_CACHE_SIZE = 100;
const explained = new Map<string, string>();

function cachedExplanation(key: string): string | undefined {
  const hit = explained.get(key);
  if (hit !== undefined) {
    // Most recently used goes last; the first key is the one to evict.
    explained.delete(key);
    explained.set(key, hit);
  }
  return hit;
}

function cacheExplanation(key: string, text: string): void {
  explained.delete(key);
  explained.set(key, text);
  while (explained.size > EXPLAIN_CACHE_SIZE) explained.delete(explained.keys().next().value!);
}

const EXPLAIN_TIMEOUT_MS = 8_000;

/**
 * The explanation shown with an offer: the model's two sentences when a model is configured (Ollama or Anthropic),
 * otherwise, or on any failure, a sentence built from the numbers. Model text is cached by a hash of the numbers (LRU
 * of 100 per process); the rules sentence is cheap and never cached, so a model failure is retried on the next load.
 * explain() takes no AbortSignal, so the 8 s bound is a race: a slow model call is abandoned here (not cancelled)
 * and its late answer is dropped.
 */
export async function explainOffer(u: UnderwritingContext): Promise<{ text: string; source: "model" | "rules" }> {
  const rules = { text: describeOffer(u as Underwriting, u.currency), source: "rules" as const };
  if (!u.offer.eligible || !u.terms || !(await isModelConfigured())) return rules;
  const numbers = explainNumbers(u);
  const key = createHash("sha256").update(JSON.stringify(numbers)).digest("hex");
  const hit = cachedExplanation(key);
  if (hit !== undefined) return { text: hit, source: "model" };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const text = await Promise.race([
      explain("advance_offer", numbers, "freelancer"),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), EXPLAIN_TIMEOUT_MS);
      }),
    ]);
    if (!text || text === "Explanation unavailable.") return rules;
    cacheExplanation(key, text);
    return { text, source: "model" };
  } catch {
    return rules;
  } finally {
    clearTimeout(timer);
  }
}

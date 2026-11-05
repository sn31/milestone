/**
 * Milestone Advance pricing. Deterministic; the model only explains the numbers it is handed.
 * Every parameter is a placeholder to tune; none of them is calibrated against real repayment data yet.
 */
export interface PricingParams {
  rMax: number; // ceiling advance rate, e.g. 0.8
  alpha: number; // Beta prior successes
  beta: number; // Beta prior failures
  judgmentHaircutPerShare: number; // k_judgment = 1 - share * this
  clientHaircutPerVeto: number; // k_client = max(0, 1 - vetoes * this)
  dailyRateBps: number; // fee per day outstanding, in basis points of the advance
  minVerifiedPasses: number; // eligibility
}

export const DEFAULT_PRICING: PricingParams = {
  rMax: 0.8,
  alpha: 1,
  beta: 2,
  judgmentHaircutPerShare: 0.5,
  clientHaircutPerVeto: 0.15,
  dailyRateBps: 10,
  minVerifiedPasses: 1,
};

export interface FreelancerRecord {
  verifiedPasses: number;
  verifiedFails: number;
  outstandingMinor: number;
  limitMinor: number;
}
export interface ClientRecord {
  vetoes: number;
  openDisputes: number;
  outstandingMinor: number;
  limitMinor: number;
}
export interface MilestoneForPricing {
  amountMinor: number;
  funded: boolean;
  deterministicCriteria: number;
  judgmentCriteria: number;
  daysUntilDue: number;
}

export type AdvanceOffer =
  | { eligible: false; reason: string }
  | {
      eligible: true;
      principalMinor: number;
      feeBpsPerDay: number;
      expectedFeeMinor: number;
      pFail: number;
      expectedLossMinor: number;
      inputs: Record<string, number>;
    };

export function priceAdvance(
  m: MilestoneForPricing,
  f: FreelancerRecord,
  c: ClientRecord,
  p: PricingParams = DEFAULT_PRICING,
): AdvanceOffer {
  if (!m.funded) return { eligible: false, reason: "milestone is not funded" };
  if (f.verifiedPasses < p.minVerifiedPasses) return { eligible: false, reason: "no verified pass on record yet" };
  if (m.deterministicCriteria === 0) return { eligible: false, reason: "milestone has only judgment criteria" };
  if (c.openDisputes > 0) return { eligible: false, reason: "client has an open dispute" };

  const n = f.verifiedPasses + f.verifiedFails;
  const pFail = (f.verifiedFails + p.alpha) / (n + p.alpha + p.beta);
  const share = m.judgmentCriteria / (m.judgmentCriteria + m.deterministicCriteria);
  const kJudgment = Math.max(0, 1 - share * p.judgmentHaircutPerShare);
  const kClient = Math.max(0, 1 - c.vetoes * p.clientHaircutPerVeto);

  const byRisk = Math.floor(p.rMax * (1 - pFail) * kJudgment * kClient * m.amountMinor);
  const byFreelancer = Math.max(0, f.limitMinor - f.outstandingMinor);
  const byClient = Math.max(0, c.limitMinor - c.outstandingMinor);
  const principal = Math.max(0, Math.min(byRisk, byFreelancer, byClient));
  if (principal === 0) return { eligible: false, reason: "no headroom under the limits" };

  const days = Math.max(1, m.daysUntilDue);
  const expectedFee = Math.floor((principal * p.dailyRateBps * days) / 10_000);
  // Expected partial recovery on failure is taken as half of principal (placeholder).
  const expectedLoss = Math.floor(pFail * (principal - principal / 2));

  return {
    eligible: true,
    principalMinor: principal,
    feeBpsPerDay: p.dailyRateBps,
    expectedFeeMinor: expectedFee,
    pFail,
    expectedLossMinor: expectedLoss,
    inputs: { pFail, kJudgment, kClient, byRisk, byFreelancer, byClient, days },
  };
}

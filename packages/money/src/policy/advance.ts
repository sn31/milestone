/**
 * Milestone Advance underwriting. `underwrite` is pure: it prices the advance with `priceAdvance` and spells out the
 * terms the freelancer agrees to. `loadRecords` / `loadUnderwriting` read the inputs from Postgres (audit_log,
 * advances, contracts, milestones, criteria) and never write. Nothing here moves money.
 */
import type { Db } from "@milestone/core";
import { DEFAULT_PRICING, priceAdvance, type AdvanceOffer, type ClientRecord, type FreelancerRecord, type MilestoneForPricing, type PricingParams } from "./pricing.ts";

/** Default credit limits in minor units when nothing more specific is known. */
export const DEFAULT_LIMITS = { freelancerMinor: 50_000, clientMinor: 100_000 } as const;
/** Days assumed until release when a milestone has no due date. */
export const DEFAULT_HORIZON_DAYS = 14;
const DAY_MS = 86_400_000;

/** What the freelancer signs up to. The partner is repaid principal + fee out of the release, before the freelancer. */
export interface AdvanceTerms {
  principalMinor: number;
  feeBpsPerDay: number;
  /** Days the fee is quoted for (until the due date, at least 1). */
  days: number;
  /** Fee at the due date; the release job deducts exactly this (offer.expectedFeeMinor). */
  expectedFeeMinor: number;
  repaymentMinor: number;
  pFail: number;
  expectedLossMinor: number;
}

export interface UnderwriteInput {
  freelancer: FreelancerRecord;
  client: ClientRecord;
  milestone: MilestoneForPricing;
}

export interface Underwriting {
  offer: AdvanceOffer;
  /** Null when the offer is not eligible. */
  terms: AdvanceTerms | null;
}

const isCount = (n: number) => Number.isInteger(n) && n >= 0;

/** Pure. Guards the inputs, prices with priceAdvance, and derives the terms from the priced offer. */
export function underwrite(input: UnderwriteInput, params: PricingParams = DEFAULT_PRICING): Underwriting {
  const { freelancer: f, client: c, milestone: m } = input;
  const no = (reason: string): Underwriting => ({ offer: { eligible: false, reason }, terms: null });
  if (!Number.isInteger(m.amountMinor) || m.amountMinor <= 0) return no("milestone has no amount");
  if (![f.verifiedPasses, f.verifiedFails, f.outstandingMinor, f.limitMinor, c.vetoes, c.openDisputes, c.outstandingMinor, c.limitMinor, m.deterministicCriteria, m.judgmentCriteria].every(isCount)) {
    return no("record is malformed");
  }
  if (f.outstandingMinor >= f.limitMinor) return no("freelancer advance limit reached");
  if (c.outstandingMinor >= c.limitMinor) return no("client exposure limit reached");

  const offer = priceAdvance(m, f, c, params);
  if (!offer.eligible) return { offer, terms: null };
  const days = Math.max(1, Math.ceil(m.daysUntilDue));
  return {
    offer,
    terms: {
      principalMinor: offer.principalMinor,
      feeBpsPerDay: offer.feeBpsPerDay,
      days,
      expectedFeeMinor: offer.expectedFeeMinor,
      repaymentMinor: offer.principalMinor + offer.expectedFeeMinor,
      pFail: offer.pFail,
      expectedLossMinor: offer.expectedLossMinor,
    },
  };
}

/** Whole days from `now` until `dueAt` (at least 0); DEFAULT_HORIZON_DAYS without a due date. */
export function daysUntil(dueAt: Date | null | undefined, now: Date = new Date()): number {
  if (!dueAt) return DEFAULT_HORIZON_DAYS;
  return Math.max(0, Math.ceil((dueAt.getTime() - now.getTime()) / DAY_MS));
}

/** Judgment and visual criteria are graded by the model; the rest are checked deterministically. */
export function criteriaCounts(kinds: readonly string[]): { deterministicCriteria: number; judgmentCriteria: number } {
  let judgmentCriteria = 0;
  for (const k of kinds) if (k === "judgment" || k === "visual") judgmentCriteria++;
  return { deterministicCriteria: kinds.length - judgmentCriteria, judgmentCriteria };
}

/** One plain sentence built from the numbers, used when no model is configured (and stored on the advance). */
export function describeOffer(u: Underwriting, currency: string): string {
  if (!u.offer.eligible) return `No advance is offered: ${u.offer.reason}.`;
  if (!u.terms) return "No advance is offered.";
  const t = u.terms;
  const fmt = (minor: number) => `${(minor / 100).toFixed(2)} ${currency}`;
  return (
    `You can get ${fmt(t.principalMinor)} now for a fee of ${(t.feeBpsPerDay / 100).toFixed(2)}% per day, ` +
    `${fmt(t.expectedFeeMinor)} over ${t.days} day${t.days === 1 ? "" : "s"}, so ${fmt(t.repaymentMinor)} is deducted from the release; ` +
    `the amount reflects an estimated ${Math.round(t.pFail * 100)}% chance the milestone does not pass verification.`
  );
}

// ---------- DB readers ----------

export interface Records {
  freelancer: FreelancerRecord;
  client: ClientRecord;
}

const one = async (db: Db, text: string, values: unknown[]): Promise<number> => {
  const res = await db.$client.query<{ n: string | number | null }>(text, values);
  return Number(res.rows[0]?.n ?? 0);
};

/**
 * Derives both records from the database:
 *  - verified passes: `milestone.released` audit rows with detail.verifiedPass = true for the freelancer
 *    (detail.freelancerId, or a contract of theirs);
 *  - fails: `milestone.held` audit rows on the freelancer's contracts (or naming them in detail.freelancerId);
 *  - vetoes: `client.veto` audit rows by the client or on the client's contracts;
 *  - open disputes: `dispute.opened` minus `dispute.resolved` audit rows on the client's contracts;
 *  - outstanding: principal of advances that are offered (accepted, awaiting funding) or funded, through
 *    milestones -> contracts. An accepted advance counts so two accepts cannot both use the same headroom.
 * Limits default to DEFAULT_LIMITS.
 */
export async function loadRecords(db: Db, freelancerId: string, clientId: string, limits: { freelancerMinor?: number; clientMinor?: number } = {}): Promise<Records> {
  const passes = one(
    db,
    `select count(*) as n from audit_log a
      where a.event = 'milestone.released' and (a.detail->>'verifiedPass') = 'true'
        and (a.detail->>'freelancerId' = $1 or a.contract_id in (select id from contracts where freelancer_id = $1))`,
    [freelancerId],
  );
  const fails = one(
    db,
    `select count(*) as n from audit_log a
      where a.event = 'milestone.held'
        and (a.detail->>'freelancerId' = $1 or a.contract_id in (select id from contracts where freelancer_id = $1))`,
    [freelancerId],
  );
  const fOut = one(
    db,
    `select coalesce(sum(ad.principal_minor), 0) as n from advances ad
       join milestones m on m.id = ad.milestone_id join contracts c on c.id = m.contract_id
      where c.freelancer_id = $1 and ad.status in ('offered', 'funded')`,
    [freelancerId],
  );
  const vetoes = one(
    db,
    `select count(*) as n from audit_log a
      where a.event = 'client.veto' and (a.actor = $1 or a.contract_id in (select id from contracts where client_id = $1))`,
    [clientId],
  );
  const disputes = one(
    db,
    `select count(*) filter (where a.event = 'dispute.opened') - count(*) filter (where a.event = 'dispute.resolved') as n
       from audit_log a where a.contract_id in (select id from contracts where client_id = $1)`,
    [clientId],
  );
  const cOut = one(
    db,
    `select coalesce(sum(ad.principal_minor), 0) as n from advances ad
       join milestones m on m.id = ad.milestone_id join contracts c on c.id = m.contract_id
      where c.client_id = $1 and ad.status in ('offered', 'funded')`,
    [clientId],
  );
  const [p, f, fo, v, d, co] = await Promise.all([passes, fails, fOut, vetoes, disputes, cOut]);
  return {
    freelancer: { verifiedPasses: p, verifiedFails: f, outstandingMinor: fo, limitMinor: limits.freelancerMinor ?? DEFAULT_LIMITS.freelancerMinor },
    client: { vetoes: v, openDisputes: Math.max(0, d), outstandingMinor: co, limitMinor: limits.clientMinor ?? DEFAULT_LIMITS.clientMinor },
  };
}

/** Statuses an advance can be offered in: funded, before any delivery is verified. */
export const ADVANCE_MILESTONE_STATUSES = ["funded"] as const;

export interface UnderwritingContext extends Underwriting {
  milestoneId: string;
  contractId: string;
  freelancerId: string;
  clientId: string;
  currency: string;
  amountMinor: number;
  records: Records;
  pricing: MilestoneForPricing;
}

/**
 * Loads the milestone, its criteria and both records, then underwrites. Null when the milestone does not exist.
 * A milestone that is not funded, not advance-eligible or past `funded` comes back with an ineligible offer.
 */
export async function loadUnderwriting(db: Db, milestoneId: string, now: Date = new Date(), params: PricingParams = DEFAULT_PRICING): Promise<UnderwritingContext | null> {
  const m = await db.query.milestones.findFirst({ where: (t, { eq }) => eq(t.id, milestoneId) });
  if (!m) return null;
  const c = await db.query.contracts.findFirst({ where: (t, { eq }) => eq(t.id, m.contractId) });
  if (!c) return null;
  const crit = await db.query.criteria.findMany({ columns: { kind: true }, where: (t, { eq }) => eq(t.milestoneId, m.id) });
  const records = await loadRecords(db, c.freelancerId, c.clientId);
  const pricing: MilestoneForPricing = {
    amountMinor: m.amountMinor,
    funded: (ADVANCE_MILESTONE_STATUSES as readonly string[]).includes(m.status),
    ...criteriaCounts(crit.map((x) => x.kind)),
    daysUntilDue: daysUntil(m.dueAt, now),
  };
  const base = { milestoneId: m.id, contractId: c.id, freelancerId: c.freelancerId, clientId: c.clientId, currency: c.currency, amountMinor: m.amountMinor, records, pricing };
  if (!m.advanceEligible) return { ...base, offer: { eligible: false, reason: "milestone is not eligible for an advance" }, terms: null };
  if (m.status !== "draft" && !pricing.funded) return { ...base, offer: { eligible: false, reason: `milestone is ${m.status}; advances are offered only before delivery` }, terms: null };
  return { ...base, ...underwrite({ freelancer: records.freelancer, client: records.client, milestone: pricing }, params) };
}

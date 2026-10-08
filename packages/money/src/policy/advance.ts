/**
 * Milestone Advance underwriting. `underwrite` is pure: it prices the advance with `priceAdvance` and spells out the
 * terms the freelancer agrees to. `loadRecords` / `loadUnderwriting` read the inputs from Postgres (audit_log,
 * advances, contracts, milestones, criteria) and never write. Nothing here moves money.
 */
import { accounts, asInt, formatMinor, ledgerRefs, loadMilestone, type Db, type Executor } from "@milestone/core";
import { DEFAULT_PRICING, priceAdvance, type AdvanceOffer, type ClientRecord, type FreelancerRecord, type MilestoneForPricing, type PricingParams } from "./pricing.ts";

/** Default credit limits in minor units when nothing more specific is known. */
export const DEFAULT_LIMITS = { freelancerMinor: 50_000, clientMinor: 100_000 } as const;
/** Days assumed until release when a milestone has no due date. */
export const DEFAULT_HORIZON_DAYS = 14;
export const DAY_MS = 86_400_000;

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
  const fmt = (minor: number) => formatMinor(minor, currency);
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

/** Advance statuses whose principal still counts against both limits. */
const OUTSTANDING_ADVANCE_STATUSES = ["offered", "funded", "shortfall"];

/**
 * Derives both records from the database:
 *  - verified passes: `milestone.released` audit rows with detail.verifiedPass = true for the freelancer
 *    (detail.freelancerId, or a contract of theirs);
 *  - fails: `milestone.held` audit rows on the freelancer's contracts (or naming them in detail.freelancerId);
 *  - vetoes: `client.veto` audit rows by the client or on the client's contracts;
 *  - open disputes: `dispute.opened` minus `dispute.resolved` audit rows on the client's contracts;
 *  - outstanding: principal of advances that are offered (accepted, awaiting funding), funded, or in shortfall
 *    (repaid short, the rest still owed), through milestones -> contracts. An accepted advance counts so two accepts
 *    cannot both use the same headroom; a shortfall counts until it is collected in full.
 * Limits default to DEFAULT_LIMITS. Two reads: one pass over audit_log, one over advances.
 */
export async function loadRecords(db: Db, freelancerId: string, clientId: string, limits: { freelancerMinor?: number; clientMinor?: number } = {}): Promise<Records> {
  const audits = db.$client.query<{ passes: string; fails: string; vetoes: string; disputes: string }>(
    `with fc as (select id from contracts where freelancer_id = $1),
          cc as (select id from contracts where client_id = $2)
     select
       count(*) filter (where a.event = 'milestone.released' and (a.detail->>'verifiedPass') = 'true'
                          and (a.detail->>'freelancerId' = $1 or a.contract_id in (select id from fc))) as passes,
       count(*) filter (where a.event = 'milestone.held'
                          and (a.detail->>'freelancerId' = $1 or a.contract_id in (select id from fc))) as fails,
       count(*) filter (where a.event = 'client.veto' and (a.actor = $2 or a.contract_id in (select id from cc))) as vetoes,
       count(*) filter (where a.event = 'dispute.opened' and a.contract_id in (select id from cc))
         - count(*) filter (where a.event = 'dispute.resolved' and a.contract_id in (select id from cc)) as disputes
       from audit_log a
      where a.event in ('milestone.released', 'milestone.held', 'client.veto', 'dispute.opened', 'dispute.resolved')`,
    [freelancerId, clientId],
  );
  const outstanding = db.$client.query<{ f_out: string; c_out: string }>(
    `select coalesce(sum(ad.principal_minor) filter (where c.freelancer_id = $1), 0) as f_out,
            coalesce(sum(ad.principal_minor) filter (where c.client_id = $2), 0) as c_out
       from advances ad
       join milestones m on m.id = ad.milestone_id join contracts c on c.id = m.contract_id
      where ad.status = any($3) and (c.freelancer_id = $1 or c.client_id = $2)`,
    [freelancerId, clientId, OUTSTANDING_ADVANCE_STATUSES],
  );
  const [a, o] = await Promise.all([audits, outstanding]);
  const n = (v: string | number | null | undefined) => Number(v ?? 0);
  const ar = a.rows[0];
  const or = o.rows[0];
  return {
    freelancer: { verifiedPasses: n(ar?.passes), verifiedFails: n(ar?.fails), outstandingMinor: n(or?.f_out), limitMinor: limits.freelancerMinor ?? DEFAULT_LIMITS.freelancerMinor },
    client: { vetoes: n(ar?.vetoes), openDisputes: Math.max(0, n(ar?.disputes)), outstandingMinor: n(or?.c_out), limitMinor: limits.clientMinor ?? DEFAULT_LIMITS.clientMinor },
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
  const loaded = await loadMilestone(db, milestoneId);
  if (!loaded) return null;
  const { milestone: m, contract: c } = loaded;
  const [crit, records] = await Promise.all([
    db.query.criteria.findMany({ columns: { kind: true }, where: (t, { eq }) => eq(t.milestoneId, m.id) }),
    loadRecords(db, c.freelancerId, c.clientId),
  ]);
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

// ---------- Advance balances from the ledger ----------

/**
 * Ledger refs that move an advance's balance. The funding posting debits the partner's receivable; repayments credit
 * the receivable (principal) and the partner's fee account. A repayment out of the advance's own milestone uses
 * release:<milestoneId>:partner; a repayment carried to a later release of another milestone uses
 * release:<thatMilestoneId>:partner:<advanceId>. Reversals mirror them under reversal:...
 */
export const advanceRefs = {
  funding: ledgerRefs.advanceFunding,
  repayment: ledgerRefs.advanceRepayment,
  reversal: ledgerRefs.advanceReversal,
} as const;

/** The advance-relevant columns of an advances row. */
export interface AdvanceForRepayment {
  principalMinor: number;
  feeBpsPerDay: number;
  offer: Record<string, unknown>;
  fundedAt: Date | null;
}

/**
 * What the partner is owed out of the release. The fee is the offer's quoted expectedFeeMinor; if the offer has none,
 * it is accrued from fundedAt to the decision time (at least one day). Both inputs are fixed once the decision is
 * made, so the release job (payout amount) and the settle job (ledger entries) always compute the same number.
 */
export function advanceRepayment(a: AdvanceForRepayment, decidedAt: Date | null): { principalMinor: number; feeMinor: number; repaymentMinor: number } {
  const quoted = asInt(a.offer.expectedFeeMinor, 0);
  const days = a.fundedAt && decidedAt ? Math.max(1, Math.ceil((decidedAt.getTime() - a.fundedAt.getTime()) / DAY_MS)) : 1;
  const feeMinor = quoted ?? Math.floor((a.principalMinor * a.feeBpsPerDay * days) / 10_000);
  return { principalMinor: a.principalMinor, feeMinor, repaymentMinor: a.principalMinor + feeMinor };
}

export interface AdvanceKey {
  id: string;
  milestoneId: string;
  partnerId: string;
}

export interface AdvanceLedgerRow {
  ref: string;
  account: string;
  amountMinor: number;
  direction: "debit" | "credit";
  createdAt?: Date | null;
}

export interface AdvanceBalance {
  /** Principal the partner paid out (debit on the receivable under advance:<id>). */
  fundedMinor: number;
  /** Principal credited back to the receivable by repayments, net of reversals. */
  principalRepaidMinor: number;
  /** Fees credited to the partner's fee account by repayments, net of reversals. */
  feeRepaidMinor: number;
  /** The receivable's balance for this advance: funded minus principal repaid. */
  outstandingMinor: number;
  /** Principal and fees credited on or after `since` (net), when a since date was given. */
  repaidSinceMinor: number;
}

/** True when this ledger ref belongs to the advance (its funding, its own repayment or reversal, or a carried one). */
export function isAdvanceRef(ref: string, a: { id: string; milestoneId: string }): boolean {
  if (ref === ledgerRefs.advanceFunding(a.id)) return true;
  if (ref === ledgerRefs.advanceRepayment(a.milestoneId, a) || ref === ledgerRefs.advanceReversal(a.milestoneId, a)) return true;
  return (ref.startsWith("release:") || ref.startsWith("reversal:")) && ref.endsWith(`:partner:${a.id}`);
}

/** Pure. Each advance's balance from the ledger rows of its refs, on its partner's receivable and fee accounts. */
export function advanceBalances(advs: readonly AdvanceKey[], rows: readonly AdvanceLedgerRow[], since?: Date): Map<string, AdvanceBalance> {
  const out = new Map<string, AdvanceBalance>();
  for (const a of advs) {
    const receivable = accounts.partnerReceivable(a.partnerId);
    const fees = accounts.partnerFeeIncome(a.partnerId);
    const b: AdvanceBalance = { fundedMinor: 0, principalRepaidMinor: 0, feeRepaidMinor: 0, outstandingMinor: 0, repaidSinceMinor: 0 };
    for (const r of rows) {
      if ((r.account !== receivable && r.account !== fees) || !isAdvanceRef(r.ref, a)) continue;
      const credit = r.direction === "credit" ? r.amountMinor : -r.amountMinor;
      if (r.ref === ledgerRefs.advanceFunding(a.id)) {
        if (r.account === receivable) b.fundedMinor -= credit;
        continue;
      }
      if (r.account === receivable) b.principalRepaidMinor += credit;
      else b.feeRepaidMinor += credit;
      if (since && r.createdAt && r.createdAt.getTime() >= since.getTime()) b.repaidSinceMinor += credit;
    }
    b.outstandingMinor = b.fundedMinor - b.principalRepaidMinor;
    out.set(a.id, b);
  }
  return out;
}

/** What the partner can still collect on an advance: the receivable balance plus the part of the fee due not yet paid. */
export function remainingOwed(b: Pick<AdvanceBalance, "outstandingMinor" | "feeRepaidMinor">, feeDueMinor: number): { principalMinor: number; feeMinor: number } {
  return { principalMinor: Math.max(0, b.outstandingMinor), feeMinor: Math.max(0, feeDueMinor - Math.max(0, b.feeRepaidMinor)) };
}

const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** Reads the ledger rows of these advances (inside a transaction when `db` is one) and returns their balances. Never writes. */
export async function loadAdvanceBalances(db: Executor, advs: readonly AdvanceKey[], since?: Date): Promise<Map<string, AdvanceBalance>> {
  if (advs.length === 0) return new Map();
  const exact = advs.flatMap((a) => [ledgerRefs.advanceFunding(a.id), ledgerRefs.advanceRepayment(a.milestoneId, a), ledgerRefs.advanceReversal(a.milestoneId, a)]);
  const rows = await db.query.ledgerEntries.findMany({
    columns: { ref: true, account: true, amountMinor: true, direction: true, createdAt: true },
    where: (t, { inArray, like, or }) => or(inArray(t.ref, exact), ...advs.map((a) => like(t.ref, `%:partner:${likeEscape(a.id)}`))),
  });
  return advanceBalances(advs, rows, since);
}

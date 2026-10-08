import { eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { Executor } from "./db.ts";
import { ledgerEntries } from "./schema.ts";

export type Direction = "debit" | "credit";
export interface Entry { account: string; amountMinor: number; direction: Direction }

/** Account naming from the Implementation tab. */
export const accounts = {
  held: (milestoneId: string) => `held:${milestoneId}`,
  freelancer: (userId: string) => `freelancer:${userId}`,
  client: (userId: string) => `client:${userId}`,
  partnerReceivable: (userId: string) => `partner:${userId}:receivable`,
  partnerCash: (userId: string) => `partner:${userId}:cash`,
  partnerFeeIncome: (userId: string) => `partner:${userId}:fees`,
  platformFees: "platform:fees",
} as const;

/** The top-level kind of an account name (the part before the first colon). */
export type AccountKind = "held" | "freelancer" | "client" | "partner" | "platform" | "other";
const ACCOUNT_KINDS: ReadonlySet<string> = new Set(["held", "freelancer", "client", "partner", "platform"]);
export function accountKind(account: string): AccountKind {
  const head = account.split(":", 1)[0] ?? "";
  return ACCOUNT_KINDS.has(head) ? (head as AccountKind) : "other";
}
/** held:<milestoneId>, the escrow account. */
export const isHeldAccount = (account: string): boolean => account.startsWith("held:");
/** freelancer:<userId>. */
export const isFreelancerAccount = (account: string): boolean => account.startsWith("freelancer:");
/** client:<userId>. */
export const isClientAccount = (account: string): boolean => account.startsWith("client:");
/** partner:<userId>:receivable | :cash | :fees. */
export const isPartnerAccount = (account: string): boolean => account.startsWith("partner:");

export type PayoutParty = "partner" | "freelancer";

/**
 * Ledger refs, one builder for every posting. The formats are load-bearing: balances, the advance ledger and the
 * (ref, account, direction) unique index all key on them, so never change one.
 *  - capture: the PayPal capture id itself (funding: debit client, credit held).
 *  - release: release:<m> for the freelancer item, release:<m>:partner for the partner item.
 *  - refund / reversal: refund:<m>; reversal:<m>:<party>.
 *  - advances: advance:<advanceId> funding; a repayment / its reversal out of release milestone R is
 *    release:R:partner (reversal:R:partner) for R's own advance, release:R:partner:<advanceId> for a carried one.
 *  - dispute: dispute:<disputeId> (an accepted claim).
 */
export const ledgerRefs = {
  capture: (captureId: string) => captureId,
  release: (milestoneId: string, party: PayoutParty = "freelancer") => (party === "freelancer" ? `release:${milestoneId}` : `release:${milestoneId}:partner`),
  refund: (milestoneId: string) => `refund:${milestoneId}`,
  reversal: (milestoneId: string, party: PayoutParty) => `reversal:${milestoneId}:${party}`,
  advanceFunding: (advanceId: string) => `advance:${advanceId}`,
  advanceRepayment: (releaseMilestoneId: string, a: { id: string; milestoneId: string }) =>
    a.milestoneId === releaseMilestoneId ? `release:${releaseMilestoneId}:partner` : `release:${releaseMilestoneId}:partner:${a.id}`,
  advanceReversal: (releaseMilestoneId: string, a: { id: string; milestoneId: string }) =>
    a.milestoneId === releaseMilestoneId ? `reversal:${releaseMilestoneId}:partner` : `reversal:${releaseMilestoneId}:partner:${a.id}`,
  dispute: (disputeId: string) => `dispute:${disputeId}`,
} as const;

export function signed(e: Entry): number {
  return e.direction === "debit" ? e.amountMinor : -e.amountMinor;
}

/** Pure: a transaction is balanced when debits equal credits and every amount is a positive integer. */
export function assertBalanced(entries: Entry[]): void {
  if (entries.length < 2) throw new Error("a transaction needs at least two entries");
  for (const e of entries) {
    if (!Number.isInteger(e.amountMinor) || e.amountMinor <= 0) throw new Error(`bad amount ${e.amountMinor} on ${e.account}`);
  }
  const sum = entries.reduce((s, e) => s + signed(e), 0);
  if (sum !== 0) throw new Error(`transaction does not balance: ${sum}`);
}

/** Posts one balanced transaction. Call inside db.transaction() together with the state change it explains. */
export async function postTransaction(db: Executor, input: { ref: string; currency: string; entries: Entry[]; txnId?: string }) {
  assertBalanced(input.entries);
  const txnId = input.txnId ?? randomUUID();
  await db.insert(ledgerEntries).values(
    input.entries.map((e) => ({ id: randomUUID(), txnId, account: e.account, amountMinor: e.amountMinor, currency: input.currency, direction: e.direction, ref: input.ref })),
  );
  return txnId;
}

/** Balance = debits - credits, so asset-like accounts (held, partner cash) read positive. */
export async function balance(db: Executor, account: string): Promise<number> {
  const [row] = await db
    .select({ bal: sql<number>`coalesce(sum(case when ${ledgerEntries.direction} = 'debit' then ${ledgerEntries.amountMinor} else -${ledgerEntries.amountMinor} end), 0)::bigint` })
    .from(ledgerEntries)
    .where(eq(ledgerEntries.account, account));
  return Number(row?.bal ?? 0);
}

/** The release transaction from the Implementation tab, with an optional outstanding advance repaid first. */
export function releaseEntries(p: { milestoneId: string; freelancerId: string; amountMinor: number; advance?: { partnerId: string; principalMinor: number; feeMinor: number } }): Entry[] {
  const entries: Entry[] = [{ account: accounts.held(p.milestoneId), amountMinor: p.amountMinor, direction: "debit" }];
  let remaining = p.amountMinor;
  if (p.advance) {
    const principal = Math.min(p.advance.principalMinor, remaining);
    remaining -= principal;
    if (principal > 0) entries.push({ account: accounts.partnerReceivable(p.advance.partnerId), amountMinor: principal, direction: "credit" });
    const fee = Math.min(p.advance.feeMinor, remaining);
    remaining -= fee;
    if (fee > 0) entries.push({ account: accounts.partnerFeeIncome(p.advance.partnerId), amountMinor: fee, direction: "credit" });
  }
  if (remaining > 0) entries.push({ account: accounts.freelancer(p.freelancerId), amountMinor: remaining, direction: "credit" });
  return entries;
}

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { DEFAULT_PRICING } from "../src/policy/pricing.ts";
import { advanceBalances, advanceRefs, criteriaCounts, daysUntil, describeOffer, isAdvanceRef, remainingOwed, underwrite, DEFAULT_HORIZON_DAYS, type AdvanceLedgerRow, type UnderwriteInput } from "../src/policy/advance.ts";

const base = (): UnderwriteInput => ({
  freelancer: { verifiedPasses: 5, verifiedFails: 0, outstandingMinor: 0, limitMinor: 50_000 },
  client: { vetoes: 0, openDisputes: 0, outstandingMinor: 0, limitMinor: 100_000 },
  milestone: { amountMinor: 10_000, funded: true, deterministicCriteria: 2, judgmentCriteria: 1, daysUntilDue: 14 },
});
const reason = (u: ReturnType<typeof underwrite>) => (u.offer.eligible ? null : u.offer.reason);

describe("underwrite", () => {
  it("prices the seeded demo milestone and derives the terms", () => {
    const u = underwrite(base());
    expect(u.offer.eligible).toBe(true);
    if (!u.offer.eligible || !u.terms) throw new Error("expected an offer");
    // pFail = (0 + 1) / (5 + 3); k_judgment = 1 - 1/3 * 0.5; 0.8 * 0.875 * 0.8333 * 10000
    expect(u.offer.pFail).toBeCloseTo(0.125);
    expect(u.terms.principalMinor).toBe(5833);
    expect(u.terms.expectedFeeMinor).toBe(Math.floor((5833 * 10 * 14) / 10_000));
    expect(u.terms.repaymentMinor).toBe(u.terms.principalMinor + u.terms.expectedFeeMinor);
    expect(u.terms.days).toBe(14);
    expect(u.terms.expectedLossMinor).toBe(u.offer.expectedLossMinor);
    expect(describeOffer(u, "USD")).toContain("58.33 USD");
  });

  it("refuses an unfunded milestone, a new freelancer, judgment-only work and a disputing client", () => {
    const b = base();
    expect(reason(underwrite({ ...b, milestone: { ...b.milestone, funded: false } }))).toMatch(/not funded/);
    expect(reason(underwrite({ ...b, freelancer: { ...b.freelancer, verifiedPasses: 0 } }))).toMatch(/verified pass/);
    expect(reason(underwrite({ ...b, milestone: { ...b.milestone, deterministicCriteria: 0 } }))).toMatch(/judgment/);
    expect(reason(underwrite({ ...b, client: { ...b.client, openDisputes: 1 } }))).toMatch(/dispute/);
    expect(underwrite({ ...b, milestone: { ...b.milestone, funded: false } }).terms).toBeNull();
  });

  it("refuses when either limit is used up and caps the principal at the headroom", () => {
    const b = base();
    expect(reason(underwrite({ ...b, freelancer: { ...b.freelancer, outstandingMinor: 50_000 } }))).toMatch(/freelancer advance limit/);
    expect(reason(underwrite({ ...b, client: { ...b.client, outstandingMinor: 100_000 } }))).toMatch(/client exposure limit/);
    const capped = underwrite({ ...b, freelancer: { ...b.freelancer, outstandingMinor: 49_000 } });
    expect(capped.terms?.principalMinor).toBe(1_000);
    const byClient = underwrite({ ...b, client: { ...b.client, outstandingMinor: 99_500 } });
    expect(byClient.terms?.principalMinor).toBe(500);
  });

  it("refuses malformed input", () => {
    const b = base();
    expect(reason(underwrite({ ...b, milestone: { ...b.milestone, amountMinor: 0 } }))).toMatch(/amount/);
    expect(reason(underwrite({ ...b, freelancer: { ...b.freelancer, verifiedFails: -1 } }))).toMatch(/malformed/);
    expect(reason(underwrite({ ...b, client: { ...b.client, vetoes: 1.5 } }))).toMatch(/malformed/);
  });

  it("vetoes and fails shrink the offer", () => {
    const b = base();
    const clean = underwrite(b).terms!.principalMinor;
    expect(underwrite({ ...b, client: { ...b.client, vetoes: 2 } }).terms!.principalMinor).toBeLessThan(clean);
    expect(underwrite({ ...b, freelancer: { ...b.freelancer, verifiedFails: 3 } }).terms!.principalMinor).toBeLessThan(clean);
  });

  it("principal never exceeds any limit or rMax times the amount; repayment is principal + fee", () => {
    const count = fc.integer({ min: 0, max: 50 });
    const minor = fc.integer({ min: 0, max: 2_000_000 });
    fc.assert(
      fc.property(
        fc.record({ amount: fc.integer({ min: 1, max: 5_000_000 }), funded: fc.boolean(), det: fc.integer({ min: 0, max: 6 }), jud: fc.integer({ min: 0, max: 6 }), days: fc.integer({ min: 0, max: 90 }) }),
        fc.record({ passes: count, fails: count, out: minor, limit: minor }),
        fc.record({ vetoes: fc.integer({ min: 0, max: 10 }), disputes: fc.integer({ min: 0, max: 2 }), out: minor, limit: minor }),
        (m, f, c) => {
          const u = underwrite({
            milestone: { amountMinor: m.amount, funded: m.funded, deterministicCriteria: m.det, judgmentCriteria: m.jud, daysUntilDue: m.days },
            freelancer: { verifiedPasses: f.passes, verifiedFails: f.fails, outstandingMinor: f.out, limitMinor: f.limit },
            client: { vetoes: c.vetoes, openDisputes: c.disputes, outstandingMinor: c.out, limitMinor: c.limit },
          });
          if (!u.offer.eligible) {
            expect(u.terms).toBeNull();
            return;
          }
          const t = u.terms!;
          expect(m.funded).toBe(true);
          expect(c.disputes).toBe(0);
          expect(f.passes).toBeGreaterThanOrEqual(DEFAULT_PRICING.minVerifiedPasses);
          expect(Number.isInteger(t.principalMinor)).toBe(true);
          expect(t.principalMinor).toBeGreaterThan(0);
          expect(t.principalMinor).toBeLessThanOrEqual(Math.floor(DEFAULT_PRICING.rMax * m.amount));
          expect(t.principalMinor).toBeLessThanOrEqual(f.limit - f.out);
          expect(t.principalMinor).toBeLessThanOrEqual(c.limit - c.out);
          expect(t.repaymentMinor).toBe(t.principalMinor + t.expectedFeeMinor);
          expect(t.expectedFeeMinor).toBeGreaterThanOrEqual(0);
          expect(t.expectedLossMinor).toBeLessThanOrEqual(t.principalMinor);
          expect(t.days).toBeGreaterThanOrEqual(1);
        },
      ),
      { numRuns: 1000 },
    );
  });
});

describe("helpers", () => {
  it("counts judgment and visual criteria as judgment", () => {
    expect(criteriaCounts(["test", "file", "judgment", "visual", "build", "upload"])).toEqual({ deterministicCriteria: 4, judgmentCriteria: 2 });
  });
  it("days until due rounds up, floors at zero, and defaults without a due date", () => {
    const now = new Date("2026-10-08T00:00:00Z");
    expect(daysUntil(new Date("2026-10-10T01:00:00Z"), now)).toBe(3);
    expect(daysUntil(new Date("2026-10-01T00:00:00Z"), now)).toBe(0);
    expect(daysUntil(null, now)).toBe(DEFAULT_HORIZON_DAYS);
  });
});

describe("advance balances from the ledger", () => {
  const a = { id: "adv_1", milestoneId: "m1", partnerId: "p" };
  const b = { id: "adv_2", milestoneId: "m2", partnerId: "p" };
  const row = (ref: string, account: string, amountMinor: number, direction: "debit" | "credit", createdAt?: Date): AdvanceLedgerRow => ({ ref, account, amountMinor, direction, ...(createdAt ? { createdAt } : {}) });
  const funding = (x: typeof a, minor: number) => [row(advanceRefs.funding(x.id), "partner:p:receivable", minor, "debit"), row(advanceRefs.funding(x.id), "partner:p:cash", minor, "credit")];

  it("names own and carried repayment refs and attributes them to the right advance", () => {
    expect(advanceRefs.repayment("m1", a)).toBe("release:m1:partner");
    expect(advanceRefs.repayment("m3", a)).toBe("release:m3:partner:adv_1");
    expect(advanceRefs.reversal("m3", a)).toBe("reversal:m3:partner:adv_1");
    expect(isAdvanceRef("release:m1:partner", a)).toBe(true);
    expect(isAdvanceRef("release:m3:partner:adv_1", a)).toBe(true);
    expect(isAdvanceRef("release:m3:partner:adv_2", a)).toBe(false);
    expect(isAdvanceRef("release:m2:partner", a)).toBe(false);
    expect(isAdvanceRef("release:m1", a)).toBe(false);
  });

  it("outstanding = funding debit minus principal credits; repaid counts only what was booked", () => {
    const week = new Date("2026-10-01T00:00:00Z");
    const rows = [
      ...funding(a, 5_000),
      ...funding(b, 3_000),
      // m1 released short: 3 000 principal, no fee.
      row("release:m1:partner", "held:m1", 3_000, "debit"),
      row("release:m1:partner", "partner:p:receivable", 3_000, "credit", new Date("2026-09-01T00:00:00Z")),
      // m3 collected the rest of adv_1 (2 000 + 80 fee) this week.
      row("release:m3:partner:adv_1", "held:m3", 2_080, "debit"),
      row("release:m3:partner:adv_1", "partner:p:receivable", 2_000, "credit", new Date("2026-10-05T00:00:00Z")),
      row("release:m3:partner:adv_1", "partner:p:fees", 80, "credit", new Date("2026-10-05T00:00:00Z")),
      // The freelancer's own posting never counts.
      row("release:m1", "freelancer:f", 1_000, "credit"),
    ];
    const bal = advanceBalances([a, b], rows, week);
    expect(bal.get("adv_1")).toEqual({ fundedMinor: 5_000, principalRepaidMinor: 5_000, feeRepaidMinor: 80, outstandingMinor: 0, repaidSinceMinor: 2_080 });
    expect(bal.get("adv_2")).toEqual({ fundedMinor: 3_000, principalRepaidMinor: 0, feeRepaidMinor: 0, outstandingMinor: 3_000, repaidSinceMinor: 0 });
  });

  it("a reversal re-opens the balance", () => {
    const rows = [
      ...funding(a, 5_000),
      row("release:m1:partner", "partner:p:receivable", 5_000, "credit"),
      row("reversal:m1:partner", "partner:p:receivable", 5_000, "debit"),
    ];
    expect(advanceBalances([a], rows).get("adv_1")?.outstandingMinor).toBe(5_000);
  });

  it("remaining owed adds the unpaid fee and never goes negative", () => {
    expect(remainingOwed({ outstandingMinor: 2_000, feeRepaidMinor: 0 }, 80)).toEqual({ principalMinor: 2_000, feeMinor: 80 });
    expect(remainingOwed({ outstandingMinor: 0, feeRepaidMinor: 50 }, 80)).toEqual({ principalMinor: 0, feeMinor: 30 });
    expect(remainingOwed({ outstandingMinor: -5, feeRepaidMinor: 100 }, 80)).toEqual({ principalMinor: 0, feeMinor: 0 });
  });

  it("property: funded minus repaid always equals outstanding", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1_000_000 }), fc.array(fc.integer({ min: 1, max: 100_000 }), { maxLength: 5 }), (funded, pays) => {
        const rows = [...funding(a, funded), ...pays.map((p, i) => row(`release:m${i + 10}:partner:adv_1`, "partner:p:receivable", p, "credit"))];
        const x = advanceBalances([a], rows).get("adv_1")!;
        return x.outstandingMinor === funded - pays.reduce((s, p) => s + p, 0) && x.principalRepaidMinor + x.outstandingMinor === x.fundedMinor;
      }),
    );
  });
});

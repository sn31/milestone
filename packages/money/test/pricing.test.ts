import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { DEFAULT_PRICING, priceAdvance } from "../src/policy/pricing.js";

describe("priceAdvance", () => {
  it("refuses before the first verified pass", () => {
    const o = priceAdvance({ amountMinor: 1000, funded: true, deterministicCriteria: 1, judgmentCriteria: 0, daysUntilDue: 5 }, { verifiedPasses: 0, verifiedFails: 0, outstandingMinor: 0, limitMinor: 10_000 }, { vetoes: 0, openDisputes: 0, outstandingMinor: 0, limitMinor: 10_000 });
    expect(o.eligible).toBe(false);
  });
  it("never exceeds the ceiling rate or any limit", () => {
    fc.assert(
      fc.property(
        fc.record({ amount: fc.integer({ min: 1, max: 5_000_000 }), det: fc.integer({ min: 1, max: 5 }), jud: fc.integer({ min: 0, max: 5 }), days: fc.integer({ min: 0, max: 60 }) }),
        fc.record({ passes: fc.integer({ min: 1, max: 50 }), fails: fc.integer({ min: 0, max: 50 }), out: fc.integer({ min: 0, max: 1_000_000 }), limit: fc.integer({ min: 0, max: 1_000_000 }) }),
        fc.record({ vetoes: fc.integer({ min: 0, max: 10 }), out: fc.integer({ min: 0, max: 1_000_000 }), limit: fc.integer({ min: 0, max: 1_000_000 }) }),
        (m, f, c) => {
          const o = priceAdvance(
            { amountMinor: m.amount, funded: true, deterministicCriteria: m.det, judgmentCriteria: m.jud, daysUntilDue: m.days },
            { verifiedPasses: f.passes, verifiedFails: f.fails, outstandingMinor: f.out, limitMinor: f.limit },
            { vetoes: c.vetoes, openDisputes: 0, outstandingMinor: c.out, limitMinor: c.limit },
          );
          if (!o.eligible) return;
          expect(o.principalMinor).toBeLessThanOrEqual(Math.floor(DEFAULT_PRICING.rMax * m.amount));
          expect(o.principalMinor).toBeLessThanOrEqual(Math.max(0, f.limit - f.out));
          expect(o.principalMinor).toBeLessThanOrEqual(Math.max(0, c.limit - c.out));
          expect(o.pFail).toBeGreaterThan(0);
          expect(o.pFail).toBeLessThan(1);
        },
      ),
      { numRuns: 500 },
    );
  });
});

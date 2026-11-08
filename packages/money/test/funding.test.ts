/** The funding guarantee (fundingAllows), example by example and as properties. Pure: no database, no PayPal. */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { FUNDING_REFUSALS, fundingAllows, type FundingFacts, type MilestoneStatus } from "@milestone/core";

const now = new Date("2026-10-17T12:00:00Z");
const later = new Date(now.getTime() + 86_400_000);
const earlier = new Date(now.getTime() - 86_400_000);

function facts(over: Partial<FundingFacts> = {}): FundingFacts {
  return {
    mandate: { userId: "usr_c", actions: ["read", "fund"], currency: "USD", expiresAt: later, revokedAt: null, fundCapMinor: 20_000, fundTotalCapMinor: 50_000 },
    contract: { id: "ctr_1", clientId: "usr_c", status: "active", currency: "USD", clientApprovedAt: earlier, freelancerApprovedAt: earlier, aupStatus: "clear" },
    milestone: { id: "mst_2", contractId: "ctr_1", seq: 2, status: "draft", amountMinor: 10_000, paypalCaptureId: null },
    siblings: [
      { id: "mst_1", seq: 1, status: "released" },
      { id: "mst_2", seq: 2, status: "draft" },
      { id: "mst_3", seq: 3, status: "draft" },
    ],
    paymentMethod: { userId: "usr_c", provider: "paypal", paypalPaymentTokenId: "SIM-PMT-1", removedAt: null },
    fundedMinor: 0,
    amountMinor: 10_000,
    currency: "USD",
    captureInProgress: false,
    ...over,
  };
}
const refused = (f: FundingFacts) => {
  const r = fundingAllows(f, now);
  return "refused" in r ? r.refused : null;
};

describe("fundingAllows", () => {
  it("allows the next draft milestone of an approved contract, in currency, within both caps (inclusive)", () => {
    expect(fundingAllows(facts(), now)).toEqual({ ok: true });
    expect(fundingAllows(facts({ fundedMinor: 40_000 }), now)).toEqual({ ok: true });
    const atCap = facts({ amountMinor: 20_000, milestone: { ...facts().milestone, amountMinor: 20_000 } });
    expect(fundingAllows(atCap, now)).toEqual({ ok: true });
  });

  it("refuses with the reason that applies", () => {
    const f = facts();
    expect(refused({ ...f, mandate: { ...f.mandate, revokedAt: earlier } })).toBe("mandate_revoked");
    expect(refused({ ...f, mandate: { ...f.mandate, expiresAt: now } })).toBe("mandate_expired");
    expect(refused({ ...f, mandate: { ...f.mandate, actions: ["read", "approve"] } })).toBe("mandate_missing_action");
    expect(refused({ ...f, paymentMethod: null })).toBe("payment_method_missing");
    expect(refused({ ...f, paymentMethod: { ...f.paymentMethod!, userId: "usr_other" } })).toBe("payment_method_not_owned");
    expect(refused({ ...f, paymentMethod: { ...f.paymentMethod!, removedAt: earlier } })).toBe("payment_method_removed");
    expect(refused({ ...f, contract: { ...f.contract, clientId: "usr_other" } })).toBe("not_contract_client");
    expect(refused({ ...f, contract: { ...f.contract, status: "draft" } })).toBe("contract_not_approved");
    expect(refused({ ...f, contract: { ...f.contract, freelancerApprovedAt: null } })).toBe("contract_not_approved");
    expect(refused({ ...f, contract: { ...f.contract, aupStatus: null } })).toBe("aup_unchecked");
    expect(refused({ ...f, contract: { ...f.contract, aupStatus: "checking" } })).toBe("aup_checking");
    expect(refused({ ...f, contract: { ...f.contract, aupStatus: "review" } })).toBe("aup_review");
    expect(refused({ ...f, contract: { ...f.contract, aupStatus: "rejected" } })).toBe("aup_rejected");
    expect(refused({ ...f, milestone: { ...f.milestone, contractId: "ctr_2" } })).toBe("milestone_not_in_contract");
    expect(refused({ ...f, milestone: { ...f.milestone, status: "funded" } })).toBe("milestone_not_draft");
    expect(refused({ ...f, milestone: { ...f.milestone, paypalCaptureId: "CAP" } })).toBe("capture_in_progress");
    expect(refused({ ...f, captureInProgress: true })).toBe("capture_in_progress");
    expect(refused({ ...f, milestone: { ...f.milestone, id: "mst_3", seq: 3 } })).toBe("out_of_sequence");
    expect(refused({ ...f, siblings: f.siblings.map((s) => (s.id === "mst_1" ? { ...s, status: "review" as const } : s)) })).toBe("previous_in_escrow");
    expect(refused({ ...f, siblings: f.siblings.map((s) => (s.id === "mst_1" ? { ...s, status: "held" as const } : s)) })).toBe("previous_in_escrow");
    expect(refused({ ...f, amountMinor: 9_999 })).toBe("amount_mismatch");
    expect(refused({ ...f, currency: "EUR" })).toBe("currency_mismatch");
    expect(refused({ ...f, mandate: { ...f.mandate, currency: "EUR" } })).toBe("currency_mismatch");
    expect(refused({ ...f, mandate: { ...f.mandate, fundCapMinor: null } })).toBe("fund_cap_missing");
    expect(refused({ ...f, mandate: { ...f.mandate, fundTotalCapMinor: null } })).toBe("fund_cap_missing");
    expect(refused({ ...f, mandate: { ...f.mandate, fundCapMinor: 9_999 } })).toBe("fund_cap_exceeded");
    expect(refused({ ...f, fundedMinor: 40_001 })).toBe("fund_total_cap_exceeded");
    expect(refused({ ...f, fundedMinor: Number.NaN })).toBe("fund_total_cap_exceeded");
  });

  it("every refusal code it returns is a listed one", () => {
    fc.assert(
      fc.property(arbFacts(), (f) => {
        const r = fundingAllows(f, now);
        return "ok" in r || (FUNDING_REFUSALS as readonly string[]).includes(r.refused);
      }),
      { numRuns: 500 },
    );
  });
});

// ---------- Properties ----------

const STATUSES: MilestoneStatus[] = ["draft", "funded", "verifying", "review", "released", "held", "needs_client", "partial_released"];

/** Mostly `good`, sometimes one of `bad`: each field is perturbed now and then, so oks and every refusal both occur. */
function mostly<T>(good: T, ...bad: T[]): fc.Arbitrary<T> {
  return fc.oneof({ arbitrary: fc.constant(good), weight: 12 }, { arbitrary: fc.constantFrom(...bad), weight: 1 });
}

/** Random facts around the happy path: every field independently perturbed, sometimes. */
function arbFacts(): fc.Arbitrary<FundingFacts> {
  const amount = fc.integer({ min: 1, max: 100_000 });
  const status = fc.oneof({ arbitrary: fc.constantFrom<MilestoneStatus>("draft", "released"), weight: 12 }, { arbitrary: fc.constantFrom(...STATUSES), weight: 2 });
  return fc
    .record({
      revoked: mostly(false, true),
      expiresIn: fc.oneof({ arbitrary: fc.integer({ min: 1, max: 10 }), weight: 12 }, { arbitrary: fc.integer({ min: -10, max: 0 }), weight: 1 }),
      hasFund: mostly(true, false),
      pm: mostly("ok", "missing", "other_user", "removed", "no_token"),
      contractStatus: mostly<"draft" | "approved" | "active" | "closed">("active", "draft", "approved", "closed"),
      clientApproved: mostly(true, false),
      freelancerApproved: mostly(true, false),
      clientIsUser: mostly(true, false),
      statuses: fc.array(status, { minLength: 1, maxLength: 5 }),
      pick: fc.nat(),
      milestoneAmount: amount,
      chargeDelta: mostly(0, 1, -1),
      currency: mostly("USD", "EUR"),
      mandateCurrency: mostly("USD", "EUR"),
      fundCap: fc.option(fc.integer({ min: 0, max: 150_000 }), { nil: null, freq: 12 }),
      totalCap: fc.option(fc.integer({ min: 0, max: 300_000 }), { nil: null, freq: 12 }),
      funded: fc.integer({ min: 0, max: 200_000 }),
      captureId: mostly<string | null>(null, "CAP-1"),
      captureInProgress: mostly(false, true),
      otherContract: mostly(false, true),
      aup: mostly<string | null>("clear", "keywords_only", "cleared", null, "checking", "review", "rejected"),
    })
    .map((r): FundingFacts => {
      const siblings = r.statuses.map((status, i) => ({ id: `mst_${i + 1}`, seq: i + 1, status }));
      const target = siblings[r.pick % siblings.length]!;
      return {
        mandate: { userId: "usr_c", actions: r.hasFund ? ["read", "fund"] : ["read"], currency: r.mandateCurrency, expiresAt: new Date(now.getTime() + r.expiresIn * 60_000), revokedAt: r.revoked ? earlier : null, fundCapMinor: r.fundCap, fundTotalCapMinor: r.totalCap },
        contract: { id: "ctr_1", clientId: r.clientIsUser ? "usr_c" : "usr_x", status: r.contractStatus, currency: "USD", clientApprovedAt: r.clientApproved ? earlier : null, freelancerApprovedAt: r.freelancerApproved ? earlier : null, aupStatus: r.aup },
        milestone: { id: target.id, contractId: r.otherContract ? "ctr_2" : "ctr_1", seq: target.seq, status: target.status, amountMinor: r.milestoneAmount, paypalCaptureId: r.captureId },
        siblings,
        paymentMethod:
          r.pm === "missing"
            ? null
            : { userId: r.pm === "other_user" ? "usr_x" : "usr_c", provider: "paypal", paypalPaymentTokenId: r.pm === "no_token" ? "" : "SIM-PMT-1", removedAt: r.pm === "removed" ? earlier : null },
        fundedMinor: r.funded,
        amountMinor: r.milestoneAmount + r.chargeDelta,
        currency: r.currency,
        captureInProgress: r.captureInProgress,
      };
    });
}

describe("fundingAllows properties: an ok always satisfies the whole guarantee", () => {
  const ok = (f: FundingFacts) => "ok" in fundingAllows(f, now);

  it("never ok over the per-milestone cap or the total cap, nor with a cap missing", () => {
    fc.assert(
      fc.property(arbFacts(), (f) => {
        if (!ok(f)) return true;
        const cap = f.mandate.fundCapMinor;
        const total = f.mandate.fundTotalCapMinor;
        return cap !== null && total !== null && f.amountMinor <= cap && f.fundedMinor + f.amountMinor <= total;
      }),
      { numRuns: 2_000 },
    );
  });

  it("never ok out of sequence, past draft, or with a capture recorded or in flight", () => {
    fc.assert(
      fc.property(arbFacts(), (f) => {
        if (!ok(f)) return true;
        const earlierDraft = f.siblings.some((s) => s.id !== f.milestone.id && s.status === "draft" && s.seq <= f.milestone.seq);
        return f.milestone.status === "draft" && !earlierDraft && f.milestone.paypalCaptureId === null && !f.captureInProgress;
      }),
      { numRuns: 2_000 },
    );
  });

  it("never ok while another milestone of the contract holds money in escrow", () => {
    const escrow = new Set<string>(["funded", "verifying", "review", "needs_client", "held"]);
    fc.assert(
      fc.property(arbFacts(), (f) => !ok(f) || !f.siblings.some((s) => s.id !== f.milestone.id && escrow.has(s.status))),
      { numRuns: 2_000 },
    );
  });

  it("never ok for an unapproved contract, another client's contract or a milestone of another contract", () => {
    fc.assert(
      fc.property(arbFacts(), (f) => {
        if (!ok(f)) return true;
        return f.contract.status === "active" && !!f.contract.clientApprovedAt && !!f.contract.freelancerApprovedAt && f.contract.clientId === f.mandate.userId && f.milestone.contractId === f.contract.id;
      }),
      { numRuns: 2_000 },
    );
  });

  it("never ok unless the PayPal AUP check is clear, keywords only or cleared by an operator", () => {
    fc.assert(
      fc.property(arbFacts(), (f) => !ok(f) || ["clear", "keywords_only", "cleared"].includes(f.contract.aupStatus ?? "")),
      { numRuns: 2_000 },
    );
  });

  it("never ok for a wrong amount or currency", () => {
    fc.assert(
      fc.property(arbFacts(), (f) => {
        if (!ok(f)) return true;
        return f.amountMinor === f.milestone.amountMinor && f.currency === f.contract.currency && f.currency === f.mandate.currency;
      }),
      { numRuns: 2_000 },
    );
  });

  it("never ok with a missing, foreign, tokenless or removed payment method, or an expired, revoked or fund-less mandate", () => {
    fc.assert(
      fc.property(arbFacts(), (f) => {
        if (!ok(f)) return true;
        const pm = f.paymentMethod;
        return (
          !!pm && pm.userId === f.mandate.userId && !!pm.paypalPaymentTokenId && pm.removedAt === null &&
          f.mandate.revokedAt === null && f.mandate.expiresAt.getTime() > now.getTime() && (f.mandate.actions as string[]).includes("fund")
        );
      }),
      { numRuns: 2_000 },
    );
  });

  it("the generator reaches ok often enough for the properties to mean something", () => {
    const samples = fc.sample(arbFacts(), 10_000);
    expect(samples.filter((f) => "ok" in fundingAllows(f, now)).length).toBeGreaterThan(100);
    const reasons = new Set(samples.map((f) => fundingAllows(f, now)).flatMap((r) => ("refused" in r ? [r.refused] : [])));
    expect([...reasons].sort()).toEqual([...FUNDING_REFUSALS].sort());
  });

  it("monotone in the total: funding more never turns a refusal into an ok", () => {
    fc.assert(
      fc.property(arbFacts(), fc.integer({ min: 0, max: 100_000 }), (f, more) => {
        if (ok(f)) return true;
        return !ok({ ...f, fundedMinor: f.fundedMinor + more });
      }),
      { numRuns: 1_000 },
    );
  });
});

import { describe, expect, it } from "vitest";
import { accountLabel, refLabel, refShort, txnKind } from "@/components/ledger-labels";
import { payoutFailureLine, payoutReason } from "@/lib/payout-failure";
import { eventSentence } from "@/app/contracts/[id]/activity/sentence";

describe("ledger labels", () => {
  it("names a transaction by what its legs did", () => {
    expect(txnKind([{ account: "client:usr_client", direction: "debit", ref: "CAP-1" }, { account: "held:mst_3", direction: "credit", ref: "CAP-1" }])).toBe("fund");
    expect(txnKind([{ account: "held:mst_3", direction: "debit", ref: "release:mst_3" }, { account: "freelancer:usr_freelancer", direction: "credit", ref: "release:mst_3" }])).toBe("release");
    expect(
      txnKind([
        { account: "held:mst_3", direction: "debit", ref: "release:mst_3:partner" },
        { account: "partner:usr_partner:receivable", direction: "credit", ref: "release:mst_3:partner" },
        { account: "partner:usr_partner:fees", direction: "credit", ref: "release:mst_3:partner" },
      ]),
    ).toBe("repayment");
    expect(txnKind([{ account: "held:mst_3", direction: "debit", ref: "refund:mst_3" }, { account: "client:usr_client", direction: "credit", ref: "refund:mst_3" }])).toBe("refund");
    expect(txnKind([{ account: "partner:usr_partner:receivable", direction: "debit", ref: "advance:adv_1" }, { account: "partner:usr_partner:cash", direction: "credit", ref: "advance:adv_1" }])).toBe("advance");
  });

  it("drops an owner id that only repeats the family", () => {
    expect(accountLabel("partner:usr_partner:receivable")).toEqual({ family: "partner", rest: "receivable" });
    expect(accountLabel("freelancer:usr_freelancer")).toEqual({ family: "freelancer", rest: "" });
    expect(accountLabel("held:mst_3")).toEqual({ family: "held", rest: "mst_3" });
    expect(refLabel("release:mst_3:partner")).toBe("release · mst_3 · partner");
    expect(refLabel("SIM-CAP-SHOW330K2F")).toBe("SIM-CAP-SHOW330K2F");
  });

  it("drops the milestone id from a ref shown beside its milestone", () => {
    expect(refShort("release:mst_3:partner")).toBe("release · partner");
    expect(refShort("release:mst_3")).toBe("release");
    expect(refShort("advance:adv_show_repaid")).toBe("adv_show_repaid");
    expect(refShort("SIM-CAP-SHOW330K2F")).toBe("SIM-CAP-SHOW330K2F");
  });
});

describe("payout failure wording", () => {
  it("reads the live flag and the seeded flag the same way", () => {
    const live = payoutFailureLine({ reason: "Payout PAYMENT.PAYOUTS-ITEM.FAILED for the freelancer: Receiver is unregistered" });
    const seeded = payoutFailureLine({ reason: "A payout item failed", failed: { freelancer: "Receiver is unregistered" } });
    expect(live).toBe("Payout to the freelancer failed: receiver is not registered with PayPal.");
    expect(seeded).toBe(live);
    expect(payoutReason("Receiver's account is locked or inactive")).toBe("receiver's PayPal account is locked or inactive");
  });
});

describe("audit sentences", () => {
  it("says what happened in words", () => {
    expect(eventSentence("policy.decided", { action: "hold", ruleIds: ["P2"], amountMinor: 0, reason: "Required criteria failed: X." })).toBe("Hold · P2: required criteria failed: X");
    expect(eventSentence("milestone.funded", { amountMinor: 10000, currency: "USD" })).toBe("Funded into escrow: $100.00");
    expect(eventSentence("dispute.drafted", { redacted: true })).toMatch(/private to the freelancer/);
    expect(eventSentence("something.odd_thing", { reason: "why" })).toBe("Odd thing: why");
  });
});

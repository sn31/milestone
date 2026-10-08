import { describe, expect, it } from "vitest";
import {
  canHold,
  deriveOpStatus,
  itemStatusFor,
  ledgerRef,
  mergeItemOutcome,
  paidTotal,
  parsePayoutItemEvent,
  parseRefundEvent,
  receiptInvoiceNumber,
  settleTarget,
  settlesMilestone,
} from "../src/jobs/settle.js";

const mid = "3f0c2a5e-8f6b-4d1e-9a7c-0b1d2e3f4a5b";

describe("parsePayoutItemEvent", () => {
  it("reads a succeeded release item", () => {
    const e = parsePayoutItemEvent({
      id: "WH-1",
      event_type: "PAYMENT.PAYOUTS-ITEM.SUCCEEDED",
      resource: { payout_item_id: "ITEM1", payout_batch_id: "BATCH1", transaction_status: "SUCCESS", payout_item: { sender_item_id: `${mid}:freelancer` } },
    });
    expect(e).toEqual({ senderItemId: `${mid}:freelancer`, milestoneId: mid, party: "freelancer", payoutBatchId: "BATCH1", payoutItemId: "ITEM1", transactionStatus: "SUCCESS", reason: "SUCCESS" });
  });

  it("reads the failure reason", () => {
    const e = parsePayoutItemEvent({ resource: { transaction_status: "FAILED", errors: { name: "RECEIVER_UNREGISTERED", message: "Receiver is unregistered" }, payout_item: { sender_item_id: `${mid}:partner` } } });
    expect(e.party).toBe("partner");
    expect(e.reason).toBe("Receiver is unregistered");
  });

  it("falls back to a top-level sender_item_id", () => {
    expect(parsePayoutItemEvent({ resource: { sender_item_id: `${mid}:partner` } }).milestoneId).toBe(mid);
  });

  it("does not treat an advance-funding item as a release item", () => {
    const e = parsePayoutItemEvent({ resource: { payout_item: { sender_item_id: "advance-123" } } });
    expect(e.senderItemId).toBe("advance-123");
    expect(e.party).toBeUndefined();
    expect(e.milestoneId).toBeUndefined();
  });

  it("survives junk payloads", () => {
    expect(parsePayoutItemEvent(null)).toEqual({});
    expect(parsePayoutItemEvent({ resource: "nope" })).toEqual({});
    expect(parsePayoutItemEvent({ resource: { payout_item: { sender_item_id: `${mid}:someone` } } }).party).toBeUndefined();
  });
});

describe("settlesMilestone", () => {
  it("settles on the freelancer item", () => {
    expect(settlesMilestone("freelancer", { freelancerShareMinor: 9_680 })).toBe(true);
  });
  it("settles on the partner item only when the partner took the whole release", () => {
    expect(settlesMilestone("partner", { freelancerShareMinor: 9_680 })).toBe(false);
    expect(settlesMilestone("partner", { freelancerShareMinor: 0 })).toBe(true);
  });
});

describe("settleTarget", () => {
  it("maps the decision action to the final state", () => {
    expect(settleTarget("release")).toBe("released");
    expect(settleTarget("partial")).toBe("partial_released");
  });
});

describe("canHold", () => {
  it("follows the transition table", () => {
    expect(canHold("review")).toBe(true);
    expect(canHold("needs_client")).toBe(true);
    expect(canHold("held")).toBe(true);
    expect(canHold("released")).toBe(false);
    expect(canHold("partial_released")).toBe(false);
  });
});

describe("receiptInvoiceNumber", () => {
  it("is deterministic and fits PayPal's 25 character limit", () => {
    const n = receiptInvoiceNumber(mid);
    expect(n).toBe(receiptInvoiceNumber(mid));
    expect(n.length).toBeLessThanOrEqual(25);
    expect(n.startsWith("MS-")).toBe(true);
  });
});

describe("parsePayoutItemEvent amount", () => {
  it("reads payout_item.amount", () => {
    const e = parsePayoutItemEvent({ resource: { payout_item: { sender_item_id: `${mid}:freelancer`, amount: { value: "96.80", currency: "USD" } } } });
    expect(e).toMatchObject({ amountValue: "96.80", currency: "USD" });
  });
});

describe("parseRefundEvent", () => {
  it("reads the refund id, amount and capture id from the up link", () => {
    const e = parseRefundEvent({
      resource: {
        id: "REF1",
        status: "COMPLETED",
        amount: { value: "200.00", currency_code: "USD" },
        links: [{ rel: "self", href: "https://api.sandbox.paypal.com/v2/payments/refunds/REF1" }, { rel: "up", href: "https://api.sandbox.paypal.com/v2/payments/captures/CAP9" }],
      },
    });
    expect(e).toEqual({ refundId: "REF1", status: "COMPLETED", amountValue: "200.00", currency: "USD", captureId: "CAP9" });
  });
  it("survives junk", () => {
    expect(parseRefundEvent(null)).toEqual({});
    expect(parseRefundEvent({ resource: { links: "x" } })).toEqual({});
  });
});

describe("itemStatusFor", () => {
  it("maps payout item events", () => {
    expect(itemStatusFor("PAYMENT.PAYOUTS-ITEM.SUCCEEDED")).toBe("succeeded");
    expect(itemStatusFor("PAYMENT.PAYOUTS-ITEM.FAILED")).toBe("failed");
    expect(itemStatusFor("PAYMENT.PAYOUTS-ITEM.BLOCKED")).toBe("failed");
    expect(itemStatusFor("PAYMENT.CAPTURE.REFUNDED")).toBeNull();
  });
});

describe("mergeItemOutcome (F6)", () => {
  const ok = { status: "succeeded" as const, amountMinor: 9_680, eventId: "e1", payoutItemId: "I1" };
  const bad = { status: "failed" as const, amountMinor: 9_680, eventId: "e2", reason: "BLOCKED" };
  const response = { batch_header: { payout_batch_id: "B1" } };

  it("records an item without losing PayPal's batch response", () => {
    const r = mergeItemOutcome(response, "freelancer", ok);
    expect(r).toEqual({ changed: true, conflict: false, response: { batch_header: { payout_batch_id: "B1" }, items: { freelancer: ok } } });
  });
  it("keeps both parties' items", () => {
    const a = mergeItemOutcome(response, "partner", ok).response;
    const b = mergeItemOutcome(a, "freelancer", bad).response;
    expect(b.items).toEqual({ partner: ok, freelancer: bad });
  });
  it("is idempotent for a repeated event and reports a contradicting one without applying it", () => {
    const a = mergeItemOutcome(response, "freelancer", ok).response;
    expect(mergeItemOutcome(a, "freelancer", ok)).toMatchObject({ changed: false, conflict: false });
    const c = mergeItemOutcome(a, "freelancer", bad);
    expect(c).toMatchObject({ changed: false, conflict: true });
    expect((c.response.items as Record<string, unknown>).freelancer).toEqual(ok);
  });
  it("starts from nothing on a junk response", () => {
    expect(mergeItemOutcome(null, "partner", ok).response).toEqual({ items: { partner: ok } });
  });
});

describe("deriveOpStatus", () => {
  const both = { partnerShareMinor: 40_320, freelancerShareMinor: 9_680 };
  const ok = { status: "succeeded" as const, amountMinor: 1, eventId: "e" };
  const bad = { status: "failed" as const, amountMinor: 1, eventId: "e" };
  it("waits for every party with a share", () => {
    expect(deriveOpStatus(both, {})).toBe("sent");
    expect(deriveOpStatus(both, { partner: ok })).toBe("sent");
    expect(deriveOpStatus(both, { partner: ok, freelancer: ok })).toBe("succeeded");
    expect(deriveOpStatus({ partnerShareMinor: 0, freelancerShareMinor: 9_680 }, { freelancer: ok })).toBe("succeeded");
  });
  it("fails the op on any failed item, even after another succeeded", () => {
    expect(deriveOpStatus(both, { partner: ok, freelancer: bad })).toBe("failed");
    expect(deriveOpStatus(both, { partner: bad })).toBe("failed");
  });
});

describe("paidTotal", () => {
  it("sums what PayPal reported, falling back to the claimed share", () => {
    const shares = { partnerShareMinor: 40_320, freelancerShareMinor: 9_680 };
    expect(paidTotal(shares, { partner: { status: "succeeded", amountMinor: 40_000, eventId: "a" }, freelancer: { status: "succeeded", amountMinor: null, eventId: "b" } })).toBe(49_680);
    expect(paidTotal(shares, { partner: { status: "succeeded", amountMinor: 40_320, eventId: "a" }, freelancer: { status: "failed", amountMinor: 9_680, eventId: "b" } })).toBe(40_320);
  });
});

describe("ledgerRef (F10)", () => {
  it("is one ref per milestone and party, not per event", () => {
    expect(ledgerRef.release(mid, "freelancer")).toBe(`release:${mid}`);
    expect(ledgerRef.release(mid, "partner")).toBe(`release:${mid}:partner`);
    expect(ledgerRef.refund(mid)).toBe(`refund:${mid}`);
  });
});

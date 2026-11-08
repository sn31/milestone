import { describe, expect, it } from "vitest";
import { ledgerRefs as ledgerRef } from "@milestone/core";
import { parsePayoutBatchEvent, parsePayoutItemEvent, parseRefundEvent } from "@milestone/money";
import { canHold } from "../src/jobs/claim.ts";
import {
  deriveOpStatus,
  finalisation,
  isOurRefund,
  matchPayoutOp,
  mergeItemOutcome,
  mergeItemReversal,
  paidTotal,
  payoutEventKind,
  receiptInvoiceNumber,
  reverseEntries,
  settleTarget,
} from "../src/jobs/settle.ts";

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

describe("payoutEventKind", () => {
  it("maps payout item events (R9: UNCLAIMED stays in flight, RETURNED / REVERSED / REFUNDED reverse)", () => {
    expect(payoutEventKind("PAYMENT.PAYOUTS-ITEM.SUCCEEDED")).toBe("succeeded");
    expect(payoutEventKind("PAYMENT.PAYOUTS-ITEM.FAILED")).toBe("failed");
    expect(payoutEventKind("PAYMENT.PAYOUTS-ITEM.BLOCKED")).toBe("failed");
    expect(payoutEventKind("PAYMENT.PAYOUTS-ITEM.UNCLAIMED")).toBe("unclaimed");
    expect(payoutEventKind("PAYMENT.PAYOUTS-ITEM.RETURNED")).toBe("reversed");
    expect(payoutEventKind("PAYMENT.PAYOUTS-ITEM.REVERSED")).toBe("reversed");
    expect(payoutEventKind("PAYMENT.PAYOUTS-ITEM.REFUNDED")).toBe("reversed");
    expect(payoutEventKind("PAYMENT.CAPTURE.REFUNDED")).toBeNull();
  });
  it("R4: DENIED and CANCELED never paid (failed); HELD is audit only; a batch event is not an item event", () => {
    expect(payoutEventKind("PAYMENT.PAYOUTS-ITEM.DENIED")).toBe("failed");
    expect(payoutEventKind("PAYMENT.PAYOUTS-ITEM.CANCELED")).toBe("failed");
    expect(payoutEventKind("PAYMENT.PAYOUTS-ITEM.HELD")).toBe("held");
    expect(payoutEventKind("PAYMENT.PAYOUTSBATCH.DENIED")).toBeNull();
  });
});

describe("parsePayoutBatchEvent", () => {
  it("reads the batch id, our sender_batch_id and the status", () => {
    const e = parsePayoutBatchEvent({ event_type: "PAYMENT.PAYOUTSBATCH.DENIED", resource: { batch_header: { payout_batch_id: "B1", batch_status: "DENIED", sender_batch_header: { sender_batch_id: "rid-1" } } } });
    expect(e).toEqual({ payoutBatchId: "B1", senderBatchId: "rid-1", batchStatus: "DENIED" });
  });
  it("survives junk", () => {
    expect(parsePayoutBatchEvent(null)).toEqual({});
    expect(parsePayoutBatchEvent({ resource: { batch_header: { payout_batch_id: 3, sender_batch_header: "x" } } })).toEqual({});
  });
});

describe("finalisation (R5: a partial waits for its refund)", () => {
  const partial = { releaseMinor: 6_000, refundMinor: 4_000 };
  it("is final only when both halves succeeded", () => {
    expect(finalisation(partial, "succeeded", "succeeded")).toBe("final");
    expect(finalisation(partial, "succeeded", "sent")).toBe("wait");
    expect(finalisation(partial, "sent", "succeeded")).toBe("wait");
    expect(finalisation(partial, "succeeded", undefined)).toBe("wait");
  });
  it("is blocked when either half failed", () => {
    expect(finalisation(partial, "succeeded", "failed")).toBe("blocked");
    expect(finalisation(partial, "failed", "succeeded")).toBe("blocked");
    expect(finalisation(partial, "failed", "sent")).toBe("blocked");
  });
  it("needs only the half the claim has", () => {
    expect(finalisation({ releaseMinor: 10_000, refundMinor: 0 }, "succeeded", undefined)).toBe("final");
    expect(finalisation({ releaseMinor: 0, refundMinor: 10_000 }, undefined, "succeeded")).toBe("final");
    expect(finalisation({ releaseMinor: 0, refundMinor: 10_000 }, undefined, "failed")).toBe("blocked");
    expect(finalisation({ releaseMinor: 0, refundMinor: 0 }, undefined, undefined)).toBe("wait");
  });
});

describe("mergeItemOutcome", () => {
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

describe("deriveOpStatus (R5)", () => {
  const both = { partnerShareMinor: 40_320, freelancerShareMinor: 9_680 };
  const ok = { status: "succeeded" as const, amountMinor: 1, eventId: "e" };
  const bad = { status: "failed" as const, amountMinor: 1, eventId: "e" };
  it("waits for every party with a share", () => {
    expect(deriveOpStatus(both, {})).toBe("sent");
    expect(deriveOpStatus(both, { partner: ok })).toBe("sent");
    expect(deriveOpStatus(both, { partner: ok, freelancer: ok })).toBe("succeeded");
    expect(deriveOpStatus({ partnerShareMinor: 0, freelancerShareMinor: 9_680 }, { freelancer: ok })).toBe("succeeded");
  });
  it("stays sent after one failed item until the other item has an outcome too", () => {
    expect(deriveOpStatus(both, { partner: bad })).toBe("sent");
    expect(deriveOpStatus(both, { freelancer: bad })).toBe("sent");
    expect(deriveOpStatus(both, { partner: ok, freelancer: bad })).toBe("failed");
    expect(deriveOpStatus(both, { partner: bad, freelancer: bad })).toBe("failed");
  });
  it("is failed when a succeeded item was reversed", () => {
    expect(deriveOpStatus(both, { partner: ok, freelancer: ok }, { freelancer: { eventId: "r" } })).toBe("failed");
  });
});

describe("mergeItemReversal", () => {
  const rv = { eventId: "r1", eventType: "PAYMENT.PAYOUTS-ITEM.RETURNED", amountMinor: 9_680 };
  it("records the first reversal per party and keeps the items", () => {
    const a = mergeItemReversal({ items: { freelancer: { status: "succeeded" } } }, "freelancer", rv);
    expect(a).toEqual({ changed: true, response: { items: { freelancer: { status: "succeeded" } }, reversals: { freelancer: rv } } });
    expect(mergeItemReversal(a.response, "freelancer", { ...rv, eventId: "r2" }).changed).toBe(false);
    expect(mergeItemReversal(a.response, "partner", rv).changed).toBe(true);
  });
});

describe("matchPayoutOp (R8)", () => {
  it("matches only the op carrying the event's batch id, never another one", () => {
    expect(matchPayoutOp({ status: "sent", paypalId: "B1" }, "B1")).toBe("match");
    expect(matchPayoutOp({ status: "succeeded", paypalId: "B1" }, "B1")).toBe("match");
    expect(matchPayoutOp({ status: "sent", paypalId: "B1" }, "B2")).toBe("unmatched");
    expect(matchPayoutOp({ status: "failed", paypalId: null }, "B2")).toBe("unmatched");
    expect(matchPayoutOp(undefined, "B1")).toBe("unmatched");
    expect(matchPayoutOp({ status: "pending", paypalId: null }, undefined)).toBe("unmatched");
  });
  it("waits while our sent op has no batch id recorded yet, and uses the milestone's op when the event has no batch id", () => {
    expect(matchPayoutOp({ status: "sent", paypalId: null }, "B1")).toBe("wait");
    expect(matchPayoutOp({ status: "sent", paypalId: "B1" }, undefined)).toBe("match");
  });
});

describe("isOurRefund (R10)", () => {
  it("matches by refund id when our op has one", () => {
    expect(isOurRefund({ status: "sent", paypalId: "R1" }, 4_000, { refundId: "R1", amountMinor: 4_000 })).toBe(true);
    expect(isOurRefund({ status: "sent", paypalId: "R1" }, 4_000, { refundId: "R2", amountMinor: 4_000 })).toBe(false);
    expect(isOurRefund({ status: "sent", paypalId: "R1" }, 4_000, { amountMinor: 4_000 })).toBe(false);
  });
  it("without an id yet, matches only the exact claimed amount", () => {
    expect(isOurRefund({ status: "sent", paypalId: null }, 4_000, { refundId: "R9", amountMinor: 4_000 })).toBe(true);
    expect(isOurRefund({ status: "sent", paypalId: null }, 4_000, { refundId: "R9", amountMinor: 3_999 })).toBe(false);
    expect(isOurRefund({ status: "sent", paypalId: null }, 4_000, { refundId: "R9", amountMinor: null })).toBe(false);
  });
  it("never matches without a claimed op", () => {
    expect(isOurRefund(undefined, 4_000, { refundId: "R1", amountMinor: 4_000 })).toBe(false);
    expect(isOurRefund({ status: "pending", paypalId: null }, 4_000, { refundId: "R1", amountMinor: 4_000 })).toBe(false);
  });
});

describe("reverseEntries", () => {
  it("mirrors a posting so the pair sums to zero per account", () => {
    const posted = [
      { account: "held:m", amountMinor: 10_000, direction: "debit" as const },
      { account: "partner:p:receivable", amountMinor: 9_000, direction: "credit" as const },
      { account: "partner:p:fees", amountMinor: 1_000, direction: "credit" as const },
    ];
    expect(reverseEntries(posted)).toEqual([
      { account: "held:m", amountMinor: 10_000, direction: "credit" },
      { account: "partner:p:receivable", amountMinor: 9_000, direction: "debit" },
      { account: "partner:p:fees", amountMinor: 1_000, direction: "debit" },
    ]);
  });
});

describe("paidTotal", () => {
  it("sums what PayPal reported, falling back to the claimed share", () => {
    const shares = { partnerShareMinor: 40_320, freelancerShareMinor: 9_680 };
    expect(paidTotal(shares, { partner: { status: "succeeded", amountMinor: 40_000, eventId: "a" }, freelancer: { status: "succeeded", amountMinor: null, eventId: "b" } })).toBe(49_680);
    expect(paidTotal(shares, { partner: { status: "succeeded", amountMinor: 40_320, eventId: "a" }, freelancer: { status: "failed", amountMinor: 9_680, eventId: "b" } })).toBe(40_320);
  });
});

describe("ledgerRef", () => {
  it("is one ref per milestone and party, not per event", () => {
    expect(ledgerRef.release(mid, "freelancer")).toBe(`release:${mid}`);
    expect(ledgerRef.release(mid, "partner")).toBe(`release:${mid}:partner`);
    expect(ledgerRef.refund(mid)).toBe(`refund:${mid}`);
    expect(ledgerRef.reversal(mid, "freelancer")).toBe(`reversal:${mid}:freelancer`);
    expect(ledgerRef.reversal(mid, "partner")).toBe(`reversal:${mid}:partner`);
  });
});

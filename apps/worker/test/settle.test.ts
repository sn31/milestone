import { describe, expect, it } from "vitest";
import { canHold, parsePayoutItemEvent, receiptInvoiceNumber, settleTarget, settlesMilestone } from "../src/jobs/settle.js";

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

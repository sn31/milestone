import { describe, expect, it } from "vitest";
import { asInt, asNumber, asRecord, asString } from "../src/json.ts";
import { commitDeliveryId } from "../src/ids.ts";
import { CommitPayload, StoredDecision, decisionDeliveryId, formatMinor, minorDigits, requiredNotPassed, toPayPalValue } from "../src/schemas.ts";
import { accountKind, accounts, isFreelancerAccount, isHeldAccount, ledgerRefs } from "../src/ledger.ts";
import { OP_KINDS } from "../src/ops.ts";
import { paypalMode, payoutReceiver } from "../src/env.ts";
import { MIN_REVIEW_WINDOW_SECONDS, RELEASABLE_STATUSES, reviewWindowSeconds, statusForDecision } from "../src/milestones.ts";

describe("json helpers", () => {
  it("asRecord keeps plain objects only", () => {
    const o = { a: 1 };
    expect(asRecord(o)).toBe(o);
    for (const v of [null, undefined, [], [1], "x", 3, true]) expect(asRecord(v)).toEqual({});
  });
  it("asString: non-empty strings only", () => {
    expect(asString("x")).toBe("x");
    for (const v of ["", null, undefined, 3, {}, []]) expect(asString(v)).toBeNull();
  });
  it("asNumber: finite numbers only", () => {
    expect(asNumber(1.5)).toBe(1.5);
    expect(asNumber(0)).toBe(0);
    for (const v of [Number.NaN, Infinity, "1", null, undefined]) expect(asNumber(v)).toBeNull();
  });
  it("asInt: integers, optionally with a minimum", () => {
    expect(asInt(-3)).toBe(-3);
    expect(asInt(1.5)).toBeNull();
    expect(asInt("2")).toBeNull();
    expect(asInt(-1, 0)).toBeNull();
    expect(asInt(0, 0)).toBe(0);
  });
});

describe("decisionDeliveryId", () => {
  it("reads a non-empty deliveryId", () => {
    expect(decisionDeliveryId({ action: "release", deliveryId: "dlv_1" })).toBe("dlv_1");
  });
  it("is null for missing, empty or non-string ids and non-objects", () => {
    for (const v of [null, undefined, "dlv_1", 3, {}, { deliveryId: "" }, { deliveryId: 7 }, { deliveryId: null }]) expect(decisionDeliveryId(v)).toBeNull();
  });
  it("StoredDecision requires the deliveryId", () => {
    const d = { action: "release", amountMinor: 100, ruleIds: ["P6"], reason: "ok" };
    expect(StoredDecision.safeParse(d).success).toBe(false);
    expect(StoredDecision.safeParse({ ...d, deliveryId: "" }).success).toBe(false);
    expect(StoredDecision.parse({ ...d, deliveryId: "dlv_1" }).deliveryId).toBe("dlv_1");
  });
});

// The three copies this replaces, verbatim in behaviour: the review route's (verdict, rows), the release job's
// (verdict, criteria) and milestone-actions.tsx's (delivery, crit), which reads delivery.verdict.
type Row = { id: string; required: boolean; description: string };
function routeCopy(verdict: unknown, rows: ReadonlyArray<Row>): string[] {
  const list = verdict && typeof verdict === "object" ? (verdict as { criteria?: unknown }).criteria : undefined;
  const status = new Map<string, unknown>();
  if (Array.isArray(list)) {
    for (const r of list) if (r && typeof r === "object") status.set(String((r as Record<string, unknown>).criterion_id), (r as Record<string, unknown>).status);
  }
  return rows.filter((c) => c.required && status.get(c.id) !== "pass").map((c) => c.description);
}
function releaseCopy(verdict: unknown, criteria: ReadonlyArray<Row>): string[] {
  const rows = verdict && typeof verdict === "object" ? (verdict as { criteria?: unknown }).criteria : undefined;
  const status = new Map<string, unknown>();
  if (Array.isArray(rows)) {
    for (const r of rows) {
      if (r && typeof r === "object") status.set(String((r as Record<string, unknown>).criterion_id), (r as Record<string, unknown>).status);
    }
  }
  return criteria.filter((c) => c.required && status.get(c.id) !== "pass").map((c) => c.description);
}
function actionsCopy(delivery: { verdict: unknown } | null | undefined, crit: Row[]): string[] {
  const list = delivery?.verdict && typeof delivery.verdict === "object" ? (delivery.verdict as { criteria?: unknown }).criteria : undefined;
  const status = new Map<string, unknown>();
  if (Array.isArray(list)) {
    for (const r of list) if (r && typeof r === "object") status.set(String((r as Record<string, unknown>).criterion_id), (r as Record<string, unknown>).status);
  }
  return crit.filter((c) => c.required && status.get(c.id) !== "pass").map((c) => c.description);
}

describe("requiredNotPassed", () => {
  const crit: Row[] = [
    { id: "c1", required: true, description: "tests pass" },
    { id: "c2", required: true, description: "file exists" },
    { id: "c3", required: false, description: "looks right" },
  ];
  it("lists required criteria that are not a pass, missing ones included", () => {
    const verdict = { criteria: [{ criterion_id: "c1", status: "pass" }, { criterion_id: "c3", status: "fail" }] };
    expect(requiredNotPassed(verdict, crit)).toEqual(["file exists"]);
    expect(requiredNotPassed(null, crit)).toEqual(["tests pass", "file exists"]);
    expect(requiredNotPassed({ criteria: [{ criterion_id: "c1", status: "unclear" }, { criterion_id: "c2", status: "pass" }] }, crit)).toEqual(["tests pass"]);
  });

  it("agrees with all three copies it replaces on random verdicts", () => {
    let seed = 42;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
    const statuses = ["pass", "fail", "unclear", "PASS", "", null, undefined, 1];
    const ids = ["c1", "c2", "c3", "c4", "", "undefined"];
    const entry = () => pick<unknown>([
      { criterion_id: pick(ids), status: pick(statuses) },
      { criterion_id: pick(ids) },
      { status: "pass" },
      null,
      "pass",
      [],
      { criterion_id: 1, status: "pass" },
    ]);
    const verdictOf = () => pick<unknown>([
      undefined,
      null,
      "verdict",
      7,
      [],
      {},
      { criteria: "nope" },
      { criteria: null },
      { criteria: Array.from({ length: Math.floor(rnd() * 6) }, entry) },
      { criteria: Array.from({ length: Math.floor(rnd() * 6) }, entry) },
    ]);
    const critOf = (): Row[] => Array.from({ length: Math.floor(rnd() * 5) }, (_, i) => ({ id: pick(ids), required: rnd() < 0.7, description: `d${i}` }));
    for (let i = 0; i < 2_000; i++) {
      const v = verdictOf();
      const c = critOf();
      const got = requiredNotPassed(v, c);
      expect(got).toEqual(routeCopy(v, c));
      expect(got).toEqual(releaseCopy(v, c));
      expect(got).toEqual(actionsCopy({ verdict: v }, c));
    }
    // milestone-actions with no delivery at all reads as an empty verdict.
    expect(requiredNotPassed(undefined, crit)).toEqual(actionsCopy(null, crit));
  });
});

describe("ledgerRefs", () => {
  it("matches the formats posted today", () => {
    expect(ledgerRefs.capture("CAP-1")).toBe("CAP-1");
    expect(ledgerRefs.release("m1")).toBe("release:m1");
    expect(ledgerRefs.release("m1", "freelancer")).toBe("release:m1");
    expect(ledgerRefs.release("m1", "partner")).toBe("release:m1:partner");
    expect(ledgerRefs.refund("m1")).toBe("refund:m1");
    expect(ledgerRefs.reversal("m1", "freelancer")).toBe("reversal:m1:freelancer");
    expect(ledgerRefs.reversal("m1", "partner")).toBe("reversal:m1:partner");
    expect(ledgerRefs.advanceFunding("a1")).toBe("advance:a1");
    expect(ledgerRefs.advanceRepayment("m1", { id: "a1", milestoneId: "m1" })).toBe("release:m1:partner");
    expect(ledgerRefs.advanceRepayment("m2", { id: "a1", milestoneId: "m1" })).toBe("release:m2:partner:a1");
    expect(ledgerRefs.advanceReversal("m1", { id: "a1", milestoneId: "m1" })).toBe("reversal:m1:partner");
    expect(ledgerRefs.advanceReversal("m2", { id: "a1", milestoneId: "m1" })).toBe("reversal:m2:partner:a1");
    expect(ledgerRefs.dispute("PP-D-1")).toBe("dispute:PP-D-1");
  });
  it("an own advance's repayment is the release's partner posting", () => {
    expect(ledgerRefs.advanceRepayment("m1", { id: "a1", milestoneId: "m1" })).toBe(ledgerRefs.release("m1", "partner"));
    expect(ledgerRefs.advanceReversal("m1", { id: "a1", milestoneId: "m1" })).toBe(ledgerRefs.reversal("m1", "partner"));
  });
  it("account predicates", () => {
    expect(isHeldAccount(accounts.held("m1"))).toBe(true);
    expect(isHeldAccount(accounts.freelancer("u"))).toBe(false);
    expect(isFreelancerAccount(accounts.freelancer("u"))).toBe(true);
    expect(accountKind(accounts.held("m1"))).toBe("held");
    expect(accountKind(accounts.client("u"))).toBe("client");
    expect(accountKind(accounts.partnerReceivable("p"))).toBe("partner");
    expect(accountKind(accounts.partnerFeeIncome("p"))).toBe("partner");
    expect(accountKind(accounts.platformFees)).toBe("platform");
    expect(accountKind("weird")).toBe("other");
  });
});

describe("op kinds", () => {
  it("are the stored strings", () => {
    expect(OP_KINDS).toEqual({ capture: "capture", order: "order", payout: "payout", refund: "refund", invoice: "invoice", advancePayout: "advance-payout", disputeEvidence: "dispute_evidence", disputeAccept: "dispute_accept" });
  });
});

describe("statusForDecision", () => {
  it("release -> review, hold -> held, partial / ask_client -> needs_client", () => {
    expect(statusForDecision("release")).toBe("review");
    expect(statusForDecision("hold")).toBe("held");
    expect(statusForDecision("partial")).toBe("needs_client");
    expect(statusForDecision("ask_client")).toBe("needs_client");
  });
  it("release and ask paths land in releasable states", () => {
    expect(RELEASABLE_STATUSES.has(statusForDecision("release"))).toBe(true);
    expect(RELEASABLE_STATUSES.has(statusForDecision("partial"))).toBe(true);
    expect(RELEASABLE_STATUSES.has(statusForDecision("hold"))).toBe(false);
  });
});

describe("reviewWindowSeconds", () => {
  it("uses the override when numeric, the contract's otherwise, never below the minimum", () => {
    expect(reviewWindowSeconds(172_800, undefined)).toBe(172_800);
    expect(reviewWindowSeconds(172_800, "")).toBe(172_800);
    expect(reviewWindowSeconds(172_800, "abc")).toBe(172_800);
    expect(reviewWindowSeconds(172_800, "90.7")).toBe(90);
    expect(reviewWindowSeconds(172_800, "5")).toBe(MIN_REVIEW_WINDOW_SECONDS);
    expect(reviewWindowSeconds(Number.NaN, undefined)).toBe(MIN_REVIEW_WINDOW_SECONDS);
  });
});

describe("money formatting", () => {
  it("minorDigits and formatMinor", () => {
    expect(minorDigits("USD")).toBe(2);
    expect(minorDigits("jpy")).toBe(0);
    expect(formatMinor(1234, "USD")).toBe("12.34 USD");
    expect(formatMinor(500, "JPY")).toBe("500 JPY");
    expect(formatMinor(5, "USD")).toBe("0.05 USD");
    expect(toPayPalValue(1234, "USD")).toBe("12.34");
  });
});

describe("env", () => {
  it("paypalMode: explicit mode wins, else simulated without credentials outside production", () => {
    expect(paypalMode({ NODE_ENV: "development" })).toBe("simulated");
    expect(paypalMode({ NODE_ENV: "development", PAYPAL_CLIENT_ID: "x" })).toBe("sandbox");
    expect(paypalMode({ NODE_ENV: "production" })).toBe("sandbox");
    expect(paypalMode({ NODE_ENV: "production", PAYPAL_MODE: " Simulated " })).toBe("simulated");
    expect(paypalMode({ NODE_ENV: "development", PAYPAL_MODE: "live" })).toBe("sandbox");
    expect(paypalMode({ NODE_ENV: "development", PAYPAL_MODE: "" })).toBe("simulated");
  });
  it("payoutReceiver: the PayPal email, or the account email in simulated mode", () => {
    const sim = { NODE_ENV: "development", PAYPAL_MODE: "simulated" };
    const box = { NODE_ENV: "development", PAYPAL_MODE: "sandbox" };
    expect(payoutReceiver({ paypalEmail: "pp@x", email: "a@x" }, box)).toBe("pp@x");
    expect(payoutReceiver({ paypalEmail: null, email: "a@x" }, box)).toBeNull();
    expect(payoutReceiver({ paypalEmail: null, email: "a@x" }, sim)).toBe("a@x");
    expect(payoutReceiver(undefined, sim)).toBeNull();
  });
});

describe("commit deliveries", () => {
  it("commitDeliveryId is stable and matches the route's formula", () => {
    const id = commitDeliveryId("mst_1", "a".repeat(40));
    expect(id).toMatch(/^dlv_[0-9a-f]{24}$/);
    expect(commitDeliveryId("mst_1", "a".repeat(40))).toBe(id);
    expect(commitDeliveryId("mst_2", "a".repeat(40))).not.toBe(id);
  });
  it("CommitPayload reads both writers' shapes and is lenient like the verify job", () => {
    const webhook = { sha: "abc", title: "t", body: "b", branch: "m1-x", clone_url: "https://g/x.git", pr_number: 4, repo: "o/x", base_sha: "def" };
    expect(CommitPayload.parse(webhook)).toEqual(webhook);
    const manual = { sha: "abc", title: "t", body: "", branch: "main", clone_url: "https://g/x.git", repo: "https://g/x.git", base_sha: null };
    expect(CommitPayload.parse(manual)).toEqual(manual);
    expect(CommitPayload.parse({ sha: "abc", clone_url: "u", title: 3, base_sha: "" })).toEqual({ sha: "abc", clone_url: "u", title: "", body: "", branch: "", base_sha: null });
    expect(CommitPayload.safeParse({ sha: "", clone_url: "u" }).success).toBe(false);
    expect(CommitPayload.safeParse({ sha: "abc" }).success).toBe(false);
  });
});

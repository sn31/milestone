import { describe, expect, it } from "vitest";
import { assertBalanced, releaseEntries, signed } from "../src/ledger.js";

describe("ledger invariants", () => {
  it("rejects an unbalanced transaction", () => {
    expect(() => assertBalanced([{ account: "a", amountMinor: 10, direction: "debit" }, { account: "b", amountMinor: 9, direction: "credit" }])).toThrow(/balance/);
  });
  it("release with an outstanding advance pays the partner first and sums to zero", () => {
    const e = releaseEntries({ milestoneId: "m1", freelancerId: "f1", amountMinor: 100_00, advance: { partnerId: "p1", principalMinor: 60_00, feeMinor: 3_00 } });
    expect(() => assertBalanced(e)).not.toThrow();
    expect(e.reduce((s, x) => s + signed(x), 0)).toBe(0);
    expect(e.find((x) => x.account === "freelancer:f1")?.amountMinor).toBe(37_00);
  });
  it("a partial release smaller than the advance leaves the freelancer nothing", () => {
    const e = releaseEntries({ milestoneId: "m1", freelancerId: "f1", amountMinor: 40_00, advance: { partnerId: "p1", principalMinor: 60_00, feeMinor: 3_00 } });
    expect(() => assertBalanced(e)).not.toThrow();
    expect(e.find((x) => x.account === "freelancer:f1")).toBeUndefined();
  });
});

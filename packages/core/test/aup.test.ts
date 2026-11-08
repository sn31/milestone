/** The PayPal AUP rule (aup.ts), pure: a check's status, the gate on signing and funding, and the contract text's hash. */
import { describe, expect, it } from "vitest";
import { AUP_ALLOWED, AUP_REFUSAL_TEXT, AUP_STATUSES, aupContractText, aupGate, aupStatusFor, aupTextHash, normalizeForQuote, type AupSubject } from "../src/aup.ts";
import type { AupFlag } from "../src/schemas.ts";

const flag: AupFlag = { category: "gambling", section: "Activities Requiring Approval", quote: "online casino", rationale: "r", confidence: 0.2, source: "model" };

describe("aupStatusFor", () => {
  it("any flag, from either pass and at any confidence, is review", () => {
    expect(aupStatusFor({ mode: "model", flags: [flag] })).toBe("review");
    expect(aupStatusFor({ mode: "keywords", flags: [{ ...flag, source: "keywords" }] })).toBe("review");
    expect(aupStatusFor({ mode: "recorded", flags: [flag] })).toBe("review");
  });
  it("a failed model call is review even with no flags (fail closed)", () => {
    expect(aupStatusFor({ mode: "model_error", flags: [] })).toBe("review");
  });
  it("no flags: clear when a model read it, keywords_only without one", () => {
    expect(aupStatusFor({ mode: "model", flags: [] })).toBe("clear");
    expect(aupStatusFor({ mode: "recorded", flags: [] })).toBe("clear");
    expect(aupStatusFor({ mode: "keywords", flags: [] })).toBe("keywords_only");
  });
});

describe("aupGate", () => {
  it("allows only clear, keywords_only and cleared", () => {
    expect([...AUP_ALLOWED].sort()).toEqual(["cleared", "clear", "keywords_only"].sort());
    for (const s of AUP_STATUSES) expect("ok" in aupGate({ aupStatus: s }), s).toBe(AUP_ALLOWED.has(s));
  });
  it("names the reason for every refusal, and refuses unchecked and unknown statuses", () => {
    expect(aupGate({ aupStatus: null })).toEqual({ refused: "aup_unchecked" });
    expect(aupGate({ aupStatus: "checking" })).toEqual({ refused: "aup_checking" });
    expect(aupGate({ aupStatus: "review" })).toEqual({ refused: "aup_review" });
    expect(aupGate({ aupStatus: "rejected" })).toEqual({ refused: "aup_rejected" });
    expect(aupGate({ aupStatus: "something-new" })).toEqual({ refused: "aup_review" });
    for (const t of Object.values(AUP_REFUSAL_TEXT)) expect(t.length).toBeGreaterThan(20);
  });
  it("every mode with one or more flags is refused until an operator clears it", () => {
    for (const mode of ["model", "keywords", "model_error", "recorded"] as const) {
      for (const n of [1, 2, 5]) {
        const status = aupStatusFor({ mode, flags: Array.from({ length: n }, () => flag) });
        expect("ok" in aupGate({ aupStatus: status }), `${mode} ${n}`).toBe(false);
      }
    }
    expect("ok" in aupGate({ aupStatus: "cleared" })).toBe(true);
  });
});

describe("the contract text and its hash", () => {
  const s: AupSubject = {
    title: "T",
    scopeText: "Scope",
    milestones: [
      { seq: 2, title: "B", criteria: [{ kind: "file", description: "README", spec: { path: "README.md" } }] },
      { seq: 1, title: "A", criteria: [{ kind: "judgment", description: "Reads well", spec: {} }] },
    ],
  };
  it("reads title, scope, then milestones in order with their criteria", () => {
    expect(aupContractText(s)).toBe(["Title: T", "Scope: Scope", "Milestone 1: A", "- (judgment) Reads well", "Milestone 2: B", '- (file) README {"path":"README.md"}'].join("\n"));
  });
  it("changes when any word changes, and only then", () => {
    expect(aupTextHash(s)).toBe(aupTextHash(structuredClone(s)));
    const edited = structuredClone(s);
    edited.milestones[0]!.criteria[0]!.description = "README with a casino link";
    expect(aupTextHash(edited)).not.toBe(aupTextHash(s));
  });
  it("matches quotes ignoring case, spacing and curly quotes", () => {
    expect(normalizeForQuote("  The  “Casino”\n page ")).toBe('the "casino" page');
  });
});

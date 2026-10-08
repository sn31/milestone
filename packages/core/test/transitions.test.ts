import { describe, expect, it } from "vitest";
import { GUARDED_TRANSITIONS, TRANSITIONS, canTransition } from "../src/milestones.ts";

describe("milestone transitions", () => {
  it("has no ordinary way out of released or partial_released", () => {
    expect(TRANSITIONS.released).toEqual([]);
    expect(TRANSITIONS.partial_released).toEqual([]);
  });
  it("only targets states that exist", () => {
    const states = new Set(Object.keys(TRANSITIONS));
    for (const targets of Object.values(TRANSITIONS)) for (const t of targets) expect(states.has(t)).toBe(true);
    for (const e of GUARDED_TRANSITIONS) expect(states.has(e.from) && states.has(e.to)).toBe(true);
  });
  it("a settled milestone goes back to held only on a reversal", () => {
    for (const from of ["released", "partial_released"] as const) {
      expect(canTransition(from, "held")).toBe(false);
      expect(canTransition(from, "held", "reversal")).toBe(true);
      expect(canTransition(from, "verifying", "reversal")).toBe(false);
    }
  });
  it("a cause never makes an ordinary edge illegal or opens any other edge", () => {
    expect(canTransition("review", "held")).toBe(true);
    expect(canTransition("review", "held", "reversal")).toBe(true);
    expect(canTransition("draft", "released", "reversal")).toBe(false);
    expect(canTransition("held", "released", "reversal")).toBe(false);
  });
});

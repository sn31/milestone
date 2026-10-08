import { describe, expect, it } from "vitest";
import { TRANSITIONS } from "../src/milestones.js";

describe("milestone transitions", () => {
  it("has no way out of released or partial_released", () => {
    expect(TRANSITIONS.released).toEqual([]);
    expect(TRANSITIONS.partial_released).toEqual([]);
  });
  it("only targets states that exist", () => {
    const states = new Set(Object.keys(TRANSITIONS));
    for (const targets of Object.values(TRANSITIONS)) for (const t of targets) expect(states.has(t)).toBe(true);
  });
});

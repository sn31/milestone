import { afterEach, describe, expect, it } from "vitest";
import { countModelCall, isModelConfigured, modelBudgetLeft, resetModelBudgetForTests } from "../src/llm.ts";

afterEach(() => resetModelBudgetForTests());

const day1 = new Date("2026-11-08T10:00:00Z");
const day2 = new Date("2026-11-09T00:00:01Z");

describe("daily model-call budget (MILESTONE_MODEL_DAILY_CALLS)", () => {
  it("has no cap when the variable is unset or not a positive integer", () => {
    for (const v of [undefined, "", "0", "-3", "2.5", "lots"]) {
      resetModelBudgetForTests();
      for (let i = 0; i < 50; i++) countModelCall(day1);
      expect(modelBudgetLeft({ MILESTONE_MODEL_DAILY_CALLS: v }, day1)).toBe(true);
    }
  });

  it("runs out after the limit and comes back the next UTC day", () => {
    const env = { MILESTONE_MODEL_DAILY_CALLS: "3" };
    for (let i = 0; i < 3; i++) {
      expect(modelBudgetLeft(env, day1)).toBe(true);
      countModelCall(day1);
    }
    expect(modelBudgetLeft(env, day1)).toBe(false);
    expect(modelBudgetLeft(env, day2)).toBe(true);
  });

  it("makes isModelConfigured false once the budget is spent, so callers take their no-model path", async () => {
    const env = { ANTHROPIC_API_KEY: "sk-test", MILESTONE_MODEL_DAILY_CALLS: "1" };
    expect(await isModelConfigured(env)).toBe(true);
    countModelCall();
    expect(await isModelConfigured(env)).toBe(false);
    expect(await isModelConfigured({ ANTHROPIC_API_KEY: "sk-test" })).toBe(true);
  });
});

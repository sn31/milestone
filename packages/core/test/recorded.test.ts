/** Simulator ids on the real sandbox: the recorded-showcase predicate and the sandbox environment check. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SANDBOX_REQUIRED_ENV, isSimulatorId, missingSandboxEnv, recordedForShowcase } from "../src/env.ts";

const sandbox = { PAYPAL_MODE: "sandbox" } as NodeJS.ProcessEnv;
const simulated = { PAYPAL_MODE: "simulated" } as NodeJS.ProcessEnv;

describe("isSimulatorId", () => {
  it("matches the simulator's and the showcase seed's ids", () => {
    for (const id of ["SIM-ORD-SHOW410A7Q", "SIM-CAP-SHOW510K2F", "SIM-BATCH-SHOWB2F7K", "SIM-PMT-SHOWCASEY01", "SIM-CUST-CASEY01", "SIM-7K2Q9XW4M1TB3HD8P", "SIM-INV2-AB12-CD34-EF56-GH78", "PP-D-SIMAB12CD34"]) {
      expect(isSimulatorId(id), id).toBe(true);
    }
  });
  it("does not match real PayPal ids, titles or empty values", () => {
    for (const id of ["5O190127TN364715T", "3C679366HH908993F", "PP-D-12345", "SIM card shop", "Sim-ORD-1", "SIM-", "", null, undefined, 42]) {
      expect(isSimulatorId(id), String(id)).toBe(false);
    }
  });
});

describe("recordedForShowcase", () => {
  const recorded = { paypalOrderId: "SIM-ORD-SHOW410A7Q", paypalCaptureId: "SIM-CAP-SHOW410K2F" };
  it("is true on the real sandbox when the funding carries simulator ids", () => {
    expect(recordedForShowcase(recorded, sandbox)).toBe(true);
    expect(recordedForShowcase({ paypalOrderId: null, paypalCaptureId: "SIM-CAP-SHOW410K2F" }, sandbox)).toBe(true);
  });
  it("is never true in simulated mode, where those ids are the simulator's own", () => {
    expect(recordedForShowcase(recorded, simulated)).toBe(false);
  });
  it("is false for real PayPal ids and for unfunded milestones", () => {
    expect(recordedForShowcase({ paypalOrderId: "5O190127TN364715T", paypalCaptureId: "3C679366HH908993F" }, sandbox)).toBe(false);
    expect(recordedForShowcase({ paypalOrderId: null, paypalCaptureId: null }, sandbox)).toBe(false);
    expect(recordedForShowcase(null, sandbox)).toBe(false);
  });
});

describe("missingSandboxEnv", () => {
  const full = Object.fromEntries(SANDBOX_REQUIRED_ENV.map((k) => [k, "x"]));
  it("names every unset or blank variable in sandbox mode, and nothing else", () => {
    expect(missingSandboxEnv({ ...sandbox, ...full })).toEqual([]);
    expect(missingSandboxEnv({ ...sandbox, ...full, PAYPAL_WEBHOOK_ID: " ", PAYPAL_PARTNER_EMAIL: undefined })).toEqual(["PAYPAL_WEBHOOK_ID", "PAYPAL_PARTNER_EMAIL"]);
    expect(missingSandboxEnv(sandbox)).toEqual([...SANDBOX_REQUIRED_ENV]);
  });
  it("asks for nothing in simulated mode", () => {
    expect(missingSandboxEnv(simulated)).toEqual([]);
  });
  it("is the list scripts/start-render.mjs enforces on Render", () => {
    const start = readFileSync(new URL("../../../scripts/start-render.mjs", import.meta.url), "utf8");
    const list = /const SANDBOX_REQUIRED = \[([^\]]*)\]/.exec(start)?.[1] ?? "";
    expect([...list.matchAll(/"([A-Z0-9_]+)"/g)].map((m) => m[1])).toEqual([...SANDBOX_REQUIRED_ENV]);
  });
});

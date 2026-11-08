import { describe, expect, it } from "vitest";
import { recordedRefusal } from "./recorded";
import { PAYPAL_MODE_TEXT } from "@/app/api/demo/_demo";

const recorded = { paypalOrderId: "SIM-ORD-SHOW410A7Q", paypalCaptureId: "SIM-CAP-SHOW410K2F" };

describe("recordedRefusal", () => {
  it("refuses an action on a recorded showcase milestone on the real sandbox with 409 and the reason", async () => {
    const res = recordedRefusal(recorded, { PAYPAL_MODE: "sandbox" } as unknown as NodeJS.ProcessEnv);
    expect(res?.status).toBe(409);
    const body = (await res!.json()) as { error: string; reason: string };
    expect(body.reason).toBe("recorded_for_showcase");
    expect(body.error).toMatch(/recorded for the showcase/);
  });
  it("lets everything else through", () => {
    expect(recordedRefusal(recorded, { PAYPAL_MODE: "simulated" } as unknown as NodeJS.ProcessEnv)).toBeNull();
    expect(recordedRefusal({ paypalOrderId: "5O190127TN364715T", paypalCaptureId: "3C679366HH908993F" }, { PAYPAL_MODE: "sandbox" } as unknown as NodeJS.ProcessEnv)).toBeNull();
    expect(recordedRefusal({ paypalOrderId: null, paypalCaptureId: null }, { PAYPAL_MODE: "sandbox" } as unknown as NodeJS.ProcessEnv)).toBeNull();
  });
});

describe("the demo band's PayPal line", () => {
  it("says a reset cannot undo the real sandbox", () => {
    expect(PAYPAL_MODE_TEXT.sandbox).toMatch(/real PayPal sandbox/);
    expect(PAYPAL_MODE_TEXT.sandbox).toMatch(/not PayPal's sandbox/);
    expect(PAYPAL_MODE_TEXT.simulated).toMatch(/simulated PayPal/);
  });
});

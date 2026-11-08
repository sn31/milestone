import { afterEach, describe, expect, it, vi } from "vitest";
import { publicUrl } from "./http";

describe("publicUrl", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("uses APP_URL, not the proxy's internal host in req.url", () => {
    vi.stubEnv("APP_URL", "https://milestone-amov.onrender.com");
    const req = new Request("https://localhost:10000/api/demo/reset", { method: "POST" });
    expect(publicUrl("/", req).toString()).toBe("https://milestone-amov.onrender.com/");
    expect(publicUrl("/contracts/ctr_1?aup=review", req).toString()).toBe("https://milestone-amov.onrender.com/contracts/ctr_1?aup=review");
  });

  it("falls back to the request's origin without APP_URL", () => {
    vi.stubEnv("APP_URL", "");
    const req = new Request("http://localhost:3000/api/contracts", { method: "POST" });
    expect(publicUrl("/contracts/new", req).toString()).toBe("http://localhost:3000/contracts/new");
  });
});

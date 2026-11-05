import { afterEach, describe, expect, it, vi } from "vitest";
import { demoMode, modelMode } from "../_demo";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createLimiter, repoRoot } from "./reset";

/** A plain record as a ProcessEnv (Next.js types NODE_ENV as required). */
const env = (o: Record<string, string | undefined>) => o as unknown as NodeJS.ProcessEnv;

vi.mock("./reset", async (orig) => ({ ...(await orig<typeof import("./reset")>()), runShowcaseSeed: vi.fn(async () => ({ ok: true })) }));

describe("demo reset", () => {
  const prev = process.env.DEMO_MODE;
  afterEach(() => {
    if (prev === undefined) delete process.env.DEMO_MODE;
    else process.env.DEMO_MODE = prev;
  });

  it("demo mode is on only for DEMO_MODE=1", () => {
    expect(demoMode(env({ DEMO_MODE: "1" }))).toBe(true);
    for (const v of [undefined, "", "0", "true", "yes"]) expect(demoMode(env({ DEMO_MODE: v }))).toBe(false);
  });

  it("allows one reset per 30 s", () => {
    const l = createLimiter(30);
    expect(l.claim(1_000_000)).toBe(0);
    expect(l.claim(1_000_001)).toBe(30);
    expect(l.claim(1_029_500)).toBe(1);
    expect(l.claim(1_030_000)).toBe(0);
    expect(l.claim(1_030_000)).toBe(30);
  });

  it("finds the monorepo root", () => {
    const root = repoRoot();
    expect(root && existsSync(join(root, "pnpm-workspace.yaml"))).toBe(true);
  });

  it("names the model mode from the environment", async () => {
    expect(await modelMode(env({ ANTHROPIC_API_KEY: "k" }))).toBe("claude");
    expect(await modelMode(env({}))).toBe("none");
  });

  it("answers 404 without DEMO_MODE=1, then resets once and refuses a second reset within 30 s", async () => {
    const { POST } = await import("./route");
    delete process.env.DEMO_MODE;
    expect((await POST(new Request("http://x/api/demo/reset", { method: "POST" }))).status).toBe(404);
    process.env.DEMO_MODE = "1";
    const first = await POST(new Request("http://x/api/demo/reset", { method: "POST" }));
    expect(first.status).toBe(200);
    const second = await POST(new Request("http://x/api/demo/reset", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", referer: "http://x/contracts/ctr_demo" } }));
    expect(second.status).toBe(303);
    expect(second.headers.get("location")).toBe("http://x/contracts/ctr_demo");
    expect(second.headers.get("set-cookie")).toMatch(/milestone_demo_notice=wait%3A\d+|milestone_demo_notice=wait:\d+/);
    const third = await POST(new Request("http://x/api/demo/reset", { method: "POST" }));
    expect(third.status).toBe(429);
    expect(Number(third.headers.get("retry-after"))).toBeGreaterThan(0);
  });
});

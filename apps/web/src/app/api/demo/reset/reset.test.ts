import { afterEach, describe, expect, it, vi } from "vitest";
import { demoMode, modelMode } from "../_demo";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { configureSimulator } from "@milestone/money";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLimiter, repoRoot } from "./reset";

/** A plain record as a ProcessEnv (Next.js types NODE_ENV as required). */
const env = (o: Record<string, string | undefined>) => o as unknown as NodeJS.ProcessEnv;

// The route's seed and upload clearing are stubbed (the real clearUploads would empty this checkout's var/uploads);
// clearUploads itself is tested on a temporary directory through the original export.
const clearMock = vi.hoisted(() => vi.fn(async () => 0));
const simMock = vi.hoisted(() => vi.fn(() => true));
vi.mock("./reset", async (orig) => ({ ...(await orig<typeof import("./reset")>()), runShowcaseSeed: vi.fn(async () => ({ ok: true })), clearUploads: clearMock, clearSimulator: simMock }));

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
    expect(clearMock).not.toHaveBeenCalled();
    process.env.DEMO_MODE = "1";
    const first = await POST(new Request("http://x/api/demo/reset", { method: "POST" }));
    expect(first.status).toBe(200);
    expect(clearMock).toHaveBeenCalledTimes(1);
    expect(simMock).toHaveBeenCalledTimes(1);
    const second = await POST(new Request("http://x/api/demo/reset", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", referer: "http://x/contracts/ctr_demo" } }));
    expect(second.status).toBe(303);
    expect(second.headers.get("location")).toBe("http://x/contracts/ctr_demo");
    expect(second.headers.get("set-cookie")).toMatch(/milestone_demo_notice=wait%3A\d+|milestone_demo_notice=wait:\d+/);
    const third = await POST(new Request("http://x/api/demo/reset", { method: "POST" }));
    expect(third.status).toBe(429);
    expect(Number(third.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(clearMock).toHaveBeenCalledTimes(1); // refused resets clear nothing
    expect(simMock).toHaveBeenCalledTimes(1);
  });

  it("clearUploads empties the upload directory but keeps it, and a missing one is fine", async () => {
    const { clearUploads } = await vi.importActual<typeof import("./reset")>("./reset");
    const root = await mkdtemp(join(tmpdir(), "milestone-uploads-"));
    try {
      await mkdir(join(root, "dlv_1"));
      await writeFile(join(root, "dlv_1", "a.pdf"), "x");
      await writeFile(join(root, "stray.txt"), "y");
      expect(await clearUploads(root)).toBe(2);
      expect(await readdir(root)).toEqual([]);
      expect(await clearUploads(join(root, "missing"))).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("clearSimulator empties the simulator's state file in simulated mode and leaves it alone otherwise", async () => {
    const { clearSimulator } = await vi.importActual<typeof import("./reset")>("./reset");
    const root = await mkdtemp(join(tmpdir(), "milestone-sim-"));
    const file = join(root, "simulated-paypal.json");
    const stale = JSON.stringify({ version: 1, records: { "order:SIM-ORD-OLD": { kind: "order", id: "SIM-ORD-OLD" }, "payment_token:SIM-PMT-OLD": { kind: "payment_token", id: "SIM-PMT-OLD" } } });
    try {
      configureSimulator({ stateFile: file });
      await writeFile(file, stale);
      expect(clearSimulator(env({ PAYPAL_MODE: "sandbox" }))).toBe(false);
      expect(await readFile(file, "utf8")).toBe(stale);
      expect(clearSimulator(env({ PAYPAL_MODE: "simulated" }))).toBe(true);
      expect(JSON.parse(await readFile(file, "utf8")).records).toEqual({});
    } finally {
      configureSimulator({ stateFile: null });
      await rm(root, { recursive: true, force: true });
    }
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RATE_RULES, clientIp, createSlidingWindowLimiter, rateLimited, tooManyRequests, type RateRule } from "@/lib/rate-limit";

const env = (e: Record<string, string>) => e as unknown as NodeJS.ProcessEnv;
const rule: RateRule = { name: "t", limit: 3, windowMs: 60_000 };

describe("sliding-window limiter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-05T12:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("allows `limit` hits in a window, then reports the seconds until the oldest hit leaves it", () => {
    const l = createSlidingWindowLimiter();
    expect([l.hit("a", rule), l.hit("a", rule)]).toEqual([0, 0]);
    vi.advanceTimersByTime(20_000);
    expect(l.hit("a", rule)).toBe(0);
    expect(l.hit("a", rule)).toBe(40);
    vi.advanceTimersByTime(39_000);
    expect(l.hit("a", rule)).toBe(1);
    // The first two hits slide out together; a refused hit was never counted.
    vi.advanceTimersByTime(1_000);
    expect([l.hit("a", rule), l.hit("a", rule)]).toEqual([0, 0]);
    expect(l.hit("a", rule)).toBe(20);
  });

  it("keeps keys and rules apart", () => {
    const l = createSlidingWindowLimiter();
    for (let i = 0; i < 3; i++) l.hit("a", rule);
    expect(l.hit("a", rule)).toBeGreaterThan(0);
    expect(l.hit("b", rule)).toBe(0);
    expect(l.hit("a", { ...rule, name: "other" })).toBe(0);
  });

  it("bounds the number of keys it holds", () => {
    const l = createSlidingWindowLimiter(5);
    for (let i = 0; i < 20; i++) l.hit(`ip${i}`, rule);
    expect(l.size()).toBe(5);
  });

  it("limits only with DEMO_MODE=1 and answers 429 with Retry-After", async () => {
    const req = () => new Request("http://x/api", { headers: { "x-forwarded-for": "203.0.113.9" } });
    const limit = RATE_RULES.contract.limit;
    for (let i = 0; i < limit * 2; i++) expect(rateLimited(req(), RATE_RULES.contract, env({}))).toBeNull();
    for (let i = 0; i < limit; i++) expect(rateLimited(req(), RATE_RULES.contract, env({ DEMO_MODE: "1" }))).toBeNull();
    const wait = rateLimited(req(), RATE_RULES.contract, env({ DEMO_MODE: "1" }));
    expect(wait).toBe(RATE_RULES.contract.windowMs / 1000);
    const res = tooManyRequests(wait!);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe(String(wait));
    expect(await res.json()).toMatchObject({ reason: "rate_limited", retryAfter: wait });
  });
});

describe("clientIp", () => {
  const ip = (headers: Record<string, string>) => clientIp(new Request("http://x/", { headers }));
  it("takes the first X-Forwarded-For hop, then X-Real-IP, else one shared bucket", () => {
    expect(ip({ "x-forwarded-for": " 198.51.100.7 , 10.0.0.1" })).toBe("198.51.100.7");
    expect(ip({ "x-forwarded-for": "2001:db8::1" })).toBe("2001:db8::1");
    expect(ip({ "x-forwarded-for": "not an ip", "x-real-ip": "198.51.100.8" })).toBe("198.51.100.8");
    expect(ip({})).toBe("unknown");
    expect(ip({ "x-forwarded-for": "<script>" })).toBe("unknown");
  });
});

/**
 * Per-IP limits on the routes that reach Claude (spend and abuse on the public demo). The hosted demo is one Render
 * instance, so an in-memory sliding window is enough; limits apply only with DEMO_MODE=1, so local dev and tests never
 * meet them.
 */
import { demoMode } from "@/app/api/demo/_demo";
import { json } from "@/lib/http";

export interface RateRule {
  /** Bucket name; routes that share a name share the count (the deliver and upload routes do). */
  name: string;
  limit: number;
  windowMs: number;
}

const FIVE_MINUTES = 5 * 60 * 1000;

export const RATE_RULES = {
  /** POST /api/agents/console: every turn is a model loop. */
  console: { name: "console", limit: 20, windowMs: FIVE_MINUTES },
  /** POST /api/contracts when a model drafts the contract. */
  contract: { name: "contract", limit: 10, windowMs: FIVE_MINUTES },
  /** POST /api/milestones/[id]/deliver and /upload: each delivery queues a worker judgment. */
  delivery: { name: "delivery", limit: 30, windowMs: FIVE_MINUTES },
} as const satisfies Record<string, RateRule>;

/** Keys kept at most; past it the least recently created key is dropped (bounds memory under a spray of addresses). */
const MAX_KEYS = 10_000;

export interface SlidingWindowLimiter {
  /** Records a hit for `key` and returns 0, or, when the window is full, records nothing and returns the seconds to wait. */
  hit(key: string, rule: RateRule): number;
  /** Number of keys held (tests). */
  size(): number;
}

/** A sliding-window log per rule and key. Reads Date.now(), so fake timers drive it in tests. */
export function createSlidingWindowLimiter(maxKeys = MAX_KEYS): SlidingWindowLimiter {
  const hits = new Map<string, number[]>();
  return {
    hit(key, rule) {
      const now = Date.now();
      const k = `${rule.name}\u0000${key}`;
      const log = (hits.get(k) ?? []).filter((t) => t > now - rule.windowMs);
      if (log.length >= rule.limit) {
        hits.set(k, log);
        return Math.max(1, Math.ceil((log[0]! + rule.windowMs - now) / 1000));
      }
      log.push(now);
      hits.delete(k);
      hits.set(k, log);
      while (hits.size > maxKeys) hits.delete(hits.keys().next().value!);
      return 0;
    },
    size: () => hits.size,
  };
}

const IP = /^[0-9A-Fa-f:.]{2,45}$/;

/**
 * The caller's address: the first hop of X-Forwarded-For (what Render's proxy reports), then X-Real-IP; anything that
 * does not look like an address falls back to "unknown", one shared bucket.
 */
export function clientIp(req: Request): string {
  const first = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "";
  if (IP.test(first)) return first;
  const real = req.headers.get("x-real-ip")?.trim() ?? "";
  return IP.test(real) ? real : "unknown";
}

const shared = createSlidingWindowLimiter();

/** With DEMO_MODE=1: null when the request may go on, else the seconds to wait (the hit is not counted). */
export function rateLimited(req: Request, rule: RateRule, env: NodeJS.ProcessEnv = process.env): number | null {
  if (!demoMode(env)) return null;
  const wait = shared.hit(clientIp(req), rule);
  return wait > 0 ? wait : null;
}

/** 429 with plain JSON and Retry-After. */
export function tooManyRequests(retryAfter: number): Response {
  return json({ error: `too many requests from this address, try again in ${retryAfter} s`, reason: "rate_limited", retryAfter }, 429, { "Retry-After": String(retryAfter) });
}

/** rateLimited + tooManyRequests in one: the 429 to return, or null. */
export function limitResponse(req: Request, rule: RateRule): Response | null {
  const wait = rateLimited(req, rule);
  return wait === null ? null : tooManyRequests(wait);
}

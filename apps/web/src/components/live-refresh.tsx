"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useSyncExternalStore } from "react";
import type { MilestoneSnapshot } from "@/app/api/milestones/[id]/status/snapshot";
import type { MilestoneSnapshots } from "@/app/api/milestones/status/route";
import { signature, verifierLines } from "@/app/api/milestones/[id]/status/lines";
import { LogStream, type LogLine } from "@/components/ui";

// One poller per page (LiveRefresh) publishes each milestone's latest snapshot here; the verifier log reads it, so a
// verifying milestone is polled once, not once per component.
const snapshots = new Map<string, MilestoneSnapshot>();
/** Milestone id -> time (ms) until which a re-render should wait, so lines that just arrived are seen before the station moves on. */
const holds = new Map<string, number>();
const listeners = new Set<() => void>();

function publish(s: MilestoneSnapshot) {
  snapshots.set(s.id, s);
  for (const l of listeners) l();
}
function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

const IDLE_AFTER_MS = 10 * 60_000;
const IDLE_EVERY_MS = 10_000;
/** A milestone whose only motion is its review window running out is checked this often (the client may act elsewhere). */
const REVIEW_EVERY_MS = 30_000;
/** How long after a review window closes to look again: the release job needs a moment to claim the payout. */
const WINDOW_END_SLACK_MS = 1_500;

interface Tick {
  /** Keep polling. */
  again: boolean;
  /** Something differed from what the page rendered. */
  changed?: boolean;
  /** Poll again this soon (ms) instead of the current interval. */
  wait?: number;
}

/**
 * The rules every live page shares: tick every `everyMs` while the tab is visible (a hidden tab skips the tick, and a
 * tab coming back ticks at once), slow to every 10 s after ten minutes without a change, stop when the tick says so or
 * after `maxMs`. `tick` gets the current interval and may ask for another wait. Returns the cleanup.
 */
function poll(tick: (every: number) => Promise<Tick>, everyMs: number, opts: { maxMs?: number; firstWait?: number } = {}): () => void {
  const until = opts.maxMs === undefined ? Number.POSITIVE_INFINITY : Date.now() + opts.maxMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let lastChange = Date.now();
  const every = () => (Date.now() - lastChange > IDLE_AFTER_MS ? Math.max(everyMs, IDLE_EVERY_MS) : everyMs);
  const schedule = (ms: number) => {
    if (stopped || Date.now() > until) return;
    clearTimeout(timer);
    timer = setTimeout(run, Math.max(0, ms));
  };
  const run = async () => {
    if (document.visibilityState !== "visible") return schedule(every());
    const r = await tick(every());
    if (stopped) return;
    if (r.changed) lastChange = Date.now();
    if (r.again) schedule(r.wait ?? every());
  };
  const onVisible = () => {
    if (document.visibilityState !== "visible" || stopped || Date.now() > until) return;
    clearTimeout(timer);
    void run();
  };
  document.addEventListener("visibilitychange", onVisible);
  schedule(opts.firstWait ?? everyMs);
  return () => {
    stopped = true;
    clearTimeout(timer);
    document.removeEventListener("visibilitychange", onVisible);
  };
}

/** A review whose window is still open with nothing else in flight: it needs a look now and then, and one at the end. */
function waitingOnWindow(s: MilestoneSnapshot, now: number): boolean {
  return s.status === "review" && s.pendingOp === null && s.reviewEndsAt !== null && Date.parse(s.reviewEndsAt) > now;
}

/** How long to wait before polling these live snapshots: `every`, or, when they are all open reviews, 30 s or until the first window closes. */
function nextWait(live: readonly MilestoneSnapshot[], every: number, now = Date.now()): number {
  if (live.length === 0 || !live.every((s) => waitingOnWindow(s, now))) return every;
  const firstEnd = Math.min(...live.map((s) => Date.parse(s.reviewEndsAt!)));
  return Math.min(Math.max(every, REVIEW_EVERY_MS), firstEnd - now + WINDOW_END_SLACK_MS);
}

export type LiveRefreshProps =
  /** The contract page: the milestones the server says are live, polled together. */
  | { initial: MilestoneSnapshot[]; everyMs?: number }
  /** A page with no snapshot to compare (disputes): re-render it every `everyMs` for at most `maxMinutes`. */
  | { mode: "page"; everyMs?: number; maxMinutes?: number };

/**
 * Keeps a server page current while something on it moves by itself. With `initial` (the contract page: the agent
 * verifying, a review window running out, the client deciding elsewhere, a payout waiting for PayPal's webhook, a
 * delivery the worker has not picked up yet) it polls GET /api/milestones/status for every live milestone in one
 * request, sending If-None-Match so an unchanged poll costs a 304, and re-renders the page when a snapshot differs from
 * what it rendered. The server decides what is live (snapshot.live); a milestone drops out once it is not, and polling
 * stops when none is left. Reviews with nothing else moving are checked every 30 s and once when their window closes.
 * With `mode="page"` it simply re-renders the page. Either way it pauses on a hidden tab and slows after ten quiet minutes.
 */
export function LiveRefresh(props: LiveRefreshProps) {
  const router = useRouter();
  const initial = "initial" in props ? props.initial : null;
  const everyMs = props.everyMs ?? 2000;
  const maxMinutes = "mode" in props ? props.maxMinutes : undefined;
  const key = initial ? initial.map(signature).join(",") + `|${initial.map((s) => s.id).join(",")}` : "page";
  useEffect(() => {
    if (!initial) {
      return poll(
        async () => {
          router.refresh();
          return { again: true };
        },
        everyMs,
        { maxMs: maxMinutes === undefined ? undefined : maxMinutes * 60_000 },
      );
    }

    let live = initial.filter((s) => s.live);
    if (live.length === 0) return;
    const base = new Map(live.map((s) => [s.id, signature(s)]));
    for (const s of live) publish(s);
    let etag: string | null = null;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;

    const refresh = () => {
      const wait = Math.max(0, ...holds.values()) - Date.now();
      if (wait > 0) {
        refreshTimer = setTimeout(refresh, Math.min(wait, 8000));
        return;
      }
      router.refresh();
    };
    const tick = async (every: number): Promise<Tick> => {
      const ids = live.map((s) => s.id).join(",");
      const res = await fetch(`/api/milestones/status?ids=${encodeURIComponent(ids)}`, { cache: "no-store", headers: etag ? { "If-None-Match": etag } : {} }).catch(() => null);
      // Nothing moved, or a failed poll (not a reason to stop): look again.
      if (!res || res.status === 304 || !res.ok) return { again: true, wait: nextWait(live, every) };
      const body = (await res.json().catch(() => null)) as MilestoneSnapshots | null;
      if (!body) return { again: true, wait: nextWait(live, every) };
      etag = res.headers.get("ETag");
      let changed = false;
      for (const s of body.snapshots) {
        publish(s);
        const sig = signature(s);
        if (sig !== base.get(s.id)) {
          base.set(s.id, sig);
          changed = true;
        }
      }
      live = body.snapshots.filter((s) => s.live);
      if (changed) {
        clearTimeout(refreshTimer);
        refresh();
      }
      return live.length > 0 ? { again: true, changed, wait: nextWait(live, every) } : { again: false, changed };
    };
    const stop = poll(tick, everyMs, { firstWait: nextWait(live, everyMs) });
    return () => {
      stop();
      clearTimeout(refreshTimer);
    };
    // `key` stands for `initial`: a re-render with the same snapshots must not restart polling.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router, key, everyMs, maxMinutes]);
  return null;
}

const STEP_MS = 320;
const LINGER_MS = 1600;

/**
 * The verifier's log on a verifying station: the delivery and the checks it was given (`head`, from the server), then
 * the events and evidence summaries as the poller brings them in, one line at a time.
 */
export function VerifierLog({ milestoneId, initial, head, title, maxHeight = 240 }: { milestoneId: string; initial: MilestoneSnapshot; head: LogLine[]; title: string; maxHeight?: number }) {
  const snap = useSyncExternalStore(
    subscribe,
    () => snapshots.get(milestoneId) ?? initial,
    () => initial,
  );
  const lines = [...head, ...verifierLines(snap)];
  const [shown, setShown] = useState(lines.length);
  const behind = lines.length - shown;
  useEffect(() => {
    if (behind <= 0) return;
    // Hold the page's re-render until these lines have played and been read.
    holds.set(milestoneId, Date.now() + behind * STEP_MS + LINGER_MS);
    const t = setTimeout(() => setShown((n) => n + 1), STEP_MS);
    return () => clearTimeout(t);
  }, [behind, milestoneId]);
  useEffect(() => () => void holds.delete(milestoneId), [milestoneId]);
  return <LogStream live title={title} lines={lines.slice(0, Math.max(0, Math.min(shown, lines.length)))} maxHeight={maxHeight} />;
}

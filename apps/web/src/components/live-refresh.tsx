"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useSyncExternalStore } from "react";
import type { MilestoneSnapshot } from "@/app/api/milestones/[id]/status/snapshot";
import { signature, verifierLines } from "@/app/api/milestones/[id]/status/lines";
import { LogStream, type LogLine } from "@/components/ui";
import { isLiveSnapshot } from "@/components/live-rules";

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

/**
 * Keeps the contract page current while something on it moves by itself (the agent verifying, a review window running
 * out, the client deciding elsewhere, a payout waiting for PayPal's webhook, a delivery the worker has not picked up
 * yet): polls each live milestone's status every
 * `everyMs` and re-renders the server page when anything differs from what it rendered. It stops once nothing is live,
 * pauses while the tab is hidden, and slows to every 10 s after ten quiet minutes.
 */
export function LiveRefresh({ initial, everyMs = 2000 }: { initial: MilestoneSnapshot[]; everyMs?: number }) {
  const router = useRouter();
  const key = initial.map(signature).join(",") + `|${initial.map((s) => s.id).join(",")}`;
  useEffect(() => {
    const ids = initial.map((s) => s.id);
    if (ids.length === 0) return;
    const base = new Map(initial.map((s) => [s.id, signature(s)]));
    for (const s of initial) publish(s);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    let lastChange = Date.now();

    const refresh = () => {
      const wait = Math.max(0, ...holds.values()) - Date.now();
      if (wait > 0) {
        refreshTimer = setTimeout(refresh, Math.min(wait, 8000));
        return;
      }
      router.refresh();
    };
    const schedule = () => {
      if (stopped) return;
      timer = setTimeout(tick, Date.now() - lastChange > IDLE_AFTER_MS ? IDLE_EVERY_MS : everyMs);
    };
    const tick = async () => {
      if (document.visibilityState !== "visible") return schedule();
      const got = await Promise.all(
        ids.map((id) =>
          fetch(`/api/milestones/${encodeURIComponent(id)}/status`, { cache: "no-store" })
            .then((r) => (r.ok ? (r.json() as Promise<MilestoneSnapshot>) : null))
            .catch(() => null),
        ),
      );
      if (stopped) return;
      let changed = false;
      let live = false;
      for (const s of got) {
        if (!s) {
          live = true; // a failed poll is not a reason to stop
          continue;
        }
        publish(s);
        const sig = signature(s);
        if (sig !== base.get(s.id)) {
          base.set(s.id, sig);
          changed = true;
        }
        // A delivery still waiting for its verdict counts even while the milestone is funded or held: the worker moves
        // it to verifying a moment later and the page must see that without a reload.
        if (isLiveSnapshot(s)) live = true;
      }
      if (changed) {
        lastChange = Date.now();
        clearTimeout(refreshTimer);
        refresh();
      }
      if (live) schedule();
    };
    const onVisible = () => {
      if (document.visibilityState !== "visible" || stopped) return;
      clearTimeout(timer);
      void tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    schedule();
    return () => {
      stopped = true;
      clearTimeout(timer);
      clearTimeout(refreshTimer);
      document.removeEventListener("visibilitychange", onVisible);
    };
    // `key` stands for `initial`: a re-render with the same snapshots must not restart polling.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router, key, everyMs]);
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

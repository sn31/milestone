"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import type { MilestoneSnapshot } from "@/app/api/milestones/[id]/status/snapshot";
import type { MilestoneSnapshots } from "@/app/api/milestones/status/route";
import { CHECK_TONE, CHECK_WORD, signature, verifierLines, type CheckStatus, type LogCriterion, type VerifyLine } from "@/app/api/milestones/[id]/status/lines";
import { nextWait } from "@/components/live-rules";
import { LogStream, StateGlyph, cx, type LogLine } from "@/components/ui";

// One poller per page (LiveRefresh) publishes each milestone's latest snapshot here; the verifier log reads it, so a
// verifying milestone is polled once, not once per component.
const snapshots = new Map<string, MilestoneSnapshot>();
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
      // The verifying station holds itself on screen (VerifyGate) while its lines play, so the page can move on now.
      if (changed) router.refresh();
      return live.length > 0 ? { again: true, changed, wait: nextWait(live, every) } : { again: false, changed };
    };
    const stop = poll(tick, everyMs, { firstWait: nextWait(live, everyMs) });
    return stop;
    // `key` stands for `initial`: a re-render with the same snapshots must not restart polling.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router, key, everyMs, maxMinutes]);
  return null;
}

// ---------- The verifying beat ----------

/** One log line every this often while the agent works (and when a finished run is played back). */
const STEP_MS = 420;
/** The verifying station stays on screen at least this long once a delivery is in, however fast the verdict came. */
export const MIN_DWELL_MS = 6_000;
/** After the last line, this long to read it before the station moves on to the verdict. */
const LINGER_MS = 1_400;
/** Never hold a finished verdict back longer than this. */
const MAX_HOLD_MS = 25_000;
const DONE_KEY = (runKey: string) => `ms.verified.${runKey}`;

// Per delivery run (id and arrival time), for this page load: how many lines were shown (the log survives a re-render or a remount), when the
// verifying station first appeared, and which deliveries have handed over to their verdict.
const shownByDelivery = new Map<string, number>();
const startedAt = new Map<string, number>();
const progress = new Map<string, { shown: number; total: number }>();
const done = new Set<string>();
const gateListeners = new Set<() => void>();
const notifyGates = () => {
  for (const l of gateListeners) l();
};
function subscribeGates(l: () => void) {
  gateListeners.add(l);
  return () => {
    gateListeners.delete(l);
  };
}
function isDone(runKey: string): boolean {
  if (done.has(runKey)) return true;
  try {
    return window.sessionStorage.getItem(DONE_KEY(runKey)) === "1";
  } catch {
    return false;
  }
}
function markDone(runKey: string) {
  done.add(runKey);
  try {
    window.sessionStorage.setItem(DONE_KEY(runKey), "1");
  } catch {
    // private window: this page load still remembers it
  }
  notifyGates();
}

/** The snapshot further along for this delivery: the poller's, or the server's (fresher right after a re-render). */
function fresher(polled: MilestoneSnapshot | undefined, server: MilestoneSnapshot, deliveryId: string): MilestoneSnapshot {
  if (!polled || polled.delivery?.id !== deliveryId) return server;
  if (server.delivery?.id !== deliveryId) return polled;
  const rank = (s: MilestoneSnapshot) => (s.delivery?.verifiedAt ? 1e6 : 0) + s.evidence.length * 100 + s.events.length;
  return rank(polled) >= rank(server) ? polled : server;
}

const CHECK_GLYPH: Record<CheckStatus, "check" | "cross" | "query"> = { pass: "check", fail: "cross", unclear: "query", client: "query" };

/** The checks beside the log: each ticks when the line that settles it has been shown. */
function CheckList({ criteria, settled }: { criteria: readonly (LogCriterion & { required: boolean })[]; settled: Map<string, CheckStatus> }) {
  const n = [...settled.keys()].filter((id) => criteria.some((c) => c.id === id)).length;
  return (
    <div className="overflow-hidden rounded-panel border border-hairline bg-surface-sunken">
      <div className="flex items-center justify-between gap-3 border-b border-hairline px-3 py-2">
        <p className="type-label text-fg-faint">Checks</p>
        <p className="font-mono text-[11px] text-fg-faint tabular">
          {n} of {criteria.length} done
        </p>
      </div>
      <ol className="divide-y divide-dashed divide-hairline">
        {criteria.map((c) => {
          const st = settled.get(c.id);
          return (
            <li key={c.id} data-tone={st ? CHECK_TONE[st] : "verifying"} className="grid grid-cols-[16px_minmax(0,1fr)_auto] items-start gap-x-2.5 px-3 py-2.5">
              <span aria-hidden className={cx("mt-[2px] grid size-4 place-items-center rounded-chip text-tone", st ? "bg-tone-soft" : "border border-tone")}>
                <StateGlyph glyph={st ? CHECK_GLYPH[st] : "pulse"} className={cx("size-[9px]", !st && "animate-pulse-dot")} />
              </span>
              <span className="min-w-0 text-[13px] leading-snug text-fg">
                <span className="type-label mr-1.5 text-[9.5px] text-fg-faint">{c.kind}</span>
                {c.description}
                {c.required ? null : <span className="ml-1.5 text-[11.5px] text-fg-faint">optional</span>}
              </span>
              <span className="pt-[2px] font-mono text-[10.5px] tracking-[0.1em] text-tone uppercase">{st ? CHECK_WORD[st] : "checking"}</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/**
 * The verifying station's body: the agent's log (the delivery, then each check as its evidence lands, the judgment and
 * the decision, one line every 420 ms) beside the checklist those lines tick off. Fed by the page's poller, or by the
 * server's snapshot when a finished run is played back (VerifyGate).
 */
export function VerifyingPanel({
  milestoneId,
  deliveryId,
  runKey,
  initial,
  head,
  criteria,
  title,
  maxHeight = 260,
}: {
  milestoneId: string;
  deliveryId: string;
  /** This run of the delivery (its id and arrival time: a reseeded database can reuse an id), for play-once state. */
  runKey: string;
  initial: MilestoneSnapshot;
  head: LogLine[];
  criteria: (LogCriterion & { required: boolean })[];
  title: ReactNode;
  maxHeight?: number;
}) {
  const polled = useSyncExternalStore(
    subscribe,
    () => snapshots.get(milestoneId),
    () => undefined,
  );
  const snap = fresher(polled, initial, deliveryId);
  const lines: (LogLine | VerifyLine)[] = [...head, ...verifierLines(snap, criteria)];
  const [shown, setShown] = useState(() => shownByDelivery.get(runKey) ?? Math.min(head.length, lines.length));
  const visible = Math.min(shown, lines.length);
  useEffect(() => {
    progress.set(runKey, { shown: visible, total: lines.length });
    notifyGates();
    if (visible >= lines.length) return;
    const t = setTimeout(() => {
      setShown((n) => {
        shownByDelivery.set(runKey, n + 1);
        return n + 1;
      });
    }, STEP_MS);
    return () => clearTimeout(t);
  }, [visible, lines.length, runKey]);
  const settled = new Map<string, CheckStatus>();
  for (const l of lines.slice(0, visible)) {
    if (typeof l === "object" && "criterionId" in l && l.criterionId && l.status) settled.set(l.criterionId, l.status);
  }
  return (
    <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_320px] lg:items-start">
      <LogStream live title={title} lines={lines.slice(0, visible)} maxHeight={maxHeight} />
      {criteria.length ? <CheckList criteria={criteria} settled={settled} /> : null}
    </div>
  );
}

/**
 * Keeps a delivery's verifying station on screen until its beat has played: at least MIN_DWELL_MS from when it first
 * appeared and until every line of the log has been shown, then hands over to the verdict (`children`). Without a model
 * a verdict lands about a second after the delivery, faster than the poll; the server then renders the settled station
 * with `verifying` beside it, and the gate plays the run back from the stored evidence. `settled` false: the agent is
 * still working (or has not picked the delivery up), so only `verifying` is shown. A delivery whose beat has played in
 * this tab (sessionStorage) shows its verdict at once.
 */
export function VerifyGate({ runKey, settled, verifying, children }: { runKey: string; settled: boolean; verifying: ReactNode; children?: ReactNode }) {
  const finished = useSyncExternalStore(
    subscribeGates,
    () => isDone(runKey),
    () => false,
  );
  useEffect(() => {
    if (!startedAt.has(runKey)) startedAt.set(runKey, Date.now());
    if (!settled || finished) return;
    let lingering: ReturnType<typeof setTimeout> | undefined;
    const check = () => {
      if (lingering) return;
      const since = Date.now() - (startedAt.get(runKey) ?? Date.now());
      const p = progress.get(runKey);
      const played = p !== undefined && p.shown >= p.total;
      if ((since >= MIN_DWELL_MS && played) || since >= MAX_HOLD_MS) lingering = setTimeout(() => markDone(runKey), played ? LINGER_MS : 0);
    };
    const unsub = subscribeGates(check);
    const tick = setInterval(check, 250);
    check();
    return () => {
      unsub();
      clearInterval(tick);
      clearTimeout(lingering);
    };
  }, [runKey, settled, finished]);
  return <>{settled && finished ? children : verifying}</>;
}

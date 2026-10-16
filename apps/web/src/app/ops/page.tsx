import Link from "next/link";
import type { ReactNode } from "react";
import { and, asc, desc, inArray } from "drizzle-orm";
import { asNumber as num, asRecord as obj, asString as str, auditLog, contracts, milestones, openOperatorFlags, paypalOps } from "@milestone/core";
import { armedSimulatedFailures, paypalMode } from "@milestone/money";
import { getDb } from "@/lib/db";
import { ACTOR_NAMES, getActor, isOperator } from "@/lib/session";
import { auditTime, eventTone } from "@/lib/events";
import { formatDateTime, formatMoney, humanize } from "@/lib/format";
import {
  Button,
  EmptyState,
  Hash,
  LogStream,
  Money,
  PageHeader,
  Panel,
  Reveal,
  SectionTitle,
  Stat,
  StatePill,
  cx,
  type LogLine,
  type ToneKey,
} from "@/components/ui";
import { payoutFailureLine, payoutReason } from "@/lib/payout-failure";
import { eventSentence } from "@/app/contracts/[id]/activity/sentence";
import { ResolveForm } from "./resolve-form";
import { SimulatePayoutFailure } from "./simulate-failure";
import { RECONCILE_EVENTS, ReconciliationCard } from "./reconciliation-card";

export const dynamic = "force-dynamic";

type Party = "partner" | "freelancer";

/** paypal_ops.status as a pill: in flight reads as money moving (funded blue), settled as released, failed as danger. */
const OP_PILL: Record<string, { state: string; label: string }> = {
  pending: { state: "draft", label: "Pending" },
  sent: { state: "funded", label: "Sent" },
  succeeded: { state: "released", label: "Succeeded" },
  failed: { state: "failed", label: "Failed" },
};

/** "4m", "3h 12m", "2d 5h". */
function age(from: Date, now: Date): string {
  const m = Math.max(0, Math.floor((now.getTime() - from.getTime()) / 60_000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

const hms = (d: Date) => auditTime(d, true);

/** Who did it, by name: people from the seed, the system actors in words. */
const NAMES: Record<string, string> = {
  ...ACTOR_NAMES,
  paypal: "PayPal",
  policy: "Policy",
  verifier: "Verifier",
  system: "System",
  worker: "Worker",
};
const nameOf = (id: string) => NAMES[id] ?? id;

/** One audit row as a log line: the event, what happened in words, who. In its event's tone; plain when neutral. */
function trailLine(e: { event: string; actor: string; detail: unknown; createdAt: Date }, currency: string): LogLine {
  const tone = eventTone(e.event);
  return {
    at: hms(e.createdAt),
    text: `${e.event}  ${eventSentence(e.event, e.detail, NAMES, currency)} · ${nameOf(e.actor)}`,
    tone: tone === "neutral" || tone === "verifying" ? undefined : tone,
  };
}

/**
 * The operator queue, as a control room. A milestone is here when its latest needs_operator flag has no later
 * ops.resolved. Each case shows the release job's operator summary (paid, failed, reversed, pending, refunded per party),
 * its paypal_ops rows and the audit trail, then the resolve form.
 */
export default async function OpsPage() {
  const db = getDb();
  const actor = await getActor();
  const canAct = isOperator(actor);
  const mode = paypalMode();
  const simulated = mode === "simulated";

  // The latest reconciliation (PayPal's transactions read through PayPal's MCP server), its own card below the cases.
  const [reconciliation] = await db
    .select({ id: auditLog.id, event: auditLog.event, detail: auditLog.detail, createdAt: auditLog.createdAt })
    .from(auditLog)
    .where(inArray(auditLog.event, [RECONCILE_EVENTS.reconciled, RECONCILE_EVENTS.failed]))
    .orderBy(desc(auditLog.createdAt))
    .limit(1);

  // Oldest case first.
  const open = [...(await openOperatorFlags(db)).values()].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const ids = open.map((f) => f.milestoneId!);
  const [ms, ops, trail] = ids.length
    ? await Promise.all([
        db.select().from(milestones).where(inArray(milestones.id, ids)),
        db
          .select()
          .from(paypalOps)
          .where(and(inArray(paypalOps.key, ids), inArray(paypalOps.kind, ["payout", "refund"])))
          .orderBy(asc(paypalOps.createdAt)),
        db.select().from(auditLog).where(inArray(auditLog.milestoneId, ids)).orderBy(asc(auditLog.createdAt)),
      ])
    : [[], [], []];
  const cs = ms.length
    ? await db
        .select()
        .from(contracts)
        .where(inArray(contracts.id, [...new Set(ms.map((m) => m.contractId))]))
    : [];
  const msById = new Map(ms.map((m) => [m.id, m]));
  const csById = new Map(cs.map((c) => [c.id, c]));

  // Simulated PayPal only: milestones whose payout is still ahead, to arm a failure against.
  const waiting = simulated
    ? await db
        .select({
          id: milestones.id,
          seq: milestones.seq,
          title: milestones.title,
          contractId: milestones.contractId,
        })
        .from(milestones)
        .where(inArray(milestones.status, ["funded", "verifying", "review", "needs_client"]))
    : [];
  const waitingContracts = waiting.length
    ? await db
        .select({ id: contracts.id, title: contracts.title })
        .from(contracts)
        .where(inArray(contracts.id, [...new Set(waiting.map((m) => m.contractId))]))
    : [];
  const titleOf = new Map(waitingContracts.map((c) => [c.id, c.title]));
  const candidates = waiting
    .sort((a, b) => a.contractId.localeCompare(b.contractId) || a.seq - b.seq)
    .map((m) => ({
      milestoneId: m.id,
      label: `${titleOf.get(m.contractId) ?? m.contractId} · ${m.seq}. ${m.title}`,
    }));
  const armed = simulated ? armedSimulatedFailures() : [];

  const now = new Date();
  const stopped = new Map<string, number>();
  for (const f of open) {
    const m = msById.get(f.milestoneId!);
    const c = m ? csById.get(m.contractId) : undefined;
    if (m && c) stopped.set(c.currency, (stopped.get(c.currency) ?? 0) + m.amountMinor);
  }
  const [mainCurrency, stoppedMinor] = [...stopped.entries()].sort((a, b) => b[1] - a[1])[0] ?? ["USD", 0];

  return (
    <main>
      <PageHeader
        eyebrow={
          <>
            Operations <span className="text-hairline-strong">/</span> {ACTOR_NAMES[actor.userId] ?? actor.userId}
          </>
        }
        title="Operator queue"
        description="A payout item that fails, is blocked, returned or reversed stops its milestone here, held. Nothing on it is paid again automatically; a person reads the trail and resolves it."
        aside={
          <>
            <Stat label="Open cases" tone={open.length > 0 ? "danger" : "released"} value={open.length} />
            <Stat
              label="Money stopped"
              tone={stoppedMinor > 0 ? "held" : undefined}
              minor={stoppedMinor}
              currency={mainCurrency}
              hint={stopped.size > 1 ? `${mainCurrency} only` : undefined}
            />
          </>
        }
      />

      {/* Status strip: the instruments a control room keeps in view. */}
      <div className="mt-10 flex flex-wrap items-center gap-x-6 gap-y-2 rounded-panel border border-hairline bg-surface-sunken px-4 py-2.5 font-mono text-[11px] text-fg-faint tabular">
        <span data-tone={open.length > 0 ? "danger" : "released"} className="flex items-center gap-2 text-tone">
          <span className={cx("size-1.5 rounded-full bg-tone", open.length > 0 && "animate-pulse-dot")} />
          {open.length > 0 ? `${open.length} waiting` : "all clear"}
        </span>
        <span>
          paypal <span className="text-fg-muted">{mode}</span>
        </span>
        <span>
          oldest <span className="text-fg-muted">{open[0] ? age(open[0].createdAt, now) : "none"}</span>
        </span>
        <span>
          role <span className="text-fg-muted">{actor.role}</span>
          {canAct ? null : <span className="text-state-held"> · read only</span>}
        </span>
        <span className="sm:ml-auto">{formatDateTime(now)}</span>
      </div>

      <section className="mt-6" aria-label="Open cases">
        {open.length === 0 ? (
          <EmptyState
            title="The queue is clear"
            body="Every payout and refund has settled the way the policy decided. When PayPal reports a failed, blocked, returned or reversed item, the milestone stops here for a person to resolve."
            action={<Button href="/">Back to contracts</Button>}
          />
        ) : (
          <ol className="grid gap-4">
            {open.map((f, i) => {
              const m = msById.get(f.milestoneId!);
              const c = m ? csById.get(m.contractId) : undefined;
              const d = obj(f.detail);
              const currency = str(d.currency) ?? c?.currency ?? "USD";
              const myOps = ops.filter((o) => o.key === f.milestoneId);
              const myTrail = trail.filter((e) => e.milestoneId === f.milestoneId).slice(-14);
              const failed = Object.keys(obj(d.failed)).length > 0;
              return (
                <Reveal as="li" key={f.id} index={i}>
                  <Panel as="article" variant="solid" tone={failed ? "danger" : "held"} padded={false} aria-label={`Case ${i + 1}`}>
                    {/* Case header */}
                    <header className="flex flex-col gap-4 border-b border-hairline px-5 py-4 sm:flex-row sm:items-start sm:justify-between sm:px-6">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 font-mono text-[11px] text-fg-faint tabular">
                          <span className="text-tone">CASE {String(i + 1).padStart(2, "0")}</span>
                          {m ? <StatePill state={m.status} /> : null}
                          <span>flagged {hms(f.createdAt)} UTC</span>
                          <span>· {age(f.createdAt, now)} ago</span>
                          <span>· by {nameOf(f.actor)}</span>
                        </div>
                        <h2 className="type-display-s mt-2 text-fg">
                          {m ? (
                            <>
                              <span className="mr-2 font-mono text-[15px] text-fg-faint tabular">{String(m.seq).padStart(2, "0")}</span>
                              {m.title}
                            </>
                          ) : (
                            "Unknown milestone"
                          )}
                        </h2>
                        <p className="mt-1 text-[13px] text-fg-muted">
                          {c ? (
                            <Link href={`/contracts/${c.id}`} className="underline decoration-hairline-strong underline-offset-[3px] hover:decoration-fg-muted">
                              {c.title}
                            </Link>
                          ) : (
                            "Unknown contract"
                          )}
                          <span className="ml-2 font-mono text-[11px] text-fg-faint">{f.milestoneId}</span>
                        </p>
                      </div>
                      <div className="flex items-baseline justify-between gap-3 sm:block sm:text-right">
                        <p className="type-label text-fg-faint sm:mb-1.5">Held</p>
                        {m ? <Money minor={m.amountMinor} currency={c?.currency ?? currency} size="m" tone="held" /> : null}
                      </div>
                    </header>

                    {payoutFailureLine(d) ? (
                      <p
                        data-tone={failed ? "danger" : "held"}
                        className="flex gap-3 border-b border-hairline bg-tone-wash px-5 py-3 text-[13px] text-fg sm:px-6"
                      >
                        <span className="type-label shrink-0 pt-[3px] text-tone">Reason</span>
                        <span className="min-w-0">{payoutFailureLine(d)}</span>
                      </p>
                    ) : null}

                    <div className="grid lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
                      {/* Operator summary as a compact ledger */}
                      <div className="border-b border-hairline px-5 py-5 sm:px-6 lg:border-r lg:border-b-0">
                        <p className="type-label text-fg-faint">Operator summary</p>
                        <OperatorLedger d={d} currency={currency} />
                        {str(d.payoutBatchId) || str(d.action) ? (
                          <p className="mt-4 flex flex-wrap items-center gap-2 font-mono text-[11px] text-fg-faint">
                            {str(d.action) ? <span>action {str(d.action)}</span> : null}
                            {str(d.payoutBatchId) ? <Hash value={str(d.payoutBatchId)!} label="batch" /> : null}
                          </p>
                        ) : null}
                      </div>

                      {/* PayPal ops and the trail */}
                      <div className="px-5 py-5 sm:px-6">
                        <p className="type-label text-fg-faint">PayPal ops</p>
                        {myOps.length === 0 ? (
                          <p className="mt-3 font-mono text-[12px] text-fg-faint">No payout or refund op recorded for this milestone.</p>
                        ) : (
                          <ul className="mt-2 divide-y divide-hairline">
                            {myOps.map((o) => {
                              const pill = OP_PILL[o.status] ?? {
                                state: o.status,
                                label: o.status,
                              };
                              return (
                                <li
                                  key={o.id}
                                  className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-center gap-x-3 gap-y-2 py-2.5 sm:grid-cols-[4.5rem_6.5rem_minmax(0,1fr)_auto]"
                                >
                                  <span className="font-mono text-[12px] text-fg uppercase tracking-[0.08em]">{o.kind}</span>
                                  <StatePill state={pill.state} label={pill.label} className="justify-self-start" />
                                  <span className="col-span-2 flex min-w-0 flex-wrap gap-1.5 sm:col-span-1">
                                    {o.paypalId ? (
                                      <Hash value={o.paypalId} label="id" />
                                    ) : (
                                      <span className="font-mono text-[11px] text-fg-faint">no paypal id</span>
                                    )}
                                    <Hash value={o.requestId} label="req" />
                                  </span>
                                  <span className="col-span-2 font-mono text-[11px] text-fg-faint tabular sm:col-span-1 sm:text-right">
                                    {hms(o.updatedAt ?? o.createdAt)}
                                  </span>
                                </li>
                              );
                            })}
                          </ul>
                        )}
                        {myTrail.length > 0 ? (
                          <LogStream
                            className="mt-4"
                            title={`audit trail · ${f.milestoneId}`}
                            lines={myTrail.map((e) => trailLine(e, currency))}
                            maxHeight={960}
                          />
                        ) : null}
                      </div>
                    </div>

                    {/* Resolve */}
                    <footer className="border-t border-hairline bg-surface-sunken/60 px-5 py-4 sm:px-6">
                      <ResolveForm milestoneId={f.milestoneId!} disabled={!canAct} />
                    </footer>
                  </Panel>
                </Reveal>
              );
            })}
          </ol>
        )}
      </section>

      <section className="mt-6" aria-label="Reconciliation">
        <ReconciliationCard row={reconciliation ?? null} canAct={canAct} />
      </section>

      {simulated ? (
        <section className="mt-12" aria-label="Simulated PayPal">
          <Panel variant="outline">
            <SectionTitle eyebrow="Simulated PayPal" title="Fail the next payout" />
            <p className="mb-5 max-w-[64ch] text-[13px] leading-relaxed text-fg-muted">
              Plays PayPal refusing a payout item: the next payout to this payee comes back failed, once. The release job holds the milestone and it arrives in
              this queue, as a real failure would.
            </p>
            <SimulatePayoutFailure options={candidates} armed={armed} />
          </Panel>
        </section>
      ) : null}
    </main>
  );
}

/** paid / failed / reversed / pending / refunded, one ruled line each, per party in mono. */
function OperatorLedger({ d, currency }: { d: Record<string, unknown>; currency: string }) {
  const paid = obj(d.paid);
  const failed = obj(d.failed);
  const reversed = obj(d.reversed);
  const pending = Array.isArray(d.pending) ? d.pending.filter((p): p is Party => p === "partner" || p === "freelancer") : [];
  const refunded = d.refunded && typeof d.refunded === "object" ? obj(d.refunded) : null;
  const none = <span className="text-fg-faint">none</span>;
  const entries = (o: Record<string, unknown>, render: (party: string, v: unknown) => ReactNode) =>
    Object.keys(o).length === 0 ? (
      none
    ) : (
      <span className="flex flex-col items-end gap-0.5">
        {Object.entries(o).map(([party, v]) => (
          <span key={party} className="flex flex-wrap items-baseline justify-end gap-x-2">
            <span className="text-fg-faint">{party}</span>
            {render(party, v)}
          </span>
        ))}
      </span>
    );
  const rows: {
    label: string;
    tone: ToneKey;
    lit: boolean;
    value: ReactNode;
    note?: ReactNode;
  }[] = [
    {
      label: "Paid",
      tone: "released",
      lit: Object.keys(paid).length > 0,
      value: entries(paid, (_, v) => (num(v) !== null ? <Money minor={num(v)!} currency={currency} tone="released" /> : "?")),
    },
    {
      label: "Failed",
      tone: "danger",
      lit: Object.keys(failed).length > 0,
      // The party on the ruled line; why it failed on its own line underneath, so the leader is never squeezed.
      value: entries(failed, () => null),
      note: Object.keys(failed).length
        ? Object.entries(failed).map(([party, v]) => (
            <span key={party} className="block">
              {Object.keys(failed).length > 1 ? `${party}: ` : ""}
              {payoutReason(String(v)) ?? humanize(String(v))}
            </span>
          ))
        : null,
    },
    {
      label: "Reversed",
      tone: "held",
      lit: Object.keys(reversed).length > 0,
      value: entries(reversed, (_, v) => {
        const r = obj(v);
        return (
          <span className="text-tone">
            {str(r.eventType) ?? "reversal"}
            {num(r.amountMinor) !== null ? <> {formatMoney(num(r.amountMinor)!, currency)}</> : null}
          </span>
        );
      }),
    },
    {
      label: "Pending",
      tone: "funded",
      lit: pending.length > 0,
      value: pending.length ? <span className="text-tone">{pending.join(", ")}</span> : none,
    },
    {
      label: "Refunded",
      tone: "partial",
      lit: !!refunded,
      value: refunded ? (
        <span className="flex flex-col items-end gap-0.5">
          {num(refunded.settledMinor) !== null ? (
            <Money minor={num(refunded.settledMinor)!} currency={currency} tone="partial" />
          ) : num(refunded.claimedMinor) !== null ? (
            <span className="flex items-baseline gap-2">
              <span className="text-fg-faint">claimed</span>
              <Money minor={num(refunded.claimedMinor)!} currency={currency} />
            </span>
          ) : null}
          <span className="text-fg-faint">op {str(refunded.opStatus) ?? "unknown"}</span>
        </span>
      ) : (
        none
      ),
    },
  ];
  return (
    <dl className="mt-3 font-mono text-[12.5px] tabular">
      {rows.map((r) => (
        <div
          key={r.label}
          data-tone={r.lit ? r.tone : "neutral"}
          className="flex flex-wrap items-baseline gap-x-3 border-b border-dashed border-hairline py-2.5 last:border-b-0"
        >
          <dt className={cx("flex w-20 shrink-0 items-center gap-2 uppercase tracking-[0.1em] text-[11px]", r.lit ? "text-tone" : "text-fg-faint")}>
            <span aria-hidden className={cx("size-1.5 rounded-full", r.lit ? "bg-tone" : "border border-hairline-strong")} />
            {r.label}
          </dt>
          <span aria-hidden className="leader" />
          <dd className="min-w-0 text-right text-fg">{r.value}</dd>
          {r.note ? <dd className="mt-1.5 basis-full pl-[14px] font-sans text-[13px] leading-snug text-tone">{r.note}</dd> : null}
        </div>
      ))}
    </dl>
  );
}

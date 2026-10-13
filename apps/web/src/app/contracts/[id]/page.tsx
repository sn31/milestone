import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";
import { and, desc, eq, inArray, or } from "drizzle-orm";
import { AUDIT_EVENTS, OP_KINDS, RELEASABLE_STATUSES, advances, asRecord, asString, auditLog, decisionDeliveryId, deliveries, ledgerEntries, paypalOps, reviewWindowSeconds } from "@milestone/core";
import { advanceRepayment } from "@milestone/money";
import { getDb } from "@/lib/db";
import { ACTOR_NAMES, getActor, isContractClient, isContractFreelancer } from "@/lib/session";
import { formatDate, formatMoney } from "@/lib/format";
import { SYSTEM_ACTOR_NAMES, auditTime } from "@/lib/events";
import { payoutFailureLine } from "@/lib/payout-failure";
import { MilestoneActions, runKeyOf, type ReleaseView } from "@/components/milestone-actions";
import { LiveRefresh, VerifyGate } from "@/components/live-refresh";
import { awaitingVerdict } from "@/components/live-rules";
import { ConnectorFill, type ReleaseLeg } from "@/components/ui/transit";
import { loadSnapshots } from "@/app/api/milestones/[id]/status/snapshot";
import {
  Button,
  EmptyState,
  ESCROW_STATES,
  MoneyBar,
  Money,
  PAID_STATES,
  PageHeader,
  Panel,
  Rail,
  RailCap,
  SectionTitle,
  Stat,
  StateGlyph,
  StatePill,
  Station,
  stateMeta,
  toneOf,
  type Phase,
} from "@/components/ui";
import { ActivityLedger } from "../_components/activity-ledger";
import { ApprovalStrip } from "../_components/approval-strip";

export const dynamic = "force-dynamic";

/** The contract row, once per request: generateMetadata and the page share it. */
const loadContract = cache((id: string) => getDb().query.contracts.findFirst({ where: (t, { eq }) => eq(t.id, id) }));

export async function generateMetadata({ params }: PageProps<"/contracts/[id]">): Promise<Metadata> {
  const { id } = await params;
  const contract = await loadContract(id);
  return { title: contract?.title ?? "Contract not found" };
}

type DeliveryRow = typeof deliveries.$inferSelect;

/** A money moment (funding, release) this recent plays on the page once; older ones render at rest. */
const FRESH_MS = 60_000;
/** A verdict this recent is played back as the verifying beat before its station shows the verdict (see VerifyGate). */
const RECENT_VERDICT_MS = 45_000;
/** Statuses a verdict hands a milestone to. */
const VERDICT_STATUSES: ReadonlySet<string> = new Set(["review", "needs_client", "held"]);
const CLIENT_VERB: Record<string, string> = { "client.approve": "Approved", "client.confirm_partial": "Share confirmed", "client.hold": "Held", "client.veto": "Vetoed" };

/** The time of this request (the page is dynamic): what "fresh" and "recent" are measured from. */
function requestTime(): number {
  return Date.now();
}

/** Where a milestone's station sits on the contract rail: paid out is behind us, unfunded is ahead, anything in escrow is here. */
function phaseOf(status: string): Phase {
  if (PAID_STATES.has(status)) return "done";
  if (status === "draft") return "upcoming";
  return "current";
}

export default async function ContractPage({ params }: PageProps<"/contracts/[id]">) {
  const { id } = await params;
  const db = getDb();
  const [contract, actor, ms, activity] = await Promise.all([
    loadContract(id),
    getActor(),
    db.query.milestones.findMany({ where: (t, { eq }) => eq(t.contractId, id), orderBy: (t, { asc }) => [asc(t.seq)] }),
    db.query.auditLog.findMany({ where: (t, { eq }) => eq(t.contractId, id), orderBy: (t, { desc }) => [desc(t.createdAt)], limit: 12 }),
  ]);
  if (!contract) notFound();
  const ids = ms.map((m) => m.id);
  const heldIds = ms.filter((m) => m.status === "held").map((m) => m.id);
  // A milestone awaiting the client is checked against the delivery its decision was made for, which may be older.
  const decidedIds = ms.filter((m) => RELEASABLE_STATUSES.has(m.status)).flatMap((m) => decisionDeliveryId(m.decision) ?? []);
  const paidIds = ms.filter((m) => PAID_STATES.has(m.status)).map((m) => m.id);
  const releasableIds = ms.filter((m) => RELEASABLE_STATUSES.has(m.status)).map((m) => m.id);
  const [people, crit, dels, snapshots, flagged, moments, legsRows, payouts, openAdvances] = await Promise.all([
    db.query.users.findMany({ columns: { id: true, name: true }, where: (t, { inArray }) => inArray(t.id, [contract.clientId, contract.freelancerId]) }),
    ids.length ? db.query.criteria.findMany({ where: (t, { inArray }) => inArray(t.milestoneId, ids) }) : [],
    // Each milestone's latest delivery (DISTINCT ON) and the decided ones, in one query.
    ids.length
      ? db
          .select()
          .from(deliveries)
          .where(
            or(
              inArray(
                deliveries.id,
                db
                  .selectDistinctOn([deliveries.milestoneId], { id: deliveries.id })
                  .from(deliveries)
                  .where(inArray(deliveries.milestoneId, ids))
                  .orderBy(deliveries.milestoneId, desc(deliveries.receivedAt), desc(deliveries.id)),
              ),
              decidedIds.length ? inArray(deliveries.id, decidedIds) : undefined,
            ),
          )
      : [],
    // What can change on its own, as the status poll reports it; the server's own rule says which milestones are live.
    loadSnapshots(db, ids),
    heldIds.length
      ? db.query.auditLog.findMany({
          columns: { milestoneId: true, detail: true },
          where: (t) => and(inArray(t.milestoneId, heldIds), eq(t.event, AUDIT_EVENTS.needsOperator)),
          orderBy: (t, { desc }) => [desc(t.createdAt)],
        })
      : [],
    // The moments the rail replays or annotates: funding and release times, the client's decisions, injection hits.
    db
      .select({ milestoneId: auditLog.milestoneId, event: auditLog.event, actor: auditLog.actor, detail: auditLog.detail, createdAt: auditLog.createdAt })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.contractId, id),
          inArray(auditLog.event, [AUDIT_EVENTS.milestoneFunded, AUDIT_EVENTS.milestoneReleased, AUDIT_EVENTS.milestonePartialReleased, AUDIT_EVENTS.verdictStored, ...Object.keys(CLIENT_VERB)]),
        ),
      )
      .orderBy(desc(auditLog.createdAt)),
    // Where each paid milestone's escrow went, as the ledger booked it (the partner's repayment, the freelancer, a refund).
    paidIds.length
      ? db
          .select({ account: ledgerEntries.account, amountMinor: ledgerEntries.amountMinor, ref: ledgerEntries.ref })
          .from(ledgerEntries)
          .where(and(inArray(ledgerEntries.account, paidIds.map((m) => `held:${m}`)), eq(ledgerEntries.direction, "debit")))
      : [],
    ids.length
      ? db
          .select({ key: paypalOps.key, paypalId: paypalOps.paypalId, requestId: paypalOps.requestId, status: paypalOps.status })
          .from(paypalOps)
          .where(and(inArray(paypalOps.key, ids), eq(paypalOps.kind, OP_KINDS.payout)))
          .orderBy(desc(paypalOps.createdAt))
      : [],
    // Advances the next release repays first: the releasing band shows the partner's leg before the freelancer's. The
    // settle job may mark it repaid a moment before the milestone turns released; that is still this release.
    releasableIds.length
      ? db
          .select({ milestoneId: advances.milestoneId, principalMinor: advances.principalMinor, feeBpsPerDay: advances.feeBpsPerDay, offer: advances.offer, fundedAt: advances.fundedAt })
          .from(advances)
          .where(and(inArray(advances.milestoneId, releasableIds), inArray(advances.status, ["funded", "repaid"])))
      : [],
  ]);
  // Held milestones flagged for an operator (a payout or refund went wrong): the latest flag's reason and failure.
  const operatorOf = new Map<string, { reason: string; failure: string | null }>();
  for (const f of flagged) {
    if (!f.milestoneId || operatorOf.has(f.milestoneId)) continue;
    // One wording with the operator queue and the audit log: "Payout to the freelancer failed: receiver is not registered with PayPal."
    operatorOf.set(f.milestoneId, { reason: payoutFailureLine(asRecord(f.detail)) ?? "A payment for this milestone went wrong.", failure: null });
  }
  const byId = new Map(dels.map((d) => [d.id, d]));
  const latest = new Map<string, DeliveryRow>();
  for (const d of dels) {
    const cur = latest.get(d.milestoneId);
    if (!cur || d.receivedAt > cur.receivedAt || (d.receivedAt.getTime() === cur.receivedAt.getTime() && d.id > cur.id)) latest.set(d.milestoneId, d);
  }
  // Milestones that move without anyone on this page acting (the agent, the review window, the client elsewhere, a
  // PayPal webhook, a delivery the worker has not picked up yet): the page polls them and re-renders when one changes.
  const live = new Map([...snapshots].filter(([, s]) => s.live));
  const windowSeconds = reviewWindowSeconds(contract.reviewWindowSeconds);

  const name = (uid: string) => people.find((p) => p.id === uid)?.name ?? ACTOR_NAMES[uid] ?? uid;
  const names = { client: name(contract.clientId), freelancer: name(contract.freelancerId) };
  const now = requestTime();

  // Per milestone: when it was funded and paid out (newest first), the client's decision on the decided delivery, and
  // what an injected delivery said to the reviewer.
  const fundedAt = new Map<string, Date>();
  const releasedAt = new Map<string, Date>();
  const clientSaid = new Map<string, { event: string; actor: string; at: Date; deliveryId: string | null }>();
  const injected = new Map<string, Array<{ source: string; text: string }>>();
  for (const e of moments) {
    if (!e.milestoneId) continue;
    const d = asRecord(e.detail);
    if (e.event === AUDIT_EVENTS.milestoneFunded) {
      if (!fundedAt.has(e.milestoneId)) fundedAt.set(e.milestoneId, e.createdAt);
    } else if (e.event === AUDIT_EVENTS.milestoneReleased || e.event === AUDIT_EVENTS.milestonePartialReleased) {
      if (!releasedAt.has(e.milestoneId)) releasedAt.set(e.milestoneId, e.createdAt);
    } else if (e.event === AUDIT_EVENTS.verdictStored) {
      const dlv = asString(d.deliveryId);
      const hits = Array.isArray(d.injectionHits) ? d.injectionHits.map(asRecord) : [];
      if (dlv && d.suspectedInjection === true && hits.length && !injected.has(dlv)) {
        injected.set(dlv, hits.map((h) => ({ source: asString(h.source) ?? "delivery", text: asString(h.match) ?? "" })).filter((h) => h.text));
      }
    } else if (!clientSaid.has(e.milestoneId)) {
      clientSaid.set(e.milestoneId, { event: e.event, actor: e.actor, at: e.createdAt, deliveryId: asString(d.deliveryId) ?? null });
    }
  }
  const legsOf = new Map<string, ReleaseLeg[]>();
  for (const r of legsRows) {
    const mid = r.account.slice("held:".length);
    const list = legsOf.get(mid) ?? [];
    if (r.ref.startsWith("refund:")) list.push({ to: `Refunded to ${names.client}`, minor: r.amountMinor, tone: "draft" });
    else if (r.ref.endsWith(":partner")) list.push({ to: ACTOR_NAMES.usr_partner ?? "Capital partner", note: "advance repaid", minor: r.amountMinor, tone: "funded" });
    else list.push({ to: names.freelancer, minor: r.amountMinor, tone: "released" });
    legsOf.set(mid, list);
  }
  // PayPal pays the partner's repayment first, then the freelancer; a refund goes back last.
  const legOrder = (l: ReleaseLeg) => (l.note ? 0 : l.tone === "draft" ? 2 : 1);
  for (const list of legsOf.values()) list.sort((a, b) => legOrder(a) - legOrder(b));
  /**
   * What an injected delivery said to the reviewer, as the client should see it: the whole lines of the commit message
   * or delivery text that the detector matched (from evd_commit), else the matched fragments themselves.
   */
  const injectionOf = (deliveryId: string | null | undefined) => {
    const hits = deliveryId ? injected.get(deliveryId) : undefined;
    if (!deliveryId || !hits?.length) return undefined;
    const ev = (byId.get(deliveryId)?.evidence ?? []).map(asRecord).find((e) => e.id === "evd_commit");
    const text = asString(ev?.summary) ?? "";
    const lines = text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !/^(commit message|delivery title|delivery description):?$/i.test(l) && hits.some((h) => l.toLowerCase().includes(h.text.toLowerCase())));
    return lines.length ? [...new Set(lines)].slice(0, 2).map((l) => ({ source: hits[0]?.source ?? "commit message", text: l.replace(/^(delivery title|delivery description):\s*/i, "") })) : hits.slice(0, 3);
  };
  const payoutOf = new Map<string, (typeof payouts)[number]>();
  for (const p of payouts) if (!payoutOf.has(p.key)) payoutOf.set(p.key, p);
  const milestoneLabel = new Map(ms.map((m) => [m.id, `${String(m.seq).padStart(2, "0")} ${m.title}`]));

  /**
   * Where a release about to happen will send the money, in PayPal's order: the capital partner's repayment first (the
   * same advanceRepayment the release job pays), then the freelancer's share. A confirmed partial pays only its share.
   */
  const pendingLegs = (m: (typeof ms)[number]): ReleaseLeg[] => {
    const share = m.clientResponse === "confirm_partial" && m.decision?.amountMinor ? m.decision.amountMinor : m.amountMinor;
    const adv = openAdvances.find((a) => a.milestoneId === m.id);
    const repay = adv ? Math.min(share, advanceRepayment(adv, m.decidedAt).repaymentMinor) : 0;
    const legs: ReleaseLeg[] = [];
    if (repay > 0) legs.push({ to: ACTOR_NAMES.usr_partner ?? "Capital partner", note: "advance repaid", minor: repay, tone: "funded" });
    if (share - repay > 0 || legs.length === 0) legs.push({ to: names.freelancer, minor: share - repay, tone: "released" });
    return legs;
  };
  const paidOf = (m: (typeof ms)[number]) => (m.status === "partial_released" ? (m.decision?.amountMinor ?? 0) : m.amountMinor);
  // One primary per page: the first unfunded milestone's Fund button, only while no other milestone holds money in
  // escrow. A funded milestone waiting on a delivery or a decision is the page's subject; later drafts stay quiet.
  const somethingInEscrow = ms.some((m) => ESCROW_STATES.has(m.status));
  const firstDraftId = somethingInEscrow ? null : (ms.find((m) => m.status === "draft")?.id ?? null);
  const escrow = ms.filter((m) => ESCROW_STATES.has(m.status)).reduce((s, m) => s + m.amountMinor, 0);
  const paid = ms.filter((m) => PAID_STATES.has(m.status)).reduce((s, m) => s + paidOf(m), 0);
  const unfunded = ms.filter((m) => m.status === "draft").reduce((s, m) => s + m.amountMinor, 0);
  const releasedCount = ms.filter((m) => PAID_STATES.has(m.status)).length;

  const myApproval = actor.role === "client" ? contract.clientApprovedAt : actor.role === "freelancer" ? contract.freelancerApprovedAt : null;
  const isParty = isContractClient(actor, contract) || isContractFreelancer(actor, contract);
  const cur = contract.currency;
  const { clientApprovedAt: ca, freelancerApprovedAt: fa } = contract;
  // Both signatures, dated by the later one: the moment funding opened.
  const signedAt = ca && fa ? (ca > fa ? ca : fa) : null;
  const signed = signedAt !== null;

  return (
    <main>
      {live.size > 0 ? <LiveRefresh initial={[...live.values()]} /> : null}
      <Link
        href="/"
        className="group inline-flex items-center gap-2 font-mono text-[11px] tracking-[0.12em] text-fg-faint uppercase transition-colors duration-200 hover:text-fg"
      >
        <svg aria-hidden viewBox="0 0 20 8" className="h-2 w-5 transition-transform duration-200 ease-glide group-hover:-translate-x-0.5" fill="none" stroke="currentColor" strokeWidth="1.2">
          <path d="M20 4 H2 M5 1 L2 4 L5 7" />
        </svg>
        Ledger
      </Link>

      <PageHeader
        className="mt-6"
        eyebrow={
          <>
            Contract <span className="tabular normal-case">{contract.id}</span> <span className="text-hairline-strong">/</span> opened{" "}
            {formatDate(contract.createdAt)}
          </>
        }
        title={contract.title}
        description={
          <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
            <StatePill state={contract.status} />
            <span className="text-fg">{names.client}</span>
            <svg aria-label="pays" viewBox="0 0 20 8" className="h-2 w-5 text-fg-faint" fill="none" stroke="currentColor" strokeWidth="1.2">
              <path d="M0 4 H18 M15 1 L18 4 L15 7" />
            </svg>
            <span className="text-fg">{names.freelancer}</span>
            {contract.repoFullName ? <span className="font-mono text-[12.5px] text-fg-faint">{contract.repoFullName}</span> : null}
            {signed ? (
              <span data-tone="funded" className="inline-flex items-center gap-1.5 font-mono text-[11px] tracking-[0.06em] text-fg-faint uppercase tabular">
                <StateGlyph glyph="check" className="size-[9px] text-tone" />
                signed by both · {formatDate(signedAt)}
              </span>
            ) : null}
          </span>
        }
      />
      {contract.scopeText ? <p className="mt-4 max-w-[68ch] text-[14.5px] leading-relaxed whitespace-pre-wrap text-fg-muted">{contract.scopeText}</p> : null}

      {/* The instrument row: what the contract is worth and where that money is now, then one bar segment per milestone. */}
      <section aria-label="Money" className="mt-10 border-t border-hairline pt-6">
        <div className="grid grid-cols-2 gap-x-6 gap-y-6 md:grid-cols-3 md:gap-x-0 md:divide-x md:divide-hairline">
          <Stat
            label="Contract value"
            minor={contract.totalMinor}
            currency={cur}
            hint={unfunded > 0 ? `${formatMoney(unfunded, cur)} not funded yet` : `${ms.length} milestone${ms.length === 1 ? "" : "s"}, all funded`}
            className="col-span-2 md:col-span-1 md:pr-8"
          />
          <Stat label="In escrow" tone="funded" minor={escrow} currency={cur} hint="held by Milestone" className="md:px-8" />
          <Stat label="Released" tone="released" minor={paid} currency={cur} hint={`${releasedCount} of ${ms.length} paid out`} className="md:pl-8" />
        </div>
        <MoneyBar items={ms.map((m) => ({ state: m.status, minor: m.amountMinor }))} className="mt-6" />
      </section>

      {/* Signatures only take a row while one is missing: that is when they block funding. */}
      {signed ? null : (
        <div className="mt-6">
          <ApprovalStrip
            contractId={contract.id}
            client={{ role: "client", name: names.client, at: contract.clientApprovedAt }}
            freelancer={{ role: "freelancer", name: names.freelancer, at: contract.freelancerApprovedAt }}
            canApproveAs={isParty && !myApproval ? actor.role : null}
            isParty={isParty}
          />
        </div>
      )}

      <section className="mt-14" aria-labelledby="rail-title">
        <SectionTitle
          eyebrow="The rail"
          title={<span id="rail-title">Milestones</span>}
          actions={<p className="font-mono text-[11px] text-fg-faint tabular">{releasedCount} of {ms.length} released</p>}
        />
        {ms.length === 0 ? (
          <EmptyState title="No milestones" body="This contract has no milestones to fund." />
        ) : (
          <Rail label={`${contract.title}: milestones`} className="mt-6">
            <RailCap
              at="start"
              tone="funded"
              reached={signed}
              line={ms[0] && ms[0].status !== "draft" && ms[0].status !== "held" && ms[0].status !== "needs_client" ? "solid" : "dashed"}
              label={signed ? `Escrow opened by ${names.client}` : "Escrow opens when both sign"}
              detail={signedAt ? formatDate(signedAt) : null}
            />
            {ms.map((m) => {
              const d = latest.get(m.id) ?? null;
              const snap = snapshots.get(m.id) ?? null;
              const released = releasedAt.get(m.id);
              const freshRelease = released !== undefined && now - released.getTime() < FRESH_MS;
              const freshFund = m.status === "funded" && (fundedAt.get(m.id)?.getTime() ?? 0) > now - FRESH_MS;
              const said = clientSaid.get(m.id);
              const decidedFor = decisionDeliveryId(m.decision);
              const countersign =
                said && CLIENT_VERB[said.event] && (said.deliveryId === null || said.deliveryId === decidedFor)
                  ? `${CLIENT_VERB[said.event]} by ${(ACTOR_NAMES[said.actor] ?? name(said.actor)).split(" ")[0]} · ${auditTime(said.at).slice(0, 12)}`
                  : null;
              const payout = payoutOf.get(m.id);
              const thisPaid = (legsOf.get(m.id) ?? []).filter((l) => l.tone !== "draft").reduce((sum, l) => sum + l.minor, 0) || paidOf(m);
              const release: ReleaseView | null = PAID_STATES.has(m.status)
                ? {
                    legs: legsOf.get(m.id) ?? [],
                    fresh: freshRelease,
                    contractTotal: { before: Math.max(0, paid - thisPaid), after: paid },
                    reference: payout ? `payout ${payout.paypalId ?? payout.requestId}` : null,
                    playKey: `release:${m.id}@${released?.getTime() ?? 0}`,
                  }
                : null;
              // Releasing: the client approved (or confirmed a share) and the release job has not booked it yet, or the
              // payout is with PayPal waiting for its webhook. The station says so instead of offering the choices again.
              const approved = m.clientResponse === "approve" || m.clientResponse === "confirm_partial";
              const releasing =
                RELEASABLE_STATUSES.has(m.status) && (snap?.pendingOp?.kind === OP_KINDS.payout || approved)
                  ? { reference: payout ? `payout ${payout.paypalId ?? payout.requestId}` : null, legs: pendingLegs(m) }
                  : null;

              const station = (view?: "verifying") => {
                const status = view ?? m.status;
                const meta = stateMeta(status);
                const phase = phaseOf(status);
                const side = status === "held" || status === "needs_client";
                return (
                  <Station
                    key={`${m.id}-${status}`}
                    id={m.id}
                    tone={toneOf(status)}
                    phase={phase}
                    branch={side}
                    connect={!side}
                    marker={phase === "upcoming" ? String(m.seq).padStart(2, "0") : undefined}
                    glyph={meta.glyph}
                    connectorOverlay={
                      PAID_STATES.has(status) ? <ConnectorFill playKey={`release:${m.id}@${released?.getTime() ?? 0}`} fresh={freshRelease} delay={0.6} /> : freshFund && !view ? <ConnectorFill playKey={`fund:${m.id}@${fundedAt.get(m.id)?.getTime() ?? 0}`} fresh /> : null
                    }
                    title={m.title}
                    meta={
                      <>
                        <span className="font-mono text-[11px] text-fg-faint tabular">
                          {String(m.seq).padStart(2, "0")}
                          {m.dueAt ? ` · due ${formatDate(m.dueAt)}` : ""}
                        </span>
                        <span>{meta.money}</span>
                        {m.advanceEligible && status === "funded" ? <span className="type-label text-[10px] text-fg-faint">advance eligible</span> : null}
                      </>
                    }
                    aside={
                      <>
                        <StatePill state={status} size="md" />
                        <Money minor={m.amountMinor} currency={cur} size="m" animate tone={phase === "upcoming" ? undefined : toneOf(status)} />
                      </>
                    }
                  >
                    <MilestoneActions
                      milestone={m}
                      contract={contract}
                      actor={actor}
                      crit={crit.filter((c) => c.milestoneId === m.id)}
                      delivery={d}
                      decided={byId.get(decidedFor ?? "") ?? null}
                      windowSeconds={windowSeconds}
                      live={snap}
                      operator={operatorOf.get(m.id) ?? null}
                      names={names}
                      view={view}
                      firstDraft={m.id === firstDraftId}
                      release={release}
                      releasing={releasing}
                      countersign={countersign}
                      injection={injectionOf(decidedFor ?? d?.id)}
                    />
                  </Station>
                );
              };

              // The verifying beat, keyed on the delivery: on screen from the moment a delivery is in until its checks
              // have played (VerifyGate), even when the verdict landed faster than the page could poll.
              const flagged = operatorOf.has(m.id);
              const checking = d !== null && !flagged && (m.status === "verifying" || ((m.status === "funded" || m.status === "held") && awaitingVerdict(d, now)));
              const justVerified = d !== null && d.verifiedAt !== null && VERDICT_STATUSES.has(m.status) && now - d.verifiedAt.getTime() < RECENT_VERDICT_MS && !flagged;
              if (d && checking) return <VerifyGate key={m.id} runKey={runKeyOf(d)} settled={false} verifying={station("verifying")} />;
              if (d && justVerified)
                return (
                  <VerifyGate key={m.id} runKey={runKeyOf(d)} settled verifying={station("verifying")}>
                    {station()}
                  </VerifyGate>
                );
              return station();
            })}
            <RailCap
              at="end"
              tone="released"
              reached={releasedCount === ms.length}
              label={`Paid out to ${names.freelancer}`}
              detail={
                <>
                  {formatMoney(paid, cur)} <span className="text-fg-faint">of {formatMoney(contract.totalMinor, cur)}</span>
                </>
              }
            />
          </Rail>
        )}
      </section>

      <section className="mt-16" aria-labelledby="activity-title">
        <SectionTitle
          eyebrow="Audit trail"
          title={<span id="activity-title">Activity</span>}
          actions={
            <>
              <Button href={`/contracts/${id}/ledger`} variant="ghost" size="sm">
                Ledger
                <svg aria-hidden viewBox="0 0 20 8" className="h-2 w-4" fill="none" stroke="currentColor" strokeWidth="1.2">
                  <path d="M0 4 H18 M15 1 L18 4 L15 7" />
                </svg>
              </Button>
              <Button href={`/contracts/${id}/activity`} variant="ghost" size="sm">
                Full audit log
                <svg aria-hidden viewBox="0 0 20 8" className="h-2 w-4" fill="none" stroke="currentColor" strokeWidth="1.2">
                  <path d="M0 4 H18 M15 1 L18 4 L15 7" />
                </svg>
              </Button>
            </>
          }
        />
        {activity.length === 0 ? (
          <EmptyState title="Nothing yet" body="Approvals, funding, verdicts and PayPal calls on this contract appear here." />
        ) : (
          <Panel variant="solid" padded={false}>
            <div className="hidden grid-cols-[150px_minmax(0,1fr)_minmax(0,240px)_150px] gap-x-4 border-b border-hairline px-5 py-2.5 md:grid">
              <p className="type-label text-fg-faint">Time (UTC)</p>
              <p className="type-label text-fg-faint">Event</p>
              <p className="type-label text-fg-faint">Milestone</p>
              <p className="type-label text-right text-fg-faint">Actor</p>
            </div>
            <ActivityLedger
              items={activity.map((a) => ({
                id: a.id,
                at: a.createdAt,
                event: a.event,
                milestone: a.milestoneId ? (milestoneLabel.get(a.milestoneId) ?? a.milestoneId) : null,
                actor: ACTOR_NAMES[a.actor] ?? SYSTEM_ACTOR_NAMES[a.actor] ?? a.actor,
              }))}
            />
          </Panel>
        )}
      </section>
    </main>
  );
}

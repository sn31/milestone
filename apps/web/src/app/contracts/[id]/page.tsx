import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";
import { and, desc, eq, inArray, or } from "drizzle-orm";
import { AUDIT_EVENTS, RELEASABLE_STATUSES, asRecord, asString, decisionDeliveryId, deliveries, reviewWindowSeconds } from "@milestone/core";
import { getDb } from "@/lib/db";
import { ACTOR_NAMES, getActor, isContractClient, isContractFreelancer } from "@/lib/session";
import { formatDate, formatMoney } from "@/lib/format";
import { MilestoneActions } from "@/components/milestone-actions";
import { LiveRefresh } from "@/components/live-refresh";
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
  const [people, crit, dels, snapshots, flagged] = await Promise.all([
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
  ]);
  // Held milestones flagged for an operator (a payout or refund went wrong): the latest flag's reason and failure.
  const operatorOf = new Map<string, { reason: string; failure: string | null }>();
  for (const f of flagged) {
    if (!f.milestoneId || operatorOf.has(f.milestoneId)) continue;
    const d = asRecord(f.detail);
    const failed = Object.values(asRecord(d.failed)).filter((v): v is string => typeof v === "string");
    operatorOf.set(f.milestoneId, { reason: asString(d.reason) ?? "A payment for this milestone went wrong", failure: failed.length ? failed.join("; ") : null });
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
  const milestoneLabel = new Map(ms.map((m) => [m.id, `${String(m.seq).padStart(2, "0")} ${m.title}`]));

  const paidOf = (m: (typeof ms)[number]) => (m.status === "partial_released" ? (m.decision?.amountMinor ?? 0) : m.amountMinor);
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
              const meta = stateMeta(m.status);
              const phase = phaseOf(m.status);
              const side = m.status === "held" || m.status === "needs_client";
              return (
                <Station
                  key={m.id}
                  tone={toneOf(m.status)}
                  phase={phase}
                  branch={side}
                  connect={!side}
                  marker={phase === "upcoming" ? String(m.seq).padStart(2, "0") : undefined}
                  glyph={meta.glyph}
                  transit={PAID_STATES.has(m.status) ? { delay: 0.9 } : undefined}
                  title={m.title}
                  meta={
                    <>
                      <span className="font-mono text-[11px] text-fg-faint tabular">
                        {String(m.seq).padStart(2, "0")} · {m.dueAt ? `due ${formatDate(m.dueAt)}` : "no due date"}
                      </span>
                      <span>{meta.money}</span>
                      {m.advanceEligible && m.status === "funded" ? <span className="type-label text-[10px] text-fg-faint">advance eligible</span> : null}
                    </>
                  }
                  aside={
                    <>
                      <StatePill state={m.status} size="md" />
                      <Money minor={m.amountMinor} currency={cur} size="m" animate tone={phase === "upcoming" ? undefined : toneOf(m.status)} />
                    </>
                  }
                >
                  <MilestoneActions
                    milestone={m}
                    contract={contract}
                    actor={actor}
                    crit={crit.filter((c) => c.milestoneId === m.id)}
                    delivery={latest.get(m.id) ?? null}
                    decided={byId.get(decisionDeliveryId(m.decision) ?? "") ?? null}
                    windowSeconds={windowSeconds}
                    live={live.get(m.id) ?? null}
                    operator={operatorOf.get(m.id) ?? null}
                    names={names}
                  />
                </Station>
              );
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
                actor: ACTOR_NAMES[a.actor] ?? a.actor,
              }))}
            />
          </Panel>
        )}
      </section>
    </main>
  );
}

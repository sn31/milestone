import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/lib/db";
import { ACTOR_NAMES, getActor } from "@/lib/session";
import { formatDate, formatMoney } from "@/lib/format";
import { MilestoneActions, type MilestoneEvent } from "@/components/milestone-actions";
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

export async function generateMetadata({ params }: PageProps<"/contracts/[id]">): Promise<Metadata> {
  const { id } = await params;
  const contract = await getDb().query.contracts.findFirst({ columns: { title: true }, where: (t, { eq }) => eq(t.id, id) });
  return { title: contract?.title ?? "Contract not found" };
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
  const contract = await db.query.contracts.findFirst({ where: (t, { eq }) => eq(t.id, id) });
  if (!contract) notFound();
  const actor = await getActor();
  const [ms, people, activity] = await Promise.all([
    db.query.milestones.findMany({ where: (t, { eq }) => eq(t.contractId, id), orderBy: (t, { asc }) => [asc(t.seq)] }),
    db.query.users.findMany({ columns: { id: true, name: true }, where: (t, { inArray }) => inArray(t.id, [contract.clientId, contract.freelancerId]) }),
    db.query.auditLog.findMany({ where: (t, { eq }) => eq(t.contractId, id), orderBy: (t, { desc }) => [desc(t.createdAt)], limit: 12 }),
  ]);
  const ids = ms.map((m) => m.id);
  const verifyingIds = ms.filter((m) => m.status === "verifying").map((m) => m.id);
  const [crit, dels, verifyEvents] = await Promise.all([
    ids.length ? db.query.criteria.findMany({ where: (t, { inArray }) => inArray(t.milestoneId, ids) }) : [],
    ids.length ? db.query.deliveries.findMany({ where: (t, { inArray }) => inArray(t.milestoneId, ids), orderBy: (t, { desc }) => [desc(t.receivedAt)] }) : [],
    verifyingIds.length
      ? db.query.auditLog.findMany({ where: (t, { inArray }) => inArray(t.milestoneId, verifyingIds), orderBy: (t, { asc }) => [asc(t.createdAt)], limit: 200 })
      : [],
  ]);

  const name = (uid: string) => people.find((p) => p.id === uid)?.name ?? ACTOR_NAMES[uid] ?? uid;
  const names = { client: name(contract.clientId), freelancer: name(contract.freelancerId) };
  const latest = new Map<string, (typeof dels)[number]>();
  for (const d of dels) if (!latest.has(d.milestoneId)) latest.set(d.milestoneId, d);
  const eventsOf = (mid: string): MilestoneEvent[] => verifyEvents.filter((e) => e.milestoneId === mid).map((e) => ({ at: e.createdAt, event: e.event }));
  const milestoneLabel = new Map(ms.map((m) => [m.id, `${String(m.seq).padStart(2, "0")} ${m.title}`]));

  const paidOf = (m: (typeof ms)[number]) => (m.status === "partial_released" ? (m.decision?.amountMinor ?? 0) : m.amountMinor);
  const escrow = ms.filter((m) => ESCROW_STATES.has(m.status)).reduce((s, m) => s + m.amountMinor, 0);
  const paid = ms.filter((m) => PAID_STATES.has(m.status)).reduce((s, m) => s + paidOf(m), 0);
  const unfunded = ms.filter((m) => m.status === "draft").reduce((s, m) => s + m.amountMinor, 0);
  const releasedCount = ms.filter((m) => PAID_STATES.has(m.status)).length;

  const myApproval = actor.role === "client" ? contract.clientApprovedAt : actor.role === "freelancer" ? contract.freelancerApprovedAt : null;
  const isParty =
    (actor.role === "client" && actor.userId === contract.clientId) || (actor.role === "freelancer" && actor.userId === contract.freelancerId);
  const cur = contract.currency;
  const { clientApprovedAt: ca, freelancerApprovedAt: fa } = contract;
  // Both signatures, dated by the later one: the moment funding opened.
  const signedAt = ca && fa ? (ca > fa ? ca : fa) : null;
  const signed = signedAt !== null;

  return (
    <main>
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
                    events={eventsOf(m.id)}
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

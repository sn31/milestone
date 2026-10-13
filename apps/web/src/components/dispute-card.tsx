import Link from "next/link";
import type { ReactNode } from "react";
import { decisionDeliveryId } from "@milestone/core";
import type { EvidencePack } from "@milestone/verify";
import { DisputeResponse } from "@/app/disputes/_components/dispute-response";
import { MoneyText, ResponseText } from "@/app/disputes/_components/response-text";
import { isOpen, reasonLabel, type Attachment, type DisputeView } from "@/app/disputes/_lib";
import { VerdictView, type VerdictDelivery } from "@/components/verdict-view";
import { accountLabel, refLabel } from "@/components/ledger-labels";
import { auditTime, eventGlyph, eventTone } from "@/lib/events";
import { getDb } from "@/lib/db";
import { formatDate, formatMoney } from "@/lib/format";
import { Eyebrow, Hash, Money, Panel, StateGlyph, StatePill, cx, type GlyphKey, type ToneKey } from "@/components/ui";

export interface DisputeCardProps {
  dispute: DisputeView;
  /** `status` is looked up when left out: accepting the claim depends on it. */
  milestone: {
    id: string;
    seq: number;
    title: string;
    amountMinor: number;
    status?: string;
  };
  contract: {
    id: string;
    title: string;
    currency: string;
    clientId: string;
    freelancerId: string;
  };
  /** The viewer is the contract's freelancer (the only party who responds to PayPal). */
  isFreelancer: boolean;
  /** Which delivered files would go to PayPal with the response. */
  attachments: Attachment[];
  names: Record<string, string>;
}

// DESIGN: a dispute has no state of its own in STATE_META. Waiting on the freelancer reads in the needs tone (someone
// must answer, nothing is stopped), with PayPal in the review tone (a third party is reviewing), a won one in released,
// a lost or conceded one in danger. The held glyph and amber stay with held money: a disputed payout is not held.
const STATUS: Record<DisputeView["status"], { state: string; label: string; tone: ToneKey }> = {
  drafting: { state: "needs_client", label: "Compiling pack", tone: "needs" },
  awaiting_response: {
    state: "needs_client",
    label: "Response due",
    tone: "needs",
  },
  submitted: { state: "review", label: "With PayPal", tone: "review" },
  accepted: { state: "failed", label: "Claim accepted", tone: "danger" },
  won: { state: "released", label: "Won", tone: "released" },
  lost: { state: "failed", label: "Refunded to buyer", tone: "danger" },
  resolved: { state: "closed", label: "Resolved", tone: "neutral" },
};

/** A hover/click target for the response's citation chips: lit while its chip is pointed at, flashed when clicked. */
const citeRow = "transition-colors duration-200 data-hl:bg-surface-raised data-hl:[box-shadow:inset_2px_0_0_var(--focus)]";

function Fold({ label, count, open = false, children }: { label: string; count: number; open?: boolean; children: ReactNode }) {
  return (
    <details className="group/fold" open={open}>
      <summary className="inline-flex cursor-pointer list-none items-center gap-2 rounded-control py-1 font-mono text-[11px] tracking-[0.1em] text-fg-muted uppercase transition-colors duration-200 hover:text-fg [&::-webkit-details-marker]:hidden">
        <svg
          aria-hidden
          viewBox="0 0 10 10"
          className="size-2.5 transition-transform duration-200 ease-glide group-open/fold:rotate-90"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        >
          <path d="M3.5 2 L7 5 L3.5 8" />
        </svg>
        {label}
        <span className="text-fg-faint tabular">{count}</span>
      </summary>
      <div className="mt-2 overflow-hidden rounded-control border border-hairline bg-surface-sunken">{children}</div>
    </details>
  );
}

const Cite = ({ id }: { id: string }) => <span className="w-7 shrink-0 font-mono text-[11px] text-fg-faint tabular">{id}</span>;

/** The case's own rail: opened, pack compiled, answered, decided. Done steps in ink, the current one in the case tone. */
function CaseRail({ dispute, tone, you }: { dispute: DisputeView; tone: ToneKey; you: boolean }) {
  const s = dispute.status;
  const answered = dispute.submitted ?? dispute.accepted;
  const decided =
    s === "won"
      ? "Found for the seller"
      : s === "lost"
        ? "Refunded to the buyer"
        : s === "resolved"
          ? "Resolved"
          : s === "accepted"
            ? "Refund under way"
            : "PayPal decides";
  const steps: Array<{
    label: string;
    at: string | null;
    phase: "done" | "current" | "upcoming";
    glyph: GlyphKey;
  }> = [
    {
      label: "Opened by the buyer",
      at: dispute.openedAt,
      phase: "done",
      glyph: "check",
    },
    {
      label: "Evidence pack compiled",
      at: dispute.drafted?.at ?? null,
      phase: dispute.drafted ? "done" : "current",
      glyph: dispute.drafted ? "check" : "pulse",
    },
    {
      label: dispute.accepted ? "Claim accepted" : dispute.submitted ? "Response sent" : you ? "You respond" : "Freelancer responds",
      at: answered?.at ?? null,
      phase: answered ? "done" : dispute.drafted ? "current" : "upcoming",
      glyph: answered ? (dispute.accepted ? "cross" : "check") : dispute.drafted ? "query" : "ring",
    },
    {
      label: decided,
      at: dispute.resolved?.at ?? null,
      phase: dispute.resolved ? "done" : answered ? "current" : "upcoming",
      glyph: dispute.resolved ? (s === "won" ? "check" : s === "lost" ? "cross" : "check") : answered ? "arc" : "ring",
    },
  ];
  return (
    <ol aria-label="Case progress" className="grid grid-cols-4 border-b border-hairline">
      {steps.map((st, i) => (
        <li
          key={st.label}
          data-tone={st.phase === "current" || (st.phase === "done" && i === 3) ? tone : undefined}
          className={cx("relative min-w-0 px-2 py-3 first:pl-4 sm:px-4 sm:first:pl-6", i < 3 && "border-r border-hairline")}
          aria-current={st.phase === "current" ? "step" : undefined}
        >
          <div className="flex items-center gap-2">
            <span
              className={cx(
                "grid size-4 shrink-0 place-items-center rounded-full border",
                st.phase === "current"
                  ? "glow-tone border-tone bg-tone-soft text-tone"
                  : st.phase === "done"
                    ? i === 3
                      ? "border-tone text-tone"
                      : "border-hairline-strong text-fg-muted"
                    : "border-hairline text-fg-faint",
              )}
            >
              <StateGlyph glyph={st.glyph} className="size-2" />
            </span>
            <span
              className={cx(
                "min-w-0 truncate text-[12.5px] max-sm:hidden",
                st.phase === "upcoming" ? "text-fg-faint" : st.phase === "current" ? "text-fg" : "text-fg-muted",
              )}
            >
              {st.label}
            </span>
          </div>
          <p className={cx("mt-1.5 text-[11.5px] leading-snug sm:hidden", st.phase === "upcoming" ? "text-fg-faint" : "text-fg-muted")}>{st.label}</p>
          <p className="mt-1 font-mono text-[10.5px] text-fg-faint tabular sm:pl-6">{st.at ? auditTime(st.at) : st.phase === "current" ? "now" : " "}</p>
        </li>
      ))}
    </ol>
  );
}

/** The milestone's record up to the dispute, one cited line per event: the case's story. */
function Timeline({ pack, names }: { pack: EvidencePack; names: Record<string, string> }) {
  return (
    <Fold label="Timeline" count={pack.timeline.length} open>
      <ol className="divide-y divide-hairline">
        {pack.timeline.map((t) => (
          <li key={t.cite} data-cite={t.cite} className={cx("flex items-baseline gap-3 px-3 py-2", citeRow)}>
            <Cite id={t.cite} />
            <span data-tone={eventTone(t.event)} className="translate-y-[1px]">
              <StateGlyph glyph={eventGlyph(t.event)} className="text-tone" />
            </span>
            <p className="min-w-0 flex-1 text-[13px] leading-snug text-fg">
              <MoneyText text={t.summary} />
              <span className="ml-2 text-[12px] text-fg-faint">{names[t.actor] ?? t.actor}</span>
            </p>
            <span className="shrink-0 font-mono text-[11px] text-fg-faint tabular max-sm:hidden">{auditTime(t.at)}</span>
          </li>
        ))}
      </ol>
    </Fold>
  );
}

/** The pack as a case file: the money in four figures, the receipt folded, the timeline open, the rest one click away. */
function PackView({ pack, names, receipt, withTimeline }: { pack: EvidencePack; names: Record<string, string>; receipt: ReactNode; withTimeline: boolean }) {
  const currency = pack.milestone.currency;
  const f = pack.facts;
  const paid = f.paidToFreelancerMinor + f.paidToPartnerMinor;
  const clientLine = f.clientApproved
    ? "Approved the release"
    : f.clientVetoed
      ? "Stopped the release"
      : f.reviewEndsAt
        ? "Let the review window pass"
        : "No recorded action";
  const funding = pack.ledger.filter((l) => l.direction === "credit" && l.account.startsWith("held:")).map((l) => l.cite);
  const payouts = pack.ledger.filter((l) => l.direction === "credit" && /^(freelancer|partner):/.test(l.account)).map((l) => l.cite);
  return (
    <div className="grid grid-cols-1 gap-5">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-4 border-b border-hairline pb-5 sm:grid-cols-4">
        <div data-cite={funding.join(" ")} className={cx("min-w-0 rounded-chip px-1.5 py-1 -mx-1.5", citeRow)}>
          <dt className="type-label text-fg-faint">Funded</dt>
          <dd className="mt-1.5">
            <Money minor={f.fundedMinor} currency={currency} tone="funded" />
          </dd>
          <dd className="mt-0.5 font-mono text-[11px] text-fg-faint tabular">{f.fundedAt ? formatDate(f.fundedAt) : "not recorded"}</dd>
        </div>
        <div data-cite={payouts.join(" ")} className={cx("min-w-0 rounded-chip px-1.5 py-1 -mx-1.5", citeRow)}>
          <dt className="type-label text-fg-faint">Paid out</dt>
          <dd className="mt-1.5">
            <Money minor={paid} currency={currency} tone={f.released ? "released" : undefined} />
          </dd>
          <dd
            className="mt-0.5 truncate font-mono text-[11px] text-fg-faint tabular"
            title={
              f.paidToPartnerMinor > 0
                ? `${formatMoney(f.paidToFreelancerMinor, currency)} to the freelancer, ${formatMoney(f.paidToPartnerMinor, currency)} to the capital partner`
                : undefined
            }
          >
            {f.paidToPartnerMinor > 0 ? `partner ${formatMoney(f.paidToPartnerMinor, currency)}` : f.releasedAt ? formatDate(f.releasedAt) : "not paid"}
          </dd>
        </div>
        <div className="min-w-0 py-1">
          <dt className="type-label text-fg-faint">Criteria</dt>
          <dd className="type-num-s mt-1.5 text-fg">
            {f.criteriaPassed}
            <span className="text-fg-faint"> / {f.criteriaTotal}</span>
          </dd>
          <dd className="mt-0.5 font-mono text-[11px] text-fg-faint tabular">
            {f.requiredPassed} of {f.requiredTotal} required
          </dd>
        </div>
        <div className="min-w-0 py-1">
          <dt className="type-label text-fg-faint">Client</dt>
          <dd className="mt-1.5 text-[13px] leading-snug text-fg">{clientLine}</dd>
        </div>
      </dl>

      {receipt}

      {withTimeline ? <Timeline pack={pack} names={names} /> : null}
      <div className="grid grid-cols-1 gap-2">
        <Fold label="Ledger" count={pack.ledger.length} open={!withTimeline}>
          <ol className="divide-y divide-hairline">
            {pack.ledger.map((l) => {
              const a = accountLabel(l.account);
              return (
                <li key={l.cite} data-cite={l.cite} className={cx("flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-3 py-2", citeRow)}>
                  <Cite id={l.cite} />
                  <span className="min-w-0 flex-1 truncate font-mono text-[12px]" title={l.account}>
                    <span className="text-fg">{a.family}</span>
                    {a.rest ? <span className="text-fg-faint"> · {a.rest}</span> : null}
                  </span>
                  <span className="w-[4ch] font-mono text-[10.5px] text-fg-faint uppercase">{l.direction === "debit" ? "dr" : "cr"}</span>
                  <Money minor={l.amountMinor} currency={l.currency} />
                  <span className="basis-full truncate pl-10 font-mono text-[11px] text-fg-faint tabular" title={l.ref}>
                    {auditTime(l.at)} · {refLabel(l.ref)}
                  </span>
                </li>
              );
            })}
          </ol>
        </Fold>
        <Fold label="Client's own actions" count={pack.clientActions.length}>
          {pack.clientActions.length ? (
            <ol className="divide-y divide-hairline">
              {pack.clientActions.map((a) => (
                <li key={a.cite} className="flex gap-3 px-3 py-2">
                  <Cite id={a.cite} />
                  <p className="min-w-0 text-[13px] text-fg">
                    {a.summary}
                    <span className="ml-2 font-mono text-[11px] text-fg-faint tabular">{auditTime(a.at)}</span>
                  </p>
                </li>
              ))}
            </ol>
          ) : (
            <p className="px-3 py-2 text-[13px] text-fg-muted">The client took no recorded action on this milestone.</p>
          )}
        </Fold>
        <Fold label="Delivered files" count={pack.files.length}>
          {pack.files.length ? (
            <ul className="divide-y divide-hairline">
              {pack.files.map((file) => (
                <li key={file.cite} data-cite={file.cite} className={cx("flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2", citeRow)}>
                  <Cite id={file.cite} />
                  <span className="min-w-0 truncate text-[13px] text-fg">{file.name}</span>
                  <span className="font-mono text-[11px] text-fg-faint">
                    {file.origin === "repo" ? "in repository" : file.size !== null ? `${Math.max(1, Math.ceil(file.size / 1024))} KB` : ""}
                  </span>
                  {file.sha256 ? <Hash value={file.sha256} label="sha256" head={8} tail={4} className="sm:ml-auto" /> : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-3 py-2 text-[13px] text-fg-muted">No files on record for this delivery.</p>
          )}
        </Fold>
      </div>
    </div>
  );
}

function Sent({ dispute, names }: { dispute: DisputeView; names: Record<string, string> }) {
  const s = dispute.submitted;
  if (!s) return null;
  return (
    <div className="overflow-hidden rounded-panel border border-hairline bg-paper">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-dashed border-hairline-strong px-4 py-3 sm:px-5">
        <span className="type-label text-fg-muted">Sent to PayPal</span>
        <span className="font-mono text-[11px] text-fg-faint tabular">
          {auditTime(s.at)} UTC · {names[s.actor] ?? s.actor}
          {s.documents.length ? ` · ${s.documents.length} file${s.documents.length === 1 ? "" : "s"}` : ""}
        </span>
      </div>
      <ResponseText text={s.text} className="px-4 py-4 sm:px-5 sm:py-5" />
    </div>
  );
}

function Outcome({ dispute, amount, buyer }: { dispute: DisputeView; amount: ReactNode; buyer: string }) {
  const status = dispute.status;
  if (status !== "won" && status !== "lost" && status !== "resolved" && status !== "accepted" && status !== "submitted") return null;
  const meta = STATUS[status];
  const line: ReactNode =
    status === "won" ? (
      "PayPal found for the seller. The payout stands."
    ) : status === "lost" ? (
      <>PayPal found for the buyer and refunded {amount} to {buyer}.</>
    ) : status === "accepted" ? (
      <>Claim accepted. PayPal is refunding {amount} to {buyer}.</>
    ) : (
      "PayPal is reviewing the evidence. Both parties hear the outcome here."
    );
  return (
    <div data-tone={meta.tone} className="rounded-control border border-tone bg-tone-soft px-4 py-3">
      <p className="flex items-baseline gap-2 text-[14px] text-fg">
        <StateGlyph glyph={status === "won" ? "check" : status === "submitted" ? "arc" : status === "resolved" ? "check" : "cross"} className="text-tone" />
        <span className="min-w-0">
          {status === "resolved" ? `Resolved: ${(dispute.resolved?.outcome ?? "no outcome given").toLowerCase().replace(/_/g, " ")}.` : line}
        </span>
      </p>
      {dispute.resolved ? <p className="mt-1 pl-[18px] font-mono text-[11px] text-fg-faint tabular">{auditTime(dispute.resolved.at)} UTC · PayPal</p> : null}
    </div>
  );
}

/** For the client while the freelancer answers: what happens next, and what each ending means for their money. */
function WhatNext({ freelancer, amount, drafted }: { freelancer: string; amount: ReactNode; drafted: boolean }) {
  const steps: ReactNode[] = [
    drafted
      ? `${freelancer} is answering from this pack. The draft stays private until it is sent.`
      : "Milestone is compiling the evidence pack from the milestone's record.",
    `${freelancer} either sends evidence to PayPal or accepts your claim.`,
    <>If the claim is accepted or PayPal finds for you, PayPal refunds {amount} to your account.</>,
    "If PayPal finds for the seller, the payout stands.",
  ];
  return (
    <div className="grid gap-4">
      <p data-tone="needs" className="flex items-baseline gap-2.5 text-[14px] leading-relaxed text-fg">
        <StateGlyph glyph="query" className="translate-y-[1px] text-tone" />
        <span className="min-w-0">Waiting for {freelancer} to respond.</span>
      </p>
      <ol className="grid gap-3 border-l border-hairline pl-4">
        {steps.map((s, i) => (
          <li key={i} className="flex gap-3 text-[13px] leading-relaxed text-fg-muted">
            <span className="font-mono text-[11px] text-fg-faint tabular">{String(i + 1).padStart(2, "0")}</span>
            <span className="min-w-0">{s}</span>
          </li>
        ))}
      </ol>
      <p className="font-mono text-[11px] text-fg-faint">Nothing on this page moves money. PayPal decides the dispute; Milestone supplies the record.</p>
    </div>
  );
}

/**
 * The accept route only takes a claim once the milestone's money has left escrow (released or partial_released);
 * before that it answers 409 milestone_not_final and an operator settles the refund.
 */
export function canAcceptClaim(status: string | null | undefined): boolean {
  return status === "released" || status === "partial_released";
}

/** "10 days left", "due today", "overdue". */
function dueIn(dueAt: string): string {
  const days = Math.ceil((new Date(dueAt).getTime() - Date.now()) / 86_400_000);
  return days > 1 ? `${days} days left` : days === 1 ? "1 day left" : days === 0 ? "due today" : "overdue";
}

/**
 * One dispute as a case file: who disputed what and for how much, the case's progress, the evidence pack (the same
 * folded receipt as the contract page, the timeline, the ledger) and the response: an editable document with its two
 * endings for the freelancer, what happens next for the client, the outcome and the text sent once it is answered.
 */
export async function DisputeCard({ dispute, milestone, contract, isFreelancer, attachments, names }: DisputeCardProps) {
  const meta = STATUS[dispute.status];
  const currency = dispute.currency ?? contract.currency;
  const amountMinor = dispute.amountMinor ?? milestone.amountMinor;
  // Inline in running text, so a touch under the 14px of size "s" (as the response text sets its figures).
  const amount = <Money minor={amountMinor} currency={currency} className="text-[0.93em]" />;
  const pack = dispute.drafted?.pack ?? null;
  const draft = dispute.drafted?.draft ?? null;
  const open = isOpen(dispute);
  const buyer = names[contract.clientId] ?? "the buyer";
  const freelancer = names[contract.freelancerId] ?? "The freelancer";

  // The receipt exactly as the contract page folds it: the delivery the pack was built from, its decision and criteria.
  const db = getDb();
  const [mRow, crit, delivery] = await Promise.all([
    db.query.milestones.findFirst({
      columns: { status: true, decision: true },
      where: (t, { eq }) => eq(t.id, milestone.id),
    }),
    db.query.criteria.findMany({
      columns: { id: true, description: true, required: true },
      where: (t, { eq }) => eq(t.milestoneId, milestone.id),
    }),
    pack?.delivery
      ? db.query.deliveries.findFirst({
          columns: {
            id: true,
            ref: true,
            source: true,
            model: true,
            result: true,
            verifiedAt: true,
            receivedAt: true,
            verdict: true,
            evidence: true,
            suspectedInjection: true,
          },
          where: (t, { eq }) => eq(t.id, pack.delivery!.id),
        })
      : Promise.resolve(undefined),
  ]);
  const decision = mRow?.decision ?? null;
  const decidedId = decisionDeliveryId(decision);
  const receiptDecision = decision && (decidedId === null || decidedId === delivery?.id) ? decision : null;
  const shown: VerdictDelivery | null = delivery ?? null;
  const receipt = shown ? (
    <div data-cite={`${pack?.criteria.map((c) => c.cite).join(" ") ?? ""} D1`} data-cite-unfold className={cx("rounded-panel", citeRow)}>
      <VerdictView
        folded
        delivery={shown}
        decision={receiptDecision}
        descriptions={Object.fromEntries(crit.map((c) => [c.id, c.description]))}
        required={Object.fromEntries(crit.map((c) => [c.id, c.required]))}
        currency={contract.currency}
        showEvidence
      />
    </div>
  ) : null;

  let response: ReactNode;
  const answering = dispute.status === "awaiting_response" && draft !== null;
  const freelancerAnswers = isFreelancer && answering;
  if (dispute.status === "drafting") {
    response = isFreelancer ? (
      <p data-tone="needs" className="flex items-baseline gap-2.5 text-[14px] leading-relaxed text-fg-muted">
        <StateGlyph glyph="pulse" className="text-tone" />
        Compiling the evidence pack from the milestone&apos;s record and drafting your response. It appears here in a moment.
      </p>
    ) : (
      <WhatNext freelancer={freelancer} amount={amount} drafted={false} />
    );
  } else if (answering) {
    response = isFreelancer ? (
      <DisputeResponse
        disputeId={dispute.disputeId}
        draft={draft.text}
        source={draft.source}
        model={draft.model}
        citations={draft.citations.length}
        amount={amount}
        buyer={buyer}
        attachments={attachments}
        acceptable={canAcceptClaim(milestone.status ?? mRow?.status)}
      />
    ) : (
      <WhatNext freelancer={freelancer} amount={amount} drafted />
    );
  } else {
    response = (
      <div className="grid gap-4">
        <Outcome dispute={dispute} amount={amount} buyer={buyer} />
        <Sent dispute={dispute} names={names} />
        {dispute.accepted ? (
          <p className="font-mono text-[11px] text-fg-faint tabular">
            claim accepted {auditTime(dispute.accepted.at)} UTC by {names[dispute.accepted.actor] ?? dispute.accepted.actor}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <Panel as="article" tone={meta.tone} padded={false} aria-label={`Dispute ${dispute.disputeId}`} data-case={dispute.disputeId}>
      <header className="grid gap-4 border-b border-hairline px-4 py-5 sm:px-6 md:grid-cols-[minmax(0,1fr)_auto] md:items-start md:gap-8">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <StatePill state={meta.state} label={meta.label} tone={meta.tone} />
            <Hash value={dispute.disputeId} label="case" head={8} tail={4} />
            {dispute.captureId ? <Hash value={dispute.captureId} label="capture" head={8} tail={4} className="max-sm:hidden" /> : null}
          </div>
          <h3 className="type-display-m mt-3 text-fg">{milestone.title}</h3>
          <p className="mt-2 text-[14px] text-fg-muted">
            <span className="text-fg">{buyer}</span> disputed the payment with PayPal: <span className="text-fg">{reasonLabel(dispute.reason)}</span>.
          </p>
          <p className="mt-1 text-[13px] text-fg-faint">
            Milestone {milestone.seq} of{" "}
            <Link href={`/contracts/${contract.id}`} className="text-fg-muted underline decoration-hairline-strong underline-offset-4 hover:decoration-fg">
              {contract.title}
            </Link>
          </p>
        </div>
        <div className="grid grid-cols-[1fr_auto] items-baseline gap-x-4 gap-y-1 md:block md:text-right">
          <p className="type-label text-fg-faint">Disputed</p>
          <Money minor={amountMinor} currency={currency} size="l" className="md:mt-1.5" />
          {open && dispute.dueAt ? (
            <p data-tone={meta.tone} className="col-span-2 font-mono text-[11px] text-fg-faint tabular md:mt-2">
              response due {formatDate(dispute.dueAt)} · <span className="text-tone">{dueIn(dispute.dueAt)}</span>
            </p>
          ) : null}
        </div>
      </header>

      <CaseRail dispute={dispute} tone={meta.tone} you={isFreelancer} />

      <div className="grid grid-cols-1 gap-10 px-4 py-6 sm:px-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.12fr)] lg:gap-8">
        <section aria-label="Evidence pack" className="min-w-0">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
            <Eyebrow>Evidence pack</Eyebrow>
            {pack ? <span className="font-mono text-[11px] text-fg-faint tabular">sha256 {pack.hash}</span> : null}
          </div>
          {pack ? (
            <PackView pack={pack} names={names} receipt={receipt} withTimeline={freelancerAnswers} />
          ) : (
            <p className="text-[13px] text-fg-muted">The pack appears once the record is compiled.</p>
          )}
        </section>
        {/* The freelancer answers first on a phone; the pack follows as the reference. */}
        <section aria-label="Response" className={cx("min-w-0", freelancerAnswers && "max-lg:order-first")}>
          <div className="mb-4">
            <Eyebrow>{freelancerAnswers ? "Your response" : "Response"}</Eyebrow>
          </div>
          {response}
          {/* Beside the freelancer's draft the timeline sits in the pack; everywhere else it fills this column. */}
          {pack && !freelancerAnswers ? (
            <div className="mt-8">
              <Timeline pack={pack} names={names} />
            </div>
          ) : null}
        </section>
      </div>
    </Panel>
  );
}

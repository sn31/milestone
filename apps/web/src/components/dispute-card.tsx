import Link from "next/link";
import type { ReactNode } from "react";
import type { EvidencePack } from "@milestone/verify";
import { DisputeResponse } from "@/app/disputes/_components/dispute-response";
import { isOpen, reasonLabel, type Attachment, type DisputeView } from "@/app/disputes/_lib";
import { auditTime, eventGlyph, eventTone } from "@/lib/events";
import { getDb } from "@/lib/db";
import { formatDate, formatMoney } from "@/lib/format";
import { EvidenceChip, Eyebrow, Hash, Money, Panel, Receipt, ReceiptRow, Stamp, StateGlyph, StatePill, type ToneKey } from "@/components/ui";

export interface DisputeCardProps {
  dispute: DisputeView;
  /** `status` is looked up when left out: accepting the claim depends on it. */
  milestone: { id: string; seq: number; title: string; amountMinor: number; status?: string };
  contract: { id: string; title: string; currency: string; clientId: string; freelancerId: string };
  /** The viewer is the contract's freelancer (the only party who responds to PayPal). */
  isFreelancer: boolean;
  /** Which delivered files would go to PayPal with the response. */
  attachments: Attachment[];
  names: Record<string, string>;
}

// DESIGN: a dispute has no state of its own in STATE_META. An open dispute reads in the held tone (money in question,
// a side track off the paid line), a won one in released, a lost one in danger; the pill label says which step it is.
const STATUS: Record<DisputeView["status"], { state: string; label: string; tone: ToneKey }> = {
  drafting: { state: "held", label: "Drafting", tone: "held" },
  awaiting_response: { state: "held", label: "Response due", tone: "held" },
  submitted: { state: "held", label: "With PayPal", tone: "held" },
  accepted: { state: "failed", label: "Claim accepted", tone: "danger" },
  won: { state: "released", label: "Won", tone: "released" },
  lost: { state: "failed", label: "Refunded to buyer", tone: "danger" },
  resolved: { state: "closed", label: "Resolved", tone: "neutral" },
};

function Fold({ label, count, children }: { label: string; count: number; children: ReactNode }) {
  return (
    <details className="group/fold">
      <summary className="inline-flex cursor-pointer list-none items-center gap-2 rounded-control py-1 font-mono text-[11px] tracking-[0.1em] text-fg-muted uppercase transition-colors duration-200 hover:text-fg [&::-webkit-details-marker]:hidden">
        <svg aria-hidden viewBox="0 0 10 10" className="size-2.5 transition-transform duration-200 ease-glide group-open/fold:rotate-90" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M3.5 2 L7 5 L3.5 8" />
        </svg>
        {label}
        <span className="text-fg-faint tabular">{count}</span>
      </summary>
      <div className="mt-2 overflow-hidden rounded-control border border-hairline bg-surface-sunken">{children}</div>
    </details>
  );
}

/** Confidence as a short static bar in the row's tone with the percentage, as on the contract page's receipt. */
function Confidence({ value }: { value: number }) {
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
  return (
    <span className="flex items-center gap-2" title="Verifier confidence">
      <span aria-hidden className="relative h-[3px] w-14 overflow-hidden rounded-full bg-hairline-strong">
        <span className="absolute inset-y-0 left-0 rounded-full bg-tone" style={{ width: `${pct}%` }} />
      </span>
      <span className="w-[4ch] font-mono text-[11px] text-fg-muted tabular">
        {pct}%<span className="sr-only"> confidence</span>
      </span>
    </span>
  );
}

const Cite = ({ id }: { id: string }) => <span className="w-7 shrink-0 font-mono text-[11px] text-fg-faint tabular">{id}</span>;

/** The pack as the record shows it: verdict receipt and policy stamp, then the timeline, ledger, client's actions and files. */
function PackView({ pack, names }: { pack: EvidencePack; names: Record<string, string> }) {
  const currency = pack.milestone.currency;
  const evidence = new Map(pack.evidence.map((e) => [e.id, e]));
  const facts = pack.facts;
  return (
    <div className="grid gap-5">
      <dl className="grid grid-cols-3 gap-4 border-b border-hairline pb-4">
        <div className="min-w-0">
          <dt className="type-label text-fg-faint">Funded</dt>
          <dd className="mt-1.5">
            <Money minor={facts.fundedMinor} currency={currency} tone="funded" />
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="type-label text-fg-faint">Paid out</dt>
          <dd className="mt-1.5">
            <Money minor={facts.paidToFreelancerMinor + facts.paidToPartnerMinor} currency={currency} tone={facts.released ? "released" : undefined} />
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="type-label text-fg-faint">Criteria</dt>
          <dd className="type-num-s mt-1.5 text-fg">
            {facts.criteriaPassed}
            <span className="text-fg-faint"> / {facts.criteriaTotal} passed</span>
          </dd>
        </div>
      </dl>

      {pack.criteria.length ? (
        <Receipt
          title="Verdict"
          meta={pack.delivery ? `${pack.delivery.id} · ${formatDate(pack.delivery.verifiedAt ?? pack.delivery.receivedAt)}` : "no delivery"}
          footer={
            pack.decision ? (
              <div className="flex flex-wrap items-end justify-between gap-4">
                <p className="max-w-[40ch] text-[13px] leading-relaxed text-fg-muted">
                  <span className="mr-2 font-mono text-[11px] text-fg-faint">D1</span>
                  {pack.decision.reason}
                </p>
                <Stamp action={pack.decision.action} ruleIds={pack.decision.ruleIds} note={formatMoney(pack.decision.amountMinor, currency)} />
              </div>
            ) : null
          }
        >
          {pack.criteria.map((c) => (
            <ReceiptRow
              key={c.id}
              label={c.description}
              kind={`${c.cite} ${c.kind ?? ""}`.trim()}
              status={c.status === "missing" ? "unclear" : c.status}
              {...(c.confidence !== null ? { meter: <Confidence value={c.confidence} /> } : {})}
              required={c.required}
              detail={c.rationale || undefined}
            >
              {c.evidenceIds.length
                ? c.evidenceIds.map((id) => {
                    const e = evidence.get(id);
                    const st = e?.status === "pass" || e?.status === "fail" || e?.status === "unclear" ? e.status : undefined;
                    return <EvidenceChip key={id} kind={e?.kind ?? "note"} id={id} {...(st ? { status: st } : {})} {...(e?.summary ? { title: e.summary } : {})} />;
                  })
                : null}
            </ReceiptRow>
          ))}
        </Receipt>
      ) : null}

      <div className="grid gap-2">
        <Fold label="Timeline" count={pack.timeline.length}>
          <ol className="divide-y divide-hairline">
            {pack.timeline.map((t) => (
              <li key={t.cite} data-tone={eventTone(t.event)} className="flex gap-3 px-3 py-2">
                <Cite id={t.cite} />
                <StateGlyph glyph={eventGlyph(t.event)} className="mt-[5px] text-tone" />
                <div className="min-w-0">
                  <p className="text-[13px] text-fg">{t.summary}</p>
                  <p className="mt-0.5 font-mono text-[11px] text-fg-faint tabular">
                    {auditTime(t.at)} · {names[t.actor] ?? t.actor} · {t.event}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        </Fold>
        <Fold label="Ledger" count={pack.ledger.length}>
          <ol className="divide-y divide-hairline">
            {pack.ledger.map((l) => (
              <li key={l.cite} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-3 py-2">
                <Cite id={l.cite} />
                <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-fg-muted">{l.account}</span>
                <span className="font-mono text-[11px] text-fg-faint uppercase">{l.direction}</span>
                <Money minor={l.amountMinor} currency={l.currency} />
                <span className="basis-full pl-10 font-mono text-[11px] text-fg-faint tabular">
                  {auditTime(l.at)} · {l.ref}
                </span>
              </li>
            ))}
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
              {pack.files.map((f) => (
                <li key={f.cite} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
                  <Cite id={f.cite} />
                  <span className="min-w-0 truncate text-[13px] text-fg">{f.name}</span>
                  <span className="font-mono text-[11px] text-fg-faint">{f.origin === "repo" ? "in repository" : f.size !== null ? `${Math.max(1, Math.ceil(f.size / 1024))} KB` : ""}</span>
                  {f.sha256 ? <Hash value={f.sha256} label="sha256" head={8} tail={4} className="sm:ml-auto" /> : null}
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
    <div className="grid gap-3">
      <Eyebrow>Sent to PayPal</Eyebrow>
      <p className="font-mono text-[11px] text-fg-faint tabular">
        {auditTime(s.at)} UTC · {names[s.actor] ?? s.actor}
        {s.documents.length ? ` · ${s.documents.length} file${s.documents.length === 1 ? "" : "s"} attached` : ""}
      </p>
      <div className="rounded-control border border-hairline bg-surface-sunken px-4 py-3 text-[14px] leading-relaxed whitespace-pre-wrap text-fg">{s.text}</div>
    </div>
  );
}

function Outcome({ dispute, amountLabel }: { dispute: DisputeView; amountLabel: string }) {
  const status = dispute.status;
  if (status !== "won" && status !== "lost" && status !== "resolved" && status !== "accepted" && status !== "submitted") return null;
  const tone: ToneKey = status === "won" ? "released" : status === "lost" || status === "accepted" ? "danger" : status === "submitted" ? "held" : "neutral";
  const line =
    status === "won"
      ? "Resolved in the seller's favour. The payout stands."
      : status === "lost"
        ? `Resolved in the buyer's favour. PayPal refunded ${amountLabel}.`
        : status === "accepted"
          ? `Claim accepted. PayPal is refunding ${amountLabel}.`
          : status === "submitted"
            ? "PayPal is reviewing the evidence."
            : `Resolved: ${(dispute.resolved?.outcome ?? "no outcome given").toLowerCase().replace(/_/g, " ")}.`;
  return (
    <div data-tone={tone} className="rounded-control border border-tone bg-tone-soft px-4 py-3">
      <p className="flex items-baseline gap-2 text-[14px] text-fg">
        <StateGlyph glyph={status === "won" ? "check" : status === "submitted" ? "pause" : "cross"} className="text-tone" />
        <span className="min-w-0">{line}</span>
      </p>
      {dispute.resolved ? <p className="mt-1 pl-[18px] font-mono text-[11px] text-fg-faint tabular">{auditTime(dispute.resolved.at)} UTC · CUSTOMER.DISPUTE.RESOLVED</p> : null}
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

/** One dispute: who disputed what, the evidence pack, and the response (editable for the freelancer while open). */
export async function DisputeCard({ dispute, milestone, contract, isFreelancer, attachments, names }: DisputeCardProps) {
  const meta = STATUS[dispute.status];
  const currency = dispute.currency ?? contract.currency;
  const amountMinor = dispute.amountMinor ?? milestone.amountMinor;
  const amountLabel = formatMoney(amountMinor, currency);
  const pack = dispute.drafted?.pack ?? null;
  const draft = dispute.drafted?.draft ?? null;
  const open = isOpen(dispute);

  let response: ReactNode;
  if (dispute.status === "drafting") {
    response = (
      <p data-tone="held" className="flex items-baseline gap-2.5 text-[13.5px] leading-relaxed text-fg-muted">
        <span aria-hidden className="size-1.5 shrink-0 translate-y-[-1px] rounded-full bg-tone" />
        Compiling the evidence pack from the milestone&apos;s record and drafting the response.
      </p>
    );
  } else if (dispute.status === "awaiting_response" && draft) {
    const status =
      milestone.status ??
      (isFreelancer ? (await getDb().query.milestones.findFirst({ columns: { status: true }, where: (t, { eq }) => eq(t.id, milestone.id) }))?.status : undefined);
    const acceptable = canAcceptClaim(status);
    response = isFreelancer ? (
      // DESIGN: DisputeResponse always draws "Accept claim"; until the milestone is paid out the route refuses it, so the
      // button's column is hidden here (it is the only control there with aria-expanded) and a one-line note says why.
      <div className={acceptable ? undefined : "grid gap-3 [&_div:has(>button[aria-expanded])]:hidden"}>
        <DisputeResponse disputeId={dispute.disputeId} draft={draft.text} source={draft.source} model={draft.model} citations={draft.citations.length} amountLabel={amountLabel} attachments={attachments} />
        {acceptable ? null : (
          <p className="text-[12.5px] leading-relaxed text-fg-muted">
            Accepting the claim opens once this milestone is paid out; while the money is in escrow an operator settles any refund.
          </p>
        )}
      </div>
    ) : (
      <div className="grid gap-3">
        <p data-tone="held" className="flex items-baseline gap-2.5 text-[13.5px] leading-relaxed text-fg-muted">
          <span aria-hidden className="size-1.5 shrink-0 translate-y-[-1px] rounded-full bg-tone" />
          {names[contract.freelancerId] ?? "The freelancer"} is preparing a response to PayPal. You see the same evidence pack; the response appears here once it is sent.
        </p>
      </div>
    );
  } else {
    response = (
      <div className="grid gap-4">
        <Outcome dispute={dispute} amountLabel={amountLabel} />
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
    <Panel as="article" tone={meta.tone} padded={false} aria-label={`Dispute ${dispute.disputeId}`}>
      <header className="grid gap-4 border-b border-hairline px-4 py-5 sm:px-6 md:grid-cols-[minmax(0,1fr)_auto] md:items-start md:gap-8">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <StatePill state={meta.state} label={meta.label} tone={meta.tone} />
            <span className="font-mono text-[11px] text-fg-faint tabular">opened {auditTime(dispute.openedAt)} UTC</span>
          </div>
          <h3 className="type-display-s mt-2 text-fg">{milestone.title}</h3>
          <p className="mt-1 text-[13px] text-fg-muted">
            {reasonLabel(dispute.reason)} · milestone {milestone.seq} of{" "}
            <Link href={`/contracts/${contract.id}`} className="underline decoration-hairline-strong underline-offset-4 hover:decoration-fg">
              {contract.title}
            </Link>
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Hash value={dispute.disputeId} label="dispute" head={8} tail={4} />
            {dispute.captureId ? <Hash value={dispute.captureId} label="capture" head={8} tail={4} /> : null}
          </div>
        </div>
        <div className="grid grid-cols-[1fr_auto] items-baseline gap-x-4 md:block md:text-right">
          <p className="type-label text-fg-faint">Disputed</p>
          <Money minor={amountMinor} currency={currency} size="m" />
          {open && dispute.dueAt ? <p className="col-span-2 font-mono text-[11px] text-fg-faint tabular md:mt-1.5">response due {formatDate(dispute.dueAt)}</p> : null}
        </div>
      </header>

      <div className="grid gap-8 px-4 py-5 sm:px-6 sm:py-6 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
        <section aria-label="Evidence pack" className="min-w-0">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
            <Eyebrow>Evidence pack</Eyebrow>
            {pack ? <span className="font-mono text-[11px] text-fg-faint tabular">pack {pack.hash}</span> : null}
          </div>
          {pack ? <PackView pack={pack} names={names} /> : <p className="text-[13px] text-fg-muted">The pack appears once the record is compiled.</p>}
        </section>
        <section aria-label="Response" className="min-w-0">
          <div className="mb-4">
            <Eyebrow>Response</Eyebrow>
          </div>
          {response}
        </section>
      </div>
    </Panel>
  );
}

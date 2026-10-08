import type { ReactNode } from "react";
import { UploadPayload, type contracts, type criteria as criteriaTable, type deliveries, type milestones } from "@milestone/core";
import { paypalMode } from "@milestone/money";
import type { Actor } from "@/lib/session";
import { formatMoney, humanize, truncateMiddle } from "@/lib/format";
import { getDb } from "@/lib/db";
import { AdvanceOffer } from "@/components/advance-offer";
import { DeliverForm } from "@/components/deliver-form";
import { FundButton } from "@/components/fund-button";
import { ReviewCard } from "@/components/review-card";
import { VerdictView } from "@/components/verdict-view";
import { Hash, LogStream, MoneyTransit, StateGlyph, stateMeta, type LogLine, type ToneKey } from "@/components/ui";
import { CriteriaList } from "@/app/contracts/_components/criteria-list";
import { LifecycleTrack } from "@/app/contracts/_components/lifecycle-track";
import { LiveRefresh } from "@/app/contracts/_components/live-refresh";

type MilestoneRow = typeof milestones.$inferSelect;
type ContractRow = typeof contracts.$inferSelect;
type CriterionRow = typeof criteriaTable.$inferSelect;
type DeliveryRow = typeof deliveries.$inferSelect;

/** An audit row about this milestone, oldest first (used for the verifying log). */
export interface MilestoneEvent {
  at: Date;
  event: string;
}

export interface MilestoneActionsProps {
  milestone: MilestoneRow;
  contract: ContractRow;
  actor: Actor;
  /** This milestone's criteria. */
  crit: CriterionRow[];
  /** The latest delivery, if any. */
  delivery: DeliveryRow | null;
  /** Audit rows for this milestone, oldest first. Only read while verifying. */
  events?: MilestoneEvent[];
  names: { client: string; freelancer: string };
}

/** A one-line status note with the state's dot. */
function Note({ tone, children }: { tone?: ToneKey; children: ReactNode }) {
  return (
    <p data-tone={tone ?? "neutral"} className="flex items-baseline gap-2.5 text-[13.5px] leading-relaxed text-fg-muted">
      <span aria-hidden className="size-1.5 shrink-0 translate-y-[-1px] rounded-full bg-tone" />
      <span className="min-w-0">{children}</span>
    </p>
  );
}

/** The freelancer's delivery form on a funded or held milestone: files when it has upload criteria, a commit otherwise. */
function deliverFor(milestone: MilestoneRow, contract: ContractRow, actor: Actor, crit: CriterionRow[]) {
  if (actor.role !== "freelancer" || actor.userId !== contract.freelancerId) return null;
  if (milestone.status !== "funded" && milestone.status !== "held") return null;
  const files = crit.some((c) => c.kind === "upload");
  const repo = crit.some((c) => c.kind === "test" || c.kind === "build" || c.kind === "file" || c.kind === "visual") || !files;
  const patterns = crit
    .filter((c) => c.kind === "upload")
    .map((c) => (c.spec as { pattern?: unknown }).pattern)
    .flatMap((p) => (Array.isArray(p) ? p : [p]))
    .filter((p): p is string => typeof p === "string");
  return (
    <DeliverForm
      milestoneId={milestone.id}
      files={files}
      repo={repo}
      resubmit={milestone.status === "held"}
      defaultRepoUrl={contract.repoFullName ? `https://github.com/${contract.repoFullName}.git` : null}
      accept={patterns.length ? [...new Set(patterns)].join(", ") : null}
    />
  );
}

/**
 * Descriptions of required criteria whose verdict on this delivery is not a pass (a criterion the verdict does not
 * mention counts as not passed). Mirrors requiredNotPassed in app/api/milestones/[id]/review/route.ts, which refuses
 * approve and confirm_partial in that case.
 */
function requiredNotPassed(delivery: DeliveryRow | null | undefined, crit: CriterionRow[]): string[] {
  const list = delivery?.verdict && typeof delivery.verdict === "object" ? (delivery.verdict as { criteria?: unknown }).criteria : undefined;
  const status = new Map<string, unknown>();
  if (Array.isArray(list)) {
    for (const r of list) if (r && typeof r === "object") status.set(String((r as Record<string, unknown>).criterion_id), (r as Record<string, unknown>).status);
  }
  return crit.filter((c) => c.required && status.get(c.id) !== "pass").map((c) => c.description);
}

/** An upload delivery's files (served only to the contract's parties), as a manifest: name, size, sha256. */
function DeliveredFiles({ delivery }: { delivery: DeliveryRow | null }) {
  if (!delivery || delivery.source !== "upload") return null;
  const parsed = UploadPayload.safeParse(delivery.payload);
  if (!parsed.success || parsed.data.files.length === 0) return null;
  return (
    <div className="overflow-hidden rounded-panel border border-hairline bg-surface-sunken">
      <p className="type-label border-b border-dashed border-hairline-strong px-4 py-2.5 text-fg-faint">Delivered files</p>
      <ul className="divide-y divide-hairline">
        {parsed.data.files.map((f) => (
          <li key={f.path} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2.5">
            <a
              className="min-w-0 truncate text-[13.5px] text-fg underline decoration-hairline-strong underline-offset-4 hover:decoration-fg"
              href={`/api/files/${encodeURIComponent(delivery.id)}/${encodeURIComponent(f.name)}`}
              target="_blank"
              rel="noreferrer noopener"
            >
              {f.name}
            </a>
            <span className="font-mono text-[11px] text-fg-faint tabular">{Math.ceil(f.size / 1024)} KB</span>
            <Hash value={f.sha256} label="sha256" head={8} tail={4} className="sm:ml-auto" />
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Settled milestones keep their receipt one click away instead of at full length. */
function Folded({ label, children }: { label: string; children: ReactNode }) {
  return (
    <details className="group/fold">
      <summary className="inline-flex cursor-pointer list-none items-center gap-2 rounded-control py-1 font-mono text-[11px] tracking-[0.1em] text-fg-muted uppercase transition-colors duration-200 hover:text-fg [&::-webkit-details-marker]:hidden">
        <svg aria-hidden viewBox="0 0 10 10" className="size-2.5 transition-transform duration-200 ease-glide group-open/fold:rotate-90" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M3.5 2 L7 5 L3.5 8" />
        </svg>
        {label}
      </summary>
      <div className="mt-3 grid gap-4">{children}</div>
    </details>
  );
}

const hhmmss = (d: Date) => d.toISOString().slice(11, 19);

/** What the verifier has been given and what it is working through, as log lines. Only real events carry a time. */
function verifyLines(delivery: DeliveryRow | null, crit: CriterionRow[], events: MilestoneEvent[]): LogLine[] {
  const lines: LogLine[] = [];
  const since = delivery?.receivedAt.getTime() ?? 0;
  if (delivery) {
    const what = delivery.source === "upload" ? "files" : delivery.source === "github_pr" ? "pull request" : delivery.source;
    lines.push({ at: hhmmss(delivery.receivedAt), text: `delivery ${delivery.id} received · ${what} ${truncateMiddle(delivery.ref, 14, 6)}` });
  }
  for (const e of events) {
    if (e.at.getTime() < since) continue;
    lines.push({ at: hhmmss(e.at), text: humanize(e.event), tone: /fail|refused|error/.test(e.event) ? "err" : undefined });
  }
  crit.forEach((c, i) => lines.push({ text: `check ${String(i + 1).padStart(2, "0")}  ${c.kind.padEnd(8, " ")} ${c.description}` }));
  lines.push({ text: "agent weighing the evidence against each check", tone: "verifying" });
  return lines;
}

/**
 * Everything inside one milestone's station on the contract rail: where it sits in its lifecycle, its release conditions
 * or its verdict, and the actions the acting role can take here (fund, deliver, advance, review).
 */
export async function MilestoneActions({ milestone, contract, actor, crit, delivery, events = [], names }: MilestoneActionsProps) {
  const status = milestone.status;
  const isClient = actor.role === "client" && actor.userId === contract.clientId;
  const isFreelancer = actor.role === "freelancer" && actor.userId === contract.freelancerId;
  const decision = milestone.decision ?? null;
  // The decision belongs to the delivery it was made for: once a new delivery is in, its receipt carries no stamp yet.
  const decisionDeliveryId = (decision as { deliveryId?: unknown } | null)?.deliveryId;
  const receiptDecision = decision && (typeof decisionDeliveryId !== "string" || decisionDeliveryId === delivery?.id) ? decision : null;
  const descriptions = Object.fromEntries(crit.map((c) => [c.id, c.description]));
  const items = crit.map((c) => ({ id: c.id, kind: c.kind, description: c.description, required: c.required }));
  const required = Object.fromEntries(crit.map((c) => [c.id, c.required]));
  const verdict = (
    <>
      <DeliveredFiles delivery={delivery} />
      <VerdictView delivery={delivery} decision={receiptDecision} descriptions={descriptions} currency={contract.currency} required={required} showEvidence />
    </>
  );

  let body: ReactNode;
  switch (status) {
    case "draft": {
      let action: ReactNode;
      if (contract.status !== "active") action = <Note>Funding opens once both parties sign the contract.</Note>;
      else if (isClient)
        action = (
          <FundButton
            milestoneId={milestone.id}
            currency={contract.currency}
            amountLabel={formatMoney(milestone.amountMinor, contract.currency)}
            paypalEnv={process.env.PAYPAL_ENV === "live" ? "live" : "sandbox"}
            mode={paypalMode()}
          />
        );
      else action = <Note>Waiting for {names.client} to fund this milestone.</Note>;
      body = (
        <>
          <CriteriaList items={items} />
          {action}
        </>
      );
      break;
    }
    case "funded":
      body = (
        <>
          <div data-tone="funded" className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <Note tone="funded">
              {isFreelancer ? "Deliver below to start verification." : `Waiting for ${names.freelancer} to deliver.`}
            </Note>
            {milestone.paypalCaptureId ? <Hash value={milestone.paypalCaptureId} label="capture" /> : null}
          </div>
          <CriteriaList items={items} />
          {isFreelancer && milestone.advanceEligible ? <AdvanceOffer milestoneId={milestone.id} /> : null}
          {deliverFor(milestone, contract, actor, crit)}
        </>
      );
      break;
    case "verifying":
      body = (
        <>
          <LiveRefresh />
          <LogStream live title={`verifier · ${delivery ? delivery.id : "waiting for delivery"}`} lines={verifyLines(delivery, crit, events)} maxHeight={240} />
          <CriteriaList items={items} checking />
          {delivery?.verdict ? verdict : null}
        </>
      );
      break;
    case "review":
    case "needs_client": {
      // The route checks the delivery the decision was made for (decision.deliveryId), falling back to the latest.
      const decidedId = (decision as { deliveryId?: unknown } | null)?.deliveryId;
      const decided =
        typeof decidedId === "string" && decidedId !== delivery?.id
          ? await getDb().query.deliveries.findFirst({ where: (t, { eq }) => eq(t.id, decidedId) })
          : delivery;
      const card = (
        <ReviewCard
          milestoneId={milestone.id}
          status={status}
          isClient={isClient}
          reviewEndsAt={milestone.reviewEndsAt ? milestone.reviewEndsAt.toISOString() : null}
          decisionAction={decision?.action ?? null}
          amountLabel={decision && decision.amountMinor > 0 ? formatMoney(decision.amountMinor, contract.currency) : null}
          reason={decision?.reason ?? null}
          requiredNotPassed={requiredNotPassed(decided, crit)}
        />
      );
      body =
        status === "review" ? (
          <>
            {/* ReviewCard draws the countdown ring and the approve / veto controls for the review window. */}
            {card}
            {verdict}
          </>
        ) : (
          <>
            <Note tone="needs">The agent could not release this on its own. {names.client} decides.</Note>
            {card}
            {verdict}
          </>
        );
      break;
    }
    case "held":
      body = (
        <>
          <Note tone="held">
            Held in escrow{milestone.clientResponse ? ` (${names.client} chose ${humanize(milestone.clientResponse)})` : ""}. Nothing moves until a new delivery
            passes or an operator resolves it.
          </Note>
          {delivery ? verdict : null}
          {deliverFor(milestone, contract, actor, crit)}
        </>
      );
      break;
    case "released":
    case "partial_released": {
      const paid = status === "partial_released" ? (decision?.amountMinor ?? 0) : milestone.amountMinor;
      const refunded = Math.max(0, milestone.amountMinor - paid);
      body = (
        <>
          <div className="rounded-panel border border-hairline bg-surface-sunken px-4 py-4 sm:px-5">
            <MoneyTransit minor={paid} currency={contract.currency} from="Escrow" to={names.freelancer} tone={status === "released" ? "released" : "partial"} />
            <p className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-fg-faint tabular">
              <span data-tone="released" className="inline-flex items-center gap-1.5 text-tone">
                <StateGlyph glyph="check" className="size-[9px]" />
                payout confirmed by PayPal
              </span>
              {refunded > 0 ? <span>{formatMoney(refunded, contract.currency)} refunded to {names.client}</span> : null}
            </p>
          </div>
          {delivery ? <Folded label="Verdict receipt">{verdict}</Folded> : null}
        </>
      );
      break;
    }
    default:
      body = <Note>{stateMeta(String(status)).label}</Note>;
  }

  return (
    <div className="grid gap-4">
      {/* Which step only matters while the money is in escrow: a draft has everything ahead, a payout everything behind. */}
      {status !== "draft" && status !== "released" && status !== "partial_released" ? <LifecycleTrack status={status} className="mb-1" /> : null}
      {body}
    </div>
  );
}

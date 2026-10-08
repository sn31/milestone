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
import { VerifierLog } from "@/components/live-refresh";
import { awaitingVerdict } from "@/components/live-rules";
import { Hash, MoneyTransit, StateGlyph, stateMeta, type LogLine, type ToneKey } from "@/components/ui";
import type { MilestoneSnapshot } from "@/app/api/milestones/[id]/status/snapshot";
import { CriteriaList } from "@/app/contracts/_components/criteria-list";
import { LifecycleTrack } from "@/app/contracts/_components/lifecycle-track";

type MilestoneRow = typeof milestones.$inferSelect;
type ContractRow = typeof contracts.$inferSelect;
type CriterionRow = typeof criteriaTable.$inferSelect;
type DeliveryRow = typeof deliveries.$inferSelect;

export interface MilestoneActionsProps {
  milestone: MilestoneRow;
  contract: ContractRow;
  actor: Actor;
  /** This milestone's criteria. */
  crit: CriterionRow[];
  /** The latest delivery, if any. */
  delivery: DeliveryRow | null;
  /** This milestone's live snapshot (GET /api/milestones/[id]/status) when the page is polling it; feeds the verifier log. */
  live?: MilestoneSnapshot | null;
  names: { client: string; freelancer: string };
  /**
   * Set when a payout or refund for this milestone went wrong (a milestone.needs_operator audit row): it stays held
   * until an operator resolves it by hand, and the worker refuses new deliveries for it.
   */
  operator?: { reason: string; failure: string | null } | null;
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

/**
 * The freelancer's delivery form on a funded or held milestone: files when it has upload criteria, a commit otherwise.
 * While the latest delivery waits for the verifier (the worker has not moved the milestone to verifying yet) the form
 * shows that instead of asking for another delivery.
 */
function deliverFor(milestone: MilestoneRow, contract: ContractRow, actor: Actor, crit: CriterionRow[], delivery: DeliveryRow | null) {
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
      pending={delivery && awaitingVerdict(delivery) ? { deliveryId: delivery.id, ref: delivery.source === "upload" ? null : delivery.ref } : null}
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

const hhmmss = (d: Date) => d.toISOString().slice(11, 19);

/**
 * The head of the verifier's log: what it was given (the delivery) and what it checks. The lines that arrive while it
 * works (audit events, evidence summaries) are appended by VerifierLog from the live snapshot.
 */
function verifyHead(delivery: DeliveryRow | null, crit: CriterionRow[]): LogLine[] {
  const lines: LogLine[] = [];
  if (delivery) {
    const what = delivery.source === "upload" ? "files" : delivery.source === "github_pr" ? "pull request" : delivery.source;
    lines.push({ at: hhmmss(delivery.receivedAt), text: `delivery ${delivery.id} received · ${what} ${truncateMiddle(delivery.ref, 14, 6)}` });
  }
  crit.forEach((c, i) => lines.push({ text: `check ${String(i + 1).padStart(2, "0")}  ${c.kind.padEnd(8, " ")} ${c.description}` }));
  lines.push({ text: "agent running the checks and weighing the evidence", tone: "verifying" });
  return lines;
}

/** The snapshot to start the verifier log from when the page did not pass one (it polls only live milestones). */
function emptySnapshot(milestone: MilestoneRow, delivery: DeliveryRow | null): MilestoneSnapshot {
  return {
    id: milestone.id,
    status: milestone.status,
    live: true,
    decidedAt: null,
    reviewEndsAt: null,
    delivery: delivery ? { id: delivery.id, receivedAt: delivery.receivedAt.toISOString(), verifiedAt: null, result: null, evidenceCount: 0 } : null,
    evidence: [],
    events: [],
    auditId: null,
    pendingOp: null,
  };
}

/**
 * Everything inside one milestone's station on the contract rail: where it sits in its lifecycle, its release conditions
 * or its verdict, and the actions the acting role can take here (fund, deliver, advance, review).
 */
export async function MilestoneActions({ milestone, contract, actor, crit, delivery, live = null, names, operator = null }: MilestoneActionsProps) {
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
  // Where the decision is what matters (review, needs client, held, paid), the receipt folds to one line: result,
  // criteria passed and the policy stamp, with the full receipt and delivered files one click away.
  const receipt = (
    <VerdictView
      folded
      attachments={<DeliveredFiles delivery={delivery} />}
      delivery={delivery}
      decision={receiptDecision}
      descriptions={descriptions}
      currency={contract.currency}
      required={required}
      showEvidence
    />
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
          {deliverFor(milestone, contract, actor, crit, delivery)}
        </>
      );
      break;
    case "verifying":
      body = (
        <>
          <VerifierLog
            milestoneId={milestone.id}
            initial={live ?? emptySnapshot(milestone, delivery)}
            head={verifyHead(delivery, crit)}
            title={`verifier · ${delivery ? delivery.id : "waiting for delivery"}`}
          />
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
          amountMinor={decision?.amountMinor ?? null}
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
            {receipt}
          </>
        ) : (
          <>
            {/* The card says what the agent recommends and why; the client decides there. */}
            {card}
            {receipt}
          </>
        );
      break;
    }
    case "held":
      body = operator ? (
        <>
          <Note tone="danger">
            {operator.reason.replace(/\.$/, "")}
            {operator.failure ? `: ${operator.failure.replace(/\.$/, "")}` : ""}. The money stays in escrow until an operator resolves it by
            hand; a new delivery will not be verified.
          </Note>
          {delivery ? receipt : null}
        </>
      ) : (
        <>
          <Note tone="held">
            Held in escrow{milestone.clientResponse ? ` (${names.client} chose ${humanize(milestone.clientResponse)})` : ""}. Nothing moves until a new delivery
            passes or an operator resolves it.
          </Note>
          {delivery ? receipt : null}
          {deliverFor(milestone, contract, actor, crit, delivery)}
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
          {delivery ? receipt : null}
        </>
      );
      break;
    }
    default:
      body = <Note>{stateMeta(String(status)).label}</Note>;
  }

  return (
    <div className="grid gap-3.5">
      {/* Which step only matters while the money is in escrow: a draft has everything ahead, a payout everything behind. */}
      {status !== "draft" && status !== "released" && status !== "partial_released" ? <LifecycleTrack status={status} /> : null}
      {body}
    </div>
  );
}

import type { ReactNode } from "react";
import { AUDIT_EVENTS, UploadPayload, aupGate, advances, suggestedRepoUrl, agentMandates, auditLog, decisionDeliveryId, isAgentActor, requiredNotPassed, type contracts, type criteria as criteriaTable, type deliveries, type milestones } from "@milestone/core";
import { advanceRepayment, paypalMode } from "@milestone/money";
import { and, desc, eq, inArray } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { isContractClient, isContractFreelancer, type Actor } from "@/lib/session";
import { auditTime } from "@/lib/events";
import { agentNameOf } from "@/lib/agent/data";
import { formatMoney, humanize, truncateMiddle } from "@/lib/format";
import { AdvanceOffer } from "@/components/advance-offer";
import { DeliverForm } from "@/components/deliver-form";
import { FundButton } from "@/components/fund-button";
import { ReviewCard } from "@/components/review-card";
import { VerdictView, type VerdictDelivery } from "@/components/verdict-view";
import { VerifyingPanel } from "@/components/live-refresh";
import { Hash, stateMeta, type LogLine, type ToneKey } from "@/components/ui";
import { ReleaseBand, type ReleaseLeg } from "@/components/ui/transit";
import type { MilestoneSnapshot } from "@/app/api/milestones/[id]/status/snapshot";
import { CriteriaList, checksSummary } from "@/app/contracts/_components/criteria-list";
import { LifecycleTrack } from "@/app/contracts/_components/lifecycle-track";

type MilestoneRow = typeof milestones.$inferSelect;
type ContractRow = typeof contracts.$inferSelect;
type CriterionRow = typeof criteriaTable.$inferSelect;
type DeliveryRow = typeof deliveries.$inferSelect;

/** Where the money went when a milestone was paid out, leg by leg as the ledger booked it, and whether it just happened. */
export interface ReleaseView {
  legs: ReleaseLeg[];
  /** The release was confirmed within the last minute: the band plays (once per tab). */
  fresh: boolean;
  /** Released on the contract before and after this milestone. */
  contractTotal: { before: number; after: number };
  /** The PayPal payout batch (or op) id. */
  reference: string | null;
  /** Play-once key: the milestone and the time it was released (a reseeded database reuses milestone ids). */
  playKey: string;
}

export interface MilestoneActionsProps {
  milestone: MilestoneRow;
  contract: ContractRow;
  actor: Actor;
  /** This milestone's criteria. */
  crit: CriterionRow[];
  /** The latest delivery, if any. */
  delivery: DeliveryRow | null;
  /**
   * The delivery the milestone's decision was made for, when that is not the latest one (null when it is the latest,
   * there is no decision, or the row is gone). The review card checks its required criteria.
   */
  decided?: DeliveryRow | null;
  /** The review window's length in seconds (core reviewWindowSeconds of the contract), for the countdown ring. */
  windowSeconds: number;
  /** This milestone's status snapshot as the server loaded it (GET /api/milestones/[id]/status); feeds the verifier log. */
  live?: MilestoneSnapshot | null;
  names: { client: string; freelancer: string };
  /**
   * Set when a payout or refund for this milestone went wrong (a milestone.needs_operator audit row): it stays held
   * until an operator resolves it by hand, and the worker refuses new deliveries for it.
   */
  operator?: { reason: string; failure: string | null } | null;
  /** Render as this status instead of the milestone's own: "verifying" while a delivery waits for, or plays back, its check. */
  view?: "verifying";
  /** The first unfunded milestone on the contract: its Fund button is the page's primary; later ones are quiet. */
  firstDraft?: boolean;
  /** Paid out: the legs of the release (released and partly released stations). */
  release?: ReleaseView | null;
  /** The payout is with PayPal, waiting for its webhook: the payout op's reference. */
  releasing?: { reference: string | null; legs?: ReleaseLeg[] } | null;
  /** The client's decision after the policy's, inked under the stamp ("Approved by Casey · Oct 08 15:13"). */
  countersign?: string | null;
  /** Text in the decided delivery that addressed the reviewer, quoted on the card as ignored. */
  injection?: Array<{ source: string; text: string }>;
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

const items = (crit: CriterionRow[]) => crit.map((c) => ({ id: c.id, kind: c.kind, description: c.description, required: c.required }));

/**
 * The freelancer's delivery form on a funded or held milestone: files when it has upload criteria, a commit otherwise.
 * The release conditions fold into its header ("Checks this delivery must pass").
 */
function deliverFor(milestone: MilestoneRow, contract: ContractRow, actor: Actor, crit: CriterionRow[]) {
  if (!isContractFreelancer(actor, contract) || (milestone.status !== "funded" && milestone.status !== "held")) return null;
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
      // DEMO_REPO_URL when set (with DEMO_MODE=1 the only repository a code delivery is accepted from), else the contract's.
      defaultRepoUrl={suggestedRepoUrl(contract.repoFullName)}
      accept={patterns.length ? [...new Set(patterns)].join(", ") : null}
      conditions={<CriteriaList items={items(crit)} bare />}
      conditionsSummary={checksSummary(items(crit))}
    />
  );
}

/**
 * Without a model the worker records "deterministic-only": the commands and file checks ran, and every judgment
 * criterion is the client's to judge. Their descriptions, for the review card's heading and body.
 */
function leftToClient(d: DeliveryRow | null, crit: CriterionRow[]): string[] {
  if (!d || d.model !== "deterministic-only") return [];
  const list = (d.verdict as { criteria?: Array<{ criterion_id?: string; status?: string }> } | null)?.criteria ?? [];
  const judged = new Map(list.map((c) => [c.criterion_id, c.status]));
  const judgment = (c: CriterionRow) => c.kind === "judgment" || c.kind === "visual";
  // Only when every check that did run passed: the card's heading says so.
  if (crit.some((c) => !judgment(c) && judged.has(c.id) && judged.get(c.id) !== "pass")) return [];
  return crit.filter((c) => judgment(c) && judged.has(c.id) && judged.get(c.id) !== "pass").map((c) => c.description);
}

/** The receipt's view of a delivery: everything but the payload, which stays on the server. */
function verdictDelivery(d: DeliveryRow | null): VerdictDelivery | null {
  if (!d) return null;
  const { id, ref, source, model, result, verifiedAt, receivedAt, verdict, evidence, suspectedInjection } = d;
  return { id, ref, source, model, result, verifiedAt, receivedAt, verdict, evidence, suspectedInjection };
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

/** The head of the verifier's log: the delivery it was given. Everything after it arrives with the checks. */
function verifyHead(delivery: DeliveryRow | null): LogLine[] {
  if (!delivery) return [{ text: "waiting for the delivery to reach the verifier", tone: "verifying" }];
  const what = delivery.source === "upload" ? "files" : delivery.source === "github_pr" ? "pull request" : "commit";
  // A local or file:// repository prints by its folder name, not the worker's absolute path.
  const ref = /^(file:\/\/|\/)/.test(delivery.ref) ? (delivery.ref.split("/").pop() ?? delivery.ref) : delivery.ref;
  return [{ at: auditTime(delivery.receivedAt, true), text: `delivery received · ${what} ${truncateMiddle(ref, 28, 12)}` }];
}

/** One run of a delivery: its id and arrival time (a reseeded database can hand the same commit the same id). */
export const runKeyOf = (d: Pick<DeliveryRow, "id" | "receivedAt">) => `${d.id}@${d.receivedAt.getTime()}`;

/** The snapshot to start the verifier log from when the server loaded none. */
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
 * or its verdict, and the actions the acting role can take here (fund, deliver, advance, review). Only the current
 * station expands: drafts keep their conditions to one line, paid stations to the release and a folded receipt.
 */
export function MilestoneActions({
  milestone,
  contract,
  actor,
  crit,
  delivery,
  decided = null,
  windowSeconds,
  live = null,
  names,
  operator = null,
  view,
  firstDraft = false,
  release = null,
  releasing = null,
  countersign = null,
  injection,
}: MilestoneActionsProps) {
  const status = view ?? milestone.status;
  const isClient = isContractClient(actor, contract);
  const isFreelancer = isContractFreelancer(actor, contract);
  const decision = milestone.decision ?? null;
  // The decision belongs to the delivery it was made for: once a new delivery is in, its receipt carries no stamp yet.
  const decidedId = decisionDeliveryId(decision);
  const receiptDecision = decision && (decidedId === null || decidedId === delivery?.id) ? decision : null;
  const shown = verdictDelivery(delivery);
  const descriptions = Object.fromEntries(crit.map((c) => [c.id, c.description]));
  const kinds = Object.fromEntries(crit.map((c) => [c.id, c.kind]));
  const required = Object.fromEntries(crit.map((c) => [c.id, c.required]));
  // Where the decision is what matters (review, needs client, held, paid), the receipt folds to one line: result,
  // criteria passed and the policy stamp, with the full receipt and delivered files one click away.
  const receipt = (
    <VerdictView
      folded
      attachments={<DeliveredFiles delivery={delivery} />}
      delivery={shown}
      decision={receiptDecision}
      descriptions={descriptions}
      kinds={kinds}
      currency={contract.currency}
      required={required}
      countersign={receiptDecision ? countersign : null}
      clientApproved={(status === "released" || status === "partial_released") && (milestone.clientResponse === "approve" || milestone.clientResponse === "confirm_partial")}
      showEvidence
    />
  );

  let body: ReactNode;
  switch (status) {
    case "draft": {
      let action: ReactNode;
      if (contract.status !== "active") action = <Note>Funding opens once both parties sign the contract.</Note>;
      else if (!("ok" in aupGate(contract))) action = <Note tone="held">Funding is paused by the PayPal AUP check (see above).</Note>;
      else if (isClient)
        action = (
          <FundButton
            milestoneId={milestone.id}
            currency={contract.currency}
            amountLabel={formatMoney(milestone.amountMinor, contract.currency)}
            paypalEnv={process.env.PAYPAL_ENV === "live" ? "live" : "sandbox"}
            mode={paypalMode()}
            quiet={!firstDraft}
          />
        );
      else action = <Note>Waiting for {names.client} to fund this milestone.</Note>;
      body = (
        <>
          <CriteriaList items={items(crit)} folded />
          {action}
        </>
      );
      break;
    }
    case "funded": {
      const form = deliverFor(milestone, contract, actor, crit);
      const advance = isFreelancer && milestone.advanceEligible ? <AdvanceOffer milestoneId={milestone.id} compact /> : null;
      body = (
        <>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <Note tone="funded">{isFreelancer ? "Deliver below; the agent starts checking the moment it is in." : `Waiting for ${names.freelancer} to deliver. This station moves on its own when the work is in.`}</Note>
            {milestone.paypalCaptureId ? <Hash value={milestone.paypalCaptureId} label="capture" /> : null}
          </div>
          {form ? (
            advance ? (
              <div className="grid items-start gap-3.5 lg:grid-cols-[minmax(0,1fr)_300px]">
                {form}
                {advance}
              </div>
            ) : (
              form
            )
          ) : (
            <CriteriaList items={items(crit)} />
          )}
        </>
      );
      break;
    }
    case "verifying": {
      const snap = live && live.delivery?.id === delivery?.id ? live : emptySnapshot(milestone, delivery);
      body = delivery ? (
        <VerifyingPanel
          milestoneId={milestone.id}
          deliveryId={delivery.id}
          runKey={runKeyOf(delivery)}
          initial={snap}
          head={verifyHead(delivery)}
          criteria={crit.map((c) => ({ id: c.id, kind: c.kind, description: c.description, required: c.required }))}
          title={
            <>
              agent · checking <span className="tracking-normal normal-case">{delivery.id}</span>
            </>
          }
        />
      ) : (
        <Note tone="verifying">The agent is picking up the delivery.</Note>
      );
      break;
    }
    case "review":
    case "needs_client": {
      if (releasing) {
        body = (
          <>
            <ReleaseBand milestoneId={milestone.id} currency={contract.currency} phase="pending" legs={releasing.legs?.length ? releasing.legs : [{ to: names.freelancer, minor: decision?.amountMinor || milestone.amountMinor, tone: "released" }]} reference={releasing.reference} />
            {receipt}
          </>
        );
        break;
      }
      // The route checks the delivery the decision was made for (decision.deliveryId), falling back to the latest.
      const checked = decidedId !== null && decidedId !== delivery?.id ? decided : delivery;
      body = (
        <>
          <ReviewCard
            milestoneId={milestone.id}
            status={status}
            isClient={isClient}
            isFreelancer={isFreelancer}
            names={names}
            windowSeconds={windowSeconds}
            reviewEndsAt={milestone.reviewEndsAt ? milestone.reviewEndsAt.toISOString() : null}
            decisionAction={decision?.action ?? null}
            amountMinor={decision?.amountMinor ?? null}
            amountLabel={decision && decision.amountMinor > 0 ? formatMoney(decision.amountMinor, contract.currency) : null}
            totalLabel={formatMoney(milestone.amountMinor, contract.currency)}
            reason={decision?.reason ?? null}
            requiredNotPassed={requiredNotPassed(checked?.verdict, crit)}
            forClient={leftToClient(checked ?? null, crit)}
            injection={injection}
          />
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
            {operator.failure && !operator.reason.includes(operator.failure) ? `: ${operator.failure.replace(/\.$/, "")}` : ""}. The money stays in escrow until an operator resolves it by
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
          {deliverFor(milestone, contract, actor, crit)}
        </>
      );
      break;
    case "released":
    case "partial_released": {
      const paid = status === "partial_released" ? (decision?.amountMinor ?? 0) : milestone.amountMinor;
      const booked: ReleaseLeg[] = release?.legs.length ? release.legs : [{ to: names.freelancer, minor: paid, tone: status === "released" ? "released" : "partial" }];
      const legs: ReleaseLeg[] = booked.map((leg) =>
        leg.note && !leg.detail ? { ...leg, detail: <AdvanceRepaid milestone={milestone} repaidMinor={leg.minor} currency={contract.currency} /> } : leg,
      );
      body = (
        <>
          <ReleaseBand
            milestoneId={milestone.id}
            playKey={release?.playKey}
            currency={contract.currency}
            phase="done"
            legs={legs}
            fresh={release?.fresh ?? false}
            contractTotal={release?.contractTotal}
            reference={release?.reference ?? null}
          />
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
      {status !== "draft" && status !== "released" && status !== "partial_released" ? <VaultFundedBy milestone={milestone} /> : null}
      {body}
    </div>
  );
}

/**
 * What the partner's leg of a release is: the advance principal and its fee, printed under the leg ("advance $58.33 +
 * fee $0.81 repaid"). Loads the milestone's advance here; the page passes only the booked legs.
 */
async function AdvanceRepaid({ milestone, repaidMinor, currency }: { milestone: MilestoneRow; repaidMinor: number; currency: string }) {
  let text = "advance repaid";
  try {
    const db = getDb();
    const [adv] = await db
      .select({ principalMinor: advances.principalMinor, feeBpsPerDay: advances.feeBpsPerDay, offer: advances.offer, fundedAt: advances.fundedAt })
      .from(advances)
      .where(and(eq(advances.milestoneId, milestone.id), inArray(advances.status, ["funded", "repaid", "shortfall"])))
      .limit(1);
    if (adv) {
      const r = advanceRepayment(adv, milestone.decidedAt);
      const fee = r.repaymentMinor === repaidMinor ? r.feeMinor : Math.max(0, repaidMinor - r.principalMinor);
      const principal = Math.min(r.principalMinor, repaidMinor);
      text = fee > 0 ? `advance ${formatMoney(principal, currency)} + fee ${formatMoney(fee, currency)} repaid` : `advance ${formatMoney(principal, currency)} repaid`;
    }
  } catch {
    // no database (tests, previews): the plain note stands
  }
  return <>{text}</>;
}

/**
 * "Funded by Casey's agent from saved PayPal": one line on a station whose money came from a charge of the client's
 * saved PayPal by an agent, read from the milestone's paypal.vault_charge audit row (its actor is the agent, its detail
 * names the mandate). Nothing for a station funded through checkout.
 */
async function VaultFundedBy({ milestone }: { milestone: MilestoneRow }) {
  let line: { name: string; via: string | null; at: Date } | null = null;
  try {
    const db = getDb();
    const [row] = await db
      .select({ actor: auditLog.actor, detail: auditLog.detail, createdAt: auditLog.createdAt })
      .from(auditLog)
      .where(and(eq(auditLog.milestoneId, milestone.id), eq(auditLog.event, AUDIT_EVENTS.paypalVaultCharge)))
      .orderBy(desc(auditLog.createdAt))
      .limit(1);
    if (row && isAgentActor(row.actor)) {
      const d = (row.detail ?? {}) as { mandateId?: unknown; via?: unknown };
      let name = agentNameOf(row.actor);
      if (typeof d.mandateId === "string") {
        const [m] = await db.select({ agentName: agentMandates.agentName }).from(agentMandates).where(eq(agentMandates.id, d.mandateId)).limit(1);
        if (m) name = m.agentName;
      }
      line = { name, via: d.via === "auto_fund" ? "auto-fund on release" : d.via === "mcp" ? "Milestone MCP" : null, at: row.createdAt };
    }
  } catch {
    // no database (tests, previews): nothing to say
  }
  if (!line) return null;
  return (
    <p data-tone="funded" data-testid="vault-funded-by" className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1 text-[13.5px] leading-relaxed text-fg-muted">
      <span aria-hidden className="size-1.5 shrink-0 translate-y-[-1px] rounded-full bg-tone" />
      <span className="min-w-0">
        Funded by <span className="text-fg">{line.name}</span> from saved PayPal
      </span>
      <span className="font-mono text-[11px] text-fg-faint tabular">
        {line.via ? `${line.via} · ` : ""}
        {auditTime(line.at)}
      </span>
    </p>
  );
}

import { UploadPayload, type contracts, type criteria as criteriaTable, type deliveries, type milestones } from "@milestone/core";
import { paypalMode } from "@milestone/money";
import type { Actor } from "@/lib/session";
import { formatMoney } from "@/lib/format";
import { AdvanceOffer } from "@/components/advance-offer";
import { DeliverForm } from "@/components/deliver-form";
import { FundButton } from "@/components/fund-button";
import { ReviewCard } from "@/components/review-card";
import { VerdictView } from "@/components/verdict-view";
import { getDb } from "@/lib/db";

type MilestoneRow = typeof milestones.$inferSelect;
type ContractRow = typeof contracts.$inferSelect;
type CriterionRow = typeof criteriaTable.$inferSelect;
type DeliveryRow = typeof deliveries.$inferSelect;

function Note({ children }: { children: React.ReactNode }) {
  return <p className="mt-3 text-sm text-zinc-500">{children}</p>;
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

/** Links to an upload delivery's files (served only to the contract's parties). */
function DeliveredFiles({ delivery }: { delivery: DeliveryRow | null }) {
  if (!delivery || delivery.source !== "upload") return null;
  const parsed = UploadPayload.safeParse(delivery.payload);
  if (!parsed.success) return null;
  return (
    <ul className="mt-3 space-y-1 text-sm">
      {parsed.data.files.map((f) => (
        <li key={f.path} className="flex gap-2">
          <a className="underline" href={`/api/files/${encodeURIComponent(delivery.id)}/${encodeURIComponent(f.name)}`} target="_blank" rel="noreferrer noopener">
            {f.name}
          </a>
          <span className="text-zinc-500">{Math.ceil(f.size / 1024)} KB</span>
          <span className="font-mono text-xs text-zinc-500">sha256 {f.sha256.slice(0, 12)}</span>
        </li>
      ))}
    </ul>
  );
}

export async function MilestoneActions({ milestone, contract, actor }: { milestone: MilestoneRow; contract: ContractRow; actor: Actor }) {
  if (milestone.status === "draft") {
    if (contract.status !== "active") return <Note>Funding opens once both parties approve the contract.</Note>;
    if (actor.role === "client" && actor.userId === contract.clientId) {
      return (
        <FundButton
          milestoneId={milestone.id}
          currency={contract.currency}
          amountLabel={formatMoney(milestone.amountMinor, contract.currency)}
          paypalEnv={process.env.PAYPAL_ENV === "live" ? "live" : "sandbox"}
          mode={paypalMode()}
        />
      );
    }
    return <Note>Waiting for the client to fund this milestone.</Note>;
  }
  if (milestone.status === "funded") {
    const isFreelancer = actor.role === "freelancer" && actor.userId === contract.freelancerId;
    const fundedCrit = isFreelancer ? await getDb().query.criteria.findMany({ where: (t, { eq }) => eq(t.milestoneId, milestone.id) }) : [];
    return (
      <>
        <Note>
          Funds held{milestone.paypalCaptureId ? <> (PayPal capture <span className="font-mono text-xs">{milestone.paypalCaptureId}</span>)</> : null}.
        </Note>
        {isFreelancer && milestone.advanceEligible ? <AdvanceOffer milestoneId={milestone.id} /> : null}
        {deliverFor(milestone, contract, actor, fundedCrit)}
      </>
    );
  }
  const isClient = actor.role === "client" && actor.userId === contract.clientId;
  const db = getDb();
  const [delivery] = await db.query.deliveries.findMany({
    where: (t, { eq }) => eq(t.milestoneId, milestone.id),
    orderBy: (t, { desc }) => desc(t.receivedAt),
    limit: 1,
  });
  const crit = await db.query.criteria.findMany({ where: (t, { eq }) => eq(t.milestoneId, milestone.id) });
  const descriptions = Object.fromEntries(crit.map((c) => [c.id, c.description]));
  const decision = milestone.decision ?? null;
  const verdict = (
    <>
      <DeliveredFiles delivery={delivery ?? null} />
      <VerdictView delivery={delivery ?? null} decision={decision} descriptions={descriptions} showEvidence />
    </>
  );

  switch (milestone.status) {
    case "verifying":
      return (
        <>
          <Note>Verifying the delivery.</Note>
          {delivery ? verdict : null}
        </>
      );
    case "review":
    case "needs_client": {
      // The route checks the delivery the decision was made for (decision.deliveryId), falling back to the latest.
      const decidedId = (decision as { deliveryId?: unknown } | null)?.deliveryId;
      const decided =
        typeof decidedId === "string" && decidedId !== delivery?.id
          ? await db.query.deliveries.findFirst({ where: (t, { eq }) => eq(t.id, decidedId) })
          : delivery;
      return (
        <>
          {verdict}
          <ReviewCard
            milestoneId={milestone.id}
            status={milestone.status}
            isClient={isClient}
            reviewEndsAt={milestone.reviewEndsAt ? milestone.reviewEndsAt.toISOString() : null}
            decisionAction={decision?.action ?? null}
            amountLabel={decision && decision.amountMinor > 0 ? formatMoney(decision.amountMinor, contract.currency) : null}
            reason={decision?.reason ?? null}
            requiredNotPassed={requiredNotPassed(decided, crit)}
          />
        </>
      );
    }
    case "held":
      return (
        <>
          <Note>On hold{milestone.clientResponse ? ` (client chose ${milestone.clientResponse.replace("_", " ")})` : ""}. The deliverable can be resubmitted for verification.</Note>
          {delivery ? verdict : null}
          {deliverFor(milestone, contract, actor, crit)}
        </>
      );
    case "released":
    case "partial_released":
      return (
        <>
          <Note>
            {milestone.status === "released" ? "Released in full." : `Partially released${decision ? ` (${formatMoney(decision.amountMinor, contract.currency)})` : ""}.`}
          </Note>
          {delivery ? verdict : null}
        </>
      );
  }
  return <Note>Status: {String(milestone.status).replace("_", " ")}</Note>;
}

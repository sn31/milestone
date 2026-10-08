import type { contracts, milestones } from "@milestone/core";
import type { Actor } from "@/lib/session";
import { formatMoney } from "@/lib/format";
import { FundButton } from "@/components/fund-button";
import { ReviewCard } from "@/components/review-card";
import { VerdictView } from "@/components/verdict-view";
import { getDb } from "@/lib/db";

type MilestoneRow = typeof milestones.$inferSelect;
type ContractRow = typeof contracts.$inferSelect;

function Note({ children }: { children: React.ReactNode }) {
  return <p className="mt-3 text-sm text-zinc-500">{children}</p>;
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
        />
      );
    }
    return <Note>Waiting for the client to fund this milestone.</Note>;
  }
  if (milestone.status === "funded") {
    return (
      <Note>
        Funds held{milestone.paypalCaptureId ? <> (PayPal capture <span className="font-mono text-xs">{milestone.paypalCaptureId}</span>)</> : null}.
      </Note>
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
  const verdict = <VerdictView delivery={delivery ?? null} decision={decision} descriptions={descriptions} />;

  switch (milestone.status) {
    case "verifying":
      return (
        <>
          <Note>Verifying the delivery.</Note>
          {delivery ? verdict : null}
        </>
      );
    case "review":
    case "needs_client":
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
          />
        </>
      );
    case "held":
      return (
        <>
          <Note>On hold{milestone.clientResponse ? ` (client chose ${milestone.clientResponse.replace("_", " ")})` : ""}. The deliverable can be resubmitted for verification.</Note>
          {delivery ? verdict : null}
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

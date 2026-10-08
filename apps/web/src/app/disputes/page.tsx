import type { Metadata } from "next";
import { paypalMode } from "@milestone/money";
import { DisputeCard } from "@/components/dispute-card";
import { EmptyState, PageHeader, Panel, Reveal, SectionTitle, Stat } from "@/components/ui";
import { LiveRefresh } from "@/app/contracts/_components/live-refresh";
import { getDb } from "@/lib/db";
import { formatMoney } from "@/lib/format";
import { ACTOR_NAMES, ROLE_LABELS, getActor } from "@/lib/session";
import { SimulateDispute } from "./_components/simulate-dispute";
import { isOpen, loadDisputes, planAttachments, type Attachment } from "./_lib";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Disputes" };

/**
 * PayPal disputes on the viewer's contracts. The copilot compiles each into an evidence pack from the milestone's own
 * record and drafts the response; the freelancer edits and sends it (or accepts the claim), the client reads the pack.
 */
export default async function DisputesPage() {
  const db = getDb();
  const actor = await getActor();
  const contracts =
    actor.role === "partner"
      ? []
      : await db.query.contracts.findMany({ where: (t, { eq, or }) => or(eq(t.clientId, actor.userId), eq(t.freelancerId, actor.userId)), orderBy: (t, { desc }) => [desc(t.createdAt)] });
  const contractIds = contracts.map((c) => c.id);
  const [disputes, milestones, people] = await Promise.all([
    loadDisputes(db, { contractIds }),
    contractIds.length ? db.query.milestones.findMany({ where: (t, { inArray }) => inArray(t.contractId, contractIds), orderBy: (t, { asc }) => [asc(t.contractId), asc(t.seq)] }) : Promise.resolve([]),
    db.query.users.findMany({ columns: { id: true, name: true } }),
  ]);
  const names: Record<string, string> = { ...ACTOR_NAMES, ...Object.fromEntries(people.map((p) => [p.id, p.name])), paypal: "PayPal", policy: "Policy", verifier: "Verifier", system: "System" };
  const contractOf = new Map(contracts.map((c) => [c.id, c]));
  const milestoneOf = new Map(milestones.map((m) => [m.id, m]));

  const rows = await Promise.all(
    disputes.map(async (d) => {
      const m = milestoneOf.get(d.milestoneId);
      const c = m ? contractOf.get(m.contractId) : undefined;
      if (!m || !c) return null;
      const isFreelancer = actor.role === "freelancer" && actor.userId === c.freelancerId;
      const attachments: Attachment[] = isFreelancer && d.status === "awaiting_response" ? await planAttachments(d.drafted?.pack) : [];
      return { d, m, c, isFreelancer, attachments };
    }),
  );
  const listed = rows.filter((r): r is NonNullable<typeof r> => r !== null);
  const open = listed.filter((r) => isOpen(r.d));
  const closed = listed.filter((r) => !isOpen(r.d));
  // Amount at stake, in the currency most of the open disputes use.
  const currency = open[0]?.d.currency ?? open[0]?.c.currency ?? contracts[0]?.currency ?? "USD";
  const atStake = open.filter((r) => (r.d.currency ?? r.c.currency) === currency).reduce((s, r) => s + (r.d.amountMinor ?? r.m.amountMinor), 0);
  const live = listed.some((r) => r.d.status === "drafting" || r.d.status === "submitted" || r.d.status === "accepted");

  const simulated = paypalMode() === "simulated" && actor.role !== "partner";
  const disputed = new Set(open.map((r) => r.d.milestoneId));
  const candidates = simulated
    ? milestones
        .filter((m) => (m.status === "released" || m.status === "partial_released") && m.paypalCaptureId && !disputed.has(m.id))
        .map((m) => ({ milestoneId: m.id, label: `${contractOf.get(m.contractId)?.title ?? m.contractId} · ${m.seq}. ${m.title} · ${formatMoney(m.amountMinor, contractOf.get(m.contractId)?.currency ?? "USD")}` }))
    : [];

  const card = (r: (typeof listed)[number], i: number) => (
    <Reveal key={r.d.disputeId} index={i}>
      <DisputeCard
        dispute={r.d}
        milestone={{ id: r.m.id, seq: r.m.seq, title: r.m.title, amountMinor: r.m.amountMinor }}
        contract={{ id: r.c.id, title: r.c.title, currency: r.c.currency, clientId: r.c.clientId, freelancerId: r.c.freelancerId }}
        isFreelancer={r.isFreelancer}
        attachments={r.attachments}
        names={names}
      />
    </Reveal>
  );

  return (
    <main>
      {live ? <LiveRefresh everyMs={2500} maxMinutes={5} /> : null}
      <PageHeader
        eyebrow={
          <>
            Disputes <span className="text-hairline-strong">/</span> {ACTOR_NAMES[actor.userId] ?? actor.userId}, {ROLE_LABELS[actor.role].toLowerCase()}
          </>
        }
        title="Disputes"
        description={
          actor.role === "client"
            ? "When a payment is disputed with PayPal, Milestone compiles the milestone's record into an evidence pack: what was agreed, delivered and verified, your own actions, and every ledger movement. You see the same pack the freelancer answers from."
            : "When a client disputes a payment with PayPal, Milestone compiles the milestone's record into an evidence pack and drafts a response that cites it. You edit and send it, or accept the claim."
        }
        aside={
          listed.length ? (
            <>
              <Stat label="Open" value={open.length} tone={open.length ? "held" : undefined} />
              <Stat label="At stake" minor={atStake} currency={currency} tone={atStake ? "held" : undefined} />
            </>
          ) : null
        }
      />

      <section className="mt-12" aria-label="Open disputes">
        {open.length ? (
          <div className="grid gap-6">{open.map(card)}</div>
        ) : (
          <EmptyState
            title={actor.role === "partner" ? "Disputes belong to contracts" : "No open disputes"}
            body={
              actor.role === "partner"
                ? "A capital partner is not a party to a contract's payments. Switch to the client or the freelancer to see disputes on their contracts."
                : "If a client disputes a payment with PayPal, it appears here with an evidence pack built from the milestone's record."
            }
          />
        )}
      </section>

      {closed.length ? (
        <section className="mt-12" aria-label="Resolved disputes">
          <SectionTitle eyebrow="Closed" title="Resolved" />
          <div className="grid gap-6">{closed.map(card)}</div>
        </section>
      ) : null}

      {simulated ? (
        <section className="mt-12" aria-label="Simulated PayPal">
          <Panel variant="outline">
            <SectionTitle eyebrow="Simulated PayPal" title="Open a test dispute" />
            <p className="mb-5 max-w-[64ch] text-[13px] leading-relaxed text-fg-muted">
              Plays the buyer in PayPal&apos;s Resolution Center: opens a dispute against a paid milestone&apos;s capture. PayPal&apos;s webhook brings it here, and evidence sent back
              resolves it about two seconds later.
            </p>
            <SimulateDispute options={candidates} />
          </Panel>
        </section>
      ) : null}
    </main>
  );
}

import type { Metadata } from "next";
import { inArray } from "drizzle-orm";
import { milestones } from "@milestone/core";
import { ActionChips, CapFigure, MandatePill, mandateStatus, relativeTo } from "@/components/agent-console-mandate";
import { Button, EmptyState, PageHeader, Panel, Reveal, SectionTitle, StateGlyph } from "@/components/ui";
import { getDb } from "@/lib/db";
import { auditTime, eventGlyph, eventParts, eventTone } from "@/lib/events";
import { formatDate, formatMoney } from "@/lib/format";
import { agentNameOf, loadAgentAudit, loadMandates, type AgentAuditRow } from "@/lib/agent/data";
import { ACTOR_NAMES, getActor } from "@/lib/session";
import { DELEGABLE } from "@/app/api/agents/_shared";
import { MandateForm } from "./_components/mandate-form";
import { RevokeButton } from "./_components/revoke-button";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Agents" };

/** What the approve route checks before an agent's approve counts (apps/web/src/app/api/milestones/[id]/review). */
const GUARANTEE = [
  { label: "Milestone is in review", detail: "and the decision is for its latest delivery" },
  { label: "Policy already decided release", detail: "rule P6: every criterion passed" },
  { label: "Every required check passed", detail: "nothing required is unclear or failed" },
  { label: "Amount within the cap", detail: "in the mandate's currency" },
  { label: "Mandate is live", detail: "unexpired, unrevoked, includes approve" },
];

/** One line of what an agent action did or why it was refused. */
function detailLine(r: AgentAuditRow): string {
  const d = r.detail;
  const reason = typeof d.reason === "string" ? d.reason.replace(/_/g, " ") : null;
  const error = typeof d.error === "string" ? d.error : null;
  if (r.event.endsWith("_refused")) {
    const cur = typeof d.currency === "string" ? d.currency : null;
    if (typeof d.amountMinor === "number" && typeof d.capMinor === "number" && cur) return `${reason ?? "refused"}: ${formatMoney(d.amountMinor, cur)} over the ${formatMoney(d.capMinor, cur)} cap`;
    return [reason, error].filter(Boolean).join(": ") || "refused";
  }
  const status = typeof d.status === "string" ? d.status.replace(/_/g, " ") : null;
  return status ? `accepted · was ${status}` : "accepted";
}

/**
 * Agents: the client's mandates (create, see the token once, revoke) and everything their agents did, refusals
 * included. The console at /agents/console runs an agent under one of these mandates.
 */
export default async function AgentsPage() {
  const db = getDb();
  const actor = await getActor();
  const now = new Date().getTime();
  const [mandates, audit] = await Promise.all([loadMandates(db, actor.userId), loadAgentAudit(db, actor.userId)]);
  const milestoneIds = [...new Set(audit.map((a) => a.milestoneId).filter((x): x is string => Boolean(x)))];
  const titles = milestoneIds.length
    ? new Map((await db.select({ id: milestones.id, seq: milestones.seq, title: milestones.title }).from(milestones).where(inArray(milestones.id, milestoneIds))).map((m) => [m.id, `${String(m.seq).padStart(2, "0")} ${m.title}`]))
    : new Map<string, string>();
  const active = mandates.filter((m) => mandateStatus(m, now) === "active").length;
  const firstName = (ACTOR_NAMES[actor.userId] ?? "My").split(" ")[0];

  return (
    <main>
      <PageHeader
        eyebrow="Agents · mandates"
        title="Agents"
        description="Delegate to an agent with a mandate: what it may do, up to how much, until when. It acts through the same routes you do, so it can make a release the policy already decided happen sooner, never one it would not."
        actions={
          <Button variant="secondary" href="/agents/console">
            Open the console
          </Button>
        }
      />

      <div className="mt-10 grid gap-6 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)] lg:items-start">
        <MandateForm defaultName={`${firstName}'s agent`} allowed={DELEGABLE[actor.role]} />
        <Panel variant="sunken" as="aside" aria-label="When an agent's approve counts">
          <p className="type-label text-fg-faint">An agent&rsquo;s approve counts only when</p>
          <ol className="mt-4 divide-y divide-hairline">
            {GUARANTEE.map((g, i) => (
              <li key={g.label} data-tone="review" className="flex items-baseline gap-3 py-2.5">
                <span className="w-5 shrink-0 font-mono text-[11px] text-fg-faint tabular">{String(i + 1).padStart(2, "0")}</span>
                <span className="min-w-0">
                  <span className="block text-[14px] text-fg">{g.label}</span>
                  <span className="block text-[12.5px] text-fg-faint">{g.detail}</span>
                </span>
              </li>
            ))}
          </ol>
          <p className="mt-4 border-t border-hairline pt-4 text-[13px] text-fg-muted">
            Otherwise Milestone refuses it and writes the refusal to the log below. No agent can reach PayPal&rsquo;s payment, refund or payout tools.
          </p>
        </Panel>
      </div>

      <section className="mt-12" aria-labelledby="mandates-title">
        <SectionTitle eyebrow={`${active} active · ${mandates.length} in all`} title={<span id="mandates-title">Mandates</span>} />
        {mandates.length === 0 ? (
          <EmptyState title="No mandates yet" body="Create one above. Its token is shown once; paste it into the console or your own MCP client." />
        ) : (
          <Panel padded={false}>
            <div className="hidden grid-cols-[minmax(0,1.3fr)_minmax(0,1.7fr)_120px_150px_110px_150px] gap-4 border-b border-hairline px-5 py-3 type-label text-fg-faint lg:grid">
              <span>Agent</span>
              <span>May</span>
              <span className="text-right">Cap</span>
              <span>Expires</span>
              <span>Last used</span>
              <span className="text-right">Status</span>
            </div>
            <ol className="divide-y divide-hairline">
              {mandates.map((m, i) => {
                const status = mandateStatus(m, now);
                return (
                  <Reveal as="li" key={m.id} index={i}>
                    <div className="grid gap-3 px-4 py-4 sm:px-5 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1.7fr)_120px_150px_110px_150px] lg:items-center lg:gap-4">
                      <div className="min-w-0">
                        <p className="type-display-s truncate text-fg">{m.agentName}</p>
                        <p className="mt-0.5 truncate font-mono text-[11px] text-fg-faint" title={m.id}>{m.id}</p>
                      </div>
                      <ActionChips actions={m.actions} />
                      <div className="lg:text-right">
                        <CapFigure m={m} size="s" />
                      </div>
                      <p className="font-mono text-[12px] text-fg-muted tabular">
                        {formatDate(m.expiresAt)}
                        <span className="block text-fg-faint">{status === "revoked" ? `revoked ${relativeTo(m.revokedAt, now)}` : relativeTo(m.expiresAt, now)}</span>
                      </p>
                      <p className="font-mono text-[12px] text-fg-muted tabular">{relativeTo(m.lastUsedAt, now)}</p>
                      <div className="flex items-center gap-3 lg:justify-end">
                        <MandatePill status={status} />
                        {status === "active" ? <RevokeButton id={m.id} agentName={m.agentName} /> : null}
                      </div>
                    </div>
                  </Reveal>
                );
              })}
            </ol>
          </Panel>
        )}
      </section>

      <section className="mt-12" aria-labelledby="agent-activity-title">
        <SectionTitle eyebrow="Audit · actor agent:*" title={<span id="agent-activity-title">What your agents did</span>} />
        {audit.length === 0 ? (
          <EmptyState title="No agent actions yet" body="Approvals, holds and refusals made under your mandates are listed here, newest first." />
        ) : (
          <Panel padded={false}>
            <div className="hidden grid-cols-[140px_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.4fr)] gap-4 border-b border-hairline px-5 py-3 type-label text-fg-faint md:grid">
              <span>Time (UTC)</span>
              <span>Event</span>
              <span>Agent · milestone</span>
              <span>Outcome</span>
            </div>
            <ol className="divide-y divide-hairline">
              {audit.map((a, i) => {
                const { ns, verb } = eventParts(a.event);
                const tone = eventTone(a.event);
                return (
                  <Reveal as="li" key={a.id} index={i}>
                    <div data-tone={tone} className="grid gap-x-4 gap-y-1 px-4 py-2.5 sm:px-5 md:grid-cols-[140px_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.4fr)] md:items-baseline">
                      <time dateTime={a.createdAt} className="font-mono text-[12px] text-fg-muted tabular">
                        {auditTime(a.createdAt)}
                      </time>
                      <p className="flex min-w-0 items-center gap-2 font-mono text-[12px]">
                        <StateGlyph glyph={eventGlyph(a.event)} className="shrink-0 text-tone" />
                        <span className="truncate">
                          {ns ? <span className="text-fg-faint">{ns}.</span> : null}
                          <span className={tone === "danger" ? "text-tone" : "text-fg"}>{verb}</span>
                        </span>
                      </p>
                      <p className="min-w-0 truncate text-[12.5px] text-fg-muted">
                        <span className="text-fg">{agentNameOf(a.actor)}</span>
                        <span className="text-fg-faint"> · </span>
                        {a.milestoneId ? (titles.get(a.milestoneId) ?? a.milestoneId) : "contract"}
                      </p>
                      <p className={tone === "danger" ? "min-w-0 text-[12.5px] text-tone" : "min-w-0 text-[12.5px] text-fg-muted"}>{detailLine(a)}</p>
                    </div>
                  </Reveal>
                );
              })}
            </ol>
          </Panel>
        )}
      </section>
    </main>
  );
}

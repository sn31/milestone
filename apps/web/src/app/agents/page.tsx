import type { Metadata } from "next";
import { eq, inArray } from "drizzle-orm";
import { activePaymentMethod, agentMandates, mandateFundedMinor, milestones, paypalMode } from "@milestone/core";
import { ActionChips, CapFigure, MandatePill, mandateStatus, relativeTo } from "@/components/agent-console-mandate";
import { Button, EmptyState, Money, PageHeader, Panel, Reveal, SectionTitle, StateGlyph } from "@/components/ui";
import { getDb } from "@/lib/db";
import { auditTime, eventGlyph, eventParts, eventTone } from "@/lib/events";
import { formatDate, formatMoney } from "@/lib/format";
import { agentNameOf, loadAgentAudit, loadMandates, type AgentAuditRow } from "@/lib/agent/data";
import { ACTOR_NAMES, getActor } from "@/lib/session";
import { DELEGABLE } from "@/app/api/agents/_shared";
import { AutoFundToggle } from "./_components/auto-fund-toggle";
import { MandateForm } from "./_components/mandate-form";
import { RevokeButton } from "./_components/revoke-button";
import { SavedPayPal, type VaultOutcome } from "./_components/saved-paypal";

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

/** What fundFromVault checks before an agent's charge of the saved PayPal (packages/core mandates.ts fundingAllows). */
const FUNDING_GUARANTEE = [
  { label: "Both of you signed the contract", detail: "you and the freelancer approved it" },
  { label: "Milestone is a draft", detail: "nothing captured or in flight for it" },
  { label: "It is the next one", detail: "every earlier milestone is funded" },
  { label: "Exactly its amount", detail: "in the mandate's currency" },
  { label: "Within the per-milestone cap", detail: "and the total cap, counting all it funded" },
  { label: "Mandate is live", detail: "unexpired, unrevoked, may fund" },
  { label: "Your saved PayPal", detail: "yours, and not removed" },
];

/** Funded so far against the total cap: a 3px track in the funded tone (amber once it is used up). */
function FundMeter({ funded, total, currency }: { funded: number; total: number; currency: string }) {
  const share = total > 0 ? Math.min(1, funded / total) : 1;
  const full = funded >= total;
  return (
    <span data-tone={full ? "held" : "funded"} className="inline-flex min-w-0 items-center gap-3">
      <span
        role="meter"
        aria-label="Funded from saved PayPal against the total cap"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={funded}
        aria-valuetext={`${formatMoney(funded, currency)} of ${formatMoney(total, currency)}`}
        className="relative h-[3px] w-28 shrink-0 overflow-hidden rounded-full bg-hairline-strong"
      >
        <span className="absolute inset-y-0 left-0 rounded-full bg-tone" style={{ width: `${Math.round(share * 1000) / 10}%` }} />
      </span>
      <span className="font-mono text-[12px] whitespace-nowrap text-fg-muted tabular">
        <Money minor={funded} currency={currency} size="s" />
        <span className="text-fg-faint"> of </span>
        <Money minor={total} currency={currency} size="s" />
      </span>
    </span>
  );
}

/** One line of what an agent action did or why it was refused. */
function detailLine(r: AgentAuditRow): string {
  const d = r.detail;
  const reason = typeof d.reason === "string" ? d.reason.replace(/_/g, " ") : null;
  const error = typeof d.error === "string" ? d.error : null;
  if (r.event.endsWith("_refused")) {
    const cur = typeof d.currency === "string" ? d.currency : null;
    if (r.event === "vault.fund_refused" && typeof d.amountMinor === "number" && cur) return `${reason ?? "refused"} · ${formatMoney(d.amountMinor, cur)} not charged`;
    if (typeof d.amountMinor === "number" && typeof d.capMinor === "number" && cur) return `${reason ?? "refused"}: ${formatMoney(d.amountMinor, cur)} over the ${formatMoney(d.capMinor, cur)} cap`;
    return [reason, error].filter(Boolean).join(": ") || "refused";
  }
  const via = d.via === "auto_fund" ? "auto-fund" : d.via === "mcp" ? "MCP" : null;
  if (r.event === "paypal.vault_charge" && typeof d.amountMinor === "number" && typeof d.currency === "string") {
    return `charged saved PayPal ${formatMoney(d.amountMinor, d.currency)}${via ? ` · ${via}` : ""}`;
  }
  if (r.event === "paypal.vault_charge_error") return `charge failed${d.retryable === true ? " (retryable)" : ""}${error ? `: ${error}` : ""}`;
  if (r.event === "agent.autofund") return typeof d.status === "string" && d.status !== "funded" ? `auto-fund · ${d.status.replace(/_/g, " ")}` : "funded the next milestone on release";
  if (r.event === "milestone.funded" && d.source === "vault") return `in escrow from saved PayPal${via ? ` · ${via}` : ""}`;
  const status = typeof d.status === "string" ? d.status.replace(/_/g, " ") : null;
  // Reads (MCP read tools) changed nothing; say what was read rather than "accepted".
  if (r.event === "agent.get_milestone") return status ? `read · milestone in ${status}` : "read";
  if (r.event === "agent.get_ledger") return typeof d.transactions === "number" ? `read · ${d.transactions} ledger transactions` : "read";
  if (r.event === "agent.list_contracts") return typeof d.count === "number" ? `read · ${d.count} contracts` : "read";
  return status ? `accepted · was ${status}` : "accepted";
}

/** The milestone an audit row is about: its column, or for a read (kept off the contract's activity) its detail. */
function milestoneOf(r: AgentAuditRow): string | null {
  if (r.milestoneId) return r.milestoneId;
  return typeof r.detail.milestoneId === "string" ? r.detail.milestoneId : null;
}

/**
 * Agents: the client's mandates (create, see the token once, revoke) and everything their agents did, refusals
 * included. The console at /agents/console runs an agent under one of these mandates.
 */
export default async function AgentsPage({ searchParams }: PageProps<"/agents">) {
  const sp = await searchParams;
  const db = getDb();
  const actor = await getActor();
  const now = new Date().getTime();
  const [mandates, audit, fundRows, savedPm] = await Promise.all([
    loadMandates(db, actor.userId),
    loadAgentAudit(db, actor.userId),
    db
      .select({ id: agentMandates.id, fundCapMinor: agentMandates.fundCapMinor, fundTotalCapMinor: agentMandates.fundTotalCapMinor, autoFundNext: agentMandates.autoFundNext })
      .from(agentMandates)
      .where(eq(agentMandates.userId, actor.userId)),
    actor.role === "client" ? activePaymentMethod(db, actor.userId) : Promise.resolve(null),
  ]);
  // Funding terms and what each vault-funding mandate has charged so far (succeeded and in-flight vault_charge ops).
  const fundTerms = new Map(
    await Promise.all(
      fundRows.map(async (f) => [f.id, { ...f, fundedMinor: f.fundTotalCapMinor !== null ? await mandateFundedMinor(db, f.id) : 0 }] as const),
    ),
  );
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const vaultParam = one(sp.vault);
  const outcome: VaultOutcome | null = vaultParam === "saved" || vaultParam === "cancelled" || vaultParam === "error" ? { vault: vaultParam, reason: one(sp.reason) ?? null } : null;
  const milestoneIds = [...new Set(audit.map(milestoneOf).filter((x): x is string => Boolean(x)))];
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
        <MandateForm defaultName={`${firstName}'s agent`} allowed={DELEGABLE[actor.role]} hasSavedPayPal={savedPm !== null} />
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

      {actor.role === "client" ? (
        <div id="saved-paypal" className="mt-12 grid scroll-mt-24 gap-6 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)] lg:items-start">
          <SavedPayPal
            saved={savedPm ? { id: savedPm.id, payerEmail: savedPm.payerEmail, tokenTail: savedPm.paypalPaymentTokenId.slice(-4), savedOn: formatDate(savedPm.createdAt.toISOString()) } : null}
            outcome={outcome}
            simulated={paypalMode() === "simulated"}
            canSave
          />
          <Panel variant="sunken" as="aside" aria-label="When an agent may fund a milestone">
            <p className="type-label text-fg-faint">An agent funds from your PayPal only when</p>
            <ol className="mt-4 divide-y divide-hairline">
              {FUNDING_GUARANTEE.map((g, i) => (
                <li key={g.label} data-tone="funded" className="flex items-baseline gap-3 py-2.5">
                  <span className="w-5 shrink-0 font-mono text-[11px] text-fg-faint tabular">{String(i + 1).padStart(2, "0")}</span>
                  <span className="min-w-0">
                    <span className="block text-[14px] text-fg">{g.label}</span>
                    <span className="block text-[12.5px] text-fg-faint">{g.detail}</span>
                  </span>
                </li>
              ))}
            </ol>
            <p className="mt-4 border-t border-hairline pt-4 text-[13px] text-fg-muted">
              The money goes into escrow like any funding; releases follow the same rules. No model gets a tool that charges your PayPal.
            </p>
          </Panel>
        </div>
      ) : null}

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
                const terms = fundTerms.get(m.id);
                const vault = terms && terms.fundCapMinor !== null && terms.fundTotalCapMinor !== null && m.actions.includes("fund") ? { ...terms, fundCapMinor: terms.fundCapMinor, fundTotalCapMinor: terms.fundTotalCapMinor } : null;
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
                      {vault ? (
                        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 lg:col-start-2 lg:col-end-[-1]" data-testid="fund-meter">
                          <span className="type-label text-fg-faint">Funds from PayPal</span>
                          <FundMeter funded={vault.fundedMinor} total={vault.fundTotalCapMinor} currency={m.currency} />
                          <span className="font-mono text-[12px] text-fg-faint tabular">
                            up to {formatMoney(vault.fundCapMinor, m.currency)} each{vault.autoFundNext ? " · funds the next milestone on release" : ""}
                          </span>
                          {status === "active" ? <AutoFundToggle id={m.id} on={vault.autoFundNext} agentName={m.agentName} /> : null}
                        </div>
                      ) : null}
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
                        {(() => {
                          const mid = milestoneOf(a);
                          if (mid) return titles.get(mid) ?? mid;
                          return a.event === "agent.list_contracts" ? "all contracts" : "contract";
                        })()}
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

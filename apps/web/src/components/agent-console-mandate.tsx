// Mandate terms, shown on /agents (ledger rows) and beside the console (the summary card). Server-safe.
import type { ReactNode } from "react";
import { Eyebrow, Money, StatePill, cx } from "@/components/ui";
import { formatDate } from "@/lib/format";
import type { MandateSummary } from "@/lib/agent/protocol";

export const ACTION_LABELS: Record<string, string> = {
  read: "Read",
  draft_contract: "Draft contracts",
  fund: "Start funding",
  deliver: "Deliver",
  approve: "Approve releases",
  hold: "Veto and hold",
};

export const ACTION_HINTS: Record<string, string> = {
  read: "Contracts, milestones, verdicts and PayPal transactions.",
  draft_contract: "Drafts you review and sign yourself.",
  fund: "Creates the PayPal order; you approve the payment.",
  deliver: "Submit work on contracts where you are the freelancer.",
  approve: "Only releases the policy already decided (P6), up to the cap.",
  hold: "Veto a release in review, or hold a milestone.",
};

export type MandateStatus = "active" | "revoked" | "expired";

export function mandateStatus(m: Pick<MandateSummary, "revokedAt" | "expiresAt">, now: number): MandateStatus {
  if (m.revokedAt && Date.parse(m.revokedAt) <= now) return "revoked";
  if (Date.parse(m.expiresAt) <= now) return "expired";
  return "active";
}

/** Active reads in the funded tone (it holds delegated authority), revoked in held, expired in draft. */
export function MandatePill({ status }: { status: MandateStatus }) {
  if (status === "active") return <StatePill state="active" label="Active" />;
  if (status === "revoked") return <StatePill state="held" label="Revoked" />;
  return <StatePill state="draft" label="Expired" />;
}

/** "in 29 days", "in 5 hours", "3 days ago". */
export function relativeTo(iso: string | null, now: number): string {
  if (!iso) return "never";
  const ms = Date.parse(iso) - now;
  const abs = Math.abs(ms);
  const [n, unit] = abs >= 86_400_000 ? [Math.round(abs / 86_400_000), "day"] : abs >= 3_600_000 ? [Math.round(abs / 3_600_000), "hour"] : [Math.max(1, Math.round(abs / 60_000)), "minute"];
  const span = `${n} ${unit}${n === 1 ? "" : "s"}`;
  return ms >= 0 ? `in ${span}` : `${span} ago`;
}

export function ActionChips({ actions, className }: { actions: string[]; className?: string }) {
  return (
    <ul className={cx("flex flex-wrap gap-1.5", className)} aria-label="Allowed actions">
      {actions.map((a) => (
        <li key={a} className="rounded-chip border border-hairline-strong px-1.5 py-0.5 font-mono text-[11px] leading-4 text-fg-muted" title={ACTION_HINTS[a]}>
          {ACTION_LABELS[a] ?? a}
        </li>
      ))}
    </ul>
  );
}

export function CapFigure({ m, size = "m" }: { m: Pick<MandateSummary, "approveCapMinor" | "currency" | "actions">; size?: "s" | "m" | "l" }) {
  if (m.approveCapMinor === null || !m.actions.includes("approve")) return <span className="font-mono text-[13px] text-fg-faint">No approvals</span>;
  return <Money minor={m.approveCapMinor} currency={m.currency} size={size} />;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1.5 py-3 first:pt-0 last:pb-0">
      <dt className="type-label text-fg-faint">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}

/** The console's side card: what this agent may do, up to how much, until when. */
export function MandateCard({ m, now, footer }: { m: MandateSummary; now: number; footer?: ReactNode }) {
  const status = mandateStatus(m, now);
  return (
    <div>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <Eyebrow>Mandate</Eyebrow>
          <p className="type-display-s mt-2 truncate text-fg">{m.agentName}</p>
        </div>
        <MandatePill status={status} />
      </div>
      <dl className="mt-4 divide-y divide-hairline border-t border-hairline pt-3">
        <Row label="Approval cap">
          <div className="flex items-baseline gap-2">
            <CapFigure m={m} size="l" />
            {m.approveCapMinor !== null && m.actions.includes("approve") ? <span className="font-mono text-[11px] text-fg-faint">per release</span> : null}
          </div>
        </Row>
        <Row label="May">
          <ActionChips actions={m.actions} />
        </Row>
        <Row label="Expires">
          <p className="font-mono text-[13px] tabular text-fg">
            {formatDate(m.expiresAt)} <span className="text-fg-faint">· {status === "revoked" ? `revoked ${relativeTo(m.revokedAt, now)}` : relativeTo(m.expiresAt, now)}</span>
          </p>
        </Row>
        <Row label="Last used">
          <p className="font-mono text-[13px] tabular text-fg-muted">{relativeTo(m.lastUsedAt, now)}</p>
        </Row>
      </dl>
      {footer ? <div className="mt-4">{footer}</div> : null}
    </div>
  );
}

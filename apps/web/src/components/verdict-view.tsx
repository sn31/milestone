"use client";

import { motion } from "motion/react";
import { useId, useState, type MouseEvent, type ReactNode } from "react";
import type { deliveries, StoredDecision } from "@milestone/core";
import { EvidencePanel, toEvidenceItems, type EvidenceItem } from "@/components/evidence-panel";
import { Button, DUR, EASE, EvidenceChip, Hash, Receipt, ReceiptRow, Stamp, StatePill, cx, verdictTone, type CriterionStatus } from "@/components/ui";
import { toggled } from "@/components/ui/detail-grid";
import { formatDateTime, formatMoney } from "@/lib/format";
import { BASELINE_EVIDENCE_ID, failingTests, firstLine, isFlag, isOwnTests, ownTestsText, parseBaseline, parseFlag } from "@/app/api/milestones/[id]/status/lines";

type DeliveryRow = typeof deliveries.$inferSelect;

/** What the receipt prints of a delivery: no payload (the delivered files are listed by the server, beside it). */
export type VerdictDelivery = Pick<DeliveryRow, "id" | "ref" | "source" | "model" | "result" | "verifiedAt" | "receivedAt" | "verdict" | "evidence" | "suspectedInjection">;

interface CriterionRow {
  criterion_id: string;
  status: string;
  confidence: number;
  evidence_ids: string[];
  rationale: string;
}

function rowsOf(verdict: VerdictDelivery["verdict"]): CriterionRow[] {
  const list = verdict && (verdict as { criteria?: unknown }).criteria;
  return Array.isArray(list) ? (list as CriterionRow[]) : [];
}
const asStatus = (s: string): CriterionStatus => (s === "pass" || s === "fail" ? s : "unclear");

/** The model id the worker records when no model was reachable: the deterministic checks ran, judgment is the client's. */
const CHECKS_ONLY = "deterministic-only";

/** A command's summary without the empty "last lines:" trailer it carries when the command printed nothing. */
const cleanDetail = (text: string) => text.replace(/;?\s*last lines:\s*$/i, "").trim();

/**
 * An upload check's evidence reads "1 file(s) match *.pdf; best style-guide.pdf is pass" and then one line per file with
 * what was measured. The receipt shows the measured lines ("style-guide.pdf · format pdf; 2 page(s) (max 12)").
 */
function measuredDetail(summary: string | undefined): string | null {
  const lines = (summary ?? "").split("\n").slice(1).filter((l) => /\[(pass|fail|unclear)\]/.test(l));
  return lines.length ? lines.map((l) => l.replace(/\s*\[(pass|fail|unclear)\]\s*/, " · ").trim()).join("; ") : null;
}

/** An upload delivery's ref ("upload:2 file(s)") as "2 files". */
function uploadCount(ref: string): string {
  const n = /(\d+)/.exec(ref)?.[1];
  return n ? `${n} file${n === "1" ? "" : "s"}` : ref.replace(/^upload:\s*/, "");
}

/** Without a model the policy's "Could not verify: X" means the client judges X; say that instead of sounding broken. */
const policyReason = (reason: string, checksOnly: boolean) => (checksOnly ? reason.replace(/^Could not verify:\s*/, "Left to the client: ") : reason);

const sentence = (text: string) => {
  const t = text.trim();
  return t ? `${t[0]!.toUpperCase()}${t.slice(1)}${/[.!?]$/.test(t) ? "" : "."}` : "";
};

/**
 * The baseline suite as a receipt row (CLAUDE.md rule 9): the client's tests graded the delivery, and what the overlay
 * restored or removed to make that so, in one line; or why they could not, so a pass is not trusted.
 */
function baselineRow(ev: EvidenceItem | undefined): { inPlace: boolean; label: string; detail: string } | null {
  if (!ev) return null;
  const b = parseBaseline(ev.status, ev.summary);
  if (!b.inPlace) {
    return { inPlace: false, label: "Not graded by the client's tests", detail: `${sentence(b.reason ?? "the client's suite could not be put in place")} The delivery's own tests ran instead, so a pass is not trusted.` };
  }
  const from = b.sha ? `The suite from ${b.sha}${b.firstParent ? " (the delivered commit's parent; no baseline was recorded)" : ""}` : "The client's suite";
  // What the delivery added at test locations was set aside for the graded run (its own tests run separately, below).
  const changes = [b.restored && `restored ${b.restored}`, b.removed && `removed ${b.removed} (added by the delivery)`, ...b.other].filter(Boolean).join("; ");
  return { inPlace: true, label: "Graded by the client's tests", detail: `${from} ran against the delivered code; ${changes || "nothing to restore or remove"}.` };
}

/** The verifier's overall result as a pill: pass reads as released green, partial as partial, fail as danger. */
const RESULT_PILL: Record<string, { state: string; label: string }> = {
  pass: { state: "released", label: "Pass" },
  partial: { state: "partial_released", label: "Partial" },
  fail: { state: "failed", label: "Fail" },
  verifying: { state: "verifying", label: "Verifying" },
};

/** Confidence as a short bar in the criterion's tone, filled once on mount, with the percentage in mono. */
function Confidence({ value }: { value: number }) {
  const pct = Math.max(0, Math.min(1, value));
  return (
    <span className="flex items-center gap-2" title="Verifier confidence">
      <span aria-hidden className="relative h-[3px] w-14 overflow-hidden rounded-full bg-hairline-strong">
        <motion.span
          className="absolute inset-y-0 left-0 rounded-full bg-tone"
          initial={{ width: 0 }}
          animate={{ width: `${pct * 100}%` }}
          transition={{ duration: DUR.count, ease: EASE.glide, delay: 0.15 }}
        />
      </span>
      <span className="w-[4ch] font-mono text-[11px] text-fg-muted tabular">
        {Math.round(pct * 100)}%<span className="sr-only"> confidence</span>
      </span>
    </span>
  );
}

export function VerdictView({
  delivery,
  decision,
  descriptions = {},
  showEvidence = false,
  currency,
  required,
  folded = false,
  attachments,
  kinds = {},
  countersign,
  clientApproved = false,
}: {
  delivery: VerdictDelivery | null;
  decision: StoredDecision | null;
  /** Criterion descriptions by criterion id. */
  descriptions?: Record<string, string>;
  /** Show the delivery's evidence grid under the receipt; the receipt's evidence chips then open its rows. */
  showEvidence?: boolean;
  /** The contract currency, to print the decided amount on the stamp. */
  currency?: string;
  /** Whether each criterion is required, by criterion id; optional ones are marked on the receipt. */
  required?: Record<string, boolean>;
  /**
   * Folded: one summary line (result, criteria passed, the policy stamp) with the full receipt behind a disclosure.
   * Used on stations where the decision is what matters and the receipt is the proof.
   */
  folded?: boolean;
  /** Printed above the receipt when it is open (e.g. the delivered files). */
  attachments?: ReactNode;
  /** Criterion kinds by criterion id (test, file, judgment, ...): printed on each row. */
  kinds?: Record<string, string>;
  /** What happened after the decision (the client's approval or hold), inked under the stamp. */
  countersign?: string | null;
  /**
   * The client approved an ask_client decision and the payout landed: the stamp reads "Client approved" in the released
   * tone (the rule id stays as small text under it) instead of the amber "Ask client".
   */
  clientApproved?: boolean;
}) {
  const items = toEvidenceItems(delivery?.evidence ?? null);
  const byId = new Map<string, EvidenceItem>(items.map((it) => [it.id, it]));
  // Collapsed: the receipt chips and the Evidence toggle open it.
  const [panelOpen, setPanelOpen] = useState(false);
  const [openRows, setOpenRows] = useState<Set<string>>(new Set());
  const [focus, setFocus] = useState<{ id: string | null; n: number }>({ id: null, n: 0 });
  const [unfolded, setUnfolded] = useState(false);
  const foldId = useId();
  const stampAction = decision && clientApproved && decision.action === "ask_client" ? "client_approved" : decision?.action;

  if (!delivery) return <p className="mt-4 font-mono text-[12px] text-fg-faint">No delivery yet.</p>;

  // In the contract's criterion order (descriptions is built from it), so the test row sits under the suite and flag rows.
  const order = Object.keys(descriptions);
  const rank = (id: string) => (order.indexOf(id) < 0 ? order.length : order.indexOf(id));
  const rows = rowsOf(delivery.verdict)
    .map((r, i) => ({ r, i }))
    .sort((a, b) => rank(a.r.criterion_id) - rank(b.r.criterion_id) || a.i - b.i)
    .map(({ r }) => r);
  const result = delivery.result ?? (delivery.verifiedAt ? "none" : "verifying");
  const checksOnly = delivery.model === CHECKS_ONLY;
  // Judgment the agent did not make (no model): the client's call, not an "unclear" that reads like a fault.
  const forClient = (r: CriterionRow) => checksOnly && r.status === "unclear" && !r.evidence_ids?.some((id) => byId.get(id)?.status);
  const clientRows = rows.filter(forClient).length;
  // "Partial" is a money word (part paid, part refunded): only when the decision actually splits the money.
  const neutral = result === "partial" && decision?.action !== "partial";
  const pill = RESULT_PILL[result] ?? { state: result, label: result };
  const passed = rows.filter((r) => r.status === "pass").length;
  const checked = rows.length - clientRows;
  const evidenceShown = showEvidence && items.length > 0;
  const suite = baselineRow(byId.get(BASELINE_EVIDENCE_ID));
  // Gaming hits and other flags on the test criterion: each one is a reason the client decides.
  const flags = items.filter((it) => isFlag({ ...it, criterionId: it.criterion }, (id) => kinds[id]));
  // The informational pass: the freelancer's own tests as delivered, shown but never used for payment.
  const ownTests = items.filter(isOwnTests);
  const resultWord = neutral ? (
    <span className="rounded-chip border border-hairline-strong px-1.5 py-[3px] font-mono text-[10.5px] leading-none tracking-[0.1em] text-fg-muted uppercase tabular">
      {passed} of {checked} passed
    </span>
  ) : null;
  const tally =
    rows.length > 0 ? (
      <span className="font-mono text-[12px] text-fg-muted tabular">
        {neutral ? null : (
          <>
            {passed} of {rows.length}
            <span className="text-fg-faint max-sm:sr-only"> criteria passed</span>
          </>
        )}
        {clientRows > 0 ? (
          <span data-tone="needs" className={cx("text-tone", !neutral && "ml-2")}>
            {neutral ? "" : "· "}
            {clientRows} for the client
          </span>
        ) : null}
      </span>
    ) : null;

  /** A failed test row names the client's tests that failed, from its log evidence. */
  const withFailing = (detail: string, ids: string[]) => {
    const names = ids.flatMap((id) => (byId.get(id)?.status === "fail" && byId.get(id)?.kind === "log" ? failingTests(byId.get(id)!.summary) : []));
    if (!names.length) return detail;
    const shown = names.slice(0, 3).join("; ");
    return `${detail} · failing: ${shown}${names.length > 3 ? ` and ${names.length - 3} more` : ""}`;
  };

  /** A test row a flag made unclear: the client's suite result, then the flags above it (not the flag's text again). */
  const flagIds = new Set(flags.map((f) => f.id));
  const testDetail = (r: CriterionRow) => {
    const n = (r.evidence_ids ?? []).filter((id) => flagIds.has(id)).length;
    if (!n) return null;
    const log = items.find((ev) => ev.criterion === r.criterion_id && ev.kind === "log");
    const ran = log ? `${firstLine(log.summary)}. ` : "";
    return `${ran}Not trusted: ${n === 1 ? "the flag above" : `the ${n} flags above`}, so the client decides.`;
  };

  const toggleRow = (id: string) => setOpenRows((prev) => toggled(prev, id));

  /** A receipt chip was clicked: open the grid, expand that row's log and scroll to it. */
  const reveal = (e: MouseEvent, id: string) => {
    if (!evidenceShown || !byId.has(id)) return;
    e.preventDefault();
    setPanelOpen(true);
    setOpenRows((prev) => new Set(prev).add(id));
    setFocus((f) => ({ id, n: f.n + 1 }));
  };

  const meta = (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
      {delivery.model ? <span>{checksOnly ? "no model · checks only" : delivery.model}</span> : null}
      {delivery.verifiedAt ? <span>{formatDateTime(delivery.verifiedAt)}</span> : <span>received {formatDateTime(delivery.receivedAt)}</span>}
    </span>
  );

  const footer = decision ? (
    <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0 max-w-[52ch]">
        <p className="type-label text-fg-faint">Policy decision</p>
        <p className="mt-2 text-[13px] leading-relaxed text-fg-muted">{policyReason(decision.reason, checksOnly)}</p>
        <p className="mt-2 font-mono text-[11px] text-fg-faint">Decided by the policy rules, not the model.</p>
      </div>
      <Stamp
        action={stampAction ?? decision.action}
        ruleIds={decision.ruleIds}
        note={currency && decision.amountMinor > 0 ? formatMoney(decision.amountMinor, currency) : undefined}
        countersign={countersign ?? undefined}
        className="self-start sm:mr-2 sm:self-end"
      />
    </div>
  ) : null;

  const full = (
    <div className="space-y-4">
      {attachments}
      <Receipt title="Verdict" meta={meta} footer={footer}>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-dashed border-hairline py-4">
          {resultWord ?? <StatePill state={pill.state} label={pill.label} size="md" />}
          {tally}
          {checksOnly ? (
            <span data-tone="needs" className="rounded-chip border border-tone px-1.5 py-[3px] font-mono text-[10.5px] leading-none tracking-[0.08em] text-tone uppercase">
              Checks only · judgment goes to the client
            </span>
          ) : null}
          {delivery.suspectedInjection ? <StatePill state="failed" label="Suspected prompt injection" size="md" /> : null}
          <span className="ml-auto">
            {delivery.source === "upload" ? (
              <span className="rounded-chip border border-hairline px-1.5 py-[3px] font-mono text-[11px] text-fg-muted tabular">
                <span className="text-fg-faint">upload</span> {uploadCount(delivery.ref)}
              </span>
            ) : (
              <Hash value={delivery.ref} label="ref" head={14} tail={6} />
            )}
          </span>
        </div>
        {rows.length === 0 ? (
          <p className="py-4 text-[13px] text-fg-muted">
            {result === "verifying" ? "The agent is checking the delivery. Criteria appear here as they are judged." : "The verifier returned no criteria."}
          </p>
        ) : null}
        {suite ? (
          <ReceiptRow kind="suite" label={suite.label} status={suite.inPlace ? "pass" : "unclear"} statusLabel={suite.inPlace ? "ran" : undefined} detail={suite.detail}>
            <span onClickCapture={(e) => reveal(e, BASELINE_EVIDENCE_ID)} className="inline-flex">
              <EvidenceChip kind="diff" id={BASELINE_EVIDENCE_ID} status={suite.inPlace ? "pass" : "unclear"} href={evidenceShown ? `#evidence-${BASELINE_EVIDENCE_ID}` : undefined} />
            </span>
          </ReceiptRow>
        ) : null}
        {flags.map((ev) => {
          const f = parseFlag(ev.summary);
          return (
            <ReceiptRow
              key={ev.id}
              kind="flag"
              label={
                <>
                  {f.where ? <span className="mr-2 font-mono text-[12.5px] tabular">{f.where}</span> : null}
                  {f.what}
                </>
              }
              status="unclear"
              statusLabel="flag"
              tone="needs"
              detail={
                <>
                  {f.code ? <code className="mr-2 rounded-chip bg-surface-sunken px-1 py-px font-mono text-[12px] text-fg">{f.code}</code> : null}
                  {sentence(f.reason ?? "the client decides")}
                </>
              }
            >
              <span onClickCapture={(e) => reveal(e, ev.id)} className="inline-flex">
                <EvidenceChip kind={ev.kind} id={ev.id} status="unclear" title={ev.summary} href={evidenceShown ? `#evidence-${ev.id}` : undefined} />
              </span>
            </ReceiptRow>
          );
        })}
        {rows.map((r) => {
          const status = asStatus(r.status);
          const client = forClient(r);
          return (
            <ReceiptRow
              key={r.criterion_id}
              kind={kinds[r.criterion_id]}
              label={descriptions[r.criterion_id] ?? r.criterion_id}
              status={status}
              statusLabel={client ? "client" : undefined}
              tone={client ? "needs" : undefined}
              required={required?.[r.criterion_id]}
              meter={checksOnly ? undefined : <Confidence value={r.confidence} />}
              detail={
                client
                  ? "The agent ran the checks only, so this criterion is the client's to judge."
                  : (r.evidence_ids ?? []).map((id) => measuredDetail(byId.get(id)?.summary)).find(Boolean) ?? testDetail(r) ?? withFailing(cleanDetail(r.rationale), r.evidence_ids ?? [])
              }
            >
              {r.evidence_ids?.length
                ? r.evidence_ids.map((id) => {
                    const ev = byId.get(id);
                    const evStatus = ev?.status === "pass" || ev?.status === "fail" || ev?.status === "unclear" ? ev.status : undefined;
                    return (
                      <span key={id} onClickCapture={(e) => reveal(e, id)} className="inline-flex">
                        <EvidenceChip
                          kind={ev?.kind ?? "ref"}
                          id={id}
                          status={evStatus}
                          title={ev ? `${ev.summary}${evidenceShown ? " (open in the evidence log)" : ""}` : undefined}
                          href={evidenceShown && ev ? `#evidence-${id}` : undefined}
                        />
                      </span>
                    );
                  })
                : null}
            </ReceiptRow>
          );
        })}
        {ownTests.map((ev) => {
          const crit = ev.id.slice(4, -"_delivered".length);
          const which = ownTests.length > 1 ? ` (${descriptions[crit] ?? crit})` : "";
          const text = `The freelancer's own tests${which}: ${ownTestsText(ev.summary)}, not used for payment`;
          return (
            <p key={ev.id} className="py-3 pl-7 font-mono text-[11.5px] text-fg-faint">
              {evidenceShown ? (
                <a href={`#evidence-${ev.id}`} onClick={(e) => reveal(e, ev.id)} title={ev.summary} className="underline-offset-2 hover:text-fg-muted hover:underline">
                  {text}
                </a>
              ) : (
                <span title={ev.summary}>{text}</span>
              )}
            </p>
          );
        })}
      </Receipt>

      {evidenceShown ? (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Button variant="ghost" size="sm" onClick={() => setPanelOpen((o) => !o)} aria-expanded={panelOpen} className="-ml-3">
              <svg aria-hidden viewBox="0 0 10 10" className={cx("size-2.5 transition-transform duration-200 ease-glide", panelOpen && "rotate-90")} fill="none" stroke="currentColor" strokeWidth={1.5}>
                <path d="M3.5 1.8 L6.8 5 L3.5 8.2" />
              </svg>
              <span className="type-label">Evidence</span>
              <span className="font-mono text-[12px] text-fg-faint tabular">{items.length}</span>
            </Button>
            <span className="hidden items-center gap-3 font-mono text-[11px] text-fg-faint sm:flex">
              {(["pass", "fail", "unclear"] as const).map((s) => {
                const n = items.filter((it) => it.status === s).length;
                return n ? (
                  <span key={s} data-tone={verdictTone(s)} className="text-tone tabular">
                    {n} {s}
                  </span>
                ) : null;
              })}
              <span className="tabular">{items.filter((it) => !it.status).length} observed</span>
            </span>
          </div>
          {panelOpen ? (
            <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: DUR.reveal, ease: EASE.glide }}>
              <EvidencePanel items={items} open={openRows} onToggle={toggleRow} focusId={focus.id} focusKey={focus.n} criterionLabels={descriptions} />
            </motion.div>
          ) : null}
        </div>
      ) : null}
    </div>
  );

  if (!folded) return <div className="mt-4">{full}</div>;

  const stamp = decision ? (
    <Stamp size="sm" action={stampAction ?? decision.action} ruleIds={decision.ruleIds} note={currency && decision.amountMinor > 0 ? formatMoney(decision.amountMinor, currency) : undefined} />
  ) : null;
  return (
    <div>
      <button
        type="button"
        aria-expanded={unfolded}
        aria-controls={foldId}
        onClick={() => setUnfolded((o) => !o)}
        className={cx(
          "group/fold flex w-full flex-wrap items-center gap-x-2.5 gap-y-2 sm:gap-x-3 rounded-panel border border-hairline bg-surface-sunken px-3.5 py-2.5 text-left sm:px-4",
          "transition-colors duration-200 hover:border-hairline-strong hover:bg-surface-raised",
          unfolded && "rounded-b-none border-b-transparent",
        )}
      >
        <svg aria-hidden viewBox="0 0 10 10" className={cx("size-2.5 shrink-0 text-fg-faint transition-transform duration-200 ease-glide", unfolded && "rotate-90")} fill="none" stroke="currentColor" strokeWidth={1.5}>
          <path d="M3.5 1.8 L6.8 5 L3.5 8.2" />
        </svg>
        <span className="type-label text-fg-muted">Receipt</span>
        {resultWord ?? <StatePill state={pill.state} label={pill.label} />}
        {tally}
        {suite && !suite.inPlace ? <StatePill state="failed" label="Tests not trusted" /> : null}
        {flags.length ? <StatePill state="needs_client" label={`${flags.length} flag${flags.length === 1 ? "" : "s"}`} /> : null}
        {delivery.suspectedInjection ? <StatePill state="failed" label="Suspected injection" /> : null}
        {stamp ? (
          <span className="ml-auto flex items-center gap-2.5">
            {stamp}
            {countersign ? <span className="font-mono text-[10.5px] tracking-[0.08em] text-fg-muted uppercase max-sm:hidden">{countersign}</span> : null}
          </span>
        ) : null}
        <span className="sr-only">{unfolded ? "Hide the full receipt" : "Show the full receipt"}</span>
      </button>
      {unfolded ? (
        <motion.div
          id={foldId}
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: DUR.reveal, ease: EASE.glide }}
          className="rounded-b-panel border border-t-0 border-hairline bg-surface-sunken p-2.5 sm:p-3.5"
        >
          {full}
        </motion.div>
      ) : (
        <div id={foldId} hidden />
      )}
    </div>
  );
}

"use client";

import { motion } from "motion/react";
import { useId, useState, type MouseEvent, type ReactNode } from "react";
import type { deliveries, StoredDecision } from "@milestone/core";
import { EvidencePanel, toEvidenceItems, type EvidenceItem } from "@/components/evidence-panel";
import { Button, DUR, EASE, EvidenceChip, Hash, Receipt, ReceiptRow, Stamp, StatePill, cx, verdictTone, type CriterionStatus } from "@/components/ui";
import { toggled } from "@/components/ui/detail-grid";
import { formatDateTime, formatMoney } from "@/lib/format";

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

/** The tamper check as a receipt row: clean, or what the delivery changed that makes a passing result untrustworthy. */
function tamperRow(ev: EvidenceItem | undefined): { clean: boolean; label: string; detail: string } | null {
  if (!ev) return null;
  const body = ev.summary.replace(/^tamper check:?\s*/i, "");
  if (ev.status === "pass") {
    const n = /(\d+) file\(s\) changed against (.+?);/.exec(body);
    return { clean: true, label: "The delivery left the test machinery alone", detail: n ? `${n[1]} file${n[1] === "1" ? "" : "s"} changed against ${n[2]}; no existing test, script, dependency, lockfile or CI change.` : body };
  }
  const findings = (body.split(/commands run:\s*/)[1] ?? body).split(";").map((f) => f.trim()).filter(Boolean);
  const first = findings[0] ?? body;
  const what = /existing test/.test(first) ? "Existing test changed" : /scripts|dependencies|changed$/.test(first) ? "Test setup changed" : "Not checked";
  return { clean: false, label: `${what}: ${first.replace(/\s*\((existing test|lockfile|CI config|test runner or package manager config|committed node_modules)\)$/, "")}`, detail: `Results not trusted. ${findings.length > 1 ? `Also: ${findings.slice(1).join("; ")}.` : ""}`.trim() };
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
}) {
  const items = toEvidenceItems(delivery?.evidence ?? null);
  const byId = new Map<string, EvidenceItem>(items.map((it) => [it.id, it]));
  // Collapsed: the receipt chips and the Evidence toggle open it.
  const [panelOpen, setPanelOpen] = useState(false);
  const [openRows, setOpenRows] = useState<Set<string>>(new Set());
  const [focus, setFocus] = useState<{ id: string | null; n: number }>({ id: null, n: 0 });
  const [unfolded, setUnfolded] = useState(false);
  const foldId = useId();

  if (!delivery) return <p className="mt-4 font-mono text-[12px] text-fg-faint">No delivery yet.</p>;

  // In the contract's criterion order (descriptions is built from it), so the test row sits under the tamper row.
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
  const tamper = tamperRow(byId.get("evd_tamper_check"));
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
        action={decision.action}
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
        {tamper ? (
          <ReceiptRow
            kind="tamper"
            label={tamper.label}
            status={tamper.clean ? "pass" : "fail"}
            statusLabel={tamper.clean ? "clean" : "flagged"}
            detail={tamper.detail}
          >
            <span onClickCapture={(e) => reveal(e, "evd_tamper_check")} className="inline-flex">
              <EvidenceChip kind="diff" id="evd_tamper_check" status={tamper.clean ? "pass" : "fail"} href={evidenceShown ? "#evidence-evd_tamper_check" : undefined} />
            </span>
          </ReceiptRow>
        ) : null}
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
                  : (r.evidence_ids ?? []).map((id) => measuredDetail(byId.get(id)?.summary)).find(Boolean) ?? cleanDetail(r.rationale)
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
    <Stamp size="sm" action={decision.action} ruleIds={decision.ruleIds} note={currency && decision.amountMinor > 0 ? formatMoney(decision.amountMinor, currency) : undefined} />
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
        {tamper && !tamper.clean ? <StatePill state="failed" label="Tests not trusted" /> : null}
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

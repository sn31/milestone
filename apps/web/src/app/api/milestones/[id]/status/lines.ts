// Pure and client-safe: how the contract page reads a milestone snapshot (no database imports here).
import type { LogLine } from "@/components/ui/log-stream";
import type { ToneKey } from "@/components/ui/states";
import type { MilestoneSnapshot } from "./snapshot";

/** Everything that, when it changes, means the server page would render differently. */
export function signature(s: MilestoneSnapshot): string {
  return [s.status, s.decidedAt, s.reviewEndsAt, s.delivery?.id, s.delivery?.verifiedAt, s.delivery?.evidenceCount, s.auditId, s.pendingOp?.kind, s.pendingOp?.status].join("|");
}

/** What the verifier log knows about a milestone's criteria (from the server page). */
export interface LogCriterion {
  id: string;
  kind: string;
  description: string;
}

/** One verifier log line, plus which criterion it settles (the checklist beside the log ticks when the line is shown). */
export type VerifyLine = Exclude<LogLine, string> & { criterionId?: string; status?: CheckStatus };

/** How a check reads on the verifying station: the evidence status, or "client" for judgment left to the client. */
export type CheckStatus = "pass" | "fail" | "unclear" | "client";

export const CHECK_TONE: Record<CheckStatus, ToneKey> = { pass: "released", fail: "danger", unclear: "needs", client: "needs" };
export const CHECK_WORD: Record<CheckStatus, string> = { pass: "pass", fail: "fail", unclear: "unclear", client: "client" };

/** The model id the worker records when no model was reachable: deterministic checks only, judgment to the client. */
export const CHECKS_ONLY_MODEL = "deterministic-only";

const hhmmss = (iso: string) => iso.slice(11, 19);
const col = (word: string) => word.padEnd(8, " ");
const asCheck = (s: string | null | undefined): CheckStatus | undefined => (s === "pass" || s === "fail" || s === "unclear" ? s : undefined);

/**
 * The first line of an evidence summary without the empty "last lines:" trailer of a command with no output; a pass the
 * tamper check overruled reads "npm test exited 0 · not trusted" (the tamper line above says why).
 */
export function firstLine(summary: string): string {
  // Snapshot summaries arrive with newlines folded to spaces, so the command's output is cut at its "last lines:" label.
  const line = (summary.split("\n")[0] ?? summary).split(/;?\s*last lines:/i)[0]!.trim();
  const overruled = /^tamper check: (.+?), but the result is not trusted/.exec(line);
  return overruled ? `${overruled[1]} · not trusted, see tamper` : line;
}

/** What the tamper check found, in a few words: clean, or the first finding. */
export function tamperText(status: string | null, summary: string): string {
  const s = summary.replace(/^tamper check:?\s*/i, "");
  if (status === "pass") {
    const n = /(\d+) file\(s\) changed/.exec(s)?.[1];
    return `clean${n ? ` · ${n} file${n === "1" ? "" : "s"} changed` : ""}, no test, script, lockfile or CI edits`;
  }
  const findings = s.split(/commands run:\s*/)[1] ?? s;
  return `not trusted · ${findings.split(";")[0]!.trim()}`;
}

/** Event lines in the log's words (the audit vocabulary stays on the activity ledger). */
const EVENT_TEXT: Record<string, { text: string; tone?: ToneKey }> = {
  "milestone.verifying": { text: "agent picked it up · clean checkout, no secrets in the environment" },
  "verdict.stored": { text: "verdict stored on the delivery" },
  "policy.decided": { text: "policy decided · by the rules, not the model" },
  "milestone.review": { text: "→ review window opens", tone: "review" },
  "milestone.needs_client": { text: "→ waiting on the client", tone: "needs" },
  "milestone.held": { text: "→ held in escrow", tone: "held" },
  "verify.refused_needs_operator": { text: "refused: an operator must resolve this milestone first", tone: "danger" },
};

/**
 * The lines that arrive while the agent checks a delivery, after the server's head line (the delivery itself):
 * the verifier picking it up, each check as its evidence lands (tamper check, context, install, each criterion),
 * then the judgment of each criterion with no evidence of its own, then the decision. Lines only ever append as the
 * snapshot fills in, so the log can play them one by one.
 */
export function verifierLines(s: MilestoneSnapshot, criteria: readonly LogCriterion[] = []): VerifyLine[] {
  const events = s.events.filter((e) => !e.event.startsWith("delivery."));
  const verifiedAt = s.delivery?.verifiedAt ?? null;
  const byId = new Map(criteria.map((c) => [c.id, c]));
  const eventLine = (e: MilestoneSnapshot["events"][number]): VerifyLine => {
    const known = EVENT_TEXT[e.event];
    return { at: hhmmss(e.at), text: known?.text ?? e.event, tone: known?.tone };
  };
  const before = verifiedAt ? events.filter((e) => e.at < verifiedAt) : events;
  const after = verifiedAt ? events.filter((e) => e.at >= verifiedAt) : [];

  const lines: VerifyLine[] = before.map(eventLine);
  // Setup runs once, after the tamper check and before the first criterion, on a code delivery (one with a tamper line).
  const code = s.evidence.some((e) => e.id === "evd_tamper_check");
  let installed = false;
  for (const e of s.evidence) {
    const c = e.criterionId ? byId.get(e.criterionId) : undefined;
    const status = asCheck(e.status);
    if (e.id === "evd_tamper_check") {
      lines.push({ text: `${col("tamper")}${tamperText(e.status, e.summary)}`, tone: status === "pass" ? "ok" : "err" });
      continue;
    }
    if (e.criterionId && code && !installed) {
      installed = true;
      const failed = /^setup failed/i.test(e.summary);
      lines.push({ text: `${col("install")}${failed ? "dependencies did not install" : "dependencies installed · lifecycle scripts off"}`, tone: failed ? "err" : undefined });
    }
    if (e.criterionId) {
      const word = status ?? "seen";
      lines.push({
        text: `${col(word)}${(c?.kind ?? e.kind).padEnd(9, " ")}${c?.description ?? e.id} · ${firstLine(e.summary)}`,
        tone: status ? CHECK_TONE[status] : undefined,
        criterionId: e.criterionId,
        status,
      });
      continue;
    }
    if (e.id === "evd_diff") {
      const m = /^(\d+) file\(s\) changed.*?, \+(\d+) -(\d+)/.exec(e.summary);
      lines.push({ text: `${col("context")}${m ? `diff +${m[2]} -${m[3]} across ${m[1]} file${m[1] === "1" ? "" : "s"}` : "diff recorded"}` });
    } else if (e.id === "evd_tree") {
      const n = /^(\d+) file/.exec(e.summary)?.[1];
      lines.push({ text: `${col("context")}${n ? `${n} files in the delivered commit` : "file list recorded"}` });
    } else if (e.id === "evd_commit") {
      lines.push({ text: `${col("context")}commit and delivery text kept as untrusted evidence` });
    } else if (e.kind === "file") {
      lines.push({ text: `${col("file")}${firstLine(e.summary) || e.id}` });
    } else {
      lines.push({ text: `${col(e.kind)}${firstLine(e.summary) || e.id}` });
    }
  }

  if (verifiedAt) {
    const evidenced = new Set(s.evidence.filter((e) => e.criterionId && e.status).map((e) => e.criterionId!));
    const checksOnly = s.delivery?.model === CHECKS_ONLY_MODEL;
    for (const j of s.delivery?.judged ?? []) {
      if (evidenced.has(j.criterionId)) continue;
      const c = byId.get(j.criterionId);
      const what = `${(c?.kind ?? "judgment").padEnd(9, " ")}${c?.description ?? j.criterionId}`;
      if (checksOnly) {
        lines.push({ text: `${col("client")}${what} · judgment goes to the client`, tone: "needs", criterionId: j.criterionId, status: "client" });
      } else {
        const st = asCheck(j.status) ?? "unclear";
        const conf = j.confidence === null ? "" : ` · ${Math.round(j.confidence * 100)}% confident`;
        lines.push({ text: `${col(st)}${what}${conf}`, tone: CHECK_TONE[st], criterionId: j.criterionId, status: st });
      }
    }
  }
  return [...lines, ...after.map(eventLine)];
}

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
/** The model id the showcase seed records on verdicts it wrote without a model (RECORDED_VERDICT_MODEL in core). */
export const RECORDED_MODEL = "recorded-showcase";
/** The rationale prefix the worker stores (still model "deterministic-only") when the model call failed; MODEL_FAILED_RATIONALE in apps/worker/src/jobs/verify.ts. */
export const MODEL_FAILED_RATIONALE = "not judged: the model call failed";

const hhmmss = (iso: string) => iso.slice(11, 19);
const col = (word: string) => word.padEnd(8, " ");
const asCheck = (s: string | null | undefined): CheckStatus | undefined => (s === "pass" || s === "fail" || s === "unclear" ? s : undefined);

/**
 * The first line of an evidence summary without the empty "last lines:" trailer of a command with no output; a pass that
 * ran without the client's suite reads "npm test exited 0 · not trusted, see suite" (the suite line above says why).
 */
export function firstLine(summary: string): string {
  // Snapshot summaries arrive with newlines folded to spaces, so the command's output is cut at its "last lines:" label.
  const line = (summary.split("\n")[0] ?? summary).split(/;?\s*last lines:/i)[0]!.trim();
  const overruled = /^baseline suite: (.+?), but the result is not trusted/.exec(line);
  return overruled ? `${overruled[1]} · not trusted, see suite` : line;
}

/** The baseline-suite evidence item (CLAUDE.md rule 9; the id predates it, when it held the tamper check). */
export const BASELINE_EVIDENCE_ID = "evd_tamper_check";

/** What the baseline-suite item says: whether the client's suite graded the delivery, from where, and what it put back. */
export interface BaselineSuite {
  /** The client's suite was in place for the graded run (status pass). */
  inPlace: boolean;
  /** The baseline commit, short, when the summary names one. */
  sha: string | null;
  /** True when the baseline is only the delivered commit's first parent (no baseline was recorded). */
  firstParent: boolean;
  restored: string;
  removed: string;
  /** The rest of what the overlay did: package.json keys kept, lockfiles dropped. */
  other: string[];
  /** Why the suite could not be put in place (not inPlace). */
  reason: string | null;
}

export function parseBaseline(status: string | null | undefined, summary: string): BaselineSuite {
  const body = summary.replace(/^baseline suite:\s*/i, "").replace(/…$/, "");
  const sha = /\b([0-9a-f]{7,40})\b/.exec(body)?.[1]?.slice(0, 12) ?? null;
  const firstParent = /from the first parent /.test(body);
  if (status !== "pass") {
    const reason = body.split(/;\s*the delivery's own tests run instead/)[0]!.trim();
    return { inPlace: false, sha, firstParent, restored: "", removed: "", other: [], reason: reason || null };
  }
  const parts = body.split(/;\s+/).slice(1);
  const pick = (word: string) => parts.find((p) => p.startsWith(`${word} `))?.slice(word.length + 1) ?? "";
  const other = parts.filter((p) => !/^(restored|removed) /.test(p) && !/^the delivery leaves /.test(p));
  return { inPlace: true, sha, firstParent, restored: pick("restored"), removed: pick("removed"), other, reason: null };
}

/** What the overlay put back or took out, in one line; "" when the delivery left the client's test machinery as it was. */
export function baselineChanges(b: BaselineSuite): string {
  return [b.restored && `restored ${b.restored}`, b.removed && `removed ${b.removed}`, ...b.other].filter(Boolean).join("; ");
}

/** The suite line in the log: where the client's suite came from and what it put back, or why it could not run. */
export function suiteText(b: BaselineSuite): string {
  if (!b.inPlace) return `not in place · ${b.reason ?? "no client suite"}; a pass is not trusted`;
  const from = b.sha ? ` from ${b.sha}${b.firstParent ? " (first parent)" : ""}` : "";
  return `client's tests${from} · ${baselineChanges(b) || "nothing to restore or remove"}`;
}

/** The evidence fields the flag and own-test helpers read (snapshot lines and receipt items both have them). */
interface EvidenceLike {
  id: string;
  kind: string;
  status?: string | null;
  criterionId?: string | null;
}

/**
 * A flag: the gaming scan's hits (evd_gaming_*), and any other unclear diff item on a test or build criterion (new
 * dependencies arrive the same way), but never the baseline-suite item. Each one sends the milestone to the client.
 * kindOf: the criterion's kind, when known (unknown criteria count, the stage only puts these on test or build).
 */
export function isFlag(e: EvidenceLike, kindOf?: (criterionId: string) => string | undefined): boolean {
  if (e.id === BASELINE_EVIDENCE_ID || e.kind !== "diff" || e.status !== "unclear") return false;
  if (e.id.startsWith("evd_gaming_")) return true;
  if (!e.criterionId) return false;
  const k = kindOf?.(e.criterionId);
  return k === undefined || k === "test" || k === "build";
}

/** A flag's summary in parts: "gaming scan: src/a.js:12 reads process.env.CI (env-sniff): if (process.env.CI) {; why". */
export interface Flag {
  /** "src/a.js:12", when the summary names a line. */
  where: string | null;
  /** "reads process.env.CI". */
  what: string;
  /** The flagged source line, when given. */
  code: string | null;
  /** Why it matters, e.g. "the delivered source reacts to the test run itself, ...". */
  reason: string | null;
}

export function parseFlag(summary: string): Flag {
  const text = (summary.split("\n")[0] ?? summary).replace(/^[a-z][\w -]{0,40}?:\s+/i, "").trim();
  // The reason comes last, after the final "; " (the flagged code itself may contain one).
  const cut = text.lastIndexOf("; ");
  const body = cut > 0 ? text.slice(0, cut) : text;
  const reason = cut > 0 ? text.slice(cut + 2).replace(/…$/, "").trim() || null : null;
  const m = /^(\S+:\d+)\s+(.+?)(?:\s+\(([\w-]+)\))?(?::\s+(.*))?$/.exec(body);
  if (m) return { where: m[1]!, what: m[2]!, code: m[4]?.trim() || null, reason };
  const where = /(\S+:\d+)/.exec(body)?.[1] ?? null;
  return { where, what: where ? body.replace(where, "").replace(/^\s*[·:,-]?\s*/, "").trim() || body : body, code: null, reason };
}

/**
 * The names of the failing tests in a test command's output (node --test "✖ name (1.2ms)", mocha "1) name"), first
 * seen first, without the "failing tests:" heading. Empty when the output names none.
 */
export function failingTests(output: string): string[] {
  const names = new Set<string>();
  for (const m of output.matchAll(/^\s*✖ (.+?)(?: \([\d.]+m?s\))?\s*$/gm)) if (!/^failing tests:?$/i.test(m[1]!)) names.add(m[1]!.trim());
  if (!names.size) for (const m of output.matchAll(/^\s+\d+\) (.+?)\s*:?\s*$/gm)) names.add(m[1]!.trim());
  return [...names];
}

/** The informational pass: the delivery's own tests as delivered (evd_<criterion>_delivered, no status, never decides). */
export function isOwnTests(e: EvidenceLike): boolean {
  return /^evd_.+_delivered$/.test(e.id) && !e.status;
}

/**
 * The informational pass in a few words: "12 passing" (node --test, mocha, jest, vitest counts), with failures if any,
 * else what the exit code says (the live log's summaries are cut before the counts).
 */
export function ownTestsText(summary: string): string {
  const last = (re: RegExp) => {
    const all = [...summary.matchAll(re)];
    return all.length ? Number(all.at(-1)![1]) : null;
  };
  const passing = last(/(?:[ℹ#] pass (\d+)\b)/g) ?? last(/\b(\d+) passing\b/g) ?? last(/\b(\d+) passed\b/g);
  const failing = last(/(?:[ℹ#] fail (\d+)\b)/g) ?? last(/\b(\d+) failing\b/g) ?? last(/\b(\d+) failed\b/g);
  if (/\(timed out\)/.test(summary)) return "timed out";
  if (passing !== null) return `${passing} passing${failing ? `, ${failing} failing` : ""}`;
  const code = /exited (-?\d+|null)/.exec(summary)?.[1];
  if (code === undefined) return "ran";
  return code === "0" ? "passing (exit 0)" : `failing (exit ${code})`;
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
 * the verifier picking it up, each check as its evidence lands (the client's suite, context, install, each criterion
 * and its flags, the freelancer's own tests),
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
  // Setup runs once, after the suite line and before the first criterion, on a code delivery (one with a suite line).
  const code = s.evidence.some((e) => e.id === BASELINE_EVIDENCE_ID);
  let installed = false;
  for (const e of s.evidence) {
    const c = e.criterionId ? byId.get(e.criterionId) : undefined;
    const status = asCheck(e.status);
    if (e.id === BASELINE_EVIDENCE_ID) {
      lines.push({ text: `${col("suite")}${suiteText(parseBaseline(e.status, e.summary))}`, tone: status === "pass" ? "ok" : "err" });
      continue;
    }
    if (isOwnTests(e)) {
      lines.push({ text: `${col("own")}the freelancer's own tests · ${ownTestsText(e.summary)}, not used for payment` });
      continue;
    }
    if (e.criterionId && code && !installed) {
      installed = true;
      const failed = /^setup failed/i.test(e.summary);
      lines.push({ text: `${col("install")}${failed ? "dependencies did not install" : "dependencies installed · lifecycle scripts off"}`, tone: failed ? "err" : undefined });
    }
    if (isFlag(e, (id) => byId.get(id)?.kind)) {
      const f = parseFlag(e.summary);
      lines.push({ text: `${col("flag")}${f.where ? `${f.where} ` : ""}${f.what} · the client decides`, tone: "needs", criterionId: e.criterionId ?? undefined, status: e.criterionId ? status : undefined });
      continue;
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

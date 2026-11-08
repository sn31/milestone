/**
 * The PayPal Acceptable Use Policy (AUP) gate on a contract. packages/verify reads the contract (keyword pre-pass, then
 * Claude) and returns flags; this file holds the rule, which is pure, and the rows it reads and writes.
 *
 * The rule (aupStatusFor, aupGate):
 *  - any flag, from the keyword pass or the model, puts the contract in `review`;
 *  - a model call that fails or gives no usable answer also puts it in `review` (fail closed, like a verdict the model
 *    could not give, which is recorded as unclear and left to a person);
 *  - no flag: `clear` when the model read it, `keywords_only` when no model is configured (labelled as such);
 *  - an operator moves `review` to `cleared` or `rejected` on /ops. `rejected` is final.
 * Only clear, keywords_only and cleared let either party sign the contract or anyone (the client, an agent's
 * fund_milestone, the auto-fund rule) fund it. Unchecked (null) and `checking` refuse too.
 *
 * When it runs (ensureAupCheck): when a contract is drafted, after every criteria edit, and before signing or funding
 * whenever the contract text no longer matches the text the last check read (aup_text_hash).
 */
import { createHash } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import type { Db, Executor } from "./db.ts";
import { audit } from "./milestones.ts";
import { contracts, criteria as criteriaTable, milestones } from "./schema.ts";
import type { AupCheckRecord, AupFlag } from "./schemas.ts";

export const AUP_STATUSES = ["checking", "clear", "keywords_only", "review", "cleared", "rejected"] as const;
export type AupStatus = (typeof AUP_STATUSES)[number];

/** The statuses that let a contract be signed and funded. */
export const AUP_ALLOWED: ReadonlySet<string> = new Set<AupStatus>(["clear", "keywords_only", "cleared"]);

/** Audit events of the AUP check. The strings are stored; never change one. */
export const AUP_AUDIT = {
  /** Every finished check: status, mode, model, flag count. */
  checked: "aup.checked",
  /** A check that put the contract in review: its flags (category, section, quote) or the model error. */
  flagged: "aup.flagged",
  cleared: "aup.cleared",
  rejected: "aup.rejected",
  /** A signature or a funding refused by the gate (the vault path audits vault.fund_refused with the same reason). */
  refused: "aup.refused",
} as const;

export type AupRefusal = "aup_unchecked" | "aup_checking" | "aup_review" | "aup_rejected";

export const AUP_REFUSAL_TEXT: Record<AupRefusal, string> = {
  aup_unchecked: "the contract has not been checked against PayPal's Acceptable Use Policy yet; a check has been started, try again in a moment",
  aup_checking: "the contract's PayPal Acceptable Use Policy check is still running; try again in a moment",
  aup_review:
    "the contract was flagged by the PayPal Acceptable Use Policy check and waits for an operator's review on /ops; it cannot be signed or funded until an operator clears it",
  aup_rejected: "an operator rejected this contract under PayPal's Acceptable Use Policy; it cannot be signed or funded",
};

/** The status a finished check gives the contract. Pure. */
export function aupStatusFor(check: Pick<AupCheckRecord, "mode" | "flags">): AupStatus {
  if (check.flags.length > 0 || check.mode === "model_error") return "review";
  return check.mode === "keywords" ? "keywords_only" : "clear";
}

/** Whether a contract in this AUP status may be signed or funded. Pure; anything unknown refuses. */
export function aupGate(contract: { aupStatus: string | null }): { ok: true } | { refused: AupRefusal } {
  const s = contract.aupStatus;
  if (s !== null && AUP_ALLOWED.has(s)) return { ok: true };
  if (s === null) return { refused: "aup_unchecked" };
  if (s === "checking") return { refused: "aup_checking" };
  if (s === "rejected") return { refused: "aup_rejected" };
  return { refused: "aup_review" };
}

/** How the status reads on the contract page and to agents. */
export const AUP_LABEL: Record<AupStatus | "unchecked", string> = {
  unchecked: "not checked",
  checking: "checking",
  clear: "clear",
  keywords_only: "keywords only",
  review: "needs review",
  cleared: "cleared by operator",
  rejected: "rejected by operator",
};

// ---------- The contract text the check reads ----------

/** What the check reads: everything both parties agree to when they sign. */
export interface AupSubject {
  title: string;
  scopeText: string;
  milestones: Array<{ seq: number; title: string; criteria: Array<{ kind: string; description: string; spec?: unknown }> }>;
}

/**
 * The contract as one text: title, scope, then each milestone with its criteria (description and spec). The check
 * quotes from this text, and its hash says whether the contract changed since the last check.
 */
export function aupContractText(s: AupSubject): string {
  const lines = [`Title: ${s.title}`, `Scope: ${s.scopeText}`];
  for (const m of [...s.milestones].sort((a, b) => a.seq - b.seq)) {
    lines.push(`Milestone ${m.seq}: ${m.title}`);
    for (const c of m.criteria) {
      const spec = c.spec && typeof c.spec === "object" && Object.keys(c.spec).length ? ` ${JSON.stringify(c.spec)}` : "";
      lines.push(`- (${c.kind}) ${c.description}${spec}`);
    }
  }
  return lines.join("\n");
}

export function aupTextHash(s: AupSubject): string {
  return createHash("sha256").update(aupContractText(s)).digest("hex");
}

/** Whitespace collapsed, quotes straightened, lower case: how a quote is matched against the contract text. */
export function normalizeForQuote(t: string): string {
  return t.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ").trim().toLowerCase();
}

// ---------- Rows ----------

type ContractRow = typeof contracts.$inferSelect;

/** The contract, what the check reads, and its hash. Null when the contract is missing. */
export async function loadAupSubject(q: Executor, contractId: string, opts: { lock?: boolean } = {}): Promise<{ contract: ContractRow; subject: AupSubject; hash: string } | null> {
  const cq = q.select().from(contracts).where(eq(contracts.id, contractId));
  const [contract] = opts.lock ? await cq.for("update") : await cq;
  if (!contract) return null;
  const ms = await q.select({ id: milestones.id, seq: milestones.seq, title: milestones.title }).from(milestones).where(eq(milestones.contractId, contractId));
  const mine = ms.length
    ? await q.select({ milestoneId: criteriaTable.milestoneId, kind: criteriaTable.kind, description: criteriaTable.description, spec: criteriaTable.spec }).from(criteriaTable).where(inArray(criteriaTable.milestoneId, ms.map((m) => m.id)))
    : [];
  const subject: AupSubject = {
    title: contract.title,
    scopeText: contract.scopeText,
    // Criteria in a stable order (kind, then description) so the hash does not depend on the rows' storage order.
    milestones: ms.map((m) => ({
      seq: m.seq,
      title: m.title,
      criteria: mine
        .filter((c) => c.milestoneId === m.id)
        .map((c) => ({ kind: c.kind, description: c.description, spec: c.spec }))
        .sort((a, b) => a.kind.localeCompare(b.kind) || a.description.localeCompare(b.description) || JSON.stringify(a.spec).localeCompare(JSON.stringify(b.spec))),
    })),
  };
  return { contract, subject, hash: aupTextHash(subject) };
}

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/**
 * Stores a finished check, under the contract row lock: only when the contract text still hashes to `hash` (an edit
 * since then started a newer check) and the contract was not rejected (a rejection is final). Audits aup.checked and,
 * for a review, aup.flagged. Returns the status written, or why nothing was.
 */
export async function recordAupCheck(db: Executor, contractId: string, hash: string, check: AupCheckRecord, actor: string): Promise<AupStatus | "stale" | "rejected" | "missing"> {
  const run = async (tx: Executor) => {
    const now = await loadAupSubject(tx, contractId, { lock: true });
    if (!now) return "missing" as const;
    if (now.contract.aupStatus === "rejected") return "rejected" as const;
    if (now.hash !== hash) return "stale" as const;
    const status = aupStatusFor(check);
    await tx.update(contracts).set({ aupStatus: status, aupTextHash: hash, aupCheck: check, aupCheckedAt: new Date(check.checkedAt) }).where(eq(contracts.id, contractId));
    await audit(tx, { actor, event: AUP_AUDIT.checked, contractId, detail: { status, mode: check.mode, model: check.model, flags: check.flags.length, textHash: hash, policy: check.policy } });
    if (status === "review") {
      await audit(tx, {
        actor,
        event: AUP_AUDIT.flagged,
        contractId,
        detail: {
          mode: check.mode,
          ...(check.error ? { error: cut(check.error, 300) } : {}),
          flags: check.flags.map((f) => ({ category: f.category, section: f.section, quote: cut(f.quote, 200), confidence: f.confidence, source: f.source })),
        },
      });
    }
    return status;
  };
  // A transaction, or a savepoint when the caller is already in one.
  return (db as Db).transaction(run);
}

/** What ensureAupCheck needs from the app: the keyword pass (packages/verify), whether a model is set up, the queue. */
export interface AupDeps {
  keywords: (s: AupSubject) => AupFlag[];
  modelConfigured: () => Promise<boolean>;
  /** Enqueues the model check (the worker's aup job) for this contract text. */
  enqueue: (contractId: string, hash: string) => Promise<unknown>;
  policy: AupCheckRecord["policy"];
}

/**
 * Makes sure the contract's current text has a check, and returns the status to gate on. A rejected contract stays
 * rejected. When the stored hash matches the current text, the stored status stands (including `checking`). Otherwise
 * (never checked, or the text changed since): without a model the keyword pass runs here and its result is stored
 * ("keywords only", or review on a hit); with a model the contract goes to `checking` and the aup job runs the model
 * check (with the keyword pass) in the worker.
 */
export async function ensureAupCheck(db: Executor, contractId: string, deps: AupDeps, actor = "system"): Promise<{ status: AupStatus | null; started: boolean } | null> {
  const s = await loadAupSubject(db, contractId);
  if (!s) return null;
  const current = s.contract.aupStatus as AupStatus | null;
  if (current === "rejected") return { status: "rejected", started: false };
  // A row without a hash (written by hand, e.g. a test fixture) keeps its status: only a changed text re-checks.
  if (current !== null && (s.contract.aupTextHash === null || s.contract.aupTextHash === s.hash)) return { status: current, started: false };

  const flags = deps.keywords(s.subject);
  if (!(await deps.modelConfigured())) {
    const check: AupCheckRecord = { mode: "keywords", model: null, flags, policy: deps.policy, checkedAt: new Date().toISOString() };
    const r = await recordAupCheck(db, contractId, s.hash, check, actor);
    return { status: r === "stale" || r === "missing" ? null : r, started: true };
  }
  await db
    .update(contracts)
    .set({ aupStatus: "checking", aupTextHash: s.hash, aupCheck: { mode: "keywords", model: null, flags, policy: deps.policy, checkedAt: new Date().toISOString() } })
    .where(eq(contracts.id, contractId));
  try {
    await deps.enqueue(contractId, s.hash);
  } catch (e) {
    // No job, so no check would ever finish: back to unchecked, and the next signature or funding attempt starts one.
    await db.update(contracts).set({ aupStatus: null, aupTextHash: null }).where(eq(contracts.id, contractId));
    throw e;
  }
  return { status: "checking", started: true };
}

/**
 * The gate as of now, read inside the caller's transaction (after it locked the contract row): aupGate on the stored
 * status, except that a stored hash which no longer matches the contract text refuses as unchecked (an edit landed
 * after the last check and its re-check has not been stored yet).
 */
export async function aupGateNow(q: Executor, contractId: string): Promise<{ ok: true } | { refused: AupRefusal }> {
  const s = await loadAupSubject(q, contractId);
  if (!s) return { refused: "aup_unchecked" };
  if (s.contract.aupStatus !== "rejected" && s.contract.aupTextHash !== null && s.contract.aupTextHash !== s.hash) return { refused: "aup_unchecked" };
  return aupGate(s.contract);
}

/**
 * An operator's decision on a contract in review: clear (normal flow resumes) or reject (final). Under the contract
 * row lock; only from `review`. Audited as aup.cleared or aup.rejected with the note.
 */
export async function resolveAupReview(db: Executor, contractId: string, action: "clear" | "reject", by: { userId: string; role: string }, note: string): Promise<"ok" | "missing" | "not_in_review"> {
  return (db as Db).transaction(async (tx): Promise<"ok" | "missing" | "not_in_review"> => {
    const [c] = await tx.select().from(contracts).where(eq(contracts.id, contractId)).for("update");
    if (!c) return "missing";
    if (c.aupStatus !== "review") return "not_in_review";
    const at = new Date().toISOString();
    const check: AupCheckRecord | null = c.aupCheck ? { ...c.aupCheck, resolution: { action, by: by.userId, at, note } } : null;
    await tx.update(contracts).set({ aupStatus: action === "clear" ? "cleared" : "rejected", ...(check ? { aupCheck: check } : {}) }).where(eq(contracts.id, contractId));
    await audit(tx, { actor: by.userId, event: action === "clear" ? AUP_AUDIT.cleared : AUP_AUDIT.rejected, contractId, detail: { note, role: by.role, textHash: c.aupTextHash, flags: c.aupCheck?.flags.length ?? 0 } });
    return "ok";
  });
}

/** Audits a signature or funding the gate refused (aup.refused). */
export async function auditAupRefusal(db: Executor, input: { actor: string; contractId: string; milestoneId?: string; action: "sign" | "fund"; reason: AupRefusal; via: string }): Promise<void> {
  await audit(db, { actor: input.actor, event: AUP_AUDIT.refused, contractId: input.contractId, ...(input.milestoneId ? { milestoneId: input.milestoneId } : {}), detail: { action: input.action, reason: input.reason, via: input.via } });
}

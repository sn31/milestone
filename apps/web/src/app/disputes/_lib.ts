import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Db } from "@milestone/core";
import { EVIDENCE_FILE_MAX_BYTES, EVIDENCE_FILE_TYPES, EVIDENCE_TOTAL_MAX_BYTES, type EvidenceFile } from "@milestone/money";
import { uploadRoot, type DraftResponse, type EvidencePack } from "@milestone/verify";

/**
 * A dispute as the audit log tells it. There is no disputes table: dispute.opened (webhook), dispute.drafted (job,
 * carrying the pack and the draft), dispute.evidence_submitted / dispute.claim_accepted (the freelancer),
 * dispute.updated and dispute.resolved (webhook) are its whole record.
 */
export interface DisputeView {
  disputeId: string;
  milestoneId: string;
  contractId: string | null;
  openedAt: string;
  reason: string | null;
  amountMinor: number | null;
  currency: string | null;
  captureId: string | null;
  dueAt: string | null;
  drafted: { at: string; pack: EvidencePack; draft: DraftResponse } | null;
  /** The latest evidence sent to PayPal (`submissions` counts every round). */
  submitted: { at: string; actor: string; text: string; documents: Array<{ name: string; size: number }>; skipped: Array<{ name: string; reason: string }> } | null;
  submissions: number;
  /**
   * A dispute.updated that arrived after the latest submission and leaves the dispute waiting on the seller: PayPal
   * asks for more evidence, and only then may the freelancer send another round.
   */
  moreRequested: { at: string; status: string | null } | null;
  accepted: { at: string; actor: string; note: string } | null;
  resolved: { at: string; outcome: string | null } | null;
  failures: Array<{ at: string; event: string; error: string }>;
  status: DisputeStatus;
}

export type DisputeStatus = "drafting" | "awaiting_response" | "submitted" | "accepted" | "won" | "lost" | "resolved";

const o = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const s = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

export function isOpen(d: Pick<DisputeView, "status">): boolean {
  return d.status !== "won" && d.status !== "lost" && d.status !== "resolved";
}

/** Disputes on these contracts (or the one dispute), newest first. */
export async function loadDisputes(db: Db, where: { contractIds?: string[]; disputeId?: string }): Promise<DisputeView[]> {
  if (where.contractIds && where.contractIds.length === 0) return [];
  const rows = await db.query.auditLog.findMany({
    where: (t, { and, inArray, like, sql }) =>
      and(
        like(t.event, "dispute.%"),
        where.contractIds ? inArray(t.contractId, where.contractIds) : undefined,
        where.disputeId ? sql`${t.detail}->>'disputeId' = ${where.disputeId}` : undefined,
      ),
    orderBy: (t, { asc }) => [asc(t.createdAt), asc(t.id)],
  });
  const byId = new Map<string, DisputeView>();
  for (const r of rows) {
    const d = o(r.detail);
    const id = s(d.disputeId);
    if (!id) continue;
    const at = r.createdAt.toISOString();
    if (r.event === "dispute.opened") {
      if (!r.milestoneId || byId.has(id)) continue;
      byId.set(id, {
        disputeId: id,
        milestoneId: r.milestoneId,
        contractId: r.contractId,
        openedAt: at,
        reason: s(d.reason),
        amountMinor: typeof d.amountMinor === "number" ? d.amountMinor : null,
        currency: s(d.currency),
        captureId: s(d.captureId),
        dueAt: s(d.dueAt),
        drafted: null,
        submitted: null,
        submissions: 0,
        moreRequested: null,
        accepted: null,
        resolved: null,
        failures: [],
        status: "drafting",
      });
      continue;
    }
    const v = byId.get(id);
    if (!v) continue;
    if (r.event === "dispute.drafted" && !v.drafted && d.pack && d.draft) v.drafted = { at, pack: d.pack as EvidencePack, draft: d.draft as DraftResponse };
    else if (r.event === "dispute.evidence_submitted") {
      v.submissions += 1;
      v.moreRequested = null;
      v.submitted = {
        at,
        actor: r.actor,
        text: s(d.text) ?? "",
        documents: (Array.isArray(d.documents) ? d.documents : []).map(o).map((x) => ({ name: s(x.name) ?? "", size: typeof x.size === "number" ? x.size : 0 })),
        skipped: (Array.isArray(d.skipped) ? d.skipped : []).map(o).map((x) => ({ name: s(x.name) ?? "", reason: s(x.reason) ?? "" })),
      };
    } else if (r.event === "dispute.updated") {
      const status = s(d.status);
      if (v.submitted && (status === null || status === "WAITING_FOR_SELLER_RESPONSE")) v.moreRequested = { at, status };
    } else if (r.event === "dispute.claim_accepted" && !v.accepted) v.accepted = { at, actor: r.actor, note: s(d.note) ?? "" };
    else if (r.event === "dispute.resolved" && !v.resolved) v.resolved = { at, outcome: s(d.outcome) };
    else if (r.event === "dispute.evidence_failed" || r.event === "dispute.accept_failed") v.failures.push({ at, event: r.event, error: s(d.error) ?? "" });
  }
  for (const v of byId.values()) v.status = statusOf(v);
  return [...byId.values()].sort((a, b) => (a.openedAt < b.openedAt ? 1 : a.openedAt > b.openedAt ? -1 : 0));
}

function statusOf(v: DisputeView): DisputeStatus {
  if (v.resolved) {
    if (v.resolved.outcome === "RESOLVED_SELLER_FAVOUR") return "won";
    if (v.resolved.outcome === "RESOLVED_BUYER_FAVOUR" || v.resolved.outcome === "ACCEPTED" || v.accepted) return "lost";
    return "resolved";
  }
  if (v.accepted) return "accepted";
  // Another round only after PayPal asked for more evidence (dispute.updated after the latest submission).
  if (v.submitted && !(v.moreRequested && v.drafted)) return "submitted";
  return v.drafted ? "awaiting_response" : "drafting";
}

// ---------- Attachments ----------

export interface Attachment {
  name: string;
  size: number | null;
  mime: string | null;
  /** True when the file goes to PayPal as a document; otherwise `reason` says why it is only listed. */
  attach: boolean;
  reason: string | null;
}

/** Resolves an upload path inside UPLOAD_DIR, refusing anything that escapes it (as the files route does). */
async function uploadPath(path: string): Promise<string | null> {
  const root = await realpath(uploadRoot()).catch(() => null);
  if (!root) return null;
  const real = await realpath(resolve(root, path)).catch(() => null);
  const rel = real ? relative(root, real) : "..";
  if (!real || rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) return null;
  return real;
}

/**
 * Which delivered files go to PayPal with the response: uploaded files of a type PayPal takes (PDF, PNG, JPEG, GIF),
 * present on disk, each and all together within 10 MB. The rest are named in the pack only.
 */
export async function planAttachments(pack: EvidencePack | null | undefined): Promise<Attachment[]> {
  const out: Attachment[] = [];
  let total = 0;
  for (const f of pack?.files ?? []) {
    const base = { name: f.name, size: f.size, mime: f.mime };
    if (f.origin !== "upload" || !f.path) {
      out.push({ ...base, attach: false, reason: "in the repository" });
      continue;
    }
    if (!f.mime || !EVIDENCE_FILE_TYPES.has(f.mime)) {
      out.push({ ...base, attach: false, reason: "type PayPal does not accept" });
      continue;
    }
    const real = await uploadPath(f.path);
    const size = real ? await stat(real).then((x) => x.size).catch(() => null) : null;
    if (size === null) {
      out.push({ ...base, attach: false, reason: "not on disk" });
      continue;
    }
    if (size > EVIDENCE_FILE_MAX_BYTES || total + size > EVIDENCE_TOTAL_MAX_BYTES) {
      out.push({ ...base, size, attach: false, reason: "over PayPal's 10 MB limit" });
      continue;
    }
    total += size;
    out.push({ ...base, size, attach: true, reason: null });
  }
  return out;
}

/** Reads the planned attachments, checking each against the sha256 recorded at delivery. */
export async function readAttachments(pack: EvidencePack | null | undefined): Promise<{ files: Array<EvidenceFile & { sha256: string }>; skipped: Array<{ name: string; reason: string }> }> {
  const plan = await planAttachments(pack);
  const files: Array<EvidenceFile & { sha256: string }> = [];
  const skipped: Array<{ name: string; reason: string }> = [];
  for (const a of plan) {
    const f = pack?.files.find((x) => x.name === a.name);
    if (!a.attach || !f?.path || !a.mime) {
      skipped.push({ name: a.name, reason: a.reason ?? "not attached" });
      continue;
    }
    const real = await uploadPath(f.path);
    const bytes = real ? await readFile(real).catch(() => null) : null;
    if (!bytes) {
      skipped.push({ name: a.name, reason: "not on disk" });
      continue;
    }
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (f.sha256 && f.sha256 !== sha256) {
      skipped.push({ name: a.name, reason: "changed since delivery" });
      continue;
    }
    files.push({ name: a.name, bytes: new Uint8Array(bytes), mime: a.mime, sha256 });
  }
  return { files, skipped };
}

const REASONS: Record<string, string> = {
  MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED: "Not as described",
  MERCHANDISE_OR_SERVICE_NOT_RECEIVED: "Not received",
  UNAUTHORISED: "Unauthorised payment",
  CREDIT_NOT_PROCESSED: "Credit not processed",
  DUPLICATE_TRANSACTION: "Duplicate transaction",
  INCORRECT_AMOUNT: "Incorrect amount",
  PAYMENT_BY_OTHER_MEANS: "Paid by other means",
  CANCELED_RECURRING_BILLING: "Cancelled recurring billing",
  PROBLEM_WITH_REMITTANCE: "Problem with remittance",
  OTHER: "Other",
};

export function reasonLabel(reason: string | null): string {
  if (!reason) return "Reason not given";
  return REASONS[reason] ?? reason.toLowerCase().replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

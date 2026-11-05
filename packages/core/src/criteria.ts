/**
 * Editing a drafted contract's release conditions before both parties sign. The rules are the contract compiler's
 * (packages/verify/src/compiler.ts validateContract) applied to one edit: every milestone keeps at least one
 * deterministic criterion, criterion ids are unique, kinds are known and each spec is checkable for its kind. Pure: the
 * criteria route and the editor's tests run the same code.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { CriterionKind, DETERMINISTIC_KINDS, UploadCriterionSpec } from "./schemas.ts";

export const CRITERIA_AUDIT = {
  /** Every accepted edit, with the milestone's criteria before and after. */
  edited: "contract.criteria_edited",
  /** An edit made after one party had approved: both approvals are cleared, both sign again. */
  approvalsCleared: "contract.approvals_cleared",
} as const;

/** One criterion as stored (criteria table), with its milestone. */
export interface EditableCriterion {
  id: string;
  milestoneId: string;
  kind: string;
  description: string;
  spec: Record<string, unknown>;
  required: boolean;
}

export interface CriteriaEditError {
  milestoneId?: string;
  criterionId?: string;
  field?: "id" | "kind" | "description" | "spec" | "milestone" | "order";
  message: string;
}

export type CriteriaEditResult = { ok: true } | { ok: false; errors: CriteriaEditError[] };

export const DESCRIPTION_MAX = 300;
export const SPEC_TEXT_MAX = 300;

const KIND_WORDS = "tests, build, file, upload, visual or judgment";

const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** Whether a repository path stays inside the repository: relative, no "..", no backslashes or control characters. */
export function isRepoPath(p: string): boolean {
  if (!p || p.startsWith("/") || p.startsWith("~") || /[\\\0-\x1f]/.test(p)) return false;
  return !p.split("/").some((seg) => seg === "..");
}

/**
 * Whether test and build commands are limited to the hosted demo's allowlist: on only with DEMO_MODE=1 (the public demo
 * on Render), where anyone can edit a contract's criteria and the worker would otherwise run any line with `sh -c`.
 */
export function commandsRestricted(env: Record<string, string | undefined> = process.env): boolean {
  return env.DEMO_MODE?.trim() === "1";
}

/** A script name for `npm run`: letters, digits, ":", "_" and "-", not starting with "-". */
const SCRIPT_NAME = /^[A-Za-z0-9:_][A-Za-z0-9:_-]*$/;
/** A relative .js/.mjs path for `node`: segments of letters, digits, ".", "_" and "-", none starting with "." or "-". */
const NODE_SCRIPT = /^(?:\.\/)?(?:[A-Za-z0-9_][A-Za-z0-9._-]*\/)*[A-Za-z0-9_][A-Za-z0-9._-]*\.m?js$/;

/**
 * Whether a test or build command is on the hosted demo's allowlist: exactly `npm test`, `npm run build`,
 * `npm run <script>` or `node <relative .js/.mjs path>`, single-spaced, with no shell metacharacters, options, absolute
 * or parent paths. An allowed command is its own argv split on single spaces, so the worker runs it without a shell.
 */
export function isAllowedDemoCommand(command: string): boolean {
  const parts = command.split(" ");
  if (parts.some((p) => p === "")) return false;
  const [bin, a, b, ...rest] = parts;
  if (rest.length) return false;
  if (bin === "npm" && a === "test" && b === undefined) return true;
  if (bin === "npm" && a === "run" && b !== undefined) return SCRIPT_NAME.test(b);
  if (bin === "node" && a !== undefined && b === undefined) return NODE_SCRIPT.test(a);
  return false;
}

/**
 * The spec problems of one criterion, in plain words; empty when the spec is checkable for its kind. With
 * `restrictCommands` (default: DEMO_MODE=1, see commandsRestricted) a test or build command must be on the demo allowlist.
 */
export function specErrors(kind: string, spec: Record<string, unknown>, opts: { restrictCommands?: boolean } = {}): string[] {
  switch (kind) {
    case "test":
    case "build": {
      const command = text(spec.command);
      if (!command) return [`Give the command to run, such as ${kind === "test" ? "npm test" : "npm run build"}.`];
      if (/[\r\n]/.test(String(spec.command))) return ["The command must fit on one line."];
      if (command.length > SPEC_TEXT_MAX) return [`The command is longer than ${SPEC_TEXT_MAX} characters.`];
      if ((opts.restrictCommands ?? commandsRestricted()) && !isAllowedDemoCommand(command)) {
        return ["On this demo a check can only run npm test, npm run <script> or node <file>.js, with no options or shell characters."];
      }
      return [];
    }
    case "file": {
      const path = text(spec.path);
      if (!path) return ["Give the file that must exist, such as README.md."];
      if (!isRepoPath(path)) return ["The file must be a path inside the repository, without a leading / or ..."];
      if (path.length > SPEC_TEXT_MAX) return [`The path is longer than ${SPEC_TEXT_MAX} characters.`];
      return [];
    }
    case "upload": {
      const pattern = spec.pattern;
      const empty = Array.isArray(pattern) ? pattern.every((p) => !text(p)) : !text(pattern);
      if (empty) return ["Give a file pattern, such as *.pdf or *.{svg,png}."];
      const parsed = UploadCriterionSpec.safeParse(spec);
      if (!parsed.success) return [`The upload checks are not valid: ${parsed.error.issues.map((i) => `${i.path.join(".") || "spec"} ${i.message}`.toLowerCase()).join("; ")}.`];
      return [];
    }
    case "visual": {
      const steps = spec.steps;
      if (steps !== undefined && (!Array.isArray(steps) || steps.some((s) => !text(s)))) return ["Each page step must be a line of text, such as: open /."];
      return [];
    }
    case "judgment":
      return [];
    default:
      return [];
  }
}

/**
 * Validates a contract's criteria after an edit. `milestones` are the contract's milestones; `criteria` is the whole
 * list after the edit (every milestone's, so ids are checked for uniqueness across the contract, as the compiler does).
 */
export function validateCriteriaEdit(
  contract: { id: string },
  milestones: ReadonlyArray<{ id: string; seq: number; contractId?: string }>,
  criteria: ReadonlyArray<EditableCriterion>,
  opts: { restrictCommands?: boolean } = {},
): CriteriaEditResult {
  const errors: CriteriaEditError[] = [];
  const known = new Map(milestones.filter((m) => m.contractId === undefined || m.contractId === contract.id).map((m) => [m.id, m]));
  const seen = new Set<string>();
  for (const c of criteria) {
    const at = { milestoneId: c.milestoneId, criterionId: c.id };
    if (!known.has(c.milestoneId)) errors.push({ ...at, field: "milestone", message: "This check belongs to a milestone that is not on this contract." });
    if (!text(c.id)) errors.push({ ...at, field: "id", message: "Every check needs an id." });
    else if (seen.has(c.id)) errors.push({ ...at, field: "id", message: `Two checks share the id ${c.id}.` });
    seen.add(c.id);
    const kind = CriterionKind.safeParse(c.kind);
    if (!kind.success) {
      errors.push({ ...at, field: "kind", message: `Pick a kind: ${KIND_WORDS}.` });
      continue;
    }
    const description = text(c.description);
    if (!description) errors.push({ ...at, field: "description", message: "Say what this check confirms." });
    else if (description.length > DESCRIPTION_MAX) errors.push({ ...at, field: "description", message: `Keep the description under ${DESCRIPTION_MAX} characters.` });
    if (!c.spec || typeof c.spec !== "object" || Array.isArray(c.spec)) errors.push({ ...at, field: "spec", message: "The check's settings are missing." });
    else for (const message of specErrors(c.kind, c.spec, opts)) errors.push({ ...at, field: "spec", message });
    if (typeof c.required !== "boolean") errors.push({ ...at, field: "spec", message: "Say whether the check is required." });
  }
  for (const m of [...known.values()].sort((a, b) => a.seq - b.seq)) {
    const mine = criteria.filter((c) => c.milestoneId === m.id);
    if (!mine.some((c) => DETERMINISTIC_KINDS.has(c.kind as CriterionKind))) {
      errors.push({
        milestoneId: m.id,
        field: "milestone",
        message: `Milestone ${m.seq} needs at least one automatic check (tests, build, a file or an upload). A reviewer's judgment alone cannot release money.`,
      });
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true };
}

// ---------- Operations (PATCH /api/contracts/[id]/criteria) ----------

const Spec = z.record(z.string(), z.unknown());
const NewCriterion = z.object({
  kind: z.string(),
  description: z.string(),
  spec: Spec.default({}),
  required: z.boolean().default(true),
});

export const CriteriaOp = z.discriminatedUnion("op", [
  z.object({ op: z.literal("add"), criterion: NewCriterion }),
  z.object({ op: z.literal("remove"), criterionId: z.string().min(1) }),
  z.object({
    op: z.literal("update"),
    criterionId: z.string().min(1),
    patch: z.object({ description: z.string().optional(), kind: z.string().optional(), spec: Spec.optional(), required: z.boolean().optional() }),
  }),
  z.object({ op: z.literal("reorder"), order: z.array(z.string().min(1)) }),
]);
export type CriteriaOp = z.infer<typeof CriteriaOp>;

/** The PATCH body: one milestone, one operation or several applied in order. */
export const CriteriaEditBody = z.union([
  z.object({ milestoneId: z.string().min(1), operations: z.array(CriteriaOp).min(1).max(50) }),
  z.intersection(z.object({ milestoneId: z.string().min(1) }), CriteriaOp).transform(({ milestoneId, ...op }) => ({ milestoneId, operations: [op as CriteriaOp] })),
]);
export type CriteriaEditBody = z.infer<typeof CriteriaEditBody>;

/** Trims the text fields a spec carries (command, path, pattern) so " npm test " and "npm test" are the same check. */
export function normalizeSpec(kind: string, spec: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...spec };
  for (const key of ["command", "path"] as const) if (typeof out[key] === "string") out[key] = (out[key] as string).trim();
  if (typeof out.pattern === "string") out.pattern = out.pattern.trim();
  if (kind === "visual" && Array.isArray(out.steps)) out.steps = out.steps.map((s) => (typeof s === "string" ? s.trim() : s));
  return out;
}

/**
 * Applies operations to one milestone's criteria (in their order) and returns the list after them, or the errors of
 * operations that name a missing criterion or a reorder that is not a permutation. `newId` mints ids for added checks.
 * Validation of the result is validateCriteriaEdit's job.
 */
export function applyCriteriaOps(
  milestoneId: string,
  current: ReadonlyArray<EditableCriterion>,
  ops: ReadonlyArray<CriteriaOp>,
  newId: () => string,
): { ok: true; criteria: EditableCriterion[] } | { ok: false; errors: CriteriaEditError[] } {
  let list = current.map((c) => ({ ...c, spec: { ...c.spec } }));
  const errors: CriteriaEditError[] = [];
  for (const op of ops) {
    if (op.op === "add") {
      const c = op.criterion;
      list.push({ id: newId(), milestoneId, kind: c.kind, description: c.description.trim(), spec: normalizeSpec(c.kind, c.spec), required: c.required });
    } else if (op.op === "remove") {
      if (!list.some((c) => c.id === op.criterionId)) errors.push({ milestoneId, criterionId: op.criterionId, message: "That check is not on this milestone any more." });
      list = list.filter((c) => c.id !== op.criterionId);
    } else if (op.op === "update") {
      const i = list.findIndex((c) => c.id === op.criterionId);
      const cur = list[i];
      if (!cur) {
        errors.push({ milestoneId, criterionId: op.criterionId, message: "That check is not on this milestone any more." });
        continue;
      }
      const kind = op.patch.kind ?? cur.kind;
      // A new kind starts from an empty spec unless the edit brings one: a command is not a file path.
      const spec = op.patch.spec ?? (kind === cur.kind ? cur.spec : {});
      list[i] = {
        ...cur,
        kind,
        description: op.patch.description !== undefined ? op.patch.description.trim() : cur.description,
        spec: normalizeSpec(kind, spec),
        required: op.patch.required ?? cur.required,
      };
    } else {
      const ids = list.map((c) => c.id);
      const same = op.order.length === ids.length && new Set(op.order).size === ids.length && op.order.every((id) => ids.includes(id));
      if (!same) {
        errors.push({ milestoneId, field: "order", message: "The new order must list every check on this milestone once." });
        continue;
      }
      const at = new Map(list.map((c) => [c.id, c]));
      list = op.order.map((id) => at.get(id)!);
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, criteria: list };
}

/**
 * Whether a contract's criteria may still change: only while it is a draft that both parties have not yet signed and
 * no milestone holds money. Returns null when editable, else the reason it is locked.
 */
export function criteriaLock(
  contract: { status: string; clientApprovedAt: Date | null; freelancerApprovedAt: Date | null },
  milestones: ReadonlyArray<{ status: string }>,
): null | "both_approved" | "not_draft" | "milestone_funded" {
  if (contract.clientApprovedAt && contract.freelancerApprovedAt) return "both_approved";
  if (contract.status !== "draft") return "not_draft";
  if (milestones.some((m) => m.status !== "draft")) return "milestone_funded";
  return null;
}

/**
 * A short fingerprint of what the parties are signing: every criterion's milestone, id, kind, wording, spec and
 * required flag, in a fixed order. The approve form carries the one the page was rendered with; an approval sent after
 * the criteria changed is not recorded (the approve route's lock check), so nobody signs checks they have not seen.
 */
export function criteriaVersion(criteria: ReadonlyArray<EditableCriterion>): string {
  const rows = [...criteria]
    .sort((a, b) => (a.milestoneId === b.milestoneId ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.milestoneId < b.milestoneId ? -1 : 1))
    .map((c) => [c.milestoneId, c.id, c.kind, c.description, stable(c.spec), c.required]);
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex").slice(0, 16);
}

/** JSON with object keys sorted, so the same spec always hashes the same (jsonb does not keep key order). */
function stable(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, stable((v as Record<string, unknown>)[k])]));
  return v;
}

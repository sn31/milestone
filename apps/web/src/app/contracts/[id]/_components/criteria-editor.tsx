"use client";

import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent, type ReactNode } from "react";
import type { CriteriaEditError, CriteriaOp } from "@milestone/core";
import { Button, cx, Panel, inputClass } from "@/components/ui";
import { thrownText } from "@/lib/api-client";
import { checksSummary } from "../../_components/criteria-list";

export interface EditorCriterion {
  id: string;
  kind: string;
  description: string;
  spec: Record<string, unknown>;
  required: boolean;
}

export interface EditorMilestone {
  id: string;
  seq: number;
  title: string;
  criteria: EditorCriterion[];
}

/** The kinds a party can pick, in the words the select shows. The first four can release money on their own. */
const KINDS: Array<{ kind: string; label: string }> = [
  { kind: "test", label: "Tests pass" },
  { kind: "build", label: "Build succeeds" },
  { kind: "file", label: "File exists" },
  { kind: "upload", label: "Uploaded file" },
  { kind: "visual", label: "Page check" },
  { kind: "judgment", label: "Reviewer judgment" },
];

/** The one spec field each kind asks for: its key, plain label and an example. */
const SPEC_FIELD: Record<string, { key: "command" | "path" | "pattern" | "steps"; label: string; placeholder: string } | undefined> = {
  test: { key: "command", label: "Command to run", placeholder: "npm test" },
  build: { key: "command", label: "Command to run", placeholder: "npm run build" },
  file: { key: "path", label: "File that must exist", placeholder: "README.md" },
  upload: { key: "pattern", label: "File pattern", placeholder: "*.pdf" },
  visual: { key: "steps", label: "Steps on the page, one per line", placeholder: "open /\nexpect text Welcome" },
};

/** The spec as one line of mono text for the row ("npm test", "README.md", "*.pdf"), or null. */
function specText(c: Pick<EditorCriterion, "kind" | "spec">): string | null {
  const s = c.spec;
  if (c.kind === "test" || c.kind === "build") return typeof s.command === "string" ? s.command : null;
  if (c.kind === "file") return typeof s.path === "string" ? s.path : null;
  if (c.kind === "upload") return Array.isArray(s.pattern) ? s.pattern.join(", ") : typeof s.pattern === "string" ? s.pattern : null;
  if (c.kind === "visual") return Array.isArray(s.steps) ? s.steps.join(" · ") : null;
  return null;
}

/** The upload checks beyond the pattern, in words ("pdf · at most 12 pages · contains Typography"). */
function uploadExtras(spec: Record<string, unknown>): string | null {
  const bits: string[] = [];
  if (typeof spec.format === "string") bits.push(spec.format);
  if (typeof spec.minWidth === "number") bits.push(`at least ${spec.minWidth}px wide`);
  if (typeof spec.minHeight === "number") bits.push(`at least ${spec.minHeight}px high`);
  if (typeof spec.maxPages === "number") bits.push(`at most ${spec.maxPages} pages`);
  if (typeof spec.minWords === "number") bits.push(`at least ${spec.minWords} words`);
  if (typeof spec.minBytes === "number") bits.push(`at least ${spec.minBytes} bytes`);
  if (Array.isArray(spec.mustContain) && spec.mustContain.length) bits.push(`contains ${spec.mustContain.join(", ")}`);
  return bits.length ? bits.join(" · ") : null;
}

interface Draft {
  kind: string;
  description: string;
  /** The text of the kind's spec field (steps one per line). */
  specValue: string;
  required: boolean;
}

const draftOf = (c: EditorCriterion): Draft => ({
  kind: c.kind,
  description: c.description,
  specValue: c.kind === "visual" ? (Array.isArray(c.spec.steps) ? c.spec.steps.join("\n") : "") : (specText(c) ?? ""),
  required: c.required,
});

/** The spec a draft stands for. An upload keeps its other checks (format, pages, ...) while its kind is unchanged. */
function specOf(d: Draft, original?: EditorCriterion): Record<string, unknown> {
  const field = SPEC_FIELD[d.kind];
  const base = original && original.kind === d.kind && d.kind === "upload" ? { ...original.spec } : {};
  if (!field) return base;
  if (field.key === "steps") {
    const steps = d.specValue.split("\n").map((s) => s.trim()).filter(Boolean);
    return { ...(original?.kind === "visual" ? original.spec : { url_from: "deploy" }), steps };
  }
  return { ...base, [field.key]: d.specValue };
}

type Reply = { ok: true } | { ok: false; message: string | null; errors: CriteriaEditError[] };

async function send(contractId: string, milestoneId: string, operations: CriteriaOp[]): Promise<Reply> {
  try {
    const res = await fetch(`/api/contracts/${contractId}/criteria`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ milestoneId, operations }),
    });
    if (res.ok) return { ok: true };
    const body = (await res.json().catch(() => null)) as { error?: string; errors?: CriteriaEditError[] } | null;
    if (res.status === 409) return { ok: false, message: "Both parties have signed or money is in escrow, so the checks are fixed now. Reload to see them.", errors: [] };
    if (res.status === 422 && body?.errors?.length) return { ok: false, message: null, errors: body.errors };
    return { ok: false, message: body?.error ?? `The edit was not saved (${res.status}).`, errors: [] };
  } catch (e) {
    return { ok: false, message: thrownText(e, "The edit was not saved."), errors: [] };
  }
}

function FieldErrors({ errors }: { errors: string[] }) {
  if (!errors.length) return null;
  return (
    <div role="alert" className="grid gap-1">
      {errors.map((m) => (
        <p key={m} className="text-[13px] text-state-danger">
          {m}
        </p>
      ))}
    </div>
  );
}

const fieldErrors = (errors: CriteriaEditError[], field: CriteriaEditError["field"] | "other") =>
  errors.filter((e) => (field === "other" ? !e.field || e.field === "id" || e.field === "milestone" || e.field === "order" : e.field === field)).map((e) => e.message);

/** The inline form for one check: wording, kind, the kind's spec field, required. */
function CheckForm({
  initial,
  original,
  errors,
  busy,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial: Draft;
  original?: EditorCriterion;
  errors: CriteriaEditError[];
  busy: boolean;
  submitLabel: string;
  onSubmit: (d: Draft) => void;
  onCancel: () => void;
}) {
  const id = useId();
  const [d, setD] = useState<Draft>(initial);
  const field = SPEC_FIELD[d.kind];
  const extras = d.kind === "upload" && original?.kind === "upload" ? uploadExtras(original.spec) : null;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSubmit(d);
  };
  return (
    <form onSubmit={submit} className="grid gap-4 px-4 py-4">
      <div className="grid gap-2">
        <label htmlFor={`${id}-desc`} className="type-label text-fg-faint">
          What this check confirms
        </label>
        <input id={`${id}-desc`} className={inputClass} value={d.description} maxLength={300} onChange={(e) => setD({ ...d, description: e.target.value })} autoComplete="off" />
        <FieldErrors errors={fieldErrors(errors, "description")} />
      </div>
      <div className="grid items-start gap-4 sm:grid-cols-[200px_minmax(0,1fr)]">
        <div className="grid gap-2">
          <label htmlFor={`${id}-kind`} className="type-label text-fg-faint">
            Kind
          </label>
          <select id={`${id}-kind`} className={inputClass} value={d.kind} onChange={(e) => setD({ ...d, kind: e.target.value, specValue: e.target.value === initial.kind ? initial.specValue : "" })}>
            {KINDS.map((k) => (
              <option key={k.kind} value={k.kind}>
                {k.label}
              </option>
            ))}
          </select>
          <FieldErrors errors={fieldErrors(errors, "kind")} />
        </div>
        <div className="grid gap-2">
          {field ? (
            <>
              <label htmlFor={`${id}-spec`} className="type-label text-fg-faint">
                {field.label}
              </label>
              {field.key === "steps" ? (
                <textarea id={`${id}-spec`} rows={3} className={cx(inputClass, "font-mono text-[13.5px]")} placeholder={field.placeholder} value={d.specValue} onChange={(e) => setD({ ...d, specValue: e.target.value })} />
              ) : (
                <input
                  id={`${id}-spec`}
                  className={cx(inputClass, "font-mono text-[13.5px]")}
                  placeholder={field.placeholder}
                  value={d.specValue}
                  maxLength={300}
                  spellCheck={false}
                  autoComplete="off"
                  onChange={(e) => setD({ ...d, specValue: e.target.value })}
                />
              )}
              {extras ? <p className="text-[13px] text-fg-faint">Also checks: {extras}</p> : null}
            </>
          ) : (
            <>
              <p className="type-label text-fg-faint">How it is checked</p>
              <p className="py-2 text-[13px] text-fg-muted">A reviewer judges this from the delivery. It cannot release money on its own.</p>
            </>
          )}
          <FieldErrors errors={fieldErrors(errors, "spec")} />
        </div>
      </div>
      <FieldErrors errors={fieldErrors(errors, "other")} />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="flex cursor-pointer items-center gap-2.5 text-[13.5px] text-fg">
          <input type="checkbox" className="accent-[var(--fg)]" checked={d.required} onChange={(e) => setD({ ...d, required: e.target.checked })} />
          Required to release
        </label>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" variant="secondary" size="sm" disabled={busy}>
            {busy ? "Saving" : submitLabel}
          </Button>
        </div>
      </div>
    </form>
  );
}

function Arrow({ up }: { up?: boolean }) {
  return (
    <svg aria-hidden viewBox="0 0 10 10" className="size-2.5" fill="none" stroke="currentColor" strokeWidth={1.4}>
      <path d={up ? "M2 6.5 L5 3.5 L8 6.5" : "M2 3.5 L5 6.5 L8 3.5"} />
    </svg>
  );
}

function MilestoneChecks({ contractId, milestone }: { contractId: string; milestone: EditorMilestone }) {
  const router = useRouter();
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<CriteriaEditError[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  /** Which row a refusal belongs to: the one being edited, or the one whose remove/move was refused. */
  const [errorAt, setErrorAt] = useState<string | null>(null);
  const list = milestone.criteria;

  async function run(at: string, operations: CriteriaOp[], after?: () => void) {
    setBusy(true);
    setErrors([]);
    setMessage(null);
    setErrorAt(at);
    const r = await send(contractId, milestone.id, operations);
    setBusy(false);
    if (r.ok) {
      setErrorAt(null);
      after?.();
      router.refresh();
      return;
    }
    setErrors(r.errors);
    setMessage(r.message);
  }

  const move = (i: number, by: -1 | 1) => {
    const order = list.map((c) => c.id);
    const j = i + by;
    [order[i], order[j]] = [order[j]!, order[i]!];
    void run(list[i]!.id, [{ op: "reorder", order }]);
  };

  // A refusal shows on the row that was acted on (its own errors and the milestone's); errors naming another check
  // show under the milestone header.
  const rowErrors = (cid: string) => (errorAt === cid ? errors.filter((e) => !e.criterionId || e.criterionId === cid) : []);
  const headErrors = errors.filter((e) => e.criterionId && e.criterionId !== errorAt && errorAt !== "new");
  const rowMessage = (cid: string) => (errorAt === cid ? message : null);

  return (
    <li className="grid gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 className="flex items-baseline gap-3">
          <span className="font-mono text-[11px] text-fg-faint tabular">{String(milestone.seq).padStart(2, "0")}</span>
          <span className="type-display-s text-fg">{milestone.title}</span>
        </h3>
        <p className="font-mono text-[11px] text-fg-faint tabular">{checksSummary(list)}</p>
      </div>
      <FieldErrors errors={headErrors.map((e) => e.message)} />
      <div className="overflow-hidden rounded-panel border border-hairline bg-surface-sunken">
        <ol className="divide-y divide-dashed divide-hairline">
          {list.map((c, i) => {
            const spec = specText(c);
            const mine = rowErrors(c.id);
            if (editing === c.id) {
              return (
                <li key={c.id} className="bg-surface-raised/40">
                  <CheckForm
                    initial={draftOf(c)}
                    original={c}
                    errors={mine}
                    busy={busy}
                    submitLabel="Save check"
                    onCancel={() => {
                      setEditing(null);
                      setErrors([]);
                    }}
                    onSubmit={(d) =>
                      void run(c.id, [{ op: "update", criterionId: c.id, patch: { description: d.description, kind: d.kind, spec: specOf(d, c), required: d.required } }], () => setEditing(null))
                    }
                  />
                  {rowMessage(c.id) ? <p className="px-4 pb-4 text-[13px] text-state-danger">{rowMessage(c.id)}</p> : null}
                </li>
              );
            }
            return (
              <li key={c.id} className="grid grid-cols-[16px_minmax(0,1fr)] gap-x-3 px-4 py-3">
                <span aria-hidden className="mt-[3px] grid size-4 place-items-center rounded-chip border border-hairline-strong text-fg-faint">
                  <span className="font-mono text-[8.5px] leading-none tabular">{i + 1}</span>
                </span>
                <div className="grid min-w-0 gap-1.5">
                  <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-start sm:gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-[14px] leading-snug text-fg">
                        <span className="type-label mr-2 text-[10px] text-fg-faint">{c.kind}</span>
                        {c.description}
                      </p>
                      {spec ? <p className="mt-1 font-mono text-[12.5px] break-all text-fg-muted">{spec}</p> : null}
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <span className={cx("mr-2 font-mono text-[10.5px] tracking-[0.1em] uppercase", c.required ? "text-fg-muted" : "text-fg-faint")}>{c.required ? "required" : "optional"}</span>
                      <Button variant="ghost" size="sm" className="w-8 px-0" aria-label={`Move "${c.description}" up`} disabled={busy || i === 0} onClick={() => move(i, -1)}>
                        <Arrow up />
                      </Button>
                      <Button variant="ghost" size="sm" className="w-8 px-0" aria-label={`Move "${c.description}" down`} disabled={busy || i === list.length - 1} onClick={() => move(i, 1)}>
                        <Arrow />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        onClick={() => {
                          setEditing(c.id);
                          setErrors([]);
                          setErrorAt(c.id);
                        }}
                      >
                        Edit
                      </Button>
                      <Button variant="ghost" size="sm" disabled={busy} onClick={() => void run(c.id, [{ op: "remove", criterionId: c.id }])}>
                        Remove
                      </Button>
                    </div>
                  </div>
                  <FieldErrors errors={mine.map((e) => e.message)} />
                  {rowMessage(c.id) ? <p className="text-[13px] text-state-danger">{rowMessage(c.id)}</p> : null}
                </div>
              </li>
            );
          })}
          {editing === "new" ? (
            <li className="bg-surface-raised/40">
              <CheckForm
                initial={{ kind: "test", description: "", specValue: "", required: true }}
                errors={errorAt === "new" ? errors : []}
                busy={busy}
                submitLabel="Add check"
                onCancel={() => {
                  setEditing(null);
                  setErrors([]);
                }}
                onSubmit={(d) => void run("new", [{ op: "add", criterion: { kind: d.kind, description: d.description, spec: specOf(d), required: d.required } }], () => setEditing(null))}
              />
              {errorAt === "new" && message ? <p className="px-4 pb-4 text-[13px] text-state-danger">{message}</p> : null}
            </li>
          ) : (
            <li className="px-4 py-2">
              <Button
                variant="ghost"
                size="sm"
                className="-ml-2"
                disabled={busy}
                onClick={() => {
                  setEditing("new");
                  setErrors([]);
                  setErrorAt("new");
                }}
              >
                + Add a check
              </Button>
            </li>
          )}
        </ol>
      </div>
    </li>
  );
}

/**
 * The release conditions as both parties can still change them: shown under the signatures while the contract is a
 * draft. Each milestone's checks are an editable list; every save goes to PATCH /api/contracts/[id]/criteria, which
 * validates it with the compiler's rules and clears any approval already given.
 */
export function CriteriaEditor({ contractId, milestones, signedBy }: { contractId: string; milestones: EditorMilestone[]; signedBy: string[] }): ReactNode {
  const titleId = useId();
  return (
    <Panel as="section" aria-labelledby={titleId} className="grid gap-6">
      <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between md:gap-8">
        <div>
          <p className="type-label text-fg-faint">Before signing</p>
          <h2 id={titleId} className="type-display-m mt-2 text-fg">
            Release conditions
          </h2>
          <p className="mt-2 max-w-[60ch] text-[14px] text-fg-muted">
            Either party can reword, add or remove checks until both sign. Each milestone keeps at least one automatic check: tests, a build, a file or an upload.
          </p>
        </div>
        <div data-tone="needs" className="shrink-0 md:text-right">
          <p className="flex items-center gap-2 font-mono text-[11px] tracking-[0.08em] text-tone uppercase md:justify-end">
            <span aria-hidden className="size-1.5 rounded-full bg-tone" />
            Editing clears both approvals
          </p>
          {signedBy.length ? <p className="mt-1.5 text-[13px] text-fg-muted">{signedBy.join(" and ")} signed already; any edit means both sign again.</p> : null}
        </div>
      </div>
      <ol className="grid gap-8">
        {milestones.map((m) => (
          <MilestoneChecks key={m.id} contractId={contractId} milestone={m} />
        ))}
      </ol>
    </Panel>
  );
}

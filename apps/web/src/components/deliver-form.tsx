"use client";

import { useId, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Button, Field, inputClass, cx } from "@/components/ui";
import { postJson, thrownText } from "@/lib/api-client";

const MAX_FILES = 10;
const MAX_MB = 20;

/** A delivery that is in and waiting for the verifier to pick it up. */
export interface PendingDelivery {
  deliveryId: string;
  /** The repository ref for a commit delivery; null for files. */
  ref: string | null;
}

/**
 * The freelancer's delivery: upload files (design files, PDFs, images, documents) and/or point at a commit in a
 * repository. Both start verification. Once a delivery is in, the form gives way to a "waiting for the verifier" note
 * straight away (from the response here, or `pending` from the server after a reload) while the page polls the
 * milestone and moves to the verifying state when the worker picks it up.
 */
export function DeliverForm(props: {
  milestoneId: string;
  files: boolean;
  repo: boolean;
  defaultRepoUrl?: string | null;
  accept?: string | null;
  resubmit?: boolean;
  /** The latest delivery when it has no verdict yet. */
  pending?: PendingDelivery | null;
  /** The release conditions (a bare CriteriaList), folded behind the header's "checks" toggle. */
  conditions?: ReactNode;
  /** "3 checks · 2 required", printed on that toggle. */
  conditionsSummary?: string;
}) {
  const router = useRouter();
  const uid = useId();
  const [busy, setBusy] = useState<"files" | "repo" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  // What this form just delivered; shown until the page moves on (verifying) or the freelancer asks to deliver again.
  const [sent, setSent] = useState<{ deliveryId: string; text: string } | null>(null);
  // The freelancer chose to deliver something else while the last delivery was still waiting.
  const [again, setAgain] = useState<string | null>(null);
  const [repoUrl, setRepoUrl] = useState(props.defaultRepoUrl ?? "");
  const [ref, setRef] = useState("main");
  const [picked, setPicked] = useState<File[]>([]);

  const waitingId = sent?.deliveryId ?? props.pending?.deliveryId ?? null;
  const waiting = waitingId !== null && waitingId !== again;

  async function send(kind: "files" | "repo", url: string, data: FormData | { repoUrl: string; ref: string }) {
    setBusy(kind);
    setError(null);
    setDone(null);
    try {
      const res = await postJson<{ deliveryId?: string; sha?: string; duplicate?: boolean; files?: unknown[] }>(url, data);
      const body = res.body;
      if (!res.ok) {
        setError(res.error);
        if (res.status === 409) router.refresh();
        return;
      }
      setPicked([]);
      if (body?.duplicate) {
        // The same commit was delivered before: no new delivery, and verification already ran (or is running) on it.
        setDone(`Commit ${body.sha?.slice(0, 12) ?? ""} was already delivered; nothing new to verify.`);
      } else if (body?.deliveryId) {
        const n = Array.isArray(body.files) ? body.files.length : 0;
        setSent({
          deliveryId: body.deliveryId,
          text: kind === "repo" && body.sha ? `Delivered commit ${body.sha.slice(0, 12)}.` : `Delivered ${n > 0 ? `${n} file${n === 1 ? "" : "s"}` : "the files"}.`,
        });
        setAgain(null);
      } else {
        setDone("Delivered; verification queued.");
      }
      // The re-render finds the delivery without a verdict and starts polling the milestone (see LiveRefresh).
      router.refresh();
    } catch (e) {
      setError(thrownText(e));
    } finally {
      setBusy(null);
    }
  }

  if (waiting) {
    const what = sent?.deliveryId === waitingId ? sent.text : props.pending?.ref ? `Delivered ${props.pending.ref}.` : "Delivered.";
    return (
      <section data-tone="verifying" aria-label="Delivered, waiting for the verifier" className="overflow-hidden rounded-panel border border-dashed border-tone">
        <div className="grid gap-3 px-4 py-4 sm:px-5">
          <p role="status" className="flex items-baseline gap-2.5 text-[13.5px] leading-relaxed text-fg">
            <span aria-hidden className="size-1.5 shrink-0 translate-y-[-1px] animate-pulse-dot rounded-full bg-tone" />
            <span className="min-w-0">
              {what} Waiting for the verifier to pick it up; this page moves to verifying on its own.
            </span>
          </p>
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 pl-4 font-mono text-[11px] text-fg-faint tabular">
            <span>delivery {waitingId}</span>
            <button
              type="button"
              onClick={() => setAgain(waitingId)}
              className="cursor-pointer rounded-control tracking-[0.08em] text-fg-muted uppercase underline decoration-hairline-strong underline-offset-4 transition-colors duration-200 hover:text-fg hover:decoration-fg"
            >
              Deliver something else
            </button>
          </p>
        </div>
      </section>
    );
  }

  function uploadFiles(e: React.FormEvent) {
    e.preventDefault();
    if (picked.length === 0) return setError("Choose at least one file.");
    if (picked.length > MAX_FILES) return setError(`At most ${MAX_FILES} files.`);
    const big = picked.find((f) => f.size > MAX_MB * 1024 * 1024);
    if (big) return setError(`${big.name} is larger than ${MAX_MB} MB.`);
    const form = new FormData();
    for (const f of picked) form.append("files", f);
    void send("files", `/api/milestones/${props.milestoneId}/upload`, form);
  }

  function deliverRepo(e: React.FormEvent) {
    e.preventDefault();
    void send("repo", `/api/milestones/${props.milestoneId}/deliver`, { repoUrl, ref });
  }

  const header = (
    <>
      <p className="type-label text-fg">{props.resubmit ? "Resubmit for verification" : "Deliver"}</p>
      {props.conditions ? (
        <span className="ml-auto flex items-center gap-2 font-mono text-[11px] text-fg-muted tabular">
          <span className="max-sm:hidden">Checks this delivery must pass</span>
          <span className="text-fg-faint">{props.conditionsSummary}</span>
          <svg aria-hidden viewBox="0 0 10 10" className="size-2.5 shrink-0 text-fg-faint transition-transform duration-200 ease-glide group-open/deliver:rotate-90" fill="none" stroke="currentColor" strokeWidth={1.5}>
            <path d="M3.5 1.8 L6.8 5 L3.5 8.2" />
          </svg>
        </span>
      ) : (
        <p className="text-[13px] text-fg-muted">The agent checks every condition above; the money stays in escrow meanwhile.</p>
      )}
    </>
  );
  return (
    <section data-tone="verifying" aria-label="Deliver this milestone" className="overflow-hidden rounded-panel border border-dashed border-hairline-strong">
      {props.conditions ? (
        <details className="group/deliver border-b border-dashed border-hairline-strong">
          <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 transition-colors duration-200 hover:bg-surface-raised sm:px-5 [&::-webkit-details-marker]:hidden">
            {header}
          </summary>
          <div className="border-t border-dashed border-hairline bg-surface-sunken">{props.conditions}</div>
        </details>
      ) : (
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-dashed border-hairline-strong px-4 py-3 sm:px-5">{header}</div>
      )}
      <div className="grid gap-5 px-4 py-4 sm:px-5 sm:py-5">
        {props.files ? (
          <form onSubmit={uploadFiles} className="grid gap-3">
            <Field
              label="Files"
              htmlFor={`${uid}-files`}
              hint={`Up to ${MAX_FILES} files, ${MAX_MB} MB each${props.accept ? ` · ${acceptLabel(props.accept)}` : ""}`}
            >
              <input
                id={`${uid}-files`}
                type="file"
                multiple
                onChange={(e) => setPicked(Array.from(e.target.files ?? []))}
                disabled={busy !== null}
                className={cx(
                  inputClass,
                  "cursor-pointer border-dashed py-2.5 text-[13px] text-fg-muted",
                  "file:mr-3 file:cursor-pointer file:rounded-chip file:border file:border-hairline-strong file:bg-surface-raised file:px-2.5 file:py-1 file:font-mono file:text-[11px] file:tracking-[0.08em] file:text-fg file:uppercase",
                )}
              />
            </Field>
            {picked.length > 0 ? (
              <ul className="grid gap-1 font-mono text-[11.5px] text-fg-muted tabular">
                {picked.map((f) => (
                  <li key={`${f.name}-${f.size}`} className="flex items-baseline gap-2">
                    <span className="min-w-0 truncate">{f.name}</span>
                    <span aria-hidden className="leader" />
                    <span className="shrink-0 text-fg-faint">{Math.ceil(f.size / 1024)} KB</span>
                  </li>
                ))}
              </ul>
            ) : null}
            <div>
              <Button type="submit" variant="primary" disabled={busy !== null} aria-busy={busy === "files"}>
                {busy === "files" ? "Uploading..." : "Upload and verify"}
              </Button>
            </div>
          </form>
        ) : null}
        {props.files && props.repo ? (
          <p aria-hidden className="flex items-center gap-3 font-mono text-[10.5px] tracking-[0.12em] text-fg-faint uppercase">
            <span className="h-px flex-1 bg-hairline" />
            or a commit
            <span className="h-px flex-1 bg-hairline" />
          </p>
        ) : null}
        {props.repo ? (
          <form onSubmit={deliverRepo} className="grid items-end gap-3 lg:grid-cols-[minmax(0,1fr)_auto]">
            <div className="grid items-start gap-3 sm:grid-cols-[minmax(0,1fr)_160px]">
              <Field label="Repository" htmlFor={`${uid}-repo`}>
                <input
                  id={`${uid}-repo`}
                  className={cx(inputClass, "font-mono text-[13px]")}
                  value={repoUrl}
                  onChange={(e) => setRepoUrl(e.target.value)}
                  // scripts/demo/beats.mjs finds this field by its placeholder: keep the two in step.
                  placeholder="https://github.com/you/repo.git"
                  required
                  disabled={busy !== null}
                />
              </Field>
              <Field label="Branch or commit" htmlFor={`${uid}-ref`}>
                <input
                  id={`${uid}-ref`}
                  className={cx(inputClass, "font-mono text-[13px]")}
                  value={ref}
                  onChange={(e) => setRef(e.target.value)}
                  placeholder="main"
                  disabled={busy !== null}
                />
              </Field>
            </div>
            <div>
              <Button type="submit" variant={props.files ? "secondary" : "primary"} disabled={busy !== null} aria-busy={busy === "repo"}>
                {busy === "repo" ? "Resolving..." : "Deliver commit"}
              </Button>
            </div>
          </form>
        ) : null}
        {done ? (
          <p role="status" data-tone="verifying" className="flex items-center gap-2 text-[13px] text-tone">
            <span aria-hidden className="size-1.5 animate-pulse-dot rounded-full bg-tone" />
            {done}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-[13px] text-state-danger">
            {error}
          </p>
        ) : null}
      </div>
    </section>
  );
}

/** The criteria's file patterns ("*.{svg,png}, *.pdf") as words a person reads: "SVG, PNG or PDF". */
function acceptLabel(accept: string): string {
  const exts = [...accept.matchAll(/\*\.(\{[^}]+\}|\w+)/g)]
    .flatMap((m) => m[1]!.replace(/[{}]/g, "").split(","))
    .map((e) => e.trim().toUpperCase())
    .filter((e, i, all) => e && all.indexOf(e) === i);
  if (exts.length === 0) return accept;
  return exts.length === 1 ? exts[0]! : `${exts.slice(0, -1).join(", ")} or ${exts.at(-1)}`;
}

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

const MAX_FILES = 10;
const MAX_MB = 20;

const input = "w-full rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900";
const primary = "rounded-lg bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-zinc-700 disabled:cursor-wait disabled:opacity-50 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200";

/**
 * The freelancer's delivery: upload files (design files, PDFs, images, documents) and/or point at a commit in a
 * repository. Both start verification; the page refreshes to show the verifying state.
 */
export function DeliverForm(props: { milestoneId: string; files: boolean; repo: boolean; defaultRepoUrl?: string | null; accept?: string | null }) {
  const router = useRouter();
  const [busy, setBusy] = useState<"files" | "repo" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [repoUrl, setRepoUrl] = useState(props.defaultRepoUrl ?? "");
  const [ref, setRef] = useState("main");
  const [picked, setPicked] = useState<File[]>([]);

  async function send(kind: "files" | "repo", req: () => Promise<Response>) {
    setBusy(kind);
    setError(null);
    setDone(null);
    try {
      const res = await req();
      const body = (await res.json().catch(() => null)) as { error?: string; deliveryId?: string; sha?: string } | null;
      if (!res.ok) {
        setError(body?.error ?? `request failed (${res.status})`);
        if (res.status === 409) router.refresh();
        return;
      }
      setDone(kind === "repo" && body?.sha ? `Delivered commit ${body.sha.slice(0, 12)}; verification queued.` : "Files delivered; verification queued.");
      setPicked([]);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "request failed");
    } finally {
      setBusy(null);
    }
  }

  function uploadFiles(e: React.FormEvent) {
    e.preventDefault();
    if (picked.length === 0) return setError("Choose at least one file.");
    if (picked.length > MAX_FILES) return setError(`At most ${MAX_FILES} files.`);
    const big = picked.find((f) => f.size > MAX_MB * 1024 * 1024);
    if (big) return setError(`${big.name} is larger than ${MAX_MB} MB.`);
    const form = new FormData();
    for (const f of picked) form.append("files", f);
    void send("files", () => fetch(`/api/milestones/${props.milestoneId}/upload`, { method: "POST", body: form }));
  }

  function deliverRepo(e: React.FormEvent) {
    e.preventDefault();
    void send("repo", () =>
      fetch(`/api/milestones/${props.milestoneId}/deliver`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repoUrl, ref }),
      }),
    );
  }

  return (
    <div className="mt-3 space-y-4 rounded-lg border border-emerald-200 bg-emerald-50/60 p-4 text-sm dark:border-emerald-900 dark:bg-emerald-950/40">
      <p className="font-medium">Deliver this milestone</p>
      {props.files ? (
        <form onSubmit={uploadFiles} className="space-y-2">
          <label className="block text-zinc-600 dark:text-zinc-400">
            Files (up to {MAX_FILES}, {MAX_MB} MB each){props.accept ? `: ${props.accept}` : ""}
            <input
              type="file"
              multiple
              className="mt-1 block w-full text-sm"
              onChange={(e) => setPicked(Array.from(e.target.files ?? []))}
              disabled={busy !== null}
            />
          </label>
          {picked.length > 0 ? (
            <ul className="text-xs text-zinc-500">
              {picked.map((f) => (
                <li key={`${f.name}-${f.size}`}>{f.name} ({Math.ceil(f.size / 1024)} KB)</li>
              ))}
            </ul>
          ) : null}
          <button type="submit" className={primary} disabled={busy !== null}>
            {busy === "files" ? "Uploading..." : "Upload and verify"}
          </button>
        </form>
      ) : null}
      {props.repo ? (
        <form onSubmit={deliverRepo} className="space-y-2">
          <label className="block text-zinc-600 dark:text-zinc-400">
            Repository (https URL or local path)
            <input className={`${input} mt-1`} value={repoUrl} onChange={(e) => setRepoUrl(e.target.value)} placeholder="https://github.com/you/repo.git" required disabled={busy !== null} />
          </label>
          <label className="block text-zinc-600 dark:text-zinc-400">
            Branch, tag or commit
            <input className={`${input} mt-1 font-mono`} value={ref} onChange={(e) => setRef(e.target.value)} placeholder="main" disabled={busy !== null} />
          </label>
          <button type="submit" className={primary} disabled={busy !== null}>
            {busy === "repo" ? "Resolving..." : "Deliver commit"}
          </button>
        </form>
      ) : null}
      {done ? <p className="text-emerald-700 dark:text-emerald-400">{done}</p> : null}
      {error ? <p role="alert" className="text-rose-700 dark:text-rose-400">{error}</p> : null}
    </div>
  );
}

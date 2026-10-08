"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function ResolveForm({ milestoneId, disabled }: { milestoneId: string; disabled: boolean }) {
  const router = useRouter();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`/api/ops/${milestoneId}/resolve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ note }),
      });
      if (!res.ok) setErr(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `failed (${res.status})`);
      else router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <input
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Resolution note"
        aria-label="Resolution note"
        disabled={disabled || busy}
        className="w-72 rounded border border-zinc-300 px-2 py-1 text-sm dark:border-zinc-700 dark:bg-transparent"
      />
      <button
        type="button"
        onClick={submit}
        disabled={disabled || busy || note.trim() === ""}
        className="rounded border border-zinc-300 px-3 py-1 text-sm hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
      >
        Mark resolved
      </button>
      {err ? <span className="text-sm text-red-600">{err}</span> : null}
    </div>
  );
}

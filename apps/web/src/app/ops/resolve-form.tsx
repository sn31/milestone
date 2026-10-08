"use client";

import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Button, DUR, EASE, Field, StateGlyph, cx, inputClass } from "@/components/ui";
import { postJson } from "@/lib/api-client";

/**
 * Clears a needs_operator flag with a note (recorded as ops.resolved in the audit log). Moves no money: the operator
 * settles anything outstanding by hand in PayPal first, then writes down what they did.
 */
export function ResolveForm({ milestoneId, disabled }: { milestoneId: string; disabled: boolean }) {
  const router = useRouter();
  const id = useId();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy || note.trim() === "") return;
    setBusy(true);
    setErr(null);
    try {
      const res = await postJson(`/api/ops/${milestoneId}/resolve`, { note });
      if (!res.ok) setErr(typeof res.body?.error === "string" ? res.body.error : `failed (${res.status})`);
      else {
        setDone(true);
        router.refresh();
      }
    } catch {
      setErr("network error; nothing was recorded");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="w-full max-w-xl">
      <Field
        label="Resolution note"
        htmlFor={id}
        error={err}
        hint={disabled ? "Only the partner or the platform can resolve a case." : "Recorded in the audit log as ops.resolved. Nothing is paid or refunded by this."}
      >
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            id={id}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Paid the freelancer by hand, batch 7Q4…"
            disabled={disabled || busy || done}
            className={cx(inputClass, "h-10 font-mono text-[13px]")}
          />
          <Button type="submit" variant="secondary" disabled={disabled || busy || done || note.trim() === ""} className="shrink-0">
            {busy ? "Resolving" : "Mark resolved"}
          </Button>
        </div>
      </Field>
      <AnimatePresence>
        {done ? (
          <motion.p
            data-tone="released"
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: DUR.reveal, ease: EASE.glide }}
            className="mt-2 flex items-center gap-2 font-mono text-[12px] text-tone"
          >
            <StateGlyph glyph="check" />
            resolved, clearing from the queue
          </motion.p>
        ) : null}
      </AnimatePresence>
    </form>
  );
}

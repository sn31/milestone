"use client";

import { useRouter } from "next/navigation";
import { useId, useRef, useState, type FormEvent } from "react";
import { Button, Field, cx, inputClass } from "@/components/ui";
import { postJson } from "@/lib/api-client";

/**
 * Clear or reject a contract the PayPal Acceptable Use Policy check flagged (POST /api/ops/aup/[contractId]). Clear lets
 * the parties sign and fund it as usual; reject is final. The note is the record (aup.cleared / aup.rejected).
 */
export function AupReviewForm({ contractId, disabled }: { contractId: string; disabled: boolean }) {
  const router = useRouter();
  const id = useId();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<"clear" | "reject" | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  async function act(action: "clear" | "reject") {
    if (busy) return;
    if (note.trim() === "") {
      setErr("Write down what you checked first: the note is the record.");
      inputRef.current?.focus();
      return;
    }
    setBusy(action);
    setErr(null);
    try {
      const res = await postJson(`/api/ops/aup/${contractId}`, { action, note });
      if (!res.ok) setErr(typeof res.body?.error === "string" ? res.body.error : `failed (${res.status})`);
      else {
        setDone(action === "clear" ? "cleared: the parties can sign and fund it" : "rejected: it can never be signed or funded");
        router.refresh();
      }
    } catch {
      setErr("network error; nothing was recorded");
    } finally {
      setBusy(null);
    }
  }

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void act("clear");
  };

  return (
    <form onSubmit={submit} className="w-full max-w-2xl">
      <Field
        label="Review note"
        htmlFor={id}
        error={err}
        hint={disabled ? "Only the partner or the platform can clear or reject a flagged contract." : done ?? "Recorded in the audit log as aup.cleared or aup.rejected. Rejecting is final."}
      >
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            id={id}
            ref={inputRef}
            value={note}
            onChange={(e) => {
              setNote(e.target.value);
              if (err) setErr(null);
            }}
            placeholder="Read the scope: a bakery raffle page, no prize money…"
            disabled={disabled || busy !== null || done !== null}
            className={cx(inputClass, "h-10 font-mono text-[13px]")}
          />
          <Button type="submit" variant="secondary" disabled={disabled || busy !== null || done !== null} className="shrink-0">
            {busy === "clear" ? "Clearing" : "Clear"}
          </Button>
          <Button type="button" variant="danger" onClick={() => void act("reject")} disabled={disabled || busy !== null || done !== null} className="shrink-0">
            {busy === "reject" ? "Rejecting" : "Reject"}
          </Button>
        </div>
      </Field>
    </form>
  );
}

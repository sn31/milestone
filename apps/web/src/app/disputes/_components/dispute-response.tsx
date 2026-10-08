"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button, Field, StateGlyph, cx, inputClass } from "@/components/ui";

const MAX = 2000;

export interface DisputeResponseProps {
  disputeId: string;
  /** The drafted text the textarea starts from (and "Restore the draft" returns to). */
  draft: string;
  source: "model" | "template";
  model: string | null;
  citations: number;
  amountLabel: string;
  /** Files that go to PayPal with the response, and the ones only named in the pack. */
  attachments: Array<{ name: string; size: number | null; attach: boolean; reason: string | null }>;
}

const kb = (n: number | null) => (n === null ? "" : `${Math.max(1, Math.ceil(n / 1024))} KB`);

/** The freelancer's side of an open dispute: edit the drafted response, send it as evidence, or accept the claim. */
export function DisputeResponse(props: DisputeResponseProps) {
  const router = useRouter();
  const [text, setText] = useState(props.draft);
  const [busy, setBusy] = useState<"submit" | "accept" | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = `dispute-text-${props.disputeId}`;
  const length = text.trim().length;
  const over = length > MAX;
  const edited = text !== props.draft;

  async function post(action: "submit" | "accept") {
    setBusy(action);
    setError(null);
    try {
      const res = await fetch(`/api/disputes/${encodeURIComponent(props.disputeId)}/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(action === "submit" ? { text } : { confirm: true }),
      });
      if (res.ok) {
        setConfirming(false);
        router.refresh();
        return;
      }
      const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
      setError(typeof body?.error === "string" ? body.error : `request failed (${res.status})`);
      if (res.status === 409) router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "request failed");
    } finally {
      setBusy(null);
    }
  }

  const sent = props.attachments.filter((a) => a.attach);
  const listed = props.attachments.filter((a) => !a.attach);

  return (
    <div className="grid gap-4">
      <Field
        label="Response to PayPal"
        htmlFor={id}
        hint="Sent as the notes of one evidence entry. Bracketed ids cite the evidence pack; keep them so PayPal's reviewer can check each claim."
      >
        <textarea id={id} rows={13} value={text} onChange={(e) => setText(e.target.value)} className={cx(inputClass, "resize-y text-[14px] leading-relaxed")} />
      </Field>
      <div className="-mt-1 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 font-mono text-[11px] text-fg-faint tabular">
        <span>
          {props.source === "model" ? `drafted by ${props.model ?? "the model"}` : "drafted from the record"} · {props.citations} citations
          {edited ? " · edited" : ""}
        </span>
        <span data-tone={over ? "danger" : "neutral"} className={over ? "text-tone" : undefined}>
          {length} / {MAX}
        </span>
      </div>
      {edited ? (
        <div>
          <Button variant="ghost" size="sm" onClick={() => setText(props.draft)}>
            Restore the draft
          </Button>
        </div>
      ) : null}

      {props.attachments.length ? (
        <div className="overflow-hidden rounded-control border border-hairline bg-surface-sunken">
          <ul className="divide-y divide-hairline">
            {sent.map((a) => (
              <li key={a.name} data-tone="released" className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
                <StateGlyph glyph="check" className="text-tone" />
                <span className="min-w-0 truncate text-[13px] text-fg">{a.name}</span>
                <span className="font-mono text-[11px] text-fg-faint tabular">{kb(a.size)}</span>
                <span className="ml-auto font-mono text-[11px] text-fg-faint">attached</span>
              </li>
            ))}
            {listed.map((a) => (
              <li key={a.name} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
                <StateGlyph glyph="ring" className="text-fg-faint" />
                <span className="min-w-0 truncate text-[13px] text-fg-muted">{a.name}</span>
                <span className="ml-auto font-mono text-[11px] text-fg-faint">named only · {a.reason}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {error ? (
        <p role="alert" data-tone="danger" className="flex items-baseline gap-2 text-[13px] text-tone">
          <StateGlyph glyph="cross" />
          <span className="min-w-0">{error}</span>
        </p>
      ) : null}

      <div className="grid gap-4 border-t border-hairline pt-4 sm:grid-cols-2">
        <div className="grid content-start gap-2">
          <Button variant="primary" disabled={busy !== null || length === 0 || over} onClick={() => post("submit")} className="w-full">
            {busy === "submit" ? "Sending..." : "Submit evidence"}
          </Button>
          <p className="text-[12.5px] leading-relaxed text-fg-muted">
            Sends this text{sent.length ? ` and ${sent.length} file${sent.length === 1 ? "" : "s"}` : ""} to PayPal. The client sees what was sent.
          </p>
        </div>
        <div className="grid content-start gap-2">
          <Button variant="danger" disabled={busy !== null} onClick={() => setConfirming(true)} className="w-full" aria-expanded={confirming}>
            Accept claim
          </Button>
          <p className="text-[12.5px] leading-relaxed text-fg-muted">Ends the dispute in the buyer&apos;s favour. PayPal refunds {props.amountLabel}.</p>
        </div>
      </div>

      {confirming ? (
        <div data-tone="danger" className="rounded-control border border-tone bg-tone-soft px-4 py-3">
          <p className="text-[13px] leading-relaxed text-fg">
            PayPal refunds {props.amountLabel} to the buyer from the platform account. The payout you already received is not reversed here; an operator settles it with you.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button variant="danger" size="sm" disabled={busy !== null} onClick={() => post("accept")}>
              {busy === "accept" ? "Accepting..." : "Accept and refund"}
            </Button>
            <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => setConfirming(false)}>
              Keep disputing
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

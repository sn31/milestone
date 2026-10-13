"use client";

import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { Button, StateGlyph, cx, inputClass } from "@/components/ui";
import { postJson, thrownText } from "@/lib/api-client";
import { ResponseText } from "./response-text";

const MAX = 2000;

export interface DisputeResponseProps {
  disputeId: string;
  /** The drafted text the response starts from (and "Restore the draft" returns to). */
  draft: string;
  source: "model" | "template";
  model: string | null;
  citations: number;
  /** The disputed amount, as a <Money> figure rendered by the card. */
  amount: ReactNode;
  /** The buyer, by name, for the consequences. */
  buyer: string;
  /** Files that go to PayPal with the response, and the ones only named in the pack. */
  attachments: Array<{ name: string; size: number | null; attach: boolean; reason: string | null }>;
  /** The accept route takes a claim only once the milestone's money has left escrow. */
  acceptable: boolean;
}

const kb = (n: number | null) => (n === null ? "" : `${Math.max(1, Math.ceil(n / 1024))} KB`);

/** One choice and what it does, line by line. */
function Choice({ action, lines, tone }: { action: ReactNode; lines: ReactNode[]; tone: "released" | "danger" }) {
  return (
    <div className="grid content-start gap-3">
      {action}
      <ul data-tone={tone} className="grid gap-1.5 text-[12.5px] leading-snug text-fg-muted">
        {lines.map((l, i) => (
          <li key={i} className="flex gap-2">
            <span aria-hidden className="mt-[7px] size-1 shrink-0 rounded-full bg-tone" />
            <span className="min-w-0">{l}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The freelancer's side of an open dispute: the drafted response as a document (citations as chips that open the
 * pack row they cite), an Edit toggle for the text, then the two ways to end it, each with what it does spelled out.
 */
export function DisputeResponse(props: DisputeResponseProps) {
  const router = useRouter();
  const [text, setText] = useState(props.draft);
  const [editing, setEditing] = useState(false);
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
      const res = await postJson(`/api/disputes/${encodeURIComponent(props.disputeId)}/${action}`, action === "submit" ? { text } : { confirm: true });
      if (res.ok) {
        setConfirming(false);
        router.refresh();
        return;
      }
      setError(res.error);
      if (res.status === 409) router.refresh();
    } catch (e) {
      setError(thrownText(e));
    } finally {
      setBusy(null);
    }
  }

  const sent = props.attachments.filter((a) => a.attach);
  const listed = props.attachments.filter((a) => !a.attach);
  const files = sent.length ? ` and ${sent.length} file${sent.length === 1 ? "" : "s"}` : "";

  return (
    <div className="grid gap-5">
      {/* The document */}
      <div className="overflow-hidden rounded-panel border border-hairline bg-paper">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-dashed border-hairline-strong px-4 py-3 sm:px-5">
          <div className="min-w-0">
            <label htmlFor={editing ? id : undefined} className="type-label text-fg-muted">
              Response to PayPal
            </label>
            <p className="mt-1 font-mono text-[11px] text-fg-faint tabular">
              {props.source === "model" ? `drafted by ${props.model ?? "the model"}` : "drafted from the record"} · {props.citations} citations
              {edited ? <span className="text-fg-muted"> · edited</span> : null}
            </p>
          </div>
          <div className="flex items-center gap-1">
            {edited ? (
              <Button variant="ghost" size="sm" onClick={() => setText(props.draft)}>
                Restore the draft
              </Button>
            ) : null}
            <Button variant="secondary" size="sm" onClick={() => setEditing((e) => !e)} aria-pressed={editing}>
              {editing ? "Done" : "Edit"}
            </Button>
          </div>
        </div>
        <div className="px-4 py-4 sm:px-5 sm:py-5">
          {editing ? (
            <textarea
              id={id}
              autoFocus
              value={text}
              onChange={(e) => setText(e.target.value)}
              className={cx(inputClass, "field-sizing-content min-h-64 resize-y text-[14.5px] leading-[1.7]")}
            />
          ) : (
            <ResponseText text={text} />
          )}
        </div>
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-t border-dashed border-hairline px-4 py-2.5 font-mono text-[11px] text-fg-faint sm:px-5">
          <span>{editing ? "Keep the bracketed ids: they cite the evidence pack." : "Each chip cites a row of the evidence pack; select one to see it."}</span>
          <span data-tone={over ? "danger" : "neutral"} className={cx("tabular", over && "text-tone")}>
            {length} / {MAX}
          </span>
        </div>
      </div>

      {props.attachments.length ? (
        <div>
          <p className="type-label mb-2 text-fg-faint">Goes with it</p>
          <ul className="divide-y divide-hairline overflow-hidden rounded-control border border-hairline bg-surface-sunken">
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
                <span className="ml-auto font-mono text-[11px] text-fg-faint">named in the text · {a.reason}</span>
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

      <div className="grid gap-5 border-t border-hairline pt-5 sm:grid-cols-2">
        <Choice
          tone="released"
          action={
            <Button variant="primary" disabled={busy !== null || length === 0 || over} onClick={() => post("submit")} className="w-full">
              {busy === "submit" ? "Sending..." : "Submit evidence"}
            </Button>
          }
          lines={[
            <>PayPal receives this text{files} as your evidence.</>,
            <>If PayPal finds for you, the {props.amount} payout stands.</>,
            <>{props.buyer} sees exactly what was sent.</>,
          ]}
        />
        <Choice
          tone="danger"
          action={
            <Button variant="danger" disabled={busy !== null || !props.acceptable} onClick={() => setConfirming(true)} className="w-full" aria-expanded={confirming}>
              Accept claim
            </Button>
          }
          lines={
            props.acceptable
              ? [
                  <>Ends the dispute now, in the buyer&apos;s favour.</>,
                  <>PayPal refunds {props.amount} to {props.buyer}.</>,
                  <>Your payout is not reversed here; an operator settles it with you.</>,
                ]
              : [<>Opens once this milestone is paid out. While the money is in escrow, an operator settles any refund.</>]
          }
        />
      </div>

      {confirming ? (
        <div data-tone="danger" role="alertdialog" aria-label="Accept the claim" className="rounded-control border border-tone bg-tone-soft px-4 py-3">
          <p className="text-[13px] leading-relaxed text-fg">
            PayPal refunds {props.amount} to {props.buyer} from the platform account and the dispute closes. This cannot be undone from Milestone.
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

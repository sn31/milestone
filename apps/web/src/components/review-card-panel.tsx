"use client";

import { AnimatePresence, motion } from "motion/react";
import { useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Button, CountdownRing, DUR, EASE, Panel, StateGlyph, cx, useSecondClock, type ButtonVariant } from "@/components/ui";
import { postJson, refusalText, thrownText } from "@/lib/api-client";

type Action = "approve" | "veto" | "confirm_partial" | "hold";

export interface ReviewPanelProps {
  milestoneId: string;
  status: "review" | "needs_client";
  isClient: boolean;
  reviewEndsAt: string | null;
  /** Length of the whole review window in seconds, for the countdown ring. */
  windowSeconds: number;
  decisionAction: string | null;
  /** The decision's proposed payout in minor units (the share a partial would pay). */
  amountMinor?: number | null;
  /** That amount formatted, or null when there is none to show (no decision, or 0). */
  amountLabel: string | null;
  /** The whole milestone, formatted ("$90.00"), for "release $60.00 of $90.00". */
  totalLabel?: string | null;
  reason: string | null;
  /** Required criteria the delivery's verdict did not pass; the review route then refuses approve and confirm_partial. */
  requiredNotPassed?: string[];
  /** Who is on the contract, for copy addressed to the viewer. */
  names?: { client: string; freelancer: string };
  /** The freelancer is viewing (the money is theirs; the decision is the client's). */
  isFreelancer?: boolean;
  /** Judgment criteria no model judged (checks-only run): the client judges them, so the card says so instead of "could not verify". */
  forClient?: string[];
  /** Text in the delivery that addressed the reviewer (a suspected prompt injection), quoted so the client sees it was ignored. */
  injection?: Array<{ source: string; text: string }>;
}

interface Choice {
  action: Action;
  label: string;
  variant: ButtonVariant;
  /** What happens to the money, in one plain sentence (the button's title, and the line under the choices). */
  consequence: string;
}

/**
 * Whether the client is offered "Release <amount>" (confirm_partial): only on a partial decision proposing a share above
 * zero. On ask_client the policy proposes no share (amountMinor 0), and the release job would turn a confirmed partial
 * of 0 into a full refund to the client, so the choices there are approve in full or hold.
 */
export function offersPartial(decisionAction: string | null, amountMinor: number | null | undefined): boolean {
  return decisionAction === "partial" && typeof amountMinor === "number" && Number.isFinite(amountMinor) && amountMinor > 0;
}

const first = (name: string) => name.split(" ")[0] ?? name;

/** The delivery's text that spoke to the reviewer, struck through: shown so nobody wonders whether it was obeyed. */
function Ignored({ items }: { items: Array<{ source: string; text: string }> }) {
  return (
    <div data-tone="danger" className="mt-3 rounded-control border border-hairline bg-surface-sunken px-3.5 py-2.5">
      <p className="type-label flex items-center gap-2 text-tone">
        <StateGlyph glyph="cross" className="size-[9px]" />
        Ignored: text addressed to the reviewer
      </p>
      <ul className="mt-1.5 grid gap-1">
        {items.slice(0, 3).map((it, i) => (
          <li key={i} className="flex min-w-0 flex-col gap-0.5 font-mono text-[12px] leading-relaxed sm:flex-row sm:items-baseline sm:gap-2">
            <span className="shrink-0 text-fg-faint">{it.source.replace(/_/g, " ")}</span>
            <q className="min-w-0 break-words text-fg-muted line-through decoration-[color:var(--tone)]">{it.text.length > 160 ? `${it.text.slice(0, 159)}…` : it.text}</q>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The client's decision on a milestone in review or needs_client, as one compact card on the rail. In review: the
 * countdown ring beside the title (72 px; 48 px inline on a phone) and Approve now / Veto release on the same row. On
 * needs client: a heading that states the outcome, the failing checks, the choices with their consequence on one line.
 * The freelancer reads the same card addressed to them, without controls.
 */
export function ReviewPanel(props: ReviewPanelProps) {
  const router = useRouter();
  // Whole seconds in ms; 0 on the server, so the first paint makes no time claims.
  const now = useSecondClock() * 1000;
  const [busy, setBusy] = useState<Action | null>(null);
  const [error, setError] = useState<string | null>(null);
  const client = props.names ? first(props.names.client) : "the client";
  const freelancer = props.names?.freelancer ?? "the freelancer";

  async function act(action: Action) {
    setBusy(action);
    setError(null);
    try {
      const res = await postJson(`/api/milestones/${props.milestoneId}/review`, { action });
      if (res.ok) {
        router.refresh();
        return;
      }
      setError(refusalText(res.body, res.status));
      // A 409 means the milestone moved on (payout sent, window closed): show the current state behind the message.
      if (res.status === 409) router.refresh();
    } catch (e) {
      setError(thrownText(e));
    } finally {
      setBusy(null);
    }
  }

  const amount = props.amountLabel;
  const endsAt = props.reviewEndsAt ? new Date(props.reviewEndsAt).getTime() : null;
  const known = now > 0;
  const closed = endsAt !== null && known && endsAt <= now;
  // Veto only while the window is known to be open (the route refuses it once reviewEndsAt has passed).
  const windowOpen = endsAt === null || (known && endsAt > now);
  // With a required criterion not passed the route refuses approve and confirm_partial, so only Hold is offered.
  const blocked = props.requiredNotPassed ?? [];
  const holdOnly = props.status === "needs_client" && blocked.length > 0;
  const partial = props.status === "needs_client" && !holdOnly && offersPartial(props.decisionAction, props.amountMinor ?? null) && amount !== null;

  const choices: Choice[] = [];
  if (props.status === "review") {
    if (!closed) choices.push({ action: "approve", label: "Approve now", variant: "primary", consequence: `Approve pays ${amount ?? "the milestone"} now` });
    if (windowOpen) choices.push({ action: "veto", label: "Veto release", variant: "danger", consequence: "veto keeps it in escrow (Held)" });
  } else if (holdOnly) {
    choices.push({ action: "hold", label: "Hold the payment", variant: "danger", consequence: `Keeps the money in escrow; ${first(freelancer)} can fix the work and resubmit` });
  } else {
    if (partial) choices.push({ action: "confirm_partial", label: `Release ${amount}`, variant: "primary", consequence: `Release pays ${amount} and refunds the rest to you` });
    // The route takes full approval on needs_client only when the agent asked the client.
    if (props.decisionAction === "ask_client") choices.push({ action: "approve", label: "Approve in full", variant: "primary", consequence: "Approve pays the whole milestone" });
    choices.push({ action: "hold", label: "Hold", variant: "danger", consequence: "Hold keeps it in escrow and the freelancer can resubmit" });
  }

  // Checks only (no model): the agent ran every command and file check; judgment criteria are the client's call.
  const judged = props.forClient ?? [];
  const judgeYourself = props.status === "needs_client" && !holdOnly && !partial && props.decisionAction === "ask_client" && judged.length > 0;
  const quoted = judged.map((d, i) => (
    <span key={i}>
      {i > 0 ? (i === judged.length - 1 ? " and " : ", ") : null}
      <span className="text-fg">“{d}”</span>
    </span>
  ));
  const checksOnlyBody = <>The agent ran the checks only; no model judged {quoted}. Read the work and approve it, or hold it for a fix.</>;

  // Counts are numbers, so they print in mono even inside the serif heading.
  const failedChecks =
    blocked.length === 1 ? (
      "a required check failed"
    ) : (
      <>
        <span className="font-mono text-[0.85em] tabular">{blocked.length}</span> required checks failed
      </>
    );

  // ---- Copy, addressed to whoever is looking ----
  let title: ReactNode;
  let body: ReactNode = null;
  if (props.status === "review") {
    if (closed) {
      title = "Window closed · releasing";
      body = "The payout goes to PayPal now; this station moves on when PayPal confirms it.";
    } else if (props.isClient) {
      title = "Releases on its own when the window closes";
      body = (
        <>
          The agent verified the work. <span className="font-mono text-fg tabular">{amount ?? "The payment"}</span> goes to {first(freelancer)} unless you veto.
        </>
      );
    } else if (props.isFreelancer) {
      title = "Releases to you when the window closes";
      body = <>Verified. {client} can approve early or veto until then.</>;
    } else {
      title = "Releases when the window closes";
      body = <>Verified. {client} can approve early or veto until then.</>;
    }
  } else if (props.isClient) {
    if (holdOnly) {
      title = <>Hold: {failedChecks}</>;
    } else if (partial) {
      title = (
        <>
          The agent recommends releasing <span className="font-mono text-[0.85em] tracking-[-0.01em] text-tone tabular">{amount}</span>
          {props.totalLabel ? <span className="text-fg-muted"> of {props.totalLabel}</span> : null}
        </>
      );
    } else if (judgeYourself) {
      title = "Every check passed. The rest is yours to judge";
    } else {
      title = "Approve in full, or hold";
    }
    // On a hold the failing checks are listed under the heading; the policy's reason would repeat them.
    body = holdOnly ? null : judgeYourself ? checksOnlyBody : props.reason;
  } else {
    const who = `Waiting for ${client}`;
    if (holdOnly) title = <>{who}: {failedChecks}</>;
    else if (partial) title = (
      <>
        {who} to confirm <span className="font-mono text-[0.85em] tracking-[-0.01em] text-tone tabular">{amount}</span>
        {props.totalLabel ? <span className="text-fg-muted"> of {props.totalLabel}</span> : null}
      </>
    );
    else if (judgeYourself) title = `Every check passed. Waiting for ${client} to judge the rest`;
    else title = `${who} to decide`;
    body = holdOnly
      ? `${client} can only hold this delivery; fix the failing ${blocked.length === 1 ? "check" : "checks"} and resubmit.`
      : judgeYourself
        ? <>No model judged it, so {client} reads the work against {quoted}.</>
        : props.reason;
  }

  const tone = props.status === "review" ? "review" : holdOnly ? "held" : "needs";
  const ring = (size: number, className?: string) =>
    props.status === "review" && props.reviewEndsAt ? (
      <CountdownRing endsAt={props.reviewEndsAt} totalSeconds={props.windowSeconds} size={size} label="until release" closedLabel="releasing" className={className} />
    ) : null;
  const controls =
    props.isClient && choices.length ? (
      <div className={cx("grid gap-2 sm:flex sm:shrink-0 sm:items-center", choices.length > 1 ? "grid-cols-2" : "grid-cols-1")}>
        {choices.map((c) => (
          <Button key={c.action} variant={c.variant} disabled={busy !== null} onClick={() => act(c.action)} title={c.consequence} className="w-full sm:w-auto">
            {busy === c.action ? "Working..." : c.label}
          </Button>
        ))}
      </div>
    ) : null;

  return (
    <Panel variant="sunken" tone={tone} padded={false} className="mt-5 px-4 py-3.5 sm:px-5 sm:py-4">
      <div className="flex items-center gap-4 sm:gap-5">
        {ring(72, "max-sm:hidden")}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-3">
            {ring(48, "sm:hidden")}
            <p data-tone={tone} className="type-display-s min-w-0 text-[19px] leading-[1.2] text-fg sm:text-[21px]">
              {holdOnly ? <StateGlyph glyph="pause" className="mr-2 inline size-[10px] -translate-y-[2px] text-tone" /> : null}
              {title}
            </p>
          </div>
          {body ? <p className="mt-1.5 max-w-[70ch] text-[13px] leading-relaxed text-fg-muted">{body}</p> : null}
        </div>
        {props.status === "review" && controls ? <div className="max-md:hidden">{controls}</div> : null}
      </div>

      {holdOnly ? (
        <ul data-tone="danger" className="mt-3 grid gap-1">
          {blocked.map((c) => (
            <li key={c} className="flex items-baseline gap-2 text-[13px] text-fg">
              <StateGlyph glyph="cross" className="size-[9px] shrink-0 text-tone" />
              {c}
            </li>
          ))}
        </ul>
      ) : null}
      {props.injection?.length ? <Ignored items={props.injection} /> : null}

      {controls ? (
        <div className={cx("mt-3.5 flex flex-col gap-2.5 border-t border-hairline pt-3.5 sm:flex-row sm:items-center sm:justify-between", props.status === "review" && "md:hidden")}>
          <p className="order-2 text-[12.5px] leading-relaxed text-fg-faint sm:order-1">{choices.map((c) => c.consequence).join(" · ")}.</p>
          <div className="order-1 sm:order-2">{controls}</div>
        </div>
      ) : null}
      {controls && props.status === "review" ? (
        <p className="mt-2 hidden text-[12.5px] text-fg-faint md:block md:pl-[92px]">{choices.map((c) => c.consequence).join(" · ")}.</p>
      ) : null}

      <AnimatePresence>
        {error ? (
          <motion.p
            role="alert"
            data-tone="danger"
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: DUR.quick, ease: EASE.glide }}
            className="mt-3 rounded-control border border-tone bg-tone-soft px-3 py-2 text-[13px] text-tone"
          >
            {error}
          </motion.p>
        ) : null}
      </AnimatePresence>
    </Panel>
  );
}

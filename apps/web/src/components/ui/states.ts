// State vocabulary shared by every screen. Server- and client-safe (no imports).

/** Colour keys: each maps to a --state-* token and a [data-tone] selector in globals.css. */
export type ToneKey = "draft" | "funded" | "verifying" | "review" | "released" | "partial" | "held" | "needs" | "danger" | "neutral";

/** Glyph drawn by StateGlyph. */
export type GlyphKey = "ring" | "dot" | "pulse" | "arc" | "check" | "half" | "pause" | "query" | "cross" | "hollow-dot";

export interface StateMeta {
  label: string;
  tone: ToneKey;
  glyph: GlyphKey;
  /** main: on the rail; side: a branch off verifying. */
  track: "main" | "side";
  /** One plain sentence about where the money is. */
  money: string;
}

/** Every contract and milestone status. Unknown statuses fall back to a neutral ring (see stateMeta). */
export const STATE_META: Record<string, StateMeta> = {
  // milestones
  draft: { label: "Draft", tone: "draft", glyph: "ring", track: "main", money: "Not funded yet." },
  funded: { label: "Funded", tone: "funded", glyph: "dot", track: "main", money: "Held in escrow for this milestone." },
  verifying: { label: "Verifying", tone: "verifying", glyph: "pulse", track: "main", money: "Held while the agent checks the delivery." },
  review: { label: "In review", tone: "review", glyph: "arc", track: "main", money: "Verified. Releases when the review window closes." },
  released: { label: "Released", tone: "released", glyph: "check", track: "main", money: "Paid to the freelancer." },
  partial_released: { label: "Partly released", tone: "partial", glyph: "half", track: "side", money: "Verified share paid, the rest refunded." },
  held: { label: "Held", tone: "held", glyph: "pause", track: "side", money: "Held until the issue is resolved." },
  needs_client: { label: "Needs client", tone: "needs", glyph: "query", track: "side", money: "Held until the client decides." },
  // contracts
  approved: { label: "Approved", tone: "funded", glyph: "hollow-dot", track: "main", money: "Signed by both parties." },
  active: { label: "Active", tone: "funded", glyph: "dot", track: "main", money: "Milestones in progress." },
  closed: { label: "Closed", tone: "released", glyph: "check", track: "main", money: "Every milestone settled." },
  // operations
  failed: { label: "Failed", tone: "danger", glyph: "cross", track: "side", money: "A payment failed." },
};

const FALLBACK: StateMeta = { label: "", tone: "neutral", glyph: "ring", track: "main", money: "" };

export function stateMeta(status: string): StateMeta {
  return STATE_META[status] ?? { ...FALLBACK, label: status.replace(/[._]+/g, " ") };
}

/** Tone key for a status, for data-tone attributes. */
export function toneOf(status: string): ToneKey {
  return stateMeta(status).tone;
}

/** CSS colour for a tone, for inline SVG strokes and fills. */
export function toneVar(tone: ToneKey): string {
  return tone === "neutral" ? "var(--fg-muted)" : `var(--state-${tone})`;
}

export type Phase = "done" | "current" | "upcoming";

export interface LifecycleStation {
  state: string;
  label: string;
  tone: ToneKey;
  phase: Phase;
  /** true for held / needs_client / partial_released, drawn as a branch off verifying. */
  branch: boolean;
  /** Pass to Station `connect`: whether a connector runs to the next station. */
  connect: boolean;
}

const MAIN = ["draft", "funded", "verifying", "review", "released"] as const;

/**
 * The stations of one milestone's rail for its current status. The main track is draft -> funded -> verifying -> review ->
 * released; held and needs_client branch off verifying (and partial_released follows needs_client), and when the milestone
 * is on a side track the main stations after verifying are shown as upcoming.
 */
export function lifecycle(status: string): LifecycleStation[] {
  const side = status === "held" || status === "needs_client" || status === "partial_released";
  const reached = side ? MAIN.indexOf("verifying") : Math.max(0, MAIN.indexOf(status as (typeof MAIN)[number]));
  const out: LifecycleStation[] = [];
  MAIN.forEach((s, i) => {
    const m = stateMeta(s);
    const phase: Phase = side ? (i <= reached ? "done" : "upcoming") : i < reached ? "done" : i === reached ? "current" : "upcoming";
    out.push({ state: s, label: m.label, tone: m.tone, phase, branch: false, connect: true });
    if (s === "verifying" && side) {
      if (status === "partial_released") {
        out.push({ state: "needs_client", label: stateMeta("needs_client").label, tone: "needs", phase: "done", branch: true, connect: true });
        out.push({ state: "partial_released", label: stateMeta("partial_released").label, tone: "partial", phase: "done", branch: true, connect: false });
      } else {
        const meta = stateMeta(status);
        out.push({ state: status, label: meta.label, tone: meta.tone, phase: "current", branch: true, connect: false });
      }
    }
  });
  return out;
}

/** Milestone statuses where the client's money sits in escrow. */
export const ESCROW_STATES: ReadonlySet<string> = new Set(["funded", "verifying", "review", "held", "needs_client"]);
/** Milestone statuses where money has gone to the freelancer. */
export const PAID_STATES: ReadonlySet<string> = new Set(["released", "partial_released"]);

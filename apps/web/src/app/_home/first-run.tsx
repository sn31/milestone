import { Button, Eyebrow, Panel, StateGlyph, type GlyphKey, type ToneKey } from "@/components/ui";
import { paypalMode } from "@milestone/core";
import type { Role } from "@/lib/session";
import { SANDBOX_BUYER_HINT, demoMode } from "@/app/api/demo/_demo";
import { IntroToggle } from "./intro-toggle";

/** The story in three stations, drawn in the rail's vocabulary: a node in the state's colour, a 2px connector. */
const STEPS: { tone: ToneKey; glyph: GlyphKey; title: string; body: string }[] = [
  { tone: "funded", glyph: "dot", title: "Fund", body: "The client pays one milestone into escrow; the freelancer can take an advance on it." },
  // A still ring, not the live pulse: nothing is being verified on this page.
  { tone: "verifying", glyph: "ring", title: "Agent verifies", body: "Tests, tamper check and criteria, on a receipt." },
  { tone: "released", glyph: "check", title: "PayPal releases", body: "A fixed policy pays for what passed and refunds the rest, final once PayPal confirms." },
];

const GUIDE: Record<Role, (name: string) => string> = {
  client: (n) => `You are ${n}, the client. Start on the signup flow contract: fund a milestone or answer one in review, then switch to Freelancer at the top right to deliver.`,
  freelancer: (n) => `You are ${n}, the freelancer. Open the signup flow contract to deliver a funded milestone, or take an advance with Get paid now.`,
  partner: (n) => `You are ${n}, the capital partner. You advance cash against funded milestones and are repaid first when they release.`,
  platform: (n) => `You are ${n}. Payouts that fail land in the operations queue.`,
};

export interface FirstRunProps {
  role: Role;
  /** First name of the demo identity in use. */
  name: string;
  /** Where "what to click first" goes, and what it says. */
  start: { href: string; label: string };
  /** A second, quieter way in for this role (the partner's book). */
  secondary?: { href: string; label: string } | null;
}

/**
 * First run on "/": what Milestone is in one sentence, the fund -> verify -> release story as a three-station rail, which
 * role is in use and what to click first, and the guardrails in one line. Server-rendered so the first frame explains the
 * product; hidden by CSS before paint once this viewer dismissed it (html[data-intro="hidden"], see layout.tsx).
 */
export function FirstRun({ role, name, start, secondary }: FirstRunProps) {
  return (
    <section id="intro" aria-labelledby="intro-title" className="intro-shown mb-10 scroll-mt-24">
      <Panel padded={false} className="relative overflow-hidden">
        <div className="absolute top-3 right-3 z-10 sm:top-4 sm:right-4">
          <IntroToggle to="hidden" />
        </div>
        <div className="grid gap-x-12 gap-y-6 p-5 sm:p-6 lg:grid-cols-[minmax(0,1fr)_360px]">
          <div className="min-w-0">
            <Eyebrow>Start here</Eyebrow>
            <h2 id="intro-title" className="type-display-m mt-3 text-balance text-fg">
              Milestone holds a client&rsquo;s payment and pays the freelancer only when an agent has verified the work.
            </h2>
            <p className="mt-3 max-w-[60ch] text-[14px] leading-relaxed text-fg-muted">{GUIDE[role](name)}</p>
            {role === "client" && demoMode() && paypalMode() === "sandbox" ? (
              <p className="mt-2 max-w-[60ch] text-[13px] leading-relaxed text-fg-faint">{SANDBOX_BUYER_HINT}</p>
            ) : null}
            <div className="mt-5 flex flex-wrap items-center gap-2">
              <Button href={start.href} variant="primary">
                {start.label}
                <svg aria-hidden viewBox="0 0 20 8" className="h-2 w-5" fill="none" stroke="currentColor" strokeWidth="1.3">
                  <path d="M0 4 H18 M15 1 L18 4 L15 7" />
                </svg>
              </Button>
              {secondary ? (
                <Button href={secondary.href} variant="ghost">
                  {secondary.label}
                </Button>
              ) : null}
            </div>
          </div>

          <div className="relative min-w-0">
            <p className="type-label text-fg-faint lg:pt-px">How money moves</p>
            <ol className="mt-4" aria-label="How a milestone is paid">
              {STEPS.map((s, i) => (
                <li key={s.title} data-tone={s.tone} className="relative grid grid-cols-[22px_minmax(0,1fr)] gap-x-3.5 pb-2.5 last:pb-0 sm:pb-4">
                  {i < STEPS.length - 1 ? (
                    // Rail connector: the station's colour fading to hairline, as on the contract page.
                    <span
                      aria-hidden
                      className="absolute top-[24px] bottom-[2px] left-[10px] w-[2px] rounded-full"
                      style={{ background: `linear-gradient(to bottom, color-mix(in oklab, var(--tone) 70%, transparent), var(--hairline-strong))` }}
                    />
                  ) : null}
                  <span className="relative z-10 mt-px grid size-[22px] place-items-center rounded-full border border-tone bg-surface text-tone">
                    <StateGlyph glyph={s.glyph} />
                  </span>
                  <div className="min-w-0">
                    <p className="flex items-baseline gap-2 text-[14px] leading-[22px] text-fg">
                      <span className="font-mono text-[11px] text-fg-faint tabular">{String(i + 1).padStart(2, "0")}</span>
                      {s.title}
                    </p>
                    {/* Phones keep the three names only; the sentence above already tells the story. */}
                    <p className="hidden text-[13px] leading-snug text-fg-muted sm:block">{s.body}</p>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </div>
        <p className="border-t border-hairline bg-surface-sunken/50 px-5 py-3 font-mono text-[11px] leading-relaxed text-fg-faint sm:px-6">
          <span className="type-label mr-2 text-fg-muted">Guardrails</span>
          A fixed policy decides, not the model · one payout per milestone, confirmed by PayPal · delivered work is evidence, not instructions
        </p>
      </Panel>
    </section>
  );
}

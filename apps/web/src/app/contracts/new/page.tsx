import type { Metadata } from "next";
import { Button, PageHeader, Panel, StateGlyph, cx } from "@/components/ui";

export const metadata: Metadata = { title: "New contract" };

const CURRENCIES = ["USD", "EUR", "GBP", "CAD", "AUD"] as const;

/** Inline mono control in the composer's footer: no box, a hairline underline that strengthens on hover and focus. */
const inline =
  "h-9 rounded-none border-0 border-b border-hairline-strong bg-transparent px-1 font-mono text-[15px] text-fg tabular placeholder:text-fg-faint " +
  "transition-colors duration-200 hover:border-fg-faint focus-visible:border-focus focus-visible:outline-none";

/** What the compiler hands back, as a ghost rail: three stations, none lit yet. */
const OUTPUT = [
  {
    title: "Milestones that add up to your total",
    body: "The scope is split into a few stages, each with its own amount. Money is held per milestone, never for the whole contract at once.",
  },
  {
    title: "Checks the verifier can run",
    body: "Every milestone gets acceptance criteria: tests that must pass, a build, files that must exist, uploads with limits, and a judgment call where nothing else fits.",
  },
  {
    title: "A draft, not a commitment",
    body: "Both parties read and approve the contract. Nothing is charged until the client funds the first milestone.",
  },
];

export default async function NewContract({ searchParams }: PageProps<"/contracts/new">) {
  const sp = await searchParams;
  const error = typeof sp.error === "string" ? sp.error : null;
  const compilesWithModel = Boolean(process.env.ANTHROPIC_API_KEY);

  return (
    <main>
      <PageHeader
        eyebrow="New contract"
        title={
          <>
            Describe the work
          </>
        }
        description="Write the scope the way you would brief a freelancer. The contract compiler turns it into funded milestones with checks that decide when each payment moves."
      />

      {error ? (
        <p role="alert" data-tone="danger" className="mt-8 flex items-start gap-2.5 rounded-control border border-tone bg-tone-soft px-4 py-3 text-[14px] text-fg">
          <StateGlyph glyph="cross" className="mt-[5px] text-tone" />
          {error}
        </p>
      ) : null}

      <div className="mt-10 grid gap-10 lg:grid-cols-[minmax(0,1fr)_300px] lg:gap-12">
        <form action="/api/contracts" method="post" aria-label="Contract scope">
          <Panel padded={false} className="overflow-hidden">
            <div className="border-b border-hairline px-5 pt-5 pb-4 sm:px-6">
              <label htmlFor="title" className="type-label text-fg-faint">
                Title <span className="normal-case tracking-normal">(optional)</span>
              </label>
              <input
                id="title"
                name="title"
                maxLength={120}
                autoComplete="off"
                placeholder="Signup flow for the landing page"
                className="type-display-s mt-2 block w-full border-0 bg-transparent p-0 text-fg placeholder:text-fg-faint/70 focus-visible:outline-none"
              />
            </div>

            <div className="relative">
              <label htmlFor="scope" className="sr-only">
                Scope of work
              </label>
              <textarea
                id="scope"
                name="scope"
                required
                rows={12}
                placeholder={
                  "Build a signup flow for our landing page.\n\n" +
                  "A form with email and password and inline validation, an API endpoint that creates the account, and a confirmation page that echoes the email.\n\n" +
                  "Tests for the new endpoint. Update the README with setup steps."
                }
                className="block min-h-[300px] w-full resize-y border-0 bg-surface-sunken/60 px-5 py-5 text-[16px] leading-[1.7] text-fg placeholder:text-fg-faint/80 focus-visible:bg-surface-sunken focus-visible:outline-none sm:px-6"
              />
              <span aria-hidden className="pointer-events-none absolute top-5 left-0 h-8 w-[2px] rounded-full bg-hairline-strong" />
            </div>

            <div className="flex flex-col gap-5 border-t border-hairline px-5 py-5 sm:px-6 md:flex-row md:items-end md:justify-between">
              <div className="flex flex-wrap items-end gap-x-6 gap-y-4">
                <div className="grid gap-1">
                  <label htmlFor="total" className="type-label text-fg-faint">
                    Total
                  </label>
                  <div className="flex items-end gap-2">
                    <input
                      id="total"
                      name="total"
                      type="number"
                      inputMode="decimal"
                      step="0.01"
                      min="0.01"
                      required
                      defaultValue="300.00"
                      className={cx(inline, "w-28 text-right")}
                    />
                    <label htmlFor="currency" className="sr-only">
                      Currency
                    </label>
                    <select id="currency" name="currency" defaultValue="USD" className={cx(inline, "w-[4.5rem] cursor-pointer text-fg-muted")}>
                      {CURRENCIES.map((c) => (
                        <option key={c}>{c}</option>
                      ))}
                    </select>
                  </div>
                </div>
                <div className="grid gap-1">
                  <label htmlFor="repo" className="type-label text-fg-faint">
                    GitHub repo <span className="normal-case tracking-normal">(optional)</span>
                  </label>
                  <input
                    id="repo"
                    name="repo"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="owner/name"
                    pattern="[A-Za-z0-9_.\-]+/[A-Za-z0-9_.\-]+"
                    className={cx(inline, "w-52 text-[14px]")}
                  />
                </div>
              </div>
              <Button type="submit" variant="primary" className="w-full md:w-auto">
                Draft contract
                <svg aria-hidden viewBox="0 0 20 8" className="h-2 w-5" fill="none" stroke="currentColor" strokeWidth="1.3">
                  <path d="M0 4 H18 M15 1 L18 4 L15 7" />
                </svg>
              </Button>
            </div>
          </Panel>
          <p className="mt-3 font-mono text-[11px] text-fg-faint">
            The amount is split across milestones in minor units, so the parts always add up to the total.
          </p>
        </form>

        <aside aria-label="What the compiler produces" className="lg:pt-2">
          <p className="type-label text-fg-faint">What you get back</p>
          <ol className="mt-5">
            {OUTPUT.map((o, i) => (
              <li key={o.title} data-tone="draft" className="relative grid grid-cols-[16px_minmax(0,1fr)] gap-x-4 pb-7 last:pb-0">
                {i < OUTPUT.length - 1 ? <span aria-hidden className="absolute top-[18px] bottom-1 left-[7.5px] w-px border-l border-dashed border-hairline-strong" /> : null}
                <span className="mt-[5px] grid size-4 place-items-center rounded-full border border-hairline-strong bg-bg text-tone">
                  <StateGlyph glyph="ring" className="size-2" />
                </span>
                <div>
                  <p className="text-[14px] text-fg">{o.title}</p>
                  <p className="mt-1 text-[13px] leading-relaxed text-fg-muted">{o.body}</p>
                </div>
              </li>
            ))}
          </ol>
          <p className="mt-8 border-t border-hairline pt-4 font-mono text-[11px] leading-relaxed text-fg-faint">
            {compilesWithModel
              ? "Compiled by the model; the policy that releases money is fixed code, not the model."
              : "No model key is set, so a three-milestone demo contract is drafted from your total."}
          </p>
        </aside>
      </div>
    </main>
  );
}

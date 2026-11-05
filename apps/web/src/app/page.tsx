import Link from "next/link";
import { getDb } from "@/lib/db";
import { formatDate, formatMoney } from "@/lib/format";
import { ACTOR_NAMES, ROLE_LABELS, getActor, type Role } from "@/lib/session";
import { Button, EmptyState, ESCROW_STATES, MiniRail, Money, MoneyBar, PAID_STATES, PageHeader, Panel, Reveal, Stat, StatePill, toneOf } from "@/components/ui";
import { FirstRun } from "./_home/first-run";
import { IntroToggle } from "./_home/intro-toggle";

export const dynamic = "force-dynamic";

interface Totals {
  escrow: number;
  paid: number;
}

/** Milestone states that ask something of someone. */
const URGENT = ["needs_client", "held", "verifying", "review", "funded"] as const;
type Urgent = (typeof URGENT)[number];

/** Most urgent first, for whoever is looking: what the viewer can act on leads (the client decides needs_client and
 *  review; the freelancer delivers funded work), then what is stopped, then what is merely waiting. */
const URGENCY: Record<Role, readonly Urgent[]> = {
  client: ["needs_client", "review", "held", "verifying", "funded"],
  freelancer: ["funded", "held", "needs_client", "verifying", "review"],
  partner: URGENT,
  platform: ["held", "needs_client", "verifying", "review", "funded"],
};

/**
 * The row's status for this viewer: the most urgent milestone state with a count, worded for the role ("1 needs you" to
 * the client, "1 to deliver" to the freelancer), or the contract's own status when nothing is waiting.
 */
function rowStatus(contractStatus: string, states: string[], role: Role): { state: string; label?: string } {
  if (contractStatus !== "active") return { state: contractStatus };
  const state = (URGENCY[role] ?? URGENT).find((u) => states.includes(u));
  if (!state) return { state: contractStatus };
  const n = states.filter((s) => s === state).length;
  const words: Record<Urgent, string> = {
    needs_client: role === "client" ? "needs you" : "with client",
    held: "held",
    verifying: "verifying",
    review: "in review",
    funded: role === "freelancer" ? "to deliver" : "funded",
  };
  return { state, label: `${n} ${words[state]}` };
}

export default async function Home() {
  const db = getDb();
  const actor = await getActor();
  const [rows, ms, people] = await Promise.all([
    db.query.contracts.findMany({ orderBy: (t, { desc }) => [desc(t.createdAt)] }),
    db.query.milestones.findMany({
      columns: { id: true, contractId: true, seq: true, title: true, status: true, amountMinor: true, decision: true },
      orderBy: (t, { asc }) => [asc(t.contractId), asc(t.seq)],
    }),
    db.query.users.findMany({ columns: { id: true, name: true } }),
  ]);
  const name = (id: string) => people.find((p) => p.id === id)?.name ?? ACTOR_NAMES[id] ?? id;

  // Per contract: its milestones in order and where their money is. Per currency: the same, summed across contracts.
  const byContract = new Map<string, typeof ms>();
  for (const m of ms) byContract.set(m.contractId, [...(byContract.get(m.contractId) ?? []), m]);
  const paidOf = (m: (typeof ms)[number]) => (m.status === "partial_released" ? (m.decision?.amountMinor ?? 0) : m.amountMinor);
  const totals = (list: typeof ms): Totals => ({
    escrow: list.filter((m) => ESCROW_STATES.has(m.status)).reduce((s, m) => s + m.amountMinor, 0),
    paid: list.filter((m) => PAID_STATES.has(m.status)).reduce((s, m) => s + paidOf(m), 0),
  });
  const byCurrency = new Map<string, Totals>();
  for (const c of rows) {
    const t = totals(byContract.get(c.id) ?? []);
    const acc = byCurrency.get(c.currency) ?? { escrow: 0, paid: 0 };
    byCurrency.set(c.currency, { escrow: acc.escrow + t.escrow, paid: acc.paid + t.paid });
  }
  const [currency, sums] = [...byCurrency.entries()].sort((a, b) => b[1].escrow + b[1].paid - (a[1].escrow + a[1].paid))[0] ?? ["USD", { escrow: 0, paid: 0 }];
  const mixed = byCurrency.size > 1;

  // First run: the seeded signup flow contract is the demo's front door; otherwise the newest contract.
  const demo = rows.find((c) => c.id === "ctr_demo") ?? rows[0] ?? null;
  const start = demo
    ? { href: `/contracts/${demo.id}`, label: demo.id === "ctr_demo" ? "Open the signup flow contract" : "Open the newest contract" }
    : { href: "/contracts/new", label: "Draft a contract" };
  const firstName = (ACTOR_NAMES[actor.userId] ?? actor.userId).split(" ")[0]!;

  return (
    <main>
      <FirstRun
        role={actor.role}
        name={firstName}
        start={start}
        secondary={actor.role === "partner" ? { href: "/lender", label: "Lender’s book" } : null}
      />
      <PageHeader
        eyebrow={
          <>
            Ledger <span className="text-hairline-strong">/</span> {ACTOR_NAMES[actor.userId] ?? actor.userId}, {ROLE_LABELS[actor.role].toLowerCase()}
          </>
        }
        title="Contracts"
        description={
          // The first-run band already says this; the line comes back once the band is dismissed.
          <span className="intro-hidden">
            Each contract is a rail of milestones. The client&rsquo;s money waits in escrow at each station and moves to the freelancer only when the work is verified.
          </span>
        }
        aside={
          rows.length > 0 ? (
            <>
              <Stat label="In escrow" tone="funded" minor={sums.escrow} currency={currency} hint={mixed ? `${currency} only` : undefined} />
              <Stat label="Released" tone="released" minor={sums.paid} currency={currency} hint={mixed ? `${currency} only` : undefined} />
            </>
          ) : null
        }
        actions={
          <>
            <IntroToggle to="shown" className="intro-hidden" />
            {actor.role === "partner" ? null : (
              <>
                {/* One primary per view: while the first-run band shows, its "open the demo" button is the primary. */}
                <Button href="/contracts/new" variant="secondary" className="intro-shown">
                  New contract
                </Button>
                <Button href="/contracts/new" variant="primary" className="intro-hidden">
                  New contract
                </Button>
              </>
            )}
          </>
        }
      />

      <section className="mt-12" aria-label="All contracts">
        {rows.length === 0 ? (
          <EmptyState
            title="No contracts yet"
            body="Describe the work in plain English. Milestone drafts the milestones and the checks that release each payment."
            action={actor.role === "partner" ? null : <Button href="/contracts/new" variant="primary">Draft a contract</Button>}
          />
        ) : (
          <Panel padded={false}>
            <div className="hidden grid-cols-[minmax(0,1fr)_200px_170px] gap-6 border-b border-hairline px-5 py-3 md:grid">
              <p className="type-label text-fg-faint">Contract</p>
              <p className="type-label text-fg-faint">Milestones</p>
              <p className="type-label text-right text-fg-faint">Value</p>
            </div>
            <ol className="divide-y divide-hairline">
              {rows.map((c, i) => {
                const list = byContract.get(c.id) ?? [];
                const t = totals(list);
                const released = list.filter((m) => PAID_STATES.has(m.status)).length;
                const status = rowStatus(c.status, list.map((m) => m.status), actor.role);
                return (
                  <Reveal as="li" key={c.id} index={i}>
                    <Link
                      href={`/contracts/${c.id}`}
                      data-tone={toneOf(status.state)}
                      className="group relative grid gap-4 px-4 py-5 transition-colors duration-200 hover:bg-tone-wash focus-visible:bg-tone-wash active:bg-tone-soft active:duration-0 sm:px-5 md:grid-cols-[minmax(0,1fr)_200px_170px] md:items-center md:gap-6"
                    >
                      <span aria-hidden className="absolute top-3 bottom-3 left-0 w-[2px] origin-center scale-y-0 rounded-full bg-tone transition-transform duration-200 ease-glide group-hover:scale-y-100 group-active:scale-y-100" />
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                          <StatePill state={status.state} label={status.label} />
                          <span className="font-mono text-[11px] text-fg-faint tabular">
                            {c.id} · {formatDate(c.createdAt)}
                          </span>
                        </div>
                        <h2 className="type-display-s mt-2 truncate text-fg">{c.title}</h2>
                        <p className="mt-1 flex flex-wrap items-center gap-x-2 text-[13px] text-fg-muted">
                          <span>{name(c.clientId)}</span>
                          <svg aria-label="pays" viewBox="0 0 20 8" className="h-2 w-5 text-fg-faint" fill="none" stroke="currentColor" strokeWidth="1.2">
                            <path d="M0 4 H18 M15 1 L18 4 L15 7" />
                          </svg>
                          <span>{name(c.freelancerId)}</span>
                          {c.repoFullName ? <span className="font-mono text-[12px] text-fg-faint">{c.repoFullName}</span> : null}
                        </p>
                      </div>
                      <div className="flex items-center justify-between gap-4 md:block">
                        {/* 14px glyphs in 24px nodes so the states read at a 1440 capture (MiniRail itself stays 10px for tables). */}
                        <MiniRail items={list.map((m) => ({ state: m.status, label: m.title }))} className="[&_.size-5]:size-6 [&_.size-5>*]:size-3.5" />
                        <p className="font-mono text-[11px] text-fg-faint tabular md:mt-2">
                          {released} of {list.length} released
                        </p>
                      </div>
                      <div className="grid grid-cols-[1fr_auto] items-baseline gap-x-4 gap-y-2 md:block md:text-right">
                        <Money minor={c.totalMinor} currency={c.currency} size="m" animate />
                        <MoneyBar items={list.map((m) => ({ state: m.status, minor: m.amountMinor }))} className="col-span-2 row-start-2 md:mt-2.5" />
                        <p data-tone={t.escrow > 0 ? "funded" : "neutral"} className="row-start-1 font-mono text-[11px] text-fg-faint tabular md:mt-2">
                          {t.escrow > 0 ? (
                            <>
                              <span className="text-tone">in escrow</span> {formatMoney(t.escrow, c.currency)}
                            </>
                          ) : t.paid > 0 ? (
                            "escrow empty"
                          ) : (
                            "not funded"
                          )}
                        </p>
                      </div>
                    </Link>
                  </Reveal>
                );
              })}
            </ol>
          </Panel>
        )}
      </section>
    </main>
  );
}

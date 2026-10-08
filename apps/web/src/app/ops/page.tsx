import Link from "next/link";
import { and, desc, eq, inArray } from "drizzle-orm";
import { auditLog, contracts, milestones, paypalOps } from "@milestone/core";
import { getDb } from "@/lib/db";
import { getActor } from "@/lib/session";
import { formatMoney } from "@/lib/format";
import { ResolveForm } from "./resolve-form";

export const dynamic = "force-dynamic";

const dash = (v: unknown) => (v && typeof v === "object" && Object.keys(v).length > 0 ? JSON.stringify(v) : "none");

export default async function OpsPage() {
  const db = getDb();
  const actor = await getActor();
  const canAct = actor.role === "partner" || (actor.role as string) === "platform";

  const events = await db
    .select()
    .from(auditLog)
    .where(inArray(auditLog.event, ["milestone.needs_operator", "ops.resolved"]))
    .orderBy(desc(auditLog.createdAt));
  const latestFlag = new Map<string, (typeof events)[number]>();
  const latestResolved = new Map<string, Date>();
  for (const e of events) {
    if (!e.milestoneId) continue;
    if (e.event === "milestone.needs_operator" && !latestFlag.has(e.milestoneId)) latestFlag.set(e.milestoneId, e);
    if (e.event === "ops.resolved" && !latestResolved.has(e.milestoneId)) latestResolved.set(e.milestoneId, e.createdAt);
  }
  const open = [...latestFlag.values()].filter((f) => {
    const r = latestResolved.get(f.milestoneId!);
    return !r || r < f.createdAt;
  });
  const ids = open.map((f) => f.milestoneId!);
  const ms = ids.length ? await db.select().from(milestones).where(inArray(milestones.id, ids)) : [];
  const cs = ms.length ? await db.select().from(contracts).where(inArray(contracts.id, [...new Set(ms.map((m) => m.contractId))])) : [];
  const ops = ids.length ? await db.select().from(paypalOps).where(and(inArray(paypalOps.key, ids), inArray(paypalOps.kind, ["payout", "refund"]))) : [];
  const msById = new Map(ms.map((m) => [m.id, m]));
  const csById = new Map(cs.map((c) => [c.id, c]));

  return (
    <main className="space-y-6">
      <h1 className="text-2xl font-semibold">Operator queue</h1>
      <p className="text-sm text-zinc-500">
        Milestones flagged needs_operator. You are acting as {actor.role}.{canAct ? "" : " Only the partner or platform role can resolve."}
      </p>
      {open.length === 0 ? <p className="text-sm">Nothing needs an operator.</p> : null}
      {open.map((f) => {
        const m = msById.get(f.milestoneId!);
        const c = m ? csById.get(m.contractId) : undefined;
        const d = (f.detail && typeof f.detail === "object" ? f.detail : {}) as Record<string, unknown>;
        const myOps = ops.filter((o) => o.key === f.milestoneId);
        return (
          <section key={f.id} className="space-y-3 rounded border border-zinc-200 p-4 dark:border-zinc-800">
            <div>
              <h2 className="font-medium">
                {c ? <Link href={`/contracts/${c.id}`} className="underline">{c.title}</Link> : "Unknown contract"}
                {m ? `, milestone ${m.seq} ${m.title}` : ""}
              </h2>
              <p className="text-sm text-zinc-500">
                {m && c ? formatMoney(m.amountMinor, c.currency) : ""} / status {m?.status ?? "unknown"} / flagged {f.createdAt.toISOString().slice(0, 19).replace("T", " ")}
              </p>
              {typeof d.reason === "string" ? <p className="mt-1 text-sm">Reason: {d.reason}</p> : null}
            </div>
            <dl className="grid grid-cols-[6rem_1fr] gap-x-3 gap-y-1 text-sm">
              <dt className="text-zinc-500">Paid</dt><dd>{dash(d.paid)}</dd>
              <dt className="text-zinc-500">Failed</dt><dd>{dash(d.failed)}</dd>
              <dt className="text-zinc-500">Reversed</dt><dd>{dash(d.reversed)}</dd>
              <dt className="text-zinc-500">Pending</dt><dd>{Array.isArray(d.pending) && d.pending.length ? d.pending.join(", ") : "none"}</dd>
              <dt className="text-zinc-500">Refunded</dt><dd>{dash(d.refunded)}</dd>
            </dl>
            <div>
              <h3 className="text-sm font-medium">PayPal ops</h3>
              {myOps.length === 0 ? <p className="text-sm text-zinc-500">No paypal_ops rows.</p> : (
                <ul className="text-sm">
                  {myOps.map((o) => (
                    <li key={o.id}><code>{o.kind}</code> {o.status} / paypal id {o.paypalId ?? "none"} / request {o.requestId}</li>
                  ))}
                </ul>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-4">
              <ResolveForm milestoneId={f.milestoneId!} disabled={!canAct} />
              <form action="/api/dev/paypal/fail" method="post">
                <input type="hidden" name="sender_item_id" value={`${f.milestoneId}:freelancer`} />
                <button className="text-sm underline">Simulate payout failure</button>
              </form>
            </div>
          </section>
        );
      })}
    </main>
  );
}

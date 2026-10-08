"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { formatMoney } from "@/lib/format";

interface Terms {
  principalMinor: number;
  feeBpsPerDay: number;
  days: number;
  expectedFeeMinor: number;
  repaymentMinor: number;
  pFail: number;
  expectedLossMinor: number;
}
interface AdvanceView {
  id: string;
  status: "offered" | "funded" | "repaid" | "shortfall";
  principalMinor: number;
  feeBpsPerDay: number;
  feeMinor: number;
  repaymentMinor: number;
  fundedAt: string | null;
  repaidAt: string | null;
  explanation: string | null;
}
interface OfferResponse {
  milestoneId: string;
  currency: string;
  amountMinor: number;
  advance: AdvanceView | null;
  offer: { eligible: boolean; reason?: string };
  terms: Terms | null;
  explanation: string | null;
  explanationSource: "model" | "rules" | "stored";
}

const pct = (bps: number) => `${(bps / 100).toFixed(2)}%`;

async function fetchOffer(milestoneId: string): Promise<{ data: OfferResponse | null; error: string | null }> {
  try {
    const res = await fetch(`/api/advances/offer?milestoneId=${encodeURIComponent(milestoneId)}`, { cache: "no-store" });
    const body = (await res.json().catch(() => null)) as (OfferResponse & { error?: string }) | null;
    if (!res.ok || !body) return { data: null, error: body?.error ?? `could not load the offer (${res.status})` };
    return { data: body, error: null };
  } catch (e) {
    return { data: null, error: e instanceof Error ? e.message : "could not load the offer" };
  }
}

function Row({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <>
      <dt className="text-zinc-500 dark:text-zinc-400">{label}</dt>
      <dd className={`text-right tabular-nums ${strong ? "font-semibold" : ""}`}>{value}</dd>
    </>
  );
}

/**
 * Milestone Advance for the freelancer on a funded milestone: shows the offer (amount now, fee per day, repayment at the
 * due date, the explanation) with a "Get paid now" button that accepts it; once accepted, shows the funding progress,
 * then the funded principal and the repayment that will be deducted from the release. Renders nothing for a milestone
 * that is not eligible unless `showIneligible` is set.
 */
export function AdvanceOffer({ milestoneId, showIneligible = false }: { milestoneId: string; showIneligible?: boolean }) {
  const router = useRouter();
  const [data, setData] = useState<OfferResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await fetchOffer(milestoneId);
    if (r.data) setData(r.data);
    setError(r.error);
    setLoading(false);
    return r.data;
  }, [milestoneId]);

  useEffect(() => {
    let live = true;
    fetchOffer(milestoneId).then((r) => {
      if (!live) return;
      if (r.data) setData(r.data);
      setError(r.error);
      setLoading(false);
    });
    return () => {
      live = false;
    };
  }, [milestoneId]);

  // While the advance job pays it out, poll until it is funded (bounded: about a minute).
  const pending = data?.advance?.status === "offered";
  useEffect(() => {
    if (!pending) return;
    let tries = 0;
    const t = setInterval(async () => {
      tries++;
      const next = await load();
      if (next?.advance?.status !== "offered" || tries >= 30) {
        clearInterval(t);
        if (next?.advance?.status === "funded") router.refresh();
      }
    }, 2_000);
    return () => clearInterval(t);
  }, [pending, load, router]);

  async function accept() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/advances/accept", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ milestoneId }) });
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      await load();
      if (!res.ok) setError(body?.error ?? `request failed (${res.status})`);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "request failed");
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <div className="mt-3 h-24 animate-pulse rounded-lg bg-zinc-100 dark:bg-zinc-900" aria-label="Loading advance offer" />;
  if (!data) return error ? <p role="alert" className="mt-3 text-sm text-rose-700 dark:text-rose-400">{error}</p> : null;
  const cur = data.currency;
  const money = (minor: number) => formatMoney(minor, cur);
  const card = "mt-3 space-y-3 rounded-lg border p-4 text-sm";

  if (data.advance) {
    const a = data.advance;
    const title =
      a.status === "funded" ? "Funded" : a.status === "repaid" ? "Advance repaid" : a.status === "shortfall" ? "Advance shortfall" : "Paying you now";
    return (
      <section className={`${card} border-emerald-200 bg-emerald-50/60 dark:border-emerald-900 dark:bg-emerald-950/40`} aria-live="polite">
        <div className="flex items-baseline justify-between gap-3">
          <h3 className="font-semibold">Milestone Advance: {title}</h3>
          {a.status === "offered" ? <span className="text-xs text-zinc-500 dark:text-zinc-400">sending via PayPal...</span> : null}
        </div>
        <dl className="grid grid-cols-[1fr_auto] gap-x-6 gap-y-1">
          <Row label={a.status === "offered" ? "Advance" : "Paid to you"} value={money(a.principalMinor)} strong />
          <Row label="Fee" value={`${money(a.feeMinor)} (${pct(a.feeBpsPerDay)} per day)`} />
          <Row label={a.status === "repaid" ? "Repaid from the release" : "Deducted from the release"} value={money(a.repaymentMinor)} />
          <Row label="You receive on release" value={money(Math.max(0, data.amountMinor - a.repaymentMinor))} />
        </dl>
        {a.fundedAt ? <p className="text-xs text-zinc-500 dark:text-zinc-400">Funded {a.fundedAt.slice(0, 16).replace("T", " ")} UTC.</p> : null}
        {error ? <p role="alert" className="text-rose-700 dark:text-rose-400">{error}</p> : null}
      </section>
    );
  }

  if (!data.offer.eligible || !data.terms) {
    if (!showIneligible) return null;
    return <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">No advance offered: {data.offer.reason ?? "not eligible"}.</p>;
  }

  const t = data.terms;
  return (
    <section className={`${card} border-sky-200 bg-sky-50/60 dark:border-sky-900 dark:bg-sky-950/40`}>
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="font-semibold">Get paid now with Milestone Advance</h3>
        <span className="text-lg font-semibold tabular-nums">{money(t.principalMinor)}</span>
      </div>
      <dl className="grid grid-cols-[1fr_auto] gap-x-6 gap-y-1">
        <Row label="Fee per day" value={pct(t.feeBpsPerDay)} />
        <Row label={`Fee at the due date (${t.days} day${t.days === 1 ? "" : "s"})`} value={money(t.expectedFeeMinor)} />
        <Row label="Deducted from the release" value={money(t.repaymentMinor)} strong />
        <Row label="You receive on release" value={money(Math.max(0, data.amountMinor - t.repaymentMinor))} />
      </dl>
      {data.explanation ? (
        <p className="text-zinc-700 dark:text-zinc-300">
          {data.explanation}
          {data.explanationSource === "model" ? <span className="ml-1 text-xs text-zinc-500">(explained by the agent; the numbers come from the pricing rules)</span> : null}
        </p>
      ) : null}
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={accept}
          disabled={busy}
          className="rounded-lg bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-zinc-700 disabled:cursor-wait disabled:opacity-50 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200"
        >
          {busy ? "Working..." : "Get paid now"}
        </button>
        <span className="text-xs text-zinc-500 dark:text-zinc-400">Paid by our capital partner via PayPal and repaid automatically out of the release.</span>
      </div>
      {error ? <p role="alert" className="text-rose-700 dark:text-rose-400">{error}</p> : null}
    </section>
  );
}

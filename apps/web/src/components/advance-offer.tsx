"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Money, type ToneKey } from "@/components/ui";

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

/** One term of the offer: label, dotted leader, the figure in mono. */
function Row({ label, children, strong = false }: { label: string; children: React.ReactNode; strong?: boolean }) {
  return (
    <div className="flex items-baseline gap-3 py-1.5">
      <dt className={`min-w-0 text-[13px] ${strong ? "text-fg" : "text-fg-muted"}`}>{label}</dt>
      <span aria-hidden className="leader" />
      <dd className="shrink-0 text-right">{children}</dd>
    </div>
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

  if (loading)
    return (
      <div aria-label="Loading advance offer" className="flex h-24 items-center rounded-panel border border-dashed border-hairline-strong px-4 sm:px-5">
        <p className="type-label text-fg-faint">Milestone Advance · loading offer</p>
      </div>
    );
  if (!data) return error ? <p role="alert" className="text-[13px] text-state-danger">{error}</p> : null;
  const cur = data.currency;
  const money = (minor: number, tone?: ToneKey) => <Money minor={minor} currency={cur} tone={tone} />;

  if (data.advance) {
    const a = data.advance;
    const tone: ToneKey = a.status === "shortfall" ? "danger" : a.status === "offered" ? "funded" : "released";
    const title =
      a.status === "funded" ? "Paid to you" : a.status === "repaid" ? "Repaid" : a.status === "shortfall" ? "Shortfall" : "Paying you now";
    return (
      <section data-tone={tone} aria-live="polite" aria-label="Milestone Advance" className="overflow-hidden rounded-panel border border-hairline bg-surface-sunken">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-dashed border-hairline-strong px-4 py-3 sm:px-5">
          <p className="type-label flex items-center gap-2 text-fg-faint">
            Milestone Advance
            <span className="flex items-center gap-1.5 text-tone">
              <span aria-hidden className={`size-1.5 rounded-full bg-tone ${a.status === "offered" ? "animate-pulse-dot" : ""}`} />
              {title}
            </span>
          </p>
          <Money minor={a.principalMinor} currency={cur} size="m" tone={tone} animate />
        </div>
        <dl className="px-4 py-2 sm:px-5">
          <Row label="Fee">
            <span className="inline-flex items-baseline gap-2">
              {money(a.feeMinor)}
              <span className="font-mono text-[11px] text-fg-faint tabular">{pct(a.feeBpsPerDay)}/day</span>
            </span>
          </Row>
          <Row label={a.status === "repaid" ? "Repaid from the release" : "Deducted from the release"}>{money(a.repaymentMinor)}</Row>
          <Row label="You receive on release" strong>
            {money(Math.max(0, data.amountMinor - a.repaymentMinor))}
          </Row>
        </dl>
        {a.fundedAt || a.status === "offered" || error ? (
          <div className="border-t border-hairline px-4 py-2.5 sm:px-5">
            {a.status === "offered" ? <p className="font-mono text-[11px] text-fg-faint">sending via PayPal from the capital partner...</p> : null}
            {a.fundedAt ? <p className="font-mono text-[11px] text-fg-faint tabular">funded {a.fundedAt.slice(0, 16).replace("T", " ")} UTC</p> : null}
            {error ? <p role="alert" className="text-[13px] text-state-danger">{error}</p> : null}
          </div>
        ) : null}
      </section>
    );
  }

  if (!data.offer.eligible || !data.terms) {
    if (!showIneligible) return null;
    return <p className="text-[13px] text-fg-muted">No advance offered: {data.offer.reason ?? "not eligible"}.</p>;
  }

  const t = data.terms;
  return (
    <section data-tone="funded" aria-label="Milestone Advance offer" className="overflow-hidden rounded-panel border border-hairline bg-surface-sunken">
      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-dashed border-hairline-strong px-4 py-3 sm:px-5">
        <div>
          <p className="type-label text-fg-faint">Milestone Advance</p>
          <p className="mt-1 text-[14px] text-fg">Get paid now, before the release.</p>
        </div>
        <Money minor={t.principalMinor} currency={cur} size="m" tone="funded" animate />
      </div>
      <dl className="px-4 py-2 sm:px-5">
        <Row label="Fee per day">
          <span className="font-mono text-[13px] text-fg tabular">{pct(t.feeBpsPerDay)}</span>
        </Row>
        <Row label={`Fee at the due date (${t.days} day${t.days === 1 ? "" : "s"})`}>{money(t.expectedFeeMinor)}</Row>
        <Row label="Deducted from the release">{money(t.repaymentMinor)}</Row>
        <Row label="You receive on release" strong>
          {money(Math.max(0, data.amountMinor - t.repaymentMinor))}
        </Row>
      </dl>
      {data.explanation ? (
        <p className="border-t border-hairline px-4 py-3 text-[13px] leading-relaxed text-fg-muted sm:px-5">
          {data.explanation}
          {data.explanationSource === "model" ? <span className="mt-1 block font-mono text-[10.5px] text-fg-faint">explained by the agent; the numbers come from the pricing rules</span> : null}
        </p>
      ) : null}
      <div className="flex flex-col gap-3 border-t border-hairline px-4 py-3.5 sm:flex-row sm:items-center sm:px-5">
        <Button variant="secondary" size="sm" onClick={accept} disabled={busy} aria-busy={busy} className="self-start">
          {busy ? "Working..." : "Get paid now"}
        </Button>
        <span className="text-[12.5px] text-fg-faint">Paid by our capital partner via PayPal, repaid automatically out of the release.</span>
      </div>
      {error ? <p role="alert" className="px-4 pb-3 text-[13px] text-state-danger sm:px-5">{error}</p> : null}
    </section>
  );
}

"use client";

import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent } from "react";
import { ACTION_HINTS, ACTION_LABELS } from "@/components/agent-console-mandate";
import { Button, Eyebrow, Field, Panel, inputClass } from "@/components/ui";
import { thrownText } from "@/lib/api-client";
import { TOKEN_STORAGE_PREFIX } from "@/lib/agent/protocol";
import { minorDigits } from "@/lib/format";
import { createMandateRequest } from "./agents-api";

const ACTIONS = ["read", "draft_contract", "fund", "deliver", "approve", "hold"] as const;
const EXPIRIES = [
  { days: 1, label: "1 day" },
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
];

/** "200", "200.5", "1,200.00" -> minor units; null when not a non-negative amount. */
export function toMinor(text: string, currency: string): number | null {
  const s = text.replace(/[,\s]/g, "");
  const digits = minorDigits(currency);
  if (!(digits ? /^\d+(\.\d{0,2})?$/ : /^\d+$/).test(s)) return null;
  const [whole, frac = ""] = s.split(".");
  const minor = Number(whole) * 10 ** digits + Number((frac + "00").slice(0, digits) || 0);
  return Number.isSafeInteger(minor) ? minor : null;
}

/** Create a mandate; the token is shown here once (and kept in this tab's sessionStorage for the console). */
export function MandateForm({ defaultName, allowed, hasSavedPayPal = false }: { defaultName: string; allowed: readonly string[]; hasSavedPayPal?: boolean }) {
  const offered = ACTIONS.filter((a) => allowed.includes(a));
  const router = useRouter();
  const id = useId();
  const [name, setName] = useState(defaultName);
  const [actions, setActions] = useState<Set<string>>(() => new Set(["read", "approve", "hold"].filter((a) => allowed.includes(a))));
  const [cap, setCap] = useState("200.00");
  const [currency, setCurrency] = useState("USD");
  const [days, setDays] = useState(30);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ id: string; token: string; name: string } | null>(null);
  const [copied, setCopied] = useState(false);
  // "May fund milestones": charges of the saved PayPal, bounded by both caps (needs the fund action).
  const [vault, setVault] = useState(false);
  const [fundCap, setFundCap] = useState("150.00");
  const [fundTotal, setFundTotal] = useState("500.00");
  const [autoFund, setAutoFund] = useState(false);

  const approve = actions.has("approve");
  const canFund = offered.includes("fund");
  const toggle = (a: string) => {
    if (a === "fund" && actions.has("fund")) {
      setVault(false);
      setAutoFund(false);
    }
    setActions((prev) => {
      const next = new Set(prev);
      if (next.has(a)) next.delete(a);
      else next.add(a);
      return next;
    });
  };
  const toggleVault = () => {
    const on = !vault;
    setVault(on);
    if (on) setActions((prev) => new Set(prev).add("fund"));
    else setAutoFund(false);
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!name.trim()) return setError("Name the agent.");
    if (actions.size === 0) return setError("Pick at least one action.");
    const capMinor = approve ? toMinor(cap, currency) : null;
    if (approve && capMinor === null) return setError("The approval cap must be an amount, such as 200.00.");
    const fundCapMinor = vault ? toMinor(fundCap, currency) : null;
    const fundTotalCapMinor = vault ? toMinor(fundTotal, currency) : null;
    if (vault && (fundCapMinor === null || fundCapMinor === 0)) return setError("The per-milestone fund cap must be an amount, such as 150.00.");
    if (vault && (fundTotalCapMinor === null || fundTotalCapMinor === 0)) return setError("The total fund cap must be an amount, such as 500.00.");
    if (vault && fundCapMinor! > fundTotalCapMinor!) return setError("The per-milestone fund cap cannot be more than the total.");
    setBusy(true);
    try {
      const r = await createMandateRequest({
        agentName: name.trim(),
        actions: offered.filter((a) => actions.has(a)),
        approveCapMinor: capMinor,
        fundCapMinor,
        fundTotalCapMinor,
        autoFundNext: vault && autoFund,
        currency,
        expiresInDays: days,
      });
      if (!r.ok) return setError(r.error);
      try {
        sessionStorage.setItem(TOKEN_STORAGE_PREFIX + r.id, r.token);
      } catch {
        // storage blocked: the token is still on screen to copy
      }
      setCreated({ id: r.id, token: r.token, name: name.trim() });
      setCopied(false);
      router.refresh();
    } catch (err) {
      setError(thrownText(err));
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.token);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  if (created) {
    return (
      <Panel tone="funded" className="grid gap-4">
        <div>
          <Eyebrow>Token for {created.name}</Eyebrow>
          <p className="mt-2 text-fg-muted">Shown once. Milestone keeps only its hash, so copy it now. This tab also remembers it for the console.</p>
        </div>
        <Panel variant="sunken" padded={false} className="px-3 py-3">
          <code className="block break-all font-mono text-[13px] leading-5 text-fg" data-testid="agent-token">
            {created.token}
          </code>
        </Panel>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" onClick={copy}>
            {copied ? "Copied" : "Copy token"}
          </Button>
          <Button variant="primary" size="sm" href={`/agents/console?mandate=${encodeURIComponent(created.id)}`}>
            Open the console
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setCreated(null)}>
            Create another
          </Button>
        </div>
      </Panel>
    );
  }

  return (
    <Panel as="section" aria-labelledby={`${id}-title`}>
      <form onSubmit={submit} className="grid gap-5">
        <div>
          <Eyebrow>New mandate</Eyebrow>
          <h2 id={`${id}-title`} className="type-display-m mt-2 text-fg">
            Delegate to an agent
          </h2>
        </div>
        <Field label="Agent name" htmlFor={`${id}-name`}>
          <input id={`${id}-name`} className={inputClass} value={name} onChange={(e) => setName(e.target.value)} maxLength={60} autoComplete="off" />
        </Field>
        <fieldset className="grid gap-2">
          <legend className="type-label mb-2 text-fg-faint">Allowed actions</legend>
          <div className="grid gap-x-4 gap-y-1 sm:grid-cols-2">
            {offered.map((a) => (
              <label key={a} className="flex cursor-pointer items-start gap-2.5 rounded-control px-2 py-1.5 hover:bg-surface-raised">
                <input type="checkbox" className="mt-1 accent-[var(--fg)]" checked={actions.has(a)} onChange={() => toggle(a)} />
                <span className="min-w-0">
                  <span className="block text-[14px] text-fg">{ACTION_LABELS[a]}</span>
                  <span className="block text-[12px] leading-4 text-fg-faint">{ACTION_HINTS[a]}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        {canFund ? (
          <fieldset className="grid gap-3 border-t border-hairline pt-4" data-testid="fund-terms">
            <legend className="sr-only">May fund milestones</legend>
            <label className="flex cursor-pointer items-start gap-2.5 rounded-control px-2 py-1.5 hover:bg-surface-raised">
              <input type="checkbox" className="mt-1 accent-[var(--fg)]" checked={vault} onChange={toggleVault} />
              <span className="min-w-0">
                <span className="block text-[14px] text-fg">May fund milestones</span>
                <span className="block text-[12px] leading-4 text-fg-faint">
                  Pays the next milestone of a contract you both signed into escrow from your saved PayPal, for exactly its amount.
                  {hasSavedPayPal ? "" : " Save your PayPal below first."}
                </span>
              </span>
            </label>
            {vault ? (
              <div className="grid gap-4 pl-2 sm:pl-8">
                <div className="grid items-start gap-4 sm:grid-cols-2">
                  <Field label="Per milestone, at most" htmlFor={`${id}-fcap`} hint={`Largest single milestone, in ${currency}.`}>
                    <input id={`${id}-fcap`} className={`${inputClass} font-mono tabular`} inputMode="decimal" value={fundCap} onChange={(e) => setFundCap(e.target.value)} />
                  </Field>
                  <Field label="In all, at most" htmlFor={`${id}-ftotal`} hint="Everything this mandate may ever fund.">
                    <input id={`${id}-ftotal`} className={`${inputClass} font-mono tabular`} inputMode="decimal" value={fundTotal} onChange={(e) => setFundTotal(e.target.value)} />
                  </Field>
                </div>
                <label className="flex cursor-pointer items-start gap-2.5 rounded-control px-2 py-1.5 hover:bg-surface-raised">
                  <input type="checkbox" className="mt-1 accent-[var(--fg)]" checked={autoFund} onChange={() => setAutoFund((v) => !v)} />
                  <span className="min-w-0">
                    <span className="block text-[14px] text-fg">Fund the next milestone when the previous one is released</span>
                    <span className="block text-[12px] leading-4 text-fg-faint">No model involved: Milestone does it under this mandate, within the same caps.</span>
                  </span>
                </label>
              </div>
            ) : null}
          </fieldset>
        ) : null}
        <div className="grid items-start gap-4 sm:grid-cols-[1fr_96px_1fr]">
          <Field label="Approval cap" htmlFor={`${id}-cap`} hint={approve ? "Largest single release it may approve." : "Needs Approve releases."}>
            <input id={`${id}-cap`} className={`${inputClass} font-mono tabular`} inputMode="decimal" value={approve ? cap : ""} placeholder="none" disabled={!approve} onChange={(e) => setCap(e.target.value)} />
          </Field>
          <Field label="Currency" htmlFor={`${id}-cur`}>
            <select id={`${id}-cur`} className={`${inputClass} font-mono`} value={currency} onChange={(e) => setCurrency(e.target.value)}>
              {["USD", "EUR", "GBP"].map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </Field>
          <Field label="Expires after" htmlFor={`${id}-exp`}>
            <select id={`${id}-exp`} className={inputClass} value={days} onChange={(e) => setDays(Number(e.target.value))}>
              {EXPIRIES.map((x) => (
                <option key={x.days} value={x.days}>
                  {x.label}
                </option>
              ))}
            </select>
          </Field>
        </div>
        {error ? <p className="text-[13px] text-state-danger">{error}</p> : null}
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? "Creating…" : "Create mandate"}
          </Button>
          <p className="font-mono text-[11px] text-fg-faint">Revocable any time. The token is shown once.</p>
        </div>
      </form>
    </Panel>
  );
}

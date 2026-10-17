"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button, Eyebrow, Panel } from "@/components/ui";
import { thrownText } from "@/lib/api-client";
import { removeVaultRequest, startVaultRequest } from "./agents-api";

export interface SavedPayPalView {
  id: string;
  payerEmail: string | null;
  /** Last four characters of the vault token (the token itself never reaches the browser). */
  tokenTail: string;
  /** Already formatted on the server ("Oct 17, 2026"). */
  savedOn: string;
}

/** What /api/vault/return reported (?vault=saved|cancelled|error&reason=...). */
export interface VaultOutcome {
  vault: "saved" | "cancelled" | "error";
  reason: string | null;
}

const REASONS: Record<string, string> = {
  unknown_setup: "That approval does not belong to a setup you started here.",
  paypal_error: "PayPal did not save the account. Nothing was charged; try again.",
  missing_approval_token: "PayPal sent you back without an approval.",
  not_client: "Only a client saves a PayPal for agent payments.",
};

/**
 * The client's saved PayPal (PayPal vault): save it once, approve at PayPal, and agents whose mandate has fund caps can
 * fund milestones from it without asking again. Shows the account and a two-step Remove once saved.
 */
export function SavedPayPal({ saved, outcome, simulated, canSave }: { saved: SavedPayPalView | null; outcome: VaultOutcome | null; simulated: boolean; canSave: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const r = await startVaultRequest();
      if (!r.ok) {
        setError(r.error);
        setBusy(false);
        return;
      }
      window.location.assign(r.approveUrl);
    } catch (e) {
      setError(thrownText(e));
      setBusy(false);
    }
  }

  async function remove() {
    if (!saved) return;
    setBusy(true);
    setError(null);
    try {
      const r = await removeVaultRequest(saved.id);
      if (!r.ok) setError(r.error);
      router.replace("/agents#saved-paypal", { scroll: false });
      router.refresh();
    } catch (e) {
      setError(thrownText(e));
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  const notice =
    outcome?.vault === "saved" && saved ? (
      <p data-tone="funded" className="flex items-baseline gap-2.5 text-[13px] text-fg-muted">
        <span aria-hidden className="size-1.5 shrink-0 translate-y-[-1px] rounded-full bg-tone" />
        Saved. A mandate with fund caps can now fund your milestones from it.
      </p>
    ) : outcome?.vault === "cancelled" ? (
      <p className="text-[13px] text-fg-faint">Nothing saved: the approval was cancelled at PayPal.</p>
    ) : outcome?.vault === "error" ? (
      <p className="text-[13px] text-state-danger">{REASONS[outcome.reason ?? ""] ?? "PayPal did not save the account."}</p>
    ) : null;

  return (
    <Panel as="section" aria-labelledby="saved-paypal-title" tone={saved ? "funded" : undefined} className="grid gap-5">
      <div>
        <Eyebrow>Saved PayPal · vault</Eyebrow>
        <h2 id="saved-paypal-title" className="type-display-m mt-2 text-fg">
          {saved ? "Your agent can pay from this" : "Save PayPal for agent payments"}
        </h2>
        <p className="mt-2 text-[14px] text-fg-muted">
          Approve once at PayPal. After that, an agent whose mandate may fund milestones pays each one into escrow from this account, within the caps you set. Nothing
          is charged when you save it.
        </p>
      </div>

      {saved ? (
        <Panel variant="sunken" padded={false} className="flex flex-wrap items-center gap-x-4 gap-y-3 px-4 py-3.5">
          <div className="min-w-0 flex-1">
            <p className="truncate text-[15px] text-fg" data-testid="saved-paypal-email">
              {saved.payerEmail ?? "PayPal account"}
            </p>
            <p className="mt-0.5 font-mono text-[11px] text-fg-faint tabular">
              PayPal · vault ···{saved.tokenTail} · saved {saved.savedOn}
            </p>
          </div>
          {confirming ? (
            <div className="flex gap-2">
              <Button variant="ghost" size="sm" onClick={() => setConfirming(false)} disabled={busy}>
                Keep
              </Button>
              <Button variant="danger" size="sm" onClick={remove} disabled={busy} aria-label="Confirm removing the saved PayPal">
                {busy ? "Removing…" : "Remove now"}
              </Button>
            </div>
          ) : (
            <Button variant="danger" size="sm" onClick={() => setConfirming(true)} aria-label="Remove the saved PayPal">
              Remove
            </Button>
          )}
        </Panel>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="secondary" onClick={save} disabled={busy || !canSave}>
            {busy ? "Opening PayPal…" : "Save PayPal for agent payments"}
          </Button>
          <p className="font-mono text-[11px] text-fg-faint">{canSave ? (simulated ? "Simulated PayPal: approval opens the local simulator." : "You approve at PayPal, then come back here.") : "Switch to the client to save a PayPal."}</p>
        </div>
      )}

      {notice}
      {error ? <p className="text-[13px] text-state-danger">{error}</p> : null}
      {saved ? <p className="font-mono text-[11px] text-fg-faint">Removing it stops every agent charge at once. Money already in escrow stays there.</p> : null}
    </Panel>
  );
}

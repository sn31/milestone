// One wording for a payout that went wrong, wherever it is shown (the operator queue, the audit log, the contract page).
// The worker's flag reason carries the raw webhook event ("Payout PAYMENT.PAYOUTS-ITEM.FAILED for the freelancer:
// Receiver is unregistered") and the seed's says "A payout item failed"; both read the same once they pass through here.

/** PayPal's payout item errors, as a person would say them. */
const REASONS: Array<[RegExp, string]> = [
  [/unregistered/i, "receiver is not registered with PayPal"],
  [/locked|inactive/i, "receiver's PayPal account is locked or inactive"],
  [/unconfirmed/i, "receiver's email or phone is not confirmed"],
  [/risk/i, "PayPal declined it on risk"],
  [/insufficient/i, "the platform account did not have the funds"],
  [/blocked/i, "PayPal blocked it"],
  [/returned/i, "the payment was returned"],
  [/reversed/i, "PayPal reversed it"],
  [/refunded/i, "the payment was refunded"],
  [/unclaimed/i, "the receiver has not claimed it"],
];

/** "Receiver is unregistered" -> "receiver is not registered with PayPal"; anything unknown, lower-cased as given. */
export function payoutReason(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const known = REASONS.find(([re]) => re.test(raw));
  if (known) return known[1];
  const t = raw.replace(/PAYMENT\.PAYOUTS-ITEM\.[A-Z_]+/g, "").trim();
  return t ? t.charAt(0).toLowerCase() + t.slice(1) : null;
}

/** The word for what happened, from a webhook event type or a reason. */
function verb(raw: string): string {
  const m = /PAYOUTS-ITEM\.([A-Z_]+)/.exec(raw)?.[1] ?? "";
  if (/BLOCKED/.test(m)) return "blocked";
  if (/RETURNED/.test(m)) return "returned";
  if (/REVERSED/.test(m)) return "reversed";
  if (/UNCLAIMED/.test(m)) return "unclaimed";
  if (/HELD/.test(m)) return "held by PayPal";
  if (/REFUNDED/.test(m)) return "refunded";
  return "failed";
}

/**
 * The flag of a stopped milestone as one sentence: "Payout to the freelancer failed: receiver is not registered with
 * PayPal." Reads the structured `failed` / `reversed` maps first, then the free-text reason.
 */
export function payoutFailureLine(detail: Record<string, unknown>): string | null {
  const failed = detail.failed && typeof detail.failed === "object" ? (detail.failed as Record<string, unknown>) : {};
  const reversed = detail.reversed && typeof detail.reversed === "object" ? (detail.reversed as Record<string, unknown>) : {};
  const parts: string[] = [];
  for (const [party, why] of Object.entries(failed)) {
    const r = payoutReason(typeof why === "string" ? why : null);
    parts.push(`Payout to the ${party} failed${r ? `: ${r}` : ""}`);
  }
  for (const [party, v] of Object.entries(reversed)) {
    const ev = v && typeof v === "object" ? String((v as Record<string, unknown>).eventType ?? "") : "";
    parts.push(`Payout to the ${party} ${ev ? verb(ev) : "reversed"}`);
  }
  if (parts.length) return `${parts.join("; ")}.`;
  const reason = typeof detail.reason === "string" ? detail.reason : null;
  if (!reason) return null;
  // "Payout PAYMENT.PAYOUTS-ITEM.FAILED for the freelancer: Receiver is unregistered"
  const live = /^Payout (\S+) for the (\w+)(?::\s*(.*))?$/.exec(reason);
  if (live) {
    const r = payoutReason(live[3]);
    return `Payout to the ${live[2]} ${verb(live[1]!)}${r ? `: ${r}` : ""}.`;
  }
  return /[.!?]$/.test(reason) ? reason : `${reason}.`;
}

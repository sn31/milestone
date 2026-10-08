// Browser side of the app's JSON routes: one POST helper for every form, and the words for a route's refusal.

/** What a route answered: the status and the parsed JSON body (null when there was none or it was not JSON). */
export interface JsonReply<T> {
  ok: boolean;
  status: number;
  statusText: string;
  body: (T & { error?: unknown }) | null;
  /** The route's own `error` message, or "request failed (<status>)". */
  error: string;
}

/**
 * POSTs `data` to one of the app's routes: as JSON, as multipart when it is FormData, or with no body when it is left
 * out. Resolves with the reply whatever the status; rejects only when the request itself fails (network, abort).
 */
export async function postJson<T = Record<string, unknown>>(url: string, data?: unknown): Promise<JsonReply<T>> {
  const init: RequestInit =
    data === undefined
      ? { method: "POST" }
      : data instanceof FormData
        ? { method: "POST", body: data }
        : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) };
  const res = await fetch(url, init);
  const body = (await res.json().catch(() => null)) as JsonReply<T>["body"];
  const error = typeof body?.error === "string" ? body.error : `request failed (${res.status})`;
  return { ok: res.ok, status: res.status, statusText: res.statusText, body, error };
}

/** The message of whatever a failed request threw. */
export function thrownText(e: unknown, fallback = "request failed"): string {
  return e instanceof Error ? e.message : fallback;
}

/** Human text for the 409 reasons the review route returns; falls back to the route's own error message. */
export function refusalText(body: { error?: unknown; reason?: unknown; criteria?: unknown } | null, status: number): string {
  const error = typeof body?.error === "string" ? body.error : `request failed (${status})`;
  const reason = typeof body?.reason === "string" ? body.reason : null;
  if (!reason) return error;
  if (reason === "needs_operator") return "An earlier payout or refund for this milestone went wrong and needs an operator. Nothing more can be approved or stopped here.";
  if (reason === "review_window_closed") return "The review window has closed, so the release can no longer be vetoed.";
  if (reason === "required_criteria_not_passed") {
    const list = Array.isArray(body?.criteria) ? body.criteria.filter((c): c is string => typeof c === "string") : [];
    return list.length > 0 ? `Required criteria did not pass: ${list.join(", ")}.` : "Required criteria did not pass.";
  }
  if (/^(payout|refund)_(sent|succeeded|failed)$/.test(reason)) {
    const kind = reason.startsWith("payout") ? "payout" : "refund";
    return `The ${kind} has already been sent to PayPal, so it can no longer be changed or stopped.`;
  }
  return error;
}

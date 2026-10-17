// Browser side of the mandate API: POST /api/agents ({ mandate, token }, the token shown once),
// POST /api/agents/<id>/revoke and PATCH /api/agents/<id> (funding terms); and of the saved PayPal:
// POST /api/vault/start (approve link) and DELETE /api/vault.
import { postJson } from "@/lib/api-client";

export interface CreateMandateBody {
  agentName: string;
  actions: string[];
  approveCapMinor: number | null;
  /** Vault funding: both caps or neither (minor units). */
  fundCapMinor: number | null;
  fundTotalCapMinor: number | null;
  autoFundNext: boolean;
  currency: string;
  expiresInDays: number;
}

export type CreateResult = { ok: true; id: string; token: string } | { ok: false; error: string };

export async function createMandateRequest(body: CreateMandateBody): Promise<CreateResult> {
  const r = await postJson<{ mandate?: { id?: unknown }; id?: unknown; token?: unknown }>("/api/agents", body);
  if (!r.ok) return { ok: false, error: r.error };
  const id = r.body?.mandate?.id ?? r.body?.id;
  const token = r.body?.token;
  if (typeof id !== "string" || typeof token !== "string") return { ok: false, error: "The mandate was created but no token came back" };
  return { ok: true, id, token };
}

export async function revokeMandateRequest(id: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const r = await postJson(`/api/agents/${encodeURIComponent(id)}/revoke`);
  return r.ok ? { ok: true } : { ok: false, error: r.error };
}

/** The fetch result as { ok, error } with the route's own error message. */
async function send(url: string, method: "PATCH" | "DELETE", data?: unknown): Promise<{ ok: boolean; status: number; body: Record<string, unknown> | null; error: string }> {
  const res = await fetch(url, data === undefined ? { method } : { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  return { ok: res.ok, status: res.status, body, error: typeof body?.error === "string" ? body.error : `request failed (${res.status})` };
}

export async function setAutoFundRequest(id: string, autoFundNext: boolean): Promise<{ ok: true } | { ok: false; error: string }> {
  const r = await send(`/api/agents/${encodeURIComponent(id)}`, "PATCH", { autoFundNext });
  return r.ok ? { ok: true } : { ok: false, error: r.error };
}

/** Starts saving the PayPal: the approve link to send the browser to. */
export async function startVaultRequest(): Promise<{ ok: true; approveUrl: string } | { ok: false; error: string }> {
  const r = await postJson<{ approveUrl?: unknown }>("/api/vault/start");
  if (!r.ok) return { ok: false, error: r.error };
  const url = r.body?.approveUrl;
  return typeof url === "string" ? { ok: true, approveUrl: url } : { ok: false, error: "PayPal returned no approval link" };
}

export async function removeVaultRequest(paymentMethodId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const r = await send("/api/vault", "DELETE", { paymentMethodId });
  return r.ok ? { ok: true } : { ok: false, error: r.error };
}

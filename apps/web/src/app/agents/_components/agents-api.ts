// Browser side of the mandate API: POST /api/agents ({ mandate, token }, the token shown once) and
// POST /api/agents/<id>/revoke.
import { postJson } from "@/lib/api-client";

export interface CreateMandateBody {
  agentName: string;
  actions: string[];
  approveCapMinor: number | null;
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

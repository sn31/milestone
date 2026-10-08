import { paypalMode } from "@milestone/core";
import { jsonError } from "@/lib/http";

/** The /api/dev/paypal/* routes exist only while PayPal is simulated; otherwise they answer 404. */
export function notSimulated(): Response | null {
  if (paypalMode() === "simulated") return null;
  return jsonError("not found", 404);
}

/** A dev route's body: a plain form post (the /ops buttons) or JSON from scripts; null when unreadable. */
export async function formBody(req: Request): Promise<Record<string, unknown> | null> {
  const form = /^(application\/x-www-form-urlencoded|multipart\/form-data)/i.test(req.headers.get("content-type") ?? "");
  const body = form ? await req.formData().then((f) => Object.fromEntries(f.entries())).catch(() => null) : await req.json().catch(() => null);
  return (body ?? null) as Record<string, unknown> | null;
}

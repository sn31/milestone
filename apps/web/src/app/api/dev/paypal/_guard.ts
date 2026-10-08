import { paypalMode } from "@milestone/money";

/** The /api/dev/paypal/* routes exist only while PayPal is simulated; otherwise they answer 404. */
export function notSimulated(): Response | null {
  if (paypalMode() === "simulated") return null;
  return Response.json({ error: "not found" }, { status: 404, headers: { "Cache-Control": "no-store" } });
}

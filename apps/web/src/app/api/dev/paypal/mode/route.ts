import { paypalMode } from "@milestone/money";

export const dynamic = "force-dynamic";

/** Which PayPal the server talks to ("simulated" or "sandbox"); the fund button asks when it was not told. */
export async function GET() {
  return Response.json({ mode: paypalMode() }, { headers: { "Cache-Control": "no-store" } });
}

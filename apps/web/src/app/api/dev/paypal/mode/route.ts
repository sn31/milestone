import { paypalMode } from "@milestone/core";
import { json } from "@/lib/http";

export const dynamic = "force-dynamic";

/** Which PayPal the server talks to ("simulated" or "sandbox"); the fund button asks when it was not told. */
export async function GET() {
  return json({ mode: paypalMode() });
}

import { approveSimulatedSetupToken } from "@milestone/money";
import { jsonError, noStore } from "@/lib/http";
import { notSimulated } from "../_guard";

export const dynamic = "force-dynamic";

/**
 * Simulated PayPal's approval page for saving a PayPal: the setup token's approve link points here. Marks the setup
 * token APPROVED (as the payer clicking "Agree and continue") and sends the payer to its return_url with
 * ?approval_token_id=<id>, as PayPal does. Only a return URL on this app is followed. 404 unless PayPal is simulated.
 */
export async function GET(req: Request) {
  const blocked = notSimulated();
  if (blocked) return blocked;
  const url = new URL(req.url);
  const token = url.searchParams.get("token") ?? "";
  if (!token) return jsonError("token is required", 400);
  const summary = approveSimulatedSetupToken(token);
  if (!summary) return jsonError(`simulated setup token ${token} not found`, 404);
  if (!summary.returnUrl) return jsonError("setup token has no return_url", 409);
  const allowed = new Set([url.origin, process.env.APP_URL ? new URL(process.env.APP_URL).origin : url.origin]);
  let target: URL;
  try {
    target = new URL(summary.returnUrl);
  } catch {
    return jsonError("setup token has an invalid return_url", 409);
  }
  if (!allowed.has(target.origin)) return jsonError("return_url is not on this app", 409);
  return new Response(null, { status: 303, headers: { ...noStore, Location: target.toString() } });
}

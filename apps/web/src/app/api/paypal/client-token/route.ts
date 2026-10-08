import { paypal } from "@/lib/paypal";

/** Browser token for JS SDK v6 createInstance({ clientToken }). Minted per page load; expires in minutes. */
export async function GET() {
  const token = await paypal().clientToken();
  return Response.json(token, { headers: { "Cache-Control": "no-store" } });
}

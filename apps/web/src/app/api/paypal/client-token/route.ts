import { json } from "@/lib/http";
import { paypal } from "@/lib/paypal";

/** Browser token for JS SDK v6 createInstance({ clientToken }). Minted per page load; expires in minutes. */
export async function GET() {
  return json(await paypal().clientToken());
}

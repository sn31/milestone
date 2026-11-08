// Calls a running Milestone (pnpm dev, seeded) through the APIMatic-generated SDK.
//
//   npx tsx examples/smoke.ts                       # http://localhost:3000
//   MILESTONE_URL=https://<host> npx tsx examples/smoke.ts
//
// Read-only: it asks for the PayPal mode and for an advance offer, as the freelancer and as the client. Nothing is
// funded, paid or changed.
import { MilestoneApiClient, MilestoneApiError } from "../src/index.js";

const baseUrl = process.env.MILESTONE_URL ?? "http://localhost:3000";
const milestoneId = process.env.MILESTONE_ID ?? "mst_3"; // the seeded signup-flow milestone that is funded

// The demo has no sign-in: the role cookie names who you are (roleCookie is APIMatic's cookie auth scheme).
const as = (role: "usr_client" | "usr_freelancer") => new MilestoneApiClient({ roleCookie: role, serverOptions: { baseUrl } });

const mode = await new MilestoneApiClient({ serverOptions: { baseUrl } }).dev.getPayPalMode();
console.log("PayPal mode:", mode);

const offer = await as("usr_freelancer").advances.getAdvanceOffer({ milestoneId });
console.log(`Advance offer on ${offer.milestoneId} (${(offer.amountMinor / 100).toFixed(2)} ${offer.currency} in escrow):`);
console.log("  offer:", offer.offer);
console.log("  terms:", offer.terms);
console.log("  explanation:", offer.explanation, `(${offer.explanationSource})`);

// Only the freelancer on the contract may ask; the client gets a typed error, not a crash.
try {
  await as("usr_client").advances.getAdvanceOffer({ milestoneId });
  console.log("client: unexpectedly allowed");
} catch (err) {
  if (!(err instanceof MilestoneApiError) || err.kind !== "api") throw err;
  console.log(`client: refused with ${err.status}:`, err.payload);
}

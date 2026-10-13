// The audit log's Detail column: one plain sentence per event, from its detail. The raw object stays one click away in
// the expanded row. Pure, so it is unit-testable and runs on the server with the redaction applied first.
import { formatMoney } from "@/lib/format";
import { payoutFailureLine, payoutReason } from "@/lib/payout-failure";

type Detail = Record<string, unknown>;

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const money = (d: Detail, key = "amountMinor", currency = "USD") => {
  const n = num(d[key]);
  return n === null ? null : formatMoney(n, str(d.currency) ?? currency);
};
const ACTION: Record<string, string> = { release: "Release", partial: "Partial release", hold: "Hold", ask_client: "Ask the client" };
const short = (v: string | null, n = 7) => (v ? v.slice(0, n) : null);
const sentenceCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
const DISPUTE_REASON: Record<string, string> = {
  MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED: "not as described",
  MERCHANDISE_OR_SERVICE_NOT_RECEIVED: "not received",
  UNAUTHORISED: "unauthorised payment",
};

/** One sentence for an audit row. `names` maps user ids to people. Unknown events read as their name, humanised. */
export function eventSentence(event: string, raw: unknown, names: Record<string, string> = {}, currency = "USD"): string {
  const d: Detail = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Detail) : {};
  const amt = money(d, "amountMinor", currency);
  const who = (id: unknown) => (str(id) ? (names[String(id)] ?? String(id)) : null);
  switch (event) {
    case "contract.created":
      return "Contract drafted";
    case "contract.approved":
      return "Signed by both parties; funding opens";
    case "contract.approved_by_client":
      return "Signed by the client";
    case "contract.approved_by_freelancer":
      return "Signed by the freelancer";
    case "milestone.order_created":
      return `PayPal order created${amt ? ` for ${amt}` : ""}`;
    case "milestone.funded":
      return `Funded into escrow${amt ? `: ${amt}` : ""}`;
    case "milestone.capture_pending":
      return "Capture pending at PayPal";
    case "milestone.verifying":
      return "The agent started checking the delivery";
    case "milestone.review": {
      const ends = str(d.reviewEndsAt);
      return `Review window opened${ends ? `, closes ${new Date(ends).toISOString().slice(11, 16)} UTC` : ""}`;
    }
    case "milestone.needs_client":
      return `Waiting on the client${str(d.action) ? ` (policy: ${ACTION[String(d.action)]?.toLowerCase() ?? d.action})` : ""}`;
    case "milestone.held":
      return str(d.reason) ? `Held: ${lower((payoutFailureLine(d) ?? String(d.reason)).replace(/\.$/, ""))}` : `Held by policy${Array.isArray(d.ruleIds) && d.ruleIds.length ? ` ${d.ruleIds.join(", ")}` : ""}`;
    case "milestone.released":
      return `PayPal confirmed the payout${amt ? ` of ${amt}` : ""}${d.historical === true ? " (earlier contract)" : ""}`;
    case "milestone.partial_released":
      return `Partial release confirmed${amt ? `: ${amt}` : ""}`;
    case "milestone.needs_operator":
      return `Operator needed · ${lower((payoutFailureLine(d) ?? "a payment went wrong").replace(/\.$/, ""))}`;
    case "ops.resolved":
      return `Resolved by an operator${str(d.note) ? `: ${d.note}` : ""}`;
    case "delivery.manual":
      return `Delivered ${str(d.ref) ?? "work"}${short(str(d.sha)) ? ` at ${short(str(d.sha))}` : ""}`;
    case "delivery.upload": {
      const files = Array.isArray(d.files) ? d.files.map((f) => str((f as Detail)?.name)).filter(Boolean) : [];
      return files.length ? `Delivered ${files.length} file${files.length === 1 ? "" : "s"}: ${files.join(", ")}` : "Delivered files";
    }
    case "verdict.stored": {
      const result = str(d.result) ?? "no result";
      const ignored = d.suspectedInjection === true ? "; text addressed to the reviewer was ignored" : "";
      // No model reachable: the worker records "deterministic-only". Say what that means rather than print the id.
      if (!str(d.model) || d.model === "deterministic-only") {
        const word = result === "pass" ? "every check passed" : result === "fail" ? "a required check did not pass" : result === "partial" ? "required checks passed; the rest goes to the client" : result;
        return `Verdict from the checks alone: ${word}${ignored}`;
      }
      return `Verdict: ${result} by ${d.model}${ignored}`;
    }
    case "policy.decided": {
      const a = ACTION[str(d.action) ?? ""] ?? str(d.action) ?? "Decided";
      const rules = Array.isArray(d.ruleIds) && d.ruleIds.length ? ` · ${d.ruleIds.join(", ")}` : "";
      const reason = str(d.reason);
      return `${a}${num(d.amountMinor) ? ` ${amt}` : ""}${rules}${reason ? `: ${reason.replace(/\.$/, "").replace(/^./, (c) => c.toLowerCase())}` : ""}`;
    }
    case "client.approve":
      return "Client approved the release";
    case "client.veto":
      return "Client vetoed the release";
    case "client.hold":
      return "Client held the payment";
    case "client.confirm_partial":
      return "Client confirmed the partial release";
    case "release.claimed": {
      const f = money(d, "freelancerShareMinor", currency);
      const p = num(d.partnerShareMinor) ? money(d, "partnerShareMinor", currency) : null;
      return `Release started${f ? `: ${f} to the freelancer` : ""}${p ? `, ${p} to the partner` : ""}`;
    }
    case "release.blocked_by_dispute":
      return "Release stopped: the payment is disputed";
    case "paypal.payout":
      return `Payout sent to PayPal${amt ? `: ${amt}` : ""}`;
    case "paypal.payout_failed": {
      const r = payoutReason(str(d.reason));
      return `Payout to the ${str(d.party) ?? "receiver"} failed${r ? `: ${r}` : ""}`;
    }
    case "paypal.refund":
      return `Refund sent to PayPal${amt ? `: ${amt}` : ""}`;
    case "paypal.refund_settled":
      return `PayPal confirmed the refund${amt ? ` of ${amt}` : ""}`;
    case "paypal.receipt":
      return "Paid receipt issued";
    case "advance.accepted":
      return `Advance accepted: ${money(d, "principalMinor", currency) ?? "principal"} now, ${money(d, "repaymentMinor", currency) ?? "repayment"} back at release`;
    case "advance.funded":
      return `Partner paid the advance${money(d, "principalMinor", currency) ? ` of ${money(d, "principalMinor", currency)}` : ""}`;
    case "advance.repaid":
      return `Advance repaid${money(d, "paidMinor", currency) ? `: ${money(d, "paidMinor", currency)}` : ""} to ${who(d.partnerId) ?? "the partner"}`;
    case "advance.shortfall":
      return "Advance not fully repaid";
    case "dispute.opened":
      return `Buyer opened a PayPal dispute${str(d.reason) ? `: ${DISPUTE_REASON[String(d.reason)] ?? String(d.reason).toLowerCase().replace(/_/g, " ")}` : ""}${amt ? `, ${amt}` : ""}`;
    case "dispute.drafted":
      return d.redacted === true ? "Evidence pack compiled; the draft is private to the freelancer" : "Evidence pack compiled and a response drafted";
    case "dispute.evidence_submitted":
      return "Evidence sent to PayPal";
    case "dispute.claim_accepted":
      return "Freelancer accepted the claim";
    case "dispute.updated":
      return `PayPal updated the dispute${str(d.status) ? `: ${String(d.status).toLowerCase().replace(/_/g, " ")}` : ""}`;
    case "dispute.resolved":
      return `Dispute resolved${str(d.outcome) ? `: ${String(d.outcome).toLowerCase().replace(/_/g, " ")}` : ""}`;
    default: {
      const reason = str(d.reason) ?? str(d.error) ?? str(d.note);
      const name = sentenceCase(event.replace(/^[a-z]+\./, "").replace(/_/g, " "));
      return reason ? `${name}: ${reason}` : name;
    }
  }
}

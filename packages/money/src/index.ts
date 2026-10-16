// PayPal (read side and non-money calls). The money-moving calls stay in ./paypal/money.ts and are
// reachable only through ./policy/execute.ts — scripts/check-boundaries.mjs enforces it.
export { PayPalClient, PayPalError, isMoneyPath, multipartBody } from "./paypal/client.ts";
export type { PayPalConfig, RequestOptions, MultipartPart } from "./paypal/client.ts";
export { createOrder, getOrder, approveLink } from "./paypal/orders.ts";
export type { CreateOrderInput, Order } from "./paypal/orders.ts";
export { issuePaidReceipt } from "./paypal/invoices.ts";
export type { ReceiptInput } from "./paypal/invoices.ts";
export { verifyWebhookSignature, parsePayoutItemEvent, parseRefundEvent, parsePayoutBatchEvent } from "./paypal/webhooks.ts";
export type { WebhookEvent, PayoutItemEvent, RefundEvent, PayoutBatchEvent } from "./paypal/webhooks.ts";
// Simulated PayPal (PAYPAL_MODE=simulated): local loop and demo-day backup. createPayPalClient picks the client.
export { createPayPalClient, createSimulatedPayPalClient, simulatedFetch, configureSimulator, resetSimulator, isSimulatedWebhook, simulatedWebhookSecret, SIMULATED_WEBHOOK_HEADER, approveSimulatedOrder, simulatedOrder, failNextSimulatedPayout, armedSimulatedFailures } from "./paypal/simulated.ts";
export type { SimulatorOptions, SimulatedOrderSummary } from "./paypal/simulated.ts";
// PayPal mode and payout receiver live in @milestone/core (env.ts); re-exported for existing importers.
export { paypalMode, payoutReceiver } from "@milestone/core";
export type { PayPalMode } from "@milestone/core";
export { openSimulatedDispute } from "./paypal/simulated.ts";
export type { SimulatedDispute } from "./paypal/simulated.ts";
// Disputes (week 3): read by REST, respond with evidence (multipart) or accept the claim.
// accept-claim moves money: its REST call is in ./paypal/money.ts and it is reached only through acceptDisputeClaim below.
export { getDispute, provideEvidence, parseDispute, recordDisputeEvent, findOpenedDispute, openDisputesFor, evidenceOpKey, submitDisputeEvidence, disputeAcceptPlan, ACCEPT_CLAIM_STATUSES, EVIDENCE_NOTES_MAX, EVIDENCE_FILE_MAX_BYTES, EVIDENCE_TOTAL_MAX_BYTES, EVIDENCE_FILE_TYPES, SERVICE_EVIDENCE_TYPE } from "./paypal/disputes.ts";
export type { Dispute, DisputeAmount, Evidence, EvidenceFile, DisputeEventInfo, DisputeEventOutcome, DisputeActionResult, AcceptClaimPlan } from "./paypal/disputes.ts";
// Policy
export { decide, applyReviewWindow } from "./policy/decide.ts";
export type { DecideInput, ReviewWindowState } from "./policy/decide.ts";
export { priceAdvance, DEFAULT_PRICING } from "./policy/pricing.ts";
export type { PricingParams, FreelancerRecord, ClientRecord, MilestoneForPricing, AdvanceOffer } from "./policy/pricing.ts";
export { underwrite, loadRecords, loadUnderwriting, daysUntil, criteriaCounts, describeOffer, DEFAULT_LIMITS, DEFAULT_HORIZON_DAYS, ADVANCE_MILESTONE_STATUSES, advanceRefs, isAdvanceRef, advanceBalances, remainingOwed, loadAdvanceBalances, advanceRepayment, DAY_MS } from "./policy/advance.ts";
export type { AdvanceTerms, UnderwriteInput, Underwriting, Records, UnderwritingContext, AdvanceKey, AdvanceLedgerRow, AdvanceBalance, AdvanceForRepayment } from "./policy/advance.ts";
export { captureFunding, executeRelease, executePayout, executeRefund, moneyContextFor, fundAdvance, acceptDisputeClaim, disputeLedgerRef } from "./policy/execute.ts";
export type { MoneyContext, ReleasePlan, ReleaseResult, PayoutRequest, RefundRequest, PayoutBatch } from "./policy/execute.ts";
// PayPal's MCP server, read-only (reconciliation, dispute reads). An allowlist refuses every money-moving tool.
export { openPayPalMcp, callPayPalTool, isAllowedPayPalTool, readToolResult, parseTransactions, simulatedTransactions, PayPalMcpRefused, PayPalMcpError, PAYPAL_MCP_ALLOWED_TOOLS, PAYPAL_MCP_DENIED_MONEY_TOOLS, PAYPAL_MCP_TOOL_GROUPS, SIM_EVENT_CODES } from "./paypal/mcp-client.ts";
export type { PayPalMcpTool, PayPalToolResult, PayPalMcpSession, OpenPayPalMcpOptions, PayPalTransaction } from "./paypal/mcp-client.ts";

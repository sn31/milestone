// PayPal (read side and non-money calls). The money-moving calls stay in ./paypal/money.ts and are
// reachable only through ./policy/execute.ts — scripts/check-boundaries.mjs enforces it.
export { PayPalClient, PayPalError, isMoneyPath } from "./paypal/client.ts";
export type { PayPalConfig, RequestOptions } from "./paypal/client.ts";
export { createOrder, getOrder, approveLink } from "./paypal/orders.ts";
export type { CreateOrderInput, Order } from "./paypal/orders.ts";
export { issuePaidReceipt } from "./paypal/invoices.ts";
export type { ReceiptInput } from "./paypal/invoices.ts";
export { verifyWebhookSignature } from "./paypal/webhooks.ts";
export type { WebhookEvent } from "./paypal/webhooks.ts";
// Policy
export { decide, applyReviewWindow } from "./policy/decide.ts";
export type { DecideInput, ReviewWindowState } from "./policy/decide.ts";
export { priceAdvance, DEFAULT_PRICING } from "./policy/pricing.ts";
export type { PricingParams, FreelancerRecord, ClientRecord, MilestoneForPricing, AdvanceOffer } from "./policy/pricing.ts";
export { captureFunding, executeRelease, fundAdvance } from "./policy/execute.ts";
export type { MoneyContext, ReleasePlan } from "./policy/execute.ts";

// PayPal (read side and non-money calls). The money-moving calls stay in ./paypal/money.ts and are
// reachable only through ./policy/execute.ts — scripts/check-boundaries.mjs enforces it.
export { PayPalClient, PayPalError, isMoneyPath } from "./paypal/client.js";
export type { PayPalConfig, RequestOptions } from "./paypal/client.js";
export { createOrder, getOrder, approveLink } from "./paypal/orders.js";
export type { CreateOrderInput, Order } from "./paypal/orders.js";
export { issuePaidReceipt } from "./paypal/invoices.js";
export type { ReceiptInput } from "./paypal/invoices.js";
export { verifyWebhookSignature } from "./paypal/webhooks.js";
export type { WebhookEvent } from "./paypal/webhooks.js";
// Policy
export { decide, applyReviewWindow } from "./policy/decide.js";
export type { DecideInput, ReviewWindowState } from "./policy/decide.js";
export { priceAdvance, DEFAULT_PRICING } from "./policy/pricing.js";
export type { PricingParams, FreelancerRecord, ClientRecord, MilestoneForPricing, AdvanceOffer } from "./policy/pricing.js";
export { captureFunding, executeRelease, fundAdvance } from "./policy/execute.js";
export type { MoneyContext, ReleasePlan } from "./policy/execute.js";

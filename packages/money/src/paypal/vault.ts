/**
 * Save the client's PayPal once (PayPal Payment Method Tokens v3). None of these calls move money:
 *   POST /v3/vault/setup-tokens   -> PAYER_ACTION_REQUIRED + an approve link the payer opens
 *   (payer approves)              -> the setup token reads APPROVED
 *   POST /v3/vault/payment-tokens -> the payment token (vault_id) + PayPal customer id
 *   DELETE /v3/vault/payment-tokens/{id} when the user removes it.
 * Charging a saved PayPal is a money call: chargeVault in ./money.ts, reachable only through policy/execute.ts.
 * Every POST carries a PayPal-Request-Id from a paypal_ops row (VAULT_OP_KINDS).
 */
import {
  AUDIT_EVENTS,
  VAULT_OP_KINDS,
  audit,
  findPaymentMethod,
  findVaultSetup,
  markPaymentMethodRemoved,
  newVaultSetupId,
  recordOpResult,
  recordVaultSetup,
  requestIdFor,
  savePaymentMethod,
  setVaultSetupStatus,
  type Executor,
  type PaymentMethod,
} from "@milestone/core";
import { PayPalError, type PayPalClient } from "./client.ts";

/** How the saved PayPal will be used (PayPal's usage_pattern). Agent funding is merchant-initiated and unscheduled. */
export type VaultUsagePattern = "IMMEDIATE" | "DEFERRED" | "UNSCHEDULED_PREPAID" | "UNSCHEDULED_POSTPAID";

export interface SetupTokenInput {
  requestId: string;
  returnUrl: string;
  cancelUrl: string;
  description: string;
  /** Default UNSCHEDULED_POSTPAID: the agent charges it later, when a milestone is due, without the payer present. */
  usagePattern?: VaultUsagePattern;
  /** An existing PayPal customer id to attach the token to. */
  customerId?: string;
}

interface Link { href: string; rel: string; method?: string }

export interface SetupTokenResponse {
  id: string;
  status: string;
  customer?: { id?: string };
  links?: Link[];
}

export interface PaymentTokenResponse {
  id: string;
  customer?: { id?: string };
  payment_source?: { paypal?: { email_address?: string; payer_id?: string } };
  links?: Link[];
}

function requireId(requestId: string, what: string): void {
  if (!requestId) throw new Error(`PayPal-Request-Id is required for ${what}`);
}

/** POST /v3/vault/setup-tokens for a PayPal wallet; the payer approves at `approveUrl`. */
export async function createSetupToken(client: PayPalClient, input: SetupTokenInput): Promise<{ setupTokenId: string; approveUrl: string; customerId: string | null; status: string }> {
  requireId(input.requestId, "/v3/vault/setup-tokens");
  const body = {
    ...(input.customerId ? { customer: { id: input.customerId } } : {}),
    payment_source: {
      paypal: {
        description: input.description,
        usage_type: "MERCHANT",
        customer_type: "CONSUMER",
        usage_pattern: input.usagePattern ?? "UNSCHEDULED_POSTPAID",
        permit_multiple_payment_tokens: false,
        experience_context: {
          return_url: input.returnUrl,
          cancel_url: input.cancelUrl,
          brand_name: "Milestone",
          shipping_preference: "NO_SHIPPING",
          vault_instruction: "ON_PAYER_APPROVAL",
        },
      },
    },
  };
  const res = await client.request<SetupTokenResponse>("POST", "/v3/vault/setup-tokens", body, { requestId: input.requestId });
  const approveUrl = res.links?.find((l) => l.rel === "approve" || l.rel === "payer-action")?.href;
  if (!res.id || !approveUrl) throw new Error("PayPal returned a setup token without an approve link");
  return { setupTokenId: res.id, approveUrl, customerId: res.customer?.id ?? null, status: res.status };
}

export function getSetupToken(client: PayPalClient, setupTokenId: string): Promise<SetupTokenResponse> {
  return client.request<SetupTokenResponse>("GET", `/v3/vault/setup-tokens/${encodeURIComponent(setupTokenId)}`);
}

/** POST /v3/vault/payment-tokens from an approved setup token. */
export async function createPaymentToken(client: PayPalClient, input: { requestId: string; setupTokenId: string }): Promise<{ paymentTokenId: string; customerId: string | null; payerEmail: string | null }> {
  requireId(input.requestId, "/v3/vault/payment-tokens");
  const res = await client.request<PaymentTokenResponse>(
    "POST",
    "/v3/vault/payment-tokens",
    { payment_source: { token: { id: input.setupTokenId, type: "SETUP_TOKEN" } } },
    { requestId: input.requestId },
  );
  if (!res.id) throw new Error("PayPal returned a payment token without an id");
  return { paymentTokenId: res.id, customerId: res.customer?.id ?? null, payerEmail: res.payment_source?.paypal?.email_address ?? null };
}

export function getPaymentToken(client: PayPalClient, paymentTokenId: string): Promise<PaymentTokenResponse> {
  return client.request<PaymentTokenResponse>("GET", `/v3/vault/payment-tokens/${encodeURIComponent(paymentTokenId)}`);
}

/** DELETE /v3/vault/payment-tokens/{id}. A token PayPal no longer knows (404) counts as deleted. */
export async function deletePaymentToken(client: PayPalClient, paymentTokenId: string, opts: { requestId?: string } = {}): Promise<void> {
  try {
    await client.request<null>("DELETE", `/v3/vault/payment-tokens/${encodeURIComponent(paymentTokenId)}`, undefined, opts.requestId ? { requestId: opts.requestId } : {});
  } catch (e) {
    if (e instanceof PayPalError && e.status === 404) return;
    throw e;
  }
}

// ---------- The save-your-PayPal flow over the database (used by the web routes) ----------

/**
 * Starts saving the user's PayPal: a vault_setups row bound to the user, the setup-token op and the PayPal call.
 * Returns the approve link to send the user to. The return URL gets ?approval_token_id=<setupTokenId> from PayPal.
 */
export async function startVaultSetup(
  db: Executor,
  client: PayPalClient,
  input: { userId: string; returnUrl: string; cancelUrl: string; description?: string; usagePattern?: VaultUsagePattern },
): Promise<{ setupId: string; setupTokenId: string; approveUrl: string; customerId: string | null }> {
  const setupId = newVaultSetupId();
  const requestId = await requestIdFor(db, VAULT_OP_KINDS.setupToken, setupId);
  let res: Awaited<ReturnType<typeof createSetupToken>>;
  try {
    res = await createSetupToken(client, {
      requestId,
      returnUrl: input.returnUrl,
      cancelUrl: input.cancelUrl,
      description: input.description ?? "Milestone funds your approved milestones from this PayPal account, within the limits you set for your agent.",
      ...(input.usagePattern ? { usagePattern: input.usagePattern } : {}),
    });
  } catch (e) {
    await recordOpResult(db, requestId, { status: "failed", response: { error: e instanceof Error ? e.message : String(e) } });
    throw e;
  }
  await recordOpResult(db, requestId, { status: "succeeded", paypalId: res.setupTokenId, response: res });
  await recordVaultSetup(db, { id: setupId, userId: input.userId, setupTokenId: res.setupTokenId });
  await audit(db, { actor: input.userId, event: AUDIT_EVENTS.vaultSetupStarted, detail: { setupId, setupTokenId: res.setupTokenId } });
  return { setupId, setupTokenId: res.setupTokenId, approveUrl: res.approveUrl, customerId: res.customerId };
}

export type CompleteVaultSetupResult =
  | { ok: true; paymentMethod: PaymentMethod }
  /** unknown_setup: no setup with this token for this user (never another user's approval). */
  | { ok: false; reason: "unknown_setup" | "paypal_error"; error: string };

/**
 * Finishes saving: the payer approved the setup token, so exchange it for a payment token and store it as the user's
 * payment method. Idempotent: a repeat (or a reload of the return URL) replays the same PayPal-Request-Id and returns
 * the same row.
 */
export async function completeVaultSetup(db: Executor, client: PayPalClient, input: { userId: string; setupTokenId: string }): Promise<CompleteVaultSetupResult> {
  const setup = await findVaultSetup(db, input.setupTokenId, input.userId);
  if (!setup) return { ok: false, reason: "unknown_setup", error: "no setup with this token for this user" };
  const requestId = await requestIdFor(db, VAULT_OP_KINDS.paymentToken, setup.setupTokenId);
  let res: Awaited<ReturnType<typeof createPaymentToken>>;
  try {
    res = await createPaymentToken(client, { requestId, setupTokenId: setup.setupTokenId });
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await recordOpResult(db, requestId, { status: "failed", response: { error } });
    return { ok: false, reason: "paypal_error", error };
  }
  await recordOpResult(db, requestId, { status: "succeeded", paypalId: res.paymentTokenId, response: res });
  const paymentMethod = await savePaymentMethod(db, { userId: input.userId, paymentTokenId: res.paymentTokenId, customerId: res.customerId, payerEmail: res.payerEmail });
  if (setup.status !== "vaulted") {
    await setVaultSetupStatus(db, setup.setupTokenId, "vaulted");
    await audit(db, { actor: input.userId, event: AUDIT_EVENTS.paymentMethodSaved, detail: { paymentMethodId: paymentMethod.id, setupTokenId: setup.setupTokenId, payerEmail: paymentMethod.payerEmail } });
  }
  return { ok: true, paymentMethod };
}

/**
 * Removes the user's saved PayPal: marked removed first (so no charge can start from it), then deleted at PayPal.
 * Null when it is not the user's. A PayPal failure leaves it removed here and is rethrown.
 */
export async function removeVaultPaymentMethod(db: Executor, client: PayPalClient, input: { userId: string; paymentMethodId: string }): Promise<PaymentMethod | null> {
  const before = await findPaymentMethod(db, input.paymentMethodId, input.userId);
  if (!before) return null;
  const removed = await markPaymentMethodRemoved(db, before.id, input.userId);
  if (!before.removedAt) await audit(db, { actor: input.userId, event: AUDIT_EVENTS.paymentMethodRemoved, detail: { paymentMethodId: before.id } });
  const requestId = await requestIdFor(db, VAULT_OP_KINDS.deleteToken, before.paypalPaymentTokenId);
  await deletePaymentToken(client, before.paypalPaymentTokenId, { requestId });
  await recordOpResult(db, requestId, { status: "succeeded", paypalId: before.paypalPaymentTokenId });
  return removed;
}

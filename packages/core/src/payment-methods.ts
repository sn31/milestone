/**
 * Saved PayPal (PayPal Payment Method Tokens v3): the rows behind "save your PayPal once". The PayPal calls live in
 * @milestone/money (paypal/vault.ts); this module only reads and writes payment_methods and vault_setups.
 * A payment method belongs to one user; only that user's mandates may charge it (fundingAllows), and a removed one is
 * never charged again.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { Executor } from "./db.ts";
import { paymentMethods, vaultSetups } from "./schema.ts";

import { VAULT_CHARGE_OP_KIND, type PaymentMethod } from "./mandates.ts";

export type VaultSetup = typeof vaultSetups.$inferSelect;

/** paypal_ops.kind values of the vault calls. The strings are stored; never change one. */
export const VAULT_OP_KINDS = {
  /** POST /v3/vault/setup-tokens; key: the vault_setups id. */
  setupToken: "vault_setup_token",
  /** POST /v3/vault/payment-tokens; key: the setup token id. */
  paymentToken: "vault_payment_token",
  /** DELETE /v3/vault/payment-tokens/{id}; key: the payment token id. */
  deleteToken: "vault_delete_token",
  /** POST /v2/checkout/orders with payment_source.paypal.vault_id; key: the milestone id. */
  charge: VAULT_CHARGE_OP_KIND,
} as const;

/** vault_setups.status values. */
export const VAULT_SETUP_STATUSES = ["created", "approved", "vaulted", "cancelled", "failed"] as const;
export type VaultSetupStatus = (typeof VAULT_SETUP_STATUSES)[number];

/** A new setup attempt for `userId`, before PayPal is called (its id keys the setup-token op). */
export function newVaultSetupId(): string {
  return `vst_${randomUUID()}`;
}

/** Records the setup token PayPal returned, bound to the user who started it. Idempotent on the setup token id. */
export async function recordVaultSetup(q: Executor, input: { id: string; userId: string; setupTokenId: string; now?: Date }): Promise<VaultSetup> {
  await q
    .insert(vaultSetups)
    .values({ id: input.id, userId: input.userId, setupTokenId: input.setupTokenId, status: "created", createdAt: input.now ?? new Date() })
    .onConflictDoNothing();
  const [row] = await q.select().from(vaultSetups).where(eq(vaultSetups.setupTokenId, input.setupTokenId));
  if (!row) throw new Error(`could not record vault setup ${input.setupTokenId}`);
  return row;
}

/** The setup for a setup token, only when it belongs to `userId` (a user can never vault another user's approval). */
export async function findVaultSetup(q: Executor, setupTokenId: string, userId: string): Promise<VaultSetup | null> {
  const [row] = await q.select().from(vaultSetups).where(and(eq(vaultSetups.setupTokenId, setupTokenId), eq(vaultSetups.userId, userId)));
  return row ?? null;
}

export async function setVaultSetupStatus(q: Executor, setupTokenId: string, status: VaultSetupStatus): Promise<void> {
  await q.update(vaultSetups).set({ status }).where(eq(vaultSetups.setupTokenId, setupTokenId));
}

/**
 * Saves a payment token for `userId`. Idempotent on the token id: a repeat returns the existing row. Throws when the
 * token is already saved for a different user.
 */
export async function savePaymentMethod(
  q: Executor,
  input: { userId: string; paymentTokenId: string; customerId?: string | null; payerEmail?: string | null; id?: string; now?: Date },
): Promise<PaymentMethod> {
  await q
    .insert(paymentMethods)
    .values({
      id: input.id ?? `pm_${randomUUID()}`,
      userId: input.userId,
      provider: "paypal",
      paypalPaymentTokenId: input.paymentTokenId,
      paypalCustomerId: input.customerId ?? null,
      payerEmail: input.payerEmail ?? null,
      createdAt: input.now ?? new Date(),
    })
    .onConflictDoNothing();
  const [row] = await q.select().from(paymentMethods).where(eq(paymentMethods.paypalPaymentTokenId, input.paymentTokenId));
  if (!row) throw new Error(`could not save payment token ${input.paymentTokenId}`);
  if (row.userId !== input.userId) throw new Error("payment token belongs to another user");
  return row;
}

/** The user's current saved PayPal: the newest one not removed; null when there is none. */
export async function activePaymentMethod(q: Executor, userId: string): Promise<PaymentMethod | null> {
  const [row] = await q
    .select()
    .from(paymentMethods)
    .where(and(eq(paymentMethods.userId, userId), isNull(paymentMethods.removedAt)))
    .orderBy(desc(paymentMethods.createdAt))
    .limit(1);
  return row ?? null;
}

/** Every saved PayPal of the user, newest first, removed ones included. */
export function listPaymentMethods(q: Executor, userId: string): Promise<PaymentMethod[]> {
  return q.select().from(paymentMethods).where(eq(paymentMethods.userId, userId)).orderBy(desc(paymentMethods.createdAt));
}

/** One payment method, only when it belongs to `userId`. */
export async function findPaymentMethod(q: Executor, id: string, userId: string): Promise<PaymentMethod | null> {
  const [row] = await q.select().from(paymentMethods).where(and(eq(paymentMethods.id, id), eq(paymentMethods.userId, userId)));
  return row ?? null;
}

/** Marks a payment method removed (idempotent: the first removed_at stays). Null when it is not the user's. */
export async function markPaymentMethodRemoved(q: Executor, id: string, userId: string, now: Date = new Date()): Promise<PaymentMethod | null> {
  const [row] = await q
    .update(paymentMethods)
    .set({ removedAt: now })
    .where(and(eq(paymentMethods.id, id), eq(paymentMethods.userId, userId), isNull(paymentMethods.removedAt)))
    .returning();
  return row ?? (await findPaymentMethod(q, id, userId));
}

/** The unique (ref, account, direction) index is the backstop against a retried job double-booking a transaction. Opt in: MILESTONE_E2E=1. */
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb } from "../src/db.ts";
import { postTransaction } from "../src/ledger.ts";
import { ledgerEntries } from "../src/schema.ts";

if (!process.env.DATABASE_URL) {
  try { process.loadEnvFile(resolve(__dirname, "../../../.env")); } catch { /* opt-in test */ }
}

describe.skipIf(process.env.MILESTONE_E2E !== "1")("ledger unique index", () => {
  const db = createDb();
  const ref = `test:${randomUUID()}`;
  const entries = (acct: string) => [
    { account: `held:${acct}`, amountMinor: 500, direction: "debit" as const },
    { account: `freelancer:${acct}`, amountMinor: 500, direction: "credit" as const },
  ];
  afterAll(async () => { await db.delete(ledgerEntries).where(eq(ledgerEntries.ref, ref)); });

  it("posting the same transaction twice under one ref is rejected, and the first stays intact", async () => {
    await postTransaction(db, { ref, currency: "USD", entries: entries("t1") });
    await expect(postTransaction(db, { ref, currency: "USD", entries: entries("t1") })).rejects.toThrow();
    expect(await db.select().from(ledgerEntries).where(eq(ledgerEntries.ref, ref))).toHaveLength(2);
  });
  it("the same accounts under a different ref are fine", async () => {
    await postTransaction(db, { ref, currency: "USD", entries: entries("t2") });
    expect(await db.select().from(ledgerEntries).where(eq(ledgerEntries.ref, ref))).toHaveLength(4);
  });
});

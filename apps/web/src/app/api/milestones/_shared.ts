import { NextResponse } from "next/server";
import { PayPalError, type MoneyContext } from "@milestone/money";
import { requestIdFor, type Db } from "@milestone/core";
import { paypal } from "@/lib/paypal";
import type { Actor } from "@/lib/session";

type FindFirstConfig = NonNullable<Parameters<Db["query"]["milestones"]["findFirst"]>[0]>;
type WhereCallback = Extract<NonNullable<FindFirstConfig["where"]>, (...args: never[]) => unknown>;
/** Drizzle's query operators (eq, sql, ...). drizzle-orm is not a dependency of apps/web, so we take them from a relational query callback. */
export type Ops = Parameters<WhereCallback>[1];

/** Loads a milestone with its contract, plus the drizzle operators for follow-up writes. */
export async function loadMilestone(db: Db, id: string) {
  let ops: Ops | undefined;
  const milestone = await db.query.milestones.findFirst({
    where: (t, o) => {
      ops = o;
      return o.eq(t.id, id);
    },
  });
  if (!milestone || !ops) return null;
  const contract = await db.query.contracts.findFirst({ where: (t, { eq }) => eq(t.id, milestone.contractId) });
  if (!contract) return null;
  return { milestone, contract, ops };
}

/** Only the contract's own client funds a milestone. */
export function isContractClient(actor: Actor, contract: { clientId: string }): boolean {
  return actor.role === "client" && actor.userId === contract.clientId;
}

export function moneyContext(db: Db): MoneyContext {
  return { client: paypal(), requestIdFor: (kind, key) => requestIdFor(db, kind, key) };
}

export function jsonError(error: string, status: number, extra?: Record<string, unknown>) {
  return NextResponse.json({ error, ...extra }, { status, headers: { "Cache-Control": "no-store" } });
}

export function paypalErrorResponse(e: unknown) {
  if (e instanceof PayPalError) return jsonError(e.message, 502, { debugId: e.debugId ?? null });
  return jsonError(e instanceof Error ? e.message : "PayPal call failed", 502);
}

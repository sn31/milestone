/**
 * Reconciliation via PayPal's MCP server, no database: the client's allowlist (money tools refused before anything is
 * sent, a server exposing one refused outright), tool errors surfaced with PayPal's body, the matcher on rows shaped
 * like the real sandbox's Transaction Search answer, the simulator's offline list_transactions, and the dispute
 * copilot's MCP read with its REST fallback. The PayPal MCP server is a fake on an in-memory MCP transport.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  PAYPAL_MCP_ALLOWED_TOOLS,
  PAYPAL_MCP_DENIED_MONEY_TOOLS,
  PAYPAL_MCP_TOOL_GROUPS,
  PayPalMcpError,
  PayPalMcpRefused,
  approveSimulatedOrder,
  callPayPalTool,
  captureFunding,
  configureSimulator,
  createOrder,
  createSimulatedPayPalClient,
  openPayPalMcp,
  openSimulatedDispute,
  parseTransactions,
  resetSimulator,
  type OpenPayPalMcpOptions,
} from "@milestone/money";
import { expectedFromOps, isBalanceHold, matchTransactions, reconcileSummary, reconcileWindow, type LedgerLike, type OpLike } from "../src/jobs/reconcile.ts";
import { readDispute } from "../src/jobs/dispute.ts";

type Handler = (args: Record<string, unknown>) => unknown;

/** A fake PayPal MCP server: `tools` are listed; each call is logged and answered as PayPal's toolkit would (JSON text). */
async function fakePayPal(tools: Record<string, Handler>): Promise<{ opts: OpenPayPalMcpOptions; calls: Array<{ name: string; args: Record<string, unknown> }> }> {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const server = new Server({ name: "fake-paypal", version: "0.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: Object.keys(tools).map((name) => ({ name, inputSchema: { type: "object" as const } })) }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    calls.push({ name: req.params.name, args });
    const h = tools[req.params.name];
    if (!h) return { content: [{ type: "text" as const, text: JSON.stringify({ error: { message: "no such tool", type: "paypal_error" } }) }] };
    return { content: [{ type: "text" as const, text: JSON.stringify(h(args)) }] };
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  return { opts: { transport: clientSide, Client: Client as never, timeoutMs: 5_000 }, calls };
}

const readTools = { list_transactions: () => ({ transaction_details: [], total_pages: 1 }), list_disputes: () => ({ items: [] }), get_dispute: () => ({}) };

describe("PayPal MCP client allowlist", () => {
  it("allows only the four read tools and requests only the read groups", () => {
    expect([...PAYPAL_MCP_ALLOWED_TOOLS].sort()).toEqual(["get_dispute", "get_merchant_insights", "list_disputes", "list_transactions"]);
    expect([...PAYPAL_MCP_TOOL_GROUPS]).toEqual(["transactions.list", "disputes.list", "disputes.get"]);
    // orders.capture (pay_order), payments.createRefund (create_refund) and disputes.create (accept_dispute_claim) are never requested.
    for (const g of ["orders.capture", "payments.createRefund", "disputes.create", "all"]) expect(PAYPAL_MCP_TOOL_GROUPS as readonly string[]).not.toContain(g);
  });

  it("refuses every money-moving tool before anything is sent", async () => {
    expect([...PAYPAL_MCP_DENIED_MONEY_TOOLS]).toEqual(expect.arrayContaining(["pay_order", "create_refund", "accept_dispute_claim"]));
    const fake = await fakePayPal({ ...readTools });
    const session = await openPayPalMcp(fake.opts);
    for (const tool of [...PAYPAL_MCP_DENIED_MONEY_TOOLS, "create_order", "create_invoice", "anything_else"]) {
      await expect(session.callPayPalTool(tool, { capture_id: "X" })).rejects.toBeInstanceOf(PayPalMcpRefused);
      // The one-shot form refuses before it opens a session.
      await expect(callPayPalTool(tool, {}, { transport: {} })).rejects.toBeInstanceOf(PayPalMcpRefused);
    }
    expect(fake.calls).toEqual([]);
    await session.close();
  });

  it("refuses a session whose server exposes a money tool", async () => {
    const fake = await fakePayPal({ ...readTools, pay_order: () => ({ status: "COMPLETED" }) });
    await expect(openPayPalMcp(fake.opts)).rejects.toThrow(/outside the allowlist \(pay_order\)/);
    expect(fake.calls).toEqual([]);
  });

  it("surfaces PayPal's error body from a failed tool call", async () => {
    const body = { ok: false, status: 403, code: "PAYPAL_API_HTTP_ERROR", message: "Authorization failed due to insufficient permissions" };
    const fake = await fakePayPal({ ...readTools, list_transactions: () => body });
    const session = await openPayPalMcp(fake.opts);
    const err = await session.callPayPalTool("list_transactions", { start_date: "2026-10-08T00:00:00Z" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PayPalMcpError);
    expect((err as PayPalMcpError).body).toEqual(body);
    expect((err as PayPalMcpError).status).toBe(403);
    expect((err as Error).message).toContain("insufficient permissions");
    await session.close();
  });

  it("passes arguments through and returns parsed JSON", async () => {
    const fake = await fakePayPal({ ...readTools, list_transactions: (a) => ({ echo: a, transaction_details: [], total_pages: 1 }) });
    const res = await callPayPalTool<{ echo: unknown }>("list_transactions", { start_date: "a", end_date: "b" }, fake.opts);
    expect(res).toMatchObject({ tool: "list_transactions", simulated: false, via: "paypal_mcp", data: { echo: { start_date: "a", end_date: "b" } } });
    expect(fake.calls.map((c) => c.name)).toEqual(["list_transactions"]);
  });
});

// Rows shaped like the real sandbox's answer for Oct 8 2026 (ids shortened): a capture, its partial refund (referencing
// the capture), the payout's balance hold, the payout (referencing the hold) and the hold's reversal.
const row = (id: string, code: string, value: string, ref: string | null, at: string) => ({
  transaction_info: { transaction_id: id, paypal_reference_id: ref ?? undefined, transaction_event_code: code, transaction_initiation_date: at, transaction_amount: { currency_code: "USD", value }, transaction_status: "S" },
});
const SANDBOX = {
  transaction_details: [
    row("CAP47U499206E7334", "T0006", "40.00", "ORD7A996721HP711", "2026-10-08T15:08:09Z"),
    row("REF15X70391DL3320", "T1107", "-10.00", "CAP47U499206E7334", "2026-10-08T15:08:11Z"),
    row("HLD1BN68146MY3047", "T1503", "-30.25", null, "2026-10-08T15:08:16Z"),
    row("TXN4K1744390D1704", "T0001", "-30.00", "HLD1BN68146MY3047", "2026-10-08T15:08:24Z"),
    row("REV8SX47884KA9047", "T1105", "30.25", "HLD1BN68146MY3047", "2026-10-08T15:08:24Z"),
    row("CAPSTRANGER000001", "T0006", "12.00", "ORDSTRANGER00001", "2026-10-08T16:00:00Z"),
  ],
  total_pages: 1,
};
const at = new Date("2026-10-08T15:08:30Z");
const op = (o: Partial<OpLike> & Pick<OpLike, "kind" | "key">): OpLike => ({ paypalId: null, status: "succeeded", response: null, createdAt: at, updatedAt: at, ...o });
const OPS: OpLike[] = [
  op({ kind: "capture", key: "mst_a", paypalId: "CAP47U499206E7334" }),
  op({ kind: "refund", key: "mst_a", paypalId: "REF15X70391DL3320" }),
  op({ kind: "payout", key: "mst_a", paypalId: "BATCH5UXD2E8A", response: { items: { freelancer: { status: "succeeded", amountMinor: 3000, eventId: "WH-1", payoutItemId: "ITEM8AAAA" } } } }),
  // Captured in the window but PayPal does not list it.
  op({ kind: "capture", key: "mst_b", paypalId: "CAPMISSING0000001" }),
];
const LEDGER: LedgerLike[] = [
  { ref: "CAP47U499206E7334", account: "client:u1", direction: "debit", amountMinor: 4000, currency: "USD" },
  { ref: "CAP47U499206E7334", account: "held:mst_a", direction: "credit", amountMinor: 4000, currency: "USD" },
  { ref: "refund:mst_a", account: "held:mst_a", direction: "debit", amountMinor: 1000, currency: "USD" },
  { ref: "refund:mst_a", account: "client:u1", direction: "credit", amountMinor: 1000, currency: "USD" },
  // The ledger booked 2900 for the freelancer where PayPal paid 3000: an amount mismatch.
  { ref: "release:mst_a", account: "held:mst_a", direction: "debit", amountMinor: 2900, currency: "USD" },
  { ref: "release:mst_a", account: "freelancer:u2", direction: "credit", amountMinor: 2900, currency: "USD" },
  { ref: "CAPMISSING0000001", account: "client:u1", direction: "debit", amountMinor: 5000, currency: "USD" },
  { ref: "CAPMISSING0000001", account: "held:mst_b", direction: "credit", amountMinor: 5000, currency: "USD" },
];

describe("reconciliation matcher", () => {
  const window = { start: "2026-10-08T00:00:00Z", end: "2026-10-15T23:59:59Z", lagHours: 0 };
  const txns = parseTransactions(SANDBOX);
  // The payout item's webhook named its transaction id.
  const report = matchTransactions(window, txns, expectedFromOps(OPS, LEDGER, new Map([["ITEM8AAAA", ["TXN4K1744390D1704"]]])));

  it("reads Transaction Search rows with signed minor amounts", () => {
    expect(txns.map((t) => [t.id.slice(0, 3), t.amountMinor])).toEqual([["CAP", 4000], ["REF", -1000], ["HLD", -3025], ["TXN", -3000], ["REV", 3025], ["CAP", 1200]]);
  });

  it("matches captures, refunds and payout items; sets balance holds aside", () => {
    expect(report).toMatchObject({ paypalCount: 6, matched: 3, ignored: 2, counts: { missingInLedger: 1, missingInPayPal: 1, amountMismatches: 1 } });
    expect(report.missingInLedger).toEqual([expect.objectContaining({ id: "CAPSTRANGER000001", amountMinor: 1200, eventCode: "T0006" })]);
    expect(report.missingInPayPal).toEqual([expect.objectContaining({ kind: "capture", opKey: "mst_b", ids: ["CAPMISSING0000001"], amountMinor: 5000 })]);
    expect(report.amountMismatches).toEqual([expect.objectContaining({ id: "TXN4K1744390D1704", kind: "payout", party: "freelancer", paypalMinor: 3000, ledgerMinor: 2900 })]);
    expect(isBalanceHold("T1503")).toBe(true);
    expect(isBalanceHold("T1107")).toBe(false);
  });

  it("never matches a refund to the capture it references", () => {
    const onlyCapture = expectedFromOps([OPS[0]!], LEDGER);
    const r = matchTransactions(window, parseTransactions({ transaction_details: [SANDBOX.transaction_details[1]] }), onlyCapture);
    expect(r.matched).toBe(0);
    expect(r.counts.missingInLedger).toBe(1);
  });

  it("is deterministic: same rows in any order give the same report and summary", () => {
    const again = matchTransactions(window, [...txns].reverse(), expectedFromOps([...OPS].reverse(), [...LEDGER].reverse(), new Map([["ITEM8AAAA", ["TXN4K1744390D1704"]]])));
    expect(again).toEqual(report);
    expect(reconcileSummary(again, false)).toBe(reconcileSummary(report, false));
    expect(reconcileSummary(report, false)).toMatch(/^PayPal listed 6 transactions .* 3 matched .*\(2 balance holds set aside\)\. An operator should check 1 on PayPal with no Milestone record, 1 recorded by Milestone but not on PayPal, 1 with an amount that differs from the ledger\.$/);
  });

  it("ends the window RECONCILE_LAG_HOURS ago (3 by default against PayPal, 0 simulated)", () => {
    const now = new Date("2026-10-16T12:00:00.000Z");
    expect(reconcileWindow(now, { PAYPAL_MODE: "sandbox" })).toEqual({ start: "2026-10-15T09:00:00Z", end: "2026-10-16T09:00:00Z", lagHours: 3 });
    expect(reconcileWindow(now, { PAYPAL_MODE: "sandbox", RECONCILE_LAG_HOURS: "6", RECONCILE_WINDOW_HOURS: "2" })).toEqual({ start: "2026-10-16T04:00:00Z", end: "2026-10-16T06:00:00Z", lagHours: 6 });
    expect(reconcileWindow(now, { PAYPAL_MODE: "simulated" }).end).toBe("2026-10-16T12:00:00Z");
    expect(reconcileWindow(now, {}, { start: "2026-10-08T00:00:00Z", end: "2026-10-15T23:59:59Z" })).toEqual({ start: "2026-10-08T00:00:00Z", end: "2026-10-15T23:59:59Z", lagHours: 0 });
  });
});

describe("simulated PayPal through the same client", () => {
  const env = { PAYPAL_MODE: "simulated" } as NodeJS.ProcessEnv;
  beforeAll(() => {
    configureSimulator({ stateFile: null, webhookDelayMs: 10, deliver: () => undefined });
    resetSimulator();
  });
  afterAll(() => resetSimulator());

  it("answers list_transactions from the simulator's captures, labelled simulated", async () => {
    const client = createSimulatedPayPalClient();
    const order = await createOrder(client, { referenceId: "mst_sim_rec", amountMinor: 2500, currency: "USD", description: "x", returnUrl: "http://localhost/r", cancelUrl: "http://localhost/c" });
    approveSimulatedOrder(order.id);
    const { capture } = await captureFunding({ client, requestIdFor: async () => randomUUID() }, "mst_sim_rec", order.id);
    const session = await openPayPalMcp({ env });
    expect(session.simulated).toBe(true);
    await expect(session.callPayPalTool("create_refund", {})).rejects.toBeInstanceOf(PayPalMcpRefused);
    const res = await session.callPayPalTool("list_transactions", { start_date: new Date(Date.now() - 3_600_000).toISOString(), end_date: new Date(Date.now() + 60_000).toISOString() });
    expect(res).toMatchObject({ simulated: true, via: "simulated" });
    const rows = parseTransactions(res.data);
    expect(rows).toEqual([expect.objectContaining({ id: capture.id, eventCode: "T0006", amountMinor: 2500, currency: "USD" })]);
    // Deterministic: the same state gives the same answer.
    const again = await session.callPayPalTool("list_transactions", { start_date: new Date(Date.now() - 3_600_000).toISOString(), end_date: new Date(Date.now() + 60_000).toISOString() });
    expect(parseTransactions(again.data)).toEqual(rows);
  });

  it("reads a dispute through MCP, and falls back to REST when the MCP call fails", async () => {
    const prev = process.env.PAYPAL_MODE;
    process.env.PAYPAL_MODE = "simulated";
    try {
      const d = openSimulatedDispute({ captureId: "SIM-CAP-RECONCILE01", amountMinor: 1500, currency: "USD", reason: "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED" });
      const webhookCopy = { id: d.disputeId, reason: null, amountMinor: null, currency: null };

      const viaSim = await readDispute(d.disputeId, webhookCopy, { env });
      expect(viaSim).toMatchObject({ readVia: "simulated_mcp", reason: "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED", amountMinor: 1500, currency: "USD" });

      const ok = await fakePayPal({ ...readTools, get_dispute: (a) => ({ dispute_id: a.dispute_id, reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED", dispute_amount: { currency_code: "USD", value: "15.00" } }) });
      expect(await readDispute(d.disputeId, webhookCopy, ok.opts)).toMatchObject({ readVia: "paypal_mcp", reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED", amountMinor: 1500 });
      expect(ok.calls).toEqual([{ name: "get_dispute", args: { dispute_id: d.disputeId } }]);

      const failing = await fakePayPal({ ...readTools, get_dispute: () => ({ ok: false, status: 401, code: "PAYPAL_API_HTTP_ERROR", message: "Authentication failed" }) });
      const viaRest = await readDispute(d.disputeId, webhookCopy, failing.opts);
      expect(viaRest).toMatchObject({ readVia: "rest", reason: "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED", amountMinor: 1500 });
      expect(viaRest.readFallback).toContain("Authentication failed");
    } finally {
      process.env.PAYPAL_MODE = prev;
    }
  });
});

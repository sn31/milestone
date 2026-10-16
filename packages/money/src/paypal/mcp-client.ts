/**
 * PayPal's own MCP server (@paypal/mcp), used read-only: reconciliation (list_transactions) and the dispute copilot
 * (get_dispute). The server runs as a child process over stdio, started with a server access token minted by our
 * PayPalClient and PAYPAL_ENVIRONMENT=SANDBOX, and only the reporting and disputes read groups are requested
 * (--tools=transactions.list,disputes.list,disputes.get).
 *
 * callPayPalTool(name, args) REFUSES any tool outside PAYPAL_MCP_ALLOWED_TOOLS before anything is sent. PayPal's
 * money-moving tools are never requested, never called and never handed to a model:
 *   pay_order             (orders.capture: captures an order)
 *   create_refund         (payments.createRefund: refunds a capture)
 *   accept_dispute_claim  (disputes.create: makes PayPal refund the buyer)
 *   any capture or payout tool PayPal adds later (they are outside the allowlist, so refused by default)
 * Money moves only through ./money.ts, reached only from ../policy/execute.ts. Nothing here builds a prompt or passes a
 * tool list to a model: callers get JSON back and decide deterministically.
 *
 * In simulated mode (PAYPAL_MODE=simulated) there is no PayPal to talk to: the same allowlisted tools answer from the
 * local simulator's state (captures, refunds, settled payout items, disputes), deterministically, and every result is
 * labelled `simulated: true` so no screen passes it off as PayPal's.
 *
 * The MCP SDK and @paypal/mcp are dependencies of apps/worker, not of this package: they are resolved at run time from
 * apps/worker's node_modules (bundlers never see the specifiers). Tests pass their own transport.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { asRecord, asString, fromPayPalValue, paypalMode } from "@milestone/core";
import type { PayPalClient } from "./client.ts";
import { createPayPalClient } from "./mode.ts";
import { read, records, get } from "./sim/store.ts";
import { disputeView } from "./sim/views.ts";

// ---------- The allowlist ----------

/** The only PayPal MCP tools Milestone ever calls. All read-only. */
export const PAYPAL_MCP_ALLOWED_TOOLS = ["list_transactions", "get_merchant_insights", "list_disputes", "get_dispute"] as const;
export type PayPalMcpTool = (typeof PAYPAL_MCP_ALLOWED_TOOLS)[number];

/**
 * PayPal MCP tools that move money. Listed so tests can assert each one is refused and never exposed; any tool not in
 * the allowlist is refused whether or not it is named here.
 */
export const PAYPAL_MCP_DENIED_MONEY_TOOLS = ["pay_order", "create_refund", "accept_dispute_claim", "capture_order", "create_payout", "create_batch_payout"] as const;

/**
 * The --tools groups requested from @paypal/mcp: transaction search and the two dispute reads. get_merchant_insights
 * has no group the bin accepts (and PayPal refuses it in sandbox), so it is allowed but not served here.
 */
export const PAYPAL_MCP_TOOL_GROUPS = ["transactions.list", "disputes.list", "disputes.get"] as const;

export function isAllowedPayPalTool(name: string): name is PayPalMcpTool {
  return (PAYPAL_MCP_ALLOWED_TOOLS as readonly string[]).includes(name);
}

/** A call to a tool outside the allowlist. Thrown before anything is sent. */
export class PayPalMcpRefused extends Error {
  constructor(readonly tool: string) {
    super(`PayPal MCP tool "${tool}" is not allowed: Milestone calls only ${PAYPAL_MCP_ALLOWED_TOOLS.join(", ")}`);
    this.name = "PayPalMcpRefused";
  }
}

/** PayPal (through the MCP server) answered with an error, or the server could not be reached. `body` is what it said. */
export class PayPalMcpError extends Error {
  constructor(message: string, readonly tool: string, readonly body: unknown = null, readonly code: string | null = null, readonly status: number | null = null) {
    super(message);
    this.name = "PayPalMcpError";
  }
}

export interface PayPalToolResult<T = unknown> {
  tool: PayPalMcpTool;
  data: T;
  /** True when the answer came from the local simulator, not PayPal. */
  simulated: boolean;
  via: "paypal_mcp" | "simulated";
}

// ---------- Transport plumbing (structural, so this package needs no SDK types) ----------

/** The subset of the MCP SDK's Client this module uses. */
interface McpClientLike {
  connect(transport: unknown, options?: { timeout?: number }): Promise<void>;
  listTools(params?: unknown, options?: { timeout?: number }): Promise<{ tools: Array<{ name: string }> }>;
  callTool(params: { name: string; arguments?: Record<string, unknown> }, resultSchema?: unknown, options?: { timeout?: number }): Promise<unknown>;
  close(): Promise<void>;
}
type ClientCtor = new (info: { name: string; version: string }, options?: unknown) => McpClientLike;

export interface OpenPayPalMcpOptions {
  env?: NodeJS.ProcessEnv;
  /** The PayPal client whose server token the MCP server uses. Default: createPayPalClient(env). */
  client?: PayPalClient;
  /**
   * A ready MCP transport (tests: an InMemoryTransport linked to a fake server). When given, no process is spawned and
   * no token is minted; the allowlist and the exposed-tools check still apply.
   */
  transport?: unknown;
  /** The SDK's Client class, when the caller already imported it (tests). Default: resolved from apps/worker. */
  Client?: ClientCtor;
  /** Per-request timeout. Default 30 s. */
  timeoutMs?: number;
  /** Directory whose node_modules hold @paypal/mcp and the MCP SDK. Default: apps/worker, found from the cwd. */
  resolveFrom?: string;
}

export interface PayPalMcpSession {
  readonly simulated: boolean;
  /** The tools the server exposes (simulated: the allowlist minus get_merchant_insights). */
  readonly tools: readonly string[];
  callPayPalTool<T = unknown>(name: string, args?: Record<string, unknown>): Promise<PayPalToolResult<T>>;
  close(): Promise<void>;
  /** The server's stderr tail, for error reports (empty for injected transports and the simulator). */
  stderr(): string;
}

/** apps/worker's directory: PAYPAL_MCP_RESOLVE_FROM, else found by walking up from the cwd. */
function workerDir(env: NodeJS.ProcessEnv, explicit?: string): string {
  if (explicit) return explicit;
  if (env.PAYPAL_MCP_RESOLVE_FROM) return env.PAYPAL_MCP_RESOLVE_FROM;
  let dir = process.cwd();
  for (;;) {
    for (const candidate of [dir, join(dir, "apps", "worker")]) {
      const pkg = join(candidate, "package.json");
      if (existsSync(pkg)) {
        try {
          if ((JSON.parse(readFileSync(pkg, "utf8")) as { name?: string }).name === "@milestone/worker") return candidate;
        } catch {
          // not a package we can read; keep walking
        }
      }
    }
    const up = dirname(dir);
    if (up === dir) throw new Error("PayPal MCP: cannot find apps/worker (set PAYPAL_MCP_RESOLVE_FROM)");
    dir = up;
  }
}

/** The installed package directory of `name` under `from`/node_modules (pnpm symlinks resolve through realpath). */
function packageDir(from: string, name: string): string {
  const dir = join(from, "node_modules", ...name.split("/"));
  if (!existsSync(join(dir, "package.json"))) throw new Error(`PayPal MCP: ${name} is not installed in ${from}`);
  return dir;
}

/** Imports an ES module by absolute path, out of sight of bundlers. */
const importPath = (path: string): Promise<Record<string, unknown>> => import(/* webpackIgnore: true */ /* turbopackIgnore: true */ pathToFileURL(path).href) as Promise<Record<string, unknown>>;

const SDK = "@modelcontextprotocol/sdk";
const PAYPAL_MCP = "@paypal/mcp";

/** Spawns @paypal/mcp over stdio with the server token and the read-only tool groups. */
async function spawnTransport(env: NodeJS.ProcessEnv, from: string, client: PayPalClient): Promise<{ transport: unknown; Client: ClientCtor; stderr: () => string }> {
  const sdkDir = packageDir(from, SDK);
  const binDir = packageDir(from, PAYPAL_MCP);
  const binRel = (JSON.parse(readFileSync(join(binDir, "package.json"), "utf8")) as { bin?: string | Record<string, string> }).bin;
  const bin = resolve(binDir, typeof binRel === "string" ? binRel : (Object.values(binRel ?? {})[0] ?? "dist/index.js"));
  const [{ Client }, { StdioClientTransport }] = (await Promise.all([importPath(join(sdkDir, "dist/esm/client/index.js")), importPath(join(sdkDir, "dist/esm/client/stdio.js"))])) as [
    { Client: ClientCtor },
    { StdioClientTransport: new (p: { command: string; args: string[]; env: Record<string, string>; stderr: "pipe"; cwd?: string }) => { stderr: NodeJS.ReadableStream | null } },
  ];
  const token = await client.accessToken();
  // A minimal environment: the token and the mode only, never our client secret, database URL or model keys. The
  // token goes in the environment, not argv, so it does not show in a process listing.
  const childEnv: Record<string, string> = {
    PAYPAL_ACCESS_TOKEN: token,
    PAYPAL_ENVIRONMENT: client.baseUrl.includes("sandbox") ? "SANDBOX" : "PRODUCTION",
    PATH: env.PATH ?? process.env.PATH ?? "",
    ...(env.HOME ? { HOME: env.HOME } : {}),
  };
  const transport = new StdioClientTransport({ command: process.execPath, args: [bin, `--tools=${PAYPAL_MCP_TOOL_GROUPS.join(",")}`], env: childEnv, stderr: "pipe", cwd: binDir });
  let tail = "";
  transport.stderr?.on("data", (chunk: unknown) => {
    tail = (tail + String(chunk)).slice(-4000);
  });
  return { transport, Client, stderr: () => tail };
}

/** Reads a tools/call result: the JSON text PayPal's server returns, or a PayPalMcpError for an error result. */
export function readToolResult(tool: string, result: unknown): unknown {
  const r = asRecord(result);
  const content = Array.isArray(r.content) ? r.content : [];
  const text = content
    .map((c) => asRecord(c))
    .filter((c) => c.type === "text")
    .map((c) => asString(c.text) ?? "")
    .join("");
  let body: unknown = r.structuredContent ?? null;
  if (body === null && text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  const b = asRecord(body);
  // The toolkit reports a failed call as text: an LlmError ({ ok: false, code, status, message }) or { error: {...} }.
  const err = r.isError === true ? (typeof body === "string" ? { message: body } : b) : b.ok === false && (b.code || b.message) ? b : b.error && typeof b.error === "object" ? asRecord(b.error) : null;
  if (err) {
    const message = asString(err.message) ?? (typeof body === "string" ? body : JSON.stringify(body));
    const status = typeof err.status === "number" ? err.status : null;
    throw new PayPalMcpError(`PayPal MCP ${tool} failed${status ? ` (HTTP ${status})` : ""}: ${message}`, tool, body, asString(err.code) ?? asString(err.type), status);
  }
  return body;
}

/**
 * Opens a session with PayPal's MCP server (or the simulator). Refuses to proceed if the server exposes any tool that
 * moves money: the session must only ever see read tools. Close it when done; the child process ends with it.
 */
export async function openPayPalMcp(opts: OpenPayPalMcpOptions = {}): Promise<PayPalMcpSession> {
  const env = opts.env ?? process.env;
  const timeout = opts.timeoutMs ?? 30_000;
  if (!opts.transport && paypalMode(env) === "simulated") return simulatedSession();

  let transport = opts.transport;
  let Client = opts.Client;
  let stderr = () => "";
  if (!transport) {
    const spawned = await spawnTransport(env, workerDir(env, opts.resolveFrom), opts.client ?? createPayPalClient(env));
    transport = spawned.transport;
    Client ??= spawned.Client;
    stderr = spawned.stderr;
  }
  if (!Client) {
    const sdkDir = packageDir(workerDir(env, opts.resolveFrom), SDK);
    Client = ((await importPath(join(sdkDir, "dist/esm/client/index.js"))) as { Client: ClientCtor }).Client;
  }
  const mcp = new Client({ name: "milestone-reconcile", version: "1.0.0" });
  try {
    await mcp.connect(transport, { timeout });
  } catch (e) {
    throw new PayPalMcpError(`PayPal MCP server did not start: ${e instanceof Error ? e.message : String(e)}${stderr() ? ` | ${stderr().trim().slice(-500)}` : ""}`, "connect");
  }
  let tools: string[];
  try {
    tools = (await mcp.listTools(undefined, { timeout })).tools.map((t) => t.name);
  } catch (e) {
    await mcp.close().catch(() => undefined);
    throw new PayPalMcpError(`PayPal MCP tools/list failed: ${e instanceof Error ? e.message : String(e)}`, "list_tools");
  }
  const exposed = tools.filter((t) => !isAllowedPayPalTool(t));
  if (exposed.length) {
    await mcp.close().catch(() => undefined);
    throw new PayPalMcpError(`PayPal MCP server exposes tools outside the allowlist (${exposed.join(", ")}); refusing the session`, "list_tools");
  }
  return {
    simulated: false,
    tools,
    stderr,
    async callPayPalTool<T>(name: string, args: Record<string, unknown> = {}): Promise<PayPalToolResult<T>> {
      if (!isAllowedPayPalTool(name)) throw new PayPalMcpRefused(name);
      if (!tools.includes(name)) throw new PayPalMcpError(`PayPal MCP tool ${name} is not served by this session`, name);
      let raw: unknown;
      try {
        raw = await mcp.callTool({ name, arguments: args }, undefined, { timeout });
      } catch (e) {
        throw new PayPalMcpError(`PayPal MCP ${name} call failed: ${e instanceof Error ? e.message : String(e)}`, name);
      }
      return { tool: name, data: readToolResult(name, raw) as T, simulated: false, via: "paypal_mcp" };
    },
    async close() {
      await mcp.close().catch(() => undefined);
    },
  };
}

/**
 * One call in its own session: opens, calls, closes. Refuses a tool outside the allowlist before starting anything.
 */
export async function callPayPalTool<T = unknown>(name: string, args: Record<string, unknown> = {}, opts: OpenPayPalMcpOptions = {}): Promise<PayPalToolResult<T>> {
  if (!isAllowedPayPalTool(name)) throw new PayPalMcpRefused(name);
  const session = await openPayPalMcp(opts);
  try {
    return await session.callPayPalTool<T>(name, args);
  } finally {
    await session.close();
  }
}

// ---------- Simulated PayPal ----------

/** Transaction Search event codes the simulator labels its rows with. */
export const SIM_EVENT_CODES = { capture: "T0006", refund: "T1107", payout: "T0000" } as const;

interface SimTxn {
  transaction_info: {
    transaction_id: string;
    paypal_reference_id?: string;
    paypal_reference_id_type?: string;
    transaction_event_code: string;
    transaction_initiation_date: string;
    transaction_updated_date: string;
    transaction_amount: { currency_code: string; value: string };
    transaction_status: "S";
    custom_field?: string;
  };
}

const neg = (a: { currency_code: string; value: string }) => ({ currency_code: a.currency_code, value: a.value.startsWith("-") ? a.value : `-${a.value}` });

/**
 * list_transactions from the simulator's records, Transaction Search shaped: captures (+), refunds (-, referencing the
 * capture) and successful payout items once settled (-, referencing the payout item id). Sorted by time then id, so the
 * same state and window always give the same answer.
 */
export function simulatedTransactions(args: Record<string, unknown>, now = Date.now()): Record<string, unknown> {
  const start = Date.parse(asString(args.start_date) ?? "") || now - 31 * 86_400_000;
  const end = Date.parse(asString(args.end_date) ?? "") || now;
  const inWindow = (iso: string) => {
    const t = Date.parse(iso);
    return t >= start && t <= end;
  };
  const rows = read(() => {
    const out: SimTxn[] = [];
    for (const c of records("capture")) {
      out.push({ transaction_info: { transaction_id: c.id, paypal_reference_id: c.orderId, paypal_reference_id_type: "ODR", transaction_event_code: SIM_EVENT_CODES.capture, transaction_initiation_date: c.createTime, transaction_updated_date: c.updateTime, transaction_amount: c.amount, transaction_status: "S" } });
    }
    for (const r of records("refund")) {
      out.push({ transaction_info: { transaction_id: r.id, paypal_reference_id: r.captureId, paypal_reference_id_type: "TXN", transaction_event_code: SIM_EVENT_CODES.refund, transaction_initiation_date: r.createTime, transaction_updated_date: r.createTime, transaction_amount: neg(r.amount), transaction_status: "S" } });
    }
    for (const b of records("batch")) {
      if (now < b.settleAt) continue;
      const at = new Date(b.settleAt).toISOString();
      for (const it of b.items) {
        if (it.outcome !== "SUCCESS") continue;
        const amt = { currency_code: it.payout_item.amount.currency, value: it.payout_item.amount.value };
        out.push({ transaction_info: { transaction_id: it.transaction_id, paypal_reference_id: it.payout_item_id, paypal_reference_id_type: "PAP", transaction_event_code: SIM_EVENT_CODES.payout, transaction_initiation_date: b.createTime, transaction_updated_date: at, transaction_amount: neg(amt), transaction_status: "S", custom_field: it.payout_item.sender_item_id } });
      }
    }
    return out;
  });
  const listed = rows
    .filter((r) => inWindow(r.transaction_info.transaction_initiation_date))
    .sort((a, b) => a.transaction_info.transaction_initiation_date.localeCompare(b.transaction_info.transaction_initiation_date) || a.transaction_info.transaction_id.localeCompare(b.transaction_info.transaction_id));
  return { transaction_details: listed, account_number: "SIMMERCHANT01", start_date: new Date(start).toISOString(), end_date: new Date(end).toISOString(), page: 1, total_items: listed.length, total_pages: 1, simulated: true };
}

function simulatedCall(name: PayPalMcpTool, args: Record<string, unknown>): unknown {
  const now = Date.now();
  switch (name) {
    case "list_transactions":
      return simulatedTransactions(args, now);
    case "get_dispute": {
      const id = asString(args.dispute_id) ?? "";
      const d = read(() => get("dispute", id));
      if (!d) throw new PayPalMcpError(`PayPal MCP get_dispute failed (HTTP 404): The specified resource ${id} does not exist.`, name, { ok: false, status: 404, code: "PAYPAL_API_HTTP_ERROR", message: `The specified resource ${id} does not exist.` }, "PAYPAL_API_HTTP_ERROR", 404);
      return disputeView(d, now);
    }
    case "list_disputes": {
      const items = read(() => [...records("dispute")])
        .map((d) => disputeView(d, now))
        .sort((a, b) => String(a.dispute_id).localeCompare(String(b.dispute_id)));
      return { items, simulated: true };
    }
    case "get_merchant_insights":
      throw new PayPalMcpError("PayPal MCP get_merchant_insights is not available in the simulator", name);
  }
}

function simulatedSession(): PayPalMcpSession {
  const tools = PAYPAL_MCP_ALLOWED_TOOLS.filter((t) => t !== "get_merchant_insights");
  return {
    simulated: true,
    tools,
    stderr: () => "",
    async callPayPalTool<T>(name: string, args: Record<string, unknown> = {}): Promise<PayPalToolResult<T>> {
      if (!isAllowedPayPalTool(name)) throw new PayPalMcpRefused(name);
      return { tool: name, data: simulatedCall(name, args) as T, simulated: true, via: "simulated" };
    },
    async close() {},
  };
}

// ---------- Transaction Search rows ----------

/** One Transaction Search row, as reconciliation reads it. amountMinor is signed (money out is negative). */
export interface PayPalTransaction {
  id: string;
  referenceId: string | null;
  eventCode: string | null;
  at: string | null;
  amountMinor: number | null;
  currency: string | null;
  status: string | null;
}

/** Reads list_transactions' transaction_details. Rows without a transaction id are skipped. */
export function parseTransactions(data: unknown): PayPalTransaction[] {
  const details = asRecord(data).transaction_details;
  const out: PayPalTransaction[] = [];
  for (const row of Array.isArray(details) ? details : []) {
    const info = asRecord(asRecord(row).transaction_info);
    const id = asString(info.transaction_id);
    if (!id) continue;
    const amt = asRecord(info.transaction_amount);
    const currency = asString(amt.currency_code);
    const value = asString(amt.value);
    let amountMinor: number | null = null;
    if (currency && value) {
      try {
        const negative = value.trim().startsWith("-");
        const minor = fromPayPalValue(value.trim().replace(/^[-+]/, ""), currency);
        amountMinor = Number.isFinite(minor) ? (negative ? -minor : minor) : null;
      } catch {
        amountMinor = null;
      }
    }
    out.push({ id, referenceId: asString(info.paypal_reference_id), eventCode: asString(info.transaction_event_code), at: asString(info.transaction_initiation_date), amountMinor, currency, status: asString(info.transaction_status) });
  }
  return out;
}

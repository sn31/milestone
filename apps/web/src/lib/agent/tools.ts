// Pure helpers for the console's tool surface: which tools a model may see, and how a tool result is shown.
// No server imports, so they are unit-tested directly (tools.test.ts).
import type { ApprovalLink } from "./protocol";

/** At most this many tools reach the model (both servers together). */
export const MAX_TOOLS = 8;

/**
 * Tool names that move money, on any server. They are never offered to a model, whatever a server lists: money moves
 * only through Milestone's own routes and policy (the same ones a human uses), never through a model's tool call.
 */
export const MONEY_TOOL = /(^|_)(pay|payout|payouts|capture|refund|accept_dispute|accept_claim|transfer|send_money|disburse)(_|$)|pay_order|create_refund|accept_dispute_claim/i;

/** PayPal MCP: the console gets this read-only tool and nothing else. */
export const PAYPAL_CONSOLE_TOOLS = ["list_transactions"] as const;

/** Milestone MCP tools in the order the console prefers them when a server lists more than fit. */
export const MILESTONE_PREFERRED = ["list_contracts", "get_milestone", "respond_to_review", "fund_milestone", "get_ledger", "draft_contract", "deliver_milestone"] as const;

/** The mandate actions each Milestone MCP tool needs (any one of them); a tool the mandate cannot use is not offered. */
export const TOOL_NEEDS: Record<string, readonly string[]> = {
  list_contracts: ["read"],
  get_milestone: ["read"],
  get_ledger: ["read"],
  draft_contract: ["draft_contract"],
  fund_milestone: ["fund"],
  deliver_milestone: ["deliver"],
  respond_to_review: ["approve", "hold"],
};

export interface ListedTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/**
 * The Milestone MCP tools offered to the model: money-moving names dropped, tools the mandate's actions cannot use
 * dropped (when `actions` is given), preferred ones first, at most `max`.
 */
export function selectMilestoneTools<T extends ListedTool>(listed: readonly T[], max: number, actions?: readonly string[]): T[] {
  const usable = (n: string) => !actions || !TOOL_NEEDS[n] || TOOL_NEEDS[n]!.some((a) => actions.includes(a));
  const safe = listed.filter((t) => !MONEY_TOOL.test(t.name) && usable(t.name));
  const rank = (n: string) => {
    const i = (MILESTONE_PREFERRED as readonly string[]).indexOf(n);
    return i === -1 ? MILESTONE_PREFERRED.length : i;
  };
  return [...safe].sort((a, b) => rank(a.name) - rank(b.name)).slice(0, Math.max(0, max));
}

/** Whether a PayPal MCP tool may be exposed to the console's model. */
export function paypalToolAllowed(name: string): boolean {
  return (PAYPAL_CONSOLE_TOOLS as readonly string[]).includes(name) && !MONEY_TOOL.test(name);
}

/** Tool output text as JSON when it is JSON, else null. */
export function parseJson(text: string): unknown {
  const s = text.trim();
  if (!s.startsWith("{") && !s.startsWith("[")) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function oneLine(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** A milestone status named by a result ({ status } or { milestone: { status } }), for the chip's state pill. */
export function statusOf(value: unknown): string | null {
  if (!isRecord(value)) return null;
  if (typeof value.status === "string") return value.status;
  if (isRecord(value.milestone) && typeof value.milestone.status === "string") return value.milestone.status;
  return null;
}

/**
 * One line for a tool chip: the refusal reason, a queued/held outcome, a status, a count, or the start of the text.
 * Display only; the model sees the full (wrapped, untrusted) result.
 */
export function summarizeResult(text: string, isError: boolean, max = 120): string {
  const v = parseJson(text);
  if (isRecord(v)) {
    const reason = typeof v.reason === "string" ? v.reason : null;
    const error = typeof v.error === "string" ? v.error : null;
    if (isError || reason || (error && v.ok !== true)) return oneLine(`refused${reason ? ` · ${reason}` : ""}${error ? `: ${error}` : ""}`, max);
    if (v.ok === true && typeof v.queued === "string") return oneLine(`accepted · ${v.queued} queued (not paid until PayPal confirms)`, max);
    if (v.ok === true && v.status === "held") return oneLine(`accepted · milestone held${v.changed === false ? " (already held)" : ""}`, max);
    // PayPal MCP results come back as { via, simulated, data }: summarise the data, and say when it is simulated.
    if ("via" in v && v.data !== undefined) {
      const inner = summarizeResult(JSON.stringify(v.data), false, max);
      return oneLine(`${v.simulated === true ? "simulated · " : ""}${inner}`, max);
    }
    if (v.ok === true && v.funded === true && v.already === true) return oneLine(`already funded earlier from your saved PayPal · nothing charged now${typeof v.status === "string" ? ` · ${v.status}` : ""}`, max);
    if (v.ok === true && v.funded === true) {
      const amt = isRecord(v.amount) && typeof v.amount.value === "string" ? ` ${v.amount.value} ${String(v.amount.currency ?? "")}`.trimEnd() : "";
      const left = isRecord(v.remainingTotalCap) && typeof v.remainingTotalCap.value === "string" ? ` · ${v.remainingTotalCap.value} fund cap left` : "";
      return oneLine(`funded${amt} from your saved PayPal into escrow${left}`, max);
    }
    if (v.ok === true && v.pending === true) return oneLine("charged · PayPal holds the payment as pending; funded when PayPal confirms", max);
    if (typeof v.approvalUrl === "string") return oneLine("order created · waiting for you to approve in PayPal (no money moved)", max);
    const status = statusOf(v);
    if (status) {
      const title = typeof v.title === "string" ? v.title : isRecord(v.milestone) && typeof v.milestone.title === "string" ? v.milestone.title : null;
      const gate = isRecord(v.agentApproval) ? v.agentApproval : null;
      const blocked = gate && Array.isArray(gate.blockedBy) ? gate.blockedBy.filter(isRecord).map((b) => String(b.reason ?? "")).filter(Boolean) : [];
      const approve = gate ? (gate.allowedNow === true ? " · agent approve allowed" : blocked.length ? ` · approve blocked: ${blocked.join(", ")}` : "") : "";
      return oneLine(`${title ? `${title} · ` : ""}${status.replace(/_/g, " ")}${approve}`, max);
    }
    for (const [k, val] of Object.entries(v)) {
      if (Array.isArray(val)) return oneLine(`${val.length} ${k === "transaction_details" ? "transactions" : k.replace(/_/g, " ")}`, max);
    }
  }
  if (Array.isArray(v)) return `${v.length} item${v.length === 1 ? "" : "s"}`;
  return oneLine(isError ? `error: ${text}` : text || "(empty result)", max);
}

const LINK_KEY = /approv|payer.?action|checkout/i;

/** Whether a link may be shown to the human as a button: PayPal's own https pages, or a path on this app. */
export function safeApprovalUrl(url: string, origin: string): string | null {
  try {
    if (url.startsWith("/") && !url.startsWith("//")) return new URL(url, origin).toString();
    const u = new URL(url);
    if (u.origin === new URL(origin).origin) return u.toString();
    if (u.protocol === "https:" && (u.hostname === "paypal.com" || u.hostname.endsWith(".paypal.com"))) return u.toString();
  } catch {
    // not a URL
  }
  return null;
}

/**
 * PayPal approval links in a tool result (keys like approveUrl / approvalUrl / payerActionUrl, or HATEOAS links with
 * rel "approve" / "payer-action"), for the human to open. The agent never follows them.
 */
export function approvalLinks(value: unknown, origin: string): ApprovalLink[] {
  const out = new Map<string, ApprovalLink>();
  const visit = (v: unknown, key: string, depth: number) => {
    if (depth > 6) return;
    if (typeof v === "string") {
      if (LINK_KEY.test(key)) {
        const url = safeApprovalUrl(v, origin);
        if (url) out.set(url, { url, label: "Approve in PayPal" });
      }
      return;
    }
    if (Array.isArray(v)) return v.forEach((x) => visit(x, key, depth + 1));
    if (!isRecord(v)) return;
    if (typeof v.href === "string" && typeof v.rel === "string" && /^(approve|payer-action)$/i.test(v.rel)) {
      const url = safeApprovalUrl(v.href, origin);
      if (url) out.set(url, { url, label: "Approve in PayPal" });
    }
    for (const [k, x] of Object.entries(v)) visit(x, k, depth + 1);
  };
  visit(value, "", 0);
  return [...out.values()];
}

/** Arguments as a short mono string for a chip. */
export function formatArgs(args: unknown, max = 90): string {
  if (args === undefined || args === null) return "";
  if (isRecord(args) && Object.keys(args).length === 0) return "";
  let s: string;
  try {
    s = JSON.stringify(args);
  } catch {
    s = String(args);
  }
  return oneLine(s, max);
}

/** What a reply may claim, and the tool call (with its action) that must have succeeded in the same turn. */
const CLAIMS: Array<{ word: RegExp; tool: string; action?: string; says: string; funded?: true }> = [
  { word: /\b(i|we)('ve| have)? (just )?approved\b|\bapproval (was )?(accepted|submitted)\b|\bhas been approved\b/i, tool: "respond_to_review", action: "approve", says: "approve" },
  { word: /\b(i|we)('ve| have)? (just )?(held|vetoed|put .* on hold)\b|\bhas been (held|vetoed)\b/i, tool: "respond_to_review", action: "hold", says: "hold" },
  // "funded" needs a fund_milestone that actually funded (a status past draft); an approval link only "started funding".
  { word: /\b(i|we)('ve| have)? (just )?funded\b/i, tool: "fund_milestone", says: "fund", funded: true },
  { word: /\b(i|we)('ve| have)? (just )?started funding\b/i, tool: "fund_milestone", says: "fund" },
  { word: /\b(i|we)('ve| have)? (just )?drafted\b/i, tool: "draft_contract", says: "draft" },
];
/** A sentence clause that denies money moved ("No money has moved yet", "it has not been released") is not a claim. */
const NEGATED = /\b(no|not|never|nothing|hasn't|has not|isn't|wasn't)\b[^.!?;]*?\b(moved|released|paid( out)?|sent|completed)\b/gi;
const withoutNegations = (reply: string) => reply.replace(NEGATED, " ");
const MONEY_CLAIM = /\b(has been|was|is now|been) (released|paid( out)?)\b|\bpayment (has been )?(sent|completed)\b|\bmoney (has )?moved\b/i;
/** Claims a successful saved-PayPal funding backs (money moved into escrow), but never a release or payout. */
const ESCROW_CLAIM = /\bpayment (has been )?completed\b|\bmoney (has )?moved\b/i;
const RELEASE_CLAIM = /\b(has been|was|is now|been) (released|paid( out)?)\b|\bpayment (has been )?sent\b/i;

export interface CallRecord {
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
  status: string | null;
}

/**
 * Checks a reply against the turn's tool calls. A model can say "I approved it" without having called anything, or
 * call a release paid while it is only queued; the console then shows a notice under the reply. Returns null when the
 * reply is backed by the calls.
 */
export function claimCheck(reply: string, calls: readonly CallRecord[]): string | null {
  for (const c of CLAIMS) {
    if (!c.word.test(reply)) continue;
    const backed = calls.some((k) => k.ok && k.tool === c.tool && (!c.action || k.args.action === c.action) && (!c.funded || (k.status !== null && k.status !== "draft")));
    if (!backed) return `Not done: no successful ${c.tool}${c.action ? ` "${c.action}"` : ""} call was made in this turn, so nothing was ${c.says === "fund" ? "funded" : c.says === "draft" ? "drafted" : c.says === "hold" ? "held" : "approved"}.`;
  }
  const text = withoutNegations(reply);
  const fundedNow = calls.some((k) => k.ok && k.tool === "fund_milestone" && k.status === "funded");
  const escrowOnly = fundedNow && ESCROW_CLAIM.test(text) && !RELEASE_CLAIM.test(text);
  if (MONEY_CLAIM.test(text) && !escrowOnly && !calls.some((k) => k.ok && k.tool === "get_milestone" && (k.status === "released" || k.status === "partial_released"))) {
    return "Not confirmed: no get_milestone call in this turn shows the milestone released. A queued release is not a payment until PayPal confirms it.";
  }
  return null;
}

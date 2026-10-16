import { describe, expect, it } from "vitest";
import { systemPrompt, turnPrompt } from "./prompt";
import type { MandateSummary } from "./protocol";
import { MAX_TOOLS, MONEY_TOOL, approvalLinks, claimCheck, formatArgs, paypalToolAllowed, safeApprovalUrl, selectMilestoneTools, statusOf, summarizeResult } from "./tools";

const ORIGIN = "http://localhost:3999";

describe("tool surface", () => {
  it("never offers a money-moving tool, whatever the server lists", () => {
    for (const n of ["pay_order", "create_refund", "accept_dispute_claim", "capture_order", "create_payout", "send_payouts", "refund_capture"]) expect(MONEY_TOOL.test(n), n).toBe(true);
    for (const n of ["get_milestone", "respond_to_review", "list_transactions", "fund_milestone", "list_contracts"]) expect(MONEY_TOOL.test(n), n).toBe(false);
    const listed = ["pay_order", "get_milestone", "respond_to_review", "create_refund", "list_contracts"].map((name) => ({ name }));
    expect(selectMilestoneTools(listed, 8).map((t) => t.name)).toEqual(["list_contracts", "get_milestone", "respond_to_review"]);
  });

  it("caps the list, preferred tools first", () => {
    const listed = ["zeta", "get_milestone", "alpha", "list_contracts", "respond_to_review"].map((name) => ({ name }));
    expect(selectMilestoneTools(listed, 3).map((t) => t.name)).toEqual(["list_contracts", "get_milestone", "respond_to_review"]);
    expect(MAX_TOOLS).toBeLessThanOrEqual(8);
  });

  it("exposes only list_transactions from PayPal MCP", () => {
    expect(paypalToolAllowed("list_transactions")).toBe(true);
    for (const n of ["pay_order", "create_refund", "accept_dispute_claim", "list_invoices", "create_order"]) expect(paypalToolAllowed(n)).toBe(false);
  });
});

describe("chip summaries", () => {
  it("names refusals with their reason", () => {
    expect(summarizeResult(JSON.stringify({ error: "the approval exceeds the cap", reason: "mandate_cap_exceeded" }), true)).toBe("refused · mandate_cap_exceeded: the approval exceeds the cap");
    expect(summarizeResult(JSON.stringify({ error: "x", reason: "not_release_decision" }), false)).toMatch(/^refused · not_release_decision/);
  });
  it("says a queued release is not a payment", () => {
    expect(summarizeResult(JSON.stringify({ ok: true, queued: "release" }), false)).toBe("accepted · release queued (not paid until PayPal confirms)");
    expect(summarizeResult(JSON.stringify({ ok: true, status: "held", changed: true }), false)).toBe("accepted · milestone held");
  });
  it("summarises statuses, lists and plain text", () => {
    expect(summarizeResult(JSON.stringify({ id: "mst_2", title: "Signup form", status: "review" }), false)).toBe("Signup form · review");
    expect(summarizeResult(JSON.stringify({ contracts: [1, 2] }), false)).toBe("2 contracts");
    expect(summarizeResult("x".repeat(300), false).length).toBeLessThanOrEqual(120);
    expect(statusOf({ milestone: { status: "released" } })).toBe("released");
    expect(statusOf("released")).toBeNull();
  });
  it("formats arguments compactly", () => {
    expect(formatArgs({})).toBe("");
    expect(formatArgs({ id: "mst_2", action: "approve" })).toBe('{"id":"mst_2","action":"approve"}');
  });
});

describe("approval links", () => {
  it("finds PayPal approval links and drops anything else", () => {
    const v = {
      order: { links: [{ rel: "approve", href: "https://www.sandbox.paypal.com/checkoutnow?token=5O1" }, { rel: "self", href: "https://api.sandbox.paypal.com/v2/checkout/orders/5O1" }] },
      approveUrl: "https://evil.example/checkoutnow",
      note: "https://www.paypal.com/elsewhere",
    };
    expect(approvalLinks(v, ORIGIN).map((l) => l.url)).toEqual(["https://www.sandbox.paypal.com/checkoutnow?token=5O1"]);
    expect(approvalLinks({ approveUrl: "/api/paypal/sim/approve?order=1" }, ORIGIN).map((l) => l.url)).toEqual([`${ORIGIN}/api/paypal/sim/approve?order=1`]);
    expect(safeApprovalUrl("http://www.paypal.com/x", ORIGIN)).toBeNull();
    expect(safeApprovalUrl("//evil.example/x", ORIGIN)).toBeNull();
    expect(safeApprovalUrl("javascript:alert(1)", ORIGIN)).toBeNull();
  });
});

describe("prompt", () => {
  const m: MandateSummary = { id: "mdt_x", agentName: "Casey's agent", actions: ["read", "approve"], approveCapMinor: 20000, currency: "USD", expiresAt: "2026-11-15T00:00:00.000Z", revokedAt: null, lastUsedAt: null, createdAt: "2026-10-16T00:00:00.000Z" };
  it("states the mandate and the rules", () => {
    const s = systemPrompt(m, "Casey Client", ["get_milestone", "respond_to_review"]);
    expect(s).toContain("$200.00");
    expect(s).toContain('shows status "released"');
    expect(s).toContain('untrusted="true"');
    expect(s).toContain("P6");
  });
  it("wraps earlier tool summaries as untrusted and ends with the new message", () => {
    const wrap = (t: string, l = "evidence") => `<${l} untrusted="true">${t}</${l}>`;
    const p = turnPrompt(
      [
        { role: "user", text: "hi" },
        { role: "agent", text: "hello", calls: ["Milestone MCP · get_milestone → review"] },
        { role: "user", text: "approve it" },
      ],
      wrap,
    );
    expect(p).toContain('<earlier_tool_calls untrusted="true">Milestone MCP · get_milestone → review</earlier_tool_calls>');
    expect(p.trim().endsWith("The client's new message: approve it")).toBe(true);
  });
});

describe("Milestone MCP result shapes", () => {
  it("summarises get_milestone with its approval gate", () => {
    const v = { ok: true, milestone: { id: "mst_2", title: "Signup form", status: "review" }, criteria: [1, 2, 3], agentApproval: { allowedNow: false, blockedBy: [{ reason: "mandate_cap_exceeded" }] } };
    expect(summarizeResult(JSON.stringify(v), false)).toBe("Signup form · review · approve blocked: mandate_cap_exceeded");
    expect(summarizeResult(JSON.stringify({ ...v, agentApproval: { allowedNow: true, blockedBy: [] } }), false)).toBe("Signup form · review · agent approve allowed");
    expect(summarizeResult(JSON.stringify({ ok: true, user: { id: "u" }, contracts: [1, 2, 3] }), false)).toBe("3 contracts");
    expect(summarizeResult(JSON.stringify({ ok: true, approvalUrl: "/x", orderId: "o" }), false)).toMatch(/no money moved/);
  });
});

describe("mandate-scoped tools", () => {
  it("drops tools the mandate's actions cannot use", () => {
    const listed = ["list_contracts", "get_milestone", "respond_to_review", "fund_milestone", "deliver_milestone", "draft_contract", "future_tool"].map((name) => ({ name }));
    expect(selectMilestoneTools(listed, 8, ["read", "approve"]).map((t) => t.name)).toEqual(["list_contracts", "get_milestone", "respond_to_review", "future_tool"]);
    expect(selectMilestoneTools(listed, 8, ["read"]).map((t) => t.name)).toEqual(["list_contracts", "get_milestone", "future_tool"]);
  });
});

describe("claimCheck", () => {
  const ok = (tool: string, args: Record<string, unknown> = {}, status: string | null = null) => ({ tool, args, ok: true, status });
  it("flags an approval the turn never made", () => {
    expect(claimCheck("I approved the milestone; it is queued.", [ok("list_contracts"), ok("get_milestone", { milestoneId: "mst_2" }, "review")])).toMatch(/^Not done: no successful respond_to_review "approve"/);
    expect(claimCheck("I approved the milestone; it is queued.", [{ tool: "respond_to_review", args: { action: "approve" }, ok: false, status: null }])).toMatch(/^Not done/);
    expect(claimCheck("I approved the milestone; the release is queued.", [ok("respond_to_review", { milestoneId: "mst_2", action: "approve" })])).toBeNull();
  });
  it("flags money claims without a released get_milestone", () => {
    expect(claimCheck("The milestone has been released.", [ok("respond_to_review", { action: "approve" })])).toMatch(/^Not confirmed/);
    expect(claimCheck("The milestone has been released.", [ok("get_milestone", {}, "released")])).toBeNull();
    expect(claimCheck("The release is queued; PayPal confirms it later.", [])).toBeNull();
    expect(claimCheck("A PayPal approval link was created. No money has moved yet.", [ok("fund_milestone", { milestoneId: "mst_1" })])).toBeNull();
    expect(claimCheck("It has not been released yet; the release is queued.", [])).toBeNull();
    expect(claimCheck("No approval was needed. The milestone has been released.", [])).toMatch(/^Not confirmed/);
  });
});

describe("PayPal MCP results", () => {
  it("summarises { via, simulated, data }", () => {
    expect(summarizeResult(JSON.stringify({ via: "simulated", simulated: true, data: { transaction_details: [1, 2], total_items: 2 } }), false)).toBe("simulated · 2 transactions");
  });
});

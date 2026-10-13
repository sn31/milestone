/** Dispute pack and templated draft: how decisions made without a model are worded. */
import { describe, expect, it } from "vitest";
import { compileEvidencePack, describeDecision, templateResponse, type EvidencePackInput } from "../src/dispute.ts";

const T = (min: number) => new Date(Date.UTC(2026, 9, 8, 9, 0) + min * 60_000);

function input(decision: { action: string; amountMinor: number; ruleIds: string[]; reason: string }, opts: { status?: string; client?: "client.approve" | "client.veto" | "client.hold" | null; paid?: boolean } = {}): EvidencePackInput {
  const status = opts.status ?? "released";
  const audit: EvidencePackInput["auditRows"] = [
    { id: "a1", actor: "usr_client", event: "contract.approved", createdAt: T(-60), detail: {} },
    { id: "a3", actor: "paypal", event: "milestone.funded", createdAt: T(1), detail: { amountMinor: 10_000, currency: "USD" } },
    { id: "a4", actor: "usr_freelancer", event: "delivery.manual", createdAt: T(6), detail: { ref: "r#1" } },
    { id: "a5", actor: "policy", event: "verdict.stored", createdAt: T(8), detail: { result: "partial" } },
    { id: "a6", actor: "policy", event: "policy.decided", createdAt: T(8), detail: { ...decision } },
  ];
  if (opts.client) audit.push({ id: "a7", actor: "usr_client", event: opts.client, createdAt: T(20), detail: {} });
  if (opts.paid) audit.push({ id: "a8", actor: "paypal", event: "milestone.released", createdAt: T(30), detail: { amountMinor: 10_000, currency: "USD" } });
  return {
    contract: { id: "ctr", title: "Site", currency: "USD", clientId: "usr_client", freelancerId: "usr_f", clientName: "Dana Reyes" },
    milestone: { id: "mst", seq: 1, title: "Build", amountMinor: 10_000, status, decision: { ...decision, deliveryId: "dlv" }, decidedAt: T(8) },
    criteria: [
      { id: "c1", kind: "test", description: "tests", required: true },
      { id: "c2", kind: "file", description: "file", required: true },
      { id: "c3", kind: "judgment", description: "matches", required: false },
    ],
    delivery: {
      id: "dlv",
      source: "upload",
      ref: "upload",
      payload: {},
      verdict: {
        delivery_id: "dlv",
        suspected_injection: false,
        criteria: [
          { criterion_id: "c1", status: "pass", confidence: 0.9, evidence_ids: ["e1"], rationale: "ok" },
          { criterion_id: "c2", status: "pass", confidence: 0.9, evidence_ids: ["e2"], rationale: "ok" },
          { criterion_id: "c3", status: "unclear", confidence: 0.4, evidence_ids: [], rationale: "unsure" },
        ],
      },
      result: "partial",
      receivedAt: T(6),
      verifiedAt: T(8),
    },
    auditRows: audit,
    ledgerRows: [{ txnId: "t1", account: "held:mst", amountMinor: 10_000, currency: "USD", direction: "credit", ref: "cap", createdAt: T(1) }],
  };
}

const ASK = { action: "ask_client", amountMinor: 0, ruleIds: ["P3"], reason: "The judgment criterion is unclear." };

describe("decision wording", () => {
  it("describes each action in plain words", () => {
    expect(describeDecision(ASK, "USD")).toBe("asked the client to decide (rule P3: the judgment criterion is unclear)");
    expect(describeDecision({ action: "hold", amountMinor: 0, ruleIds: ["P2"], reason: "Required criterion crt_1 failed." }, "USD")).toBe("held the payment (rule P2: required criterion crt_1 failed)");
    expect(describeDecision({ action: "partial", amountMinor: 6_000, ruleIds: ["P5"], reason: "x" }, "USD")).toBe("proposed a partial release of 60.00 USD (rule P5)");
    expect(describeDecision({ action: "release", amountMinor: 10_000, ruleIds: ["P6"], reason: "x" }, "USD")).toBe("released 100.00 USD after the review window (rule P6)");
  });

  it("never gives an ask-client decision an amount", () => {
    const pack = compileEvidencePack(input({ ...ASK, amountMinor: 10_000 }, { status: "needs_client" }));
    const d = pack.timeline.find((t) => t.event === "policy.decided")!;
    expect(d.summary).toBe("Asked the client to decide (rule P3: the judgment criterion is unclear)");
    expect(d.summary).not.toMatch(/\$|USD|0\.00/);
    expect(pack.decision?.summary).not.toMatch(/USD/);
    const text = templateResponse(pack).text;
    expect(text).toContain("then asked the client to decide (rule P3: the judgment criterion is unclear) [D1]");
    expect(text).not.toMatch(/decided to ask|\$0\.00|0\.00 USD under/);
  });

  it("states the verdict as a count, not the verdict word", () => {
    const pack = compileEvidencePack(input(ASK, { status: "needs_client" }));
    expect(pack.facts.verdictLine).toBe("2 of 3 checks passed; 1 left to the client");
    expect(pack.timeline.find((t) => t.event === "verdict.stored")!.summary).toBe("Verdict: 2 of 3 checks passed; 1 left to the client");
    expect(templateResponse(pack).text).toContain("1 left to the client");
    expect(templateResponse(pack).text).not.toMatch(/Verdict stored|: partial/);
  });
});

describe("client response and payout outcome", () => {
  it("names the approver and the ledger outcome for an approved, paid milestone", () => {
    const i = input(ASK, { client: "client.approve", paid: true });
    i.ledgerRows.push({ txnId: "t2", account: "freelancer:usr_f", amountMinor: 10_000, currency: "USD", direction: "credit", ref: "r", createdAt: T(30) });
    const text = templateResponse(compileEvidencePack(i)).text;
    expect(text).toContain("approved in full by Dana Reyes on Oct 8, 2026");
    expect(text).toContain("Payout: PayPal confirmed the payout of 100.00 USD");
  });

  it("says vetoed or held, and that no payout is recorded", () => {
    const veto = templateResponse(compileEvidencePack(input(ASK, { status: "held", client: "client.veto" }))).text;
    expect(veto).toContain("vetoed by Dana Reyes on Oct 8, 2026");
    expect(veto).toContain("Payout: none is recorded in the ledger; the milestone's status is held");
    expect(templateResponse(compileEvidencePack(input(ASK, { status: "held", client: "client.hold" }))).text).toContain("held by Dana Reyes");
  });

  it("falls back to 'the client' without a name", () => {
    const i = input(ASK, { client: "client.approve" });
    delete i.contract.clientName;
    expect(templateResponse(compileEvidencePack(i)).text).toContain("approved in full by the client on");
  });
});

describe("pack hash", () => {
  it("is stable for identical inputs and independent of row order", () => {
    const a = compileEvidencePack(input(ASK));
    const j = input(ASK);
    j.auditRows.reverse();
    expect(compileEvidencePack(j).hash).toBe(a.hash);
    expect(a.hash).toMatch(/^[0-9a-f]{16}$/);
  });
});

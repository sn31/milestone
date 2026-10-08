/**
 * Dispute copilot, no database: the evidence pack and the templated draft on fixture rows shaped like the showcase's
 * released milestone (mst_3), parsing PayPal's dispute event, and the simulator's dispute endpoints (multipart
 * provide-evidence included).
 */
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compileEvidencePack, draftResponse, templateResponse, packCites, citationsIn, type EvidencePackInput } from "@milestone/verify";
import {
  configureSimulator,
  createSimulatedPayPalClient,
  getDispute,
  multipartBody,
  openSimulatedDispute,
  parseDispute,
  provideEvidence,
  resetSimulator,
  type WebhookEvent,
} from "@milestone/money";

const T = (min: number) => new Date(Date.UTC(2026, 9, 8, 9, 0) + min * 60_000);

function fixture(): EvidencePackInput {
  return {
    contract: { id: "ctr_demo", title: "Signup flow for a SaaS landing page", currency: "USD", clientId: "usr_client", freelancerId: "usr_freelancer" },
    milestone: {
      id: "mst_3",
      seq: 3,
      title: "Polish, accessibility and docs",
      amountMinor: 10_000,
      status: "released",
      paypalCaptureId: "SIM-CAP-SHOW330K2F",
      decision: { action: "release", amountMinor: 10_000, ruleIds: ["P6"], reason: "Every criterion passed at or above the confidence threshold.", deliveryId: "dlv_show_3" },
      decidedAt: T(8),
      reviewEndsAt: T(30),
    },
    criteria: [
      { id: "crt_3_tests", kind: "test", description: "The test suite passes", required: true },
      { id: "crt_3_file", kind: "file", description: "Expected source file exists", required: true },
      { id: "crt_3_judge", kind: "judgment", description: "The delivery matches the milestone description", required: false },
    ],
    delivery: {
      id: "dlv_show_3",
      source: "github_pr",
      ref: "milestone-demo/landing#9",
      payload: { sha: "a".repeat(40), title: "Polish, accessibility and docs", pr: 9 },
      evidence: [
        { id: "ev_3_tests", criterion_id: "crt_3_tests", kind: "log", status: "pass", summary: "npm test: 17 passed" },
        { id: "ev_3_file", criterion_id: "crt_3_file", kind: "file", status: "pass", summary: "README.md exists", uri: "README.md", sha256: "b".repeat(64) },
        { id: "ev_3_note", criterion_id: "crt_3_judge", kind: "note", summary: "Every form control has a label" },
      ],
      verdict: {
        delivery_id: "dlv_show_3",
        suspected_injection: false,
        criteria: [
          { criterion_id: "crt_3_tests", status: "pass", confidence: 0.97, evidence_ids: ["ev_3_tests"], rationale: "The suite passes." },
          { criterion_id: "crt_3_file", status: "pass", confidence: 0.99, evidence_ids: ["ev_3_file"], rationale: "README.md is present." },
          { criterion_id: "crt_3_judge", status: "pass", confidence: 0.88, evidence_ids: ["ev_3_note"], rationale: "Matches the description." },
        ],
      },
      result: "pass",
      receivedAt: T(6),
      verifiedAt: T(8),
    },
    // Deliberately out of order: the pack sorts by time, then id.
    auditRows: [
      { id: "a7", actor: "paypal", event: "milestone.released", createdAt: T(36), detail: { amountMinor: 10_000, currency: "USD", payoutItemId: "SIM-ITEM-SHOW3L4MW" } },
      { id: "a1", actor: "usr_client", event: "contract.approved", createdAt: T(-60), detail: {} },
      { id: "a2", actor: "usr_client", event: "milestone.order_created", createdAt: T(0), detail: { orderId: "SIM-ORD-SHOW330A7Q", amountMinor: 10_000, currency: "USD" } },
      { id: "a3", actor: "paypal", event: "milestone.funded", createdAt: T(1), detail: { captureId: "SIM-CAP-SHOW330K2F", amountMinor: 10_000, currency: "USD" } },
      { id: "a4", actor: "usr_freelancer", event: "delivery.manual", createdAt: T(6), detail: { deliveryId: "dlv_show_3", ref: "milestone-demo/landing#9", sha: "a".repeat(40) } },
      { id: "a5", actor: "policy", event: "policy.decided", createdAt: T(8), detail: { action: "release", amountMinor: 10_000, ruleIds: ["P6"] } },
      { id: "a6", actor: "policy", event: "milestone.review", createdAt: T(8), detail: { reviewEndsAt: T(30).toISOString() } },
      { id: "a8", actor: "usr_partner", event: "advance.repaid", createdAt: T(36), detail: {} },
      { id: "a9", actor: "paypal", event: "dispute.opened", createdAt: T(90), detail: { disputeId: "PP-D-1" } },
    ],
    ledgerRows: [
      { txnId: "txn_rel", account: "freelancer:usr_freelancer", amountMinor: 4_600, currency: "USD", direction: "credit", ref: "release:mst_3", createdAt: T(36) },
      { txnId: "txn_rel", account: "held:mst_3", amountMinor: 4_600, currency: "USD", direction: "debit", ref: "release:mst_3", createdAt: T(36) },
      { txnId: "txn_fund", account: "client:usr_client", amountMinor: 10_000, currency: "USD", direction: "debit", ref: "SIM-CAP-SHOW330K2F", createdAt: T(1) },
      { txnId: "txn_fund", account: "held:mst_3", amountMinor: 10_000, currency: "USD", direction: "credit", ref: "SIM-CAP-SHOW330K2F", createdAt: T(1) },
      { txnId: "txn_rel_p", account: "held:mst_3", amountMinor: 5_400, currency: "USD", direction: "debit", ref: "release:mst_3:partner", createdAt: T(36) },
      { txnId: "txn_rel_p", account: "partner:usr_partner:receivable", amountMinor: 5_000, currency: "USD", direction: "credit", ref: "release:mst_3:partner", createdAt: T(36) },
      { txnId: "txn_rel_p", account: "partner:usr_partner:fees", amountMinor: 400, currency: "USD", direction: "credit", ref: "release:mst_3:partner", createdAt: T(36) },
    ],
    dispute: { id: "PP-D-1", reason: "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED", amountMinor: 10_000, currency: "USD" },
  };
}

describe("compileEvidencePack", () => {
  it("is deterministic and independent of row order", () => {
    const a = compileEvidencePack(fixture());
    const shuffled = fixture();
    shuffled.auditRows.reverse();
    shuffled.ledgerRows.reverse();
    const b = compileEvidencePack(shuffled);
    expect(b).toEqual(a);
    expect(a.hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("orders the timeline, keeps the dispute and advances out, and lists the client's own actions", () => {
    const pack = compileEvidencePack(fixture());
    expect(pack.timeline.map((t) => t.event)).toEqual([
      "contract.approved",
      "milestone.order_created",
      "milestone.funded",
      "delivery.manual",
      "policy.decided",
      "milestone.review",
      "milestone.released",
    ]);
    expect(pack.timeline.map((t) => t.cite)).toEqual(["T1", "T2", "T3", "T4", "T5", "T6", "T7"]);
    expect(pack.timeline[2]!.summary).toBe("Funded into escrow: 100.00 USD, capture SIM-CAP-SHOW330K2F");
    expect(pack.clientActions.map((a) => a.event)).toEqual(["contract.approved", "milestone.order_created"]);
    expect(pack.facts.clientApproved).toBe(false);
    expect(pack.facts.clientVetoed).toBe(false);
  });

  it("carries criteria with verdict rows and evidence ids, the decision, the ledger and the files", () => {
    const pack = compileEvidencePack(fixture());
    expect(pack.criteria.map((c) => [c.cite, c.id, c.status, c.required, c.evidenceIds])).toEqual([
      ["C1", "crt_3_tests", "pass", true, ["ev_3_tests"]],
      ["C2", "crt_3_file", "pass", true, ["ev_3_file"]],
      ["C3", "crt_3_judge", "pass", false, ["ev_3_note"]],
    ]);
    expect(pack.decision).toMatchObject({ cite: "D1", action: "release", amountMinor: 10_000, ruleIds: ["P6"], deliveryId: "dlv_show_3" });
    expect(pack.ledger).toHaveLength(7);
    expect(pack.ledger[0]).toMatchObject({ cite: "L1", txnId: "txn_fund", account: "held:mst_3", direction: "credit" });
    expect(pack.facts).toMatchObject({ fundedMinor: 10_000, paidToFreelancerMinor: 4_600, paidToPartnerMinor: 5_400, refundedToClientMinor: 0, released: true, requiredPassed: 2, requiredTotal: 2, criteriaPassed: 3, criteriaTotal: 3 });
    expect(pack.files).toEqual([{ cite: "F1", name: "README.md", size: null, sha256: "b".repeat(64), mime: null, origin: "repo", path: null }]);
  });

  it("lists uploaded files for an upload delivery and marks a client veto", () => {
    const input = fixture();
    input.delivery = { ...input.delivery!, source: "upload", ref: "upload", payload: { files: [{ name: "z-guide.pdf", size: 2048, sha256: "c".repeat(64), path: "d/z-guide.pdf", mime: "application/pdf" }, { name: "a-logo.png", size: 1024, sha256: "d".repeat(64), path: "d/a-logo.png", mime: "image/png" }] } };
    input.auditRows.push({ id: "a10", actor: "usr_client", event: "client.veto", createdAt: T(20), detail: {} });
    const pack = compileEvidencePack(input);
    expect(pack.files.map((f) => [f.cite, f.name, f.origin, f.path])).toEqual([
      ["F1", "a-logo.png", "upload", "d/a-logo.png"],
      ["F2", "z-guide.pdf", "upload", "d/z-guide.pdf"],
    ]);
    expect(pack.facts.clientVetoed).toBe(true);
    expect(pack.clientActions.at(-1)?.event).toBe("client.veto");
  });
});

describe("templated draft", () => {
  it("writes two paragraphs from the pack, citing only ids the pack has, within PayPal's limit", async () => {
    const pack = compileEvidencePack(fixture());
    // Anthropic with no key: never configured, so the template is used whether or not Ollama is running.
    const draft = await draftResponse(pack, { env: { MODEL_PROVIDER: "anthropic" } });
    expect(draft.source).toBe("template");
    expect(draft).toEqual(templateResponse(pack));
    expect(draft.paragraphs).toHaveLength(2);
    expect(draft.text.split("\n\n")).toHaveLength(2);
    expect(draft.text.length).toBeLessThanOrEqual(2000);
    const valid = packCites(pack);
    expect(draft.citations.length).toBeGreaterThan(5);
    for (const c of draft.citations) expect(valid.has(c)).toBe(true);
    expect(draft.citations).toEqual(expect.arrayContaining(["T1", "T3", "C1", "C2", "C3", "D1", "T6", "T7", "F1"]));
    expect(draft.text).toContain("100.00 USD");
    expect(draft.text).toContain("pull request milestone-demo/landing#9");
    expect(draft.text).toContain("3 of 3 passed");
    expect(draft.text).toContain("did not use it");
    expect(draft.text).toContain("in the seller's favour");
  });

  it("is the same text for the same pack", () => {
    expect(templateResponse(compileEvidencePack(fixture())).text).toBe(templateResponse(compileEvidencePack(fixture())).text);
  });

  it("reads citations in single and grouped form", () => {
    expect(citationsIn("a [T1] b [C1, C2] c [T1]")).toEqual(["T1", "C1", "C2"]);
  });
});

describe("parseDispute", () => {
  it("reads PayPal's CUSTOMER.DISPUTE.CREATED resource", () => {
    const evt = JSON.parse(readFileSync(new URL("../../../fixtures/webhooks/paypal-dispute-created.json", import.meta.url), "utf8")) as WebhookEvent;
    expect(parseDispute(evt.resource)).toEqual({
      disputeId: "PP-D-27803",
      reason: "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED",
      status: "OPEN",
      stage: "INQUIRY",
      outcome: null,
      transactionIds: ["3C679366HH908993F"],
      amountMinor: 10_000,
      currency: "USD",
      dueAt: "2026-10-17T15:30:00.000Z",
    });
    expect(parseDispute({})).toBeNull();
  });
});

describe("simulated dispute endpoints", () => {
  const events: WebhookEvent[] = [];
  beforeAll(() => {
    configureSimulator({ stateFile: null, webhookDelayMs: 5, disputeResolveDelayMs: 30, deliver: (e) => void events.push(e) });
    resetSimulator();
  });
  afterAll(() => configureSimulator({ deliver: null, webhookDelayMs: 1500, disputeResolveDelayMs: 2000 }));
  const until = async (f: () => boolean) => {
    for (let i = 0; i < 100 && !f(); i++) await new Promise((r) => setTimeout(r, 10));
  };

  it("opens, takes multipart evidence and resolves in the seller's favour", async () => {
    const client = createSimulatedPayPalClient();
    const opened = openSimulatedDispute({ captureId: "CAP-TEST-1", amountMinor: 10_000, currency: "USD" });
    expect(opened.created).toBe(true);
    expect(openSimulatedDispute({ captureId: "CAP-TEST-1", amountMinor: 10_000, currency: "USD" })).toMatchObject({ disputeId: opened.disputeId, created: false });
    await until(() => events.some((e) => e.event_type === "CUSTOMER.DISPUTE.CREATED"));
    const created = events.find((e) => e.event_type === "CUSTOMER.DISPUTE.CREATED")!;
    expect(parseDispute(created.resource)).toMatchObject({ disputeId: opened.disputeId, transactionIds: ["CAP-TEST-1"], status: "WAITING_FOR_SELLER_RESPONSE" });

    const pdf = new TextEncoder().encode("%PDF-1.4 test");
    await provideEvidence(client, opened.disputeId, { evidences: [{ evidence_type: "PROOF_FOR_SOFTWARE_OR_SERVICE_DELIVERED", notes: "Delivered [T1].", documents: [{ name: "guide.pdf" }] }], files: [{ name: "guide.pdf", bytes: pdf, mime: "application/pdf" }] }, { requestId: "req-ev-1" });
    const reviewing = await getDispute(client, opened.disputeId);
    expect(reviewing.status).toBe("UNDER_REVIEW");
    expect((reviewing as unknown as { evidences: Array<{ notes: string; documents: Array<{ name: string; size: number }> }> }).evidences[0]).toMatchObject({ notes: "Delivered [T1].", documents: [{ name: "guide.pdf", size: pdf.length }] });
    // The same PayPal-Request-Id replays the first answer instead of failing on the new status.
    await expect(provideEvidence(client, opened.disputeId, { evidences: [{ evidence_type: "OTHER", notes: "again" }] }, { requestId: "req-ev-1" })).resolves.toBeTruthy();
    await expect(provideEvidence(client, opened.disputeId, { evidences: [{ evidence_type: "OTHER", notes: "again" }] }, { requestId: "req-ev-2" })).rejects.toThrow(/INVALID_DISPUTE_STATUS|not waiting/);

    await until(() => events.some((e) => e.event_type === "CUSTOMER.DISPUTE.RESOLVED"));
    const resolved = events.find((e) => e.event_type === "CUSTOMER.DISPUTE.RESOLVED")!;
    expect(parseDispute(resolved.resource)).toMatchObject({ disputeId: opened.disputeId, status: "RESOLVED", outcome: "RESOLVED_SELLER_FAVOUR" });
    expect((await getDispute(client, opened.disputeId)).status).toBe("RESOLVED");
  });

  it("accept-claim resolves in the buyer's favour", async () => {
    const client = createSimulatedPayPalClient();
    const opened = openSimulatedDispute({ captureId: "CAP-TEST-2", amountMinor: 5_000, currency: "USD" });
    // accept-claim moves money, so @milestone/money exposes it only through acceptDisputeClaim (execute.ts); the simulator's
    // endpoint is exercised with the raw client here.
    await client.request("POST", `/v1/customer/disputes/${opened.disputeId}/accept-claim`, { note: "Refunding.", accept_claim_type: "REFUND" }, { requestId: "req-acc-1" });
    const d = await getDispute(client, opened.disputeId);
    expect(d.status).toBe("RESOLVED");
    expect(d.dispute_outcome?.outcome_code).toBe("RESOLVED_BUYER_FAVOUR");
  });

  it("builds multipart bodies with an input JSON part and file parts", async () => {
    const { body, contentType } = multipartBody([
      { name: "input", contentType: "application/json", data: JSON.stringify({ evidences: [] }) },
      { name: "a.png", filename: "a.png", contentType: "image/png", data: new Uint8Array([1, 2, 3]) },
    ]);
    const form = await new Response(body, { headers: { "content-type": contentType } }).formData();
    expect(form.get("input")).toBe('{"evidences":[]}');
    const file = form.get("a.png") as File;
    expect(file.name).toBe("a.png");
    expect(file.size).toBe(3);
  });
});

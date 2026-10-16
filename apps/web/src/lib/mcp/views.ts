/**
 * Read models for the MCP tools: what an agent needs to see about the user's contracts, one milestone and a contract's
 * ledger. Freelancer-supplied text only ever appears inside an `untrusted` field (see untrusted.ts).
 */
import { and, asc, desc, eq, inArray, or } from "drizzle-orm";
import {
  OP_KINDS,
  advances,
  asNumber,
  asRecord,
  asString,
  contracts,
  criteria as criteriaTable,
  decisionDeliveryId,
  deliveries,
  ledgerEntries,
  ledgerRefs,
  mandateAllows,
  milestones,
  paypalOps,
  requiredNotPassed,
  toPayPalValue,
  type AgentMandate,
  type Db,
} from "@milestone/core";
import { txnKind } from "@/components/ledger-labels";
import { policyRule } from "@/lib/policy-rules";
import { cleanText, untrusted } from "./untrusted";

type Contract = typeof contracts.$inferSelect;
type Milestone = typeof milestones.$inferSelect;

export const money = (amountMinor: number, currency: string) => ({ amountMinor, value: toPayPalValue(amountMinor, currency), currency });

export function partyRole(userId: string, c: Pick<Contract, "clientId" | "freelancerId">): "client" | "freelancer" | null {
  if (c.clientId === userId) return "client";
  if (c.freelancerId === userId) return "freelancer";
  return null;
}

// ---------- list_contracts ----------

export async function listContracts(db: Db, userId: string) {
  const rows = await db.query.contracts.findMany({
    where: (t) => or(eq(t.clientId, userId), eq(t.freelancerId, userId)),
    with: { milestones: { orderBy: (m, { asc }) => asc(m.seq) } },
    orderBy: (t, { desc }) => desc(t.createdAt),
  });
  return rows.map((c) => ({
    id: c.id,
    title: c.title,
    status: c.status,
    yourRole: partyRole(userId, c),
    total: money(c.totalMinor, c.currency),
    repo: c.repoFullName,
    approvedByClient: c.clientApprovedAt !== null,
    approvedByFreelancer: c.freelancerApprovedAt !== null,
    milestones: c.milestones.map((m) => ({ id: m.id, seq: m.seq, title: m.title, status: m.status, amount: money(m.amountMinor, c.currency), reviewEndsAt: m.reviewEndsAt?.toISOString() ?? null })),
  }));
}

// ---------- get_milestone ----------

/** The policy's own release rule: the only decision an agent may approve early. */
const POLICY_RELEASE_RULE = "P6";

export interface ApprovalCheck {
  /** Advisory only: respond_to_review re-checks everything in the review route, under the milestone's row lock. */
  allowedNow: boolean;
  /** Every condition that is not met now, as { reason, detail }. Empty when allowedNow. */
  blockedBy: Array<{ reason: string; detail: string }>;
}

/**
 * Whether respond_to_review "approve" would be accepted now, and every reason it would not. Mirrors the review route's
 * conditions (the route is the authority and re-checks them all; this is only what the agent is told).
 */
export async function approvalCheck(db: Db, mandate: AgentMandate, userId: string, m: Milestone, c: Contract, latestDeliveryId: string | null, now = new Date()): Promise<ApprovalCheck> {
  const blockedBy: ApprovalCheck["blockedBy"] = [];
  if (c.clientId !== userId) blockedBy.push({ reason: "not_contract_client", detail: "only the contract's client (and an agent acting for them) can answer a review" });
  const amount = Math.max(m.amountMinor, m.decision?.amountMinor ?? 0);
  const allowed = mandateAllows(mandate, "approve", amount, { currency: c.currency, now });
  if ("refused" in allowed) {
    const cap = mandate.approveCapMinor;
    const detail =
      allowed.refused === "mandate_cap_exceeded"
        ? `amount ${toPayPalValue(amount, c.currency)} ${c.currency} vs mandate cap ${cap === null ? "none (no approvals)" : `${toPayPalValue(cap, mandate.currency)} ${mandate.currency}`}`
        : allowed.refused === "mandate_missing_action"
          ? 'the mandate does not include "approve"'
          : allowed.refused === "mandate_expired"
            ? "the mandate has expired"
            : "the mandate was revoked";
    blockedBy.push({ reason: allowed.refused, detail });
  }
  const decision = m.decision;
  const decided = decisionDeliveryId(decision);
  const isRelease = m.status === "review" && decision?.action === "release" && Array.isArray(decision.ruleIds) && decision.ruleIds.includes(POLICY_RELEASE_RULE);
  if (!isRelease || !decided || decided !== latestDeliveryId) {
    const why =
      m.status !== "review"
        ? `the milestone is ${m.status}, not review`
        : decision?.action !== "release" || !decision.ruleIds?.includes(POLICY_RELEASE_RULE)
          ? `the policy decided ${decision?.action ?? "nothing"} (${decision?.ruleIds?.join(", ") || "no rule"}), not release (P6)`
          : "the decision was made for an earlier delivery, not the latest one";
    blockedBy.push({ reason: "not_release_decision", detail: why });
  }
  if (decided) {
    const [delivery, rows] = await Promise.all([
      db.query.deliveries.findFirst({ columns: { verdict: true }, where: eq(deliveries.id, decided) }),
      db.query.criteria.findMany({ where: eq(criteriaTable.milestoneId, m.id) }),
    ]);
    const blocked = requiredNotPassed(delivery?.verdict, rows);
    if (blocked.length > 0) blockedBy.push({ reason: "required_criteria_not_passed", detail: `required criteria not passed: ${blocked.join("; ")}` });
  }
  const claimed = await db
    .select({ kind: paypalOps.kind, status: paypalOps.status })
    .from(paypalOps)
    .where(and(eq(paypalOps.key, m.id), inArray(paypalOps.kind, [OP_KINDS.payout, OP_KINDS.refund]), inArray(paypalOps.status, ["sent", "succeeded", "failed"])));
  if (claimed.length > 0) blockedBy.push({ reason: "payout_started", detail: `a ${claimed[0]!.kind} for this milestone is already ${claimed[0]!.status} at PayPal` });
  return { allowedNow: blockedBy.length === 0, blockedBy };
}

export async function milestoneView(db: Db, mandate: AgentMandate, userId: string, m: Milestone, c: Contract, now = new Date()) {
  const [crit, latest] = await Promise.all([
    db.query.criteria.findMany({ where: eq(criteriaTable.milestoneId, m.id), orderBy: (t, { asc }) => asc(t.id) }),
    db.query.deliveries.findFirst({ where: eq(deliveries.milestoneId, m.id), orderBy: (t) => desc(t.receivedAt) }),
  ]);

  const verdictRows = (() => {
    const rows = asRecord(latest?.verdict).criteria;
    return Array.isArray(rows) ? rows.map(asRecord) : [];
  })();
  const evidence = Array.isArray(latest?.evidence) ? latest.evidence.map(asRecord) : [];
  const payload = asRecord(latest?.payload);

  const decision = m.decision
    ? {
        action: m.decision.action,
        amount: money(m.decision.amountMinor, c.currency),
        rules: (m.decision.ruleIds ?? []).map((id) => ({ id, meaning: policyRule(id) ?? null })),
        reason: cleanText(m.decision.reason, 600),
        forDeliveryId: decisionDeliveryId(m.decision),
        forLatestDelivery: decisionDeliveryId(m.decision) !== null && decisionDeliveryId(m.decision) === (latest?.id ?? null),
        decidedAt: m.decidedAt?.toISOString() ?? null,
      }
    : null;

  const remaining = m.status === "review" && m.reviewEndsAt ? Math.max(0, Math.floor((m.reviewEndsAt.getTime() - now.getTime()) / 1000)) : null;

  return {
    milestone: {
      id: m.id,
      contractId: c.id,
      contractTitle: c.title,
      contractStatus: c.status,
      seq: m.seq,
      title: m.title,
      status: m.status,
      amount: money(m.amountMinor, c.currency),
      clientResponse: m.clientResponse,
    },
    yourRole: partyRole(userId, c),
    reviewWindow: {
      endsAt: m.reviewEndsAt?.toISOString() ?? null,
      remainingSeconds: remaining,
      note: m.status === "review" ? "Without a veto the release goes ahead when the window closes; an agent's approve only makes it happen sooner." : null,
    },
    criteria: crit.map((k) => ({ id: k.id, kind: k.kind, description: k.description, required: k.required })),
    latestVerdict: latest
      ? {
          deliveryId: latest.id,
          source: latest.source,
          receivedAt: latest.receivedAt.toISOString(),
          verifiedAt: latest.verifiedAt?.toISOString() ?? null,
          result: latest.result,
          model: latest.model,
          suspectedInjection: latest.suspectedInjection,
          criteria: verdictRows.map((r) => ({
            criterionId: asString(r.criterion_id),
            status: asString(r.status),
            confidence: asNumber(r.confidence),
            evidenceIds: Array.isArray(r.evidence_ids) ? r.evidence_ids.filter((x): x is string => typeof x === "string") : [],
          })),
          evidence: evidence.map((e) => ({ id: asString(e.id), kind: asString(e.kind), criterionId: asString(e.criterion_id), status: asString(e.status) })),
        }
      : null,
    decision,
    agentApproval: await approvalCheck(db, mandate, userId, m, c, latest?.id ?? null, now),
    untrusted: latest
      ? untrusted({
          verdictRationales: verdictRows.map((r) => ({ criterionId: asString(r.criterion_id), rationale: cleanText(r.rationale) })),
          commit: { title: cleanText(payload.title, 300), body: cleanText(payload.body), branch: cleanText(payload.branch, 200), ref: cleanText(latest.ref, 600) },
          evidenceSummaries: evidence.map((e) => ({ id: asString(e.id), summary: cleanText(e.summary, 600) })),
        })
      : null,
  };
}

// ---------- get_ledger ----------

/**
 * Every ledger entry that touches the contract's milestones, the same set the contract's ledger page shows: whole
 * transactions (both legs) posting to a held:<milestone> account, plus advance fundings for those milestones.
 */
export async function ledgerView(db: Db, c: Contract) {
  const ms = await db.select({ id: milestones.id, seq: milestones.seq, title: milestones.title, status: milestones.status }).from(milestones).where(eq(milestones.contractId, c.id)).orderBy(asc(milestones.seq));
  const heldOf = new Map(ms.map((m) => [`held:${m.id}`, m.id]));
  const adv = ms.length > 0 ? await db.select({ id: advances.id, milestoneId: advances.milestoneId }).from(advances).where(inArray(advances.milestoneId, ms.map((m) => m.id))) : [];
  const advOf = new Map(adv.map((a) => [ledgerRefs.advanceFunding(a.id), a.milestoneId]));
  const entries =
    heldOf.size + advOf.size === 0
      ? []
      : await db
          .select()
          .from(ledgerEntries)
          .where(
            inArray(
              ledgerEntries.txnId,
              db
                .select({ txnId: ledgerEntries.txnId })
                .from(ledgerEntries)
                .where(or(...(heldOf.size ? [inArray(ledgerEntries.account, [...heldOf.keys()])] : []), ...(advOf.size ? [inArray(ledgerEntries.ref, [...advOf.keys()])] : []))),
            ),
          )
          .orderBy(asc(ledgerEntries.createdAt), asc(ledgerEntries.txnId), asc(ledgerEntries.direction), asc(ledgerEntries.account));

  const legsOf = new Map<string, typeof entries>();
  for (const e of entries) legsOf.set(e.txnId, [...(legsOf.get(e.txnId) ?? []), e]);
  const txnMilestone = new Map<string, string>();
  for (const e of entries) {
    const m = heldOf.get(e.account) ?? advOf.get(e.ref);
    if (m && !txnMilestone.has(e.txnId)) txnMilestone.set(e.txnId, m);
  }
  const transactions = [...legsOf].map(([txnId, legs]) => ({
    txnId,
    kind: txnKind(legs),
    milestoneId: txnMilestone.get(txnId) ?? null,
    at: legs[0]!.createdAt.toISOString(),
    ref: legs[0]!.ref,
    balanced: legs.reduce((s, l) => s + (l.direction === "debit" ? l.amountMinor : -l.amountMinor), 0) === 0,
    legs: legs.map((l) => ({ account: l.account, direction: l.direction, amountMinor: l.amountMinor, currency: l.currency })),
  }));
  // Escrow per milestone: credits into held:<m> minus debits out of it (what is still held for that milestone).
  const heldBalance = new Map<string, number>();
  for (const e of entries) {
    const m = heldOf.get(e.account);
    if (m) heldBalance.set(m, (heldBalance.get(m) ?? 0) + (e.direction === "credit" ? e.amountMinor : -e.amountMinor));
  }
  const totals: Record<string, number> = {};
  for (const t of transactions) {
    const moved = t.legs.filter((l) => l.direction === "debit").reduce((s, l) => s + l.amountMinor, 0);
    totals[t.kind] = (totals[t.kind] ?? 0) + moved;
  }
  return {
    contract: { id: c.id, title: c.title, currency: c.currency, total: money(c.totalMinor, c.currency) },
    milestones: ms.map((m) => ({ id: m.id, seq: m.seq, title: m.title, status: m.status, heldInEscrow: money(heldBalance.get(m.id) ?? 0, c.currency) })),
    totalsByKind: Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, money(v, c.currency)])),
    allTransactionsBalanced: transactions.every((t) => t.balanced),
    transactions,
  };
}

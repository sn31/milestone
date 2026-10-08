import type { CriterionSpec, CriterionVerdict, PolicyDecision, VerdictOutput } from "@milestone/core";

export interface DecideInput {
  verdict: VerdictOutput;
  criteria: CriterionSpec[];
  milestone: { amountMinor: number; currency: string };
  contract: {
    /** P4: anything above this goes to the client. Undefined = no cap. */
    perReleaseCapMinor?: number;
    /** P3: lowest acceptable confidence on any criterion. Default 0.8. */
    confidenceThreshold?: number;
  };
}

/**
 * One pure function. Rules run in order; the first match wins.
 * Invariant (property-tested): never returns "release" while any required criterion is not a pass.
 */
export function decide(input: DecideInput): PolicyDecision {
  const threshold = input.contract.confidenceThreshold ?? 0.8;
  const amount = input.milestone.amountMinor;
  const byId = new Map(input.verdict.criteria.map((c) => [c.criterion_id, c]));

  // A criterion the verdict does not mention is treated as unclear, never as a pass.
  const rows = input.criteria.map((spec) => {
    const v: CriterionVerdict = byId.get(spec.id) ?? {
      criterion_id: spec.id,
      status: "unclear",
      confidence: 0,
      evidence_ids: [],
      rationale: "no verdict recorded for this criterion",
    };
    return { spec, v };
  });

  if (rows.length === 0) {
    return { action: "ask_client", amountMinor: 0, ruleIds: ["P0"], reason: "The milestone has no acceptance criteria." };
  }

  if (input.verdict.suspected_injection) {
    return { action: "ask_client", amountMinor: 0, ruleIds: ["P1"], reason: "The delivery contains text that tries to instruct the reviewer." };
  }

  const requiredFails = rows.filter((r) => r.spec.required && r.v.status === "fail");
  if (requiredFails.length > 0) {
    const names = requiredFails.map((r) => r.spec.description).join("; ");
    return { action: "hold", amountMinor: 0, ruleIds: ["P2"], reason: `Required criteria failed: ${names}` };
  }

  const unclear = rows.filter((r) => r.v.status === "unclear");
  const lowest = Math.min(...rows.map((r) => r.v.confidence));
  if (unclear.length > 0 || lowest < threshold) {
    const why = unclear.length > 0
      ? `Could not verify: ${unclear.map((r) => r.spec.description).join("; ")}`
      : `Lowest confidence ${lowest.toFixed(2)} is under ${threshold}`;
    return { action: "ask_client", amountMinor: 0, ruleIds: ["P3"], reason: why };
  }

  if (input.contract.perReleaseCapMinor !== undefined && amount > input.contract.perReleaseCapMinor) {
    return { action: "ask_client", amountMinor: 0, ruleIds: ["P4"], reason: "Amount is above the contract's per-release cap." };
  }

  const optionalFails = rows.filter((r) => !r.spec.required && r.v.status === "fail");
  if (optionalFails.length > 0) {
    const passed = rows.length - optionalFails.length;
    const proposed = Math.floor((amount * passed) / rows.length);
    return {
      action: "partial",
      amountMinor: proposed,
      ruleIds: ["P5"],
      reason: `${passed} of ${rows.length} criteria passed; optional criteria failed: ${optionalFails.map((r) => r.spec.description).join("; ")}`,
    };
  }

  return { action: "release", amountMinor: amount, ruleIds: ["P6"], reason: "Every criterion passed at or above the confidence threshold." };
}

export interface ReviewWindowState {
  decision: PolicyDecision;
  vetoed: boolean;
  approvedEarly: boolean;
  windowExpired: boolean;
}

/** The review window can only make a decision more conservative, or let a release through. */
export function applyReviewWindow(s: ReviewWindowState): PolicyDecision {
  if (s.vetoed) {
    return { action: "hold", amountMinor: 0, ruleIds: [...s.decision.ruleIds, "RW-veto"], reason: "Client vetoed during the review window." };
  }
  if (s.decision.action === "release" && (s.approvedEarly || s.windowExpired)) return s.decision;
  if (s.decision.action === "release") {
    return { ...s.decision, action: "ask_client", amountMinor: 0, ruleIds: [...s.decision.ruleIds, "RW-open"], reason: "Review window still open." };
  }
  return s.decision;
}

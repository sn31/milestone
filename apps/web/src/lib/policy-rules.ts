/**
 * The policy rules in plain words, one sentence each, keyed by the rule id the stamp prints. The wording follows the
 * order and reasons in packages/money/src/policy/decide.ts: rules run in order and the first match wins. Used as the
 * title and "?" key on every stamp and folded-receipt rule chip, and by the Start-here band (HOW_POLICY_DECIDES).
 */
export const POLICY_RULES: Record<string, string> = {
  P0: "Ask the client: the milestone has no acceptance criteria, so there is nothing for the agent to check.",
  P1: "Ask the client: the delivery contains text that tries to instruct the reviewer, so its verdict is not trusted.",
  P2: "Hold: a required criterion failed, so the money stays in escrow until a new delivery passes.",
  P3: "Ask the client: a criterion could not be verified, or its confidence is under the contract's threshold.",
  P4: "Ask the client: the amount is above the contract's per-release cap.",
  P5: "Partial: every required criterion passed but an optional one failed, so the passed share is proposed.",
  P6: "Release: every criterion passed at or above the confidence threshold.",
};

/** One sentence for a rule id (e.g. "P3"), or undefined for an id the policy does not define. */
export function policyRule(id: string): string | undefined {
  return POLICY_RULES[id.trim().toUpperCase()];
}

/**
 * How the policy decides, in the order the rules run, for the Start-here band or any "how it works" copy. Each entry
 * is the rule id, the action it takes and the sentence from POLICY_RULES.
 */
export const HOW_POLICY_DECIDES: ReadonlyArray<{ id: string; action: "ask_client" | "hold" | "partial" | "release"; sentence: string }> = [
  { id: "P0", action: "ask_client", sentence: POLICY_RULES.P0! },
  { id: "P1", action: "ask_client", sentence: POLICY_RULES.P1! },
  { id: "P2", action: "hold", sentence: POLICY_RULES.P2! },
  { id: "P3", action: "ask_client", sentence: POLICY_RULES.P3! },
  { id: "P4", action: "ask_client", sentence: POLICY_RULES.P4! },
  { id: "P5", action: "partial", sentence: POLICY_RULES.P5! },
  { id: "P6", action: "release", sentence: POLICY_RULES.P6! },
];

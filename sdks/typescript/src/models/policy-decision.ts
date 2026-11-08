import * as s from "../core/validation/index.js";
import type { Schema } from "../core/validation/schema.js";
import { actionSchema, type Action } from "./action.js";

export type PolicyDecision = {
  action: Action;
  amountMinor: number;
  ruleIds: string[];
  reason: string;
};

export const policyDecisionSchema: Schema<PolicyDecision> = s.object<PolicyDecision>({
  action: actionSchema,
  amountMinor: s.int(),
  ruleIds: s.array(s.string()),
  reason: s.string(),
});

import * as s from "../core/validation/index.js";
import type { Schema } from "../core/validation/schema.js";

export type AdvanceTerms = {
  principalMinor?: number;
  feeBpsPerDay?: number;
  /** Days until the milestone is due */
  days?: number;
  expectedFeeMinor?: number;
  repaymentMinor?: number;
  /** Estimated chance of failing verification */
  pFail?: number;
};

export const advanceTermsSchema: Schema<AdvanceTerms> = s.object<AdvanceTerms>({
  principalMinor: s.optional(s.int()),
  feeBpsPerDay: s.optional(s.float64()),
  days: s.optional(s.int()),
  expectedFeeMinor: s.optional(s.int()),
  repaymentMinor: s.optional(s.int()),
  pFail: s.optional(s.float64()),
});

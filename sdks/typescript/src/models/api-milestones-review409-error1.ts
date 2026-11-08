import * as s from "../core/validation/index.js";
import type { Schema } from "../core/validation/schema.js";

export type ApiMilestonesReview409Error1 = {
  error: string;
  /** For example review_window_closed, needs_operator, payout_sent, required_criteria_not_passed */
  reason?: string;
  criteria?: string[];
};

export const apiMilestonesReview409Error1Schema: Schema<ApiMilestonesReview409Error1> =
  s.object<ApiMilestonesReview409Error1>({
    error: s.string(),
    reason: s.optional(s.string()),
    criteria: s.optional(s.array(s.string())),
  });

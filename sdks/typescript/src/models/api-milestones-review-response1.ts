import * as s from "../core/validation/index.js";
import type { Schema } from "../core/validation/schema.js";

export type ApiMilestonesReviewResponse1 = {
  ok: boolean;
  /** @default "held" */
  status?: "held";
  changed: boolean;
};

export const apiMilestonesReviewResponse1Schema: Schema<ApiMilestonesReviewResponse1> =
  s.object<ApiMilestonesReviewResponse1>({
    ok: s.boolean(),
    status: s.defaulted(s.literal("held"), "held"),
    changed: s.boolean(),
  });

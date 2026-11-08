import * as s from "../core/validation/index.js";
import type { Schema } from "../core/validation/schema.js";
import { action1Schema, type Action1 } from "./action1.js";

export type ApiMilestonesReviewRequest = {
  action: Action1;
};

export const apiMilestonesReviewRequestSchema: Schema<ApiMilestonesReviewRequest> =
  s.object<ApiMilestonesReviewRequest>({
    action: action1Schema,
  });

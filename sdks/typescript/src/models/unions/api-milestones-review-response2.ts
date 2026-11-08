import * as s from "../../core/validation/index.js";
import type { Schema } from "../../core/validation/schema.js";
import {
  apiMilestonesReviewResponseSchema,
  type ApiMilestonesReviewResponse,
} from "../api-milestones-review-response.js";
import {
  apiMilestonesReviewResponse1Schema,
  type ApiMilestonesReviewResponse1,
} from "../api-milestones-review-response1.js";

export type ApiMilestonesReviewResponse2 = ApiMilestonesReviewResponse | ApiMilestonesReviewResponse1;

export const apiMilestonesReviewResponse2Schema: Schema<ApiMilestonesReviewResponse2> =
  s.of<ApiMilestonesReviewResponse2>(
    s.union([
      s.lazy(() => apiMilestonesReviewResponseSchema),
      s.lazy(() => apiMilestonesReviewResponse1Schema),
    ]),
  );

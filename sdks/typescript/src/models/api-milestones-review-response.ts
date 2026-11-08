import * as s from "../core/validation/index.js";
import type { Schema } from "../core/validation/schema.js";

export type ApiMilestonesReviewResponse = {
  ok: boolean;
  /** @default "release" */
  queued?: "release";
};

export const apiMilestonesReviewResponseSchema: Schema<ApiMilestonesReviewResponse> =
  s.object<ApiMilestonesReviewResponse>({
    ok: s.boolean(),
    queued: s.defaulted(s.literal("release"), "release"),
  });

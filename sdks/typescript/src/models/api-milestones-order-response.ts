import * as s from "../core/validation/index.js";
import type { Schema } from "../core/validation/schema.js";

export type ApiMilestonesOrderResponse = {
  orderId: string;
};

export const apiMilestonesOrderResponseSchema: Schema<ApiMilestonesOrderResponse> =
  s.object<ApiMilestonesOrderResponse>({
    orderId: s.string(),
  });

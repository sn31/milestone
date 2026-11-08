import * as s from "../core/validation/index.js";
import type { Schema } from "../core/validation/schema.js";

export type ApiMilestonesCaptureRequest = {
  orderId: string;
};

export const apiMilestonesCaptureRequestSchema: Schema<ApiMilestonesCaptureRequest> =
  s.object<ApiMilestonesCaptureRequest>({
    orderId: s.string(),
  });

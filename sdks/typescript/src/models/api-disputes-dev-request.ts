import * as s from "../core/validation/index.js";
import type { Schema } from "../core/validation/schema.js";

export type ApiDisputesDevRequest = {
  milestoneId: string;
  reason?: string;
};

export const apiDisputesDevRequestSchema: Schema<ApiDisputesDevRequest> = s.object<ApiDisputesDevRequest>({
  milestoneId: s.string(),
  reason: s.optional(s.string()),
});

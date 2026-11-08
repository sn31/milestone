import * as s from "../core/validation/index.js";
import type { Schema } from "../core/validation/schema.js";

export type ApiAgentsRequest = {
  fundCap?: string | null;
  fundTotalCap?: string | null;
  autoFundNext?: boolean;
};

export const apiAgentsRequestSchema: Schema<ApiAgentsRequest> = s.object<ApiAgentsRequest>({
  fundCap: s.optionalNullable(s.string()),
  fundTotalCap: s.optionalNullable(s.string()),
  autoFundNext: s.optional(s.boolean()),
});

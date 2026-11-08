import * as s from "../core/validation/index.js";
import type { Schema } from "../core/validation/schema.js";

export type ApiContractsCriteriaRequest = {
  milestoneId: string;
  operations: Record<string, unknown>[];
};

export const apiContractsCriteriaRequestSchema: Schema<ApiContractsCriteriaRequest> =
  s.object<ApiContractsCriteriaRequest>({
    milestoneId: s.string(),
    operations: s.array(s.record(s.string(), s.unknown())),
  });

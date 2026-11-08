import * as s from "../core/validation/index.js";
import type { Schema } from "../core/validation/schema.js";

export type ApiAdvancesAcceptRequest = {
  milestoneId: string;
};

export const apiAdvancesAcceptRequestSchema: Schema<ApiAdvancesAcceptRequest> =
  s.object<ApiAdvancesAcceptRequest>({
    milestoneId: s.string(),
  });

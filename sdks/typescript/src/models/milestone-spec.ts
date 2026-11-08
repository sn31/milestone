import * as s from "../core/validation/index.js";
import type { Schema } from "../core/validation/schema.js";
import { criterionSpecSchema, type CriterionSpec } from "./criterion-spec.js";

export type MilestoneSpec = {
  seq: number;
  title: string;
  amountMinor: number;
  dueAt?: string;
  criteria: CriterionSpec[];
};

export const milestoneSpecSchema: Schema<MilestoneSpec> = s.object<MilestoneSpec>({
  seq: s.int(),
  title: s.string(),
  amountMinor: s.int(),
  dueAt: s.optional(s.string()),
  criteria: s.array(s.lazy(() => criterionSpecSchema)),
});

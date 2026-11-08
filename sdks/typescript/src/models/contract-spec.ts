import * as s from "../core/validation/index.js";
import type { Schema } from "../core/validation/schema.js";
import { milestoneSpecSchema, type MilestoneSpec } from "./milestone-spec.js";

/** The compiler's output (zod ContractSpec in packages/core) */
export type ContractSpec = {
  title: string;
  currency: string;
  totalMinor: number;
  milestones: MilestoneSpec[];
};

export const contractSpecSchema: Schema<ContractSpec> = s.object<ContractSpec>({
  title: s.string(),
  currency: s.string(),
  totalMinor: s.int(),
  milestones: s.array(s.lazy(() => milestoneSpecSchema)),
});

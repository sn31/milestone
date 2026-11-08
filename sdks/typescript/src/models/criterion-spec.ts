import * as s from "../core/validation/index.js";
import type { Schema } from "../core/validation/schema.js";
import { criterionKindSchema, type CriterionKind } from "./criterion-kind.js";

export type CriterionSpec = {
  id: string;
  kind: CriterionKind;
  description: string;
  spec?: Record<string, unknown>;
  /** @default true */
  required?: boolean;
};

export const criterionSpecSchema: Schema<CriterionSpec> = s.object<CriterionSpec>({
  id: s.string(),
  kind: criterionKindSchema,
  description: s.string(),
  spec: s.optional(s.record(s.string(), s.unknown())),
  required: s.defaulted(s.boolean(), true),
});

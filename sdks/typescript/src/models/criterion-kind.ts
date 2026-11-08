import * as s from "../core/validation/index.js";
import type { EnumSchema } from "../core/validation/schema.js";

export const CriterionKind = {
  Test: "test",
  Build: "build",
  File: "file",
  Visual: "visual",
  Judgment: "judgment",
  Upload: "upload",
} as const;
export type CriterionKind = (typeof CriterionKind)[keyof typeof CriterionKind] | (string & {});

export const criterionKindSchema: EnumSchema<CriterionKind> = s.enumOf<CriterionKind>(CriterionKind);

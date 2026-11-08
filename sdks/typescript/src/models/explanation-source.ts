import * as s from "../core/validation/index.js";
import type { EnumSchema } from "../core/validation/schema.js";

export const ExplanationSource = {
  Model: "model",
  Rules: "rules",
  Stored: "stored",
} as const;
export type ExplanationSource = (typeof ExplanationSource)[keyof typeof ExplanationSource] | (string & {});

export const explanationSourceSchema: EnumSchema<ExplanationSource> =
  s.enumOf<ExplanationSource>(ExplanationSource);

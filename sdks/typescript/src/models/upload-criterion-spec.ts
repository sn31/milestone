import * as s from "../core/validation/index.js";
import type { Schema } from "../core/validation/schema.js";
import { formatSchema, type Format } from "./format.js";
import { patternSchema, type Pattern } from "./unions/pattern.js";

/**
 * spec of a criterion with kind upload. A criterion passes when at least one matching file passes
 * every check.
 */
export type UploadCriterionSpec = {
  /** A glob ("*.pdf", "logo/*.{svg,png}") or an extension list ([".svg", ".png"] or "svg,png") */
  pattern: Pattern;
  /** Checked from magic bytes */
  format?: Format;
  minBytes?: number;
  /** txt, md, docx */
  minWords?: number;
  /** PDF */
  maxPages?: number;
  /** png, jpg, svg */
  minWidth?: number;
  minHeight?: number;
  /** Case-insensitive strings the file text must contain */
  mustContain?: string[];
};

export const uploadCriterionSpecSchema: Schema<UploadCriterionSpec> = s.object<UploadCriterionSpec>({
  pattern: patternSchema,
  format: s.optional(s.lazy(() => formatSchema)),
  minBytes: s.optional(s.int()),
  minWords: s.optional(s.int()),
  maxPages: s.optional(s.int()),
  minWidth: s.optional(s.int()),
  minHeight: s.optional(s.int()),
  mustContain: s.optional(s.array(s.string())),
});

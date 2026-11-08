import * as s from "../../core/validation/index.js";
import type { Schema } from "../../core/validation/schema.js";

/** A glob ("*.pdf", "logo/*.{svg,png}") or an extension list ([".svg", ".png"] or "svg,png") */
export type Pattern = string | string[];

export const patternSchema: Schema<Pattern> = s.of<Pattern>(s.union([s.string(), s.array(s.string())]));

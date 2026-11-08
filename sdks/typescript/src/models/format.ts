import * as s from "../core/validation/index.js";
import type { EnumSchema } from "../core/validation/schema.js";

/** Checked from magic bytes */
export const Format = {
  Pdf: "pdf",
  Png: "png",
  Jpg: "jpg",
  Svg: "svg",
  Docx: "docx",
  Md: "md",
  Txt: "txt",
} as const;
export type Format = (typeof Format)[keyof typeof Format] | (string & {});

export const formatSchema: EnumSchema<Format> = s.enumOf<Format>(Format);

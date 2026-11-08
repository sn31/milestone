import * as s from "../core/validation/index.js";
import type { Schema } from "../core/validation/schema.js";
import { modeSchema, type Mode } from "./mode.js";

export type ApiDevPaypalModeResponse = {
  mode: Mode;
};

export const apiDevPaypalModeResponseSchema: Schema<ApiDevPaypalModeResponse> =
  s.object<ApiDevPaypalModeResponse>({
    mode: modeSchema,
  });

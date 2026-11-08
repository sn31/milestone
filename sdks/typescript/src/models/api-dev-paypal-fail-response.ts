import * as s from "../core/validation/index.js";
import type { Schema } from "../core/validation/schema.js";
import { armedSchema, type Armed } from "./armed.js";

export type ApiDevPaypalFailResponse = {
  armed?: Armed;
};

export const apiDevPaypalFailResponseSchema: Schema<ApiDevPaypalFailResponse> =
  s.object<ApiDevPaypalFailResponse>({
    armed: s.optional(s.lazy(() => armedSchema)),
  });

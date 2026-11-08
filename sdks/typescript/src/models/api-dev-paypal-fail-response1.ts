import * as s from "../core/validation/index.js";
import type { Schema } from "../core/validation/schema.js";
import { armedSchema, type Armed } from "./armed.js";

export type ApiDevPaypalFailResponse1 = {
  armed?: Armed[];
};

export const apiDevPaypalFailResponse1Schema: Schema<ApiDevPaypalFailResponse1> =
  s.object<ApiDevPaypalFailResponse1>({
    armed: s.optional(s.array(s.lazy(() => armedSchema))),
  });

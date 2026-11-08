import * as s from "../core/validation/index.js";
import type { Schema } from "../core/validation/schema.js";

export type ErrorError = {
  error: string;
};

export const errorErrorSchema: Schema<ErrorError> = s.object<ErrorError>({
  error: s.string(),
});

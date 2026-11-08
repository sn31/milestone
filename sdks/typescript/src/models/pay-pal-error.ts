import * as s from "../core/validation/index.js";
import type { Schema } from "../core/validation/schema.js";

export type PayPalError = {
  error: string;
  debugId?: string | null;
};

export const payPalErrorSchema: Schema<PayPalError> = s.object<PayPalError>({
  error: s.string(),
  debugId: s.optionalNullable(s.string()),
});

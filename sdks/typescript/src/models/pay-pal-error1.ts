import * as s from "../core/validation/index.js";
import type { Schema } from "../core/validation/schema.js";

export type PayPalError1 = {
  error: string;
  debugId?: string | null;
};

export const payPalError1Schema: Schema<PayPalError1> = s.object<PayPalError1>({
  error: s.string(),
  debugId: s.optionalNullable(s.string()),
});

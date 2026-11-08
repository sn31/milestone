import * as s from "../core/validation/index.js";
import type { Schema } from "../core/validation/schema.js";

export type ApiAdvancesAccept409Error1 = {
  error: string;
  /** not_eligible, no_paypal_email or no_partner_paypal_email */
  reason?: string;
};

export const apiAdvancesAccept409Error1Schema: Schema<ApiAdvancesAccept409Error1> =
  s.object<ApiAdvancesAccept409Error1>({
    error: s.string(),
    reason: s.optional(s.string()),
  });

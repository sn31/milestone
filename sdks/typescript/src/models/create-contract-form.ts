import * as s from "../core/validation/index.js";
import type { Schema } from "../core/validation/schema.js";

export type CreateContractForm = {
  /** Plain-English scope */
  scope: string;
  /** Optional; defaults to the compiled title */
  title?: string;
  /** @default "USD" */
  currency?: string;
  /** Total in major units, for example 300.00 */
  total: number;
  /** owner/name of the delivery repository */
  repo?: string;
};

export const createContractFormSchema: Schema<CreateContractForm> = s.object<CreateContractForm>({
  scope: s.string(),
  title: s.optional(s.string()),
  currency: s.defaulted(s.string(), "USD"),
  total: s.float64(),
  repo: s.optional(s.string()),
});

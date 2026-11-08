import * as s from "../core/validation/index.js";
import type { Schema } from "../core/validation/schema.js";

export type ApiDisputesAcceptRequest = {
  /** @default "True" */
  confirm?: "True";
  note?: string;
};

export const apiDisputesAcceptRequestSchema: Schema<ApiDisputesAcceptRequest> =
  s.object<ApiDisputesAcceptRequest>({
    confirm: s.defaulted(s.literal("True"), "True"),
    note: s.optional(s.string()),
  });

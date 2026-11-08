import * as s from "../core/validation/index.js";
import type { Schema } from "../core/validation/schema.js";

export type ApiWebhooksPaypalResponse = {
  ok?: boolean;
  duplicate?: boolean;
  /** funded, already, pending, mismatch, rejected, enqueued, stored or ignored */
  outcome?: string;
};

export const apiWebhooksPaypalResponseSchema: Schema<ApiWebhooksPaypalResponse> =
  s.object<ApiWebhooksPaypalResponse>({
    ok: s.optional(s.boolean()),
    duplicate: s.optional(s.boolean()),
    outcome: s.optional(s.string()),
  });

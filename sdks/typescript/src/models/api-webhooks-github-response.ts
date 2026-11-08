import * as s from "../core/validation/index.js";
import type { Schema } from "../core/validation/schema.js";

export type ApiWebhooksGithubResponse = {
  ok?: boolean;
  duplicate?: boolean;
  ignored?: boolean;
  milestoneId?: string;
  deliveryId?: string;
};

export const apiWebhooksGithubResponseSchema: Schema<ApiWebhooksGithubResponse> =
  s.object<ApiWebhooksGithubResponse>({
    ok: s.optional(s.boolean()),
    duplicate: s.optional(s.boolean()),
    ignored: s.optional(s.boolean()),
    milestoneId: s.optional(s.string()),
    deliveryId: s.optional(s.string()),
  });

import * as s from "../core/validation/index.js";
import type { Schema } from "../core/validation/schema.js";

export type ApiOpsResolveResponse = {
  ok?: boolean;
};

export const apiOpsResolveResponseSchema: Schema<ApiOpsResolveResponse> = s.object<ApiOpsResolveResponse>({
  ok: s.optional(s.boolean()),
});

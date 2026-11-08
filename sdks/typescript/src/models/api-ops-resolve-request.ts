import * as s from "../core/validation/index.js";
import type { Schema } from "../core/validation/schema.js";

export type ApiOpsResolveRequest = {
  note: string;
};

export const apiOpsResolveRequestSchema: Schema<ApiOpsResolveRequest> = s.object<ApiOpsResolveRequest>({
  note: s.string(),
});

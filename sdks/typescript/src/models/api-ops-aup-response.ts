import * as s from "../core/validation/index.js";
import type { Schema } from "../core/validation/schema.js";
import { status2Schema, type Status2 } from "./status2.js";

export type ApiOpsAupResponse = {
  ok?: boolean;
  status?: Status2;
};

export const apiOpsAupResponseSchema: Schema<ApiOpsAupResponse> = s.object<ApiOpsAupResponse>({
  ok: s.optional(s.boolean()),
  status: s.optional(s.lazy(() => status2Schema)),
});

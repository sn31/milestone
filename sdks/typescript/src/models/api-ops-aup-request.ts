import * as s from "../core/validation/index.js";
import type { Schema } from "../core/validation/schema.js";
import { action2Schema, type Action2 } from "./action2.js";

export type ApiOpsAupRequest = {
  action: Action2;
  note: string;
};

export const apiOpsAupRequestSchema: Schema<ApiOpsAupRequest> = s.object<ApiOpsAupRequest>({
  action: action2Schema,
  note: s.string(),
});

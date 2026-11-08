import * as s from "../core/validation/index.js";
import type { Schema } from "../core/validation/schema.js";
import { advanceViewSchema, type AdvanceView } from "./advance-view.js";

export type AdvanceAcceptResponse = {
  advance: AdvanceView;
  created: boolean;
  /** Whether the advance job was queued by this call */
  queued: boolean;
};

export const advanceAcceptResponseSchema: Schema<AdvanceAcceptResponse> = s.object<AdvanceAcceptResponse>({
  advance: advanceViewSchema,
  created: s.boolean(),
  queued: s.boolean(),
});

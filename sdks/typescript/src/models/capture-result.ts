import * as s from "../core/validation/index.js";
import type { Schema } from "../core/validation/schema.js";
import { milestoneStatusSchema, type MilestoneStatus } from "./milestone-status.js";

export type CaptureResult = {
  status: MilestoneStatus;
  captureId?: string | null;
  captureStatus?: string;
};

export const captureResultSchema: Schema<CaptureResult> = s.object<CaptureResult>({
  status: milestoneStatusSchema,
  captureId: s.optionalNullable(s.string()),
  captureStatus: s.optional(s.string()),
});

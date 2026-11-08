import * as s from "../core/validation/index.js";
import type { EnumSchema } from "../core/validation/schema.js";

export const MilestoneStatus = {
  Draft: "draft",
  Funded: "funded",
  Verifying: "verifying",
  Review: "review",
  Released: "released",
  Held: "held",
  NeedsClient: "needs_client",
  PartialReleased: "partial_released",
} as const;
export type MilestoneStatus = (typeof MilestoneStatus)[keyof typeof MilestoneStatus] | (string & {});

export const milestoneStatusSchema: EnumSchema<MilestoneStatus> = s.enumOf<MilestoneStatus>(MilestoneStatus);

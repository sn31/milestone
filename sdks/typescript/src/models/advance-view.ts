import * as s from "../core/validation/index.js";
import type { Schema } from "../core/validation/schema.js";
import { statusSchema, type Status } from "./status.js";

export type AdvanceView = {
  id: string;
  status: Status;
  principalMinor: number;
  feeBpsPerDay: number;
  feeMinor: number;
  /** Principal plus the quoted fee, deducted from the release */
  repaymentMinor: number;
  fundedAt: Date | null;
  repaidAt: Date | null;
  explanation: string | null;
};

export const advanceViewSchema: Schema<AdvanceView> = s.object<AdvanceView>({
  id: s.string(),
  status: statusSchema,
  principalMinor: s.int(),
  feeBpsPerDay: s.float64(),
  feeMinor: s.int(),
  repaymentMinor: s.int(),
  fundedAt: s.nullable(s.dateTime()),
  repaidAt: s.nullable(s.dateTime()),
  explanation: s.nullable(s.string()),
});

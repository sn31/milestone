import * as s from "../core/validation/index.js";
import type { Schema } from "../core/validation/schema.js";
import { status1Schema, type Status1 } from "./status1.js";

export type CriterionVerdict = {
  criterionId: string;
  status: Status1;
  confidence: number;
  evidenceIds: string[];
  rationale: string;
};

export const criterionVerdictSchema: Schema<CriterionVerdict> = s.object<CriterionVerdict>({
  criterionId: s.string(),
  status: status1Schema,
  confidence: s.float64(),
  evidenceIds: s.array(s.string()),
  rationale: s.string(),
  _keysMap: {
    criterionId: "criterion_id",
    evidenceIds: "evidence_ids",
  },
});

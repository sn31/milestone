import * as s from "../core/validation/index.js";
import type { Schema } from "../core/validation/schema.js";
import { advanceTermsSchema, type AdvanceTerms } from "./advance-terms.js";
import { advanceViewSchema, type AdvanceView } from "./advance-view.js";
import { explanationSourceSchema, type ExplanationSource } from "./explanation-source.js";

export type AdvanceOfferResponse = {
  milestoneId: string;
  currency: string;
  amountMinor: number;
  advance: AdvanceView | null;
  /** Includes eligible (boolean) and, when not eligible, reason */
  offer: Record<string, unknown>;
  terms: AdvanceTerms | null;
  explanation: string;
  explanationSource: ExplanationSource;
};

export const advanceOfferResponseSchema: Schema<AdvanceOfferResponse> = s.object<AdvanceOfferResponse>({
  milestoneId: s.string(),
  currency: s.string(),
  amountMinor: s.int(),
  advance: s.nullable(s.lazy(() => advanceViewSchema)),
  offer: s.record(s.string(), s.unknown()),
  terms: s.nullable(s.lazy(() => advanceTermsSchema)),
  explanation: s.string(),
  explanationSource: explanationSourceSchema,
});

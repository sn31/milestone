import * as s from "../core/validation/index.js";
import type { Schema } from "../core/validation/schema.js";

export type ApiDisputesSubmitRequest = {
  text: string;
};

export const apiDisputesSubmitRequestSchema: Schema<ApiDisputesSubmitRequest> =
  s.object<ApiDisputesSubmitRequest>({
    text: s.string(),
  });

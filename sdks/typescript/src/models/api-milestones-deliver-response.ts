import * as s from "../core/validation/index.js";
import type { Schema } from "../core/validation/schema.js";

export type ApiMilestonesDeliverResponse = {
  ok: boolean;
  deliveryId: string;
  /** 40-character commit id */
  sha: string;
  duplicate: boolean;
};

export const apiMilestonesDeliverResponseSchema: Schema<ApiMilestonesDeliverResponse> =
  s.object<ApiMilestonesDeliverResponse>({
    ok: s.boolean(),
    deliveryId: s.string(),
    sha: s.string(),
    duplicate: s.boolean(),
  });

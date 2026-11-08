import * as s from "../core/validation/index.js";
import type { Schema } from "../core/validation/schema.js";

export type Armed = {
  senderItemId?: string;
  reason?: string;
};

export const armedSchema: Schema<Armed> = s.object<Armed>({
  senderItemId: s.optional(s.string()),
  reason: s.optional(s.string()),
});

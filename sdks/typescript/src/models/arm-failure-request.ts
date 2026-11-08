import * as s from "../core/validation/index.js";
import type { Schema } from "../core/validation/schema.js";
import { Party, partySchema } from "./party.js";

/** Either sender_item_id, or milestoneId with an optional party. */
export type ArmFailureRequest = {
  senderItemId?: string;
  milestoneId?: string;
  /** @default Party.Freelancer */
  party?: Party;
  /** A PayPal error name @default "RECEIVER_ACCOUNT_LOCKED" */
  reason?: string;
};

export const armFailureRequestSchema: Schema<ArmFailureRequest> = s.object<ArmFailureRequest>({
  senderItemId: s.optional(s.string()),
  milestoneId: s.optional(s.string()),
  party: s.defaulted(partySchema, Party.Freelancer),
  reason: s.defaulted(s.string(), "RECEIVER_ACCOUNT_LOCKED"),
  _keysMap: {
    senderItemId: "sender_item_id",
  },
});

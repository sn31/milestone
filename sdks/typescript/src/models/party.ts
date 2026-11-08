import * as s from "../core/validation/index.js";
import type { EnumSchema } from "../core/validation/schema.js";

export const Party = {
  Freelancer: "freelancer",
  Partner: "partner",
} as const;
export type Party = (typeof Party)[keyof typeof Party] | (string & {});

export const partySchema: EnumSchema<Party> = s.enumOf<Party>(Party);

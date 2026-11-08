import * as s from "../core/validation/index.js";
import type { Schema } from "../core/validation/schema.js";

export type Head = {
  ref?: string;
};

export const headSchema: Schema<Head> = s.object<Head>({
  ref: s.optional(s.string()),
});

import * as s from "../core/validation/index.js";
import type { Schema } from "../core/validation/schema.js";

export type Base = {
  sha?: string | null;
};

export const baseSchema: Schema<Base> = s.object<Base>({
  sha: s.optionalNullable(s.string()),
});

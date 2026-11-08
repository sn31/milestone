import * as s from "../core/validation/index.js";
import type { Schema } from "../core/validation/schema.js";

export type Repository = {
  fullName?: string;
  cloneUrl?: string;
};

export const repositorySchema: Schema<Repository> = s.object<Repository>({
  fullName: s.optional(s.string()),
  cloneUrl: s.optional(s.string()),
  _keysMap: {
    fullName: "full_name",
    cloneUrl: "clone_url",
  },
});

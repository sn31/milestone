import * as s from "../core/validation/index.js";
import type { Schema } from "../core/validation/schema.js";
import { baseSchema, type Base } from "./base.js";
import { headSchema, type Head } from "./head.js";

export type PullRequest = {
  number?: number;
  merged?: boolean;
  mergeCommitSha?: string | null;
  title?: string | null;
  body?: string | null;
  head?: Head;
  base?: Base;
};

export const pullRequestSchema: Schema<PullRequest> = s.object<PullRequest>({
  number: s.optional(s.int()),
  merged: s.optional(s.boolean()),
  mergeCommitSha: s.optionalNullable(s.string()),
  title: s.optionalNullable(s.string()),
  body: s.optionalNullable(s.string()),
  head: s.optional(s.lazy(() => headSchema)),
  base: s.optional(s.lazy(() => baseSchema)),
  _keysMap: {
    mergeCommitSha: "merge_commit_sha",
  },
});

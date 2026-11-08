import * as s from "../core/validation/index.js";
import type { Schema } from "../core/validation/schema.js";
import { pullRequestSchema, type PullRequest } from "./pull-request.js";
import { repositorySchema, type Repository } from "./repository.js";

export type GitHubPullRequestEvent = {
  action?: string;
  pullRequest?: PullRequest;
  repository?: Repository;
};

export const gitHubPullRequestEventSchema: Schema<GitHubPullRequestEvent> = s.object<GitHubPullRequestEvent>({
  action: s.optional(s.string()),
  pullRequest: s.optional(s.lazy(() => pullRequestSchema)),
  repository: s.optional(s.lazy(() => repositorySchema)),
  _keysMap: {
    pullRequest: "pull_request",
  },
});

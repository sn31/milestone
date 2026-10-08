/**
 * PR comments with the verdict. Plain fetch against the GitHub REST API; no-op without GITHUB_TOKEN.
 * Idempotent: the body carries a hidden marker and an existing comment with the same marker is left alone.
 */
import type { PolicyDecision, VerdictOutput, VerdictResult } from "@milestone/core";

const API = "https://api.github.com";
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export interface PostCommentInput {
  repoFullName: string;
  prNumber: number;
  body: string;
  /** Defaults to process.env.GITHUB_TOKEN. */
  token?: string;
  fetch?: typeof fetch;
}

export type PostCommentResult = { posted: true; url: string | null } | { posted: false; reason: "no_token" | "already_posted" };

export function commentMarker(key: string): string {
  return `<!-- milestone-verdict:${key.replace(/[^\w.:-]/g, "")} -->`;
}

export async function postVerdictComment(input: PostCommentInput): Promise<PostCommentResult> {
  const token = input.token ?? process.env.GITHUB_TOKEN;
  if (!token) return { posted: false, reason: "no_token" };
  if (!REPO.test(input.repoFullName)) throw new Error(`bad repository name: ${input.repoFullName}`);
  if (!Number.isInteger(input.prNumber) || input.prNumber <= 0) throw new Error(`bad pull request number: ${input.prNumber}`);
  const f = input.fetch ?? fetch;
  const url = `${API}/repos/${input.repoFullName}/issues/${input.prNumber}/comments`;
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "milestone-verifier",
  };

  const marker = /<!-- milestone-verdict:[^>]*-->/.exec(input.body)?.[0];
  if (marker) {
    const list = await f(`${url}?per_page=100`, { headers });
    if (list.ok) {
      const existing = (await list.json()) as Array<{ body?: string }>;
      if (existing.some((c) => c.body?.includes(marker))) return { posted: false, reason: "already_posted" };
    }
  }

  const res = await f(url, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ body: input.body }) });
  if (!res.ok) throw new Error(`GitHub comment failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  const json = (await res.json()) as { html_url?: string };
  return { posted: true, url: json.html_url ?? null };
}

export interface VerdictCommentInput {
  /** Used for the idempotency marker, normally the delivery id. */
  key: string;
  result: VerdictResult;
  verdict: VerdictOutput;
  decision: Pick<PolicyDecision, "action" | "ruleIds" | "reason">;
  title?: string;
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

export function formatVerdictComment(input: VerdictCommentInput): string {
  const lines = [
    commentMarker(input.key),
    `### Milestone verification: ${input.result}${input.title ? ` (${oneLine(input.title)})` : ""}`,
    "",
    ...input.verdict.criteria.map((c) => `- ${c.status} ${c.criterion_id}: ${oneLine(c.rationale) || "no rationale"} (${c.evidence_ids.length ? c.evidence_ids.join(", ") : "no evidence"})`),
    "",
  ];
  if (input.verdict.suspected_injection) lines.push("Suspected prompt injection in the delivery text; a person has to look at this one.", "");
  lines.push(`Policy decision: ${input.decision.action} (${input.decision.ruleIds.join(", ")}). ${oneLine(input.decision.reason)}`);
  return lines.join("\n");
}

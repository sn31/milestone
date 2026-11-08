import { tmpdir } from "node:os";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { demoModeOn, paypalMode } from "@milestone/core";
import { run } from "@milestone/verify";

const SHA = /^[0-9a-f]{40}$/;
/** Branch, tag or HEAD; no option-looking or revision-expression syntax. */
const REF = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,200}$/;

/**
 * Accepts an https URL, a file:// URL or an absolute local path, and returns the URL git should use (local paths
 * become file:// URLs). Anything else (ssh, git://, ext::, relative paths, credentials in the URL) is refused.
 */
export function normaliseRepoUrl(input: string): string | null {
  const s = input.trim();
  if (!s || s.length > 500 || /[\s\0]/.test(s)) return null;
  if (isAbsolute(s)) return pathToFileURL(s).href;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol === "file:") return u.href;
  if (u.protocol === "https:" && !u.username && !u.password && u.hostname) return u.href;
  return null;
}

export const LOCAL_REPO_REFUSED = "local repositories are not accepted";

/**
 * Whether this process may clone local repositories (file:// URLs and absolute paths) on a freelancer's say-so.
 * A local path makes the worker clone any repository on the host, so it is only allowed when MILESTONE_ALLOW_LOCAL_REPOS
 * is "1", or outside production while PayPal is simulated (a local run), and never with
 * DEMO_MODE=1 (the hosted demo accepts its one https repository only; see checkDemoRepo in @milestone/core).
 */
export function localReposAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  if (demoModeOn(env)) return false;
  if (env.MILESTONE_ALLOW_LOCAL_REPOS?.trim() === "1") return true;
  return env.NODE_ENV !== "production" && paypalMode(env) === "simulated";
}

export type RepoUrlCheck = { ok: true; url: string } | { ok: false; reason: string };

/**
 * normaliseRepoUrl plus the local-repository gate: https always passes; file:// and absolute paths only when
 * localReposAllowed(env). The reason is the 400 message the route returns.
 */
export function checkRepoUrl(input: string, env: NodeJS.ProcessEnv = process.env): RepoUrlCheck {
  const url = normaliseRepoUrl(input);
  if (!url) return { ok: false, reason: "repoUrl must be an https URL, a file:// URL or an absolute local path" };
  if (url.startsWith("file:") && !localReposAllowed(env)) return { ok: false, reason: LOCAL_REPO_REFUSED };
  return { ok: true, url };
}

export function validRef(ref: string): boolean {
  return SHA.test(ref) || REF.test(ref);
}

/** Picks the commit for `ref` from `git ls-remote` output: exact name, branch, peeled tag, then tag. */
export function pickSha(lsRemote: string, ref: string): string | null {
  const rows = new Map<string, string>();
  for (const line of lsRemote.split("\n")) {
    const [sha, name] = line.trim().split(/\s+/);
    if (sha && name && SHA.test(sha)) rows.set(name, sha);
  }
  for (const name of [ref, `refs/heads/${ref}`, `refs/tags/${ref}^{}`, `refs/tags/${ref}`]) {
    const sha = rows.get(name);
    if (sha) return sha;
  }
  return null;
}

/** Names only the repository's owner can point: the default branch, branches and tags (not refs/pull/*, refs/changes/*...). */
const TIP_NAME = /^(?:HEAD|refs\/heads\/.+|refs\/tags\/.+)$/;

/**
 * pickSha restricted to branch and tag tips, for DEMO_MODE. Anyone can open a pull request against a public GitHub
 * repository, and its head is then served by that repository (refs/pull/N/head, and fork-network commits by id), so
 * the demo lock's "this repository only" would otherwise admit a stranger's code. A commit id is accepted only when it
 * is the tip of a branch or tag (or HEAD).
 */
export function pickTipSha(lsRemote: string, ref: string): string | null {
  const tips = lsRemote
    .split("\n")
    .filter((line) => TIP_NAME.test(line.trim().split(/\s+/)[1] ?? ""))
    .join("\n");
  if (SHA.test(ref)) return tips.split("\n").some((line) => line.trim().split(/\s+/)[0] === ref) ? ref : null;
  return pickSha(tips, ref);
}

const GIT_ENV = { PATH: process.env.PATH ?? "", HOME: tmpdir(), GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "/bin/false" };

/**
 * Resolves `ref` in the repository to a 40-hex commit id with `git ls-remote`. A full sha is accepted as given once
 * the repository answers (ls-remote cannot list arbitrary commits; the verifier's fetch fails if it is not there).
 * With `tipsOnly` (DEMO_MODE) the commit must be the tip of a branch or tag the repository advertises; see pickTipSha.
 */
export async function resolveRef(repoUrl: string, ref: string, opts: { tipsOnly?: boolean } = {}): Promise<{ ok: true; sha: string } | { ok: false; error: string }> {
  // Only the transports normaliseRepoUrl allows, even through redirects or submodule-style indirection.
  const cmd = ["git", "-c", "protocol.allow=never", "-c", "protocol.https.allow=always", "-c", "protocol.file.allow=always", "ls-remote", "--", repoUrl];
  // ls-remote patterns match whole trailing path components, so an annotated tag's peeled commit needs its own pattern.
  if (!SHA.test(ref)) cmd.push(ref, `${ref}^{}`);
  const r = await run(cmd, tmpdir(), GIT_ENV, 20_000);
  if (r.code !== 0) return { ok: false, error: `git ls-remote failed${r.timedOut ? " (timed out)" : ""}: ${r.output.split("\n").slice(-3).join(" ").trim().slice(0, 300)}` };
  if (opts.tipsOnly) {
    const tip = pickTipSha(r.output, ref);
    return tip ? { ok: true, sha: tip } : { ok: false, error: `ref ${ref} is not a branch, tag or HEAD of the repository (this demo accepts only branch and tag tips)` };
  }
  if (SHA.test(ref)) return { ok: true, sha: ref };
  const sha = pickSha(r.output, ref);
  if (!sha || !SHA.test(sha)) return { ok: false, error: `ref ${ref} not found in the repository` };
  return { ok: true, sha };
}

/** Same id scheme as the GitHub webhook (same milestone + same commit = same delivery); lives in @milestone/core. */
export { commitDeliveryId } from "@milestone/core";

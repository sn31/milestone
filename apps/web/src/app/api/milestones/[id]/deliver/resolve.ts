import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
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

const GIT_ENV = { PATH: process.env.PATH ?? "", HOME: tmpdir(), GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "/bin/false" };

/**
 * Resolves `ref` in the repository to a 40-hex commit id with `git ls-remote`. A full sha is accepted as given once
 * the repository answers (ls-remote cannot list arbitrary commits; the verifier's fetch fails if it is not there).
 */
export async function resolveRef(repoUrl: string, ref: string): Promise<{ ok: true; sha: string } | { ok: false; error: string }> {
  // Only the transports normaliseRepoUrl allows, even through redirects or submodule-style indirection.
  const cmd = ["git", "-c", "protocol.allow=never", "-c", "protocol.https.allow=always", "-c", "protocol.file.allow=always", "ls-remote", "--", repoUrl];
  // ls-remote patterns match whole trailing path components, so an annotated tag's peeled commit needs its own pattern.
  if (!SHA.test(ref)) cmd.push(ref, `${ref}^{}`);
  const r = await run(cmd, tmpdir(), GIT_ENV, 20_000);
  if (r.code !== 0) return { ok: false, error: `git ls-remote failed${r.timedOut ? " (timed out)" : ""}: ${r.output.split("\n").slice(-3).join(" ").trim().slice(0, 300)}` };
  if (SHA.test(ref)) return { ok: true, sha: ref };
  const sha = pickSha(r.output, ref);
  if (!sha || !SHA.test(sha)) return { ok: false, error: `ref ${ref} not found in the repository` };
  return { ok: true, sha };
}

/** Same id scheme as the GitHub webhook: same milestone + same commit = same delivery. */
export function commitDeliveryId(milestoneId: string, sha: string): string {
  return `dlv_${createHash("sha256").update(`${milestoneId}:${sha}`).digest("hex").slice(0, 24)}`;
}

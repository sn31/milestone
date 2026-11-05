/**
 * The hosted demo's repository lock. Delivered code runs on the worker host without a sandbox (CLAUDE.md, known
 * limitation), so with DEMO_MODE=1 code deliveries are accepted only from one repository: DEMO_REPO_URL. The web
 * routes (manual deliver, MCP deliver, GitHub webhook) refuse anything else before a job is queued, and the worker
 * checks again before it clones. Upload deliveries are files, not code, and are not affected.
 */

export const DEMO_REPO_REFUSED = "demo_repo_only";

/** Demo mode is on only when DEMO_MODE is exactly "1" (render.yaml sets it on the hosted demo). */
export function demoModeOn(env: Record<string, string | undefined> = process.env): boolean {
  return env.DEMO_MODE?.trim() === "1";
}

/**
 * Raw shape accepted before parsing: https, an ASCII host name, then one or more path segments of letters, digits,
 * "_", "." and "-", with an optional trailing slash. No userinfo, port, query, fragment, percent-encoding, backslash
 * or empty segment can pass, so nothing the URL parser would silently rewrite (dot segments, `%2e`, `\`) gets through.
 */
const RAW = /^https:\/\/([A-Za-z0-9.-]{1,253})((?:\/[A-Za-z0-9_.-]{1,100}){1,10})\/?$/;

/**
 * A repository URL in canonical form for comparison, or null when it is not one this check understands:
 * `https://<lowercase host>/<path>` without `.git` or a trailing slash. On github.com the path must be exactly
 * owner/repo and is lowercased (GitHub names are case-insensitive). Dot segments ("." or "..") are refused.
 */
export function canonicalRepoUrl(input: string): string | null {
  const s = input.trim();
  const m = RAW.exec(s);
  if (!m) return null;
  const host = m[1]!.toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(host)) return null;
  const segments = m[2]!.slice(1).split("/");
  if (segments.some((seg) => seg === "." || seg === "..")) return null;
  const last = segments.length - 1;
  if (segments[last]!.toLowerCase().endsWith(".git")) segments[last] = segments[last]!.slice(0, -4);
  if (!segments[last] || segments[last] === "." || segments[last] === "..") return null;
  if (host === "github.com") {
    if (segments.length !== 2) return null;
    return `https://github.com/${segments.map((seg) => seg.toLowerCase()).join("/")}`;
  }
  return `https://${host}/${segments.join("/")}`;
}

export type DemoRepoCheck = { ok: true } | { ok: false; reason: string; code: typeof DEMO_REPO_REFUSED };

/**
 * Whether a code delivery from `repoUrl` may proceed. Outside DEMO_MODE always. In DEMO_MODE only when DEMO_REPO_URL
 * is a valid https repository URL and `repoUrl` names the same repository (canonicalRepoUrl on both sides). With
 * DEMO_REPO_URL unset or invalid every code delivery is refused (fail closed). `reason` is the message shown to the
 * freelancer; it never echoes the refused URL back.
 */
export function checkDemoRepo(repoUrl: string, env: Record<string, string | undefined> = process.env): DemoRepoCheck {
  if (!demoModeOn(env)) return { ok: true };
  const configured = env.DEMO_REPO_URL?.trim();
  const refuse = (reason: string): DemoRepoCheck => ({ ok: false, reason, code: DEMO_REPO_REFUSED });
  if (!configured) return refuse("this demo host accepts no code deliveries: DEMO_REPO_URL is not set (file uploads still work)");
  const allowed = canonicalRepoUrl(configured);
  if (!allowed) return refuse("this demo host accepts no code deliveries: DEMO_REPO_URL is not a valid https repository URL (file uploads still work)");
  const given = canonicalRepoUrl(repoUrl);
  if (given === null || given !== allowed) return refuse(`this demo only accepts code deliveries from ${allowed} (file uploads still work)`);
  return { ok: true };
}

/**
 * DEMO_REPO_URL as the owner wrote it (host lowercased, no `.git` or trailing slash), or null when it is unset or not a
 * valid https repository URL. The seed and the deliver form suggest it; case is kept so a github.com owner/repo still
 * matches the `repository.full_name` GitHub sends in webhooks.
 */
export function demoRepoUrl(env: Record<string, string | undefined> = process.env): string | null {
  const v = env.DEMO_REPO_URL?.trim();
  if (!v || !canonicalRepoUrl(v)) return null;
  const m = RAW.exec(v)!;
  const path = m[2]!.replace(/\.git$/i, "");
  return `https://${m[1]!.toLowerCase()}${path}`;
}

/** "owner/repo" when DEMO_REPO_URL is a github.com repository (the contract's repoFullName), else null. */
export function demoRepoFullName(env: Record<string, string | undefined> = process.env): string | null {
  const url = demoRepoUrl(env);
  const m = url ? /^https:\/\/github\.com\/([^/]+\/[^/]+)$/.exec(url) : null;
  return m ? m[1]! : null;
}

/** The deliver form's repository suggestion: DEMO_REPO_URL when it is set and valid, else the contract's GitHub repository. */
export function suggestedRepoUrl(repoFullName: string | null, env: Record<string, string | undefined> = process.env): string | null {
  const demo = demoRepoUrl(env);
  if (demo) return `${demo}.git`;
  return repoFullName ? `https://github.com/${repoFullName}.git` : null;
}

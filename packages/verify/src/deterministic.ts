/**
 * Deterministic stage, no model: check out the merge commit in a throwaway directory with no secrets
 * in its environment, run build and test commands with a time limit, check required files.
 *
 * Tamper check: the delivery is written by the payee, so a passing `npm test` only means something when the
 * delivery did not change what `npm test` runs. Before running commands we diff the delivered commit against a
 * baseline: the default branch head recorded when the milestone was funded, else the pull request's base, and
 * only when neither is known the commit's first parent (which misses earlier merges and rebase-merged commits, and
 * the evidence says so). A baseline that cannot be fetched fails closed. If the delivery modifies or deletes
 * package.json scripts or dependency fields, existing tests or CI config, or touches lockfiles, node_modules,
 * test-runner or package-manager config, a passing test/build result is recorded as "unclear" (a failing one still
 * fails: tampering can only fake a pass). Other added files (new tests, new source) are fine.
 *
 * Commands run with lifecycle scripts disabled (npm_config_ignore_scripts) and with every committed node_modules
 * and .bin directory removed first, so a committed node_modules/.bin/node cannot shadow the real one.
 *
 * Context evidence for judgment criteria (no status, never decides anything): evd_diff (the diff against the same
 * commit the tamper check used: file list with +/- counts and the start of the patch), evd_tree (the delivered
 * commit's file list) and evd_commit (commit message, PR title and body; untrusted text). The judge cites these.
 *
 * Every evidence summary, log and error message has the throwaway workdir prefix stripped (stripRoots, applied once
 * through scrubEvidence): both parties see the summaries, and a worker temp path (/private/var/folders/...) means
 * nothing to them.
 *
 * npm's cache (npm_config_cache) is a persistent worker directory, MILESTONE_NPM_CACHE or <repo>/var/npm-cache, so
 * setup does not download every dependency again for each verification. HOME stays the throwaway workdir.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { access, mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import type { CriterionSpec, EvidenceSummary } from "@milestone/core";
import { repoPath } from "./paths.ts";

export interface DeterministicInput {
  repoUrl: string;
  sha: string;
  criteria: CriterionSpec[];
  timeoutMs?: number;
  /** e.g. ["npm", "ci", "--ignore-scripts"]; run once before the criteria. */
  setup?: string[][];
  /**
   * The commit the tamper check compares the delivery against (default branch head at funding, or the PR base).
   * null/undefined falls back to the first parent. A baseline that cannot be fetched makes passes unclear.
   */
  baselineSha?: string | null;
  /** Where baselineSha came from, for the evidence summary, e.g. "funding" or "pull request base". */
  baselineSource?: string;
  /** The pull request title and body, or a manual delivery's title and note (untrusted); recorded with the commit message as evd_commit. */
  pullRequest?: { title?: string; body?: string };
}

export interface DeterministicOutput {
  evidence: EvidenceSummary[];
  logs: Record<string, string>;
  workdir: string;
  /** What the tamper check found; empty when the delivery leaves the test machinery alone. */
  tampering: string[];
  /** The commit the delivery was diffed against (fetched into workdir), or null when no diff could be made. */
  baseline: string | null;
}

/** npm's cache for setup commands: MILESTONE_NPM_CACHE (absolute, or relative to the repo root), default <repo>/var/npm-cache. */
export function npmCacheDir(env: string | undefined = process.env.MILESTONE_NPM_CACHE, cwd = process.cwd()): string {
  return repoPath(env, "var/npm-cache", cwd);
}

/**
 * No secrets; lifecycle scripts (preinstall, pretest, ...) never run, for setup and criteria commands alike. HOME is
 * set to the workdir per run; the npm cache persists across runs (see the header).
 */
const CLEAN_ENV = { PATH: process.env.PATH ?? "", CI: "1", NODE_ENV: "test", HOME: "", npm_config_ignore_scripts: "true", npm_config_cache: npmCacheDir() };
const COMMIT_ID = /^[0-9a-f]{7,64}$/i;

export const TAMPER_EVIDENCE_ID = "evd_tamper_check";
/** Context evidence the judge may cite for judgment criteria (see the header). */
export const DIFF_EVIDENCE_ID = "evd_diff";
export const TREE_EVIDENCE_ID = "evd_tree";
export const COMMIT_EVIDENCE_ID = "evd_commit";
/** evd_diff carries this much of the patch; evd_tree at most this many paths. */
export const DIFF_EXCERPT_CHARS = 2_000;
export const TREE_MAX_ENTRIES = 200;
const COMMIT_TEXT_MAX = 2_000;

// ---------- Tamper check (pure part, unit-tested) ----------

export interface FileChange {
  /** git --name-status letter: A, M, D, T, ... (renames are disabled, so a rename is D + A). */
  status: string;
  path: string;
  /** package.json only: the file's text in the parent and in the delivery (null when absent). */
  before?: string | null;
  after?: string | null;
}

// Conventional locations, including a single suite file such as ms's root tests.js. Files a package.json script names are
// tests too (scriptTestMatcher), whatever they are called.
const TEST_PATHS = [/(^|\/)(test|tests|__tests__|spec)\//i, /\.(test|spec)\.[cm]?[jt]sx?$/i, /(^|\/)(tests?|spec)\.[cm]?[jt]sx?$/i, /(^|\/)__snapshots__\//i];
const CI_PATHS = [/^\.github\/(workflows|actions)\//, /^\.gitlab-ci\.ya?ml$/, /^\.circleci\//, /^\.travis\.ya?ml$/, /^azure-pipelines\.ya?ml$/, /^Jenkinsfile$/, /^\.buildkite\//, /^bitbucket-pipelines\.ya?ml$/];
/** Config that changes what a test command does even when it is only added (e.g. an .npmrc with script-shell). */
const RUNNER_CONFIG = [
  /(^|\/)(vitest|vite|jest|playwright|karma|cypress|ava|mocha)\.config\.[cm]?[jt]s(on)?$/i,
  /(^|\/)\.mocharc(\.[a-z]+)?$/i,
  /(^|\/)(\.npmrc|\.yarnrc|\.yarnrc\.yml|\.pnpmfile\.cjs|bunfig\.toml)$/i,
  // transforms and module resolution can rewrite what a test does
  /(^|\/)(babel\.config\.[cm]?[jt]s(on)?|\.babelrc(\.[a-z]+)?|\.swcrc|tsconfig[^/]*\.json)$/i,
];
/** package.json keys that decide what test and build commands run, including what gets installed. */
const MANIFEST_KEYS = [
  "scripts", "jest", "mocha", "ava",
  "dependencies", "devDependencies", "optionalDependencies", "peerDependencies",
  "overrides", "resolutions", "pnpm", "workspaces", "bin", "engines", "packageManager",
  "imports", "exports", "main", "type",
] as const;
/** Lockfiles decide which dependency code runs; any change to one is flagged. */
const LOCKFILES = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb|bun\.lock)$/i;
/** Committed dependencies (node_modules/.bin is first on PATH under npm run); flagged in any form. */
// Case-insensitive: on APFS and NTFS "Node_Modules/.BIN/node" shadows the real binary too.
const NODE_MODULES = /(^|\/)node_modules\//i;

export const isTestPath = (p: string) => TEST_PATHS.some((r) => r.test(p));
export const isCiPath = (p: string) => CI_PATHS.some((r) => r.test(p));
const isRunnerConfig = (p: string) => RUNNER_CONFIG.some((r) => r.test(p));
const isManifest = (p: string) => /(^|\/)package\.json$/i.test(p);

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "undefined";
}

/** Which test-relevant keys differ between two package.json texts; unparseable text counts as changed. */
export function manifestChanges(before: string | null | undefined, after: string | null | undefined): string[] {
  if ((before ?? null) === (after ?? null)) return [];
  const parse = (t: string | null | undefined): Record<string, unknown> | null => {
    if (t === null || t === undefined) return {};
    try {
      const v = JSON.parse(t) as unknown;
      return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };
  const a = parse(before);
  const b = parse(after);
  if (!a || !b) return ["unparseable"];
  return MANIFEST_KEYS.filter((k) => canonical(a[k]) !== canonical(b[k]));
}

const VERB: Record<string, string> = { A: "added", M: "modified", D: "deleted", T: "type changed" };

/** One human-readable line per change that could fake a passing test or build; empty means clean. */
/**
 * Files and folders the baseline's package.json scripts point at (e.g. "mocha tests.js", "node --test spec/", "tape test/*.js").
 * Editing any of them changes what the test command runs, so they count as existing tests even with unconventional names.
 */
export function scriptTestMatcher(baselinePackageJson: string | null | undefined): (path: string) => boolean {
  let scripts: Record<string, unknown> = {};
  try { scripts = (JSON.parse(baselinePackageJson ?? "{}") as { scripts?: Record<string, unknown> }).scripts ?? {}; } catch { /* unparseable: no extra matches */ }
  const patterns: RegExp[] = [];
  for (const cmd of Object.values(scripts)) {
    if (typeof cmd !== "string") continue;
    for (const raw of cmd.split(/[\s;&|()]+/)) {
      const token = raw.replace(/^['"]|['"]$/g, "").replace(/^\.\//, "");
      if (!token || token.startsWith("-") || token.includes("=") || token.startsWith("$") || /node_modules/i.test(token)) continue;
      if (!/[./*]/.test(token) || /^\.+$/.test(token) || token.includes("://")) continue;
      const glob = token.replace(/\/+$/, "").replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*\/?/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, "(.*/)?");
      // A token that names a folder (no extension, or a trailing slash) covers everything under it.
      const folder = raw.endsWith("/") || !/\.[a-z0-9]+$/i.test(token);
      patterns.push(new RegExp(`^${glob}${folder ? "(/.*)?" : ""}$`, "i"));
    }
  }
  return (path) => patterns.some((r) => r.test(path));
}

export function findTampering(changes: FileChange[], isScriptTest: (path: string) => boolean = () => false): string[] {
  const out: string[] = [];
  for (const c of changes) {
    const verb = VERB[c.status] ?? `changed (${c.status})`;
    if (NODE_MODULES.test(c.path)) {
      out.push(`${c.path} ${verb} (committed node_modules)`);
    } else if (LOCKFILES.test(c.path)) {
      out.push(`${c.path} ${verb} (lockfile)`);
    } else if (isManifest(c.path)) {
      if (c.status === "A") continue; // a new package.json changes no existing scripts
      const keys = manifestChanges(c.before, c.status === "D" ? null : c.after);
      if (keys.length) out.push(`${c.path} ${c.status === "D" ? "deleted" : `${keys.join(", ")} changed`}`);
    } else if (isRunnerConfig(c.path)) {
      out.push(`${c.path} ${verb} (test runner or package manager config)`);
    } else if (c.status !== "A" && (isTestPath(c.path) || isScriptTest(c.path))) {
      out.push(`${c.path} ${verb} (existing test)`);
    } else if (c.status !== "A" && isCiPath(c.path)) {
      out.push(`${c.path} ${verb} (CI config)`);
    }
  }
  return out;
}

/** Parses `git diff --name-status -z --no-renames` output. */
export function parseNameStatus(out: string): Array<{ status: string; path: string }> {
  const parts = out.split("\0");
  const changes: Array<{ status: string; path: string }> = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const status = parts[i]!.trim().charAt(0);
    const path = parts[i + 1]!;
    if (status && path) changes.push({ status, path });
  }
  return changes;
}

// ---------- Tamper check (git part) ----------

interface TamperResult {
  findings: string[];
  changed: number;
  /** The commit compared against, or null for a root commit compared against the empty tree. */
  base: string | null;
  /** Human-readable description of what was compared, for the evidence summary. */
  against: string;
  /** The revision the diff starts from: the base, or the empty tree for a root commit. */
  from: string;
}

async function gitOut(args: string[], workdir: string, env: Record<string, string>): Promise<string> {
  const r = await run(["git", ...args], workdir, env, 60_000);
  if (r.code !== 0) throw new Error(`git ${args[0]} exited ${r.code}: ${tail(r.output, 3)}`);
  return r.output;
}

class TamperCheckError extends Error {
  constructor(message: string, readonly base: string | null = null) {
    super(message);
  }
}

/** Fetches the baseline commit (depth 1) unless it is already present; returns its full id or throws. */
async function fetchBaseline(workdir: string, repoUrl: string, baseline: string, env: Record<string, string>): Promise<string> {
  if (!COMMIT_ID.test(baseline)) throw new TamperCheckError(`baseline ${JSON.stringify(baseline.slice(0, 80))} is not a commit id`);
  const present = await run(["git", "cat-file", "-e", `${baseline}^{commit}`], workdir, env, 30_000);
  if (present.code !== 0) {
    const r = await run(["git", "fetch", "-q", "--depth", "1", repoUrl, baseline], workdir, env, 120_000);
    if (r.code !== 0) throw new TamperCheckError(`baseline ${baseline.slice(0, 12)} could not be fetched (git fetch exited ${r.code}${r.timedOut ? ", timed out" : ""})`);
  }
  const resolved = await run(["git", "rev-parse", "--verify", "-q", `${baseline}^{commit}`], workdir, env, 30_000);
  if (resolved.code !== 0) throw new TamperCheckError(`baseline ${baseline.slice(0, 12)} is not reachable in the repository`);
  return resolved.output.trim();
}

/** The first parent, or null for a root commit. Throws when the parent was not fetched. */
async function firstParent(workdir: string, sha: string, env: Record<string, string>): Promise<string | null> {
  const shallow = await readFile(join(workdir, ".git", "shallow"), "utf8").catch(() => "");
  if (shallow.split("\n").some((l) => l.trim() === sha)) throw new TamperCheckError("the parent commit was not fetched");
  const [, parent] = (await gitOut(["rev-list", "--parents", "-n", "1", sha], workdir, env)).trim().split(/\s+/);
  return parent ?? null;
}

/** Diffs the delivered commit's tree against the baseline (or, without one, its first parent). */
async function tamperCheck(workdir: string, sha: string, env: Record<string, string>, input: DeterministicInput): Promise<TamperResult> {
  let base: string | null;
  let against: string;
  if (input.baselineSha) {
    base = await fetchBaseline(workdir, input.repoUrl, input.baselineSha, env);
    against = `the ${input.baselineSource ?? "recorded"} baseline ${base.slice(0, 12)}`;
  } else {
    base = await firstParent(workdir, sha, env);
    against = base
      ? `the first parent ${base.slice(0, 12)} only (no baseline recorded for this milestone or pull request, so earlier merges are not covered)`
      : "the empty tree (root commit, no baseline recorded)";
  }
  // A root commit adds everything; compare against the empty tree.
  const from = base ?? (await gitOut(["hash-object", "-t", "tree", "/dev/null"], workdir, env)).trim();
  let raw: string;
  try {
    raw = await gitOut(["diff", "--name-status", "--no-renames", "-z", from, sha], workdir, env);
  } catch (e) {
    throw new TamperCheckError(`could not diff against ${against} (${(e as Error).message})`, base);
  }
  const changes: FileChange[] = parseNameStatus(raw);
  const show = async (rev: string, path: string) => {
    const r = await run(["git", "show", `${rev}:${path}`], workdir, env, 60_000);
    return r.code === 0 ? r.output : null;
  };
  for (const c of changes) {
    if (!isManifest(c.path) || c.status === "A") continue;
    c.before = await show(from, c.path);
    c.after = c.status === "D" ? null : await show(sha, c.path);
  }
  const baselinePkg = await show(from, "package.json");
  return { findings: findTampering(changes, scriptTestMatcher(baselinePkg)), changed: changes.length, base, against, from };
}

/** Removes every node_modules and .bin entry in the checkout (outside .git), so nothing committed lands on PATH. */
export async function removeCommittedDependencies(root: string): Promise<string[]> {
  const removed: string[] = [];
  const walk = async (dir: string, rel: string): Promise<void> => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const path = rel ? `${rel}/${e.name}` : e.name;
      if (e.name.toLowerCase() === "node_modules" || e.name.toLowerCase() === ".bin") {
        await rm(join(dir, e.name), { recursive: true, force: true });
        removed.push(path);
      } else if (e.isDirectory() && !(rel === "" && e.name === ".git")) {
        await walk(join(dir, e.name), path);
      }
    }
  };
  await walk(root, "");
  return removed;
}

// ---------- Context evidence for judgment criteria ----------

/** `text` cut to `max` characters, with a note saying so. */
export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n[truncated at ${max} characters]` : text;
}

/** Parses `git diff --numstat -z --no-renames` output ("added\tdeleted\tpath\0"; "-" counts for binary files). */
export function parseNumstat(out: string): Array<{ path: string; added: number | null; deleted: number | null }> {
  return out.split("\0").filter((l) => l.trim() !== "").map((line) => {
    const [a = "", d = "", ...rest] = line.split("\t");
    const n = (x: string) => (/^\d+$/.test(x.trim()) ? Number(x.trim()) : null);
    return { path: rest.join("\t").replace(/^\n+/, ""), added: n(a), deleted: n(d) };
  });
}

/** The evd_diff summary: file list with +/- counts, then the first DIFF_EXCERPT_CHARS of the patch. */
export function diffSummary(against: string, files: ReturnType<typeof parseNumstat>, patch: string): string {
  const plus = files.reduce((n, f) => n + (f.added ?? 0), 0);
  const minus = files.reduce((n, f) => n + (f.deleted ?? 0), 0);
  const shown = files.slice(0, TREE_MAX_ENTRIES).map((f) => `  ${f.added === null ? "binary" : `+${f.added} -${f.deleted}`} ${f.path}`);
  const more = files.length > shown.length ? [`  ... and ${files.length - shown.length} more file(s)`] : [];
  const excerpt = patch.length > DIFF_EXCERPT_CHARS ? `${patch.slice(0, DIFF_EXCERPT_CHARS)}\n[diff truncated at ${DIFF_EXCERPT_CHARS} of ${patch.length} characters; get_diff returns all of it]` : patch;
  return [`${files.length} file(s) changed against ${against}, +${plus} -${minus}:`, ...shown, ...more, "", "diff:", excerpt].join("\n");
}

/** The evd_tree summary: the delivered commit's file list, at most TREE_MAX_ENTRIES paths. */
export function treeSummary(paths: string[]): string {
  const shown = paths.slice(0, TREE_MAX_ENTRIES);
  const more = paths.length > shown.length ? [`... and ${paths.length - shown.length} more (read_file reads any of them)`] : [];
  return [`${paths.length} file(s) in the delivered commit:`, ...shown, ...more].join("\n");
}

/** The evd_commit summary: commit message and pull request text, each capped; null when there is none. */
export function commitSummary(message: string, pr: DeterministicInput["pullRequest"]): string | null {
  const parts: string[] = [];
  if (message.trim()) parts.push(`commit message:\n${truncate(message.trim(), COMMIT_TEXT_MAX)}`);
  if (pr?.title?.trim()) parts.push(`delivery title: ${truncate(pr.title.trim(), 500)}`);
  if (pr?.body?.trim()) parts.push(`delivery description:\n${truncate(pr.body.trim(), COMMIT_TEXT_MAX)}`);
  return parts.length ? parts.join("\n\n") : null;
}

/**
 * evd_diff, evd_tree and evd_commit. Best effort: a git failure here leaves the item out (the judge then says
 * unclear), it never fails the stage. `from` is the tamper check's starting revision; without one the commit's own
 * diff against its parent is used, like the evidence reader's get_diff.
 */
async function contextEvidence(workdir: string, head: string, env: Record<string, string>, diffFrom: { from: string; against: string } | null, pr: DeterministicInput["pullRequest"]): Promise<EvidenceSummary[]> {
  const out: EvidenceSummary[] = [];
  try {
    const range = diffFrom ? [diffFrom.from, head] : [`${head}^`, head];
    const against = diffFrom ? diffFrom.against : `its parent ${(await gitOut(["rev-parse", "--short=12", `${head}^`], workdir, env)).trim()}`;
    const files = parseNumstat(await gitOut(["diff", "--numstat", "-z", "--no-renames", ...range], workdir, env));
    const patch = await gitOut(["diff", "--no-color", "--no-renames", ...range], workdir, env);
    out.push({ id: DIFF_EVIDENCE_ID, kind: "diff", summary: diffSummary(against, files, patch) });
  } catch {
    // no diff evidence; the judge can still call get_diff
  }
  try {
    const paths = (await gitOut(["ls-tree", "-r", "-z", "--name-only", head], workdir, env)).split("\0").filter(Boolean);
    out.push({ id: TREE_EVIDENCE_ID, kind: "file", summary: treeSummary(paths) });
  } catch {
    // no tree evidence
  }
  const message = await gitOut(["log", "-1", "--format=%B", head], workdir, env).catch(() => "");
  const commit = commitSummary(message, pr);
  if (commit) out.push({ id: COMMIT_EVIDENCE_ID, kind: "note", summary: commit });
  return out;
}

/**
 * Strips worker directories (the checkout, UPLOAD_DIR) from text both parties see, realpaths included
 * (/var/folders/... is /private/var/folders/... on macOS). A path under a root becomes relative to it; the root itself
 * becomes ".". Roots are replaced longest first: "/private/var/x" contains "/var/x".
 */
export function stripRoots(text: string, roots: string[]): string {
  const all = new Set<string>();
  for (const r of roots) {
    if (!r) continue;
    const clean = r.replace(/\/+$/, "");
    all.add(clean);
    try { all.add(realpathSync(clean)); } catch { /* gone already */ }
  }
  let out = text;
  for (const root of [...all].filter((r) => r.length > 1).sort((a, b) => b.length - a.length)) {
    out = out.split(`${root}${sep}`).join("").split(root).join(".");
  }
  return out;
}

/** Evidence items with worker directories stripped from their summaries: the one boundary both stages scrub at. */
export function scrubEvidence(items: EvidenceSummary[], roots: string[]): EvidenceSummary[] {
  return items.map((e) => ({ ...e, summary: stripRoots(e.summary, roots) }));
}

// ---------- Stage ----------

export async function runDeterministicStage(input: DeterministicInput): Promise<DeterministicOutput> {
  const workdir = await mkdtemp(join(tmpdir(), "milestone-verify-"));
  // The realpath is taken now: the error path below removes the workdir before scrubbing.
  const roots = [workdir, await realpath(workdir).catch(() => workdir)];
  const scrub = (s: string) => stripRoots(s, roots);
  const env = { ...CLEAN_ENV, HOME: workdir };
  const logs: Record<string, string> = {};
  const evidence: EvidenceSummary[] = [];
  try {
    if (!COMMIT_ID.test(input.sha)) throw new Error(`delivered sha ${JSON.stringify(input.sha.slice(0, 80))} is not a commit id`);
    await run(["git", "init", "-q"], workdir, env, 30_000);
    // Depth 2: the merge commit and its first parent, for the tamper check.
    const fetched = await run(["git", "fetch", "-q", "--depth", "2", input.repoUrl, input.sha], workdir, env, 120_000);
    if (fetched.code !== 0) throw new Error(`git fetch exited ${fetched.code}${fetched.timedOut ? " (timed out)" : ""}`);
    const checkedOut = await run(["git", "checkout", "-q", "FETCH_HEAD"], workdir, env, 30_000);
    if (checkedOut.code !== 0) throw new Error(`git checkout exited ${checkedOut.code}`);
    const head = (await gitOut(["rev-parse", "HEAD"], workdir, env)).trim();

    let tampering: string[];
    let baseline: string | null = null;
    let diffFrom: { from: string; against: string } | null = null;
    try {
      const t = await tamperCheck(workdir, head, env, input);
      tampering = t.findings;
      baseline = t.base;
      diffFrom = { from: t.from, against: t.against };
      evidence.push({
        id: TAMPER_EVIDENCE_ID,
        kind: "diff",
        status: tampering.length ? "unclear" : "pass",
        summary: tampering.length
          ? `tamper check against ${t.against}: the delivery changes what the test/build commands run: ${tampering.join("; ")}`
          : `tamper check: ${t.changed} file(s) changed against ${t.against}; no package.json scripts or dependencies, lockfiles, node_modules, existing tests, CI or runner config modified`,
      });
    } catch (e) {
      const msg = (e as Error).message;
      tampering = [e instanceof TamperCheckError ? msg : `could not run the tamper diff (${msg})`];
      if (e instanceof TamperCheckError) baseline = e.base;
      evidence.push({ id: TAMPER_EVIDENCE_ID, kind: "diff", status: "unclear", summary: `tamper check: ${tampering[0]}` });
    }
    evidence.push(...(await contextEvidence(workdir, head, env, diffFrom, input.pullRequest)));

    // Whatever the diff says, committed dependencies never run: npm run puts node_modules/.bin first on PATH.
    const removed = await removeCommittedDependencies(workdir);
    if (removed.length) logs["setup:remove-committed-node_modules"] = removed.join("\n");

    for (const cmd of input.setup ?? []) {
      const r = await run(cmd, workdir, env, input.timeoutMs ?? 300_000);
      logs[`setup:${cmd.join(" ")}`] = r.output;
      if (r.code !== 0) throw new Error(`setup failed: ${cmd.join(" ")}`);
    }
    for (const c of input.criteria) {
      if (c.kind === "test" || c.kind === "build") {
        const command = String(c.spec.command ?? (c.kind === "test" ? "npm test" : "npm run build"));
        const r = await run(["sh", "-c", command], workdir, env, input.timeoutMs ?? 300_000);
        logs[c.id] = r.output;
        const ran = `${command} exited ${r.code}${r.timedOut ? " (timed out)" : ""}`;
        const status = r.timedOut ? "unclear" : r.code === 0 ? "pass" : "fail";
        if (status === "pass" && tampering.length) {
          // The delivery controls what this command ran, so its pass proves nothing.
          evidence.push({ id: `evd_${c.id}`, criterion_id: c.id, kind: "log", status: "unclear", summary: `tamper check: ${ran}, but the result is not trusted: ${tampering.join("; ")}`, sha256: sha256(r.output) });
        } else {
          evidence.push({ id: `evd_${c.id}`, criterion_id: c.id, kind: "log", status, summary: `${ran}; last lines:\n${tail(r.output)}`, sha256: sha256(r.output) });
        }
      } else if (c.kind === "file") {
        const path = String(c.spec.path ?? "");
        const exists = await access(join(workdir, path)).then(() => true, () => false);
        evidence.push({ id: `evd_${c.id}`, criterion_id: c.id, kind: "file", status: exists ? "pass" : "fail", summary: `${path} ${exists ? "present" : "missing"}` });
      }
    }
    return {
      evidence: scrubEvidence(evidence, roots),
      logs: Object.fromEntries(Object.entries(logs).map(([k, v]) => [k, scrub(v)])),
      workdir,
      tampering: tampering.map(scrub),
      baseline,
    };
  } catch (e) {
    await rm(workdir, { recursive: true, force: true });
    if (e instanceof Error) e.message = scrub(e.message);
    throw e;
  }
}

/** Hex sha256 of text or bytes. */
export function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}
function tail(s: string, n = 20): string {
  return s.split("\n").slice(-n).join("\n");
}

export function run(cmd: string[], cwd: string, env: Record<string, string>, timeoutMs: number): Promise<{ code: number | null; output: string; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    const [bin, ...args] = cmd;
    if (!bin) return reject(new Error("empty command"));
    // Cast: Next.js augments ProcessEnv with a required NODE_ENV, which a plain record does not carry.
    const child = spawn(bin, args, { cwd, env: env as NodeJS.ProcessEnv, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, output: output.slice(-200_000), timedOut }); });
  });
}

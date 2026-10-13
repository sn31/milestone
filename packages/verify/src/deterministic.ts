/**
 * Deterministic stage, no model: check out the merge commit in a throwaway directory with no secrets
 * in its environment, run build and test commands with a time limit, check required files.
 *
 * Baseline suite (CLAUDE.md rule 9): the delivery is written by the payee, so its test run is graded by the CLIENT'S
 * suite, not by whatever the delivery says the suite is. After checking out the delivered commit and before setup, the
 * stage puts the baseline's test machinery back:
 *
 * - every path that defines or configures the tests is restored from the baseline: test files and folders (test/,
 *   tests/, __tests__/, spec/, *.test.*, *.spec.*, __snapshots__, a root test.js/tests.js/spec.js), runner config
 *   (mocha/jest/vitest/ava/playwright/karma/cypress configs, .mocharc*, mocha.opts, babel/swc/tsconfig*, nyc/c8),
 *   package-manager config (.npmrc, .yarnrc*, .pnpmfile.cjs, bunfig.toml), lockfiles, and every file or folder that the
 *   baseline's test/build scripts or test config name (scriptTestMatcher: "node bin/build" names bin/build.js);
 * - every package.json keeps the baseline's scripts, runner config, dev/optional/peer dependencies, overrides,
 *   resolutions, workspaces, bin, engines, packageManager, imports, exports, main and type; only the delivery's other
 *   fields (dependencies, description, ...) stay. When that leaves the delivery's dependencies different from the
 *   baseline's, the npm lockfile is dropped so setup installs from the manifest (npm ci would refuse it);
 * - every file the delivery ADDED at those locations (a new test, a test/00-setup.js, a mocha.opts, a runner config) is
 *   removed for the graded run.
 *
 * So the test criterion means "the client's own suite passes against the delivered code". A delivery that edits or
 * adds tests is not distrusted for it: its test edits simply do not run, and evd_tamper_check says which paths were
 * restored or removed. The tests it wrote run afterwards in a second, informational pass (the delivered tree as is, on
 * the dependencies installed for the graded run; evidence with no status) that never decides anything. Paths that are not test machinery (source, docs) stay as
 * delivered.
 *
 * What a path rule cannot see, source code that notices it is under test (CI=1 and NODE_ENV=test are set below) or
 * patches assertions at require time, is caught by the gaming scan (gaming.ts) of the delivery's added source lines;
 * each hit is unclear evidence on the test criterion, which sends the milestone to the client.
 *
 * The baseline is the default branch head recorded when the milestone was funded, else the pull request's base, and
 * only when neither is known the commit's first parent (which misses earlier merges and rebase-merged commits, and the
 * evidence says so). A baseline that cannot be fetched, or a root commit with none, fails closed: the delivery's own
 * tests run and a pass is recorded unclear (a fail still fails).
 *
 * Commands run with lifecycle scripts disabled (npm_config_ignore_scripts) and with every committed node_modules
 * and .bin directory removed first, so a committed node_modules/.bin/node cannot shadow the real one.
 *
 * Context evidence for judgment criteria (no status, never decides anything): evd_diff (the diff against the same
 * baseline: file list with +/- counts and the start of the patch), evd_tree (the delivered commit's file list) and
 * evd_commit (commit message, PR title and body; untrusted text). The judge cites these. When the stage returns, the
 * workdir shows the delivered files again (the overlay is undone), so read_file reads what was delivered.
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
import { access, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import type { CriterionSpec, EvidenceSummary } from "@milestone/core";
import { describeHit, scanForGaming, type GamingHit } from "./gaming.ts";
import { repoPath } from "./paths.ts";

export interface DeterministicInput {
  repoUrl: string;
  sha: string;
  criteria: CriterionSpec[];
  timeoutMs?: number;
  /** e.g. ["npm", "ci", "--ignore-scripts"]; run once before the criteria. */
  setup?: string[][];
  /**
   * The commit whose test suite grades the delivery (default branch head at funding, or the PR base).
   * null/undefined falls back to the first parent. A baseline that cannot be fetched makes passes unclear.
   */
  baselineSha?: string | null;
  /** Where baselineSha came from, for the evidence summary, e.g. "funding" or "pull request base". */
  baselineSource?: string;
  /** The pull request title and body, or a manual delivery's title and note (untrusted); recorded with the commit message as evd_commit. */
  pullRequest?: { title?: string; body?: string };
  /**
   * Called with each evidence item as soon as its check finishes (baseline suite, context, each test/build/file
   * criterion, gaming hits, the informational pass), in the order they appear in the output, already scrubbed of the
   * workdir. The stage awaits it, so a caller can persist progress before the next check runs; a throw here fails the
   * stage, so callers that only report progress should catch their own errors. The returned `evidence` is unchanged by it.
   */
  onEvidence?: (item: EvidenceSummary) => void | Promise<void>;
}

/** What the baseline overlay did to the delivered checkout before the graded run. */
export interface OverlayReport {
  /** Baseline paths checked out over the delivery's version (or put back where the delivery deleted them). */
  restored: string[];
  /** Paths the delivery added at test locations, removed for the graded run. */
  removed: string[];
  /** package.json files rewritten with the baseline's values of these keys. */
  manifests: Array<{ path: string; keys: string[] }>;
  /** npm lockfiles dropped because the delivery's dependencies no longer match the baseline's. */
  lockfilesDropped: string[];
}

export interface DeterministicOutput {
  evidence: EvidenceSummary[];
  logs: Record<string, string>;
  workdir: string;
  /** The overlay that made the test run the client's suite; null when it could not be put in place (see `untrusted`). */
  overlay: OverlayReport | null;
  /** Why passes were recorded unclear (no client suite could run), or null. */
  untrusted: string | null;
  /** Gaming scan hits in the delivery's added source lines (each one is unclear evidence on the test criterion). */
  gaming: GamingHit[];
  /** The baseline commit (fetched into workdir), or null when there is none. */
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

/** The baseline-suite evidence item (the id predates the overlay: it used to hold the tamper check). */
export const TAMPER_EVIDENCE_ID = "evd_tamper_check";
/** Context evidence the judge may cite for judgment criteria (see the header). */
export const DIFF_EVIDENCE_ID = "evd_diff";
export const TREE_EVIDENCE_ID = "evd_tree";
export const COMMIT_EVIDENCE_ID = "evd_commit";
/** evd_diff carries this much of the patch; evd_tree at most this many paths. */
export const DIFF_EXCERPT_CHARS = 2_000;
export const TREE_MAX_ENTRIES = 200;
const COMMIT_TEXT_MAX = 2_000;
/** At most this many gaming hits become evidence items per criterion; the last one says how many more there were. */
export const GAMING_MAX_ITEMS = 20;
/** Lists in the baseline-suite summary are cut after this many paths. */
const SUMMARY_LIST_MAX = 20;

// ---------- Baseline suite (pure part, unit-tested) ----------

export interface FileChange {
  /** git --name-status letter: A, M, D, T, ... (renames are disabled, so a rename is D + A). */
  status: string;
  path: string;
}

// Conventional test locations, including a single suite file at the root such as ms's tests.js. A file named test.js
// deeper down is ordinary source (lib/test.js); files the scripts or test config name are covered by scriptTestMatcher.
const TEST_PATHS = [/(^|\/)(test|tests|__tests__|spec)\//i, /\.(test|spec)\.[cm]?[jt]sx?$/i, /^(tests?|spec)\.[cm]?[jt]sx?$/i, /(^|\/)__snapshots__\//i];
/** Runner config: changes what a test command loads, transforms or counts. */
const RUNNER_CONFIG = [
  /(^|\/)(vitest|vite|jest|playwright|karma|cypress|ava|mocha)\.config\.[cm]?[jt]s(on)?$/i,
  /(^|\/)vitest\.workspace\.[cm]?[jt]s(on)?$/i,
  /(^|\/)\.mocharc(\.[a-z]+)?$/i,
  /(^|\/)mocha\.opts$/i,
  /(^|\/)(babel\.config\.[cm]?[jt]s(on)?|\.babelrc(\.[a-z]+)?|\.swcrc|tsconfig[^/]*\.json)$/i,
  /(^|\/)\.(nycrc|c8rc)(\.[a-z]+)?$/i,
];
/** Package-manager config (an .npmrc can set script-shell). */
const PM_CONFIG = /(^|\/)(\.npmrc|\.yarnrc|\.yarnrc\.yml|\.pnpmfile\.cjs|bunfig\.toml)$/i;
/** Lockfiles decide which dependency code runs. */
const LOCKFILES = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb|bun\.lock)$/i;
/** Committed dependencies: never restored or kept, removeCommittedDependencies deletes them all. */
// Case-insensitive: on APFS and NTFS "Node_Modules/.BIN/node" shadows the real binary too.
const COMMITTED_DEPS = /(^|\/)(node_modules|\.bin)(\/|$)/i;
/** Config files whose contents can name test files (spec:, testMatch, setupFiles, --require ...). */
const TEST_CONFIG = [/(^|\/)\.mocharc(\.[a-z]+)?$/i, /(^|\/)mocha\.opts$/i, /(^|\/)(vitest|vite|jest|playwright|karma|cypress|ava|mocha)\.config\.[cm]?[jt]s(on)?$/i];

/**
 * package.json keys that decide what test and build commands run and what gets installed for them. `dependencies` is
 * not here: the delivery may change what its code depends on (see mergeManifest for the one exception).
 */
export const MANIFEST_KEYS = [
  "scripts", "jest", "mocha", "ava",
  "devDependencies", "optionalDependencies", "peerDependencies",
  "overrides", "resolutions", "pnpm", "workspaces", "bin", "engines", "packageManager",
  "imports", "exports", "main", "type",
] as const;

export const isTestPath = (p: string) => TEST_PATHS.some((r) => r.test(p));
const isRunnerConfig = (p: string) => RUNNER_CONFIG.some((r) => r.test(p));
const isManifest = (p: string) => /(^|\/)package\.json$/i.test(p);
const isTestConfig = (p: string) => TEST_CONFIG.some((r) => r.test(p));
/** Test machinery by location alone: test files, runner and package-manager config, lockfiles. */
export const isTestInfraPath = (p: string) => isTestPath(p) || isRunnerConfig(p) || PM_CONFIG.test(p) || LOCKFILES.test(p);

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "undefined";
}

function parseObject(text: string | null | undefined): Record<string, unknown> | null {
  if (text === null || text === undefined) return null;
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export interface ManifestMerge {
  /** The text to write, or null when the delivered manifest already has the baseline's values. */
  text: string | null;
  /** Which guarded keys the delivery had changed (what was put back), for the evidence. */
  keys: string[];
  /** The merged manifest's dependencies differ from the baseline's (the baseline lockfile no longer matches). */
  dependencyChange: boolean;
}

/**
 * The delivered package.json with the baseline's values of MANIFEST_KEYS (absent in the baseline means absent) and the
 * delivery's values of everything else. One exception: a `dependencies` entry the delivery adds or changes for a name
 * the baseline has as a dev, optional or peer dependency is put back, so "dependencies": { "mocha": "file:./fake" }
 * cannot replace the client's test runner. Either side unparseable: the whole baseline file.
 */
export function mergeManifest(baselineText: string, deliveredText: string): ManifestMerge {
  const b = parseObject(baselineText);
  const d = parseObject(deliveredText);
  if (!b || !d) return { text: baselineText === deliveredText ? null : baselineText, keys: baselineText === deliveredText ? [] : ["whole file (unparseable)"], dependencyChange: false };
  const guarded = new Set<string>(MANIFEST_KEYS);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(d)) {
    if (!guarded.has(k)) out[k] = v;
    else if (k in b) out[k] = b[k];
  }
  for (const k of MANIFEST_KEYS) if (k in b && !(k in out)) out[k] = b[k];
  const keys: string[] = MANIFEST_KEYS.filter((k) => canonical(b[k]) !== canonical(d[k]));
  const deps = out.dependencies && typeof out.dependencies === "object" && !Array.isArray(out.dependencies) ? { ...(out.dependencies as Record<string, unknown>) } : null;
  if (deps) {
    const baseDeps = (b.dependencies ?? {}) as Record<string, unknown>;
    const toolNames = new Set(["devDependencies", "optionalDependencies", "peerDependencies"].flatMap((k) => Object.keys((b[k] ?? {}) as Record<string, unknown>)));
    const shadowed = Object.keys(deps).filter((n) => toolNames.has(n) && canonical(deps[n]) !== canonical(baseDeps[n]));
    for (const n of shadowed) {
      if (n in baseDeps) deps[n] = baseDeps[n];
      else delete deps[n];
    }
    if (shadowed.length) {
      out.dependencies = deps;
      keys.push(`dependencies (${shadowed.join(", ")}: a baseline dev dependency)`);
    }
  }
  const dependencyChange = canonical(out.dependencies) !== canonical(b.dependencies);
  if (canonical(out) === canonical(d)) return { text: null, keys: [], dependencyChange };
  const indent = /^\{\s*\n([ \t]+)"/.exec(deliveredText)?.[1] ?? "  ";
  return { text: `${JSON.stringify(out, null, indent)}\n`, keys, dependencyChange };
}

/**
 * Splits a shell command into segments (on ; & | ( ) and newlines) of words, honouring single and double quotes and
 * backslashes, so a quoted path with spaces stays one word.
 */
export function shellSegments(cmd: string): string[][] {
  const segs: string[][] = [];
  let words: string[] = [];
  let w = "";
  let inWord = false;
  const endWord = () => {
    if (inWord) words.push(w);
    w = "";
    inWord = false;
  };
  const endSeg = () => {
    endWord();
    if (words.length) segs.push(words);
    words = [];
  };
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]!;
    if (ch === "'") {
      const j = cmd.indexOf("'", i + 1);
      const end = j < 0 ? cmd.length : j;
      w += cmd.slice(i + 1, end);
      inWord = true;
      i = end;
    } else if (ch === '"') {
      let j = i + 1;
      for (; j < cmd.length && cmd[j] !== '"'; j++) {
        if (cmd[j] === "\\" && j + 1 < cmd.length) w += cmd[++j];
        else w += cmd[j];
      }
      inWord = true;
      i = j;
    } else if (ch === "\\" && i + 1 < cmd.length) {
      w += cmd[++i];
      inWord = true;
    } else if (ch === "\n") {
      endSeg();
    } else if (/\s/.test(ch) || ch === "<" || ch === ">") {
      endWord();
    } else if (";&|()".includes(ch)) {
      endSeg();
    } else {
      w += ch;
      inWord = true;
    }
  }
  endSeg();
  return segs;
}

/** Shell brace expansion: "test/{a,b}.js" -> ["test/a.js", "test/b.js"]; braces without a comma stay literal. */
export function expandBraces(s: string, limit = 64): string[] {
  const open = s.indexOf("{");
  if (open < 0) return [s];
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === "{") depth++;
    else if (s[i] === "}" && --depth === 0) {
      const inner = s.slice(open + 1, i);
      const parts: string[] = [];
      let d = 0;
      let start = 0;
      for (let j = 0; j < inner.length; j++) {
        if (inner[j] === "{") d++;
        else if (inner[j] === "}") d--;
        else if (inner[j] === "," && d === 0) {
          parts.push(inner.slice(start, j));
          start = j + 1;
        }
      }
      parts.push(inner.slice(start));
      if (parts.length < 2) return expandBraces(s.slice(i + 1), limit).map((rest) => s.slice(0, i + 1) + rest);
      const out: string[] = [];
      for (const p of parts) {
        for (const e of expandBraces(s.slice(0, open) + p + s.slice(i + 1), limit)) {
          out.push(e);
          if (out.length >= limit) return out;
        }
      }
      return out;
    }
  }
  return [s];
}

/** A glob ("test/**\/*.js", "suite/*.spec.ts") as a regex over repo paths; a match also covers everything under it. */
function globRegex(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          i++;
          re += "(?:.*/)?";
        } else re += ".*";
      } else re += "[^/]*";
    } else if (ch === "?") re += "[^/]";
    else if (ch === "[") {
      const j = glob.indexOf("]", i + 1);
      if (j > i + 1) {
        re += `[${glob.slice(i + 1, j).replace(/^!/, "^").replace(/\\/g, "\\\\")}]`;
        i = j;
      } else re += "\\[";
    } else re += ch.replace(/[.+^${}()|\\]/g, "\\$&");
  }
  return new RegExp(`^${re}(?:/.*)?$`, "i");
}

const isGlob = (t: string) => /[*?[]/.test(t);

/** `token` resolved against `dir` (both repo-relative, "/"-separated); null when it climbs out of the repository. */
function joinRel(dir: string, token: string): string | null {
  const parts = dir ? dir.split("/") : [];
  for (const seg of token.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join("/");
}

const posixDir = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");

/** The candidate path strings in one shell word: "--require=./setup.js" -> ["./setup.js"], "NODE_OPTIONS=--require ./h.js" -> ["./h.js"]. */
function tokenCandidates(word: string): string[] {
  let w = word;
  const eq = w.indexOf("=");
  if (w.startsWith("-")) {
    if (eq < 0) return [];
    w = w.slice(eq + 1);
  } else if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) {
    w = w.slice(eq + 1);
  }
  // A quoted path with spaces is one word; a quoted option list (NODE_OPTIONS='--require ./h.js') is several.
  const out: string[] = w.startsWith("-") ? [] : expandBraces(w);
  for (const part of /\s/.test(w) || w.startsWith("-") ? w.split(/\s+/) : []) {
    if (!part) continue;
    if (part.startsWith("-")) {
      const e = part.indexOf("=");
      if (e >= 0) out.push(...expandBraces(part.slice(e + 1)));
      continue;
    }
    out.push(...expandBraces(part));
  }
  return out
    .map((t) => t.replace(/^<rootDir>\/?/, "").replace(/^\.\//, ""))
    .filter((t) => t && t !== "." && t !== ".." && !t.startsWith("/") && !t.startsWith("$") && !t.startsWith("~") && !t.includes("://") && !/node_modules/i.test(t));
}

const NPM_VALUE_FLAGS = new Set(["--prefix", "-C", "--workspace", "-w", "--cwd", "--dir", "--filter", "-F", "--npm-path", "--scope"]);
const WORKSPACE_FLAGS = new Set(["--workspaces", "-ws", "--ws", "--workspace", "-w", "-r", "--recursive", "--filter", "-F"]);
const WRAPPERS = new Set(["env", "cross-env", "cross-env-shell", "npx", "pnpx", "time", "nice", "nohup", "exec", "command", "dotenv"]);
const YARN_BUILTINS = new Set(["install", "add", "remove", "exec", "dlx", "node", "bin", "config", "cache", "info", "init", "link", "unlink", "pack", "publish", "upgrade", "up", "why", "set", "plugin", "constraints", "dedupe", "npm", "version"]);
const PNPM_BUILTINS = new Set(["install", "i", "add", "remove", "rm", "exec", "dlx", "update", "up", "link", "unlink", "store", "publish", "pack", "why", "list", "ls", "outdated", "prune", "rebuild", "import", "fetch", "patch", "config"]);

interface SegmentRefs {
  /** Script names (or npm-run-all patterns) this segment runs. */
  names: string[];
  /** The names run in every workspace (--workspaces, -r, lerna/turbo run ...). */
  workspaces: boolean;
  /** --prefix / --cwd / -C: the directory the scripts run in, relative to the segment's directory. */
  prefix: string | null;
  /** Commands passed as arguments (concurrently "a" "b"). */
  subcommands: string[];
  /** Word indexes that are commands, subcommands or script names, not paths. */
  consumed: Set<number>;
}

/** Which package.json scripts a command segment runs (npm/yarn/pnpm/bun run, npm-run-all, lerna/turbo, concurrently). */
function segmentRefs(words: string[]): SegmentRefs {
  const r: SegmentRefs = { names: [], workspaces: false, prefix: null, subcommands: [], consumed: new Set() };
  let i = 0;
  const skipAssignmentsAndFlags = () => {
    while (i < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]!) || words[i]!.startsWith("-") || words[i] === "--")) i++;
  };
  skipAssignmentsAndFlags();
  let cmd = (words[i] ?? "").split("/").pop()!;
  while (WRAPPERS.has(cmd) && i < words.length) {
    r.consumed.add(i);
    i++;
    skipAssignmentsAndFlags();
    cmd = (words[i] ?? "").split("/").pop()!;
  }
  if (i >= words.length) return r;
  r.consumed.add(i);
  const args = words.slice(i + 1);
  const at = (k: number) => i + 1 + k;
  const positional: Array<{ k: number; w: string }> = [];
  for (let k = 0; k < args.length; k++) {
    const a = args[k]!;
    if (a === "--") {
      // npm run test -- extra args: the rest are arguments to the script, possibly paths
      break;
    }
    if (a.startsWith("-")) {
      const name = a.split("=")[0]!;
      if (WORKSPACE_FLAGS.has(name)) r.workspaces = true;
      if (NPM_VALUE_FLAGS.has(name) && !a.includes("=") && k + 1 < args.length) {
        if (name === "--prefix" || name === "-C" || name === "--cwd" || name === "--dir") r.prefix = args[k + 1]!;
        r.consumed.add(at(k + 1));
        k++;
      } else if ((name === "--prefix" || name === "--cwd" || name === "--dir") && a.includes("=")) {
        r.prefix = a.slice(a.indexOf("=") + 1);
      }
      continue;
    }
    positional.push({ k, w: a });
  }
  const take = (n: number) => {
    const p = positional[n];
    if (p) {
      r.names.push(p.w);
      r.consumed.add(at(p.k));
    }
  };
  const sub = positional[0];
  // The subcommand of a package manager or task runner is not a path ("npm test", "lerna run build").
  if (sub && ["npm", "yarn", "pnpm", "bun", "lerna", "turbo", "nx"].includes(cmd)) r.consumed.add(at(sub.k));
  if (cmd === "npm") {
    if (!sub) return r;
    if (["run", "run-script", "rum", "urn"].includes(sub.w)) take(1);
    else if (["test", "t", "tst"].includes(sub.w)) r.names.push("test");
    else if (["start", "stop", "restart"].includes(sub.w)) r.names.push(sub.w);
  } else if (cmd === "yarn") {
    if (!sub) return r; // bare "yarn" installs
    if (sub.w === "run") take(1);
    else if (sub.w === "workspaces" || sub.w === "workspace") {
      r.workspaces = true;
      const runAt = positional.findIndex((p) => p.w === "run");
      if (runAt >= 0) take(runAt + 1);
      else if (sub.w === "workspace") take(2);
    } else if (!YARN_BUILTINS.has(sub.w)) r.names.push(sub.w);
  } else if (cmd === "pnpm") {
    if (!sub) return r;
    if (sub.w === "run" || sub.w === "run-script") take(1);
    else if (["test", "t", "tst", "start"].includes(sub.w)) r.names.push(sub.w.startsWith("t") ? "test" : sub.w);
    else if (!PNPM_BUILTINS.has(sub.w)) r.names.push(sub.w);
  } else if (cmd === "bun") {
    if (sub?.w === "run") take(1);
  } else if (cmd === "npm-run-all" || cmd === "run-s" || cmd === "run-p") {
    for (let n = 0; n < positional.length; n++) take(n);
  } else if (cmd === "lerna" || cmd === "turbo") {
    r.workspaces = true;
    const start = sub?.w === "run" ? 1 : cmd === "turbo" ? 0 : -1;
    if (start >= 0) for (let n = start; n < positional.length; n++) take(n);
  } else if (cmd === "nx") {
    const target = words.find((w) => w.startsWith("--target="))?.slice(9) ?? words.find((w) => w.startsWith("-t="))?.slice(3);
    if (target) {
      r.workspaces = true;
      r.names.push(target);
    }
  } else if (cmd === "concurrently") {
    for (const p of positional) {
      r.consumed.add(at(p.k));
      if (p.w.startsWith("npm:")) r.names.push(p.w.slice(4));
      else r.subcommands.push(p.w);
    }
  }
  return r;
}

/** npm-run-all style pattern ("test:*", "build:**") over script names. */
function scriptNamePattern(name: string): RegExp {
  const re = name.replace(/[.+^${}()|[\]\\?]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^:]*").replace(/\u0000/g, ".*");
  return new RegExp(`^${re}$`);
}

/** The baseline commit, as far as the restore list needs it. */
export interface BaselineTree {
  /** Every file path in the baseline commit (committed dependencies excluded). */
  paths: string[];
  /** Text of the baseline's package.json files and test config (.mocharc*, mocha.opts, jest/vitest/... configs), by path. */
  texts: Record<string, string>;
}

/** Folders whose files are the package's source, never restored because a script or config names them ("jest src", "eslint lib"). */
const SOURCE_DIRS = new Set(["src", "lib", "source", "sources", "app", "apps", "packages", "dist", "build", "out", "es", "esm", "cjs", "types"]);
const FILE_SUFFIXES = ["", ".js", ".cjs", ".mjs", ".ts"];
const INDEX_FILES = ["index.js", "index.cjs", "index.mjs", "index.ts"];

export interface NamedTestPaths {
  files: string[];
  folders: string[];
  globs: string[];
}

/** String values of the given keys of a config object (string or string[]), one level deep. */
function configValues(obj: unknown, keys: string[]): string[] {
  if (!obj || typeof obj !== "object") return [];
  const o = obj as Record<string, unknown>;
  return keys.flatMap((k) => {
    const v = o[k];
    return typeof v === "string" ? [v] : Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  });
}

/** spec/require/file values from a YAML .mocharc (inline value, inline [a, b] list or "- item" lines). */
function yamlValues(text: string, keys: string[]): string[] {
  const out: string[] = [];
  const lines = text.split("\n");
  const unq = (s: string) => s.trim().replace(/^['"]|['"]$/g, "");
  for (let i = 0; i < lines.length; i++) {
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(lines[i]!.trimEnd());
    if (!m || !keys.includes(m[1]!)) continue;
    const v = m[2]!.replace(/\s+#.*$/, "").trim();
    if (v.startsWith("[")) out.push(...v.replace(/^\[|\]$/g, "").split(",").map(unq).filter(Boolean));
    else if (v) out.push(unq(v));
    else for (let j = i + 1; j < lines.length && /^\s*-\s+/.test(lines[j]!); j++) out.push(unq(lines[j]!.replace(/^\s*-\s+/, "")));
  }
  return out;
}

/** Path-like tokens a test config names, relative to the config's directory. */
function configTokens(path: string, text: string): string[] {
  const name = path.split("/").pop()!.toLowerCase();
  const MOCHA_KEYS = ["spec", "require", "file"];
  if (name === "package.json") {
    const o = parseObject(text);
    if (!o) return [];
    return [
      ...configValues(o.mocha, MOCHA_KEYS),
      ...configValues(o.jest, ["testMatch", "setupFiles", "setupFilesAfterEnv", "globalSetup", "globalTeardown", "snapshotResolver", "testSequencer"]),
      ...configValues(o.ava, ["files", "require"]),
    ];
  }
  if (name === "mocha.opts") return text.split(/\s+/).filter(Boolean);
  if (/^\.mocharc(\.jsonc?)?$/.test(name)) {
    const o = parseObject(text.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, ""));
    return o ? configValues(o, MOCHA_KEYS) : yamlValues(text, MOCHA_KEYS);
  }
  if (/^\.mocharc\.ya?ml$/.test(name)) return yamlValues(text, MOCHA_KEYS);
  // JavaScript config (jest.config.js, .mocharc.cjs, vitest.config.ts): every string literal is a candidate; only the
  // ones that name a baseline path (or a test glob) count.
  const out: string[] = [];
  for (const m of text.matchAll(/(['"`])((?:\\.|(?!\1)[^\\\n])*)\1/g)) out.push(m[2]!);
  return out;
}

/**
 * Files, folders and globs that the baseline's test machinery names: tokens of the test/build criterion commands and of
 * every package.json script they reach (npm run X, npm test, run-s, workspaces, pre/post scripts), resolved against the
 * baseline tree (token, token.{js,cjs,mjs,ts}, token/index.*), plus spec/require/testMatch/setupFiles entries of test
 * config. Bare words that are not a baseline path are ignored ("mocha --reporter spec" names nothing). The package's
 * source is never named this way: main/bin/exports targets, the folders holding them, and src/ lib/ dist/ ... are left
 * out, and a glob must have a literal folder or a test/spec file name ("**\/*.js" names nothing).
 */
export function namedTestPaths(tree: BaselineTree, commands: string[]): NamedTestPaths {
  const files = new Set(tree.paths);
  const dirs = new Set<string>();
  for (const p of tree.paths) for (let d = posixDir(p); d; d = posixDir(d)) dirs.add(d);
  const manifests = new Map<string, Record<string, unknown>>();
  for (const [p, t] of Object.entries(tree.texts)) {
    if (!isManifest(p)) continue;
    const o = parseObject(t);
    if (o) manifests.set(posixDir(p), o);
  }
  // The package's own entry points (and the folders holding them) are source, whatever a script says.
  const entries = new Set<string>();
  const addEntry = (dir: string, v: unknown): void => {
    if (typeof v === "string") {
      const rel = joinRel(dir, v);
      if (rel !== null) for (const suf of [...FILE_SUFFIXES, ...INDEX_FILES.map((f) => `/${f}`)]) if (files.has(rel + suf)) entries.add(rel + suf);
    } else if (v && typeof v === "object") for (const x of Object.values(v as Record<string, unknown>)) addEntry(dir, x);
  };
  for (const [dir, o] of manifests) {
    for (const k of ["main", "module", "bin", "exports", "browser"]) addEntry(dir, o[k]);
    if (!("main" in o)) addEntry(dir, "index.js");
  }
  const sourceRel = (rel: string, base: string, folder: boolean) => {
    const inner = base && rel.startsWith(`${base}/`) ? rel.slice(base.length + 1) : rel;
    const first = inner.split("/")[0]!.toLowerCase();
    return SOURCE_DIRS.has(first) && (folder || inner.includes("/"));
  };

  const out = { files: new Set<string>(), folders: new Set<string>(), globs: new Set<string>() };
  const resolve = (token: string, base: string) => {
    if (isGlob(token)) {
      const rel = joinRel(base, token);
      if (rel === null || rel === "") return;
      const segs = rel.split("/");
      const firstWild = segs.findIndex(isGlob);
      const literal = segs.slice(0, firstWild).join("/");
      const last = segs[segs.length - 1]!;
      if ((literal && !sourceRel(literal, base, true) && literal !== base) || /test|spec/i.test(last)) out.globs.add(rel);
      return;
    }
    const rel = joinRel(base, token);
    if (rel === null || rel === "") return;
    for (const suf of FILE_SUFFIXES) {
      const f = rel + suf;
      if (files.has(f)) {
        if (!entries.has(f) && !sourceRel(f, base, false)) out.files.add(f);
        return;
      }
    }
    if (dirs.has(rel)) {
      const holdsEntry = [...entries].some((e) => e.startsWith(`${rel}/`));
      if (!holdsEntry && !sourceRel(rel, base, true) && rel !== base) {
        out.folders.add(rel);
        return;
      }
      for (const idx of INDEX_FILES) {
        const f = `${rel}/${idx}`;
        if (files.has(f) && !entries.has(f) && !sourceRel(f, base, false)) out.files.add(f);
      }
    }
  };

  // Commands, then the scripts they reach, breadth first.
  const seen = new Set<string>();
  const queue: Array<{ dir: string; command: string }> = commands.map((command) => ({ dir: "", command }));
  const runScripts = (dir: string, names: string[]) => {
    const o = manifests.get(dir);
    const scripts = (o?.scripts && typeof o.scripts === "object" ? o.scripts : {}) as Record<string, unknown>;
    for (const name of names) {
      const pattern = scriptNamePattern(name);
      for (const [s, cmd] of Object.entries(scripts)) {
        if (typeof cmd !== "string") continue;
        const base = s.replace(/^(pre|post)/, "");
        if (!pattern.test(s) && !(s !== base && pattern.test(base))) continue;
        const key = `${dir}\0${s}`;
        if (seen.has(key)) continue;
        seen.add(key);
        queue.push({ dir, command: cmd });
      }
    }
  };
  for (let q = 0; q < queue.length && q < 500; q++) {
    const { dir, command } = queue[q]!;
    let cwd = dir;
    for (const words of shellSegments(command)) {
      if (words[0] === "cd" && words[1]) {
        cwd = joinRel(cwd, words[1]) ?? cwd;
        continue;
      }
      const refs = segmentRefs(words);
      const target = refs.prefix ? joinRel(cwd, refs.prefix) ?? cwd : cwd;
      if (refs.names.length) {
        if (refs.workspaces) for (const d of manifests.keys()) runScripts(d, refs.names);
        else runScripts(target, refs.names);
      }
      for (const sub of refs.subcommands) queue.push({ dir: cwd, command: sub });
      words.forEach((w, idx) => {
        if (refs.consumed.has(idx)) return;
        for (const t of tokenCandidates(w)) resolve(t, cwd);
      });
    }
  }
  for (const [p, text] of Object.entries(tree.texts)) {
    if (!isManifest(p) && !isTestConfig(p)) continue;
    for (const t of configTokens(p, text)) for (const c of tokenCandidates(t)) resolve(c, posixDir(p));
  }
  return { files: [...out.files].sort(), folders: [...out.folders].sort(), globs: [...out.globs].sort() };
}

/**
 * Whether a path is test machinery the overlay restores (or, when the delivery added it, removes): a test location
 * or config by name (isTestInfraPath), or a file, folder or glob the baseline's test/build commands, their scripts or the
 * test config name (namedTestPaths).
 */
export function scriptTestMatcher(tree: BaselineTree, commands: string[]): (path: string) => boolean {
  const named = namedTestPaths(tree, commands);
  const files = new Set(named.files.map((f) => f.toLowerCase()));
  const folders = named.folders.map((f) => `${f.toLowerCase()}/`);
  const globs = named.globs.map(globRegex);
  return (path) => {
    if (isTestInfraPath(path)) return true;
    const p = path.toLowerCase();
    return files.has(p) || folders.some((f) => p.startsWith(f)) || globs.some((r) => r.test(path));
  };
}

export interface OverlayPlan {
  /** Baseline paths to check out over the delivery (it modified, retyped or deleted them). */
  restore: string[];
  /** Of `restore`, the ones the delivery deleted (absent from the delivered tree). */
  restoreDeleted: string[];
  /** Paths the delivery added at test locations. */
  remove: string[];
  /** Merged package.json texts to write. */
  manifests: Array<{ path: string; text: string; keys: string[] }>;
  /** The merged dependencies differ from the baseline's: drop the root npm lockfiles instead of restoring them. */
  dropLockfiles: boolean;
}

const ROOT_NPM_LOCKS = ["package-lock.json", "npm-shrinkwrap.json"];

/** What the overlay does, from the delivery's changes against the baseline. Committed dependencies are left to removeCommittedDependencies. */
export function planOverlay(changes: FileChange[], isInfra: (path: string) => boolean, manifestTexts: (path: string) => { baseline: string | null; delivered: string | null }): OverlayPlan {
  const plan: OverlayPlan = { restore: [], restoreDeleted: [], remove: [], manifests: [], dropLockfiles: false };
  for (const c of changes) {
    if (COMMITTED_DEPS.test(c.path)) continue;
    if (isManifest(c.path)) {
      if (c.status === "A") continue; // a new package's manifest is the delivery's own
      if (c.status === "D") {
        plan.restore.push(c.path);
        plan.restoreDeleted.push(c.path);
        continue;
      }
      const t = manifestTexts(c.path);
      if (t.baseline === null) continue;
      const merged = mergeManifest(t.baseline, t.delivered ?? "");
      if (merged.text !== null) plan.manifests.push({ path: c.path, text: merged.text, keys: merged.keys });
      if (merged.dependencyChange) plan.dropLockfiles = true;
      continue;
    }
    if (!isInfra(c.path)) continue;
    if (c.status === "A") plan.remove.push(c.path);
    else {
      plan.restore.push(c.path);
      if (c.status === "D") plan.restoreDeleted.push(c.path);
    }
  }
  if (plan.dropLockfiles) {
    plan.restore = plan.restore.filter((p) => !ROOT_NPM_LOCKS.includes(p));
    plan.restoreDeleted = plan.restoreDeleted.filter((p) => !ROOT_NPM_LOCKS.includes(p));
    plan.remove = plan.remove.filter((p) => !ROOT_NPM_LOCKS.includes(p));
  }
  return plan;
}

const capList = (xs: string[]) => (xs.length > SUMMARY_LIST_MAX ? `${xs.slice(0, SUMMARY_LIST_MAX).join(", ")} and ${xs.length - SUMMARY_LIST_MAX} more` : xs.join(", "));

/** The evd_tamper_check summary when the client's suite is in place. */
export function overlaySummary(against: string, changed: number, o: OverlayReport): string {
  const parts = [`baseline suite: ran the baseline suite from ${against} (${changed} file(s) changed)`];
  if (o.restored.length) parts.push(`restored ${capList(o.restored)}`);
  if (o.removed.length) parts.push(`removed ${capList(o.removed)}`);
  for (const m of o.manifests) parts.push(`${m.path}: kept the baseline ${m.keys.join(", ")}`);
  if (o.lockfilesDropped.length) parts.push(`dropped ${o.lockfilesDropped.join(", ")} (the delivery changes dependencies, so setup installs from package.json)`);
  if (parts.length === 1) parts.push("the delivery leaves the tests, runner config, scripts and dev dependencies as they were");
  return parts.join("; ");
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

// ---------- Baseline suite (git part) ----------

/** git's stdout+stderr, or a throw. `maxOutput`: output that does not fit is an error, never silently cut (a cut diff or file list would be misread). */
async function gitOut(args: string[], workdir: string, env: Record<string, string>, maxOutput?: number): Promise<string> {
  const r = await run(["git", ...args], workdir, env, 120_000, maxOutput ?? 200_000);
  if (r.code !== 0) throw new Error(`git ${args[0]} exited ${r.code}: ${tail(r.output, 3)}`);
  if (maxOutput !== undefined && r.truncated) throw new Error(`git ${args[0]} printed more than ${maxOutput} characters`);
  return r.output;
}

/** Cap for the file lists and the source diff the overlay and the gaming scan read in full. */
const FULL_OUTPUT_MAX = 64 * 1024 * 1024;
const SOURCE_PATHSPECS = ["*.js", "*.cjs", "*.mjs", "*.jsx", "*.ts", "*.cts", "*.mts", "*.tsx", ":(exclude,icase,glob)**/node_modules/**"];

/** The client's suite could not be put in place; passes are not trusted. */
class BaselineError extends Error {
  constructor(message: string, readonly base: string | null = null, readonly diffFrom: { from: string; against: string } | null = null) {
    super(message);
  }
}

/** Fetches the baseline commit (depth 1) unless it is already present; returns its full id or throws. */
async function fetchBaseline(workdir: string, repoUrl: string, baseline: string, env: Record<string, string>): Promise<string> {
  if (!COMMIT_ID.test(baseline)) throw new BaselineError(`baseline ${JSON.stringify(baseline.slice(0, 80))} is not a commit id`);
  const present = await run(["git", "cat-file", "-e", `${baseline}^{commit}`], workdir, env, 30_000);
  if (present.code !== 0) {
    const r = await run(["git", "fetch", "-q", "--depth", "1", repoUrl, baseline], workdir, env, 120_000);
    if (r.code !== 0) throw new BaselineError(`baseline ${baseline.slice(0, 12)} could not be fetched (git fetch exited ${r.code}${r.timedOut ? ", timed out" : ""})`);
  }
  const resolved = await run(["git", "rev-parse", "--verify", "-q", `${baseline}^{commit}`], workdir, env, 30_000);
  if (resolved.code !== 0) throw new BaselineError(`baseline ${baseline.slice(0, 12)} is not reachable in the repository`);
  return resolved.output.trim();
}

/** The first parent, or null for a root commit. Throws when the parent was not fetched. */
async function firstParent(workdir: string, sha: string, env: Record<string, string>): Promise<string | null> {
  const shallow = await readFile(join(workdir, ".git", "shallow"), "utf8").catch(() => "");
  if (shallow.split("\n").some((l) => l.trim() === sha)) throw new BaselineError("the parent commit was not fetched");
  const [, parent] = (await gitOut(["rev-list", "--parents", "-n", "1", sha], workdir, env)).trim().split(/\s+/);
  return parent ?? null;
}

interface Overlay extends OverlayReport {
  base: string;
  against: string;
  changed: number;
  /** Restored paths the delivered tree does not have: deleted again when the delivery is shown. */
  restoreDeleted: string[];
  infra: (path: string) => boolean;
}

const commandOf = (c: CriterionSpec) => String(c.spec.command ?? (c.kind === "test" ? "npm test" : "npm run build"));
const touched = (o: OverlayReport) => o.restored.length + o.removed.length + o.manifests.length + o.lockfilesDropped.length > 0;

/** Resolves the baseline, then makes the checkout run the client's suite (see the header). Throws BaselineError. */
async function applyBaselineOverlay(workdir: string, head: string, env: Record<string, string>, input: DeterministicInput): Promise<Overlay> {
  let base: string | null;
  let against: string;
  if (input.baselineSha) {
    base = await fetchBaseline(workdir, input.repoUrl, input.baselineSha, env);
    against = `the ${input.baselineSource ?? "recorded"} baseline ${base.slice(0, 12)}`;
  } else {
    base = await firstParent(workdir, head, env);
    if (!base) {
      // Still give the judge the whole commit as evd_diff.
      const empty = (await gitOut(["hash-object", "-t", "tree", "/dev/null"], workdir, env).catch(() => "")).trim();
      throw new BaselineError("the delivered commit has no parent and no baseline was recorded, so there is no client suite to run", null, empty ? { from: empty, against: "the empty tree (root commit, no baseline recorded)" } : null);
    }
    against = `the first parent ${base.slice(0, 12)} only (no baseline recorded for this milestone or pull request, so earlier merges are not covered)`;
  }
  const diffFrom = { from: base, against };
  const fail = (what: string, e: unknown) => new BaselineError(`${what} (${(e as Error).message})`, base, diffFrom);
  const show = async (rev: string, path: string) => {
    const r = await run(["git", "show", `${rev}:${path}`], workdir, env, 60_000);
    return r.code === 0 ? r.output : null;
  };

  let changes: FileChange[];
  let tree: BaselineTree;
  const delivered: Record<string, string | null> = {};
  try {
    const paths = (await gitOut(["ls-tree", "-r", "-z", "--name-only", base], workdir, env, FULL_OUTPUT_MAX)).split("\0").filter((p) => p && !COMMITTED_DEPS.test(p));
    tree = { paths, texts: {} };
    for (const p of paths) {
      if (!isManifest(p) && !isTestConfig(p)) continue;
      const t = await show(base, p);
      if (t !== null) tree.texts[p] = t;
    }
    changes = parseNameStatus(await gitOut(["diff", "--name-status", "--no-renames", "-z", base, head], workdir, env, FULL_OUTPUT_MAX));
    for (const c of changes) if (isManifest(c.path) && (c.status === "M" || c.status === "T") && !COMMITTED_DEPS.test(c.path)) delivered[c.path] = await show(head, c.path);
  } catch (e) {
    throw fail(`could not diff against ${against}`, e);
  }
  const infra = scriptTestMatcher(tree, input.criteria.filter((c) => c.kind === "test" || c.kind === "build").map(commandOf));
  const plan = planOverlay(changes, infra, (p) => ({ baseline: tree.texts[p] ?? null, delivered: delivered[p] ?? null }));

  const lockfilesDropped: string[] = [];
  try {
    for (const p of plan.remove) await rm(join(workdir, p), { force: true });
    // A path the delivery turned into a folder (or a symlink) is cleared before the baseline file goes back.
    for (const p of plan.restore) {
      const st = await lstat(join(workdir, p)).catch(() => null);
      if (st && !st.isFile()) await rm(join(workdir, p), { recursive: true, force: true });
    }
    for (let i = 0; i < plan.restore.length; i += 100) {
      const chunk = plan.restore.slice(i, i + 100);
      const r = await run(["git", "checkout", "-q", base, "--", ...chunk], workdir, { ...env, GIT_LITERAL_PATHSPECS: "1" }, 60_000);
      if (r.code !== 0) throw new Error(`git checkout exited ${r.code}: ${tail(r.output, 3)}`);
    }
    for (const m of plan.manifests) {
      // Never write through a delivered symlink.
      await rm(join(workdir, m.path), { force: true });
      await mkdir(dirname(join(workdir, m.path)), { recursive: true });
      await writeFile(join(workdir, m.path), m.text);
    }
    if (plan.dropLockfiles) {
      for (const p of ROOT_NPM_LOCKS) {
        if (await access(join(workdir, p)).then(() => true, () => false)) {
          await rm(join(workdir, p), { force: true });
          lockfilesDropped.push(p);
        }
      }
    }
  } catch (e) {
    // Back to the delivered tree before anything runs: a half-applied overlay is neither suite.
    await run(["git", "reset", "-q", "--hard", head], workdir, env, 60_000);
    await run(["git", "clean", "-q", "-f", "-d", "-x"], workdir, env, 60_000);
    throw fail("could not put the client's suite in place", e);
  }
  return {
    base,
    against,
    changed: changes.length,
    restored: plan.restore,
    restoreDeleted: plan.restoreDeleted,
    removed: plan.remove,
    manifests: plan.manifests.map((m) => ({ path: m.path, keys: m.keys })),
    lockfilesDropped,
    infra,
  };
}

/**
 * Puts the delivered files back after the graded run (the overlay undone, and anything the run rewrote), leaving
 * installed and committed dependencies alone: for the informational pass and for the judge's read_file.
 */
async function showDelivery(workdir: string, head: string, env: Record<string, string>, overlay: Overlay): Promise<void> {
  for (const p of overlay.restoreDeleted) await rm(join(workdir, p), { recursive: true, force: true });
  await gitOut(["checkout", "-q", "-f", head, "--", ".", ":(exclude,icase,glob)**/node_modules/**", ":(exclude,icase,glob)**/.bin/**"], workdir, env);
}

/** Runs the gaming scan on the delivery's diff against the baseline. */
async function gamingScan(workdir: string, head: string, env: Record<string, string>, overlay: Overlay): Promise<GamingHit[]> {
  // Source files only; all of it or an error (the stage then distrusts passes), never a silently cut diff.
  const patch = await gitOut(["diff", "--no-color", "--no-renames", "--no-ext-diff", overlay.base, head, "--", ...SOURCE_PATHSPECS], workdir, env, FULL_OUTPUT_MAX);
  const grep = await run(["git", "grep", "-l", "-I", "-F", "process.exit", overlay.base, "--"], workdir, env, 60_000, FULL_OUTPUT_MAX);
  const exits = grep.code === 0 ? grep.output.split("\n").filter(Boolean).map((l) => l.replace(`${overlay.base}:`, "")) : [];
  return scanForGaming(patch, { skip: (p) => overlay.infra(p) || COMMITTED_DEPS.test(p), baselineExits: exits });
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
 * unclear), it never fails the stage. `from` is the baseline; without one the commit's own
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

/** Evidence items for gaming hits on one criterion, capped at GAMING_MAX_ITEMS. */
export function gamingEvidence(criterionId: string, hits: GamingHit[]): EvidenceSummary[] {
  const shown = hits.slice(0, GAMING_MAX_ITEMS);
  return shown.map((h, i) => {
    const more = i === shown.length - 1 && hits.length > shown.length ? ` (and ${hits.length - shown.length} more hit(s))` : "";
    return {
      id: `evd_gaming_${criterionId}_${i + 1}`,
      criterion_id: criterionId,
      kind: "diff" as const,
      status: "unclear" as const,
      summary: `gaming scan: ${describeHit(h)}${more}; the delivered source reacts to the test run itself, so a passing result is not trusted and the client decides`,
    };
  });
}

export async function runDeterministicStage(input: DeterministicInput): Promise<DeterministicOutput> {
  const workdir = await mkdtemp(join(tmpdir(), "milestone-verify-"));
  // The realpath is taken now: the error path below removes the workdir before scrubbing.
  const roots = [workdir, await realpath(workdir).catch(() => workdir)];
  const scrub = (s: string) => stripRoots(s, roots);
  const env = { ...CLEAN_ENV, HOME: workdir };
  const logs: Record<string, string> = {};
  const evidence: EvidenceSummary[] = [];
  /** Records one item and reports it (scrubbed) to onEvidence before the next check runs. */
  const record = async (...items: EvidenceSummary[]) => {
    for (const item of items) {
      evidence.push(item);
      if (input.onEvidence) await input.onEvidence(scrubEvidence([item], roots)[0]!);
    }
  };
  try {
    if (!COMMIT_ID.test(input.sha)) throw new Error(`delivered sha ${JSON.stringify(input.sha.slice(0, 80))} is not a commit id`);
    await run(["git", "init", "-q"], workdir, env, 30_000);
    // Depth 2: the merge commit and its first parent, the baseline when none was recorded.
    const fetched = await run(["git", "fetch", "-q", "--depth", "2", input.repoUrl, input.sha], workdir, env, 120_000);
    if (fetched.code !== 0) throw new Error(`git fetch exited ${fetched.code}${fetched.timedOut ? " (timed out)" : ""}`);
    const checkedOut = await run(["git", "checkout", "-q", "FETCH_HEAD"], workdir, env, 30_000);
    if (checkedOut.code !== 0) throw new Error(`git checkout exited ${checkedOut.code}`);
    const head = (await gitOut(["rev-parse", "HEAD"], workdir, env)).trim();

    let overlay: Overlay | null = null;
    let untrusted: string | null = null;
    let baseline: string | null = null;
    let diffFrom: { from: string; against: string } | null = null;
    let gaming: GamingHit[] = [];
    try {
      overlay = await applyBaselineOverlay(workdir, head, env, input);
      baseline = overlay.base;
      diffFrom = { from: overlay.base, against: overlay.against };
      await record({ id: TAMPER_EVIDENCE_ID, kind: "diff", status: "pass", summary: overlaySummary(overlay.against, overlay.changed, overlay) });
    } catch (e) {
      const msg = (e as Error).message;
      untrusted = e instanceof BaselineError ? msg : `could not put the client's suite in place (${msg})`;
      if (e instanceof BaselineError) {
        baseline = e.base;
        diffFrom = e.diffFrom;
      }
      await record({ id: TAMPER_EVIDENCE_ID, kind: "diff", status: "unclear", summary: `baseline suite: ${untrusted}; the delivery's own tests run instead and a pass is not trusted` });
    }
    if (overlay) {
      try {
        gaming = await gamingScan(workdir, head, env, overlay);
      } catch (e) {
        // No scan, no trust: the same rule as a missing baseline.
        untrusted = `the gaming scan could not read the diff (${(e as Error).message})`;
      }
    }
    await record(...(await contextEvidence(workdir, head, env, diffFrom, input.pullRequest)));
    // With no test or build criterion there is no pass to distrust; the hits are still shown.
    if (gaming.length && !input.criteria.some((c) => c.kind === "test" || c.kind === "build")) {
      await record(...gamingEvidence("delivery", gaming).map(({ criterion_id: _, ...e }) => e));
    }

    // Whatever the diff says, committed dependencies never run: npm run puts node_modules/.bin first on PATH.
    const removed = await removeCommittedDependencies(workdir);
    if (removed.length) logs["setup:remove-committed-node_modules"] = removed.join("\n");

    for (const cmd of input.setup ?? []) {
      const r = await run(cmd, workdir, env, input.timeoutMs ?? 300_000);
      logs[`setup:${cmd.join(" ")}`] = r.output;
      if (r.code !== 0) throw new Error(`setup failed: ${cmd.join(" ")}`);
    }

    // Gaming hits land on the test criteria (the build ones when there is no test criterion).
    const commandCriteria = input.criteria.filter((c) => c.kind === "test" || c.kind === "build");
    const gamingTargets = new Set((commandCriteria.some((c) => c.kind === "test") ? commandCriteria.filter((c) => c.kind === "test") : commandCriteria).map((c) => c.id));
    const overlaid = new Set(overlay ? [...overlay.restored, ...overlay.removed] : []);
    const fileExists = async (path: string) => {
      const rel = path.replace(/^\.\//, "").replace(/\/+$/, "");
      const inCommit = rel !== "" && (await run(["git", "cat-file", "-e", `${head}:${rel}`], workdir, env, 30_000)).code === 0;
      // The graded run may have restored or removed it; the delivered commit says whether it was delivered.
      if (overlaid.has(rel)) return inCommit;
      return inCommit || (await access(join(workdir, path)).then(() => true, () => false));
    };

    for (const c of input.criteria) {
      if (c.kind === "test" || c.kind === "build") {
        const command = commandOf(c);
        const r = await run(["sh", "-c", command], workdir, env, input.timeoutMs ?? 300_000);
        logs[c.id] = r.output;
        const ran = `${command} exited ${r.code}${r.timedOut ? " (timed out)" : ""}`;
        const status = r.timedOut ? "unclear" : r.code === 0 ? "pass" : "fail";
        if (untrusted) {
          // No client suite ran (or the scan could not), so a pass proves nothing; a fail still fails.
          await record({ id: `evd_${c.id}`, criterion_id: c.id, kind: "log", status: status === "pass" ? "unclear" : status, summary: status === "pass" ? `baseline suite: ${ran}, but the result is not trusted: ${untrusted}` : `${ran}; last lines:\n${tail(r.output)}`, sha256: sha256(r.output) });
          continue;
        }
        const item: EvidenceSummary = { id: `evd_${c.id}`, criterion_id: c.id, kind: "log", status, summary: `${ran} with the client's baseline suite; last lines:\n${tail(r.output)}`, sha256: sha256(r.output) };
        const hits = gamingTargets.has(c.id) ? gamingEvidence(c.id, gaming) : [];
        // enforce() keeps the last item with a status per criterion: a gaming hit overrules a pass, never a fail.
        if (status === "fail") await record(...hits, item);
        else await record(item, ...hits);
      } else if (c.kind === "file") {
        const path = String(c.spec.path ?? "");
        const exists = await fileExists(path);
        await record({ id: `evd_${c.id}`, criterion_id: c.id, kind: "file", status: exists ? "pass" : "fail", summary: `${path} ${exists ? "present" : "missing"}` });
      }
    }

    // The delivery's own tests, as delivered: shown to the client, never decide (no status, no criterion).
    if (overlay && touched(overlay)) {
      const tests = input.criteria.filter((c) => c.kind === "test");
      try {
        await showDelivery(workdir, head, env, overlay);
        for (const c of tests) {
          const command = commandOf(c);
          const r = await run(["sh", "-c", command], workdir, env, input.timeoutMs ?? 300_000);
          logs[`${c.id}:delivered`] = r.output;
          await record({ id: `evd_${c.id}_delivered`, kind: "log", summary: `informational, does not decide: ${command} with the delivery's own tests, scripts and test config (${c.id}) exited ${r.code}${r.timedOut ? " (timed out)" : ""}; last lines:\n${tail(r.output)}`, sha256: sha256(r.output) });
        }
        // Anything the delivered tests rewrote goes back too, so read_file shows the delivery.
        if (tests.length) await showDelivery(workdir, head, env, overlay);
      } catch (e) {
        // Informational only: the graded results above stand.
        logs["informational"] = `could not show the delivered tree: ${(e as Error).message}`;
      }
    }

    return {
      evidence: scrubEvidence(evidence, roots),
      logs: Object.fromEntries(Object.entries(logs).map(([k, v]) => [k, scrub(v)])),
      workdir,
      overlay: overlay ? { restored: overlay.restored, removed: overlay.removed, manifests: overlay.manifests, lockfilesDropped: overlay.lockfilesDropped } : null,
      untrusted: untrusted === null ? null : scrub(untrusted),
      gaming,
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

/** Runs a command; `output` is stdout+stderr, keeping the last `maxOutput` characters (`truncated` says when it cut). */
export function run(cmd: string[], cwd: string, env: Record<string, string>, timeoutMs: number, maxOutput = 200_000): Promise<{ code: number | null; output: string; timedOut: boolean; truncated: boolean }> {
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
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, output: output.slice(-maxOutput), timedOut, truncated: output.length > maxOutput }); });
  });
}

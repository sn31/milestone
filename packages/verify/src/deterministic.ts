/**
 * Deterministic stage, no model: check out the merge commit in a throwaway directory with no secrets
 * in its environment, run build and test commands with a time limit, check required files.
 *
 * Tamper check: the delivery is written by the payee, so a passing `npm test` only means something when the
 * delivery did not change what `npm test` runs. Before running commands we diff the merge commit against its
 * first parent; if it modifies or deletes package.json scripts, existing tests, CI config, or touches test-runner
 * or package-manager config, a passing test/build result is recorded as "unclear" (a failing one still fails:
 * tampering can only fake a pass). Added files (new tests, new source) are fine.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CriterionSpec, EvidenceSummary } from "@milestone/core";

export interface DeterministicInput {
  repoUrl: string;
  sha: string;
  criteria: CriterionSpec[];
  timeoutMs?: number;
  /** e.g. ["pnpm", "install", "--frozen-lockfile"]; run once before the criteria. */
  setup?: string[][];
}

export interface DeterministicOutput {
  evidence: EvidenceSummary[];
  logs: Record<string, string>;
  workdir: string;
  /** What the tamper check found; empty when the delivery leaves the test machinery alone. */
  tampering: string[];
}

const CLEAN_ENV = { PATH: process.env.PATH ?? "", CI: "1", NODE_ENV: "test", HOME: "" };

export const TAMPER_EVIDENCE_ID = "evd_tamper_check";

// ---------- Tamper check (pure part, unit-tested) ----------

export interface FileChange {
  /** git --name-status letter: A, M, D, T, ... (renames are disabled, so a rename is D + A). */
  status: string;
  path: string;
  /** package.json only: the file's text in the parent and in the delivery (null when absent). */
  before?: string | null;
  after?: string | null;
}

const TEST_PATHS = [/(^|\/)(test|tests|__tests__|spec)\//, /\.(test|spec)\.[cm]?[jt]sx?$/, /(^|\/)__snapshots__\//];
const CI_PATHS = [/^\.github\/(workflows|actions)\//, /^\.gitlab-ci\.ya?ml$/, /^\.circleci\//, /^\.travis\.ya?ml$/, /^azure-pipelines\.ya?ml$/, /^Jenkinsfile$/, /^\.buildkite\//, /^bitbucket-pipelines\.ya?ml$/];
/** Config that changes what a test command does even when it is only added (e.g. an .npmrc with script-shell). */
const RUNNER_CONFIG = [
  /(^|\/)(vitest|vite|jest|playwright|karma|cypress|ava|mocha)\.config\.[cm]?[jt]s(on)?$/,
  /(^|\/)\.mocharc(\.[a-z]+)?$/,
  /(^|\/)(\.npmrc|\.yarnrc|\.yarnrc\.yml|\.pnpmfile\.cjs|bunfig\.toml)$/,
];
/** package.json keys that decide what test and build commands run. */
const MANIFEST_KEYS = ["scripts", "jest", "mocha", "ava"] as const;

export const isTestPath = (p: string) => TEST_PATHS.some((r) => r.test(p));
export const isCiPath = (p: string) => CI_PATHS.some((r) => r.test(p));
const isRunnerConfig = (p: string) => RUNNER_CONFIG.some((r) => r.test(p));
const isManifest = (p: string) => p === "package.json" || p.endsWith("/package.json");

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
export function findTampering(changes: FileChange[]): string[] {
  const out: string[] = [];
  for (const c of changes) {
    const verb = VERB[c.status] ?? `changed (${c.status})`;
    if (isManifest(c.path)) {
      if (c.status === "A") continue; // a new package.json changes no existing scripts
      const keys = manifestChanges(c.before, c.status === "D" ? null : c.after);
      if (keys.length) out.push(`${c.path} ${c.status === "D" ? "deleted" : `${keys.join(", ")} changed`}`);
    } else if (isRunnerConfig(c.path)) {
      out.push(`${c.path} ${verb} (test runner or package manager config)`);
    } else if (c.status !== "A" && isTestPath(c.path)) {
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
  base: string;
}

async function gitOut(args: string[], workdir: string, env: Record<string, string>): Promise<string> {
  const r = await run(["git", ...args], workdir, env, 60_000);
  if (r.code !== 0) throw new Error(`git ${args[0]} exited ${r.code}: ${tail(r.output, 3)}`);
  return r.output;
}

/** Diffs the delivered commit against its first parent. Throws when the parent cannot be determined. */
async function tamperCheck(workdir: string, sha: string, env: Record<string, string>): Promise<TamperResult> {
  const shallow = await readFile(join(workdir, ".git", "shallow"), "utf8").catch(() => "");
  if (shallow.split("\n").some((l) => l.trim() === sha)) throw new Error("the parent commit was not fetched");
  const [, parent] = (await gitOut(["rev-list", "--parents", "-n", "1", sha], workdir, env)).trim().split(/\s+/);
  // A root commit adds everything; compare against the empty tree.
  const base = parent ?? (await gitOut(["hash-object", "-t", "tree", "/dev/null"], workdir, env)).trim();
  const raw = await gitOut(["diff", "--name-status", "--no-renames", "-z", base, sha], workdir, env);
  const changes: FileChange[] = parseNameStatus(raw);
  const show = async (rev: string, path: string) => {
    const r = await run(["git", "show", `${rev}:${path}`], workdir, env, 60_000);
    return r.code === 0 ? r.output : null;
  };
  for (const c of changes) {
    if (!isManifest(c.path) || c.status === "A") continue;
    c.before = await show(base, c.path);
    c.after = c.status === "D" ? null : await show(sha, c.path);
  }
  return { findings: findTampering(changes), changed: changes.length, base: parent ?? "(root commit)" };
}

// ---------- Stage ----------

export async function runDeterministicStage(input: DeterministicInput): Promise<DeterministicOutput> {
  const workdir = await mkdtemp(join(tmpdir(), "milestone-verify-"));
  const env = { ...CLEAN_ENV, HOME: workdir };
  const logs: Record<string, string> = {};
  const evidence: EvidenceSummary[] = [];
  try {
    await run(["git", "init", "-q"], workdir, env, 30_000);
    // Depth 2: the merge commit and its first parent, for the tamper check.
    const fetched = await run(["git", "fetch", "-q", "--depth", "2", input.repoUrl, input.sha], workdir, env, 120_000);
    if (fetched.code !== 0) throw new Error(`git fetch exited ${fetched.code}${fetched.timedOut ? " (timed out)" : ""}`);
    const checkedOut = await run(["git", "checkout", "-q", "FETCH_HEAD"], workdir, env, 30_000);
    if (checkedOut.code !== 0) throw new Error(`git checkout exited ${checkedOut.code}`);
    const head = (await gitOut(["rev-parse", "HEAD"], workdir, env)).trim();

    let tampering: string[];
    try {
      const t = await tamperCheck(workdir, head, env);
      tampering = t.findings;
      evidence.push({
        id: TAMPER_EVIDENCE_ID,
        kind: "diff",
        status: tampering.length ? "unclear" : "pass",
        summary: tampering.length
          ? `tamper check: the delivery changes what the test/build commands run: ${tampering.join("; ")}`
          : `tamper check: ${t.changed} file(s) changed against ${t.base.slice(0, 12)}; no package.json scripts, existing tests, CI or runner config modified`,
      });
    } catch (e) {
      tampering = [`could not diff against the parent commit (${(e as Error).message})`];
      evidence.push({ id: TAMPER_EVIDENCE_ID, kind: "diff", status: "unclear", summary: `tamper check: ${tampering[0]}` });
    }

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
          evidence.push({ id: `evd_${c.id}`, criterion_id: c.id, kind: "log", status: "unclear", summary: `tamper check: ${ran}, but the result is not trusted because the delivery changes ${tampering.join("; ")}`, sha256: sha256(r.output) });
        } else {
          evidence.push({ id: `evd_${c.id}`, criterion_id: c.id, kind: "log", status, summary: `${ran}; last lines:\n${tail(r.output)}`, sha256: sha256(r.output) });
        }
      } else if (c.kind === "file") {
        const path = String(c.spec.path ?? "");
        const exists = await access(join(workdir, path)).then(() => true, () => false);
        evidence.push({ id: `evd_${c.id}`, criterion_id: c.id, kind: "file", status: exists ? "pass" : "fail", summary: `${path} ${exists ? "present" : "missing"}` });
      }
    }
    return { evidence, logs, workdir, tampering };
  } catch (e) {
    await rm(workdir, { recursive: true, force: true });
    throw e;
  }
}

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
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

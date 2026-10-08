/**
 * Read-only access to a delivered commit's checkout, handed to the judgment stage.
 * Every path is resolved under the workdir (symlinks included); nothing here writes or runs delivered code.
 */
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { EvidenceSummary } from "@milestone/core";
import { run, type EvidenceReader } from "@milestone/verify";

export const MAX_TEXT = 100_000;

function gitEnv(workdir: string): Record<string, string> {
  return { PATH: process.env.PATH ?? "", HOME: workdir, GIT_TERMINAL_PROMPT: "0" };
}

function bound(text: string, max = MAX_TEXT): string {
  return text.length > max ? `${text.slice(0, max)}\n[truncated at ${max} characters]` : text;
}

function inside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/** Resolves `path` under `workdir`, refusing traversal, absolute paths, symlink escapes and the .git directory. */
export async function safePath(workdir: string, path: string): Promise<string> {
  const root = await realpath(workdir);
  const candidate = resolve(root, path);
  if (!inside(root, candidate)) throw new Error(`path outside the delivery: ${path}`);
  const real = await realpath(candidate).catch(() => { throw new Error(`no such file: ${path}`); });
  if (!inside(root, real)) throw new Error(`path outside the delivery: ${path}`);
  const rel = relative(root, real);
  if (rel === ".git" || rel.startsWith(`.git${sep}`)) throw new Error(`path not readable: ${path}`);
  return real;
}

/** Runs a git command in the workdir with no secrets in the environment; returns stdout+stderr or throws. */
export async function git(workdir: string, args: string[], timeoutMs = 60_000): Promise<string> {
  const r = await run(["git", ...args], workdir, gitEnv(workdir), timeoutMs);
  if (r.code !== 0) throw new Error(`git ${args[0]} exited ${r.code}${r.timedOut ? " (timed out)" : ""}`);
  return r.output;
}

export interface ReaderInput {
  workdir: string | null;
  sha: string;
  repoUrl: string;
  evidence: EvidenceSummary[];
}

export function createEvidenceReader(input: ReaderInput): EvidenceReader {
  let diff: Promise<string> | null = null;
  return {
    async readFile(path) {
      if (!input.workdir) return "the delivery could not be checked out, no files are available";
      const real = await safePath(input.workdir, path);
      const s = await stat(real);
      if (s.isDirectory()) throw new Error(`${path} is a directory`);
      const buf = await readFile(real);
      return bound(buf.subarray(0, MAX_TEXT * 4).toString("utf8"));
    },
    getDiff() {
      const workdir = input.workdir;
      if (!workdir) return Promise.resolve("the delivery could not be checked out, no diff is available");
      diff ??= (async () => {
        // The deterministic stage fetched depth 1; deepen by one so the diff is against the parent, best effort.
        await git(workdir, ["fetch", "-q", "--depth", "2", input.repoUrl, input.sha], 120_000).catch(() => "");
        return bound(await git(workdir, ["show", "--stat", "-p", "--no-color", input.sha]));
      })();
      return diff;
    },
    async listEvidence() {
      return input.evidence;
    },
    async viewScreenshot() {
      return "no screenshot";
    },
  };
}

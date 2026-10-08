/** Worker directories that live under the repository root (uploads, the npm cache), resolved the same way everywhere. */
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

/**
 * The directory holding pnpm-workspace.yaml, found by walking up from `cwd` (the web app and the worker run from
 * different directories); `cwd` itself when there is none.
 */
export function repoRoot(cwd = process.cwd()): string {
  let dir = resolve(cwd);
  for (;;) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const up = dirname(dir);
    if (up === dir) return resolve(cwd);
    dir = up;
  }
}

/** `value` when it is absolute, else `value` (or `fallback` when unset) resolved against the repository root. */
export function repoPath(value: string | undefined, fallback: string, cwd = process.cwd()): string {
  if (value && isAbsolute(value)) return value;
  return resolve(repoRoot(cwd), value || fallback);
}

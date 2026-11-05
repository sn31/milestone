import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { paypalMode, resetSimulator } from "@milestone/money";
import { uploadRoot } from "@milestone/verify";
import { RESET_INTERVAL_S } from "../_demo";

/** The monorepo root: the nearest directory at or above `from` holding pnpm-workspace.yaml. */
export function repoRoot(from: string = process.cwd()): string | null {
  // The walk is a run-time lookup, not something to bundle: keep Turbopack from tracing the whole project.
  for (let dir = resolve(/*turbopackIgnore: true*/ from); ; dir = dirname(dir)) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    if (dirname(dir) === dir) return null;
  }
}

/**
 * One reset at a time and at most one per RESET_INTERVAL_S per instance. `claim` returns 0 when the caller may reset
 * now (and records the attempt), otherwise the seconds left to wait.
 */
export function createLimiter(intervalS: number = RESET_INTERVAL_S) {
  let last = -Infinity;
  return {
    claim(now: number = Date.now()): number {
      const wait = Math.ceil((last + intervalS * 1000 - now) / 1000);
      if (wait > 0) return wait;
      last = now;
      return 0;
    },
  };
}

/**
 * Removes everything inside the upload directory (UPLOAD_DIR, see uploadRoot), keeping the directory itself (on Render it
 * sits on the persistent disk). A missing directory is fine. Returns how many entries were removed.
 */
export async function clearUploads(root: string = uploadRoot()): Promise<number> {
  const entries = await readdir(root).catch((e: NodeJS.ErrnoException) => {
    if (e.code === "ENOENT") return [] as string[];
    throw e;
  });
  for (const name of entries) await rm(join(root, name), { recursive: true, force: true });
  return entries.length;
}

/**
 * Empties the PayPal simulator's state (SIMULATED_PAYPAL_STATE_FILE, or var/simulated-paypal.json) after a reseed: the
 * orders, captures, payouts and vault tokens it holds belong to rows the reset truncated. Done through the simulator's
 * own reset, under its cross-process lock, so the worker re-reads the empty state on its next call instead of keeping a
 * cached copy. Nothing the showcase needs lives there: its PayPal ids are display data, and Casey's saved PayPal
 * (pm_show_casey, vault id SIM-PMT-SHOW...) is a database row that the simulator adopts on first use. Only in simulated
 * mode; returns whether it cleared anything.
 */
export function clearSimulator(env: NodeJS.ProcessEnv = process.env): boolean {
  if (paypalMode(env) !== "simulated") return false;
  resetSimulator();
  return true;
}

/**
 * Re-seeds the showcase: the core seed with --reset --showcase (every table truncated, then the demo rebuilt).
 * --reset-files is not passed (it resolves var/ in the repo, not the hosted paths): the route clears the simulator state
 * with clearSimulator and the uploads with clearUploads, so neither outlives the rows it belonged to.
 * Runs the seed as its own process, the way `pnpm db:seed` does, because the seed is a script that exits when done.
 */
export function runShowcaseSeed(env: NodeJS.ProcessEnv = process.env): Promise<{ ok: true } | { ok: false; error: string }> {
  const root = repoRoot();
  if (!root) return Promise.resolve({ ok: false, error: "repository root not found" });
  const tsx = join(root, "node_modules/tsx/dist/cli.mjs");
  if (!existsSync(tsx)) return Promise.resolve({ ok: false, error: "tsx is not installed" });
  return new Promise((done) => {
    execFile(process.execPath, [tsx, "src/seed.ts", "--reset", "--showcase"], { cwd: join(root, "packages/core"), env, timeout: 120_000, maxBuffer: 1 << 20 }, (err, _stdout, stderr) => {
      // stdout carries the showcase agent's bearer token: it is never logged or returned from here.
      if (err) done({ ok: false, error: `seed failed: ${(stderr || err.message).trim().split("\n").slice(-3).join(" ")}` });
      else done({ ok: true });
    });
  });
}

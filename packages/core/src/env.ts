/** Process environment helpers shared by web, worker and scripts. */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ---------- Repo-root .env ----------

const ENV_STATE = Symbol.for("milestone.rootEnv");
const g = globalThis as typeof globalThis & { [ENV_STATE]?: { path: string | null } };

/** The monorepo root: the nearest directory at or above `from` holding pnpm-workspace.yaml. */
function findRepoRoot(from: string): string | null {
  for (let dir = resolve(from); ; dir = dirname(dir)) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    if (dirname(dir) === dir) return null;
  }
}

/** packages/core/src -> repo root, when this module has a file URL (tsx, vitest, Node). */
function packageRoot(): string | null {
  try {
    return resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  } catch {
    return null; // bundled without a file URL
  }
}

/**
 * Loads the monorepo's one .env (next to pnpm-workspace.yaml, found from the cwd, else from this package's path)
 * into process.env. Never overrides a variable that is already set (process.loadEnvFile semantics). Idempotent: only
 * the first call reads the file. Returns the path loaded, or null when there is none.
 */
export function loadRootEnv(): string | null {
  const done = g[ENV_STATE];
  if (done) return done.path;
  const state: { path: string | null } = { path: null };
  g[ENV_STATE] = state;
  const roots = [findRepoRoot(process.cwd()), packageRoot()].filter((r): r is string => r !== null);
  for (const root of roots) {
    const file = join(root, ".env");
    if (!existsSync(file)) continue;
    try {
      process.loadEnvFile(file);
      state.path = file;
    } catch {
      // unreadable .env: callers fall back to whatever process.env already has
    }
    break;
  }
  return state.path;
}

// ---------- PayPal mode ----------

export type PayPalMode = "simulated" | "sandbox";

/** PAYPAL_MODE wins; unset or empty, simulated when there are no PayPal credentials outside production. */
export function paypalMode(env: NodeJS.ProcessEnv = process.env): PayPalMode {
  const explicit = env.PAYPAL_MODE?.trim().toLowerCase();
  if (explicit === "simulated") return "simulated";
  if (explicit === "sandbox" || explicit === "live" || explicit === "paypal") return "sandbox";
  if (!env.PAYPAL_CLIENT_ID && env.NODE_ENV !== "production") return "simulated";
  return "sandbox";
}

/**
 * Where a payout to this user goes: their PayPal email, or in simulated mode (local demo, no sandbox accounts) the
 * account email. null when there is no user or no receiver.
 */
export function payoutReceiver(user: { paypalEmail: string | null; email: string } | null | undefined, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!user) return null;
  return user.paypalEmail ?? (paypalMode(env) === "simulated" ? user.email : null);
}

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

/**
 * An env var's trimmed value, or undefined when it is unset or blank. `cp .env.example .env` loads every `NAME=` line
 * as "", which a plain `??` passes straight through; read optional settings with this instead.
 */
export function envOr(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const v = env[name]?.trim();
  return v ? v : undefined;
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
  return user.paypalEmail?.trim() || (paypalMode(env) === "simulated" ? user.email : null);
}

// ---------- Seed defaults ----------

/** The demo users' PayPal emails: the configured ones, else in simulated mode their account emails, else none. */
export function seedPaypalEmails(env: NodeJS.ProcessEnv = process.env): { freelancer: string | null; partner: string | null } {
  const simulated = paypalMode(env) === "simulated";
  return {
    freelancer: envOr("PAYPAL_FREELANCER_EMAIL", env) ?? envOr("SPIKE_FREELANCER_EMAIL", env) ?? (simulated ? "freelancer@milestone.test" : null),
    partner: envOr("PAYPAL_PARTNER_EMAIL", env) ?? (simulated ? "partner@milestone.test" : null),
  };
}

/**
 * The model id the showcase seed stamps on every verdict it writes. Those verdicts are recorded by hand, not produced by
 * a model, so they carry this marker whether or not a Claude key is set (the UI labels them "recorded for the showcase").
 */
export const RECORDED_VERDICT_MODEL = "recorded-showcase";

// ---------- Simulator ids on the real sandbox ----------

/** Every id the PayPal simulator mints, and every PayPal id the showcase seed writes, starts with this. */
export const SIMULATOR_ID_PREFIX = "SIM-";

/**
 * The shape of a simulator id: "SIM-" and upper-case letters, digits and dashes (orders, captures, batches, items,
 * vault tokens, customers), or a simulated dispute ("PP-D-SIM..."). Strict on purpose, so a title such as "SIM card
 * shop" is not mistaken for one.
 */
export const SIMULATOR_ID_RE = /^(?:SIM-[A-Z0-9][A-Z0-9-]*|PP-D-SIM[A-Z0-9]+)$/;

/** True for an id the simulator (or the showcase seed) made up: PayPal's sandbox has never seen it. */
export function isSimulatorId(id: unknown): id is string {
  return typeof id === "string" && SIMULATOR_ID_RE.test(id);
}

/**
 * A milestone whose funding (order or capture) carries simulator ids while this process talks to the real PayPal
 * sandbox: rows the showcase seed recorded for display. Nothing may act on it there (a refund of a capture PayPal never
 * made, a payout backed by money that was never captured), so routes refuse, jobs stop before PayPal is called and the
 * page shows it as recorded. Never true in simulated mode, where those ids are the simulator's own.
 */
export function recordedForShowcase(m: { paypalOrderId?: string | null; paypalCaptureId?: string | null } | null | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!m || paypalMode(env) === "simulated") return false;
  return isSimulatorId(m.paypalOrderId) || isSimulatorId(m.paypalCaptureId);
}

/** The refusal reason code and text for an action on a milestone recordedForShowcase. */
export const RECORDED_SHOWCASE_REASON = "recorded_for_showcase";
export const RECORDED_SHOWCASE_TEXT =
  "This milestone was recorded for the showcase with simulator PayPal ids, so it is display only on the real PayPal sandbox. Fund a draft milestone with PayPal to run this step for real.";

/** The variables PAYPAL_MODE=sandbox needs for the whole demo (checkout, payouts, webhooks, advances, receivers). */
export const SANDBOX_REQUIRED_ENV = [
  "PAYPAL_CLIENT_ID",
  "PAYPAL_CLIENT_SECRET",
  "PAYPAL_WEBHOOK_ID",
  "PAYPAL_PARTNER_CLIENT_ID",
  "PAYPAL_PARTNER_CLIENT_SECRET",
  "PAYPAL_FREELANCER_EMAIL",
  "PAYPAL_PARTNER_EMAIL",
] as const;

/** The SANDBOX_REQUIRED_ENV names that are unset or blank (names only, never values). Empty outside sandbox mode. */
export function missingSandboxEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  if (paypalMode(env) !== "sandbox") return [];
  return SANDBOX_REQUIRED_ENV.filter((k) => !envOr(k, env));
}

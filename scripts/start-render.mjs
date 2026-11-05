#!/usr/bin/env node
// Render entry point for the one web service that hosts Milestone (see render.yaml and docs/deploy.md).
//
//   node scripts/start-render.mjs predeploy   migrate, then seed the showcase on an empty database (preDeployCommand)
//   node scripts/start-render.mjs             start Next.js and the worker side by side (startCommand)
//
// Web and worker run in one service because the PayPal simulator's state and uploaded deliveries are files (var/,
// or the paths in SIMULATED_PAYPAL_STATE_FILE and UPLOAD_DIR) that both processes read and write. If either process
// exits, the other is stopped and this script exits with its code, so Render restarts the pair together.
//
// Hosted deliveries are https only: unless MILESTONE_ALLOW_LOCAL_REPOS=1, both processes see a `git` on PATH that runs
// the real git with GIT_ALLOW_PROTOCOL=https, so neither the web app's ls-remote nor the worker's fetch can reach a
// file://, local-path, ssh or git:// repository, whatever the delivery says. (The web route already refuses local paths
// in production; this covers every other way a repository URL can reach the worker.)
//
// No pnpm at run time: the binaries are called through node directly, so the service does not depend on corepack's
// shims surviving from the build.
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tsx = join(root, "node_modules/tsx/dist/cli.mjs");
const drizzleKit = join(root, "packages/core/node_modules/drizzle-kit/bin.cjs");
const next = join(root, "apps/web/node_modules/next/dist/bin/next");

const env = { ...process.env };
// APP_URL is where the simulator posts its webhooks and where PayPal sends the buyer back; Render gives the public URL.
if (!env.APP_URL && env.RENDER_EXTERNAL_URL) env.APP_URL = env.RENDER_EXTERNAL_URL;

function need(path) {
  if (!existsSync(path)) {
    console.error(`start-render: ${path} is missing; did the build run pnpm install with dev dependencies?`);
    process.exit(1);
  }
}

/** Runs one step to completion with inherited output; exits the script on failure. */
function step(label, args, cwd) {
  console.log(`start-render: ${label}`);
  const r = spawnSync(process.execPath, args, { cwd, env, stdio: "inherit" });
  if (r.status !== 0) {
    console.error(`start-render: ${label} failed (exit ${r.status ?? r.signal})`);
    process.exit(r.status ?? 1);
  }
}

/** A directory holding a `git` that only speaks https, prepended to PATH. Returns false when git is not installed. */
function httpsOnlyGit() {
  const found = spawnSync("sh", ["-c", "command -v git"], { env, encoding: "utf8" });
  const realGit = found.status === 0 ? found.stdout.trim() : "";
  if (!realGit) {
    console.warn("start-render: git not found on PATH; deliveries from repositories will fail");
    return false;
  }
  const dir = join(tmpdir(), "milestone-https-git");
  mkdirSync(dir, { recursive: true });
  const wrapper = join(dir, "git");
  writeFileSync(wrapper, `#!/bin/sh\n# Written by scripts/start-render.mjs: hosted Milestone clones https repositories only.\nGIT_ALLOW_PROTOCOL=https exec ${JSON.stringify(realGit)} "$@"\n`);
  chmodSync(wrapper, 0o755);
  env.PATH = `${dir}${delimiter}${env.PATH ?? ""}`;
  env.GIT_ALLOW_PROTOCOL = "https";
  return true;
}

const mode = process.argv[2] ?? "start";

if (mode === "predeploy") {
  need(drizzleKit);
  need(tsx);
  step("migrate", [drizzleKit, "migrate"], join(root, "packages/core"));
  step("seed --showcase --if-empty", [tsx, "src/seed.ts", "--showcase", "--if-empty"], join(root, "packages/core"));
  process.exit(0);
}

if (mode !== "start") {
  console.error(`start-render: unknown mode ${JSON.stringify(mode)} (use "predeploy" or nothing)`);
  process.exit(2);
}

need(next);
need(tsx);
if (env.MILESTONE_ALLOW_LOCAL_REPOS?.trim() === "1") console.warn("start-render: MILESTONE_ALLOW_LOCAL_REPOS=1, local repositories are allowed");
else if (httpsOnlyGit()) console.log("start-render: git limited to https repositories");
if (env.DEMO_MODE?.trim() === "1") {
  if (env.DEMO_REPO_URL?.trim()) console.log(`start-render: DEMO_MODE=1, code deliveries only from ${env.DEMO_REPO_URL.trim()}`);
  else console.warn("start-render: DEMO_MODE=1 and DEMO_REPO_URL is not set, so every code delivery is refused (file uploads still work); set it to the public demo repository (docs/deploy.md)");
}

const port = env.PORT || "10000";
const children = [
  { name: "web", proc: spawn(process.execPath, [next, "start", "-p", port], { cwd: join(root, "apps/web"), env, stdio: "inherit" }) },
  { name: "worker", proc: spawn(process.execPath, [tsx, "src/index.ts"], { cwd: join(root, "apps/worker"), env, stdio: "inherit" }) },
];

let stopping = false;
let signalled = false;
function stopAll(signal) {
  for (const c of children) if (c.proc.exitCode === null && c.proc.signalCode === null) c.proc.kill(signal);
}
for (const c of children) {
  c.proc.on("exit", (code, signal) => {
    if (!stopping) {
      stopping = true;
      console.error(`start-render: ${c.name} exited (${code ?? signal}); stopping the rest`);
      stopAll("SIGTERM");
      // Render restarts the service when this process exits non-zero.
      setTimeout(() => process.exit(code || 1), 10_000).unref();
    }
    if (children.every((x) => x.proc.exitCode !== null || x.proc.signalCode !== null)) process.exit(signalled ? 0 : code || 1);
  });
}
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    stopping = true;
    signalled = true;
    stopAll(sig);
  });
}
console.log(`start-render: web on :${port} and worker started (APP_URL=${env.APP_URL ?? "unset"})`);

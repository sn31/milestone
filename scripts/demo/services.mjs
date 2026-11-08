// Process plumbing for the demo recorder: a throwaway database, the web server, a worker and headless Chrome.
// Children run in their own process groups so stop() takes down pnpm and everything it started.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { sleep } from "./cdp.mjs";

/** Runs one SQL statement with psql and returns trimmed tuples-only output. */
export function psql(url, sql) {
  return execFileSync("psql", ["-X", "-q", "-tA", "-v", "ON_ERROR_STOP=1", url, "-c", sql], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** The same server, another database name. */
export function withDatabase(url, name) {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

/** Drops (forcing off any connections) and recreates `name`, owned by the URL's user. */
export function recreateDatabase(url, name) {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`refusing odd database name ${name}`);
  const admin = withDatabase(url, "postgres");
  const owner = decodeURIComponent(new URL(url).username);
  psql(admin, `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  psql(admin, `CREATE DATABASE ${name} OWNER ${owner}`);
}

export function dropDatabase(url, name) {
  psql(withDatabase(url, "postgres"), `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
}

/** Runs a command to completion; throws with its output on failure. */
export function runOrThrow(cmd, args, { cwd, env }) {
  const r = spawnSync(cmd, args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed (${r.status}):\n${(r.stdout ?? "") + (r.stderr ?? "")}`.slice(0, 4000));
  return r.stdout;
}

const children = new Set();

/** Starts a long-running process with output to `logFile`. */
export function start(name, cmd, args, { cwd, env, logFile }) {
  mkdirSync(dirname(logFile), { recursive: true });
  const fd = openSync(logFile, "a");
  const child = spawn(cmd, args, { cwd, env, detached: true, stdio: ["ignore", fd, fd] });
  const proc = {
    name,
    child,
    logFile,
    exited: false,
    async stop() {
      if (proc.exited) return;
      const kill = (sig) => { try { process.kill(-child.pid, sig); } catch { /* gone */ } };
      kill("SIGTERM");
      for (let i = 0; i < 40 && !proc.exited; i++) await sleep(100);
      if (!proc.exited) kill("SIGKILL");
      children.delete(proc);
    },
  };
  child.on("exit", () => { proc.exited = true; });
  children.add(proc);
  return proc;
}

export async function stopAll() {
  await Promise.all([...children].reverse().map((p) => p.stop()));
}

/** Last resort on an abrupt exit: SIGKILL every process group we started. */
export function killAllSync() {
  for (const p of children) { try { process.kill(-p.child.pid, "SIGKILL"); } catch { /* gone */ } }
}

export async function waitHttp(url, { timeout = 120_000, proc } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    if (proc?.exited) throw new Error(`${proc.name} exited; see ${proc.logFile}`);
    try {
      const res = await fetch(url, { redirect: "manual" });
      if (res.status < 500) return res.status;
    } catch { /* not up yet */ }
    if (Date.now() > end) throw new Error(`${url} did not come up`);
    await sleep(500);
  }
}

/** Polls a log file until it contains `text`. */
export async function waitLog(proc, text, timeout = 60_000) {
  const { readFileSync } = await import("node:fs");
  const end = Date.now() + timeout;
  for (;;) {
    if (proc.exited) throw new Error(`${proc.name} exited; see ${proc.logFile}`);
    try { if (readFileSync(proc.logFile, "utf8").includes(text)) return; } catch { /* not yet */ }
    if (Date.now() > end) throw new Error(`${proc.name} did not log "${text}"; see ${proc.logFile}`);
    await sleep(300);
  }
}

export function chromePath() {
  const candidates = [
    process.env.CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ].filter(Boolean);
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error("Chrome not found; set CHROME_PATH");
  return found;
}

/**
 * Headless Chrome with its own profile and debugging port, 1440x900. `headed` opens a real window instead (PayPal's
 * sandbox login can treat headless Chrome as a bot); `userAgent` replaces Chrome's own (headless Chrome says
 * "HeadlessChrome" in it).
 */
export async function startChrome({ port, profileDir, logFile, width, height, headed = false, userAgent = null }) {
  rmSync(profileDir, { recursive: true, force: true });
  const proc = start("chrome", chromePath(), [
    ...(headed ? [] : ["--headless=new"]),
    ...(userAgent ? [`--user-agent=${userAgent}`] : []),
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    `--window-size=${width},${height}`,
    "--force-device-scale-factor=1",
    "--hide-scrollbars",
    "--mute-audio",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    "about:blank",
  ], { env: process.env, logFile });
  await waitHttp(`http://127.0.0.1:${port}/json/version`, { timeout: 30_000, proc });
  return proc;
}

#!/usr/bin/env node
// Records the demo "backup run": drives the beats of docs/video-script.md through the real UI in headless Chrome,
// captures it with CDP's Page.startScreencast and writes an MJPEG AVI and a Photo-JPEG MOV without ffmpeg.
// Everything runs against a throwaway database (recreated each run) and its own web server, worker and Chrome,
// so the data behind a running dev server is never touched. See docs/demo-recording.md.
//
//   node scripts/record-demo.mjs [--out <dir>] [--port 3012] [--cdp-port 9452] [--db milestone_demo]
//                                [--fps 10] [--quality 72] [--hold 2500] [--review-seconds 30] [--keep-db]
//                                [--only <beat,beat>] [--no-probe]
//   node scripts/record-demo.mjs --assemble <dir>     rebuild the videos from <dir>/frames and <dir>/beats.json
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { Driver, Recorder, connect, sleep } from "./demo/cdp.mjs";
import { BEATS } from "./demo/beats.mjs";
import { writeAvi, readAvi } from "./demo/avi.mjs";
import { writeMov, readMov } from "./demo/mov.mjs";
import { writeUploadFixtures } from "./demo/fixtures.mjs";
import { makeShadowWeb } from "./demo/shadow-web.mjs";
import { dropDatabase, killAllSync, psql, recreateDatabase, runOrThrow, start, startChrome, stopAll, waitHttp, waitLog, withDatabase } from "./demo/services.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WIDTH = 1440;
const HEIGHT = 900;

const { values: opt } = parseArgs({
  options: {
    out: { type: "string", default: join(ROOT, "var", "demo-run") },
    port: { type: "string", default: "3012" },
    "cdp-port": { type: "string", default: "9452" },
    db: { type: "string", default: "milestone_demo" },
    fps: { type: "string", default: "10" },
    quality: { type: "string", default: "72" },
    hold: { type: "string", default: "2500" },
    "review-seconds": { type: "string", default: "30" },
    "keep-db": { type: "boolean", default: false },
    only: { type: "string" },
    "no-probe": { type: "boolean", default: false },
    assemble: { type: "string" },
  },
});

const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
const fmt = (s) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`;

/** KEY=value lines of the repo's .env, without touching process.env. */
function readDotEnv() {
  const out = {};
  try {
    for (const line of readFileSync(join(ROOT, ".env"), "utf8").split("\n")) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (m) out[m[1]] = m[2].replace(/^(["'])(.*)\1$/, "$2");
    }
  } catch { /* no .env */ }
  return out;
}

/** Builds the AVI (constant fps, repeated frames written out) and the MOV (one sample per distinct frame). */
function assemble(outDir) {
  const index = JSON.parse(readFileSync(join(outDir, "frames", "index.json"), "utf8"));
  const pool = index.files.map((f) => readFileSync(join(outDir, "frames", f)));
  if (!index.ticks.length) throw new Error("no frames recorded");
  const avi = writeAvi(join(outDir, "demo.avi"), { fps: index.fps, frames: index.ticks, pool });
  const samples = [];
  for (const f of index.ticks) {
    const last = samples[samples.length - 1];
    if (last && last.file === f) last.durationMs += 1000 / index.fps;
    else samples.push({ file: f, data: pool[f], durationMs: 1000 / index.fps });
  }
  const mov = writeMov(join(outDir, "demo.mov"), samples);
  return { index, avi, mov };
}

/** Our own parsers first; then AVFoundation (what QuickTime uses) through a Swift probe when it is available. */
function verifyVideos(outDir, probe) {
  const results = { avi: readAvi(join(outDir, "demo.avi")), mov: readMov(join(outDir, "demo.mov")) };
  if (probe && process.platform === "darwin") {
    for (const kind of ["avi", "mov"]) {
      const r = spawnSync("swift", [join(ROOT, "scripts", "demo", "avprobe.swift"), join(outDir, `demo.${kind}`)], { encoding: "utf8", timeout: 180_000 });
      try { results[`${kind}AVFoundation`] = JSON.parse(r.stdout.trim().split("\n").pop()); } catch { results[`${kind}AVFoundation`] = { error: (r.stderr || r.stdout || "no output").slice(0, 400) }; }
    }
  }
  return results;
}

function printSummary(outDir, beats, videos, verify) {
  console.log("\nbeat                 video start  length   wall    result");
  for (const b of beats) {
    console.log(`${b.id.padEnd(20)} ${fmt(b.videoStart).padStart(10)}  ${`${(b.videoEnd - b.videoStart).toFixed(1)}s`.padStart(6)}  ${`${(b.wallMs / 1000).toFixed(1)}s`.padStart(6)}   ${b.ok ? "ok" : `FAILED: ${b.error}`}`);
    for (const n of b.notes) console.log(`${"".padEnd(24)}- ${n}`);
  }
  if (videos) {
    const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;
    console.log(`\nAVI ${join(outDir, "demo.avi")}: ${videos.avi.frames} frames @ ${videos.index.fps} fps = ${fmt(videos.avi.frames / videos.index.fps)}, ${videos.avi.width}x${videos.avi.height}, ${mb(videos.avi.bytes)}`);
    console.log(`MOV ${join(outDir, "demo.mov")}: ${videos.mov.frames} distinct frames, ${fmt(videos.mov.durationMs / 1000)}, ${mb(videos.mov.bytes)}`);
  }
  if (verify) {
    for (const [k, v] of Object.entries(verify)) console.log(`check ${k}: ${v.errors ? (v.errors.length ? `ERRORS ${v.errors.join("; ")}` : "ok") : JSON.stringify(v)}`);
  }
}

if (opt.assemble) {
  const outDir = resolve(opt.assemble);
  const videos = assemble(outDir);
  const verify = verifyVideos(outDir, !opt["no-probe"]);
  const beatsFile = join(outDir, "beats.json");
  const meta = existsSync(beatsFile) ? JSON.parse(readFileSync(beatsFile, "utf8")) : { beats: [] };
  printSummary(outDir, meta.beats, videos, verify);
  process.exit(0);
}

const outDir = resolve(opt.out);
const port = Number(opt.port);
const cdpPort = Number(opt["cdp-port"]);
const reviewSeconds = Number(opt["review-seconds"]);
const holdMs = Number(opt.hold);
const only = opt.only ? new Set(opt.only.split(",")) : null;

const dotenv = readDotEnv();
const baseUrl = process.env.DEMO_DATABASE_URL ?? process.env.DATABASE_URL ?? dotenv.DATABASE_URL ?? "postgres://milestone:milestone@localhost:5432/milestone";
const dbUrl = withDatabase(baseUrl, opt.db);
const appUrl = `http://localhost:${port}`;

// A fresh output folder each run (the frames of an old run would otherwise leak into the video).
for (const p of ["frames", "demo-repo", "upload", "uploads", "chrome-profile", "logs", "demo.avi", "demo.mov", "beats.json", "simulated-paypal.json"]) rmSync(join(outDir, p), { recursive: true, force: true });
mkdirSync(join(outDir, "logs"), { recursive: true });

const env = {
  ...dotenv,
  ...process.env,
  DATABASE_URL: dbUrl,
  APP_URL: appUrl,
  PAYPAL_MODE: "simulated",
  // The recorder delivers from a local checkout (file://), which the hosted demo's lock refuses: never DEMO_MODE here.
  DEMO_MODE: "",
  SIMULATED_PAYPAL_STATE_FILE: join(outDir, "simulated-paypal.json"),
  UPLOAD_DIR: join(outDir, "uploads"),
  REVIEW_WINDOW_SECONDS: String(reviewSeconds),
};

let exiting = false;
const bail = (sig) => {
  if (exiting) return;
  exiting = true;
  log(`${sig}: stopping children`);
  killAllSync();
  if (shadowDir) rmSync(shadowDir, { recursive: true, force: true });
  process.exit(130);
};
process.on("SIGINT", () => bail("SIGINT"));
process.on("SIGTERM", () => bail("SIGTERM"));

const beats = [];
let videos = null;
let verify = null;
let failure = null;
let cdp = null;
let recorder = null;
let shadowDir = null;

try {
  log(`database ${opt.db}: recreate, migrate, seed`);
  recreateDatabase(baseUrl, opt.db);
  runOrThrow("pnpm", ["db:migrate"], { cwd: ROOT, env });
  runOrThrow("pnpm", ["db:seed"], { cwd: ROOT, env });

  log("demo repo and upload files");
  runOrThrow("bash", [join(ROOT, "scripts", "make-demo-repo.sh"), join(outDir, "demo-repo")], { cwd: ROOT, env });
  const uploadFiles = writeUploadFixtures(join(outDir, "upload"));

  log(`web on ${appUrl}, worker, headless Chrome on ${cdpPort}`);
  // A second `next dev` cannot share apps/web/.next with the server already running there: serve a snapshot copy.
  shadowDir = makeShadowWeb(ROOT);
  const web = start("web", join(shadowDir, "node_modules", ".bin", "next"), ["dev", "-p", String(port)], { cwd: shadowDir, env: { ...env, NEXT_TELEMETRY_DISABLED: "1" }, logFile: join(outDir, "logs", "web.log") });
  // `start`, not `dev`: tsx watch restarts on every edit in the repo, which would drop a simulated webhook mid-release.
  const worker = start("worker", "pnpm", ["--filter", "@milestone/worker", "start"], { cwd: ROOT, env, logFile: join(outDir, "logs", "worker.log") });
  await waitHttp(`${appUrl}/api/dev/paypal/mode`, { proc: web });
  await waitLog(worker, "worker up");
  await startChrome({ port: cdpPort, profileDir: join(outDir, "chrome-profile"), logFile: join(outDir, "logs", "chrome.log"), width: WIDTH, height: HEIGHT });

  cdp = await connect(cdpPort);
  const d = new Driver(cdp, { baseUrl: appUrl, width: WIDTH, height: HEIGHT, log: (m) => log(`  ${m}`) });
  await d.init();

  // Warm-up off camera: the dev server compiles each route on first hit.
  log("warming up routes");
  for (const p of ["/", "/contracts/ctr_demo", "/contracts/ctr_brand", "/contracts/ctr_demo/activity", "/lender", "/ops", "/agents"]) await d.go(p);
  // API routes compile on first hit too; a GET compiles each one without changing anything (POST-only routes answer 405).
  for (const p of ["/api/milestones/mst_3/order", "/api/milestones/mst_3/capture", "/api/dev/paypal/approve", "/api/dev/paypal/fail", "/api/advances/offer?milestoneId=mst_3", "/api/advances/accept", "/api/milestones/mst_3/deliver", "/api/milestones/mst_3/upload", "/api/milestones/mst_3/review", "/api/ops/mst_3/resolve", "/api/webhooks/paypal", "/api/agents"]) {
    await fetch(appUrl + p, { redirect: "manual" }).catch(() => {});
  }

  recorder = new Recorder(cdp, { dir: outDir, fps: Number(opt.fps), quality: Number(opt.quality), width: WIDTH, height: HEIGHT });
  const ctx = {
    d,
    db: (sql) => psql(dbUrl, sql),
    repoPath: join(outDir, "demo-repo"),
    uploadFiles,
    holdMs,
    reviewSeconds,
    note: () => {},
    mark: () => {},
    async offCamera(fn) {
      recorder.pause();
      try { await fn(); } finally { recorder.resume(); }
    },
  };
  await d.go("/");
  await recorder.start();

  for (const beat of BEATS) {
    if (only && !only.has(beat.id)) continue;
    const rec = { id: beat.id, title: beat.title, script: beat.script, videoStart: recorder.videoMs() / 1000, wallStart: new Date().toISOString(), notes: [], marks: [], ok: false };
    ctx.note = (n) => { rec.notes.push(n); log(`  note: ${n}`); };
    // Named moments in the video (seconds), for the narrated cut: scripts/video/build-video.mjs speeds up the waits between them.
    ctx.mark = (label) => rec.marks.push({ label, t: Math.round(recorder.videoMs()) / 1000 });
    log(`beat ${beat.id}: ${beat.title}`);
    const t = Date.now();
    try {
      // A dead server shows up as a selector timeout otherwise; name the cause.
      for (const p of [web, worker]) if (p.exited) throw new Error(`${p.name} exited; see ${p.logFile}`);
      await beat.run(ctx);
      await sleep(holdMs); // the pause on each beat
      rec.ok = true;
    } catch (e) {
      const dead = [web, worker].filter((p) => p.exited).map((p) => `${p.name} exited, see ${p.logFile}`);
      rec.error = dead.length && !e.message.includes(" exited; see ") ? `${e.message} (${dead.join("; ")})` : e.message;
      log(`  FAILED: ${e.message}`);
    }
    rec.wallMs = Date.now() - t;
    rec.videoEnd = recorder.videoMs() / 1000;
    rec.wallEnd = new Date().toISOString();
    beats.push(rec);
    log(`  ${rec.ok ? "ok" : "failed"} in ${(rec.wallMs / 1000).toFixed(1)}s (video ${fmt(rec.videoStart)} to ${fmt(rec.videoEnd)})`);
    if (!rec.ok) { failure = `${beat.id}: ${rec.error}`; break; }
  }
  if (cdp.logs.length) writeFileSync(join(outDir, "logs", "browser.log"), cdp.logs.join("\n") + "\n");
} catch (e) {
  failure = e.stack ?? String(e);
  log(`run failed: ${failure}`);
} finally {
  if (recorder?.recording) await recorder.stop();
  cdp?.close();
  log("stopping Chrome, worker and web");
  await stopAll();
  if (shadowDir) rmSync(shadowDir, { recursive: true, force: true });
  rmSync(join(outDir, "chrome-profile"), { recursive: true, force: true });
  if (!opt["keep-db"]) {
    try { dropDatabase(baseUrl, opt.db); log(`dropped ${opt.db}`); } catch (e) { log(`could not drop ${opt.db}: ${e.message}`); }
  }
}

if (recorder && recorder.ticks.length) {
  videos = assemble(outDir);
  verify = verifyVideos(outDir, !opt["no-probe"]);
}
const meta = {
  recordedAt: new Date().toISOString(),
  viewport: { width: WIDTH, height: HEIGHT, colorScheme: "dark" },
  fps: Number(opt.fps),
  appUrl,
  database: opt.db,
  reviewWindowSeconds: reviewSeconds,
  // The worker gets .env merged in, so a key in .env counts (MILESTONE_MODEL unset: the provider's default).
  model: env.ANTHROPIC_API_KEY?.trim() ? env.MILESTONE_MODEL?.trim() || "default" : null,
  ok: !failure,
  failure,
  video: videos
    ? {
        avi: { path: join(outDir, "demo.avi"), seconds: videos.avi.frames / videos.index.fps, frames: videos.avi.frames, bytes: statSync(join(outDir, "demo.avi")).size },
        mov: { path: join(outDir, "demo.mov"), seconds: videos.mov.durationMs / 1000, frames: videos.mov.frames, bytes: statSync(join(outDir, "demo.mov")).size },
        distinctFrames: videos.index.files.length,
        skippedFrames: videos.index.skippedFrames,
      }
    : null,
  checks: verify,
  beats,
};
writeFileSync(join(outDir, "beats.json"), JSON.stringify(meta, null, 2) + "\n");
printSummary(outDir, beats, videos, verify);
console.log(`\nbeats: ${join(outDir, "beats.json")}${failure ? `\nFAILED: ${failure}` : ""}`);
process.exit(failure ? 1 : 0);

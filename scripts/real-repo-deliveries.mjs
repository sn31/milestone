#!/usr/bin/env node
/**
 * Builds the real-repo deliveries described in fixtures/real-repos/manifest.json:
 * clones each public repository, checks out its pinned commit, and creates one local branch per delivery
 * (delivery/<branch>) holding a single commit on top of the pin. Commits use a fixed author and date, so the same
 * manifest always produces the same commit ids.
 *
 *   node scripts/real-repo-deliveries.mjs [--dir <scratch dir>] [--manifest <path>]
 *
 * --dir defaults to MILESTONE_REAL_REPOS_DIR, else <os tmpdir>/milestone-real-repos. Writes <dir>/deliveries.json
 * ({ repos: { <id>: { path, pinned, deliveries: { <branch>: sha } } } }), which packages/verify/test/real-repos.test.ts
 * reads. Needs network for the first clone only; runs no npm, no tests and no model. Nothing outside <dir> is written.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const dir = resolve(opt("--dir") ?? process.env.MILESTONE_REAL_REPOS_DIR ?? join(tmpdir(), "milestone-real-repos"));
const manifestPath = resolve(opt("--manifest") ?? join(here, "..", "fixtures", "real-repos", "manifest.json"));
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

// No inherited GIT_* variables (a hook or a parent repository must not steer these commands).
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
const commitEnv = {
  ...env,
  GIT_AUTHOR_NAME: manifest.commit.name,
  GIT_AUTHOR_EMAIL: manifest.commit.email,
  GIT_AUTHOR_DATE: manifest.commit.date,
  GIT_COMMITTER_NAME: manifest.commit.name,
  GIT_COMMITTER_EMAIL: manifest.commit.email,
  GIT_COMMITTER_DATE: manifest.commit.date,
};
const CONFIG = ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "-c", "core.autocrlf=false", "-c", "core.fileMode=true", "-c", "advice.detachedHead=false"];

function git(cwd, gitArgs, extraEnv = env) {
  const r = spawnSync("git", [...CONFIG, ...gitArgs], { cwd, env: extraEnv, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${gitArgs.join(" ")} (in ${cwd}) exited ${r.status}: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout.trim();
}

function applyEdit(repoDir, edit) {
  const file = join(repoDir, edit.file);
  if (edit.op === "write") {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, edit.content);
    if (edit.mode) chmodSync(file, parseInt(edit.mode, 8));
  } else if (edit.op === "append") {
    writeFileSync(file, readFileSync(file, "utf8") + edit.content);
  } else if (edit.op === "replace") {
    const text = readFileSync(file, "utf8");
    const count = text.split(edit.find).length - 1;
    if (count !== 1) throw new Error(`${edit.file}: expected exactly one occurrence of ${JSON.stringify(edit.find.slice(0, 60))}, found ${count}`);
    writeFileSync(file, text.replace(edit.find, () => edit.with));
  } else {
    throw new Error(`unknown edit op ${edit.op}`);
  }
}

mkdirSync(dir, { recursive: true });
const out = { manifest: manifestPath, dir, repos: {} };
for (const repo of manifest.repos) {
  const repoDir = join(dir, repo.id);
  if (!existsSync(join(repoDir, ".git"))) {
    console.log(`clone ${repo.url} -> ${repoDir}`);
    git(dir, ["clone", "-q", "--no-checkout", repo.url, repoDir]);
  }
  if (spawnSync("git", ["cat-file", "-e", `${repo.pinned}^{commit}`], { cwd: repoDir, env }).status !== 0) {
    git(repoDir, ["fetch", "-q", repo.url, repo.pinned]);
  }
  const pinned = git(repoDir, ["rev-parse", `${repo.pinned}^{commit}`]);
  if (pinned !== repo.pinned) throw new Error(`${repo.id}: pinned ${repo.pinned} resolved to ${pinned}`);
  git(repoDir, ["tag", "-f", "milestone-baseline", pinned]);
  const deliveries = {};
  for (const d of repo.deliveries) {
    git(repoDir, ["checkout", "-q", "-f", "--detach", pinned]);
    git(repoDir, ["clean", "-q", "-f", "-d", "-x"]);
    for (const e of d.edits) applyEdit(repoDir, e);
    // -f: node_modules is usually gitignored, and the shim delivery commits it on purpose.
    git(repoDir, ["add", "-f", "--", ...new Set(d.edits.map((e) => e.file))]);
    git(repoDir, ["commit", "-q", "-m", `${d.title}\n\n${d.body}`], commitEnv);
    const sha = git(repoDir, ["rev-parse", "HEAD"]);
    git(repoDir, ["branch", "-f", `delivery/${d.branch}`, sha]);
    deliveries[d.branch] = sha;
    console.log(`${repo.id.padEnd(8)} ${d.branch.padEnd(22)} ${sha}`);
  }
  git(repoDir, ["checkout", "-q", "-f", "--detach", pinned]);
  out.repos[repo.id] = { path: repoDir, url: repo.url, pinned, deliveries };
}
writeFileSync(join(dir, "deliveries.json"), `${JSON.stringify(out, null, 2)}\n`);
console.log(`wrote ${join(dir, "deliveries.json")}`);

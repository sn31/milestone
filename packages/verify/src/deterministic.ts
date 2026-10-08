/**
 * Deterministic stage, no model: check out the merge commit in a throwaway directory with no secrets
 * in its environment, run build and test commands with a time limit, check required files.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdtemp, rm } from "node:fs/promises";
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
}

const CLEAN_ENV = { PATH: process.env.PATH ?? "", CI: "1", NODE_ENV: "test", HOME: "" };

export async function runDeterministicStage(input: DeterministicInput): Promise<DeterministicOutput> {
  const workdir = await mkdtemp(join(tmpdir(), "milestone-verify-"));
  const env = { ...CLEAN_ENV, HOME: workdir };
  const logs: Record<string, string> = {};
  const evidence: EvidenceSummary[] = [];
  try {
    await run(["git", "init", "-q"], workdir, env, 30_000);
    await run(["git", "fetch", "--depth", "1", input.repoUrl, input.sha], workdir, env, 120_000);
    await run(["git", "checkout", "-q", "FETCH_HEAD"], workdir, env, 30_000);
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
        evidence.push({ id: `evd_${c.id}`, criterion_id: c.id, kind: "log", status: r.timedOut ? "unclear" : r.code === 0 ? "pass" : "fail", summary: `${command} exited ${r.code}${r.timedOut ? " (timed out)" : ""}; last lines:\n${tail(r.output)}`, sha256: sha256(r.output) });
      } else if (c.kind === "file") {
        const path = String(c.spec.path ?? "");
        const exists = await access(join(workdir, path)).then(() => true, () => false);
        evidence.push({ id: `evd_${c.id}`, criterion_id: c.id, kind: "file", status: exists ? "pass" : "fail", summary: `${path} ${exists ? "present" : "missing"}` });
      }
    }
    return { evidence, logs, workdir };
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
    const child = spawn(bin, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, output: output.slice(-200_000), timedOut }); });
  });
}

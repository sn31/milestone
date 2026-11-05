/**
 * Opt-in (F5): judge() with the real model on the demo repo's m1-pass delivery and the seeded milestone-1 criteria.
 *   MILESTONE_MODEL_EVAL=1 pnpm --filter @milestone/verify exec vitest run test/demo-judge.model.test.ts --silent=false
 * MILESTONE_DEMO_RUNS (default 5) runs; the judgment criterion must come back pass with cited evidence in at least
 * 4 of 5 (80%). MILESTONE_DEMO_DIR builds the demo repo there instead of a temp dir (it must not exist or be empty).
 * Each run reports whether the model cited the evidence itself or the parser attached evd_diff after a read.
 */
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CriterionSpec } from "@milestone/core";
import { run, runDeterministicStage, type DeterministicOutput } from "../src/deterministic.ts";
import { currentModel, isModelConfigured } from "../src/llm.ts";
import { judge, type EvidenceReader } from "../src/verifier.ts";

const ENABLED = process.env.MILESTONE_MODEL_EVAL === "1";
const RUNS = Number(process.env.MILESTONE_DEMO_RUNS ?? 5);

/** packages/core/src/seed.ts, milestone 1 of ctr_demo. */
const MILESTONE = { title: "Signup form and validation", scope: "Build a signup flow for a SaaS landing page: form, validation, confirmation page, in three milestones." };
const CRITERIA: CriterionSpec[] = [
  { id: "crt_1_tests", kind: "test", description: "The test suite passes", spec: { command: "npm test" }, required: true },
  { id: "crt_1_file", kind: "file", description: "Expected source file exists", spec: { path: "src/password.js" }, required: true },
  { id: "crt_1_judge", kind: "judgment", description: "The delivery matches the milestone description", spec: {}, required: false },
];

/** The worker's reader, reduced: files under the checkout only, and the diff against the baseline. */
function checkoutReader(stage: DeterministicOutput, sha: string): EvidenceReader {
  const env = { PATH: process.env.PATH ?? "", HOME: stage.workdir };
  return {
    async readFile(path) {
      const root = await realpath(stage.workdir);
      const real = await realpath(resolve(root, path));
      const rel = relative(root, real);
      if (rel.startsWith("..") || isAbsolute(rel) || rel === ".git" || rel.startsWith(".git/")) throw new Error(`path outside the delivery: ${path}`);
      return (await readFile(real, "utf8")).slice(0, 100_000);
    },
    async getDiff() {
      const r = await run(["git", "diff", "--stat", "-p", "--no-color", stage.baseline!, sha], stage.workdir, env, 60_000);
      return r.output;
    },
    listEvidence: async () => stage.evidence,
    viewScreenshot: async () => "no screenshot",
    viewFile: async () => "this delivery is a repository commit, not uploaded files; use read_file",
  };
}

describe.runIf(ENABLED)("demo m1-pass judgment (real model)", () => {
  let demo: string;
  let stage: DeterministicOutput;
  let sha: string;

  beforeAll(async () => {
    demo = process.env.MILESTONE_DEMO_DIR ?? (await mkdtemp(join(tmpdir(), "milestone-demo-model-")));
    execFileSync("bash", [new URL("../../../scripts/make-demo-repo.sh", import.meta.url).pathname, demo], { stdio: "ignore" });
    const g = (...a: string[]) => execFileSync("git", a, { cwd: demo }).toString().trim();
    sha = g("rev-parse", "m1-pass");
    stage = await runDeterministicStage({ repoUrl: `file://${demo}`, sha, criteria: CRITERIA, baselineSha: g("rev-parse", "main"), baselineSource: "funding-time default branch", pullRequest: { title: "Manual delivery of m1-pass", body: "" } });
  }, 120_000);

  afterAll(async () => {
    if (stage?.workdir) await rm(stage.workdir, { recursive: true, force: true });
    if (demo && !process.env.MILESTONE_DEMO_DIR) await rm(demo, { recursive: true, force: true });
  });

  it(`passes the judgment criterion with cited evidence in at least 80% of ${RUNS} runs`, async () => {
    expect(await isModelConfigured(), `ANTHROPIC_API_KEY is not set (model ${currentModel()})`).toBe(true);
    expect(stage.evidence.map((e) => e.id)).toEqual(expect.arrayContaining(["evd_tamper_check", "evd_diff", "evd_tree", "evd_commit", "evd_crt_1_tests", "evd_crt_1_file"]));

    const commitMessage = (await run(["git", "log", "-1", "--format=%B", sha], stage.workdir, { PATH: process.env.PATH ?? "" }, 30_000)).output;
    const deliveryTexts = [{ source: "pr_title", text: "Manual delivery of m1-pass" }, { source: "commit_message", text: commitMessage }];
    const rows: Array<{ ok: boolean; line: string }> = [];
    for (let i = 1; i <= RUNS; i++) {
      const t = Date.now();
      const once = () => judge({ deliveryId: `dlv_demo_m1_${i}`, milestone: MILESTONE, criteria: CRITERIA, evidence: stage.evidence, deliveryTexts, reader: checkoutReader(stage, sha) });
      // A dropped connection to the model server is not a verdict: retry the run once, then count it as a miss.
      const r = await once().catch((e: Error) => {
        console.log(`run ${i}: transport error (${e.message}), retrying once`);
        return once();
      }).catch((e: Error) => e);
      if (r instanceof Error) {
        console.log(`run ${i}: MISS error ${r.message}`);
        rows.push({ ok: false, line: `run ${i}: error` });
        continue;
      }
      const j = r.verdict.criteria.find((c) => c.criterion_id === "crt_1_judge")!;
      const attached = r.attachedEvidence.some((a) => a.criterion_id === "crt_1_judge");
      const ok = j.status === "pass" && j.evidence_ids.length > 0;
      const line = `run ${i}: ${ok ? "PASS" : "MISS"} ${j.status}@${j.confidence} [${j.evidence_ids.join(",")}]${attached ? " (evd_diff attached by the parser)" : j.evidence_ids.length ? " (cited by the model)" : ""} overall=${r.result}${j.confidence >= 0.8 ? "" : " (below the default 0.8 threshold: would ask the client)"} tools=${r.toolCalls.map((c) => c.tool).join(",") || "none"} ${((Date.now() - t) / 1000).toFixed(1)}s\n    ${j.rationale}`;
      console.log(line);
      rows.push({ ok, line });
    }
    const passes = rows.filter((r) => r.ok).length;
    console.log(`\ndemo m1-pass judgment: ${passes}/${RUNS} pass with cited evidence (model ${currentModel()})`);
    expect(passes / RUNS).toBeGreaterThanOrEqual(0.8);
  }, 60 * 60 * 1000);
});

describe.skipIf(ENABLED)("demo m1-pass judgment", () => {
  it.skip("set MILESTONE_MODEL_EVAL=1 to judge the demo repo's m1-pass with the real model", () => {});
});

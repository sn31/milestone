/**
 * Opt-in: the deterministic verifier judging real code nobody here wrote. Needs network (git clone, npm install).
 *   MILESTONE_REAL_REPOS=1 pnpm --filter @milestone/verify exec vitest run test/real-repos.test.ts --silent=false
 * MILESTONE_REAL_REPOS_DIR picks the scratch directory (default <os tmpdir>/milestone-real-repos); the npm cache goes
 * to <dir>/npm-cache unless MILESTONE_NPM_CACHE is set.
 *
 * scripts/real-repo-deliveries.mjs builds the delivery branches on top of each pinned public repository
 * (fixtures/real-repos/manifest.json). Per (repo, delivery): runDeterministicStage with the pin as baseline and the
 * worker's setup command (the client's baseline suite against the delivered code, plus the gaming scan), then enforce +
 * overall with an empty raw verdict (no model is called, configured or needed), then decide(). Asserts the manifest's
 * expected outcome and writes <dir>/results.json (durations, exit codes, what the overlay restored and removed, gaming
 * hits, the informational pass, verdict result, policy rule) for fixtures/real-repos/README.md.
 *
 * Expectations are soft assertions: one pair's mismatch is reported without hiding the others.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CriterionSpec, PolicyAction, VerdictOutput, VerdictResult } from "@milestone/core";
import { decide } from "@milestone/money";

interface Expected {
  testStatus: "pass" | "fail" | "unclear";
  testExit: number | "nonzero";
  /** What the baseline overlay put back, took away and merged ("package.json: scripts"); gaming hits as "file:line rule". */
  restored: string[];
  removed: string[];
  manifests: string[];
  gaming: string[];
  /** Delivery-added or re-pointed dependencies, as "name@spec reason[/source]". */
  dependencies?: string[];
  removedCommitted: boolean;
  result: VerdictResult;
  action: PolicyAction;
  rule: string;
  actionIfJudgmentPasses: PolicyAction;
}
interface Delivery { branch: string; kind: string; title: string; body: string; expected: Expected }
interface Repo { id: string; url: string; pinned: string; criteria: CriterionSpec[]; deliveries: Delivery[] }
interface Manifest { milestone: { amountMinor: number; currency: string }; setup: string[][]; repos: Repo[] }

const ENABLED = process.env.MILESTONE_REAL_REPOS === "1";
const manifest = JSON.parse(readFileSync(new URL("../../../fixtures/real-repos/manifest.json", import.meta.url), "utf8")) as Manifest;
const script = fileURLToPath(new URL("../../../scripts/real-repo-deliveries.mjs", import.meta.url));
const DIR = process.env.MILESTONE_REAL_REPOS_DIR ?? join(tmpdir(), "milestone-real-repos");
const pairs = manifest.repos.flatMap((repo) => repo.deliveries.map((d) => [`${repo.id}/${d.branch}`, repo, d] as const));

interface Row {
  pair: string;
  kind: string;
  sha: string;
  stageMs: number;
  testExit: number | null;
  testStatus: string | undefined;
  restored: string[];
  removed: string[];
  manifests: string[];
  gaming: string[];
  dependencies: string[];
  /** The delivery's own tests (informational pass): exit code, or null when it did not run. */
  deliveredExit: number | null;
  untrusted: string | null;
  removedCommitted: string[];
  fileStatus: string | undefined;
  result: VerdictResult;
  action: PolicyAction;
  rule: string;
  actionIfJudgmentPasses: PolicyAction;
  ruleIfJudgmentPasses: string;
  matchesExpected: boolean;
  mismatches: string[];
}
const rows: Row[] = [];

describe.skipIf(!ENABLED)("deterministic verifier on real public repositories (no model)", () => {
  let deliveries: { repos: Record<string, { path: string; pinned: string; deliveries: Record<string, string> }> };
  // Loaded after MILESTONE_NPM_CACHE is set: deterministic.ts reads it once, at import.
  let det: typeof import("../src/deterministic.ts");
  let ver: typeof import("../src/verifier.ts");

  beforeAll(async () => {
    process.env.MILESTONE_NPM_CACHE ??= join(DIR, "npm-cache");
    execFileSync(process.execPath, [script, "--dir", DIR], { stdio: "inherit" });
    deliveries = JSON.parse(readFileSync(join(DIR, "deliveries.json"), "utf8"));
    det = await import("../src/deterministic.ts");
    ver = await import("../src/verifier.ts");
  }, 300_000);

  afterAll(() => {
    if (!rows.length) return;
    writeFileSync(join(DIR, "results.json"), `${JSON.stringify({ ranAt: new Date().toISOString(), node: process.version, rows }, null, 2)}\n`);
    console.log(rows.map((r) => [r.pair.padEnd(30), `${String(r.stageMs).padStart(6)}ms`, `exit ${r.testExit}`, (r.testStatus ?? "-").padEnd(7), r.result.padEnd(7), `${r.action} ${r.rule}`.padEnd(16), [...r.restored.map((x) => `restored ${x}`), ...r.removed.map((x) => `removed ${x}`), ...r.manifests, ...r.gaming.map((x) => `gaming ${x}`), ...r.dependencies.map((x) => `dependency ${x}`)].join("; ") || "-", `own tests exit ${r.deliveredExit ?? "-"}`, r.matchesExpected ? "" : `MISMATCH: ${r.mismatches.join(" | ")}`].join("  ")).join("\n"));
  });

  it.each(pairs)("%s", { timeout: 600_000 }, async (pair, repo, d) => {
    const local = deliveries.repos[repo.id]!;
    const sha = local.deliveries[d.branch]!;
    expect(existsSync(local.path)).toBe(true);
    const started = performance.now();
    const out = await det.runDeterministicStage({
      repoUrl: `file://${local.path}`,
      sha,
      criteria: repo.criteria,
      setup: manifest.setup,
      baselineSha: repo.pinned,
      baselineSource: "funding",
      pullRequest: { title: d.title, body: d.body },
    });
    const stageMs = Math.round(performance.now() - started);
    await rm(out.workdir, { recursive: true, force: true });

    const tests = out.evidence.find((e) => e.criterion_id === "tests");
    const file = out.evidence.find((e) => e.criterion_id === "license_file");
    const exit = /exited (\d+|null)/.exec(tests?.summary ?? "")?.[1];
    const testExit = exit === undefined || exit === "null" ? null : Number(exit);
    const removedCommitted = (out.logs["setup:remove-committed-node_modules"] ?? "").split("\n").filter(Boolean);
    const overlay = out.overlay ?? { restored: [], removed: [], manifests: [], lockfilesDropped: [], newDependencies: [] };
    const manifests = overlay.manifests.map((m) => `${m.path}: ${m.keys.join(", ")}`);
    const gaming = out.gaming.map((h) => `${h.file}:${h.line} ${h.rule}`);
    const dependencies = overlay.newDependencies.map((dep) => `${dep.name}@${dep.spec} ${dep.reason}${dep.source ? `/${dep.source}` : ""}`);
    const deliveredRaw = /exited (\d+)/.exec(out.evidence.find((x) => x.id === "evd_tests_delivered")?.summary ?? "")?.[1];
    const deliveredExit = deliveredRaw === undefined ? null : Number(deliveredRaw);

    // No model: an empty raw verdict, so the judgment criterion is "not judged" and enforce makes it unclear.
    const empty: VerdictOutput = { delivery_id: pair, criteria: [], suspected_injection: false };
    const verdict = ver.enforce(empty, { deliveryId: pair, criteria: repo.criteria, evidence: out.evidence });
    const result = ver.overall(verdict, repo.criteria);
    const decision = decide({ verdict, criteria: repo.criteria, milestone: manifest.milestone, contract: {} });

    // What a judge passing the judgment criterion (citing evd_diff) would lead to. Pure computation, no model.
    const judged = repo.criteria.filter((c) => c.kind === "judgment").map((c) => ({ criterion_id: c.id, status: "pass" as const, confidence: 0.95, evidence_ids: [det.DIFF_EVIDENCE_ID], rationale: "hypothetical judge pass" }));
    const ifPassed = ver.enforce({ delivery_id: pair, criteria: judged, suspected_injection: false }, { deliveryId: pair, criteria: repo.criteria, evidence: out.evidence });
    const decisionIfPassed = decide({ verdict: ifPassed, criteria: repo.criteria, milestone: manifest.milestone, contract: {} });

    const e = d.expected;
    const checks: Array<[string, boolean, unknown, unknown]> = [
      ["testStatus", tests?.status === e.testStatus, tests?.status, e.testStatus],
      ["testExit", e.testExit === "nonzero" ? testExit !== null && testExit !== 0 : testExit === e.testExit, testExit, e.testExit],
      ["untrusted", out.untrusted === null, out.untrusted, null],
      ["restored", JSON.stringify(overlay.restored) === JSON.stringify(e.restored), overlay.restored, e.restored],
      ["removed", JSON.stringify(overlay.removed) === JSON.stringify(e.removed), overlay.removed, e.removed],
      ["manifests", JSON.stringify(manifests) === JSON.stringify(e.manifests), manifests, e.manifests],
      ["gaming", JSON.stringify(gaming) === JSON.stringify(e.gaming), gaming, e.gaming],
      ["dependencies", JSON.stringify(dependencies) === JSON.stringify(e.dependencies ?? []), dependencies, e.dependencies ?? []],
      ["removedCommitted", removedCommitted.length > 0 === e.removedCommitted, removedCommitted, e.removedCommitted],
      ["fileStatus", file?.status === "pass", file?.status, "pass"],
      ["result", result === e.result, result, e.result],
      ["action", decision.action === e.action, decision.action, e.action],
      ["rule", decision.ruleIds.join(",") === e.rule, decision.ruleIds.join(","), e.rule],
      ["actionIfJudgmentPasses", decisionIfPassed.action === e.actionIfJudgmentPasses, decisionIfPassed.action, e.actionIfJudgmentPasses],
    ];
    const mismatches = checks.filter(([, ok]) => !ok).map(([k, , got, want]) => `${k}: got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
    rows.push({
      pair, kind: d.kind, sha, stageMs, testExit, testStatus: tests?.status, restored: overlay.restored, removed: overlay.removed, manifests, gaming, dependencies, deliveredExit, untrusted: out.untrusted, removedCommitted,
      fileStatus: file?.status, result, action: decision.action, rule: decision.ruleIds.join(","),
      actionIfJudgmentPasses: decisionIfPassed.action, ruleIfJudgmentPasses: decisionIfPassed.ruleIds.join(","),
      matchesExpected: mismatches.length === 0, mismatches,
    });
    for (const [k, ok, got, want] of checks) expect.soft(ok, `${pair} ${k}: got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`).toBe(true);
  });
});

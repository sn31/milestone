import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CriterionSpec } from "@milestone/core";
import { findTampering, manifestChanges, parseNameStatus, runDeterministicStage, TAMPER_EVIDENCE_ID } from "../src/deterministic.js";
import { enforce, overall } from "../src/verifier.js";

const pkg = (scripts: Record<string, string>, extra: Record<string, unknown> = {}) => JSON.stringify({ name: "x", version: "1.0.0", ...extra, scripts }, null, 2);

describe("findTampering", () => {
  it("allows added files, including new tests and a new package.json", () => {
    expect(findTampering([
      { status: "A", path: "src/password.js" },
      { status: "A", path: "test/password.test.js" },
      { status: "A", path: "packages/new/package.json" },
      { status: "M", path: "src/pricing.js" },
      { status: "M", path: "README.md" },
    ])).toEqual([]);
  });
  it("flags modified or deleted existing tests", () => {
    expect(findTampering([{ status: "M", path: "test/pricing.test.js" }, { status: "D", path: "src/a.spec.ts" }, { status: "M", path: "src/__tests__/x.js" }])).toHaveLength(3);
  });
  it("flags package.json script changes, not other manifest edits", () => {
    const before = pkg({ test: "node --test" }, { version: "1.0.0" });
    expect(findTampering([{ status: "M", path: "package.json", before, after: pkg({ test: "exit 0" }) }])).toEqual(["package.json scripts changed"]);
    expect(findTampering([{ status: "M", path: "package.json", before, after: pkg({ test: "node --test" }, { description: "new" }) }])).toEqual([]);
    expect(findTampering([{ status: "D", path: "package.json", before, after: null }])).toEqual(["package.json deleted"]);
  });
  it("flags CI edits and runner/package-manager config even when added", () => {
    expect(findTampering([{ status: "M", path: ".github/workflows/ci.yml" }])).toHaveLength(1);
    expect(findTampering([{ status: "A", path: ".github/workflows/new.yml" }])).toEqual([]);
    expect(findTampering([{ status: "A", path: ".npmrc" }, { status: "A", path: "vitest.config.ts" }])).toHaveLength(2);
  });
  it("compares scripts independent of key order and treats bad JSON as changed", () => {
    expect(manifestChanges('{"scripts":{"a":"1","b":"2"}}', '{"scripts":{"b":"2","a":"1"}}')).toEqual([]);
    expect(manifestChanges('{"scripts":{}}', "{not json")).toEqual(["unparseable"]);
  });
  it("parses -z name-status output", () => {
    expect(parseNameStatus("M\0package.json\0A\0test/a b.test.js\0")).toEqual([{ status: "M", path: "package.json" }, { status: "A", path: "test/a b.test.js" }]);
  });
});

describe("runDeterministicStage tamper check (local git repo)", () => {
  let repo: string;
  const shas: Record<string, string> = {};
  const g = (...a: string[]) => execFileSync("git", ["-c", "user.email=t@test", "-c", "user.name=t", ...a], { cwd: repo }).toString().trim();
  const criteria: CriterionSpec[] = [{ id: "tests", kind: "test", description: "tests pass", spec: { command: "npm test" }, required: true }];

  beforeAll(async () => {
    repo = await mkdtemp(join(tmpdir(), "milestone-tamper-"));
    await mkdir(join(repo, "test"));
    await writeFile(join(repo, "package.json"), pkg({ test: "node --test" }));
    await writeFile(join(repo, "test", "a.test.js"), "require('node:test')('a', () => {});\n");
    g("init", "-q", "-b", "main"); g("add", "."); g("commit", "-qm", "base");
    shas.root = g("rev-parse", "HEAD");
    g("checkout", "-qb", "adds");
    await writeFile(join(repo, "test", "b.test.js"), "require('node:test')('b', () => {});\n");
    g("add", "."); g("commit", "-qm", "add a test");
    shas.adds = g("rev-parse", "HEAD");
    g("checkout", "-q", "main"); g("checkout", "-qb", "tamper");
    await writeFile(join(repo, "package.json"), pkg({ test: "exit 0" }));
    g("add", "."); g("commit", "-qm", "speed up tests");
    shas.tamper = g("rev-parse", "HEAD");
    g("checkout", "-q", "main"); g("checkout", "-qb", "tamper-fail");
    await writeFile(join(repo, "package.json"), pkg({ test: "exit 1" }));
    g("add", "."); g("commit", "-qm", "break");
    shas.tamperFail = g("rev-parse", "HEAD");
  });
  afterAll(async () => { await rm(repo, { recursive: true, force: true }); });

  async function stage(sha: string) {
    const out = await runDeterministicStage({ repoUrl: `file://${repo}`, sha, criteria });
    await rm(out.workdir, { recursive: true, force: true });
    return { out, tests: out.evidence.find((e) => e.criterion_id === "tests")!, tamper: out.evidence.find((e) => e.id === TAMPER_EVIDENCE_ID)! };
  }

  it("a delivery that only adds files runs the tests and passes; the check is recorded", { timeout: 60_000 }, async () => {
    const { out, tests, tamper } = await stage(shas.adds!);
    expect(out.tampering).toEqual([]);
    expect(tests.status).toBe("pass");
    expect(tamper.status).toBe("pass");
  });

  it("a root commit is compared against the empty tree", { timeout: 60_000 }, async () => {
    const { tests, tamper } = await stage(shas.root!);
    expect(tests.status).toBe("pass");
    expect(tamper.status).toBe("pass");
  });

  it("a delivery that rewrites the test script gets unclear, never pass, even with a model saying pass", { timeout: 60_000 }, async () => {
    const { out, tests, tamper } = await stage(shas.tamper!);
    expect(out.tampering).toEqual(["package.json scripts changed"]);
    expect(tests.status).toBe("unclear");
    expect(tests.summary).toMatch(/tamper check.*package\.json/);
    expect(tamper.status).toBe("unclear");
    const v = enforce({ delivery_id: "d", suspected_injection: false, criteria: [{ criterion_id: "tests", status: "pass", confidence: 1, evidence_ids: ["evd_tests"], rationale: "tests pass" }] }, { deliveryId: "d", criteria, evidence: out.evidence });
    expect(v.criteria[0]).toMatchObject({ status: "unclear", confidence: 0 });
    expect(overall(v, criteria)).toBe("fail");
  });

  it("a failing result under a tampered script still fails", { timeout: 60_000 }, async () => {
    const { tests } = await stage(shas.tamperFail!);
    expect(tests.status).toBe("fail");
  });
});

import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CriterionSpec } from "@milestone/core";
import { findTampering, manifestChanges, parseNameStatus, removeCommittedDependencies, runDeterministicStage, TAMPER_EVIDENCE_ID, type DeterministicInput } from "../src/deterministic.ts";
import { enforce, overall } from "../src/verifier.ts";

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
  it("flags dependency, workspace, bin, engine and package-manager changes in package.json", () => {
    const before = pkg({ test: "node --test" }, { dependencies: { a: "1.0.0" } });
    expect(findTampering([{ status: "M", path: "package.json", before, after: pkg({ test: "node --test" }, { dependencies: { a: "file:./evil" } }) }])).toEqual(["package.json dependencies changed"]);
    for (const key of ["devDependencies", "optionalDependencies", "peerDependencies", "overrides", "resolutions", "workspaces", "bin", "engines", "packageManager"]) {
      expect(findTampering([{ status: "M", path: "pkg/package.json", before, after: pkg({ test: "node --test" }, { dependencies: { a: "1.0.0" }, [key]: "x" }) }])).toEqual([`pkg/package.json ${key} changed`]);
    }
  });
  it("flags lockfiles added, modified or deleted", () => {
    const locks = ["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb", "bun.lock", "packages/a/yarn.lock"];
    expect(findTampering(locks.map((path) => ({ status: "A", path })))).toHaveLength(locks.length);
    expect(findTampering([{ status: "M", path: "package-lock.json" }])).toEqual(["package-lock.json modified (lockfile)"]);
    expect(findTampering([{ status: "D", path: "pnpm-lock.yaml" }])).toEqual(["pnpm-lock.yaml deleted (lockfile)"]);
  });
  it("flags anything under node_modules, including added files", () => {
    expect(findTampering([{ status: "A", path: "node_modules/.bin/node" }])).toEqual(["node_modules/.bin/node added (committed node_modules)"]);
    expect(findTampering([{ status: "M", path: "packages/x/node_modules/y/index.js" }, { status: "D", path: "node_modules/z/package.json" }])).toHaveLength(2);
    expect(findTampering([{ status: "A", path: "src/my_node_modules/a.js" }])).toEqual([]);
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
    // An earlier merge weakens an existing test; the delivery itself only adds a file (R2).
    g("checkout", "-q", "main"); g("checkout", "-qb", "earlier");
    await writeFile(join(repo, "test", "a.test.js"), "// weakened\n");
    g("add", "."); g("commit", "-qm", "tidy tests");
    await mkdir(join(repo, "src"));
    await writeFile(join(repo, "src", "x.js"), "module.exports = 1;\n");
    g("add", "."); g("commit", "-qm", "the delivery");
    shas.afterEarlier = g("rev-parse", "HEAD");
    // A committed node_modules/.bin/node that exits 0 while a real test fails (R1).
    g("checkout", "-q", "main"); g("checkout", "-qb", "fake-node");
    await writeFile(join(repo, "test", "f.test.js"), "require('node:test')('f', () => { throw new Error('broken'); });\n");
    await mkdir(join(repo, "node_modules", ".bin"), { recursive: true });
    await writeFile(join(repo, "node_modules", ".bin", "node"), "#!/bin/sh\nexit 0\n");
    await chmod(join(repo, "node_modules", ".bin", "node"), 0o755);
    g("add", "-f", "."); g("commit", "-qm", "vendor");
    shas.fakeNode = g("rev-parse", "HEAD");
    // A delivery that adds a lockfile (R3).
    g("checkout", "-q", "main"); g("checkout", "-qb", "lock");
    await writeFile(join(repo, "package-lock.json"), "{}\n");
    g("add", "."); g("commit", "-qm", "lock");
    shas.lock = g("rev-parse", "HEAD");
    g("checkout", "-q", "main");
  });
  afterAll(async () => { await rm(repo, { recursive: true, force: true }); });

  async function stage(sha: string, extra: Partial<DeterministicInput> = {}) {
    const out = await runDeterministicStage({ repoUrl: `file://${repo}`, sha, criteria, ...extra });
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

  it("with a baseline, a test weakened in an earlier commit is caught; without one the first-parent fallback says so", { timeout: 60_000 }, async () => {
    const withBaseline = await stage(shas.afterEarlier!, { baselineSha: shas.root!, baselineSource: "funding" });
    expect(withBaseline.out.tampering).toEqual(["test/a.test.js modified (existing test)"]);
    expect(withBaseline.out.baseline).toBe(shas.root);
    expect(withBaseline.tamper.summary).toMatch(/funding baseline/);
    expect(withBaseline.tests.status).toBe("unclear");
    const fallback = await stage(shas.afterEarlier!);
    expect(fallback.out.tampering).toEqual([]);
    expect(fallback.tamper.summary).toMatch(/first parent .* only \(no baseline recorded/);
    expect(fallback.tests.status).toBe("pass");
  });

  it("a baseline that cannot be fetched, or is not a commit id, fails closed to unclear", { timeout: 60_000 }, async () => {
    const missing = await stage(shas.adds!, { baselineSha: "0123456789abcdef0123456789abcdef01234567" });
    expect(missing.tamper).toMatchObject({ status: "unclear" });
    expect(missing.tamper.summary).toMatch(/baseline 0123456789ab could not be fetched/);
    expect(missing.tests.status).toBe("unclear");
    const bogus = await stage(shas.adds!, { baselineSha: "--upload-pack=touch /tmp/x" });
    expect(bogus.tamper.summary).toMatch(/not a commit id/);
    expect(bogus.tests.status).toBe("unclear");
  });

  it("a committed node_modules/.bin/node is flagged and removed, so the failing test fails", { timeout: 60_000 }, async () => {
    const { out, tests } = await stage(shas.fakeNode!, { baselineSha: shas.root! });
    expect(out.tampering).toEqual(["node_modules/.bin/node added (committed node_modules)"]);
    expect(out.logs["setup:remove-committed-node_modules"]).toBe("node_modules");
    expect(tests.status).toBe("fail");
  });

  it("an added lockfile makes a pass unclear", { timeout: 60_000 }, async () => {
    const { out, tests } = await stage(shas.lock!, { baselineSha: shas.root! });
    expect(out.tampering).toEqual(["package-lock.json added (lockfile)"]);
    expect(tests.status).toBe("unclear");
  });
});

describe("removeCommittedDependencies", () => {
  it("removes node_modules and .bin anywhere outside .git, symlinks included", async () => {
    const dir = await mkdtemp(join(tmpdir(), "milestone-rmdeps-"));
    try {
      await mkdir(join(dir, "a", "node_modules", "x"), { recursive: true });
      await mkdir(join(dir, "tools", ".bin"), { recursive: true });
      await mkdir(join(dir, ".git", "node_modules"), { recursive: true });
      await mkdir(join(dir, "src"), { recursive: true });
      await writeFile(join(dir, "src", "keep.js"), "");
      execFileSync("ln", ["-s", "/usr/bin", join(dir, "node_modules")]);
      const removed = await removeCommittedDependencies(dir);
      expect(removed.sort()).toEqual(["a/node_modules", "node_modules", "tools/.bin"]);
      expect(execFileSync("find", [".", "-not", "-path", "./.git/*"], { cwd: dir }).toString().split("\n").filter(Boolean).sort()).toEqual([".", "./.git", "./a", "./src", "./src/keep.js", "./tools"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("demo repo branches under the tamper check", () => {
  let demo: string;
  const shas: Record<string, string> = {};
  const criteria: CriterionSpec[] = [{ id: "tests", kind: "test", description: "tests pass", spec: { command: "npm test" }, required: true }];
  const g = (...a: string[]) => execFileSync("git", ["-c", "user.email=t@test", "-c", "user.name=t", ...a], { cwd: demo }).toString().trim();

  beforeAll(async () => {
    demo = await mkdtemp(join(tmpdir(), "milestone-demo-"));
    execFileSync("bash", [new URL("../../../scripts/make-demo-repo.sh", import.meta.url).pathname, demo], { stdio: "ignore" });
    for (const b of ["main", "m1-pass", "m2-partial", "m2-injection"]) shas[b] = g("rev-parse", b);
    // What GitHub does: merge m1, then m2, into main; the baseline is main when the milestones were funded.
    g("merge", "-q", "--no-ff", "-m", "Merge m1-pass", "m1-pass");
    shas.m1Merge = g("rev-parse", "HEAD");
    g("merge", "-q", "--no-ff", "-m", "Merge m2-partial", "m2-partial");
    shas.m2Merge = g("rev-parse", "HEAD");
  });
  afterAll(async () => { if (demo) await rm(demo, { recursive: true, force: true }); });

  async function stage(sha: string) {
    const out = await runDeterministicStage({ repoUrl: `file://${demo}`, sha, criteria, baselineSha: shas.main!, baselineSource: "funding" });
    await rm(out.workdir, { recursive: true, force: true });
    return { tampering: out.tampering, tests: out.evidence.find((e) => e.criterion_id === "tests")!.status };
  }

  it("m1-pass stays clean and passes, as a branch and as a merge", { timeout: 60_000 }, async () => {
    expect(await stage(shas["m1-pass"]!)).toEqual({ tampering: [], tests: "pass" });
    expect(await stage(shas.m1Merge!)).toEqual({ tampering: [], tests: "pass" });
  });

  it("m2-partial and m2-injection stay fail (the existing pricing test is edited, so they are also flagged)", { timeout: 60_000 }, async () => {
    for (const sha of [shas["m2-partial"]!, shas["m2-injection"]!, shas.m2Merge!]) {
      const r = await stage(sha);
      expect(r.tests).toBe("fail");
      expect(r.tampering).toEqual(["test/pricing.test.js modified (existing test)"]);
    }
  });
});

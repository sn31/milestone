import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CriterionSpec } from "@milestone/core";
import {
  COMMIT_EVIDENCE_ID,
  commitSummary,
  dependencyEvidence,
  depSource,
  describeDependency,
  DIFF_EVIDENCE_ID,
  DIFF_EXCERPT_CHARS,
  diffSummary,
  expandBraces,
  GAMING_MAX_ITEMS,
  gamingEvidence,
  isTestInfraPath,
  isTestPath,
  mergeManifest,
  namedTestPaths,
  overlaySummary,
  parseNameStatus,
  parseNumstat,
  planOverlay,
  removeCommittedDependencies,
  runDeterministicStage,
  scriptTestMatcher,
  shellSegments,
  stripRoots,
  TAMPER_EVIDENCE_ID,
  TREE_EVIDENCE_ID,
  TREE_MAX_ENTRIES,
  treeSummary,
  type BaselineTree,
  type DeterministicInput,
} from "../src/deterministic.ts";
import { enforce, overall } from "../src/verifier.ts";

const pkg = (scripts: Record<string, string>, extra: Record<string, unknown> = {}) => JSON.stringify({ name: "x", version: "1.0.0", ...extra, scripts }, null, 2);
const noManifests = () => ({ baseline: null, delivered: null });
const rulesOnly = (p: string) => isTestInfraPath(p);

describe("test locations by name", () => {
  it("treats test folders, *.test/*.spec files, snapshots and a ROOT test.js/tests.js/spec.js as tests", () => {
    for (const p of ["test/a.js", "src/__tests__/x.js", "spec/b.rb", "src/a.spec.ts", "x.test.mjs", "tests.js", "test.mjs", "spec.ts", "src/__snapshots__/a.snap"]) expect(isTestPath(p), p).toBe(true);
  });
  it("does not treat source that happens to be named test.js deeper down as a test (review finding 3)", () => {
    for (const p of ["lib/test.js", "src/spec.ts", "src/testing.js", "CHANGELOG.md", "index.js"]) expect(isTestPath(p), p).toBe(false);
  });
  it("counts runner config, package-manager config and lockfiles as test machinery", () => {
    for (const p of [".mocharc.yml", "mocha.opts", "test/mocha.opts", "jest.config.ts", "vitest.config.mts", "tsconfig.test.json", ".babelrc", ".npmrc", ".yarnrc.yml", "packages/a/yarn.lock", "package-lock.json", ".nycrc.json"]) expect(isTestInfraPath(p), p).toBe(true);
    for (const p of ["src/config.js", "README.md", ".github/workflows/ci.yml"]) expect(isTestInfraPath(p), p).toBe(false);
  });
});

describe("planOverlay: what the graded run puts back and takes away", () => {
  it("restores modified, retyped and deleted test machinery, removes what the delivery added there, keeps source and docs", () => {
    const plan = planOverlay(
      [
        { status: "M", path: "test/slugify.js" },
        { status: "D", path: "test/locales.js" },
        { status: "T", path: "tests.js" },
        { status: "A", path: "test/00-setup.js" },
        { status: "A", path: "mocha.opts" },
        { status: "A", path: ".npmrc" },
        { status: "M", path: "package-lock.json" },
        { status: "M", path: "slugify.js" },
        { status: "A", path: "src/new.js" },
        { status: "M", path: "README.md" },
        { status: "A", path: "node_modules/.bin/mocha" },
        { status: "A", path: "packages/new/package.json" },
      ],
      rulesOnly,
      noManifests,
    );
    expect(plan.restore).toEqual(["test/slugify.js", "test/locales.js", "tests.js", "package-lock.json"]);
    expect(plan.restoreDeleted).toEqual(["test/locales.js"]);
    expect(plan.remove).toEqual(["test/00-setup.js", "mocha.opts", ".npmrc"]);
    expect(plan.manifests).toEqual([]);
    expect(plan.dropLockfiles).toBe(false);
  });

  it("rewrites a modified package.json with the baseline's guarded keys; a deleted one comes back whole", () => {
    const before = pkg({ test: "mocha" }, { devDependencies: { mocha: "10.0.0" } });
    const after = pkg({ test: "exit 0" }, { description: "faster", devDependencies: { mocha: "10.0.0" } });
    const plan = planOverlay([{ status: "M", path: "package.json" }, { status: "D", path: "pkg/package.json" }], rulesOnly, (p) => ({ baseline: p === "package.json" ? before : null, delivered: after }));
    expect(plan.manifests).toHaveLength(1);
    expect(plan.manifests[0]!.keys).toEqual(["scripts"]);
    expect(JSON.parse(plan.manifests[0]!.text)).toMatchObject({ scripts: { test: "mocha" }, description: "faster" });
    expect(plan.restore).toEqual(["pkg/package.json"]);
  });

  it("drops the root npm lockfile instead of restoring it when the delivery changes dependencies", () => {
    const before = pkg({ test: "mocha" }, { dependencies: { a: "1.0.0" } });
    const after = pkg({ test: "mocha" }, { dependencies: { a: "1.0.0", b: "2.0.0" } });
    const plan = planOverlay([{ status: "M", path: "package.json" }, { status: "M", path: "package-lock.json" }], rulesOnly, () => ({ baseline: before, delivered: after }));
    expect(plan.dropLockfiles).toBe(true);
    expect(plan.restore).toEqual([]);
    expect(plan.manifests).toEqual([]); // dependencies may change: nothing guarded was touched
  });
});

describe("mergeManifest: baseline values of the test keys, the delivery's everything else", () => {
  it("puts back every guarded key, including ones the delivery added or removed, and keeps the rest", () => {
    const before = pkg({ test: "mocha", build: "node bin/build" }, { main: "index.js", devDependencies: { mocha: "10.0.0" }, engines: { node: ">=8" } });
    const after = JSON.stringify({ name: "x", version: "1.1.0", description: "new", main: "stub.js", scripts: { test: "exit 0" }, dependencies: { leftpad: "1.0.0" }, overrides: { mocha: "file:./fake" }, type: "module" }, null, 4);
    const m = mergeManifest(before, after);
    const out = JSON.parse(m.text!);
    expect(out).toEqual({ name: "x", version: "1.1.0", description: "new", main: "index.js", scripts: { test: "mocha", build: "node bin/build" }, dependencies: { leftpad: "1.0.0" }, devDependencies: { mocha: "10.0.0" }, engines: { node: ">=8" } });
    expect(m.keys).toEqual(["scripts", "devDependencies", "overrides", "engines", "main", "type"]);
    expect(m.dependencyChange).toBe(true);
    // leftpad is absent from every baseline dependency field, so it is a new (unreviewed) dependency; registry source.
    expect(m.newDependencies).toEqual([{ name: "leftpad", spec: "1.0.0", reason: "new", source: null }]);
    expect(m.text).toMatch(/^\{\n {4}"name"/); // the delivery's indentation
  });
  it("puts back a dependencies entry that would replace a baseline dev dependency", () => {
    const before = pkg({ test: "mocha" }, { devDependencies: { mocha: "10.0.0" } });
    const m = mergeManifest(before, pkg({ test: "mocha" }, { devDependencies: { mocha: "10.0.0" }, dependencies: { mocha: "file:./fake", ok: "1.0.0" } }));
    expect(JSON.parse(m.text!).dependencies).toEqual({ ok: "1.0.0" });
    expect(m.keys).toEqual(["dependencies (mocha: a baseline dev dependency)"]);
    // mocha was reverted to the baseline value, so only the genuinely new `ok` is reported.
    expect(m.newDependencies).toEqual([{ name: "ok", spec: "1.0.0", reason: "new", source: null }]);
  });
  it("leaves a manifest that only changed other fields alone, compares independent of key order, and restores unparseable text", () => {
    expect(mergeManifest(pkg({ test: "mocha" }), pkg({ test: "mocha" }, { description: "x" })).text).toBeNull();
    expect(mergeManifest('{"scripts":{"a":"1","b":"2"}}', '{"scripts":{"b":"2","a":"1"}}').text).toBeNull();
    expect(mergeManifest('{"scripts":{}}', "{not json")).toEqual({ text: '{"scripts":{}}', keys: ["whole file (unparseable)"], dependencyChange: false, newDependencies: [] });
  });
});

describe("new/re-pointed dependencies (finding 4, a policy rule)", () => {
  it("classifies a version spec by where its code comes from", () => {
    expect(depSource("^1.2.3")).toBeNull();
    expect(depSource("1.0.0")).toBeNull();
    expect(depSource("file:./vendor/x")).toBe("file");
    expect(depSource("link:../x")).toBe("link");
    expect(depSource("git+https://host/x.git")).toBe("git");
    expect(depSource("github:owner/x")).toBe("git");
    expect(depSource("https://host/x/-/x-1.0.0.tgz")).toBe("tarball");
    expect(depSource("https://host/x")).toBe("url");
    expect(depSource("npm:other@^1.0.0")).toBe("alias");
  });
  it("flags a NEW name (positive) but not a version bump within the same registry name (negative)", () => {
    const before = pkg({ test: "mocha" }, { dependencies: { lib: "^1.0.0" } });
    // positive: a name absent from the baseline, from a local folder.
    const added = mergeManifest(before, pkg({ test: "mocha" }, { dependencies: { lib: "^1.0.0", helper: "file:./vendor/helper" } }));
    expect(added.newDependencies).toEqual([{ name: "helper", spec: "file:./vendor/helper", reason: "new", source: "file" }]);
    // negative: bumping an existing registry dependency does not trigger the rule.
    const bumped = mergeManifest(before, pkg({ test: "mocha" }, { dependencies: { lib: "^2.0.0" } }));
    expect(bumped.newDependencies).toEqual([]);
  });
  it("flags re-pointing an existing name at a non-registry source (file:, git, tarball, alias)", () => {
    const before = pkg({ test: "mocha" }, { dependencies: { lib: "^1.0.0" } });
    const repointed = mergeManifest(before, pkg({ test: "mocha" }, { dependencies: { lib: "file:./evil" } }));
    expect(repointed.newDependencies).toEqual([{ name: "lib", spec: "file:./evil", reason: "source", source: "file" }]);
  });
});

describe("namedTestPaths: what the baseline's test/build scripts and test config name", () => {
  const tree = (paths: string[], texts: Record<string, string> = {}): BaselineTree => ({ paths, texts });

  it("resolves extensionless names (slugify's `node bin/build`) through the script chain, with pre/post scripts", () => {
    const t = tree(["package.json", "bin/build.js", "slugify.js", "config/charmap.json", "test/slugify.js", "tools/check/index.js", "tools/pre.mjs"], {
      "package.json": pkg({ build: "node bin/build", "test:ci": "npx mocha --recursive", test: "npm run build && npm run test:ci", pretest: "node tools/pre", posttest: "node tools/check" }, { main: "./slugify.js" }),
    });
    expect(namedTestPaths(t, ["npm test"])).toEqual({ files: ["bin/build.js", "tools/pre.mjs"], folders: ["tools/check"], globs: [] });
    const m = scriptTestMatcher(t, ["npm test"]);
    expect(["bin/build.js", "tools/check/index.js", "tools/check/added.js", "test/slugify.js"].every(m)).toBe(true);
    // the data the build reads is source: graded by the restored tests, not restored itself
    expect(m("config/charmap.json")).toBe(false);
    expect(m("slugify.js")).toBe(false);
  });

  it("handles --flag=path, flag values, brace globs, quoted paths with spaces and env-borne requires", () => {
    const t = tree(["package.json", "hooks/setup.js", "my tests/all.js", "suite/unit/a.js", "suite/int/b.js", "boot/h.js", "index.js"], {
      "package.json": pkg({ test: `mocha --require=hooks/setup.js 'my tests/all.js' && tape 'suite/{unit,int}/*.js' && NODE_OPTIONS='--require ./boot/h.js' node index.js --reporter spec` }),
    });
    const named = namedTestPaths(t, ["npm test"]);
    expect(named.files).toEqual(["boot/h.js", "hooks/setup.js", "my tests/all.js"]);
    expect(named.globs).toEqual(["suite/int/*.js", "suite/unit/*.js"]);
    expect(named.folders).toEqual([]);
    const m = scriptTestMatcher(t, ["npm test"]);
    expect(m("suite/unit/new.js")).toBe(true);
    expect(m("index.js")).toBe(false); // the package's entry point (no "main": index.js) is source, even when a test script runs it
  });

  it("ignores bare words that are not a baseline path, and never names the package's source", () => {
    const t = tree(["package.json", "src/index.js", "lib/x.js", "CHANGELOG.md", "checks/a.js", "cli.js", "dist/x.js"], {
      "package.json": pkg({ test: "mocha --reporter spec checks && jest src && node --test lib/x.js && node cli.js && prettier --check '**/*.js' && tsc -p .", start: "node src/index.js", lint: "eslint src", "build:changelog": "github-changes --file CHANGELOG.md" }, { main: "src/index.js", bin: { x: "cli.js" } }),
    });
    expect(namedTestPaths(t, ["npm test"])).toEqual({ files: [], folders: ["checks"], globs: [] });
  });

  it("reads config-only test locations: .mocharc spec/require, package.json jest/mocha/ava, a JS jest config", () => {
    const t = tree(["package.json", ".mocharc.yml", "checks/a.js", "setup/hooks.js", "jest.config.js", "jest/setup.js", "it/x.e2e.js", "ava/r.js"], {
      "package.json": pkg({ test: "mocha" }, { jest: { testMatch: ["<rootDir>/it/**/*.e2e.js"] }, ava: { require: ["./ava/r.js"] } }),
      ".mocharc.yml": "spec:\n  - 'checks/**/*.js'\nrequire: ./setup/hooks.js\nreporter: spec\n",
      "jest.config.js": "module.exports = { setupFiles: ['<rootDir>/jest/setup.js'], roots: ['<rootDir>/src'] };\n",
    });
    expect(namedTestPaths(t, ["npm test"])).toEqual({ files: ["ava/r.js", "jest/setup.js", "setup/hooks.js"], folders: [], globs: ["checks/**/*.js", "it/**/*.e2e.js"] });
  });

  it("follows workspace runs into each package's manifest, relative to that package", () => {
    const t = tree(["package.json", "packages/a/package.json", "packages/a/verify.js", "packages/a/index.js"], {
      "package.json": pkg({ test: "npm test --workspaces" }, { workspaces: ["packages/*"] }),
      "packages/a/package.json": pkg({ test: "node verify.js" }),
    });
    expect(namedTestPaths(t, ["npm test"]).files).toEqual(["packages/a/verify.js"]);
  });

  it("tokenises shell commands and expands braces", () => {
    expect(shellSegments(`mocha "test dir/a b.js" --require=./s.js && tape 'x/*.js'; A="--require ./h.js" node t.js`)).toEqual([["mocha", "test dir/a b.js", "--require=./s.js"], ["tape", "x/*.js"], ["A=--require ./h.js", "node", "t.js"]]);
    expect(expandBraces("test/{a,b/{c,d}}.js")).toEqual(["test/a.js", "test/b/c.js", "test/b/d.js"]);
    expect(expandBraces("x{y}z")).toEqual(["x{y}z"]);
  });

  it("parses -z name-status output", () => {
    expect(parseNameStatus("M\0package.json\0A\0test/a b.test.js\0")).toEqual([{ status: "M", path: "package.json" }, { status: "A", path: "test/a b.test.js" }]);
  });

  it("says what was restored and removed", () => {
    expect(overlaySummary("the funding baseline abc", 3, { restored: ["test/slugify.js"], removed: ["test/00-setup.js"], manifests: [{ path: "package.json", keys: ["scripts"] }], lockfilesDropped: [], newDependencies: [] })).toBe(
      "baseline suite: ran the baseline suite from the funding baseline abc (3 file(s) changed); restored test/slugify.js; removed test/00-setup.js; package.json: kept the baseline scripts",
    );
    expect(overlaySummary("x", 1, { restored: [], removed: [], manifests: [], lockfilesDropped: [], newDependencies: [] })).toMatch(/leaves the tests, runner config, scripts and dev dependencies as they were$/);
  });

  it("caps gaming evidence per criterion", () => {
    const hits = Array.from({ length: GAMING_MAX_ITEMS + 5 }, (_, i) => ({ file: "a.js", line: i + 1, rule: "exit" as const, what: "calls process.exit", text: "process.exit(0)" }));
    const ev = gamingEvidence("tests", hits);
    expect(ev).toHaveLength(GAMING_MAX_ITEMS);
    expect(ev[0]).toMatchObject({ id: "evd_gaming_tests_1", criterion_id: "tests", kind: "diff", status: "unclear" });
    expect(ev[GAMING_MAX_ITEMS - 1]!.summary).toMatch(/and 5 more hit\(s\)/);
  });
});

describe("runDeterministicStage: the client's suite grades the delivery (local git repo)", () => {
  let repo: string;
  const shas: Record<string, string> = {};
  const g = (...a: string[]) => execFileSync("git", ["-c", "user.email=t@test", "-c", "user.name=t", ...a], { cwd: repo }).toString().trim();
  const criteria: CriterionSpec[] = [{ id: "tests", kind: "test", description: "tests pass", spec: { command: "npm test" }, required: true }];
  const clientTest = "const t = require('node:test'); const assert = require('node:assert');\nt('x is 1', () => assert.strictEqual(require('../src/x.js'), 1));\n";
  const branch = async (name: string, files: Record<string, string>, from = "main") => {
    g("checkout", "-q", from); g("checkout", "-qb", name);
    for (const [p, text] of Object.entries(files)) {
      await mkdir(join(repo, p, ".."), { recursive: true });
      await writeFile(join(repo, p), text);
    }
    g("add", "-f", "."); g("commit", "-qm", name);
    shas[name] = g("rev-parse", "HEAD");
  };

  beforeAll(async () => {
    repo = await mkdtemp(join(tmpdir(), "milestone-overlay-"));
    await mkdir(join(repo, "test"));
    await mkdir(join(repo, "src"));
    await writeFile(join(repo, "package.json"), pkg({ test: "node --test" }));
    await writeFile(join(repo, "src", "x.js"), "module.exports = 1;\n");
    await writeFile(join(repo, "test", "a.test.js"), clientTest);
    g("init", "-q", "-b", "main"); g("add", "."); g("commit", "-qm", "base");
    shas.root = g("rev-parse", "HEAD");
    // An honest delivery: new source and its own new test.
    await branch("adds", { "src/y.js": "module.exports = 2;\n", "test/b.test.js": "require('node:test')('b', () => {});\n" });
    // A regression hidden by rewriting the test script.
    await branch("script", { "src/x.js": "module.exports = 2;\n", "package.json": pkg({ test: "exit 0" }) });
    // A regression hidden by editing the client's test.
    await branch("edit", { "src/x.js": "module.exports = 2;\n", "test/a.test.js": clientTest.replace("), 1)", "), 2)") });
    // A regression next to an added setup file and runner config (review finding 1).
    await branch("added", { "src/x.js": "module.exports = 2;\n", "test/00-setup.js": "process.exit(0);\n", ".mocharc.yml": "require: ./test/00-setup.js\n" });
    // A regression made invisible under CI=1 (review finding 5): the gaming scan's job.
    await branch("sniff", { "src/x.js": "// CI runs the tests\nmodule.exports = process.env.CI ? 1 : 2;\n" });
    // A sniff that does not even hide the regression: the fail stands.
    await branch("sniffFail", { "src/x.js": "if (process.env.npm_lifecycle_event === 'never') {}\nmodule.exports = 2;\n" });
    // A committed node_modules/.bin/node that exits 0, next to a regression (R1).
    g("checkout", "-q", "main"); g("checkout", "-qb", "fakeNode");
    await writeFile(join(repo, "src", "x.js"), "module.exports = 2;\n");
    await mkdir(join(repo, "node_modules", ".bin"), { recursive: true });
    await writeFile(join(repo, "node_modules", ".bin", "node"), "#!/bin/sh\nexit 0\n");
    await chmod(join(repo, "node_modules", ".bin", "node"), 0o755);
    g("add", "-f", "."); g("commit", "-qm", "vendor");
    shas.fakeNode = g("rev-parse", "HEAD");
    await rm(join(repo, "node_modules"), { recursive: true, force: true });
    // An added lockfile (R3).
    await branch("lock", { "package-lock.json": "{}\n" });
    // An earlier merge breaks the code and weakens the test; the delivery itself only adds a file (R2).
    await branch("earlier", { "src/x.js": "module.exports = 2;\n", "test/a.test.js": "// weakened\n" });
    await branch("afterEarlier", { "src/z.js": "module.exports = 3;\n" }, "earlier");
    g("checkout", "-q", "main");
  });
  afterAll(async () => { await rm(repo, { recursive: true, force: true }); });

  async function stage(sha: string, extra: Partial<DeterministicInput> = {}, inspect?: (workdir: string) => Promise<void>) {
    const out = await runDeterministicStage({ repoUrl: `file://${repo}`, sha, criteria, baselineSha: shas.root!, baselineSource: "funding", ...extra });
    try {
      if (inspect) await inspect(out.workdir);
    } finally {
      await rm(out.workdir, { recursive: true, force: true });
    }
    const v = enforce({ delivery_id: "d", suspected_injection: false, criteria: [{ criterion_id: "tests", status: "pass", confidence: 1, evidence_ids: ["evd_tests"], rationale: "model says pass" }] }, { deliveryId: "d", criteria: [...criteria, ...(extra.criteria ?? [])], evidence: out.evidence });
    return { out, tests: out.evidence.find((e) => e.id === "evd_tests")!, tamper: out.evidence.find((e) => e.id === TAMPER_EVIDENCE_ID)!, delivered: out.evidence.find((e) => e.id === "evd_tests_delivered"), verdict: v.criteria[0]!.status };
  }

  it("an honest delivery: its added test is removed for the graded run, the client's suite passes, its own tests run as information", { timeout: 60_000 }, async () => {
    const fileCrit: CriterionSpec = { id: "own_test", kind: "file", description: "ships a test", spec: { path: "test/b.test.js" }, required: true };
    const { out, tests, tamper, delivered, verdict } = await stage(shas.adds!, { criteria: [...criteria, fileCrit] }, async (wd) => {
      // the workdir shows the delivery again for the judge's read_file
      expect(await readFile(join(wd, "test", "b.test.js"), "utf8")).toMatch(/'b'/);
    });
    expect(out.overlay).toEqual({ restored: [], removed: ["test/b.test.js"], manifests: [], lockfilesDropped: [], newDependencies: [] });
    expect(out.untrusted).toBeNull();
    expect(out.gaming).toEqual([]);
    expect(tamper).toMatchObject({ status: "pass" });
    expect(tamper.summary).toMatch(/^baseline suite: ran the baseline suite from the funding baseline [0-9a-f]{12} \(2 file\(s\) changed\); removed test\/b\.test\.js$/);
    expect(tests).toMatchObject({ status: "pass" });
    expect(tests.summary).toMatch(/^npm test exited 0 with the client's baseline suite/);
    expect(verdict).toBe("pass");
    expect(delivered).toMatchObject({ kind: "log" });
    expect(delivered!.status).toBeUndefined();
    expect(delivered!.criterion_id).toBeUndefined();
    expect(delivered!.summary).toMatch(/^informational, does not decide: npm test .* exited 0/);
    expect(out.evidence.find((e) => e.id === "evd_own_test")).toMatchObject({ status: "pass" }); // delivered, though not in the graded run
  });

  it("with restricted commands (the hosted demo) an allowlisted command runs and any other is never run, recorded unclear", { timeout: 60_000 }, async () => {
    const evil: CriterionSpec = { id: "evil", kind: "build", description: "builds", spec: { command: "npm test; touch PWNED" }, required: true };
    const { out, tests } = await stage(shas.adds!, { restrictCommands: true, criteria: [...criteria, evil] }, async (wd) => {
      await expect(readFile(join(wd, "PWNED"))).rejects.toThrow();
    });
    expect(tests).toMatchObject({ status: "pass" });
    expect(out.evidence.find((e) => e.id === "evd_evil")).toMatchObject({ criterion_id: "evil", status: "unclear" });
  });

  it("a rewritten test script is put back: the client's script runs and the regression fails, whatever a model says", { timeout: 60_000 }, async () => {
    const { out, tests, tamper, delivered, verdict } = await stage(shas.script!);
    expect(out.overlay!.manifests).toEqual([{ path: "package.json", keys: ["scripts"] }]);
    expect(tamper.summary).toMatch(/package\.json: kept the baseline scripts/);
    expect(tests.status).toBe("fail");
    expect(verdict).toBe("fail");
    expect(delivered!.summary).toMatch(/exited 0/); // "exit 0", shown, not graded
  });

  it("an edited client test is restored, so the regression fails; a pass is no longer merely distrusted", { timeout: 60_000 }, async () => {
    const { out, tests, tamper, delivered } = await stage(shas.edit!, {}, async (wd) => {
      expect(await readFile(join(wd, "test", "a.test.js"), "utf8")).toMatch(/\), 2\)/);
    });
    expect(out.overlay!.restored).toEqual(["test/a.test.js"]);
    expect(tamper.summary).toMatch(/restored test\/a\.test\.js/);
    expect(tests.status).toBe("fail");
    expect(delivered!.summary).toMatch(/exited 0/);
  });

  it("added setup files and runner config are removed for the graded run (review finding 1)", { timeout: 60_000 }, async () => {
    const { out, tests } = await stage(shas.added!);
    expect(out.overlay!.removed).toEqual([".mocharc.yml", "test/00-setup.js"]);
    expect(tests.status).toBe("fail");
  });

  it("source that sniffs CI passes the client's suite, and the gaming scan sends it to the client (review finding 5)", { timeout: 60_000 }, async () => {
    const { out, tests, verdict } = await stage(shas.sniff!);
    expect(tests.status).toBe("pass");
    expect(out.gaming).toEqual([{ file: "src/x.js", line: 2, rule: "env-sniff", what: "reads process.env.CI", text: "module.exports = process.env.CI ? 1 : 2;" }]);
    const hit = out.evidence.find((e) => e.id === "evd_gaming_tests_1")!;
    expect(hit).toMatchObject({ criterion_id: "tests", kind: "diff", status: "unclear" });
    expect(hit.summary).toMatch(/^gaming scan: src\/x\.js:2 reads process\.env\.CI \(env-sniff\)/);
    expect(out.evidence.indexOf(hit)).toBeGreaterThan(out.evidence.indexOf(tests));
    expect(verdict).toBe("unclear");
  });

  it("a gaming hit never turns a failing run into unclear", { timeout: 60_000 }, async () => {
    const { out, tests, verdict } = await stage(shas.sniffFail!);
    expect(out.gaming.map((h) => h.rule)).toEqual(["env-sniff"]);
    expect(tests.status).toBe("fail");
    expect(verdict).toBe("fail");
  });

  it("a committed node_modules/.bin/node is removed, so the client's failing test fails", { timeout: 60_000 }, async () => {
    const { out, tests } = await stage(shas.fakeNode!);
    expect(out.logs["setup:remove-committed-node_modules"]).toBe("node_modules");
    expect(out.overlay!.removed).toEqual([]);
    expect(tests.status).toBe("fail");
  });

  it("an added lockfile is removed", { timeout: 60_000 }, async () => {
    const { out, tests } = await stage(shas.lock!);
    expect(out.overlay!.removed).toEqual(["package-lock.json"]);
    expect(tests.status).toBe("pass");
  });

  it("with a baseline, a test weakened in an earlier commit is restored; without one the first-parent fallback says so", { timeout: 60_000 }, async () => {
    const withBaseline = await stage(shas.afterEarlier!);
    expect(withBaseline.out.overlay!.restored).toEqual(["test/a.test.js"]);
    expect(withBaseline.out.baseline).toBe(shas.root);
    expect(withBaseline.tamper.summary).toMatch(/funding baseline/);
    expect(withBaseline.tests.status).toBe("fail");
    const fallback = await stage(shas.afterEarlier!, { baselineSha: null });
    expect(fallback.out.overlay!.restored).toEqual([]);
    expect(fallback.tamper.summary).toMatch(/first parent .* only \(no baseline recorded/);
    expect(fallback.tests.status).toBe("pass");
  });

  it("a root commit with no baseline has no client suite: the pass is not trusted", { timeout: 60_000 }, async () => {
    const { out, tests, tamper } = await stage(shas.root!, { baselineSha: null });
    expect(out.overlay).toBeNull();
    expect(out.untrusted).toMatch(/no parent and no baseline/);
    expect(tamper).toMatchObject({ status: "unclear" });
    expect(tests).toMatchObject({ status: "unclear" });
    expect(tests.summary).toMatch(/^baseline suite: npm test exited 0, but the result is not trusted/);
    // the judge still gets the whole commit as context
    expect(out.evidence.find((e) => e.id === DIFF_EVIDENCE_ID)!.summary).toMatch(/^3 file\(s\) changed against the empty tree \(root commit, no baseline recorded\)/);
  });

  it("a baseline that cannot be fetched, or is not a commit id, fails closed to unclear", { timeout: 60_000 }, async () => {
    const missing = await stage(shas.adds!, { baselineSha: "0123456789abcdef0123456789abcdef01234567" });
    expect(missing.tamper).toMatchObject({ status: "unclear" });
    expect(missing.tamper.summary).toMatch(/baseline 0123456789ab could not be fetched/);
    expect(missing.tests.status).toBe("unclear");
    expect(missing.delivered).toBeUndefined();
    const bogus = await stage(shas.adds!, { baselineSha: "--upload-pack=touch /tmp/x" });
    expect(bogus.tamper.summary).toMatch(/not a commit id/);
    expect(bogus.tests.status).toBe("unclear");
  });

  it("fail-closed: a pass is not trusted, a fail still fails", { timeout: 60_000 }, async () => {
    const bogus = "0123456789abcdef0123456789abcdef01234567";
    expect((await stage(shas.script!, { baselineSha: bogus })).tests.status).toBe("unclear"); // "exit 0" as delivered
    expect((await stage(shas.added!, { baselineSha: bogus })).tests.status).toBe("fail"); // the regression, as delivered
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

describe("demo repo branches under the baseline suite", () => {
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
    const status = (id: string) => out.evidence.find((e) => e.id === id);
    return { overlay: out.overlay, tests: status("evd_tests")!.status, delivered: status("evd_tests_delivered")?.summary.match(/exited (\d+)/)?.[1] };
  }

  it("m1-pass passes the client's suite, as a branch and as a merge; its own new test runs as information", { timeout: 60_000 }, async () => {
    for (const sha of [shas["m1-pass"]!, shas.m1Merge!]) {
      expect(await stage(sha)).toEqual({ overlay: { restored: [], removed: ["test/password.test.js"], manifests: [], lockfilesDropped: [], newDependencies: [] }, tests: "pass", delivered: "0" });
    }
  });

  it("m2-partial and m2-injection: the client's annual-billing test is on main, nothing is restored, and the partial delivery fails it", { timeout: 60_000 }, async () => {
    // The annual-discount test lives on the template's main (the client's test, skipped until annualPriceCents exists),
    // and m2 touches no test file, so the overlay changes nothing, there is no informational pass, and the graded run fails.
    for (const sha of [shas["m2-partial"]!, shas["m2-injection"]!]) {
      expect(await stage(sha)).toEqual({ overlay: { restored: [], removed: [], manifests: [], lockfilesDropped: [], newDependencies: [] }, tests: "fail", delivered: undefined });
    }
    // The merge of m1 then m2 still carries m1's added test file, which is removed for the graded run.
    const merged = await stage(shas.m2Merge!);
    expect(merged.overlay!.restored).toEqual([]);
    expect(merged.overlay!.removed).toEqual(["test/password.test.js"]);
    expect(merged.tests).toBe("fail");
  });
});

describe("context evidence for judgment criteria", () => {
  it("diffSummary lists files with +/- counts, totals and the first 2000 characters of the patch", () => {
    const files = parseNumstat("12\t0\tsrc/password.js\0" + "30\t2\ttest/password.test.js\0" + "-\t-\tlogo.png\0");
    expect(files).toEqual([{ path: "src/password.js", added: 12, deleted: 0 }, { path: "test/password.test.js", added: 30, deleted: 2 }, { path: "logo.png", added: null, deleted: null }]);
    const patch = "x".repeat(DIFF_EXCERPT_CHARS + 500);
    const s = diffSummary("the funding baseline abc", files, patch);
    expect(s).toMatch(/^3 file\(s\) changed against the funding baseline abc, \+42 -2:\n  \+12 -0 src\/password\.js\n  \+30 -2 test\/password\.test\.js\n  binary logo\.png/);
    expect(s).toContain(`diff truncated at ${DIFF_EXCERPT_CHARS} of ${patch.length} characters`);
    expect(s.split("x".repeat(10)).length).toBeLessThan(DIFF_EXCERPT_CHARS / 10 + 3);
  });
  it("treeSummary caps the file list at 200 entries", () => {
    const paths = Array.from({ length: 250 }, (_, i) => `src/f${i}.js`);
    const s = treeSummary(paths);
    expect(s.split("\n")).toHaveLength(1 + TREE_MAX_ENTRIES + 1);
    expect(s).toMatch(/\.\.\. and 50 more/);
  });
  it("commitSummary carries the commit message and PR text, or nothing", () => {
    expect(commitSummary("feat: x\n", { title: "Add x", body: "Adds x." })).toBe("commit message:\nfeat: x\n\ndelivery title: Add x\n\ndelivery description:\nAdds x.");
    expect(commitSummary("  ", {})).toBeNull();
  });
  it("stripRoots removes the workdir and its realpath, longest first", () => {
    const roots = ["/var/folders/ab/T/milestone-verify-1", "/private/var/folders/ab/T/milestone-verify-1"];
    expect(stripRoots("at /private/var/folders/ab/T/milestone-verify-1/test/a.test.js:3 in /var/folders/ab/T/milestone-verify-1", roots)).toBe("at test/a.test.js:3 in .");
  });
});

describe("demo repo m1-pass: citable evidence and no worker paths", () => {
  let demo: string;
  const criteria: CriterionSpec[] = [
    { id: "tests", kind: "test", description: "tests pass", spec: { command: "npm test" }, required: true },
    { id: "judge", kind: "judgment", description: "The delivery matches the milestone description", spec: {}, required: false },
  ];
  beforeAll(async () => {
    demo = await mkdtemp(join(tmpdir(), "milestone-demo-ctx-"));
    execFileSync("bash", [new URL("../../../scripts/make-demo-repo.sh", import.meta.url).pathname, demo], { stdio: "ignore" });
  });
  afterAll(async () => { if (demo) await rm(demo, { recursive: true, force: true }); });

  it("records evd_diff, evd_tree and evd_commit; no summary or log mentions the workdir", { timeout: 60_000 }, async () => {
    const g = (...a: string[]) => execFileSync("git", a, { cwd: demo }).toString().trim();
    const out = await runDeterministicStage({ repoUrl: `file://${demo}`, sha: g("rev-parse", "m1-pass"), criteria, baselineSha: g("rev-parse", "main"), baselineSource: "funding", pullRequest: { title: "Password strength", body: "Adds the check." } });
    try {
      const byId = new Map(out.evidence.map((e) => [e.id, e]));
      expect(byId.get(DIFF_EVIDENCE_ID)).toMatchObject({ kind: "diff" });
      expect(byId.get(DIFF_EVIDENCE_ID)!.status).toBeUndefined();
      expect(byId.get(DIFF_EVIDENCE_ID)!.summary).toMatch(/2 file\(s\) changed against the funding baseline [0-9a-f]{12}, \+\d+ -0:\n  \+\d+ -0 src\/password\.js\n  \+\d+ -0 test\/password\.test\.js/);
      expect(byId.get(DIFF_EVIDENCE_ID)!.summary).toContain("checkPasswordStrength");
      expect(byId.get(TREE_EVIDENCE_ID)).toMatchObject({ kind: "file" });
      expect(byId.get(TREE_EVIDENCE_ID)!.summary).toMatch(/src\/password\.js/);
      expect(byId.get(COMMIT_EVIDENCE_ID)).toMatchObject({ kind: "note", summary: "commit message:\nfeat: password strength check\n\ndelivery title: Password strength\n\ndelivery description:\nAdds the check." });
      const real = execFileSync("realpath", [out.workdir]).toString().trim();
      const everything = [...out.evidence.map((e) => e.summary), ...Object.values(out.logs)].join("\n");
      expect(everything).not.toContain(out.workdir);
      expect(everything).not.toContain(real);
      expect(everything).not.toMatch(/milestone-verify-/);
    } finally {
      await rm(out.workdir, { recursive: true, force: true });
    }
  });

  it("a failing test's output, which names the checkout path, is stripped", { timeout: 60_000 }, async () => {
    const g = (...a: string[]) => execFileSync("git", a, { cwd: demo }).toString().trim();
    const out = await runDeterministicStage({ repoUrl: `file://${demo}`, sha: g("rev-parse", "m2-partial"), criteria, baselineSha: g("rev-parse", "main") });
    try {
      // The client's annual-discount test (on main) fails in the graded run.
      const tests = out.evidence.find((e) => e.id === "evd_tests")!;
      expect(tests.summary).toMatch(/exited 1/);
      expect(tests.summary).not.toMatch(/milestone-verify-/);
      expect(out.logs["tests"]).not.toMatch(/milestone-verify-/);
      expect(out.logs["tests"]).toMatch(/test\/pricing\.test\.js/);
    } finally {
      await rm(out.workdir, { recursive: true, force: true });
    }
  });
});

import { describe, expect, it } from "vitest";
import { describeHit, scanForGaming } from "../src/gaming.ts";

/** A unified diff adding `lines` to `file` (a new file when `start` is 1 and there is no context). */
const diff = (file: string, lines: string[], context: string[] = []) =>
  [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -1,${context.length} +1,${context.length + lines.length} @@`,
    ...context.map((l) => ` ${l}`),
    ...lines.map((l) => `+${l}`),
  ].join("\n");

const rules = (patch: string, opts = {}) => scanForGaming(patch, opts).map((h) => `${h.file}:${h.line} ${h.rule}`);

describe("gaming scan: added source lines that game a test run", () => {
  it("flags exits, env sniffing, patched assertions, loader patches and child_process, naming file:line", () => {
    const patch = [
      diff("index.js", [
        "if (process.env.CI) { return expected; }",
        "const lifecycle = process.env['npm_lifecycle_event'];",
        "const { JEST_WORKER_ID } = process.env;",
        "if (process.env.NODE_ENV === 'test') process.exit(0);",
        "process.exitCode = 0;",
        "process.on('exit', () => { process.exitCode = 0; });",
        "require('assert').strictEqual = () => {};",
        "assert.deepEqual = function () {};",
        "global.it = () => {};",
        "describe.skip = describe;",
        "Object.assign(expect, { toBe() {} });",
        "Module._load = function (r) { return {}; };",
        "require.cache[k] = { exports: {} };",
        "delete require.cache[k];",
        "const cp = require('node:child_process');",
        "import { execSync } from 'child_process';",
        "if (process.env.VITEST || process.env.MOCHA_COLORS) {}",
      ]),
    ].join("\n");
    expect(rules(patch)).toEqual([
      "index.js:1 env-sniff",
      "index.js:2 env-sniff",
      "index.js:3 env-sniff",
      "index.js:4 exit",
      "index.js:4 env-sniff",
      "index.js:5 exit",
      "index.js:6 exit",
      "index.js:7 assert-patch",
      "index.js:8 assert-patch",
      "index.js:9 assert-patch",
      "index.js:10 assert-patch",
      "index.js:11 assert-patch",
      "index.js:12 loader-patch",
      "index.js:13 loader-patch",
      "index.js:14 loader-patch",
      "index.js:15 child-process",
      "index.js:16 child-process",
      "index.js:17 env-sniff",
    ]);
    const [first] = scanForGaming(patch);
    expect(describeHit(first!)).toBe("index.js:1 reads process.env.CI (env-sniff): if (process.env.CI) { return expected; }");
  });

  it("counts line numbers from the hunk header, through context lines, and skips removed lines", () => {
    const patch = ["diff --git a/lib/a.js b/lib/a.js", "--- a/lib/a.js", "+++ b/lib/a.js", "@@ -10,3 +10,3 @@", " var a = 1;", "-var b = 2;", "+var b = process.env.CI ? 1 : 2;", " var c = 3;", "@@ -40,1 +40,2 @@", " x();", "+process.exit(1);"].join("\n");
    expect(rules(patch)).toEqual(["lib/a.js:11 env-sniff", "lib/a.js:41 exit"]);
  });

  it("ignores comments, string literals and honest uses", () => {
    const patch = diff("src/a.ts", [
      "// process.exit(0) when CI is set",
      "/* process.env.CI",
      "   assert.ok = noop */ const ok = 1;",
      "const msg = 'call process.exit() or read process.env.CI';",
      'const tpl = `process.env.CI ${"x"}`;',
      "if (process.env.NODE_ENV !== 'production') warn();",
      "const assert = require('assert');",
      "let expect = 3; const isTest = expect === 3;",
      "if (assert.equal(a, b) == null) {}",
      "const url = 'https://x/describe=1';",
      "const cache = new Map(); cache.set(k, v);",
    ]);
    expect(rules(patch)).toEqual([]);
  });

  it("does not scan test files, skipped infrastructure, non-source files or committed node_modules", () => {
    const sniff = ["if (process.env.CI) return;"];
    const patch = [diff("test/a.js", sniff), diff("src/a.test.ts", sniff), diff("bin/build.js", sniff), diff("README.md", sniff), diff("node_modules/x/index.js", sniff), diff("src/ok.mjs", sniff)].join("\n");
    expect(rules(patch, { skip: (p: string) => p.startsWith("test/") || /\.test\./.test(p) || p === "bin/build.js" })).toEqual(["src/ok.mjs:1 env-sniff"]);
  });

  it("lets bin/ and scripts/ CLIs exit when the baseline already exited there, and nowhere else", () => {
    const exit = ["process.exit(1);"];
    const patch = [diff("bin/cli.js", exit), diff("bin/new.js", exit), diff("scripts/release.js", exit), diff("src/lib.js", exit)].join("\n");
    expect(rules(patch, { baselineExits: ["bin/cli.js"] })).toEqual(["scripts/release.js:1 exit", "src/lib.js:1 exit"]);
    // env sniffing in a CLI is still reported
    expect(rules(diff("bin/cli.js", ["if (process.env.CI) process.exit(0);"]), { baselineExits: ["bin/cli.js"] })).toEqual(["bin/cli.js:1 env-sniff"]);
  });

  it("reads git's quoted paths and a deleted file adds nothing", () => {
    const quoted = ['diff --git "a/src/a b\\303\\251.js" "b/src/a b\\303\\251.js"', '--- "a/src/a b\\303\\251.js"', '+++ "b/src/a b\\303\\251.js"', "@@ -0,0 +1 @@", "+process.abort();"].join("\n");
    expect(rules(quoted)).toEqual(["src/a bé.js:1 exit"]);
    const deleted = ["diff --git a/src/x.js b/src/x.js", "--- a/src/x.js", "+++ /dev/null", "@@ -1 +0,0 @@", "-process.exit(0);"].join("\n");
    expect(rules(deleted)).toEqual([]);
  });
});

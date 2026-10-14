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

// Each new rule below has a positive example (flagged) and a negative example (not flagged), per the task.
describe("test-detect: a non-env signal matched against a test runner name (finding 1)", () => {
  it("flags process.argv compared with a runner name; a plain CLI argv read is not flagged", () => {
    // positive: the value of process.argv is matched against a runner name (mocha).
    expect(rules(diff("index.js", ["var underTest = process.argv.join(' ').indexOf('mocha') !== -1;"]))).toEqual(["index.js:1 test-detect"]);
    // negative: a CLI legitimately reads process.argv with no runner name in sight.
    expect(rules(diff("bin/cli.js", ["const args = process.argv.slice(2);", "const file = args[0];"]))).toEqual([]);
  });
  it("flags require.main / process.mainModule / a stack trace matched against a runner name; require.main === module is not flagged", () => {
    // positive: require.main.filename is tested against a runner name.
    expect(rules(diff("index.js", ["if (require.main && /_mocha/.test(require.main.filename)) ready = true;"]))).toEqual(["index.js:1 test-detect"]);
    // positive: process.mainModule path checked for a runner.
    expect(rules(diff("index.js", ["if (process.mainModule && process.mainModule.path.includes('mocha')) ok();"]))).toEqual(["index.js:1 test-detect"]);
    // positive: a saved stack trace, matched against a runner name on a later line.
    expect(rules(diff("index.js", ["const s = new Error().stack || '';", "if (s.includes('node_modules/mocha')) correct();"]))).toEqual(["index.js:2 test-detect"]);
    // negative: the ordinary "am I the entry point" CLI idiom has no runner name.
    expect(rules(diff("index.js", ["if (require.main === module) main();"]))).toEqual([]);
  });
  it("flags module.parent used to branch; storing a value on module.exports is not flagged", () => {
    // positive: branching on module.parent to tell a test runner from direct use.
    expect(rules(diff("index.js", ["if (module.parent) correct(); else broken();"]))).toEqual(["index.js:1 test-detect"]);
    // negative: assigning module.exports is ordinary and not a signal read.
    expect(rules(diff("index.js", ["module.exports.parent = createParent();"]))).toEqual([]);
  });
});

describe("assert-patch: writing to an assertion library in every listed form (finding 2)", () => {
  it("flags an inline require(lib).prototype write; calling an assertion is not flagged", () => {
    // positive: patching a non-'assert' assertion library inline.
    expect(rules(diff("index.js", ["require('expect.js').Assertion.prototype.assert = function () { return this; };"]))).toEqual(["index.js:1 assert-patch"]);
    // negative: using chai's expect to make an assertion.
    expect(rules(diff("index.js", ["require('chai').expect(value).to.equal(2);"]))).toEqual([]);
  });
  it("flags an aliased assert whose property is later overwritten; just holding the alias is not flagged", () => {
    // positive: const a = require('assert'); then a.equal / a[k] overwritten.
    expect(rules(diff("index.js", ["const a = require('assert');", "a.equal = function () {};", "a['deepEqual'] = function () {};"]))).toEqual(["index.js:2 assert-patch", "index.js:3 assert-patch"]);
    // negative: aliasing assert and only calling it.
    expect(rules(diff("index.js", ["const a = require('assert');", "a.equal(actual, expected);"]))).toEqual([]);
  });
  it("flags Object.prototype writes and defineProperty on it; a plain object property write is not flagged", () => {
    // positive: prototype pollution via Object.defineProperty and via direct assignment.
    expect(rules(diff("index.js", ["Object.defineProperty(Object.prototype, 'eql', { value: () => true });"]))).toEqual(["index.js:1 assert-patch"]);
    expect(rules(diff("index.js", ["Object.prototype.eql = () => true;"]))).toEqual(["index.js:1 assert-patch"]);
    // negative: defining a property on an ordinary object.
    expect(rules(diff("index.js", ["Object.defineProperty(target, 'eql', { value: 1 });"]))).toEqual([]);
  });
  it("flags Reflect.defineProperty on an assertion module; on an ordinary object it is not flagged", () => {
    // positive: redefining an assertion method through Reflect.
    expect(rules(diff("index.js", ["Reflect.defineProperty(require('assert'), 'equal', { value: () => {} });"]))).toEqual(["index.js:1 assert-patch"]);
    // negative: Reflect.defineProperty on some other object.
    expect(rules(diff("index.js", ["Reflect.defineProperty(cfg, 'equal', { value: 1 });"]))).toEqual([]);
  });
  it("flags a computed-key assignment to global/globalThis/process; a computed read is not flagged", () => {
    // positive: installing a fake global assertion through a computed key.
    expect(rules(diff("index.js", ["global['ex' + 'pect'] = () => ({ to: { equal: () => {} } });"]))).toEqual(["index.js:1 assert-patch"]);
    // negative: reading a computed global key.
    expect(rules(diff("index.js", ["const fn = global[name];"]))).toEqual([]);
  });
});

describe("exit: an obfuscated computed process call (finding 3)", () => {
  it("flags process[k](0) and process['ex'+'it'](0); a computed env read is not flagged", () => {
    // positive: calling a computed process method (hidden process.exit).
    expect(rules(diff("index.js", ["process['ex' + 'it'](0);"]))).toEqual(["index.js:1 exit"]);
    expect(rules(diff("index.js", ["var k = 'exit'; process[k](0);"]))).toEqual(["index.js:1 exit"]);
    // negative: reading a computed process.env key (that is env-sniff territory, not an exit, and NODE_ENV!==prod is honest).
    expect(rules(diff("index.js", ["const home = process.env['HOME'];"]))).toEqual([]);
  });
});

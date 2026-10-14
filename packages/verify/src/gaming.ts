/**
 * Gaming scan, no model: the ADDED lines of the delivery's non-test source files, searched for code that games a test
 * run instead of passing it. The deterministic stage already runs the client's own baseline suite (restored test
 * files, runner config, scripts and dev dependencies), so a delivery can no longer edit the grader; what it can still
 * do is ship source that notices it is under test, or patches the assertions at require time:
 *
 * - exit: process.exit / kill / abort / reallyExit, process.exitCode = ..., process.on('exit' | 'beforeExit'), and an
 *   obfuscated computed call process[k](...) / process['ex'+'it'](...)
 * - env-sniff: reads of process.env.CI, npm_lifecycle_event, npm_lifecycle_script, VITEST, JEST_WORKER_ID, MOCHA*,
 *   and NODE_ENV unless it is compared with "production" or "development" (the common, honest use)
 * - test-detect: notices it is under a test runner by a non-env signal (process.argv, require.main / its filename,
 *   process.mainModule, module.parent, a new Error().stack) when that signal is matched against a known runner name
 *   (mocha, jest, vitest, ava, tap, tape, node:test, uvu, jasmine, karma) or, for module.parent, used to branch. A
 *   CLI that only reads process.argv is not flagged.
 * - assert-patch: reassigning or monkeypatching an assertion library. Any write to a property of a value obtained
 *   from require/import of a known assertion library (assert, node:assert, chai, expect.js, should, jest's expect,
 *   power-assert, uvu/assert), inline (require('chai').Assertion.prototype.x = ...) or through a local alias
 *   (const a = require('assert'); a.equal = ...; a[k] = ...); any write to assert / expect / it / describe (also
 *   through global.*); Object.prototype writes and Object.defineProperty/defineProperties/Reflect.defineProperty on
 *   Object.prototype or an assertion module; and a computed-key assignment to process / global / globalThis
 *   (global['exp'+'ect'] = ...).
 * - loader-patch: assigning Module._load / _resolveFilename / _compile / _extensions, writing to or deleting from
 *   require.cache
 * - child-process: requiring or importing child_process in library code
 *
 * Each hit names file:line. The stage records every hit as unclear evidence on the test criterion, which sends the
 * milestone to the client (P3) instead of trusting a pass; it never fails anything on its own.
 *
 * False positives are kept low: only JS/TS files; test files and the test infrastructure the stage restores are not
 * scanned (they do not run in the graded pass); comments and string literals never match; exits in bin/ and scripts/
 * CLIs are ignored when the baseline already had process.exit in that file or folder.
 */

export type GamingRule = "exit" | "env-sniff" | "test-detect" | "assert-patch" | "loader-patch" | "child-process";

export interface GamingHit {
  file: string;
  /** 1-based line in the delivered file. */
  line: number;
  rule: GamingRule;
  /** What matched, in words. */
  what: string;
  /** The added line, trimmed and capped. */
  text: string;
}

export interface GamingScanOptions {
  /** Paths not scanned: test files and everything else the stage restores or removes before the graded run. */
  skip?: (path: string) => boolean;
  /** Baseline files that already called process.exit; bin/ and scripts/ files in them (or in their folder) may exit. */
  baselineExits?: Iterable<string>;
}

const SOURCE = /\.(?:[cm]?[jt]sx?)$/i;
const CLI_DIR = /(^|\/)(bin|scripts)\//;
const TEXT_MAX = 160;

const ENV_NAMES = "CI|NODE_ENV|npm_lifecycle_event|npm_lifecycle_script|VITEST(?:_[A-Z_]+)?|JEST_WORKER_ID|MOCHA(?:_[A-Z_]+)?";
const TEST_GLOBALS = "assert|expect|it|describe";
/** Test-runner names a signal may be compared against (tape before tap so the longer alternative wins). */
const RUNNER_NAMES = "mocha|_mocha|jest|vitest|ava|tape|tap|node:test|uvu|jasmine|karma";
const RUNNER_RE = new RegExp(`(?:^|[^\\w$])(?:${RUNNER_NAMES})(?![\\w$])`);
/** Assertion libraries whose require() result (or a local alias of it) must not be written to. */
const ASSERT_LIB = "(?:node:)?assert(?:/strict)?|chai|expect\\.js|should|power-assert|uvu/assert";
const REQUIRE_ASSERT = `require\\s*\\(\\s*['"\`](?:${ASSERT_LIB})['"\`]\\s*\\)`;
/** A `.prop` / `[expr]` chain ending in an assignment (not == or =>). */
const PROP_WRITE = `((?:\\s*\\.\\s*[\\w$]+|\\s*\\[[^\\]]*\\])+)\\s*=(?![=>])`;
/** Non-env signals that a library can use to notice it runs under a test runner. */
const SIGNALS = {
  argv: /\bprocess\s*\.\s*argv\b/,
  requireMain: /\brequire\s*\.\s*main\b/,
  mainModule: /\bprocess\s*\.\s*mainModule\b/,
  moduleParent: /\bmodule\s*\.\s*parent\b/,
  stack: /\.\s*stack\b/,
} as const;
/** module.parent (and a tracked alias of a signal) counts as test detection when used to branch. */
const BRANCH_RE = /\bif\s*\(|\breturn\b|\bwhile\s*\(|[?]|&&|\|\||!\s*module\b/;
type SignalKind = "argv" | "require.main" | "mainmod" | "module.parent" | "stack";
type SymbolKind = SignalKind | "assert";
/** Per-file symbol table: locals bound to a signal or to require() of an assertion library. */
export interface ScanCtx {
  symbols: Map<string, SymbolKind>;
}
const newCtx = (): ScanCtx => ({ symbols: new Map() });
const escapeId = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

interface Pattern {
  rule: GamingRule;
  re: RegExp;
  what: (m: RegExpExecArray) => string;
  /** Extra filter on the whole (comment-free) line. */
  keep?: (line: string, m: RegExpExecArray) => boolean;
}

const PATTERNS: Pattern[] = [
  { rule: "exit", re: /\bprocess\s*(?:\.\s*|\[\s*['"`])(exit|kill|abort|reallyExit)\b/g, what: (m) => `calls process.${m[1]}` },
  // Obfuscated exit: process[k](...) / process['ex'+'it'](...) — a computed member *call* on process.
  { rule: "exit", re: /\bprocess\s*\[[^\]]*\]\s*\(/g, what: () => "calls a computed process method (obfuscated exit)" },
  { rule: "exit", re: /\bprocess\s*\.\s*exitCode\s*=(?![=>])/g, what: () => "sets process.exitCode" },
  { rule: "exit", re: /\bprocess\s*\.\s*(?:on|once|addListener|prependListener|prependOnceListener)\s*\(\s*['"`](exit|beforeExit)['"`]/g, what: (m) => `listens for process '${m[1]}'` },
  {
    rule: "env-sniff",
    re: new RegExp(`\\bprocess\\s*\\.\\s*env\\s*(?:\\.\\s*(${ENV_NAMES})\\b|\\[\\s*['"\`](${ENV_NAMES})['"\`]\\s*\\])`, "g"),
    what: (m) => `reads process.env.${m[1] ?? m[2]}`,
    // NODE_ENV compared with production/development is how libraries strip dev warnings; anything else is a sniff.
    keep: (line, m) => (m[1] ?? m[2]) !== "NODE_ENV" || !/['"`](production|development)['"`]/.test(line),
  },
  {
    rule: "env-sniff",
    re: new RegExp(`\\{[^}]*\\b(${ENV_NAMES})\\b[^}]*\\}\\s*=\\s*process\\s*\\.\\s*env\\b`, "g"),
    what: (m) => `destructures ${m[1]} from process.env`,
  },
  {
    rule: "assert-patch",
    re: new RegExp(`(?<![\\w$.])(?<!\\b(?:var|let|const)\\s+)(?:(?:global|globalThis|window)\\s*\\.\\s*)?(${TEST_GLOBALS})((?:\\s*\\.\\s*[\\w$]+)*)\\s*=(?![=>])`, "g"),
    what: (m) => `reassigns ${m[1]}${m[2]?.replace(/\s+/g, "") ?? ""}`,
  },
  {
    // Inline write to a property of require()'d assertion library: require('chai').Assertion.prototype.x = ...
    rule: "assert-patch",
    re: new RegExp(`\\b${REQUIRE_ASSERT}${PROP_WRITE}`, "g"),
    what: (m) => `reassigns require(<assertion library>)${m[1]!.replace(/\s+/g, "")}`,
  },
  {
    rule: "assert-patch",
    re: new RegExp(`\\bObject\\s*\\.\\s*(?:assign|defineProperty|defineProperties|setPrototypeOf)\\s*\\(\\s*(?:(?:global|globalThis)\\s*\\.\\s*)?(${TEST_GLOBALS}|${REQUIRE_ASSERT})`, "g"),
    what: (m) => `patches ${m[1]!.startsWith("require") ? "an assertion module" : m[1]} through Object.*`,
  },
  {
    // Prototype pollution: Object.prototype.x = ... or Object.defineProperty(Object.prototype, ...).
    rule: "assert-patch",
    re: /\bObject\s*\.\s*prototype\s*(?:\.\s*[\w$]+|\[[^\]]*\])\s*=(?![=>])/g,
    what: () => "writes Object.prototype",
  },
  {
    rule: "assert-patch",
    re: /\b(?:Object|Reflect)\s*\.\s*define(?:Propert(?:y|ies))\s*\(\s*Object\s*\.\s*prototype\b/g,
    what: () => "defines a property on Object.prototype",
  },
  {
    // Reflect.defineProperty on a require()'d assertion module.
    rule: "assert-patch",
    re: new RegExp(`\\bReflect\\s*\\.\\s*defineProperty\\s*\\(\\s*${REQUIRE_ASSERT}`, "g"),
    what: () => "redefines a property of an assertion module through Reflect.defineProperty",
  },
  {
    // Computed-key assignment to process / global / globalThis: global['ex'+'pect'] = ...
    rule: "assert-patch",
    re: /\b(process|global|globalThis)\s*\[[^\]]*\]\s*=(?![=>])/g,
    what: (m) => `assigns a computed key on ${m[1]}`,
  },
  { rule: "loader-patch", re: /\.\s*(_load|_resolveFilename|_compile|_extensions)\b(?:\s*\[[^\]]*\])?\s*=(?![=>])/g, what: (m) => `assigns Module.${m[1]}` },
  { rule: "loader-patch", re: /\brequire\s*\.\s*cache\b(?:\s*\[[^\]]*\])?\s*=(?![=>])/g, what: () => "writes require.cache" },
  { rule: "loader-patch", re: /\bdelete\s+require\s*\.\s*cache\b/g, what: () => "deletes from require.cache" },
  { rule: "child-process", re: /\b(?:require|import)\s*\(\s*['"`](?:node:)?child_process['"`]/g, what: () => "loads child_process" },
  { rule: "child-process", re: /\bfrom\s*['"`](?:node:)?child_process['"`]/g, what: () => "imports child_process" },
];

/** Character classes of a line: code, string or comment. Carries block-comment and template state across lines. */
interface LexState {
  block: boolean;
  template: boolean;
}

/**
 * Returns the line with comments blanked and a mask marking string-literal characters, so a match can be required to
 * start in code. Regex literals are not recognised (a quote inside one may hide the rest of the line, which only ever
 * hides a hit, never invents one).
 */
export function lexLine(line: string, state: LexState): { code: string; inString: boolean[] } {
  const out: string[] = [];
  const inString: boolean[] = [];
  let quote: string | null = state.template ? "`" : null;
  let i = 0;
  const push = (ch: string, str: boolean) => { out.push(ch); inString.push(str); };
  while (i < line.length) {
    const ch = line[i]!;
    if (state.block) {
      if (ch === "*" && line[i + 1] === "/") { state.block = false; push(" ", false); push(" ", false); i += 2; } else { push(" ", false); i++; }
      continue;
    }
    if (quote) {
      if (ch === "\\") { push(ch, true); if (i + 1 < line.length) push(line[i + 1]!, true); i += 2; continue; }
      push(ch, ch !== quote);
      if (ch === quote) quote = null;
      i++;
      continue;
    }
    if (ch === "/" && line[i + 1] === "/") break;
    if (ch === "/" && line[i + 1] === "*") { state.block = true; push(" ", false); push(" ", false); i += 2; continue; }
    if (ch === "'" || ch === '"' || ch === "`") { quote = ch; push(ch, false); i++; continue; }
    push(ch, false);
    i++;
  }
  // Single and double quotes end with the line; a template literal continues.
  state.template = quote === "`";
  return { code: out.join(""), inString };
}

/** A code match that starts outside a string literal. */
function matchInCode(re: RegExp, code: string, inString: boolean[], keep?: Pattern["keep"]): RegExpExecArray | null {
  re.lastIndex = 0;
  for (let m = re.exec(code); m; m = re.exec(code)) {
    if (inString[m.index]) continue;
    if (keep && !keep(code, m)) continue;
    return m;
  }
  return null;
}

/**
 * Updates the per-file symbol table from a declaration on this line: a local bound to require() of an assertion
 * library, or to one of the non-env test-detection signals. Runs on added and context lines alike, so a write on a
 * later added line is attributed to a signal/alias declared just above it (even in context).
 */
export function updateSymbols(code: string, inString: boolean[], ctx: ScanCtx): void {
  const re = /(?:^|[^\w$.])(?:var|let|const)\s+([\w$]+)\s*=\s*/g;
  for (let m = re.exec(code); m; m = re.exec(code)) {
    if (inString[m.index]) continue;
    const name = m[1]!;
    const rhs = code.slice(m.index + m[0].length);
    const kind = classifyRhs(rhs);
    if (kind) ctx.symbols.set(name, kind);
  }
}

function classifyRhs(rhs: string): SymbolKind | null {
  if (new RegExp(`\\b${REQUIRE_ASSERT}`).test(rhs)) return "assert";
  if (SIGNALS.argv.test(rhs)) return "argv";
  if (SIGNALS.requireMain.test(rhs)) return "require.main";
  if (SIGNALS.mainModule.test(rhs)) return "mainmod";
  if (SIGNALS.moduleParent.test(rhs)) return "module.parent";
  if (SIGNALS.stack.test(rhs)) return "stack";
  return null;
}

/** Hits in one line of code (comments already blanked), at most one per rule; a match must start outside string literals. */
export function scanLine(code: string, inString: boolean[], ctx: ScanCtx = newCtx()): Array<{ rule: GamingRule; what: string }> {
  const hits: Array<{ rule: GamingRule; what: string }> = [];
  const add = (rule: GamingRule, what: string) => { if (!hits.some((h) => h.rule === rule)) hits.push({ rule, what }); };
  for (const p of PATTERNS) {
    const m = matchInCode(p.re, code, inString, p.keep);
    if (m) add(p.rule, p.what(m));
  }
  // test-detect: a non-env signal matched against a runner name (or, for module.parent, used to branch). Both the
  // signal on this line and a tracked alias of it count; a CLI that only reads process.argv is not flagged.
  const runner = RUNNER_RE.test(code);
  const refOf = (name: string) => matchInCode(new RegExp(`(?:^|[^\\w$.])${escapeId(name)}(?![\\w$])`), code, inString);
  if (runner && matchInCode(SIGNALS.argv, code, inString)) add("test-detect", "matches process.argv against a test runner name");
  if (runner && matchInCode(SIGNALS.requireMain, code, inString)) add("test-detect", "inspects require.main against a test runner name");
  if (runner && matchInCode(SIGNALS.mainModule, code, inString)) add("test-detect", "inspects process.mainModule against a test runner name");
  if ((runner || BRANCH_RE.test(code)) && matchInCode(SIGNALS.moduleParent, code, inString)) add("test-detect", "branches on module.parent to detect a test run");
  if (runner && matchInCode(SIGNALS.stack, code, inString)) add("test-detect", "inspects a stack trace for a test runner name");
  for (const [name, kind] of ctx.symbols) {
    if (hits.some((h) => h.rule === "test-detect")) break;
    if (kind === "assert" || kind === "module.parent") continue;
    if ((runner) && refOf(name)) add("test-detect", `matches ${name} (a saved ${kind === "require.main" ? "require.main" : kind} value) against a test runner name`);
  }
  for (const [name, kind] of ctx.symbols) {
    if (kind === "module.parent" && BRANCH_RE.test(code) && refOf(name)) add("test-detect", `branches on ${name} (a saved module.parent value) to detect a test run`);
  }
  // assert-patch through a local alias of a required assertion library: a.equal = ..., a[k] = ..., Reflect.defineProperty(a, ...).
  for (const [name, kind] of ctx.symbols) {
    if (kind !== "assert" || hits.some((h) => h.rule === "assert-patch")) continue;
    if (matchInCode(new RegExp(`(?:^|[^\\w$.])${escapeId(name)}${PROP_WRITE}`), code, inString)) { add("assert-patch", `writes a property of ${name} (an aliased assertion module)`); break; }
    if (matchInCode(new RegExp(`\\bReflect\\s*\\.\\s*defineProperty\\s*\\(\\s*${escapeId(name)}\\b`), code, inString)) { add("assert-patch", `redefines a property of ${name} (an aliased assertion module)`); break; }
  }
  return hits;
}

const dirOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");

/**
 * Scans a unified diff (`git diff --no-renames`, any context size) and returns the hits in added lines, in diff order.
 * Context lines feed the comment/template state so a hit inside a block comment opened above is not reported.
 */
export function scanForGaming(patch: string, opts: GamingScanOptions = {}): GamingHit[] {
  const exits = new Set(opts.baselineExits ?? []);
  const exitDirs = new Set([...exits].map(dirOf));
  const hits: GamingHit[] = [];
  let file: string | null = null;
  let scan = false;
  let line = 0;
  let state: LexState = { block: false, template: false };
  let ctx: ScanCtx = newCtx();
  for (const raw of patch.split("\n")) {
    if (raw.startsWith("diff --git ")) { file = null; scan = false; continue; }
    if (raw.startsWith("+++ ")) {
      const target = raw.slice(4).replace(/\t.*$/, "");
      file = target === "/dev/null" ? null : unquote(target).replace(/^b\//, "");
      scan = !!file && SOURCE.test(file) && !/(^|\/)node_modules\//i.test(file) && !(opts.skip?.(file) ?? false);
      ctx = newCtx();
      continue;
    }
    if (raw.startsWith("--- ")) continue;
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) { line = Number(hunk[1]); state = { block: false, template: false }; continue; }
    if (!file || !scan) continue;
    if (raw.startsWith("-") || raw.startsWith("\\")) continue;
    const added = raw.startsWith("+");
    const text = raw.slice(1);
    const lexed = lexLine(text, state);
    // Track aliases/signals from added and context lines so a later added write can be attributed to them.
    updateSymbols(lexed.code, lexed.inString, ctx);
    if (added) {
      for (const h of scanLine(lexed.code, lexed.inString, ctx)) {
        if (h.rule === "exit" && CLI_DIR.test(file) && (exits.has(file) || exitDirs.has(dirOf(file)))) continue;
        const t = text.trim();
        hits.push({ file, line, rule: h.rule, what: h.what, text: t.length > TEXT_MAX ? `${t.slice(0, TEXT_MAX)}...` : t });
      }
    }
    line++;
  }
  return hits;
}

/** git quotes paths with unusual characters as C strings: "b/a\tb.js". */
function unquote(p: string): string {
  if (!p.startsWith('"') || !p.endsWith('"')) return p;
  const body = p.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch !== "\\") { bytes.push(...Buffer.from(ch, "utf8")); continue; }
    const next = body[++i] ?? "";
    if (/[0-7]/.test(next)) { bytes.push(parseInt(body.slice(i, i + 3), 8)); i += 2; continue; }
    bytes.push(({ n: 10, t: 9, r: 13, '"': 34, "\\": 92, a: 7, b: 8, f: 12, v: 11 } as Record<string, number>)[next] ?? next.charCodeAt(0));
  }
  return Buffer.from(bytes).toString("utf8");
}

/** One evidence line per hit: "index.js:48 reads process.env.CI (env-sniff): if (process.env.CI) {". */
export function describeHit(h: GamingHit): string {
  return `${h.file}:${h.line} ${h.what} (${h.rule}): ${h.text}`;
}

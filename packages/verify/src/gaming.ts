/**
 * Gaming scan, no model: the ADDED lines of the delivery's non-test source files, searched for code that games a test
 * run instead of passing it. The deterministic stage already runs the client's own baseline suite (restored test
 * files, runner config, scripts and dev dependencies), so a delivery can no longer edit the grader; what it can still
 * do is ship source that notices it is under test, or patches the assertions at require time:
 *
 * - exit: process.exit / kill / abort / reallyExit, process.exitCode = ..., process.on('exit' | 'beforeExit')
 * - env-sniff: reads of process.env.CI, npm_lifecycle_event, npm_lifecycle_script, VITEST, JEST_WORKER_ID, MOCHA*,
 *   and NODE_ENV unless it is compared with "production" or "development" (the common, honest use)
 * - assert-patch: reassigning or monkeypatching assert / expect / it / describe (also through require('assert'),
 *   global.* and Object.assign / defineProperty)
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

export type GamingRule = "exit" | "env-sniff" | "assert-patch" | "loader-patch" | "child-process";

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

interface Pattern {
  rule: GamingRule;
  re: RegExp;
  what: (m: RegExpExecArray) => string;
  /** Extra filter on the whole (comment-free) line. */
  keep?: (line: string, m: RegExpExecArray) => boolean;
}

const PATTERNS: Pattern[] = [
  { rule: "exit", re: /\bprocess\s*(?:\.\s*|\[\s*['"`])(exit|kill|abort|reallyExit)\b/g, what: (m) => `calls process.${m[1]}` },
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
    rule: "assert-patch",
    re: /\brequire\s*\(\s*['"`](?:node:)?assert(?:\/strict)?['"`]\s*\)((?:\s*\.\s*[\w$]+)+)\s*=(?![=>])/g,
    what: (m) => `reassigns require('assert')${m[1]!.replace(/\s+/g, "")}`,
  },
  {
    rule: "assert-patch",
    re: new RegExp(`\\bObject\\s*\\.\\s*(?:assign|defineProperty|defineProperties|setPrototypeOf)\\s*\\(\\s*(?:(?:global|globalThis)\\s*\\.\\s*)?(${TEST_GLOBALS}|require\\s*\\(\\s*['"\`](?:node:)?assert)\\b`, "g"),
    what: (m) => `patches ${m[1]!.startsWith("require") ? "require('assert')" : m[1]} through Object.*`,
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

/** Hits in one line of code (comments already blanked), at most one per rule; a match must start outside string literals. */
export function scanLine(code: string, inString: boolean[]): Array<{ rule: GamingRule; what: string }> {
  const hits: Array<{ rule: GamingRule; what: string }> = [];
  for (const p of PATTERNS) {
    if (hits.some((h) => h.rule === p.rule)) continue;
    p.re.lastIndex = 0;
    for (let m = p.re.exec(code); m; m = p.re.exec(code)) {
      if (inString[m.index]) continue;
      if (p.keep && !p.keep(code, m)) continue;
      hits.push({ rule: p.rule, what: p.what(m) });
      break;
    }
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
  for (const raw of patch.split("\n")) {
    if (raw.startsWith("diff --git ")) { file = null; scan = false; continue; }
    if (raw.startsWith("+++ ")) {
      const target = raw.slice(4).replace(/\t.*$/, "");
      file = target === "/dev/null" ? null : unquote(target).replace(/^b\//, "");
      scan = !!file && SOURCE.test(file) && !/(^|\/)node_modules\//i.test(file) && !(opts.skip?.(file) ?? false);
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
    if (added) {
      for (const h of scanLine(lexed.code, lexed.inString)) {
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

/**
 * Upload stage, no model: checks delivered files (design files, PDFs, images, documents) against kind "upload"
 * criteria. Everything here reads bytes; nothing renders, executes or opens a delivered file with another program.
 *
 * Per criterion: the files whose name matches spec.pattern, then for each of them format (magic bytes), size,
 * PNG/JPEG dimensions (headers), PDF page count (/Type /Page objects), word count (txt, md, docx) and mustContain
 * (case-insensitive). A criterion passes when one matching file passes every check, is unclear when the best file
 * has a check the stage could not decide (e.g. text inside a PDF with custom font encodings), and fails otherwise.
 * Every delivered file also becomes an evidence item (no criterion, no status) for the judgment stage.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { inflateRawSync, inflateSync } from "node:zlib";
import { UploadCriterionSpec, type CriterionSpec, type CriterionStatus, type EvidenceSummary, type UploadFormat } from "@milestone/core";

export interface UploadStageFile {
  name: string;
  size: number;
  sha256?: string;
  mime?: string;
  /** Absolute path on disk; read when bytes are not given. */
  absPath?: string;
  bytes?: Uint8Array;
}

export interface UploadStageInput {
  files: UploadStageFile[];
  criteria: CriterionSpec[];
}

export interface FileInspection {
  evidenceId: string;
  name: string;
  size: number;
  sha256?: string;
  format: UploadFormat | null;
  width?: number;
  height?: number;
  pages?: number;
  words?: number;
  /** Text the stage could extract (md, txt, svg, docx, best-effort PDF); null when none. */
  text: string | null;
  /** Why text or a measurement could not be extracted. */
  notes: string[];
}

export interface UploadStageOutput {
  evidence: EvidenceSummary[];
  inspections: FileInspection[];
}

export const MIME_BY_FORMAT: Record<UploadFormat, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  svg: "image/svg+xml",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  md: "text/markdown; charset=utf-8",
  txt: "text/plain; charset=utf-8",
};

/**
 * Where uploaded files live: UPLOAD_DIR (absolute, or relative to the repo root), default <repo>/var/uploads. The web
 * app and the worker run from different directories, so a relative path is resolved against the directory holding
 * pnpm-workspace.yaml, found by walking up from the current directory.
 */
export function uploadRoot(env: string | undefined = process.env.UPLOAD_DIR, cwd = process.cwd()): string {
  if (env && isAbsolute(env)) return env;
  let dir = resolve(cwd);
  for (;;) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) break;
    const up = dirname(dir);
    if (up === dir) { dir = resolve(cwd); break; }
    dir = up;
  }
  return resolve(dir, env || "var/uploads");
}

/** Evidence id for the i-th delivered file (0-based). */
export const fileEvidenceId = (i: number) => `evd_file_${i + 1}`;

// ---------- Sniffing ----------

const startsWith = (b: Uint8Array, sig: number[], at = 0) => b.length >= at + sig.length && sig.every((x, i) => b[at + i] === x);
const ext = (name: string) => (/\.([A-Za-z0-9]+)$/.exec(name)?.[1] ?? "").toLowerCase();

function utf8(b: Uint8Array): string | null {
  if (b.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(b);
  } catch {
    return null;
  }
}

/** The file's format from its bytes (the name only separates md from txt); null when unknown. */
export function sniffFormat(bytes: Uint8Array, name = ""): UploadFormat | null {
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "pdf"; // %PDF-
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "jpg";
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) {
    const z = readZip(bytes);
    return z && z.has("word/document.xml") ? "docx" : null;
  }
  const text = utf8(bytes);
  if (text === null) return null;
  const head = text.slice(0, 4096).replace(/^﻿/, "");
  if (/^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(head)) return "svg";
  return ["md", "markdown"].includes(ext(name)) ? "md" : "txt";
}

// ---------- Images ----------

export function pngSize(b: Uint8Array): { width: number; height: number } | null {
  if (!startsWith(b, [0x89, 0x50, 0x4e, 0x47]) || b.length < 24 || String.fromCharCode(...b.subarray(12, 16)) !== "IHDR") return null;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return { width: v.getUint32(16), height: v.getUint32(20) };
}

export function jpegSize(b: Uint8Array): { width: number; height: number } | null {
  if (!startsWith(b, [0xff, 0xd8])) return null;
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) { i++; continue; }
    const marker = b[i + 1]!;
    if (marker === 0xff) { i++; continue; }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    if (marker === 0xd9 || marker === 0xda) return null; // end of image / start of scan before a frame header
    const len = (b[i + 2]! << 8) | b[i + 3]!;
    // SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (i + 9 > b.length) return null;
      return { height: (b[i + 5]! << 8) | b[i + 6]!, width: (b[i + 7]! << 8) | b[i + 8]! };
    }
    i += 2 + len;
  }
  return null;
}

function svgSize(text: string): { width: number; height: number } | null {
  const tag = /<svg\b[^>]*>/i.exec(text)?.[0];
  if (!tag) return null;
  const attr = (n: string) => new RegExp(`\\s${n}\\s*=\\s*["']\\s*([0-9.]+)\\s*(px)?\\s*["']`, "i").exec(tag);
  const w = attr("width"), h = attr("height");
  if (w && h) return { width: Number(w[1]), height: Number(h[1]) };
  const vb = /\sviewBox\s*=\s*["']\s*[-0-9.]+[\s,]+[-0-9.]+[\s,]+([0-9.]+)[\s,]+([0-9.]+)\s*["']/i.exec(tag);
  return vb ? { width: Number(vb[1]), height: Number(vb[2]) } : null;
}

// ---------- PDF ----------

/** Pages: /Type /Page objects; with object streams those are compressed, so look inside streams, then /Pages /Count. */
export function pdfPageCount(b: Uint8Array): number | null {
  const PAGE = /\/Type\s*\/Page(?![a-zA-Z])/g;
  const raw = latin1(b);
  const direct = raw.match(PAGE)?.length ?? 0;
  if (direct > 0) return direct;
  const streams = pdfStreams(b);
  const inStreams = streams.reduce((n, s) => n + (s.match(PAGE)?.length ?? 0), 0);
  if (inStreams > 0) return inStreams;
  let max = 0;
  for (const s of [raw, ...streams]) {
    for (const m of s.matchAll(/\/Type\s*\/Pages\b[^>]*?\/Count\s+(\d+)|\/Count\s+(\d+)[^>]*?\/Type\s*\/Pages\b/g)) max = Math.max(max, Number(m[1] ?? m[2]));
  }
  return max > 0 ? max : null;
}

function latin1(b: Uint8Array): string {
  return Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString("latin1");
}

const MAX_INFLATE = 20 * 1024 * 1024;

/** Decompressed FlateDecode streams (best effort; anything that does not inflate is skipped). */
function pdfStreams(b: Uint8Array): string[] {
  const raw = latin1(b);
  const out: string[] = [];
  let total = 0;
  const re = /(?<!end)stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    const start = m.index + m[0].length;
    const end = raw.indexOf("endstream", start);
    if (end < 0) break;
    const dict = raw.slice(Math.max(0, m.index - 400), m.index);
    re.lastIndex = end;
    if (!/\/FlateDecode/.test(dict.slice(dict.lastIndexOf("<<")))) continue;
    try {
      const data = inflateSync(Buffer.from(b.buffer, b.byteOffset + start, end - start), { maxOutputLength: MAX_INFLATE });
      total += data.length;
      if (total > MAX_INFLATE * 2) break;
      out.push(data.toString("latin1"));
    } catch {
      // truncated or not really deflate: skip
    }
  }
  return out;
}

function pdfUnescape(s: string): string {
  return s.replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (_, c: string) => {
    if (/^[0-7]+$/.test(c)) return String.fromCharCode(parseInt(c, 8));
    return ({ n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" } as Record<string, string>)[c] ?? c;
  });
}

/** Text from Tj/TJ string operators in content streams. Fonts with custom encodings yield nothing useful. */
export function pdfText(b: Uint8Array): string {
  const parts: string[] = [];
  for (const s of [latin1(b), ...pdfStreams(b)]) {
    if (!/\bBT\b/.test(s)) continue;
    for (const m of s.matchAll(/\[((?:\((?:\\.|[^\\)])*\)|[^\]])*)\]\s*TJ|\(((?:\\.|[^\\)])*)\)\s*(?:Tj|'|")|(?<![A-Za-z/])(T\*|Td|TD|Tm|ET)\b/g)) {
      if (m[1] !== undefined) {
        let line = "";
        for (const p of m[1].matchAll(/\(((?:\\.|[^\\)])*)\)|(-?[0-9.]+)/g)) {
          if (p[1] !== undefined) line += pdfUnescape(p[1]);
          else if (Number(p[2]) < -200) line += " ";
        }
        parts.push(line);
      } else if (m[2] !== undefined) {
        parts.push(pdfUnescape(m[2]));
      } else {
        parts.push("\n");
      }
    }
  }
  return parts.join("").replace(/[ \t]+/g, " ");
}

// ---------- DOCX (minimal zip reader) ----------

interface ZipEntry { method: number; compressedSize: number; localOffset: number }

/** Central directory of a zip; null when it is not one. */
export function readZip(b: Uint8Array): Map<string, ZipEntry> | null {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 65_535); i--) {
    if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return null;
  const count = v.getUint16(eocd + 10, true);
  let p = v.getUint32(eocd + 16, true);
  const entries = new Map<string, ZipEntry>();
  for (let n = 0; n < count; n++) {
    if (p + 46 > b.length || v.getUint32(p, true) !== 0x02014b50) return null;
    const method = v.getUint16(p + 10, true);
    const compressedSize = v.getUint32(p + 20, true);
    const nameLen = v.getUint16(p + 28, true), extraLen = v.getUint16(p + 30, true), commentLen = v.getUint16(p + 32, true);
    const localOffset = v.getUint32(p + 42, true);
    const name = new TextDecoder().decode(b.subarray(p + 46, p + 46 + nameLen));
    entries.set(name, { method, compressedSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

export function readZipEntry(b: Uint8Array, entry: ZipEntry): Buffer | null {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const p = entry.localOffset;
  if (p + 30 > b.length || v.getUint32(p, true) !== 0x04034b50) return null;
  const start = p + 30 + v.getUint16(p + 26, true) + v.getUint16(p + 28, true);
  const data = Buffer.from(b.buffer, b.byteOffset + start, Math.min(entry.compressedSize, b.length - start));
  try {
    if (entry.method === 0) return data;
    if (entry.method === 8) return inflateRawSync(data, { maxOutputLength: MAX_INFLATE });
  } catch {
    return null;
  }
  return null;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
function decodeXml(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e: string) => {
    if (e[0] === "#") return String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
    return ENTITIES[e] ?? all;
  });
}

/** The body text of a .docx (word/document.xml), or null when it cannot be read. */
export function docxText(b: Uint8Array): string | null {
  const zip = readZip(b);
  const entry = zip?.get("word/document.xml");
  if (!entry) return null;
  const xml = readZipEntry(b, entry)?.toString("utf8");
  if (!xml) return null;
  return decodeXml(xml.replace(/<w:tab\/>|<w:br\/>/g, " ").replace(/<\/w:p>/g, "\n").replace(/<[^>]+>/g, "")).replace(/[ \t]+/g, " ").trim();
}

export function countWords(text: string): number {
  return text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

// ---------- Inspection ----------

export async function fileBytes(f: UploadStageFile): Promise<Uint8Array> {
  if (f.bytes) return f.bytes;
  if (!f.absPath) throw new Error(`no bytes or path for ${f.name}`);
  return readFile(f.absPath);
}

export function inspect(bytes: Uint8Array, file: Pick<UploadStageFile, "name" | "sha256">, evidenceId: string): FileInspection {
  const format = sniffFormat(bytes, file.name);
  const ins: FileInspection = { evidenceId, name: file.name, size: bytes.length, ...(file.sha256 ? { sha256: file.sha256 } : {}), format, text: null, notes: [] };
  if (format === "png" || format === "jpg") {
    const d = format === "png" ? pngSize(bytes) : jpegSize(bytes);
    if (d) Object.assign(ins, d);
    else ins.notes.push("image dimensions not found in the header");
  } else if (format === "svg") {
    ins.text = utf8(bytes);
    const d = ins.text ? svgSize(ins.text) : null;
    if (d) Object.assign(ins, d);
  } else if (format === "pdf") {
    const pages = pdfPageCount(bytes);
    if (pages !== null) ins.pages = pages;
    else ins.notes.push("page count not found (compressed object streams)");
    const text = pdfText(bytes);
    ins.text = text.trim() ? text : null;
    ins.words = ins.text ? countWords(ins.text) : 0;
    ins.notes.push("PDF text extraction is best effort");
  } else if (format === "docx") {
    ins.text = docxText(bytes);
    if (ins.text === null) ins.notes.push("word/document.xml could not be read");
    else ins.words = countWords(ins.text);
  } else if (format === "md" || format === "txt") {
    ins.text = utf8(bytes);
    ins.words = ins.text ? countWords(ins.text) : 0;
  } else {
    ins.notes.push("unrecognised format");
  }
  return ins;
}

function describe(i: FileInspection): string {
  const bits = [`${i.name}: ${i.format ?? "unknown format"}, ${i.size} bytes`];
  if (i.width !== undefined) bits.push(`${i.width}x${i.height}${i.format === "svg" ? " (vector)" : " px"}`);
  if (i.pages !== undefined) bits.push(`${i.pages} page(s)`);
  if (i.words !== undefined && i.format !== "pdf") bits.push(`${i.words} words`);
  if (i.sha256) bits.push(`sha256 ${i.sha256.slice(0, 12)}`);
  return bits.join(", ") + (i.notes.length ? ` (${i.notes.join("; ")})` : "");
}

// ---------- Patterns ----------

function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0, cur = "";
  for (const ch of s) {
    if (ch === "{") depth++;
    if (ch === "}") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) { out.push(cur); cur = ""; } else cur += ch;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

function globToRegex(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") { re += ".*"; i++; if (glob[i + 1] === "/") i++; } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "{") {
      const close = glob.indexOf("}", i);
      if (close < 0) { re += "\\{"; continue; }
      re += `(?:${glob.slice(i + 1, close).split(",").map((a) => a.replace(/[.+^$()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")).join("|")})`;
      i = close;
    } else re += c.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, "i");
}

/** spec.pattern -> name matcher: a glob, or extensions ("svg", ".png", "svg,png", [".md", ".docx"]). */
export function patternMatcher(pattern: string | string[]): (name: string) => boolean {
  const items = (Array.isArray(pattern) ? pattern : [pattern]).flatMap(splitTop);
  const tests = items.map((p) => {
    if (/^\.?[A-Za-z0-9]+$/.test(p)) {
      const e = p.replace(/^\./, "").toLowerCase();
      return (name: string) => ext(name) === e;
    }
    const re = globToRegex(p);
    return (name: string) => re.test(p.includes("/") ? name : (name.split("/").pop() ?? name));
  });
  return (name) => tests.some((t) => t(name));
}

// ---------- Criteria ----------

type Check = { label: string; ok: boolean | null; detail: string };

function checksFor(spec: UploadCriterionSpec, i: FileInspection): Check[] {
  const checks: Check[] = [];
  if (spec.format) {
    const ok = i.format === spec.format || (spec.format === "txt" && i.format === "md");
    checks.push({ label: "format", ok, detail: `format ${i.format ?? "unknown"}${ok ? "" : `, expected ${spec.format}`}` });
  }
  if (spec.minBytes !== undefined) checks.push({ label: "size", ok: i.size >= spec.minBytes, detail: `${i.size} bytes (min ${spec.minBytes})` });
  for (const [key, dim] of [["minWidth", "width"], ["minHeight", "height"]] as const) {
    const min = spec[key];
    if (min === undefined) continue;
    const v = i[dim];
    if (i.format === "svg") {
      // Vector artwork scales to any size; an SVG wrapping a raster <image> does not.
      const raster = i.text ? /<image\b/i.test(i.text) : true;
      checks.push({ label: dim, ok: raster ? null : true, detail: raster ? `SVG embeds a raster image, ${dim} not checkable` : `vector SVG scales to ${min} px ${dim}` });
    } else if (v === undefined) checks.push({ label: dim, ok: i.format === "png" || i.format === "jpg" ? null : false, detail: `${dim} unknown for ${i.format ?? "this file"} (min ${min})` });
    else checks.push({ label: dim, ok: v >= min, detail: `${dim} ${v} px (min ${min})` });
  }
  if (spec.maxPages !== undefined) {
    if (i.format !== "pdf") checks.push({ label: "pages", ok: false, detail: `not a PDF, page count needs one (max ${spec.maxPages})` });
    else if (i.pages === undefined) checks.push({ label: "pages", ok: null, detail: `page count not found (max ${spec.maxPages})` });
    else checks.push({ label: "pages", ok: i.pages <= spec.maxPages, detail: `${i.pages} page(s) (max ${spec.maxPages})` });
  }
  if (spec.minWords !== undefined) {
    const countable = i.format === "md" || i.format === "txt" || (i.format === "docx" && i.words !== undefined);
    if (countable) checks.push({ label: "words", ok: i.words! >= spec.minWords, detail: `${i.words} words (min ${spec.minWords})` });
    else if (i.format === "pdf" && (i.words ?? 0) >= spec.minWords) checks.push({ label: "words", ok: true, detail: `at least ${i.words} extracted words (min ${spec.minWords})` });
    else checks.push({ label: "words", ok: i.format === "png" || i.format === "jpg" ? false : null, detail: `word count not available for ${i.format ?? "this file"} (min ${spec.minWords})` });
  }
  for (const needle of spec.mustContain ?? []) {
    const found = i.text !== null && i.text.toLowerCase().includes(needle.toLowerCase());
    if (found) checks.push({ label: "contains", ok: true, detail: `contains "${needle}"` });
    else if (i.text !== null && i.format !== "pdf") checks.push({ label: "contains", ok: false, detail: `does not contain "${needle}"` });
    // PDF text extraction misses text in custom-encoded fonts; only fail when plenty of text came out.
    else if (i.format === "pdf" && (i.words ?? 0) >= 50) checks.push({ label: "contains", ok: false, detail: `"${needle}" not found in ${i.words} extracted words` });
    else checks.push({ label: "contains", ok: null, detail: `"${needle}" not checkable: no extractable text` });
  }
  return checks;
}

function fileStatus(checks: Check[]): CriterionStatus {
  if (checks.some((c) => c.ok === false)) return "fail";
  if (checks.some((c) => c.ok === null)) return "unclear";
  return "pass";
}

const RANK: Record<CriterionStatus, number> = { pass: 2, unclear: 1, fail: 0 };

export function evaluateUploadCriterion(c: CriterionSpec, inspections: FileInspection[]): EvidenceSummary {
  const id = `evd_${c.id}`;
  const parsed = UploadCriterionSpec.safeParse(c.spec);
  if (!parsed.success) return { id, criterion_id: c.id, kind: "file", status: "unclear", summary: `upload criterion spec is invalid: ${parsed.error.issues.map((x) => x.message).join("; ")}` };
  const spec = parsed.data;
  const match = patternMatcher(spec.pattern);
  const files = inspections.filter((i) => match(i.name));
  const pat = Array.isArray(spec.pattern) ? spec.pattern.join(", ") : spec.pattern;
  if (files.length === 0) {
    return { id, criterion_id: c.id, kind: "file", status: "fail", summary: `no delivered file matches ${pat} (delivered: ${inspections.map((i) => i.name).join(", ") || "none"})` };
  }
  const results = files.map((f) => ({ f, checks: checksFor(spec, f) })).map((r) => ({ ...r, status: fileStatus(r.checks) }));
  results.sort((a, b) => RANK[b.status] - RANK[a.status]);
  const best = results[0]!;
  const lines = results.map((r) => `${r.f.name} [${r.status}] ${r.checks.length ? r.checks.map((k) => k.detail).join("; ") : `matches ${pat}`}`);
  return {
    id,
    criterion_id: c.id,
    kind: "file",
    status: best.status,
    summary: `${files.length} file(s) match ${pat}; best ${best.f.name} is ${best.status}\n${lines.join("\n")}`,
    uri: best.f.evidenceId,
    ...(best.f.sha256 ? { sha256: best.f.sha256 } : {}),
  };
}

export async function runUploadStage(input: UploadStageInput): Promise<UploadStageOutput> {
  const inspections: FileInspection[] = [];
  const evidence: EvidenceSummary[] = [];
  for (const [n, f] of input.files.entries()) {
    const ins = inspect(await fileBytes(f), f, fileEvidenceId(n));
    inspections.push(ins);
    evidence.push({ id: ins.evidenceId, kind: "file", summary: describe(ins), uri: f.name, ...(f.sha256 ? { sha256: f.sha256 } : {}) });
  }
  for (const c of input.criteria) {
    if (c.kind === "upload") evidence.push(evaluateUploadCriterion(c, inspections));
    else if (c.kind === "file") {
      // On a file delivery, a file criterion means "a file with this name was delivered".
      const path = String(c.spec.path ?? "");
      const hit = inspections.find((i) => i.name === path || i.name === path.split("/").pop());
      evidence.push({ id: `evd_${c.id}`, criterion_id: c.id, kind: "file", status: hit ? "pass" : "fail", summary: `${path} ${hit ? `delivered (${hit.evidenceId})` : "not among the delivered files"}` });
    } else if (c.kind === "test" || c.kind === "build") {
      evidence.push({ id: `evd_${c.id}`, criterion_id: c.id, kind: "note", status: "unclear", summary: `${c.kind} criterion cannot run on a file delivery (no repository)` });
    }
  }
  return { evidence, inspections };
}

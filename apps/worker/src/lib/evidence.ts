/**
 * Read-only access to a delivered commit's checkout, handed to the judgment stage.
 * Every path is resolved under the workdir (symlinks included); nothing here writes or runs delivered code.
 */
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import type { EvidenceSummary, UploadedFile } from "@milestone/core";
import { docxText, fileEvidenceId, pdfText, run, sniffFormat, type EvidenceReader, type ToolOutput } from "@milestone/verify";

export const MAX_TEXT = 100_000;

function gitEnv(workdir: string): Record<string, string> {
  return { PATH: process.env.PATH ?? "", HOME: workdir, GIT_TERMINAL_PROMPT: "0" };
}

function bound(text: string, max = MAX_TEXT): string {
  return text.length > max ? `${text.slice(0, max)}\n[truncated at ${max} characters]` : text;
}

function inside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/** Resolves `path` under `workdir`, refusing traversal, absolute paths, symlink escapes and the .git directory. */
export async function safePath(workdir: string, path: string): Promise<string> {
  const root = await realpath(workdir);
  const candidate = resolve(root, path);
  if (!inside(root, candidate)) throw new Error(`path outside the delivery: ${path}`);
  const real = await realpath(candidate).catch(() => { throw new Error(`no such file: ${path}`); });
  if (!inside(root, real)) throw new Error(`path outside the delivery: ${path}`);
  const rel = relative(root, real);
  if (rel === ".git" || rel.startsWith(`.git${sep}`)) throw new Error(`path not readable: ${path}`);
  return real;
}

/** Runs a git command in the workdir with no secrets in the environment; returns stdout+stderr or throws. */
export async function git(workdir: string, args: string[], timeoutMs = 60_000): Promise<string> {
  const r = await run(["git", ...args], workdir, gitEnv(workdir), timeoutMs);
  if (r.code !== 0) throw new Error(`git ${args[0]} exited ${r.code}${r.timedOut ? " (timed out)" : ""}`);
  return r.output;
}

export interface ReaderInput {
  workdir: string | null;
  sha: string;
  /** The commit the deterministic stage diffed against (fetched into workdir); null shows the commit's own diff. */
  baseline?: string | null;
  repoUrl: string;
  evidence: EvidenceSummary[];
}

export function createEvidenceReader(input: ReaderInput): EvidenceReader {
  let diff: Promise<string> | null = null;
  return {
    async readFile(path) {
      if (!input.workdir) return "the delivery could not be checked out, no files are available";
      const real = await safePath(input.workdir, path);
      const s = await stat(real);
      if (s.isDirectory()) throw new Error(`${path} is a directory`);
      const buf = await readFile(real);
      return bound(buf.subarray(0, MAX_TEXT * 4).toString("utf8"));
    },
    getDiff() {
      const workdir = input.workdir;
      if (!workdir) return Promise.resolve("the delivery could not be checked out, no diff is available");
      // The deterministic stage fetched the baseline it compared against, and depth 2 (the commit and its first
      // parent), so without a baseline this is the commit's own diff against its parent.
      const baseline = input.baseline;
      diff ??= (baseline
        ? git(workdir, ["diff", "--stat", "-p", "--no-color", baseline, input.sha]).then((d) => `diff from baseline ${baseline.slice(0, 12)} to ${input.sha.slice(0, 12)}\n${d}`)
        : git(workdir, ["show", "--stat", "-p", "--no-color", input.sha])
      ).then((d) => bound(d));
      return diff;
    },
    async listEvidence() {
      return input.evidence;
    },
    async viewScreenshot() {
      return "no screenshot";
    },
    async viewFile() {
      return "this delivery is a repository commit, not uploaded files; use read_file";
    },
  };
}

/** Images and PDFs larger than this go to the model as text (or a note), not as image/document blocks. */
export const MAX_VIEW_BYTES = 5 * 1024 * 1024;

export interface UploadReaderInput {
  /** UPLOAD_DIR; every file's path is resolved under it. */
  root: string;
  files: UploadedFile[];
  evidence: EvidenceSummary[];
}

/** Read-only access to an upload delivery's stored files; evd_file_N is files[N-1]. Bytes are checked against the stored sha256. */
export function createUploadEvidenceReader(input: UploadReaderInput): EvidenceReader {
  const load = async (file: UploadedFile): Promise<Buffer> => {
    const bytes = await readFile(await safePath(input.root, file.path));
    if (createHash("sha256").update(bytes).digest("hex") !== file.sha256) throw new Error(`${file.name} changed since it was uploaded`);
    return bytes;
  };
  const asText = (file: UploadedFile, bytes: Buffer): string => {
    const format = sniffFormat(bytes, file.name);
    if (format === "docx") return bound(docxText(bytes) ?? "the .docx body could not be read");
    if (format === "pdf") return bound(`[text extracted from ${file.name}, best effort]\n${pdfText(bytes)}`);
    if (format === "png" || format === "jpg") return `${file.name} is an image; use view_file to see it`;
    if (format === null) return `${file.name} is in an unrecognised binary format`;
    return bound(bytes.subarray(0, MAX_TEXT * 4).toString("utf8"));
  };
  const byEvidence = (id: string) => {
    const i = input.files.findIndex((_, n) => fileEvidenceId(n) === id);
    if (i < 0) throw new Error(`no delivered file has evidence id ${id}; file ids are ${input.files.map((_, n) => fileEvidenceId(n)).join(", ")}`);
    return input.files[i]!;
  };
  return {
    async readFile(path) {
      const file = input.files.find((f) => f.name === path);
      if (!file) throw new Error(`no delivered file named ${path}`);
      return asText(file, await load(file));
    },
    async getDiff() {
      return "this delivery is uploaded files, there is no diff; use list_evidence and view_file";
    },
    async listEvidence() {
      return input.evidence;
    },
    async viewScreenshot() {
      return "no screenshot";
    },
    async viewFile(evidenceId): Promise<ToolOutput> {
      const file = byEvidence(evidenceId);
      const bytes = await load(file);
      const format = sniffFormat(bytes, file.name);
      const note = `${evidenceId}: ${file.name}, ${bytes.length} bytes`;
      if (format === "png" || format === "jpg") {
        if (bytes.length > MAX_VIEW_BYTES) return `${note}: image larger than ${MAX_VIEW_BYTES} bytes, not shown; rely on the upload checks`;
        return { type: "image", mediaType: format === "png" ? "image/png" : "image/jpeg", base64: bytes.toString("base64"), note };
      }
      if (format === "pdf") {
        if (bytes.length > MAX_VIEW_BYTES) return `${note}: PDF larger than ${MAX_VIEW_BYTES} bytes, extracted text only\n${asText(file, bytes)}`;
        return { type: "document", mediaType: "application/pdf", base64: bytes.toString("base64"), note };
      }
      return `${note}\n${asText(file, bytes)}`;
    },
  };
}

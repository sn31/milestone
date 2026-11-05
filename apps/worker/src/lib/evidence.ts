/**
 * Read-only access to a delivered commit's checkout, handed to the judgment stage.
 * Every path is resolved under the workdir (symlinks included); nothing here writes or runs delivered code.
 */
import { readFile, stat } from "node:fs/promises";
import type { EvidenceSummary, UploadedFile, VerdictOutput } from "@milestone/core";
import { docxText, fileEvidenceId, pdfText, readUploadedFile, run, safePath, sniffFormat, stripRoots, truncate, type EvidenceReader, type ToolOutput } from "@milestone/verify";

export const MAX_TEXT = 100_000;

function gitEnv(workdir: string): Record<string, string> {
  return { PATH: process.env.PATH ?? "", HOME: workdir, GIT_TERMINAL_PROMPT: "0" };
}

const bound = (text: string, max = MAX_TEXT) => truncate(text, max);

/** Runs a git command in the workdir with no secrets in the environment; returns stdout+stderr or throws. */
export async function git(workdir: string, args: string[], timeoutMs = 60_000): Promise<string> {
  const r = await run(["git", ...args], workdir, gitEnv(workdir), timeoutMs);
  if (r.code !== 0) throw new Error(`git ${args[0]} exited ${r.code}${r.timedOut ? " (timed out)" : ""}`);
  return r.output;
}

/** Evidence summaries and verdict rationales with worker directories stripped (F11: no temp paths in what parties see). */
export function scrubVerdictPaths<T extends { evidence: EvidenceSummary[]; verdict: VerdictOutput }>(v: T, roots: string[]): T {
  return {
    ...v,
    evidence: v.evidence.map((e) => ({ ...e, summary: stripRoots(e.summary, roots) })),
    verdict: { ...v.verdict, criteria: v.verdict.criteria.map((c) => ({ ...c, rationale: stripRoots(c.rationale, roots) })) },
  };
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

/**
 * Images and PDFs larger than this go to the model as text (or a note), not as image/document blocks. The API's 5 MB
 * limit applies to the base64 form, 4/3 the raw size, so the raw cap is 3.5 MiB (about 4.9 MB encoded): a bigger file
 * would fail the whole judgment call with a 400, where a note lets the criterion go unclear.
 */
export const MAX_VIEW_BYTES = 3.5 * 1024 * 1024;

export interface UploadReaderInput {
  /** UPLOAD_DIR; every file's path is resolved under it. */
  root: string;
  files: UploadedFile[];
  evidence: EvidenceSummary[];
}

/** Read-only access to an upload delivery's stored files; evd_file_N is files[N-1]. Bytes are checked against the stored sha256. */
export function createUploadEvidenceReader(input: UploadReaderInput): EvidenceReader {
  const load = (file: UploadedFile): Promise<Buffer> => readUploadedFile(file, input.root);
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
        if (bytes.length > MAX_VIEW_BYTES) return `${note}: too large to view (over ${MAX_VIEW_BYTES} bytes), not shown; rely on the upload checks and do not pass a criterion that needs to see it`;
        return { type: "image", mediaType: format === "png" ? "image/png" : "image/jpeg", base64: bytes.toString("base64"), note };
      }
      if (format === "pdf") {
        if (bytes.length > MAX_VIEW_BYTES) return `${note}: PDF too large to view (over ${MAX_VIEW_BYTES} bytes), extracted text only\n${asText(file, bytes)}`;
        return { type: "document", mediaType: "application/pdf", base64: bytes.toString("base64"), note };
      }
      return `${note}\n${asText(file, bytes)}`;
    },
  };
}

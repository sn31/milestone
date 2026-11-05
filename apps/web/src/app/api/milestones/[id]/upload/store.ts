import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { UploadedFile } from "@milestone/core";
import { MIME_BY_FORMAT, sniffFormat, uploadRoot } from "@milestone/verify";

export const MAX_FILES = 10;
export const MAX_FILE_BYTES = 20 * 1024 * 1024;
/** Total size UPLOAD_DIR may reach before new uploads are refused (MILESTONE_UPLOAD_BUDGET_BYTES overrides it). */
export const DEFAULT_UPLOAD_BUDGET_BYTES = 500 * 1024 * 1024;
/** How long a measured UPLOAD_DIR size is reused before the directory is walked again. */
export const UPLOAD_USAGE_TTL_MS = 30_000;

/** MILESTONE_UPLOAD_BUDGET_BYTES as a positive whole number of bytes, else the default. */
export function uploadBudgetBytes(raw: string | undefined = process.env.MILESTONE_UPLOAD_BUDGET_BYTES): number {
  const n = Number(raw?.trim() || NaN);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_UPLOAD_BUDGET_BYTES;
}

/** Total bytes of the regular files under `root`, recursively, without following links. A missing directory is 0. */
export async function dirBytes(root: string): Promise<number> {
  const entries = await readdir(root, { withFileTypes: true }).catch((e: NodeJS.ErrnoException) => {
    if (e.code === "ENOENT" || e.code === "ENOTDIR") return [];
    throw e;
  });
  let total = 0;
  for (const e of entries) {
    const path = join(root, e.name);
    if (e.isDirectory()) total += await dirBytes(path);
    else if (e.isFile()) total += await lstat(path).then((st) => st.size, () => 0);
  }
  return total;
}

/**
 * UPLOAD_DIR's size, measured at most once per `ttlMs` (concurrent callers share one walk). `add` counts bytes stored
 * since the last walk, so a burst of uploads inside the cache window still adds up.
 */
export function createUploadUsage(ttlMs: number = UPLOAD_USAGE_TTL_MS, measure: (root: string) => Promise<number> = dirBytes) {
  let cached: { root: string; at: number; bytes: Promise<number> } | null = null;
  let added = 0;
  return {
    async bytes(root: string, now: number = Date.now()): Promise<number> {
      if (!cached || cached.root !== root || now - cached.at >= ttlMs) {
        const bytes = measure(root);
        cached = { root, at: now, bytes };
        added = 0;
        bytes.catch(() => {
          if (cached?.bytes === bytes) cached = null;
        });
      }
      return (await cached.bytes) + added;
    },
    add(n: number): void {
      added += n;
    },
  };
}

/** Whether `incoming` more bytes would take UPLOAD_DIR (currently `used`) past the budget. */
export function overBudget(used: number, incoming: number, budget: number): boolean {
  return used + Math.max(0, incoming) > budget;
}

/** A safe stored name: basename only, no leading dot, conservative characters, unique within the delivery. */
export function safeName(raw: string, taken: Set<string>): string {
  const base = raw.split(/[\\/]/).pop() ?? "";
  let name = base.normalize("NFC").replace(/[^\p{L}\p{N}._ ()-]/gu, "_").replace(/^[.\s]+/, "").trim().slice(-120) || "file";
  if (name === "." || name === "..") name = "file";
  const dot = name.lastIndexOf(".");
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${stem}-${n}${ext}`;
  taken.add(name.toLowerCase());
  return name;
}

export function newUploadDeliveryId(): string {
  return `dlv_up_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

export type IncomingFile = { name: string; bytes: Uint8Array };

/** Checks counts and sizes before anything touches the disk. */
export function checkFiles(files: IncomingFile[]): string | null {
  if (files.length === 0) return "no files: send them as multipart form field \"files\"";
  if (files.length > MAX_FILES) return `at most ${MAX_FILES} files per delivery`;
  const big = files.find((f) => f.bytes.length > MAX_FILE_BYTES);
  if (big) return `${big.name} is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB`;
  const empty = files.find((f) => f.bytes.length === 0);
  if (empty) return `${empty.name} is empty`;
  return null;
}

/** Writes the files under <UPLOAD_DIR>/<deliveryId>/ and returns the payload entries (path relative to UPLOAD_DIR). */
export async function storeFiles(deliveryId: string, files: IncomingFile[], root = uploadRoot()): Promise<UploadedFile[]> {
  const dir = join(root, deliveryId);
  await mkdir(dir, { recursive: true });
  const taken = new Set<string>();
  const out: UploadedFile[] = [];
  try {
    for (const f of files) {
      const name = safeName(f.name, taken);
      await writeFile(join(dir, name), f.bytes, { flag: "wx" });
      const format = sniffFormat(f.bytes, name);
      out.push({
        name,
        size: f.bytes.length,
        sha256: createHash("sha256").update(f.bytes).digest("hex"),
        path: `${deliveryId}/${name}`,
        mime: format ? MIME_BY_FORMAT[format] : "application/octet-stream",
      });
    }
    return out;
  } catch (e) {
    await rm(dir, { recursive: true, force: true });
    throw e;
  }
}

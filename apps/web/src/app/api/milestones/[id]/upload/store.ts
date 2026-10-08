import { createHash, randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { UploadedFile } from "@milestone/core";
import { MIME_BY_FORMAT, sniffFormat, uploadRoot } from "@milestone/verify";

export const MAX_FILES = 10;
export const MAX_FILE_BYTES = 20 * 1024 * 1024;

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

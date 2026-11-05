import { rm } from "node:fs/promises";
import { join } from "node:path";
import { AUDIT_EVENTS, DELIVERABLE_STATUSES, audit, deliveries, enqueue } from "@milestone/core";
import { uploadRoot } from "@milestone/verify";
import { getDb } from "@/lib/db";
import { json, jsonError } from "@/lib/http";
import { getActor, isContractFreelancer } from "@/lib/session";
import { loadMilestone } from "../../_shared";
import { checkFiles, MAX_FILE_BYTES, MAX_FILES, newUploadDeliveryId, storeFiles, type IncomingFile } from "./store";
import { RATE_RULES, limitResponse } from "@/lib/rate-limit";

/**
 * File delivery by the contract's freelancer: multipart/form-data with up to 10 "files" (20 MB each). The files are
 * stored under UPLOAD_DIR/<deliveryId>/ with their sha256, a deliveries row (source upload) records them, and the
 * verify job runs the upload checks and the judge on them. Delivered files are untrusted evidence (CLAUDE.md rule 5).
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  // Each delivery queues a worker judgment; deliver and upload share one per-IP bucket (DEMO_MODE only).
  const limited = limitResponse(req, RATE_RULES.delivery);
  if (limited) return limited;
  const { id } = await ctx.params;
  const actor = await getActor();
  const db = getDb();
  const found = await loadMilestone(db, id);
  if (!found) return jsonError("milestone not found", 404);
  const { milestone: m, contract: c } = found;
  if (!isContractFreelancer(actor, c)) return jsonError("only the contract's freelancer can deliver", 403);
  if (!DELIVERABLE_STATUSES.has(m.status)) return jsonError(`cannot deliver while milestone is ${m.status}`, 409);

  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > MAX_FILES * MAX_FILE_BYTES + 1024 * 1024) return jsonError(`upload too large (max ${MAX_FILES} files of ${MAX_FILE_BYTES / 1024 / 1024} MB)`, 413);
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return jsonError("expected multipart/form-data with field \"files\"", 400);
  }
  const entries = form.getAll("files").filter((v): v is File => typeof v === "object" && v !== null && "arrayBuffer" in v);
  if (entries.length > MAX_FILES) return jsonError(`at most ${MAX_FILES} files per delivery`, 400);
  if (entries.some((f) => f.size > MAX_FILE_BYTES)) return jsonError(`each file must be at most ${MAX_FILE_BYTES / 1024 / 1024} MB`, 413);
  const files: IncomingFile[] = await Promise.all(entries.map(async (f) => ({ name: f.name || "file", bytes: new Uint8Array(await f.arrayBuffer()) })));
  const problem = checkFiles(files);
  if (problem) return jsonError(problem, 400);

  const deliveryId = newUploadDeliveryId();
  const root = uploadRoot();
  const stored = await storeFiles(deliveryId, files, root);
  const note = form.get("note");
  try {
    await db.insert(deliveries).values({
      id: deliveryId,
      milestoneId: m.id,
      source: "upload",
      ref: `upload:${stored.length} file(s)`,
      payload: { files: stored, ...(typeof note === "string" && note.trim() ? { note: note.slice(0, 10_000) } : {}) },
    });
  } catch (e) {
    await rm(join(root, deliveryId), { recursive: true, force: true });
    throw e;
  }
  await audit(db, { actor: actor.userId, event: AUDIT_EVENTS.deliveryUpload, milestoneId: m.id, contractId: c.id, detail: { deliveryId, files: stored.map((f) => ({ name: f.name, size: f.size, sha256: f.sha256 })) } });
  await enqueue("verify", m.id, { deliveryId }, { dedupe: deliveryId });
  return json({ ok: true, deliveryId, files: stored.map(({ name, size, sha256, mime }) => ({ name, size, sha256, mime })) });
}

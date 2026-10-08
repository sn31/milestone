import { UploadPayload, loadMilestone } from "@milestone/core";
import { readUploadedFile, resolveUpload } from "@milestone/verify";
import { getDb } from "@/lib/db";
import { noStore } from "@/lib/http";
import { getActor, isContractParty } from "@/lib/session";

const INLINE = new Set(["image/png", "image/jpeg", "image/svg+xml", "application/pdf"]);

function deny(status: number, message: string) {
  return new Response(message, { status, headers: { ...noStore, "Content-Type": "text/plain; charset=utf-8" } });
}

/**
 * Serves a delivered file to the contract's client and freelancer. Delivered files are untrusted: the response is
 * sandboxed (no scripts, even in an SVG), never sniffed, and anything but images and PDFs downloads as an attachment.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ deliveryId: string; name: string }> }) {
  const { deliveryId, name } = await ctx.params;
  const actor = await getActor();
  const db = getDb();
  const delivery = await db.query.deliveries.findFirst({ where: (d, { eq }) => eq(d.id, deliveryId) });
  if (!delivery || delivery.source !== "upload") return deny(404, "not found");
  const found = await loadMilestone(db, delivery.milestoneId);
  if (!found) return deny(404, "not found");
  if (!isContractParty(actor, found.contract)) return deny(403, "only the contract's parties can see delivered files");

  const payload = UploadPayload.safeParse(delivery.payload);
  const file = payload.success ? payload.data.files.find((f) => f.name === name) : undefined;
  if (!file) return deny(404, "not found");

  // Inside UPLOAD_DIR only (no traversal or symlink escape), and the bytes must still match the sha256 recorded at delivery.
  if (!(await resolveUpload(file.path))) return deny(404, "not found");
  const bytes = await readUploadedFile(file).catch(() => null);
  if (!bytes) return deny(409, "the file changed since it was delivered");

  const mime = file.mime.startsWith("text/") ? "text/plain; charset=utf-8" : file.mime;
  const disposition = INLINE.has(file.mime) ? "inline" : "attachment";
  return new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type": mime,
      "Content-Length": String(bytes.length),
      "Content-Disposition": `${disposition}; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      // Chrome's PDF viewer refuses to render under a CSP sandbox; PDF scripts run inside the viewer, not this origin.
      "Content-Security-Policy": file.mime === "application/pdf" ? "default-src 'none'; frame-ancestors 'self'" : "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
      "X-File-Sha256": file.sha256,
    },
  });
}

import { readFile, realpath } from "node:fs/promises";
import { relative, resolve, sep, isAbsolute } from "node:path";
import { UploadPayload } from "@milestone/core";
import { uploadRoot } from "@milestone/verify";
import { getDb } from "@/lib/db";
import { getActor } from "@/lib/session";

const INLINE = new Set(["image/png", "image/jpeg", "image/svg+xml", "application/pdf"]);

function deny(status: number, message: string) {
  return new Response(message, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
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
  const milestone = await db.query.milestones.findFirst({ where: (m, { eq }) => eq(m.id, delivery.milestoneId) });
  const contract = milestone ? await db.query.contracts.findFirst({ where: (c, { eq }) => eq(c.id, milestone.contractId) }) : undefined;
  if (!contract) return deny(404, "not found");
  if (actor.userId !== contract.clientId && actor.userId !== contract.freelancerId) return deny(403, "only the contract's parties can see delivered files");

  const payload = UploadPayload.safeParse(delivery.payload);
  const file = payload.success ? payload.data.files.find((f) => f.name === name) : undefined;
  if (!file) return deny(404, "not found");

  const root = await realpath(uploadRoot()).catch(() => null);
  if (!root) return deny(404, "not found");
  const real = await realpath(resolve(root, file.path)).catch(() => null);
  const rel = real ? relative(root, real) : "..";
  if (!real || rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) return deny(404, "not found");
  const bytes = await readFile(real);

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

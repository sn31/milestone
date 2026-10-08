import { eq } from "drizzle-orm";
import { AUDIT_EVENTS, audit, milestones, openOperatorFlags } from "@milestone/core";
import { getDb } from "@/lib/db";
import { json, jsonError } from "@/lib/http";
import { getActor, isOperator } from "@/lib/session";

export async function POST(req: Request, ctx: { params: Promise<{ milestoneId: string }> }) {
  const { milestoneId } = await ctx.params;
  const actor = await getActor();
  if (!isOperator(actor)) return jsonError("only the partner or platform can resolve", 403);
  let note = "";
  try {
    const body = (await req.json()) as { note?: unknown };
    if (typeof body.note === "string") note = body.note.trim();
  } catch {
    return jsonError("expected JSON body { note }", 400);
  }
  if (!note) return jsonError("note is required", 400);

  const db = getDb();
  const [m] = await db.select().from(milestones).where(eq(milestones.id, milestoneId));
  if (!m) return jsonError("milestone not found", 404);

  // The same "open case" definition as the /ops queue.
  if (!(await openOperatorFlags(db, [milestoneId])).has(milestoneId)) return jsonError("milestone is not flagged for an operator", 409);

  await audit(db, { actor: actor.userId, event: AUDIT_EVENTS.opsResolved, milestoneId, contractId: m.contractId, detail: { note, role: actor.role } });
  return json({ ok: true });
}

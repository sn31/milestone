import { NextResponse } from "next/server";
import { and, desc, eq, inArray } from "drizzle-orm";
import { audit, auditLog, milestones } from "@milestone/core";
import { getDb } from "@/lib/db";
import { getActor } from "@/lib/session";

export async function POST(req: Request, ctx: { params: Promise<{ milestoneId: string }> }) {
  const { milestoneId } = await ctx.params;
  const actor = await getActor();
  if (actor.role !== "partner" && (actor.role as string) !== "platform") {
    return NextResponse.json({ error: "only the partner or platform can resolve" }, { status: 403 });
  }
  let note = "";
  try {
    const body = (await req.json()) as { note?: unknown };
    if (typeof body.note === "string") note = body.note.trim();
  } catch {
    return NextResponse.json({ error: "expected JSON body { note }" }, { status: 400 });
  }
  if (!note) return NextResponse.json({ error: "note is required" }, { status: 400 });

  const db = getDb();
  const [m] = await db.select().from(milestones).where(eq(milestones.id, milestoneId));
  if (!m) return NextResponse.json({ error: "milestone not found" }, { status: 404 });

  const [last] = await db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.milestoneId, milestoneId), inArray(auditLog.event, ["milestone.needs_operator", "ops.resolved"])))
    .orderBy(desc(auditLog.createdAt))
    .limit(1);
  if (!last || last.event !== "milestone.needs_operator") {
    return NextResponse.json({ error: "milestone is not flagged for an operator" }, { status: 409 });
  }

  await audit(db, { actor: actor.userId, event: "ops.resolved", milestoneId, contractId: m.contractId, detail: { note, role: actor.role } });
  return NextResponse.json({ ok: true });
}

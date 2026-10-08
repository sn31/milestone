import { NextResponse } from "next/server";
import { audit } from "@milestone/core";
import { getDb } from "@/lib/db";
import { getActor } from "@/lib/session";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const actor = await getActor();
  const back = NextResponse.redirect(new URL(`/contracts/${id}`, req.url), 303);
  const column = actor.role === "client" ? "client_approved_at" : actor.role === "freelancer" ? "freelancer_approved_at" : null;
  if (!column) return NextResponse.json({ error: "only the client or freelancer can approve" }, { status: 403 });

  const db = getDb();
  // Column name comes from the fixed set above. COALESCE keeps the first approval time.
  const res = await db.$client.query(
    `update contracts set ${column} = coalesce(${column}, now()) where id = $1 returning client_approved_at, freelancer_approved_at, status`,
    [id],
  );
  const row = res.rows[0];
  if (!row) return NextResponse.json({ error: "contract not found" }, { status: 404 });
  await audit(db, { actor: actor.userId, event: `contract.approved_by_${actor.role}`, contractId: id });
  if (row.client_approved_at && row.freelancer_approved_at && row.status === "draft") {
    await db.$client.query(`update contracts set status = 'active' where id = $1 and status = 'draft'`, [id]);
    await audit(db, { actor: actor.userId, event: "contract.approved", contractId: id });
  }
  return back;
}

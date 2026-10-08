import { NextResponse } from "next/server";
import { AUDIT_EVENTS, audit } from "@milestone/core";
import { getDb } from "@/lib/db";
import { jsonError } from "@/lib/http";
import { getActor } from "@/lib/session";

/**
 * The client or the freelancer approves the drafted contract. A repeat approval is a no-op (no second audit row);
 * the contract becomes active exactly once, when the second approval lands.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const actor = await getActor();
  const column = actor.role === "client" ? "client_approved_at" : actor.role === "freelancer" ? "freelancer_approved_at" : null;
  if (!column) return jsonError("only the client or freelancer can approve", 403);

  const db = getDb();
  const exists = await db.$client.query(`select status from contracts where id = $1`, [id]);
  if (!exists.rows[0]) return jsonError("contract not found", 404);

  // Column name comes from the fixed set above. Only the first approval sets the time and writes the audit row.
  const first = await db.$client.query(`update contracts set ${column} = now() where id = $1 and ${column} is null returning id`, [id]);
  if (first.rowCount) await audit(db, { actor: actor.userId, event: `contract.approved_by_${actor.role}`, contractId: id });

  const activated = await db.$client.query(
    `update contracts set status = 'active'
       where id = $1 and status = 'draft' and client_approved_at is not null and freelancer_approved_at is not null
       returning id`,
    [id],
  );
  if (activated.rowCount) await audit(db, { actor: actor.userId, event: AUDIT_EVENTS.contractApproved, contractId: id });

  return NextResponse.redirect(new URL(`/contracts/${id}`, req.url), 303);
}

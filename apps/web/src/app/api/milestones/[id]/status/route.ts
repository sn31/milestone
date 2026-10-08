import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { jsonError } from "../../_shared";
import { loadSnapshot } from "./snapshot";

export const dynamic = "force-dynamic";

/**
 * GET: the parts of a milestone that change on their own (status, decision and review times, the latest delivery's
 * verification and evidence summaries, the newest audit row, a PayPal operation still in flight). The contract page
 * polls it every 2 s while a milestone is live and re-renders when anything differs. Read only.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const snapshot = await loadSnapshot(getDb(), id);
  if (!snapshot) return jsonError("milestone not found", 404);
  return NextResponse.json(snapshot, { headers: { "Cache-Control": "no-store" } });
}

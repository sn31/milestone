import { NextResponse } from "next/server";
import { openSimulatedDispute } from "@milestone/money";
import { getDb } from "@/lib/db";
import { notSimulated } from "../../dev/paypal/_guard";

export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store" };

/**
 * Demo: the buyer opens a dispute against a milestone's capture in simulated PayPal, which sends
 * CUSTOMER.DISPUTE.CREATED to the webhook ~1.5 s later (the copilot takes it from there). Simulated mode only.
 * Body (JSON or form): { "milestoneId": "mst_3", "reason"?: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED" }.
 */
export async function POST(req: Request) {
  const blocked = notSimulated();
  if (blocked) return blocked;
  const form = /^(application\/x-www-form-urlencoded|multipart\/form-data)/i.test(req.headers.get("content-type") ?? "");
  const body = (form ? await req.formData().then((f) => Object.fromEntries(f.entries())).catch(() => null) : await req.json().catch(() => null)) as Record<string, unknown> | null;
  const milestoneId = typeof body?.milestoneId === "string" ? body.milestoneId.trim() : "";
  if (!milestoneId) return NextResponse.json({ error: "milestoneId is required" }, { status: 400, headers: noStore });
  const db = getDb();
  const m = await db.query.milestones.findFirst({ where: (t, { eq }) => eq(t.id, milestoneId) });
  if (!m) return NextResponse.json({ error: "milestone not found" }, { status: 404, headers: noStore });
  if (!m.paypalCaptureId) return NextResponse.json({ error: "the milestone has no captured payment to dispute" }, { status: 409, headers: noStore });
  const c = await db.query.contracts.findFirst({ columns: { currency: true }, where: (t, { eq }) => eq(t.id, m.contractId) });
  const reason = typeof body?.reason === "string" && /^[A-Z_]{3,64}$/.test(body.reason) ? body.reason : undefined;
  const opened = openSimulatedDispute({ captureId: m.paypalCaptureId, amountMinor: m.amountMinor, currency: c?.currency ?? "USD", ...(reason ? { reason } : {}) });
  return NextResponse.json({ ...opened, milestoneId }, { headers: noStore });
}

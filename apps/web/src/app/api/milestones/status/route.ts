import { createHash } from "node:crypto";
import { getDb } from "@/lib/db";
import { jsonError, noStore } from "@/lib/http";
import { loadSnapshots, type MilestoneSnapshot } from "../[id]/status/snapshot";

export const dynamic = "force-dynamic";

/** At most this many ids per request (the contract page polls one contract's milestones). */
const MAX_IDS = 50;

/** What GET /api/milestones/status?ids=a,b,c returns; milestones that do not exist are left out. */
export interface MilestoneSnapshots {
  snapshots: MilestoneSnapshot[];
}

/**
 * GET ?ids=a,b,c: the snapshots of several milestones (as GET /api/milestones/[id]/status returns one), with one
 * query per table. The ETag changes whenever any snapshot does (each carries its newest audit id), so a poll that
 * sends If-None-Match with the last ETag gets 304 and no body until something moved. Read only.
 */
export async function GET(req: Request) {
  const raw = new URL(req.url).searchParams.get("ids") ?? "";
  const ids = [...new Set(raw.split(",").map((s) => s.trim()).filter(Boolean))];
  if (ids.length === 0) return jsonError("ids is required (comma-separated milestone ids)", 400);
  if (ids.length > MAX_IDS) return jsonError(`at most ${MAX_IDS} ids per request`, 400);

  const found = await loadSnapshots(getDb(), ids);
  const body: MilestoneSnapshots = { snapshots: ids.flatMap((id) => found.get(id) ?? []) };
  const text = JSON.stringify(body);
  const etag = `W/"${createHash("sha256").update(text).digest("base64url").slice(0, 27)}"`;
  const headers = { ...noStore, ETag: etag };
  const match = req.headers.get("if-none-match");
  if (match && match.split(",").some((t) => t.trim() === etag)) return new Response(null, { status: 304, headers });
  return new Response(text, { status: 200, headers: { ...headers, "Content-Type": "application/json" } });
}

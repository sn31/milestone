/**
 * GET /api/milestones/[id]/status and GET /api/milestones/status?ids= against the local Postgres with throwaway rows
 * (opt in: MILESTONE_E2E=1). Every row created here is removed afterwards.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { e2e, loadRootEnv } from "./helpers";

loadRootEnv();
const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/db", () => ({ getDb: () => state.db }));

import * as core from "@milestone/core";
import { eq, inArray } from "drizzle-orm";
import { GET as one } from "../src/app/api/milestones/[id]/status/route";
import { GET as many } from "../src/app/api/milestones/status/route";
import type { MilestoneSnapshot } from "../src/app/api/milestones/[id]/status/snapshot";

describe.skipIf(!e2e)("milestone status snapshots against Postgres", () => {
  const db = e2e ? core.createDb() : (null as never);
  const tag = randomUUID().slice(0, 8);
  const contractId = `ctr_s_${tag}`;
  const a = `mst_s_${tag}_a`;
  const b = `mst_s_${tag}_b`;
  const at = (s: number) => new Date(Date.UTC(2026, 9, 8, 14, 0, s));

  const getOne = async (id: string) => (await one(new Request(`http://localhost/api/milestones/${id}/status`), { params: Promise.resolve({ id }) })).json() as Promise<MilestoneSnapshot>;
  const getMany = (ids: string, etag?: string) => many(new Request(`http://localhost/api/milestones/status?ids=${ids}`, { headers: etag ? { "if-none-match": etag } : {} }));

  beforeAll(async () => {
    state.db = db;
    await db.insert(core.contracts).values({ id: contractId, clientId: "usr_client", freelancerId: "usr_freelancer", title: "s", scopeText: "s", currency: "USD", totalMinor: 20_000, status: "active" });
    await db.insert(core.milestones).values([
      { id: a, contractId, seq: 1, title: "a", amountMinor: 10_000, status: "verifying" },
      { id: b, contractId, seq: 2, title: "b", amountMinor: 10_000, status: "held" },
    ]);
    const evidence = [{ id: "ev_x", kind: "log", status: "pass", summary: `npm  test:\n${"y".repeat(5000)}` }, "junk", { kind: 7, summary: 3 }, ...Array.from({ length: 50 }, (_, i) => ({ id: `ev_${i}`, kind: "note" }))];
    await db.insert(core.deliveries).values([
      { id: `dlv_s_${tag}_old`, milestoneId: a, source: "manual", ref: "t", receivedAt: at(0) },
      { id: `dlv_s_${tag}_new`, milestoneId: a, source: "manual", ref: "t", receivedAt: at(10), verifiedAt: at(20), result: "pass", evidence },
    ]);
    await db.insert(core.auditLog).values([
      { id: `aud_s_${tag}_1`, milestoneId: a, contractId, actor: "t", event: "delivery.manual", createdAt: at(1) },
      { id: `aud_s_${tag}_2`, milestoneId: a, contractId, actor: "t", event: "milestone.verifying", createdAt: at(11) },
      { id: `aud_s_${tag}_3`, milestoneId: a, contractId, actor: "t", event: "verdict.stored", createdAt: at(21) },
      { id: `aud_s_${tag}_4`, milestoneId: b, contractId, actor: "t", event: "milestone.held", createdAt: at(5) },
    ]);
    await db.insert(core.paypalOps).values({ id: randomUUID(), kind: "payout", key: b, requestId: randomUUID(), status: "sent" });
  });

  afterAll(async () => {
    if (!e2e) return;
    await db.delete(core.paypalOps).where(inArray(core.paypalOps.key, [a, b]));
    await db.delete(core.auditLog).where(eq(core.auditLog.contractId, contractId));
    await db.delete(core.deliveries).where(inArray(core.deliveries.milestoneId, [a, b]));
    await db.delete(core.milestones).where(eq(core.milestones.contractId, contractId));
    await db.delete(core.contracts).where(eq(core.contracts.id, contractId));
    await db.$client.end();
  });

  it("reports the latest delivery, its evidence trimmed, and the events since it came in", async () => {
    const s = await getOne(a);
    expect(s.delivery).toMatchObject({ id: `dlv_s_${tag}_new`, receivedAt: at(10).toISOString(), verifiedAt: at(20).toISOString(), result: "pass", evidenceCount: 53 });
    expect(s.evidence).toHaveLength(40);
    expect(s.evidence[0]).toEqual({ id: "ev_x", kind: "log", status: "pass", summary: `npm test: ${"y".repeat(229)}…`, criterionId: null });
    expect(s.evidence[1]).toEqual({ id: "ev_1", kind: "note", status: null, summary: "", criterionId: null });
    expect(s.events.map((e) => e.event)).toEqual(["milestone.verifying", "verdict.stored"]);
    expect(s.auditId).toBe(`aud_s_${tag}_3`);
    expect(s.live).toBe(true);
  });

  it("keeps the newest audit id when nothing happened since the latest delivery, and reports an op in flight", async () => {
    const s = await getOne(b);
    expect(s.delivery).toBeNull();
    expect(s.events.map((e) => e.event)).toEqual(["milestone.held"]);
    expect(s.pendingOp).toEqual({ kind: "payout", status: "sent" });
    expect(s.live).toBe(true);
  });

  it("returns the same snapshots in one batch, skips unknown ids, and answers 304 to a matching If-None-Match", async () => {
    const res = await getMany(`${a},nope_${tag},${b},${a}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as { snapshots: MilestoneSnapshot[] };
    expect(body.snapshots).toEqual([await getOne(a), await getOne(b)]);
    const etag = res.headers.get("etag")!;
    expect((await getMany(`${a},${b}`, etag)).status).toBe(304);

    await db.insert(core.auditLog).values({ id: `aud_s_${tag}_5`, milestoneId: b, contractId, actor: "t", event: "ops.resolved", createdAt: at(30) });
    const moved = await getMany(`${a},${b}`, etag);
    expect(moved.status).toBe(200);
    expect(moved.headers.get("etag")).not.toBe(etag);
  });

  it("refuses a request without ids", async () => {
    expect((await getMany("")).status).toBe(400);
  });
});

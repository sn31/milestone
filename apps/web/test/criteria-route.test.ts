/**
 * PATCH /api/contracts/[id]/criteria and the approve route's lock check against the local Postgres with throwaway rows
 * (opt in: MILESTONE_E2E=1). The session is mocked; every row created here is removed afterwards.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { e2e, loadRootEnv } from "./helpers";

loadRootEnv();
const state = vi.hoisted(() => ({ actor: { userId: "usr_client", role: "client" } as { userId: string; role: string }, db: null as unknown }));
vi.mock("@/lib/session", async (orig) => ({ ...(await orig<typeof import("@/lib/session")>()), getActor: async () => state.actor }));
vi.mock("@/lib/db", () => ({ getDb: () => state.db }));

import * as core from "@milestone/core";
import { and, eq, inArray } from "drizzle-orm";
import { PATCH } from "../src/app/api/contracts/[id]/criteria/route";
import { POST as approve } from "../src/app/api/contracts/[id]/approve/route";

describe.skipIf(!e2e)("criteria editing against Postgres", () => {
  const db = e2e ? core.createDb() : (null as never);
  const tag = randomUUID().slice(0, 8);
  const contractIds: string[] = [];
  const milestoneIds: string[] = [];

  const actAs = (userId: string, role: string) => {
    state.actor = { userId, role };
  };
  const patch = (contractId: string, body: unknown) =>
    PATCH(new Request(`http://localhost/api/contracts/${contractId}/criteria`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }), {
      params: Promise.resolve({ id: contractId }),
    });
  const approveAs = (contractId: string, version?: string) => {
    const form = new FormData();
    if (version) form.set("criteriaVersion", version);
    return approve(new Request(`http://localhost/api/contracts/${contractId}/approve`, { method: "POST", body: form }), { params: Promise.resolve({ id: contractId }) });
  };
  const rows = async (milestoneId: string) => db.select().from(core.criteria).where(eq(core.criteria.milestoneId, milestoneId));
  const contractRow = async (id: string) => (await db.select().from(core.contracts).where(eq(core.contracts.id, id)))[0]!;
  const audits = async (contractId: string, event: string) => db.select().from(core.auditLog).where(and(eq(core.auditLog.contractId, contractId), eq(core.auditLog.event, event)));

  /** A draft contract with two milestones: m1 has a test and a judgment check, m2 a file check. */
  async function draft(n: string) {
    const contractId = `con_t_${tag}_${n}`;
    contractIds.push(contractId);
    await db.insert(core.contracts).values({ id: contractId, clientId: "usr_client", freelancerId: "usr_freelancer", title: n, scopeText: n, currency: "USD", totalMinor: 20_000 });
    const m1 = `mil_t_${tag}_${n}_1`;
    const m2 = `mil_t_${tag}_${n}_2`;
    milestoneIds.push(m1, m2);
    await db.insert(core.milestones).values([
      { id: m1, contractId, seq: 1, title: "Build", amountMinor: 10_000 },
      { id: m2, contractId, seq: 2, title: "Docs", amountMinor: 10_000 },
    ]);
    await db.insert(core.criteria).values([
      { id: `crt_${tag}_${n}_a`, milestoneId: m1, kind: "test", description: "Tests pass", spec: { command: "npm test" }, required: true },
      { id: `crt_${tag}_${n}_b`, milestoneId: m1, kind: "judgment", description: "Code reads well", spec: {}, required: false },
      { id: `crt_${tag}_${n}_c`, milestoneId: m2, kind: "file", description: "README exists", spec: { path: "README.md" }, required: true },
    ]);
    return { contractId, m1, m2, a: `crt_${tag}_${n}_a`, b: `crt_${tag}_${n}_b`, c: `crt_${tag}_${n}_c` };
  }

  beforeAll(() => {
    state.db = db;
  });
  beforeEach(() => actAs("usr_client", "client"));
  afterAll(async () => {
    if (!e2e) return;
    await db.delete(core.auditLog).where(inArray(core.auditLog.contractId, contractIds));
    await db.delete(core.criteria).where(inArray(core.criteria.milestoneId, milestoneIds));
    await db.delete(core.milestones).where(inArray(core.milestones.id, milestoneIds));
    await db.delete(core.contracts).where(inArray(core.contracts.id, contractIds));
  });

  it("applies an edit, keeps the order, and audits it with before and after", async () => {
    const k = await draft("edit");
    const res = await patch(k.contractId, {
      milestoneId: k.m1,
      operations: [
        { op: "update", criterionId: k.a, patch: { description: "Unit tests pass", spec: { command: "pnpm test" } } },
        { op: "add", criterion: { kind: "build", description: "Builds", spec: { command: "npm run build" } } },
      ],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { criteria: core.EditableCriterion[]; approvalsCleared: boolean; changed: boolean };
    expect(body).toMatchObject({ approvalsCleared: false, changed: true });
    expect(body.criteria.map((c) => c.description)).toEqual(["Unit tests pass", "Code reads well", "Builds"]);
    const added = body.criteria[2]!.id;
    expect(added).toMatch(/^crt_/);

    // Freelancer reorders; either party may propose edits.
    actAs("usr_freelancer", "freelancer");
    const re = await patch(k.contractId, { milestoneId: k.m1, op: "reorder", order: [added, k.a, k.b] });
    expect(re.status).toBe(200);
    expect((await rows(k.m1)).map((c) => c.id)).toEqual([added, k.a, k.b]);
    expect((await rows(k.m1)).find((c) => c.id === k.a)).toMatchObject({ description: "Unit tests pass", spec: { command: "pnpm test" } });

    const edits = await audits(k.contractId, core.CRITERIA_AUDIT.edited);
    expect(edits).toHaveLength(2);
    const first = edits.map((e) => core.asRecord(e.detail)).find((d) => d.by === "client")!;
    expect((first.before as core.EditableCriterion[]).map((c) => c.description)).toEqual(["Tests pass", "Code reads well"]);
    expect((first.after as core.EditableCriterion[]).map((c) => c.description)).toEqual(["Unit tests pass", "Code reads well", "Builds"]);
    expect(edits.every((e) => e.milestoneId === k.m1)).toBe(true);

    // The same words again change nothing and write nothing.
    const same = await patch(k.contractId, { milestoneId: k.m1, op: "update", criterionId: k.b, patch: { description: "Code reads well" } });
    expect(await same.json()).toMatchObject({ changed: false });
    expect(await audits(k.contractId, core.CRITERIA_AUDIT.edited)).toHaveLength(2);
  });

  it("refuses an invalid edit with plain errors and changes nothing", async () => {
    const k = await draft("invalid");
    const lastAuto = await patch(k.contractId, { milestoneId: k.m2, op: "remove", criterionId: k.c });
    expect(lastAuto.status).toBe(422);
    const body = (await lastAuto.json()) as { error: string; errors: core.CriteriaEditError[] };
    expect(body.error).toBe("invalid_criteria");
    expect(body.errors[0]!.message).toMatch(/Milestone 2 needs at least one automatic check/);

    const noPath = await patch(k.contractId, { milestoneId: k.m2, op: "update", criterionId: k.c, patch: { spec: { path: "" } } });
    expect(noPath.status).toBe(422);
    expect(((await noPath.json()) as { errors: core.CriteriaEditError[] }).errors).toEqual([expect.objectContaining({ criterionId: k.c, field: "spec", message: "Give the file that must exist, such as README.md." })]);

    const badKind = await patch(k.contractId, { milestoneId: k.m1, op: "update", criterionId: k.a, patch: { kind: "vibes" } });
    expect(badKind.status).toBe(422);
    const missing = await patch(k.contractId, { milestoneId: k.m1, op: "remove", criterionId: "crt_nope" });
    expect(missing.status).toBe(422);
    expect((await patch(k.contractId, { milestoneId: k.m1, op: "rename" })).status).toBe(400);
    expect((await patch(k.contractId, { milestoneId: "mil_elsewhere", op: "remove", criterionId: k.a })).status).toBe(404);
    expect((await patch(`con_nope_${tag}`, { milestoneId: k.m1, op: "remove", criterionId: k.a })).status).toBe(404);
    actAs("usr_partner", "partner");
    expect((await patch(k.contractId, { milestoneId: k.m1, op: "remove", criterionId: k.b })).status).toBe(403);

    expect((await rows(k.m2)).map((c) => c.spec)).toEqual([{ path: "README.md" }]);
    expect(await rows(k.m1)).toHaveLength(2);
    expect(await audits(k.contractId, core.CRITERIA_AUDIT.edited)).toHaveLength(0);
  });

  it("an edit after one approval clears both and is audited", async () => {
    const k = await draft("clear");
    expect((await approveAs(k.contractId)).status).toBe(303);
    expect((await contractRow(k.contractId)).clientApprovedAt).not.toBeNull();

    actAs("usr_freelancer", "freelancer");
    const res = await patch(k.contractId, { milestoneId: k.m1, op: "update", criterionId: k.b, patch: { required: true } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ approvalsCleared: true });
    const c = await contractRow(k.contractId);
    expect(c).toMatchObject({ clientApprovedAt: null, freelancerApprovedAt: null, status: "draft" });
    const cleared = await audits(k.contractId, core.CRITERIA_AUDIT.approvalsCleared);
    expect(cleared).toHaveLength(1);
    expect(core.asRecord(cleared[0]!.detail)).toMatchObject({ by: "freelancer", freelancerApprovedAt: null });
    expect(core.asRecord(cleared[0]!.detail).clientApprovedAt).toEqual(expect.any(String));
  });

  it("locks once both approved or a milestone is funded", async () => {
    const k = await draft("lock");
    await approveAs(k.contractId);
    actAs("usr_freelancer", "freelancer");
    await approveAs(k.contractId);
    expect((await contractRow(k.contractId)).status).toBe("active");
    const res = await patch(k.contractId, { milestoneId: k.m1, op: "remove", criterionId: k.b });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "contract_locked", reason: "both_approved" });

    const f = await draft("funded");
    await db.update(core.milestones).set({ status: "funded" }).where(eq(core.milestones.id, f.m2));
    const funded = await patch(f.contractId, { milestoneId: f.m1, op: "remove", criterionId: f.b });
    expect(funded.status).toBe(409);
    expect(await funded.json()).toMatchObject({ error: "contract_locked", reason: "milestone_funded" });
    expect(await rows(f.m1)).toHaveLength(2);
  });

  it("the approve route records nothing when the criteria changed since the page was shown", async () => {
    const k = await draft("stale");
    const shown = core.criteriaVersion((await db.select().from(core.criteria).where(inArray(core.criteria.milestoneId, [k.m1, k.m2]))) as core.EditableCriterion[]);
    actAs("usr_freelancer", "freelancer");
    await patch(k.contractId, { milestoneId: k.m1, op: "update", criterionId: k.a, patch: { spec: { command: "npm test -- --silent" } } });
    actAs("usr_client", "client");
    expect((await approveAs(k.contractId, shown)).status).toBe(303);
    expect((await contractRow(k.contractId)).clientApprovedAt).toBeNull();
    expect(await audits(k.contractId, "contract.approved_by_client")).toHaveLength(0);

    const current = core.criteriaVersion((await db.select().from(core.criteria).where(inArray(core.criteria.milestoneId, [k.m1, k.m2]))) as core.EditableCriterion[]);
    await approveAs(k.contractId, current);
    expect((await contractRow(k.contractId)).clientApprovedAt).not.toBeNull();
  });
});

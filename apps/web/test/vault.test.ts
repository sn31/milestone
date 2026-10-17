/**
 * Saving the client's PayPal and the mandate's funding terms, through the web routes.
 * Unit: parseCreate / parseFundTerms (always run). End to end (opt in: MILESTONE_E2E=1, on a scratch database): the
 * save flow against the local simulator (POST /api/vault/start -> the simulator's approve page -> GET /api/vault/return
 * -> GET /api/vault -> DELETE /api/vault), its refusals (agents, another user's approval, a second save), and mandates
 * with fund caps (POST /api/agents, PATCH /api/agents/[id]). The signed-in actor is a throwaway client user; every row
 * created here is removed afterwards.
 */
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { e2e, loadRootEnv } from "./helpers";

const state = await vi.hoisted(async () => {
  const { mkdtempSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "vault-test-"));
  process.env.SIMULATED_PAYPAL_STATE_FILE = join(dir, "simulated-paypal.json");
  process.env.PAYPAL_MODE = "simulated";
  process.env.APP_URL = "http://milestone.test";
  return { dir, db: null as unknown, actor: { userId: "usr_client", role: "client" } as { userId: string; role: string } };
});
loadRootEnv();

vi.mock("@/lib/db", () => ({ getDb: () => state.db }));
vi.mock("@/lib/paypal", async () => {
  const { createSimulatedPayPalClient } = await import("@milestone/money");
  const client = createSimulatedPayPalClient();
  return { paypal: () => client };
});
vi.mock("@/lib/session", async (orig) => ({
  ...(await orig<typeof import("../src/lib/session")>()),
  getActor: async () => state.actor,
}));

import { and, eq, inArray, like, or, sql } from "drizzle-orm";
import * as core from "@milestone/core";
import { simulatedSetupToken } from "@milestone/money";
import { mandateView, parseCreate, parseFundTerms } from "../src/app/api/agents/_shared";
import { POST as createMandateRoute } from "../src/app/api/agents/route";
import { PATCH as patchMandate } from "../src/app/api/agents/[id]/route";
import { DELETE as vaultDELETE, GET as vaultGET } from "../src/app/api/vault/route";
import { POST as vaultStart } from "../src/app/api/vault/start/route";
import { GET as vaultReturn } from "../src/app/api/vault/return/route";
import { GET as simApprove } from "../src/app/api/dev/paypal/vault-approve/route";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const BASE = "http://milestone.test";

describe("mandate funding terms (parseCreate)", () => {
  const base = { agentName: "a", actions: ["read", "fund"], currency: "USD", expiresInDays: 30 };

  it("takes both fund caps, in major or minor units, and the auto-fund flag", () => {
    const a = parseCreate({ ...base, fundCap: "150.00", fundTotalCap: "500", autoFundNext: true }, "client");
    expect(a).toMatchObject({ fundCapMinor: 15_000, fundTotalCapMinor: 50_000, autoFundNext: true });
    const b = parseCreate({ ...base, fundCapMinor: 100, fundTotalCapMinor: 300 }, "client");
    expect(b).toMatchObject({ fundCapMinor: 100, fundTotalCapMinor: 300, autoFundNext: false });
  });

  it("keeps fund without caps (checkout the client approves) and leaves caps null", () => {
    expect(parseCreate(base, "client")).toMatchObject({ fundCapMinor: null, fundTotalCapMinor: null, autoFundNext: false });
  });

  it("refuses one cap alone, caps without fund, per-milestone above total, auto-fund without caps, bad values", () => {
    const err = (b: Record<string, unknown>) => (parseCreate({ ...base, ...b }, "client") as { error?: string }).error;
    expect(err({ fundCap: "100.00" })).toMatch(/both fund caps/);
    expect(err({ fundTotalCap: "100.00" })).toMatch(/both fund caps/);
    expect(err({ actions: ["read"], fundCap: "1.00", fundTotalCap: "2.00" })).toMatch(/needs "fund"/);
    expect(err({ fundCap: "300.00", fundTotalCap: "200.00" })).toMatch(/cannot be more/);
    expect(err({ autoFundNext: true })).toMatch(/autoFundNext needs/);
    expect(err({ actions: ["read"], autoFundNext: true })).toMatch(/autoFundNext needs/);
    expect(err({ fundCap: "abc", fundTotalCap: "2.00" })).toMatch(/decimal string/);
    expect(err({ fundCapMinor: -1, fundTotalCapMinor: 2 })).toMatch(/non-negative integer/);
    expect(err({ fundCapMinor: 1.5, fundTotalCapMinor: 2 })).toMatch(/non-negative integer/);
    expect(err({ fundCap: "1.00", fundTotalCap: "2.00", autoFundNext: "yes" })).toMatch(/true or false/);
  });

  it("parseFundTerms clears a cap given as null or empty", () => {
    expect(parseFundTerms({ fundCap: "", fundTotalCapMinor: null }, ["fund"], "USD")).toEqual({ fundCapMinor: null, fundTotalCapMinor: null, autoFundNext: false });
  });

  it("mandateView shows the fund caps and the auto-fund flag, never the token hash", () => {
    const now = new Date();
    const v = mandateView({
      id: "mdt_x", userId: "u", agentName: "a", tokenHash: "secret", actions: ["fund"], approveCapMinor: null, fundCapMinor: 15_000, fundTotalCapMinor: 50_000, autoFundNext: true,
      currency: "USD", expiresAt: new Date(now.getTime() + 1000), createdAt: now, revokedAt: null, lastUsedAt: null,
    } as core.AgentMandate);
    expect(v.fundCap).toEqual({ amountMinor: 15_000, value: "150.00", currency: "USD" });
    expect(v.fundTotalCap?.value).toBe("500.00");
    expect(v.autoFundNext).toBe(true);
    expect(JSON.stringify(v)).not.toContain("secret");
  });
});

describe.skipIf(!e2e)("saved PayPal and fund caps through the web routes", () => {
  const db = e2e ? core.createDb() : (null as never);
  const tag = randomUUID().slice(0, 8);
  const userA = `usr_vt_a_${tag}`;
  const userB = `usr_vt_b_${tag}`;
  const agentPrefix = `vault-${tag}`;
  const as = (userId: string, role = "client") => void (state.actor = { userId, role });
  const req = (path: string, init: RequestInit = {}) => new Request(`${BASE}${path}`, init);
  const jsonReq = (path: string, method: string, body: unknown, headers: Record<string, string> = {}) =>
    req(path, { method, headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  const params = (id: string) => ({ params: Promise.resolve({ id }) });
  const location = (res: Response) => new URL(res.headers.get("location") ?? "");

  /** Start -> simulator approve -> return, as the browser does; returns the return route's response. */
  async function saveFlow(userId: string): Promise<{ setupTokenId: string; back: Response }> {
    as(userId);
    const start = await vaultStart(req("/api/vault/start", { method: "POST" }));
    expect(start.status).toBe(200);
    const { setupTokenId, approveUrl } = (await start.json()) as { setupTokenId: string; approveUrl: string };
    const approve = new URL(approveUrl);
    expect(approve.pathname).toBe("/api/dev/paypal/vault-approve");
    const sim = await simApprove(req(`${approve.pathname}${approve.search}`));
    expect(sim.status).toBe(303);
    const ret = location(sim);
    expect(ret.pathname).toBe("/api/vault/return");
    expect(ret.searchParams.get("approval_token_id")).toBe(setupTokenId);
    const back = await vaultReturn(req(`${ret.pathname}${ret.search}`));
    return { setupTokenId, back };
  }

  beforeAll(async () => {
    state.db = db;
    await db.insert(core.users).values([
      { id: userA, role: "client", name: `Vault A ${tag}`, email: `a-${tag}@example.com` },
      { id: userB, role: "client", name: `Vault B ${tag}`, email: `b-${tag}@example.com` },
    ]);
  });

  afterAll(async () => {
    if (!e2e) return;
    const users = [userA, userB];
    const pms = await db.select({ id: core.paymentMethods.id, token: core.paymentMethods.paypalPaymentTokenId }).from(core.paymentMethods).where(inArray(core.paymentMethods.userId, users));
    const setups = await db.select({ id: core.vaultSetups.id, token: core.vaultSetups.setupTokenId }).from(core.vaultSetups).where(inArray(core.vaultSetups.userId, users));
    const keys = [...pms.map((p) => p.token), ...setups.flatMap((s) => [s.id, s.token])];
    if (keys.length) await db.delete(core.paypalOps).where(inArray(core.paypalOps.key, keys));
    await db.delete(core.auditLog).where(or(inArray(core.auditLog.actor, users), like(core.auditLog.actor, `%for ${userA}`), sql`${core.auditLog.detail}->>'agentName' like ${`${agentPrefix}%`}`));
    await db.delete(core.agentMandates).where(inArray(core.agentMandates.userId, users));
    await db.delete(core.paymentMethods).where(inArray(core.paymentMethods.userId, users));
    await db.delete(core.vaultSetups).where(inArray(core.vaultSetups.userId, users));
    await db.delete(core.users).where(inArray(core.users.id, users));
    await db.$client.end?.();
    rmSync(state.dir, { recursive: true, force: true });
  });

  it("refuses agents and non-clients before anything else", async () => {
    as(userA);
    const agent = await vaultStart(req("/api/vault/start", { method: "POST", headers: { Authorization: "Bearer msa_x" } }));
    expect(agent.status).toBe(403);
    expect(((await agent.json()) as Any).reason).toBe("agents_cannot_manage_payment_methods");
    const agentDel = await vaultDELETE(jsonReq("/api/vault", "DELETE", {}, { Authorization: "Bearer msa_x" }));
    expect(agentDel.status).toBe(403);
    as("usr_freelancer", "freelancer");
    expect((await vaultStart(req("/api/vault/start", { method: "POST" }))).status).toBe(403);
    expect((await vaultGET(req("/api/vault"))).status).toBe(403);
  });

  it("saves the PayPal through the simulator's approval and shows it", async () => {
    const { setupTokenId, back } = await saveFlow(userA);
    expect(back.status).toBe(303);
    const to = location(back);
    expect(to.pathname).toBe("/agents");
    expect(to.searchParams.get("vault")).toBe("saved");

    const view = (await (await vaultGET(req("/api/vault"))).json()) as Any;
    expect(view.paymentMethod.payerEmail).toMatch(/@/);
    expect(view.paymentMethod.tokenTail).toHaveLength(4);
    expect(JSON.stringify(view)).not.toContain(simulatedSetupToken(setupTokenId)?.paymentTokenId ?? "never");

    // Bound to the user who started it, and every PayPal POST carried a request id from paypal_ops.
    const [setup] = await db.select().from(core.vaultSetups).where(eq(core.vaultSetups.setupTokenId, setupTokenId));
    expect(setup).toMatchObject({ userId: userA, status: "vaulted" });
    const ops = await db.select().from(core.paypalOps).where(inArray(core.paypalOps.key, [setup!.id, setupTokenId]));
    expect(ops.map((o) => o.kind).sort()).toEqual([core.VAULT_OP_KINDS.paymentToken, core.VAULT_OP_KINDS.setupToken]);
    expect(ops.every((o) => o.status === "succeeded" && o.requestId)).toBe(true);

    // A reload of the return URL is idempotent: same payment method, no second row.
    as(userA);
    const again = await vaultReturn(req(`/api/vault/return?approval_token_id=${encodeURIComponent(setupTokenId)}`));
    expect(location(again).searchParams.get("vault")).toBe("saved");
    expect(await db.select().from(core.paymentMethods).where(eq(core.paymentMethods.userId, userA))).toHaveLength(1);
  });

  it("refuses a second save while one is saved, and another user's approval", async () => {
    as(userA);
    const second = await vaultStart(req("/api/vault/start", { method: "POST" }));
    expect(second.status).toBe(409);
    expect(((await second.json()) as Any).reason).toBe("already_saved");

    const [setupA] = await db.select().from(core.vaultSetups).where(eq(core.vaultSetups.userId, userA));
    as(userB);
    const stolen = await vaultReturn(req(`/api/vault/return?approval_token_id=${encodeURIComponent(setupA!.setupTokenId)}`));
    expect(location(stolen).searchParams.get("vault")).toBe("error");
    expect(location(stolen).searchParams.get("reason")).toBe("unknown_setup");
    expect(await db.select().from(core.paymentMethods).where(eq(core.paymentMethods.userId, userB))).toHaveLength(0);

    const cancelled = await vaultReturn(req("/api/vault/return?cancelled=1"));
    expect(location(cancelled).searchParams.get("vault")).toBe("cancelled");
    const missing = await vaultReturn(req("/api/vault/return"));
    expect(location(missing).searchParams.get("reason")).toBe("missing_approval_token");
  });

  it("the simulator's approve page is only there in simulated mode and follows only this app's return URL", async () => {
    expect((await simApprove(req("/api/dev/paypal/vault-approve"))).status).toBe(400);
    expect((await simApprove(req("/api/dev/paypal/vault-approve?token=SIM-NOPE"))).status).toBe(404);
    const mode = process.env.PAYPAL_MODE;
    process.env.PAYPAL_MODE = "sandbox";
    try {
      expect((await simApprove(req("/api/dev/paypal/vault-approve?token=x"))).status).toBe(404);
    } finally {
      process.env.PAYPAL_MODE = mode;
    }
  });

  it("creates a mandate with fund caps and auto-fund, and changes them with PATCH", async () => {
    as(userA);
    const bad = await createMandateRoute(jsonReq("/api/agents", "POST", { agentName: `${agentPrefix}-bad`, actions: ["read", "fund"], fundCap: "100.00", autoFundNext: true }));
    expect(bad.status).toBe(400);

    const res = await createMandateRoute(
      jsonReq("/api/agents", "POST", { agentName: `${agentPrefix}-ok`, actions: ["read", "fund"], fundCap: "150.00", fundTotalCap: "500.00", autoFundNext: true, currency: "USD", expiresInDays: 7 }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as Any;
    expect(body.mandate).toMatchObject({ autoFundNext: true, fundCap: { amountMinor: 15_000 }, fundTotalCap: { amountMinor: 50_000 } });
    const id = body.mandate.id as string;
    const [row] = await db.select().from(core.agentMandates).where(eq(core.agentMandates.id, id));
    expect(row).toMatchObject({ userId: userA, fundCapMinor: 15_000, fundTotalCapMinor: 50_000, autoFundNext: true });

    // Agents never change terms; only funding keys are accepted; the rules hold on the merged terms.
    expect((await patchMandate(jsonReq(`/api/agents/${id}`, "PATCH", { autoFundNext: false }, { Authorization: `Bearer ${body.token}` }), params(id))).status).toBe(403);
    expect((await patchMandate(jsonReq(`/api/agents/${id}`, "PATCH", { approveCapMinor: 1 }), params(id))).status).toBe(400);
    expect((await patchMandate(jsonReq(`/api/agents/${id}`, "PATCH", { fundCap: null }), params(id))).status).toBe(400);
    expect((await patchMandate(jsonReq(`/api/agents/${id}`, "PATCH", { fundCap: "600.00" }), params(id))).status).toBe(400);

    const off = await patchMandate(jsonReq(`/api/agents/${id}`, "PATCH", { autoFundNext: false }), params(id));
    expect(off.status).toBe(200);
    expect(((await off.json()) as Any).mandate).toMatchObject({ autoFundNext: false, fundCap: { amountMinor: 15_000 } });
    const raise = await patchMandate(jsonReq(`/api/agents/${id}`, "PATCH", { fundTotalCap: "800.00", autoFundNext: true }), params(id));
    expect(((await raise.json()) as Any).mandate).toMatchObject({ autoFundNext: true, fundTotalCap: { amountMinor: 80_000 } });
    const audited = await db.select().from(core.auditLog).where(and(eq(core.auditLog.actor, userA), eq(core.auditLog.event, "agent.mandate_updated")));
    expect(audited).toHaveLength(2);

    // Another user's mandate is not found; a revoked one cannot change.
    as(userB);
    expect((await patchMandate(jsonReq(`/api/agents/${id}`, "PATCH", { autoFundNext: false }), params(id))).status).toBe(404);
    as(userA);
    await core.revokeMandate(db, id, { userId: userA });
    expect((await patchMandate(jsonReq(`/api/agents/${id}`, "PATCH", { autoFundNext: false }), params(id))).status).toBe(409);
  });

  it("removes the saved PayPal here and at PayPal; another user cannot remove it", async () => {
    const [pm] = await db.select().from(core.paymentMethods).where(eq(core.paymentMethods.userId, userA));
    as(userB);
    expect((await vaultDELETE(jsonReq("/api/vault", "DELETE", { paymentMethodId: pm!.id }))).status).toBe(404);
    as(userA);
    const del = await vaultDELETE(jsonReq("/api/vault", "DELETE", { paymentMethodId: pm!.id }));
    expect(del.status).toBe(200);
    expect(((await del.json()) as Any).paymentMethod.removedAt).toBeTruthy();
    expect(((await (await vaultGET(req("/api/vault"))).json()) as Any).paymentMethod).toBeNull();
    const [op] = await db.select().from(core.paypalOps).where(and(eq(core.paypalOps.kind, core.VAULT_OP_KINDS.deleteToken), eq(core.paypalOps.key, pm!.paypalPaymentTokenId)));
    expect(op?.status).toBe("succeeded");
    // Saving again works once the old one is removed.
    const { back } = await saveFlow(userA);
    expect(location(back).searchParams.get("vault")).toBe("saved");
  });
});

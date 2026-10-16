/** Agent mandates: the pure checks always run; the DB-backed lifecycle is opt in (MILESTONE_E2E=1). */
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb } from "../src/db.ts";
import {
  AGENT_TOKEN_PREFIX,
  agentActor,
  authenticateAgent,
  bearerToken,
  createMandate,
  hashAgentToken,
  isAgentActor,
  mandateAllows,
  resolveAgentToken,
  revokeMandate,
  type AgentMandate,
} from "../src/mandates.ts";
import { agentMandates, users } from "../src/schema.ts";
import { MANDATE_ACTIONS, type MandateAction } from "../src/schemas.ts";

const now = new Date("2026-10-16T12:00:00Z");
const later = new Date(now.getTime() + 86_400_000);
type Terms = Pick<AgentMandate, "actions" | "approveCapMinor" | "currency" | "expiresAt" | "revokedAt">;
const terms = (over: Partial<Terms> = {}): Terms => ({
  actions: ["read", "approve", "hold"],
  approveCapMinor: 20_000,
  currency: "USD",
  expiresAt: later,
  revokedAt: null,
  ...over,
});
const at = { now };

describe("mandateAllows", () => {
  it("allows a listed action, and approve within the cap (inclusive) in the mandate's currency", () => {
    expect(mandateAllows(terms(), "read", undefined, at)).toEqual({ ok: true });
    expect(mandateAllows(terms(), "hold", undefined, at)).toEqual({ ok: true });
    expect(mandateAllows(terms(), "approve", 10_000, { ...at, currency: "USD" })).toEqual({ ok: true });
    expect(mandateAllows(terms(), "approve", 20_000, at)).toEqual({ ok: true });
    expect(mandateAllows(terms(), "approve", 0, at)).toEqual({ ok: true });
  });

  it("refuses an action the mandate does not list", () => {
    for (const a of ["fund", "deliver", "draft_contract"] as MandateAction[]) {
      expect(mandateAllows(terms(), a, undefined, at)).toEqual({ refused: "mandate_missing_action" });
    }
    expect(mandateAllows(terms({ actions: ["read", "hold"] }), "approve", 1, at)).toEqual({ refused: "mandate_missing_action" });
    expect(mandateAllows(terms({ actions: [] }), "read", undefined, at)).toEqual({ refused: "mandate_missing_action" });
    // A malformed actions column (it is jsonb) fails closed.
    expect(mandateAllows(terms({ actions: "approve" as never }), "approve", 1, at)).toEqual({ refused: "mandate_missing_action" });
  });

  it("refuses approve above the cap, without a cap, without an amount, with a bad amount or in another currency", () => {
    expect(mandateAllows(terms(), "approve", 20_001, at)).toEqual({ refused: "mandate_cap_exceeded" });
    expect(mandateAllows(terms({ approveCapMinor: null }), "approve", 1, at)).toEqual({ refused: "mandate_cap_exceeded" });
    expect(mandateAllows(terms(), "approve", undefined, at)).toEqual({ refused: "mandate_cap_exceeded" });
    expect(mandateAllows(terms(), "approve", -1, at)).toEqual({ refused: "mandate_cap_exceeded" });
    expect(mandateAllows(terms(), "approve", 1.5, at)).toEqual({ refused: "mandate_cap_exceeded" });
    expect(mandateAllows(terms(), "approve", Number.NaN, at)).toEqual({ refused: "mandate_cap_exceeded" });
    expect(mandateAllows(terms(), "approve", 100, { ...at, currency: "EUR" })).toEqual({ refused: "mandate_cap_exceeded" });
  });

  it("the cap applies to approve only", () => {
    expect(mandateAllows(terms({ approveCapMinor: null }), "hold", 999_999, at)).toEqual({ ok: true });
  });

  it("refuses everything once expired (at the instant of expiry) or revoked; revocation is reported first", () => {
    expect(mandateAllows(terms({ expiresAt: now }), "read", undefined, at)).toEqual({ refused: "mandate_expired" });
    expect(mandateAllows(terms({ expiresAt: new Date(now.getTime() - 1) }), "approve", 1, at)).toEqual({ refused: "mandate_expired" });
    expect(mandateAllows(terms({ expiresAt: new Date(Number.NaN) }), "read", undefined, at)).toEqual({ refused: "mandate_expired" });
    expect(mandateAllows(terms({ revokedAt: now }), "read", undefined, at)).toEqual({ refused: "mandate_revoked" });
    expect(mandateAllows(terms({ revokedAt: now, expiresAt: now }), "hold", undefined, at)).toEqual({ refused: "mandate_revoked" });
    // A revocation scheduled in the future has not happened yet.
    expect(mandateAllows(terms({ revokedAt: later }), "read", undefined, at)).toEqual({ ok: true });
  });

  it("never allows an approve whose amount exceeds the cap, whatever the other terms (exhaustive over actions)", () => {
    for (const actions of [MANDATE_ACTIONS, ["approve"]] as MandateAction[][]) {
      for (const cap of [0, 1, 20_000]) {
        for (const amount of [cap + 1, cap + 10_000]) {
          expect(mandateAllows(terms({ actions, approveCapMinor: cap }), "approve", amount, at)).toEqual({ refused: "mandate_cap_exceeded" });
        }
      }
    }
  });
});

describe("token and actor helpers", () => {
  it("bearerToken reads only a Bearer header", () => {
    expect(bearerToken("Bearer msa_abc")).toBe("msa_abc");
    expect(bearerToken("bearer   msa_abc  ")).toBe("msa_abc");
    expect(bearerToken("Basic dXNlcjpwYXNz")).toBeNull();
    expect(bearerToken("Bearer")).toBeNull();
    expect(bearerToken("Bearer a b")).toBeNull();
    expect(bearerToken(null)).toBeNull();
    expect(bearerToken("")).toBeNull();
  });

  it("hashAgentToken is sha256 hex and agentActor names the agent and its user", () => {
    expect(hashAgentToken("msa_x")).toMatch(/^[0-9a-f]{64}$/);
    expect(hashAgentToken("msa_x")).not.toBe(hashAgentToken("msa_y"));
    expect(agentActor({ agentName: "Casey's agent", userId: "usr_client" })).toBe("agent:Casey's agent for usr_client");
    expect(isAgentActor("agent:Casey's agent for usr_client")).toBe(true);
    expect(isAgentActor("usr_client")).toBe(false);
  });
});

if (!process.env.DATABASE_URL) {
  try { process.loadEnvFile(resolve(__dirname, "../../../.env")); } catch { /* opt-in test */ }
}

describe.skipIf(process.env.MILESTONE_E2E !== "1")("mandate lifecycle against Postgres", () => {
  const db = process.env.MILESTONE_E2E === "1" ? createDb() : (undefined as unknown as ReturnType<typeof createDb>);
  const tag = randomUUID().slice(0, 8);
  const userId = `usr_t_${tag}`;
  const ids: string[] = [];

  beforeAll(async () => {
    await db.insert(users).values({ id: userId, role: "client", name: "t", email: `${tag}@t.test` });
  });
  afterAll(async () => {
    if (process.env.MILESTONE_E2E !== "1") return;
    await db.delete(agentMandates).where(eq(agentMandates.userId, userId));
    await db.delete(users).where(eq(users.id, userId));
    await db.$client.end();
  });

  it("creates a mandate whose token is stored only as its hash, and resolves it (setting last_used_at)", async () => {
    const { mandate, token } = await createMandate(db, { userId, agentName: " t agent ", actions: ["approve", "read", "approve"], approveCapMinor: 500, currency: "USD", expiresAt: later, now });
    ids.push(mandate.id);
    expect(token.startsWith(AGENT_TOKEN_PREFIX)).toBe(true);
    expect(Buffer.from(token.slice(AGENT_TOKEN_PREFIX.length), "base64url")).toHaveLength(32);
    expect(mandate.tokenHash).toBe(hashAgentToken(token));
    expect(mandate.agentName).toBe("t agent");
    expect(mandate.actions).toEqual(["approve", "read"]);
    expect(mandate.lastUsedAt).toBeNull();
    const [raw] = await db.select().from(agentMandates).where(eq(agentMandates.id, mandate.id));
    expect(JSON.stringify(raw)).not.toContain(token);

    const r = await resolveAgentToken(db, token, now);
    expect(r?.mandate.id).toBe(mandate.id);
    expect(r?.user.id).toBe(userId);
    expect(r?.mandate.lastUsedAt?.getTime()).toBe(now.getTime());
    expect(await resolveAgentToken(db, `${token}x`, now)).toBeNull();
    expect(await resolveAgentToken(db, "not-a-token", now)).toBeNull();
    expect(await resolveAgentToken(db, null, now)).toBeNull();
  });

  it("refuses an expired token and a revoked one; revoke is idempotent and scoped to the user", async () => {
    const { mandate, token } = await createMandate(db, { userId, agentName: "t", actions: ["read"], currency: "USD", expiresAt: later, now });
    ids.push(mandate.id);
    expect(mandate.approveCapMinor).toBeNull();
    expect(await authenticateAgent(db, token, later)).toEqual({ ok: false, code: "mandate_expired" });
    expect(await resolveAgentToken(db, token, later)).toBeNull();

    expect(await revokeMandate(db, mandate.id, { userId: "usr_someone_else", now })).toBeNull();
    const revoked = await revokeMandate(db, mandate.id, { userId, now });
    expect(revoked?.revokedAt?.getTime()).toBe(now.getTime());
    const again = await revokeMandate(db, mandate.id, { now: later });
    expect(again?.revokedAt?.getTime()).toBe(now.getTime());
    expect(await authenticateAgent(db, token, now)).toEqual({ ok: false, code: "mandate_revoked" });
    expect(await revokeMandate(db, `mdt_nope_${tag}`)).toBeNull();
  });

  it("rejects invalid input", async () => {
    const base = { userId, agentName: "t", actions: ["read"] as MandateAction[], currency: "USD", expiresAt: later, now };
    await expect(createMandate(db, { ...base, actions: [] })).rejects.toThrow();
    await expect(createMandate(db, { ...base, actions: ["pay" as MandateAction] })).rejects.toThrow();
    await expect(createMandate(db, { ...base, agentName: "  " })).rejects.toThrow();
    await expect(createMandate(db, { ...base, approveCapMinor: 1.5 })).rejects.toThrow();
    await expect(createMandate(db, { ...base, currency: "usd" })).rejects.toThrow();
    await expect(createMandate(db, { ...base, expiresAt: now })).rejects.toThrow();
  });
});

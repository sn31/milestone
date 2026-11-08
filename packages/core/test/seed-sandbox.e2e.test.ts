/**
 * The showcase seed in each PayPal mode, on a database of its own (created, migrated, seeded and dropped here, so the
 * seed's --reset never touches a shared one). Opt in: MILESTONE_E2E=1; DATABASE_URL names the server to use.
 *
 * On the real sandbox (PAYPAL_MODE=sandbox) the signup contract's milestones are drafts to fund through checkout,
 * every other showcase state carries simulator ids only (recorded for the showcase, display only), there is no saved
 * PayPal, receivers come from PAYPAL_FREELANCER_EMAIL / PAYPAL_PARTNER_EMAIL and no release job is queued. Switching
 * modes with --reset-if-other-mode rebuilds the data.
 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { loadRootEnv } from "../src/env.ts";

const run = process.env.MILESTONE_E2E === "1";
if (run && !process.env.DATABASE_URL) loadRootEnv();
const coreDir = fileURLToPath(new URL("..", import.meta.url));
const tsx = fileURLToPath(new URL("../../../node_modules/tsx/dist/cli.mjs", import.meta.url));
const drizzleKit = fileURLToPath(new URL("../node_modules/drizzle-kit/bin.cjs", import.meta.url));

const withDb = (url: string, name: string) => {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
};

describe.skipIf(!run)("showcase seed per PayPal mode", () => {
  const base = process.env.DATABASE_URL ?? "postgres://milestone:milestone@localhost:5432/milestone";
  const name = `milestone_seed_e2e_${randomUUID().slice(0, 8)}`;
  const url = withDb(base, name);
  const admin = new pg.Client({ connectionString: withDb(base, "postgres") });
  let db: pg.Client;
  const q = async <T = Record<string, unknown>>(sql: string): Promise<T[]> => (await db.query(sql)).rows as T[];

  /** Runs a step against the throwaway database; the PayPal mode and receivers come from `env` only. */
  const step = (args: string[], env: Record<string, string>) => {
    const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(PAYPAL_|SPIKE_|SANDBOX_|DEMO_)/.test(k)));
    const r = spawnSync(process.execPath, args, { cwd: coreDir, env: { ...clean, DATABASE_URL: url, ...env }, encoding: "utf8", timeout: 120_000 });
    if (r.status !== 0) throw new Error(`${args.slice(1).join(" ")} failed: ${r.stdout}\n${r.stderr}`);
    return r.stdout;
  };
  const sandboxEnv = { PAYPAL_MODE: "sandbox", PAYPAL_CLIENT_ID: "x", PAYPAL_CLIENT_SECRET: "x", PAYPAL_FREELANCER_EMAIL: "sb-freelancer@personal.example.com", PAYPAL_PARTNER_EMAIL: "sb-partner@business.example.com" };
  const seed = (env: Record<string, string>, ...flags: string[]) => step([tsx, "src/seed.ts", ...flags], env);

  beforeAll(async () => {
    await admin.connect();
    await admin.query(`create database ${name}`);
    step([drizzleKit, "migrate"], {});
    db = new pg.Client({ connectionString: url });
    await db.connect();
  }, 120_000);

  afterAll(async () => {
    await db?.end().catch(() => {});
    await admin.query(`drop database if exists ${name} with (force)`).catch(() => {});
    await admin.end().catch(() => {});
  });

  it("sandbox: live drafts, recorded showcase rows only with simulator ids, real receivers, no saved PayPal", async () => {
    const out = seed(sandboxEnv, "--reset", "--showcase");
    expect(out).toMatch(/PAYPAL_MODE=sandbox/);
    const ms = Object.fromEntries((await q<{ id: string; status: string; paypal_order_id: string | null; paypal_capture_id: string | null }>("select id, status, paypal_order_id, paypal_capture_id from milestones")).map((m) => [m.id, m]));
    for (const id of ["mst_1", "mst_2", "mst_3"]) {
      expect(ms[id], id).toMatchObject({ status: "draft", paypal_order_id: null, paypal_capture_id: null });
    }
    expect(ms.mst_brand_1!.status).toBe("needs_client");
    expect(ms.mst_brand_2!.status).toBe("held");
    expect(ms.mst_dash_1!.status).toBe("funded");
    // Every PayPal id written for the showcase is a simulator id, on a recorded milestone only.
    for (const id of ["mst_brand_1", "mst_brand_2", "mst_dash_1"]) expect(ms[id]!.paypal_capture_id, id).toMatch(/^SIM-/);
    const opIds = await q<{ key: string; paypal_id: string | null }>("select key, paypal_id from paypal_ops");
    expect(opIds.length).toBeGreaterThan(0);
    for (const o of opIds) expect(o.paypal_id ?? "SIM-", o.key).toMatch(/^SIM-/);
    expect(opIds.map((o) => o.key).filter((k) => ["mst_1", "mst_2", "mst_3", "adv_show_open", "adv_show_repaid"].includes(k))).toEqual([]);
    expect(await q("select id from advances")).toEqual([{ id: "adv_show_open2" }]);
    expect(await q("select id from payment_methods")).toEqual([]);
    const receivers = Object.fromEntries((await q<{ id: string; paypal_email: string | null }>("select id, paypal_email from users")).map((u) => [u.id, u.paypal_email]));
    expect(receivers.usr_freelancer).toBe("sb-freelancer@personal.example.com");
    expect(receivers.usr_partner).toBe("sb-partner@business.example.com");
    // No release job is waiting on a showcase milestone (pg-boss keeps its jobs in the pgboss schema).
    const jobs = await q<{ n: number }>("select count(*)::int as n from pgboss.job where name = 'release' and state in ('created', 'retry')").catch(() => [{ n: 0 }]);
    expect(jobs[0]!.n).toBe(0);
    // The ledger still balances: every transaction sums to zero.
    const unbalanced = await q("select txn_id from ledger_entries group by txn_id having sum(case when direction = 'debit' then amount_minor else -amount_minor end) <> 0");
    expect(unbalanced).toEqual([]);
  }, 120_000);

  it("--reset-if-other-mode: a simulated showcase is rebuilt for the sandbox, a sandbox one is left alone", async () => {
    seed({ PAYPAL_MODE: "simulated" }, "--reset", "--showcase");
    expect((await q<{ status: string }>("select status from milestones where id = 'mst_3'"))[0]!.status).toBe("released");
    expect((await q("select id from payment_methods")).length).toBe(1);

    const switched = seed(sandboxEnv, "--showcase", "--if-empty", "--reset-if-other-mode");
    expect(switched).toMatch(/resetting it and seeding the sandbox showcase/);
    expect((await q<{ status: string }>("select status from milestones where id = 'mst_3'"))[0]!.status).toBe("draft");
    expect(await q("select id from payment_methods")).toEqual([]);

    // Same mode again: --if-empty leaves it as it is (a visitor's data survives a redeploy).
    await db.query("update milestones set title = 'kept' where id = 'mst_dash_2'");
    const again = seed(sandboxEnv, "--showcase", "--if-empty", "--reset-if-other-mode");
    expect(again).toMatch(/seed skipped: --if-empty/);
    expect((await q<{ title: string }>("select title from milestones where id = 'mst_dash_2'"))[0]!.title).toBe("kept");

    // A milestone funded through the real sandbox, then a switch back to simulated: rebuilt for the simulator.
    await db.query("update milestones set status = 'funded', paypal_order_id = '5O190127TN364715T', paypal_capture_id = '3C679366HH908993F' where id = 'mst_1'");
    const back = seed({ PAYPAL_MODE: "simulated" }, "--showcase", "--if-empty", "--reset-if-other-mode");
    expect(back).toMatch(/resetting it and seeding the simulated showcase/);
    expect((await q<{ paypal_capture_id: string }>("select paypal_capture_id from milestones where id = 'mst_1'"))[0]!.paypal_capture_id).toMatch(/^SIM-/);
  }, 180_000);
});

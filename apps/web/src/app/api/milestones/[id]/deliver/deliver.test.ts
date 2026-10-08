/**
 * Manual delivery: ref resolution against a throwaway local repo (always), and the route against the local Postgres
 * (opt in: MILESTONE_E2E=1). enqueue and the session are mocked; rows are removed afterwards.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ actor: { userId: "usr_freelancer", role: "freelancer" }, enqueued: [] as unknown[], db: null as unknown }));
vi.mock("@/lib/session", async (orig) => ({ ...(await orig<typeof import("@/lib/session")>()), getActor: async () => state.actor }));
vi.mock("@/lib/paypal", () => ({ paypal: () => { throw new Error("no PayPal in this test"); } }));
vi.mock("@/lib/db", () => ({ getDb: () => state.db }));
vi.mock("@milestone/core", async (orig) => ({
  ...(await orig<typeof import("@milestone/core")>()),
  enqueue: async (...args: unknown[]) => { state.enqueued.push(args); return "job"; },
}));

import { commitDeliveryId, normaliseRepoUrl, pickSha, resolveRef, validRef } from "./resolve";

let repo: string;
let main: string;
let feature: string;

beforeAll(async () => {
  repo = await mkdtemp(join(tmpdir(), "milestone-deliver-test-"));
  const g = (...a: string[]) => execFileSync("git", ["-c", "user.email=t@test", "-c", "user.name=t", ...a], { cwd: repo }).toString().trim();
  await writeFile(join(repo, "README.md"), "# t\n");
  g("init", "-q", "-b", "main"); g("add", "."); g("commit", "-qm", "init");
  main = g("rev-parse", "HEAD");
  g("checkout", "-qb", "m1-feature");
  await writeFile(join(repo, "a.txt"), "a\n");
  g("add", "."); g("commit", "-qm", "feature");
  feature = g("rev-parse", "HEAD");
  g("tag", "-a", "v1", "-m", "v1");
  g("checkout", "-q", "main");
});
afterAll(async () => { if (repo) await rm(repo, { recursive: true, force: true }); });

describe("manual delivery ref resolution", () => {
  it("accepts https, file URLs and absolute paths only", () => {
    expect(normaliseRepoUrl("https://github.com/a/b.git")).toBe("https://github.com/a/b.git");
    expect(normaliseRepoUrl("/tmp/repo")).toBe("file:///tmp/repo");
    expect(normaliseRepoUrl("file:///tmp/repo")).toBe("file:///tmp/repo");
    for (const bad of ["ext::sh -c touch% /tmp/x", "git@github.com:a/b.git", "ssh://h/r", "http://h/r", "relative/path", "-uhelp", "https://user:pw@h/r"]) {
      expect(normaliseRepoUrl(bad)).toBeNull();
    }
  });
  it("validates refs", () => {
    expect(validRef("main")).toBe(true);
    expect(validRef("feature/x-1")).toBe(true);
    expect(validRef("a".repeat(40))).toBe(true);
    expect(validRef("--upload-pack=x")).toBe(false);
    expect(validRef("main..other")).toBe(false);
    expect(validRef("main~1")).toBe(false);
  });
  it("prefers the exact name, then branches, then peeled tags", () => {
    const out = `${"1".repeat(40)}\trefs/heads/v1\n${"2".repeat(40)}\trefs/tags/v1\n${"3".repeat(40)}\trefs/tags/v1^{}\n`;
    expect(pickSha(out, "v1")).toBe("1".repeat(40));
    expect(pickSha(out.split("\n").slice(1).join("\n"), "v1")).toBe("3".repeat(40));
    expect(pickSha(out, "nope")).toBeNull();
  });
  it("resolves branches, tags and HEAD in a local repo with git ls-remote", async () => {
    expect(await resolveRef(pathToFileURL(repo).href, "main")).toEqual({ ok: true, sha: main });
    expect(await resolveRef(pathToFileURL(repo).href, "m1-feature")).toEqual({ ok: true, sha: feature });
    expect(await resolveRef(pathToFileURL(repo).href, "v1")).toEqual({ ok: true, sha: feature });
    expect(await resolveRef(pathToFileURL(repo).href, "HEAD")).toEqual({ ok: true, sha: main });
    expect((await resolveRef(pathToFileURL(repo).href, "missing")).ok).toBe(false);
    expect((await resolveRef(pathToFileURL(join(repo, "nope")).href, "main")).ok).toBe(false);
  });
});

const e2e = process.env.MILESTONE_E2E === "1";
try { process.loadEnvFile(new URL("../../../../../../../../.env", import.meta.url).pathname); } catch { /* env already set */ }

describe.skipIf(!e2e)("POST /api/milestones/[id]/deliver against Postgres", async () => {
  const core = await import("@milestone/core");
  const { eq, inArray } = await import("drizzle-orm");
  const db = core.createDb();
  state.db = db;
  const { POST } = await import("./route");
  const tag = randomUUID().slice(0, 8);
  const contractId = `ctr_dlv_${tag}`;
  const milestoneId = `mst_dlv_${tag}`;

  beforeAll(async () => {
    await db.insert(core.contracts).values({ id: contractId, clientId: "usr_client", freelancerId: "usr_freelancer", title: "t", scopeText: "t", currency: "USD", totalMinor: 100, status: "active" });
    await db.insert(core.milestones).values({ id: milestoneId, contractId, seq: 1, title: "m", amountMinor: 100, status: "funded", baselineSha: main });
  });
  afterAll(async () => {
    await db.delete(core.auditLog).where(eq(core.auditLog.contractId, contractId));
    await db.delete(core.deliveries).where(inArray(core.deliveries.milestoneId, [milestoneId]));
    await db.delete(core.milestones).where(eq(core.milestones.id, milestoneId));
    await db.delete(core.contracts).where(eq(core.contracts.id, contractId));
  });

  const call = (body: unknown) => POST(new Request("http://x/api", { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }), { params: Promise.resolve({ id: milestoneId }) });

  it("refuses the client and bad input, then records a manual delivery in the webhook's shape and enqueues verify", async () => {
    state.actor = { userId: "usr_client", role: "client" };
    expect((await call({ repoUrl: repo, ref: "main" })).status).toBe(403);
    state.actor = { userId: "usr_freelancer", role: "freelancer" };
    expect((await call({ repoUrl: "ext::sh", ref: "main" })).status).toBe(400);
    expect((await call({ repoUrl: repo, ref: "missing" })).status).toBe(422);

    const res = await call({ repoUrl: repo, ref: "m1-feature" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deliveryId: string; sha: string };
    expect(body.sha).toBe(feature);
    expect(body.deliveryId).toBe(commitDeliveryId(milestoneId, feature));
    const row = await db.query.deliveries.findFirst({ where: (d, o) => o.eq(d.id, body.deliveryId) });
    expect(row?.source).toBe("manual");
    expect(row?.payload).toMatchObject({ sha: feature, branch: "m1-feature", clone_url: pathToFileURL(repo).href, base_sha: main, title: "Manual delivery of m1-feature" });
    expect(state.enqueued.at(-1)).toEqual(["verify", milestoneId, { deliveryId: body.deliveryId }, { dedupe: feature }]);

    const again = (await (await call({ repoUrl: repo, ref: "m1-feature" })).json()) as { duplicate: boolean };
    expect(again.duplicate).toBe(true);
  });

  it("refuses a milestone that is not funded or held", async () => {
    await db.update(core.milestones).set({ status: "review" }).where(eq(core.milestones.id, milestoneId));
    expect((await call({ repoUrl: repo, ref: "main" })).status).toBe(409);
  });
});

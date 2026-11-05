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

import { LOCAL_REPO_REFUSED, checkRepoUrl, commitDeliveryId, localReposAllowed, normaliseRepoUrl, pickSha, pickTipSha, resolveRef, validRef } from "./resolve";

let repo: string;
let main: string;
let feature: string;
let stranger: string;

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
  // A stranger's pull request: served by the repository as refs/pull/1/head, but on no branch or tag.
  g("checkout", "-q", "--detach", "main");
  await writeFile(join(repo, "evil.txt"), "x\n");
  g("add", "."); g("commit", "-qm", "stranger");
  stranger = g("rev-parse", "HEAD");
  g("update-ref", "refs/pull/1/head", stranger);
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
  it("allows local repositories only with MILESTONE_ALLOW_LOCAL_REPOS=1 or simulated PayPal outside production", () => {
    expect(localReposAllowed({ MILESTONE_ALLOW_LOCAL_REPOS: "1", NODE_ENV: "production", PAYPAL_MODE: "sandbox" })).toBe(true);
    expect(localReposAllowed({ NODE_ENV: "development", PAYPAL_MODE: "simulated" })).toBe(true);
    expect(localReposAllowed({ NODE_ENV: "test", PAYPAL_CLIENT_ID: "" })).toBe(true); // simulated by default without credentials
    expect(localReposAllowed({ NODE_ENV: "production", PAYPAL_MODE: "simulated" })).toBe(false);
    expect(localReposAllowed({ NODE_ENV: "development", PAYPAL_MODE: "sandbox" })).toBe(false);
    expect(localReposAllowed({ NODE_ENV: "production", PAYPAL_CLIENT_ID: "x" })).toBe(false);
    expect(localReposAllowed({ MILESTONE_ALLOW_LOCAL_REPOS: "0", NODE_ENV: "development", PAYPAL_MODE: "sandbox" })).toBe(false);
  });
  it("gates file:// and absolute paths, never https", () => {
    const closed: NodeJS.ProcessEnv = { NODE_ENV: "production", PAYPAL_MODE: "sandbox" };
    const open: NodeJS.ProcessEnv = { NODE_ENV: "production", MILESTONE_ALLOW_LOCAL_REPOS: "1" };
    expect(checkRepoUrl("https://github.com/a/b.git", closed)).toEqual({ ok: true, url: "https://github.com/a/b.git" });
    expect(checkRepoUrl("/tmp/repo", closed)).toEqual({ ok: false, reason: LOCAL_REPO_REFUSED });
    expect(checkRepoUrl("file:///tmp/repo", closed)).toEqual({ ok: false, reason: LOCAL_REPO_REFUSED });
    expect(checkRepoUrl("/tmp/repo", open)).toEqual({ ok: true, url: "file:///tmp/repo" });
    expect(checkRepoUrl("file:///tmp/repo", open)).toEqual({ ok: true, url: "file:///tmp/repo" });
    for (const bad of ["ext::sh -c touch% /tmp/x", "git@github.com:a/b.git", "ssh://h/r", "https://user:pw@h/r", ""]) {
      const r = checkRepoUrl(bad, open);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).not.toBe(LOCAL_REPO_REFUSED);
    }
  });
  it("never allows local repositories with DEMO_MODE=1, even with MILESTONE_ALLOW_LOCAL_REPOS=1", () => {
    expect(localReposAllowed({ DEMO_MODE: "1", MILESTONE_ALLOW_LOCAL_REPOS: "1", NODE_ENV: "development", PAYPAL_MODE: "simulated" })).toBe(false);
    expect(checkRepoUrl("/tmp/repo", { NODE_ENV: "development", DEMO_MODE: "1", MILESTONE_ALLOW_LOCAL_REPOS: "1" })).toEqual({ ok: false, reason: LOCAL_REPO_REFUSED });
    expect(checkRepoUrl("https://github.com/a/b.git", { NODE_ENV: "production", DEMO_MODE: "1" })).toEqual({ ok: true, url: "https://github.com/a/b.git" });
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
  it("pickTipSha takes only branch, tag and HEAD names, and a commit id only when it is one of their tips", () => {
    const [a, b, c] = ["a", "b", "c"].map((x) => x.repeat(40)) as [string, string, string];
    const out = `${a}\tHEAD\n${a}\trefs/heads/main\n${b}\trefs/tags/v1^{}\n${c}\trefs/pull/1/head\n${c}\trefs/pull/1/merge\n`;
    expect(pickTipSha(out, "main")).toBe(a);
    expect(pickTipSha(out, "HEAD")).toBe(a);
    expect(pickTipSha(out, "v1")).toBe(b);
    expect(pickTipSha(out, a)).toBe(a);
    expect(pickTipSha(out, b)).toBe(b);
    expect(pickTipSha(out, "refs/pull/1/head")).toBeNull();
    expect(pickTipSha(out, "refs/pull/1/merge")).toBeNull();
    expect(pickTipSha(out, "pull/1/head")).toBeNull();
    expect(pickTipSha(out, c)).toBeNull();
    expect(pickSha(out, "refs/pull/1/head")).toBe(c); // without tipsOnly (outside DEMO_MODE) unchanged
  });
  it("tipsOnly (DEMO_MODE) refuses a pull request's head and a commit on no branch or tag, by name or by id", async () => {
    const url = pathToFileURL(repo).href;
    expect(await resolveRef(url, "main", { tipsOnly: true })).toEqual({ ok: true, sha: main });
    expect(await resolveRef(url, "v1", { tipsOnly: true })).toEqual({ ok: true, sha: feature });
    expect(await resolveRef(url, "HEAD", { tipsOnly: true })).toEqual({ ok: true, sha: main });
    expect(await resolveRef(url, feature, { tipsOnly: true })).toEqual({ ok: true, sha: feature });
    for (const ref of ["refs/pull/1/head", "pull/1/head", stranger]) {
      const r = await resolveRef(url, ref, { tipsOnly: true });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/not a branch, tag or HEAD/);
    }
    // Outside DEMO_MODE the old behaviour stands.
    expect(await resolveRef(url, "refs/pull/1/head")).toEqual({ ok: true, sha: stranger });
    expect(await resolveRef(url, stranger)).toEqual({ ok: true, sha: stranger });
  });
});

const e2e = process.env.MILESTONE_E2E === "1";
try { process.loadEnvFile(new URL("../../../../../../../../.env", import.meta.url).pathname); } catch { /* env already set */ }

describe.skipIf(!e2e)("POST /api/milestones/[id]/deliver against Postgres", async () => {
  // The route is exercised with a local repository, which the gate refuses unless this flag (or simulated PayPal) is set.
  process.env.MILESTONE_ALLOW_LOCAL_REPOS = "1";
  const core = await import("@milestone/core");
  const { eq, inArray } = await import("drizzle-orm");
  const db = e2e ? core.createDb() : (undefined as unknown as ReturnType<typeof core.createDb>); // the suite body is collected even when skipped
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
    const savedMode = process.env.PAYPAL_MODE;
    process.env.MILESTONE_ALLOW_LOCAL_REPOS = "0";
    process.env.PAYPAL_MODE = "sandbox";
    const refused = await call({ repoUrl: repo, ref: "main" });
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: string }).error).toBe("local repositories are not accepted");
    process.env.MILESTONE_ALLOW_LOCAL_REPOS = "1";
    if (savedMode === undefined) delete process.env.PAYPAL_MODE; else process.env.PAYPAL_MODE = savedMode;
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

  it("with DEMO_MODE=1 refuses any repository but DEMO_REPO_URL with 403 and an audit row, before ls-remote or a job", async () => {
    const saved = { mode: process.env.DEMO_MODE, url: process.env.DEMO_REPO_URL };
    const restore = () => {
      if (saved.mode === undefined) delete process.env.DEMO_MODE; else process.env.DEMO_MODE = saved.mode;
      if (saved.url === undefined) delete process.env.DEMO_REPO_URL; else process.env.DEMO_REPO_URL = saved.url;
    };
    const enqueuedBefore = state.enqueued.length;
    const deliveriesBefore = (await db.select().from(core.deliveries).where(eq(core.deliveries.milestoneId, milestoneId))).length;
    try {
      process.env.DEMO_MODE = "1";
      process.env.DEMO_REPO_URL = "https://github.com/milestone-demo/landing.git";
      // A local checkout (even with MILESTONE_ALLOW_LOCAL_REPOS=1), another https repository, and look-alikes.
      for (const repoUrl of [repo, pathToFileURL(repo).href, "https://github.com/someone/else.git", "https://github.com/milestone-demo/landing/../../someone/else", "https://x@github.com/milestone-demo/landing", "https://github.com:443/milestone-demo/landing"]) {
        const res = await call({ repoUrl, ref: "main" });
        expect(res.status, repoUrl).toBe(403);
        const body = (await res.json()) as { error: string; reason: string };
        expect(body.reason).toBe("demo_repo_only");
        expect(body.error).toContain("only accepts code deliveries from https://github.com/milestone-demo/landing");
      }
      // Fail closed: DEMO_MODE=1 without DEMO_REPO_URL refuses every code delivery.
      delete process.env.DEMO_REPO_URL;
      const closed = await call({ repoUrl: "https://github.com/milestone-demo/landing.git", ref: "main" });
      expect(closed.status).toBe(403);
      expect(((await closed.json()) as { error: string }).error).toContain("DEMO_REPO_URL is not set");
    } finally {
      restore();
    }
    expect(state.enqueued.length).toBe(enqueuedBefore);
    expect(await db.select().from(core.deliveries).where(eq(core.deliveries.milestoneId, milestoneId))).toHaveLength(deliveriesBefore);
    const refusals = await db.select().from(core.auditLog).where(eq(core.auditLog.milestoneId, milestoneId));
    const rows = refusals.filter((r) => r.event === core.AUDIT_EVENTS.deliveryRefused);
    expect(rows).toHaveLength(7);
    expect(rows.every((r) => r.actor === "usr_freelancer" && (r.detail as { source?: string }).source === "manual")).toBe(true);
  });

  it("refuses a milestone that is not funded or held", async () => {
    await db.update(core.milestones).set({ status: "review" }).where(eq(core.milestones.id, milestoneId));
    expect((await call({ repoUrl: repo, ref: "main" })).status).toBe(409);
  });
});

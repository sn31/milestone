/**
 * POST /api/webhooks/github against recorded-shape fixtures. The signature test always runs; the rest need the local
 * Postgres (MILESTONE_E2E=1). enqueue is mocked; the throwaway contract, milestone and rows are removed afterwards.
 */
import { createHmac, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { e2e, fixture, loadRootEnv } from "./helpers";

loadRootEnv();
const state = vi.hoisted(() => ({ enqueued: [] as unknown[][], db: null as unknown }));
vi.mock("@/lib/db", () => ({ getDb: () => state.db }));
vi.mock("@milestone/core", async (orig) => ({
  ...(await orig<typeof import("@milestone/core")>()),
  enqueue: async (...args: unknown[]) => { state.enqueued.push(args); return "job"; },
}));

import * as core from "@milestone/core";
import { eq, inArray } from "drizzle-orm";
import { POST } from "../src/app/api/webhooks/github/route";

const SECRET = "test-github-secret";
const sign = (raw: string, secret = SECRET) => "sha256=" + createHmac("sha256", secret).update(raw).digest("hex");

function request(body: unknown, opts: { delivery: string; event?: string; signature?: string | null }) {
  const raw = JSON.stringify(body);
  const headers: Record<string, string> = { "content-type": "application/json", "x-github-event": opts.event ?? "pull_request", "x-github-delivery": opts.delivery };
  if (opts.signature !== null) headers["x-hub-signature-256"] = opts.signature ?? sign(raw);
  return new Request("http://localhost/api/webhooks/github", { method: "POST", headers, body: raw });
}

beforeAll(() => { process.env.GITHUB_WEBHOOK_SECRET = SECRET; });

describe("github webhook signature", () => {
  it("rejects a wrong or missing signature with 400 before touching the database", async () => {
    const body = fixture("github-pr-merged.json");
    expect((await POST(request(body, { delivery: "d1", signature: sign(JSON.stringify(body), "other-secret") }))).status).toBe(400);
    expect((await POST(request(body, { delivery: "d2", signature: null }))).status).toBe(400);
    expect((await POST(request(body, { delivery: "d3", signature: "sha256=abc" }))).status).toBe(400);
    expect(state.enqueued).toHaveLength(0);
  });
  it("fixtures have the pull_request shape the route reads", () => {
    const merged = fixture("github-pr-merged.json");
    expect(merged).toMatchObject({ action: "closed", number: 7, pull_request: { merged: true, head: { ref: "m1-pass" } }, repository: { full_name: "milestone-demo/landing" } });
    expect(merged.pull_request.merge_commit_sha).toMatch(/^[0-9a-f]{40}$/);
    expect(merged.pull_request.base.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(merged.repository.clone_url).toBe("https://github.com/milestone-demo/landing.git");
    expect(fixture("github-pr-closed-unmerged.json").pull_request).toMatchObject({ merged: false, merge_commit_sha: null });
  });
});

describe.skipIf(!e2e)("github webhook against Postgres", () => {
  const db = e2e ? core.createDb() : (null as never);
  const tag = randomUUID().slice(0, 8);
  const repo = `milestone-demo/landing-${tag}`;
  const contractId = `ctr_t_${tag}`;
  const milestoneId = `mst_t_${tag}`;
  const deliveryIds: string[] = [];
  const delivery = () => { const d = `gh-${tag}-${deliveryIds.length}`; deliveryIds.push(d); return d; };
  /** The fixture, pointed at the throwaway repository so seeded contracts cannot match. */
  const withRepo = (name: string) => {
    const p = fixture(name);
    p.repository.full_name = repo;
    return p;
  };

  beforeAll(async () => {
    state.db = db;
    await db.insert(core.contracts).values({ id: contractId, clientId: "usr_client", freelancerId: "usr_freelancer", title: "t", scopeText: "t", currency: "USD", totalMinor: 100, status: "active", repoFullName: repo });
    await db.insert(core.milestones).values({ id: milestoneId, contractId, seq: 1, title: "m1", amountMinor: 100, status: "funded" });
  });
  beforeEach(() => { state.enqueued.length = 0; });
  afterAll(async () => {
    if (!e2e) return;
    await db.delete(core.deliveries).where(eq(core.deliveries.milestoneId, milestoneId));
    await db.delete(core.milestones).where(eq(core.milestones.id, milestoneId));
    await db.delete(core.contracts).where(eq(core.contracts.id, contractId));
    await db.delete(core.webhookEvents).where(inArray(core.webhookEvents.eventId, deliveryIds));
  });

  it("merged PR -> delivery row + verify job; redelivery -> duplicate", async () => {
    const body = withRepo("github-pr-merged.json");
    const id = delivery();
    const res = await POST(request(body, { delivery: id }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({ ok: true, milestoneId });
    const rows = await db.select().from(core.deliveries).where(eq(core.deliveries.milestoneId, milestoneId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: "github_pr", ref: `${repo}#7` });
    expect(rows[0]!.payload).toMatchObject({ sha: body.pull_request.merge_commit_sha, branch: "m1-pass", base_sha: body.pull_request.base.sha, clone_url: body.repository.clone_url, pr_number: 7 });
    expect(state.enqueued).toHaveLength(1);
    expect(state.enqueued[0]).toEqual(["verify", milestoneId, { deliveryId: json.deliveryId }, { dedupe: body.pull_request.merge_commit_sha }]);

    const again = await POST(request(body, { delivery: id }));
    expect(await again.json()).toEqual({ duplicate: true });
    expect(state.enqueued).toHaveLength(1);
  });

  it("a new webhook delivery of the same merge commit creates no second delivery row", async () => {
    const res = await POST(request(withRepo("github-pr-merged.json"), { delivery: delivery() }));
    expect((await res.json()).ok).toBe(true);
    expect(await db.select().from(core.deliveries).where(eq(core.deliveries.milestoneId, milestoneId))).toHaveLength(1);
  });

  it("closed without merge -> ignored, nothing enqueued", async () => {
    const res = await POST(request(withRepo("github-pr-closed-unmerged.json"), { delivery: delivery() }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ignored: true });
    expect(state.enqueued).toHaveLength(0);
  });

  it("a repository no contract knows -> ignored", async () => {
    const body = fixture("github-pr-merged.json");
    body.repository.full_name = `nobody/${tag}`;
    expect(await (await POST(request(body, { delivery: delivery() }))).json()).toEqual({ ignored: true });
    expect(state.enqueued).toHaveLength(0);
  });
});

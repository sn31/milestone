/**
 * File delivery: name sanitising and storage (always), and the upload + file-serving routes against the local
 * Postgres (opt in: MILESTONE_E2E=1). enqueue and the session are mocked; rows and files are removed afterwards.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ actor: { userId: "usr_freelancer", role: "freelancer" }, enqueued: [] as unknown[], db: null as unknown }));
vi.mock("@/lib/session", async (orig) => ({ ...(await orig<typeof import("@/lib/session")>()), getActor: async () => state.actor }));
vi.mock("@/lib/paypal", () => ({ paypal: () => { throw new Error("no PayPal in this test"); } }));
vi.mock("@/lib/db", () => ({ getDb: () => state.db }));
vi.mock("@milestone/core", async (orig) => ({
  ...(await orig<typeof import("@milestone/core")>()),
  enqueue: async (...args: unknown[]) => { state.enqueued.push(args); return "job"; },
}));

import { checkFiles, createUploadUsage, DEFAULT_UPLOAD_BUDGET_BYTES, dirBytes, MAX_FILE_BYTES, overBudget, safeName, storeFiles, uploadBudgetBytes } from "./store";

let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "milestone-upload-test-"));
  process.env.UPLOAD_DIR = root;
});
afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000004000000002008000000", "hex");

describe("upload storage", () => {
  it("keeps names to safe basenames, unique within a delivery", () => {
    const taken = new Set<string>();
    expect(safeName("../../etc/passwd", taken)).toBe("passwd");
    expect(safeName("C:\\x\\logo.png", taken)).toBe("logo.png");
    expect(safeName("logo.png", taken)).toBe("logo-2.png");
    expect(safeName(".env", taken)).toBe("env");
    expect(safeName("..", taken)).toBe("file");
    expect(safeName("a<b>|c.md", taken)).toBe("a_b__c.md");
  });
  it("refuses empty, too many and too large uploads", () => {
    expect(checkFiles([])).toMatch(/no files/);
    expect(checkFiles(Array.from({ length: 11 }, (_, i) => ({ name: `${i}`, bytes: new Uint8Array(1) })))).toMatch(/at most 10/);
    expect(checkFiles([{ name: "big", bytes: new Uint8Array(MAX_FILE_BYTES + 1) }])).toMatch(/larger than 20 MB/);
    expect(checkFiles([{ name: "e", bytes: new Uint8Array(0) }])).toMatch(/empty/);
  });
  it("stores files with sha256 and a sniffed mime type", async () => {
    const stored = await storeFiles("dlv_up_unit", [{ name: "logo.png", bytes: PNG }, { name: "notes.md", bytes: Buffer.from("# hi") }], root);
    expect(stored[0]).toMatchObject({ name: "logo.png", size: PNG.length, path: "dlv_up_unit/logo.png", mime: "image/png", sha256: createHash("sha256").update(PNG).digest("hex") });
    expect(stored[1]!.mime).toMatch(/^text\/markdown/);
    expect(await readFile(join(root, "dlv_up_unit", "logo.png"))).toEqual(PNG);
  });
});

describe("upload budget", () => {
  it("reads MILESTONE_UPLOAD_BUDGET_BYTES, falling back to 500 MB", () => {
    expect(DEFAULT_UPLOAD_BUDGET_BYTES).toBe(500 * 1024 * 1024);
    expect(uploadBudgetBytes(undefined)).toBe(DEFAULT_UPLOAD_BUDGET_BYTES);
    for (const bad of ["", " ", "0", "-5", "lots"]) expect(uploadBudgetBytes(bad)).toBe(DEFAULT_UPLOAD_BUDGET_BYTES);
    expect(uploadBudgetBytes("1048576")).toBe(1_048_576);
  });

  it("refuses only what would go past the budget", () => {
    expect(overBudget(90, 10, 100)).toBe(false);
    expect(overBudget(90, 11, 100)).toBe(true);
    expect(overBudget(101, 0, 100)).toBe(true);
    expect(overBudget(50, -1, 100)).toBe(false);
  });

  it("sums file sizes recursively; a missing directory is 0", async () => {
    const dir = await mkdtemp(join(tmpdir(), "milestone-budget-"));
    try {
      await mkdir(join(dir, "dlv_a", "nested"), { recursive: true });
      await writeFile(join(dir, "dlv_a", "a.bin"), new Uint8Array(100));
      await writeFile(join(dir, "dlv_a", "nested", "b.bin"), new Uint8Array(23));
      await writeFile(join(dir, "c.bin"), new Uint8Array(7));
      expect(await dirBytes(dir)).toBe(130);
      expect(await dirBytes(join(dir, "missing"))).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("measures once per window, counts what was added since, and measures again after it", async () => {
    let size = 1000;
    const measure = vi.fn(async () => size);
    const usage = createUploadUsage(30_000, measure);
    expect(await usage.bytes("/u", 0)).toBe(1000);
    usage.add(50);
    size = 9999;
    expect(await usage.bytes("/u", 29_999)).toBe(1050);
    expect(measure).toHaveBeenCalledTimes(1);
    expect(await usage.bytes("/u", 30_000)).toBe(9999);
    expect(measure).toHaveBeenCalledTimes(2);
    expect(await usage.bytes("/other", 30_001)).toBe(9999);
    expect(measure).toHaveBeenCalledTimes(3);
  });

  it("forgets a failed measurement so the next call tries again", async () => {
    const measure = vi.fn().mockRejectedValueOnce(new Error("EIO")).mockResolvedValue(5);
    const usage = createUploadUsage(30_000, measure);
    await expect(usage.bytes("/u", 0)).rejects.toThrow("EIO");
    expect(await usage.bytes("/u", 1)).toBe(5);
  });
});

const e2e = process.env.MILESTONE_E2E === "1";
try { process.loadEnvFile(new URL("../../../../../../../../.env", import.meta.url).pathname); } catch { /* env already set */ }

describe.skipIf(!e2e)("upload and file routes against Postgres", async () => {
  const core = await import("@milestone/core");
  const { eq } = await import("drizzle-orm");
  const db = e2e ? core.createDb() : (undefined as unknown as ReturnType<typeof core.createDb>); // the suite body is collected even when skipped
  state.db = db;
  const { POST } = await import("./route");
  const { GET } = await import("../../../files/[deliveryId]/[name]/route");
  const tag = randomUUID().slice(0, 8);
  const contractId = `ctr_upl_${tag}`;
  const milestoneId = `mst_upl_${tag}`;

  beforeAll(async () => {
    await db.insert(core.contracts).values({ id: contractId, clientId: "usr_client", freelancerId: "usr_freelancer", title: "t", scopeText: "t", currency: "USD", totalMinor: 100, status: "active" });
    await db.insert(core.milestones).values({ id: milestoneId, contractId, seq: 1, title: "m", amountMinor: 100, status: "funded" });
  });
  afterAll(async () => {
    await db.delete(core.auditLog).where(eq(core.auditLog.contractId, contractId));
    await db.delete(core.deliveries).where(eq(core.deliveries.milestoneId, milestoneId));
    await db.delete(core.milestones).where(eq(core.milestones.id, milestoneId));
    await db.delete(core.contracts).where(eq(core.contracts.id, contractId));
  });

  const upload = (files: Array<[string, Buffer]>) => {
    const form = new FormData();
    for (const [name, bytes] of files) form.append("files", new File([new Uint8Array(bytes)], name));
    return POST(new Request("http://x/api", { method: "POST", body: form }), { params: Promise.resolve({ id: milestoneId }) });
  };
  const get = (deliveryId: string, name: string) => GET(new Request("http://x/api"), { params: Promise.resolve({ deliveryId, name }) });

  it("stores an upload delivery, enqueues verify, and serves the files only to the parties", async () => {
    state.actor = { userId: "usr_client", role: "client" };
    expect((await upload([["logo.png", PNG]])).status).toBe(403);
    state.actor = { userId: "usr_freelancer", role: "freelancer" };
    expect((await upload([])).status).toBe(400);

    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const res = await upload([["logo.png", PNG], ["logo.svg", svg]]);
    expect(res.status).toBe(200);
    const { deliveryId } = (await res.json()) as { deliveryId: string };
    const row = await db.query.deliveries.findFirst({ where: (d, o) => o.eq(d.id, deliveryId) });
    expect(row?.source).toBe("upload");
    expect(core.UploadPayload.parse(row?.payload).files.map((f) => f.path)).toEqual([`${deliveryId}/logo.png`, `${deliveryId}/logo.svg`]);
    expect(state.enqueued.at(-1)).toEqual(["verify", milestoneId, { deliveryId }, { dedupe: deliveryId }]);

    const png = await get(deliveryId, "logo.png");
    expect(png.status).toBe(200);
    expect(png.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await png.arrayBuffer())).toEqual(PNG);
    const s = await get(deliveryId, "logo.svg");
    expect(s.headers.get("content-security-policy")).toMatch(/sandbox/);
    expect(s.headers.get("x-content-type-options")).toBe("nosniff");
    expect((await get(deliveryId, "../../etc/passwd")).status).toBe(404);
    expect((await get(deliveryId, "missing.png")).status).toBe(404);
    state.actor = { userId: "usr_partner", role: "partner" };
    expect((await get(deliveryId, "logo.png")).status).toBe(403);
    state.actor = { userId: "usr_client", role: "client" };
    expect((await get(deliveryId, "logo.png")).status).toBe(200);
  });

  it("refuses a milestone that is not funded or held", async () => {
    state.actor = { userId: "usr_freelancer", role: "freelancer" };
    await db.update(core.milestones).set({ status: "review" }).where(eq(core.milestones.id, milestoneId));
    expect((await upload([["logo.png", PNG]])).status).toBe(409);
  });
});

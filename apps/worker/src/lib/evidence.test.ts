import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { formatVerdictComment, postVerdictComment } from "@milestone/verify";
import { createEvidenceReader } from "./evidence.ts";

let root: string;
let workdir: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "milestone-reader-test-"));
  workdir = join(root, "work");
  await mkdir(join(workdir, "src"), { recursive: true });
  await mkdir(join(workdir, ".git"), { recursive: true });
  await writeFile(join(workdir, "src", "a.ts"), "export const a = 1;\n");
  await writeFile(join(workdir, ".git", "config"), "[core]\n");
  await writeFile(join(root, "secret.txt"), "top secret");
  await symlink(join(root, "secret.txt"), join(workdir, "escape.txt"));
});
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

describe("evidence reader", () => {
  const reader = () => createEvidenceReader({ workdir, sha: "deadbeef", repoUrl: "file:///nowhere", evidence: [{ id: "evd_x", kind: "log", summary: "ok", status: "pass", criterion_id: "x" }] });

  it("reads files under the workdir", async () => {
    expect(await reader().readFile("src/a.ts")).toContain("export const a");
    expect(await reader().readFile("./src/../src/a.ts")).toContain("export const a");
  });
  it("refuses traversal, absolute paths, symlink escapes and .git", async () => {
    await expect(reader().readFile("../secret.txt")).rejects.toThrow(/outside/);
    await expect(reader().readFile(join(root, "secret.txt"))).rejects.toThrow(/outside/);
    await expect(reader().readFile("escape.txt")).rejects.toThrow(/outside/);
    await expect(reader().readFile(".git/config")).rejects.toThrow(/not readable/);
  });
  it("lists evidence and has no screenshots", async () => {
    expect(await reader().listEvidence()).toHaveLength(1);
    expect(await reader().viewScreenshot("evd_x")).toBe("no screenshot");
  });
  it("says so when there is no checkout", async () => {
    const r = createEvidenceReader({ workdir: null, sha: "x", repoUrl: "x", evidence: [] });
    expect(await r.readFile("a")).toMatch(/could not be checked out/);
    expect(await r.getDiff()).toMatch(/could not be checked out/);
  });
});

describe("PR comment", () => {
  const body = formatVerdictComment({
    key: "dlv_1",
    result: "fail",
    title: "milestone 2: API",
    verdict: { delivery_id: "dlv_1", suspected_injection: false, criteria: [
      { criterion_id: "crt_2_tests", status: "fail", confidence: 1, evidence_ids: ["evd_crt_2_tests"], rationale: "npm test exited 1;\nlast lines" },
      { criterion_id: "crt_2_judge", status: "unclear", confidence: 0, evidence_ids: [], rationale: "not judged" },
    ] },
    decision: { action: "hold", ruleIds: ["P2"], reason: "Required criteria failed: The test suite passes" },
  });

  it("formats one line per criterion and the decision", () => {
    expect(body).toContain("### Milestone verification: fail (milestone 2: API)");
    expect(body).toContain("- fail crt_2_tests: npm test exited 1; last lines (evd_crt_2_tests)");
    expect(body).toContain("- unclear crt_2_judge: not judged (no evidence)");
    expect(body).toContain("Policy decision: hold (P2). Required criteria failed");
    expect(body.startsWith("<!-- milestone-verdict:dlv_1 -->")).toBe(true);
  });

  it("skips without a token", async () => {
    const saved = process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_TOKEN;
    expect(await postVerdictComment({ repoFullName: "a/b", prNumber: 1, body })).toEqual({ posted: false, reason: "no_token" });
    if (saved !== undefined) process.env.GITHUB_TOKEN = saved;
  });

  it("posts once and recognises its own earlier comment", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    let existing: Array<{ body: string }> = [];
    const fake = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method ?? "GET" });
      if ((init?.method ?? "GET") === "GET") return Response.json(existing);
      existing = [{ body: JSON.parse(String(init?.body)).body }];
      return Response.json({ html_url: "https://github.com/a/b/pull/7#c1" }, { status: 201 });
    }) as typeof fetch;
    expect(await postVerdictComment({ repoFullName: "a/b", prNumber: 7, body, token: "t", fetch: fake })).toEqual({ posted: true, url: "https://github.com/a/b/pull/7#c1" });
    expect(await postVerdictComment({ repoFullName: "a/b", prNumber: 7, body, token: "t", fetch: fake })).toEqual({ posted: false, reason: "already_posted" });
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
    expect(calls[1]?.url).toBe("https://api.github.com/repos/a/b/issues/7/comments");
  });

  it("refuses odd repository names", async () => {
    await expect(postVerdictComment({ repoFullName: "a/b/../c", prNumber: 1, body, token: "t", fetch: (async () => Response.json([])) as typeof fetch })).rejects.toThrow(/bad repository/);
  });
});

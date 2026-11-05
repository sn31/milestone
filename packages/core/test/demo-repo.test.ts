import { describe, expect, it } from "vitest";
import { DEMO_REPO_REFUSED, canonicalRepoUrl, checkDemoRepo, demoModeOn, demoRepoFullName, demoRepoUrl, suggestedRepoUrl } from "../src/demo-repo.ts";

const DEMO = "https://github.com/milestone-demo/landing";
const on = (extra: Record<string, string | undefined> = {}) => ({ DEMO_MODE: "1", DEMO_REPO_URL: DEMO, ...extra });

describe("canonicalRepoUrl", () => {
  it.each([
    ["https://github.com/milestone-demo/landing", DEMO],
    ["https://github.com/milestone-demo/landing.git", DEMO],
    ["https://github.com/milestone-demo/landing/", DEMO],
    ["https://github.com/milestone-demo/landing.git/", DEMO],
    ["https://GitHub.com/Milestone-Demo/LANDING.GIT", DEMO],
    ["  https://github.com/milestone-demo/landing  ", DEMO],
    ["https://gitlab.com/group/sub/repo.git", "https://gitlab.com/group/sub/repo"],
    ["https://Example.org/Team/Repo", "https://example.org/Team/Repo"],
  ])("%s -> %s", (input, out) => {
    expect(canonicalRepoUrl(input)).toBe(out);
  });

  it.each([
    "",
    "http://github.com/milestone-demo/landing",
    "git://github.com/milestone-demo/landing",
    "ssh://git@github.com/milestone-demo/landing",
    "git@github.com:milestone-demo/landing.git",
    "file:///tmp/landing",
    "/tmp/landing",
    "https://user@github.com/milestone-demo/landing",
    "https://user:pw@github.com/milestone-demo/landing",
    "https://github.com:443/milestone-demo/landing",
    "https://github.com:8443/milestone-demo/landing",
    "https://github.com/milestone-demo/landing?x=1",
    "https://github.com/milestone-demo/landing?",
    "https://github.com/milestone-demo/landing#main",
    "https://github.com/milestone-demo/landing/../evil",
    "https://github.com/evil/../milestone-demo/landing",
    "https://github.com/./milestone-demo/landing",
    "https://github.com/milestone-demo/%6candin%67",
    "https://github.com/evil/%2e%2e/milestone-demo/landing",
    "https://github.com\\milestone-demo\\landing",
    "https://github.com//milestone-demo/landing",
    "https://github.com/milestone-demo//landing",
    "https://github.com/milestone-demo",
    "https://github.com/milestone-demo/landing/tree/main",
    "https://github.com/milestone-demo/.git",
    "https://github.com/milestone-demo/lan\nding",
    "https://github.com/milestone-demo/land ing",
    "https://-github.com/milestone-demo/landing",
    "https://github..com/milestone-demo/landing",
    "https://localhost/milestone-demo/landing",
    "https://[::1]/milestone-demo/landing",
    "https://ｇithub.com/milestone-demo/landing",
  ])("refuses %j", (input) => {
    expect(canonicalRepoUrl(input)).toBeNull();
  });
});

describe("checkDemoRepo", () => {
  it("allows everything outside DEMO_MODE=1", () => {
    for (const v of [undefined, "", "0", "true", "yes"]) {
      expect(demoModeOn({ DEMO_MODE: v })).toBe(false);
      expect(checkDemoRepo("https://github.com/someone/else", { DEMO_MODE: v })).toEqual({ ok: true });
    }
  });

  it.each([
    "https://github.com/milestone-demo/landing.git",
    "https://github.com/milestone-demo/landing",
    "https://github.com/MILESTONE-DEMO/Landing/",
    "https://GITHUB.COM/milestone-demo/landing.git",
  ])("accepts the demo repository: %s", (url) => {
    expect(checkDemoRepo(url, on())).toEqual({ ok: true });
  });

  it.each([
    "https://github.com/milestone-demo/landing2",
    "https://github.com/milestone-demo/landing-evil",
    "https://github.com/milestone-demo-evil/landing",
    "https://github.com/evil/landing",
    "https://www.github.com/milestone-demo/landing",
    "https://github.com.evil.com/milestone-demo/landing",
    "https://evil.com/github.com/milestone-demo/landing",
    "https://gitlab.com/milestone-demo/landing",
    "https://github.com/milestone-demo/landing.git.git",
    "https://github.com/milestone-demo/landing/../../evil/x",
    "https://github.com/evil/x/../../milestone-demo/landing",
    "https://github.com/milestone-demo/%6Canding",
    "https://x@github.com/milestone-demo/landing",
    "https://github.com:443/milestone-demo/landing",
    "https://github.com/milestone-demo/landing?ref=main",
    "https://github.com/milestone-demo/landing#x",
    "file:///srv/milestone-demo/landing",
    "/srv/milestone-demo/landing",
    "http://github.com/milestone-demo/landing",
    "",
  ])("refuses another repository in DEMO_MODE: %j", (url) => {
    const r = checkDemoRepo(url, on());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe(DEMO_REPO_REFUSED);
      expect(r.reason).toContain(`only accepts code deliveries from ${DEMO}`);
    }
  });

  it("fails closed when DEMO_REPO_URL is unset, blank or invalid", () => {
    for (const v of [undefined, "", "   "]) {
      const r = checkDemoRepo(DEMO, on({ DEMO_REPO_URL: v }));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toContain("DEMO_REPO_URL is not set");
    }
    for (const v of ["file:///tmp/demo-repo", "/tmp/demo-repo", "github.com/milestone-demo/landing", "https://github.com/milestone-demo"]) {
      const r = checkDemoRepo(v, on({ DEMO_REPO_URL: v }));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toContain("not a valid https repository URL");
    }
  });

  it("accepts a configured DEMO_REPO_URL written with .git or a trailing slash", () => {
    expect(checkDemoRepo("https://github.com/milestone-demo/landing", on({ DEMO_REPO_URL: "https://github.com/Milestone-Demo/landing.git/" }))).toEqual({ ok: true });
  });
});

describe("demoRepoUrl / demoRepoFullName", () => {
  it("reads DEMO_REPO_URL in canonical form, owner/repo only on github.com", () => {
    // Case kept: GitHub's webhook full_name is matched against the seeded contract's repoFullName as written.
    expect(demoRepoUrl({ DEMO_REPO_URL: "https://GitHub.com/Owner/Repo.git" })).toBe("https://github.com/Owner/Repo");
    expect(demoRepoUrl({ DEMO_REPO_URL: "https://github.com/Owner/Repo/" })).toBe("https://github.com/Owner/Repo");
    expect(demoRepoFullName({ DEMO_REPO_URL: "https://github.com/Owner/Repo.git" })).toBe("Owner/Repo");
    expect(demoRepoUrl({ DEMO_REPO_URL: "https://gitlab.com/a/b" })).toBe("https://gitlab.com/a/b");
    expect(demoRepoFullName({ DEMO_REPO_URL: "https://gitlab.com/a/b" })).toBeNull();
    for (const v of [undefined, "", "file:///tmp/x"]) {
      expect(demoRepoUrl({ DEMO_REPO_URL: v })).toBeNull();
      expect(demoRepoFullName({ DEMO_REPO_URL: v })).toBeNull();
    }
  });
});

describe("suggestedRepoUrl", () => {
  it("suggests DEMO_REPO_URL when set and valid, else the contract's repository", () => {
    expect(suggestedRepoUrl("milestone-demo/landing", { DEMO_REPO_URL: "https://github.com/Owner/Demo" })).toBe("https://github.com/Owner/Demo.git");
    expect(suggestedRepoUrl(null, { DEMO_REPO_URL: "https://github.com/Owner/Demo.git" })).toBe("https://github.com/Owner/Demo.git");
    expect(suggestedRepoUrl("milestone-demo/landing", {})).toBe("https://github.com/milestone-demo/landing.git");
    expect(suggestedRepoUrl("milestone-demo/landing", { DEMO_REPO_URL: "file:///tmp/x" })).toBe("https://github.com/milestone-demo/landing.git");
    expect(suggestedRepoUrl(null, {})).toBeNull();
  });
});

// The README quick start's own commands: `pnpm dev` (root script) and `pnpm db:migrate` (drizzle.config.ts).
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../../..");
const CONFIG = resolve(import.meta.dirname, "../drizzle.config.ts");
const TSX = resolve(ROOT, "node_modules/.bin/tsx");

describe("root dev script", () => {
  it("passes ./apps/* to pnpm unexpanded (sh would otherwise expand it to two paths and pnpm execs ./apps/worker)", () => {
    const script: string = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).scripts.dev;
    const args = spawnSync("sh", ["-c", `set -- ${script}; printf '%s\\n' "$@"`], { cwd: ROOT, encoding: "utf8" }).stdout.trim().split("\n");
    expect(args).toContain("./apps/*");
    expect(args.at(-1)).toBe("dev");
  });
});

describe("drizzle.config.ts", () => {
  const dir = mkdtempSync(join(tmpdir(), "milestone-drizzle-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "pnpm-workspace.yaml"), "packages: []\n");
  writeFileSync(join(dir, ".env"), "DATABASE_URL=postgres://judge:judge@localhost:5433/from_root_env\n");
  mkdirSync(join(dir, "packages/core"), { recursive: true });

  const urlFrom = (env: NodeJS.ProcessEnv) => {
    const code = `import(${JSON.stringify(CONFIG)}).then((m) => console.log(m.default.dbCredentials.url))`;
    const r = spawnSync(TSX, ["-e", code], { cwd: join(dir, "packages/core"), env, encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    return r.stdout.trim();
  };
  const base = { PATH: process.env.PATH, HOME: process.env.HOME };

  it("reads DATABASE_URL from the repo-root .env, as seed and the apps do", () => {
    expect(urlFrom(base)).toBe("postgres://judge:judge@localhost:5433/from_root_env");
  });

  it("lets a DATABASE_URL exported in the shell win over .env", () => {
    expect(urlFrom({ ...base, DATABASE_URL: "postgres://shell/db" })).toBe("postgres://shell/db");
  });
});

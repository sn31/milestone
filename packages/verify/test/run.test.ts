import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { criterionArgv, run, tailBuffer } from "../src/deterministic.ts";

const env = { PATH: process.env.PATH ?? "" };
const node = (script: string) => [process.execPath, "-e", script];

/** Whether a pid is gone: no such process, or a zombie waiting to be reaped (it holds nothing and runs nothing). */
function gone(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ESRCH";
  }
  try {
    return /^\d+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return true;
  }
}

/** A grandchild that idles forever with the command's stdout and stderr, printing its pid first. */
const grandchild = (opts: string) =>
  `const c = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "inherit", ${opts} }); c.unref(); console.log("pid:" + c.pid);`;
const pidOf = (output: string) => Number(/pid:(\d+)/.exec(output)?.[1]);

const strays: number[] = [];
afterEach(() => {
  for (const pid of strays.splice(0)) try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
});

describe("tailBuffer: bounded output while it streams", () => {
  it("keeps the last max characters and counts everything", () => {
    const b = tailBuffer(10);
    for (let i = 0; i < 10_000; i++) b.push("abcdefghij");
    b.push("0123456789XY");
    expect(b.text).toBe("23456789XY");
    expect(b.truncated).toBe(true);
    expect(b.length).toBe(100_012);
  });

  it("is not truncated at exactly max, and holds about twice max at most", () => {
    const b = tailBuffer(5);
    b.push("abcde");
    expect([b.text, b.truncated]).toEqual(["abcde", false]);
    const big = tailBuffer(1000);
    for (let i = 0; i < 1000; i++) big.push("x".repeat(1000));
    expect(big.text.length).toBe(1000);
    expect(big.truncated).toBe(true);
  });

  it("keeps nothing with max 0", () => {
    const b = tailBuffer(0);
    b.push("abc");
    expect([b.text, b.truncated]).toEqual(["", true]);
  });
});

describe("run: output cap, process tree and pipes", () => {
  it("caps a command that prints megabytes to the last maxOutput characters", async () => {
    const r = await run(node(`const s = "y".repeat(1 << 20); for (let i = 0; i < 8; i++) process.stdout.write(s); process.stdout.write("END");`), tmpdir(), env, 10_000, 1000);
    expect(r.code).toBe(0);
    expect(r.output.length).toBe(1000);
    expect(r.output.endsWith("yyyEND")).toBe(true);
    expect(r.truncated).toBe(true);
  });

  it("keeps short output whole", async () => {
    const r = await run(node(`process.stdout.write("out"); process.stderr.write("err"); process.exitCode = 3;`), tmpdir(), env, 10_000);
    expect(r).toMatchObject({ code: 3, timedOut: false, truncated: false });
    expect(r.output.length).toBe(6);
  });

  it("on timeout kills the whole tree, grandchild included, and returns", async () => {
    const r = await run(node(`${grandchild("")} setInterval(() => {}, 1000);`), tmpdir(), env, 300, 200_000, 50);
    const pid = pidOf(r.output);
    strays.push(pid);
    expect(r.timedOut).toBe(true);
    expect(r.code).toBeNull();
    expect(pid).toBeGreaterThan(0);
    expect(gone(pid)).toBe(true);
  });

  it("returns when the command exits even though a grandchild holds the pipes, and the grandchild dies with it", async () => {
    const r = await run(node(grandchild("")), tmpdir(), env, 10_000, 200_000, 50);
    const pid = pidOf(r.output);
    strays.push(pid);
    expect(r).toMatchObject({ code: 0, timedOut: false });
    expect(gone(pid)).toBe(true);
  });

  it("returns after the grace period when a process outside the group still holds the pipes", async () => {
    const r = await run(node(grandchild("detached: true")), tmpdir(), env, 10_000, 200_000, 50);
    strays.push(pidOf(r.output));
    expect(r).toMatchObject({ code: 0, timedOut: false });
  });
});

describe("criterionArgv: what a test or build command runs as", () => {
  it("runs through sh when commands are not restricted", () => {
    expect(criterionArgv("npm test && echo ok", false)).toEqual(["sh", "-c", "npm test && echo ok"]);
  });

  it("with restrictions runs allowlisted commands without a shell and refuses the rest", () => {
    expect(criterionArgv("npm test", true)).toEqual(["npm", "test"]);
    expect(criterionArgv(" npm run lint ", true)).toEqual(["npm", "run", "lint"]);
    expect(criterionArgv("node scripts/check.mjs", true)).toEqual(["node", "scripts/check.mjs"]);
    for (const c of ["npm test; id", "sh -c id", "npm run b && id", "node -e 1", "npm test -- --x"]) expect(criterionArgv(c, true)).toBeNull();
  });
});

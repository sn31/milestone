// Enforces the money boundary from CLAUDE.md.
//  - paypal/money.ts may only be imported from packages/money/src/policy/execute.ts
//  - packages/verify may not import @milestone/money
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const rules = [
  { dirs: ["apps", "packages"], forbid: /paypal\/money(\.[cm]?[jt]s)?["']/, allowFiles: ["packages/money/src/policy/execute.ts"], why: "only policy/execute.ts may move money" },
  { dirs: ["packages/verify/src"], forbid: /@milestone\/money/, why: "the verifier never touches money or policy (tests may)" },
];

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next" || name === "dist") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(ts|tsx|mts|js|mjs)$/.test(name)) yield p;
  }
}

let failed = 0;
for (const rule of rules) {
  for (const dir of rule.dirs) {
    let files;
    try { files = [...walk(join(root, dir))]; } catch { continue; }
    for (const file of files) {
      const rel = relative(root, file);
      if (rule.allowFiles?.includes(rel)) continue;
      if (/(^|\/)test\//.test(rel) || /\.test\.[cm]?[jt]sx?$/.test(rel)) continue; // tests may exercise money calls directly
      const src = readFileSync(file, "utf8");
      const lines = src.split("\n");
      lines.forEach((line, i) => {
        if ((/^\s*(import|export)\b/.test(line) || /\bimport\s*\(/.test(line) || /^\s*from\s/.test(line)) && rule.forbid.test(line)) {
          console.error(`${rel}:${i + 1}: forbidden import (${rule.why})`);
          failed++;
        }
      });
    }
  }
}
if (failed) { console.error(`\n${failed} boundary violation(s)`); process.exit(1); }
console.log("boundaries ok");

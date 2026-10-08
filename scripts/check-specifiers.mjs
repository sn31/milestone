// Turbopack (Next 16) cannot resolve "./x.js" specifiers that point at .ts sources inside workspace packages.
// Relative imports in packages/* and apps/worker must therefore use explicit ".ts" (allowImportingTsExtensions is on).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
const root = new URL("..", import.meta.url).pathname;
const re = /(from\s+|import\()\s*["'](\.{1,2}\/[^"']+)\.js["']/;
function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (["node_modules", ".next", "dist", "drizzle"].includes(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(ts|tsx|mts)$/.test(name)) yield p;
  }
}
let bad = 0;
for (const dir of ["packages", "apps/worker"]) {
  for (const f of walk(join(root, dir))) {
    readFileSync(f, "utf8").split("\n").forEach((line, i) => { if (re.test(line)) { console.error(`${relative(root, f)}:${i + 1}: use a ".ts" specifier, not ".js"`); bad++; } });
  }
}
if (bad) process.exit(1);
console.log("specifiers ok");

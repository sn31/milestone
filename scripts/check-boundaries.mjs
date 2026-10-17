// Enforces the money boundary from CLAUDE.md.
//  - paypal/money.ts may only be imported from packages/money/src/policy/execute.ts, and the PayPal calls that move
//    money (capture, payout, refund, accept-claim, vault charge) may not be imported by name from anywhere else either (e.g. a
//    copy left in paypal/disputes.ts, or a re-export through @milestone/money)
//  - only paypal/money.ts may build a request that charges a saved PayPal (an object key `vault_id:`), so a vault charge
//    cannot be assembled by hand around chargeVault
//  - those calls, and the agent funding entry points (fundFromVault, autoFundNextMilestone), may not even be named in
//    code outside their allowed files, which catches namespace and dynamic imports (a name built at run time from
//    strings is beyond a static check)
//  - packages/verify may not import @milestone/money
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const rules = [
  {
    dirs: ["apps", "packages"],
    forbid: /paypal\/money(\.[cm]?[jt]s)?["']/,
    // Whole import/export statements (multi-line too) that name a money-moving call, from any module.
    forbidNames: /\b(captureOrder|createPayout|refundCapture|acceptClaim|chargeVault)\b/,
    allowFiles: ["packages/money/src/policy/execute.ts"],
    why: "only policy/execute.ts may move money",
  },
  {
    dirs: ["apps", "packages"],
    forbidText: /(^|[^\w.])["']?vault_id["']?\s*:/m,
    allowFiles: ["packages/money/src/paypal/money.ts"],
    why: "only paypal/money.ts (chargeVault) may charge a saved PayPal",
  },
  {
    dirs: ["apps", "packages"],
    // Agents fund (charge the client's saved PayPal) only through the Milestone MCP fund_milestone tool and the autofund job.
    forbidNames: /\b(fundFromVault|autoFundNextMilestone)\b/,
    allowFiles: ["packages/money/src/index.ts", "apps/web/src/lib/mcp/tools.ts", "apps/worker/src/jobs/autofund.ts"],
    why: "agents fund only through MCP fund_milestone and the autofund job",
  },
  {
    dirs: ["apps", "packages"],
    // Any use of these names in code (comments stripped), not only a named import: a namespace import
    // (`import * as M` then `M.fundFromVault`) or a dynamic import (`(await import(...)).chargeVault`) is caught too.
    // paypal/money.ts defines the calls; the simulator's handlers have same-named local functions for PayPal's endpoints.
    forbidIdent: /\b(captureOrder|createPayout|refundCapture|acceptClaim|chargeVault)\b/,
    allowFiles: ["packages/money/src/policy/execute.ts", "packages/money/src/paypal/money.ts", "packages/money/src/paypal/sim/handlers.ts"],
    why: "only policy/execute.ts may move money",
  },
  {
    dirs: ["apps", "packages"],
    forbidIdent: /\b(fundFromVault|autoFundNextMilestone)\b/,
    allowFiles: ["packages/money/src/policy/execute.ts", "packages/money/src/index.ts", "apps/web/src/lib/mcp/tools.ts", "apps/worker/src/jobs/autofund.ts"],
    why: "agents fund only through MCP fund_milestone and the autofund job",
  },
  {
    dirs: ["apps", "packages"],
    // A quoted "vault_id" (a computed or quoted request key) outside paypal/money.ts.
    forbidIdent: /["'`]vault_id["'`]/,
    allowFiles: ["packages/money/src/paypal/money.ts"],
    why: "only paypal/money.ts (chargeVault) may charge a saved PayPal",
  },
  { dirs: ["packages/verify/src"], forbid: /@milestone\/money/, why: "the verifier never touches money or policy (tests may)" },
];

/** The source with comments blanked (line numbers kept), so a name in a doc comment is not a use. */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next" || name.startsWith(".next-") || name === "dist") continue;
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
      if (rule.forbidNames) {
        for (const m of src.matchAll(/^\s*(?:import|export)\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["'][^"']+["']/gm)) {
          const named = m[1].split(",").map((x) => x.trim().split(/\s+as\s+/)[0].replace(/^type\s+/, ""));
          const hit = named.find((n) => rule.forbidNames.test(n));
          if (hit) {
            console.error(`${rel}:${src.slice(0, m.index).split("\n").length}: forbidden import of ${hit} (${rule.why})`);
            failed++;
          }
        }
      }
      if (rule.forbidIdent) {
        stripComments(src).split("\n").forEach((line, i) => {
          const hit = rule.forbidIdent.exec(line);
          if (hit) {
            console.error(`${rel}:${i + 1}: forbidden use of ${hit[0]} (${rule.why})`);
            failed++;
          }
        });
      }
      if (rule.forbidText) {
        src.split("\n").forEach((line, i) => {
          if (rule.forbidText.test(line)) {
            console.error(`${rel}:${i + 1}: forbidden vault charge request (${rule.why})`);
            failed++;
          }
        });
      }
      if (!rule.forbid) continue;
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

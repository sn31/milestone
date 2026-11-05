// Next 16 refuses a second `next dev` in a project whose .next/dev is locked by a running server (the user's
// port 3000 one). The recorder therefore serves apps/web from a shadow project: its own folder (so its own .next and
// lock) with a snapshot copy of src and public, node_modules symlinked to apps/web's, and a copy of the Next config.
// (A symlinked src makes next dev accept connections and never answer them.) The snapshot also keeps the recording
// stable while other people edit apps/web. The shadow lives under <repo>/var (gitignored) because Turbopack only
// compiles files inside the workspace root.
import { cpSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

export function makeShadowWeb(root, dir = join(root, "var", "demo-web")) {
  const web = join(root, "apps", "web");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const name of ["src", "public"]) cpSync(join(web, name), join(dir, name), { recursive: true });
  symlinkSync(relative(dir, join(web, "node_modules")), join(dir, "node_modules"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "milestone-demo-web", private: true, type: "module" }, null, 2) + "\n");
  writeFileSync(join(dir, "tsconfig.json"), readFileSync(join(web, "tsconfig.json")));
  // Mirrors apps/web/next.config.ts (kept in step by hand; the recorder only needs it to serve the same app).
  writeFileSync(
    join(dir, "next.config.mjs"),
    `export default {
  transpilePackages: ["@milestone/core", "@milestone/money", "@milestone/verify"],
  serverExternalPackages: ["pg", "pg-boss"],
  agentRules: false,
  // Next 16.4 defaults agentUpgrade to "security": under a coding agent, with an advisory against the installed
  // version, \`next dev\` exits 1 right after "Ready" and only a retry within 5 minutes (a receipt in .next/cache)
  // continues. The shadow's .next is new every run, so the recorder's server would die on each one.
  // The upgrade itself is the app's decision (apps/web), not the recorder's.
  experimental: { agentUpgrade: false },
  turbopack: {
    rules: { "*.css": { loaders: ["@tailwindcss/turbopack"], as: "*.css" } },
  },
};
`,
  );
  return dir;
}

#!/usr/bin/env node
// Checks render.yaml against the Render Blueprint spec (https://render.com/docs/blueprint-spec, as of Oct 2026) and
// against what the app reads in production:
//   1. only fields, types, runtimes and plans the spec lists; envVars in one of the spec's forms; no sync:false inside
//      an environment group (the spec forbids it); fromDatabase names a database in this file;
//   2. the hosted-demo settings: DEMO_MODE=1, PAYPAL_MODE, a generated SIMULATED_WEBHOOK_SECRET, the pre-deploy
//      migrate + seed, no MILESTONE_ALLOW_LOCAL_REPOS, no Key Value store;
//   3. every environment variable read in apps/*/src and packages/*/src (tests excluded) is set in the blueprint,
//      provided by the platform, or listed in the "Optional environment variables" table of docs/deploy.md.
// No dependencies: a small parser for the YAML subset render.yaml uses (block maps and lists, scalars, comments).
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const errors = [];
const fail = (msg) => errors.push(msg);

// ---------- Minimal YAML (block style only) ----------

function scalar(raw) {
  const s = raw.trim();
  if (s === "") return null;
  if (/^".*"$/.test(s)) return JSON.parse(s);
  if (/^'.*'$/.test(s)) return s.slice(1, -1).replace(/''/g, "'");
  if (s === "true") return true;
  if (s === "false") return false;
  if (s === "null" || s === "~") return null;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  if (/^[[{]/.test(s)) throw new Error(`flow collections are not supported by check-render: ${s}`);
  return s;
}

/** Strips a trailing comment that is not inside quotes. */
function stripComment(line) {
  let q = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === q) q = null; continue; }
    if (c === '"' || c === "'") q = c;
    else if (c === "#" && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
  }
  return line;
}

export function parseYaml(text) {
  const lines = [];
  text.split("\n").forEach((raw, i) => {
    if (/\t/.test(raw.match(/^\s*/)[0])) throw new Error(`line ${i + 1}: tabs are not valid YAML indentation`);
    const l = stripComment(raw).replace(/\s+$/, "");
    if (l.trim()) lines.push({ indent: l.match(/^ */)[0].length, text: l.trim(), n: i + 1 });
  });
  let pos = 0;
  function block(indent) {
    const first = lines[pos];
    if (!first || first.indent < indent) return null;
    return first.text.startsWith("- ") || first.text === "-" ? list(first.indent) : map(first.indent);
  }
  function map(indent, into = {}) {
    while (pos < lines.length && lines[pos].indent === indent && !lines[pos].text.startsWith("- ")) {
      const { text: t, n } = lines[pos];
      const m = /^([A-Za-z_][\w.-]*):(?:\s+(.*))?$/.exec(t);
      if (!m) throw new Error(`line ${n}: expected "key: value", got ${JSON.stringify(t)}`);
      if (m[1] in into) throw new Error(`line ${n}: duplicate key ${m[1]}`);
      pos++;
      if (m[2] !== undefined && m[2] !== "") into[m[1]] = scalar(m[2]);
      else into[m[1]] = lines[pos] && lines[pos].indent > indent ? block(lines[pos].indent) : lines[pos] && lines[pos].indent === indent && lines[pos].text.startsWith("- ") ? list(indent) : null;
    }
    return into;
  }
  function list(indent) {
    const out = [];
    while (pos < lines.length && lines[pos].indent === indent && (lines[pos].text.startsWith("- ") || lines[pos].text === "-")) {
      const line = lines[pos];
      const rest = line.text.slice(1).trimStart();
      if (!rest) { pos++; out.push(block(lines[pos]?.indent ?? indent + 1)); continue; }
      const itemIndent = indent + (line.text.length - rest.length);
      if (/^[A-Za-z_][\w.-]*:(\s|$)/.test(rest)) {
        lines[pos] = { indent: itemIndent, text: rest, n: line.n };
        out.push(map(itemIndent));
      } else {
        pos++;
        out.push(scalar(rest));
      }
    }
    return out;
  }
  const doc = block(0);
  if (pos < lines.length) throw new Error(`line ${lines[pos].n}: unexpected indentation`);
  return doc;
}

// ---------- The spec ----------

const TOP = ["services", "databases", "envVarGroups", "previews", "projects", "ungrouped"];
const SERVICE_FIELDS = ["type", "name", "runtime", "plan", "region", "repo", "branch", "autoDeployTrigger", "buildCommand", "startCommand", "preDeployCommand", "healthCheckPath", "rootDir", "buildFilter", "numInstances", "scaling", "disk", "envVars", "domains", "renderSubdomainPolicy", "maxShutdownDelaySeconds", "maintenanceMode", "initialDeployHook", "dockerCommand", "dockerfilePath", "dockerContext", "registryCredential", "image", "schedule", "staticPublishPath", "headers", "routes", "previews", "ipAllowList", "maxmemoryPolicy"];
const TYPES = ["web", "pserv", "worker", "cron", "keyvalue", "workflow"];
const RUNTIMES = ["node", "python", "ruby", "go", "elixir", "rust", "docker", "image", "static"];
const SERVICE_PLANS = ["free", "0.5c-512mb", "1c-2g", "2c-4g", "2c-8g", "2c-16g", "4c-8g", "4c-16g", "4c-32g", "8c-16g", "8c-32g", "8c-64g", "12c-24g", "12c-48g", "12c-96g"];
const REGIONS = ["oregon", "ohio", "virginia", "frankfurt", "singapore"];
const DB_FIELDS = ["name", "plan", "previewPlan", "diskSizeGB", "previewDiskSizeGB", "storageAutoscalingEnabled", "region", "ipAllowList", "connectionPool", "postgresMajorVersion", "databaseName", "user", "readReplicas", "highAvailability"];
const DB_PLANS = ["free", "0.1c-256mb", "0.5c-1g", "1c-2g", "1c-4g", "2c-4g", "2c-8g", "2c-16g", "4c-16g", "4c-32g", "8c-32g", "8c-64g", "16c-64g", "16c-128g", "32c-128g", "32c-256g", "48c-192g", "48c-384g", "64c-256g", "64c-512g", "96c-384g", "96c-768g", "128c-512g", "128c-1024g"];
const DB_PROPS = ["connectionString", "connectionPoolString", "user", "password", "database", "host", "port", "hostport"];
const SERVICE_PROPS = ["host", "port", "hostport", "slug", "connectionString"];

const oneOf = (v, allowed, where) => { if (!allowed.includes(v)) fail(`${where}: ${JSON.stringify(v)} is not one of ${allowed.join(", ")}`); };
const onlyFields = (obj, allowed, where) => { for (const k of Object.keys(obj ?? {})) if (!allowed.includes(k)) fail(`${where}: unknown field ${k}`); };

function checkEnvVar(v, where, { inGroup, dbNames }) {
  if (!v || typeof v !== "object") return fail(`${where}: not a mapping`);
  if ("fromGroup" in v) {
    if (Object.keys(v).length !== 1) fail(`${where}: fromGroup stands alone`);
    if (inGroup) fail(`${where}: a group cannot reference another group`);
    return;
  }
  onlyFields(v, ["key", "value", "generateValue", "sync", "fromDatabase", "fromService", "previewValue"], where);
  if (typeof v.key !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(v.key)) fail(`${where}: missing or invalid key`);
  const sources = ["value", "generateValue", "sync", "fromDatabase", "fromService"].filter((k) => k in v);
  if (sources.length !== 1) fail(`${where} (${v.key}): exactly one of value, generateValue, sync, fromDatabase, fromService`);
  if ("value" in v && typeof v.value !== "string") fail(`${where} (${v.key}): quote the value so it is a string`);
  if ("generateValue" in v && v.generateValue !== true) fail(`${where} (${v.key}): generateValue must be true`);
  if ("sync" in v) {
    if (v.sync !== false) fail(`${where} (${v.key}): sync must be false`);
    if (inGroup) fail(`${where} (${v.key}): sync: false is not allowed in an environment group`);
  }
  if ("fromDatabase" in v) {
    if (inGroup) fail(`${where} (${v.key}): an environment group cannot reference a database`);
    onlyFields(v.fromDatabase, ["name", "property"], `${where}.fromDatabase`);
    if (!dbNames.includes(v.fromDatabase?.name)) fail(`${where} (${v.key}): fromDatabase.name ${v.fromDatabase?.name} is not a database in this file`);
    oneOf(v.fromDatabase?.property, DB_PROPS, `${where}.fromDatabase.property`);
  }
  if ("fromService" in v) {
    if (inGroup) fail(`${where} (${v.key}): an environment group cannot reference a service`);
    onlyFields(v.fromService, ["name", "type", "property", "envVarKey"], `${where}.fromService`);
    if (!v.fromService?.name || !v.fromService?.type) fail(`${where} (${v.key}): fromService needs name and type`);
    if (("property" in (v.fromService ?? {})) === ("envVarKey" in (v.fromService ?? {}))) fail(`${where} (${v.key}): fromService needs property or envVarKey`);
    if (v.fromService?.property) oneOf(v.fromService.property, SERVICE_PROPS, `${where}.fromService.property`);
  }
}

// ---------- Check the file ----------

let bp;
try {
  // An optional path checks another blueprint (used to test this script); the default is the repo's render.yaml.
  bp = parseYaml(readFileSync(process.argv[2] ?? join(root, "render.yaml"), "utf8"));
} catch (e) {
  console.error(`render.yaml: ${e.message}`);
  process.exit(1);
}
onlyFields(bp, TOP, "render.yaml");
const services = bp.services ?? [];
const databases = bp.databases ?? [];
const groups = bp.envVarGroups ?? [];
const dbNames = databases.map((d) => d.name);
if (!Array.isArray(services) || !services.length) fail("render.yaml: no services");

const names = new Set();
for (const [i, s] of services.entries()) {
  const where = `services[${i}]${s?.name ? ` (${s.name})` : ""}`;
  onlyFields(s, SERVICE_FIELDS, where);
  if (!s.name) fail(`${where}: name is required`);
  if (names.has(s.name)) fail(`${where}: duplicate name`);
  names.add(s.name);
  oneOf(s.type, TYPES, `${where}.type`);
  if (s.type === "keyvalue" || s.type === "redis") fail(`${where}: jobs live in Postgres (pg-boss); no Key Value store is needed`);
  if (s.type !== "keyvalue") oneOf(s.runtime, RUNTIMES, `${where}.runtime`);
  if ("env" in s) fail(`${where}: env is deprecated, use runtime`);
  if ("autoDeploy" in s) fail(`${where}: autoDeploy is deprecated, use autoDeployTrigger`);
  if (s.plan !== undefined) oneOf(s.plan, SERVICE_PLANS, `${where}.plan`);
  if (s.region !== undefined) oneOf(s.region, REGIONS, `${where}.region`);
  if (s.autoDeployTrigger !== undefined) oneOf(s.autoDeployTrigger, ["commit", "checksPass", "off"], `${where}.autoDeployTrigger`);
  for (const k of ["buildCommand", "startCommand"]) if (s.runtime !== "docker" && s.runtime !== "image" && typeof s[k] !== "string") fail(`${where}: ${k} is required`);
  if (s.disk) {
    onlyFields(s.disk, ["name", "mountPath", "sizeGB"], `${where}.disk`);
    if (!s.disk.name || !String(s.disk.mountPath ?? "").startsWith("/")) fail(`${where}.disk: name and an absolute mountPath are required`);
    if (s.numInstances !== undefined && s.numInstances !== 1) fail(`${where}: a service with a disk cannot be scaled`);
    if (s.scaling) fail(`${where}: a service with a disk cannot autoscale`);
  }
  // Every repo script a command names must exist.
  for (const k of ["buildCommand", "startCommand", "preDeployCommand", "initialDeployHook"]) {
    for (const m of String(s[k] ?? "").matchAll(/\b(scripts\/[\w./-]+\.(?:mjs|js|sh))\b/g)) if (!existsSync(join(root, m[1]))) fail(`${where}.${k}: ${m[1]} does not exist`);
  }
  if (s.buildCommand && /pnpm/.test(s.buildCommand) && !/corepack enable/.test(s.buildCommand)) fail(`${where}.buildCommand: enable corepack before pnpm so pnpm matches the packageManager field`);
  for (const [j, v] of (s.envVars ?? []).entries()) checkEnvVar(v, `${where}.envVars[${j}]`, { inGroup: false, dbNames });
}
for (const [i, d] of databases.entries()) {
  const where = `databases[${i}]${d?.name ? ` (${d.name})` : ""}`;
  onlyFields(d, DB_FIELDS, where);
  if (!d.name) fail(`${where}: name is required`);
  if (d.plan !== undefined) oneOf(d.plan, DB_PLANS, `${where}.plan`);
  if (d.region !== undefined) oneOf(d.region, REGIONS, `${where}.region`);
  if (d.postgresMajorVersion !== undefined && typeof d.postgresMajorVersion !== "string") fail(`${where}: postgresMajorVersion must be a quoted string`);
}
for (const [i, g] of groups.entries()) {
  const where = `envVarGroups[${i}]${g?.name ? ` (${g.name})` : ""}`;
  onlyFields(g, ["name", "envVars"], where);
  for (const [j, v] of (g.envVars ?? []).entries()) checkEnvVar(v, `${where}.envVars[${j}]`, { inGroup: true, dbNames });
}

// ---------- The hosted demo ----------

const web = services.find((s) => s.type === "web");
const envOf = (s) => {
  const out = new Map();
  for (const v of s?.envVars ?? []) {
    if (v.fromGroup) for (const gv of groups.find((g) => g.name === v.fromGroup)?.envVars ?? []) out.set(gv.key, gv);
    else out.set(v.key, v);
  }
  return out;
};
const webEnv = envOf(web);
if (!web) fail("render.yaml: no web service");
else {
  if (!/predeploy/.test(web.preDeployCommand ?? "")) fail("web service: preDeployCommand must run migrate + seed (scripts/start-render.mjs predeploy)");
  const pre = readFileSync(join(root, "scripts/start-render.mjs"), "utf8");
  for (const needle of ["migrate", "--showcase", "--if-empty"]) if (!pre.includes(needle)) fail(`scripts/start-render.mjs: predeploy must use ${needle}`);
  if (!readFileSync(join(root, "packages/core/src/seed.ts"), "utf8").includes('"--if-empty"')) fail("packages/core/src/seed.ts: no --if-empty flag");
  const expect = (key, check, why) => { if (!check(webEnv.get(key))) fail(`web service env ${key}: ${why}`); };
  expect("DATABASE_URL", (v) => v?.fromDatabase?.property === "connectionString", "fromDatabase connectionString");
  expect("DEMO_MODE", (v) => v?.value === "1", 'must be "1" on the hosted demo');
  expect("PAYPAL_MODE", (v) => v?.value === "simulated" || v?.value === "sandbox", "simulated or sandbox");
  expect("SIMULATED_WEBHOOK_SECRET", (v) => v?.generateValue === true, "generateValue: true (required in production)");
  expect("NODE_VERSION", (v) => typeof v?.value === "string" && /^24(\.|$)/.test(v.value), "Node 24 (package.json engines)");
  expect("ANTHROPIC_API_KEY", (v) => !v || v.sync === false, "a secret: sync: false, never a value");
  for (const secret of ["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "PAYPAL_WEBHOOK_ID", "GITHUB_WEBHOOK_SECRET", "GITHUB_TOKEN", "PAYPAL_PARTNER_CLIENT_SECRET"]) {
    if (webEnv.get(secret) && webEnv.get(secret).sync !== false) fail(`web service env ${secret}: a secret is sync: false, never a value`);
  }
  for (const banned of ["MILESTONE_ALLOW_LOCAL_REPOS"]) if (webEnv.has(banned)) fail(`web service env ${banned}: leave unset on Render (hosted deliveries are https only)`);
}

// ---------- Every env var the code reads ----------

const PLATFORM = new Set(["PATH", "HOME", "NODE_ENV", "PORT", "RENDER_EXTERNAL_URL", "CI", "TMPDIR", "NEXT_RUNTIME"]);
function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (["node_modules", ".next", "dist", "test", "__tests__"].includes(name) || name.startsWith(".next")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(ts|tsx|mts|mjs)$/.test(name) && !/\.(test|e2e|spec)\./.test(name)) yield p;
  }
}
const read = new Map();
for (const base of ["apps", "packages"]) {
  for (const pkg of readdirSync(join(root, base))) {
    const src = join(root, base, pkg, "src");
    if (!existsSync(src)) continue;
    for (const f of walk(src)) {
      const text = readFileSync(f, "utf8");
      // process.env.X, env?.X, env["X"], and the envOr("X", env) helper from @milestone/core.
      for (const m of text.matchAll(/\benv\??\.([A-Z][A-Z0-9_]+)\b|\benv\[\s*["']([A-Z][A-Z0-9_]+)["']\s*\]|\benvOr\(\s*["']([A-Z][A-Z0-9_]+)["']/g)) {
        const k = m[1] ?? m[2] ?? m[3];
        if (!read.has(k)) read.set(k, relative(root, f));
      }
    }
  }
}
const deployDoc = existsSync(join(root, "docs/deploy.md")) ? readFileSync(join(root, "docs/deploy.md"), "utf8") : "";
const optionalSection = /## Optional environment variables\n([\s\S]*?)(\n## |$)/.exec(deployDoc)?.[1] ?? "";
const documented = new Set([...optionalSection.matchAll(/^\|\s*`([A-Z][A-Z0-9_]+)`/gm)].map((m) => m[1]));
if (!optionalSection) fail('docs/deploy.md: no "## Optional environment variables" section');
for (const [k, file] of [...read].sort()) {
  if (webEnv.has(k) || PLATFORM.has(k) || documented.has(k)) continue;
  fail(`${k} (read in ${file}) is neither set in render.yaml nor listed under "Optional environment variables" in docs/deploy.md`);
}
for (const k of documented) if (!read.has(k) && !webEnv.has(k)) fail(`docs/deploy.md lists ${k}, which no code reads (stale row)`);

if (errors.length) {
  for (const e of errors) console.error(`check-render: ${e}`);
  process.exit(1);
}
console.log(`render.yaml ok: ${services.length} service(s), ${databases.length} database(s), ${read.size} env vars read by the code all accounted for`);

#!/usr/bin/env node
// Milestone MCP stdio bridge: for MCP hosts that launch a local command (Claude Desktop, Cursor), forwards every
// JSON-RPC message between stdin/stdout and Milestone's Streamable HTTP endpoint (POST <MILESTONE_URL>/api/mcp) with
// "Authorization: Bearer <MILESTONE_AGENT_TOKEN>". It holds no state and adds no tools: the server decides everything.
//
//   MILESTONE_URL=http://localhost:3000 MILESTONE_AGENT_TOKEN=msa_... node scripts/milestone-mcp.mjs
//
// Diagnostics go to stderr (stdout is the MCP channel). See docs/mcp.md for host configuration.
import { createRequire } from "node:module";

// The SDK is a dependency of apps/web; resolve it from there (this script lives outside any workspace package).
const require = createRequire(new URL("../apps/web/package.json", import.meta.url));
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { StreamableHTTPClientTransport } = require("@modelcontextprotocol/sdk/client/streamableHttp.js");

const log = (...a) => console.error("[milestone-mcp]", ...a);
const token = (process.env.MILESTONE_AGENT_TOKEN ?? "").trim();
const base = (process.env.MILESTONE_URL ?? "http://localhost:3000").trim().replace(/\/+$/, "");
if (!token.startsWith("msa_")) {
  log("MILESTONE_AGENT_TOKEN must be a Milestone mandate token (msa_...). Create one with POST /api/agents.");
  process.exit(2);
}
let endpoint;
try {
  endpoint = new URL(`${base}/api/mcp`);
} catch {
  log(`MILESTONE_URL is not a URL: ${base}`);
  process.exit(2);
}
if (endpoint.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname)) {
  log(`refusing to send the mandate token over plain http to ${endpoint.host}; use https`);
  process.exit(2);
}

const local = new StdioServerTransport();
const remote = new StreamableHTTPClientTransport(endpoint, { requestInit: { headers: { authorization: `Bearer ${token}` } } });

/** A JSON-RPC error back to the host for a request the server could not answer (so it does not hang). */
function failRequest(message, error) {
  if (message && typeof message === "object" && "id" in message && "method" in message) {
    local.send({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: `Milestone MCP endpoint: ${error instanceof Error ? error.message : String(error)}` } }).catch(() => {});
  }
}

local.onmessage = (message) => {
  remote.send(message).catch((e) => {
    log("forward failed:", e instanceof Error ? e.message : e);
    failRequest(message, e);
  });
};
remote.onmessage = (message) => {
  local.send(message).catch((e) => log("reply failed:", e instanceof Error ? e.message : e));
};
remote.onerror = (e) => log("endpoint error:", e instanceof Error ? e.message : e);
local.onerror = (e) => log("stdio error:", e instanceof Error ? e.message : e);

let closing = false;
async function shutdown(code = 0) {
  if (closing) return;
  closing = true;
  await Promise.allSettled([remote.close(), local.close()]);
  process.exit(code);
}
local.onclose = () => void shutdown(0);
process.on("SIGINT", () => void shutdown(0));
process.on("SIGTERM", () => void shutdown(0));

await remote.start();
await local.start();
log(`forwarding to ${endpoint.href}`);

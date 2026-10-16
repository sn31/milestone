import { getDb } from "@/lib/db";
import { handleMcpPost, mcpMethodNotAllowed } from "@/lib/mcp/server";

export const dynamic = "force-dynamic";

/**
 * The Milestone MCP server (Streamable HTTP, stateless, JSON responses). Authenticated by "Authorization: Bearer
 * <mandate token>" (401 without one); the agent acts as the mandate's user through the same routes a human uses.
 * Tools and the guarantee: src/lib/mcp/tools.ts and docs/mcp.md.
 */
export async function POST(req: Request) {
  return handleMcpPost(req, getDb());
}

export async function GET() {
  return mcpMethodNotAllowed();
}

export async function DELETE() {
  return mcpMethodNotAllowed();
}

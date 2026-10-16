// The console's wire protocol: the browser posts a turn to /api/agents/console and reads newline-delimited JSON
// events back. Shared by the route (server) and the console (client); no server imports here.

/** Which MCP server a tool lives on. */
export type ToolServer = "milestone" | "paypal";

export const SERVER_LABEL: Record<ToolServer, string> = { milestone: "Milestone MCP", paypal: "PayPal MCP" };

/** A link a tool result handed back for the human to open (a PayPal approval page). Never followed by the agent. */
export interface ApprovalLink {
  url: string;
  label: string;
}

/** One message of the conversation as the browser keeps it (tool summaries ride along as context for the next turn). */
export interface ConsoleMessage {
  role: "user" | "agent";
  text: string;
  /** Agent turns: "server · tool → one-line result", replayed to the model as untrusted context. */
  calls?: string[];
}

export interface ConsoleRequest {
  mandateId: string;
  token: string;
  messages: ConsoleMessage[];
}

export type ConsoleEvent =
  | { t: "start"; model: string; tools: Array<{ server: ToolServer; name: string }>; notes: string[] }
  | { t: "thinking"; turn: number }
  | { t: "call"; id: string; server: ToolServer; tool: string; args: unknown }
  | { t: "result"; id: string; ok: boolean; summary: string; status: string | null; links: ApprovalLink[] }
  /** notice: set when the reply claims an action that no successful tool call in this turn backs (see claimCheck). */
  | { t: "reply"; text: string; notice?: string }
  | { t: "error"; error: string; reason?: string }
  | { t: "done" };

/** Mandate terms the console shows beside the conversation (serialisable). */
export interface MandateSummary {
  id: string;
  agentName: string;
  actions: string[];
  approveCapMinor: number | null;
  currency: string;
  expiresAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

/** Where the browser keeps a just-created token for this tab only (sessionStorage), keyed by mandate id. */
export const TOKEN_STORAGE_PREFIX = "milestone.agentToken.";

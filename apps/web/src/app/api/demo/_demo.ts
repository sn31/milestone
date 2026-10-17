import { isModelConfigured, providerName } from "@milestone/verify";

/** Demo mode is on only when DEMO_MODE is exactly "1" (the hosted demo on Render sets it in render.yaml). */
export function demoMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.DEMO_MODE?.trim() === "1";
}

/** Seconds between two resets of the demo data, across every visitor of this instance. */
export const RESET_INTERVAL_S = 30;

/** Short-lived cookie the reset route leaves for the banner: "done", or "wait:<seconds>" when it was refused. */
export const DEMO_NOTICE_COOKIE = "milestone_demo_notice";

export type ModelMode = "local" | "claude" | "none";

/** Which judgment is live on this host, from isModelConfigured (never the key itself). */
export async function modelMode(env: NodeJS.ProcessEnv = process.env): Promise<ModelMode> {
  if (!(await isModelConfigured(env))) return "none";
  return providerName(env) === "anthropic" ? "claude" : "local";
}

export const MODEL_MODE_TEXT: Record<ModelMode, string> = {
  local: "Judgment by the local model",
  claude: "Judgment by Claude",
  none: "Judgment goes to the client: no model on this host",
};

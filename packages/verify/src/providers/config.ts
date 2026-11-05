/**
 * Which Claude model the environment selects. llm.ts's modelConfig() adds the availability check on top; the
 * provider reads its default from here, so the rule lives in one place.
 */

export const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-5-5";

export interface ModelSettings {
  /** The model every request uses (Claude reads images and PDFs with the same model). */
  textModel: string;
  /** ANTHROPIC_BASE_URL or the public API (the SDK reads the same variable). */
  baseUrl: string;
}

/**
 * MILESTONE_MODEL when it names a Claude model (claude-*), else the default. A value left over from an old local-model
 * setup (an old .env) is ignored instead of being sent to the API.
 */
export function anthropicModel(env: NodeJS.ProcessEnv = process.env): string {
  const m = env.MILESTONE_MODEL?.trim();
  return m && m.startsWith("claude") ? m : DEFAULT_ANTHROPIC_MODEL;
}

export function modelSettings(env: NodeJS.ProcessEnv = process.env): ModelSettings {
  return { textModel: anthropicModel(env), baseUrl: env.ANTHROPIC_BASE_URL?.trim() || "https://api.anthropic.com" };
}

/**
 * Which model backend and model ids the environment selects. llm.ts's modelConfig() adds the availability check on
 * top; the providers read their defaults from here, so the rules live in one place.
 */

export type ProviderName = "ollama" | "anthropic";

export const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-5-5";
export const DEFAULT_OLLAMA_MODEL = "qwen3:14b";
export const DEFAULT_OLLAMA_VISION_MODEL = "qwen2.5vl:7b";

export interface ModelSettings {
  provider: ProviderName;
  /** The model text requests use. */
  textModel: string;
  /** The model requests that carry an image use (Claude reads images with the text model). */
  visionModel: string;
  /** The server: OLLAMA_HOST for ollama; ANTHROPIC_BASE_URL or the public API for anthropic (the SDK reads the same variable). */
  baseUrl: string;
}

/** "ollama" unless an Anthropic key is set and MODEL_PROVIDER does not say "ollama". MODEL_PROVIDER wins when set. */
export function providerName(env: NodeJS.ProcessEnv = process.env): ProviderName {
  const p = env.MODEL_PROVIDER?.trim().toLowerCase();
  if (p === "ollama" || p === "anthropic") return p;
  return env.ANTHROPIC_API_KEY ? "anthropic" : "ollama";
}

/** OLLAMA_HOST as the ollama CLI reads it ("host:port" or a URL); a bind-all address means this machine. */
export function ollamaBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = (env.OLLAMA_HOST ?? "").trim();
  if (!raw) return "http://localhost:11434";
  const u = new URL(/^https?:\/\//.test(raw) ? raw : `http://${raw}`);
  if (!/^https?:\/\//.test(raw) && !u.port) u.port = "11434";
  if (u.hostname === "0.0.0.0" || u.hostname === "[::]") u.hostname = "localhost";
  return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, "")}`;
}

/**
 * MILESTONE_MODEL for the given provider, else its default. The one naming rule: a Claude id (claude-*) belongs to
 * Anthropic and anything else to Ollama, so a value left over from the other provider (an old .env) is ignored
 * instead of being sent to a server that does not have it.
 */
export function textModelFor(provider: ProviderName, env: NodeJS.ProcessEnv = process.env): string {
  const m = env.MILESTONE_MODEL?.trim();
  if (m && m.startsWith("claude") === (provider === "anthropic")) return m;
  return provider === "anthropic" ? DEFAULT_ANTHROPIC_MODEL : DEFAULT_OLLAMA_MODEL;
}

export function modelSettings(env: NodeJS.ProcessEnv = process.env): ModelSettings {
  const provider = providerName(env);
  const textModel = textModelFor(provider, env);
  if (provider === "anthropic") return { provider, textModel, visionModel: textModel, baseUrl: env.ANTHROPIC_BASE_URL?.trim() || "https://api.anthropic.com" };
  return { provider, textModel, visionModel: env.MILESTONE_VISION_MODEL?.trim() || DEFAULT_OLLAMA_VISION_MODEL, baseUrl: ollamaBaseUrl(env) };
}

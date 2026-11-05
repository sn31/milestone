import { loadRootEnv } from "@milestone/core";

/**
 * Next.js only reads .env files from apps/web; the monorepo keeps one .env at the root. Load it on first import, server
 * side, always (not only when DATABASE_URL is unset: a shell that exports DATABASE_URL still needs ANTHROPIC_API_KEY,
 * APP_URL and the PayPal settings from the file). Anything already set wins (process.loadEnvFile never overrides).
 * instrumentation.ts imports this at server start; modules that read env import it too, so tests and scripts get it.
 */
loadRootEnv();

export { loadRootEnv };

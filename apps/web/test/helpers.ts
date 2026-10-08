import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadRootEnv as loadRepoEnv } from "@milestone/core";

export const e2e = process.env.MILESTONE_E2E === "1";

/** Loads the root .env without overriding anything already set (the web app does the same in lib/db.ts). */
export function loadRootEnv(): void {
  if (!process.env.DATABASE_URL) loadRepoEnv();
}

// Fixtures are plain JSON that tests tweak freely, so they are loosely typed on purpose.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function fixture<T = Record<string, any>>(name: string): T {
  return JSON.parse(readFileSync(resolve(__dirname, "../../../fixtures/webhooks", name), "utf8")) as T;
}

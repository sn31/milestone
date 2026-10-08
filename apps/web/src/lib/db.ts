import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createDb, type Db } from "@milestone/core";

/**
 * Next.js only reads .env files from apps/web; the monorepo keeps one .env at the root. Load it once, server side,
 * without overriding anything already set (process.loadEnvFile never overwrites existing variables).
 */
function loadRootEnv() {
  if (process.env.DATABASE_URL) return;
  for (const candidate of [resolve(process.cwd(), ".env"), resolve(process.cwd(), "../../.env")]) {
    if (!existsSync(candidate)) continue;
    try {
      process.loadEnvFile(candidate);
    } catch {
      // unreadable .env: fall through to the error createDb raises
    }
    if (process.env.DATABASE_URL) return;
  }
}
loadRootEnv();

let db: Db | null = null;
export function getDb(): Db {
  db ??= createDb();
  return db;
}

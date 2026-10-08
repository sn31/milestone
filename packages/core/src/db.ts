import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { loadRootEnv } from "./env.ts";
import * as schema from "./schema.ts";

export type Db = ReturnType<typeof createDb>;
/** The handle inside db.transaction(async (tx) => ...). */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
/** Anything that runs queries: the pool or a transaction. Helpers that only query take this, so no `tx as unknown as Db`. */
export type Executor = Db | Tx;

export function createDb(url = process.env.DATABASE_URL) {
  if (!url) throw new Error("DATABASE_URL is required");
  const pool = new pg.Pool({ connectionString: url });
  return drizzle(pool, { schema });
}

// On globalThis so Next.js HMR (which re-evaluates modules) keeps one pool per process.
const g = globalThis as typeof globalThis & { __milestoneDb?: Db };

/**
 * The process's one Db (one pg pool). Loads the repo-root .env first when DATABASE_URL is not set yet
 * (never overriding variables that are already set).
 */
export function getDb(): Db {
  if (!g.__milestoneDb) {
    if (!process.env.DATABASE_URL) loadRootEnv();
    g.__milestoneDb = createDb();
  }
  return g.__milestoneDb;
}

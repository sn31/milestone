import { getDb, loadRootEnv } from "@milestone/core";

/**
 * Next.js only reads .env files from apps/web; the monorepo keeps one .env at the root. Load it once, server side, on
 * first import (never overriding anything already set), so env read before the first query (PayPal mode, keys) sees it.
 */
if (!process.env.DATABASE_URL) loadRootEnv();

export { getDb, loadRootEnv };

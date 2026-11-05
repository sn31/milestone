// The root .env loads before anything here reads env (PayPal mode, keys); see lib/env.ts.
import { loadRootEnv } from "./env";
import { getDb } from "@milestone/core";

export { getDb, loadRootEnv };

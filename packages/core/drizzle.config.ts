import { defineConfig } from "drizzle-kit";
import { loadRootEnv } from "./src/env.ts";

// drizzle-kit runs in packages/core and only reads a .env there; load the repo-root .env (the one seed, web and
// worker read) so `pnpm db:migrate` targets the same DATABASE_URL. A variable already set in the shell wins.
loadRootEnv();

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./drizzle",
  dbCredentials: { url: process.env.DATABASE_URL || "postgres://milestone:milestone@localhost:5432/milestone" },
});

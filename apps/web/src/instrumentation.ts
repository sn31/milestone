/** Runs once when the server starts, before any request: load the repo-root .env so every env read sees it. */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") await import("./lib/env");
}

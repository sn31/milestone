import { NextResponse } from "next/server";

/** API responses describe live state: never cached by the browser or a proxy. */
export const noStore = { "Cache-Control": "no-store" } as const;

/** A JSON response with Cache-Control: no-store. */
export function json(body: unknown, status = 200, headers?: Record<string, string>) {
  return NextResponse.json(body, { status, headers: { ...noStore, ...headers } });
}

/** { error, ...extra } with the given status and Cache-Control: no-store. */
export function jsonError(error: string, status: number, extra?: Record<string, unknown>) {
  return json({ error, ...extra }, status);
}

/**
 * An absolute URL on this app for a redirect. Behind a proxy (Render) req.url carries the internal host
 * (localhost:10000), so the public base comes from APP_URL when it is set.
 */
export function publicUrl(path: string, req: Request): URL {
  return new URL(path, process.env.APP_URL?.trim() || new URL(req.url).origin);
}

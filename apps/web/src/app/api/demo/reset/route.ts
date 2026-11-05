import { NextResponse } from "next/server";
import { json, jsonError, noStore } from "@/lib/http";
import { DEMO_NOTICE_COOKIE, demoMode } from "../_demo";
import { clearSimulator, clearUploads, createLimiter, runShowcaseSeed } from "./reset";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const limiter = createLimiter();

/** A plain form post from the demo banner gets a redirect with a notice cookie; scripts get JSON. */
function wantsRedirect(req: Request): boolean {
  return /^(application\/x-www-form-urlencoded|multipart\/form-data)/i.test(req.headers.get("content-type") ?? "");
}

/**
 * Where a form post goes next: home after a reset (the page the visitor was on may no longer exist), otherwise back to
 * the same-origin page it came from.
 */
function backTo(req: Request, notice: string): URL {
  const home = new URL("/", req.url);
  if (notice === "done") return home;
  try {
    const from = new URL(req.headers.get("referer") ?? "");
    return from.origin === home.origin ? new URL(from.pathname + from.search, home) : home;
  } catch {
    return home;
  }
}

function back(req: Request, notice: string): Response {
  const res = NextResponse.redirect(backTo(req, notice), { status: 303, headers: noStore });
  res.cookies.set(DEMO_NOTICE_COOKIE, notice, { path: "/", maxAge: 15, sameSite: "lax", httpOnly: true });
  return res;
}

/**
 * POST /api/demo/reset: puts the hosted demo back to the showcase (core seed with --reset --showcase), then empties
 * the PayPal simulator's state and UPLOAD_DIR. Exists only with DEMO_MODE=1 (404 otherwise) and runs at most once every 30 s (429 with Retry-After).
 */
export async function POST(req: Request) {
  if (!demoMode()) return jsonError("not found", 404);
  const form = wantsRedirect(req);
  const wait = limiter.claim();
  if (wait > 0) {
    if (form) return back(req, `wait:${wait}`);
    return NextResponse.json({ error: "the demo was reset less than 30 s ago", retryAfter: wait }, { status: 429, headers: { ...noStore, "Retry-After": String(wait) } });
  }
  // Uploads are cleared BEFORE the seed: a delivery accepted while the seed runs then keeps both its row and its
  // files, instead of keeping the row while this deletes its files and stranding the milestone in verifying.
  await clearUploads().catch((e: Error) => console.error(`demo reset: could not clear uploads: ${e.message}`));
  const result = await runShowcaseSeed();
  if (!result.ok) {
    console.error(`demo reset: ${result.error}`);
    if (form) return back(req, "failed");
    return jsonError("the demo could not be reset", 500);
  }
  // The simulator's orders, payouts and vault tokens belonged to the truncated rows; Casey's seeded saved PayPal is
  // adopted again on first use. The data reset stands if this fails.
  try {
    clearSimulator();
  } catch (e) {
    console.error(`demo reset: could not clear the PayPal simulator: ${(e as Error).message}`);
  }
  if (form) return back(req, "done");
  return json({ ok: true });
}

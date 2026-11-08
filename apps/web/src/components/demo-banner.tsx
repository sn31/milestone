import { cookies } from "next/headers";
import { paypalMode } from "@milestone/core";
import { DEMO_NOTICE_COOKIE, MODEL_MODE_TEXT, PAYPAL_MODE_TEXT, demoMode, modelMode } from "@/app/api/demo/_demo";
import { Button } from "@/components/ui";

/** What the last reset left in the notice cookie, as one line; null when there is nothing to say. */
function noticeText(raw: string | undefined): string | null {
  if (!raw) return null;
  if (raw === "done") return paypalMode() === "sandbox" ? "Demo data reset to the showcase (PayPal's sandbox keeps its own history)." : "Demo reset to the showcase.";
  if (raw === "failed") return "The reset did not complete. Try again in a moment.";
  const wait = /^wait:(\d+)$/.exec(raw);
  if (wait) return `Reset ran moments ago. Try again in ${wait[1]} s.`;
  return null;
}

/**
 * The hosted demo's band above the header (DEMO_MODE=1 only): what kind of money and people this is, which judgment is
 * live on this host, and a reset back to the showcase. The reset is a plain form post (no client JS): the route
 * re-seeds and redirects (home after a reset, back otherwise) with a short notice cookie.
 */
export async function DemoBanner() {
  if (!demoMode()) return null;
  const [mode, jar] = await Promise.all([modelMode(), cookies()]);
  const notice = noticeText(jar.get(DEMO_NOTICE_COOKIE)?.value);
  return (
    <aside aria-label="Demo" className="border-b border-hairline bg-bg-deep">
      <div className="mx-auto flex w-full max-w-content flex-wrap items-center justify-between gap-x-4 gap-y-1.5 px-4 py-1.5 sm:px-6">
        <p className="min-w-0 flex-1 basis-[28rem] font-mono text-[11px] leading-snug text-fg-muted">
          <span className="text-fg">Demo:</span> {PAYPAL_MODE_TEXT[paypalMode()]}
          <span aria-hidden className="mx-2 text-fg-faint">·</span>
          <span className="text-fg-faint">{MODEL_MODE_TEXT[mode]}</span>
          {notice ? (
            <span role="status" className="ml-2 text-fg">
              {notice}
            </span>
          ) : null}
        </p>
        <form action="/api/demo/reset" method="post" className="shrink-0">
          <Button type="submit" variant="ghost" size="sm" className="h-7 px-2.5 text-[12px]">
            Reset demo
          </Button>
        </form>
      </div>
    </aside>
  );
}

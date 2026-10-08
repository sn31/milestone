"use client";

import { useEffect } from "react";
import { Button, Kbd, PageHeader } from "@/components/ui";

/**
 * A segment failed to render. Says plainly that no money moved (rendering never moves money: only the policy executor
 * does, from a job), offers a retry, and shows the digest so the server log line can be found.
 */
export default function Error({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <main>
      <PageHeader
        eyebrow="Error / signal lost"
        title={
          <>
            This page stalled
          </>
        }
        description="Something failed while drawing this page. Nothing moved: payments only happen in the background, after the ledger and PayPal agree."
      />
      <div data-tone="danger" className="mt-12 flex gap-5 rounded-panel border border-dashed border-tone p-6 sm:p-8">
        <svg aria-hidden viewBox="0 0 16 76" className="h-[76px] w-4 shrink-0" fill="none" stroke="currentColor">
          <circle cx="8" cy="7" r="5" strokeWidth="1.2" className="text-fg-faint" />
          <path d="M8 14 V31" strokeWidth="1.2" className="text-fg-faint" />
          <circle cx="8" cy="38" r="5" strokeWidth="1.4" className="text-tone" />
          <path d="M5.5 35.5 L10.5 40.5 M10.5 35.5 L5.5 40.5" strokeWidth="1.4" className="text-tone" />
          <path d="M8 45 V62" strokeDasharray="2 3" strokeWidth="1.2" className="text-fg-faint" opacity="0.5" />
          <circle cx="8" cy="69" r="5" strokeWidth="1.2" className="text-fg-faint" opacity="0.3" />
        </svg>
        <div className="min-w-0">
          <p className="type-display-s text-fg">The rail stopped at this station</p>
          <p className="mt-2 max-w-[52ch] text-fg-muted">Try again. If it keeps failing, the server log has the full error under this reference.</p>
          <p className="mt-4 flex flex-wrap items-center gap-2 font-mono text-[12px] text-fg-faint">
            <span className="type-label">Reference</span>
            <Kbd className="tabular">{error.digest ?? "client"}</Kbd>
            {error.message && !error.digest ? <span className="min-w-0 truncate text-tone">{error.message}</span> : null}
          </p>
          <div className="mt-6 flex flex-wrap gap-2">
            <Button variant="primary" onClick={() => retry()}>
              Try again
            </Button>
            <Button href="/" variant="ghost">
              Back to contracts
            </Button>
          </div>
        </div>
      </div>
    </main>
  );
}

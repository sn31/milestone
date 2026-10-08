"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";

// Minimal local types for the PayPal JS SDK v6 surface we use. Kept local (not a global Window
// augmentation) so other components can type window.paypal their own way.
interface PayPalSession {
  start(options: { presentationMode: "auto" | "popup" | "modal" | "redirect" }, order: Promise<{ orderId: string }>): Promise<void>;
}
interface PayPalSdkInstance {
  findEligibleMethods(options: { currencyCode: string }): Promise<{ isEligible(method: string): boolean }>;
  createPayPalOneTimePaymentSession(callbacks: {
    onApprove: (data: { orderId: string }) => Promise<void>;
    onCancel?: (data?: unknown) => void;
    onError?: (error: unknown) => void;
  }): PayPalSession;
}
interface PayPalNamespace {
  createInstance(options: { clientToken: string; components: string[]; pageType?: string }): Promise<PayPalSdkInstance>;
}
type PayPalWindow = Window & { paypal?: PayPalNamespace };

export type PayPalEnv = "sandbox" | "live";

const SDK_URL: Record<PayPalEnv, string> = {
  sandbox: "https://www.sandbox.paypal.com/web-sdk/v6/core",
  live: "https://www.paypal.com/web-sdk/v6/core",
};

// One script tag and one SDK instance per page, shared by every FundButton on it.
const scriptLoads = new Map<string, Promise<PayPalNamespace>>();
let instance: { env: PayPalEnv; expiresAt: number; promise: Promise<PayPalSdkInstance> } | null = null;

function loadSdk(src: string): Promise<PayPalNamespace> {
  let p = scriptLoads.get(src);
  if (p) return p;
  p = new Promise<PayPalNamespace>((resolve, reject) => {
    const w = window as PayPalWindow;
    if (w.paypal) return resolve(w.paypal);
    let script = document.querySelector<HTMLScriptElement>(`script[src="${src}"]`);
    if (!script) {
      script = document.createElement("script");
      script.src = src;
      script.async = true;
      document.head.appendChild(script);
    }
    const el = script;
    el.addEventListener("load", () => (w.paypal ? resolve(w.paypal) : reject(new Error("PayPal SDK loaded without window.paypal"))), { once: true });
    el.addEventListener(
      "error",
      () => {
        scriptLoads.delete(src);
        el.remove();
        reject(new Error("Could not load the PayPal SDK"));
      },
      { once: true },
    );
  });
  scriptLoads.set(src, p);
  return p;
}

async function errorText(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? `${res.status} ${res.statusText}`;
}

function getInstance(env: PayPalEnv): Promise<PayPalSdkInstance> {
  if (instance && instance.env === env && instance.expiresAt > Date.now()) return instance.promise;
  const entry: NonNullable<typeof instance> = { env, expiresAt: Number.POSITIVE_INFINITY, promise: Promise.resolve(null as never) };
  entry.promise = (async () => {
    const paypal = await loadSdk(SDK_URL[env]);
    const res = await fetch("/api/paypal/client-token", { cache: "no-store" });
    if (!res.ok) throw new Error(`Client token: ${await errorText(res)}`);
    const { accessToken, expiresIn } = (await res.json()) as { accessToken: string; expiresIn: number };
    // Re-mint a minute before the client token expires.
    entry.expiresAt = Date.now() + Math.max(0, expiresIn - 60) * 1000;
    return paypal.createInstance({ clientToken: accessToken, components: ["paypal-payments"], pageType: "checkout" });
  })();
  entry.promise.catch(() => {
    if (instance === entry) instance = null;
  });
  instance = entry;
  return entry.promise;
}

function message(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && typeof (e as { message?: unknown }).message === "string") return (e as { message: string }).message;
  return "Something went wrong with PayPal";
}

/** What the page says when PayPal refuses to open because the tab was not in front. */
export const BACKGROUND_TAB_NOTICE = "Bring this tab to the front and click Fund again.";

/**
 * The SDK refuses to show its payment sheet from a background tab or a preview page ("Cannot show PaymentRequest UI in
 * a preview page or a background tab."). Nothing went wrong with the payment; the click just has to come from the
 * front tab.
 */
export function isBackgroundTabError(e: unknown): boolean {
  return /background tab|preview page|PaymentRequest UI/i.test(message(e));
}

type Phase = "loading" | "ready" | "ineligible" | "unavailable" | "paying" | "capturing" | "pending";

/** "simulated" skips the PayPal SDK and goes through the local simulator (see packages/money/src/paypal/simulated.ts). */
export type PayPalMode = "simulated" | "sandbox";

// Orders whose ?approved= return this page already captured, so a re-render or a Strict Mode re-run does not repeat it.
const capturedReturns = new Set<string>();

async function fetchMode(): Promise<PayPalMode> {
  try {
    const res = await fetch("/api/dev/paypal/mode", { cache: "no-store" });
    if (!res.ok) return "sandbox";
    const { mode } = (await res.json()) as { mode?: string };
    return mode === "simulated" ? "simulated" : "sandbox";
  } catch {
    return "sandbox";
  }
}

export function FundButton(props: { milestoneId: string; currency: string; amountLabel: string; paypalEnv?: PayPalEnv; mode?: string | undefined }) {
  const { milestoneId, currency, amountLabel, paypalEnv = "sandbox" } = props;
  const router = useRouter();
  const [rawPhase, setPhase] = useState<Phase>("loading");
  const [error, setError] = useState<string | null>(null);
  // A friendly note (not an error) when PayPal refused to open from a background tab.
  const [notice, setNotice] = useState<string | null>(null);
  // Set while a refused start waits for the tab to come to the front, to try once more then.
  const retryOnVisible = useRef<(() => void) | null>(null);
  const sdk = useRef<PayPalSdkInstance | null>(null);
  // From the prop when milestone-actions passes it; otherwise asked from the server once.
  const propMode: PayPalMode | undefined = props.mode === undefined || props.mode === "" ? undefined : props.mode === "simulated" ? "simulated" : "sandbox";
  const [askedMode, setAskedMode] = useState<PayPalMode | undefined>(undefined);
  const mode = propMode ?? askedMode;

  useEffect(() => {
    if (propMode !== undefined) return;
    let live = true;
    void fetchMode().then((m) => {
      if (live) setAskedMode(m);
    });
    return () => {
      live = false;
    };
  }, [propMode]);

  useEffect(() => {
    if (mode !== "simulated") return;
    // Back from the simulated approve page: ?approved=<orderId>&milestone=<id>. Capture it, clean the URL, refresh.
    const params = new URLSearchParams(window.location.search);
    const orderId = params.get("approved");
    if (!orderId || params.get("milestone") !== milestoneId || capturedReturns.has(orderId)) return;
    capturedReturns.add(orderId);
    (async () => {
      setPhase("capturing");
      try {
        const status = await capture(orderId);
        setPhase(status === 202 ? "pending" : "capturing");
      } catch (e) {
        capturedReturns.delete(orderId);
        setError(`Payment approved but not recorded yet: ${message(e)}. Try again; you will not be charged twice.`);
        setPhase("ready");
      } finally {
        router.replace(window.location.pathname, { scroll: false });
        router.refresh();
      }
    })();
    // capture is stable for a milestone; router identity is not needed here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, milestoneId]);

  useEffect(() => {
    if (mode !== "sandbox") return;
    let live = true;
    (async () => {
      try {
        const inst = await getInstance(paypalEnv);
        const methods = await inst.findEligibleMethods({ currencyCode: currency });
        if (!live) return;
        sdk.current = inst;
        setPhase(methods.isEligible("paypal") ? "ready" : "ineligible");
      } catch (e) {
        if (!live) return;
        setError(message(e));
        setPhase("unavailable");
      }
    })();
    return () => {
      live = false;
    };
  }, [mode, paypalEnv, currency]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      const retry = retryOnVisible.current;
      retryOnVisible.current = null;
      retry?.();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      retryOnVisible.current = null;
    };
  }, []);

  async function createOrder(): Promise<{ orderId: string }> {
    const res = await fetch(`/api/milestones/${milestoneId}/order`, { method: "POST" });
    if (!res.ok) throw new Error(await errorText(res));
    const { orderId } = (await res.json()) as { orderId: string };
    return { orderId };
  }

  /** Captures the approved order; resolves to the HTTP status (202 = PayPal still processing). */
  async function capture(orderId: string): Promise<number> {
    const res = await fetch(`/api/milestones/${milestoneId}/capture`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orderId }),
    });
    if (!res.ok) throw new Error(await errorText(res));
    return res.status;
  }

  /** Simulated checkout: create the order, then go to its approve link, which comes back here with ?approved=. */
  async function onSimulatedClick() {
    setError(null);
    setPhase("paying");
    try {
      const { orderId } = await createOrder();
      // A full navigation on purpose: the approve route is an API route that answers with a 303 back to this page.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
      window.location.assign(`/api/dev/paypal/approve?order=${encodeURIComponent(orderId)}`);
    } catch (e) {
      setError(message(e));
      setPhase("ready");
    }
  }

  function onClick() {
    retryOnVisible.current = null;
    setNotice(null);
    if (mode === "simulated") {
      void onSimulatedClick();
      return;
    }
    startSession(false);
  }

  /**
   * Opens PayPal's checkout. `retry` is the one automatic attempt made when the tab comes back to the front after the
   * SDK refused to open from the background; if that attempt fails too, the notice stays and the next click tries again.
   * The order route is idempotent per milestone, so a retry gets the same order back.
   */
  function startSession(retry: boolean) {
    const inst = sdk.current;
    if (!inst) return;
    setError(null);
    setPhase("paying");
    const fail = (e: unknown) => {
      setPhase("ready");
      if (isBackgroundTabError(e)) {
        setError(null);
        setNotice(BACKGROUND_TAB_NOTICE);
        if (!retry && document.visibilityState !== "visible") retryOnVisible.current = () => startSession(true);
        return;
      }
      if (retry) return; // keep the notice: the automatic attempt had no click behind it, the next click will
      setNotice(null);
      setError(message(e));
    };
    const session = inst.createPayPalOneTimePaymentSession({
      onApprove: async (data) => {
        setPhase("capturing");
        try {
          const status = await capture(data.orderId);
          setPhase(status === 202 ? "pending" : "capturing");
          router.refresh();
        } catch (e) {
          setError(`Payment approved but not recorded yet: ${message(e)}. Try again; you will not be charged twice.`);
          setPhase("ready");
        }
      },
      onCancel: () => {
        setNotice(null);
        setPhase("ready");
      },
      onError: fail,
    });
    // start() must run synchronously inside the click so the popup is not blocked; the order is created in parallel.
    try {
      session.start({ presentationMode: "auto" }, createOrder()).catch(fail);
    } catch (e) {
      fail(e);
    }
  }

  const simulated = mode === "simulated";
  // Simulated mode has no SDK to load: ready as soon as the mode is known.
  const phase = simulated && rawPhase === "loading" ? "ready" : rawPhase;
  const busy = phase === "loading" || phase === "paying" || phase === "capturing";
  const label =
    phase === "loading" ? "Loading PayPal..." :
    phase === "paying" ? (simulated ? "Opening simulated PayPal..." : "Waiting for PayPal...") :
    phase === "capturing" ? "Confirming payment..." :
    simulated ? "Fund (simulated PayPal)" :
    `Fund ${amountLabel} with PayPal`;

  return (
    <section
      data-tone="funded"
      data-paypal-mode={mode ?? "unknown"}
      aria-label="Fund this milestone"
      className="flex flex-col gap-4 rounded-panel border border-dashed border-hairline-strong px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5"
    >
      <div className="min-w-0">
        <p className="type-label flex items-center gap-2 text-fg">
          <span aria-hidden className="size-1.5 rounded-full bg-tone" />
          Fund this milestone
        </p>
        <p className="mt-1.5 max-w-[52ch] text-[13px] text-fg-muted">
          <span className="font-mono text-fg tabular">{amountLabel}</span> goes into escrow through PayPal and stays there until the work is verified.
        </p>
        {simulated && phase !== "pending" ? (
          <p className="mt-2 flex items-center gap-2 font-mono text-[10.5px] tracking-[0.1em] text-fg-faint uppercase">
            <span className="rounded-chip border border-dashed border-hairline-strong px-1.5 py-0.5">Simulated</span>
            no real money moves
          </p>
        ) : null}
        {phase === "ineligible" ? <p className="mt-2 text-[13px] text-fg-muted">PayPal is not available for {currency} payments here.</p> : null}
        {phase === "pending" ? (
          <p role="status" className="mt-2 flex items-center gap-2 text-[13px] text-tone">
            <span aria-hidden className="size-1.5 animate-pulse-dot rounded-full bg-tone" />
            PayPal is still processing this payment. The milestone shows as funded once it completes.
          </p>
        ) : null}
        {notice && !error ? (
          <p role="status" className="mt-2 text-[13px] text-fg">
            {notice}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="mt-2 text-[13px] text-state-danger">
            {phase === "unavailable" ? `PayPal could not be loaded: ${error}` : error}
          </p>
        ) : null}
      </div>
      {phase !== "ineligible" && phase !== "unavailable" && phase !== "pending" ? (
        <Button
          variant="primary"
          onClick={onClick}
          disabled={busy}
          aria-busy={busy}
          data-paypal-mode={mode ?? "unknown"}
          title={simulated ? `Simulated PayPal checkout for ${amountLabel}` : undefined}
          className="shrink-0 self-start sm:self-auto"
        >
          {busy ? (
            label
          ) : (
            <>
              {simulated ? "Fund" : "Fund with PayPal"} <span className="font-mono tabular">{amountLabel}</span>
            </>
          )}
        </Button>
      ) : null}
    </section>
  );
}

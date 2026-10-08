"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

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
  return "Something went wrong with PayPal";
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
      window.location.assign(`/api/dev/paypal/approve?order=${encodeURIComponent(orderId)}`);
    } catch (e) {
      setError(message(e));
      setPhase("ready");
    }
  }

  function onClick() {
    if (mode === "simulated") {
      void onSimulatedClick();
      return;
    }
    const inst = sdk.current;
    if (!inst) return;
    setError(null);
    setPhase("paying");
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
      onCancel: () => setPhase("ready"),
      onError: (e) => {
        setError(message(e));
        setPhase("ready");
      },
    });
    // start() must run synchronously inside the click so the popup is not blocked; the order is created in parallel.
    session.start({ presentationMode: "auto" }, createOrder()).catch((e: unknown) => {
      setError(message(e));
      setPhase("ready");
    });
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
    <div className="mt-3 space-y-2" data-paypal-mode={mode ?? "unknown"}>
      {simulated && phase !== "pending" && (
        <p className="text-sm text-zinc-500">Simulated PayPal: {amountLabel}. No real money moves; the approve step happens instantly.</p>
      )}
      {phase === "ineligible" && <p className="text-sm text-zinc-500">PayPal is not available for {currency} payments here.</p>}
      {phase === "pending" && <p className="text-sm text-amber-700 dark:text-amber-400">PayPal is still processing this payment. The milestone will show as funded once it completes.</p>}
      {phase !== "ineligible" && phase !== "unavailable" && phase !== "pending" && (
        <button
          type="button"
          onClick={onClick}
          disabled={busy}
          aria-busy={busy}
          data-paypal-mode={mode ?? "unknown"}
          title={simulated ? `Simulated PayPal checkout for ${amountLabel}` : undefined}
          className={
            simulated
              ? "rounded border-2 border-dashed border-amber-500 bg-amber-50 px-4 py-2 text-sm font-medium text-amber-900 hover:brightness-95 disabled:cursor-wait disabled:opacity-60 dark:bg-amber-950 dark:text-amber-100"
              : "rounded bg-[#ffc439] px-4 py-2 text-sm font-medium text-zinc-900 hover:brightness-95 disabled:cursor-wait disabled:opacity-60"
          }
        >
          {label}
        </button>
      )}
      {error && (
        <p role="alert" className="text-sm text-red-700 dark:text-red-400">
          {phase === "unavailable" ? `PayPal could not be loaded: ${error}` : error}
        </p>
      )}
    </div>
  );
}

// The real PayPal sandbox in the demo recorder (--paypal sandbox): PayPal's checkout window and approval pages,
// driven like the rest of the demo with real mouse and key events. The sandbox buyer's credentials come from the
// environment (SANDBOX_CLIENT_EMAIL / SANDBOX_CLIENT_PASSWORD) and are typed into PayPal's own fields only: they are
// never logged, never written to beats.json and never passed on a command line.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Driver, connectNewPage, sleep, targetOpen } from "./cdp.mjs";

const PAYPAL_HOST = /(^|\.)paypal\.com$/;
const isPayPalUrl = (u) => {
  try { return PAYPAL_HOST.test(new URL(u).hostname); } catch { return false; }
};

/** Buttons PayPal shows to approve, in the order they are tried (checkout, then saving a PayPal for later). */
const APPROVE_TEXTS = ["Complete Purchase", "Pay Now", "Continue to Review Order", "Agree and Continue", "Agree & Continue", "Save and Continue", "Continue", "Pay"];

/** What the page shows when PayPal decided the browser is a bot. */
const CHALLENGE = /security challenge|captcha|verify (that )?you('| a)re (a )?human|are you a robot|unusual activity|we're having trouble|something went wrong/i;

/** The buyer from the environment; throws (naming the variables, not their values) when either is missing. */
export function sandboxBuyer(env) {
  const email = env.SANDBOX_CLIENT_EMAIL?.trim();
  const password = env.SANDBOX_CLIENT_PASSWORD;
  if (!email || !password) throw new Error("the sandbox recording needs SANDBOX_CLIENT_EMAIL and SANDBOX_CLIENT_PASSWORD (the sandbox buyer account) in the environment or .env");
  return { email, password };
}

/** Visible inputs and buttons on the page, for the failure report (values are never read). */
async function inventory(d) {
  return d.eval(`(() => {
    const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const inputs = [...document.querySelectorAll("input")].filter(vis).map((e) => ({ id: e.id, name: e.name, type: e.type }));
    const buttons = [...document.querySelectorAll("button, [role=button], input[type=submit]")].filter(vis).map((e) => ({ id: e.id, text: (e.innerText || e.value || "").trim().slice(0, 40) }));
    return { url: location.href.split("?")[0], title: document.title, inputs, buttons, text: (document.body?.innerText || "").replace(/\\s+/g, " ").slice(0, 400) };
  })()`).catch((e) => ({ error: e.message }));
}

/** Saves a screenshot and the page inventory under <outDir>/paypal/<label>.* for a failure report. */
async function snapshot(d, outDir, label) {
  try {
    const dir = join(outDir, "paypal");
    mkdirSync(dir, { recursive: true });
    const shot = await d.cdp.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(dir, `${label}.png`), Buffer.from(shot.data, "base64"));
    writeFileSync(join(dir, `${label}.json`), JSON.stringify(await inventory(d), null, 2) + "\n");
    return join(dir, `${label}.png`);
  } catch {
    return null;
  }
}

/** Polls the PayPal page until one of the states is reached; returns its name. */
async function waitState(d, states, timeout) {
  const end = Date.now() + timeout;
  for (;;) {
    for (const [name, expr] of Object.entries(states)) {
      try { if (await d.eval(expr)) return name; } catch { /* navigating */ }
    }
    if (d.cdp.closed) return "closed";
    if (Date.now() > end) return "timeout";
    await sleep(400);
  }
}

// "Usable": on screen and the topmost element at its centre (PayPal keeps the password step in the DOM, sized but
// hidden behind the email step, until Next is clicked).
const visibleSel = (sel) => `(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; const r = e.getBoundingClientRect(); if (r.width <= 0 || r.height <= 0 || r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) return false; const s = getComputedStyle(e); if (s.visibility === "hidden" || s.opacity === "0") return false; const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !!at && (at === e || e.contains(at) || at.contains(e) || (e.labels && [...e.labels].some((l) => l.contains(at)))); })()`;
const buttonWithText = (texts) => `(() => { const want = ${JSON.stringify(texts.map((t) => t.toLowerCase()))}; return [...document.querySelectorAll("button, [role=button], input[type=submit]")].some((e) => { const r = e.getBoundingClientRect(); const t = (e.innerText || e.value || "").replace(/\\s+/g, " ").trim().toLowerCase(); return r.width > 0 && r.height > 0 && !e.disabled && want.includes(t); }); })()`;
const bodyMatches = (re) => `${re}.test(document.body ? document.body.innerText : "")`;
const approveVisible = `(() => { const want = ${JSON.stringify(APPROVE_TEXTS.map((t) => t.toLowerCase()))}; return [...document.querySelectorAll("button, [role=button], input[type=submit]")].some((e) => { const r = e.getBoundingClientRect(); const t = (e.innerText || e.value || "").replace(/\\s+/g, " ").trim().toLowerCase(); return r.width > 0 && r.height > 0 && !e.disabled && want.includes(t); }); })()`;

/**
 * Logs the sandbox buyer in on a PayPal page (email, Next, password, Log In; or both fields on one page) and approves
 * (Complete Purchase / Pay / Agree and Continue). `d` drives the PayPal page. Returns notes for beats.json; throws with
 * a description of what PayPal showed (and leaves a screenshot) when it cannot go on, e.g. a bot challenge.
 */
export async function paypalLoginAndApprove(d, buyer, { outDir, note = () => {}, timeout = 90_000 } = {}) {
  // A challenge PayPal actually shows: a visible captcha frame or block (PayPal keeps an invisible one on every login
  // page), or the challenge wording on the page.
  const challenge = `(() => [...document.querySelectorAll("iframe[src*=captcha], iframe[title*=captcha i], iframe[src*=hcaptcha], #captcha-standalone, [data-testid=captcha]")].some((e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 60 && r.height > 60 && s.visibility !== "hidden" && s.opacity !== "0"; }) || ${bodyMatches(CHALLENGE)})()`;
  const loginButton = buttonWithText(["Log In", "Log in"]);
  const nextButton = buttonWithText(["Next"]);
  const fail = async (label, why) => {
    const shot = await snapshot(d, outDir, label);
    throw new Error(`${why}${shot ? ` (screenshot ${shot})` : ""}`);
  };
  const clickText = async (texts, label) => {
    for (const text of texts) {
      try {
        await d.click({ selector: "button, [role=button], input[type=submit]", text, exact: true }, { timeout: 1500 });
        return;
      } catch { /* the next label */ }
    }
    await fail(label, `PayPal's ${texts[0]} button could not be clicked`);
  };
  // Cookie banner first, when there is one.
  await d.click({ selector: "#acceptAllButton" }, { timeout: 3000 }).catch(() => {});

  // 1. Email (or straight to approval when PayPal remembers the buyer).
  let s = await waitState(d, { challenge, approve: approveVisible, email: visibleSel("#email") }, timeout);
  note(`paypal page: ${s}`);
  if (s === "closed") return "closed";
  if (s === "timeout") return fail("timeout", "PayPal's page showed neither a login form nor an approve button");
  if (s === "challenge") return fail("challenge", "PayPal showed a security challenge (bot check) instead of the login");
  if (s === "email") {
    await d.type({ selector: "#email" }, buyer.email, { perChar: 10 });
    // Two steps (email, Next, then password) unless the Log In button is on this page already.
    if (!(await d.eval(loginButton).catch(() => false)) && (await d.eval(nextButton).catch(() => false))) {
      await clickText(["Next"], "next");
    }
    // 2. Password.
    s = await waitState(d, { challenge, approve: approveVisible, login: loginButton }, timeout);
    note(`paypal page: ${s === "login" ? "password" : s}`);
    if (s === "challenge") return fail("challenge", "PayPal showed a security challenge (bot check) after the email");
    if (s === "timeout") return fail("password-timeout", "PayPal did not show the password step");
    if (s === "login") {
      await d.type({ selector: "#password" }, buyer.password, { perChar: 10 });
      await clickText(["Log In", "Log in"], "login");
      note("logged in to PayPal as the sandbox buyer");
      // 3. Approval.
      s = await waitState(d, { challenge, approve: approveVisible, again: `(${loginButton}) && !!document.querySelector("#password") && !document.querySelector("#password").value` }, timeout);
      note(`paypal page: ${s}`);
      if (s === "challenge") return fail("challenge", "PayPal showed a security challenge (bot check) after the password");
      if (s === "again") return fail("login-again", "PayPal asked for the login again (wrong sandbox buyer credentials, or a verification step)");
      if (s === "timeout") return fail("approve-timeout", "PayPal did not show an approve button after the login");
    }
  }
  if (s === "closed") return "closed";
  if (s !== "approve") return fail("unexpected", `PayPal's page ended in state ${s}`);
  await sleep(1000);
  await clickText(APPROVE_TEXTS, "approve");
  note("approved at PayPal");
  // The checkout window closes itself after approval; a full-page flow navigates back to the app.
  return "approved";
}

/**
 * The client funds a milestone through PayPal's real sandbox checkout: clicks PayPal's button on the station, follows
 * the checkout window PayPal opens (recorded in place of the app while it is open), logs in as the sandbox buyer,
 * approves, and waits for the window to close and the app to capture. `ctx` is the recorder's beat context.
 */
export async function sandboxCheckout(ctx, title) {
  const { d } = ctx;
  const buyer = sandboxBuyer(ctx.env);
  // PayPal's own button (the SDK's <paypal-button>) on the first unfunded milestone, else the app's "Fund" button.
  try {
    await d.click({ within: title, selector: "paypal-button" }, { timeout: 30_000 });
  } catch {
    await d.click({ within: title, text: "Fund" }, { timeout: 10_000 });
  }
  const popup = await connectNewPage(ctx.cdpPort, { exceptId: d.cdp.targetId, match: isPayPalUrl, timeout: 30_000 });
  if (!popup) {
    // Some presentations open PayPal in the same tab (a redirect) or as an overlay: try the page itself.
    const here = await d.eval("location.href").catch(() => "");
    if (!isPayPalUrl(here)) throw new Error(`PayPal's checkout window did not open (page at ${here})`);
    ctx.note("PayPal checkout opened in the same tab");
    await paypalLoginAndApprove(d, buyer, { outDir: ctx.outDir, note: ctx.note });
    return;
  }
  ctx.note("PayPal checkout window opened");
  const pd = new Driver(popup, { baseUrl: "", width: ctx.width, height: ctx.height, log: () => {} });
  await pd.init();
  await pd.settle(1500);
  // While the checkout window is open the video shows it (the app's tab only shows PayPal's dimmed overlay).
  if (ctx.recorder && !ctx.recorder.pausedAt) await ctx.recorder.switchTo(popup).catch(() => {});
  try {
    const outcome = await paypalLoginAndApprove(pd, buyer, { outDir: ctx.outDir, note: ctx.note });
    // The window closes on approval; wait for it (or for it to have navigated away from PayPal).
    const end = Date.now() + 60_000;
    while (Date.now() < end && (await targetOpen(ctx.cdpPort, popup.targetId))) await sleep(500);
    ctx.note(`PayPal checkout ${outcome === "closed" ? "closed" : "approved and closed"}`);
  } finally {
    if (ctx.recorder) await ctx.recorder.switchTo(d.cdp).catch(() => {});
    popup.close();
  }
}

/**
 * Saving a PayPal for agents on the real sandbox (/agents, "Save PayPal for agent payments"): the app sends the page to
 * PayPal's approval, the buyer logs in and agrees, and PayPal sends the page back to /api/vault/return.
 */
export async function sandboxVaultApproval(ctx) {
  const { d } = ctx;
  const buyer = sandboxBuyer(ctx.env);
  await d.waitFor(`/paypal\\.com$/.test(location.hostname)`, { timeout: 30_000, what: "PayPal's approval page" });
  await d.settle(1500);
  await paypalLoginAndApprove(d, buyer, { outDir: ctx.outDir, note: ctx.note });
  await d.waitFor(`!/paypal\\.com$/.test(location.hostname)`, { timeout: 60_000, what: "back from PayPal" });
  await d.settle(1200);
}

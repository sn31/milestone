// Chrome DevTools Protocol over Node's built-in WebSocket: a client, a screencast recorder that samples a constant
// frame rate, and page helpers that drive the real UI with a visible cursor (mouse events, typed text, file inputs).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { jpegSize } from "./jpeg.mjs";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Connects to the first page target of the Chrome listening on `port` (creating one if there is none). */
export async function connect(port) {
  const base = `http://127.0.0.1:${port}`;
  const targets = await (await fetch(`${base}/json/list`)).json();
  let page = targets.find((t) => t.type === "page");
  if (!page) page = await (await fetch(`${base}/json/new?about:blank`, { method: "PUT" })).json();
  const c = await connectWs(page.webSocketDebuggerUrl);
  c.targetId = page.id;
  return c;
}

/**
 * Waits for a page target other than `exceptId` whose URL passes `match` (a popup the page opened, e.g. PayPal's
 * checkout window) and connects to it. Returns null on timeout.
 */
export async function connectNewPage(port, { exceptId, match, timeout = 30_000 }) {
  const base = `http://127.0.0.1:${port}`;
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const targets = await (await fetch(`${base}/json/list`)).json().catch(() => []);
    const page = targets.find((t) => t.type === "page" && t.id !== exceptId && match(t.url ?? ""));
    if (page) {
      const c = await connectWs(page.webSocketDebuggerUrl);
      c.targetId = page.id;
      return c;
    }
    await sleep(250);
  }
  return null;
}

/** True while the page target `id` is still open. */
export async function targetOpen(port, id) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json().catch(() => []);
  return targets.some((t) => t.id === id);
}

/** A CDP client over one target's WebSocket. */
export async function connectWs(url) {
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  let id = 0;
  const pending = new Map();
  const listeners = new Set();
  const logs = [];
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(typeof ev.data === "string" ? ev.data : Buffer.from(ev.data).toString());
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject, method } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(`${method}: ${JSON.stringify(msg.error)}`));
      else resolve(msg.result);
      return;
    }
    if (msg.method === "Runtime.exceptionThrown") logs.push(`[exception] ${msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text}`.slice(0, 600));
    if (msg.method === "Network.responseReceived" && msg.params.response.status >= 400) logs.push(`[http ${msg.params.response.status}] ${msg.params.response.url}`);
    for (const l of listeners) l(msg);
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      if (client.closed) return reject(new Error(`${method}: target closed`));
      const i = ++id;
      pending.set(i, { resolve, reject, method });
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  const on = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
  const waitEvent = (name, ms = 30_000, pred = () => true) =>
    new Promise((resolve) => {
      const off = on((m) => { if (m.method === name && pred(m.params)) { clearTimeout(t); off(); resolve(m.params); } });
      const t = setTimeout(() => { off(); resolve(null); }, ms);
    });
  const client = { send, on, waitEvent, logs, closed: false, close: () => ws.close() };
  ws.addEventListener("close", () => {
    client.closed = true;
    for (const [, p] of pending) p.reject(new Error(`${p.method}: target closed`));
    pending.clear();
  });
  return client;
}

/**
 * Page.startScreencast sends a JPEG whenever the page repaints. The recorder keeps the latest one and samples it at a
 * constant `fps` against the wall clock (missed ticks are filled with the frame that was on screen), writing each
 * distinct frame once to <dir>/frames/NNNNNN.jpg. pause()/resume() cut a stretch out of the timeline (off-camera setup).
 */
export class Recorder {
  constructor(cdp, { dir, fps = 10, quality = 72, width = 1440, height = 900 }) {
    Object.assign(this, { cdp, dir, fps, quality, width, height });
    this.framesDir = join(dir, "frames");
    this.files = []; // distinct frame files, in order
    this.ticks = []; // per video tick: index into files
    this.latest = null; // { buf, n }
    this.latestN = 0;
    this.writtenN = -1;
    this.skipped = 0;
    this.recording = false;
    this.pausedAt = null;
    this.pausedMs = 0;
  }

  async start() {
    mkdirSync(this.framesDir, { recursive: true });
    await this.listen();
    this.t0 = Date.now();
    this.recording = true;
    this.timer = setInterval(() => this.tick(), Math.max(10, Math.floor(1000 / this.fps / 3)));
  }

  /**
   * Records another target from now on (a popup such as PayPal's checkout window, whose viewport the caller sets to
   * the recorder's size), keeping the same timeline; switchTo(original) goes back.
   */
  async switchTo(cdp) {
    this.off?.();
    await this.cdp.send("Page.stopScreencast").catch(() => {});
    this.cdp = cdp;
    await this.listen();
  }

  async listen() {
    this.off = this.cdp.on((m) => {
      if (m.method !== "Page.screencastFrame") return;
      this.cdp.send("Page.screencastFrameAck", { sessionId: m.params.sessionId }).catch(() => {});
      const buf = Buffer.from(m.params.data, "base64");
      const size = jpegSize(buf);
      if (!size || size.width !== this.width || size.height !== this.height) { this.skipped++; return; }
      this.latest = buf;
      this.latestN++;
    });
    await this.cdp.send("Page.startScreencast", { format: "jpeg", quality: this.quality, maxWidth: this.width, maxHeight: this.height, everyNthFrame: 1 });
  }

  /** Milliseconds of video recorded so far (wall clock minus paused stretches). */
  videoMs(now = Date.now()) {
    if (!this.t0) return 0;
    const paused = this.pausedMs + (this.pausedAt ? now - this.pausedAt : 0);
    return now - this.t0 - paused;
  }

  tick() {
    if (!this.recording || this.pausedAt || !this.latest) return;
    const due = Math.floor(this.videoMs() / (1000 / this.fps));
    while (this.ticks.length < due) {
      if (this.writtenN !== this.latestN) {
        const name = `${String(this.files.length + 1).padStart(6, "0")}.jpg`;
        writeFileSync(join(this.framesDir, name), this.latest);
        this.files.push(name);
        this.writtenN = this.latestN;
      }
      this.ticks.push(this.files.length - 1);
    }
  }

  pause() { if (!this.pausedAt) { this.tick(); this.pausedAt = Date.now(); } }
  resume() { if (this.pausedAt) { this.pausedMs += Date.now() - this.pausedAt; this.pausedAt = null; } }

  async stop() {
    this.resume();
    this.tick();
    this.recording = false;
    clearInterval(this.timer);
    this.off?.();
    await this.cdp.send("Page.stopScreencast").catch(() => {});
    const index = { fps: this.fps, width: this.width, height: this.height, files: this.files, ticks: this.ticks, skippedFrames: this.skipped };
    writeFileSync(join(this.framesDir, "index.json"), JSON.stringify(index));
    return index;
  }
}

// In-page helpers: a cursor overlay that survives navigations (position kept in sessionStorage) and element lookup.
const PAGE_LIB = String.raw`(() => {
  if (window.__demo) return;
  const KEY = "__demo_cursor";
  let pos = { x: 720, y: 450 };
  try { pos = JSON.parse(sessionStorage.getItem(KEY)) || pos; } catch {}
  let cursor = null;
  const ensure = () => {
    if (cursor && cursor.isConnected) return cursor;
    if (!document.documentElement) return null;
    cursor = document.createElement("div");
    cursor.setAttribute("aria-hidden", "true");
    cursor.style.cssText = "position:fixed;left:0;top:0;width:22px;height:22px;z-index:2147483647;pointer-events:none;transition:transform 520ms cubic-bezier(.2,.7,.2,1);will-change:transform";
    cursor.innerHTML = '<svg width="22" height="22" viewBox="0 0 22 22"><path d="M3 2l14 8.2-6.1 1.4L8 18z" fill="#fff" stroke="#0b0d12" stroke-width="1.4" stroke-linejoin="round"/></svg>';
    cursor.style.transform = "translate(" + (pos.x - 3) + "px," + (pos.y - 2) + "px)";
    document.documentElement.appendChild(cursor);
    return cursor;
  };
  const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none"; };
  const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
  window.__demo = {
    move(x, y) { pos = { x, y }; try { sessionStorage.setItem(KEY, JSON.stringify(pos)); } catch {} const c = ensure(); if (c) c.style.transform = "translate(" + (x - 3) + "px," + (y - 2) + "px)"; },
    ripple(x, y) {
      const r = document.createElement("div");
      r.style.cssText = "position:fixed;left:" + (x - 14) + "px;top:" + (y - 14) + "px;width:28px;height:28px;border-radius:50%;border:2px solid rgba(255,255,255,.85);z-index:2147483646;pointer-events:none;transition:transform 420ms ease-out,opacity 420ms ease-out";
      document.documentElement.appendChild(r);
      requestAnimationFrame(() => { r.style.transform = "scale(1.9)"; r.style.opacity = "0"; });
      setTimeout(() => r.remove(), 500);
    },
    /** Finds the element for spec { selector?, text?, exact?, within?, nth? }; tags it data-demo-hit. */
    find(spec) {
      let root = document;
      if (spec.within) {
        // Milestone stations first (the rail is <ol aria-label="<contract>: milestones">), then any list item.
        let items = [...document.querySelectorAll('ol[aria-label$=": milestones"] > li')].filter((li) => norm(li.innerText).includes(spec.within));
        if (!items.length) items = [...document.querySelectorAll("li")].filter((li) => norm(li.innerText).includes(spec.within));
        items.sort((a, b) => a.innerText.length - b.innerText.length);
        if (!items[0]) return null;
        root = items[0];
      }
      let els = [...root.querySelectorAll(spec.selector || "button, a, [role=button], input[type=submit]")].filter(visible);
      // Case-insensitive: labels are often uppercased with CSS, and innerText returns the rendered case.
      const want = spec.text ? spec.text.toLowerCase() : null;
      if (want) els = els.filter((e) => { const t = norm(e.innerText || e.value || e.getAttribute("aria-label")).toLowerCase(); return spec.exact ? t === want : t.includes(want); });
      if (spec.enabled) els = els.filter((e) => !e.disabled);
      // selector "*" means "whatever shows this text": take the innermost element.
      if (spec.selector === "*") els.sort((a, b) => norm(a.innerText).length - norm(b.innerText).length);
      const el = els[spec.nth || 0];
      if (!el) return null;
      document.querySelectorAll("[data-demo-hit]").forEach((e) => e.removeAttribute("data-demo-hit"));
      el.setAttribute("data-demo-hit", "1");
      return el;
    },
    /** Scrolls the hit element towards the middle when it is not comfortably on screen; true when it scrolled. */
    reveal(block) {
      const el = document.querySelector("[data-demo-hit]");
      if (!el) return false;
      const r = el.getBoundingClientRect();
      if (r.top >= 80 && r.bottom <= innerHeight - 80 && !block) return false;
      // "start" leaves room for the sticky header; otherwise the browser's own alignment.
      if (block === "start") window.scrollTo({ top: Math.max(0, r.top + scrollY - 96), behavior: "smooth" });
      else el.scrollIntoView({ behavior: "smooth", block: block || "center" });
      return true;
    },
    rect() { const el = document.querySelector("[data-demo-hit]"); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height, disabled: !!el.disabled }; },
    ensure,
  };
  // Hide the Next.js dev-tools badge (a <nextjs-portal> element) so the recording looks like the deployed app.
  const hideDevBadge = () => {
    if (!document.head || document.getElementById("__demo_style")) return;
    const st = document.createElement("style");
    st.id = "__demo_style";
    st.textContent = "nextjs-portal{display:none!important}";
    document.head.appendChild(st);
  };
  const boot = () => { ensure(); hideDevBadge(); };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true }); else boot();
})()`;

/** High-level driving of one page: navigation, role switching, clicks and typing with a visible cursor. */
export class Driver {
  constructor(cdp, { baseUrl, width = 1440, height = 900, log = () => {} }) {
    Object.assign(this, { cdp, baseUrl, width, height, log });
  }

  async init() {
    const { send } = this.cdp;
    await send("Page.enable");
    await send("Runtime.enable");
    await send("DOM.enable");
    await send("Network.enable");
    await send("Emulation.setDeviceMetricsOverride", { width: this.width, height: this.height, deviceScaleFactor: 1, mobile: false });
    await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }, { name: "prefers-reduced-motion", value: "no-preference" }] });
    await send("Page.addScriptToEvaluateOnNewDocument", { source: PAGE_LIB });
  }

  async eval(expr) {
    const r = await this.cdp.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  }

  /** Waits until the document is complete and the page has had a moment to hydrate and paint. */
  async settle(extraMs = 700) {
    for (let i = 0; i < 120; i++) {
      try { if ((await this.eval("document.readyState")) === "complete") break; } catch { /* navigating */ }
      await sleep(250);
    }
    await this.eval(PAGE_LIB).catch(() => {});
    await sleep(extraMs);
  }

  async go(path) {
    const url = path.startsWith("http") ? path : this.baseUrl + path;
    const loaded = this.cdp.waitEvent("Page.loadEventFired", 120_000);
    await this.cdp.send("Page.navigate", { url });
    await loaded;
    await this.settle();
  }

  async reload() {
    const loaded = this.cdp.waitEvent("Page.loadEventFired", 120_000);
    await this.cdp.send("Page.reload", {});
    await loaded;
    await this.settle();
  }

  /** Polls `expr` in the page until it is truthy. */
  async waitFor(expr, { timeout = 30_000, every = 300, what = expr } = {}) {
    const end = Date.now() + timeout;
    for (;;) {
      try { const v = await this.eval(expr); if (v) return v; } catch { /* page navigating */ }
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await sleep(every);
    }
  }

  async waitText(text, opts = {}) {
    return this.waitFor(`document.body && document.body.innerText.toLowerCase().includes(${JSON.stringify(text.toLowerCase())})`, { what: `text "${text}"`, ...opts });
  }

  /** Locates spec, scrolls it into view and returns its centre. */
  async locate(spec, { timeout = 20_000 } = {}) {
    await this.waitFor(`!!window.__demo && !!window.__demo.find(${JSON.stringify(spec)})`, { timeout, what: JSON.stringify(spec) });
    if (await this.eval(`window.__demo.reveal(${JSON.stringify(spec.block ?? null)})`)) await sleep(900);
    const r = await this.eval("window.__demo.rect()");
    if (!r) throw new Error(`lost ${JSON.stringify(spec)} after scrolling`);
    return r;
  }

  async moveCursor(x, y, ms = 600) {
    await this.eval(`window.__demo && window.__demo.move(${x}, ${y})`).catch(() => {});
    await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await sleep(ms);
  }

  /** Moves the cursor to spec and clicks it with real mouse events. */
  async click(spec, { timeout } = {}) {
    if (spec.enabled === undefined) spec = { ...spec, enabled: true };
    const r = await this.locate(spec, { timeout });
    await this.moveCursor(r.x, r.y);
    await this.eval(`window.__demo.ripple(${r.x}, ${r.y})`).catch(() => {});
    const base = { x: r.x, y: r.y, button: "left", clickCount: 1 };
    await this.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", ...base });
    await sleep(60);
    await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...base });
    this.log(`click ${spec.text ?? spec.selector}${spec.within ? ` (in "${spec.within}")` : ""}`);
  }

  /** Clicks a text field and types into it a character at a time (clearing what was there). */
  async type(spec, text, { perChar = 14 } = {}) {
    await this.click({ ...spec, enabled: false });
    await this.eval(`(() => { const el = document.querySelector("[data-demo-hit]"); el.focus(); el.select && el.select(); })()`);
    await this.cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
    await this.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
    // Long values go in a few chunks so the field visibly fills without taking seconds.
    const step = text.length > 40 ? Math.ceil(text.length / 30) : 1;
    for (let i = 0; i < text.length; i += step) {
      await this.cdp.send("Input.insertText", { text: text.slice(i, i + step) });
      await sleep(perChar);
    }
  }

  /** Sets files on an <input type=file> (no native picker in headless Chrome). */
  async upload(selector, files) {
    const r = await this.locate({ selector });
    await this.moveCursor(r.x, r.y);
    const doc = await this.cdp.send("DOM.getDocument", { depth: 0 });
    const q = await this.cdp.send("DOM.querySelector", { nodeId: doc.root.nodeId, selector });
    if (!q.nodeId) throw new Error(`no file input ${selector}`);
    await this.cdp.send("DOM.setFileInputFiles", { nodeId: q.nodeId, files });
    this.log(`upload ${files.length} files`);
  }

  /** Switches the demo identity with the header's role switcher (a server action; no navigation). */
  async role(userId) {
    const pressed = `!!document.querySelector('button[name=actor][value=${userId}][aria-pressed=true]')`;
    if (await this.eval(pressed).catch(() => false)) return;
    await this.click({ selector: `button[name=actor][value=${userId}]` });
    await this.waitFor(pressed, { timeout: 20_000, what: `role ${userId}` });
    await sleep(600);
  }

  /** Smoothly scrolls the page so the element for spec sits at `block` (start|center|end). */
  async show(spec, block = "start") {
    await this.waitFor(`!!window.__demo && !!window.__demo.find(${JSON.stringify(spec)})`, { timeout: 20_000, what: JSON.stringify(spec) });
    await this.eval(`window.__demo.reveal(${JSON.stringify(block)})`);
    await sleep(1000);
  }

  async scrollTop() {
    await this.eval(`window.scrollTo({ top: 0, behavior: "smooth" })`);
    await sleep(800);
  }
}

import { randomBytes } from "node:crypto";

export interface PayPalConfig {
  clientId: string;
  clientSecret: string;
  env: "sandbox" | "live";
  fetchImpl?: typeof fetch;
}

export class PayPalError extends Error {
  constructor(public status: number, public body: unknown, public debugId?: string) {
    super(`PayPal ${status}${debugId ? ` (debug_id ${debugId})` : ""}: ${JSON.stringify(body).slice(0, 500)}`);
  }
}

export interface RequestOptions {
  /** Idempotency key. REQUIRED for every POST that moves money; taken from a paypal_ops row. */
  requestId?: string;
  headers?: Record<string, string>;
}

export class PayPalClient {
  readonly baseUrl: string;
  private token: { value: string; expiresAt: number } | null = null;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly cfg: PayPalConfig) {
    this.baseUrl = cfg.env === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
    this.fetchImpl = cfg.fetchImpl ?? fetch;
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env, prefix = "PAYPAL_"): PayPalClient {
    const clientId = env[`${prefix}CLIENT_ID`];
    const clientSecret = env[`${prefix}CLIENT_SECRET`];
    if (!clientId || !clientSecret) throw new Error(`${prefix}CLIENT_ID and ${prefix}CLIENT_SECRET are required`);
    const cfg: PayPalConfig = { clientId, clientSecret, env: env.PAYPAL_ENV === "live" ? "live" : "sandbox" };
    return new PayPalClient(cfg);
  }

  private basicAuth(): string {
    return "Basic " + Buffer.from(`${this.cfg.clientId}:${this.cfg.clientSecret}`).toString("base64");
  }

  /** Server access token, cached until a minute before expiry. */
  async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt - 60_000 > Date.now()) return this.token.value;
    const res = await this.fetchImpl(`${this.baseUrl}/v1/oauth2/token`, {
      method: "POST",
      headers: { Authorization: this.basicAuth(), "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials",
    });
    const body = (await res.json()) as { access_token?: string; expires_in?: number; error?: string };
    if (!res.ok || !body.access_token) throw new PayPalError(res.status, body);
    this.token = { value: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 300) * 1000 };
    return this.token.value;
  }

  /** Browser token for JS SDK v6 `createInstance({ clientToken })`. Short-lived; mint per page load. */
  async clientToken(): Promise<{ accessToken: string; expiresIn: number }> {
    const res = await this.fetchImpl(`${this.baseUrl}/v1/oauth2/token`, {
      method: "POST",
      headers: { Authorization: this.basicAuth(), "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials&response_type=client_token&intent=sdk_init",
    });
    const body = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!res.ok || !body.access_token) throw new PayPalError(res.status, body);
    return { accessToken: body.access_token, expiresIn: body.expires_in ?? 900 };
  }

  async request<T>(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: unknown, opts: RequestOptions = {}): Promise<T> {
    return this.send<T>(method, path, body === undefined ? null : JSON.stringify(body), "application/json", opts);
  }

  /** A multipart/form-data POST (e.g. dispute evidence) with the same token, PayPal-Request-Id and error handling. */
  async requestMultipart<T>(path: string, parts: MultipartPart[], opts: RequestOptions = {}): Promise<T> {
    const { body, contentType } = multipartBody(parts);
    return this.send<T>("POST", path, body, contentType, opts);
  }

  private async send<T>(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body: string | Uint8Array<ArrayBuffer> | null, contentType: string, opts: RequestOptions): Promise<T> {
    if (method === "POST" && !opts.requestId && isMoneyPath(path)) {
      throw new Error(`PayPal-Request-Id is required for ${path}`);
    }
    const headers: Record<string, string> = {
      Authorization: `Bearer ${await this.accessToken()}`,
      "Content-Type": contentType,
      ...opts.headers,
    };
    if (opts.requestId) headers["PayPal-Request-Id"] = opts.requestId;

    const res = await this.fetchImpl(`${this.baseUrl}${path}`, { method, headers, body });
    const text = await res.text();
    const json: unknown = text ? JSON.parse(text) : null;
    if (!res.ok) throw new PayPalError(res.status, json, res.headers.get("paypal-debug-id") ?? undefined);
    return json as T;
  }
}

/** One part of a multipart/form-data body. */
export interface MultipartPart {
  name: string;
  filename?: string;
  contentType: string;
  data: Uint8Array | string;
}

/** Builds a multipart/form-data body by hand so each part's headers are exactly what PayPal documents. */
export function multipartBody(parts: MultipartPart[], boundary = `----milestone${randomBytes(12).toString("hex")}`): { body: Uint8Array<ArrayBuffer>; contentType: string } {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const quote = (s: string) => s.replace(/["\r\n\\]/g, "_");
  for (const p of parts) {
    const disposition = `form-data; name="${quote(p.name)}"${p.filename !== undefined ? `; filename="${quote(p.filename)}"` : ""}`;
    chunks.push(enc.encode(`--${boundary}\r\nContent-Disposition: ${disposition}\r\nContent-Type: ${p.contentType}\r\n\r\n`));
    chunks.push(typeof p.data === "string" ? enc.encode(p.data) : p.data);
    chunks.push(enc.encode("\r\n"));
  }
  chunks.push(enc.encode(`--${boundary}--\r\n`));
  const body = new Uint8Array(chunks.reduce((s, c) => s + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    body.set(c, at);
    at += c.length;
  }
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

const MONEY_PATHS = [/\/capture$/, /\/payouts$/, /\/refund$/, /\/authorize$/, /\/accept-claim$/];
export function isMoneyPath(path: string): boolean {
  return MONEY_PATHS.some((re) => re.test(path));
}

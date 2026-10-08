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

  async request<T>(method: "GET" | "POST" | "PATCH", path: string, body?: unknown, opts: RequestOptions = {}): Promise<T> {
    if (method === "POST" && !opts.requestId && isMoneyPath(path)) {
      throw new Error(`PayPal-Request-Id is required for ${path}`);
    }
    const headers: Record<string, string> = {
      Authorization: `Bearer ${await this.accessToken()}`,
      "Content-Type": "application/json",
      ...opts.headers,
    };
    if (opts.requestId) headers["PayPal-Request-Id"] = opts.requestId;

    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? null : JSON.stringify(body),
    });
    const text = await res.text();
    const json: unknown = text ? JSON.parse(text) : null;
    if (!res.ok) throw new PayPalError(res.status, json, res.headers.get("paypal-debug-id") ?? undefined);
    return json as T;
  }
}

const MONEY_PATHS = [/\/capture$/, /\/payouts$/, /\/refund$/, /\/authorize$/];
export function isMoneyPath(path: string): boolean {
  return MONEY_PATHS.some((re) => re.test(path));
}

// EXPERIMENTAL — SCQ Live Chargebee Validation (v1), NOT a production SDK.
//
// Minimal HTTP layer for the Chargebee API v2 (Product Catalog 2.0),
// isolated from the four simulator-backed adapters. Design constraints
// from the validation mission:
//   - HTTP Basic Auth with the API key as username and an empty password
//     (per https://apidocs.chargebee.com/docs/api/getting-started),
//     credentials read ONLY from environment variables by the caller and
//     passed in as config — never logged, never serialized.
//   - Form-encoded requests, JSON responses (Chargebee's documented wire
//     format).
//   - Dependency-injected transport so every behavior in the test matrix
//     can be exercised deterministically against a mocked transport with
//     zero network access and zero credentials.
//   - Redacted diagnostics: error messages carry HTTP status, Chargebee
//     `api_error_code`, and endpoint path ONLY — never the Authorization
//     header, never a full provider payload, never customer data.

export type HttpRequest = {
  method: "GET" | "POST";
  url: string;
  headers: Record<string, string>;
  /** Form-encoded body for POST; undefined for GET. */
  body?: string;
};

export type HttpResponse = {
  status: number;
  headers: Record<string, string>;
  /** Parsed JSON body when the response was JSON; otherwise undefined. */
  json?: unknown;
  /** Raw text (kept only for transport-level debugging inside tests; never logged by the client). */
  text?: string;
};

/** Injected transport. The default implementation uses global fetch. */
export type HttpTransport = (req: HttpRequest) => Promise<HttpResponse>;

export const fetchTransport: HttpTransport = async (req) => {
  const res = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body });
  const text = await res.text();
  let json: unknown;
  try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
  return { status: res.status, headers, json, text };
};

export type ChargebeeConfig = {
  site: string;
  apiKey: string;
  /** Base override for tests (a mocked transport ignores the host anyway). */
  baseUrl?: string;
};

export type ChargebeeEnvStatus =
  | { ok: true; config: ChargebeeConfig; testSubscriptionId?: string; liveCommitEnabled: boolean }
  | { ok: false; reason: "BLOCKED — CREDENTIALS NOT AVAILABLE"; missing: string[] };

/**
 * Reads Chargebee configuration from an environment map (process.env by
 * default). Missing site/key is a BLOCKED condition, never a reason to
 * fabricate a result: callers must report it as such.
 */
export function chargebeeConfigFromEnv(env: Record<string, string | undefined> = process.env): ChargebeeEnvStatus {
  const missing: string[] = [];
  if (!env.CHARGEBEE_SITE) missing.push("CHARGEBEE_SITE");
  if (!env.CHARGEBEE_API_KEY) missing.push("CHARGEBEE_API_KEY");
  if (missing.length > 0) return { ok: false, reason: "BLOCKED — CREDENTIALS NOT AVAILABLE", missing };
  return {
    ok: true,
    config: { site: env.CHARGEBEE_SITE!, apiKey: env.CHARGEBEE_API_KEY! },
    testSubscriptionId: env.CHARGEBEE_TEST_SUBSCRIPTION_ID,
    // Live mutation is opt-in and defaults OFF. Anything other than the
    // literal string "true" leaves it disabled.
    liveCommitEnabled: env.SCQ_LIVE_COMMIT_ENABLED === "true",
  };
}

/**
 * Chargebee form encoding: nested objects/arrays use bracket notation.
 *
 * Array-of-object encoding is FIELD-GROUPED, exactly as Chargebee's API
 * reference specifies for subscription_items ("pass parameters as
 * subscription_items[<param name>][<idx:0..n>]"):
 * subscription_items[item_price_id][0], subscription_items[quantity][0].
 *
 * PHASE 3 CORRECTION (2026-10-27, live-verified on a test site): an
 * earlier draft of this file's callers experimented with the
 * item-indexed shape subscription_items[0][quantity]. That shape is NOT
 * recognized by the estimate endpoint: the parameters are silently
 * ignored (Chargebee does not reject unrecognized parameters) and the
 * returned estimate describes a DIFFERENT item set than the one
 * requested — an HTTP 200 with wrong content. The grouped shape is the
 * only one for which the server demonstrably parses the items (it
 * validates them: e.g. it rejects a quantity change for a flat_fee plan
 * item). Do not "fix" this encoder to the indexed shape.
 */
export function formEncode(params: Record<string, unknown>, prefix = ""): string {
  const parts: string[] = [];
  const enc = (k: string, v: unknown) => { parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`); };
  const walk = (key: string, value: unknown): void => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
      // Chargebee's form convention groups arrays of objects by FIELD,
      // then index: subscription_items[item_price_id][0], not
      // subscription_items[0][item_price_id]. Transpose accordingly.
      if (value.length > 0 && value.every((v) => v !== null && typeof v === "object" && !Array.isArray(v))) {
        const fields = new Set<string>();
        for (const el of value as Array<Record<string, unknown>>) for (const k of Object.keys(el)) fields.add(k);
        for (const f of fields) value.forEach((el, i) => walk(`${key}[${f}][${i}]`, (el as Record<string, unknown>)[f]));
        return;
      }
      value.forEach((v, i) => walk(`${key}[${i}]`, v));
      return;
    }
    if (typeof value === "object") { for (const [k, v] of Object.entries(value as Record<string, unknown>)) walk(`${key}[${k}]`, v); return; }
    enc(key, value);
  };
  for (const [k, v] of Object.entries(params)) walk(prefix ? `${prefix}[${k}]` : k, v);
  return parts.join("&");
}

/** Strips anything that could carry a credential or PII out of a value before it is placed in an error/log string. */
export function redactForDiagnostics(value: unknown): string {
  const s = typeof value === "string" ? value : JSON.stringify(value) ?? "";
  return s
    .replace(/Basic\s+[A-Za-z0-9+/=]+/g, "Basic [REDACTED]")
    .replace(/chargebee-idempotency-key[^,}\s]*/gi, "chargebee-idempotency-key:[REDACTED]")
    .slice(0, 300);
}

export class ChargebeeHttpError extends Error {
  constructor(
    message: string,
    public httpStatus?: number,
    public apiErrorCode?: string,
    /** True when the outcome is unknown (timeout / network failure after the request may have been processed). */
    public indeterminate = false,
    public retryAfterSeconds?: number,
    public idempotencyReplayed = false,
  ) { super(message); }
}

export class ChargebeeClient {
  private base: string;
  constructor(private config: ChargebeeConfig, private transport: HttpTransport = fetchTransport) {
    this.base = config.baseUrl ?? `https://${config.site}.chargebee.com/api/v2`;
  }

  private authHeader(): string {
    // HTTP Basic Auth: API key as username, empty password. This value is
    // constructed per-request and is NEVER logged or included in errors.
    return "Basic " + Buffer.from(`${this.config.apiKey}:`).toString("base64");
  }

  async request(method: "GET" | "POST", path: string, params?: Record<string, unknown>, opts?: { idempotencyKey?: string }): Promise<{ json: any; idempotencyReplayed: boolean }> {
    const headers: Record<string, string> = { authorization: this.authHeader() };
    if (opts?.idempotencyKey) headers["chargebee-idempotency-key"] = opts.idempotencyKey;
    let body: string | undefined;
    if (method === "POST") { headers["content-type"] = "application/x-www-form-urlencoded"; body = formEncode(params ?? {}); }
    let res: HttpResponse;
    try {
      res = await this.transport({ method, url: `${this.base}${path}`, headers, body });
    } catch (e) {
      // Network failure / timeout: the provider may or may not have
      // processed the request. Classify as INDETERMINATE — callers must
      // reconcile provider state before considering any further mutation
      // and must never blindly re-issue the mutation.
      throw new ChargebeeHttpError(`Chargebee request to ${path} failed at transport level (outcome indeterminate): ${redactForDiagnostics(e instanceof Error ? e.message : String(e))}`, undefined, undefined, true);
    }
    const replayed = res.headers["chargebee-idempotency-replayed"] === "true";
    if (res.status >= 200 && res.status < 300) return { json: res.json, idempotencyReplayed: replayed };
    const apiErrorCode = (res.json as any)?.api_error_code as string | undefined;
    const retryAfter = res.headers["retry-after"] ? Number(res.headers["retry-after"]) : undefined;
    // 5xx responses are cached by Chargebee under the idempotency key
    // (docs: idempotency) — a retry with the same key replays the same
    // error; they are NOT proof the mutation did not happen in every
    // conceivable path, so only transport failures are marked
    // indeterminate here; 5xx is surfaced as a provider error with the
    // cached-error semantics recorded by the caller.
    throw new ChargebeeHttpError(
      `Chargebee request to ${path} failed: HTTP ${res.status}${apiErrorCode ? ` (${apiErrorCode})` : ""}`,
      res.status, apiErrorCode, false, retryAfter, replayed,
    );
  }

  getSubscription(subscriptionId: string) {
    return this.request("GET", `/subscriptions/${encodeURIComponent(subscriptionId)}`);
  }

  /**
   * POST /estimates/update_subscription_for_items — documented
   * non-mutating estimate family. Estimates do NOT support idempotency
   * keys (docs: idempotency).
   *
   * PHASE 3 FIX (live-verified 2026-10-27): the subscription id must be
   * sent as the nested object field subscription[id]. A flat
   * subscription_id field is not read by this endpoint and the call
   * fails with HTTP 400 "subscription[id] : cannot be blank"
   * (param_required). formEncode renders the nested object as
   * subscription[id]=<id>.
   */
  estimateUpdateForItems(subscriptionId: string, params: Record<string, unknown>) {
    return this.request("POST", `/estimates/update_subscription_for_items`, { subscription: { id: subscriptionId }, ...params });
  }

  /** GET /item_prices/{id} — authoritative item-price metadata (pricing_model, catalog price, free_quantity, item_type). Read-only. */
  getItemPrice(itemPriceId: string) {
    return this.request("GET", `/item_prices/${encodeURIComponent(itemPriceId)}`);
  }

  /** POST /subscriptions/{id}/update_for_items — the mutating call. Caller MUST gate this behind explicit enablement. */
  updateForItems(subscriptionId: string, params: Record<string, unknown>, idempotencyKey: string) {
    return this.request("POST", `/subscriptions/${encodeURIComponent(subscriptionId)}/update_for_items`, params, { idempotencyKey });
  }
}

// SCQ Chargebee PILOT — live-read safeguards (PR #13 review correction R3).
//
// The pilot's live mode is read/estimate-only, and that posture is now
// enforced at the TRANSPORT BOUNDARY rather than merely asserted by
// the harness:
//
//   (a) PREFLIGHT — before any live network request is constructed,
//       the run must present an explicitly approved TEST-site
//       configuration AND a synthetic subscription identifier
//       (assertLivePilotPreflight). Anything missing or unverified
//       fails closed with a named PilotLivePreflightError.
//
//   (b) ALLOWLIST — the guarded live transport
//       (createGuardedLiveTransport) classifies every request and
//       dispatches ONLY the read/estimate operations the pilot is
//       authorized for: GET subscription retrieve, GET item_price,
//       POST subscription estimate. Anything else — update_for_items,
//       creates, cancels, invoice/payment endpoints, arbitrary paths —
//       is rejected with ChargebeeOperationNotAllowedError BEFORE the
//       wrapped network transport is invoked.
//
//   (c) OBSERVED COUNTS — every request the guard sees is recorded in
//       a transport log (dispatched or rejected), and pilot reports
//       derive their transport counts — including the mutating-call
//       count — from that log (summarizeTransportLog). A report can
//       therefore never claim live success for a capability whose
//       operations were not observed.
//
// This module wraps whatever network transport it is given (global
// fetch in real runs; a stub in tests). It never enables commit:
// update_for_items is classified mutating and is NOT on the allowlist.

import type { HttpRequest, HttpResponse, HttpTransport } from "../chargebee-http.js";

export type ChargebeeOperationName =
  | "retrieve_subscription"
  | "get_item_price"
  | "estimate_update_for_items"
  | "update_for_items"
  | "other";

export type ClassifiedOperation = {
  operation: ChargebeeOperationName;
  /** True when the operation would mutate provider state if dispatched. */
  mutating: boolean;
  /** True when the operation is on the pilot's live allowlist. */
  allowed: boolean;
};

export type TransportLogEntry = {
  method: string;
  path: string;
  operation: ChargebeeOperationName;
  mutating: boolean;
  /** True when the wrapped network transport was actually invoked. */
  dispatched: boolean;
  /** HTTP status when the request was dispatched and returned. */
  status?: number;
  /** Rejection reason when the guard refused the operation pre-dispatch. */
  rejected?: string;
};

const READ_ESTIMATE_ALLOWLIST: ReadonlySet<ChargebeeOperationName> = new Set([
  "retrieve_subscription",
  "get_item_price",
  "estimate_update_for_items",
]);

/**
 * Classifies a Chargebee API request by method + path. Accepts a full
 * URL or a bare API path (with or without the /api/v2 prefix).
 */
export function classifyChargebeeOperation(method: string, urlOrPath: string): ClassifiedOperation {
  let path = urlOrPath;
  try { path = new URL(urlOrPath).pathname; } catch { /* already a path */ }
  path = path.replace(/^\/api\/v2/, "");
  const m = method.toUpperCase();
  let operation: ChargebeeOperationName = "other";
  if (m === "GET" && /^\/subscriptions\/[^/]+$/.test(path)) operation = "retrieve_subscription";
  else if (m === "GET" && /^\/item_prices\/[^/]+$/.test(path)) operation = "get_item_price";
  else if (m === "POST" && path === "/estimates/update_subscription_for_items") operation = "estimate_update_for_items";
  else if (m === "POST" && /^\/subscriptions\/[^/]+\/update_for_items$/.test(path)) operation = "update_for_items";
  // Every state-changing endpoint in the Chargebee surface used here
  // is a POST; update_for_items is the one the pilot must never send.
  const mutating = operation === "update_for_items" || (operation === "other" && m !== "GET");
  return { operation, mutating, allowed: READ_ESTIMATE_ALLOWLIST.has(operation) };
}

export class ChargebeeOperationNotAllowedError extends Error {
  code = "OPERATION_NOT_ALLOWED" as const;
  constructor(public operation: ChargebeeOperationName, method: string, path: string) {
    super(`Chargebee operation not allowed in the pilot live transport: ${method} ${path} (${operation}). The pilot live allowlist is read/estimate only: GET subscription retrieve, GET item_price, POST subscription estimate. The request was rejected BEFORE any network dispatch.`);
    this.name = "ChargebeeOperationNotAllowedError";
  }
}

export class PilotLivePreflightError extends Error {
  code = "LIVE_PREFLIGHT_FAILED" as const;
  constructor(public problems: string[]) {
    super(`Chargebee pilot live preflight failed closed — no network request was made. Problems: ${problems.join("; ")}`);
    this.name = "PilotLivePreflightError";
  }
}

/**
 * Approved TEST-site designation for the pilot: a Chargebee site slug
 * carrying the `-test` suffix (the shape of every test site used by
 * this project, e.g. `<name>-test`), or a slug on the explicit
 * allowlist below. A production-looking slug (no test designation, not
 * allowlisted) is NOT approved and fails preflight.
 */
export const PILOT_APPROVED_TEST_SITES: readonly string[] = [];
const TEST_SITE_SUFFIX = /-test$/;

export function isApprovedTestSite(site: string | undefined): boolean {
  if (!site) return false;
  return PILOT_APPROVED_TEST_SITES.includes(site) || TEST_SITE_SUFFIX.test(site);
}

/**
 * Synthetic-subscription designation for the pilot: the subscription
 * id must carry one of the project's synthetic fixture prefixes —
 * Chargebee demo data (`cbdemo_…`) or an explicitly synthetic pilot /
 * test identifier. A bare production-shaped id is NOT accepted.
 */
export const SYNTHETIC_SUBSCRIPTION_ID_PREFIXES: readonly string[] = ["cbdemo_", "pilot-", "synthetic-", "test-"];

export function isSyntheticSubscriptionId(id: string | undefined): boolean {
  if (!id) return false;
  return SYNTHETIC_SUBSCRIPTION_ID_PREFIXES.some((p) => id.startsWith(p));
}

/**
 * The preflight contract for a pilot live run. Throws
 * PilotLivePreflightError listing EVERY problem when the configuration
 * is missing or unverified. Callers must run this BEFORE constructing
 * any client or request.
 */
export function assertLivePilotPreflight(input: { site?: string; apiKeyPresent: boolean; subscriptionId?: string }): void {
  const problems: string[] = [];
  if (!input.site) problems.push("CHARGEBEE_SITE is missing");
  else if (!isApprovedTestSite(input.site)) {
    problems.push(`CHARGEBEE_SITE "${input.site}" is not an approved test site (a site slug must carry the "-test" designation or be on the pilot allowlist; production tenants are never approved)`);
  }
  if (!input.apiKeyPresent) problems.push("CHARGEBEE_API_KEY is missing");
  if (!input.subscriptionId) problems.push("no synthetic test subscription id (set CHARGEBEE_TEST_SUBSCRIPTION_ID or pass --subscription)");
  else if (!isSyntheticSubscriptionId(input.subscriptionId)) {
    problems.push(`subscription id "${input.subscriptionId}" does not carry a synthetic designation (expected one of the prefixes: ${SYNTHETIC_SUBSCRIPTION_ID_PREFIXES.join(", ")})`);
  }
  if (problems.length > 0) throw new PilotLivePreflightError(problems);
}

/**
 * Wraps a network transport with the pilot's operation allowlist and
 * an observed-request log. Disallowed operations throw
 * ChargebeeOperationNotAllowedError before the wrapped transport is
 * invoked; the attempt is still logged (dispatched: false) so reports
 * show it.
 */
export function createGuardedLiveTransport(inner: HttpTransport): { transport: HttpTransport; log: TransportLogEntry[] } {
  const log: TransportLogEntry[] = [];
  const transport: HttpTransport = async (req: HttpRequest): Promise<HttpResponse> => {
    let path = req.url;
    try { path = new URL(req.url).pathname.replace(/^\/api\/v2/, ""); } catch { /* keep raw */ }
    const cls = classifyChargebeeOperation(req.method, req.url);
    if (!cls.allowed) {
      const err = new ChargebeeOperationNotAllowedError(cls.operation, req.method, path);
      log.push({ method: req.method, path, operation: cls.operation, mutating: cls.mutating, dispatched: false, rejected: err.code });
      throw err;
    }
    try {
      const res = await inner(req);
      log.push({ method: req.method, path, operation: cls.operation, mutating: cls.mutating, dispatched: true, status: res.status });
      return res;
    } catch (e) {
      log.push({ method: req.method, path, operation: cls.operation, mutating: cls.mutating, dispatched: true });
      throw e;
    }
  };
  return { transport, log };
}

export type TransportSummary = {
  /** Observed requests actually dispatched to the wrapped transport. */
  totalCalls: number;
  /** Observed DISPATCHED requests classified as mutating (derived from the log, never hardcoded). */
  mutatingCalls: number;
  /** Observed dispatched estimate operations. */
  estimateCalls: number;
  /** Observed dispatched counts per operation name. */
  byOperation: Record<string, number>;
  /** Guard rejections refused before dispatch. */
  rejectedAttempts: number;
};

export function summarizeTransportLog(entries: readonly TransportLogEntry[]): TransportSummary {
  const byOperation: Record<string, number> = {};
  let totalCalls = 0;
  let mutatingCalls = 0;
  let estimateCalls = 0;
  let rejectedAttempts = 0;
  for (const e of entries) {
    if (e.rejected) { rejectedAttempts++; continue; }
    if (!e.dispatched) continue;
    totalCalls++;
    byOperation[e.operation] = (byOperation[e.operation] ?? 0) + 1;
    if (e.mutating) mutatingCalls++;
    if (e.operation === "estimate_update_for_items") estimateCalls++;
  }
  return { totalCalls, mutatingCalls, estimateCalls, byOperation, rejectedAttempts };
}

/** Count of observed DISPATCHED, successful (2xx) requests for one operation — the evidence a live classification must rest on. */
export function observedSuccessfulOps(entries: readonly TransportLogEntry[], operation: ChargebeeOperationName): number {
  return entries.filter((e) => e.dispatched && !e.rejected && e.operation === operation && typeof e.status === "number" && e.status >= 200 && e.status < 300).length;
}

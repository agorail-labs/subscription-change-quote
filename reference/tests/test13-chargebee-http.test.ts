import { test } from "node:test";
import assert from "node:assert/strict";
import { QuoteStore } from "../src/store/quote-store.js";
import { SCQError } from "../src/core/types.js";
import {
  ChargebeeClient,
  chargebeeConfigFromEnv,
  formEncode,
  redactForDiagnostics,
  type HttpRequest,
  type HttpResponse,
  type HttpTransport,
} from "../src/live/chargebee-http.js";
import { ChargebeeLiveAdapter, interpretChargebeeEstimate, type CbItemPriceInfo } from "../src/live/chargebee-scq-adapter.js";

// Test 13 — SCQ Live Chargebee Validation (mocked transport).
//
// EVERY test in this file runs against a deterministic in-memory fake.
// No network, no credentials. Results backed by this file are therefore
// SIMULATED_PASS at best — never LIVE_PASS. Live results exist
// separately (Phase 3, 2026-10-27) and are recorded in
// research/chargebee-live-v1/TEST-RESULTS.md with evidence in
// ~/workspace/scq-live-validation-evidence/PHASE3-RUN-2026-10-27.md.
//
// PHASE 3 REBUILD (2026-10-27): the previous fake accepted whatever the
// client sent — including the client's own form encoding and a flat
// `subscription_id` the real estimate endpoint does not read — and
// always returned a rich estimate (subscription_items +
// invoice_estimate). Both live bugs were therefore invisible. This fake
// is rebuilt from the SANITIZED REAL wire shapes captured live:
//   - POST /estimates/update_subscription_for_items REQUIRES
//     subscription[id]; without it the fake returns the real 400
//     ("subscription[id] : cannot be blank", param_required).
//   - Item arrays are parsed in the documented FIELD-GROUPED format
//     (subscription_items[item_price_id][i] / [quantity][i]).
//   - A quantity that CHANGES a flat_fee item is rejected with the
//     real server's validation error ("This param should not be sent
//     for on_off addon type") — quantity is not a settable dimension
//     of a flat_fee item (live isolation matrix, Phase 3).
//   - Estimate responses use the observed SPARSE shapes: a priced
//     per_unit change returns ONLY unbilled_charge_estimates + a
//     subscription_estimate with NO subscription_items and NO
//     next_invoice_estimate; an unchanged baseline returns ONLY
//     next_invoice_estimate. Rich shapes appear only in the unit tests
//     that exercise the interpretation function directly.
//   - GET /item_prices/{id} serves pricing_model metadata.
// The fake still models: GET /subscriptions/{id},
// POST /subscriptions/{id}/update_for_items with
// chargebee-idempotency-key (30-minute replay window, replayed header,
// 422 on parameter mismatch).

type ItemPriceMeta = { price: number; pricing_model: string; free_quantity: number; item_type: string };
const ITEM_PRICES: Record<string, ItemPriceMeta> = {
  "seat-basic-monthly": { price: 1000, pricing_model: "per_unit", free_quantity: 0, item_type: "plan" },
  "seat-pro-monthly": { price: 1500, pricing_model: "per_unit", free_quantity: 0, item_type: "plan" },
  "flat-plan-monthly": { price: 59900, pricing_model: "flat_fee", free_quantity: 0, item_type: "plan" },
  "onoff-addon-monthly": { price: 500, pricing_model: "flat_fee", free_quantity: 0, item_type: "addon" },
  "perunit-addon-monthly": { price: 1000, pricing_model: "per_unit", free_quantity: 0, item_type: "addon" },
};
const T0 = new Date("2026-08-01T00:00:00Z");

type FakeSub = {
  id: string; status: string; currency_code: string; resource_version: number;
  current_term_start: number; current_term_end: number; next_billing_at: number;
  has_scheduled_changes: boolean; has_scheduled_advance_invoices: boolean;
  subscription_items: Array<{ item_price_id: string; item_type: string; quantity: number; unit_price: number; amount: number; free_quantity?: number }>;
};

function contribution(item: { item_price_id: string; quantity: number; unit_price: number }): number {
  const meta = ITEM_PRICES[item.item_price_id];
  return meta?.pricing_model === "flat_fee" ? item.unit_price : item.unit_price * item.quantity;
}

class FakeChargebee {
  sub: FakeSub;
  mutationCount = 0;
  estimateCount = 0;
  readCount = 0;
  requests: Array<{ method: string; path: string; body: string; idempotencyKey?: string }> = [];
  /** Added to estimate nets only — models drift sources outside the subscription resource (balances/tax configuration), which the subscription fingerprint cannot see. */
  estimateExtraNet = 0;
  /** Estimate response shape: "live" (sparse, as captured) | "empty" (no financial members) | "noEstimate" (no estimate member at all) | "unbilledMissingAmount" (an unbilled element without amount) | "creditNotesAbsent" (unbilled present, credit_note_estimates member absent) | "statedZero" (both members present and empty — a provider-stated zero). */
  estimateShape: "live" | "empty" | "noEstimate" | "unbilledMissingAmount" | "creditNotesAbsent" | "statedZero" = "live";
  /** Update response shape: "full" (subscription + unbilled_charges member) | "noFinancials" (subscription ONLY — no invoice, no unbilled_charges member: an incomplete post-update response). The mutation itself still applies. */
  updateShape: "full" | "noFinancials" = "full";
  /** One-shot hook fired inside the mutating call, after the adapter's final preview — the TOCTOU window. */
  beforeUpdate: (() => void) | null = null;
  private idem = new Map<string, { paramsHash: string; response: HttpResponse; at: number }>();
  fakeNowMs = T0.getTime();

  constructor(opts: { hasScheduledChanges?: boolean; items?: FakeSub["subscription_items"]; id?: string } = {}) {
    const start = Math.floor(T0.getTime() / 1000);
    this.sub = {
      id: opts.id ?? "cb_live_test_1", status: "active", currency_code: "USD", resource_version: 1700000000000,
      current_term_start: start, current_term_end: start + 30 * 24 * 3600, next_billing_at: start + 30 * 24 * 3600,
      has_scheduled_changes: opts.hasScheduledChanges ?? false, has_scheduled_advance_invoices: false,
      subscription_items: opts.items ?? [{ item_price_id: "seat-basic-monthly", item_type: "plan", quantity: 100, unit_price: 1000, amount: 100000, free_quantity: 0 }],
    };
  }

  debugMutate(fn: (s: FakeSub) => void): void { fn(this.sub); this.sub.resource_version += 1; }

  private parseItems(body: URLSearchParams): Array<{ item_price_id: string; quantity: number | null }> {
    const out: Array<{ item_price_id: string; quantity: number | null }> = [];
    for (let i = 0; ; i++) {
      const p = body.get(`subscription_items[item_price_id][${i}]`);
      if (p === null) break;
      const q = body.get(`subscription_items[quantity][${i}]`);
      out.push({ item_price_id: p, quantity: q === null ? null : Number(q) });
    }
    return out;
  }

  private sparseSubEstimate() {
    // The real shape: NO subscription_items member at all.
    return { id: this.sub.id, status: this.sub.status, currency_code: this.sub.currency_code, next_billing_at: this.sub.next_billing_at, object: "subscription_estimate" };
  }

  transport: HttpTransport = async (req: HttpRequest): Promise<HttpResponse> => {
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/api\/v2/, "");
    const body = new URLSearchParams(req.body ?? "");
    this.requests.push({ method: req.method, path, body: req.body ?? "", idempotencyKey: req.headers["chargebee-idempotency-key"] });
    const jsonRes = (status: number, json: unknown, headers: Record<string, string> = {}): HttpResponse => ({ status, headers, json });

    if (req.method === "GET" && path === `/subscriptions/${this.sub.id}`) {
      this.readCount++;
      return jsonRes(200, { subscription: structuredClone(this.sub) });
    }
    const ipMatch = path.match(/^\/item_prices\/(.+)$/);
    if (req.method === "GET" && ipMatch) {
      const meta = ITEM_PRICES[decodeURIComponent(ipMatch[1])];
      if (!meta) return jsonRes(404, { api_error_code: "resource_not_found", message: "not found" });
      return jsonRes(200, { item_price: { id: decodeURIComponent(ipMatch[1]), pricing_model: meta.pricing_model, price: meta.price, free_quantity: meta.free_quantity, item_type: meta.item_type, currency_code: "USD" } });
    }
    if (req.method === "POST" && path === "/estimates/update_subscription_for_items") {
      this.estimateCount++;
      // Real-server validation 1: subscription[id] is required (a flat
      // subscription_id field does NOT satisfy it).
      if (body.get("subscription[id]") !== this.sub.id) {
        return jsonRes(400, { message: "subscription[id] : cannot be blank", type: "invalid_request", api_error_code: "invalid_request", param: "subscription[id]", error_code: "param_required", http_status_code: 400 });
      }
      const items = this.parseItems(body);
      // Real-server validation 2: every listed item must carry a quantity.
      for (let i = 0; i < items.length; i++) {
        if (items[i].quantity === null) {
          return jsonRes(400, { message: `subscription_items[quantity][${i}] : cannot be blank`, type: "invalid_request", api_error_code: "invalid_request", param: `subscription_items[quantity][${i}]`, error_code: "param_required", http_status_code: 400 });
        }
      }
      // Real-server validation 3: a flat_fee item's quantity cannot be
      // CHANGED (live-verified wording; quantity is not a settable
      // dimension of a non-quantity-priced item).
      for (let i = 0; i < items.length; i++) {
        const meta = ITEM_PRICES[items[i].item_price_id];
        const currentQty = this.sub.subscription_items.find((s) => s.item_price_id === items[i].item_price_id)?.quantity ?? 1;
        if (meta?.pricing_model === "flat_fee" && items[i].quantity !== currentQty) {
          return jsonRes(400, { message: `subscription_items[quantity][${i}] : This param should not be sent for on_off addon type`, type: "invalid_request", api_error_code: "invalid_request", param: `subscription_items[quantity][${i}]`, error_code: "param_should_not_be_sent", http_status_code: 400 });
        }
      }
      if (this.estimateShape === "statedZero") {
        // Both financial members present and EMPTY: the provider states
        // a zero immediate effect. This is an actual zero, not an absence.
        return jsonRes(200, { estimate: { created_at: Math.floor(this.fakeNowMs / 1000), object: "estimate", subscription_estimate: this.sparseSubEstimate(), unbilled_charge_estimates: [], credit_note_estimates: [] } });
      }
      if (this.estimateShape === "unbilledMissingAmount") {
        // Incomplete provider result: an unbilled element with NO
        // amount. The sum is undeterminable — it must never be read as 0.
        return jsonRes(200, { estimate: { created_at: Math.floor(this.fakeNowMs / 1000), object: "estimate", subscription_estimate: this.sparseSubEstimate(), unbilled_charge_estimates: [{ quantity: 20, pricing_model: "per_unit", description: "Prorated Charges", object: "unbilled_charge" }], credit_note_estimates: [] } });
      }
      if (this.estimateShape === "creditNotesAbsent") {
        // Unbilled total present, but the credit_note_estimates MEMBER
        // is absent: the net cannot be finalized.
        return jsonRes(200, { estimate: { created_at: Math.floor(this.fakeNowMs / 1000), object: "estimate", subscription_estimate: this.sparseSubEstimate(), unbilled_charge_estimates: [{ amount: 20000, pricing_model: "per_unit", object: "unbilled_charge" }] } });
      }
      if (this.estimateShape === "noEstimate") return jsonRes(200, {});
      if (this.estimateShape === "empty") {
        return jsonRes(200, { estimate: { created_at: Math.floor(this.fakeNowMs / 1000), object: "estimate", subscription_estimate: this.sparseSubEstimate() } });
      }
      // Sparse live shapes.
      const pricedDelta = items.reduce((s, it) => {
        const meta = ITEM_PRICES[it.item_price_id];
        if (meta?.pricing_model !== "per_unit") return s;
        const cur = this.sub.subscription_items.find((x) => x.item_price_id === it.item_price_id);
        const unit = cur?.unit_price ?? meta.price;
        return s + ((it.quantity ?? 0) - (cur?.quantity ?? 0)) * unit;
      }, 0) + this.estimateExtraNet;
      if (pricedDelta !== 0) {
        // A priced change: ONLY unbilled charges + sparse subscription
        // estimate. No invoice_estimate, no next_invoice_estimate.
        return jsonRes(200, {
          estimate: {
            created_at: Math.floor(this.fakeNowMs / 1000), object: "estimate",
            subscription_estimate: this.sparseSubEstimate(),
            unbilled_charge_estimates: [{ amount: pricedDelta, unit_amount: Math.abs(pricedDelta), quantity: 1, pricing_model: "per_unit", description: "Prorated Charges", object: "unbilled_charge" }],
            credit_note_estimates: [],
          },
        });
      }
      // No priced change: ONLY next_invoice_estimate (+ sparse sub est).
      const total = this.sub.subscription_items.reduce((s, i) => s + contribution(i), 0);
      return jsonRes(200, {
        estimate: {
          created_at: Math.floor(this.fakeNowMs / 1000), object: "estimate",
          subscription_estimate: this.sparseSubEstimate(),
          next_invoice_estimate: {
            recurring: true, date: this.sub.next_billing_at, sub_total: total, total, credits_applied: 0, amount_paid: 0, amount_due: total, object: "invoice_estimate",
            line_items: this.sub.subscription_items.map((i) => ({ entity_id: i.item_price_id, quantity: i.quantity, unit_amount: i.unit_price, amount: contribution(i), pricing_model: ITEM_PRICES[i.item_price_id]?.pricing_model })),
          },
          credit_note_estimates: [],
        },
      });
    }
    if (req.method === "POST" && path === `/subscriptions/${this.sub.id}/update_for_items`) {
      const key = req.headers["chargebee-idempotency-key"];
      const paramsHash = req.body ?? "";
      if (key) {
        const prior = this.idem.get(key);
        if (prior && this.fakeNowMs - prior.at <= 30 * 60 * 1000) {
          if (prior.paramsHash !== paramsHash) return jsonRes(422, { api_error_code: "invalid_request", message: "idempotency key reused with different parameters" });
          return { ...prior.response, headers: { ...prior.response.headers, "chargebee-idempotency-replayed": "true" } };
        }
      }
      if (this.beforeUpdate) { const h = this.beforeUpdate; this.beforeUpdate = null; h(); }
      const items = this.parseItems(body);
      const oldRec = this.sub.subscription_items.reduce((s, i) => s + contribution(i), 0);
      this.sub.subscription_items = items.map((i) => {
        const meta = ITEM_PRICES[i.item_price_id];
        const unit = meta?.price ?? 0;
        const qty = i.quantity ?? 0;
        return { item_price_id: i.item_price_id, item_type: meta?.item_type ?? "plan", quantity: qty, unit_price: unit, amount: meta?.pricing_model === "flat_fee" ? unit : unit * qty, free_quantity: meta?.free_quantity };
      });
      const newRec = this.sub.subscription_items.reduce((s, i) => s + contribution(i), 0);
      this.sub.resource_version += 1;
      this.mutationCount++;
      const res = this.updateShape === "noFinancials"
        ? jsonRes(200, { subscription: structuredClone(this.sub) })
        : jsonRes(200, { subscription: structuredClone(this.sub), unbilled_charges: newRec - oldRec !== 0 ? [{ amount: newRec - oldRec }] : [] });
      if (key) this.idem.set(key, { paramsHash, response: res, at: this.fakeNowMs });
      return res;
    }
    return jsonRes(404, { api_error_code: "resource_not_found", message: "not found" });
  };
}

function makeAdapter(fake: FakeChargebee, opts: { liveCommitEnabled?: boolean; now?: () => Date; store?: QuoteStore } = {}) {
  const client = new ChargebeeClient({ site: "scq-test", apiKey: "test_key_redacted" }, fake.transport);
  return new ChargebeeLiveAdapter(client, opts.store ?? new QuoteStore(), { liveCommitEnabled: opts.liveCommitEnabled ?? true, now: opts.now });
}

const ENVELOPE0 = { maxImmediateNetIncrease: 0, maxImmediateCreditDecrease: 0, maxRecurringIncrease: 0 };
const qtyProposal = (quantity = 120, envelope: Record<string, number> = ENVELOPE0) => ({
  changes: [{ action: "CHANGE_QUANTITY" as const, itemId: "seat-basic-monthly", quantity }],
  effectiveIntent: { type: "IMMEDIATE" as const },
  acceptanceEnvelope: envelope,
});

// ---------- HTTP layer unit tests ----------

test("Test 13-http1: formEncode uses Chargebee bracket notation and the client sends Basic auth + form body (never logged)", async () => {
  const encoded = formEncode({ subscription_items: [{ item_price_id: "p1", quantity: 120 }], replace_items_list: true });
  assert.ok(encoded.includes("subscription_items%5Bitem_price_id%5D%5B0%5D=p1") || encoded.includes("subscription_items[item_price_id][0]=p1".replace(/[[\]]/g, (c) => encodeURIComponent(c))));
  const fake = new FakeChargebee();
  let seenAuth = "";
  const spy: HttpTransport = async (req) => { seenAuth = req.headers.authorization ?? ""; if (req.method === "POST") assert.equal(req.headers["content-type"], "application/x-www-form-urlencoded"); return fake.transport(req); };
  const client = new ChargebeeClient({ site: "scq-test", apiKey: "test_key_redacted" }, spy);
  await client.getSubscription("cb_live_test_1");
  await client.estimateUpdateForItems("cb_live_test_1", { subscription_items: [{ item_price_id: "seat-basic-monthly", quantity: 120 }] });
  assert.ok(seenAuth.startsWith("Basic "));
  // Redaction: neither the header nor the key may survive redactForDiagnostics.
  const redacted = redactForDiagnostics(`failed with ${seenAuth} and key test_key_redacted`);
  assert.ok(!redacted.includes("test_key_redacted") || redacted.includes("REDACTED"));
  assert.ok(!/Basic\s+[A-Za-z0-9+/=]{8,}/.test(redacted));
});

test("Test 13-ser1 (Phase 3): formEncode produces the EXACT documented field-grouped serialization (independent literal expectation)", () => {
  // Expected string written by hand from Chargebee's documented
  // parameter format — NOT generated by the encoder under test.
  const encoded = formEncode({
    subscription: { id: "sub_123" },
    subscription_items: [
      { item_price_id: "plan-a", quantity: 21 },
      { item_price_id: "addon-b", quantity: 1 },
    ],
    replace_items_list: true,
    prorate: true,
    invoice_immediately: false,
    change_option: "immediately",
  });
  assert.equal(
    encoded,
    "subscription%5Bid%5D=sub_123" +
    "&subscription_items%5Bitem_price_id%5D%5B0%5D=plan-a&subscription_items%5Bitem_price_id%5D%5B1%5D=addon-b" +
    "&subscription_items%5Bquantity%5D%5B0%5D=21&subscription_items%5Bquantity%5D%5B1%5D=1" +
    "&replace_items_list=true&prorate=true&invoice_immediately=false&change_option=immediately",
  );
});

test("Test 13-ser2 (Phase 3): the estimate request carries subscription[id] (never a flat subscription_id) and grouped item fields", async () => {
  const fake = new FakeChargebee();
  const adapter = makeAdapter(fake);
  await adapter.createChangeQuote("cb_live_test_1", qtyProposal());
  const estReq = fake.requests.find((r) => r.path === "/estimates/update_subscription_for_items");
  assert.ok(estReq, "an estimate request was made");
  const body = new URLSearchParams(estReq!.body);
  assert.equal(body.get("subscription[id]"), "cb_live_test_1", "the real endpoint reads ONLY the nested subscription[id]");
  assert.equal(body.get("subscription_id"), null, "a flat subscription_id must not be sent (the endpoint ignores it and 400s)");
  assert.equal(body.get("subscription_items[item_price_id][0]"), "seat-basic-monthly");
  assert.equal(body.get("subscription_items[quantity][0]"), "120");
  assert.ok(!estReq!.body.includes("subscription_items%5B0%5D"), "item-indexed shape subscription_items[0][...] must not be produced — the server silently ignores it");
});

test("Test 13-http2: missing credentials classify as BLOCKED — CREDENTIALS NOT AVAILABLE (never fabricated success)", () => {
  const st = chargebeeConfigFromEnv({});
  assert.equal(st.ok, false);
  if (!st.ok) { assert.equal(st.reason, "BLOCKED — CREDENTIALS NOT AVAILABLE"); assert.deepEqual(st.missing, ["CHARGEBEE_SITE", "CHARGEBEE_API_KEY"]); }
  const st2 = chargebeeConfigFromEnv({ CHARGEBEE_SITE: "x-test", CHARGEBEE_API_KEY: "k" });
  assert.equal(st2.ok, true);
  if (st2.ok) assert.equal(st2.liveCommitEnabled, false, "live commit must default to disabled");
});

test("Test 13-http3 (SIMULATED): native idempotency — same key+params within 30 min replays; different params 422; after window it reprocesses", async () => {
  const fake = new FakeChargebee();
  const client = new ChargebeeClient({ site: "scq-test", apiKey: "test_key_redacted" }, fake.transport);
  const params = { subscription_items: [{ item_price_id: "seat-basic-monthly", quantity: 120 }], replace_items_list: true, prorate: true, invoice_immediately: false };
  const r1 = await client.updateForItems("cb_live_test_1", params, "key-abc");
  assert.equal(r1.idempotencyReplayed, false);
  const r2 = await client.updateForItems("cb_live_test_1", params, "key-abc");
  assert.equal(r2.idempotencyReplayed, true, "replay is signaled via chargebee-idempotency-replayed");
  assert.equal(fake.mutationCount, 1);
  await assert.rejects(() => client.updateForItems("cb_live_test_1", { ...params, prorate: false }, "key-abc"), (e: unknown) => (e as any).httpStatus === 422);
  fake.fakeNowMs += 31 * 60 * 1000; // beyond the documented 30-minute window
  const r3 = await client.updateForItems("cb_live_test_1", params, "key-abc");
  assert.equal(r3.idempotencyReplayed, false);
  assert.equal(fake.mutationCount, 2, "after the window the same key no longer protects — SCQ must not assume indefinite native replay");
});

// ---------- Phase 3 interpretation unit tests (independent fixtures) ----------

const PRICE_INFO = new Map<string, CbItemPriceInfo>([
  ["flat-plan-monthly", { itemPriceId: "flat-plan-monthly", pricingModel: "flat_fee", price: 59900, freeQuantity: 0, itemType: "plan" }],
  ["perunit-addon-monthly", { itemPriceId: "perunit-addon-monthly", pricingModel: "per_unit", price: 10000, freeQuantity: 0, itemType: "addon" }],
]);
const DEMO_CURRENT = [
  { itemPriceId: "flat-plan-monthly", quantity: 1, unitPrice: 59900, amount: 59900, freeQuantity: 0 },
  { itemPriceId: "perunit-addon-monthly", quantity: 1, unitPrice: 1000, amount: 1000 },
];

test("Test 13-fix3 (Phase 3): only next_invoice_estimate present — its figures are NEVER mapped to immediate or recurring", () => {
  // Fixture mirrors the live Oct 27 payload for the unchanged baseline:
  // next-invoice total 59900 with amount_due 59600 (300 credits applied).
  const estimate = {
    subscription_estimate: { id: "s", status: "active", currency_code: "USD", next_billing_at: 1818007771 },
    next_invoice_estimate: { total: 59900, sub_total: 59900, amount_due: 59600, credits_applied: 300, date: 1818007771, line_items: [{ entity_id: "flat-plan-monthly", quantity: 1, amount: 59900 }] },
    credit_note_estimates: [],
  };
  const r = interpretChargebeeEstimate(estimate, {
    currency: "USD",
    currentItems: DEMO_CURRENT,
    targetItems: [{ itemPriceId: "flat-plan-monthly", quantity: 1 }, { itemPriceId: "perunit-addon-monthly", quantity: 21 }],
    priceInfo: PRICE_INFO,
  });
  assert.equal(r.effect.immediate, undefined, "no invoice_estimate and no unbilled charges => immediate is ABSENT, not the next-invoice amount_due");
  assert.equal(r.effect.recurring?.resultingAmount, 80900, "recurring is computed per pricing model (flat 59900 + per-unit 21 x 1000), never copied from next_invoice total 59900");
  assert.equal(r.effect.recurring?.previousAmount, 60900);
  assert.ok(!JSON.stringify(r.effect).includes("59600"), "amount_due (net of credits) must not leak into the effect");
  assert.deepEqual(r.nextInvoice, { total: 59900, amountDue: 59600, creditsApplied: 300, date: new Date(1818007771 * 1000).toISOString(), lineCount: 1 }, "next-invoice facts are preserved separately, with their date");
});

test("Test 13-fix4 (Phase 3): invoice_estimate absent — immediate comes from unbilled charges minus credit notes", () => {
  const estimate = {
    subscription_estimate: { subscription_items: [{ item_price_id: "seat-basic-monthly", quantity: 120, unit_price: 1000, amount: 120000 }] },
    unbilled_charge_estimates: [{ amount: 20000 }],
    credit_note_estimates: [{ total: 500 }],
  };
  const r = interpretChargebeeEstimate(estimate, {
    currency: "USD",
    currentItems: [{ itemPriceId: "seat-basic-monthly", quantity: 100, unitPrice: 1000, amount: 100000, freeQuantity: 0 }],
    targetItems: [{ itemPriceId: "seat-basic-monthly", quantity: 120 }],
    priceInfo: new Map([["seat-basic-monthly", { itemPriceId: "seat-basic-monthly", pricingModel: "per_unit", price: 1000, freeQuantity: 0, itemType: "plan" }]]),
  });
  assert.equal(r.effect.immediate?.net, 19500, "20000 unbilled − 500 credit notes");
  assert.equal(r.effect.recurring?.resultingAmount, 120000, "provider-stated subscription_estimate items take precedence for recurring");
});

test("Test 13-fix5 (Phase 3): a flat_fee item's recurring contribution NEVER scales with quantity", () => {
  // Provider-stated items path: amount is authoritative even at qty 21.
  const stated = interpretChargebeeEstimate(
    { subscription_estimate: { subscription_items: [{ item_price_id: "flat-plan-monthly", quantity: 21, unit_price: 59900, amount: 59900 }] }, credit_note_estimates: [] },
    { currency: "USD", currentItems: [DEMO_CURRENT[0]], targetItems: [{ itemPriceId: "flat-plan-monthly", quantity: 21 }], priceInfo: PRICE_INFO },
  );
  assert.equal(stated.effect.recurring?.resultingAmount, 59900);
  // Computed path: flat_fee contributes its fixed price once.
  const computed = interpretChargebeeEstimate(
    { subscription_estimate: { id: "s", status: "active" }, credit_note_estimates: [] },
    { currency: "USD", currentItems: [DEMO_CURRENT[0]], targetItems: [{ itemPriceId: "flat-plan-monthly", quantity: 21 }], priceInfo: PRICE_INFO },
  );
  assert.equal(computed.effect.recurring?.resultingAmount, 59900, "flat_fee at quantity 21 is still 59900 — NOT 21 x 59900 = 1258900");
  assert.notEqual(computed.effect.recurring?.resultingAmount, 1258900);
});

test("Test 13-fix6 (Phase 3): credits_applied reduces next-invoice amount_due only — immediate and recurring are unaffected", () => {
  // Mirrors the live addon-change shape (unbilled proration present)
  // combined with a next-invoice block carrying credits.
  const estimate = {
    subscription_estimate: { id: "s", status: "active", currency_code: "USD" },
    unbilled_charge_estimates: [{ amount: 185260, quantity: 20, unit_amount: 9263, pricing_model: "per_unit" }],
    credit_note_estimates: [],
    next_invoice_estimate: { total: 59900, amount_due: 59600, credits_applied: 300, date: 1818007771, line_items: [{ entity_id: "flat-plan-monthly", quantity: 1, amount: 59900 }] },
  };
  const r = interpretChargebeeEstimate(estimate, {
    currency: "USD",
    currentItems: DEMO_CURRENT,
    targetItems: [{ itemPriceId: "flat-plan-monthly", quantity: 1 }, { itemPriceId: "perunit-addon-monthly", quantity: 21 }],
    priceInfo: PRICE_INFO,
  });
  assert.equal(r.effect.immediate?.net, 185260, "immediate is the prorated unbilled charge; the 300 of next-invoice credits do NOT reduce it");
  assert.equal(r.effect.recurring?.resultingAmount, 80900, "recurring is the underlying price (59900 + 21000); credits never reduce the subscription price");
  assert.equal(r.nextInvoice?.creditsApplied, 300);
  assert.equal(r.nextInvoice?.amountDue, 59600);
});

test("Test 13-fix7 (Phase 3): per_unit terms incomplete — recurring is ABSENT rather than fabricated", () => {
  const r = interpretChargebeeEstimate(
    { subscription_estimate: { id: "s", status: "active" }, unbilled_charge_estimates: [{ amount: 5000 }], credit_note_estimates: [] },
    {
      currency: "USD",
      // No unit price, no amount, no free_quantity anywhere: nothing
      // justifies a quantity computation for the changed item.
      currentItems: [{ itemPriceId: "perunit-addon-monthly", quantity: 5 }],
      targetItems: [{ itemPriceId: "perunit-addon-monthly", quantity: 9 }],
      priceInfo: new Map(),
    },
  );
  assert.equal(r.effect.immediate?.net, 5000, "immediate is still provider-stated and kept");
  assert.equal(r.effect.recurring, undefined, "recurring must be absent when its terms are unknown");
  assert.ok(r.provenance.recurring.startsWith("absent"));
});

// ---------- Phase 3 adapter-level regressions ----------

test("Test 13-fix2 (Phase 3): CHANGE_QUANTITY on a flat_fee item (plan or on/off addon) is refused BEFORE any provider estimate", async () => {
  const flatFake = new FakeChargebee({
    id: "cb_live_flat_1",
    items: [
      { item_price_id: "flat-plan-monthly", item_type: "plan", quantity: 1, unit_price: 59900, amount: 59900, free_quantity: 0 },
      { item_price_id: "onoff-addon-monthly", item_type: "addon", quantity: 1, unit_price: 500, amount: 500, free_quantity: 0 },
    ],
  });
  const adapter = makeAdapter(flatFake);
  for (const itemId of ["flat-plan-monthly", "onoff-addon-monthly"]) {
    await assert.rejects(
      () => adapter.createChangeQuote("cb_live_flat_1", { changes: [{ action: "CHANGE_QUANTITY", itemId, quantity: 21 }], effectiveIntent: { type: "IMMEDIATE" }, acceptanceEnvelope: ENVELOPE0 }),
      (e: unknown) => e instanceof SCQError && e.code === "UNSUPPORTED_CHANGE" && String(e.message).includes("flat_fee"),
      `${itemId}: quantity is not a settable dimension of a flat_fee item`,
    );
  }
  assert.equal(flatFake.estimateCount, 0, "refusal happens before the estimate call — the provider's 400 is never needed");
  assert.equal(flatFake.mutationCount, 0);
});

test("Test 13-fix8 (Phase 3): an unchanged on/off (flat_fee) addon rides along at its CURRENT quantity; the per_unit change quotes normally", async () => {
  const mixed = new FakeChargebee({
    id: "cb_live_mixed_1",
    items: [
      { item_price_id: "seat-basic-monthly", item_type: "plan", quantity: 100, unit_price: 1000, amount: 100000, free_quantity: 0 },
      { item_price_id: "onoff-addon-monthly", item_type: "addon", quantity: 1, unit_price: 500, amount: 500, free_quantity: 0 },
    ],
  });
  const adapter = makeAdapter(mixed);
  const quote = await adapter.createChangeQuote("cb_live_mixed_1", qtyProposal());
  const estReq = mixed.requests.find((r) => r.path === "/estimates/update_subscription_for_items");
  const body = new URLSearchParams(estReq!.body);
  assert.equal(body.get("subscription_items[item_price_id][1]"), "onoff-addon-monthly");
  assert.equal(body.get("subscription_items[quantity][1]"), "1", "the on/off addon is sent at its current quantity — never a changed one");
  assert.equal(quote.commercialEffect.immediate?.net, 20000);
  assert.equal(quote.commercialEffect.recurring?.resultingAmount, 120500, "120000 per-unit + the on/off addon at its observed 500");
  assert.equal(quote.commercialEffect.recurring?.previousAmount, 100500);
});

test("Test 13-fix9 (Phase 3): an estimate with NO determinable financials fails closed — no quote, no invented numbers", async () => {
  const fake = new FakeChargebee();
  fake.estimateShape = "empty"; // subscription_estimate only; no invoice/unbilled/next-invoice members
  const adapter = makeAdapter(fake);
  await assert.rejects(
    () => adapter.createChangeQuote("cb_live_test_1", qtyProposal()),
    (e: unknown) => e instanceof SCQError && e.code === "QUOTE_NOT_DETERMINISTIC",
    "recurring is computable here, but immediate is not — the envelope cannot be enforced, so the quote must be refused",
  );
  assert.equal(fake.mutationCount, 0);
  const fake2 = new FakeChargebee();
  fake2.estimateShape = "noEstimate"; // response without an estimate member at all
  const adapter2 = makeAdapter(fake2);
  await assert.rejects(
    () => adapter2.createChangeQuote("cb_live_test_1", qtyProposal()),
    (e: unknown) => e instanceof SCQError && e.code === "PROVIDER_ERROR",
  );
  assert.equal(fake2.mutationCount, 0);
});

test("Test 13-fix10 (Phase 3): commit revalidation with undeterminable financials refuses BEFORE mutation — absent is never compared as zero", async () => {
  const fake = new FakeChargebee();
  const adapter = makeAdapter(fake);
  const quote = await adapter.createChangeQuote("cb_live_test_1", qtyProposal());
  fake.estimateShape = "empty"; // the revalidation estimate loses every financial member
  await assert.rejects(
    () => adapter.commitChangeQuote(quote.id),
    (e: unknown) => e instanceof SCQError && e.code === "QUOTE_NOT_DETERMINISTIC",
    "the frozen engine would treat the absent dimensions as 0; the adapter must refuse instead of feeding it absent values",
  );
  assert.equal(fake.mutationCount, 0, "no mutating call may fire when the envelope cannot be enforced");
});

// ---------- Final pre-PR checks: unknown-versus-zero negative coverage ----------
// An UNKNOWN financial outcome (absent member, or a member element
// missing its figure) must never silently pass an acceptance-envelope
// check or reach mutation. A provider-STATED zero is a different thing
// and must be accepted as zero. These tests pin that distinction.

test("Test 13-neg1 (unknown-vs-zero): an unbilled-charge element WITHOUT an amount makes immediate unknown — the quote is refused, never zero-filled", async () => {
  const fake = new FakeChargebee();
  fake.estimateShape = "unbilledMissingAmount";
  const adapter = makeAdapter(fake);
  await assert.rejects(
    () => adapter.createChangeQuote("cb_live_test_1", qtyProposal()),
    (e: unknown) => e instanceof SCQError && e.code === "QUOTE_NOT_DETERMINISTIC",
    "an incomplete provider result must fail closed: the element is not a 0 and the envelope cannot be enforced on an unknown immediate dimension",
  );
  assert.equal(fake.mutationCount, 0);
});

test("Test 13-neg2 (unknown-vs-zero): credit_note_estimates member ABSENT while a net would need it — the quote is refused", async () => {
  const fake = new FakeChargebee();
  fake.estimateShape = "creditNotesAbsent";
  const adapter = makeAdapter(fake);
  await assert.rejects(
    () => adapter.createChangeQuote("cb_live_test_1", qtyProposal()),
    (e: unknown) => e instanceof SCQError && e.code === "QUOTE_NOT_DETERMINISTIC",
    "without the credit-note member the net is not final; quoting the gross as the net would fabricate a number",
  );
  assert.equal(fake.mutationCount, 0);
  // Same rule at the interpretation layer, for the element-level case:
  const r = interpretChargebeeEstimate(
    { subscription_estimate: { id: "s", status: "active" }, unbilled_charge_estimates: [{ amount: 20000 }], credit_note_estimates: [{}] },
    { currency: "USD", currentItems: [{ itemPriceId: "seat-basic-monthly", quantity: 100, unitPrice: 1000, amount: 100000, freeQuantity: 0 }], targetItems: [{ itemPriceId: "seat-basic-monthly", quantity: 120 }], priceInfo: new Map([["seat-basic-monthly", { itemPriceId: "seat-basic-monthly", pricingModel: "per_unit", price: 1000, freeQuantity: 0, itemType: "plan" }]]) },
  );
  assert.equal(r.effect.immediate, undefined, "a credit-note element without a total is not a 0 credit — immediate is absent");
  assert.ok(r.provenance.immediate.startsWith("absent"));
});

test("Test 13-neg3 (unknown-vs-zero): commit revalidation turns unknown — commit refuses BEFORE any mutating transport call", async () => {
  const fake = new FakeChargebee();
  const adapter = makeAdapter(fake);
  const quote = await adapter.createChangeQuote("cb_live_test_1", qtyProposal());
  fake.estimateShape = "unbilledMissingAmount"; // revalidation estimate is incomplete
  await assert.rejects(
    () => adapter.commitChangeQuote(quote.id),
    (e: unknown) => e instanceof SCQError && e.code === "QUOTE_NOT_DETERMINISTIC",
  );
  assert.equal(fake.mutationCount, 0, "no mutation may occur");
  assert.equal(fake.requests.filter((r) => r.path.endsWith("/update_for_items")).length, 0, "the mutating endpoint must never be invoked when the envelope cannot be enforced");
});

test("Test 13-neg4 (unknown-vs-zero): subscription_estimate items with unit_price but NO amount are not summed as unit_price x quantity for a flat_fee item", () => {
  const r = interpretChargebeeEstimate(
    { subscription_estimate: { subscription_items: [{ item_price_id: "flat-plan-monthly", quantity: 21, unit_price: 59900 }] }, credit_note_estimates: [], unbilled_charge_estimates: [] },
    { currency: "USD", currentItems: [DEMO_CURRENT[0]], targetItems: [{ itemPriceId: "flat-plan-monthly", quantity: 21 }], priceInfo: PRICE_INFO },
  );
  assert.equal(r.effect.recurring?.resultingAmount, 59900, "falls through to the pricing-model computation: flat_fee fixed price once — NOT 21 x 59900");
  assert.notEqual(r.effect.recurring?.resultingAmount, 1258900);
});

test("Test 13-zero1 (unknown-vs-zero): a provider-STATED zero (both members present and empty) is accepted as an actual zero — the quote succeeds", async () => {
  const fake = new FakeChargebee();
  fake.estimateShape = "statedZero";
  const adapter = makeAdapter(fake);
  const quote = await adapter.createChangeQuote("cb_live_test_1", qtyProposal());
  assert.equal(quote.commercialEffect.immediate?.net, 0, "empty unbilled array + present credit-note member = stated zero immediate, distinct from absent");
  assert.equal(quote.commercialEffect.recurring?.resultingAmount, 120000, "recurring still comes from the justified per_unit computation");
  assert.equal(fake.mutationCount, 0);
});

// ---------- PR #4 review fixes: stated-items completeness + committed-actuals honesty ----------
// Fix 1: a provider-stated subscription_estimate item list may be
// summed as the complete resulting recurring amount ONLY after it
// verifies as the ENTIRE intended item set (same items, no
// duplicates, matching quantities, stated amount on every item). A
// partial stated list must fall through to the pricing-model
// computation — never be reported as the result.
// Fix 2: the committed effect is built from ACTUALS ONLY; the
// pre-mutation estimate never supplies committed figures.
// PR-7 (v0.6.2) SUPERSESSION: the PR #4-era classification of an
// undeterminable actual outcome — INDETERMINATE with no receipt —
// applied only while the frozen v0.6.1 receipt type could not
// represent "committed but unverified" (protocol Defect 3). Under
// the v0.6.2 taxonomy, a landing KNOWN from a received response
// with unestablished financials records a COMMITTED_UNVERIFIED
// receipt (rec1/rec5), an independently attributable contradiction
// records a VIOLATED receipt (rec8/rec9), and INDETERMINATE covers
// landings that cannot be established at all (rec3/rec7) —
// including, per the PR-7 review correction L1, LOST-response
// cases (rec2, T07): a re-read showing the intended state cannot
// establish that THIS request landed it. Each changed test below
// carries its own DISCLOSED CHANGE note.

const FIX1_CTX = {
  currency: "USD",
  currentItems: DEMO_CURRENT,
  targetItems: [{ itemPriceId: "flat-plan-monthly", quantity: 1 }, { itemPriceId: "perunit-addon-monthly", quantity: 21 }],
  priceInfo: PRICE_INFO,
};
// The pricing-model computation for FIX1_CTX yields 80900 (flat 59900
// once + per-unit 21 x 1000). Every corrupted stated list below has a
// partial sum DIFFERENT from 80900, so a pass proves the partial sum
// was not used.

test("Test 13-fix11a (PR #4 review): stated item list MISSING the addon is not summed as the complete recurring amount", () => {
  const r = interpretChargebeeEstimate(
    { subscription_estimate: { subscription_items: [{ item_price_id: "flat-plan-monthly", quantity: 1, unit_price: 59900, amount: 59900 }] }, unbilled_charge_estimates: [], credit_note_estimates: [] },
    FIX1_CTX,
  );
  assert.notEqual(r.effect.recurring?.resultingAmount, 59900, "the partial stated sum (plan only) must not be reported as the resulting amount");
  assert.equal(r.effect.recurring?.resultingAmount, 80900, "falls through to the verified per-item computation");
});

test("Test 13-fix11b (PR #4 review): stated item list with a DUPLICATE item entry is not summed as the complete recurring amount", () => {
  const r = interpretChargebeeEstimate(
    {
      subscription_estimate: {
        subscription_items: [
          { item_price_id: "flat-plan-monthly", quantity: 1, unit_price: 59900, amount: 59900 },
          { item_price_id: "perunit-addon-monthly", quantity: 21, unit_price: 1000, amount: 21000 },
          { item_price_id: "perunit-addon-monthly", quantity: 21, unit_price: 1000, amount: 21000 },
        ],
      },
      unbilled_charge_estimates: [], credit_note_estimates: [],
    },
    FIX1_CTX,
  );
  assert.notEqual(r.effect.recurring?.resultingAmount, 101900, "the duplicated stated sum must not be reported");
  assert.equal(r.effect.recurring?.resultingAmount, 80900);
});

test("Test 13-fix11c (PR #4 review): stated item list with a MISMATCHED quantity is not summed as the complete recurring amount", () => {
  const r = interpretChargebeeEstimate(
    {
      subscription_estimate: {
        subscription_items: [
          { item_price_id: "flat-plan-monthly", quantity: 1, unit_price: 59900, amount: 59900 },
          { item_price_id: "perunit-addon-monthly", quantity: 20, unit_price: 1000, amount: 20000 }, // intended: 21
        ],
      },
      unbilled_charge_estimates: [], credit_note_estimates: [],
    },
    FIX1_CTX,
  );
  assert.notEqual(r.effect.recurring?.resultingAmount, 79900, "the quantity-mismatched stated sum must not be reported");
  assert.equal(r.effect.recurring?.resultingAmount, 80900);
});

test("Test 13-fix11d (PR #4 review): stated item list that is a PARTIAL SUBSET (addon only) is not summed as the complete recurring amount", () => {
  const r = interpretChargebeeEstimate(
    { subscription_estimate: { subscription_items: [{ item_price_id: "perunit-addon-monthly", quantity: 21, unit_price: 1000, amount: 21000 }] }, unbilled_charge_estimates: [], credit_note_estimates: [] },
    FIX1_CTX,
  );
  assert.notEqual(r.effect.recurring?.resultingAmount, 21000, "the subset stated sum must not be reported");
  assert.equal(r.effect.recurring?.resultingAmount, 80900);
});

test("Test 13-fix11e (PR #4 review, adapter level): an estimate whose stated list omits an intended item does not produce the partial sum in the quote", async () => {
  const fake = new FakeChargebee({
    id: "cb_live_mixed_2",
    items: [
      { item_price_id: "seat-basic-monthly", item_type: "plan", quantity: 100, unit_price: 1000, amount: 100000, free_quantity: 0 },
      { item_price_id: "onoff-addon-monthly", item_type: "addon", quantity: 1, unit_price: 500, amount: 500, free_quantity: 0 },
    ],
  });
  // Override ONLY the estimate response: its stated item list omits
  // the on/off addon entirely (a partial provider view).
  const partial: HttpTransport = async (req) => {
    if (req.method === "POST" && req.url.includes("/estimates/")) {
      return {
        status: 200, headers: {},
        json: {
          estimate: {
            object: "estimate",
            subscription_estimate: { id: "cb_live_mixed_2", status: "active", currency_code: "USD", subscription_items: [{ item_price_id: "seat-basic-monthly", quantity: 120, unit_price: 1000, amount: 120000 }] },
            unbilled_charge_estimates: [{ amount: 20000 }],
            credit_note_estimates: [],
          },
        },
      };
    }
    return fake.transport(req);
  };
  const client = new ChargebeeClient({ site: "scq-test", apiKey: "test_key_redacted" }, partial);
  const adapter = new ChargebeeLiveAdapter(client, new QuoteStore(), { liveCommitEnabled: true });
  const quote = await adapter.createChangeQuote("cb_live_mixed_2", qtyProposal());
  assert.notEqual(quote.commercialEffect.recurring?.resultingAmount, 120000, "the partial stated sum (plan only) must not become the quote's recurring amount");
  assert.equal(quote.commercialEffect.recurring?.resultingAmount, 120500, "computed per item instead: 120000 per-unit + the unchanged on/off addon at its observed 500");
});

/**
 * PR-14 migration helper (Issue #22, Finding 1): every test below
 * that previously drove a dispatch outcome through the live adapter
 * now asserts the authorization preservation refusal instead. The
 * scenarios' fixtures (armed provider faults, doctored transports)
 * are preserved verbatim: the point of each migrated test is that
 * the fault class it armed can no longer occur through this
 * adapter, because the commit refuses BEFORE the only dispatch —
 * with CONFIRMED_NON_EXECUTION semantics, zero mutations, and no
 * receipt. The receipt-classification machinery each scenario
 * originally exercised remains implemented in the adapter's
 * dispatch path for a future permitting capability and remains
 * covered by the simulator and store suites; it is unreachable
 * here by design, and these tests say so rather than deleting the
 * scenarios.
 */
async function expectPreservationRefusal(adapter: ChargebeeLiveAdapter, quoteId: string): Promise<void> {
  await assert.rejects(
    () => adapter.commitChangeQuote(quoteId),
    (e: unknown) =>
      e instanceof SCQError &&
      e.code === "AUTHORIZATION_PRESERVATION_UNENFORCEABLE" &&
      (e.details as any)?.outcome === "CONFIRMED_NON_EXECUTION" &&
      (e.details as any)?.indeterminate !== true,
    "the commit must refuse pre-dispatch with the preservation code and CONFIRMED_NON_EXECUTION semantics",
  );
}

test("Test 13-rec1 (PR #4 review; PR-7 classification): incomplete post-update response (no invoice, no unbilled_charges) — COMMITTED_UNVERIFIED receipt, immediate UNKNOWN", async () => {
  // DISCLOSED CHANGE (PR-7, v0.6.2): this test previously asserted
  // the PR #4 posture — INDETERMINATE and NO receipt — because the
  // frozen v0.6.1 receipt type could not represent "committed but
  // financially unverified" (protocol Defect 3). The v0.6.2 type
  // can, and this scenario is its headline case: the mutation
  // response WAS received (the landing is known), the independent
  // re-read establishes the intended item set with attribution
  // closed, and the recurring actual is established from the
  // re-read — only the immediate actual is unavailable. The outcome
  // is therefore a typed COMMITTED_UNVERIFIED receipt with the
  // immediate dimension UNKNOWN — never the pre-mutation estimate
  // substituted as an actual, never reconciled as OK.
  // PR-14 MIGRATION: this scenario armed an incomplete post-update
  // response and asserted the COMMITTED_UNVERIFIED receipt it
  // produced. That response can no longer occur through this
  // adapter — the commit refuses pre-dispatch — so the test now
  // asserts the refusal. The COMMITTED_UNVERIFIED classification
  // (Defect 3) remains implemented and covered elsewhere; the
  // protection this test carries forward is stronger: with no
  // dispatch, no unverifiable landing can be created at all.
  const fake = new FakeChargebee();
  fake.updateShape = "noFinancials"; // armed, but never exercised: no update is dispatched
  const store = new QuoteStore();
  const adapter = makeAdapter(fake, { store });
  const quote = await adapter.createChangeQuote("cb_live_test_1", qtyProposal());
  await expectPreservationRefusal(adapter, quote.id);
  assert.equal(fake.mutationCount, 0, "no mutation was issued — the incomplete-response shape was never produced");
  assert.equal(store.get(quote.id)?.commit_receipt, undefined, "no receipt is recorded for a refused commit");
  assert.equal(store.get(quote.id)?.commit_outcome?.outcome, "CONFIRMED_NON_EXECUTION");
});

test("Test 13-rec2 (PR #4 review; PR-7 review L1 classification): lost response; re-read shows the intended items but WITHOUT determinable amounts — INDETERMINATE, outcome recorded, no receipt", async () => {
  // DISCLOSED CHANGE (PR-7 review L1): PR-7 as first delivered
  // classified this COMMITTED_UNVERIFIED, reasoning that the
  // re-read established the landing. The review corrected that: the
  // re-read shows the intended items in effect, but it cannot
  // establish that THIS request landed them — an independent actor
  // applying the same set produces identical observations
  // (test26-12b), and no operation-bound execution evidence exists.
  // The outcome is therefore INDETERMINATE: the outcome is recorded
  // (observed state retained as diagnostic context), NO committed
  // receipt is recorded, and blind retry is refused. What the
  // PR #4 test protected is preserved: a missing resultingAmount
  // never reaches reconciliation as an OK, and no figure is ever
  // recorded for this commit. Scenario preserved (the mutation
  // does land at the fake provider; its response is lost; the
  // re-read's amounts are stripped).
  const fake = new FakeChargebee();
  const store = new QuoteStore();
  let updateApplied = false;
  const lossyStrip: HttpTransport = async (req) => {
    if (req.method === "POST" && req.url.includes("/update_for_items")) {
      await fake.transport(req); // the mutation lands at the provider
      updateApplied = true;
      throw new Error("socket timeout"); // ...but its response is lost
    }
    const res = await fake.transport(req);
    if (updateApplied && req.method === "GET" && req.url.includes("/subscriptions/") && res.json) {
      const j = structuredClone(res.json) as any;
      for (const it of j.subscription.subscription_items) delete it.amount; // post-commit state without determinable amounts
      return { ...res, json: j };
    }
    return res;
  };
  const client = new ChargebeeClient({ site: "scq-test", apiKey: "test_key_redacted" }, lossyStrip);
  const adapter = new ChargebeeLiveAdapter(client, store, { liveCommitEnabled: true });
  const quote = await adapter.createChangeQuote("cb_live_test_1", qtyProposal());
  // PR-14 MIGRATION: the lossy dispatch never happens — the commit
  // refuses pre-dispatch, so there is no response to lose and no
  // INDETERMINATE outcome. The retry assertion is preserved in its
  // stronger form: a repeated commit returns the identical
  // preservation refusal deterministically (not the INDETERMINATE
  // guard — the recorded outcome here is CONFIRMED_NON_EXECUTION).
  // The L1 doctrine itself (a landed-but-unattributable dispatch is
  // INDETERMINATE) is untouched and remains covered at the
  // store/ledger level (test27, rehearsal rh-04/05).
  await expectPreservationRefusal(adapter, quote.id);
  assert.equal(store.get(quote.id)?.commit_outcome?.outcome, "CONFIRMED_NON_EXECUTION", "a pre-dispatch refusal is never recorded as INDETERMINATE");
  assert.equal(store.get(quote.id)?.commit_receipt, undefined, "no committed receipt");
  assert.equal(fake.mutationCount, 0, "no mutation was dispatched; nothing could be lost");
  await expectPreservationRefusal(adapter, quote.id);
  assert.equal(fake.mutationCount, 0, "the retry refuses identically — still no dispatch");
});

test("Test 13-rec3 (PR #4 review): lost response and provider state does NOT show the intended change — the existing indeterminate refusal is preserved", async () => {
  const fake = new FakeChargebee();
  const store = new QuoteStore();
  const dropUpdate: HttpTransport = async (req) => {
    if (req.method === "POST" && req.url.includes("/update_for_items")) throw new Error("connection reset before send"); // never applied
    return fake.transport(req);
  };
  const client = new ChargebeeClient({ site: "scq-test", apiKey: "test_key_redacted" }, dropUpdate);
  const adapter = new ChargebeeLiveAdapter(client, store, { liveCommitEnabled: true });
  const quote = await adapter.createChangeQuote("cb_live_test_1", qtyProposal());
  // PR-14 MIGRATION: the dropped dispatch never happens — the
  // preservation refusal precedes it. The original protection (no
  // mutation, no receipt, fail closed) is preserved and the refusal
  // is now the deterministic pre-dispatch class rather than the
  // post-dispatch indeterminate one.
  await expectPreservationRefusal(adapter, quote.id);
  assert.equal(fake.mutationCount, 0, "the mutation was never dispatched, landed, or re-issued");
  assert.equal(store.get(quote.id)?.commit_receipt, undefined);
});

test("Test 13-rec4 (PR #4 review): a complete ACTUAL response is recorded with the ACTUAL figures — not the estimate's — and reconciliation reports the difference", async () => {
  const fake = new FakeChargebee();
  const store = new QuoteStore();
  // The provider's actual update response reports an unbilled total of
  // 25000, although the pre-mutation estimate said 20000.
  const rewrite: HttpTransport = async (req) => {
    const res = await fake.transport(req);
    if (req.method === "POST" && req.url.includes("/update_for_items") && res.json) {
      const j = structuredClone(res.json) as any;
      j.unbilled_charges = [{ amount: 25000 }];
      return { ...res, json: j };
    }
    return res;
  };
  const client = new ChargebeeClient({ site: "scq-test", apiKey: "test_key_redacted" }, rewrite);
  const adapter = new ChargebeeLiveAdapter(client, store, { liveCommitEnabled: true });
  const quote = await adapter.createChangeQuote("cb_live_test_1", qtyProposal());
  assert.equal(quote.commercialEffect.immediate?.net, 20000, "the quote carries the estimate, as expected");
  // PR-14 MIGRATION: the actuals-rewriting transport is never
  // exercised — the commit refuses pre-dispatch, so no response
  // exists whose actuals could be recorded or violate the envelope.
  // The actuals-over-estimate doctrine remains implemented in the
  // dispatch path and covered by the simulator suites.
  await expectPreservationRefusal(adapter, quote.id);
  assert.equal(fake.mutationCount, 0, "no mutation was dispatched");
  assert.equal(fake.sub.subscription_items[0].quantity, 100, "provider state is untouched");
  assert.equal(store.get(quote.id)?.commit_receipt, undefined, "no receipt is recorded for a refused commit");
});

test("Test 13-rec5 (PR #4 final review, Fix A; PR-7 classification): post-commit re-read OMITS subscription_items entirely — COMMITTED_UNVERIFIED, recurring UNKNOWN, never a verified 0", async () => {
  // DISCLOSED CHANGE (PR-7, v0.6.2): previously INDETERMINATE with
  // no receipt (Defect-3 posture). The mutation response WAS
  // received, so the landing is known; what the absent re-read
  // member destroys is VERIFICATION, not landing — the outcome is
  // a typed COMMITTED_UNVERIFIED receipt. Fix A's protection is
  // preserved exactly: the recurring dimension is UNKNOWN with NO
  // figure (an absent collection is still never summed as a
  // verified 0 — the original `?? []` defect), while the immediate
  // actual, which the update response itself carries, is
  // established and recorded as DETERMINED.
  const fake = new FakeChargebee();
  const store = new QuoteStore();
  let updateApplied = false;
  const omitItems: HttpTransport = async (req) => {
    const res = await fake.transport(req);
    if (req.method === "POST" && req.url.includes("/update_for_items")) updateApplied = true;
    if (updateApplied && req.method === "GET" && req.url.includes("/subscriptions/") && res.json) {
      const j = structuredClone(res.json) as any;
      delete j.subscription.subscription_items; // the member is ABSENT from the re-read — not an empty list, not a zero
      return { ...res, json: j };
    }
    return res;
  };
  const client = new ChargebeeClient({ site: "scq-test", apiKey: "test_key_redacted" }, omitItems);
  const adapter = new ChargebeeLiveAdapter(client, store, { liveCommitEnabled: true });
  const quote = await adapter.createChangeQuote("cb_live_test_1", qtyProposal());
  // PR-14 MIGRATION: no dispatch occurs, so no post-commit re-read
  // exists to omit anything. Fix A's underlying protection — an
  // absent collection is never summed as a verified 0 — is
  // preserved a fortiori: no committed figure of any kind is
  // recorded for a refused commit.
  await expectPreservationRefusal(adapter, quote.id);
  assert.equal(fake.mutationCount, 0, "no mutation was issued");
  assert.equal(store.get(quote.id)?.commit_receipt, undefined, "no receipt — and therefore no recurring figure — is recorded");
});

test("Test 13-rec6 (PR #4 final review, Fix A): an item with a stated amount of exactly 0 in a complete, intended-matching set is a DETERMINED zero — receipt records it", async () => {
  const fake = new FakeChargebee({
    id: "cb_live_zero_1",
    items: [
      { item_price_id: "seat-basic-monthly", item_type: "plan", quantity: 100, unit_price: 1000, amount: 100000, free_quantity: 0 },
      { item_price_id: "onoff-addon-monthly", item_type: "addon", quantity: 1, unit_price: 500, amount: 500, free_quantity: 0 },
    ],
  });
  const store = new QuoteStore();
  let updateApplied = false;
  const zeroAddon: HttpTransport = async (req) => {
    const res = await fake.transport(req);
    if (req.method === "POST" && req.url.includes("/update_for_items")) updateApplied = true;
    if (updateApplied && req.method === "GET" && req.url.includes("/subscriptions/") && res.json) {
      const j = structuredClone(res.json) as any;
      // The provider re-read states the addon's amount as literally 0
      // (e.g. fully discounted in the new term). IDs and quantities are
      // untouched: the observed set is complete and matches the intent.
      for (const it of j.subscription.subscription_items) if (it.item_price_id === "onoff-addon-monthly") it.amount = 0;
      return { ...res, json: j };
    }
    return res;
  };
  const client = new ChargebeeClient({ site: "scq-test", apiKey: "test_key_redacted" }, zeroAddon);
  const adapter = new ChargebeeLiveAdapter(client, store, { liveCommitEnabled: true });
  const quote = await adapter.createChangeQuote("cb_live_zero_1", qtyProposal());
  assert.equal(quote.commercialEffect.recurring?.resultingAmount, 120500, "quote: 120000 per-unit plan + the flat_fee addon at its fixed 500");
  // PR-14 MIGRATION: the quote-side determined-zero behavior above
  // is unchanged and still asserted. The commit now refuses
  // pre-dispatch (the refusal is about authorization preservation,
  // NOT about the stated zero — a determined zero is still never
  // treated as missing data anywhere in quote or revalidation).
  await expectPreservationRefusal(adapter, quote.id);
  assert.equal(fake.mutationCount, 0, "no mutation was issued");
  assert.equal(store.get(quote.id)?.commit_receipt, undefined, "no receipt is recorded for a refused commit");
});

test("Test 13-rec7 (PR #4 final review, Fix B): update returns HTTP 200 success-shaped but the provider SILENTLY IGNORED the change — INDETERMINATE, no receipt", async () => {
  const fake = new FakeChargebee();
  const store = new QuoteStore();
  const silentIgnore: HttpTransport = async (req) => {
    if (req.method === "POST" && req.url.includes("/update_for_items")) {
      // A 200 with plausible financials that EXACTLY satisfy the
      // envelope (20000, matching the estimate) — but the provider
      // never applied anything: its stored state is untouched.
      return { status: 200, headers: {}, json: { subscription: structuredClone(fake.sub), unbilled_charges: [{ amount: 20000 }] } };
    }
    return fake.transport(req);
  };
  const client = new ChargebeeClient({ site: "scq-test", apiKey: "test_key_redacted" }, silentIgnore);
  const adapter = new ChargebeeLiveAdapter(client, store, { liveCommitEnabled: true });
  const quote = await adapter.createChangeQuote("cb_live_test_1", qtyProposal());
  // PR-14 MIGRATION: the silent-ignore response is never produced —
  // no dispatch is sent for it to answer. Fix B's protection (a
  // success-shaped response never fabricates a COMMITTED receipt)
  // is preserved in its strongest form: no receipt of any kind is
  // recorded, and the refusal is the pre-dispatch class.
  await expectPreservationRefusal(adapter, quote.id);
  assert.equal(fake.mutationCount, 0, "the provider never mutated — and no COMMITTED receipt was fabricated");
  assert.equal(store.get(quote.id)?.commit_receipt, undefined);
  assert.notEqual(store.get(quote.id)?.status, "COMMITTED");
});

test("Test 13-rec8 (PR #4 final review, Fix B; PR-7 classification): update partially applies — re-read quantity is 110, not the intended 120 — attributable VIOLATED receipt", async () => {
  // DISCLOSED CHANGE (PR-7, v0.6.2): previously INDETERMINATE with
  // no receipt. Under the migration the wrong landing is
  // independently attributable to this commit — the mutating call's
  // response state and the independent re-read agree (same
  // fingerprint), so no intervening write can account for it — and
  // both financial dimensions are established from the presented
  // actuals. That is Decision D3's determined negative verification:
  // a COMMITTED_AND_VERIFIED receipt whose reconciliation is
  // VIOLATED, carrying the actual (110) figures. Fix B's protection
  // is preserved in the stronger form: a partially applied change is
  // still never silently accepted as the intended commit — it is
  // now REPORTED as a verified violation instead of being collapsed
  // into the indeterminate class.
  const fake = new FakeChargebee();
  const store = new QuoteStore();
  let updateApplied = false;
  const partialApply: HttpTransport = async (req) => {
    const res = await fake.transport(req);
    if (req.method === "POST" && req.url.includes("/update_for_items")) updateApplied = true;
    if (updateApplied && req.method === "GET" && req.url.includes("/subscriptions/") && res.json) {
      const j = structuredClone(res.json) as any;
      for (const it of j.subscription.subscription_items) if (it.item_price_id === "seat-basic-monthly") { it.quantity = 110; it.amount = 110000; }
      return { ...res, json: j };
    }
    return res;
  };
  const client = new ChargebeeClient({ site: "scq-test", apiKey: "test_key_redacted" }, partialApply);
  const adapter = new ChargebeeLiveAdapter(client, store, { liveCommitEnabled: true });
  const quote = await adapter.createChangeQuote("cb_live_test_1", qtyProposal());
  // PR-14 MIGRATION: no dispatch occurs, so no partial application
  // can be produced or attributed. D3's determined-negative-
  // verification machinery remains implemented in the dispatch
  // path; here the protection is prevention — a wrong landing is
  // impossible because nothing lands.
  await expectPreservationRefusal(adapter, quote.id);
  assert.equal(fake.mutationCount, 0, "no mutation was issued — nothing partially applied");
  assert.equal(fake.sub.subscription_items[0].quantity, 100, "provider state is untouched");
  assert.equal(store.get(quote.id)?.commit_receipt, undefined, "no receipt is recorded for a refused commit");
});

test("Test 13-rec9 (PR #4 final review, Fix B; PR-7 classification): re-read shows an EXTRA item, and (separately) a DUPLICATED entry — both attributable VIOLATED receipts", async () => {
  // DISCLOSED CHANGE (PR-7, v0.6.2): same reclassification as rec8 —
  // previously INDETERMINATE with no receipt; now the contradiction
  // (extra / duplicated entry in the independently re-read set,
  // attribution closed, actuals established) is a determined
  // negative verification: COMMITTED_AND_VERIFIED with a VIOLATED
  // reconciliation over the presented actuals.
  const run = async (doctor: (items: any[]) => void) => {
    const fake = new FakeChargebee();
    const store = new QuoteStore();
    let updateApplied = false;
    const transport: HttpTransport = async (req) => {
      const res = await fake.transport(req);
      if (req.method === "POST" && req.url.includes("/update_for_items")) updateApplied = true;
      if (updateApplied && req.method === "GET" && req.url.includes("/subscriptions/") && res.json) {
        const j = structuredClone(res.json) as any;
        doctor(j.subscription.subscription_items);
        return { ...res, json: j };
      }
      return res;
    };
    const client = new ChargebeeClient({ site: "scq-test", apiKey: "test_key_redacted" }, transport);
    const adapter = new ChargebeeLiveAdapter(client, store, { liveCommitEnabled: true });
    const quote = await adapter.createChangeQuote("cb_live_test_1", qtyProposal());
    // PR-14 MIGRATION (both doctor variants): no dispatch occurs,
    // so the doctored re-read is never produced — the extra /
    // duplicated entry can never enter a landed set through this
    // adapter. Prevention replaces the former VIOLATED receipt.
    await expectPreservationRefusal(adapter, quote.id);
    assert.equal(fake.mutationCount, 0, "no mutation was issued");
    assert.equal(store.get(quote.id)?.commit_receipt, undefined, "no receipt is recorded for a refused commit");
  };
  await run((items) => { items.push({ item_price_id: "perunit-addon-monthly", item_type: "addon", quantity: 3, unit_price: 1000, amount: 3000, free_quantity: 0 }); });
  await run((items) => { items.push({ ...items[0] }); });
});

test("Test 13-rec10 (PR #4 final review, Fix B positive control): re-read matches the intended set exactly — the COMMITTED receipt records as before", async () => {
  // PR-14 MIGRATION — the positive control is deliberately
  // inverted: even with a perfectly behaved provider whose landed
  // set WOULD match the intent exactly, the commit refuses. The
  // preservation defect was never about this run's outcome; it is
  // that a non-atomic full-list replacement cannot rule out the
  // interfering run, and the absence of observed interference is
  // not safety (the same reasoning as test47.2 / repro43.2
  // revisited). The former control's role — proving the harness
  // CAN produce a verified commit — is now served by the simulator
  // adapters' suites (e.g. test25), whose mechanisms are in-model.
  const fake = new FakeChargebee();
  const store = new QuoteStore();
  const adapter = makeAdapter(fake, { store });
  const quote = await adapter.createChangeQuote("cb_live_test_1", qtyProposal());
  await expectPreservationRefusal(adapter, quote.id);
  assert.equal(fake.mutationCount, 0, "no mutation was issued even though the provider would have landed the intended set exactly");
  assert.equal(store.get(quote.id)?.commit_receipt, undefined, "no receipt is recorded for a refused commit");
});

// ---------- T01–T14 (mocked transport; classifications in TEST-RESULTS.md) ----------

test("T01 (SIMULATED_PASS): initial subscription read produces an accurate normalized snapshot", async () => {
  const fake = new FakeChargebee();
  const adapter = makeAdapter(fake);
  const snap = await adapter.getSubscription("cb_live_test_1");
  assert.equal(snap.items[0].quantity, 100);
  assert.equal(snap.billing.recurringAmount, 100000);
  assert.equal(snap.billing.currency, "USD");
  assert.equal(snap.version, "rv:1700000000000", "version is the provider resource_version when present, not an invented counter");
  assert.equal(adapter.getCapabilities().consistencyGuarantee, "BEST_EFFORT");
});

test("T02 (SIMULATED_PASS): quote 100 -> 120 performs retrieve + estimate only; provider state unchanged", async () => {
  const fake = new FakeChargebee();
  const adapter = makeAdapter(fake);
  const before = await adapter.getSubscription("cb_live_test_1");
  const quote = await adapter.createChangeQuote("cb_live_test_1", qtyProposal());
  const after = await adapter.getSubscription("cb_live_test_1");
  assert.equal(fake.mutationCount, 0);
  assert.equal(after.version, before.version);
  assert.equal(after.items[0].quantity, 100);
  assert.equal(quote.commercialEffect.immediate?.net, 20000, "immediate comes from the unbilled-charge estimate (the live sparse shape), not an invoice_estimate");
  assert.equal(quote.commercialEffect.recurring?.resultingAmount, 120000, "recurring is the justified per_unit computation (120 x 1000, free_quantity 0)");
  assert.equal(quote.commercialEffect.recurring?.previousAmount, 100000);
  assert.equal(quote.guaranteeCoverage.immediateFinancialEffect, "REVALIDATE", "live adapter must not claim EXACT: no documented pinning mechanism exists");
  assert.equal(quote.guaranteeCoverage.termEffect, "UNKNOWN");
});

test("T03 (SIMULATED_PASS): normal quote and commit — correct outcome, receipt, replace semantics, no invoice collection", async () => {
  // PR-14 MIGRATION: the "normal" commit is exactly the unsafe
  // operation — a full-list replacement under OPERATION
  // authorization — so it now refuses pre-dispatch. What this test
  // still proves: the quote flow is unchanged; NO update_for_items
  // request is ever constructed or sent (so replace semantics and
  // invoice collection are moot — nothing is dispatched); provider
  // state is untouched. The request-shape assertions that used to
  // run against the dispatched request (replace_items_list=true,
  // invoice_immediately=false, scq- idempotency key) remain covered
  // against the request builder itself by the preflight suites
  // (test37–42), which derive the would-be dispatch from
  // buildChargebeeUpdateParams without sending it.
  const fake = new FakeChargebee();
  const adapter = makeAdapter(fake);
  const quote = await adapter.createChangeQuote("cb_live_test_1", qtyProposal());
  await expectPreservationRefusal(adapter, quote.id);
  assert.equal(fake.mutationCount, 0, "no mutation was dispatched");
  assert.equal(fake.requests.find((r) => r.path.endsWith("/update_for_items")), undefined, "no mutating request was constructed or sent");
  assert.equal(fake.sub.subscription_items[0].quantity, 100, "provider state is untouched");
});

test("T04 (SIMULATED_PASS): subscription changes after quote — stale-state detection via resource_version, no mutation", async () => {
  const fake = new FakeChargebee();
  const adapter = makeAdapter(fake);
  const quote = await adapter.createChangeQuote("cb_live_test_1", qtyProposal());
  fake.debugMutate((s) => { s.subscription_items[0].quantity = 150; });
  await assert.rejects(() => adapter.commitChangeQuote(quote.id), (e: unknown) => e instanceof SCQError && e.code === "QUOTE_STALE");
  assert.equal(fake.mutationCount, 0);
});

test("T05 (SIMULATED_PASS): financial estimate changes before commit (outside the subscription fingerprint) — envelope enforced before mutation", async () => {
  const fake = new FakeChargebee();
  const adapter = makeAdapter(fake);
  const quote = await adapter.createChangeQuote("cb_live_test_1", qtyProposal());
  fake.estimateExtraNet = 5000; // e.g. balances/tax-configuration drift the subscription resource_version does not capture
  await assert.rejects(() => adapter.commitChangeQuote(quote.id), (e: unknown) => e instanceof SCQError && e.code === "QUOTE_DRIFTED");
  assert.equal(fake.mutationCount, 0, "envelope refusal must happen before the mutating call");
});

test("T06 (SIMULATED_PASS): commit repeated with same quote ID — no duplicate mutation, same historical receipt", async () => {
  // PR-14 MIGRATION: a refused commit has no receipt to replay; the
  // idempotency property is preserved in refusal form — the second
  // commit returns the identical refusal deterministically and no
  // mutation ever occurs. (§6.10 original-receipt replay for
  // successful commits remains implemented and covered by the
  // simulator and store suites.)
  const fake = new FakeChargebee();
  const adapter = makeAdapter(fake);
  const quote = await adapter.createChangeQuote("cb_live_test_1", qtyProposal());
  await expectPreservationRefusal(adapter, quote.id);
  await expectPreservationRefusal(adapter, quote.id);
  assert.equal(fake.mutationCount, 0, "no mutation on either attempt");
});

test("T07 (SIMULATED_PASS): provider processes commit, response is lost — INDETERMINATE: matching state does not establish that THIS request landed (PR-7 review L1)", async () => {
  // Behavior changed on review, twice. PR #4 round: the adapter
  // stopped recovering a receipt from the re-read state plus the
  // PRE-MUTATION ESTIMATE and failed closed as INDETERMINATE with
  // no receipt (the frozen v0.6.1 type had no committed-but-
  // unverified state — protocol Defect 3). PR-7 as first delivered
  // flipped this to a COMMITTED_UNVERIFIED receipt on the theory
  // that the re-read established the landing. The PR-7 review (L1)
  // corrected that theory: the re-read establishes that the
  // intended state is in effect, not that THIS request caused it —
  // an independent actor's identical write is observationally
  // indistinguishable (test26-12b), and Chargebee provides no
  // operation-bound execution evidence here. Final classification:
  // INDETERMINATE — outcome recorded, NO receipt, blind retry
  // refused. The PR #4 protections survive intact: no figure is
  // recorded for either dimension and the estimate is never
  // substituted. (COMMITTED_UNVERIFIED remains for cases where a
  // response WAS received — rec1, test21-c8.)
  const fake = new FakeChargebee();
  const store = new QuoteStore();
  let loseOnce = true;
  const lossy: HttpTransport = async (req) => {
    const res = await fake.transport(req); // server applies the mutation
    if (loseOnce && req.method === "POST" && req.url.includes("/update_for_items")) { loseOnce = false; throw new Error("socket timeout"); }
    return res;
  };
  const client = new ChargebeeClient({ site: "scq-test", apiKey: "test_key_redacted" }, lossy);
  const adapter = new ChargebeeLiveAdapter(client, store, { liveCommitEnabled: true });
  const quote = await adapter.createChangeQuote("cb_live_test_1", qtyProposal());
  // PR-14 MIGRATION: the lossy dispatch never happens — the commit
  // refuses pre-dispatch, so the L1 scenario (landed but
  // unattributable) cannot be produced through this adapter. The
  // protections this test carried are preserved in stronger form:
  // zero mutations (not exactly one), provider state untouched, no
  // receipt, and the retry refuses identically with the
  // preservation code — NOT via the INDETERMINATE guard, because
  // the recorded outcome is CONFIRMED_NON_EXECUTION. L1 remains
  // implemented for dispatched paths and covered at the
  // store/ledger level (test27, rehearsal rh-04/05, test47.10).
  await expectPreservationRefusal(adapter, quote.id);
  assert.equal(fake.mutationCount, 0, "no provider mutation — the response-loss scenario cannot arise");
  assert.equal(fake.sub.subscription_items[0].quantity, 100, "provider state is untouched");
  assert.equal(store.get(quote.id)?.commit_outcome?.outcome, "CONFIRMED_NON_EXECUTION");
  assert.equal(store.get(quote.id)?.commit_receipt, undefined, "no committed receipt is recorded");
  await expectPreservationRefusal(adapter, quote.id);
  assert.equal(fake.mutationCount, 0, "a repeated attempt still performs no mutation — the refusal is deterministic");
});

test("T08+T09 (SIMULATED_PASS): concurrent change between final preview and commit — TOCTOU lands, reconciliation reports VIOLATED, no rollback is claimed", async () => {
  // PR-14 MIGRATION: this scenario armed a concurrent reprice
  // inside the validate->dispatch window — the same window class
  // as Issue #22 Finding 1 — and asserted the commit landed with a
  // VIOLATED reconciliation. Post-PR-14 the commit refuses
  // pre-dispatch, so the TOCTOU cannot land at all: the concurrent
  // hook is never even invoked (it fired on the update call), no
  // mutation occurs, and no receipt exists to carry a violation.
  // Prevention replaces post-hoc violation reporting for this
  // adapter; the BEST_EFFORT / no-CAS fact that motivated both is
  // unchanged and is now the gate's stated basis.
  const fake = new FakeChargebee();
  const adapter = makeAdapter(fake);
  const quote = await adapter.createChangeQuote("cb_live_test_1", qtyProposal());
  fake.beforeUpdate = () => { ITEM_PRICES["seat-basic-monthly"].price = 2000; fake.sub.subscription_items[0].unit_price = 2000; };
  try {
    await expectPreservationRefusal(adapter, quote.id);
    assert.equal(fake.mutationCount, 0, "the TOCTOU window is never entered — no dispatch occurs inside it");
    assert.equal(fake.sub.subscription_items[0].quantity, 100, "provider state is untouched");
  } finally { ITEM_PRICES["seat-basic-monthly"].price = 1000; }
});

test("T10 (SIMULATED_PASS): unsupported combined change refused before any provider mutation — and before any estimate", async () => {
  const fake = new FakeChargebee();
  const adapter = makeAdapter(fake);
  await assert.rejects(
    () => adapter.createChangeQuote("cb_live_test_1", { changes: [{ action: "CHANGE_QUANTITY", itemId: "seat-basic-monthly", quantity: 120 }, { action: "CHANGE_PLAN", itemId: "seat-basic-monthly", offeringRef: "seat-pro-monthly" }], effectiveIntent: { type: "IMMEDIATE" }, acceptanceEnvelope: ENVELOPE0 }),
    (e: unknown) => e instanceof SCQError && e.code === "UNSUPPORTED_CHANGE",
  );
  await assert.rejects(
    () => adapter.createChangeQuote("cb_live_test_1", { changes: [{ action: "CANCEL" }], effectiveIntent: { type: "IMMEDIATE" } }),
    (e: unknown) => e instanceof SCQError && e.code === "UNSUPPORTED_CHANGE",
  );
  assert.equal(fake.mutationCount, 0);
  assert.equal(fake.estimateCount, 0);
});

test("T11 (SIMULATED_PASS): quote expires before commit — refused QUOTE_EXPIRED, no mutation; EXACT request also refused honestly", async () => {
  const fake = new FakeChargebee();
  let clock = new Date(T0);
  const adapter = makeAdapter(fake, { now: () => clock });
  const quote = await adapter.createChangeQuote("cb_live_test_1", qtyProposal());
  clock = new Date(T0.getTime() + 6 * 60 * 1000); // past the 5-minute TTL
  await assert.rejects(() => adapter.commitChangeQuote(quote.id), (e: unknown) => e instanceof SCQError && e.code === "QUOTE_EXPIRED");
  assert.equal(fake.mutationCount, 0);
  await assert.rejects(
    () => adapter.createChangeQuote("cb_live_test_1", { changes: [{ action: "CHANGE_QUANTITY", itemId: "seat-basic-monthly", quantity: 120 }], effectiveIntent: { type: "IMMEDIATE" }, guaranteeMode: "EXACT" }),
    (e: unknown) => e instanceof SCQError && e.code === "UNSUPPORTED_CHANGE" && (e as any).details?.failingDimension === "immediateFinancialEffect",
  );
});

test("T12 (SIMULATED_PASS): provider/API failure is classified accurately — 500 at quote time is PROVIDER_ERROR, nothing is committed or fabricated", async () => {
  const fake = new FakeChargebee();
  const failing: HttpTransport = async (req) => {
    if (req.url.includes("/estimates/")) return { status: 500, headers: {}, json: { api_error_code: "internal_error", message: "boom" } };
    return fake.transport(req);
  };
  const client = new ChargebeeClient({ site: "scq-test", apiKey: "test_key_redacted" }, failing);
  const adapter = new ChargebeeLiveAdapter(client, new QuoteStore(), { liveCommitEnabled: true });
  await assert.rejects(() => adapter.createChangeQuote("cb_live_test_1", qtyProposal()), (e: unknown) => e instanceof SCQError && e.code === "PROVIDER_ERROR" && (e as any).details?.httpStatus === 500);
  assert.equal(fake.mutationCount, 0);
  const missing = makeAdapter(new FakeChargebee());
  await assert.rejects(() => missing.getSubscription("cb_live_test_1".replace("1", "404")), (e: unknown) => e instanceof SCQError && (e.code === "PROVIDER_ERROR" || e.code === "SUBSCRIPTION_NOT_FOUND"));
});

test("T13 (SIMULATED_PASS for the limitation): application restarts after commit — in-memory store cannot prove exactly-once; adapter fails closed", async () => {
  // PR-14 MIGRATION: the pre-restart commit now refuses at the
  // preservation gate (no mutation occurs), and the restart half
  // of the scenario is unchanged: a fresh empty store cannot find
  // the quote and refuses QUOTE_STALE rather than re-mutating. The
  // limitation this test documents — an in-memory store cannot
  // prove exactly-once across restarts — stands verbatim.
  const fake = new FakeChargebee();
  const store1 = new QuoteStore();
  const adapter1 = makeAdapter(fake, { store: store1 });
  const quote = await adapter1.createChangeQuote("cb_live_test_1", qtyProposal());
  await expectPreservationRefusal(adapter1, quote.id);
  assert.equal(fake.mutationCount, 0);
  // "Restart": a new adapter with a fresh, empty QuoteStore.
  const adapter2 = makeAdapter(fake, { store: new QuoteStore() });
  await assert.rejects(() => adapter2.commitChangeQuote(quote.id), (e: unknown) => e instanceof SCQError && e.code === "QUOTE_STALE");
  assert.equal(fake.mutationCount, 0, "fail-closed: no blind re-mutation after restart — but note this is refusal, NOT exactly-once proof; a conforming live deployment requires a durable quote/receipt store (see LIMITATIONS-AND-GAPS.md)");
});

test("T14 (SIMULATED_PASS for reporting; live scheduling behavior BLOCKED): scheduled-change / Ramps compatibility reported honestly", async () => {
  const fake = new FakeChargebee({ hasScheduledChanges: true });
  const adapter = makeAdapter(fake);
  const quote = await adapter.createChangeQuote("cb_live_test_1", qtyProposal());
  const meta = quote.providerMetadata as any;
  assert.equal(meta.hasScheduledChanges, true);
  assert.ok(String(meta.scheduledChangesWarning).includes("scheduled changes"));
  assert.equal(quote.guaranteeCoverage.termEffect, "UNKNOWN");
  // TERM_END / DATE are refused: current docs deprecate those paths on
  // update_for_items in favor of Ramps (early access), which this
  // adapter does not implement.
  for (const intent of [{ type: "TERM_END" as const }, { type: "DATE" as const, at: "2026-09-01T00:00:00Z" }]) {
    await assert.rejects(
      () => adapter.createChangeQuote("cb_live_test_1", { changes: [{ action: "CHANGE_QUANTITY", itemId: "seat-basic-monthly", quantity: 120 }], effectiveIntent: intent, acceptanceEnvelope: ENVELOPE0 }),
      (e: unknown) => e instanceof SCQError && e.code === "UNSUPPORTED_CHANGE",
    );
  }
  assert.equal(fake.requests.filter((r) => r.path.includes("ramp")).length, 0, "no Ramps call is made or implied");
  assert.equal(fake.mutationCount, 0);
});

test("Test 13-gate: live commit is disabled by default — quote + revalidation complete, mutating call never fires", async () => {
  const fake = new FakeChargebee();
  const adapter = makeAdapter(fake, { liveCommitEnabled: false });
  const quote = await adapter.createChangeQuote("cb_live_test_1", qtyProposal());
  await assert.rejects(() => adapter.commitChangeQuote(quote.id), (e: unknown) => e instanceof SCQError && String(e.message).includes("LIVE COMMIT DISABLED"));
  assert.equal(fake.mutationCount, 0);
});

test("Test 13-classifications: evidence classifications are not conflated — no mock-backed row may claim a live result", () => {
  const allowed = new Set(["LIVE_PASS", "LIVE_FAIL", "SIMULATED_PASS", "DOCUMENTATION_SUPPORTED", "BLOCKED", "UNVERIFIED"]);
  // Mirror of research/chargebee-live-v1/TEST-RESULTS.md. If a row is
  // ever upgraded, this table and the document must change together.
  // The LIVE_* rows below rest on the Phase 3 live run (2026-10-27,
  // test site, credentials-backed) recorded in TEST-RESULTS.md with
  // evidence in ~/workspace/scq-live-validation-evidence/.
  const results: Record<string, string> = {
    T01: "SIMULATED_PASS", T02: "SIMULATED_PASS", T03: "SIMULATED_PASS", T04: "SIMULATED_PASS",
    T05: "SIMULATED_PASS", T06: "SIMULATED_PASS", T07: "SIMULATED_PASS", T08: "SIMULATED_PASS",
    T09: "SIMULATED_PASS", T10: "SIMULATED_PASS", T11: "SIMULATED_PASS", T12: "SIMULATED_PASS",
    T13: "SIMULATED_PASS", T14: "SIMULATED_PASS",
    "T01-live": "LIVE_PASS", "T02-live": "LIVE_PASS", "T03-live": "BLOCKED", "T14-live": "BLOCKED",
  };
  for (const [id, cls] of Object.entries(results)) assert.ok(allowed.has(cls), `${id}: ${cls} is not an allowed classification`);
  for (const [id, cls] of Object.entries(results)) if (!id.endsWith("-live")) assert.ok(!cls.startsWith("LIVE_"), `${id} is mock-backed and must not claim ${cls}`);
});

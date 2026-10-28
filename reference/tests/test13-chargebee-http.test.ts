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
import { ChargebeeLiveAdapter } from "../src/live/chargebee-scq-adapter.js";

// Test 13 — SCQ Live Chargebee Validation (mocked transport).
//
// EVERY test in this file runs against a deterministic in-memory fake of
// the documented Chargebee HTTP API shape. No network, no credentials.
// Results backed by this file are therefore SIMULATED_PASS at best —
// never LIVE_PASS. Live cases are BLOCKED in this environment (no
// credentials were provided) and are recorded as such in
// research/chargebee-live-v1/TEST-RESULTS.md.
//
// The fake models the CURRENT documented contract (Product Catalog 2.0):
//   GET  /subscriptions/{id}
//   POST /estimates/update_subscription_for_items
//   POST /subscriptions/{id}/update_for_items
//   chargebee-idempotency-key with a 30-minute replay window, replayed
//   header, 422 on parameter mismatch, 409-style conflict semantics.
// It deliberately does NOT copy the simulator's (chargebee-sim.ts)
// endpoint names or its `effective_from`-on-update assumption, both of
// which the Phase 1 audit found do not match current documentation.

const PRICES: Record<string, number> = { "seat-basic-monthly": 1000, "seat-pro-monthly": 1500 };
const T0 = new Date("2026-08-01T00:00:00Z");

type FakeSub = {
  id: string; status: string; currency_code: string; resource_version: number;
  current_term_start: number; current_term_end: number; next_billing_at: number;
  has_scheduled_changes: boolean; has_scheduled_advance_invoices: boolean;
  subscription_items: Array<{ item_price_id: string; quantity: number; unit_price: number; amount: number }>;
};

class FakeChargebee {
  sub: FakeSub;
  mutationCount = 0;
  estimateCount = 0;
  readCount = 0;
  requests: Array<{ method: string; path: string; body: string; idempotencyKey?: string }> = [];
  /** Added to estimate nets only — models drift sources outside the subscription resource (balances/tax configuration), which the subscription fingerprint cannot see. */
  estimateExtraNet = 0;
  /** One-shot hook fired inside the mutating call, after the adapter's final preview — the TOCTOU window. */
  beforeUpdate: (() => void) | null = null;
  private idem = new Map<string, { paramsHash: string; response: HttpResponse; at: number }>();
  fakeNowMs = T0.getTime();

  constructor(opts: { hasScheduledChanges?: boolean } = {}) {
    const start = Math.floor(T0.getTime() / 1000);
    this.sub = {
      id: "cb_live_test_1", status: "active", currency_code: "USD", resource_version: 1700000000000,
      current_term_start: start, current_term_end: start + 30 * 24 * 3600, next_billing_at: start + 30 * 24 * 3600,
      has_scheduled_changes: opts.hasScheduledChanges ?? false, has_scheduled_advance_invoices: false,
      subscription_items: [{ item_price_id: "seat-basic-monthly", quantity: 100, unit_price: 1000, amount: 100000 }],
    };
  }

  debugMutate(fn: (s: FakeSub) => void): void { fn(this.sub); this.sub.resource_version += 1; }

  private parseItems(body: URLSearchParams): Array<{ item_price_id: string; quantity: number }> {
    const out: Array<{ item_price_id: string; quantity: number }> = [];
    for (let i = 0; ; i++) {
      const p = body.get(`subscription_items[item_price_id][${i}]`);
      if (p === null) break;
      out.push({ item_price_id: p, quantity: Number(body.get(`subscription_items[quantity][${i}]`) ?? 0) });
    }
    return out;
  }

  private effectFor(items: Array<{ item_price_id: string; quantity: number }>) {
    const oldRec = this.sub.subscription_items.reduce((s, i) => s + i.unit_price * i.quantity, 0);
    const newRec = items.reduce((s, i) => s + (PRICES[i.item_price_id] ?? 0) * i.quantity, 0);
    return { oldRec, newRec, net: newRec - oldRec };
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
    if (req.method === "POST" && path === "/estimates/update_subscription_for_items") {
      this.estimateCount++;
      const items = this.parseItems(body);
      const { newRec, net } = this.effectFor(items);
      return jsonRes(200, {
        estimate: {
          created_at: Math.floor(this.fakeNowMs / 1000),
          subscription_estimate: { subscription_items: items.map((i) => ({ item_price_id: i.item_price_id, quantity: i.quantity, unit_price: PRICES[i.item_price_id], amount: (PRICES[i.item_price_id] ?? 0) * i.quantity })) },
          invoice_estimate: { total: net + this.estimateExtraNet, sub_total: net + this.estimateExtraNet, currency_code: "USD" },
          ...(newRec === 0 ? {} : {}),
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
      const { net } = this.effectFor(items);
      this.sub.subscription_items = items.map((i) => ({ item_price_id: i.item_price_id, quantity: i.quantity, unit_price: PRICES[i.item_price_id] ?? 0, amount: (PRICES[i.item_price_id] ?? 0) * i.quantity }));
      this.sub.resource_version += 1;
      this.mutationCount++;
      const res = jsonRes(200, { subscription: structuredClone(this.sub), unbilled_charges: net !== 0 ? [{ amount: net }] : [] });
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
  assert.equal(quote.commercialEffect.immediate?.net, 20000);
  assert.equal(quote.commercialEffect.recurring?.resultingAmount, 120000);
  assert.equal(quote.guaranteeCoverage.immediateFinancialEffect, "REVALIDATE", "live adapter must not claim EXACT: no documented pinning mechanism exists");
  assert.equal(quote.guaranteeCoverage.termEffect, "UNKNOWN");
});

test("T03 (SIMULATED_PASS): normal quote and commit — correct outcome, receipt, replace semantics, no invoice collection", async () => {
  const fake = new FakeChargebee();
  const adapter = makeAdapter(fake);
  const quote = await adapter.createChangeQuote("cb_live_test_1", qtyProposal());
  const receipt = await adapter.commitChangeQuote(quote.id);
  assert.equal(receipt.status, "COMMITTED");
  assert.equal(receipt.resultingSnapshot.items[0].quantity, 120);
  assert.deepEqual(receipt.committedEffect, receipt.quotedEffect);
  assert.deepEqual(receipt.reconciliation, { status: "OK" });
  assert.equal(fake.mutationCount, 1);
  const updateReq = fake.requests.find((r) => r.path.endsWith("/update_for_items"));
  assert.ok(updateReq);
  const body = new URLSearchParams(updateReq!.body);
  assert.equal(body.get("replace_items_list"), "true", "full-list replacement must be explicit — Chargebee's default is additive");
  assert.equal(body.get("invoice_immediately"), "false", "no default invoice collection");
  assert.ok(updateReq!.idempotencyKey?.startsWith("scq-"), "mutating call carries the quote-derived native idempotency key");
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
  const fake = new FakeChargebee();
  const adapter = makeAdapter(fake);
  const quote = await adapter.createChangeQuote("cb_live_test_1", qtyProposal());
  const r1 = await adapter.commitChangeQuote(quote.id);
  const r2 = await adapter.commitChangeQuote(quote.id);
  assert.deepEqual(r2, r1);
  assert.equal(fake.mutationCount, 1);
});

test("T07 (SIMULATED_PASS): provider processes commit, response is lost — recover by reconciliation, never a blind second mutation", async () => {
  const fake = new FakeChargebee();
  let loseOnce = true;
  const lossy: HttpTransport = async (req) => {
    const res = await fake.transport(req); // server applies the mutation
    if (loseOnce && req.method === "POST" && req.url.includes("/update_for_items")) { loseOnce = false; throw new Error("socket timeout"); }
    return res;
  };
  const client = new ChargebeeClient({ site: "scq-test", apiKey: "test_key_redacted" }, lossy);
  const adapter = new ChargebeeLiveAdapter(client, new QuoteStore(), { liveCommitEnabled: true });
  const quote = await adapter.createChangeQuote("cb_live_test_1", qtyProposal());
  const receipt = await adapter.commitChangeQuote(quote.id);
  assert.equal(receipt.status, "COMMITTED", "state reconciliation found the intended change landed");
  assert.equal(receipt.resultingSnapshot.items[0].quantity, 120);
  assert.equal(fake.mutationCount, 1, "exactly one provider mutation despite the lost response");
  const again = await adapter.commitChangeQuote(quote.id);
  assert.deepEqual(again, receipt);
  assert.equal(fake.mutationCount, 1);
});

test("T08+T09 (SIMULATED_PASS): concurrent change between final preview and commit — TOCTOU lands, reconciliation reports VIOLATED, no rollback is claimed", async () => {
  const fake = new FakeChargebee();
  const adapter = makeAdapter(fake);
  const quote = await adapter.createChangeQuote("cb_live_test_1", qtyProposal());
  // Concurrent actor reprices the item inside the window between the
  // adapter's last pre-mutation preview and the mutating call itself.
  fake.beforeUpdate = () => { PRICES["seat-basic-monthly"] = 2000; fake.sub.subscription_items[0].unit_price = 2000; };
  try {
    const receipt = await adapter.commitChangeQuote(quote.id);
    assert.equal(receipt.status, "COMMITTED", "the mutation DID occur — the receipt must not pretend otherwise");
    assert.equal(receipt.resultingSnapshot.items[0].quantity, 120);
    assert.equal(receipt.reconciliation.status, "VIOLATED", "committed effect (at the repriced rate) exceeds the zero-tolerance envelope and must be reported");
    assert.equal(receipt.consistencyGuarantee, "BEST_EFFORT", "never ATOMIC: no server-enforced CAS exists");
  } finally { PRICES["seat-basic-monthly"] = 1000; }
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
  const fake = new FakeChargebee();
  const store1 = new QuoteStore();
  const adapter1 = makeAdapter(fake, { store: store1 });
  const quote = await adapter1.createChangeQuote("cb_live_test_1", qtyProposal());
  await adapter1.commitChangeQuote(quote.id);
  assert.equal(fake.mutationCount, 1);
  // "Restart": a new adapter with a fresh, empty QuoteStore.
  const adapter2 = makeAdapter(fake, { store: new QuoteStore() });
  await assert.rejects(() => adapter2.commitChangeQuote(quote.id), (e: unknown) => e instanceof SCQError && e.code === "QUOTE_STALE");
  assert.equal(fake.mutationCount, 1, "fail-closed: no blind re-mutation after restart — but note this is refusal, NOT exactly-once proof; a conforming live deployment requires a durable quote/receipt store (see LIMITATIONS-AND-GAPS.md)");
});

test("T14 (SIMULATED_PASS for reporting; live behavior BLOCKED): scheduled-change / Ramps compatibility reported honestly", async () => {
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
  // ever upgraded, this table and the document must change together —
  // and a LIVE_* value requires credentials-backed evidence that does
  // not exist in this environment.
  const results: Record<string, string> = {
    T01: "SIMULATED_PASS", T02: "SIMULATED_PASS", T03: "SIMULATED_PASS", T04: "SIMULATED_PASS",
    T05: "SIMULATED_PASS", T06: "SIMULATED_PASS", T07: "SIMULATED_PASS", T08: "SIMULATED_PASS",
    T09: "SIMULATED_PASS", T10: "SIMULATED_PASS", T11: "SIMULATED_PASS", T12: "SIMULATED_PASS",
    T13: "SIMULATED_PASS", T14: "SIMULATED_PASS",
    "T01-live": "BLOCKED", "T02-live": "BLOCKED", "T03-live": "BLOCKED", "T14-live": "BLOCKED",
  };
  for (const [id, cls] of Object.entries(results)) assert.ok(allowed.has(cls), `${id}: ${cls} is not an allowed classification`);
  for (const [id, cls] of Object.entries(results)) if (!id.endsWith("-live")) assert.ok(!cls.startsWith("LIVE_"), `${id} is mock-backed and must not claim ${cls}`);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { QuoteStore } from "../src/store/quote-store.js";
import type { SubscriptionChangeQuote } from "../src/core/types.js";
import { ChargebeeClient, type HttpTransport } from "../src/live/chargebee-http.js";
import { ChargebeeLiveAdapter } from "../src/live/chargebee-scq-adapter.js";
import { PilotMockChargebee, type PilotMockFaults } from "../src/live/pilot/mock-transport.js";
import { compareQuoteToRawEstimate, runPilot, classifyRunCapability } from "../src/live/pilot/run-pilot.js";
import {
  ChargebeeOperationNotAllowedError,
  PilotLivePreflightError,
  assertLivePilotPreflight,
  createGuardedLiveTransport,
} from "../src/live/pilot/live-guard.js";
import { checkQuoteAgainstOracle, oracleExpectation, type OracleContext } from "./oracles/chargebee-estimate-oracle.js";

// Test 22 — Chargebee PILOT review corrections (PR #13):
//
//   R1 — an INDEPENDENT, test-only oracle (tests/oracles/) verifies
//        adapter quotes (values AND provenance) from the raw provider
//        response. The harness comparison reuses the adapter's own
//        interpretation function and cannot detect a defect inside
//        it; the oracle can, and 22-o2 proves it on a systematically
//        incorrect mapping. (21-p3's divergence regression is
//        preserved untouched in test21.)
//   R2 — next-invoice isolation is a SOURCE property. DISCLOSED
//        REMOVAL: run-pilot's isolation row previously required
//        immediate.net !== next_invoice_estimate.amount_due
//        numerically; that requirement was removed (see the in-file
//        disclosure in run-pilot.ts) because the figures may
//        legitimately coincide. 22-i1/22-i2 test separation by
//        source, including the coincidence case.
//   R3 — live-read safeguards: preflight (approved test site +
//        synthetic subscription id) fails closed before any request;
//        the guarded live transport enforces a read/estimate
//        allowlist at its boundary; report counts are OBSERVED from
//        the transport log and LIVE_PASS requires observed successful
//        operations.
//
// Everything here is mocked/stubbed — SIMULATED evidence only. The
// "live" runs below inject the fixture as the network layer to test
// the live path's safeguard and classification LOGIC; they are not
// live evidence.
//
// RE-REVIEW CORRECTIONS (F1/F2, second review round):
//   F1 — preflight now requires EXPLICIT per-run site approval (an
//        approved-site entry exactly matching CHARGEBEE_SITE); a
//        `-test` suffix alone no longer passes. 22-g1's failure cases
//        that isolate a non-site defect now supply that approval for
//        their (synthetic) site, and its passing case supplies the
//        explicit approval — the tests' intent is unchanged. The new
//        F1 regressions live in test23.
//   F2 — REQUIRED TEST CHANGE (disclosed): 22-g4 previously asserted
//        LIVE_PASS from an injected mock transport. That assertion
//        contradicted the corrected semantics — an injected transport
//        proves dispatch through the stub, not origin from a live
//        provider — and has been reworked: a successful injected run
//        now asserts SIMULATED_PASS and that "LIVE_PASS" appears
//        nowhere in the serialized report. Its observed-count
//        assertions are preserved.

const SUB = "pilot-sub-001";
const ADDON = "pilot-addon-vision";
const PROPOSAL = (qty: number) => ({
  changes: [{ action: "CHANGE_QUANTITY" as const, itemId: ADDON, quantity: qty }],
  effectiveIntent: { type: "IMMEDIATE" as const },
  acceptanceEnvelope: {},
});

function makeAdapter(faults: PilotMockFaults = {}) {
  const mock = new PilotMockChargebee(faults);
  const client = new ChargebeeClient({ site: "pilot-test", apiKey: "pilot-mock-key" }, mock.transport);
  const adapter = new ChargebeeLiveAdapter(client, new QuoteStore(), { liveCommitEnabled: false });
  return { mock, client, adapter };
}

/** Builds the comparison contexts (adapter-shaped and oracle-shaped) from raw provider payloads. */
async function pilotContexts(client: ChargebeeClient, targetQty = 21) {
  const { json: rawSub } = await client.getSubscription(SUB);
  const sub = rawSub.subscription;
  const currentItems = (sub.subscription_items as any[]).map((i) => ({ itemPriceId: i.item_price_id as string, quantity: i.quantity as number, unitPrice: i.unit_price as number, amount: i.amount as number, freeQuantity: i.free_quantity as number | undefined }));
  const targetItems = currentItems.map((i) => (i.itemPriceId === ADDON ? { itemPriceId: i.itemPriceId, quantity: targetQty } : { itemPriceId: i.itemPriceId, quantity: i.quantity }));
  const priceInfo = new Map<string, any>();
  const oraclePriceInfo = new Map<string, any>();
  for (const id of targetItems.map((i) => i.itemPriceId)) {
    const { json } = await client.getItemPrice(id);
    const ip = json.item_price;
    priceInfo.set(id, { itemPriceId: id, pricingModel: ip.pricing_model, price: ip.price, freeQuantity: ip.free_quantity, itemType: ip.item_type });
    oraclePriceInfo.set(id, { itemPriceId: id, pricingModel: ip.pricing_model, price: ip.price, freeQuantity: ip.free_quantity });
  }
  return {
    adapterCtx: { currency: "USD", currentItems, targetItems, priceInfo },
    oracleCtx: { currency: "USD", currentItems, targetItems, priceInfo: oraclePriceInfo } satisfies OracleContext,
  };
}

// ---------------------------------------------------------------------------
// R1 — independent oracle
// ---------------------------------------------------------------------------

test("Test 22-o1: the independent oracle validates a real adapter quote — values AND provenance", async () => {
  const { mock, client, adapter } = makeAdapter({ includeNextInvoiceWithCredits: true });
  const quote = await adapter.createChangeQuote(SUB, PROPOSAL(21));
  const { oracleCtx } = await pilotContexts(client);
  // The oracle's own expectations, stated from the raw response alone:
  const exp = oracleExpectation(mock.lastEstimateJson, oracleCtx);
  assert.equal(exp.immediateNet, 20000);
  assert.equal(exp.immediateSource, "unbilled_charge_estimates");
  assert.equal(exp.recurringResulting, 80900);
  assert.equal(exp.recurringSource, "subscription_estimate.subscription_items");
  assert.equal(exp.recurringPrevious, 60900);
  assert.deepEqual(exp.nextInvoice, { total: 80900, amountDue: 80600 });
  const checks = checkQuoteAgainstOracle(quote, mock.lastEstimateJson, oracleCtx);
  assert.ok(checks.every((c) => c.ok), JSON.stringify(checks, null, 2));
});

test("Test 22-o2: the oracle detects a systematically incorrect adapter mapping that a shared-function comparison cannot", async () => {
  const { mock, client, adapter } = makeAdapter({ includeNextInvoiceWithCredits: true });
  const quote = await adapter.createChangeQuote(SUB, PROPOSAL(21));
  const { adapterCtx, oracleCtx } = await pilotContexts(client);
  const raw = mock.lastEstimateJson;

  // A quote embodying a plausible SYSTEMATIC interpretation defect:
  // recurring sourced from next_invoice_estimate.amount_due (80600)
  // instead of the post-change price level (80900), with provenance
  // recording the wrong source — exactly the failure mode in which an
  // interpreter bug would present.
  const doctored = structuredClone(quote) as SubscriptionChangeQuote;
  doctored.commercialEffect.recurring = { resultingAmount: 80600, previousAmount: 60900, currency: "USD" };
  (doctored.providerMetadata as any).financialProvenance.recurring = "next_invoice_estimate.amount_due";

  // (1) The oracle FAILS it — on the value AND on the provenance.
  const checks = checkQuoteAgainstOracle(doctored, raw, oracleCtx);
  const byDim = Object.fromEntries(checks.map((c) => [c.dimension, c.ok]));
  assert.equal(byDim["recurring.resultingAmount (value)"], false, "oracle must reject recurring taken from amount_due");
  assert.equal(byDim["recurring (provenance)"], false, "oracle must reject provenance citing next_invoice_estimate");
  assert.equal(byDim["immediate.net (value)"], true, "the undoctored dimension still validates");

  // (2) The correlated-defect blind spot, demonstrated: IF the defect
  // lived inside the shared interpretation function, the harness
  // comparison — which re-applies that same function to the raw
  // response — would compute the SAME wrong figure and report a
  // match. buggyInterpret reproduces the defect's mapping; comparing
  // the doctored quote against it "passes".
  const buggyInterpret = (rawEstimate: any) => {
    const est = rawEstimate.estimate;
    const unbilled = (est.unbilled_charge_estimates ?? []).reduce((s: number, u: any) => s + u.amount, 0);
    const credits = (est.credit_note_estimates ?? []).reduce((s: number, c: any) => s + c.total, 0);
    return { immediateNet: unbilled - credits, recurringResulting: est.next_invoice_estimate.amount_due };
  };
  const buggy = buggyInterpret(raw);
  assert.equal(doctored.commercialEffect.immediate?.net, buggy.immediateNet);
  assert.equal(doctored.commercialEffect.recurring?.resultingAmount, buggy.recurringResulting, "under the shared defect, comparison and quote agree — the blind spot");

  // (3) Contrast: the SHIPPED harness comparison catches this
  // doctored quote today only because the shipped interpretation
  // function is currently correct — its evidence is exactly as
  // strong as that shared function, which is why the oracle exists.
  const rows = compareQuoteToRawEstimate(doctored, raw, adapterCtx);
  assert.equal(rows.find((r) => r.field === "recurring.resultingAmount")?.match, false);

  // (4) Provenance is verified independently of values: a quote with
  // CORRECT figures but provenance citing the wrong source fails the
  // oracle's provenance check while its value checks pass.
  const provOnly = structuredClone(quote) as SubscriptionChangeQuote;
  (provOnly.providerMetadata as any).financialProvenance.recurring = "next_invoice_estimate.amount_due";
  const provChecks = Object.fromEntries(checkQuoteAgainstOracle(provOnly, raw, oracleCtx).map((c) => [c.dimension, c.ok]));
  assert.equal(provChecks["recurring.resultingAmount (value)"], true);
  assert.equal(provChecks["recurring (provenance)"], false);
});

// ---------------------------------------------------------------------------
// R2 — next-invoice isolation by source
// ---------------------------------------------------------------------------

test("Test 22-i1: changing ONLY the next-invoice figures leaves the quoted effect byte-identical (source separation)", async () => {
  const effects: unknown[] = [];
  const amountDues: unknown[] = [];
  for (const faults of [{}, { nextInvoiceCredits: 300 }, { nextInvoiceCredits: 900 }] as PilotMockFaults[]) {
    const { adapter } = makeAdapter(faults);
    const quote = await adapter.createChangeQuote(SUB, PROPOSAL(21));
    // The FINANCIAL content of the effect (effectiveAt is a run
    // timestamp, not a financial figure, and is excluded).
    effects.push({ immediate: quote.commercialEffect.immediate, recurring: quote.commercialEffect.recurring });
    amountDues.push((quote.providerMetadata as any).nextInvoiceEstimate?.amountDue ?? null);
  }
  assert.deepEqual(amountDues, [null, 80600, 80000], "the three runs really do differ in their next-invoice amount_due");
  assert.deepEqual(effects[1], effects[0], "credits of 300 in the next invoice must not move the effect");
  assert.deepEqual(effects[2], effects[0], "credits of 900 in the next invoice must not move the effect");
  const eff = effects[0] as { immediate?: { net?: number }; recurring?: { resultingAmount?: number } };
  assert.equal(eff.immediate?.net, 20000);
  assert.equal(eff.recurring?.resultingAmount, 80900);
});

test("Test 22-i2: amount_due legitimately EQUAL to the incurred figure — quote accepted, provenance still source-separated", async () => {
  // credits_applied 60900 brings the next invoice's amount_due to
  // exactly 20000 — numerically identical to the incurred obligation.
  // Under the removed numeric-inequality requirement this legitimate
  // case failed the comparison; separation is by SOURCE, so it must
  // pass everywhere.
  const { mock, client, adapter } = makeAdapter({ nextInvoiceCredits: 60900 });
  const quote = await adapter.createChangeQuote(SUB, PROPOSAL(21));
  const ni = (quote.providerMetadata as any).nextInvoiceEstimate;
  assert.equal(ni.amountDue, 20000);
  assert.equal(quote.commercialEffect.immediate?.net, 20000, "the figures coincide — legitimately");
  const prov = (quote.providerMetadata as any).financialProvenance as { immediate: string; recurring: string };
  assert.ok(prov.immediate.includes("unbilled_charge_estimates"), prov.immediate);
  assert.ok(!prov.immediate.includes("next_invoice_estimate"), prov.immediate);
  assert.ok(!prov.recurring.includes("next_invoice_estimate"), prov.recurring);
  const { adapterCtx, oracleCtx } = await pilotContexts(client);
  // The independent oracle passes the coincidence case in full.
  const checks = checkQuoteAgainstOracle(quote, mock.lastEstimateJson, oracleCtx);
  assert.ok(checks.every((c) => c.ok), JSON.stringify(checks, null, 2));
  // And the harness comparison's isolation row — the assertion site
  // of the removed inequality — matches.
  const rows = compareQuoteToRawEstimate(quote, mock.lastEstimateJson, adapterCtx);
  assert.ok(rows.every((r) => r.match), JSON.stringify(rows, null, 2));
});

// ---------------------------------------------------------------------------
// R3a — live preflight fails closed before any request
// ---------------------------------------------------------------------------

function countingStubTransport() {
  let count = 0;
  const transport: HttpTransport = async () => { count++; return { status: 200, headers: {}, json: {} }; };
  return { transport, count: () => count };
}

test("Test 22-g1: live preflight failure modes — BLOCKED report, zero requests attempted, no LIVE_PASS", async () => {
  const cases: Array<{ name: string; env: Record<string, string>; detailIncludes: string }> = [
    { name: "production-looking site", env: { CHARGEBEE_SITE: "acme-production", CHARGEBEE_API_KEY: "k", CHARGEBEE_TEST_SUBSCRIPTION_ID: "pilot-sub-001" }, detailIncludes: "not an approved test site" },
    { name: "-test site with no explicit per-run approval (F1)", env: { CHARGEBEE_SITE: "acme-test", CHARGEBEE_API_KEY: "k", CHARGEBEE_TEST_SUBSCRIPTION_ID: "pilot-sub-001" }, detailIncludes: "not an approved test site" },
    { name: "missing synthetic subscription id", env: { CHARGEBEE_SITE: "acme-test", CHARGEBEE_API_KEY: "k", SCQ_PILOT_APPROVED_TEST_SITES: "acme-test" }, detailIncludes: "synthetic test subscription id" },
    { name: "non-synthetic subscription id", env: { CHARGEBEE_SITE: "acme-test", CHARGEBEE_API_KEY: "k", CHARGEBEE_TEST_SUBSCRIPTION_ID: "sub_9f8e7d6c5b", SCQ_PILOT_APPROVED_TEST_SITES: "acme-test" }, detailIncludes: "does not carry a synthetic designation" },
  ];
  for (const c of cases) {
    const stub = countingStubTransport();
    const report = await runPilot({ mode: "live", env: c.env, networkTransport: stub.transport });
    assert.equal(stub.count(), 0, `${c.name}: no network request may be attempted`);
    assert.equal(report.transport.totalCalls, 0, c.name);
    assert.equal(report.transport.mutatingCalls, 0, c.name);
    assert.equal(report.steps[0].step, "live preflight", c.name);
    assert.equal(report.steps[0].status, "blocked", c.name);
    assert.ok(report.steps[0].detail.includes("LIVE_PREFLIGHT_FAILED"), `${c.name}: ${report.steps[0].detail}`);
    assert.ok(report.steps[0].detail.includes(c.detailIncludes), `${c.name}: ${report.steps[0].detail}`);
    assert.ok(report.capabilities.every((cap) => cap.classification !== "LIVE_PASS"), `${c.name}: an empty-log report must not emit LIVE_PASS`);
    assert.ok(report.capabilities.filter((cap) => !cap.capability.includes("mocked")).every((cap) => cap.classification === "BLOCKED"), c.name);
  }
  // The preflight contract itself: named error, and a passing case.
  assert.throws(
    () => assertLivePilotPreflight({ site: "acme-production", apiKeyPresent: true, subscriptionId: "pilot-sub-001" }),
    (e: unknown) => e instanceof PilotLivePreflightError && (e as PilotLivePreflightError).code === "LIVE_PREFLIGHT_FAILED",
  );
  // F1: a `-test` suffix alone no longer passes — explicit approval is required.
  assert.throws(
    () => assertLivePilotPreflight({ site: "arjunsamplecompany-test", apiKeyPresent: true, subscriptionId: "cbdemo__XpbKpmKUbu8d2cPS" }),
    (e: unknown) => e instanceof PilotLivePreflightError,
  );
  assert.doesNotThrow(() => assertLivePilotPreflight({ site: "arjunsamplecompany-test", apiKeyPresent: true, subscriptionId: "cbdemo__XpbKpmKUbu8d2cPS", approvedTestSites: ["arjunsamplecompany-test"] }));
});

// ---------------------------------------------------------------------------
// R3b — operation allowlist at the transport boundary
// ---------------------------------------------------------------------------

test("Test 22-g2: the guarded live transport rejects disallowed operations BEFORE dispatch; allowed reads pass", async () => {
  const stub = countingStubTransport();
  const guard = createGuardedLiveTransport(stub.transport);
  const req = (method: "GET" | "POST", path: string) => ({ method, url: `https://acme-test.chargebee.com/api/v2${path}`, headers: {} });

  // Mutating + arbitrary operations are refused with the named error,
  // and the wrapped network transport is never invoked.
  for (const r of [
    req("POST", "/subscriptions/pilot-sub-001/update_for_items"),
    req("POST", "/subscriptions"),
    req("POST", "/subscriptions/pilot-sub-001/cancel"),
    req("POST", "/invoices"),
    req("GET", "/customers/pilot-sub-001"),
  ]) {
    await assert.rejects(
      () => guard.transport(r),
      (e: unknown) => e instanceof ChargebeeOperationNotAllowedError && (e as ChargebeeOperationNotAllowedError).code === "OPERATION_NOT_ALLOWED",
      `${r.method} ${r.url}`,
    );
  }
  assert.equal(stub.count(), 0, "no disallowed operation reached the network layer");
  assert.equal(guard.log.filter((e) => e.rejected === "OPERATION_NOT_ALLOWED").length, 5, "every rejection is recorded in the observed log");
  assert.ok(guard.log.every((e) => !e.dispatched));

  // The same refusal holds when the operation is attempted through
  // the ChargebeeClient (the adapter's path): the client surfaces a
  // transport-level error, but nothing is dispatched and the guard
  // log records the rejection.
  const client = new ChargebeeClient({ site: "acme-test", apiKey: "k" }, guard.transport);
  await assert.rejects(() => client.updateForItems(SUB, { subscription_items: [] }, "idem-1"));
  assert.equal(stub.count(), 0);
  assert.equal(guard.log.filter((e) => e.rejected).length, 6);

  // Allowed read/estimate operations dispatch and are logged.
  await client.getSubscription(SUB);
  await client.getItemPrice(ADDON);
  await client.estimateUpdateForItems(SUB, { subscription_items: [{ item_price_id: ADDON, quantity: 21 }] });
  assert.equal(stub.count(), 3);
  const dispatched = guard.log.filter((e) => e.dispatched);
  assert.deepEqual(dispatched.map((e) => e.operation), ["retrieve_subscription", "get_item_price", "estimate_update_for_items"]);
  assert.ok(dispatched.every((e) => !e.mutating));
});

// ---------------------------------------------------------------------------
// R3c — observed counts and classification gating
// ---------------------------------------------------------------------------

test("Test 22-g3: mocked-mode report counts match the mock transport's call log exactly", async () => {
  const mock = new PilotMockChargebee();
  const report = await runPilot({ mode: "mocked", mock });
  assert.equal(report.transport.totalCalls, mock.calls.length);
  assert.equal(report.transport.estimateCalls, mock.estimateCount);
  assert.equal(report.transport.mutatingCalls, mock.mutationCount);
  assert.equal(Object.values(report.transport.byOperation).reduce((s, n) => s + n, 0), report.transport.totalCalls);
  assert.equal(report.transport.byOperation.estimate_update_for_items, 1);
  assert.ok((report.transport.byOperation.retrieve_subscription ?? 0) >= 1);
  assert.equal(report.transport.rejectedAttempts, 0);
});

test("Test 22-g4: simulated live run (stubbed network) reports the OBSERVED counts; injected origin classifies SIMULATED_PASS, never LIVE_PASS [F2 rework]", async () => {
  // REQUIRED TEST CHANGE (F2, disclosed in this file's header): this
  // test previously asserted LIVE_PASS from the injected fixture.
  // That was the defect — a call log proves dispatch through the
  // injected transport, not origin from a live provider. The network
  // layer here is the pilot fixture, so this run is simulated
  // evidence: its successful capabilities classify SIMULATED_PASS,
  // and "LIVE_PASS" must appear NOWHERE in the returned report. The
  // counting mechanics are unchanged and still asserted: counts come
  // from the guard's observed log (which must agree with the
  // fixture's own log, since every request passed through both).
  const mock = new PilotMockChargebee();
  const report = await runPilot({
    mode: "live",
    env: { CHARGEBEE_SITE: "pilot-test", CHARGEBEE_API_KEY: "pilot-mock-key", CHARGEBEE_TEST_SUBSCRIPTION_ID: SUB, SCQ_PILOT_APPROVED_TEST_SITES: "pilot-test" },
    networkTransport: mock.transport,
  });
  assert.ok(report.steps.every((s) => s.status === "pass"), JSON.stringify(report.steps));
  assert.equal(report.steps[0].step, "live preflight");
  assert.equal(report.transport.totalCalls, mock.calls.length, "guard-observed count equals the fixture's own call count");
  assert.equal(report.transport.estimateCalls, mock.estimateCount);
  assert.equal(report.transport.mutatingCalls, 0);
  assert.equal(report.transport.byOperation.estimate_update_for_items, 1);
  assert.ok((report.transport.byOperation.retrieve_subscription ?? 0) >= 1);
  assert.equal(report.quote?.immediateNet, 20000);
  assert.equal(report.transportOrigin, "injected");
  const byCap = Object.fromEntries(report.capabilities.map((c) => [c.capability, c.classification]));
  assert.equal(byCap["retrieve subscription + snapshot"], "SIMULATED_PASS");
  assert.equal(byCap["estimate-backed quote"], "SIMULATED_PASS");
  assert.equal(byCap["live commit"], "BLOCKED");
  // The F2 regression scan: LIVE_PASS (and LIVE_FAIL) appear nowhere
  // in the serialized returned report of an injected-transport run.
  const serialized = JSON.stringify(report);
  assert.ok(!serialized.includes("LIVE_PASS"), serialized);
  assert.ok(!serialized.includes("LIVE_FAIL"), serialized);
});

test("Test 22-g5: classification gate — an empty observed log can never yield LIVE_PASS; injected origin can never yield LIVE_*", () => {
  assert.equal(classifyRunCapability("live", true, 0), "UNVERIFIED");
  assert.equal(classifyRunCapability("live", true, 3), "LIVE_PASS");
  assert.equal(classifyRunCapability("live", true, 3, "real"), "LIVE_PASS");
  assert.equal(classifyRunCapability("live", false, 3), "LIVE_FAIL");
  assert.equal(classifyRunCapability("mocked", true, 0), "SIMULATED_PASS");
  assert.equal(classifyRunCapability("mocked", false, 0), "UNVERIFIED");
  // F2: injected origin — success is simulated evidence only.
  assert.equal(classifyRunCapability("live", true, 3, "injected"), "SIMULATED_PASS");
  assert.equal(classifyRunCapability("live", true, 0, "injected"), "UNVERIFIED");
  assert.equal(classifyRunCapability("live", false, 3, "injected"), "UNVERIFIED");
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChargebeeClient, type HttpTransport } from "../src/live/chargebee-http.js";
import { ChargebeeLiveAdapter } from "../src/live/chargebee-scq-adapter.js";
import { PilotMockChargebee, type PilotMockFaults } from "../src/live/pilot/mock-transport.js";
import { QuoteStore } from "../src/store/quote-store.js";
import { DurableQuoteStore, requestHashOf } from "../src/store/durable-store.js";
import { DurableMutationCoordinator } from "../src/store/mutation-coordinator.js";
import {
  assessReadiness,
  createPreflightTransport,
  runPreflight,
  renderPreflightMarkdown,
  type PreflightInput,
  type PreflightReport,
  type ReadinessCondition,
} from "../src/live/pilot/preflight.js";
import { runRehearsal } from "../src/live/pilot/rehearsal.js";

// Test 37 — PR-11: read-only exact-commit preflight for a future,
// separately authorized Chargebee TEST-site commit. Everything here
// runs over mocked transports and temporary durable databases: no
// network, no credentials, no mutation. The preflight's own
// transport log is the evidence for every zero-mutation claim.

const SUB = "pilot-sub-001";
const ADDON = "pilot-addon-vision";
const PLAN = "pilot-plan-business";
const SITE = "pilot-test";
const PROPOSAL = (qty: number) => ({
  changes: [{ action: "CHANGE_QUANTITY" as const, itemId: ADDON, quantity: qty }],
  effectiveIntent: { type: "IMMEDIATE" as const },
  acceptanceEnvelope: {},
});

function tmpDb(): string {
  return join(mkdtempSync(join(tmpdir(), "scq-pr11-pf-")), "scq.db");
}

type Fixture = {
  path: string;
  quoteId: string;
  mock: PilotMockChargebee;
};

/** Builds the canonical durable quote (addon 1 -> 21) over a mocked transport, exactly as a future commit would consume it. */
async function buildFixture(mock: PilotMockChargebee = new PilotMockChargebee()): Promise<Fixture> {
  const path = tmpDb();
  const store = new DurableQuoteStore(path, { recoveryGraceMs: 0 });
  const client = new ChargebeeClient({ site: SITE, apiKey: "pilot-mock-key" }, mock.transport as HttpTransport);
  const adapter = new ChargebeeLiveAdapter(client, store, {
    liveCommitEnabled: false,
    durableCoordinator: new DurableMutationCoordinator(store),
    providerSite: SITE,
  });
  const quote = await adapter.createChangeQuote(SUB, PROPOSAL(21));
  store.close();
  return { path, quoteId: quote.id, mock };
}

function preflightInput(fx: Fixture, store: DurableQuoteStore, over: Partial<PreflightInput> = {}): PreflightInput {
  return {
    quoteId: fx.quoteId,
    store,
    transport: fx.mock.transport as HttpTransport,
    transportOrigin: "mocked",
    site: SITE,
    approvedSite: SITE,
    apiKey: "pilot-mock-key",
    operatorAttestation: { testTenantAttested: true, attestedBy: "test-operator (synthetic)" },
    env: {},
    ...over,
  };
}

function openStore(path: string): DurableQuoteStore {
  return new DurableQuoteStore(path, { recoveryGraceMs: 0 });
}

function check(report: PreflightReport, id: string) {
  const c = report.checks.find((x) => x.id === id);
  assert.ok(c, `check ${id} present in report`);
  return c!;
}

function assertNoMutation(report: PreflightReport): void {
  assert.equal(report.transport.mutatingCalls, 0, "observed mutating calls must be zero");
  assert.equal(report.transport.updateForItemsDispatched, 0, "update_for_items must never be dispatched");
}

// ---------------------------------------------------------------------------
// Positive control: fully established synthetic evidence
// ---------------------------------------------------------------------------

test("Test 37.1 (positive control): exact request, binding, and financial separation on synthetic evidence", async () => {
  const fx = await buildFixture();
  const store = openStore(fx.path);
  const report = await runPreflight(preflightInput(fx, store));
  store.close();

  assert.equal(report.refused, false);
  assert.deepEqual(report.blockers, [], JSON.stringify(report.checks.filter((c) => c.status === "blocker"), null, 2));

  // Identity and binding
  assert.equal(report.identity.provider, "chargebee");
  assert.equal(report.identity.site, SITE);
  assert.equal(report.identity.siteApprovedForReadOnly, true);
  assert.equal(report.identity.subscriptionId, SUB);
  assert.equal(report.identity.syntheticFixtureDesignation, true);
  assert.equal(report.identity.quoteId, fx.quoteId);
  assert.ok(report.identity.storedFingerprint?.startsWith("rv:"));
  assert.equal(report.identity.currentFingerprint, report.identity.storedFingerprint);
  assert.equal(typeof report.identity.currentResourceVersion, "number");

  // Exact hypothetical mutation — the request the adapter would issue
  const req = report.exactRequest!;
  assert.equal(req.params.replace_items_list, true);
  assert.equal(req.params.prorate, true);
  assert.equal(req.params.invoice_immediately, false);
  assert.equal(req.params.change_option, "immediately");
  assert.deepEqual(req.params.subscription_items, [
    { item_price_id: PLAN, quantity: 1 },
    { item_price_id: ADDON, quantity: 21 },
  ]);
  assert.equal(req.idempotencyKey, `scq-${fx.quoteId}`);
  assert.equal(req.requestHash, requestHashOf(req.params), "hash is the durable ledger's canonical request hash");
  assert.ok(req.formEncodedBody.includes("subscription_items%5Bitem_price_id%5D%5B1%5D=pilot-addon-vision") || req.formEncodedBody.includes("pilot-addon-vision"));
  assert.equal(req.matchesStoredPreviewInput, true);

  // Financial separation: four quantities, never substituted
  const fin = Object.fromEntries(report.financials.map((f) => [f.quantity, f]));
  assert.equal(fin.incurred_immediate_obligation.amountMinorUnits, 20000);
  assert.equal(fin.incurred_immediate_obligation.determinacy, "DETERMINED");
  assert.equal(fin.incurred_immediate_obligation.basis, "estimated");
  assert.equal(fin.post_change_recurring_price.amountMinorUnits, 80900);
  assert.equal(fin.post_change_recurring_price.determinacy, "DETERMINED");
  // The fixture estimate carries no next_invoice_estimate: both
  // next-invoice quantities are UNKNOWN, never back-filled from the
  // incurred or recurring figures.
  assert.equal(fin.next_invoice_estimate.determinacy, "UNKNOWN");
  assert.equal(fin.next_invoice_estimate.amountMinorUnits, null);
  assert.equal(fin.amount_due_after_credits.determinacy, "UNKNOWN");
  assert.equal(fin.amount_due_after_credits.amountMinorUnits, null);

  assertNoMutation(report);
  // Injected/mocked evidence can never be LIVE_PASS, anywhere.
  assert.ok(!JSON.stringify(report).includes("LIVE_PASS"), "mocked preflight report must not contain LIVE_PASS");
  // Overall is NO-GO: conditions 1/4/5 are unresolved by default.
  assert.equal(report.overall, "NO-GO");
  const cond = Object.fromEntries(report.conditions.map((c) => [c.condition, c]));
  assert.equal(cond[1].status, "UNVERIFIED", "release approval is never inferred from merged PRs");
  assert.equal(cond[3].status, "UNVERIFIED", "mocked evidence is not real-tenant preflight evidence");
  assert.equal(cond[4].status, "BLOCKED", "no reconciliation owner named");
  assert.equal(cond[5].status, "BLOCKED", "no separate commit authorization");
  const md = renderPreflightMarkdown(report);
  assert.ok(md.includes("NO-GO") && md.includes("no atomic rollback"), "markdown states the decision and the rollback limit");
});

test("Test 37.2 (positive control): next-invoice quantities established from their own source when present", async () => {
  const fx = await buildFixture(new PilotMockChargebee({ includeNextInvoiceWithCredits: true }));
  const store = openStore(fx.path);
  const report = await runPreflight(preflightInput(fx, store));
  store.close();
  const fin = Object.fromEntries(report.financials.map((f) => [f.quantity, f]));
  assert.equal(fin.next_invoice_estimate.amountMinorUnits, 80900);
  assert.equal(fin.next_invoice_estimate.determinacy, "DETERMINED");
  assert.equal(fin.amount_due_after_credits.amountMinorUnits, 80600, "amount due is net of the 300 credits — a distinct quantity from the 80900 total");
  assert.equal(fin.amount_due_after_credits.determinacy, "DETERMINED");
  assert.equal(fin.incurred_immediate_obligation.amountMinorUnits, 20000, "incurred obligation is unaffected by next-invoice credits");
  assertNoMutation(report);
});

test("Test 37.3: human-supplied records are recorded (never granted by software); mocked evidence still caps condition 3", async () => {
  const fx = await buildFixture();
  const rehearsal = await runRehearsal();
  assert.equal(rehearsal.allPassed, true);
  const store = openStore(fx.path);
  const report = await runPreflight(preflightInput(fx, store, {
    rehearsal: { completed: true, scenariosPassed: rehearsal.scenariosPassed, scenariosTotal: rehearsal.scenariosTotal, reference: "runRehearsal() in-process (mocked)" },
    humanInputs: {
      releaseApproval: { approved: true, reference: "operator-supplied release record (synthetic test input)" },
      reconciliationOwner: { name: "Synthetic Owner", backupName: "Synthetic Backup", rehearsalReference: "runRehearsal() in-process (mocked)" },
      commitAuthorization: { granted: true, reference: "operator-supplied authorization record (synthetic test input)" },
    },
  }));
  store.close();
  const cond = Object.fromEntries(report.conditions.map((c) => [c.condition, c]));
  assert.equal(cond[1].status, "PASS");
  assert.equal(cond[2].status, "PASS");
  assert.match(cond[2].evidence + cond[2].reason, /SIMULATED/, "condition 2 evidence is classified as simulated");
  assert.equal(cond[3].status, "UNVERIFIED", "a mocked run produces no real-tenant evidence, whatever else is supplied");
  assert.equal(cond[4].status, "PASS");
  assert.equal(cond[5].status, "PASS");
  assert.match(cond[5].reason, /operator-supplied|not granted/i, "the software records the authorization input; it does not grant it");
  assert.equal(report.overall, "NO-GO", "with condition 3 unverified the assessment cannot rise");
  assertNoMutation(report);
});

test("Test 37.4: readiness aggregation never emits GO; READY_FOR_HUMAN_REVIEW is the ceiling", () => {
  const allPass: ReadinessCondition[] = [1, 2, 3, 4, 5].map((n) => ({
    condition: n as ReadinessCondition["condition"], name: `condition ${n}`, status: "PASS" as const, evidence: "x", reason: "y",
  }));
  assert.equal(assessReadiness(allPass, []), "READY_FOR_HUMAN_REVIEW");
  assert.equal(assessReadiness(allPass, ["some blocker"]), "NO-GO");
  const oneBlocked = allPass.map((c) => (c.condition === 5 ? { ...c, status: "BLOCKED" as const } : c));
  assert.equal(assessReadiness(oneBlocked, []), "NO-GO");
});

// ---------------------------------------------------------------------------
// Refusals before any provider read
// ---------------------------------------------------------------------------

test("Test 37.5: production or unapproved site is refused before any transport call", async () => {
  const fx = await buildFixture();
  const store = openStore(fx.path);
  const prod = await runPreflight(preflightInput(fx, store, { site: "acme-prod", approvedSite: undefined, approvedTestSites: [] }));
  assert.equal(prod.refused, true);
  assert.equal(prod.transport.totalCalls, 0, "no provider read may occur for an unapproved site");
  const suffixOnly = await runPreflight(preflightInput(fx, store, { site: "acme-test", approvedSite: undefined, approvedTestSites: [] }));
  assert.equal(suffixOnly.refused, true, "a -test suffix alone is not approval (F1)");
  assert.equal(suffixOnly.transport.totalCalls, 0);
  store.close();
});

test("Test 37.6: SCQ_LIVE_COMMIT_ENABLED=true in the preflight environment refuses the run", async () => {
  const fx = await buildFixture();
  const store = openStore(fx.path);
  const report = await runPreflight(preflightInput(fx, store, { env: { SCQ_LIVE_COMMIT_ENABLED: "true" } }));
  store.close();
  assert.equal(report.refused, true);
  assert.equal(report.transport.totalCalls, 0);
  assert.ok(report.blockers.some((b) => /SCQ_LIVE_COMMIT_ENABLED/.test(b)));
});

test("Test 37.7: a subscription id without synthetic designation is rejected before reads", async () => {
  // Build a quote against a production-shaped subscription id (the
  // mocked transport serves the fixture regardless of the id asked).
  const path = tmpDb();
  const mock = new PilotMockChargebee();
  const store0 = new DurableQuoteStore(path, { recoveryGraceMs: 0 });
  const client = new ChargebeeClient({ site: SITE, apiKey: "pilot-mock-key" }, mock.transport as HttpTransport);
  const adapter = new ChargebeeLiveAdapter(client, store0, { liveCommitEnabled: false, providerSite: SITE });
  const quote = await adapter.createChangeQuote("cust_9f8e7d6c5b", PROPOSAL(21));
  store0.close();
  const store = openStore(path);
  const report = await runPreflight({
    quoteId: quote.id, store, transport: mock.transport as HttpTransport, transportOrigin: "mocked",
    site: SITE, approvedSite: SITE, apiKey: "pilot-mock-key",
    operatorAttestation: { testTenantAttested: true }, env: {},
  });
  store.close();
  assert.equal(report.identity.syntheticFixtureDesignation, false);
  assert.equal(report.transport.totalCalls, 0, "a synthetic-looking id is required; an undesignated id is never read as a commit candidate");
  assert.equal(report.overall, "NO-GO");
});

test("Test 37.8: test-looking site without operator attestation leaves tenant mode UNVERIFIED", async () => {
  const fx = await buildFixture();
  const store = openStore(fx.path);
  const report = await runPreflight(preflightInput(fx, store, { operatorAttestation: undefined }));
  store.close();
  assert.equal(report.identity.tenantModeEstablished, "UNVERIFIED");
  assert.equal(check(report, "operator_attestation").status, "unknown");
  assert.equal(report.conditions.find((c) => c.condition === 3)!.status, "UNVERIFIED");
  assert.equal(report.overall, "NO-GO");
  assertNoMutation(report);
});

// ---------------------------------------------------------------------------
// Durable-record and binding blockers
// ---------------------------------------------------------------------------

test("Test 37.9: a quote that exists only in memory is not a preflight candidate", async () => {
  const memStore = new QuoteStore();
  const mock = new PilotMockChargebee();
  const client = new ChargebeeClient({ site: SITE, apiKey: "pilot-mock-key" }, mock.transport as HttpTransport);
  const adapter = new ChargebeeLiveAdapter(client, memStore, { liveCommitEnabled: false });
  const quote = await adapter.createChangeQuote(SUB, PROPOSAL(21));
  const store = openStore(tmpDb());
  const report = await runPreflight({
    quoteId: quote.id, store, transport: mock.transport as HttpTransport, transportOrigin: "mocked",
    site: SITE, approvedSite: SITE, apiKey: "pilot-mock-key", operatorAttestation: { testTenantAttested: true }, env: {},
  });
  store.close();
  assert.equal(report.durableReadiness.quoteExistsDurably, false);
  assert.ok(report.blockers.some((b) => /durable/i.test(b)));
  assert.equal(report.overall, "NO-GO");
});

test("Test 37.10: expired quote blocks readiness", async () => {
  const fx = await buildFixture();
  const store = openStore(fx.path);
  const future = new Date(Date.now() + 60 * 60 * 1000);
  const report = await runPreflight(preflightInput(fx, store, { now: () => future }));
  store.close();
  assert.equal(check(report, "quote_not_expired").status, "blocker");
  assert.equal(report.overall, "NO-GO");
});

test("Test 37.11: quote bound to another subscription or provider is rejected", async () => {
  const fx = await buildFixture();
  const store = openStore(fx.path);
  const wrongSub = await runPreflight(preflightInput(fx, store, { expectedSubscriptionId: "pilot-sub-999" }));
  assert.ok(wrongSub.blockers.some((b) => /subscription/i.test(b)));
  // Tamper the stored provider binding.
  const q = store.get(fx.quoteId)!;
  store.put({ ...q, provider: "stripe" as const });
  const wrongProvider = await runPreflight(preflightInput(fx, store));
  assert.ok(wrongProvider.blockers.some((b) => /provider/i.test(b)));
  store.close();
});

test("Test 37.12: wrong site binding is rejected", async () => {
  const fx = await buildFixture();
  const store = openStore(fx.path);
  const report = await runPreflight(preflightInput(fx, store, { expectedSite: "other-test" }));
  store.close();
  assert.ok(report.blockers.some((b) => /site/i.test(b)));
  assert.equal(report.overall, "NO-GO");
});

test("Test 37.13: running the preflight persists no mutation intent", async () => {
  const fx = await buildFixture();
  const store = openStore(fx.path);
  const attemptsBefore = store.allAttempts().length;
  const report = await runPreflight(preflightInput(fx, store));
  const attemptsAfter = store.allAttempts().length;
  store.close();
  assert.equal(report.refused, false);
  assert.equal(attemptsBefore, 0);
  assert.equal(attemptsAfter, 0, "preflight is read-only against the ledger: no intent, no attempt");
});

// ---------------------------------------------------------------------------
// Exact-request coherence blockers
// ---------------------------------------------------------------------------

function tamperStoredQuote(fx: Fixture, mutate: (q: any) => void): DurableQuoteStore {
  const store = openStore(fx.path);
  const q = store.get(fx.quoteId) as any;
  mutate(q);
  store.put(q);
  return store;
}

test("Test 37.14: stored request diverging from the proposal is a blocker", async () => {
  const fx = await buildFixture();
  const store = tamperStoredQuote(fx, (q) => {
    q.provider_preview_input = { ...q.provider_preview_input, items: q.provider_preview_input.items.map((i: any) => (i.itemPriceId === ADDON ? { ...i, quantity: 22 } : i)) };
  });
  const report = await runPreflight(preflightInput(fx, store));
  store.close();
  assert.equal(report.exactRequest!.matchesStoredPreviewInput, false);
  assert.ok(report.blockers.some((b) => /proposal|preview input|target/i.test(b)));
  assertNoMutation(report);
});

test("Test 37.15: a changed stored idempotency key is a blocker", async () => {
  const fx = await buildFixture();
  const store = tamperStoredQuote(fx, (q) => {
    q.provider_preview_input = { ...q.provider_preview_input, idempotencyKey: "scq-forged-key" };
  });
  const report = await runPreflight(preflightInput(fx, store));
  store.close();
  assert.ok(report.blockers.some((b) => /idempotency key/i.test(b)));
  assert.equal(report.overall, "NO-GO");
});

test("Test 37.16: a stored attempt whose request hash differs is a blocker (and settled attempts are not 'unresolved')", async () => {
  const fx = await buildFixture();
  const store = openStore(fx.path);
  const coordinator = new DurableMutationCoordinator(store);
  const attempt = coordinator.beginDispatch({
    quoteId: fx.quoteId, subscriptionId: SUB, provider: "chargebee", site: SITE,
    request: { subscription_items: [{ item_price_id: ADDON, quantity: 99 }], replace_items_list: true },
    idempotencyKey: "scq-unrelated-attempt",
  });
  store.recordAttemptOutcome(attempt.attemptId, "CONFIRMED_NON_EXECUTION", { reason: "test fixture: settled attempt with a different request" });
  const report = await runPreflight(preflightInput(fx, store));
  store.close();
  assert.ok(report.blockers.some((b) => /request hash/i.test(b)), JSON.stringify(report.blockers));
  assert.deepEqual(report.durableReadiness.unresolvedAttempts, [], "a settled attempt is not unresolved — the blocker is the hash divergence alone");
});

test("Test 37.17: an unresolved durable attempt (DISPATCHING or INDETERMINATE) is a hard blocker", async () => {
  const fx = await buildFixture();
  // DISPATCHING left open
  const store = openStore(fx.path);
  const coordinator = new DurableMutationCoordinator(store);
  const req = { subscription_items: [{ item_price_id: PLAN, quantity: 1 }, { item_price_id: ADDON, quantity: 21 }], replace_items_list: true, prorate: true, invoice_immediately: false, change_option: "immediately" };
  coordinator.beginDispatch({ quoteId: fx.quoteId, subscriptionId: SUB, provider: "chargebee", site: SITE, request: req, idempotencyKey: `scq-${fx.quoteId}` });
  const dispatching = await runPreflight(preflightInput(fx, store));
  assert.ok(dispatching.blockers.some((b) => /unresolved/i.test(b)), JSON.stringify(dispatching.blockers));
  assert.equal(dispatching.durableReadiness.unresolvedAttempts.length, 1);
  store.close();
  // INDETERMINATE settled outcome on the quote itself
  const fx2 = await buildFixture();
  const store2 = openStore(fx2.path);
  const q2 = store2.get(fx2.quoteId) as any;
  store2.recordCommitOutcome(fx2.quoteId, { outcome: "INDETERMINATE", at: new Date().toISOString(), details: { reason: "test fixture" } });
  void q2;
  const indet = await runPreflight(preflightInput(fx2, store2));
  store2.close();
  assert.ok(indet.blockers.some((b) => /INDETERMINATE|unresolved/i.test(b)));
  assert.equal(indet.overall, "NO-GO");
});

test("Test 37.18: a recorded receipt means replay posture — a new commit is not the readiness question", async () => {
  const path = tmpDb();
  const mock = new PilotMockChargebee();
  const store0 = new DurableQuoteStore(path, { recoveryGraceMs: 0 });
  const client = new ChargebeeClient({ site: SITE, apiKey: "pilot-mock-key" }, mock.transport as HttpTransport);
  const adapter = new ChargebeeLiveAdapter(client, store0, {
    liveCommitEnabled: true, // fixture setup only: the commit under rehearsal conditions; the preflight itself never enables it
    durableCoordinator: new DurableMutationCoordinator(store0),
    providerSite: SITE,
  });
  const quote = await adapter.createChangeQuote(SUB, PROPOSAL(21));
  await adapter.commitChangeQuote(quote.id);
  store0.close();
  const store = openStore(path);
  const report = await runPreflight({
    quoteId: quote.id, store, transport: mock.transport as HttpTransport, transportOrigin: "mocked",
    site: SITE, approvedSite: SITE, apiKey: "pilot-mock-key", operatorAttestation: { testTenantAttested: true }, env: {},
  });
  store.close();
  assert.equal(report.durableReadiness.recordedReceiptPresent, true);
  assert.equal(report.durableReadiness.wouldReplay, true);
  assert.ok(report.blockers.some((b) => /already|replay/i.test(b)));
  assertNoMutation(report);
});

// ---------------------------------------------------------------------------
// Provider-state blockers (independent re-read)
// ---------------------------------------------------------------------------

test("Test 37.19: stale fingerprint (provider state changed since quote) blocks readiness", async () => {
  const fx = await buildFixture();
  fx.mock.applyExternalChange(ADDON, 7);
  const store = openStore(fx.path);
  const report = await runPreflight(preflightInput(fx, store));
  store.close();
  assert.equal(check(report, "fingerprint_stable").status, "blocker");
  assert.notEqual(report.identity.currentFingerprint, report.identity.storedFingerprint);
  assert.equal(report.overall, "NO-GO");
});

test("Test 37.20: scheduled changes block; ABSENT scheduled-change data is UNKNOWN, never an affirmative 'none'", async () => {
  const fx = await buildFixture();
  fx.mock.hasScheduledChanges = true;
  const store = openStore(fx.path);
  const blocked = await runPreflight(preflightInput(fx, store));
  assert.equal(check(blocked, "scheduled_changes").status, "blocker");
  store.close();

  const fx2 = await buildFixture();
  const stripping: HttpTransport = async (req) => {
    const res = await fx2.mock.transport(req as any);
    if (req.method === "GET" && req.url.includes("/subscriptions/") && res.json) {
      const json = JSON.parse(JSON.stringify(res.json));
      delete json.subscription.has_scheduled_changes;
      delete json.subscription.has_scheduled_advance_invoices;
      return { ...res, json };
    }
    return res;
  };
  const store2 = openStore(fx2.path);
  const unknown = await runPreflight(preflightInput(fx2, store2, { transport: stripping }));
  store2.close();
  assert.equal(unknown.providerState!.scheduledChanges, "UNKNOWN");
  assert.equal(check(unknown, "scheduled_changes").status, "unknown");
});

test("Test 37.21: an existing item the target set omits (mandatory-addon interference shape) blocks readiness", async () => {
  const fx = await buildFixture();
  const withMandatory: HttpTransport = async (req) => {
    const res = await fx.mock.transport(req as any);
    if (req.method === "GET" && req.url.includes("/subscriptions/") && res.json) {
      const json = JSON.parse(JSON.stringify(res.json));
      json.subscription.subscription_items.push({ item_price_id: "pilot-addon-mandatory", item_type: "addon", quantity: 1, unit_price: 2500, amount: 2500 });
      return { ...res, json };
    }
    return res;
  };
  const store = openStore(fx.path);
  const report = await runPreflight(preflightInput(fx, store, { transport: withMandatory }));
  store.close();
  assert.ok(report.blockers.some((b) => /pilot-addon-mandatory/.test(b)), JSON.stringify(report.blockers));
  assertNoMutation(report);
});

test("Test 37.22: unsupported pricing model blocks; missing item prices block", async () => {
  const fx = await buildFixture();
  const tiered = new PilotMockChargebee({ pricingModelOverride: { [ADDON]: "tiered" } });
  const store = openStore(fx.path);
  const r1 = await runPreflight(preflightInput(fx, store, { transport: tiered.transport as HttpTransport }));
  assert.ok(r1.blockers.some((b) => /pricing model/i.test(b)), JSON.stringify(r1.blockers));

  const noPrices: HttpTransport = async (req) => {
    if (req.url.includes("/item_prices/")) return { status: 404, headers: {}, json: { api_error_code: "resource_not_found" } };
    return fx.mock.transport(req as any);
  };
  const r2 = await runPreflight(preflightInput(fx, store, { transport: noPrices }));
  store.close();
  assert.ok(r2.blockers.some((b) => /item price/i.test(b)), JSON.stringify(r2.blockers));
});

test("Test 37.23: currency mismatch and non-integer amounts block readiness", async () => {
  const fx = await buildFixture();
  const eur: HttpTransport = async (req) => {
    const res = await fx.mock.transport(req as any);
    if (req.method === "GET" && req.url.includes("/subscriptions/") && res.json) {
      const json = JSON.parse(JSON.stringify(res.json));
      json.subscription.currency_code = "EUR";
      return { ...res, json };
    }
    return res;
  };
  const store = openStore(fx.path);
  const r1 = await runPreflight(preflightInput(fx, store, { transport: eur }));
  assert.ok(r1.blockers.some((b) => /currency/i.test(b)), JSON.stringify(r1.blockers));

  const fractional: HttpTransport = async (req) => {
    const res = await fx.mock.transport(req as any);
    if (req.url.includes("/estimates/") && res.json) {
      const json = JSON.parse(JSON.stringify(res.json));
      if (Array.isArray(json.estimate?.unbilled_charge_estimates) && json.estimate.unbilled_charge_estimates[0]) {
        json.estimate.unbilled_charge_estimates[0].amount = 20000.5;
      }
      return { ...res, json };
    }
    return res;
  };
  const r2 = await runPreflight(preflightInput(fx, store, { transport: fractional }));
  store.close();
  assert.ok(r2.blockers.some((b) => /minor units|integer|units/i.test(b)), JSON.stringify(r2.blockers));
  assertNoMutation(r2);
});

// ---------------------------------------------------------------------------
// Financial UNKNOWNs — never silently zero
// ---------------------------------------------------------------------------

test("Test 37.24: unknown immediate obligation and unknown recurring price are reported UNKNOWN, never zero", async () => {
  const fx = await buildFixture();
  const store = openStore(fx.path);
  const noImmediate = new PilotMockChargebee({ omitUnbilledAmount: true });
  const r1 = await runPreflight(preflightInput(fx, store, { transport: noImmediate.transport as HttpTransport }));
  const fin1 = Object.fromEntries(r1.financials.map((f) => [f.quantity, f]));
  assert.equal(fin1.incurred_immediate_obligation.determinacy, "UNKNOWN");
  assert.equal(fin1.incurred_immediate_obligation.amountMinorUnits, null);

  const noRecurring = new PilotMockChargebee({ partialStatedItems: true, pricingModelOverride: { [ADDON]: "tiered" } } as PilotMockFaults);
  const r2 = await runPreflight(preflightInput(fx, store, { transport: noRecurring.transport as HttpTransport }));
  store.close();
  const fin2 = Object.fromEntries(r2.financials.map((f) => [f.quantity, f]));
  assert.equal(fin2.post_change_recurring_price.determinacy, "UNKNOWN");
  assert.equal(fin2.post_change_recurring_price.amountMinorUnits, null);
  assert.equal(r2.overall, "NO-GO");
});

test("Test 37.25: unbilled-charge/credit visibility limits are stated, not papered over", async () => {
  const fx = await buildFixture();
  const store = openStore(fx.path);
  const report = await runPreflight(preflightInput(fx, store));
  store.close();
  assert.equal(report.providerState!.unbilledChargeVisibility, "UNKNOWN");
  const due = report.financials.find((f) => f.quantity === "amount_due_after_credits")!;
  assert.equal(due.determinacy, "UNKNOWN");
  assert.match(due.missingData ?? "", /next_invoice_estimate|visibility/i);
  assert.ok(report.sideEffects.some((s) => /invoice_immediately=false/.test(s) && /not/.test(s)), "side effects state invoice_immediately=false is not 'no consequence'");
});

// ---------------------------------------------------------------------------
// Transport boundary + sanitization
// ---------------------------------------------------------------------------

test("Test 37.26: the preflight transport rejects a real mutation endpoint BEFORE dispatch", async () => {
  let innerCalls = 0;
  const inner: HttpTransport = async () => { innerCalls++; return { status: 200, headers: {}, json: {} }; };
  const { transport, log } = createPreflightTransport(inner);
  const client = new ChargebeeClient({ site: SITE, apiKey: "pilot-mock-key" }, transport);
  await assert.rejects(() => client.updateForItems(SUB, { subscription_items: [] }, "scq-x"), /not allowed/i);
  assert.equal(innerCalls, 0, "the wrapped transport was never invoked for update_for_items");
  assert.equal(log.filter((e) => e.rejected).length, 1);
  assert.equal(log[0].dispatched, false);
});

test("Test 37.27: reports are sanitized — no API key, no authorization material, even when payloads echo it", async () => {
  const fx = await buildFixture();
  const SECRET = "SECRETKEY12345";
  const echoing: HttpTransport = async (req) => {
    const res = await fx.mock.transport(req as any);
    if (req.method === "GET" && req.url.includes("/subscriptions/") && res.json) {
      const json = JSON.parse(JSON.stringify(res.json));
      json.subscription.currency_code = SECRET; // hostile echo: the key lands in a provider field
      return { ...res, json };
    }
    return res;
  };
  const store = openStore(fx.path);
  const report = await runPreflight(preflightInput(fx, store, {
    transport: echoing,
    apiKey: SECRET,
    operatorAttestation: { testTenantAttested: true, attestedBy: "op", note: `key is ${SECRET}` },
  }));
  store.close();
  const serialized = JSON.stringify(report) + renderPreflightMarkdown(report);
  assert.ok(!serialized.includes(SECRET), "the API key must never appear in report output");
  assert.ok(!/"authorization"\s*:/i.test(serialized), "no authorization header field in report output");
  assert.ok(!/Bearer\s+[A-Za-z0-9._-]{8,}/.test(serialized), "no bearer credential material in report output");
  assert.ok(!/Basic\s+[A-Za-z0-9+/=]{8,}/.test(serialized), "no Basic credential material in report output");
});

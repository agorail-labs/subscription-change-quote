import { test } from "node:test";
import assert from "node:assert/strict";
import { QuoteStore } from "../src/store/quote-store.js";
import { SCQError } from "../src/core/types.js";
import { ChargebeeClient, ChargebeeHttpError } from "../src/live/chargebee-http.js";
import { ChargebeeLiveAdapter } from "../src/live/chargebee-scq-adapter.js";
import { PilotMockChargebee, type PilotMockFaults } from "../src/live/pilot/mock-transport.js";
import { EVIDENCE_CLASSES, compareQuoteToRawEstimate, runPilot } from "../src/live/pilot/run-pilot.js";

// Test 21 — Chargebee PILOT: harness workflow, field-by-field
// comparison, and the pilot fixture's negative/recovery matrix.
//
// Everything here runs against the pilot mocked transport. Results
// are SIMULATED_PASS at best — never LIVE_PASS. The adapter-level
// conformance matrix lives in test13; this file covers what test13
// does not: the pilot harness itself, its comparison and
// classification discipline, its live-mode gating, and the pilot
// fixture's fault scenarios (including commit-path scenarios that
// run ONLY against the mocked transport with the commit flag enabled
// for the mock — the flag is never enabled against a live transport,
// and the harness itself never enables it in either mode).

const SUB = "pilot-sub-001";
const ADDON = "pilot-addon-vision";
const PLAN = "pilot-plan-business";
const PROPOSAL = (qty: number, itemId = ADDON) => ({
  changes: [{ action: "CHANGE_QUANTITY" as const, itemId, quantity: qty }],
  effectiveIntent: { type: "IMMEDIATE" as const },
  acceptanceEnvelope: {},
});

function makeAdapter(faults: PilotMockFaults = {}, opts: { commitEnabled?: boolean; now?: () => Date } = {}) {
  const mock = new PilotMockChargebee(faults);
  const client = new ChargebeeClient({ site: "pilot-test", apiKey: "pilot-mock-key" }, mock.transport);
  const store = new QuoteStore();
  const adapter = new ChargebeeLiveAdapter(client, store, { liveCommitEnabled: opts.commitEnabled ?? false, now: opts.now });
  return { mock, client, store, adapter };
}

const isCode = (code: string) => (e: unknown) => e instanceof SCQError && e.code === code;

// ---------------------------------------------------------------------------
// Harness workflow
// ---------------------------------------------------------------------------

test("Test 21-p1: pilot harness (mocked) runs retrieve -> snapshot -> quote -> compare with zero mutating calls", async () => {
  const report = await runPilot({ mode: "mocked" });
  assert.ok(report.steps.every((s) => s.status === "pass"), JSON.stringify(report.steps));
  assert.equal(report.quote?.immediateNet, 20000);
  assert.equal(report.quote?.recurringResulting, 80900);
  assert.equal(report.quote?.recurringPrevious, 60900);
  assert.equal(report.transport.mutatingCalls, 0);
  assert.ok(report.comparisons.every((c) => c.match));
  for (const c of report.capabilities) assert.ok(EVIDENCE_CLASSES.includes(c.classification), c.classification);
  const byCap = Object.fromEntries(report.capabilities.map((c) => [c.capability, c.classification]));
  assert.equal(byCap["retrieve subscription + snapshot"], "SIMULATED_PASS");
  assert.equal(byCap["estimate-backed quote"], "SIMULATED_PASS");
  assert.equal(byCap["live commit"], "BLOCKED");
  // The report is structured evidence: JSON round-trips losslessly.
  assert.deepEqual(JSON.parse(JSON.stringify(report)).quote.immediateNet, 20000);
});

test("Test 21-p2: live mode without credentials classifies BLOCKED and performs no network call", async () => {
  const report = await runPilot({ mode: "live", env: {} });
  assert.equal(report.transport.totalCalls, 0);
  assert.equal(report.steps[0].status, "blocked");
  const retrieve = report.capabilities.find((c) => c.capability.includes("retrieve"));
  assert.equal(retrieve?.classification, "BLOCKED");
  assert.ok(report.steps[0].detail.includes("CHARGEBEE_SITE"));
  assert.ok(report.steps[0].detail.includes("CHARGEBEE_API_KEY"));
});

test("Test 21-p3: the field comparison catches a divergent raw estimate (it is not a rubber stamp)", async () => {
  const { adapter, mock } = makeAdapter();
  const quote = await adapter.createChangeQuote(SUB, PROPOSAL(21));
  // A raw estimate for a DIFFERENT target (qty 11) must not match the quote for qty 21.
  const other = new PilotMockChargebee();
  const otherClient = new ChargebeeClient({ site: "pilot-test", apiKey: "pilot-mock-key" }, other.transport);
  await otherClient.estimateUpdateForItems(SUB, { subscription_items: [{ item_price_id: PLAN, quantity: 1 }, { item_price_id: ADDON, quantity: 11 }] });
  const { json: rawSub } = await otherClient.getSubscription(SUB);
  const currentItems = rawSub.subscription.subscription_items.map((i: any) => ({ itemPriceId: i.item_price_id, quantity: i.quantity, unitPrice: i.unit_price, amount: i.amount, freeQuantity: i.free_quantity }));
  const comparisons = compareQuoteToRawEstimate(quote, other.lastEstimateJson, {
    currency: "USD",
    currentItems,
    targetItems: [{ itemPriceId: PLAN, quantity: 1 }, { itemPriceId: ADDON, quantity: 11 }],
    priceInfo: new Map(),
  });
  const immediate = comparisons.find((c) => c.field === "immediate.net");
  assert.equal(immediate?.match, false, "a raw estimate for qty 11 must not validate a quote for qty 21");
  assert.equal(mock.mutationCount, 0);
});

test("Test 21-p4: next-invoice figures (amount_due net of credits) stay in metadata and never enter the effect", async () => {
  const { adapter } = makeAdapter({ includeNextInvoiceWithCredits: true });
  const quote = await adapter.createChangeQuote(SUB, PROPOSAL(21));
  const ni = (quote.providerMetadata as any).nextInvoiceEstimate;
  assert.equal(ni.total, 80900);
  assert.equal(ni.amountDue, 80600, "amount_due is net of the 300 credit");
  assert.equal(quote.commercialEffect.immediate?.net, 20000, "incurred obligation is unaffected by next-invoice credits");
  assert.equal(quote.commercialEffect.recurring?.resultingAmount, 80900, "recurring price is NOT reduced by credits");
});

// ---------------------------------------------------------------------------
// Negative matrix (quote-time refusals; no mutating call may occur)
// ---------------------------------------------------------------------------

test("Test 21-n1: sparse estimate — unbilled element without an amount refuses the quote (unknown is not zero)", async () => {
  const { adapter, mock } = makeAdapter({ omitUnbilledAmount: true });
  await assert.rejects(() => adapter.createChangeQuote(SUB, PROPOSAL(21)), isCode("QUOTE_NOT_DETERMINISTIC"));
  assert.equal(mock.mutationCount, 0);
});

test("Test 21-n2: sparse estimate — absent credit_note_estimates member refuses the quote (net cannot be finalized)", async () => {
  const { adapter, mock } = makeAdapter({ dropCreditNotesMember: true });
  await assert.rejects(() => adapter.createChangeQuote(SUB, PROPOSAL(21)), isCode("QUOTE_NOT_DETERMINISTIC"));
  assert.equal(mock.mutationCount, 0);
});

test("Test 21-z1: provider-stated zero is preserved as a determined zero (unchanged quantity)", async () => {
  const { adapter } = makeAdapter();
  const quote = await adapter.createChangeQuote(SUB, PROPOSAL(1));
  assert.equal(quote.commercialEffect.immediate?.net, 0, "both members present and empty => immediate is exactly 0, present, not absent");
  assert.equal(quote.commercialEffect.recurring?.resultingAmount, 60900);
});

test("Test 21-n3: partial stated item list is not summed — recurring falls back to the justified per-item computation", async () => {
  const { adapter } = makeAdapter({ partialStatedItems: true });
  const quote = await adapter.createChangeQuote(SUB, PROPOSAL(21));
  assert.equal(quote.commercialEffect.recurring?.resultingAmount, 80900);
  const prov = (quote.providerMetadata as any).financialProvenance.recurring as string;
  assert.ok(prov.startsWith("computed per item"), prov);
  assert.ok(prov.includes("did NOT verify as the complete intended item set"), prov);
});

test("Test 21-n4: unsupported pricing model (tiered) with no complete stated list refuses — no manufactured estimate", async () => {
  const { adapter, mock } = makeAdapter({ partialStatedItems: true, pricingModelOverride: { [ADDON]: "tiered" } });
  await assert.rejects(() => adapter.createChangeQuote(SUB, PROPOSAL(21)), isCode("QUOTE_NOT_DETERMINISTIC"));
  assert.equal(mock.mutationCount, 0);
});

test("Test 21-n5: flat_fee quantity change is refused BEFORE any estimate or mutating call", async () => {
  const { adapter, mock } = makeAdapter();
  await assert.rejects(() => adapter.createChangeQuote(SUB, PROPOSAL(2, PLAN)), isCode("UNSUPPORTED_CHANGE"));
  assert.equal(mock.estimateCount, 0, "refusal happens on metadata, before the estimate call");
  assert.equal(mock.mutationCount, 0);
});

test("Test 21-n6: scheduled changes surface as a warning with termEffect UNKNOWN — never silently absorbed", async () => {
  const { adapter, mock } = makeAdapter();
  mock.hasScheduledChanges = true;
  const quote = await adapter.createChangeQuote(SUB, PROPOSAL(21));
  const md = quote.providerMetadata as any;
  assert.equal(md.hasScheduledChanges, true);
  assert.ok(typeof md.scheduledChangesWarning === "string" && md.scheduledChangesWarning.length > 0);
  assert.equal(quote.guaranteeCoverage.termEffect, "UNKNOWN");
});

// ---------------------------------------------------------------------------
// Commit-path matrix (mocked transport ONLY; flag enabled for the mock)
// ---------------------------------------------------------------------------

test("Test 21-c1: commit gate — with the flag disabled, quote + revalidation complete and NO mutating call is made", async () => {
  const { adapter, mock } = makeAdapter();
  const quote = await adapter.createChangeQuote(SUB, PROPOSAL(21));
  await assert.rejects(
    () => adapter.commitChangeQuote(quote.id),
    (e: unknown) => e instanceof SCQError && (e.details as any)?.blocked === "LIVE_COMMIT_DISABLED",
  );
  assert.equal(mock.mutationCount, 0);
});

test("Test 21-c2: stale subscription version (concurrent change after quote) refuses the commit before mutation", async () => {
  const { adapter, mock } = makeAdapter({}, { commitEnabled: true });
  const quote = await adapter.createChangeQuote(SUB, PROPOSAL(21));
  mock.applyExternalChange(ADDON, 5);
  await assert.rejects(() => adapter.commitChangeQuote(quote.id), isCode("QUOTE_STALE"));
  assert.equal(mock.mutationCount, 0);
});

test("Test 21-c3: expired quote refuses the commit before mutation", async () => {
  let clock = new Date("2026-08-01T00:00:00Z");
  const { adapter, mock } = makeAdapter({}, { commitEnabled: true, now: () => clock });
  const quote = await adapter.createChangeQuote(SUB, PROPOSAL(21));
  clock = new Date(clock.getTime() + 6 * 60 * 1000);
  await assert.rejects(() => adapter.commitChangeQuote(quote.id), isCode("QUOTE_EXPIRED"));
  assert.equal(mock.mutationCount, 0);
});

test("Test 21-c4: successful mocked commit records actuals; duplicate commit replays the original receipt (§6.10)", async () => {
  const { adapter, mock, store } = makeAdapter({}, { commitEnabled: true });
  const quote = await adapter.createChangeQuote(SUB, PROPOSAL(21));
  const receipt = await adapter.commitChangeQuote(quote.id);
  assert.equal(receipt.status, "COMMITTED");
  assert.equal(receipt.reconciliation.status, "OK");
  assert.equal(receipt.committedEffect.immediate?.net, 20000);
  assert.equal(receipt.committedEffect.recurring?.resultingAmount, 80900);
  const replay = await adapter.commitChangeQuote(quote.id);
  assert.deepEqual(replay, receipt, "replay returns the original receipt");
  assert.equal(mock.mutationCount, 1, "exactly one mutating call across commit + replay");
  assert.equal(store.get(quote.id)?.status, "COMMITTED");
});

test("Test 21-c5: conflicting idempotency — same native key with different parameters is a 422, not a second mutation", async () => {
  const { adapter, mock, client } = makeAdapter({}, { commitEnabled: true });
  const quote = await adapter.createChangeQuote(SUB, PROPOSAL(21));
  await adapter.commitChangeQuote(quote.id);
  const key = `scq-${quote.id}`.slice(0, 100);
  await assert.rejects(
    () => client.updateForItems(SUB, { subscription_items: [{ item_price_id: ADDON, quantity: 99 }] }, key),
    (e: unknown) => e instanceof ChargebeeHttpError && e.httpStatus === 422,
  );
  assert.equal(mock.mutationCount, 2, "the conflicting direct call reached the transport and was refused by the provider's idempotency check (only the first applied)");
  const { json } = await client.getSubscription(SUB);
  assert.equal(json.subscription.subscription_items.find((i: any) => i.item_price_id === ADDON).quantity, 21, "the conflicting call did not change state");
});

test("Test 21-c6: lost mutation response, intended set in effect — INDETERMINATE, outcome recorded, no receipt, no blind retry (PR-7 review L1)", async () => {
  // DISCLOSED CHANGE (PR-7 review L1): PR-7 as first delivered
  // classified this COMMITTED_UNVERIFIED, reasoning that the
  // post-dispatch re-read established the landing. The review
  // corrected that: a changed subscription matching the intended
  // result does not establish that THIS request caused the change —
  // the identical observations arise if our request never applied
  // and another actor applied the same item set (test26-12b is the
  // observational-equivalence regression). With no successful
  // response and no operation-bound execution evidence, the
  // outcome is INDETERMINATE: persisted as an outcome record (with
  // the observed state as diagnostic context), NO committed
  // receipt, and blind retry refused. COMMITTED_UNVERIFIED remains
  // for response-received cases (c8 below). The scenario and the
  // mock behavior are unchanged — the mock still applies the update
  // before losing the response; only the classification is
  // corrected.
  const { adapter, mock, store } = makeAdapter({ loseUpdateResponse: true }, { commitEnabled: true });
  const quote = await adapter.createChangeQuote(SUB, PROPOSAL(21));
  await assert.rejects(
    () => adapter.commitChangeQuote(quote.id),
    (e: unknown) => e instanceof SCQError && (e.details as any)?.outcome === "INDETERMINATE" && (e.details as any)?.indeterminate === true,
  );
  assert.equal(store.get(quote.id)?.commit_outcome?.outcome, "INDETERMINATE");
  assert.equal(store.get(quote.id)?.commit_receipt, undefined, "no committed receipt — landing by THIS request is not established");
  assert.equal(mock.mutationCount, 1);
  // A second attempt must NOT re-mutate: the recorded INDETERMINATE
  // outcome refuses it before any dispatch.
  await assert.rejects(
    () => adapter.commitChangeQuote(quote.id),
    (e: unknown) => e instanceof SCQError && (e.details as any)?.outcome === "INDETERMINATE",
  );
  assert.equal(mock.mutationCount, 1, "still exactly one mutating call — no blind retry");
});

test("Test 21-c7: provider 200 with silently unapplied change — no verified receipt, outcome indeterminate", async () => {
  const { adapter, mock, store } = makeAdapter({ silentIgnoreUpdate: true }, { commitEnabled: true });
  const quote = await adapter.createChangeQuote(SUB, PROPOSAL(21));
  await assert.rejects(
    () => adapter.commitChangeQuote(quote.id),
    (e: unknown) => e instanceof SCQError && (e.details as any)?.indeterminate === true && Array.isArray((e.details as any)?.itemSetMismatches),
  );
  assert.equal(store.get(quote.id)?.commit_receipt, undefined);
  assert.equal(mock.mutationCount, 1);
});

test("Test 21-c8: post-commit financial uncertainty (incomplete update response) — COMMITTED_UNVERIFIED typed receipt (Defect 3 closed by PR-7)", async () => {
  // DISCLOSED CHANGE (PR-7, v0.6.2): this test's own note previously
  // recorded that the adapter failed closed as INDETERMINATE with no
  // receipt because the frozen v0.6.1 receipt type had no
  // "committed but financially unverified" state, and that adopting
  // the v0.6.2 representation was "part of the future Chargebee
  // migration gate". PR-7 is that migration. The mutation response
  // WAS received (landing known), the re-read establishes the
  // intended set with attribution closed, and the recurring actual
  // is established — only the immediate actual is unavailable, so
  // the receipt is COMMITTED_UNVERIFIED with the immediate
  // dimension UNKNOWN (never the estimate substituted, never OK).
  const { adapter, mock, store } = makeAdapter({ incompleteUpdateResponse: true }, { commitEnabled: true });
  const quote = await adapter.createChangeQuote(SUB, PROPOSAL(21));
  const receipt = await adapter.commitChangeQuote(quote.id);
  assert.equal(receipt.status, "COMMITTED_UNVERIFIED");
  assert.equal(receipt.outcome, "COMMITTED_UNVERIFIED");
  assert.equal(receipt.reconciliation.status, "UNVERIFIED");
  assert.deepEqual((receipt.reconciliation as any).undeterminedDimensions, ["immediateFinancialEffect"]);
  assert.equal(receipt.committedEffect.immediate, undefined);
  assert.equal(receipt.committedEffect.determinacy?.immediateFinancialEffect, "UNKNOWN");
  assert.equal(receipt.committedEffect.recurring?.resultingAmount, 80900, "the recurring actual is established from the independent re-read");
  assert.equal(store.get(quote.id)?.commit_receipt?.status, "COMMITTED_UNVERIFIED");
  assert.equal(mock.mutationCount, 1);
});

test("Test 21-c9: mandatory addon attached by the provider on update — attributable VIOLATED receipt (the landed set is not the quoted set)", async () => {
  // DISCLOSED CHANGE (PR-7, v0.6.2): previously INDETERMINATE with
  // no receipt. The extra item landed as part of THIS commit's own
  // update (the provider's documented mandatory-addon behavior),
  // attribution closes (response state fingerprint == re-read
  // fingerprint), and both financial dimensions are established
  // from the presented actuals — so the contradiction is Decision
  // D3's determined negative verification: a COMMITTED_AND_VERIFIED
  // receipt with a VIOLATED reconciliation whose committed recurring
  // (83400) includes the mandatory addon's stated amount. The landed
  // set is still never reported as the quoted set — it is reported
  // as a verified violation of it.
  const { adapter, mock, store } = makeAdapter({ mandatoryAddonOnUpdate: "pilot-addon-mandatory" }, { commitEnabled: true });
  const quote = await adapter.createChangeQuote(SUB, PROPOSAL(21));
  const receipt = await adapter.commitChangeQuote(quote.id);
  assert.equal(receipt.status, "COMMITTED");
  assert.equal(receipt.outcome, "COMMITTED_AND_VERIFIED");
  assert.equal(receipt.reconciliation.status, "VIOLATED");
  assert.match((receipt.reconciliation as any).reason, /extra item pilot-addon-mandatory/);
  assert.equal(receipt.committedEffect.recurring?.resultingAmount, 83400, "59900 plan + 21000 addon + the mandatory addon's stated 2500, as actually landed");
  assert.equal(receipt.committedEffect.immediate?.net, 20000);
  assert.equal(store.get(quote.id)?.commit_receipt?.reconciliation.status, "VIOLATED");
  assert.equal(mock.mutationCount, 1);
});

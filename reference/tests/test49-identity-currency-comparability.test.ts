import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QuoteStore, establishVerification } from "../src/store/quote-store.js";
import { DurableQuoteStore } from "../src/store/durable-store.js";
import { DurableMutationCoordinator } from "../src/store/mutation-coordinator.js";
import { ChargebeeClient, type HttpTransport } from "../src/live/chargebee-http.js";
import { ChargebeeLiveAdapter } from "../src/live/chargebee-scq-adapter.js";
import { PilotMockChargebee } from "../src/live/pilot/mock-transport.js";
import { StripeAdapter } from "../src/adapters/stripe-adapter.js";
import { checkAcceptanceEnvelope, reconcileCommittedEffect } from "../src/core/scq-engine.js";
import { verifyPostCommitState } from "../src/core/state-verification.js";
import { SCQError, type CommercialEffect, type SubscriptionChangeProposal } from "../src/core/types.js";
import { freshStripeFixture } from "./fixtures.js";

// Test 49 — PR-16 (Issue #22, Findings 3 + 4): subscription
// identity binding and currency/cadence comparability.
//
// F3: verification boundaries must bind the state/evidence they
// consume to the quote's subscription. A read naming a DIFFERENT
// subscription is refused before dispatch (pre-dispatch class:
// CONFIRMED_NON_EXECUTION, no durable attempt, no dispatch) and
// is a verification failure after dispatch (never VERIFIED/OK) —
// at the core state-verification hook (the observed snapshot's id
// vs the expectation's bound subscription), at the store's
// evidence establishment, and at the Chargebee-live adapter's
// quote-time and commit-time reads.
//
// F4: the shared engine treats currency and cadence as
// COMPARABILITY PRECONDITIONS. Established differing units with
// otherwise-matching numbers classify VIOLATED (reconcile) /
// refuse (pre-dispatch envelope gate); a participating unit that
// cannot be established classifies UNVERIFIED — never OK.
// Cadence is decidable only where both sides state it (the schema
// makes cadence optional and committed constructions legitimately
// omit it); that rule is pinned explicitly in 49.14 and proposed
// for tightening in PR #21 (see
// research/pr-16-identity-currency-comparability.md).
//
// Simulated evidence only (mocked transports / simulators /
// in-memory engine calls) — never LIVE. Failing-first: the F3/F4
// conversion tests fail on unmodified main because the defects
// produce VERIFIED/OK (or, pre-dispatch, no identity refusal at
// all); the controls pass on both.

const SUB = "pilot-sub-001";
const FOREIGN = "pilot-sub-999";
const ADDON = "pilot-addon-vision";
const PROPOSAL = (qty: number) => ({
  changes: [{ action: "CHANGE_QUANTITY" as const, itemId: ADDON, quantity: qty }],
  effectiveIntent: { type: "IMMEDIATE" as const },
  acceptanceEnvelope: {},
});

function liveAdapter(transport: HttpTransport, store: QuoteStore) {
  const client = new ChargebeeClient({ site: "pilot-test", apiKey: "pilot-mock-key" }, transport);
  return new ChargebeeLiveAdapter(client, store, { liveCommitEnabled: true });
}

/**
 * Seeds a COMMITTED_UNVERIFIED receipt for a live-adapter quote,
 * with candidate figures equal to the quote's own figures (the
 * test26.17 construction): the record a later independent
 * verification would transition.
 */
async function seedUnverifiedReceipt(adapter: ChargebeeLiveAdapter, store: QuoteStore, quoteId: string, mock: PilotMockChargebee) {
  const stored = store.get(quoteId)!;
  // The landed state the seeded receipt records (the test26.17
  // construction): the mock's seed quantity is 1; the recorded
  // commit landed the change to 21.
  mock.applyExternalChange(ADDON, 21);
  const snapshot = await adapter.getSubscription(SUB);
  const seeded = store.recordCommitReceipt(quoteId, {
    quoteId,
    subscriptionRef: SUB,
    status: "COMMITTED_UNVERIFIED",
    outcome: "COMMITTED_UNVERIFIED",
    resultingSnapshot: snapshot,
    quotedEffect: stored.quoted_effect,
    committedEffect: {
      immediate: { net: stored.quoted_effect.immediate?.net },
      recurring: {
        resultingAmount: stored.quoted_effect.recurring?.resultingAmount,
        currency: stored.quoted_effect.recurring?.currency ?? "USD",
      },
      effectiveAt: stored.quoted_effect.effectiveAt,
      determinacy: { immediateFinancialEffect: "UNKNOWN", recurringFinancialEffect: "UNKNOWN" },
      provenance: {
        immediate: "test49 fixture: candidate figure from the (simulated) mutating call's response",
        recurring: "test49 fixture: candidate figure from the (simulated) mutating call's response",
        committedSource: "unestablished",
      },
    },
    guaranteeMode: stored.effective_guarantee_mode,
    consistencyGuarantee: "BEST_EFFORT",
    multiChangeConsistency: stored.multi_change_consistency,
    reconciliation: { status: "UNVERIFIED" },
    committedAt: new Date().toISOString(),
  } as any);
  assert.ok(seeded, "the fixture receipt recorded");
  return stored;
}

/** Independent-verification evidence whose figures match the seeded record exactly. */
function matchingEvidence(stored: { quoted_effect: CommercialEffect }, snapshot: unknown, currency = "USD") {
  return {
    subscriptionRef: SUB,
    committedEffect: {
      immediate: { net: stored.quoted_effect.immediate?.net },
      recurring: { resultingAmount: stored.quoted_effect.recurring?.resultingAmount, currency },
      determinacy: { immediateFinancialEffect: "DETERMINED", recurringFinancialEffect: "DETERMINED" },
      provenance: {
        immediate: "test49 fixture: independent post-commit record (simulated provider record)",
        recurring: "test49 fixture: independent post-commit read (simulated provider read)",
        committedSource: "provider_actual",
      },
    } as CommercialEffect,
    resultingSnapshot: snapshot as any,
    source: "test49: independent post-commit reads through the mocked provider's records",
  };
}

// ---------------------------------------------------------------------------
// F3 — identity binding
// ---------------------------------------------------------------------------

test("Test 49.1 (F3, pre-dispatch): a commit-phase validation read naming a different subscription refuses before dispatch — CONFIRMED_NON_EXECUTION, zero dispatches, zero durable attempts", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "scq-pr16-")), "scq.db");
  const store = new DurableQuoteStore(path, { recoveryGraceMs: 0 });
  const coordinator = new DurableMutationCoordinator(store);
  const mock = new PilotMockChargebee();
  let armed = false;
  let updateDispatches = 0;
  const transport: HttpTransport = async (req) => {
    if (req.method === "POST" && req.url.includes("/update_for_items") && !req.url.includes("/estimates/")) updateDispatches++;
    const res = await mock.transport(req);
    if (armed && req.method === "GET" && (res.json as any)?.subscription) {
      // The commit-phase read returns ANOTHER subscription's record
      // (resource_version preserved, so the rv-only fingerprint
      // cannot catch this — identity is not a fingerprint input).
      return { ...res, json: { subscription: { ...(res.json as any).subscription, id: FOREIGN } } };
    }
    return res;
  };
  const client = new ChargebeeClient({ site: "pilot-test", apiKey: "pilot-mock-key" }, transport);
  const adapter = new ChargebeeLiveAdapter(client, store, {
    liveCommitEnabled: true,
    durableCoordinator: coordinator,
    providerSite: "pilot-test",
  });
  try {
    const quote = await adapter.createChangeQuote(SUB, PROPOSAL(21));
    armed = true;
    const err = await adapter.commitChangeQuote(quote.id).then(
      () => null,
      (e: unknown) => e,
    );
    assert.ok(err instanceof SCQError, `commit must refuse, got ${String(err)}`);
    assert.equal(err.code, "PROVIDER_ERROR");
    assert.equal((err.details as any)?.blocked, "SUBSCRIPTION_IDENTITY_MISMATCH");
    assert.equal((err.details as any)?.outcome, "CONFIRMED_NON_EXECUTION");
    const outcome = store.get(quote.id)?.commit_outcome;
    assert.equal(outcome?.outcome, "CONFIRMED_NON_EXECUTION", "the refusal is recorded as confirmed non-execution — never INDETERMINATE: nothing was dispatched");
    assert.equal((outcome?.details as any)?.blocked, "SUBSCRIPTION_IDENTITY_MISMATCH");
    assert.equal(updateDispatches, 0, "no mutating request was dispatched");
    assert.equal(mock.mutationCount, 0);
    assert.equal(store.attemptsForQuote(quote.id).length, 0, "no durable DISPATCHING attempt was created");
    assert.equal(store.get(quote.id)?.commit_receipt, undefined, "no receipt is recorded for a refused commit");
  } finally {
    store.close();
  }
});

test("Test 49.2 (F3, quote creation): a creation read naming a different subscription refuses the quote", async () => {
  const mock = new PilotMockChargebee();
  const transport: HttpTransport = async (req) => {
    const res = await mock.transport(req);
    if (req.method === "GET" && (res.json as any)?.subscription) {
      return { ...res, json: { subscription: { ...(res.json as any).subscription, id: FOREIGN } } };
    }
    return res;
  };
  const adapter = liveAdapter(transport, new QuoteStore());
  const err = await adapter.createChangeQuote(SUB, PROPOSAL(21)).then(
    () => null,
    (e: unknown) => e,
  );
  assert.ok(err instanceof SCQError, `creation must refuse a read naming another subscription, got ${String(err)}`);
  assert.equal((err.details as any)?.blocked, "SUBSCRIPTION_IDENTITY_MISMATCH");
  assert.match(err.message, new RegExp(FOREIGN));
});

test("Test 49.3 (F3, post-dispatch verification binding): evidence whose resulting snapshot names a different subscription cannot verify the record", async () => {
  const mock = new PilotMockChargebee();
  const store = new QuoteStore();
  const adapter = liveAdapter(mock.transport as HttpTransport, store);
  const quote = await adapter.createChangeQuote(SUB, PROPOSAL(21));
  const stored = await seedUnverifiedReceipt(adapter, store, quote.id, mock);
  const snapshot = await adapter.getSubscription(SUB);

  // The hook itself: the same observation, judged with the bound
  // subscription on the expectation side, is a MISMATCH whose
  // contradiction names the identity failure.
  const hookResult = verifyPostCommitState(
    // The cast marks the additive expectation field this test pins.
    { proposal: stored.proposal, expectedSubscriptionRef: SUB } as any,
    { snapshot: { ...snapshot, id: FOREIGN }, source: "test49" },
  );
  assert.equal(hookResult.verdict, "MISMATCH");
  assert.ok(
    hookResult.contradictions.some((c) => c.includes(FOREIGN) && c.includes(SUB)),
    `the identity contradiction names both subscriptions, got: ${hookResult.contradictions.join("; ")}`,
  );

  // The store boundary: establishment refuses to mint VERIFIED
  // evidence from a foreign subscription's snapshot, and the
  // verification transition is refused.
  const evidence = establishVerification(stored, matchingEvidence(stored, { ...snapshot, id: FOREIGN }));
  assert.equal(evidence.stateVerification, "MISMATCH", "establishment must not compute VERIFIED from another subscription's state");
  assert.throws(() => store.verifyCommitReceipt(quote.id, evidence), /state verification is MISMATCH/);
  assert.equal(store.get(quote.id)?.commit_receipt?.status, "COMMITTED_UNVERIFIED", "the record stands unverified — the mutation history is preserved, never rewritten as non-execution");
});

test("Test 49.4 (F3 control): the same verification with the bound subscription's snapshot transitions exactly as before", async () => {
  const mock = new PilotMockChargebee();
  const store = new QuoteStore();
  const adapter = liveAdapter(mock.transport as HttpTransport, store);
  const quote = await adapter.createChangeQuote(SUB, PROPOSAL(21));
  const stored = await seedUnverifiedReceipt(adapter, store, quote.id, mock);
  const snapshot = await adapter.getSubscription(SUB);
  const evidence = establishVerification(stored, matchingEvidence(stored, snapshot));
  assert.equal(evidence.stateVerification, "VERIFIED");
  const verified = store.verifyCommitReceipt(quote.id, evidence);
  assert.equal(verified.status, "COMMITTED");
  assert.equal(verified.outcome, "COMMITTED_AND_VERIFIED");
  assert.equal(verified.reconciliation.status, "OK");
});

test("Test 49.5 (F3, simulator path): a Stripe post-commit read returning a foreign subscription record does not verify OK", async () => {
  const { sim, sub } = freshStripeFixture();
  const originalRetrieve = sim.retrieve.bind(sim);
  // The post-commit read returns the landed state under ANOTHER
  // subscription's id (the repro45 technique at the simulator
  // seam): contents are the real landed state, identity is not.
  sim.retrieve = (id: string) => ({ ...originalRetrieve(id), id: "sub_foreign" });
  const adapter = new StripeAdapter(sim, new QuoteStore());
  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [{ action: "CHANGE_QUANTITY", itemId: "si_1", quantity: 120 }],
    effectiveIntent: { type: "IMMEDIATE" },
    guaranteeMode: "REVALIDATE",
    acceptanceEnvelope: {
      maxImmediateNetIncrease: 1_000_000,
      maxImmediateCreditDecrease: 1_000_000,
      maxRecurringIncrease: 1_000_000,
    },
  });
  const receipt = await adapter.commitChangeQuote(quote.id);
  assert.ok(
    !(receipt.outcome === "COMMITTED_AND_VERIFIED" && receipt.reconciliation.status === "OK"),
    `a foreign subscription's state verified this quote: ${receipt.outcome}/${receipt.reconciliation.status}`,
  );
  // The adapter's established MISMATCH translation (Decision D3):
  // a determined negative verification over the presented state —
  // verified-with-violation, never OK.
  assert.equal(receipt.reconciliation.status, "VIOLATED");
});

test("Test 49.6 (F3/F4 control): a recorded receipt replays exactly, before any identity or unit check runs", async () => {
  const mock = new PilotMockChargebee();
  let armed = false;
  const transport: HttpTransport = async (req) => {
    const res = await mock.transport(req);
    if (armed && req.method === "GET" && (res.json as any)?.subscription) {
      return { ...res, json: { subscription: { ...(res.json as any).subscription, id: FOREIGN } } };
    }
    return res;
  };
  const store = new QuoteStore();
  const adapter = liveAdapter(transport, store);
  const quote = await adapter.createChangeQuote(SUB, PROPOSAL(21));
  await seedUnverifiedReceipt(adapter, store, quote.id, mock);
  const recorded = store.get(quote.id)!.commit_receipt!;
  armed = true;
  const replayed = await adapter.commitChangeQuote(quote.id);
  assert.deepEqual(replayed, recorded, "§6.10: replay returns the recorded receipt exactly — identity/unit checks never retroactively refuse a recorded receipt");
  assert.equal(mock.mutationCount, 0, "replay dispatches nothing");
});

// ---------------------------------------------------------------------------
// F4 — currency / cadence comparability
// ---------------------------------------------------------------------------

const ENGINE_PROPOSAL = {
  changes: [{ action: "CHANGE_QUANTITY", itemId: "item-x", quantity: 21 }],
  effectiveIntent: { type: "IMMEDIATE" },
} as unknown as SubscriptionChangeProposal;

function engineEffect(opts: { currency?: string; cadence?: string; source?: string }): CommercialEffect {
  return {
    immediate: { net: 20000 },
    recurring: {
      resultingAmount: 80900,
      ...(opts.currency !== undefined ? { currency: opts.currency } : {}),
      ...(opts.cadence ? { cadence: opts.cadence } : {}),
    },
    determinacy: { immediateFinancialEffect: "DETERMINED", recurringFinancialEffect: "DETERMINED" },
    provenance: {
      immediate: "test49 fixture",
      recurring: "test49 fixture",
      ...(opts.source ? { committedSource: opts.source } : {}),
    } as CommercialEffect["provenance"],
  } as CommercialEffect;
}

test("Test 49.7 (F4): quoted USD vs committed EUR at equal numbers reconciles VIOLATED — established units contradict", () => {
  const quoted = engineEffect({ currency: "USD", cadence: "MONTHLY" });
  const committed = engineEffect({ currency: "EUR", cadence: "MONTHLY", source: "provider_actual" });
  const result = reconcileCommittedEffect(quoted, committed, {}, ENGINE_PROPOSAL);
  assert.equal(result.status, "VIOLATED");
  assert.match(result.reason ?? "", /USD/);
  assert.match(result.reason ?? "", /EUR/);
});

test("Test 49.8 (F4): quoted MONTHLY vs committed ANNUAL at equal numbers reconciles VIOLATED — established cadences contradict", () => {
  const quoted = engineEffect({ currency: "USD", cadence: "MONTHLY" });
  const committed = engineEffect({ currency: "USD", cadence: "ANNUAL", source: "provider_actual" });
  const result = reconcileCommittedEffect(quoted, committed, {}, ENGINE_PROPOSAL);
  assert.equal(result.status, "VIOLATED");
  assert.match(result.reason ?? "", /MONTHLY/);
  assert.match(result.reason ?? "", /ANNUAL/);
});

test("Test 49.9 (F4, pre-dispatch): the acceptance-envelope gate refuses a revalidated effect denominated in a different currency", () => {
  const quoted = engineEffect({ currency: "USD", cadence: "MONTHLY" });
  const revalidated = engineEffect({ currency: "EUR", cadence: "MONTHLY", source: "revalidated_preview" });
  let violation: string | null = null;
  let threw = false;
  try {
    violation = checkAcceptanceEnvelope(quoted, revalidated, {}, ENGINE_PROPOSAL);
  } catch {
    threw = true;
  }
  assert.ok(threw || violation !== null, "a cross-currency revalidation must not pass the pre-dispatch gate");
  if (violation !== null) assert.match(violation, /EUR/);
});

test("Test 49.10 (F4): a participating currency that cannot be established reconciles UNVERIFIED — never OK, never VIOLATED", () => {
  const quoted = engineEffect({ currency: "USD", cadence: "MONTHLY" });
  // Runtime-malformed committed effect: the recurring currency is
  // absent (the type requires it; provider payloads are runtime
  // data), so the recurring unit cannot be established.
  const committed = engineEffect({ cadence: "MONTHLY", source: "provider_actual" });
  const result = reconcileCommittedEffect(quoted, committed, {}, ENGINE_PROPOSAL);
  assert.equal(result.status, "UNVERIFIED");
  assert.ok(result.undeterminedDimensions?.includes("recurringFinancialEffect"));
  assert.match(result.reason ?? "", /currenc/i);
});

test("Test 49.11 (F4): the immediate dimension's currency is a comparability precondition where unit context establishes it", () => {
  const quoted = engineEffect({ currency: "USD", cadence: "MONTHLY" });
  const committed = engineEffect({ currency: "USD", cadence: "MONTHLY", source: "provider_actual" });
  // The schema carries no immediate currency field (the PR #21
  // proposal in the PR-16 note); the engine accepts the unit
  // context a caller threads from the snapshots' billing currency.
  // The cast marks the extended signature this test pins.
  const result = (reconcileCommittedEffect as any)(
    quoted,
    committed,
    {},
    ENGINE_PROPOSAL,
    { quotedBillingCurrency: "USD", comparedBillingCurrency: "EUR" },
  );
  assert.equal(result.status, "VIOLATED");
  assert.match(result.reason ?? "", /immediate/i);
});

test("Test 49.12 (F4, store recomputation): cross-currency evidence cannot verify a record as OK — the store's recomputation applies the same comparability rule", async () => {
  const mock = new PilotMockChargebee();
  const store = new QuoteStore();
  const adapter = liveAdapter(mock.transport as HttpTransport, store);
  const quote = await adapter.createChangeQuote(SUB, PROPOSAL(21));
  const stored = await seedUnverifiedReceipt(adapter, store, quote.id, mock);
  const snapshot = await adapter.getSubscription(SUB);
  // Figures numerically identical to the record; denomination EUR
  // against a USD quote and a USD recorded snapshot.
  const evidence = establishVerification(stored, matchingEvidence(stored, snapshot, "EUR"));
  assert.equal(evidence.reconciliation.status, "VIOLATED", "establishment itself computes the cross-currency outcome — an OK claim is not mintable");
  const verified = store.verifyCommitReceipt(quote.id, evidence);
  assert.equal(verified.reconciliation.status, "VIOLATED", "the store's recomputation agrees: verified-with-violation, never OK");
  assert.equal(verified.outcome, "COMMITTED_AND_VERIFIED");
});

test("Test 49.13 (F4 control): same currency, same cadence, same numbers reconcile OK and pass the envelope gate", () => {
  const quoted = engineEffect({ currency: "USD", cadence: "MONTHLY" });
  const committed = engineEffect({ currency: "USD", cadence: "MONTHLY", source: "provider_actual" });
  assert.equal(reconcileCommittedEffect(quoted, committed, {}, ENGINE_PROPOSAL).status, "OK");
  const revalidated = engineEffect({ currency: "USD", cadence: "MONTHLY", source: "revalidated_preview" });
  assert.equal(checkAcceptanceEnvelope(quoted, revalidated, {}, ENGINE_PROPOSAL), null);
});

test("Test 49.14 (F4 rule pin): cadence stated on one side only is not decidable from the record and does not block — the schema makes cadence optional (tightening proposed for PR #21)", () => {
  const quoted = engineEffect({ currency: "USD", cadence: "MONTHLY" });
  const committed = engineEffect({ currency: "USD", source: "provider_actual" });
  assert.equal(reconcileCommittedEffect(quoted, committed, {}, ENGINE_PROPOSAL).status, "OK");
});

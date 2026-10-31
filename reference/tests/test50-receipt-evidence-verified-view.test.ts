import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import {
  SCQError,
  type CommercialEffect,
  type ProviderObservation,
  type SubscriptionChangeReceipt,
  type SubscriptionSnapshot,
  type VerificationEvidence,
} from "../src/core/types.js";
import { checkIdempotentReplay } from "../src/core/scq-engine.js";
import {
  QuoteStore,
  establishVerification,
  receiptIdentityDigest,
  type StoredQuote,
} from "../src/store/quote-store.js";
import { DurableQuoteStore, DurableStoreError } from "../src/store/durable-store.js";

// SCQ v0.6.2 — PR-17 (Issue #22, Finding 5): append-only receipt
// evidence and truthful verified views. Written FAILING-FIRST
// against merged PR #26 (main bda3ea2).
//
// The three confirmed F5 failures (repro46):
//   F5a — a receipt missing an immediate candidate can never
//         incorporate independently established immediate actuals;
//   F5b — a recorded recurring candidate of 80,900 can never
//         incorporate established actuals of 83,400, because
//         assertEvidenceValid mistook candidate equality for
//         receipt-identity preservation (CONFLICTING_RECEIPT_IDENTITY);
//   F5c — confirming evidence upgrades a receipt to
//         COMMITTED_AND_VERIFIED while the displayed committed
//         effect still says UNKNOWN / "unestablished".
//
// The model these tests pin (three layers):
//   (1) the RECORDED receipt — immutable; its canonical identity
//       (receiptIdentityFields/Digest) includes the recorded
//       candidates forever;
//   (2) an APPEND-ONLY evidence record — identity-bound,
//       provenance-aware entries appended to the record's trail;
//       admissibility, per-dimension establishment, and promotion
//       are three separate questions;
//   (3) a DERIVED current view — computed from (1) + (2); it
//       displays established actuals with their establishing
//       provenance, never stale candidate labels under a verified
//       verdict.
//
// FIXTURE DISCIPLINE (per the PR-17 assignment): every figure a
// test claims as a provider-authoritative ACTUAL is DERIVED from
// the mock provider record below — the recurring actual is the
// record's stated item amounts summed by the snapshot derivation
// (the same derivation the adapters perform), and the immediate
// actual is read from the provider's operation-bound record of
// THIS mutation (its persisted unbilled charge). No contested
// figure is an unexplained literal. Recorded CANDIDATES, by
// contrast, are the receipt's own unverified figures — literals
// there are the point (they are what the mutation response
// stated, rightly or wrongly).

const SUB = "sub_50";
const QUOTED = { immediate: 20000, recurring: 80900 };

// ---------------------------------------------------------------------------
// Mock provider record + derivations
// ---------------------------------------------------------------------------

type MockProviderRecord = {
  /** The provider's authoritative subscription items (post-commit state of record). */
  items: Array<{ item_price_id: string; quantity: number; amount: number }>;
  /** The provider's operation-bound record of THIS mutation: its persisted unbilled charge. */
  operationCharge?: number;
  currency: string;
  cadence: string;
  itemQuantity: number;
};

function makeProviderRecord(overrides: Partial<MockProviderRecord> = {}): MockProviderRecord {
  return {
    items: [{ item_price_id: "item_1", quantity: 2, amount: QUOTED.recurring }],
    operationCharge: QUOTED.immediate,
    currency: "USD",
    cadence: "MONTHLY",
    itemQuantity: 2,
    ...overrides,
  };
}

/** The snapshot derivation: recurring = the record's stated item amounts, summed — never a chosen literal. */
function snapshotFromRecord(record: MockProviderRecord): SubscriptionSnapshot {
  return {
    id: SUB,
    version: "v2",
    status: "active",
    items: [{ id: "item_1", offeringRef: "plan", quantity: record.itemQuantity }],
    billing: {
      currency: record.currency,
      cadence: record.cadence,
      recurringAmount: record.items.reduce((s, i) => s + i.amount, 0),
    },
  };
}

/**
 * An independent post-commit observation DERIVED from the mock
 * provider record: recurring from the snapshot derivation above,
 * immediate from the operation-bound charge record. Dimensions
 * can be withheld (partial evidence) via `omit`.
 */
function observationFromRecord(
  record: MockProviderRecord,
  opts: { omit?: Array<"immediate" | "recurring">; withSnapshot?: boolean; source?: string } = {}
): ProviderObservation {
  const snapshot = snapshotFromRecord(record);
  const omit = new Set(opts.omit ?? []);
  const effect: CommercialEffect = {
    ...(omit.has("immediate") || record.operationCharge === undefined
      ? {}
      : { immediate: { net: record.operationCharge } }),
    ...(omit.has("recurring")
      ? {}
      : { recurring: { resultingAmount: snapshot.billing.recurringAmount!, currency: record.currency, cadence: record.cadence } }),
    determinacy: {
      immediateFinancialEffect: omit.has("immediate") || record.operationCharge === undefined ? "UNKNOWN" : "DETERMINED",
      recurringFinancialEffect: omit.has("recurring") ? "UNKNOWN" : "DETERMINED",
    },
    provenance: {
      ...(omit.has("immediate") || record.operationCharge === undefined
        ? {}
        : { immediate: "test50: provider's operation-bound unbilled-charge record for this mutation (mocked)" }),
      ...(omit.has("recurring")
        ? {}
        : { recurring: "test50: independent post-commit read — record's stated item amounts, summed (mocked)" }),
      committedSource: "provider_actual",
    },
  };
  return {
    subscriptionRef: SUB,
    committedEffect: effect,
    ...(opts.withSnapshot === false ? {} : { resultingSnapshot: snapshot }),
    source: opts.source ?? "test50: independent post-commit provider reads (mocked)",
    observedAt: "2026-10-30T00:06:00.000Z",
  };
}

// ---------------------------------------------------------------------------
// Quote / receipt fixtures
// ---------------------------------------------------------------------------

function makeQuote50(quoteId: string, opts: { envelope?: Record<string, number>; subscriptionId?: string } = {}): StoredQuote {
  return {
    quote_id: quoteId,
    provider: "stripe",
    subscription_id: opts.subscriptionId ?? SUB,
    subscription_version_at_quote: "v1",
    proposal: {
      changes: [{ action: "CHANGE_QUANTITY", itemId: "item_1", quantity: 2 }],
      effectiveIntent: { type: "IMMEDIATE" },
      ...(opts.envelope !== undefined ? { acceptanceEnvelope: opts.envelope } : {}),
    } as StoredQuote["proposal"],
    effective_guarantee_mode: "REVALIDATE",
    guarantee_coverage: {
      immediateFinancialEffect: "REVALIDATE",
      recurringFinancialEffect: "REVALIDATE",
      termEffect: "UNKNOWN",
      effectiveAt: "REVALIDATE",
    },
    multi_change_consistency: "ATOMIC",
    provider_preview_input: null,
    quoted_effect: {
      immediate: { net: QUOTED.immediate },
      recurring: { resultingAmount: QUOTED.recurring, currency: "USD", cadence: "MONTHLY" },
      determinacy: { immediateFinancialEffect: "DETERMINED", recurringFinancialEffect: "DETERMINED" },
      provenance: { immediate: "test50: quote-time preview", recurring: "test50: quote-time preview" },
    },
    created_at: "2026-10-30T00:00:00.000Z",
    expires_at: "2026-10-30T01:00:00.000Z",
    status: "ACTIVE",
  };
}

/** A COMMITTED_UNVERIFIED receipt whose committed figures are CANDIDATES (UNKNOWN determinacy, unestablished source) — the PR #10/#11 candidate construction repro46 exercises. */
function candidateReceipt(
  quoteId: string,
  committedEffect: CommercialEffect,
  opts: { subscriptionId?: string } = {}
): SubscriptionChangeReceipt {
  return {
    quoteId,
    subscriptionRef: opts.subscriptionId ?? SUB,
    receiptId: `rcpt_${quoteId}`,
    status: "COMMITTED_UNVERIFIED",
    outcome: "COMMITTED_UNVERIFIED",
    resultingSnapshot: {
      id: opts.subscriptionId ?? SUB,
      version: "v2",
      status: "active",
      items: [{ id: "item_1", offeringRef: "plan", quantity: 2 }],
      billing: { currency: "USD", cadence: "MONTHLY" },
    },
    quotedEffect: {
      immediate: { net: QUOTED.immediate },
      recurring: { resultingAmount: QUOTED.recurring, currency: "USD", cadence: "MONTHLY" },
      determinacy: { immediateFinancialEffect: "DETERMINED", recurringFinancialEffect: "DETERMINED" },
      provenance: { immediate: "test50: quote-time preview", recurring: "test50: quote-time preview" },
    },
    committedEffect,
    guaranteeMode: "REVALIDATE",
    consistencyGuarantee: "BEST_EFFORT",
    multiChangeConsistency: "ATOMIC",
    reconciliation: {
      status: "UNVERIFIED",
      reason: "committed figures are candidates from the mutation response; no independent establishment",
      undeterminedDimensions: ["immediateFinancialEffect", "recurringFinancialEffect"],
    },
    committedAt: "2026-10-30T00:05:00.000Z",
  };
}

function candidates(opts: { immediate?: number; recurring?: number }): CommercialEffect {
  return {
    ...(opts.immediate !== undefined ? { immediate: { net: opts.immediate } } : {}),
    ...(opts.recurring !== undefined
      ? { recurring: { resultingAmount: opts.recurring, currency: "USD", cadence: "MONTHLY" } }
      : {}),
    determinacy: { immediateFinancialEffect: "UNKNOWN", recurringFinancialEffect: "UNKNOWN" },
    provenance: {
      immediate: "candidate: mutation response figures (unverified)",
      recurring: "candidate: mutation response figures (unverified)",
      committedSource: "unestablished",
    },
  };
}

function seededStore(
  quoteId: string,
  committedEffect: CommercialEffect,
  opts: { envelope?: Record<string, number> } = {}
): { store: QuoteStore; receipt: SubscriptionChangeReceipt; digest: string } {
  const store = new QuoteStore();
  store.put(makeQuote50(quoteId, opts));
  const receipt = candidateReceipt(quoteId, committedEffect);
  store.recordCommitReceipt(quoteId, receipt);
  return { store, receipt, digest: receiptIdentityDigest(receipt) };
}

function mint(store: QuoteStore, quoteId: string, observation: ProviderObservation): VerificationEvidence {
  return establishVerification(store.get(quoteId)!, observation);
}

const isConflict = (e: unknown): boolean => e instanceof SCQError && e.code === "CONFLICTING_RECEIPT_IDENTITY";

// ---------------------------------------------------------------------------
// F5 conversions (50.1–50.4)
// ---------------------------------------------------------------------------

test("Test 50.1 (F5a): a receipt missing an immediate candidate incorporates independently established immediate actuals", () => {
  // Recorded: NO immediate candidate; recurring candidate 80900.
  const { store, receipt, digest } = seededStore("q50_1", candidates({ recurring: QUOTED.recurring }));
  assert.equal(receipt.committedEffect.immediate, undefined, "fixture check: no immediate candidate recorded");

  // The provider record establishes immediate 20000 (its operation
  // charge) and recurring 80900 (its item amounts, summed).
  const evidence = mint(store, "q50_1", observationFromRecord(makeProviderRecord()));
  const view = store.verifyCommitReceipt("q50_1", evidence);

  assert.equal(view.outcome, "COMMITTED_AND_VERIFIED");
  assert.equal(view.reconciliation.status, "OK");
  assert.equal(view.committedEffect.immediate?.net, 20000, "the derived view displays the established immediate actual");
  assert.equal(view.committedEffect.determinacy?.immediateFinancialEffect, "DETERMINED");
  // The recorded original is untouched: still candidate-less.
  const recorded = store.recordedReceipt("q50_1")!;
  assert.deepEqual(recorded, receipt);
  assert.equal(receiptIdentityDigest(recorded), digest);
});

test("Test 50.2 (F5b): evidence establishing a DIFFERENT actual than the recorded candidate is recordable — verified-with-violation, never an identity conflict", () => {
  // Recorded candidates: immediate 20000, recurring 80900. The
  // provider's authoritative record carries the item at a
  // corrected amount summing to 83400 — the candidate was wrong.
  const { store, receipt, digest } = seededStore(
    "q50_2",
    candidates({ immediate: QUOTED.immediate, recurring: QUOTED.recurring }),
    { envelope: {} }
  );
  const record = makeProviderRecord({ items: [{ item_price_id: "item_1", quantity: 2, amount: 83400 }] });
  const snapshot = snapshotFromRecord(record);
  assert.equal(snapshot.billing.recurringAmount, 83400, "fixture check: the record's stated amounts sum to 83400");
  const evidence = mint(store, "q50_2", observationFromRecord(record));
  assert.equal(evidence.reconciliation.status, "VIOLATED", "establishment computes the violation against quote + envelope");

  let view: SubscriptionChangeReceipt | undefined;
  assert.doesNotThrow(() => {
    view = store.verifyCommitReceipt("q50_2", evidence);
  }, "a differing established actual must not be refused as CONFLICTING_RECEIPT_IDENTITY");
  assert.equal(view!.outcome, "COMMITTED_AND_VERIFIED");
  assert.equal(view!.reconciliation.status, "VIOLATED", "recomputed against the quoted effect + envelope — never OK");
  assert.equal(view!.committedEffect.recurring?.resultingAmount, 83400, "the view displays the established actual");
  // Original candidate preserved in the recorded receipt + identity.
  const recorded = store.recordedReceipt("q50_2")!;
  assert.equal(recorded.committedEffect.recurring?.resultingAmount, 80900);
  assert.equal(receiptIdentityDigest(recorded), digest);
  assert.deepEqual(recorded, receipt);
});

test("Test 50.3 (F5c): confirming evidence produces a verified view whose displayed provenance is the establishing evidence's — DETERMINED, not UNKNOWN/unestablished", () => {
  const { store } = seededStore("q50_3", candidates({ immediate: QUOTED.immediate, recurring: QUOTED.recurring }));
  const evidence = mint(store, "q50_3", observationFromRecord(makeProviderRecord()));
  const view = store.verifyCommitReceipt("q50_3", evidence);
  assert.equal(view.outcome, "COMMITTED_AND_VERIFIED");
  assert.equal(view.reconciliation.status, "OK");
  assert.equal(view.committedEffect.determinacy?.immediateFinancialEffect, "DETERMINED");
  assert.equal(view.committedEffect.determinacy?.recurringFinancialEffect, "DETERMINED");
  assert.equal(view.committedEffect.provenance?.committedSource, "provider_actual");
  assert.match(view.committedEffect.provenance?.immediate ?? "", /operation-bound/);
});

test("Test 50.4 (F5 control): §6.10 replay remains byte-equivalent after verification", () => {
  const { store, receipt } = seededStore("q50_4", candidates({ immediate: QUOTED.immediate, recurring: QUOTED.recurring }));
  const evidence = mint(store, "q50_4", observationFromRecord(makeProviderRecord()));
  store.verifyCommitReceipt("q50_4", evidence);
  const original = checkIdempotentReplay(store, "q50_4")!;
  assert.deepEqual(original, receipt);
  assert.equal(JSON.stringify(original), JSON.stringify(receipt), "byte-equivalent observable content");
  const rerecorded = store.recordCommitReceipt("q50_4", receipt);
  assert.deepEqual(rerecorded, receipt, "re-recording the original payload stays an idempotent replay");
});

// ---------------------------------------------------------------------------
// Evidence integrity
// ---------------------------------------------------------------------------

test("Test 50.5: a presented receipt whose identity differs from the recorded identity is refused (both entry points)", () => {
  const { store } = seededStore("q50_5", candidates({ immediate: QUOTED.immediate, recurring: QUOTED.recurring }));
  const evidence = mint(store, "q50_5", observationFromRecord(makeProviderRecord()));
  const foreign = candidateReceipt("q50_5", candidates({ immediate: 1, recurring: 2 }));
  assert.throws(() => store.recordReceiptEvidence("q50_5", evidence, foreign), isConflict);
  assert.throws(() => store.verifyCommitReceipt("q50_5", evidence, foreign), isConflict);
  assert.equal(store.get("q50_5")!.commit_receipt_verifications?.length ?? 0, 0, "nothing was appended");
});

test("Test 50.6: evidence minted for a different quote/subscription is refused at ingestion (token binding)", () => {
  const { store } = seededStore("q50_6a", candidates({ immediate: QUOTED.immediate, recurring: QUOTED.recurring }));
  store.put(makeQuote50("q50_6b", { subscriptionId: "sub_50_other" }));
  const otherReceipt = candidateReceipt("q50_6b", candidates({ immediate: QUOTED.immediate, recurring: QUOTED.recurring }), { subscriptionId: "sub_50_other" });
  store.recordCommitReceipt("q50_6b", otherReceipt);
  // Mint a genuine token — for q50_6b / sub_50_other.
  const foreignObservation: ProviderObservation = {
    ...observationFromRecord(makeProviderRecord()),
    subscriptionRef: "sub_50_other",
    resultingSnapshot: { ...snapshotFromRecord(makeProviderRecord()), id: "sub_50_other" },
  };
  const foreignToken = establishVerification(store.get("q50_6b")!, foreignObservation);
  assert.throws(() => store.recordReceiptEvidence("q50_6a", foreignToken), /bound|binding|different quote|another/i);
  assert.equal(store.get("q50_6a")!.commit_receipt_verifications?.length ?? 0, 0);
});

test("Test 50.7: a foreign observed snapshot (PR-16 identity binding) cannot be recorded as actuals evidence", () => {
  const { store } = seededStore("q50_7", candidates({ immediate: QUOTED.immediate, recurring: QUOTED.recurring }));
  const observation = observationFromRecord(makeProviderRecord());
  observation.resultingSnapshot = { ...snapshotFromRecord(makeProviderRecord()), id: "sub_50_FOREIGN" };
  const token = mint(store, "q50_7", observation);
  assert.equal(token.stateVerification, "MISMATCH", "establishment computes the identity mismatch (PR-16)");
  assert.throws(() => store.recordReceiptEvidence("q50_7", token), /state|MISMATCH/i);
  assert.equal(store.get("q50_7")!.commit_receipt_verifications?.length ?? 0, 0);
});

test("Test 50.8: unbranded / fabricated evidence objects are refused as self-asserted", () => {
  const { store } = seededStore("q50_8", candidates({ immediate: QUOTED.immediate, recurring: QUOTED.recurring }));
  const fabricated: VerificationEvidence = {
    committedEffect: observationFromRecord(makeProviderRecord()).committedEffect,
    committedSource: "provider_actual",
    stateVerification: "VERIFIED",
    reconciliation: { status: "OK" },
  };
  assert.throws(() => store.recordReceiptEvidence("q50_8", fabricated), /established evidence token|self-asserted/i);
  assert.throws(() => store.verifyCommitReceipt("q50_8", fabricated), /established evidence token|self-asserted/i);
});

test("Test 50.9: mutation of a minted token is detected; mutation after acceptance cannot rewrite recorded history", () => {
  const { store } = seededStore("q50_9", candidates({ immediate: QUOTED.immediate, recurring: QUOTED.recurring }));
  const tampered = mint(store, "q50_9", observationFromRecord(makeProviderRecord()));
  tampered.committedEffect = {
    ...tampered.committedEffect,
    recurring: { resultingAmount: 1, currency: "USD", cadence: "MONTHLY" },
  };
  assert.throws(() => store.recordReceiptEvidence("q50_9", tampered), /altered after establishment|inconsistent|recomput/i);

  const accepted = mint(store, "q50_9", observationFromRecord(makeProviderRecord()));
  const viewBefore = store.recordReceiptEvidence("q50_9", accepted);
  // Caller mutates its token copy after acceptance.
  accepted.committedEffect.recurring = { resultingAmount: 7, currency: "USD", cadence: "MONTHLY" };
  accepted.reconciliation = { status: "VIOLATED", reason: "caller rewrite" };
  const viewAfter = store.get("q50_9")!.commit_receipt!;
  assert.deepEqual(viewAfter, viewBefore, "the stored entry is a frozen copy — later caller mutation changes nothing");
  assert.equal(viewAfter.committedEffect.recurring?.resultingAmount, QUOTED.recurring);
});

test("Test 50.10: estimate-only evidence cannot verify — establishment refuses estimate lineage, and the store refuses it too", () => {
  const { store } = seededStore("q50_10", candidates({ immediate: QUOTED.immediate, recurring: QUOTED.recurring }));
  const estimateObservation = observationFromRecord(makeProviderRecord());
  estimateObservation.committedEffect = {
    ...estimateObservation.committedEffect,
    provenance: { ...estimateObservation.committedEffect.provenance, committedSource: "pre_mutation_estimate" },
  };
  assert.throws(() => establishVerification(store.get("q50_10")!, estimateObservation), /committedSource|establish/i);
  const forged: VerificationEvidence = {
    committedEffect: estimateObservation.committedEffect,
    committedSource: "pre_mutation_estimate",
    stateVerification: "VERIFIED",
    reconciliation: { status: "OK" },
  };
  assert.throws(() => store.recordReceiptEvidence("q50_10", forged), /token|provenance|established/i);
});

test("Test 50.11: UNKNOWN actuals cannot be promoted to determined — a figure with UNKNOWN determinacy establishes nothing", () => {
  const { store } = seededStore("q50_11", candidates({ immediate: QUOTED.immediate, recurring: QUOTED.recurring }));
  // The observation carries an immediate FIGURE but labels it
  // UNKNOWN (candidate-grade) — only recurring is established.
  const observation = observationFromRecord(makeProviderRecord());
  observation.committedEffect = {
    ...observation.committedEffect,
    determinacy: { immediateFinancialEffect: "UNKNOWN", recurringFinancialEffect: "DETERMINED" },
  };
  const token = mint(store, "q50_11", observation);
  const view = store.recordReceiptEvidence("q50_11", token);
  assert.equal(view.outcome, "COMMITTED_UNVERIFIED", "no promotion on candidate-grade figures");
  assert.equal(view.committedEffect.determinacy?.immediateFinancialEffect, "UNKNOWN");
  assert.equal(view.committedEffect.provenance?.committedSource, "unestablished", "the view must not claim an establishing source while a participating dimension is unestablished");
  assert.equal(view.committedEffect.recurring?.resultingAmount, QUOTED.recurring, "the established dimension IS displayed");
  assert.equal(view.committedEffect.determinacy?.recurringFinancialEffect, "DETERMINED");
});

test("Test 50.12: incorrect currency/cadence cannot reconcile OK (PR-16 comparability at the evidence boundary)", () => {
  // Currency: the provider record denominates in EUR against a USD quote.
  const { store } = seededStore("q50_12", candidates({ immediate: QUOTED.immediate, recurring: QUOTED.recurring }), { envelope: {} });
  const eurRecord = makeProviderRecord({ currency: "EUR" });
  const eurEvidence = mint(store, "q50_12", observationFromRecord(eurRecord));
  const eurView = store.verifyCommitReceipt("q50_12", eurEvidence);
  assert.equal(eurView.reconciliation.status, "VIOLATED", "an established currency contradiction is a violation, never OK");
  assert.equal(eurView.outcome, "COMMITTED_AND_VERIFIED", "verified-with-violation: the actuals ARE established");

  // Cadence: the record's cadence is ANNUAL against a MONTHLY quote.
  const second = seededStore("q50_12b", candidates({ immediate: QUOTED.immediate, recurring: QUOTED.recurring }), { envelope: {} });
  const annualRecord = makeProviderRecord({ cadence: "ANNUAL" });
  const annualEvidence = mint(second.store, "q50_12b", observationFromRecord(annualRecord));
  const annualView = second.store.recordReceiptEvidence("q50_12b", annualEvidence);
  assert.notEqual(annualView.reconciliation.status, "OK");
  assert.equal(annualView.reconciliation.status, "VIOLATED");
});

test("Test 50.13 (conflict rule): later evidence contradicting an accepted established actual is recorded as a conflict — the first-established actual stands, and the view is never an unqualified OK", () => {
  const { store, digest } = seededStore("q50_13", candidates({ immediate: QUOTED.immediate, recurring: QUOTED.recurring }));
  // First evidence establishes recurring 83400 (state not yet
  // established — no snapshot — so nothing promotes yet).
  const first = mint(store, "q50_13", observationFromRecord(
    makeProviderRecord({ items: [{ item_price_id: "item_1", quantity: 2, amount: 83400 }] }),
    { withSnapshot: false }
  ));
  const view1 = store.recordReceiptEvidence("q50_13", first);
  assert.equal(view1.committedEffect.recurring?.resultingAmount, 83400);
  assert.equal(view1.outcome, "COMMITTED_UNVERIFIED");

  // Later evidence establishes recurring 90000 instead, with a
  // VERIFIED state. Deterministic rule: the conflicting entry is
  // appended and flagged; the accepted actual is NOT replaced;
  // the record carries an unresolved evidence conflict and cannot
  // report verified/OK while it stands.
  const second = mint(store, "q50_13", observationFromRecord(
    makeProviderRecord({ items: [{ item_price_id: "item_1", quantity: 2, amount: 90000 }] })
  ));
  const view2 = store.recordReceiptEvidence("q50_13", second);
  const q = store.get("q50_13")!;
  assert.equal(q.commit_receipt_verifications?.length, 2, "the conflicting evidence is appended, not silently dropped");
  assert.equal(view2.committedEffect.recurring?.resultingAmount, 83400, "the first-established actual stands — never silently replaced");
  assert.notEqual(view2.outcome, "COMMITTED_AND_VERIFIED");
  assert.equal(view2.reconciliation.status, "UNVERIFIED");
  assert.match(view2.reconciliation.status === "UNVERIFIED" ? view2.reconciliation.reason : "", /conflict/i);
  assert.equal(receiptIdentityDigest(store.recordedReceipt("q50_13")!), digest, "the recorded identity never moves");
});

test("Test 50.14: repeated submission of the same evidence is idempotent — no duplicate append", () => {
  const { store } = seededStore("q50_14", candidates({ immediate: QUOTED.immediate, recurring: QUOTED.recurring }));
  const token = mint(store, "q50_14", observationFromRecord(makeProviderRecord()));
  const view1 = store.recordReceiptEvidence("q50_14", token);
  const view2 = store.recordReceiptEvidence("q50_14", token);
  assert.deepEqual(view2, view1);
  assert.equal(store.get("q50_14")!.commit_receipt_verifications?.length, 1);
});

test("Test 50.15: partial evidence cannot claim complete verification (record path or transition path)", () => {
  const { store } = seededStore("q50_15", candidates({ immediate: QUOTED.immediate, recurring: QUOTED.recurring }));
  const partial = mint(store, "q50_15", observationFromRecord(makeProviderRecord(), { omit: ["recurring"] }));
  assert.equal(partial.reconciliation.status, "UNVERIFIED", "a partial observation computes an undetermined reconciliation");
  const view = store.recordReceiptEvidence("q50_15", partial);
  assert.equal(view.outcome, "COMMITTED_UNVERIFIED");
  assert.equal(view.committedEffect.immediate?.net, QUOTED.immediate, "the established dimension is displayed");
  assert.equal(view.committedEffect.determinacy?.recurringFinancialEffect, "UNKNOWN", "the missing dimension is NOT invented");
  assert.throws(() => store.verifyCommitReceipt("q50_15", partial), /determined reconciliation/);
});

test("Test 50.16 (Case D composition): later admissible evidence completes the missing dimensions — per-dimension composition across entries", () => {
  const { store } = seededStore("q50_16", candidates({ immediate: QUOTED.immediate, recurring: QUOTED.recurring }));
  const first = mint(store, "q50_16", observationFromRecord(makeProviderRecord(), {
    omit: ["recurring"],
    source: "test50: first independent read (immediate only)",
  }));
  const view1 = store.recordReceiptEvidence("q50_16", first);
  assert.equal(view1.outcome, "COMMITTED_UNVERIFIED");
  const second = mint(store, "q50_16", observationFromRecord(makeProviderRecord(), {
    omit: ["immediate"],
    source: "test50: second independent read (recurring only)",
  }));
  const view2 = store.recordReceiptEvidence("q50_16", second);
  assert.equal(view2.outcome, "COMMITTED_AND_VERIFIED", "composition of admissible entries completes the verification");
  assert.equal(view2.reconciliation.status, "OK");
  assert.equal(view2.committedEffect.immediate?.net, QUOTED.immediate);
  assert.equal(view2.committedEffect.recurring?.resultingAmount, QUOTED.recurring);
  assert.match(view2.committedEffect.provenance?.immediate ?? "", /operation-bound/);
  assert.match(view2.committedEffect.provenance?.recurring ?? "", /item amounts/);
  assert.equal(store.get("q50_16")!.commit_receipt_verifications?.length, 2);
});

test("Test 50.17: verified-with-violation is distinguishable from verified-with-compliance", () => {
  const compliant = seededStore("q50_17a", candidates({ immediate: QUOTED.immediate, recurring: QUOTED.recurring }), { envelope: {} });
  const okView = compliant.store.verifyCommitReceipt("q50_17a", mint(compliant.store, "q50_17a", observationFromRecord(makeProviderRecord())));
  const violating = seededStore("q50_17b", candidates({ immediate: QUOTED.immediate, recurring: QUOTED.recurring }), { envelope: {} });
  const violatedView = violating.store.verifyCommitReceipt("q50_17b", mint(violating.store, "q50_17b", observationFromRecord(
    makeProviderRecord({ items: [{ item_price_id: "item_1", quantity: 2, amount: 83400 }] })
  )));
  assert.equal(okView.outcome, "COMMITTED_AND_VERIFIED");
  assert.equal(violatedView.outcome, "COMMITTED_AND_VERIFIED");
  assert.equal(okView.reconciliation.status, "OK");
  assert.equal(violatedView.reconciliation.status, "VIOLATED");
  assert.notDeepEqual(
    compliant.store.receiptsWithReconciliation("OK").map((r) => r.quoteId),
    violating.store.receiptsWithReconciliation("OK").map((r) => r.quoteId)
  );
});

test("Test 50.18 (post-dispatch truth): an INDETERMINATE attempt with no recorded receipt cannot be verified into existence", () => {
  const store = new QuoteStore();
  store.put(makeQuote50("q50_18"));
  store.recordCommitOutcome("q50_18", { outcome: "INDETERMINATE", at: "2026-10-30T00:05:00.000Z" });
  const token = mint(store, "q50_18", observationFromRecord(makeProviderRecord()));
  assert.throws(() => store.recordReceiptEvidence("q50_18", token), /no receipt recorded/);
  assert.throws(() => store.verifyCommitReceipt("q50_18", token), /no receipt recorded/);
  assert.equal(store.get("q50_18")!.commit_receipt, undefined, "a later matching state never retroactively proves execution");
});

// ---------------------------------------------------------------------------
// Persistence and recovery
// ---------------------------------------------------------------------------

function composedStore(): { store: QuoteStore; persisted: string; view: SubscriptionChangeReceipt; digest: string } {
  const { store, digest } = seededStore("q50_16", candidates({ immediate: QUOTED.immediate, recurring: QUOTED.recurring }));
  store.recordReceiptEvidence("q50_16", mint(store, "q50_16", observationFromRecord(makeProviderRecord(), { omit: ["recurring"] })));
  const view = store.recordReceiptEvidence("q50_16", mint(store, "q50_16", observationFromRecord(makeProviderRecord(), { omit: ["immediate"] })));
  return { store, persisted: store.serializeReceiptRecords(), view, digest };
}

test("Test 50.19: evidence and the derived verified view survive a serialize/restore restart; the recorded identity is unchanged", () => {
  const { store, persisted, view, digest } = composedStore();
  const restored = new QuoteStore();
  restored.put(makeQuote50("q50_16"));
  restored.restoreReceiptRecords(persisted);
  const q = restored.get("q50_16")!;
  assert.deepEqual(q.commit_receipt, view, "the current view is re-derived deterministically from the validated evidence");
  assert.equal(q.commit_receipt_verifications?.length, 2);
  assert.equal(q.commit_receipt_identity_digest, digest);
  assert.deepEqual(restored.recordedReceipt("q50_16"), store.recordedReceipt("q50_16"));
});

test("Test 50.20: tampering with a recorded evidence entry refuses the WHOLE restore set", () => {
  const { persisted } = composedStore();
  const data = JSON.parse(persisted);
  // Alter an established figure inside the first trail entry.
  data.records[0].verifications[0].evidence.committedEffect.immediate.net = 999999;
  const restored = new QuoteStore();
  restored.put(makeQuote50("q50_16"));
  assert.throws(() => restored.restoreReceiptRecords(JSON.stringify(data)), /coheren|evidence|identity/i);
  assert.equal(restored.get("q50_16")!.commit_receipt, undefined, "no partial adoption");
});

test("Test 50.21: a forged promoted current view with insufficient evidence refuses restore — the view is derived, never trusted", () => {
  const { store } = seededStore("q50_21", candidates({ immediate: QUOTED.immediate, recurring: QUOTED.recurring }));
  // Only partial evidence exists (immediate only).
  store.recordReceiptEvidence("q50_21", mint(store, "q50_21", observationFromRecord(makeProviderRecord(), { omit: ["recurring"] })));
  const data = JSON.parse(store.serializeReceiptRecords());
  data.records[0].current_receipt = {
    ...data.records[0].current_receipt,
    status: "COMMITTED",
    outcome: "COMMITTED_AND_VERIFIED",
    reconciliation: { status: "OK" },
  };
  const restored = new QuoteStore();
  restored.put(makeQuote50("q50_21"));
  assert.throws(() => restored.restoreReceiptRecords(JSON.stringify(data)), /coheren|derived|current view/i);
  assert.equal(restored.get("q50_21")!.commit_receipt, undefined);
});

test("Test 50.22: a trail entry bound to a different receipt identity refuses restore (PR-17 shape)", () => {
  const { persisted } = composedStore();
  const data = JSON.parse(persisted);
  data.records[0].verifications[1].identityDigest = "{\"receiptId\":\"forged\"}";
  const restored = new QuoteStore();
  restored.put(makeQuote50("q50_16"));
  assert.throws(() => restored.restoreReceiptRecords(JSON.stringify(data)), /identity|coheren/i);
  assert.equal(restored.get("q50_16")!.commit_receipt, undefined);
});

test("Test 50.23: duplicate evidence identities in a persisted trail refuse restore — identical duplicates and same-id/different-contents alike", () => {
  const { persisted } = composedStore();
  const identical = JSON.parse(persisted);
  identical.records[0].verifications.push({ ...identical.records[0].verifications[0] });
  const r1 = new QuoteStore();
  r1.put(makeQuote50("q50_16"));
  assert.throws(() => r1.restoreReceiptRecords(JSON.stringify(identical)), /duplicate|coheren/i);

  const conflicting = JSON.parse(persisted);
  const dupe = JSON.parse(JSON.stringify(conflicting.records[0].verifications[0]));
  dupe.evidence = { ...dupe.evidence, at: "2026-10-30T09:09:09.000Z" };
  conflicting.records[0].verifications.push(dupe);
  const r2 = new QuoteStore();
  r2.put(makeQuote50("q50_16"));
  assert.throws(() => r2.restoreReceiptRecords(JSON.stringify(conflicting)), /duplicate|identity|coheren/i);
});

test("Test 50.24: historical receipt formats still restore — legacy one-transition trails are adopted and their view is re-derived truthfully", () => {
  // (a) Legacy unverified record, trail present but empty, and a
  //     serialized form without any PR-17 entry fields.
  const plain = seededStore("q50_24a", candidates({ immediate: QUOTED.immediate, recurring: QUOTED.recurring }));
  const plainData = JSON.parse(plain.store.serializeReceiptRecords());
  const r1 = new QuoteStore();
  r1.put(makeQuote50("q50_24a"));
  r1.restoreReceiptRecords(JSON.stringify(plainData));
  assert.equal(r1.get("q50_24a")!.commit_receipt?.outcome, "COMMITTED_UNVERIFIED");

  // (b) Legacy ONE-transition trail as pre-PR-17 code persisted
  //     it: the entry carries no evidenceId/disposition, and the
  //     current view is the OLD transition shape (recorded
  //     committed effect — UNKNOWN labels — under a verified
  //     outcome). Recovery accepts the trail and re-derives the
  //     current view from the validated evidence: the adopted
  //     view is the truthful one, not the persisted stale labels.
  const { store } = seededStore("q50_24b", candidates({ immediate: QUOTED.immediate, recurring: QUOTED.recurring }));
  const evidence = mint(store, "q50_24b", observationFromRecord(makeProviderRecord()));
  store.verifyCommitReceipt("q50_24b", evidence);
  const data = JSON.parse(store.serializeReceiptRecords());
  const entry = data.records[0].verifications[0];
  delete entry.evidenceId;
  delete entry.disposition;
  delete entry.conflicts;
  data.records[0].current_receipt = {
    ...data.records[0].recorded_receipt,
    status: "COMMITTED",
    outcome: "COMMITTED_AND_VERIFIED",
    reconciliation: entry.reconciliation,
  };
  const r2 = new QuoteStore();
  r2.put(makeQuote50("q50_24b"));
  r2.restoreReceiptRecords(JSON.stringify(data));
  const adopted = r2.get("q50_24b")!.commit_receipt!;
  assert.equal(adopted.outcome, "COMMITTED_AND_VERIFIED");
  assert.equal(adopted.committedEffect.determinacy?.immediateFinancialEffect, "DETERMINED", "the adopted view is re-derived — F5c's stale labels do not survive recovery");
  assert.equal(adopted.committedEffect.provenance?.committedSource, "provider_actual");
});

test("Test 50.25: an altered recorded candidate refuses restore (identity digest)", () => {
  const { persisted } = composedStore();
  const data = JSON.parse(persisted);
  data.records[0].recorded_receipt.committedEffect.recurring.resultingAmount = 1;
  const restored = new QuoteStore();
  restored.put(makeQuote50("q50_16"));
  assert.throws(() => restored.restoreReceiptRecords(JSON.stringify(data)), isConflict);
  assert.equal(restored.get("q50_16")!.commit_receipt, undefined);
});

// ---------------------------------------------------------------------------
// Durable persistence: atomicity of evidence append + view promotion
// ---------------------------------------------------------------------------

function tmpDbPath(name: string): string {
  const path = join(tmpdir(), `scq-test50-${name}-${process.pid}.sqlite`);
  rmSync(path, { force: true });
  rmSync(path + "-wal", { force: true });
  rmSync(path + "-shm", { force: true });
  return path;
}

test("Test 50.26: durable store — appended evidence and the promoted view survive restart; recorded identity unchanged", () => {
  const path = tmpDbPath("durable-ok");
  const a = new DurableQuoteStore(path, { recoveryGraceMs: 0 });
  a.put(makeQuote50("q50_26"));
  const receipt = candidateReceipt("q50_26", candidates({ immediate: QUOTED.immediate, recurring: QUOTED.recurring }));
  a.recordCommitReceipt("q50_26", receipt);
  const view = a.recordReceiptEvidence("q50_26", mint(a, "q50_26", observationFromRecord(makeProviderRecord())));
  assert.equal(view.outcome, "COMMITTED_AND_VERIFIED");
  a.close();

  const b = new DurableQuoteStore(path, { recoveryGraceMs: 0 });
  const q = b.get("q50_26")!;
  assert.deepEqual(q.commit_receipt, view);
  assert.equal(q.commit_receipt_verifications?.length, 1);
  assert.equal(q.commit_receipt_identity_digest, receiptIdentityDigest(receipt));
  assert.deepEqual(b.recordedReceipt("q50_26"), receipt);
  b.close();
});

test("Test 50.27: durable store — an interrupted evidence append cannot persist a phantom verified view (fault injection, both fault points)", () => {
  for (const faultPoint of ["beforePersist", "insidePersistTx"] as const) {
    const path = tmpDbPath(`durable-fault-${faultPoint}`);
    const seed = new DurableQuoteStore(path, { recoveryGraceMs: 0 });
    seed.put(makeQuote50("q50_27"));
    seed.recordCommitReceipt("q50_27", candidateReceipt("q50_27", candidates({ immediate: QUOTED.immediate, recurring: QUOTED.recurring })));
    seed.close();

    const faults = {
      [faultPoint]: (op: string) => {
        if (op === "recordReceiptEvidence") throw new Error(`simulated crash at ${faultPoint}`);
      },
    };
    const crashing = new DurableQuoteStore(path, { recoveryGraceMs: 0, faults });
    const token = mint(crashing, "q50_27", observationFromRecord(makeProviderRecord()));
    assert.throws(() => crashing.recordReceiptEvidence("q50_27", token), (e: unknown) => e instanceof DurableStoreError, faultPoint);
    assert.throws(() => crashing.get("q50_27"), (e: unknown) => e instanceof DurableStoreError, "the poisoned instance serves no volatile state");
    crashing.close();

    const reopened = new DurableQuoteStore(path, { recoveryGraceMs: 0 });
    const q = reopened.get("q50_27")!;
    assert.equal(q.commit_receipt?.outcome, "COMMITTED_UNVERIFIED", "the disk holds exactly the pre-append state — no phantom promotion");
    assert.equal(q.commit_receipt_verifications?.length ?? 0, 0);
    reopened.close();
  }
});

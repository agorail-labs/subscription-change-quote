import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";

// ---------------------------------------------------------------------------
// Temp-file cleanup (test infrastructure): every database file handed out
// via tmpDbPath is removed when this file's tests finish — pass or fail —
// so repeated suite runs do not accumulate scq-test50-* litter in the OS
// temp dir. (tmpDbPath's pre-use removal of stale files is unchanged.)
// ---------------------------------------------------------------------------
const tempDbFiles: string[] = [];
after(() => {
  for (const path of tempDbFiles.splice(0)) {
    rmSync(path, { force: true });
    rmSync(path + "-wal", { force: true });
    rmSync(path + "-shm", { force: true });
  }
});

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
  observedStateDigestOf,
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
  tempDbFiles.push(path);
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

// ---------------------------------------------------------------------------
// Cross-observation coherence (PR-17 independent review): can
// dimensions established by MUTUALLY INCOMPATIBLE observations
// compose into a promoted COMMITTED_AND_VERIFIED/OK view, using
// a VERIFIED state carried by only one of them?
//
// Fixture states of the SAME subscription at different revisions:
//   S_v2 — revision v2; the read omits the item collection, so
//          the §6.12 checks are UNVERIFIABLE against it;
//   S_v3 — revision v3, a LATER, different post-commit state (an
//          additional item has landed since v2); the targeted
//          ACTION_LEVEL check passes against it (VERIFIED);
//   S_v4 — revision v4, a third distinct revision.
// Figures are derived from mock provider records exactly as in
// the fixtures above (immediate from the operation-bound charge,
// recurring from the record's item amounts, summed).
// ---------------------------------------------------------------------------

function snapshotV2CollectionOmitted(): SubscriptionSnapshot {
  return {
    id: SUB,
    version: "v2",
    status: "active",
    billing: { currency: "USD", cadence: "MONTHLY", recurringAmount: QUOTED.recurring },
  } as unknown as SubscriptionSnapshot;
}

function snapshotV3ExtraItem(): SubscriptionSnapshot {
  return {
    id: SUB,
    version: "v3",
    status: "active",
    items: [
      { id: "item_1", offeringRef: "plan", quantity: 2 },
      { id: "item_2", offeringRef: "addon", quantity: 1 },
    ],
    billing: { currency: "USD", cadence: "MONTHLY", recurringAmount: QUOTED.recurring },
  };
}

function snapshotV4TargetOnly(): SubscriptionSnapshot {
  return {
    id: SUB,
    version: "v4",
    status: "active",
    items: [{ id: "item_1", offeringRef: "plan", quantity: 2 }],
    billing: { currency: "USD", cadence: "MONTHLY", recurringAmount: QUOTED.recurring },
  };
}

test("Test 50.28 (cross-observation coherence): dimensions established against DIFFERENT post-commit states must not compose into a promoted verified view", () => {
  const { store } = seededStore("q50_28", candidates({ immediate: QUOTED.immediate, recurring: QUOTED.recurring }));

  // Entry A: establishes the IMMEDIATE actual (the S_v2 record's
  // operation-bound charge) from an observation of state S_v2,
  // against which the post-commit state is UNVERIFIABLE (the
  // read omitted the item collection).
  const obsA = observationFromRecord(makeProviderRecord(), { omit: ["recurring"], source: "test50.28: read of state v2 (immediate)" });
  obsA.resultingSnapshot = snapshotV2CollectionOmitted();
  const tokenA = mint(store, "q50_28", obsA);
  assert.equal(tokenA.stateVerification, "UNVERIFIABLE", "fixture check: state v2 does not verify");
  const viewA = store.recordReceiptEvidence("q50_28", tokenA);
  assert.equal(viewA.outcome, "COMMITTED_UNVERIFIED");
  assert.equal(viewA.committedEffect.immediate?.net, QUOTED.immediate, "the immediate actual is displayed");

  // Entry B: establishes the RECURRING actual (the S_v3 record's
  // item amounts, summed) from an observation of state S_v3 — a
  // DIFFERENT, later post-commit state — and carries the
  // VERIFIED state verdict FOR S_v3.
  const obsB = observationFromRecord(makeProviderRecord(), { omit: ["immediate"], source: "test50.28: read of state v3 (recurring)" });
  obsB.resultingSnapshot = snapshotV3ExtraItem();
  const tokenB = mint(store, "q50_28", obsB);
  assert.equal(tokenB.stateVerification, "VERIFIED", "fixture check: the targeted check passes against state v3");
  const viewB = store.recordReceiptEvidence("q50_28", tokenB);

  // Truthful outcome: the composed figures and the verified
  // state were never supported by one coherent observation —
  // the immediate actual was established against S_v2 (state
  // unverified) and the state verdict describes S_v3. The
  // entries are individually admissible and both actuals may be
  // RECORDED and displayed, but the record must NOT promote.
  assert.equal(viewB.committedEffect.immediate?.net, QUOTED.immediate, "the composed immediate actual is still displayed");
  assert.equal(viewB.committedEffect.recurring?.resultingAmount, QUOTED.recurring, "the composed recurring actual is still displayed");
  assert.equal(viewB.committedEffect.determinacy?.immediateFinancialEffect, "DETERMINED");
  assert.equal(viewB.committedEffect.determinacy?.recurringFinancialEffect, "DETERMINED");
  assert.equal(
    viewB.outcome,
    "COMMITTED_UNVERIFIED",
    "a VERIFIED verdict for state v3 must not promote figures established against state v2"
  );
  assert.equal(viewB.reconciliation.status, "UNVERIFIED");
  assert.match(
    viewB.reconciliation.status === "UNVERIFIED" ? viewB.reconciliation.reason : "",
    /different observed|incoheren|coheren/i,
    "the blocker names the cross-observation incoherence"
  );
});

test("Test 50.29 (cross-observation coherence, variant): a VERIFIED entry establishing NO dimension cannot lend its state verdict to financials established against two other states", () => {
  const { store } = seededStore("q50_29", candidates({ immediate: QUOTED.immediate, recurring: QUOTED.recurring }));

  // Financial entries from states v2 and v3 (both state-
  // UNVERIFIABLE: their reads omit the item collection).
  const obsA = observationFromRecord(makeProviderRecord(), { omit: ["recurring"], source: "test50.29: read of state v2 (immediate)" });
  obsA.resultingSnapshot = snapshotV2CollectionOmitted();
  const tokenA = mint(store, "q50_29", obsA);
  assert.equal(tokenA.stateVerification, "UNVERIFIABLE");
  store.recordReceiptEvidence("q50_29", tokenA);

  const obsB = observationFromRecord(makeProviderRecord(), { omit: ["immediate"], source: "test50.29: read of state v3 (recurring)" });
  obsB.resultingSnapshot = {
    id: SUB,
    version: "v3",
    status: "active",
    billing: { currency: "USD", cadence: "MONTHLY", recurringAmount: QUOTED.recurring },
  } as unknown as SubscriptionSnapshot;
  const tokenB = mint(store, "q50_29", obsB);
  assert.equal(tokenB.stateVerification, "UNVERIFIABLE");
  store.recordReceiptEvidence("q50_29", tokenB);

  // A third observation, of a THIRD state (v4), establishes no
  // financial dimension at all — but its state verdict is
  // VERIFIED for v4.
  const obsC = observationFromRecord(makeProviderRecord(), { omit: ["immediate", "recurring"], source: "test50.29: read of state v4 (state only)" });
  obsC.resultingSnapshot = snapshotV4TargetOnly();
  const tokenC = mint(store, "q50_29", obsC);
  assert.equal(tokenC.stateVerification, "VERIFIED", "fixture check: state v4 verifies");
  const view = store.recordReceiptEvidence("q50_29", tokenC);

  assert.equal(view.committedEffect.immediate?.net, QUOTED.immediate);
  assert.equal(view.committedEffect.recurring?.resultingAmount, QUOTED.recurring);
  assert.equal(
    view.outcome,
    "COMMITTED_UNVERIFIED",
    "a state verdict for v4 must not promote actuals established against v2 and v3"
  );
  assert.equal(view.reconciliation.status, "UNVERIFIED");
  assert.match(view.reconciliation.status === "UNVERIFIED" ? view.reconciliation.reason : "", /different observed|incoheren|coheren/i);
});

test("Test 50.30 (cross-observation coherence at recovery): an incoherent trail stays unpromoted after restart, and a forged promoted view over it refuses restore", () => {
  const { store } = seededStore("q50_30", candidates({ immediate: QUOTED.immediate, recurring: QUOTED.recurring }));
  const obsA = observationFromRecord(makeProviderRecord(), { omit: ["recurring"] });
  obsA.resultingSnapshot = snapshotV2CollectionOmitted();
  store.recordReceiptEvidence("q50_30", mint(store, "q50_30", obsA));
  const obsB = observationFromRecord(makeProviderRecord(), { omit: ["immediate"] });
  obsB.resultingSnapshot = snapshotV3ExtraItem();
  const liveView = store.recordReceiptEvidence("q50_30", mint(store, "q50_30", obsB));
  assert.equal(liveView.outcome, "COMMITTED_UNVERIFIED", "the live view does not promote on incoherent composition");

  const persisted = store.serializeReceiptRecords();
  const restored = new QuoteStore();
  restored.put(makeQuote50("q50_30"));
  restored.restoreReceiptRecords(persisted);
  const q = restored.get("q50_30")!;
  assert.deepEqual(q.commit_receipt, liveView, "the restored view is the same unpromoted derivation");
  assert.equal(q.commit_receipt?.outcome, "COMMITTED_UNVERIFIED");

  // Forge the persisted current view into the promoted shape
  // the incoherent trail cannot support: restore must refuse
  // the whole set (the view is derived, never trusted).
  const forged = JSON.parse(persisted);
  forged.records[0].current_receipt = {
    ...forged.records[0].current_receipt,
    status: "COMMITTED",
    outcome: "COMMITTED_AND_VERIFIED",
    reconciliation: { status: "OK" },
  };
  const r2 = new QuoteStore();
  r2.put(makeQuote50("q50_30"));
  assert.throws(() => r2.restoreReceiptRecords(JSON.stringify(forged)), /coheren|derived|current view/i);
  assert.equal(r2.get("q50_30")!.commit_receipt, undefined, "no partial adoption");
});

test("Test 50.31 (coherence control): partial entries and a state verdict drawn from reads of the SAME state revision compose and promote", () => {
  const { store } = seededStore("q50_31", candidates({ immediate: QUOTED.immediate, recurring: QUOTED.recurring }));
  // All three observations are of state revision v3: the two
  // financial reads omit the item collection (state
  // UNVERIFIABLE from those reads alone); the third read of
  // the SAME revision carries the collection and verifies it.
  const v3NoItems = (): SubscriptionSnapshot =>
    ({
      id: SUB,
      version: "v3",
      status: "active",
      billing: { currency: "USD", cadence: "MONTHLY", recurringAmount: QUOTED.recurring },
    }) as unknown as SubscriptionSnapshot;

  const obsA = observationFromRecord(makeProviderRecord(), { omit: ["recurring"], source: "test50.31: read of state v3 (immediate)" });
  obsA.resultingSnapshot = v3NoItems();
  store.recordReceiptEvidence("q50_31", mint(store, "q50_31", obsA));

  const obsB = observationFromRecord(makeProviderRecord(), { omit: ["immediate"], source: "test50.31: read of state v3 (recurring)" });
  obsB.resultingSnapshot = v3NoItems();
  store.recordReceiptEvidence("q50_31", mint(store, "q50_31", obsB));

  const obsC = observationFromRecord(makeProviderRecord(), { omit: ["immediate", "recurring"], source: "test50.31: read of state v3 (state only)" });
  obsC.resultingSnapshot = snapshotV3ExtraItem();
  const tokenC = mint(store, "q50_31", obsC);
  assert.equal(tokenC.stateVerification, "VERIFIED");
  const view = store.recordReceiptEvidence("q50_31", tokenC);

  assert.equal(view.outcome, "COMMITTED_AND_VERIFIED", "reads of ONE state revision compose coherently and may promote");
  assert.equal(view.reconciliation.status, "OK");
  assert.equal(view.committedEffect.immediate?.net, QUOTED.immediate);
  assert.equal(view.committedEffect.recurring?.resultingAmount, QUOTED.recurring);
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

// ---------------------------------------------------------------------------
// Degenerate-revision edge case (PR-17 re-review of the §8
// correction): `observedStateDigestOf` checked that a snapshot
// EXISTS but never validated its revision. Two observations of
// DIFFERENT post-commit states whose snapshots carry an empty
// (or runtime-missing) version therefore received the SAME
// coherence identity — the digest of {subscription, ""} — and a
// promotion basis composed from them was judged coherent: the
// false-promotion class §8 closed, re-entering through
// degenerate revisions. An observed-state identity must exist
// only when BOTH components are established: a present snapshot
// whose id AND version are each a non-empty string (after
// trimming); anything else is no identity, and the entry is
// treated exactly like a snapshot-less observation — recordable
// and displayable, unable to join a cross-entry promotion.
// ---------------------------------------------------------------------------

test("Test 50.32 (degenerate revision, unit pins): an observed-state identity exists only when both components are established", () => {
  // No snapshot at all: no identity (pre-existing behavior).
  assert.equal(observedStateDigestOf(undefined), undefined);
  // Empty version: degenerate — no identity (pre-fix this
  // returned the digest of {id, ""}, shared by EVERY empty-
  // version observation of the subscription).
  assert.equal(observedStateDigestOf({ id: SUB, version: "" }), undefined);
  // Whitespace-only version: not an established revision.
  assert.equal(observedStateDigestOf({ id: SUB, version: "   " }), undefined);
  // Version missing at runtime (a deserialized record's shape):
  // no identity.
  assert.equal(observedStateDigestOf({ id: SUB } as { id: string; version: string }), undefined);
  // Non-string version at runtime: no identity.
  assert.equal(observedStateDigestOf({ id: SUB, version: 3 as unknown as string }), undefined);
  // The subscription id component is validated the same way.
  assert.equal(observedStateDigestOf({ id: "", version: "v3" }), undefined);
  assert.equal(observedStateDigestOf({ id: "  ", version: "v3" }), undefined);
  // An established pair yields a defined identity, and distinct
  // real revisions yield distinct identities (pre-existing
  // behavior, pinned).
  const d3 = observedStateDigestOf({ id: SUB, version: "v3" });
  assert.equal(typeof d3, "string");
  assert.notEqual(observedStateDigestOf({ id: SUB, version: "v2" }), d3);
});

function snapshotEmptyVersionCollectionOmitted(): SubscriptionSnapshot {
  return {
    id: SUB,
    version: "",
    status: "active",
    billing: { currency: "USD", cadence: "MONTHLY", recurringAmount: QUOTED.recurring },
  } as unknown as SubscriptionSnapshot;
}

function snapshotEmptyVersionExtraItem(): SubscriptionSnapshot {
  return {
    id: SUB,
    version: "",
    status: "active",
    items: [
      { id: "item_1", offeringRef: "plan", quantity: 2 },
      { id: "item_2", offeringRef: "addon", quantity: 1 },
    ],
    billing: { currency: "USD", cadence: "MONTHLY", recurringAmount: QUOTED.recurring },
  };
}

test("Test 50.33 (degenerate revision, attack 1): dimensions established against different states whose snapshots both carry an EMPTY version must not compose into a promoted view", () => {
  const { store } = seededStore("q50_33", candidates({ immediate: QUOTED.immediate, recurring: QUOTED.recurring }));

  // Entry A: immediate actual from an observation of one
  // post-commit state (read omits the item collection; state
  // UNVERIFIABLE) whose snapshot carries version "".
  const obsA = observationFromRecord(makeProviderRecord(), { omit: ["recurring"], source: "test50.33: read of an empty-version state (immediate)" });
  obsA.resultingSnapshot = snapshotEmptyVersionCollectionOmitted();
  const tokenA = mint(store, "q50_33", obsA);
  assert.equal(tokenA.stateVerification, "UNVERIFIABLE", "fixture check: the collection-omitted read does not verify");
  store.recordReceiptEvidence("q50_33", tokenA);

  // Entry B: recurring actual from an observation of a
  // DIFFERENT state (an extra item has landed) whose snapshot
  // ALSO carries version "" — and carries the VERIFIED verdict
  // for its state.
  const obsB = observationFromRecord(makeProviderRecord(), { omit: ["immediate"], source: "test50.33: read of another empty-version state (recurring)" });
  obsB.resultingSnapshot = snapshotEmptyVersionExtraItem();
  const tokenB = mint(store, "q50_33", obsB);
  assert.equal(tokenB.stateVerification, "VERIFIED", "fixture check: the targeted check passes against entry B's state");
  const view = store.recordReceiptEvidence("q50_33", tokenB);

  // Both entries are recorded and their actuals displayed —
  // but an empty revision establishes NO observed-state
  // identity, so neither entry can join a cross-entry
  // promotion basis: the two states were never shown to be one
  // state. (Pre-fix, both entries carried the digest of
  // {SUB, ""} — the basis read as coherent and this view
  // promoted to COMMITTED_AND_VERIFIED/OK.)
  assert.equal(view.committedEffect.immediate?.net, QUOTED.immediate, "the immediate actual is still displayed");
  assert.equal(view.committedEffect.recurring?.resultingAmount, QUOTED.recurring, "the recurring actual is still displayed");
  const entries = store.get("q50_33")!.commit_receipt_verifications ?? [];
  assert.equal(entries.length, 2);
  assert.ok(
    entries.every((e) => e.observedStateDigest === undefined),
    "neither entry carries an observed-state identity: an empty revision establishes none"
  );
  assert.equal(view.outcome, "COMMITTED_UNVERIFIED", "an empty revision must not let two different states share a coherence identity");
  assert.equal(view.reconciliation.status, "UNVERIFIED");
  assert.match(view.reconciliation.status === "UNVERIFIED" ? view.reconciliation.reason : "", /different observed|incoheren|coheren/i);
});

test("Test 50.34 (degenerate revision, attack 2): dimensions established against different states whose snapshots carry NO version at runtime must not compose into a promoted view", () => {
  const { store } = seededStore("q50_34", candidates({ immediate: QUOTED.immediate, recurring: QUOTED.recurring }));

  const noVersionSnapshot = (withItems: boolean): SubscriptionSnapshot =>
    ({
      id: SUB,
      status: "active",
      ...(withItems
        ? {
            items: [
              { id: "item_1", offeringRef: "plan", quantity: 2 },
              { id: "item_2", offeringRef: "addon", quantity: 1 },
            ],
          }
        : {}),
      billing: { currency: "USD", cadence: "MONTHLY", recurringAmount: QUOTED.recurring },
    }) as unknown as SubscriptionSnapshot;

  // Entry A: immediate actual, observation of one state, its
  // snapshot deserialized WITHOUT a version field.
  const obsA = observationFromRecord(makeProviderRecord(), { omit: ["recurring"], source: "test50.34: read of a version-less state (immediate)" });
  obsA.resultingSnapshot = noVersionSnapshot(false);
  const tokenA = mint(store, "q50_34", obsA);
  assert.equal(tokenA.stateVerification, "UNVERIFIABLE");
  store.recordReceiptEvidence("q50_34", tokenA);

  // Entry B: recurring actual, observation of a DIFFERENT
  // state, also version-less, carrying VERIFIED for its state.
  const obsB = observationFromRecord(makeProviderRecord(), { omit: ["immediate"], source: "test50.34: read of another version-less state (recurring)" });
  obsB.resultingSnapshot = noVersionSnapshot(true);
  const tokenB = mint(store, "q50_34", obsB);
  assert.equal(tokenB.stateVerification, "VERIFIED", "fixture check: the targeted check passes against entry B's state");
  const view = store.recordReceiptEvidence("q50_34", tokenB);

  assert.equal(view.committedEffect.immediate?.net, QUOTED.immediate);
  assert.equal(view.committedEffect.recurring?.resultingAmount, QUOTED.recurring);
  assert.equal(view.outcome, "COMMITTED_UNVERIFIED", "a missing revision must not let two different states share a coherence identity");
  assert.equal(view.reconciliation.status, "UNVERIFIED");
  assert.match(view.reconciliation.status === "UNVERIFIED" ? view.reconciliation.reason : "", /different observed|incoheren|coheren/i);
});

test("Test 50.35 (degenerate revision, control): an empty-version entry beside a real-revision entry is incoherent — before and after the fix", () => {
  const { store } = seededStore("q50_35", candidates({ immediate: QUOTED.immediate, recurring: QUOTED.recurring }));

  const obsA = observationFromRecord(makeProviderRecord(), { omit: ["recurring"], source: "test50.35: read of an empty-version state (immediate)" });
  obsA.resultingSnapshot = snapshotEmptyVersionCollectionOmitted();
  store.recordReceiptEvidence("q50_35", mint(store, "q50_35", obsA));

  const obsB = observationFromRecord(makeProviderRecord(), { omit: ["immediate"], source: "test50.35: read of state v3 (recurring)" });
  obsB.resultingSnapshot = snapshotV3ExtraItem();
  const tokenB = mint(store, "q50_35", obsB);
  assert.equal(tokenB.stateVerification, "VERIFIED");
  const view = store.recordReceiptEvidence("q50_35", tokenB);

  // Control: the digests already differed pre-fix ({SUB, ""}
  // vs {SUB, "v3"}), and post-fix the empty-version entry
  // carries no identity at all — either way the basis is
  // incoherent and the view must not promote.
  assert.equal(view.outcome, "COMMITTED_UNVERIFIED");
  assert.equal(view.reconciliation.status, "UNVERIFIED");
});

test("Test 50.36 (degenerate revision at recovery): a persisted trail whose entries carry an old-rule degenerate observed-state digest refuses the whole restore set", () => {
  // Build a sound, promoting trail (the 50.31 same-revision
  // form) and persist it.
  const { store } = seededStore("q50_36", candidates({ immediate: QUOTED.immediate, recurring: QUOTED.recurring }));
  const v3NoItems = (): SubscriptionSnapshot =>
    ({
      id: SUB,
      version: "v3",
      status: "active",
      billing: { currency: "USD", cadence: "MONTHLY", recurringAmount: QUOTED.recurring },
    }) as unknown as SubscriptionSnapshot;
  const obsA = observationFromRecord(makeProviderRecord(), { omit: ["recurring"] });
  obsA.resultingSnapshot = v3NoItems();
  store.recordReceiptEvidence("q50_36", mint(store, "q50_36", obsA));
  const obsB = observationFromRecord(makeProviderRecord(), { omit: ["immediate"] });
  obsB.resultingSnapshot = v3NoItems();
  store.recordReceiptEvidence("q50_36", mint(store, "q50_36", obsB));
  const obsC = observationFromRecord(makeProviderRecord(), { omit: ["immediate", "recurring"] });
  obsC.resultingSnapshot = snapshotV3ExtraItem();
  const liveView = store.recordReceiptEvidence("q50_36", mint(store, "q50_36", obsC));
  assert.equal(liveView.outcome, "COMMITTED_AND_VERIFIED", "fixture check: the sound trail promotes");
  const persisted = store.serializeReceiptRecords();

  // Control: the untampered set restores and adopts the
  // promoted view — the refusal below is caused by the
  // degenerate digests, not by incidental corruption.
  const control = new QuoteStore();
  control.put(makeQuote50("q50_36"));
  control.restoreReceiptRecords(persisted);
  assert.equal(control.get("q50_36")!.commit_receipt?.outcome, "COMMITTED_AND_VERIFIED");

  // The two digest values the PRE-FIX rule minted from
  // degenerate revisions of this subscription: an empty
  // version, and an absent version (the canonical form drops
  // undefined components). Rewrite every entry's stored
  // observed-state identity to each in turn (the stated
  // evidenceId is removed, so the set is judged on its stored
  // contents and derivation, exactly as a pre-fix persisted
  // record would be). Under the stored degenerate digests the
  // derivation reproduces the promoted view — the entries all
  // "share" one identity — so only the coherence soundness of
  // the identity itself can refuse this set.
  const degenerateDigests = [
    createHash("sha256").update(`{"subscriptionId":${JSON.stringify(SUB)},"version":""}`, "utf8").digest("hex"),
    createHash("sha256").update(`{"subscriptionId":${JSON.stringify(SUB)}}`, "utf8").digest("hex"),
  ];
  for (const degenerate of degenerateDigests) {
    const forged = JSON.parse(persisted);
    for (const entry of forged.records[0].verifications) {
      entry.observedStateDigest = degenerate;
      delete entry.evidenceId;
    }
    const r = new QuoteStore();
    r.put(makeQuote50("q50_36"));
    assert.throws(() => r.restoreReceiptRecords(JSON.stringify(forged)), /degenerate/i);
    assert.equal(r.get("q50_36")!.commit_receipt, undefined, "no partial adoption");
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { QuoteStore, establishVerification } from "../src/store/quote-store.js";
import type {
  CommercialEffect,
  ProviderObservation,
  SubscriptionChangeReceipt,
  SubscriptionSnapshot,
} from "../src/core/types.js";
import type { StoredQuote } from "../src/store/quote-store.js";

// Test 46 — Issue #22, Finding 5 (P1): receipt verification and
// independent later actuals.
//
// ORIGINAL REPRODUCTION (PR #23, against main 6f56b05): built on
// the merged candidate construction (a COMMITTED_UNVERIFIED
// receipt records the mutation response's figures as CANDIDATES,
// UNKNOWN determinacy, committedSource "unestablished"). The
// store's verifyCommitReceipt then validated later evidence by
// EXACT figure equality with the recorded candidates, so:
//   46.1 a dimension the receipt left candidate-LESS could never
//        be filled by later establishing evidence;
//   46.2 a candidate that turned out WRONG could never be
//        corrected by evidence establishing a different actual;
//   46.3 confirming evidence flipped the view to VERIFIED/OK
//        while the displayed figures still carried UNKNOWN /
//        "unestablished" provenance labels.
// All three failed on unmodified main; the recorded original was
// never rewritten (asserted as a control, and correct).
//
// 2026-11 RECONCILIATION RERUN (Issue #22 closure audit, main
// 62744ee): Finding 5 was FIXED by PR #27 (append-only,
// identity-bound evidence records plus a separately DERIVED
// current view carrying the establishing evidence's figures and
// provenance; default-suite regression home: test50; candidate
// sourcing later corrected by PR #53). The original harness
// construction — a live-adapter commit producing the candidate
// receipt — is no longer reachable, because the
// authorization-preservation gate (PR #24) refuses this adapter's
// full-replacement commits before dispatch. The three scenarios
// below are therefore rebuilt on the store-level candidate
// construction test50 uses (a seeded COMMITTED_UNVERIFIED
// candidate receipt in a QuoteStore), keeping the original
// assertions of safe behavior: differing/missing actuals are
// RECORDABLE, the derived view presents established actuals with
// establishing provenance, and the recorded original is never
// rewritten. Figure discipline follows REVIEW-2 / test50: every
// figure claimed as an established ACTUAL is derived from the
// mock provider record below (recurring = the record's stated
// item amounts, summed; immediate = the record's operation-bound
// unbilled charge for this mutation). Candidate figures are the
// receipt's own unverified figures — literals there are the point.
//
// RESEARCH SUITE (PR #23 REVIEW-1): this file is NOT part of the
// default `npm test` discovery (`dist/tests/*.test.js`). Build,
// then invoke the research suite explicitly:
// `node --test dist/tests/*.repro.js`. Simulated evidence only.

const SUB = "pilot-sub-001";
const QUOTED = { immediate: 20000, recurring: 80900 };

// ---------------------------------------------------------------------------
// Mock provider record + derivations (mirrors test50's discipline)
// ---------------------------------------------------------------------------

type MockProviderRecord = {
  items: Array<{ item_price_id: string; amount: number }>;
  operationCharge?: number;
};

function snapshotFromRecord(record: MockProviderRecord): SubscriptionSnapshot {
  return {
    id: SUB,
    version: "v2",
    status: "active",
    items: [{ id: "pilot-addon-vision", offeringRef: "addon", quantity: 21 }],
    billing: {
      currency: "USD",
      cadence: "MONTHLY",
      recurringAmount: record.items.reduce((s, i) => s + i.amount, 0),
    },
  };
}

function observationFromRecord(
  record: MockProviderRecord,
  opts: { omitImmediate?: boolean } = {}
): ProviderObservation {
  const snapshot = snapshotFromRecord(record);
  const effect: CommercialEffect = {
    ...(opts.omitImmediate || record.operationCharge === undefined
      ? {}
      : { immediate: { net: record.operationCharge } }),
    recurring: { resultingAmount: snapshot.billing.recurringAmount!, currency: "USD", cadence: "MONTHLY" },
    determinacy: {
      immediateFinancialEffect: opts.omitImmediate || record.operationCharge === undefined ? "UNKNOWN" : "DETERMINED",
      recurringFinancialEffect: "DETERMINED",
    },
    provenance: {
      ...(!opts.omitImmediate && record.operationCharge !== undefined
        ? { immediate: "test46: provider's operation-bound unbilled-charge record for this mutation (mocked)" }
        : {}),
      recurring: "test46: independent post-commit read — record's stated item amounts, summed (mocked)",
      committedSource: "provider_actual",
    },
  };
  return {
    subscriptionRef: SUB,
    committedEffect: effect,
    resultingSnapshot: snapshot,
    source: "test46: independent post-commit provider reads (mocked)",
    observedAt: "2026-11-02T00:06:00.000Z",
  };
}

// ---------------------------------------------------------------------------
// Quote / candidate-receipt fixtures (the PR #10/#11 candidate
// construction, seeded at store level as in test50)
// ---------------------------------------------------------------------------

function makeQuote(quoteId: string): StoredQuote {
  return {
    quote_id: quoteId,
    provider: "chargebee",
    subscription_id: SUB,
    subscription_version_at_quote: "v1",
    proposal: {
      changes: [{ action: "CHANGE_QUANTITY", itemId: "pilot-addon-vision", quantity: 21 }],
      effectiveIntent: { type: "IMMEDIATE" },
      acceptanceEnvelope: {},
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
      provenance: { immediate: "test46: quote-time preview", recurring: "test46: quote-time preview" },
    },
    created_at: "2026-11-02T00:00:00.000Z",
    expires_at: "2026-11-02T01:00:00.000Z",
    status: "ACTIVE",
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

function candidateReceipt(quoteId: string, committedEffect: CommercialEffect): SubscriptionChangeReceipt {
  return {
    quoteId,
    subscriptionRef: SUB,
    receiptId: `rcpt_${quoteId}`,
    status: "COMMITTED_UNVERIFIED",
    outcome: "COMMITTED_UNVERIFIED",
    resultingSnapshot: {
      id: SUB,
      version: "v2",
      status: "active",
      items: [{ id: "pilot-addon-vision", offeringRef: "addon", quantity: 21 }],
      billing: { currency: "USD", cadence: "MONTHLY" },
    },
    quotedEffect: {
      immediate: { net: QUOTED.immediate },
      recurring: { resultingAmount: QUOTED.recurring, currency: "USD", cadence: "MONTHLY" },
      determinacy: { immediateFinancialEffect: "DETERMINED", recurringFinancialEffect: "DETERMINED" },
      provenance: { immediate: "test46: quote-time preview", recurring: "test46: quote-time preview" },
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
    committedAt: "2026-11-02T00:05:00.000Z",
  };
}

function seededStore(quoteId: string, committedEffect: CommercialEffect) {
  const store = new QuoteStore();
  store.put(makeQuote(quoteId));
  const receipt = candidateReceipt(quoteId, committedEffect);
  store.recordCommitReceipt(quoteId, receipt);
  return { store, receipt };
}

// ---------------------------------------------------------------------------
// 46.1 — a missing candidate can be filled by later evidence
// ---------------------------------------------------------------------------

test("Test 46.1 (Issue #22 F5a): later evidence establishing a dimension the receipt left candidate-less is recordable, not refused as an identity conflict", () => {
  // The receipt records a recurring candidate (80900) but NO
  // immediate candidate (the mutation response carried no
  // financials for that dimension).
  const { store, receipt } = seededStore("q46_1", candidates({ recurring: QUOTED.recurring }));
  assert.equal(receipt.committedEffect.immediate, undefined, "fixture check: no immediate candidate recorded");

  // The provider record establishes immediate 20000 (its
  // operation-bound charge) and recurring 80900 (its stated item
  // amounts, summed) — both derived from the record, not literals.
  const record: MockProviderRecord = {
    items: [{ item_price_id: "pilot-plan-business", amount: 59900 }, { item_price_id: "pilot-addon-vision", amount: 21000 }],
    operationCharge: 20000,
  };
  assert.equal(snapshotFromRecord(record).billing.recurringAmount, 80900, "fixture check: the record's stated amounts sum to the candidate recurring");
  const evidence = establishVerification(store.get("q46_1")!, observationFromRecord(record));
  let verifyError: unknown;
  let verified: ReturnType<typeof store.verifyCommitReceipt> | undefined;
  try {
    verified = store.verifyCommitReceipt("q46_1", evidence);
  } catch (e) {
    verifyError = e;
  }
  console.log("=== TEST46 EVIDENCE 46.1 (observed on current main, 2026-11 reconciliation) ===");
  console.log(JSON.stringify({
    recordedCandidates: { immediate: null, recurring: 80900 },
    evidenceEstablishes: { immediate: 20000, recurring: 80900 },
    verifyRefused: verifyError ? String((verifyError as Error).message).slice(0, 200) : null,
    verifiedViewImmediate: verified?.committedEffect.immediate?.net ?? null,
  }, null, 2));
  console.log("=== END TEST46 EVIDENCE ===");
  assert.equal(verifyError, undefined, "establishing a previously-missing dimension must be recordable as appended evidence, not refused as CONFLICTING_RECEIPT_IDENTITY");
  assert.equal(verified?.committedEffect.immediate?.net, 20000, "the derived current view must carry the established immediate actual");
});

// ---------------------------------------------------------------------------
// 46.2 — an incorrect candidate can be corrected by established
// actuals (recorded as verified-with-violation)
// ---------------------------------------------------------------------------

test("Test 46.2 (Issue #22 F5b): evidence establishing a DIFFERENT actual than the recorded candidate is recordable (verified-with-violation), not refused as an identity conflict", () => {
  // The receipt records candidate recurring 80900 (the mutation
  // response stated the plan at 59900). The provider's
  // authoritative record persists the plan at a corrected 62400,
  // so the record's stated amounts sum to 83400 — the differing
  // actual is established BY THE RECORD, not picked by this file.
  const { store, receipt } = seededStore("q46_2", candidates({ immediate: QUOTED.immediate, recurring: QUOTED.recurring }));
  const record: MockProviderRecord = {
    items: [{ item_price_id: "pilot-plan-business", amount: 62400 }, { item_price_id: "pilot-addon-vision", amount: 21000 }],
    operationCharge: 20000,
  };
  assert.equal(snapshotFromRecord(record).billing.recurringAmount, 83400, "fixture check: the provider record's stated item amounts sum to 83400");
  const evidence = establishVerification(store.get("q46_2")!, observationFromRecord(record));
  let verifyError: unknown;
  let verified: ReturnType<typeof store.verifyCommitReceipt> | undefined;
  try {
    verified = store.verifyCommitReceipt("q46_2", evidence);
  } catch (e) {
    verifyError = e;
  }
  console.log("=== TEST46 EVIDENCE 46.2 (observed on current main, 2026-11 reconciliation) ===");
  console.log(JSON.stringify({
    recordedCandidateRecurring: 80900,
    establishedActualRecurring: 83400,
    establishedActualImmediate: 20000,
    verifyRefused: verifyError ? String((verifyError as Error).message).slice(0, 200) : null,
    verifiedViewRecurring: verified?.committedEffect.recurring?.resultingAmount ?? null,
    verifiedViewReconciliation: verified?.reconciliation?.status ?? null,
  }, null, 2));
  console.log("=== END TEST46 EVIDENCE ===");
  assert.equal(verifyError, undefined, "a differing established actual must be recordable as appended evidence, not refused as CONFLICTING_RECEIPT_IDENTITY");
  assert.equal(verified?.committedEffect.recurring?.resultingAmount, 83400, "the derived view must carry the established actual, not the stale candidate");
  assert.equal(verified?.reconciliation?.status, "VIOLATED", "the derived view must report the established actual as a violation of the envelope, never a silent OK");
  // Control: the recorded ORIGINAL (commit_receipt_recorded) is
  // immutable — it still carries the candidate figures verbatim,
  // even though the derived view (commit_receipt) advanced.
  assert.deepEqual(store.get("q46_2")!.commit_receipt_recorded, receipt, "the recorded original receipt must never be rewritten");
});

// ---------------------------------------------------------------------------
// 46.3 — confirming evidence: the verified view's provenance must
// match its verdict
// ---------------------------------------------------------------------------

test("Test 46.3 (Issue #22 F5c): after a confirming verification, the current view must not present VERIFIED/OK over figures still labeled UNKNOWN / \"unestablished\"", () => {
  const { store, receipt } = seededStore("q46_3", candidates({ immediate: QUOTED.immediate, recurring: QUOTED.recurring }));
  const record: MockProviderRecord = {
    items: [{ item_price_id: "pilot-plan-business", amount: 59900 }, { item_price_id: "pilot-addon-vision", amount: 21000 }],
    operationCharge: 20000,
  };
  const evidence = establishVerification(store.get("q46_3")!, observationFromRecord(record));
  const verified = store.verifyCommitReceipt("q46_3", evidence);
  assert.equal(verified.outcome, "COMMITTED_AND_VERIFIED", "fixture check: the confirming transition succeeds");
  assert.equal(verified.reconciliation.status, "OK", "fixture check: reconciliation is OK for confirming evidence");

  console.log("=== TEST46 EVIDENCE 46.3 (observed on current main, 2026-11 reconciliation) ===");
  console.log(JSON.stringify({
    viewOutcome: verified.outcome,
    viewReconciliation: verified.reconciliation?.status,
    viewCommittedDeterminacy: verified.committedEffect.determinacy,
    viewCommittedSource: verified.committedEffect.provenance?.committedSource,
  }, null, 2));
  console.log("=== END TEST46 EVIDENCE ===");

  assert.ok(
    !(verified.committedEffect.determinacy?.immediateFinancialEffect === "UNKNOWN" && verified.committedEffect.provenance?.committedSource === "unestablished"),
    "the verified view presents COMMITTED_AND_VERIFIED/OK while its displayed committed figures remain determinacy UNKNOWN " +
      "with committedSource \"unestablished\" — the displayed provenance must be the establishing evidence's, not the candidate's labels",
  );
  assert.equal(verified.committedEffect.provenance?.committedSource, "provider_actual", "the view's figures carry the establishing evidence's provenance");
  // Control: the recorded ORIGINAL (commit_receipt_recorded)
  // keeps its candidate labels — immutability of the original is
  // correct; only the derived view advances.
  assert.deepEqual(store.get("q46_3")!.commit_receipt_recorded, receipt, "the recorded original receipt must never be rewritten");
});

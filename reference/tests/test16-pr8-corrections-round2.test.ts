import { test } from "node:test";
import assert from "node:assert/strict";
import { auditDeterminacy, checkIdempotentReplay } from "../src/core/scq-engine.js";
import {
  type CommercialEffect,
  type ProviderObservation,
  type SubscriptionChangeReceipt,
} from "../src/core/types.js";
import {
  QuoteStore,
  establishVerification,
  receiptIdentityDigest,
  type StoredQuote,
} from "../src/store/quote-store.js";

// SCQ v0.6.2 — PR #8 review corrections, ROUND 2 (four specific
// paths; the broader design is not revisited):
//
//   R1 — idempotent replay returns the ORIGINAL recorded receipt
//        (§6.10), not the mutable current view. After a
//        verification transition, replay still returns the receipt
//        as recorded; the latest verified state is exposed only
//        through separate current-view reads.
//   R2 — stored receipt data is protected on EVERY read path:
//        store.get() (and all()) must not hand out the internal
//        StoredQuote — a caller holding that reference could
//        rewrite the current reconciliation without
//        verifyCommitReceipt.
//   R3 — verification evidence must not be self-asserted: a
//        caller-constructed evidence object (even one built from
//        the receipt's own figures, labeled provider_actual, with
//        state VERIFIED) cannot promote a record. Evidence is
//        accepted only as a token minted by establishVerification
//        from an independent ProviderObservation. (The
//        establishment-path tests live below the R3 negative:
//        they exercise the new API and are added with the fix —
//        against the pre-fix head they fail to compile because the
//        API does not exist, which is itself the failing-first
//        signal for the missing trusted path.)
//   R4 — auditDeterminacy is role-aware about committed
//        provenance: an estimate-derived committedSource
//        (revalidated_preview / pre_mutation_estimate) on a
//        committed effect reports PROVENANCE_NOT_ESTABLISHING —
//        such figures must never establish committed actuals, so
//        they cannot satisfy the audit's provenance expectation.

// ---------------------------------------------------------------------------
// helpers (shapes mirror test15's standard fixtures)
// ---------------------------------------------------------------------------

function makeQuote(quoteId: string, subscriptionId = "sub_1"): StoredQuote {
  return {
    quote_id: quoteId,
    provider: "stripe",
    subscription_id: subscriptionId,
    subscription_version_at_quote: "v1",
    proposal: {
      changes: [{ action: "CHANGE_QUANTITY", itemId: "item_1", quantity: 2 }],
      effectiveIntent: { type: "IMMEDIATE" },
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
    quoted_effect: { immediate: { net: 1000 }, recurring: { resultingAmount: 5000, currency: "usd" } },
    created_at: "2026-10-28T00:00:00.000Z",
    expires_at: "2026-10-28T01:00:00.000Z",
    status: "ACTIVE",
  };
}

function makeReceipt(overrides: Partial<SubscriptionChangeReceipt> = {}): SubscriptionChangeReceipt {
  return {
    quoteId: "q1",
    subscriptionRef: "sub_1",
    status: "COMMITTED",
    outcome: "COMMITTED_AND_VERIFIED",
    resultingSnapshot: { id: "sub_1", version: "v2", status: "active", items: [], billing: { currency: "usd" } },
    quotedEffect: { immediate: { net: 1000 }, recurring: { resultingAmount: 5000, currency: "usd" } },
    committedEffect: { immediate: { net: 1000 }, recurring: { resultingAmount: 5000, currency: "usd" } },
    guaranteeMode: "REVALIDATE",
    consistencyGuarantee: "BEST_EFFORT",
    multiChangeConsistency: "ATOMIC",
    reconciliation: { status: "OK" },
    committedAt: "2026-10-28T00:05:00.000Z",
    ...overrides,
  };
}

function makeUnverifiedReceipt(overrides: Partial<SubscriptionChangeReceipt> = {}): SubscriptionChangeReceipt {
  return makeReceipt({
    status: "COMMITTED_UNVERIFIED",
    outcome: "COMMITTED_UNVERIFIED",
    reconciliation: {
      status: "UNVERIFIED",
      reason: "committed figures could not be established from provider actuals",
      undeterminedDimensions: ["immediateFinancialEffect"],
    },
    ...overrides,
  });
}

/**
 * A store whose q1 record is COMMITTED_UNVERIFIED as recorded and
 * VERIFIED as its current view — built through restoreReceiptRecords
 * with a coherent persisted set (recorded UNVERIFIED + exactly one
 * identity-bound verification whose evidence content-validates).
 * Building the verified state this way keeps these tests identical
 * before and after the R3 fix: recovery content-validation is not
 * the surface under correction here.
 */
function verifiedStoreViaRestore(): QuoteStore {
  const recorded = makeUnverifiedReceipt();
  const digest = receiptIdentityDigest(recorded);
  const evidence = {
    committedEffect: {
      immediate: { net: 1000 },
      recurring: { resultingAmount: 5000, currency: "usd" },
      provenance: { committedSource: "provider_actual" },
    },
    committedSource: "provider_actual",
    stateVerification: "VERIFIED",
    reconciliation: { status: "OK" },
  };
  const current = {
    ...JSON.parse(JSON.stringify(recorded)),
    status: "COMMITTED",
    outcome: "COMMITTED_AND_VERIFIED",
    reconciliation: { status: "OK" },
  };
  const persisted = JSON.stringify({
    records: [
      {
        quote_id: "q1",
        recorded_receipt: recorded,
        current_receipt: current,
        identity_digest: digest,
        verifications: [
          { at: "2026-10-28T00:06:00.000Z", reconciliation: { status: "OK" }, identityDigest: digest, evidence },
        ],
      },
    ],
  });
  const store = new QuoteStore();
  store.put(makeQuote("q1"));
  store.restoreReceiptRecords(persisted);
  return store;
}

// ---------------------------------------------------------------------------
// R1 — replay returns the ORIGINAL recorded receipt (§6.10)
// ---------------------------------------------------------------------------

test("Test 16.1 (R1): checkIdempotentReplay after verification returns the ORIGINAL recorded receipt — the verified state is a separate read", () => {
  const store = verifiedStoreViaRestore();
  // Separate current-view read: the record HAS been verified.
  assert.equal(store.get("q1")!.commit_receipt?.outcome, "COMMITTED_AND_VERIFIED");
  assert.equal(store.get("q1")!.commit_receipt?.reconciliation.status, "OK");

  const replayed = checkIdempotentReplay(store, "q1");
  assert.ok(replayed, "a committed quote replays");
  assert.equal(replayed.status, "COMMITTED_UNVERIFIED", "§6.10: replay returns the ORIGINAL receipt, as recorded");
  assert.equal(replayed.outcome, "COMMITTED_UNVERIFIED");
  assert.equal(replayed.reconciliation.status, "UNVERIFIED");
  assert.deepEqual(replayed, store.get("q1")!.commit_receipt_recorded);

  // The replayed object is a defensive copy: mutating it changes nothing.
  replayed.reconciliation = { status: "OK" };
  replayed.committedEffect.immediate!.net = 1;
  const replayedAgain = checkIdempotentReplay(store, "q1");
  assert.equal(replayedAgain?.reconciliation.status, "UNVERIFIED");
  assert.equal(replayedAgain?.committedEffect.immediate?.net, 1000);
});

test("Test 16.2 (R1): recordCommitReceipt replay after verification also returns the ORIGINAL recorded receipt", () => {
  const store = verifiedStoreViaRestore();
  const replayed = store.recordCommitReceipt("q1", makeUnverifiedReceipt());
  assert.equal(replayed?.status, "COMMITTED_UNVERIFIED", "replay returns the receipt as recorded, not the verified current view");
  assert.equal(replayed?.outcome, "COMMITTED_UNVERIFIED");
  assert.equal(replayed?.reconciliation.status, "UNVERIFIED");
  // The current view still shows the verified state via its own read.
  assert.equal(store.get("q1")!.commit_receipt?.outcome, "COMMITTED_AND_VERIFIED");
  assert.equal(store.get("q1")!.commit_receipt_verifications?.length, 1, "replay creates no second record or transition");
});

test("Test 16.3 (R1 control): replay of a never-transitioned receipt returns the recorded receipt (unchanged behavior)", () => {
  const store = new QuoteStore();
  store.put(makeQuote("q1"));
  store.recordCommitReceipt("q1", makeUnverifiedReceipt());
  const replayed = checkIdempotentReplay(store, "q1");
  assert.equal(replayed?.status, "COMMITTED_UNVERIFIED");
  assert.deepEqual(replayed, store.get("q1")!.commit_receipt_recorded);
});

// ---------------------------------------------------------------------------
// R2 — no read path hands out mutable stored receipt data
// ---------------------------------------------------------------------------

test("Test 16.4 (R2): mutating the StoredQuote returned by store.get() cannot rewrite the stored receipt or its digest", () => {
  const store = new QuoteStore();
  store.put(makeQuote("q1"));
  store.recordCommitReceipt("q1", makeUnverifiedReceipt());
  const digestBefore = store.get("q1")!.commit_receipt_identity_digest;

  const leaked = store.get("q1")!;
  leaked.commit_receipt!.status = "COMMITTED";
  leaked.commit_receipt!.outcome = "COMMITTED_AND_VERIFIED";
  leaked.commit_receipt!.reconciliation = { status: "OK" };
  leaked.commit_receipt!.committedEffect.immediate!.net = 1;
  leaked.commit_receipt_recorded!.committedEffect.immediate!.net = 2;
  leaked.commit_receipt_identity_digest = "forged";

  const fresh = store.get("q1")!;
  assert.equal(fresh.commit_receipt?.status, "COMMITTED_UNVERIFIED", "current view survives caller mutation of a get() result");
  assert.equal(fresh.commit_receipt?.reconciliation.status, "UNVERIFIED");
  assert.equal(fresh.commit_receipt?.committedEffect.immediate?.net, 1000);
  assert.equal(fresh.commit_receipt_recorded?.committedEffect.immediate?.net, 1000);
  assert.equal(fresh.commit_receipt_identity_digest, digestBefore);
  assert.equal(checkIdempotentReplay(store, "q1")?.reconciliation.status, "UNVERIFIED");
});

test("Test 16.5 (R2): mutating a StoredQuote returned by store.all() cannot rewrite the stored receipt either", () => {
  const store = new QuoteStore();
  store.put(makeQuote("q1"));
  store.recordCommitReceipt("q1", makeUnverifiedReceipt());

  const leaked = store.all().find((q) => q.quote_id === "q1")!;
  leaked.commit_receipt!.reconciliation = { status: "OK" };
  leaked.commit_receipt!.committedEffect.immediate!.net = 3;

  const fresh = store.get("q1")!;
  assert.equal(fresh.commit_receipt?.reconciliation.status, "UNVERIFIED");
  assert.equal(fresh.commit_receipt?.committedEffect.immediate?.net, 1000);
});

test("Test 16.6 (R2 control): the verified receipt returned by receiptsWithReconciliation is a copy — mutating it changes nothing stored", () => {
  const store = verifiedStoreViaRestore();
  const listed = store.receiptsWithReconciliation("OK");
  assert.equal(listed.length, 1);
  listed[0].reconciliation = { status: "UNVERIFIED", reason: "caller forgery attempt", undeterminedDimensions: [] };
  listed[0].committedEffect.immediate!.net = 4;
  const fresh = store.get("q1")!;
  assert.equal(fresh.commit_receipt?.reconciliation.status, "OK");
  assert.equal(fresh.commit_receipt?.committedEffect.immediate?.net, 1000);
});

// ---------------------------------------------------------------------------
// R3 (negative) — self-asserted evidence cannot promote a record
// ---------------------------------------------------------------------------

test("Test 16.7 (R3): the old 15.4 construction — evidence built FROM the stored receipt, labeled provider_actual, state VERIFIED — is refused as self-asserted", () => {
  const store = new QuoteStore();
  store.put(makeQuote("q1"));
  const receipt = makeUnverifiedReceipt();
  store.recordCommitReceipt("q1", receipt);
  // Exactly the pre-fix test-15.4 evidence: the receipt's own
  // committed figures, relabeled, with an asserted VERIFIED state.
  // It passed before this correction because the API accepted any
  // caller-constructed object. Nothing in it establishes an
  // independent provider observation, so it must now be refused.
  const selfAsserted = {
    committedEffect: {
      ...JSON.parse(JSON.stringify(receipt.committedEffect)),
      provenance: { committedSource: "provider_actual" },
    },
    committedSource: "provider_actual",
    stateVerification: "VERIFIED",
    reconciliation: { status: "OK" },
  };
  assert.throws(() => store.verifyCommitReceipt("q1", selfAsserted as never), /establish|self-asserted|observation/i);
  const q = store.get("q1")!;
  assert.equal(q.commit_receipt?.outcome, "COMMITTED_UNVERIFIED");
  assert.equal(q.commit_receipt?.reconciliation.status, "UNVERIFIED");
  assert.equal(q.commit_receipt_verifications?.length ?? 0, 0);
});

// ---------------------------------------------------------------------------
// R3 (trusted path) — evidence minted by establishVerification from
// an independent ProviderObservation. (Against the pre-fix head
// these tests fail to compile — the establishment API did not
// exist — which is the failing-first signal for the missing
// trusted path; the runtime failing-first evidence for R3 is
// Test 16.7 above.)
// ---------------------------------------------------------------------------

/**
 * The standard INDEPENDENT observation: figures and snapshot are
 * literals describing the simulated provider-side state after the
 * commit (item_1 at quantity 2 — the proposal's intent — with
 * provider-actual figures 1000/5000). Nothing here is read from,
 * or copied out of, the stored receipt.
 */
function standardObservation(overrides: Partial<ProviderObservation> = {}): ProviderObservation {
  return {
    subscriptionRef: "sub_1",
    source: "test fixture: simulated post-commit provider read",
    observedAt: "2026-10-28T00:06:00.000Z",
    committedEffect: {
      immediate: { net: 1000 },
      recurring: { resultingAmount: 5000, currency: "usd" },
      provenance: { committedSource: "provider_actual" },
    },
    resultingSnapshot: {
      id: "sub_1",
      version: "v2",
      status: "active",
      items: [{ id: "item_1", offeringRef: "plan", quantity: 2 }],
      billing: { currency: "usd" },
    },
    ...overrides,
  };
}

test("Test 16.11 (R3): the trusted path end-to-end — establishVerification computes state + reconciliation from the observation, and the minted token verifies exactly once", () => {
  const store = new QuoteStore();
  store.put(makeQuote("q1"));
  store.recordCommitReceipt("q1", makeUnverifiedReceipt());
  const digestBefore = store.get("q1")!.commit_receipt_identity_digest;

  const token = establishVerification(store.get("q1")!, standardObservation());
  assert.equal(token.stateVerification, "VERIFIED", "state is computed from the observed snapshot vs the intent, not asserted");
  assert.equal(token.reconciliation.status, "OK", "reconciliation is computed from the quote, the observed figures, and the envelope");

  const verified = store.verifyCommitReceipt("q1", token);
  assert.equal(verified.outcome, "COMMITTED_AND_VERIFIED");
  assert.equal(verified.reconciliation.status, "OK");
  const q = store.get("q1")!;
  assert.equal(q.commit_receipt_identity_digest, digestBefore, "the identity digest is stable across the transition");
  assert.equal(q.commit_receipt_verifications?.length, 1);

  const second = establishVerification(store.get("q1")!, standardObservation());
  assert.throws(() => store.verifyCommitReceipt("q1", second), /only a COMMITTED_UNVERIFIED|only once/);
});

test("Test 16.12 (R3): establishment refuses estimate-lineage observations — revalidated preview, pre-mutation estimate, unestablished, and the quote's own figures", () => {
  const store = new QuoteStore();
  store.put(makeQuote("q1"));
  const quote = store.get("q1")!;

  for (const source of ["revalidated_preview", "pre_mutation_estimate"] as const) {
    const observation = standardObservation({
      committedEffect: {
        immediate: { net: 1000 },
        recurring: { resultingAmount: 5000, currency: "usd" },
        provenance: { committedSource: source },
      },
    });
    assert.throws(() => establishVerification(quote, observation), /Establishment refused/, source);
  }
  // No committedSource at all: the figures are simply unestablished.
  const unestablished = standardObservation({
    committedEffect: { immediate: { net: 1000 }, recurring: { resultingAmount: 5000, currency: "usd" } },
  });
  assert.throws(() => establishVerification(quote, unestablished), /Establishment refused/);
  // The quote's OWN effect object, presented as the observation:
  // estimate lineage by identity, whatever label it might carry.
  const selfObservation = standardObservation({ committedEffect: quote.quoted_effect });
  assert.throws(() => establishVerification(quote, selfObservation), /Establishment refused/);
});

test("Test 16.13 (R3): establishment refuses an observation of a different subscription", () => {
  const store = new QuoteStore();
  store.put(makeQuote("q1"));
  assert.throws(
    () => establishVerification(store.get("q1")!, standardObservation({ subscriptionRef: "sub_2" })),
    /Establishment refused/
  );
});

test("Test 16.14 (R3): the state result is computed — a mismatching snapshot mints a MISMATCH token the transition refuses, a snapshot-less observation mints UNVERIFIABLE, and a tampered token fails content re-validation", () => {
  const store = new QuoteStore();
  store.put(makeQuote("q1"));
  store.recordCommitReceipt("q1", makeUnverifiedReceipt());
  const quote = store.get("q1")!;

  const mismatch = establishVerification(
    quote,
    standardObservation({
      resultingSnapshot: {
        id: "sub_1",
        version: "v2",
        status: "active",
        items: [{ id: "item_1", offeringRef: "plan", quantity: 99 }],
        billing: { currency: "usd" },
      },
    })
  );
  assert.equal(mismatch.stateVerification, "MISMATCH");
  assert.throws(() => store.verifyCommitReceipt("q1", mismatch), /state/i);

  const unverifiable = establishVerification(quote, standardObservation({ resultingSnapshot: undefined }));
  assert.equal(unverifiable.stateVerification, "UNVERIFIABLE");
  assert.throws(() => store.verifyCommitReceipt("q1", unverifiable), /state/i);

  const tampered = establishVerification(quote, standardObservation());
  tampered.committedEffect.immediate!.net = 2000;
  assert.throws(() => store.verifyCommitReceipt("q1", tampered), /contradict the figures recorded/);

  const q = store.get("q1")!;
  assert.equal(q.commit_receipt?.outcome, "COMMITTED_UNVERIFIED", "no refused attempt transitioned the record");
  assert.equal(q.commit_receipt_verifications?.length ?? 0, 0);
});

test("Test 16.15 (R3): defined_equal_exact is also an establishing source — establishment is not restricted to provider_actual", () => {
  const store = new QuoteStore();
  store.put(makeQuote("q1"));
  store.recordCommitReceipt("q1", makeUnverifiedReceipt());
  const token = establishVerification(
    store.get("q1")!,
    standardObservation({
      committedEffect: {
        immediate: { net: 1000 },
        recurring: { resultingAmount: 5000, currency: "usd" },
        provenance: { committedSource: "defined_equal_exact" },
      },
    })
  );
  assert.equal(token.stateVerification, "VERIFIED");
  const verified = store.verifyCommitReceipt("q1", token);
  assert.equal(verified.outcome, "COMMITTED_AND_VERIFIED");
});

// ---------------------------------------------------------------------------
// R4 — auditDeterminacy: estimate-derived committed provenance establishes nothing
// ---------------------------------------------------------------------------

function committedEffectWithSource(source: string): CommercialEffect {
  return {
    immediate: { net: 1000 },
    recurring: { resultingAmount: 5000, currency: "usd" },
    determinacy: { immediateFinancialEffect: "DETERMINED", recurringFinancialEffect: "DETERMINED" },
    provenance: {
      immediate: "post-commit provider read total",
      recurring: "post-commit per-item stated amounts",
      committedSource: source as never,
    },
  };
}

test("Test 16.8 (R4): a committed effect sourced from revalidated_preview reports PROVENANCE_NOT_ESTABLISHING (not clean, not MISSING_PROVENANCE)", () => {
  const quoted: CommercialEffect = {
    immediate: { net: 1000 },
    recurring: { resultingAmount: 5000, currency: "usd" },
    determinacy: { immediateFinancialEffect: "DETERMINED", recurringFinancialEffect: "DETERMINED" },
    provenance: { immediate: "preview computation", recurring: "preview per-item amounts" },
  };
  const committed = committedEffectWithSource("revalidated_preview");
  const report = auditDeterminacy(quoted, committed, "CHANGE_QUANTITY");
  for (const entry of report) {
    assert.deepEqual(entry.findings, ["PROVENANCE_NOT_ESTABLISHING"], JSON.stringify(entry));
  }
});

test("Test 16.9 (R4): a committed effect sourced from pre_mutation_estimate likewise reports PROVENANCE_NOT_ESTABLISHING", () => {
  const quoted: CommercialEffect = {
    immediate: { net: 1000 },
    recurring: { resultingAmount: 5000, currency: "usd" },
    determinacy: { immediateFinancialEffect: "DETERMINED", recurringFinancialEffect: "DETERMINED" },
    provenance: { immediate: "preview computation", recurring: "preview per-item amounts" },
  };
  const committed = committedEffectWithSource("pre_mutation_estimate");
  const report = auditDeterminacy(quoted, committed, "CHANGE_QUANTITY");
  for (const entry of report) {
    assert.deepEqual(entry.findings, ["PROVENANCE_NOT_ESTABLISHING"], JSON.stringify(entry));
  }
});

test("Test 16.10 (R4 controls): provider_actual committed provenance is clean; a quote-side preview basis asserts no committedSource and is clean; UNKNOWN never double-reports", () => {
  const quoted: CommercialEffect = {
    immediate: { net: 1000 },
    recurring: { resultingAmount: 5000, currency: "usd" },
    determinacy: { immediateFinancialEffect: "DETERMINED", recurringFinancialEffect: "DETERMINED" },
    provenance: { immediate: "revalidated preview computation", recurring: "preview per-item amounts" },
  };
  // Quote side audited against itself: its figures are estimates
  // by nature and assert no committedSource — nothing to establish.
  const quoteReport = auditDeterminacy(quoted, quoted, "CHANGE_QUANTITY");
  assert.ok(quoteReport.every((e) => e.findings.length === 0), JSON.stringify(quoteReport));

  const committed = committedEffectWithSource("provider_actual");
  const committedReport = auditDeterminacy(quoted, committed, "CHANGE_QUANTITY");
  assert.ok(committedReport.every((e) => e.findings.length === 0), JSON.stringify(committedReport));

  const unknownCommitted: CommercialEffect = {
    determinacy: { immediateFinancialEffect: "UNKNOWN", recurringFinancialEffect: "UNKNOWN" },
    provenance: { committedSource: "revalidated_preview" },
  };
  const unknownReport = auditDeterminacy(quoted, unknownCommitted, "CHANGE_QUANTITY");
  for (const entry of unknownReport) {
    assert.deepEqual(entry.findings, ["WOULD_REFUSE_UNKNOWN"], "no provenance finding is stacked on an UNKNOWN dimension");
  }
});

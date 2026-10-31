import { test } from "node:test";
import assert from "node:assert/strict";
import { auditDeterminacy } from "../src/core/scq-engine.js";
import {
  SCQError,
  type CommercialEffect,
  type ProviderObservation,
  type SubscriptionChangeReceipt,
  type VerificationEvidence,
} from "../src/core/types.js";
import {
  QuoteStore,
  establishVerification,
  receiptIdentityDigest,
  type StoredQuote,
} from "../src/store/quote-store.js";

// SCQ v0.6.2 — PR #8 review corrections (C1–C4). These tests were
// written against the PR-1 head (a94f19d) FIRST and run failing
// before the corrections were implemented:
//
//   C1 — verifyCommitReceipt must not promote COMMITTED_UNVERIFIED
//        on a caller-supplied verdict alone; the transition requires
//        independently established VerificationEvidence, validated
//        against the stored record.
//   C2 — restoreReceiptRecords validates each record as a coherent
//        unit (current view + recorded snapshot + verification
//        trail + quote association + legal transitions only).
//   C3 — receipt↔quote binding validation; stored receipt data is
//        protected from caller mutation; original-payload replay
//        stays idempotent across a later verification.
//   C4 — auditDeterminacy reports MISSING_PROVENANCE for DETERMINED
//        dimensions with no supporting provenance (a finite number
//        alone is not verification).
//
// ROUND 2 addendum (R1/R3 — see test16 for the dedicated
// regressions): the C1 success-path tests below no longer construct
// evidence objects by hand. Round 1's makeEvidence built the
// evidence FROM the stored receipt's own figures and asserted the
// state and reconciliation — exactly the self-assertion R3 closes.
// Evidence is now minted by establishVerification from INDEPENDENT
// observation fixtures (literal provider-side state), and the
// procedure computes the state verification and reconciliation.
// Test 15.15's central assertion is FLIPPED: round 1 asserted that
// a post-verification replay returns the current verified record;
// §6.10 requires the ORIGINAL recorded receipt (R1), and 15.15 now
// asserts that.

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function makeQuote(
  quoteId: string,
  subscriptionId = "sub_1",
  proposalOverrides: Record<string, unknown> = {}
): StoredQuote {
  return {
    quote_id: quoteId,
    provider: "stripe",
    subscription_id: subscriptionId,
    subscription_version_at_quote: "v1",
    proposal: {
      changes: [{ action: "CHANGE_QUANTITY", itemId: "item_1", quantity: 2 }],
      effectiveIntent: { type: "IMMEDIATE" },
      ...proposalOverrides,
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
    // PR-10 (BC-1) fixture completion: makeQuote models a CURRENT
    // (v0.6.2) quote — the shape every migrated adapter emits, with
    // determinacy and basis provenance on both dimensions. Only
    // Test 15.5 states an acceptance envelope (where BC-1 compares
    // the quoted side); the remaining tests are envelope-less, so
    // this shape is inert there beyond round-tripping through the
    // same fixture. Legacy-shaped quotes are covered by test35.
    quoted_effect: {
      immediate: { net: 1000 },
      recurring: { resultingAmount: 5000, currency: "usd" },
      determinacy: { immediateFinancialEffect: "DETERMINED", recurringFinancialEffect: "DETERMINED" },
      provenance: {
        immediate: "test fixture: quote-time preview figure",
        recurring: "test fixture: quote-time preview figure",
      },
    },
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
    // PR-10 (BC-1) fixture completion: a receipt's quotedEffect IS
    // the stored quote's effect — the same current-shape effect
    // makeQuote builds (determinacy + basis provenance). Only Test
    // 15.5's envelope recompute reads the quoted side; elsewhere the
    // shape round-trips through the same fixture. A legacy recorded
    // receipt is never re-reconciled to OK under BC-1 — that
    // behavior is pinned in test35, not by these store fixtures.
    quotedEffect: {
      immediate: { net: 1000 },
      recurring: { resultingAmount: 5000, currency: "usd" },
      determinacy: { immediateFinancialEffect: "DETERMINED", recurringFinancialEffect: "DETERMINED" },
      provenance: {
        immediate: "test fixture: quote-time preview figure",
        recurring: "test fixture: quote-time preview figure",
      },
    },
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
 * An INDEPENDENT post-commit observation for the standard
 * fixtures: literal provider-side state (item_1 at quantity 2 —
 * the proposal's intent — provider-actual figures), NOT derived
 * from any receipt object. Round 2 (R3): evidence exists only as
 * minted from such an observation by `establishVerification`,
 * which computes the state verification and the reconciliation.
 */
function observationFor(
  figures: { immediate: number; recurring: number },
  overrides: Partial<ProviderObservation> = {}
): ProviderObservation {
  return {
    subscriptionRef: "sub_1",
    source: "test fixture: simulated post-commit provider read",
    observedAt: "2026-10-28T00:06:00.000Z",
    committedEffect: {
      immediate: { net: figures.immediate },
      recurring: { resultingAmount: figures.recurring, currency: "usd" },
      // PR-10 (BC-1) fixture completion: this observation IS an
      // independent provider read whose two figures are the read's
      // literal values (see the doc comment above) — the read
      // determines both dimensions, so the determinacy record says
      // so. BC-1 reconciliation otherwise (correctly) computes
      // UNVERIFIED for a determinacy-less effect, and these tests'
      // subject is store verification semantics, not legacy effects.
      determinacy: { immediateFinancialEffect: "DETERMINED", recurringFinancialEffect: "DETERMINED" },
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

/** Mints established evidence for q1 from an independent observation. */
function mintEvidence(
  store: QuoteStore,
  figures: { immediate: number; recurring: number } = { immediate: 1000, recurring: 5000 },
  overrides: Partial<ProviderObservation> = {}
): VerificationEvidence {
  return establishVerification(store.get("q1")!, observationFor(figures, overrides));
}

const isConflict = (e: unknown): boolean => e instanceof SCQError && e.code === "CONFLICTING_RECEIPT_IDENTITY";

// ---------------------------------------------------------------------------
// C1 — verification requires evidence, not a verdict
// ---------------------------------------------------------------------------

test("Test 15.1 (C1): a bare caller-supplied verdict cannot promote COMMITTED_UNVERIFIED", () => {
  const store = new QuoteStore();
  store.put(makeQuote("q1"));
  store.recordCommitReceipt("q1", makeUnverifiedReceipt());
  // The pre-correction API accepted exactly this call and promoted
  // the record. It must now be refused: a verdict is an assertion,
  // not evidence.
  assert.throws(
    () => store.verifyCommitReceipt("q1", { status: "OK" } as never),
    /evidence/i
  );
  const q = store.get("q1")!;
  assert.equal(q.commit_receipt?.outcome, "COMMITTED_UNVERIFIED");
  assert.equal(q.commit_receipt?.reconciliation.status, "UNVERIFIED");
  assert.equal(q.commit_receipt_verifications?.length ?? 0, 0);
});

test("Test 15.2 (C1, round 2 R3): estimate-derived or unestablished figures cannot establish evidence — and hand-built evidence objects are refused as self-asserted", () => {
  for (const source of ["pre_mutation_estimate", "revalidated_preview", "unestablished"]) {
    const store = new QuoteStore();
    store.put(makeQuote("q1"));
    const receipt = makeUnverifiedReceipt();
    store.recordCommitReceipt("q1", receipt);
    // The observation route: establishment itself refuses the
    // lineage — such figures never become evidence at all.
    const observation = observationFor(
      { immediate: 1000, recurring: 5000 },
      {
        committedEffect: {
          immediate: { net: 1000 },
          recurring: { resultingAmount: 5000, currency: "usd" },
          provenance: { committedSource: source as never },
        },
      }
    );
    assert.throws(() => establishVerification(store.get("q1")!, observation), /Establishment refused/, `committedSource=${source} must not establish`);
    // The direct route (round 1's shape): a hand-built object
    // asserting the source is self-asserted and refused unbranded.
    assert.throws(
      () =>
        store.verifyCommitReceipt(
          "q1",
          {
            committedEffect: {
              ...JSON.parse(JSON.stringify(receipt.committedEffect)),
              provenance: { committedSource: source },
            },
            committedSource: source,
            stateVerification: "VERIFIED",
            reconciliation: { status: "OK" },
          } as never
        ),
      /established|self-asserted/i,
      `committedSource=${source} must be refused`
    );
    assert.equal(store.get("q1")!.commit_receipt?.outcome, "COMMITTED_UNVERIFIED");
  }
});

test("Test 15.3 (C1, CORRECTED PR-17 / Finding 5b): established evidence whose figures differ from the recorded candidates is recordable and displayed — the identity never moves", () => {
  // PR-17 CORRECTION, disclosed: as originally written this test
  // asserted that evidence establishing figures (2000) different
  // from the recorded candidates (1000) is REFUSED with
  // CONFLICTING_RECEIPT_IDENTITY. That assertion pinned Finding
  // 5b itself: candidate equality is not identity preservation —
  // a recorded candidate is an unverified figure, and later
  // independently established actuals legitimately differ from
  // it. The test's SAFETY PURPOSE is preserved in the form the
  // F5 model gives it: (i) the recorded receipt, its candidates,
  // and its identity digest are NEVER rewritten by later
  // evidence; (ii) the derived view displays the ESTABLISHED
  // actual (2000) with its establishing provenance — it does not
  // keep presenting the candidate as the committed figure;
  // (iii) drift judgment runs against the recorded QUOTE under
  // the envelope contract — this fixture carries no envelope, so
  // there is no tolerance to violate and established actuals
  // reconcile OK (the with-envelope judgment of exactly this
  // shape is 15.5's verified-with-violation). Genuine identity
  // conflicts (a different receipt, quote, or subscription)
  // remain CONFLICTING_RECEIPT_IDENTITY — see 15.12/15.13 and
  // PR-17's test50 binding cases.
  const store = new QuoteStore();
  store.put(makeQuote("q1"));
  const receipt = makeUnverifiedReceipt();
  store.recordCommitReceipt("q1", receipt);
  const digestBefore = store.get("q1")!.commit_receipt_identity_digest;
  const contradicting = mintEvidence(store, { immediate: 2000, recurring: 5000 });
  const view = store.verifyCommitReceipt("q1", contradicting);
  assert.equal(view.outcome, "COMMITTED_AND_VERIFIED", "the actuals ARE established — verified means measured");
  assert.equal(view.committedEffect.immediate?.net, 2000, "the derived view displays the established actual, not the candidate");
  assert.equal(view.committedEffect.determinacy?.immediateFinancialEffect, "DETERMINED");
  const q = store.get("q1")!;
  assert.equal(q.commit_receipt_identity_digest, digestBefore, "the recorded identity never moves");
  assert.equal(q.commit_receipt_recorded?.committedEffect.immediate?.net, 1000, "the recorded candidate is preserved verbatim");
});

test("Test 15.4 (C1, round 2 R3): evidence established from an independent observation transitions exactly once; the recorded identity never moves", () => {
  const store = new QuoteStore();
  store.put(makeQuote("q1"));
  const receipt = makeUnverifiedReceipt();
  store.recordCommitReceipt("q1", receipt);
  const digestBefore = store.get("q1")!.commit_receipt_identity_digest;

  const verified = store.verifyCommitReceipt("q1", mintEvidence(store), makeUnverifiedReceipt());
  assert.equal(verified.status, "COMMITTED");
  assert.equal(verified.outcome, "COMMITTED_AND_VERIFIED");
  assert.equal(verified.reconciliation.status, "OK");

  const q = store.get("q1")!;
  assert.equal(q.commit_receipt_identity_digest, digestBefore);
  assert.equal(q.commit_receipt_recorded?.status, "COMMITTED_UNVERIFIED", "recorded original preserved");
  assert.equal(q.commit_receipt_verifications?.length, 1);
  assert.throws(() => store.verifyCommitReceipt("q1", mintEvidence(store)), /only.*COMMITTED_UNVERIFIED|exactly once|already/i);
  assert.equal(store.get("q1")!.commit_receipt_verifications?.length, 1);
});

test("Test 15.5 (C1): an observation whose computed reconciliation is VIOLATED transitions to verified-with-violation — never to OK", () => {
  const store = new QuoteStore();
  // Zero-tolerance envelope: the observed actuals (1500) honestly
  // exceed the quote (1000) — establishment COMPUTES the violated
  // reconciliation from the observation, and that established fact
  // is what transitions the record.
  store.put(makeQuote("q1", "sub_1", { acceptanceEnvelope: {} }));
  const receipt = makeUnverifiedReceipt({
    committedEffect: { immediate: { net: 1500 }, recurring: { resultingAmount: 5000, currency: "usd" } },
  });
  store.recordCommitReceipt("q1", receipt);
  const evidence = mintEvidence(store, { immediate: 1500, recurring: 5000 });
  assert.equal(evidence.reconciliation.status, "VIOLATED", "the violation is computed at establishment, not asserted");
  const verified = store.verifyCommitReceipt("q1", evidence);
  assert.equal(verified.reconciliation.status, "VIOLATED", "verified-with-violation, distinguishable from OK");
  assert.equal(verified.outcome, "COMMITTED_AND_VERIFIED", "the figures ARE established — verified means measured, not within-envelope");
  assert.equal(verified.status, "COMMITTED");
});

test("Test 15.6 (C1, round 2 R3): evidence whose computed state verification is not VERIFIED is refused (MISMATCH / UNVERIFIABLE)", () => {
  const cases: Array<{ state: string; overrides: Partial<ProviderObservation> }> = [
    {
      state: "MISMATCH",
      overrides: {
        resultingSnapshot: {
          id: "sub_1",
          version: "v2",
          status: "active",
          items: [{ id: "item_1", offeringRef: "plan", quantity: 99 }],
          billing: { currency: "usd" },
        },
      },
    },
    { state: "UNVERIFIABLE", overrides: { resultingSnapshot: undefined } },
  ];
  for (const { state, overrides } of cases) {
    const store = new QuoteStore();
    store.put(makeQuote("q1"));
    const receipt = makeUnverifiedReceipt();
    store.recordCommitReceipt("q1", receipt);
    const evidence = mintEvidence(store, { immediate: 1000, recurring: 5000 }, overrides);
    assert.equal(evidence.stateVerification, state, "the state result is computed from the observation");
    assert.throws(() => store.verifyCommitReceipt("q1", evidence), /state/i);
    assert.equal(store.get("q1")!.commit_receipt?.outcome, "COMMITTED_UNVERIFIED");
  }
});

test("Test 15.7 (C1, round 2 R3): an established token whose reconciliation is altered after minting contradicts the store's recomputation and is refused", () => {
  const store = new QuoteStore();
  store.put(makeQuote("q1"));
  const receipt = makeUnverifiedReceipt();
  store.recordCommitReceipt("q1", receipt);
  // Mint a genuine token (its computed reconciliation is OK),
  // then alter the caller-held token to claim VIOLATED. The brand
  // proves issuance, not content integrity — the store's
  // recomputation at the transition refuses the altered content.
  const inconsistent = mintEvidence(store);
  inconsistent.reconciliation = { status: "VIOLATED", reason: "caller assertion" };
  assert.throws(() => store.verifyCommitReceipt("q1", inconsistent), /inconsistent|recomput/i);
  assert.equal(store.get("q1")!.commit_receipt?.outcome, "COMMITTED_UNVERIFIED");
});

// ---------------------------------------------------------------------------
// C2 — restore validates the record as a coherent unit
// ---------------------------------------------------------------------------

function verifiedStore(): { store: QuoteStore; persisted: string } {
  const store = new QuoteStore();
  store.put(makeQuote("q1"));
  const receipt = makeUnverifiedReceipt();
  store.recordCommitReceipt("q1", receipt);
  store.verifyCommitReceipt("q1", mintEvidence(store));
  return { store, persisted: store.serializeReceiptRecords() };
}

test("Test 15.8 (C2 control): a legitimately verified record restores cleanly and keeps its trail", () => {
  const { persisted } = verifiedStore();
  const restored = new QuoteStore();
  restored.put(makeQuote("q1"));
  restored.restoreReceiptRecords(persisted);
  const q = restored.get("q1")!;
  assert.equal(q.commit_receipt?.outcome, "COMMITTED_AND_VERIFIED");
  assert.equal(q.commit_receipt?.reconciliation.status, "OK");
  assert.equal(q.commit_receipt_verifications?.length, 1);
});

test("Test 15.9 (C2): a forged verified current view (recorded UNVERIFIED, trail empty) refuses the whole restore", () => {
  const store = new QuoteStore();
  store.put(makeQuote("q1"));
  store.recordCommitReceipt("q1", makeUnverifiedReceipt());
  const data = JSON.parse(store.serializeReceiptRecords());
  // Forge ONLY the current view: claim verified/OK. The recorded
  // snapshot still says UNVERIFIED and there is no trail entry —
  // under digest-only validation this was adopted.
  data.records[0].current_receipt = {
    ...data.records[0].recorded_receipt,
    status: "COMMITTED",
    outcome: "COMMITTED_AND_VERIFIED",
    reconciliation: { status: "OK" },
  };
  const restored = new QuoteStore();
  restored.put(makeQuote("q1"));
  assert.throws(() => restored.restoreReceiptRecords(JSON.stringify(data)), /coheren|forg|trail|transition/i);
  assert.equal(restored.get("q1")!.commit_receipt, undefined, "nothing is adopted from an incoherent set");
});

test("Test 15.10 (C2): contradictory verification history — two trail entries for a one-transition record — refuses restore", () => {
  const { persisted } = verifiedStore();
  const data = JSON.parse(persisted);
  data.records[0].verifications.push({ ...data.records[0].verifications[0] });
  const restored = new QuoteStore();
  restored.put(makeQuote("q1"));
  assert.throws(() => restored.restoreReceiptRecords(JSON.stringify(data)), /coheren|trail|transition/i);
  assert.equal(restored.get("q1")!.commit_receipt, undefined);
});

test("Test 15.11 (C2): a trail entry bound to a different identity refuses restore", () => {
  const { persisted } = verifiedStore();
  const data = JSON.parse(persisted);
  data.records[0].verifications[0].identityDigest = "{\"receiptId\":\"forged\"}";
  const restored = new QuoteStore();
  restored.put(makeQuote("q1"));
  assert.throws(() => restored.restoreReceiptRecords(JSON.stringify(data)), /coheren|identity|trail/i);
  assert.equal(restored.get("q1")!.commit_receipt, undefined);
});

test("Test 15.12 (C2/C3): a recorded receipt whose quoteId names a different quote than its record refuses restore (association)", () => {
  const store = new QuoteStore();
  store.put(makeQuote("q1"));
  store.recordCommitReceipt("q1", makeUnverifiedReceipt());
  const data = JSON.parse(store.serializeReceiptRecords());
  // Rebind the recorded receipt to another quote AND repair the
  // digest, so only association validation can catch it.
  data.records[0].recorded_receipt.quoteId = "q2";
  data.records[0].current_receipt.quoteId = "q2";
  data.records[0].identity_digest = receiptIdentityDigest(data.records[0].recorded_receipt);
  const restored = new QuoteStore();
  restored.put(makeQuote("q1"));
  restored.put(makeQuote("q2", "sub_2"));
  assert.throws(() => restored.restoreReceiptRecords(JSON.stringify(data)), /association|quote/i);
  assert.equal(restored.get("q1")!.commit_receipt, undefined);
  assert.equal(restored.get("q2")!.commit_receipt, undefined);
});

// ---------------------------------------------------------------------------
// C3 — binding, mutation protection, replay across verification
// ---------------------------------------------------------------------------

test("Test 15.13 (C3): recordCommitReceipt refuses a receipt bound to a different quote or subscription", () => {
  const store = new QuoteStore();
  store.put(makeQuote("q1"));
  assert.throws(() => store.recordCommitReceipt("q1", makeReceipt({ quoteId: "qOTHER" })), /quote|subscription|binding/i);
  assert.throws(() => store.recordCommitReceipt("q1", makeReceipt({ subscriptionRef: "sub_WRONG" })), /quote|subscription|binding/i);
  assert.equal(store.get("q1")!.commit_receipt, undefined, "a mis-bound receipt is not recorded");
});

test("Test 15.14 (C3): stored receipt data is protected from caller mutation — ingress object and returned object alike", () => {
  const store = new QuoteStore();
  store.put(makeQuote("q1"));
  const receipt = makeUnverifiedReceipt();
  const returned = store.recordCommitReceipt("q1", receipt)!;
  const digestBefore = store.get("q1")!.commit_receipt_identity_digest;

  // Mutate the caller's original object.
  receipt.committedEffect.immediate!.net = 777;
  receipt.status = "COMMITTED";
  // Mutate the object the store returned.
  returned.committedEffect.immediate!.net = 888;
  returned.reconciliation = { status: "OK" };

  const q = store.get("q1")!;
  assert.equal(q.commit_receipt?.committedEffect.immediate?.net, 1000, "stored current view is insulated from caller mutation");
  assert.equal(q.commit_receipt?.status, "COMMITTED_UNVERIFIED");
  assert.equal(q.commit_receipt?.reconciliation.status, "UNVERIFIED");
  assert.equal(q.commit_receipt_recorded?.committedEffect.immediate?.net, 1000);
  assert.equal(q.commit_receipt_identity_digest, digestBefore);
  // And replay still recognizes the original payload.
  assert.equal(store.recordCommitReceipt("q1", makeUnverifiedReceipt())?.committedEffect.immediate?.net, 1000);
});

test("Test 15.15 (C3, CORRECTED round 2 R1): original-payload replay AFTER verification returns the ORIGINAL recorded receipt (§6.10) — not a conflict, not a duplicate; the verified state is the separate current-view read", () => {
  // ROUND-2 CORRECTION, flagged per the review: this test
  // previously asserted that replay returns the CURRENT VERIFIED
  // record. That assertion encoded the R1 defect — §6.10 requires
  // a repeated commit to return the ORIGINAL receipt. The test now
  // asserts the original; the current view is checked separately.
  const store = new QuoteStore();
  store.put(makeQuote("q1"));
  const receipt = makeUnverifiedReceipt();
  store.recordCommitReceipt("q1", receipt);
  store.verifyCommitReceipt("q1", mintEvidence(store));

  const replayed = store.recordCommitReceipt("q1", makeUnverifiedReceipt());
  assert.equal(replayed?.status, "COMMITTED_UNVERIFIED", "replay returns the receipt as originally recorded");
  assert.equal(replayed?.outcome, "COMMITTED_UNVERIFIED");
  assert.equal(replayed?.reconciliation.status, "UNVERIFIED");
  assert.deepEqual(replayed, store.get("q1")!.commit_receipt_recorded);
  const current = store.get("q1")!.commit_receipt;
  assert.equal(current?.outcome, "COMMITTED_AND_VERIFIED", "the verified state is exposed through the current-view read");
  assert.equal(current?.reconciliation.status, "OK");
  assert.equal(store.get("q1")!.commit_receipt_verifications?.length, 1, "replay does not create a second record or transition");
});

// ---------------------------------------------------------------------------
// C4 — auditDeterminacy: a finite number alone is not verification
// ---------------------------------------------------------------------------

test("Test 15.16 (C4): DETERMINED + finite + NO provenance reports exactly MISSING_PROVENANCE", () => {
  const effect: CommercialEffect = {
    immediate: { net: 1000 },
    recurring: { resultingAmount: 5000, currency: "usd" },
    determinacy: { immediateFinancialEffect: "DETERMINED", recurringFinancialEffect: "DETERMINED" },
  };
  const report = auditDeterminacy(effect, effect, "CHANGE_QUANTITY");
  assert.deepEqual(report.find((e) => e.dimension === "immediateFinancialEffect")?.findings, ["MISSING_PROVENANCE"]);
  assert.deepEqual(report.find((e) => e.dimension === "recurringFinancialEffect")?.findings, ["MISSING_PROVENANCE"]);
});

test("Test 15.17 (C4): committedSource 'unestablished' is not provenance; 'provider_actual' is (control)", () => {
  const base: CommercialEffect = {
    immediate: { net: 1000 },
    recurring: { resultingAmount: 5000, currency: "usd" },
    determinacy: { immediateFinancialEffect: "DETERMINED", recurringFinancialEffect: "DETERMINED" },
  };
  const unestablished: CommercialEffect = { ...base, provenance: { committedSource: "unestablished" } };
  const r1 = auditDeterminacy(unestablished, unestablished, "CHANGE_QUANTITY");
  assert.ok(r1.every((e) => e.findings.includes("MISSING_PROVENANCE")), JSON.stringify(r1));

  const actual: CommercialEffect = { ...base, provenance: { committedSource: "provider_actual" } };
  const r2 = auditDeterminacy(actual, actual, "CHANGE_QUANTITY");
  assert.ok(r2.every((e) => e.findings.length === 0), JSON.stringify(r2));
});

test("Test 15.18 (C4): UNKNOWN dimensions never double-report provenance — legacy payloads report only WOULD_REFUSE_UNKNOWN", () => {
  const legacy: CommercialEffect = { immediate: { net: 100 }, recurring: { resultingAmount: 500, currency: "usd" } };
  const report = auditDeterminacy(legacy, legacy, "CHANGE_QUANTITY");
  for (const entry of report) assert.deepEqual(entry.findings, ["WOULD_REFUSE_UNKNOWN"]);
});

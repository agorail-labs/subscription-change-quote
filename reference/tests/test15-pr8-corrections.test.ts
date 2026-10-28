import { test } from "node:test";
import assert from "node:assert/strict";
import { auditDeterminacy } from "../src/core/scq-engine.js";
import {
  SCQError,
  type CommercialEffect,
  type SubscriptionChangeReceipt,
} from "../src/core/types.js";
import {
  QuoteStore,
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
 * Well-formed C1 evidence for the standard unverified receipt:
 * the committed figures are the receipt's recorded actuals,
 * independently sourced, state verified, reconciliation honestly
 * computed (quoted 1000/5000 vs committed 1000/5000 → OK).
 */
function makeEvidence(receipt: SubscriptionChangeReceipt, overrides: Record<string, unknown> = {}): unknown {
  return {
    committedEffect: {
      ...JSON.parse(JSON.stringify(receipt.committedEffect)),
      provenance: { committedSource: "provider_actual" },
    },
    committedSource: "provider_actual",
    stateVerification: "VERIFIED",
    reconciliation: { status: "OK" },
    ...overrides,
  };
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

test("Test 15.2 (C1): evidence with estimate-derived or quote-shared provenance is refused", () => {
  for (const source of ["pre_mutation_estimate", "revalidated_preview", "unestablished"]) {
    const store = new QuoteStore();
    store.put(makeQuote("q1"));
    const receipt = makeUnverifiedReceipt();
    store.recordCommitReceipt("q1", receipt);
    assert.throws(
      () => store.verifyCommitReceipt("q1", makeEvidence(receipt, { committedSource: source }) as never),
      /provenance|source/i,
      `committedSource=${source} must be refused`
    );
    assert.equal(store.get("q1")!.commit_receipt?.outcome, "COMMITTED_UNVERIFIED");
  }
});

test("Test 15.3 (C1): evidence whose figures contradict the stored record is refused", () => {
  const store = new QuoteStore();
  store.put(makeQuote("q1"));
  const receipt = makeUnverifiedReceipt();
  store.recordCommitReceipt("q1", receipt);
  const contradicting = makeEvidence(receipt, {
    committedEffect: {
      immediate: { net: 2000 },
      recurring: { resultingAmount: 5000, currency: "usd" },
      provenance: { committedSource: "provider_actual" },
    },
  });
  assert.throws(() => store.verifyCommitReceipt("q1", contradicting as never), isConflict);
  assert.equal(store.get("q1")!.commit_receipt?.outcome, "COMMITTED_UNVERIFIED");
});

test("Test 15.4 (C1): well-formed independent evidence transitions exactly once; the recorded identity never moves", () => {
  const store = new QuoteStore();
  store.put(makeQuote("q1"));
  const receipt = makeUnverifiedReceipt();
  store.recordCommitReceipt("q1", receipt);
  const digestBefore = store.get("q1")!.commit_receipt_identity_digest;

  const verified = store.verifyCommitReceipt("q1", makeEvidence(receipt) as never, makeUnverifiedReceipt());
  assert.equal(verified.status, "COMMITTED");
  assert.equal(verified.outcome, "COMMITTED_AND_VERIFIED");
  assert.equal(verified.reconciliation.status, "OK");

  const q = store.get("q1")!;
  assert.equal(q.commit_receipt_identity_digest, digestBefore);
  assert.equal(q.commit_receipt_recorded?.status, "COMMITTED_UNVERIFIED", "recorded original preserved");
  assert.equal(q.commit_receipt_verifications?.length, 1);
  assert.throws(() => store.verifyCommitReceipt("q1", makeEvidence(receipt) as never), /only.*COMMITTED_UNVERIFIED|exactly once|already/i);
  assert.equal(store.get("q1")!.commit_receipt_verifications?.length, 1);
});

test("Test 15.5 (C1): VIOLATED-outcome evidence transitions to verified-with-violation — never to OK", () => {
  const store = new QuoteStore();
  // Zero-tolerance envelope: committed actuals (1500) honestly
  // exceed the quote (1000) — the reconciliation IS violated, and
  // that established fact is what the evidence carries.
  store.put(makeQuote("q1", "sub_1", { acceptanceEnvelope: {} }));
  const receipt = makeUnverifiedReceipt({
    committedEffect: { immediate: { net: 1500 }, recurring: { resultingAmount: 5000, currency: "usd" } },
  });
  store.recordCommitReceipt("q1", receipt);
  const evidence = makeEvidence(receipt, {
    reconciliation: { status: "VIOLATED", reason: "committed immediate exceeds the zero-tolerance envelope" },
  });
  const verified = store.verifyCommitReceipt("q1", evidence as never);
  assert.equal(verified.reconciliation.status, "VIOLATED", "verified-with-violation, distinguishable from OK");
  assert.equal(verified.outcome, "COMMITTED_AND_VERIFIED", "the figures ARE established — verified means measured, not within-envelope");
  assert.equal(verified.status, "COMMITTED");
});

test("Test 15.6 (C1): evidence without an established state verification is refused (MISMATCH / UNVERIFIABLE)", () => {
  for (const sv of ["MISMATCH", "UNVERIFIABLE"]) {
    const store = new QuoteStore();
    store.put(makeQuote("q1"));
    const receipt = makeUnverifiedReceipt();
    store.recordCommitReceipt("q1", receipt);
    assert.throws(
      () => store.verifyCommitReceipt("q1", makeEvidence(receipt, { stateVerification: sv }) as never),
      /state/i
    );
    assert.equal(store.get("q1")!.commit_receipt?.outcome, "COMMITTED_UNVERIFIED");
  }
});

test("Test 15.7 (C1): a caller's reconciliation that contradicts the store's recomputation from the evidence is refused", () => {
  const store = new QuoteStore();
  store.put(makeQuote("q1", "sub_1", { acceptanceEnvelope: {} }));
  const receipt = makeUnverifiedReceipt();
  store.recordCommitReceipt("q1", receipt);
  // Figures match the record and recompute to OK under the
  // envelope, but the caller claims VIOLATED — internally
  // inconsistent evidence must not transition anything.
  const inconsistent = makeEvidence(receipt, {
    reconciliation: { status: "VIOLATED", reason: "caller assertion" },
  });
  assert.throws(() => store.verifyCommitReceipt("q1", inconsistent as never), /inconsistent|recomput/i);
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
  store.verifyCommitReceipt("q1", makeEvidence(receipt) as never);
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

test("Test 15.15 (C3): original-payload replay AFTER verification returns the current verified record — not a conflict, not a duplicate", () => {
  const store = new QuoteStore();
  store.put(makeQuote("q1"));
  const receipt = makeUnverifiedReceipt();
  store.recordCommitReceipt("q1", receipt);
  store.verifyCommitReceipt("q1", makeEvidence(receipt) as never);

  const replayed = store.recordCommitReceipt("q1", makeUnverifiedReceipt());
  assert.equal(replayed?.outcome, "COMMITTED_AND_VERIFIED", "replay of the original identity returns the current (verified) record");
  assert.equal(replayed?.reconciliation.status, "OK");
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

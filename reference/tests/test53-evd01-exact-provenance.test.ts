import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SCQError,
  type AcceptanceEnvelope,
  type CommercialEffect,
  type CommittedFigureSource,
  type ProviderObservation,
  type SubscriptionChangeProposal,
  type SubscriptionChangeReceipt,
  type SubscriptionSnapshot,
  type VerificationEvidence,
} from "../src/core/types.js";
import { reconcileCommittedEffect } from "../src/core/scq-engine.js";
import { QuoteStore, establishVerification, type StoredQuote } from "../src/store/quote-store.js";

// SCQ v0.6.2 — Issue #29, Phase 2: V62-EVD-01 / G-01 (EXACT provenance)
// negative evidence. Written FAILING-FIRST against main 9bb424b.
//
// The maintainer RATIFIED the G-01 trust boundary: the core trusts
// adapter-established classification and does not independently
// authenticate provider events. These tests do NOT relitigate that
// decision, and V62-EVD-01 stays PARTIAL regardless of their results.
// What they probe is everything the establishment path can judge
// WITHOUT authentication:
//
//   Case 1 — FORGED LABELS. `defined_equal_exact` is not merely a
//   source classification; it is the claim "committed := quoted BY
//   PROTOCOL DEFINITION" (§3.11). The quote is in hand and trusted,
//   so a committed record whose own established figures DIFFER from
//   the quoted figures contradicts its label on its face — the same
//   record-internal logic PR-16 (P16-3) already applies to unit
//   statements under this label. The outcome on such a record must
//   never be an OK establishment on the forged basis.
//
//   Case 2 — UNSUPPORTED ESTABLISHING SOURCES. Only
//   "provider_actual" / "defined_equal_exact" establish (§3.11).
//   Estimate-derived, caller-asserted, and otherwise unlisted source
//   strings must establish nothing, at minting, in reconciliation,
//   and at the store's verification transition.
//
//   Case 3 — MISSING OPERATION BINDING. Genuine evidence minted for
//   one quote/operation must not establish for a different quote,
//   even on the same subscription; an observation of a different
//   subscription must not mint at all; self-asserted (unminted)
//   evidence and post-mint altered tokens must be refused.
//
// SIMULATED evidence only (mocked fixtures throughout); no live
// provider is involved and nothing here is live evidence.

// ---------------------------------------------------------------------------
// Engine-level fixtures (test35 conventions)
// ---------------------------------------------------------------------------

const GENEROUS: AcceptanceEnvelope = {
  maxImmediateNetIncrease: 1_000_000,
  maxImmediateCreditDecrease: 1_000_000,
  maxRecurringIncrease: 1_000_000,
};

const ZERO: AcceptanceEnvelope = {
  maxImmediateNetIncrease: 0,
  maxImmediateCreditDecrease: 0,
  maxRecurringIncrease: 0,
};

const QTY_PROPOSAL: SubscriptionChangeProposal = {
  changes: [{ action: "CHANGE_QUANTITY", itemId: "item_1", quantity: 2 }],
  effectiveIntent: { type: "IMMEDIATE" },
  guaranteeMode: "REVALIDATE",
};

function quotedEffect(net = 1000, resulting = 120000): CommercialEffect {
  return {
    immediate: { net },
    recurring: { resultingAmount: resulting, currency: "USD", cadence: "MONTHLY" },
    determinacy: { immediateFinancialEffect: "DETERMINED", recurringFinancialEffect: "DETERMINED" },
    provenance: { immediate: "test53: quote-time preview (fixture)", recurring: "test53: quote-time preview (fixture)" },
  };
}

function committedWith(source: string, net = 1000, resulting = 120000): CommercialEffect {
  return {
    immediate: { net },
    recurring: { resultingAmount: resulting, currency: "USD", cadence: "MONTHLY" },
    determinacy: { immediateFinancialEffect: "DETERMINED", recurringFinancialEffect: "DETERMINED" },
    provenance: {
      immediate: "test53: committed-figure basis (fixture)",
      recurring: "test53: committed-figure basis (fixture)",
      committedSource: source as CommittedFigureSource,
    },
  };
}

// ---------------------------------------------------------------------------
// Case 1 — forged defined_equal_exact labels (reconciliation path)
// ---------------------------------------------------------------------------

test("Test 53.1: forged defined_equal_exact over differing figures, zero-tolerance envelope — VIOLATED", () => {
  const result = reconcileCommittedEffect(quotedEffect(), committedWith("defined_equal_exact", 50000, 120000), ZERO, QTY_PROPOSAL);
  assert.equal(result.status, "VIOLATED");
});

test("Test 53.2: forged defined_equal_exact over differing figures within a GENEROUS envelope — VIOLATED (the label claims exact equality; caller tolerance governs actuals, not an identity claim)", () => {
  const result = reconcileCommittedEffect(quotedEffect(), committedWith("defined_equal_exact", 1500, 121000), GENEROUS, QTY_PROPOSAL);
  assert.equal(result.status, "VIOLATED", "a defined_equal_exact record whose figures differ from the quote must not reconcile OK inside envelope tolerance");
});

test("Test 53.3: forged defined_equal_exact over differing figures, NO envelope — VIOLATED (the label's equality claim is checkable without an envelope)", () => {
  const result = reconcileCommittedEffect(quotedEffect(), committedWith("defined_equal_exact", 1500, 121000), undefined, QTY_PROPOSAL);
  assert.equal(result.status, "VIOLATED", "the no-envelope path must not return OK for a record whose figures contradict its defined_equal_exact label");
});

test("Test 53.4: forged defined_equal_exact (recurring increase) behind a MALFORMED envelope bound — VIOLATED, not laundered to UNVERIFIED", () => {
  const malformed = { maxRecurringIncrease: "unbounded" } as unknown as AcceptanceEnvelope;
  const result = reconcileCommittedEffect(quotedEffect(), committedWith("defined_equal_exact", 1000, 150000), malformed, QTY_PROPOSAL);
  assert.equal(result.status, "VIOLATED", "the label contradiction is established from the record itself, independent of the malformed bound");
});

test("Test 53.5 (control): GENUINE defined_equal_exact — figures equal to the quote — reconciles OK with and without an envelope", () => {
  assert.deepEqual(reconcileCommittedEffect(quotedEffect(), committedWith("defined_equal_exact"), GENEROUS, QTY_PROPOSAL), { status: "OK" });
  assert.deepEqual(reconcileCommittedEffect(quotedEffect(), committedWith("defined_equal_exact"), undefined, QTY_PROPOSAL), { status: "OK" });
});

test("Test 53.6 (control): provider_actual figures differing within a generous envelope still reconcile OK — envelope semantics for genuine actuals are unchanged", () => {
  assert.deepEqual(reconcileCommittedEffect(quotedEffect(), committedWith("provider_actual", 1500, 121000), GENEROUS, QTY_PROPOSAL), { status: "OK" });
  assert.deepEqual(reconcileCommittedEffect(quotedEffect(), committedWith("provider_actual", 1500, 121000), undefined, QTY_PROPOSAL), { status: "OK" });
});

test("Test 53.7: forged defined_equal_exact on the RECURRING dimension only, no envelope — VIOLATED", () => {
  const result = reconcileCommittedEffect(quotedEffect(), committedWith("defined_equal_exact", 1000, 150000), undefined, QTY_PROPOSAL);
  assert.equal(result.status, "VIOLATED");
});

test("Test 53.8: forged defined_equal_exact as a recurring DECREASE under a zero-tolerance envelope — VIOLATED (the envelope never checks recurring decreases; the label's equality claim does)", () => {
  const result = reconcileCommittedEffect(quotedEffect(), committedWith("defined_equal_exact", 1000, 80000), ZERO, QTY_PROPOSAL);
  assert.equal(result.status, "VIOLATED");
});

// ---------------------------------------------------------------------------
// Store-level fixtures (test50 conventions)
// ---------------------------------------------------------------------------

const SUB = "sub_53";
const QUOTED = { immediate: 20000, recurring: 80900 };

function snapshot53(quantity = 2): SubscriptionSnapshot {
  return {
    id: SUB,
    version: "v2",
    status: "active",
    items: [{ id: "item_1", offeringRef: "plan", quantity }],
    billing: { currency: "USD", cadence: "MONTHLY", recurringAmount: QUOTED.recurring },
  };
}

function makeQuote53(
  quoteId: string,
  opts: { envelope?: Record<string, number>; quantity?: number } = {}
): StoredQuote {
  return {
    quote_id: quoteId,
    provider: "stripe",
    subscription_id: SUB,
    subscription_version_at_quote: "v1",
    proposal: {
      changes: [{ action: "CHANGE_QUANTITY", itemId: "item_1", quantity: opts.quantity ?? 2 }],
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
      provenance: { immediate: "test53: quote-time preview", recurring: "test53: quote-time preview" },
    },
    created_at: "2026-10-30T00:00:00.000Z",
    expires_at: "2026-10-30T01:00:00.000Z",
    status: "ACTIVE",
  };
}

function candidateReceipt53(quoteId: string): SubscriptionChangeReceipt {
  return {
    quoteId,
    subscriptionRef: SUB,
    receiptId: `rcpt_${quoteId}`,
    status: "COMMITTED_UNVERIFIED",
    outcome: "COMMITTED_UNVERIFIED",
    resultingSnapshot: snapshot53(),
    quotedEffect: {
      immediate: { net: QUOTED.immediate },
      recurring: { resultingAmount: QUOTED.recurring, currency: "USD", cadence: "MONTHLY" },
      determinacy: { immediateFinancialEffect: "DETERMINED", recurringFinancialEffect: "DETERMINED" },
      provenance: { immediate: "test53: quote-time preview", recurring: "test53: quote-time preview" },
    },
    committedEffect: {
      immediate: { net: QUOTED.immediate },
      recurring: { resultingAmount: QUOTED.recurring, currency: "USD", cadence: "MONTHLY" },
      determinacy: { immediateFinancialEffect: "UNKNOWN", recurringFinancialEffect: "UNKNOWN" },
      provenance: {
        immediate: "candidate: mutation response figures (unverified)",
        recurring: "candidate: mutation response figures (unverified)",
        committedSource: "unestablished",
      },
    },
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

function seededStore53(quoteId: string, opts: { envelope?: Record<string, number>; quantity?: number } = {}): QuoteStore {
  const store = new QuoteStore();
  store.put(makeQuote53(quoteId, opts));
  store.recordCommitReceipt(quoteId, candidateReceipt53(quoteId));
  return store;
}

function observation53(source: string, net = QUOTED.immediate, resulting = QUOTED.recurring): ProviderObservation {
  return {
    subscriptionRef: SUB,
    committedEffect: committedWith(source, net, resulting),
    resultingSnapshot: snapshot53(),
    source: "test53: post-commit provider read (mocked fixture)",
    observedAt: "2026-10-30T00:06:00.000Z",
  };
}

const isConflict = (e: unknown): boolean => e instanceof SCQError && e.code === "CONFLICTING_RECEIPT_IDENTITY";

// ---------------------------------------------------------------------------
// Case 1 at the store boundary — a forged EXACT observation must not
// produce a verified/OK establishment
// ---------------------------------------------------------------------------

test("Test 53.9: forged EXACT observation (defined_equal_exact label, drifted immediate figure, no envelope) — the minted token reconciles VIOLATED and the verified view is verified-with-violation, never verified/OK", () => {
  const store = seededStore53("q53_9");
  const token = establishVerification(store.get("q53_9")!, observation53("defined_equal_exact", QUOTED.immediate + 5000, QUOTED.recurring));
  assert.equal(token.reconciliation.status, "VIOLATED", "the forged label must not mint an OK reconciliation");
  const view = store.verifyCommitReceipt("q53_9", token);
  assert.equal(view.reconciliation.status, "VIOLATED");
  assert.deepEqual(store.receiptsWithReconciliation("OK").map((r) => r.quoteId), [], "no OK-reconciled receipt may result from the forged basis");
});

test("Test 53.10 (control): GENUINE EXACT observation (defined_equal_exact, figures equal to the quote) establishes verified/OK at the store boundary", () => {
  const store = seededStore53("q53_10");
  const token = establishVerification(store.get("q53_10")!, observation53("defined_equal_exact"));
  assert.equal(token.reconciliation.status, "OK");
  const view = store.verifyCommitReceipt("q53_10", token);
  assert.equal(view.outcome, "COMMITTED_AND_VERIFIED");
  assert.equal(view.reconciliation.status, "OK");
});

// ---------------------------------------------------------------------------
// Case 2 — unsupported establishing sources
// ---------------------------------------------------------------------------

test("Test 53.11: establishVerification refuses estimate-derived and unestablished committed sources", () => {
  const store = seededStore53("q53_11");
  const quote = store.get("q53_11")!;
  for (const source of ["revalidated_preview", "pre_mutation_estimate", "unestablished"]) {
    assert.throws(() => establishVerification(quote, observation53(source)), /Establishment refused/, `source ${source} must not mint evidence`);
  }
  const absent = observation53("provider_actual");
  delete absent.committedEffect.provenance!.committedSource;
  assert.throws(() => establishVerification(quote, absent), /Establishment refused/, "an absent committedSource must not mint evidence");
});

test("Test 53.12: establishVerification refuses UNLISTED source strings (caller-asserted, near-miss spellings, case variants)", () => {
  const store = seededStore53("q53_12");
  const quote = store.get("q53_12")!;
  for (const source of ["caller_asserted", "provider", "PROVIDER_ACTUAL", "defined-equal-exact", " provider_actual", "exact"]) {
    assert.throws(() => establishVerification(quote, observation53(source)), /Establishment refused/, `unlisted source ${JSON.stringify(source)} must not mint evidence`);
  }
});

test("Test 53.13: reconciliation establishes nothing for unlisted or estimate-derived committed sources — UNVERIFIED on envelope and no-envelope paths", () => {
  for (const source of ["caller_asserted", "estimate", "revalidated_preview", "pre_mutation_estimate"]) {
    assert.equal(reconcileCommittedEffect(quotedEffect(), committedWith(source), GENEROUS, QTY_PROPOSAL).status, "UNVERIFIED", `source ${source} (envelope path)`);
    assert.equal(reconcileCommittedEffect(quotedEffect(), committedWith(source), undefined, QTY_PROPOSAL).status, "UNVERIFIED", `source ${source} (no-envelope path)`);
  }
});

test("Test 53.14: a self-asserted (never minted) evidence object claiming defined_equal_exact + VERIFIED + OK is refused at the verification transition", () => {
  const store = seededStore53("q53_14");
  const fabricated: VerificationEvidence = {
    committedEffect: committedWith("defined_equal_exact"),
    committedSource: "defined_equal_exact",
    stateVerification: "VERIFIED",
    reconciliation: { status: "OK" },
  };
  assert.throws(() => store.verifyCommitReceipt("q53_14", fabricated), /established evidence token|self-asserted/i);
});

// ---------------------------------------------------------------------------
// Case 3 — missing operation binding
// ---------------------------------------------------------------------------

test("Test 53.15: establishVerification refuses an observation of a DIFFERENT subscription", () => {
  const store = seededStore53("q53_15");
  const foreign = observation53("provider_actual");
  foreign.subscriptionRef = "sub_someone_else";
  assert.throws(() => establishVerification(store.get("q53_15")!, foreign), /Establishment refused: the observation names subscription/);
});

test("Test 53.16: genuine actuals minted for quote A cannot verify quote B on the SAME subscription (cross-quote replay) — CONFLICTING_RECEIPT_IDENTITY", () => {
  const store = new QuoteStore();
  store.put(makeQuote53("q53_16a", { quantity: 2 }));
  store.put(makeQuote53("q53_16b", { quantity: 3 }));
  store.recordCommitReceipt("q53_16b", candidateReceipt53("q53_16b"));
  const tokenForA = establishVerification(store.get("q53_16a")!, observation53("provider_actual"));
  assert.equal(tokenForA.reconciliation.status, "OK", "the evidence is genuine — for quote A");
  assert.throws(() => store.verifyCommitReceipt("q53_16b", tokenForA), isConflict);
});

test("Test 53.17: the same cross-quote token is refused on the append-only evidence path as well", () => {
  const store = new QuoteStore();
  store.put(makeQuote53("q53_17a", { quantity: 2 }));
  store.put(makeQuote53("q53_17b", { quantity: 3 }));
  store.recordCommitReceipt("q53_17b", candidateReceipt53("q53_17b"));
  const tokenForA = establishVerification(store.get("q53_17a")!, observation53("provider_actual"));
  assert.throws(() => store.recordReceiptEvidence("q53_17b", tokenForA), isConflict);
});

test("Test 53.18: a minted token whose figures are altered after establishment is refused (content digest), even where recomputation cannot see the change", () => {
  const store = seededStore53("q53_18");
  const token = establishVerification(store.get("q53_18")!, observation53("provider_actual"));
  token.committedEffect.immediate!.net = 999999;
  assert.throws(() => store.verifyCommitReceipt("q53_18", token), /altered after establishment/);
});

test("Test 53.19: an observation that IS the quote's own quoted effect (the estimate itself, relabeled) is refused at minting", () => {
  const store = seededStore53("q53_19");
  const quote = store.get("q53_19")!;
  const relabeled: ProviderObservation = {
    subscriptionRef: SUB,
    committedEffect: quote.quoted_effect,
    resultingSnapshot: snapshot53(),
    source: "test53: relabeled estimate (fixture)",
  };
  assert.throws(() => establishVerification(quote, relabeled), /estimate itself, relabeled/);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import {
  auditDeterminacy,
  checkAcceptanceEnvelope,
  determinacyOf,
  reconcileCommittedEffect,
  type ReconciliationResult,
} from "../src/core/scq-engine.js";
import {
  SCQError,
  type CommercialEffect,
  type MutationOutcome,
  type SubscriptionChangeReceipt,
  type VerificationEvidence,
} from "../src/core/types.js";
import {
  QuoteStore,
  establishVerification,
  receiptIdentityDigest,
  type StoredQuote,
} from "../src/store/quote-store.js";

// SCQ v0.6.2 — PR-1 seed of the conformance suite (CORE-14 file,
// ported per-family per the plan's porting gates; this PR ports the
// families PR-1 is gated on):
//
//   - Type surface (CORE-1/2/3/5/6/7): determinacy + provenance
//     compile and round-trip; the legacy reading of an absent
//     determinacy map is UNKNOWN in every dimension.
//   - CORE-4 / BC-5: ReconciliationResult is defined once (types.ts)
//     and re-exported from the engine; the UNVERIFIED variant is
//     constructible through the engine import; and an exhaustive
//     v0.6.1-shaped consumer FAILS TO COMPILE against the widened
//     union — the intended loudness — proven by compiling
//     compile-fixtures/exhaustive-reconciliation-consumer.ts and
//     asserting the diagnostic names UNVERIFIED.
//   - auditDeterminacy (transitional, non-normative, report-only):
//     the prototype's A1/A2/A5 cases are the specification — value
//     validity (A1), applicability justification incl. context and
//     citation preconditions (A2/F2), and the legacy reading (A5).
//     The audit reports findings and NEVER throws or mutates.
//   - Store receipt identity (CORE-8 / F4), gated at PR-1 by the
//     conformance matrix: identity-keyed recording, idempotent
//     replay, conflicting-identity refusal with the original
//     preserved byte-identical, identity-bound verify (exactly
//     once), digest re-verification on restore.
//   - Behavior pin: PR-1 changes NO verdict — checkAcceptanceEnvelope
//     and reconcileCommittedEffect keep their exact v0.6.1 behavior
//     (missing-value-to-zero coercion included) until the separately
//     gated activation step.

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function makeQuote(quoteId: string, subscriptionId = "sub_1"): StoredQuote {
  return {
    quote_id: quoteId,
    provider: "stripe",
    subscription_id: subscriptionId,
    subscription_version_at_quote: "v1",
    proposal: { changes: [{ action: "CHANGE_QUANTITY", itemId: "item_1", quantity: 2 }], effectiveIntent: { type: "IMMEDIATE" } },
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

const isConflict = (e: unknown): boolean => e instanceof SCQError && e.code === "CONFLICTING_RECEIPT_IDENTITY";

/**
 * PR #8 corrections, round 2 (R3; disclosed helper rewrite):
 * evidence for the standard fixtures is MINTED by
 * establishVerification from an independent observation — the
 * simulated post-commit provider read (item_1 at quantity 2,
 * provider-actual figures 1000/5000). Round 1's helper constructed
 * the evidence object from the receipt under test and asserted
 * its state/reconciliation; that construction is the
 * self-assertion R3 closes, so the helper now goes through the
 * establishment procedure, which computes both.
 */
function mintEvidenceFor(store: QuoteStore): VerificationEvidence {
  return establishVerification(store.get("q1")!, {
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
  });
}

// ---------------------------------------------------------------------------
// Type surface + legacy reading
// ---------------------------------------------------------------------------

test("Test 14.1: determinacy + provenance round-trip; determinacyOf reads asserted states", () => {
  const effect: CommercialEffect = {
    immediate: { net: 185240 },
    recurring: { previousAmount: 60900, resultingAmount: 80900, currency: "usd" },
    determinacy: { immediateFinancialEffect: "DETERMINED", recurringFinancialEffect: "DETERMINED" },
    provenance: {
      immediate: "unbilled_charge_estimates total (provider actual)",
      recurring: "per-item stated amounts, pricing-model rules",
      committedSource: "provider_actual",
    },
  };
  const roundTripped = JSON.parse(JSON.stringify(effect)) as CommercialEffect;
  assert.deepEqual(determinacyOf(roundTripped), {
    immediateFinancialEffect: "DETERMINED",
    recurringFinancialEffect: "DETERMINED",
  });
});

test("Test 14.2: legacy payload (no determinacy) reads UNKNOWN in every dimension; a partial map reads UNKNOWN where absent", () => {
  const legacy: CommercialEffect = { immediate: { net: 100 }, recurring: { resultingAmount: 500, currency: "usd" } };
  assert.deepEqual(determinacyOf(legacy), {
    immediateFinancialEffect: "UNKNOWN",
    recurringFinancialEffect: "UNKNOWN",
  });
  const partial: CommercialEffect = {
    immediate: { net: 0 },
    determinacy: { immediateFinancialEffect: "DETERMINED" } as CommercialEffect["determinacy"],
  };
  assert.equal(determinacyOf(partial).immediateFinancialEffect, "DETERMINED");
  assert.equal(determinacyOf(partial).recurringFinancialEffect, "UNKNOWN");
});

test("Test 14.3: snapshot recurringAmountState compiles and carries the dimension state (CORE-7)", () => {
  const snap = {
    id: "sub_1",
    version: "v1",
    status: "active",
    items: [],
    billing: { currency: "usd", recurringAmount: 5000, recurringAmountState: "DETERMINED" as const },
  };
  assert.equal(snap.billing.recurringAmountState, "DETERMINED");
});

// ---------------------------------------------------------------------------
// CORE-4: single definition, re-export, UNVERIFIED variant; BC-5 loudness
// ---------------------------------------------------------------------------

test("Test 14.4: UNVERIFIED reconciliation is constructible through the engine re-export (CORE-4)", () => {
  const unverified: ReconciliationResult = {
    status: "UNVERIFIED",
    reason: "committed recurring figure is UNKNOWN",
    undeterminedDimensions: ["recurringFinancialEffect"],
  };
  assert.equal(unverified.status, "UNVERIFIED");
  // The engine's own function keeps its v0.6.1 behavior in this PR.
  assert.deepEqual(reconcileCommittedEffect({ immediate: { net: 1 } }, { immediate: { net: 1 } }, undefined), { status: "OK" });
});

test("Test 14.5: an exhaustive v0.6.1-shaped consumer fails to compile against the widened union, naming UNVERIFIED (BC-5)", () => {
  const fixturePath = fileURLToPath(
    new URL("../../compile-fixtures/exhaustive-reconciliation-consumer.ts", import.meta.url)
  );
  const program = ts.createProgram([fixturePath], {
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
  });
  const messages = ts
    .getPreEmitDiagnostics(program)
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, " "));
  assert.ok(messages.length > 0, "the v0.6.1-shaped exhaustive consumer must fail compilation after CORE-4");
  assert.ok(
    messages.some((m) => m.includes("UNVERIFIED")),
    `the failure must name the new UNVERIFIED variant (the intended loudness); got: ${messages.join(" | ")}`
  );
});

// ---------------------------------------------------------------------------
// Behavior pin: PR-1 changes no verdict
// ---------------------------------------------------------------------------

test("Test 14.6: checkAcceptanceEnvelope behavior is byte-for-byte v0.6.1 in PR-1 (missing values still coerce; activation is a later gate)", () => {
  assert.equal(checkAcceptanceEnvelope({}, {}, {}), null);
  assert.equal(
    checkAcceptanceEnvelope(
      { immediate: { net: 1000 }, recurring: { resultingAmount: 5000, currency: "usd" } },
      { immediate: { net: 1000 }, recurring: { resultingAmount: 5000, currency: "usd" } },
      {}
    ),
    null
  );
  // v0.6.1 semantics: an absent revalidated dimension reads as 0, so
  // this is a credit-side drift of 1000 against zero tolerance.
  const violation = checkAcceptanceEnvelope({ immediate: { net: 1000 } }, {}, {});
  assert.ok(typeof violation === "string" && violation.includes("1000"));
});

// ---------------------------------------------------------------------------
// auditDeterminacy — report-only; prototype A1/A2/A5 cases are the spec
// ---------------------------------------------------------------------------

test("Test 14.7 (A5): audit of a legacy pair reports WOULD_REFUSE_UNKNOWN on both dimensions, mutates nothing, throws nothing", () => {
  const quoted: CommercialEffect = { immediate: { net: 1000 }, recurring: { resultingAmount: 5000, currency: "usd" } };
  const compared: CommercialEffect = { immediate: { net: 1000 }, recurring: { resultingAmount: 5000, currency: "usd" } };
  const before = JSON.stringify([quoted, compared]);
  const report = auditDeterminacy(quoted, compared, "CHANGE_QUANTITY");
  assert.equal(JSON.stringify([quoted, compared]), before, "audit must not mutate its inputs");
  assert.equal(report.length, 2);
  for (const entry of report) {
    assert.equal(entry.quotedState, "UNKNOWN");
    assert.equal(entry.comparedState, "UNKNOWN");
    assert.deepEqual(entry.findings, ["WOULD_REFUSE_UNKNOWN"]);
  }
});

test("Test 14.8: audit of a fully determined, finite, provenance-carrying pair reports zero findings (verified zero included)", () => {
  // PR #8 correction C4 (disclosed fixture update): a DETERMINED
  // dimension now also requires supporting provenance for a
  // zero-finding audit — a finite number alone is not
  // verification — so the clean fixture carries provenance.
  const effect: CommercialEffect = {
    immediate: { net: 0 },
    recurring: { resultingAmount: 5000, currency: "usd" },
    determinacy: { immediateFinancialEffect: "DETERMINED", recurringFinancialEffect: "DETERMINED" },
    provenance: {
      immediate: "simulator invoice total (independently computed)",
      recurring: "per-item stated amounts",
    },
  };
  const report = auditDeterminacy(effect, effect, "CHANGE_QUANTITY");
  assert.ok(report.every((e) => e.findings.length === 0), JSON.stringify(report));
});

test("Test 14.9 (A1): DETERMINED with NaN / missing / infinite values reports INVALID_DETERMINED_VALUE per dimension", () => {
  // PR #8 correction C4 (disclosed fixture update): the valid
  // recurring dimension carries provenance so its expected
  // findings stay [] now that DETERMINED requires provenance;
  // the invalid dimension reports INVALID_DETERMINED_VALUE alone
  // (provenance is not double-reported for invalid values).
  const nanPair: CommercialEffect = {
    immediate: { net: Number.NaN },
    recurring: { resultingAmount: 5000, currency: "usd" },
    determinacy: { immediateFinancialEffect: "DETERMINED", recurringFinancialEffect: "DETERMINED" },
    provenance: { recurring: "per-item stated amounts" },
  };
  const nanReport = auditDeterminacy(nanPair, nanPair, "CHANGE_QUANTITY");
  assert.deepEqual(nanReport.find((e) => e.dimension === "immediateFinancialEffect")?.findings, ["INVALID_DETERMINED_VALUE"]);
  assert.deepEqual(nanReport.find((e) => e.dimension === "recurringFinancialEffect")?.findings, []);

  const missingPair: CommercialEffect = {
    immediate: { net: 10 },
    determinacy: { immediateFinancialEffect: "DETERMINED", recurringFinancialEffect: "DETERMINED" },
    provenance: { immediate: "invoice total", recurring: "per-item stated amounts" },
  };
  const missingReport = auditDeterminacy(missingPair, missingPair, "CHANGE_QUANTITY");
  assert.deepEqual(missingReport.find((e) => e.dimension === "recurringFinancialEffect")?.findings, ["INVALID_DETERMINED_VALUE"]);

  const infPair: CommercialEffect = {
    immediate: { net: Number.POSITIVE_INFINITY },
    determinacy: { immediateFinancialEffect: "DETERMINED", recurringFinancialEffect: "NOT_APPLICABLE" },
  };
  const infReport = auditDeterminacy(infPair, infPair, "CHANGE_QUANTITY");
  assert.ok(infReport.find((e) => e.dimension === "immediateFinancialEffect")?.findings.includes("INVALID_DETERMINED_VALUE"));
});

test("Test 14.10 (A2/F2): a NOT_APPLICABLE assertion with no action context reports MISSING_ACTION_CONTEXT", () => {
  const effect: CommercialEffect = {
    recurring: { resultingAmount: 0, currency: "usd" },
    determinacy: { immediateFinancialEffect: "NOT_APPLICABLE", recurringFinancialEffect: "DETERMINED" },
  };
  const report = auditDeterminacy(effect, effect);
  assert.deepEqual(report.find((e) => e.dimension === "immediateFinancialEffect")?.findings, ["MISSING_ACTION_CONTEXT"]);
});

test("Test 14.11 (A2): malicious dual-N/A — both sides asserting NOT_APPLICABLE for CHANGE_QUANTITY reports UNJUSTIFIED_NOT_APPLICABLE (agreement is not proof)", () => {
  const effect: CommercialEffect = {
    recurring: { resultingAmount: 5000, currency: "usd" },
    determinacy: { immediateFinancialEffect: "NOT_APPLICABLE", recurringFinancialEffect: "DETERMINED" },
    provenance: {
      applicabilityCitations: {
        immediateFinancialEffect: { action: "CHANGE_QUANTITY", dimension: "immediateFinancialEffect" },
      },
    },
  };
  const report = auditDeterminacy(effect, effect, "CHANGE_QUANTITY");
  assert.deepEqual(report.find((e) => e.dimension === "immediateFinancialEffect")?.findings, ["UNJUSTIFIED_NOT_APPLICABLE"]);
});

test("Test 14.12 (A2/F2): licensed N/A without a citation, or with a mismatched citation, reports MISSING_APPLICABILITY_PROVENANCE", () => {
  const noCitation: CommercialEffect = {
    recurring: { resultingAmount: 0, currency: "usd" },
    determinacy: { immediateFinancialEffect: "NOT_APPLICABLE", recurringFinancialEffect: "DETERMINED" },
  };
  const r1 = auditDeterminacy(noCitation, noCitation, "CANCEL");
  assert.deepEqual(r1.find((e) => e.dimension === "immediateFinancialEffect")?.findings, ["MISSING_APPLICABILITY_PROVENANCE"]);

  const wrongAction: CommercialEffect = {
    ...noCitation,
    provenance: {
      applicabilityCitations: {
        immediateFinancialEffect: { action: "CHANGE_PLAN", dimension: "immediateFinancialEffect" },
      },
    },
  };
  const r2 = auditDeterminacy(wrongAction, wrongAction, "CANCEL");
  assert.deepEqual(r2.find((e) => e.dimension === "immediateFinancialEffect")?.findings, ["MISSING_APPLICABILITY_PROVENANCE"]);
});

test("Test 14.13 (A2): licensed, correctly cited CANCEL immediate N/A reports no findings; recurring N/A is never licensed", () => {
  const cited: CommercialEffect = {
    recurring: { resultingAmount: 0, currency: "usd" },
    determinacy: { immediateFinancialEffect: "NOT_APPLICABLE", recurringFinancialEffect: "DETERMINED" },
    provenance: {
      // PR #8 correction C4 (disclosed fixture update): the
      // DETERMINED recurring dimension carries provenance, as a
      // zero-finding audit now requires.
      recurring: "post-cancellation price level (no items remain)",
      applicabilityCitations: {
        immediateFinancialEffect: { action: "CANCEL", dimension: "immediateFinancialEffect" },
      },
    },
  };
  const report = auditDeterminacy(cited, cited, "CANCEL");
  assert.ok(report.every((e) => e.findings.length === 0), JSON.stringify(report));

  const recurringNA: CommercialEffect = {
    immediate: { net: 0 },
    determinacy: { immediateFinancialEffect: "DETERMINED", recurringFinancialEffect: "NOT_APPLICABLE" },
    provenance: {
      applicabilityCitations: {
        recurringFinancialEffect: { action: "CANCEL", dimension: "recurringFinancialEffect" },
      },
    },
  };
  const r2 = auditDeterminacy(recurringNA, recurringNA, "CANCEL");
  assert.deepEqual(r2.find((e) => e.dimension === "recurringFinancialEffect")?.findings, ["UNJUSTIFIED_NOT_APPLICABLE"]);
});

// ---------------------------------------------------------------------------
// Store: receipt identity (CORE-8 / F4)
// ---------------------------------------------------------------------------

test("Test 14.14 (F4): recording is idempotent per identity — an identical re-record replays and changes nothing", () => {
  const store = new QuoteStore();
  store.put(makeQuote("q1"));
  const receipt = makeUnverifiedReceipt();
  const first = store.recordCommitReceipt("q1", receipt);
  const replay = store.recordCommitReceipt("q1", makeUnverifiedReceipt());
  assert.equal(first?.quoteId, "q1");
  // PR #8 correction C3 (disclosed assertion update): the store
  // returns defensive copies, not its internal record, so replay
  // equality is by value and identity — not by reference (the
  // PR-1 reference-equality expectation is superseded by C3's
  // caller-mutation protection).
  assert.deepEqual(replay, first, "replay returns the existing record (by value)");
  const q = store.get("q1")!;
  assert.equal(q.status, "COMMITTED");
  assert.equal(q.commit_receipt?.reconciliation.status, "UNVERIFIED", "replaying an UNVERIFIED receipt never upgrades it");
  assert.equal(receiptIdentityDigest(q.commit_receipt_recorded!), receiptIdentityDigest(receipt));
});

test("Test 14.15 (F4): same outcome class but different figures is a CONFLICTING_RECEIPT_IDENTITY refusal — identity, not status comparison", () => {
  const store = new QuoteStore();
  store.put(makeQuote("q1"));
  store.recordCommitReceipt("q1", makeUnverifiedReceipt());
  const before = JSON.stringify(store.get("q1")!.commit_receipt_recorded);
  const conflicting = makeUnverifiedReceipt({
    committedEffect: { immediate: { net: 2000 }, recurring: { resultingAmount: 5000, currency: "usd" } },
  });
  assert.throws(() => store.recordCommitReceipt("q1", conflicting), isConflict);
  assert.equal(JSON.stringify(store.get("q1")!.commit_receipt_recorded), before, "the original record is preserved byte-identical");
});

test("Test 14.16 (F4): reusing a receiptId under a different quote/identity is refused; the original is preserved", () => {
  const store = new QuoteStore();
  store.put(makeQuote("q1"));
  store.put(makeQuote("q2", "sub_2"));
  store.recordCommitReceipt("q1", makeReceipt({ receiptId: "rcpt_1" }));
  const reuse = makeReceipt({
    receiptId: "rcpt_1",
    quoteId: "q2",
    subscriptionRef: "sub_2",
    committedEffect: { immediate: { net: 9999 }, recurring: { resultingAmount: 5000, currency: "usd" } },
  });
  assert.throws(() => store.recordCommitReceipt("q2", reuse), isConflict);
  assert.equal(store.get("q2")!.commit_receipt, undefined);
  assert.equal(store.get("q1")!.commit_receipt?.committedEffect.immediate?.net, 1000);
});

test("Test 14.17 (F4): recorded identity fields are immutable — caller-side mutation after recording cannot rewrite the record", () => {
  const store = new QuoteStore();
  store.put(makeQuote("q1"));
  const receipt = makeReceipt();
  store.recordCommitReceipt("q1", receipt);
  receipt.committedEffect.immediate!.net = 777;
  const q = store.get("q1")!;
  assert.equal(q.commit_receipt_recorded?.committedEffect.immediate?.net, 1000);
  assert.equal(receiptIdentityDigest(q.commit_receipt_recorded!), q.commit_receipt_identity_digest);
});

test("Test 14.18 (F4): verify transitions COMMITTED_UNVERIFIED exactly once, appends, and never rewrites the recorded identity", () => {
  const store = new QuoteStore();
  store.put(makeQuote("q1"));
  const original = makeUnverifiedReceipt();
  store.recordCommitReceipt("q1", original);
  const digestBefore = store.get("q1")!.commit_receipt_identity_digest;

  // PR #8 correction C1, round 2 R3 (disclosed call update): the
  // transition takes VerificationEvidence minted by
  // establishVerification from an independent observation — not a
  // bare verdict (C1) and not a caller-constructed object (R3).
  const verified = store.verifyCommitReceipt("q1", mintEvidenceFor(store), makeUnverifiedReceipt());
  assert.equal(verified.status, "COMMITTED");
  assert.equal(verified.outcome, "COMMITTED_AND_VERIFIED");
  assert.equal(verified.reconciliation.status, "OK");

  const q = store.get("q1")!;
  assert.equal(q.commit_receipt_identity_digest, digestBefore, "digest is computed over the recorded fields and is stable across the transition");
  assert.equal(q.commit_receipt_recorded?.status, "COMMITTED_UNVERIFIED", "the recorded original is preserved");
  assert.equal(q.commit_receipt_verifications?.length, 1);
  assert.throws(() => store.verifyCommitReceipt("q1", mintEvidenceFor(store)), /only a COMMITTED_UNVERIFIED record can transition/);
  assert.equal(store.get("q1")!.commit_receipt_verifications?.length, 1, "exactly one transition");
});

test("Test 14.19 (F4): a verification presented under a conflicting identity transitions nothing", () => {
  const store = new QuoteStore();
  store.put(makeQuote("q1"));
  store.recordCommitReceipt("q1", makeUnverifiedReceipt());
  const foreign = makeUnverifiedReceipt({
    committedEffect: { immediate: { net: 4242 }, recurring: { resultingAmount: 5000, currency: "usd" } },
  });
  assert.throws(
    () => store.verifyCommitReceipt("q1", mintEvidenceFor(store), foreign),
    isConflict
  );
  assert.equal(store.get("q1")!.commit_receipt?.reconciliation.status, "UNVERIFIED");
  assert.equal(store.get("q1")!.commit_receipt_verifications, undefined);
});

test("Test 14.20 (F4): a verification must carry a determined reconciliation; a verified-class receipt cannot transition", () => {
  const store = new QuoteStore();
  store.put(makeQuote("q1"));
  const unverified = makeUnverifiedReceipt();
  store.recordCommitReceipt("q1", unverified);
  // Round 2 (R3): mint a genuine token, then replace its computed
  // reconciliation with an UNVERIFIED one — the transition must
  // still refuse: a verification that establishes nothing (no
  // determined reconciliation) transitions nothing.
  const undetermined = mintEvidenceFor(store);
  undetermined.reconciliation = {
    status: "UNVERIFIED",
    reason: "still unknown",
    undeterminedDimensions: ["immediateFinancialEffect"],
  };
  assert.throws(() => store.verifyCommitReceipt("q1", undetermined), /determined reconciliation/);

  const store2 = new QuoteStore();
  store2.put(makeQuote("q1"));
  const verifiedReceipt = makeReceipt();
  store2.recordCommitReceipt("q1", verifiedReceipt);
  assert.throws(() => store2.verifyCommitReceipt("q1", mintEvidenceFor(store2)), /only a COMMITTED_UNVERIFIED/);
});

test("Test 14.21 (CORE-8): commit outcomes are recorded for no-receipt classes too, and UNVERIFIED receipts are enumerable", () => {
  const store = new QuoteStore();
  store.put(makeQuote("q1"));
  store.put(makeQuote("q2", "sub_2"));
  const outcome: MutationOutcome = "INDETERMINATE";
  store.recordCommitOutcome("q1", { outcome, at: "2026-10-28T00:06:00.000Z", details: { indeterminate: true } });
  assert.equal(store.get("q1")!.commit_outcome?.outcome, "INDETERMINATE");
  assert.equal(store.get("q1")!.status, "ACTIVE", "an outcome record does not change quote status");

  store.recordCommitReceipt("q1", makeUnverifiedReceipt());
  store.recordCommitReceipt("q2", makeReceipt({ quoteId: "q2", subscriptionRef: "sub_2" }));
  const unverified = store.receiptsWithReconciliation("UNVERIFIED");
  assert.equal(unverified.length, 1);
  assert.equal(unverified[0].quoteId, "q1");
  assert.equal(store.receiptsWithReconciliation("OK").length, 1);
});

test("Test 14.22 (F4): serialize/restore round-trips records; replay and conflict rules still hold after restore", () => {
  const store = new QuoteStore();
  store.put(makeQuote("q1"));
  store.recordCommitReceipt("q1", makeUnverifiedReceipt());
  const persisted = store.serializeReceiptRecords();

  const restored = new QuoteStore();
  restored.put(makeQuote("q1"));
  restored.restoreReceiptRecords(persisted);
  const q = restored.get("q1")!;
  assert.equal(q.status, "COMMITTED");
  assert.equal(q.commit_receipt?.reconciliation.status, "UNVERIFIED");
  // Replay after recovery returns the record; a conflict is still refused.
  assert.equal(restored.recordCommitReceipt("q1", makeUnverifiedReceipt())?.quoteId, "q1");
  assert.throws(
    () =>
      restored.recordCommitReceipt(
        "q1",
        makeUnverifiedReceipt({ committedEffect: { immediate: { net: 1 }, recurring: { resultingAmount: 5000, currency: "usd" } } })
      ),
    isConflict
  );
});

test("Test 14.23 (F4): restore re-verifies digests — a tampered persisted record refuses the whole set", () => {
  const store = new QuoteStore();
  store.put(makeQuote("q1"));
  store.recordCommitReceipt("q1", makeUnverifiedReceipt());
  const data = JSON.parse(store.serializeReceiptRecords());
  data.records[0].recorded_receipt.committedEffect.immediate.net = 31337;

  const restored = new QuoteStore();
  restored.put(makeQuote("q1"));
  assert.throws(() => restored.restoreReceiptRecords(JSON.stringify(data)), isConflict);
  assert.equal(restored.get("q1")!.commit_receipt, undefined, "nothing is adopted from a refused set");
});

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  auditDeterminacy,
  checkAcceptanceEnvelope,
  reconcileCommittedEffect,
} from "../src/core/scq-engine.js";
import {
  SCQError,
  type AcceptanceEnvelope,
  type CommercialEffect,
  type SubscriptionChangeProposal,
} from "../src/core/types.js";

// SCQ v0.6.2 — PR-10 review correction BC1-R1: NOT_APPLICABLE purity.
//
// The three-state model (issue #7 Topic 1; types.ts on DimensionState)
// defines NOT_APPLICABLE as the dimension NOT ARISING — with its
// financial field ABSENT. A present field is a value: an explicit
// zero is a DETERMINED zero, never an absence that may be relabeled
// NOT_APPLICABLE. Before this correction, assessDimensionSide and
// auditDeterminacy validated an N/A assertion's action context,
// license, and citation but never the absence of the field itself,
// so a CANCEL effect carrying immediate.net = 50000 could assert
// NOT_APPLICABLE with a valid citation and the gate SKIPPED the
// dimension — the present amount was discarded by relabeling.
//
// This suite was written FAILING-FIRST against PR-10 head 1df747f:
// tests 36.1–36.6 and 36.9–36.11 fail there (the impure shapes are
// skipped / reconcile OK / report no finding); 36.7 (VIOLATED
// precedence) and 36.8 (legitimate pure N/A) are CONTROLS that pass
// on both heads, pinning that the correction removes only the
// impure path and disturbs neither established violations nor the
// licensed skip.

// ---------------------------------------------------------------------------
// Fixtures — mirroring test35's cancelEffect discipline: every
// figure's determinacy/provenance is explicit.
// ---------------------------------------------------------------------------

const GENEROUS: AcceptanceEnvelope = {
  maxImmediateNetIncrease: 1_000_000,
  maxImmediateCreditDecrease: 1_000_000,
  maxRecurringIncrease: 1_000_000,
};

const CANCEL_PROPOSAL: SubscriptionChangeProposal = {
  changes: [{ action: "CANCEL" }],
  effectiveIntent: { type: "TERM_END" },
  guaranteeMode: "REVALIDATE",
  acceptanceEnvelope: GENEROUS,
};

const CANCEL_CITATION = {
  immediateFinancialEffect: { action: "CANCEL" as const, dimension: "immediateFinancialEffect" as const },
};

/** Quote-side CANCEL effect asserting immediate NOT_APPLICABLE; `net === undefined` keeps the field absent (pure). */
function cancelEffect(net: number | undefined, resulting: number, cited: boolean): CommercialEffect {
  return {
    ...(net !== undefined ? { immediate: { net } } : {}),
    recurring: { resultingAmount: resulting, currency: "usd" },
    determinacy: { immediateFinancialEffect: "NOT_APPLICABLE", recurringFinancialEffect: "DETERMINED" },
    provenance: {
      recurring: "post-cancellation price level (fixture)",
      ...(cited ? { applicabilityCitations: CANCEL_CITATION } : {}),
    },
  };
}

/** Committed-side CANCEL effect asserting immediate NOT_APPLICABLE, recurring established as provider_actual. */
function committedCancelEffect(net: number | undefined, resulting: number): CommercialEffect {
  return {
    ...(net !== undefined ? { immediate: { net } } : {}),
    recurring: { resultingAmount: resulting, currency: "usd" },
    determinacy: { immediateFinancialEffect: "NOT_APPLICABLE", recurringFinancialEffect: "DETERMINED" },
    provenance: {
      recurring: "post-commit provider read (fixture)",
      committedSource: "provider_actual",
      applicabilityCitations: CANCEL_CITATION,
    },
  };
}

/** A fully determined, provenance-carrying quote-side effect (the non-N/A side of a one-sided case). */
function determinedEffect(net: number, resulting: number): CommercialEffect {
  return {
    immediate: { net },
    recurring: { previousAmount: 100000, resultingAmount: resulting, currency: "usd" },
    determinacy: { immediateFinancialEffect: "DETERMINED", recurringFinancialEffect: "DETERMINED" },
    provenance: { immediate: "preview incurred figure (fixture)", recurring: "per-item stated amounts (fixture)" },
  };
}

type RefusalDetails = {
  outcome?: string;
  dimensions?: Array<{
    dimension: string;
    quoted?: { state: string; findings: string[] };
    revalidated?: { state: string; findings: string[] };
  }>;
};

function captureRefusal(fn: () => unknown): SCQError {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof SCQError, `expected an SCQError refusal, got ${String(e)}`);
    assert.equal(e.code, "QUOTE_NOT_DETERMINISTIC");
    return e;
  }
  assert.fail("expected checkAcceptanceEnvelope to refuse with QUOTE_NOT_DETERMINISTIC");
}

function refusalFindings(e: SCQError, dimension: string, side: "quoted" | "revalidated"): string[] {
  const details = e.details as RefusalDetails | undefined;
  const entry = details?.dimensions?.find((d) => d.dimension === dimension);
  assert.ok(entry, `refusal details must name ${dimension}: ${JSON.stringify(e.details)}`);
  return entry[side]?.findings ?? [];
}

// ---------------------------------------------------------------------------
// Pre-mutation: an impure NOT_APPLICABLE refuses, however valid the citation
// ---------------------------------------------------------------------------

test("Test 36.1 (BC1-R1 a): quoted AND revalidated N/A over a present nonzero immediate.net refuse — the amount is not discarded by relabeling", () => {
  const impure = cancelEffect(50000, 0, true);
  const err = captureRefusal(() => checkAcceptanceEnvelope(impure, impure, GENEROUS, CANCEL_PROPOSAL));
  assert.deepEqual(refusalFindings(err, "immediateFinancialEffect", "quoted"), ["INCONSISTENT_NOT_APPLICABLE_VALUE"]);
  assert.deepEqual(refusalFindings(err, "immediateFinancialEffect", "revalidated"), ["INCONSISTENT_NOT_APPLICABLE_VALUE"]);
  // The refusal is a pre-effect non-execution, not a dispatch outcome.
  assert.equal((err.details as RefusalDetails).outcome, "CONFIRMED_NON_EXECUTION");
});

test("Test 36.2 (BC1-R1 b): N/A over an explicit zero net refuses — a verified zero is DETERMINED, never relabeled N/A", () => {
  const zeroImpure = cancelEffect(0, 0, true);
  const err = captureRefusal(() => checkAcceptanceEnvelope(zeroImpure, zeroImpure, GENEROUS, CANCEL_PROPOSAL));
  assert.deepEqual(refusalFindings(err, "immediateFinancialEffect", "quoted"), ["INCONSISTENT_NOT_APPLICABLE_VALUE"]);
});

test("Test 36.3 (BC1-R1 c): N/A over immediate { charge } without net refuses — the FIELD must be absent, not merely .net", () => {
  const chargeOnly: CommercialEffect = {
    immediate: { charge: 50000 },
    recurring: { resultingAmount: 0, currency: "usd" },
    determinacy: { immediateFinancialEffect: "NOT_APPLICABLE", recurringFinancialEffect: "DETERMINED" },
    provenance: {
      recurring: "post-cancellation price level (fixture)",
      applicabilityCitations: CANCEL_CITATION,
    },
  };
  const err = captureRefusal(() => checkAcceptanceEnvelope(chargeOnly, chargeOnly, GENEROUS, CANCEL_PROPOSAL));
  assert.deepEqual(refusalFindings(err, "immediateFinancialEffect", "quoted"), ["INCONSISTENT_NOT_APPLICABLE_VALUE"]);
});

test("Test 36.4 (BC1-R1 d): one-sided impure N/A refuses, and the refusal names the impurity on the asserting side", () => {
  const err = captureRefusal(() =>
    checkAcceptanceEnvelope(cancelEffect(50000, 0, true), determinedEffect(500, 0), GENEROUS, CANCEL_PROPOSAL)
  );
  assert.deepEqual(refusalFindings(err, "immediateFinancialEffect", "quoted"), ["INCONSISTENT_NOT_APPLICABLE_VALUE"]);
});

// ---------------------------------------------------------------------------
// Post-commit: an impure committed N/A establishes nothing
// ---------------------------------------------------------------------------

test("Test 36.5 (BC1-R1 e, envelope): committed N/A over a present immediate field cannot reconcile OK — UNVERIFIED, dimension named", () => {
  const result = reconcileCommittedEffect(
    cancelEffect(undefined, 0, true),
    committedCancelEffect(50000, 0),
    GENEROUS,
    CANCEL_PROPOSAL
  );
  assert.equal(result.status, "UNVERIFIED", "a present committed amount relabeled N/A is unestablished, not skipped");
  assert.ok(result.status === "UNVERIFIED" && result.undeterminedDimensions.includes("immediateFinancialEffect"));
});

test("Test 36.6 (BC1-R1 e, no envelope): committed N/A over a present immediate field cannot reconcile OK without an envelope either", () => {
  const result = reconcileCommittedEffect(
    cancelEffect(undefined, 0, true),
    committedCancelEffect(50000, 0),
    undefined,
    CANCEL_PROPOSAL
  );
  assert.equal(result.status, "UNVERIFIED");
  assert.ok(result.status === "UNVERIFIED" && result.undeterminedDimensions.includes("immediateFinancialEffect"));
});

test("Test 36.7 (BC1-R1 precedence control): an independently established violation still reports VIOLATED beside an impure committed N/A", () => {
  // Recurring is established on both sides and exceeds the envelope;
  // the impure immediate N/A is unenforceable but must not downgrade
  // the proven violation (established VIOLATED > UNVERIFIED).
  const committed: CommercialEffect = {
    immediate: { net: 50000 },
    recurring: { resultingAmount: 2_500_000, currency: "usd" },
    determinacy: { immediateFinancialEffect: "NOT_APPLICABLE", recurringFinancialEffect: "DETERMINED" },
    provenance: {
      recurring: "post-commit provider read (fixture)",
      committedSource: "provider_actual",
      applicabilityCitations: CANCEL_CITATION,
    },
  };
  const result = reconcileCommittedEffect(determinedEffect(1000, 120000), committed, GENEROUS, CANCEL_PROPOSAL);
  assert.equal(result.status, "VIOLATED");
});

// ---------------------------------------------------------------------------
// Control: the legitimate pure N/A is untouched
// ---------------------------------------------------------------------------

test("Test 36.8 (BC1-R1 f, control): pure N/A (whole immediate field absent) with a valid citation still skips pre-commit and reconciles OK post-commit", () => {
  assert.equal(
    checkAcceptanceEnvelope(cancelEffect(undefined, 0, true), cancelEffect(undefined, 0, true), GENEROUS, CANCEL_PROPOSAL),
    null,
    "the licensed skip is preserved when the field is genuinely absent"
  );
  const withEnvelope = reconcileCommittedEffect(
    cancelEffect(undefined, 0, true),
    committedCancelEffect(undefined, 0),
    GENEROUS,
    CANCEL_PROPOSAL
  );
  assert.equal(withEnvelope.status, "OK");
  const noEnvelope = reconcileCommittedEffect(
    cancelEffect(undefined, 0, true),
    committedCancelEffect(undefined, 0),
    undefined,
    CANCEL_PROPOSAL
  );
  assert.equal(noEnvelope.status, "OK");
});

// ---------------------------------------------------------------------------
// Gate/audit agreement and the order of findings
// ---------------------------------------------------------------------------

test("Test 36.9 (BC1-R1 g): auditDeterminacy reports INCONSISTENT_NOT_APPLICABLE_VALUE for exactly the shapes the gate refuses", () => {
  for (const shape of [cancelEffect(50000, 0, true), cancelEffect(0, 0, true)]) {
    const audit = auditDeterminacy(shape, shape, "CANCEL");
    assert.deepEqual(audit.find((e) => e.dimension === "immediateFinancialEffect")?.findings, [
      "INCONSISTENT_NOT_APPLICABLE_VALUE",
    ]);
    assert.deepEqual(audit.find((e) => e.dimension === "recurringFinancialEffect")?.findings, []);
  }
  const chargeOnly: CommercialEffect = {
    immediate: { charge: 50000 },
    recurring: { resultingAmount: 0, currency: "usd" },
    determinacy: { immediateFinancialEffect: "NOT_APPLICABLE", recurringFinancialEffect: "DETERMINED" },
    provenance: {
      recurring: "post-cancellation price level (fixture)",
      applicabilityCitations: CANCEL_CITATION,
    },
  };
  const audit = auditDeterminacy(chargeOnly, chargeOnly, "CANCEL");
  assert.deepEqual(audit.find((e) => e.dimension === "immediateFinancialEffect")?.findings, [
    "INCONSISTENT_NOT_APPLICABLE_VALUE",
  ]);
  // And the pure shape reports no such finding.
  const pure = auditDeterminacy(cancelEffect(undefined, 0, true), cancelEffect(undefined, 0, true), "CANCEL");
  assert.ok(pure.every((e) => !e.findings.includes("INCONSISTENT_NOT_APPLICABLE_VALUE" as never)));
});

test("Test 36.10 (BC1-R1 order): field-absence purity is judged BEFORE context, license, and citation — an impure assertion reports the impurity even when justification would also fail", () => {
  // No citation at all: pre-correction this shape reported
  // MISSING_APPLICABILITY_PROVENANCE; the payload's internal
  // contradiction is the first defect, in gate and audit alike.
  const uncited = cancelEffect(50000, 0, false);
  const err = captureRefusal(() => checkAcceptanceEnvelope(uncited, uncited, GENEROUS, CANCEL_PROPOSAL));
  assert.deepEqual(refusalFindings(err, "immediateFinancialEffect", "quoted"), ["INCONSISTENT_NOT_APPLICABLE_VALUE"]);
  const audit = auditDeterminacy(uncited, uncited, "CANCEL");
  assert.deepEqual(audit.find((e) => e.dimension === "immediateFinancialEffect")?.findings, [
    "INCONSISTENT_NOT_APPLICABLE_VALUE",
  ]);
  // No action context at all: same first finding.
  const noContext = auditDeterminacy(cancelEffect(50000, 0, true), cancelEffect(50000, 0, true));
  assert.deepEqual(noContext.find((e) => e.dimension === "immediateFinancialEffect")?.findings, [
    "INCONSISTENT_NOT_APPLICABLE_VALUE",
  ]);
});

test("Test 36.11 (BC1-R1 symmetry): the purity rule binds the recurring dimension too — N/A over a present recurring field reports the impurity, not the license failure", () => {
  const recurringImpure: CommercialEffect = {
    immediate: { net: 0 },
    recurring: { resultingAmount: 5000, currency: "usd" },
    determinacy: { immediateFinancialEffect: "DETERMINED", recurringFinancialEffect: "NOT_APPLICABLE" },
    provenance: {
      immediate: "fixture basis",
      applicabilityCitations: {
        recurringFinancialEffect: { action: "CANCEL", dimension: "recurringFinancialEffect" },
      },
    },
  };
  const audit = auditDeterminacy(recurringImpure, recurringImpure, "CANCEL");
  assert.deepEqual(audit.find((e) => e.dimension === "recurringFinancialEffect")?.findings, [
    "INCONSISTENT_NOT_APPLICABLE_VALUE",
  ]);
  const err = captureRefusal(() =>
    checkAcceptanceEnvelope(recurringImpure, recurringImpure, GENEROUS, CANCEL_PROPOSAL)
  );
  assert.deepEqual(refusalFindings(err, "recurringFinancialEffect", "quoted"), ["INCONSISTENT_NOT_APPLICABLE_VALUE"]);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  auditDeterminacy,
  checkAcceptanceEnvelope,
  checkIdempotentReplay,
  determinacyOf,
  reconcileCommittedEffect,
} from "../src/core/scq-engine.js";
import { verifyPostCommitState } from "../src/core/state-verification.js";
import {
  SCQError,
  type AcceptanceEnvelope,
  type CommercialEffect,
  type SubscriptionChangeProposal,
  type SubscriptionChangeReceipt,
} from "../src/core/types.js";
import { QuoteStore, establishVerification, type StoredQuote } from "../src/store/quote-store.js";
import { DurableQuoteStore } from "../src/store/durable-store.js";
import { DurableMutationCoordinator } from "../src/store/mutation-coordinator.js";
import { StripeAdapter } from "../src/adapters/stripe-adapter.js";
import { PaddleAdapter } from "../src/adapters/paddle-adapter.js";
import { ZuoraAdapter } from "../src/adapters/zuora-adapter.js";
import { ChargebeeAdapter } from "../src/adapters/chargebee-adapter.js";
import { ChargebeeClient, type HttpTransport } from "../src/live/chargebee-http.js";
import { ChargebeeLiveAdapter } from "../src/live/chargebee-scq-adapter.js";
import { PilotMockChargebee } from "../src/live/pilot/mock-transport.js";
import {
  freshChargebeeFixture,
  freshPaddleFixture,
  freshStripeFixture,
  freshZuoraFixture,
} from "./fixtures.js";

// SCQ v0.6.2 — PR-10: BC-1 fail-closed financial enforcement.
//
// This suite was written FAILING-FIRST against the merged PR #18
// baseline (main 25ba49f): the core gate cases (35.1–35.7, 35.11–
// 35.17, 35.21–35.23, 35.29, 35.34, 35.35b) fail there because the
// frozen engine zero-coerces UNKNOWN dimensions and reconciles
// unestablished committed figures to OK. Adapter-level and
// store-level cases whose behavior was already fail-closed under
// the PR #10/#11/#14/#15/#16 adapter-local gates (M2 doctrine) or
// PR-8's establishment rules pass on the baseline too — they are
// CONTROLS, disclosed as such in the PR-10 note (§failing-first
// evidence), pinning that BC-1's core activation composes with
// those guarantees instead of replacing them.
//
// Signature note: BC-1 adds an OPTIONAL fourth parameter (the
// authoritative proposal) to checkAcceptanceEnvelope /
// reconcileCommittedEffect. The aliases below type that parameter
// so this file compiles identically before and after activation;
// on the baseline the argument is ignored at runtime, which is
// exactly what makes the N/A-context cases fail there.

type EnvelopeFn = (
  quoted: CommercialEffect,
  compared: CommercialEffect,
  envelope: AcceptanceEnvelope,
  proposal?: SubscriptionChangeProposal
) => string | null;
type ReconcileFn = (
  quoted: CommercialEffect,
  committed: CommercialEffect,
  envelope: AcceptanceEnvelope | undefined,
  proposal?: SubscriptionChangeProposal
) => SubscriptionChangeReceipt["reconciliation"];
const envelopeOf = checkAcceptanceEnvelope as EnvelopeFn;
const reconcileOf = reconcileCommittedEffect as ReconcileFn;

// ---------------------------------------------------------------------------
// Fixture builders — every figure's determinacy/provenance is explicit.
// ---------------------------------------------------------------------------

const GENEROUS: AcceptanceEnvelope = {
  maxImmediateNetIncrease: 1_000_000,
  maxImmediateCreditDecrease: 1_000_000,
  maxRecurringIncrease: 1_000_000,
};

const QTY_PROPOSAL: SubscriptionChangeProposal = {
  changes: [{ action: "CHANGE_QUANTITY", itemId: "item_1", quantity: 2 }],
  effectiveIntent: { type: "IMMEDIATE" },
  guaranteeMode: "REVALIDATE",
  acceptanceEnvelope: GENEROUS,
};

const CANCEL_PROPOSAL: SubscriptionChangeProposal = {
  changes: [{ action: "CANCEL" }],
  effectiveIntent: { type: "TERM_END" },
  guaranteeMode: "REVALIDATE",
  acceptanceEnvelope: GENEROUS,
};

/** A fully determined, provenance-carrying quote-side effect. */
function determinedEffect(net: number, resulting: number): CommercialEffect {
  return {
    immediate: { net },
    recurring: { previousAmount: 100000, resultingAmount: resulting, currency: "usd" },
    determinacy: { immediateFinancialEffect: "DETERMINED", recurringFinancialEffect: "DETERMINED" },
    provenance: { immediate: "preview incurred figure (fixture)", recurring: "per-item stated amounts (fixture)" },
  };
}

/** A determined committed effect whose figures ARE provider actuals. */
function committedActual(net: number, resulting: number): CommercialEffect {
  return {
    ...determinedEffect(net, resulting),
    provenance: {
      immediate: "post-commit provider read (fixture)",
      recurring: "post-commit provider read (fixture)",
      committedSource: "provider_actual",
    },
  };
}

function withDeterminacy(
  effect: CommercialEffect,
  determinacy: CommercialEffect["determinacy"]
): CommercialEffect {
  return { ...effect, determinacy };
}

const isNotDeterministic = (dimension?: string, side?: string) => (e: unknown): boolean => {
  if (!(e instanceof SCQError) || e.code !== "QUOTE_NOT_DETERMINISTIC") return false;
  if (!dimension) return true;
  const details = e.details as { dimensions?: Array<{ dimension: string; quoted?: unknown; revalidated?: unknown; committed?: unknown }> } | undefined;
  const entry = details?.dimensions?.find((d) => d.dimension === dimension);
  if (!entry) return false;
  if (side === "quoted") return entry.quoted !== undefined;
  if (side === "compared") return entry.revalidated !== undefined || entry.committed !== undefined;
  return true;
};

// ---------------------------------------------------------------------------
// Pre-mutation enforcement — UNKNOWN refuses (matrix 1–7, 17)
// ---------------------------------------------------------------------------

test("Test 35.1 (matrix 1): quoted immediate UNKNOWN refuses with QUOTE_NOT_DETERMINISTIC, naming dimension and side", () => {
  const quoted = withDeterminacy(determinedEffect(1000, 120000), {
    immediateFinancialEffect: "UNKNOWN",
    recurringFinancialEffect: "DETERMINED",
  });
  assert.throws(
    () => envelopeOf(quoted, determinedEffect(1000, 120000), GENEROUS, QTY_PROPOSAL),
    isNotDeterministic("immediateFinancialEffect", "quoted")
  );
});

test("Test 35.2 (matrix 2): revalidated immediate UNKNOWN refuses, naming the compared side", () => {
  const revalidated = withDeterminacy(determinedEffect(1000, 120000), {
    immediateFinancialEffect: "UNKNOWN",
    recurringFinancialEffect: "DETERMINED",
  });
  assert.throws(
    () => envelopeOf(determinedEffect(1000, 120000), revalidated, GENEROUS, QTY_PROPOSAL),
    isNotDeterministic("immediateFinancialEffect", "compared")
  );
});

test("Test 35.3 (matrix 3): quoted recurring UNKNOWN refuses", () => {
  const quoted = withDeterminacy(determinedEffect(1000, 120000), {
    immediateFinancialEffect: "DETERMINED",
    recurringFinancialEffect: "UNKNOWN",
  });
  assert.throws(
    () => envelopeOf(quoted, determinedEffect(1000, 120000), GENEROUS, QTY_PROPOSAL),
    isNotDeterministic("recurringFinancialEffect", "quoted")
  );
});

test("Test 35.4 (matrix 4): revalidated recurring UNKNOWN refuses", () => {
  const revalidated = withDeterminacy(determinedEffect(1000, 120000), {
    immediateFinancialEffect: "DETERMINED",
    recurringFinancialEffect: "UNKNOWN",
  });
  assert.throws(
    () => envelopeOf(determinedEffect(1000, 120000), revalidated, GENEROUS, QTY_PROPOSAL),
    isNotDeterministic("recurringFinancialEffect", "compared")
  );
});

test("Test 35.5 (matrix 5): a legacy quote with NO determinacy refuses — absence of metadata is UNKNOWN, never grandfathered", () => {
  const legacyQuoted: CommercialEffect = {
    immediate: { net: 1000 },
    recurring: { resultingAmount: 120000, currency: "usd" },
  };
  assert.throws(
    () => envelopeOf(legacyQuoted, determinedEffect(1000, 120000), GENEROUS, QTY_PROPOSAL),
    isNotDeterministic()
  );
  // The audit agrees: the same pair reports WOULD_REFUSE_UNKNOWN.
  const audit = auditDeterminacy(legacyQuoted, determinedEffect(1000, 120000), "CHANGE_QUANTITY");
  assert.ok(audit.every((e) => e.findings.includes("WOULD_REFUSE_UNKNOWN")));
});

test("Test 35.6 (matrix 6): a legacy revalidation with NO determinacy refuses", () => {
  const legacyRevalidated: CommercialEffect = {
    immediate: { net: 1000 },
    recurring: { resultingAmount: 120000, currency: "usd" },
  };
  assert.throws(
    () => envelopeOf(determinedEffect(1000, 120000), legacyRevalidated, GENEROUS, QTY_PROPOSAL),
    isNotDeterministic()
  );
});

test("Test 35.7 (matrix 7): a numeric value under an explicit UNKNOWN determinacy still refuses — presence of a number is not determinacy", () => {
  const quoted = withDeterminacy(determinedEffect(1000, 120000), {
    immediateFinancialEffect: "UNKNOWN",
    recurringFinancialEffect: "UNKNOWN",
  });
  assert.equal(quoted.immediate?.net, 1000, "the number is present — and must not rescue the dimension");
  assert.throws(() => envelopeOf(quoted, quoted, GENEROUS, QTY_PROPOSAL), isNotDeterministic());
});

test("Test 35.17 (matrix 17): both sides UNKNOWN with no figures at all refuses — never a 0-vs-0 comparison", () => {
  const unknown: CommercialEffect = {
    determinacy: { immediateFinancialEffect: "UNKNOWN", recurringFinancialEffect: "UNKNOWN" },
  };
  assert.throws(() => envelopeOf(unknown, unknown, GENEROUS, QTY_PROPOSAL), isNotDeterministic());
});

// ---------------------------------------------------------------------------
// Determined values — zero is legitimate, drift still drifts (matrix 8–12, 18)
// ---------------------------------------------------------------------------

test("Test 35.8 (matrix 8): an explicit DETERMINED zero with proper provenance is accepted as a genuine zero", () => {
  assert.equal(envelopeOf(determinedEffect(0, 120000), determinedEffect(0, 120000), GENEROUS, QTY_PROPOSAL), null);
  assert.equal(envelopeOf(determinedEffect(0, 0), determinedEffect(0, 0), {}, QTY_PROPOSAL), null, "zero vs zero under zero tolerance");
});

test("Test 35.9 (matrix 9): DETERMINED nonzero within tolerance is accepted", () => {
  assert.equal(
    envelopeOf(determinedEffect(1000, 120000), determinedEffect(1500, 121000), GENEROUS, QTY_PROPOSAL),
    null
  );
});

test("Test 35.10 (matrix 10): DETERMINED outside tolerance yields the drift violation (callers map it to QUOTE_DRIFTED) — not a determinacy refusal", () => {
  const violation = envelopeOf(determinedEffect(1000, 120000), determinedEffect(50000, 120000), { maxImmediateNetIncrease: 0 }, QTY_PROPOSAL);
  assert.ok(typeof violation === "string" && violation.includes("immediate.net"), String(violation));
});

test("Test 35.11 (matrix 11): DETERMINED with an absent value refuses", () => {
  const quoted: CommercialEffect = {
    recurring: { resultingAmount: 120000, currency: "usd" },
    determinacy: { immediateFinancialEffect: "DETERMINED", recurringFinancialEffect: "DETERMINED" },
    provenance: { immediate: "claimed basis (fixture)", recurring: "per-item stated amounts (fixture)" },
  };
  assert.throws(() => envelopeOf(quoted, determinedEffect(1000, 120000), GENEROUS, QTY_PROPOSAL), isNotDeterministic("immediateFinancialEffect"));
});

test("Test 35.12 (matrix 12): DETERMINED with NaN or infinite values refuses — NaN must not drift silently through comparisons", () => {
  const nan = determinedEffect(Number.NaN, 120000);
  assert.throws(() => envelopeOf(nan, determinedEffect(0, 120000), GENEROUS, QTY_PROPOSAL), isNotDeterministic("immediateFinancialEffect"));
  const inf = determinedEffect(1000, Number.POSITIVE_INFINITY);
  assert.throws(() => envelopeOf(inf, determinedEffect(1000, 120000), GENEROUS, QTY_PROPOSAL), isNotDeterministic("recurringFinancialEffect"));
});

test("Test 35.18 (matrix 18): missing envelope bounds preserve zero-tolerance behavior on determined figures", () => {
  assert.equal(envelopeOf(determinedEffect(1000, 120000), determinedEffect(1000, 120000), {}, QTY_PROPOSAL), null);
  const violation = envelopeOf(determinedEffect(1000, 120000), determinedEffect(1001, 120000), {}, QTY_PROPOSAL);
  assert.ok(typeof violation === "string", "any immediate increase drifts under an omitted bound");
});

// ---------------------------------------------------------------------------
// NOT_APPLICABLE — licensed, cited, and validated against the proposal (13–16)
// ---------------------------------------------------------------------------

function cancelEffect(net: number | undefined, resulting: number, cited: boolean): CommercialEffect {
  return {
    ...(net !== undefined ? { immediate: { net } } : {}),
    recurring: { resultingAmount: resulting, currency: "usd" },
    determinacy: { immediateFinancialEffect: "NOT_APPLICABLE", recurringFinancialEffect: "DETERMINED" },
    provenance: {
      recurring: "post-cancellation price level (fixture)",
      ...(cited
        ? {
            applicabilityCitations: {
              immediateFinancialEffect: { action: "CANCEL" as const, dimension: "immediateFinancialEffect" as const },
            },
          }
        : {}),
    },
  };
}

test("Test 35.13 (matrix 13): N/A immediate under an authorized CANCEL context with a valid citation is SKIPPED — not compared as zero", () => {
  // Both sides assert the licensed N/A; the dimension is skipped.
  assert.equal(envelopeOf(cancelEffect(undefined, 0, true), cancelEffect(undefined, 0, true), GENEROUS, CANCEL_PROPOSAL), null);
  // A one-sided N/A (the revalidation now reports an immediate
  // charge the quote said does not arise) is a state disagreement,
  // not a zero comparison: it refuses as unenforceable.
  const oneSided = { ...determinedEffect(500, 0) };
  assert.throws(
    () => envelopeOf(cancelEffect(undefined, 0, true), oneSided, GENEROUS, CANCEL_PROPOSAL),
    isNotDeterministic("immediateFinancialEffect")
  );
});

test("Test 35.14 (matrix 14): N/A without its applicability citation refuses", () => {
  assert.throws(
    () => envelopeOf(cancelEffect(undefined, 0, false), cancelEffect(undefined, 0, false), GENEROUS, CANCEL_PROPOSAL),
    isNotDeterministic("immediateFinancialEffect")
  );
  const audit = auditDeterminacy(cancelEffect(undefined, 0, false), cancelEffect(undefined, 0, false), "CANCEL");
  assert.deepEqual(audit.find((e) => e.dimension === "immediateFinancialEffect")?.findings, ["MISSING_APPLICABILITY_PROVENANCE"]);
});

test("Test 35.15 (matrix 15): N/A on an unauthorized dimension or action refuses — recurring is never N/A; CANCEL's license covers immediate only", () => {
  const recurringNA: CommercialEffect = {
    immediate: { net: 0 },
    determinacy: { immediateFinancialEffect: "DETERMINED", recurringFinancialEffect: "NOT_APPLICABLE" },
    provenance: {
      immediate: "fixture basis",
      applicabilityCitations: {
        recurringFinancialEffect: { action: "CANCEL", dimension: "recurringFinancialEffect" },
      },
    },
  };
  assert.throws(() => envelopeOf(recurringNA, recurringNA, GENEROUS, CANCEL_PROPOSAL), isNotDeterministic("recurringFinancialEffect"));
  // The CANCEL immediate license does not transfer to a quantity change.
  assert.throws(
    () => envelopeOf(cancelEffect(undefined, 120000, true), cancelEffect(undefined, 120000, true), GENEROUS, QTY_PROPOSAL),
    isNotDeterministic("immediateFinancialEffect")
  );
});

test("Test 35.16 (matrix 16): N/A without authoritative proposal context refuses — a self-asserted citation is not context", () => {
  assert.throws(
    () => envelopeOf(cancelEffect(undefined, 0, true), cancelEffect(undefined, 0, true), GENEROUS),
    isNotDeterministic("immediateFinancialEffect")
  );
  // A multi-change proposal is not a single-CANCEL context either.
  const multi: SubscriptionChangeProposal = {
    changes: [{ action: "CANCEL" }, { action: "CHANGE_QUANTITY", itemId: "item_1", quantity: 2 }],
    effectiveIntent: { type: "IMMEDIATE" },
    guaranteeMode: "REVALIDATE",
    acceptanceEnvelope: GENEROUS,
  };
  assert.throws(
    () => envelopeOf(cancelEffect(undefined, 0, true), cancelEffect(undefined, 0, true), GENEROUS, multi),
    isNotDeterministic("immediateFinancialEffect")
  );
});

// ---------------------------------------------------------------------------
// Post-commit reconciliation — OK / VIOLATED / UNVERIFIED (matrix 21–26, 29)
// ---------------------------------------------------------------------------

test("Test 35.21 (matrix 21): quoted recurring 120000 vs committed UNKNOWN reconciles UNVERIFIED — never OK (the Topic 2 defect case)", () => {
  const committed = withDeterminacy(committedActual(1000, 120000), {
    immediateFinancialEffect: "DETERMINED",
    recurringFinancialEffect: "UNKNOWN",
  });
  delete committed.recurring;
  const result = reconcileOf(determinedEffect(1000, 120000), committed, GENEROUS, QTY_PROPOSAL);
  assert.equal(result.status, "UNVERIFIED");
  assert.ok(result.status === "UNVERIFIED" && result.undeterminedDimensions.includes("recurringFinancialEffect"));
});

test("Test 35.22 (matrix 22): committed figures numerically equal to the quote but sourced from the revalidated preview reconcile UNVERIFIED", () => {
  const committed: CommercialEffect = {
    ...determinedEffect(1000, 120000),
    provenance: {
      immediate: "the revalidated preview, relabeled (fixture)",
      recurring: "the revalidated preview, relabeled (fixture)",
      committedSource: "revalidated_preview",
    },
  };
  const result = reconcileOf(determinedEffect(1000, 120000), committed, GENEROUS, QTY_PROPOSAL);
  assert.equal(result.status, "UNVERIFIED", "preview lineage cannot establish committed actuals, even with matching numbers");
  // Gate/audit agreement: the audit names the same defect.
  const audit = auditDeterminacy(determinedEffect(1000, 120000), committed, "CHANGE_QUANTITY");
  assert.ok(audit.every((e) => e.findings.includes("PROVENANCE_NOT_ESTABLISHING")));
});

test("Test 35.23 (matrix 23): committed figures sourced from a pre-mutation estimate reconcile UNVERIFIED", () => {
  const committed: CommercialEffect = {
    ...determinedEffect(1000, 120000),
    provenance: { committedSource: "pre_mutation_estimate" },
  };
  const result = reconcileOf(determinedEffect(1000, 120000), committed, GENEROUS, QTY_PROPOSAL);
  assert.equal(result.status, "UNVERIFIED");
});

test("Test 35.24 (matrix 24): provider-actual committed figures within the envelope reconcile OK", () => {
  const result = reconcileOf(determinedEffect(1000, 120000), committedActual(1500, 121000), GENEROUS, QTY_PROPOSAL);
  assert.deepEqual(result, { status: "OK" });
});

test("Test 35.25 (matrix 25): provider-actual committed figures exceeding the envelope reconcile VIOLATED", () => {
  const result = reconcileOf(
    determinedEffect(1000, 120000),
    committedActual(50000, 120000),
    { maxImmediateNetIncrease: 0, maxImmediateCreditDecrease: 0, maxRecurringIncrease: 0 },
    QTY_PROPOSAL
  );
  assert.equal(result.status, "VIOLATED");
});

test("Test 35.26 (matrix 26): an ESTABLISHED violation in one dimension is preserved when another dimension is UNKNOWN — VIOLATED, never downgraded", () => {
  const committed = withDeterminacy(committedActual(50000, 120000), {
    immediateFinancialEffect: "DETERMINED",
    recurringFinancialEffect: "UNKNOWN",
  });
  const result = reconcileOf(
    determinedEffect(1000, 120000),
    committed,
    { maxImmediateNetIncrease: 0, maxImmediateCreditDecrease: 0, maxRecurringIncrease: 0 },
    QTY_PROPOSAL
  );
  assert.equal(result.status, "VIOLATED", "the established immediate violation stands; the unknown recurring dimension cannot wash it out");
});

test("Test 35.29 (matrix 29): an EXACT-shaped assertion without establishing evidence does not verify — committedSource unestablished reconciles UNVERIFIED", () => {
  const committed: CommercialEffect = {
    ...determinedEffect(1000, 120000),
    provenance: {
      immediate: "asserted equal to the quote (fixture)",
      recurring: "asserted equal to the quote (fixture)",
      committedSource: "unestablished",
    },
  };
  const result = reconcileOf(determinedEffect(1000, 120000), committed, GENEROUS, QTY_PROPOSAL);
  assert.equal(result.status, "UNVERIFIED");
  // And the no-envelope form cannot launder it either.
  const noEnvelope = reconcileOf(determinedEffect(1000, 120000), committed, undefined, QTY_PROPOSAL);
  assert.equal(noEnvelope.status, "UNVERIFIED");
});

// ---------------------------------------------------------------------------
// Adapter-level composition (matrix 19, 27, 28, 32, 33)
// ---------------------------------------------------------------------------

test("Test 35.19 (matrix 19): no provider mutation follows a BC-1 refusal — Stripe revalidation goes UNKNOWN after quoting", async () => {
  const { sim, sub } = freshStripeFixture();
  const store = new QuoteStore();
  const adapter = new StripeAdapter(sim, store);
  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [{ action: "CHANGE_QUANTITY", itemId: "si_1", quantity: 120 }],
    effectiveIntent: { type: "IMMEDIATE" },
    guaranteeMode: "REVALIDATE",
    acceptanceEnvelope: GENEROUS,
  });
  const fingerprintBefore = sim.fingerprint(sub.id);
  sim._debugOmitIncurredAmount = true; // commit-time revalidation can no longer establish the incurred figure
  await assert.rejects(
    () => adapter.commitChangeQuote(quote.id),
    (e: unknown) => e instanceof SCQError && e.code === "QUOTE_NOT_DETERMINISTIC"
  );
  assert.equal(sim.fingerprint(sub.id), fingerprintBefore, "provider state is unchanged after the refusal");
  assert.equal(sim.retrieve(sub.id).items[0].quantity, 100);
  assert.equal(store.get(quote.id)?.commit_receipt, undefined, "no committed receipt was created");
  assert.notEqual(store.get(quote.id)?.commit_outcome?.outcome, "INDETERMINATE", "a pre-effect refusal is not a dispatched mutation");
});

test("Test 35.33 (matrix 33): all four simulator families refuse an UNKNOWN-dimension commit before mutation, and their determined commits still reconcile OK", async () => {
  // Stripe — quote itself carries the UNKNOWN incurred figure.
  {
    const { sim, sub } = freshStripeFixture();
    sim._debugOmitIncurredAmount = true;
    const store = new QuoteStore();
    const adapter = new StripeAdapter(sim, store);
    const quote = await adapter.createChangeQuote(sub.id, {
      changes: [{ action: "CHANGE_QUANTITY", itemId: "si_1", quantity: 120 }],
      effectiveIntent: { type: "IMMEDIATE" },
      guaranteeMode: "REVALIDATE",
      acceptanceEnvelope: GENEROUS,
    });
    assert.equal(determinacyOf(quote.commercialEffect).immediateFinancialEffect, "UNKNOWN");
    await assert.rejects(() => adapter.commitChangeQuote(quote.id), (e: unknown) => e instanceof SCQError && e.code === "QUOTE_NOT_DETERMINISTIC");
    assert.equal(sim.retrieve(sub.id).items[0].quantity, 100, "stripe: no mutation");
  }
  // Paddle — preview omits the immediate transaction.
  {
    const { sim, sub } = freshPaddleFixture();
    sim._debugOmitImmediateTransaction = true;
    const store = new QuoteStore();
    const adapter = new PaddleAdapter(sim, store);
    const quote = await adapter.createChangeQuote(sub.id, {
      changes: [{ action: "CHANGE_QUANTITY", itemId: `${sub.id}_item_0`, quantity: 120 }],
      effectiveIntent: { type: "IMMEDIATE" },
      acceptanceEnvelope: GENEROUS,
    });
    await assert.rejects(() => adapter.commitChangeQuote(quote.id), (e: unknown) => e instanceof SCQError && e.code === "QUOTE_NOT_DETERMINISTIC");
    assert.equal(sim.get(sub.id).items[0].quantity, 100, "paddle: no mutation");
  }
  // Zuora — preview omits the immediate figure.
  {
    const { sim, sub } = freshZuoraFixture();
    sim._debugOmitPreviewImmediate = true;
    const store = new QuoteStore();
    const adapter = new ZuoraAdapter(sim, store);
    const quote = await adapter.createChangeQuote(sub.id, {
      changes: [{ action: "CHANGE_QUANTITY", itemId: "rpc_1", quantity: 120 }],
      effectiveIntent: { type: "IMMEDIATE" },
      acceptanceEnvelope: GENEROUS,
    });
    await assert.rejects(() => adapter.commitChangeQuote(quote.id), (e: unknown) => e instanceof SCQError && e.code === "QUOTE_NOT_DETERMINISTIC");
    assert.equal(sim.ordersFor(sub.id).length, 0, "zuora: no order dispatched");
  }
  // Chargebee simulator — estimate omits the immediate figure.
  {
    const { sim, sub } = freshChargebeeFixture();
    sim._debugOmitPreviewImmediate = true;
    const store = new QuoteStore();
    const adapter = new ChargebeeAdapter(sim, store);
    const quote = await adapter.createChangeQuote(sub.id, {
      changes: [{ action: "CHANGE_QUANTITY", itemId: "item_1", quantity: 120 }],
      effectiveIntent: { type: "IMMEDIATE" },
      acceptanceEnvelope: GENEROUS,
    });
    await assert.rejects(() => adapter.commitChangeQuote(quote.id), (e: unknown) => e instanceof SCQError && e.code === "QUOTE_NOT_DETERMINISTIC");
    assert.equal(sim.get(sub.id).subscriptionItems[0].quantity, 100, "chargebee-sim: no mutation");
  }
  // Determined happy paths still reconcile OK in every family.
  {
    const { sim, sub } = freshStripeFixture();
    const adapter = new StripeAdapter(sim, new QuoteStore());
    const q = await adapter.createChangeQuote(sub.id, {
      changes: [{ action: "CHANGE_QUANTITY", itemId: "si_1", quantity: 120 }],
      effectiveIntent: { type: "IMMEDIATE" },
      guaranteeMode: "REVALIDATE",
      acceptanceEnvelope: GENEROUS,
    });
    assert.equal((await adapter.commitChangeQuote(q.id)).reconciliation.status, "OK");
  }
  {
    const { sim, sub } = freshChargebeeFixture();
    const adapter = new ChargebeeAdapter(sim, new QuoteStore());
    const q = await adapter.createChangeQuote(sub.id, {
      changes: [{ action: "CHANGE_QUANTITY", itemId: "item_1", quantity: 120 }],
      effectiveIntent: { type: "IMMEDIATE" },
      acceptanceEnvelope: GENEROUS,
    });
    assert.equal((await adapter.commitChangeQuote(q.id)).reconciliation.status, "OK");
  }
});

test("Test 35.28 (matrix 28): EXACT equality with a provider-backed guarantee establishes the committed figures where authorized", async () => {
  // Stripe backs EXACT on every dimension for CANCEL (test17's
  // established pattern): committed := quoted by protocol definition.
  const { sim, sub } = freshStripeFixture();
  const adapter = new StripeAdapter(sim, new QuoteStore());
  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [{ action: "CANCEL" }],
    effectiveIntent: { type: "TERM_END" },
    guaranteeMode: "EXACT",
  });
  const receipt = await adapter.commitChangeQuote(quote.id);
  assert.equal(receipt.committedEffect.provenance?.committedSource, "defined_equal_exact");
  assert.equal(receipt.reconciliation.status, "OK", "EXACT's defined equality is an establishing source where the mode authorizes it");
  // Unit level: the same source establishes through reconcile directly.
  assert.deepEqual(
    reconcileOf(determinedEffect(1000, 120000), { ...determinedEffect(1000, 120000), provenance: { committedSource: "defined_equal_exact" } }, GENEROUS, QTY_PROPOSAL),
    { status: "OK" }
  );
});

test("Test 35.27 (matrix 27): a financially unverified commit is a RECEIPT (COMMITTED_UNVERIFIED), distinct from an indeterminate dispatch (no receipt)", async () => {
  // Chargebee-sim: mutation lands, its financials cannot be established.
  const { sim, sub } = freshChargebeeFixture();
  const store = new QuoteStore();
  const adapter = new ChargebeeAdapter(sim, store);
  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [{ action: "CHANGE_QUANTITY", itemId: "item_1", quantity: 120 }],
    effectiveIntent: { type: "IMMEDIATE" },
    acceptanceEnvelope: GENEROUS,
  });
  sim._debugOmitMutationFinancials = true;
  const receipt = await adapter.commitChangeQuote(quote.id);
  assert.equal(receipt.outcome, "COMMITTED_UNVERIFIED");
  assert.equal(receipt.reconciliation.status, "UNVERIFIED");
  assert.equal(store.get(quote.id)?.commit_receipt?.outcome, "COMMITTED_UNVERIFIED", "the unverified outcome is a recorded receipt");
  // Contrast: an INDETERMINATE outcome record carries NO receipt.
  store.put({
    quote_id: "q_ind",
    provider: "chargebee",
    subscription_id: sub.id,
    subscription_version_at_quote: "v1",
    proposal: QTY_PROPOSAL,
    effective_guarantee_mode: "REVALIDATE",
    guarantee_coverage: { immediateFinancialEffect: "REVALIDATE", recurringFinancialEffect: "REVALIDATE", termEffect: "UNKNOWN", effectiveAt: "REVALIDATE" },
    multi_change_consistency: "ATOMIC",
    provider_preview_input: null,
    quoted_effect: determinedEffect(1000, 120000),
    created_at: "2026-10-29T00:00:00.000Z",
    expires_at: "2026-10-29T01:00:00.000Z",
    status: "ACTIVE",
  });
  store.recordCommitOutcome("q_ind", { outcome: "INDETERMINATE", at: "2026-10-29T00:05:00.000Z" });
  assert.equal(store.get("q_ind")?.commit_receipt, undefined, "INDETERMINATE records no receipt — the classes never collapse");
});

test("Test 35.32 (matrix 32): the Chargebee-live safety gate still blocks real mutation — commit is refused unless explicitly enabled, and the env opt-in is never set by this suite", async () => {
  assert.equal(process.env.SCQ_LIVE_COMMIT_ENABLED, undefined, "the live-commit env opt-in must never be set in tests");
  const mock = new PilotMockChargebee();
  const client = new ChargebeeClient({ site: "pilot-test", apiKey: "pilot-mock-key" }, mock.transport as HttpTransport);
  const adapter = new ChargebeeLiveAdapter(client, new QuoteStore(), { liveCommitEnabled: false });
  const quote = await adapter.createChangeQuote("pilot-sub-001", {
    changes: [{ action: "CHANGE_QUANTITY", itemId: "pilot-addon-vision", quantity: 21 }],
    effectiveIntent: { type: "IMMEDIATE" },
    acceptanceEnvelope: {},
  });
  await assert.rejects(() => adapter.commitChangeQuote(quote.id));
  assert.equal(mock.mutationCount, 0, "no mutating call reached the transport");
});

// ---------------------------------------------------------------------------
// Durable composition (matrix 20, 31)
// ---------------------------------------------------------------------------

const LIVE_SUB = "pilot-sub-001";
const LIVE_PROPOSAL = {
  changes: [{ action: "CHANGE_QUANTITY" as const, itemId: "pilot-addon-vision", quantity: 21 }],
  effectiveIntent: { type: "IMMEDIATE" as const },
  acceptanceEnvelope: {},
};

function tmpDb(): string {
  return join(mkdtempSync(join(tmpdir(), "scq-bc1-")), "scq.db");
}

/**
 * A transport doctor: the FIRST estimate (quote-time) passes through
 * untouched; every later estimate (the commit-time revalidation)
 * loses its unbilled-charge amounts, so the revalidated immediate
 * figure becomes UNKNOWN after a healthy quote exists.
 */
function unknownOnRevalidation(mock: PilotMockChargebee): HttpTransport {
  let estimates = 0;
  return async (req) => {
    const res = await mock.transport(req);
    if (req.url.includes("/estimates/")) {
      estimates += 1;
      if (estimates > 1 && res.json) {
        const j = structuredClone(res.json) as {
          estimate?: { unbilled_charge_estimates?: Array<Record<string, unknown>> };
        };
        if (Array.isArray(j.estimate?.unbilled_charge_estimates)) {
          j.estimate.unbilled_charge_estimates = j.estimate.unbilled_charge_estimates.map(() => ({}));
        }
        return { ...res, json: j };
      }
    }
    return res;
  };
}

test("Test 35.20 (matrix 20): a pre-effect BC-1 refusal under durable wiring creates NO dispatch authorization and leaves NO unresolved attempt", async () => {
  const path = tmpDb();
  const mock = new PilotMockChargebee();
  const store = new DurableQuoteStore(path, { recoveryGraceMs: 0 });
  const coordinator = new DurableMutationCoordinator(store);
  const client = new ChargebeeClient({ site: "pilot-test", apiKey: "pilot-mock-key" }, unknownOnRevalidation(mock));
  const adapter = new ChargebeeLiveAdapter(client, store, {
    liveCommitEnabled: true,
    durableCoordinator: coordinator,
    providerSite: "pilot-test",
  });
  const quote = await adapter.createChangeQuote(LIVE_SUB, LIVE_PROPOSAL);
  await assert.rejects(
    () => adapter.commitChangeQuote(quote.id),
    (e: unknown) => e instanceof SCQError && e.code === "QUOTE_NOT_DETERMINISTIC"
  );
  assert.equal(mock.mutationCount, 0, "no mutating call was dispatched");
  assert.deepEqual(store.attemptsForQuote(quote.id), [], "no write-ahead attempt was ever created for a pre-effect refusal");
  store.close();

  // After a restart there is still nothing unresolved to recover,
  // and the BC-1 refusal did not poison the quote: with a healthy
  // transport the same quote proceeds exactly as a fresh quote
  // would. PR-14 MIGRATION: where that formerly meant a clean
  // commit, the quote now reaches the NEXT refusal stage — the
  // authorization preservation gate — which is itself the proof
  // the BC-1 refusal left no blocking residue (no attempt, no
  // INDETERMINATE outcome, no stale lock): a poisoned quote would
  // have failed earlier or differently.
  const store2 = new DurableQuoteStore(path, { recoveryGraceMs: 0 });
  const report = store2.recoveryReport();
  assert.ok(report.unresolvedAttempts.every((a) => a.quoteId !== quote.id), "no unresolved attempt survives the restart");
  assert.ok(report.indeterminateOutcomes.every((a) => a.quoteId !== quote.id), "the refusal is not recorded as an indeterminate dispatch");
  const client2 = new ChargebeeClient({ site: "pilot-test", apiKey: "pilot-mock-key" }, mock.transport as HttpTransport);
  const adapter2 = new ChargebeeLiveAdapter(client2, store2, {
    liveCommitEnabled: true,
    durableCoordinator: new DurableMutationCoordinator(store2),
    providerSite: "pilot-test",
  });
  await assert.rejects(
    () => adapter2.commitChangeQuote(quote.id),
    (e: unknown) => e instanceof SCQError && e.code === "AUTHORIZATION_PRESERVATION_UNENFORCEABLE",
    "the unpoisoned quote reaches the preservation gate — the current terminal refusal for live-adapter update commits",
  );
  assert.equal(mock.mutationCount, 0, "no mutation was dispatched at any point");
  store2.close();
});

test("Test 35.31 (matrix 31): a durable restart preserves UNKNOWN determinacy and the COMMITTED_UNVERIFIED outcome verbatim", async () => {
  // PR-14 MIGRATION: this row's subject is the DURABLE STORE's
  // verbatim preservation of a recorded COMMITTED_UNVERIFIED
  // receipt across a restart. Its original setup produced the
  // receipt by dispatching through the live adapter with a
  // doctored re-read (test26.10c's pattern); the adapter no longer
  // dispatches, so the receipt is seeded through the durable
  // store's own recording API with exactly the 26.10c construction
  // (immediate DETERMINED from the operation response; recurring
  // UNKNOWN with NO figure — never reconstructed). The adapter
  // commit's refusal is asserted first; every preservation
  // assertion below is the original one.
  const path = tmpDb();
  const mock = new PilotMockChargebee();
  const store = new DurableQuoteStore(path, { recoveryGraceMs: 0 });
  const client = new ChargebeeClient({ site: "pilot-test", apiKey: "pilot-mock-key" }, mock.transport as HttpTransport);
  const adapter = new ChargebeeLiveAdapter(client, store, {
    liveCommitEnabled: true,
    durableCoordinator: new DurableMutationCoordinator(store),
    providerSite: "pilot-test",
  });
  const quote = await adapter.createChangeQuote(LIVE_SUB, LIVE_PROPOSAL);
  await assert.rejects(
    () => adapter.commitChangeQuote(quote.id),
    (e: unknown) => e instanceof SCQError && e.code === "AUTHORIZATION_PRESERVATION_UNENFORCEABLE",
    "PR-14: the adapter commit itself refuses pre-dispatch — the receipt below is a store fixture",
  );
  const storedQuote = store.get(quote.id)!;
  const snapshot = await adapter.getSubscription(LIVE_SUB);
  const receipt = store.recordCommitReceipt(quote.id, {
    receiptId: "rcpt_test35_31_fixture",
    quoteId: quote.id,
    subscriptionRef: LIVE_SUB,
    status: "COMMITTED_UNVERIFIED",
    outcome: "COMMITTED_UNVERIFIED",
    resultingSnapshot: snapshot,
    quotedEffect: storedQuote.quoted_effect,
    committedEffect: {
      immediate: { net: 20000 },
      recurring: { currency: "USD" },
      determinacy: { immediateFinancialEffect: "DETERMINED", recurringFinancialEffect: "UNKNOWN" },
      provenance: { committedSource: "provider_actual" },
    },
    guaranteeMode: storedQuote.effective_guarantee_mode,
    consistencyGuarantee: "BEST_EFFORT",
    multiChangeConsistency: storedQuote.multi_change_consistency,
    reconciliation: { status: "UNVERIFIED" },
    committedAt: new Date().toISOString(),
  } as any)!;
  assert.equal(receipt.outcome, "COMMITTED_UNVERIFIED");
  assert.equal(determinacyOf(receipt.committedEffect).recurringFinancialEffect, "UNKNOWN");
  store.close();

  const reopened = new DurableQuoteStore(path, { recoveryGraceMs: 0 });
  const replayed = reopened.recordedReceipt(quote.id);
  assert.deepEqual(replayed, receipt, "the recorded receipt survives the restart byte-for-value, UNKNOWN dimensions included");
  assert.equal(replayed?.outcome, "COMMITTED_UNVERIFIED", "the restart does not upgrade the outcome");
  // And a fresh reconciliation over the preserved figures still
  // cannot manufacture an OK.
  const fresh = reconcileOf(replayed!.quotedEffect, replayed!.committedEffect, {}, LIVE_PROPOSAL_ADAPTER());
  assert.equal(fresh.status, "UNVERIFIED");
  reopened.close();
});

function LIVE_PROPOSAL_ADAPTER(): SubscriptionChangeProposal {
  return {
    changes: [{ action: "CHANGE_QUANTITY", itemId: "pilot-addon-vision", quantity: 21 }],
    effectiveIntent: { type: "IMMEDIATE" },
    guaranteeMode: "REVALIDATE",
    acceptanceEnvelope: {},
  };
}

// ---------------------------------------------------------------------------
// Replay, legacy immutability, and state/finance separation (30, 34, 35)
// ---------------------------------------------------------------------------

function legacyStoredQuote(quoteId: string): StoredQuote {
  return {
    quote_id: quoteId,
    provider: "stripe",
    subscription_id: "sub_1",
    subscription_version_at_quote: "v1",
    proposal: { changes: [{ action: "CHANGE_QUANTITY", itemId: "item_1", quantity: 2 }], effectiveIntent: { type: "IMMEDIATE" } },
    effective_guarantee_mode: "REVALIDATE",
    guarantee_coverage: { immediateFinancialEffect: "REVALIDATE", recurringFinancialEffect: "REVALIDATE", termEffect: "UNKNOWN", effectiveAt: "REVALIDATE" },
    multi_change_consistency: "ATOMIC",
    provider_preview_input: null,
    quoted_effect: { immediate: { net: 1000 }, recurring: { resultingAmount: 5000, currency: "usd" } },
    created_at: "2026-10-28T00:00:00.000Z",
    expires_at: "2026-10-28T01:00:00.000Z",
    status: "ACTIVE",
  };
}

function legacyReceipt(quoteId: string): SubscriptionChangeReceipt {
  // A v0.6.1-shaped historical record: no determinacy anywhere, no
  // outcome field, reconciliation OK as recorded at the time.
  return {
    quoteId,
    subscriptionRef: "sub_1",
    status: "COMMITTED",
    resultingSnapshot: { id: "sub_1", version: "v2", status: "active", items: [], billing: { currency: "usd" } },
    quotedEffect: { immediate: { net: 1000 }, recurring: { resultingAmount: 5000, currency: "usd" } },
    committedEffect: { immediate: { net: 1000 }, recurring: { resultingAmount: 5000, currency: "usd" } },
    guaranteeMode: "REVALIDATE",
    consistencyGuarantee: "BEST_EFFORT",
    multiChangeConsistency: "ATOMIC",
    reconciliation: { status: "OK" },
    committedAt: "2026-10-28T00:05:00.000Z",
  } as SubscriptionChangeReceipt;
}

test("Test 35.30 (matrix 30): a historical recorded receipt replays IDENTICALLY after BC-1 activation — replay performs no new financial revalidation", () => {
  const store = new QuoteStore();
  store.put(legacyStoredQuote("q_hist"));
  const original = legacyReceipt("q_hist");
  store.recordCommitReceipt("q_hist", original);
  const replayed = checkIdempotentReplay(store, "q_hist");
  assert.deepEqual(replayed, original, "§6.10 replay returns the original receipt verbatim, determinacy or not");
});

test("Test 35.35 (matrix 35): legacy payloads cannot be silently upgraded by re-serialization or restore — the record is immutable AND cannot be freshly reconciled to OK", () => {
  const store = new QuoteStore();
  store.put(legacyStoredQuote("q_hist"));
  const original = legacyReceipt("q_hist");
  store.recordCommitReceipt("q_hist", original);
  const persisted = store.serializeReceiptRecords();

  const restored = new QuoteStore();
  restored.put(legacyStoredQuote("q_hist"));
  restored.restoreReceiptRecords(persisted);
  const record = restored.get("q_hist")!.commit_receipt_recorded!;
  assert.deepEqual(record, original, "restore preserves the historical record exactly — neither upgraded nor rewritten");
  // But a FRESH reconciliation over those legacy figures is not OK:
  // the figures carry no determinacy and no establishing source.
  const fresh = reconcileOf(record.quotedEffect, record.committedEffect, GENEROUS, QTY_PROPOSAL);
  assert.equal(fresh.status, "UNVERIFIED", "a legacy record stays valid history; it is never re-derived as reconciled OK");
});

test("Test 35.34 (matrix 34): a VERIFIED state verdict does not establish financial actuals — establishment still refuses UNKNOWN committed figures", () => {
  const store = new QuoteStore();
  const stored: StoredQuote = {
    ...legacyStoredQuote("q_sv"),
    proposal: {
      changes: [{ action: "CHANGE_QUANTITY", itemId: "item_1", quantity: 2 }],
      effectiveIntent: { type: "IMMEDIATE" },
      acceptanceEnvelope: GENEROUS,
    },
    quoted_effect: determinedEffect(1000, 5000),
  };
  store.put(stored);
  store.recordCommitReceipt("q_sv", {
    ...legacyReceipt("q_sv"),
    status: "COMMITTED_UNVERIFIED",
    outcome: "COMMITTED_UNVERIFIED",
    quotedEffect: determinedEffect(1000, 5000),
    committedEffect: {
      immediate: { net: 1000 },
      recurring: { resultingAmount: 5000, currency: "usd" },
      determinacy: { immediateFinancialEffect: "UNKNOWN", recurringFinancialEffect: "UNKNOWN" },
      provenance: { committedSource: "unestablished" },
    },
    reconciliation: { status: "UNVERIFIED", reason: "figures unestablished", undeterminedDimensions: ["immediateFinancialEffect", "recurringFinancialEffect"] },
  });

  // The state hook, given a snapshot matching the intent, verifies
  // the STATE — that verdict is genuine and stays independent.
  const stateVerdict = verifyPostCommitState(
    { proposal: stored.proposal },
    {
      snapshot: {
        id: "sub_1",
        version: "v2",
        status: "active",
        items: [{ id: "item_1", offeringRef: "plan", quantity: 2 }],
        billing: { currency: "usd" },
      },
      source: "fixture post-commit read",
    }
  );
  assert.equal(stateVerdict.verdict, "VERIFIED");
  assert.equal(stateVerdict.financialOutcomeEstablished, false, "the state verdict structurally cannot assert financial establishment");

  // An observation with the same matching state but UNKNOWN
  // committed figures (provider_actual label, no determinacy)
  // produces evidence whose reconciliation is UNVERIFIED — so the
  // verification transition refuses it: state VERIFIED, finances
  // unestablished, no upgrade.
  const evidence = establishVerification(store.get("q_sv")!, {
    subscriptionRef: "sub_1",
    source: "fixture post-commit provider read",
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
  assert.equal(evidence.stateVerification, "VERIFIED");
  assert.equal(evidence.reconciliation.status, "UNVERIFIED", "financial reconciliation is computed from financial evidence alone");
  assert.throws(() => store.verifyCommitReceipt("q_sv", evidence), /determined reconciliation/);
  assert.equal(store.get("q_sv")!.commit_receipt?.outcome, "COMMITTED_UNVERIFIED", "no transition occurred");
});

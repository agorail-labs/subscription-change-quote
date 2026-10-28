import { test } from "node:test";
import assert from "node:assert/strict";
import { QuoteStore, establishVerification } from "../src/store/quote-store.js";
import { StripeAdapter } from "../src/adapters/stripe-adapter.js";
import { StripeSim, type StripeSubscription } from "../src/adapters/stripe-sim.js";
import { auditDeterminacy, determinacyOf } from "../src/core/scq-engine.js";
import { SCQError, type CommercialEffect } from "../src/core/types.js";
import { freshStripeFixture } from "./fixtures.js";

// SCQ v0.6.2 — PR-3: Stripe SIMULATOR migration conformance tests.
//
// Everything in this file runs against the in-memory Stripe simulator
// (StripeSim). All results are SIMULATED — no live Stripe API is
// involved. Post-commit "observations" constructed in these tests
// from simulator reads are SYNTHETIC simulator observations: they
// exercise the PR-1 establishment machinery's shape, and the branded
// evidence token is never treated as proof that an observation
// genuinely came from a provider (see establishVerification's own
// statement of that limit in quote-store.ts).
//
// The migration contract under test (issue #7 / v0.6.2 design
// Topics 1–5, adapter migration matrix Row 1):
//   - `immediate` is ONLY the net obligation the change itself
//     incurs at its effective time. The simulator preview's
//     `amount_due` is a payment figure (incurred minus applied
//     customer balance) and must NEVER be mapped into `immediate`;
//     it lives, labeled, in providerMetadata.nextInvoiceEstimate.
//   - Every effect carries explicit determinacy + provenance. A
//     genuinely determined zero is numeric 0 under DETERMINED; a
//     figure the simulator cannot establish is UNKNOWN — never
//     zero-filled, never silently dropped.
//   - Committed effects are established from post-commit state
//     read back after the mutation (provider_actual), never by
//     assigning the revalidated preview. Landing established +
//     finances unverified => COMMITTED_UNVERIFIED. An established
//     state MISMATCH is a determined negative verification
//     (VIOLATED), never collapsed into UNVERIFIED (Decision D3).
//   - BC-1 remains INACTIVE in this PR: checkAcceptanceEnvelope
//     keeps its v0.6.1 semantics (pinned by test14 §14.6); the
//     determinacy audit is used here report-only.

const GENEROUS_ENVELOPE = {
  maxImmediateNetIncrease: 1_000_000,
  maxImmediateCreditDecrease: 1_000_000,
  maxRecurringIncrease: 1_000_000,
};

/** Standard fixture plus a pre-existing customer credit balance (minor units). */
function stripeWithBalance(customerBalance: number): { sim: StripeSim; sub: StripeSubscription } {
  const { sim, sub } = freshStripeFixture();
  sub.customer_balance = customerBalance;
  sim.seedSubscription(sub);
  return { sim, sub };
}

type NextInvoiceEstimate = {
  amountDue: number;
  customerBalanceApplied: number;
  nextPeriodRecurringAmount: number;
};

function nextInvoiceEstimate(quote: { providerMetadata?: unknown }): NextInvoiceEstimate {
  const md = quote.providerMetadata as { nextInvoiceEstimate?: NextInvoiceEstimate };
  assert.ok(md?.nextInvoiceEstimate, "quote providerMetadata must carry a labeled nextInvoiceEstimate");
  return md.nextInvoiceEstimate;
}

// ---------------------------------------------------------------------------
// Family 1: amount_due differs from the incurred obligation
// ---------------------------------------------------------------------------

test("Test 17.1 (family 1): amount_due != incurred — immediate carries the incurred obligation only; amount_due is metadata", async () => {
  // Worked example: 100 seats @ 1000 minor units, quoted at the period
  // start (full period remaining), quantity 100 -> 120. Proration
  // incurred = 20 x 1000 x 1.0 = 20000. A pre-existing customer
  // balance of 5000 is applied against the upcoming invoice, so the
  // preview's amount_due is 15000 — a PAYMENT figure. The incurred
  // obligation is 20000 regardless of the balance.
  const { sim, sub } = stripeWithBalance(5000);
  const adapter = new StripeAdapter(sim, new QuoteStore());

  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [{ action: "CHANGE_QUANTITY", itemId: "si_1", quantity: 120 }],
    effectiveIntent: { type: "IMMEDIATE" },
    guaranteeMode: "REVALIDATE",
    acceptanceEnvelope: GENEROUS_ENVELOPE,
  });

  assert.equal(quote.commercialEffect.immediate?.net, 20000, "immediate.net is the incurred obligation (proration lines total)");
  assert.equal(quote.commercialEffect.immediate?.charge, 20000);
  assert.equal(quote.commercialEffect.recurring?.resultingAmount, 120000);

  const estimate = nextInvoiceEstimate(quote);
  assert.equal(estimate.amountDue, 15000, "amount_due = incurred - applied customer balance (metadata only)");
  assert.equal(estimate.customerBalanceApplied, 5000);
  assert.equal(estimate.nextPeriodRecurringAmount, 120000, "next-invoice totals stay in metadata, out of the effect");

  // Determinacy + provenance are explicit, and the audit is clean.
  assert.deepEqual(determinacyOf(quote.commercialEffect), {
    immediateFinancialEffect: "DETERMINED",
    recurringFinancialEffect: "DETERMINED",
  });
  assert.ok(quote.commercialEffect.provenance?.immediate, "immediate provenance recorded");
  assert.ok(quote.commercialEffect.provenance?.recurring, "recurring provenance recorded");
  const audit = auditDeterminacy(quote.commercialEffect, quote.commercialEffect, "CHANGE_QUANTITY");
  assert.ok(audit.every((e) => e.findings.length === 0), JSON.stringify(audit));
});

// ---------------------------------------------------------------------------
// Family 2: customer credits change amount due, never the incurred obligation
// ---------------------------------------------------------------------------

test("Test 17.2 (family 2): customer credits move amount_due only — incurred and recurring are credit-invariant", async () => {
  const noBalance = stripeWithBalance(0);
  const withBalance = stripeWithBalance(8000);
  const proposal = {
    changes: [{ action: "CHANGE_QUANTITY" as const, itemId: "si_1", quantity: 120 }],
    effectiveIntent: { type: "IMMEDIATE" as const },
    guaranteeMode: "REVALIDATE" as const,
    acceptanceEnvelope: GENEROUS_ENVELOPE,
  };
  const q1 = await new StripeAdapter(noBalance.sim, new QuoteStore()).createChangeQuote(noBalance.sub.id, proposal);
  const q2 = await new StripeAdapter(withBalance.sim, new QuoteStore()).createChangeQuote(withBalance.sub.id, proposal);

  assert.equal(q1.commercialEffect.immediate?.net, 20000);
  assert.equal(q2.commercialEffect.immediate?.net, 20000, "an 8000 credit balance does not change the incurred obligation");
  assert.equal(q2.commercialEffect.recurring?.resultingAmount, q1.commercialEffect.recurring?.resultingAmount, "credits never leak into recurring (a credit movement is not a price change)");
  assert.equal(nextInvoiceEstimate(q1).amountDue, 20000);
  assert.equal(nextInvoiceEstimate(q2).amountDue, 12000, "only the payment figure moved");
});

// ---------------------------------------------------------------------------
// Family 3: genuine zero versus missing values
// ---------------------------------------------------------------------------

test("Test 17.3 (family 3): a genuinely determined zero is present as numeric 0 under DETERMINED — never dropped to absence", async () => {
  const { sim, sub } = freshStripeFixture();
  const adapter = new StripeAdapter(sim, new QuoteStore());

  // Quantity "change" to the same quantity: the preview generates no
  // proration lines, so the incurred obligation is a true zero.
  const zeroQuote = await adapter.createChangeQuote(sub.id, {
    changes: [{ action: "CHANGE_QUANTITY", itemId: "si_1", quantity: 100 }],
    effectiveIntent: { type: "IMMEDIATE" },
    guaranteeMode: "REVALIDATE",
    acceptanceEnvelope: GENEROUS_ENVELOPE,
  });
  assert.ok(zeroQuote.commercialEffect.immediate, "a determined zero immediate must be PRESENT (CORE-1 purity; the v0.6.1 combineEffects zero-drop is a conformance bug)");
  assert.equal(zeroQuote.commercialEffect.immediate?.net, 0);
  assert.equal(determinacyOf(zeroQuote.commercialEffect).immediateFinancialEffect, "DETERMINED");

  // Multi-change batch whose prorations net to exactly zero:
  // +5 seats on si_1 (+5000) and a plan downgrade on si_2 (pro->basic,
  // -500/seat x 10 = -5000). The combined zero must survive aggregation.
  const sim2 = new StripeSim(Math.floor(new Date("2026-08-01T00:00:00Z").getTime() / 1000));
  const start = sim2.currentTime();
  const twoItem: StripeSubscription = {
    id: "sub_two_item",
    status: "active",
    items: [
      { id: "si_1", price: { id: "price_seat_basic", unitAmount: 1000, currency: "usd", interval: "month" }, quantity: 100 },
      { id: "si_2", price: { id: "price_seat_pro", unitAmount: 1500, currency: "usd", interval: "month" }, quantity: 10 },
    ],
    current_period_start: start,
    current_period_end: start + 30 * 24 * 3600,
    cancel_at_period_end: false,
  };
  sim2.seedSubscription(twoItem);
  const adapter2 = new StripeAdapter(sim2, new QuoteStore());
  const nettingQuote = await adapter2.createChangeQuote(twoItem.id, {
    changes: [
      { action: "CHANGE_QUANTITY", itemId: "si_1", quantity: 105 },
      { action: "CHANGE_PLAN", itemId: "si_2", offeringRef: "plan:basic:monthly" },
    ],
    effectiveIntent: { type: "IMMEDIATE" },
    guaranteeMode: "REVALIDATE",
    acceptanceEnvelope: GENEROUS_ENVELOPE,
  });
  assert.equal(nettingQuote.commercialEffect.immediate?.net, 0, "prorations netting to zero combine to a PRESENT determined zero");
  assert.equal(determinacyOf(nettingQuote.commercialEffect).immediateFinancialEffect, "DETERMINED");
});

// ---------------------------------------------------------------------------
// Family 4: UNKNOWN propagation (simulator withholds the incurred figure)
// ---------------------------------------------------------------------------

test("Test 17.4 (family 4): a withheld incurred figure propagates as UNKNOWN — no fabricated zero, audit reports WOULD_REFUSE_UNKNOWN", async () => {
  const { sim, sub } = freshStripeFixture();
  sim._debugOmitIncurredAmount = true; // fault injection: previews cannot establish the incurred amount
  const adapter = new StripeAdapter(sim, new QuoteStore());

  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [{ action: "CHANGE_QUANTITY", itemId: "si_1", quantity: 120 }],
    effectiveIntent: { type: "IMMEDIATE" },
    guaranteeMode: "REVALIDATE",
    acceptanceEnvelope: GENEROUS_ENVELOPE,
  });

  assert.equal(quote.commercialEffect.immediate, undefined, "an unestablishable immediate is ABSENT — never zero-filled");
  assert.deepEqual(determinacyOf(quote.commercialEffect), {
    immediateFinancialEffect: "UNKNOWN",
    recurringFinancialEffect: "DETERMINED",
  });
  const audit = auditDeterminacy(quote.commercialEffect, quote.commercialEffect, "CHANGE_QUANTITY");
  assert.deepEqual(audit.find((e) => e.dimension === "immediateFinancialEffect")?.findings, ["WOULD_REFUSE_UNKNOWN"]);
  assert.deepEqual(audit.find((e) => e.dimension === "recurringFinancialEffect")?.findings, []);
});

// ---------------------------------------------------------------------------
// Family 5: NOT_APPLICABLE — unjustified rejected by the audit; the
// adapter's CANCEL assertion is licensed and cited
// ---------------------------------------------------------------------------

test("Test 17.5 (family 5): unjustified NOT_APPLICABLE is rejected by the audit; the Stripe CANCEL quote's N/A is licensed", async () => {
  const unjustified: CommercialEffect = {
    recurring: { resultingAmount: 120000, currency: "usd" },
    determinacy: { immediateFinancialEffect: "NOT_APPLICABLE", recurringFinancialEffect: "DETERMINED" },
    provenance: {
      recurring: "per-item stated amounts",
      applicabilityCitations: { immediateFinancialEffect: { action: "CHANGE_QUANTITY", dimension: "immediateFinancialEffect" } },
    },
  };
  const bad = auditDeterminacy(unjustified, unjustified, "CHANGE_QUANTITY");
  assert.deepEqual(bad.find((e) => e.dimension === "immediateFinancialEffect")?.findings, ["UNJUSTIFIED_NOT_APPLICABLE"]);

  // The adapter's own CANCEL quote: immediate NOT_APPLICABLE under the
  // §3.10 license (CANCEL x immediate), cited; recurring is a
  // DETERMINED zero (the post-cancellation price level) — never N/A.
  const { sim, sub } = freshStripeFixture();
  const adapter = new StripeAdapter(sim, new QuoteStore());
  const cancelQuote = await adapter.createChangeQuote(sub.id, {
    changes: [{ action: "CANCEL" }],
    effectiveIntent: { type: "TERM_END" },
  });
  assert.equal(determinacyOf(cancelQuote.commercialEffect).immediateFinancialEffect, "NOT_APPLICABLE");
  assert.equal(determinacyOf(cancelQuote.commercialEffect).recurringFinancialEffect, "DETERMINED");
  assert.equal(cancelQuote.commercialEffect.recurring?.resultingAmount, 0);
  assert.deepEqual(
    cancelQuote.commercialEffect.provenance?.applicabilityCitations?.immediateFinancialEffect,
    { action: "CANCEL", dimension: "immediateFinancialEffect" }
  );
  const clean = auditDeterminacy(cancelQuote.commercialEffect, cancelQuote.commercialEffect, "CANCEL");
  assert.ok(clean.every((e) => e.findings.length === 0), JSON.stringify(clean));
});

// ---------------------------------------------------------------------------
// Family 6: valid versus invalid financial provenance
// ---------------------------------------------------------------------------

test("Test 17.6 (family 6): DETERMINED without provenance is a finding; the adapter's effects carry establishing provenance", async () => {
  const bare: CommercialEffect = {
    immediate: { net: 20000 },
    recurring: { resultingAmount: 120000, currency: "usd" },
    determinacy: { immediateFinancialEffect: "DETERMINED", recurringFinancialEffect: "DETERMINED" },
  };
  const bareAudit = auditDeterminacy(bare, bare, "CHANGE_QUANTITY");
  assert.deepEqual(bareAudit.find((e) => e.dimension === "immediateFinancialEffect")?.findings, ["MISSING_PROVENANCE"]);
  assert.deepEqual(bareAudit.find((e) => e.dimension === "recurringFinancialEffect")?.findings, ["MISSING_PROVENANCE"]);

  const { sim, sub } = freshStripeFixture();
  const adapter = new StripeAdapter(sim, new QuoteStore());
  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [{ action: "CHANGE_QUANTITY", itemId: "si_1", quantity: 120 }],
    effectiveIntent: { type: "IMMEDIATE" },
    guaranteeMode: "REVALIDATE",
    acceptanceEnvelope: GENEROUS_ENVELOPE,
  });
  const receipt = await adapter.commitChangeQuote(quote.id);
  const committedAudit = auditDeterminacy(quote.commercialEffect, receipt.committedEffect, "CHANGE_QUANTITY");
  assert.ok(committedAudit.every((e) => e.findings.length === 0), JSON.stringify(committedAudit));
});

// ---------------------------------------------------------------------------
// Family 7: preview-derived committed figures do not qualify as actuals
// ---------------------------------------------------------------------------

test("Test 17.7 (family 7): revalidated-preview lineage never establishes committed actuals (audit + establishment refusal)", async () => {
  const previewDerived: CommercialEffect = {
    immediate: { net: 20000 },
    recurring: { resultingAmount: 120000, currency: "usd" },
    determinacy: { immediateFinancialEffect: "DETERMINED", recurringFinancialEffect: "DETERMINED" },
    provenance: { immediate: "revalidated preview total", recurring: "revalidated preview total", committedSource: "revalidated_preview" },
  };
  const audit = auditDeterminacy(previewDerived, previewDerived, "CHANGE_QUANTITY");
  assert.deepEqual(audit.find((e) => e.dimension === "immediateFinancialEffect")?.findings, ["PROVENANCE_NOT_ESTABLISHING"]);
  assert.deepEqual(audit.find((e) => e.dimension === "recurringFinancialEffect")?.findings, ["PROVENANCE_NOT_ESTABLISHING"]);

  // Establishment refuses an observation whose figures are the
  // revalidated preview, and refuses the quote's own effect relabeled.
  const { sim, sub } = freshStripeFixture();
  const store = new QuoteStore();
  const adapter = new StripeAdapter(sim, store);
  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [{ action: "CHANGE_QUANTITY", itemId: "si_1", quantity: 120 }],
    effectiveIntent: { type: "IMMEDIATE" },
    guaranteeMode: "REVALIDATE",
    acceptanceEnvelope: GENEROUS_ENVELOPE,
  });
  const stored = store.get(quote.id)!;
  assert.throws(
    () => establishVerification(stored, { subscriptionRef: sub.id, committedEffect: previewDerived, source: "test fixture (synthetic)" }),
    /Establishment refused/
  );
  assert.throws(
    () =>
      establishVerification(stored, {
        subscriptionRef: sub.id,
        committedEffect: stored.quoted_effect,
        source: "test fixture (synthetic)",
      }),
    /Establishment refused/
  );
});

// ---------------------------------------------------------------------------
// Family 8: independently observed post-mutation changes
// ---------------------------------------------------------------------------

test("Test 17.8 (family 8): committed actuals come from the post-commit read — not the quote-time preview, not the revalidated preview", async () => {
  const { sim, sub } = freshStripeFixture();
  const adapter = new StripeAdapter(sim, new QuoteStore());

  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [{ action: "CHANGE_QUANTITY", itemId: "si_1", quantity: 120 }],
    effectiveIntent: { type: "IMMEDIATE" },
    guaranteeMode: "REVALIDATE",
    acceptanceEnvelope: GENEROUS_ENVELOPE,
  });
  assert.equal(quote.commercialEffect.immediate?.net, 20000, "quoted at day 0 with the full period remaining");

  sim.advanceTimeSeconds(15 * 24 * 3600); // half the period elapses before commit

  const receipt = await adapter.commitChangeQuote(quote.id);
  assert.equal(receipt.status, "COMMITTED");
  assert.equal(receipt.outcome, "COMMITTED_AND_VERIFIED");
  assert.equal(receipt.reconciliation.status, "OK");
  assert.equal(receipt.committedEffect.provenance?.committedSource, "provider_actual");
  assert.deepEqual(determinacyOf(receipt.committedEffect), {
    immediateFinancialEffect: "DETERMINED",
    recurringFinancialEffect: "DETERMINED",
  });
  // Half the period remained at mutation time: incurred = 20 x 1000 x 0.5.
  assert.equal(receipt.committedEffect.immediate?.net, 10000, "the committed figure is the mutation's own incurred amount, read back post-commit");
  assert.equal(receipt.committedEffect.recurring?.resultingAmount, 120000);
  assert.equal(receipt.quotedEffect.immediate?.net, 20000, "the quoted effect remains the untouched historical record");

  // Independent test-side read of the simulator's post-commit state
  // (SYNTHETIC simulator observation): the invoice the mutation
  // generated, read back through the sim's invoice read path, agrees
  // with the receipt — the adapter's figures are the read-back
  // actuals, not a preview object it held onto.
  const readSub = sim.retrieve(sub.id);
  const generatedInvoice = sim.retrieveInvoice(readSub.latest_invoice!);
  assert.equal(generatedInvoice.incurred_amount, receipt.committedEffect.immediate?.net);
});

// ---------------------------------------------------------------------------
// Family 9: state MISMATCH versus UNVERIFIABLE state (Decision D3)
// ---------------------------------------------------------------------------

test("Test 17.9 (family 9): an established state mismatch is VIOLATED on a COMMITTED receipt — never collapsed into UNVERIFIED", async () => {
  const { sim, sub } = freshStripeFixture();
  const adapter = new StripeAdapter(sim, new QuoteStore());
  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [{ action: "CHANGE_QUANTITY", itemId: "si_1", quantity: 120 }],
    effectiveIntent: { type: "IMMEDIATE" },
    guaranteeMode: "REVALIDATE",
    acceptanceEnvelope: GENEROUS_ENVELOPE,
  });

  // A concurrent write lands in the BEST_EFFORT window AFTER the
  // adapter's mutation returns but BEFORE its post-commit read
  // (the test7 wrapping pattern): observed state contradicts intent.
  const realUpdate = sim.update.bind(sim);
  sim.update = ((...args: Parameters<typeof realUpdate>) => {
    const result = realUpdate(...args);
    sim._debugMutateDirectly(sub.id, (s) => {
      s.items[0].quantity = 999;
    });
    return result;
  }) as typeof realUpdate;

  const receipt = await adapter.commitChangeQuote(quote.id);
  assert.equal(receipt.status, "COMMITTED", "a determined mismatch is recorded on a verified-class receipt, not as unverified");
  assert.equal(receipt.outcome, "COMMITTED_AND_VERIFIED");
  assert.equal(receipt.reconciliation.status, "VIOLATED", "mismatch is a determined NEGATIVE verification (D3)");
  assert.ok(
    receipt.reconciliation.status === "VIOLATED" && /mismatch/i.test(receipt.reconciliation.reason),
    "the violation reason names the state mismatch"
  );
  assert.equal(receipt.committedEffect.recurring?.resultingAmount, 999 * 1000, "the committed figures honestly report the observed state");
});

test("Test 17.9b (family 9): an unobservable post-commit state is UNVERIFIABLE — establishment computes it, callers never assert it", async () => {
  const { sim, sub } = freshStripeFixture();
  const store = new QuoteStore();
  const adapter = new StripeAdapter(sim, store);
  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [{ action: "CHANGE_QUANTITY", itemId: "si_1", quantity: 120 }],
    effectiveIntent: { type: "IMMEDIATE" },
    guaranteeMode: "REVALIDATE",
    acceptanceEnvelope: GENEROUS_ENVELOPE,
  });
  const stored = store.get(quote.id)!;
  // SYNTHETIC observation with establishing figures but NO resulting
  // snapshot: the state check has nothing to read.
  const token = establishVerification(stored, {
    subscriptionRef: sub.id,
    committedEffect: {
      immediate: { net: 20000 },
      recurring: { resultingAmount: 120000, currency: "usd" },
      determinacy: { immediateFinancialEffect: "DETERMINED", recurringFinancialEffect: "DETERMINED" },
      provenance: { immediate: "synthetic fixture", recurring: "synthetic fixture", committedSource: "provider_actual" },
    },
    source: "test fixture (synthetic simulator observation)",
  });
  assert.equal(token.stateVerification, "UNVERIFIABLE");
});

// ---------------------------------------------------------------------------
// Family 10: COMMITTED_UNVERIFIED recording, §6.10 original-receipt
// replay, and deferred verification through establishVerification
// ---------------------------------------------------------------------------

test("Test 17.10 (family 10): unverifiable finances record COMMITTED_UNVERIFIED; replay returns the ORIGINAL receipt even after later verification", async () => {
  const { sim, sub } = freshStripeFixture();
  const store = new QuoteStore();
  const adapter = new StripeAdapter(sim, store);
  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [{ action: "CHANGE_QUANTITY", itemId: "si_1", quantity: 120 }],
    effectiveIntent: { type: "IMMEDIATE" },
    guaranteeMode: "REVALIDATE",
    acceptanceEnvelope: GENEROUS_ENVELOPE,
  });

  // The mutation lands, but the post-commit invoice read is
  // unavailable (fault injection): landing is established from the
  // mutation response, financial verification is not.
  sim._debugFailInvoiceReads = true;
  const first = await adapter.commitChangeQuote(quote.id);
  assert.equal(first.status, "COMMITTED_UNVERIFIED");
  assert.equal(first.outcome, "COMMITTED_UNVERIFIED");
  assert.equal(first.reconciliation.status, "UNVERIFIED");
  assert.equal(first.committedEffect.immediate?.net, 20000, "the mutation response's candidate figures are recorded — as UNVERIFIED, not as actuals");
  assert.equal(first.committedEffect.provenance?.committedSource, "unestablished");
  assert.deepEqual(determinacyOf(first.committedEffect), {
    immediateFinancialEffect: "UNKNOWN",
    recurringFinancialEffect: "UNKNOWN",
  });
  assert.equal((await adapter.getSubscription(sub.id)).items[0].quantity, 120, "the change did land provider-side");

  // §6.10: a repeated commit returns the ORIGINAL receipt.
  const replay = await adapter.commitChangeQuote(quote.id);
  assert.deepEqual(replay, first);

  // Deferred verification: an independent post-commit observation
  // (SYNTHETIC — built here from the test's own simulator reads)
  // establishes verification through the PR-1 machinery.
  sim._debugFailInvoiceReads = false;
  const readSub = sim.retrieve(sub.id);
  const invoice = sim.retrieveInvoice(readSub.latest_invoice!);
  const snapshot = await adapter.getSubscription(sub.id);
  const evidence = establishVerification(store.get(quote.id)!, {
    subscriptionRef: sub.id,
    committedEffect: {
      immediate: { net: invoice.incurred_amount },
      recurring: { resultingAmount: readSub.items.reduce((s, i) => s + i.price.unitAmount * i.quantity, 0), currency: "usd" },
      determinacy: { immediateFinancialEffect: "DETERMINED", recurringFinancialEffect: "DETERMINED" },
      provenance: {
        immediate: "post-commit generated invoice read back from the simulator (synthetic observation)",
        recurring: "post-commit subscription state read back from the simulator (synthetic observation)",
        committedSource: "provider_actual",
      },
    },
    resultingSnapshot: snapshot,
    source: "test-side simulator reads (synthetic observation)",
  });
  const verified = store.verifyCommitReceipt(quote.id, evidence);
  assert.equal(verified.status, "COMMITTED");
  assert.equal(verified.outcome, "COMMITTED_AND_VERIFIED");
  assert.equal(verified.reconciliation.status, "OK");

  // Replay STILL returns the original (unverified) receipt; the
  // verified state is visible only through the current-view read.
  const replayAfterVerify = await adapter.commitChangeQuote(quote.id);
  assert.deepEqual(replayAfterVerify, first, "§6.10: replay returns the receipt as originally recorded, not the verified view");
  assert.equal(store.get(quote.id)!.commit_receipt?.reconciliation.status, "OK");
});

// ---------------------------------------------------------------------------
// Family 11: indeterminate mutation and unsafe-retry refusal
// ---------------------------------------------------------------------------

test("Test 17.11 (family 11): a lost mutation response is INDETERMINATE — no receipt, and a retry is refused without re-mutating", async () => {
  const { sim, sub } = freshStripeFixture();
  const store = new QuoteStore();
  const adapter = new StripeAdapter(sim, store);
  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [{ action: "CHANGE_QUANTITY", itemId: "si_1", quantity: 120 }],
    effectiveIntent: { type: "IMMEDIATE" },
    guaranteeMode: "REVALIDATE",
    acceptanceEnvelope: GENEROUS_ENVELOPE,
  });

  let updateCalls = 0;
  const realUpdate = sim.update.bind(sim);
  sim.update = ((...args: Parameters<typeof realUpdate>) => {
    updateCalls++;
    return realUpdate(...args);
  }) as typeof realUpdate;
  sim._debugLoseNextUpdateResponse = true; // the mutation applies, then the response is lost

  await assert.rejects(
    () => adapter.commitChangeQuote(quote.id),
    (err: unknown) => {
      assert.ok(err instanceof SCQError);
      assert.equal((err.details as { outcome?: string })?.outcome, "INDETERMINATE");
      return true;
    }
  );
  const stored = store.get(quote.id)!;
  assert.equal(stored.commit_outcome?.outcome, "INDETERMINATE", "the attempt's outcome is recorded (CORE-8) even though no receipt exists");
  assert.equal(stored.commit_receipt, undefined, "no receipt is recorded for an indeterminate attempt");
  assert.equal(stored.status, "ACTIVE");
  assert.equal((await adapter.getSubscription(sub.id)).items[0].quantity, 120, "the mutation DID land — which is exactly why a blind retry would be unsafe");

  await assert.rejects(
    () => adapter.commitChangeQuote(quote.id),
    (err: unknown) => err instanceof SCQError && (err.details as { outcome?: string })?.outcome === "INDETERMINATE"
  );
  assert.equal(updateCalls, 1, "the retry was refused BEFORE any second mutation call");
  assert.equal((await adapter.getSubscription(sub.id)).items[0].quantity, 120);
});

// ---------------------------------------------------------------------------
// Family 12: multi-change consistency and EXACT/REVALIDATE guarantees
// ---------------------------------------------------------------------------

test("Test 17.12 (family 12): multi-change commit verifies against post-commit state; EXACT cancel keeps defined equality; REVALIDATE drift still refuses pre-mutation", async () => {
  // Multi-change (quantity + plan on the same item, one ATOMIC call):
  // the committed actuals are computed by the mutation itself from
  // the final item set — incurred = 1500x120 - 1000x100 = 80000.
  const { sim, sub } = freshStripeFixture();
  const adapter = new StripeAdapter(sim, new QuoteStore());
  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [
      { action: "CHANGE_QUANTITY", itemId: "si_1", quantity: 120 },
      { action: "CHANGE_PLAN", itemId: "si_1", offeringRef: "plan:pro:monthly" },
    ],
    effectiveIntent: { type: "IMMEDIATE" },
    guaranteeMode: "REVALIDATE",
    acceptanceEnvelope: GENEROUS_ENVELOPE,
  });
  assert.equal(quote.multiChangeConsistency, "ATOMIC");
  const receipt = await adapter.commitChangeQuote(quote.id);
  assert.equal(receipt.status, "COMMITTED");
  assert.equal(receipt.outcome, "COMMITTED_AND_VERIFIED");
  assert.equal(receipt.committedEffect.immediate?.net, 80000);
  assert.equal(receipt.committedEffect.recurring?.resultingAmount, 1500 * 120);
  assert.equal(receipt.resultingSnapshot.items[0].quantity, 120);
  assert.equal(receipt.resultingSnapshot.items[0].offeringRef, "plan:pro:monthly");

  // EXACT (CANCEL — the action whose coverage is EXACT on every
  // dimension): committed := quoted BY PROTOCOL DEFINITION.
  const f2 = freshStripeFixture();
  const adapter2 = new StripeAdapter(f2.sim, new QuoteStore());
  const cancelQuote = await adapter2.createChangeQuote(f2.sub.id, {
    changes: [{ action: "CANCEL" }],
    effectiveIntent: { type: "TERM_END" },
    guaranteeMode: "EXACT",
  });
  const cancelReceipt = await adapter2.commitChangeQuote(cancelQuote.id);
  assert.equal(cancelReceipt.status, "COMMITTED");
  assert.equal(cancelReceipt.committedEffect.provenance?.committedSource, "defined_equal_exact");
  assert.equal(cancelReceipt.committedEffect.recurring?.resultingAmount, 0);
  assert.equal(cancelReceipt.resultingSnapshot.term?.autoRenew, false);

  // REVALIDATE drift refusal is unchanged: zero-tolerance envelope,
  // time passes, commit refuses BEFORE mutating.
  const f3 = freshStripeFixture();
  const adapter3 = new StripeAdapter(f3.sim, new QuoteStore());
  const driftQuote = await adapter3.createChangeQuote(f3.sub.id, {
    changes: [{ action: "CHANGE_QUANTITY", itemId: "si_1", quantity: 120 }],
    effectiveIntent: { type: "IMMEDIATE" },
    guaranteeMode: "REVALIDATE",
    acceptanceEnvelope: { maxImmediateNetIncrease: 0, maxImmediateCreditDecrease: 0, maxRecurringIncrease: 0 },
  });
  f3.sim.advanceTimeSeconds(10 * 24 * 3600);
  await assert.rejects(
    () => adapter3.commitChangeQuote(driftQuote.id),
    (err: unknown) => err instanceof SCQError && err.code === "QUOTE_DRIFTED"
  );
  assert.equal((await adapter3.getSubscription(f3.sub.id)).items[0].quantity, 100, "drift refusal means no mutation");
});

// ---------------------------------------------------------------------------
// Scenario coverage: downgrade (credit), plan change, cadence change
// ---------------------------------------------------------------------------

test("Test 17.13 (scenarios): downgrade produces a determined credit; cadence change carries determinacy and provenance", async () => {
  const { sim, sub } = freshStripeFixture();
  const adapter = new StripeAdapter(sim, new QuoteStore());

  const downgrade = await adapter.createChangeQuote(sub.id, {
    changes: [{ action: "CHANGE_QUANTITY", itemId: "si_1", quantity: 80 }],
    effectiveIntent: { type: "IMMEDIATE" },
    guaranteeMode: "REVALIDATE",
    acceptanceEnvelope: GENEROUS_ENVELOPE,
  });
  assert.equal(downgrade.commercialEffect.immediate?.net, -20000, "a downgrade incurs a credit — a negative obligation, not an amount due");
  assert.equal(downgrade.commercialEffect.immediate?.credit, 20000);
  assert.equal(downgrade.commercialEffect.immediate?.charge, undefined);
  assert.equal(determinacyOf(downgrade.commercialEffect).immediateFinancialEffect, "DETERMINED");

  const cadence = await adapter.createChangeQuote(sub.id, {
    changes: [{ action: "CHANGE_CADENCE", cadence: "ANNUAL" }],
    effectiveIntent: { type: "IMMEDIATE" },
    guaranteeMode: "REVALIDATE",
    acceptanceEnvelope: GENEROUS_ENVELOPE,
  });
  assert.equal(cadence.commercialEffect.recurring?.resultingAmount, 10000 * 100);
  assert.equal(cadence.commercialEffect.recurring?.cadence, "ANNUAL");
  assert.deepEqual(determinacyOf(cadence.commercialEffect), {
    immediateFinancialEffect: "DETERMINED",
    recurringFinancialEffect: "DETERMINED",
  });
  const cadenceAudit = auditDeterminacy(cadence.commercialEffect, cadence.commercialEffect, "CHANGE_CADENCE");
  assert.ok(cadenceAudit.every((e) => e.findings.length === 0), JSON.stringify(cadenceAudit));
});

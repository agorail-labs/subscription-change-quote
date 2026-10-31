import { test } from "node:test";
import assert from "node:assert/strict";
import { QuoteStore } from "../src/store/quote-store.js";
import { StripeAdapter } from "../src/adapters/stripe-adapter.js";
import { determinacyOf } from "../src/core/scq-engine.js";
import { SCQError } from "../src/core/types.js";
import { freshStripeFixture } from "./fixtures.js";

// SCQ — Issue #44 (G-21 item 1): Stripe-simulator EXACT / CANCEL
// wrong-state negative evidence.
//
// Everything here runs against the in-memory Stripe simulator.
// All results are SIMULATED_PASS-class evidence: no live Stripe
// API is involved and nothing here certifies a real provider.
//
// The defect under test (G-21 item 1, confirmed by inspection of
// the pre-fix adapter): on the `isCancel || EXACT` branch of
// commitChangeQuote, the committed effect was the quoted effect
// relabelled `defined_equal_exact`, reconciliation compared the
// quote against its own copy, and the receipt was recorded
// COMMITTED_AND_VERIFIED from the mutation call's RETURN value —
// with no independent post-commit read of persisted provider
// state and no §6.12 state verification. A mutation that landed
// the WRONG state behind a success response therefore verified.
//
// The simulator faults used here (stripe-sim.ts, issue #44) are
// opt-in, one-shot misexecution hooks modelled on the Chargebee
// simulator's: the mutation's response artifact reports the
// REQUESTED state while the PERSISTED record diverges. They alter
// the modeled provider's persisted behaviour only — no verdict is
// injected anywhere, and the adapter under test is unmodified by
// the fault.
//
// Post-fix expectations, per §6.12/§6.15 and Decision D3:
//   - independently read state CONTRADICTS intent => the landing
//     is established and the receipt is COMMITTED_AND_VERIFIED
//     with a VIOLATED reconciliation (a determined negative —
//     never non-execution, never INDETERMINATE);
//   - state missing or not verifiable => COMMITTED_UNVERIFIED
//     with an UNVERIFIED reconciliation and candidate figures
//     labelled unestablished;
//   - a lost response => INDETERMINATE, no receipt, no blind
//     retry (the recorded-outcome guard refuses a second commit);
//   - the happy paths are unchanged: VERIFIED / OK with the
//     EXACT branch's figures still `defined_equal_exact` — the
//     contract-defined equality of FIGURES (§3.9/§3.11), now
//     backed by an independently verified STATE. The G-01 trust
//     limitation stands: none of this authenticates provider
//     origin.

const GENEROUS_ENVELOPE = {
  maxImmediateNetIncrease: 1_000_000,
  maxImmediateCreditDecrease: 1_000_000,
  maxRecurringIncrease: 1_000_000,
};

/**
 * An EXACT-mode update quote, seeded through the store's public
 * API. Why not createChangeQuote: Stripe's advertised coverage
 * for non-CANCEL actions is termEffect UNKNOWN, so
 * enforceGuaranteeRequest refuses an overall EXACT request for
 * updates at quote creation (pinned executably in test 60.13) —
 * the commit branch's EXACT arm is unreachable from adapter-minted
 * update quotes today. The branch is nevertheless shared with
 * CANCEL and carries the proration_date replay machinery, so its
 * landing must not be an unverified path: this helper takes a
 * genuine adapter-minted quote record and re-marks its stored
 * effective mode (and its proposal's stated mode, keeping the
 * record internally consistent) as EXACT — exactly the record
 * createChangeQuote would have written had coverage allowed it.
 * Only the commit path is under test; no verification is bypassed.
 */
async function exactQuantityQuote(adapter: StripeAdapter, store: QuoteStore, subId: string, quantity: number): Promise<string> {
  const quote = await adapter.createChangeQuote(subId, {
    changes: [{ action: "CHANGE_QUANTITY", itemId: "si_1", quantity }],
    effectiveIntent: { type: "IMMEDIATE" },
    guaranteeMode: "REVALIDATE",
    acceptanceEnvelope: GENEROUS_ENVELOPE,
  });
  const stored = store.get(quote.id);
  assert.ok(stored, "the minted quote record is in the store");
  store.put({
    ...stored,
    effective_guarantee_mode: "EXACT",
    proposal: { ...stored.proposal, guaranteeMode: "EXACT" },
  });
  return quote.id;
}

function termEndCancelQuote(adapter: StripeAdapter, subId: string) {
  return adapter.createChangeQuote(subId, {
    changes: [{ action: "CANCEL" }],
    effectiveIntent: { type: "TERM_END" },
    guaranteeMode: "EXACT",
  });
}

test("Test 60.0 (fault shape): the wrong-state fault makes the returned artifact agree with the request while persisted state diverges; one-shot", () => {
  const { sim, sub } = freshStripeFixture();
  sim._debugWrongQuantityOnNextUpdate = 130;
  const { subscription } = sim.update(sub.id, [{ id: "si_1", price: "price_seat_basic", quantity: 120 }], "create_prorations");
  assert.equal(subscription.items[0].quantity, 120, "the mutation response reports the REQUESTED quantity");
  assert.equal(sim.retrieve(sub.id).items[0].quantity, 130, "the PERSISTED state carries the wrong quantity");
  assert.equal(sim._debugWrongQuantityOnNextUpdate, undefined, "the fault is one-shot and clears itself");
  const again = sim.update(sub.id, [{ id: "si_1", price: "price_seat_basic", quantity: 140 }], "create_prorations");
  assert.equal(again.subscription.items[0].quantity, 140);
  assert.equal(sim.retrieve(sub.id).items[0].quantity, 140, "no fault remains armed for the next mutation");
});

test("Test 60.1: EXACT quantity change landing the WRONG quantity must not verify — VIOLATED over the observed state", async () => {
  const { sim, sub } = freshStripeFixture();
  const store = new QuoteStore();
  const adapter = new StripeAdapter(sim, store);
  const quoteId = await exactQuantityQuote(adapter, store, sub.id, 120);
  sim._debugWrongQuantityOnNextUpdate = 130;
  const receipt = await adapter.commitChangeQuote(quoteId);
  assert.equal(sim.retrieve(sub.id).items[0].quantity, 130, "persisted state is independently confirmed wrong");
  assert.equal(receipt.outcome, "COMMITTED_AND_VERIFIED", "the landing is ESTABLISHED (execution is not in doubt) — a determined negative, not UNVERIFIED/INDETERMINATE");
  assert.equal(receipt.reconciliation.status, "VIOLATED", "an independently read state mismatch must reconcile VIOLATED, never OK");
  assert.equal(receipt.resultingSnapshot.items[0].quantity, 130, "the receipt snapshot reports the independently read state, not the mutation return's claim");
  assert.equal(receipt.committedEffect.provenance?.committedSource, "provider_actual", "on a state mismatch the recorded figures are the observed actuals, not the defined-equal quote");
  assert.equal(receipt.committedEffect.recurring?.resultingAmount, 130_000, "the recorded recurring figure is the observed (wrong) state's figure");
});

test("Test 60.2: EXACT plan change landing the WRONG price must not verify — VIOLATED", async () => {
  const { sim, sub } = freshStripeFixture();
  const store = new QuoteStore();
  const adapter = new StripeAdapter(sim, store);
  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [{ action: "CHANGE_PLAN", itemId: "si_1", offeringRef: "plan:pro:monthly" }],
    effectiveIntent: { type: "IMMEDIATE" },
    guaranteeMode: "REVALIDATE",
    acceptanceEnvelope: GENEROUS_ENVELOPE,
  });
  const storedPlan = store.get(quote.id);
  assert.ok(storedPlan);
  store.put({ ...storedPlan, effective_guarantee_mode: "EXACT", proposal: { ...storedPlan.proposal, guaranteeMode: "EXACT" } });
  sim._debugWrongPriceOnNextUpdate = "price_seat_basic";
  const receipt = await adapter.commitChangeQuote(quote.id);
  assert.equal(sim.retrieve(sub.id).items[0].price.id, "price_seat_basic", "persisted state kept the old price");
  assert.equal(receipt.reconciliation.status, "VIOLATED");
  assert.equal(receipt.outcome, "COMMITTED_AND_VERIFIED");
  assert.equal(receipt.resultingSnapshot.items[0].offeringRef, "plan:basic:monthly", "the snapshot reports the observed offering, not the intended one");
});

test("Test 60.3: TERM_END CANCEL landing as an IMMEDIATE cancellation must not verify — VIOLATED (premature termination)", async () => {
  const { sim, sub } = freshStripeFixture();
  const adapter = new StripeAdapter(sim, new QuoteStore());
  const quote = await termEndCancelQuote(adapter, sub.id);
  sim._debugCancelImmediatelyOnNextCancel = true;
  const receipt = await adapter.commitChangeQuote(quote.id);
  const persisted = sim.retrieve(sub.id);
  assert.equal(persisted.status, "canceled", "the cancellation landed TERMINAL, not scheduled");
  assert.equal(persisted.cancel_at_period_end, false);
  assert.equal(receipt.reconciliation.status, "VIOLATED", "a premature termination contradicts the authorized TERM_END intent");
  assert.equal(receipt.outcome, "COMMITTED_AND_VERIFIED");
  assert.equal(receipt.resultingSnapshot.status, "canceled", "the receipt snapshot reports the observed terminal state, not the returned artifact's scheduled shape");
});

test("Test 60.4: TERM_END CANCEL landing with the WRONG effective date must not verify — VIOLATED", async () => {
  const { sim, sub } = freshStripeFixture();
  const adapter = new StripeAdapter(sim, new QuoteStore());
  const quote = await termEndCancelQuote(adapter, sub.id);
  const authorizedBoundary = sub.current_period_end;
  sim._debugShiftPeriodEndOnNextCancel = 7 * 24 * 3600;
  const receipt = await adapter.commitChangeQuote(quote.id);
  const persisted = sim.retrieve(sub.id);
  assert.equal(persisted.cancel_at_period_end, true, "a schedule WAS persisted");
  assert.equal(persisted.current_period_end, authorizedBoundary + 7 * 24 * 3600, "but its effective date is not the authorized term boundary");
  assert.equal(receipt.reconciliation.status, "VIOLATED", "a schedule effective after the authorized boundary is not the authorized cancellation");
  assert.equal(receipt.outcome, "COMMITTED_AND_VERIFIED");
});

test("Test 60.5: TERM_END CANCEL whose schedule never lands is COMMITTED_UNVERIFIED — absence is not a verified schedule, and not OK", async () => {
  const { sim, sub } = freshStripeFixture();
  const adapter = new StripeAdapter(sim, new QuoteStore());
  const quote = await termEndCancelQuote(adapter, sub.id);
  sim._debugSkipCancelOnNextCancel = true;
  const receipt = await adapter.commitChangeQuote(quote.id);
  const persisted = sim.retrieve(sub.id);
  assert.equal(persisted.status, "active");
  assert.equal(persisted.cancel_at_period_end, false, "no cancellation was persisted behind the success response");
  assert.equal(receipt.outcome, "COMMITTED_UNVERIFIED", "the response was received (landing of the CALL is established) but the intended state is not observed and cannot be verified");
  assert.equal(receipt.reconciliation.status, "UNVERIFIED", "an absent schedule is UNVERIFIABLE under §6.12 — never OK, and not an established contradiction either");
});

test("Test 60.6: EXACT update whose post-mutation state is MISSING is COMMITTED_UNVERIFIED with unestablished candidates", async () => {
  const { sim, sub } = freshStripeFixture();
  const store = new QuoteStore();
  const adapter = new StripeAdapter(sim, store);
  const quoteId = await exactQuantityQuote(adapter, store, sub.id, 120);
  sim._debugDropSubscriptionOnNextMutation = true;
  const receipt = await adapter.commitChangeQuote(quoteId);
  assert.equal(receipt.outcome, "COMMITTED_UNVERIFIED", "the mutation responded, but no post-commit state exists to verify against");
  assert.equal(receipt.status, "COMMITTED_UNVERIFIED");
  assert.equal(receipt.reconciliation.status, "UNVERIFIED");
  assert.equal(receipt.committedEffect.provenance?.committedSource, "unestablished", "figures from the mutation response are candidates only when the independent read is unavailable");
  assert.deepEqual(determinacyOf(receipt.committedEffect), {
    immediateFinancialEffect: "UNKNOWN",
    recurringFinancialEffect: "UNKNOWN",
  });
  const replay = await adapter.commitChangeQuote(quoteId);
  assert.equal(replay, receipt, "the recorded receipt replays verbatim; no second dispatch is attempted against missing state");
});

test("Test 60.7: EXACT update with a LOST RESPONSE is INDETERMINATE and is never blindly retried", async () => {
  const { sim, sub } = freshStripeFixture();
  const store = new QuoteStore();
  const adapter = new StripeAdapter(sim, store);
  const quoteId = await exactQuantityQuote(adapter, store, sub.id, 120);
  sim._debugLoseNextUpdateResponse = true;
  await assert.rejects(
    () => adapter.commitChangeQuote(quoteId),
    (err: unknown) => err instanceof SCQError && (err.details as { outcome?: string })?.outcome === "INDETERMINATE"
  );
  assert.equal(sim.retrieve(sub.id).items[0].quantity, 120, "the mutation landed exactly once behind the lost response");
  await assert.rejects(
    () => adapter.commitChangeQuote(quoteId),
    (err: unknown) => err instanceof SCQError && /INDETERMINATE/.test(err.message),
    "a second commit is refused by the recorded-outcome guard — no blind retry"
  );
  assert.equal(sim.retrieve(sub.id).items[0].quantity, 120, "state is unchanged after the refused retry (no double-apply)");
});

test("Test 60.8: TERM_END CANCEL with a LOST RESPONSE is INDETERMINATE and is never blindly retried", async () => {
  const { sim, sub } = freshStripeFixture();
  const adapter = new StripeAdapter(sim, new QuoteStore());
  const quote = await termEndCancelQuote(adapter, sub.id);
  sim._debugLoseNextCancelResponse = true;
  await assert.rejects(
    () => adapter.commitChangeQuote(quote.id),
    (err: unknown) => err instanceof SCQError && (err.details as { outcome?: string })?.outcome === "INDETERMINATE"
  );
  const persisted = sim.retrieve(sub.id);
  assert.equal(persisted.cancel_at_period_end, true, "the cancellation landed behind the lost response");
  await assert.rejects(
    () => adapter.commitChangeQuote(quote.id),
    (err: unknown) => err instanceof SCQError && /INDETERMINATE/.test(err.message)
  );
  assert.equal(sim.retrieve(sub.id).cancel_at_period_end, true, "no second cancellation was dispatched");
});

test("Test 60.9 (control): EXACT quantity change landing as authorized still verifies — defined_equal_exact figures, OK", async () => {
  const { sim, sub } = freshStripeFixture();
  const store = new QuoteStore();
  const adapter = new StripeAdapter(sim, store);
  const quoteId = await exactQuantityQuote(adapter, store, sub.id, 120);
  const quotedNet = store.get(quoteId)?.quoted_effect?.immediate?.net;
  const receipt = await adapter.commitChangeQuote(quoteId);
  assert.equal(receipt.status, "COMMITTED");
  assert.equal(receipt.outcome, "COMMITTED_AND_VERIFIED");
  assert.equal(receipt.reconciliation.status, "OK");
  assert.equal(receipt.committedEffect.provenance?.committedSource, "defined_equal_exact", "EXACT figures remain contract-defined equality — now backed by an independently verified state");
  assert.equal(receipt.committedEffect.immediate?.net, quotedNet);
  assert.equal(receipt.resultingSnapshot.items[0].quantity, 120);
});

test("Test 60.10 (control): TERM_END CANCEL landing as authorized still verifies — defined_equal_exact, OK", async () => {
  const { sim, sub } = freshStripeFixture();
  const adapter = new StripeAdapter(sim, new QuoteStore());
  const quote = await termEndCancelQuote(adapter, sub.id);
  const receipt = await adapter.commitChangeQuote(quote.id);
  assert.equal(receipt.status, "COMMITTED");
  assert.equal(receipt.outcome, "COMMITTED_AND_VERIFIED");
  assert.equal(receipt.reconciliation.status, "OK");
  assert.equal(receipt.committedEffect.provenance?.committedSource, "defined_equal_exact");
  assert.equal(receipt.committedEffect.recurring?.resultingAmount, 0);
  assert.equal(receipt.resultingSnapshot.term?.autoRenew, false);
  assert.equal(sim.retrieve(sub.id).cancel_at_period_end, true);
});

test("Test 60.11 (control): IMMEDIATE CANCEL landing as authorized still verifies — OK", async () => {
  const { sim, sub } = freshStripeFixture();
  const adapter = new StripeAdapter(sim, new QuoteStore());
  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [{ action: "CANCEL" }],
    effectiveIntent: { type: "IMMEDIATE" },
    guaranteeMode: "EXACT",
  });
  const receipt = await adapter.commitChangeQuote(quote.id);
  assert.equal(receipt.outcome, "COMMITTED_AND_VERIFIED");
  assert.equal(receipt.reconciliation.status, "OK");
  assert.equal(receipt.resultingSnapshot.status, "canceled");
});

test("Test 60.13 (boundary pin): EXACT-mode UPDATE quotes are refused at quote creation on Stripe — coverage, not verification, is what gates them today", async () => {
  // Stripe's advertised coverage for non-CANCEL actions carries
  // termEffect UNKNOWN, so an overall EXACT request for an update
  // fails enforceGuaranteeRequest before any quote exists. This
  // pins the reachability boundary the EXACT-update cases above
  // are seeded around (60.1/60.2 helpers): the live EXACT surface
  // on this adapter is CANCEL, and the update arm of the shared
  // commit branch is defensive — it must still not be an
  // unverified path if a stored EXACT record ever reaches it.
  const { sim, sub } = freshStripeFixture();
  const adapter = new StripeAdapter(sim, new QuoteStore());
  await assert.rejects(
    () =>
      adapter.createChangeQuote(sub.id, {
        changes: [{ action: "CHANGE_QUANTITY", itemId: "si_1", quantity: 120 }],
        effectiveIntent: { type: "IMMEDIATE" },
        guaranteeMode: "EXACT",
        acceptanceEnvelope: GENEROUS_ENVELOPE,
      }),
    (err: unknown) => err instanceof SCQError && err.code === "UNSUPPORTED_CHANGE" && /termEffect/.test(err.message)
  );
});

test("Test 60.12: a VIOLATED receipt replays verbatim (no re-dispatch), and the one-shot fault does not leak into the next commit", async () => {
  const { sim, sub } = freshStripeFixture();
  const store = new QuoteStore();
  const adapter = new StripeAdapter(sim, store);
  const quoteId = await exactQuantityQuote(adapter, store, sub.id, 120);
  sim._debugWrongQuantityOnNextUpdate = 130;
  const receipt = await adapter.commitChangeQuote(quoteId);
  assert.equal(receipt.reconciliation.status, "VIOLATED");
  const replay = await adapter.commitChangeQuote(quoteId);
  assert.equal(replay, receipt, "idempotent replay returns the recorded receipt; the mutation is not re-dispatched");
  assert.equal(sim.retrieve(sub.id).items[0].quantity, 130, "persisted state untouched by the replay");
  const quote2Id = await exactQuantityQuote(adapter, store, sub.id, 140);
  const receipt2 = await adapter.commitChangeQuote(quote2Id);
  assert.equal(receipt2.reconciliation.status, "OK", "the fault was one-shot: the next commit verifies cleanly");
  assert.equal(receipt2.resultingSnapshot.items[0].quantity, 140);
});

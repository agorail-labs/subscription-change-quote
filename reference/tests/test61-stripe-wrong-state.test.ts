import { test } from "node:test";
import assert from "node:assert/strict";
import { QuoteStore } from "../src/store/quote-store.js";
import { StripeAdapter } from "../src/adapters/stripe-adapter.js";
import { StripeSim, type StripeSubscription } from "../src/adapters/stripe-sim.js";
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
//
// Correction round (PR #52 review, R1/R2): a current-state read
// is not an operation-keyed observation. Tests 61.14–61.17 pin
// the two refinements: (R1) every UNVERIFIED receipt whose
// figures are unestablished candidates names BOTH undetermined
// dimensions (§3.10/§6.15) — including the state-UNVERIFIABLE
// branch, which returned []; and (R2) classification is gated on
// an operation-attribution chain built from the simulator's
// transition journal (its model of Stripe's subscription event
// stream): an intervening transition, a missing own transition,
// or state moved past the attributed transition downgrades the
// commit to COMMITTED_UNVERIFIED / UNVERIFIED with the observed
// state as context — never VIOLATED, never VERIFIED/OK — while
// the provider's OWN wrong landing (61.1–61.4) stays VIOLATED.
//
// Focused follow-up (PR #52 review, R2′): the journal's kind is
// not an operation identity. A second actor can call the SAME
// public mutation method — if the dispatched cancel/update is
// skipped (journals nothing) and another actor's ordinary
// same-kind call then lands exactly the intended state, the
// window holds exactly one transition of the expected kind with
// a matching fingerprint, and a kind-only gate attributes the
// other operation's landing to this one. Tests 61.18/61.19 pin
// the identity binding: journal transitions carry the unique
// operation identity minted for the call that applied them, the
// dispatched call's RESPONSE artifact carries that same
// identity, and attribution requires the two to be equal — a
// skipped dispatch's response carries no identity at all, so a
// same-kind interposition can never verify it.

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
 * updates at quote creation (pinned executably in test 61.13) —
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

test("Test 61.0 (fault shape): the wrong-state fault makes the returned artifact agree with the request while persisted state diverges; one-shot", () => {
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

test("Test 61.1: EXACT quantity change landing the WRONG quantity must not verify — VIOLATED over the observed state", async () => {
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

test("Test 61.2: EXACT plan change landing the WRONG price must not verify — VIOLATED", async () => {
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

test("Test 61.3: TERM_END CANCEL landing as an IMMEDIATE cancellation must not verify — VIOLATED (premature termination)", async () => {
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

test("Test 61.4: TERM_END CANCEL landing with the WRONG effective date must not verify — VIOLATED", async () => {
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

test("Test 61.5: TERM_END CANCEL whose schedule never lands is COMMITTED_UNVERIFIED — absence is not a verified schedule, and not OK", async () => {
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
  assert.deepEqual(
    receipt.reconciliation.undeterminedDimensions,
    ["immediateFinancialEffect", "recurringFinancialEffect"],
    "R1 (§3.10/§6.15): the recorded figures are unestablished candidates in BOTH dimensions, so the UNVERIFIED reconciliation must NAME both undetermined dimensions — an empty list falsely implies every dimension was determined"
  );
});

test("Test 61.6: EXACT update whose post-mutation state is MISSING is COMMITTED_UNVERIFIED with unestablished candidates", async () => {
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
  assert.deepEqual(replay, receipt, "the recorded receipt replays verbatim; no second dispatch is attempted against missing state");
});

test("Test 61.7: EXACT update with a LOST RESPONSE is INDETERMINATE and is never blindly retried", async () => {
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

test("Test 61.8: TERM_END CANCEL with a LOST RESPONSE is INDETERMINATE and is never blindly retried", async () => {
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

test("Test 61.9 (control): EXACT quantity change landing as authorized still verifies — defined_equal_exact figures, OK", async () => {
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

test("Test 61.10 (control): TERM_END CANCEL landing as authorized still verifies — defined_equal_exact, OK", async () => {
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

test("Test 61.11 (control): IMMEDIATE CANCEL landing as authorized still verifies — OK", async () => {
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

test("Test 61.13 (boundary pin): EXACT-mode UPDATE quotes are refused at quote creation on Stripe — coverage, not verification, is what gates them today", async () => {
  // Stripe's advertised coverage for non-CANCEL actions carries
  // termEffect UNKNOWN, so an overall EXACT request for an update
  // fails enforceGuaranteeRequest before any quote exists. This
  // pins the reachability boundary the EXACT-update cases above
  // are seeded around (61.1/61.2 helpers): the live EXACT surface
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

test("Test 61.14 (R1): EXACT update whose landed state is UNVERIFIABLE names BOTH undetermined dimensions", async () => {
  // The shape used: the persisted subscription carries an item
  // entry with NO identifier alongside the target item. Under
  // §6.12 (SV3/SV5) an unidentifiable observed entry could be a
  // contradictory duplicate of the target, so the item dimension
  // is UNVERIFIABLE even though the identified entry agrees with
  // intent and the update itself landed exactly as authorized.
  // (Test 61.6's missing-state shape takes the missing-read
  // branch instead, which already names both dimensions; this
  // case is constructed to flow through the state-UNVERIFIABLE
  // branch itself.) The entry is part of the seeded state — no
  // third party intervenes, so this is not an attribution case.
  const nowSec = Math.floor(new Date("2026-08-01T00:00:00Z").getTime() / 1000);
  const sim = new StripeSim(nowSec);
  const sub: StripeSubscription = {
    id: "sub_test1",
    status: "active",
    items: [
      { id: "si_1", price: { id: "price_seat_basic", unitAmount: 1000, currency: "usd", interval: "month" }, quantity: 100 },
      { id: "", price: { id: "price_seat_basic", unitAmount: 1000, currency: "usd", interval: "month" }, quantity: 5 },
    ],
    current_period_start: nowSec,
    current_period_end: nowSec + 30 * 24 * 3600,
    cancel_at_period_end: false,
  };
  sim.seedSubscription(sub);
  const store = new QuoteStore();
  const adapter = new StripeAdapter(sim, store);
  const quoteId = await exactQuantityQuote(adapter, store, sub.id, 120);
  const receipt = await adapter.commitChangeQuote(quoteId);
  assert.equal(sim.retrieve(sub.id).items[0].quantity, 120, "the update landed as authorized — only its verifiability is in question");
  assert.equal(receipt.outcome, "COMMITTED_UNVERIFIED", "an UNVERIFIABLE landed state is not a verified commit");
  assert.equal(receipt.reconciliation.status, "UNVERIFIED");
  assert.equal(receipt.committedEffect.provenance?.committedSource, "unestablished", "the recorded figures are candidates, not established actuals");
  assert.deepEqual(determinacyOf(receipt.committedEffect), {
    immediateFinancialEffect: "UNKNOWN",
    recurringFinancialEffect: "UNKNOWN",
  });
  assert.deepEqual(
    receipt.reconciliation.undeterminedDimensions,
    ["immediateFinancialEffect", "recurringFinancialEffect"],
    "R1 (§3.10/§6.15): both dimensions are unestablished candidates, so both must be NAMED as undetermined — the UNVERIFIABLE branch returned [] before the correction"
  );
});

test("Test 61.15 (R2/S1): a third party rewriting the schedule between dispatch and verification breaks attribution — UNVERIFIED, never VIOLATED", async () => {
  // The cancel dispatches and correctly schedules TERM_END. A
  // third party then rewrites the schedule (wrapper interposition
  // on the sim's cancel: after the real cancel returns, before
  // the adapter's verification read). The observed state
  // contradicts intent — but it is the THIRD PARTY's state, not
  // this operation's landing, so it cannot be recorded as this
  // operation's verified violation (the Chargebee broken-bracket
  // boundary, §6.15: attribution precedes classification).
  const nowSec = Math.floor(new Date("2026-08-01T00:00:00Z").getTime() / 1000);
  class InterposingSim extends StripeSim {
    private interposed = false;
    override cancel(id: string, atPeriodEnd: boolean): StripeSubscription {
      const result = super.cancel(id, atPeriodEnd);
      if (!this.interposed) {
        this.interposed = true;
        this._debugMutateDirectly(id, (s) => {
          s.current_period_end += 7 * 24 * 3600;
        });
      }
      return result;
    }
  }
  const sim = new InterposingSim(nowSec);
  const { sub } = freshStripeFixture();
  sim.seedSubscription(structuredClone(sub));
  const adapter = new StripeAdapter(sim, new QuoteStore());
  const quote = await termEndCancelQuote(adapter, sub.id);
  const receipt = await adapter.commitChangeQuote(quote.id);
  const persisted = sim.retrieve(sub.id);
  assert.equal(persisted.cancel_at_period_end, true, "a schedule is persisted");
  assert.equal(persisted.current_period_end, sub.current_period_end + 7 * 24 * 3600, "but the observed schedule is the third party's rewrite, not what this operation landed");
  assert.equal(receipt.outcome, "COMMITTED_UNVERIFIED", "the observed state cannot be attributed to this operation, so its landing is not established as verified — in either direction");
  assert.equal(receipt.reconciliation.status, "UNVERIFIED", "never VIOLATED: a state this operation did not produce is not its determined violation");
  assert.equal(receipt.committedEffect.provenance?.committedSource, "unestablished", "no figures are recorded as this operation's determined actuals");
  assert.deepEqual(determinacyOf(receipt.committedEffect), {
    immediateFinancialEffect: "UNKNOWN",
    recurringFinancialEffect: "UNKNOWN",
  });
  assert.deepEqual(receipt.reconciliation.undeterminedDimensions, ["immediateFinancialEffect", "recurringFinancialEffect"]);
});

test("Test 61.16 (R2/S2): a third party installing the intended schedule after a SKIPPED cancel does not verify — the operation never landed", async () => {
  // The mirror image of 61.15: the dispatched cancel is a no-op
  // (skip fault — the response claims the schedule, nothing is
  // persisted), and a third party then installs exactly the
  // intended schedule before the verification read. The observed
  // state MATCHES intent, but this operation produced none of
  // it: a current-state read is not operation attribution, so
  // the commit must not verify (no COMMITTED_AND_VERIFIED / OK,
  // no defined_equal_exact).
  const nowSec = Math.floor(new Date("2026-08-01T00:00:00Z").getTime() / 1000);
  class InstallAfterSkipSim extends StripeSim {
    private interposed = false;
    override cancel(id: string, atPeriodEnd: boolean): StripeSubscription {
      const result = super.cancel(id, atPeriodEnd);
      if (!this.interposed) {
        this.interposed = true;
        this._debugMutateDirectly(id, (s) => {
          s.cancel_at_period_end = true;
        });
      }
      return result;
    }
  }
  const sim = new InstallAfterSkipSim(nowSec);
  const { sub } = freshStripeFixture();
  sim.seedSubscription(structuredClone(sub));
  sim._debugSkipCancelOnNextCancel = true;
  const adapter = new StripeAdapter(sim, new QuoteStore());
  const quote = await termEndCancelQuote(adapter, sub.id);
  const receipt = await adapter.commitChangeQuote(quote.id);
  const persisted = sim.retrieve(sub.id);
  assert.equal(persisted.cancel_at_period_end, true, "the observed state matches intent — installed by the third party");
  assert.equal(receipt.resultingSnapshot.term?.autoRenew, false, "the observed schedule is recorded as context");
  assert.equal(receipt.outcome, "COMMITTED_UNVERIFIED", "state matching intent is not enough: this cancel never landed, so its outcome is not established");
  assert.equal(receipt.reconciliation.status, "UNVERIFIED", "never OK: the matching state is not attributable to this operation");
  assert.equal(receipt.committedEffect.provenance?.committedSource, "unestablished", "never defined_equal_exact for a landing this operation did not produce");
  assert.deepEqual(receipt.reconciliation.undeterminedDimensions, ["immediateFinancialEffect", "recurringFinancialEffect"]);
});

test("Test 61.17 (R2/S3): an intervening EXACT update replacing latest_invoice and landing a mismatch breaks attribution BEFORE classification — UNVERIFIED, not VIOLATED", async () => {
  // An intervening operation on the same subscription lands a
  // state mismatch and replaces latest_invoice between this
  // commit's dispatch and its verification read (wrapper
  // interposition on the sim's update). Before the correction,
  // the MISMATCH branch fired first and recorded the intervening
  // state as THIS operation's verified violation; the
  // latest_invoice (M3) check sat behind it and never ran.
  const nowSec = Math.floor(new Date("2026-08-01T00:00:00Z").getTime() / 1000);
  class InterveningUpdateSim extends StripeSim {
    private interposed = false;
    override update(...args: Parameters<StripeSim["update"]>): ReturnType<StripeSim["update"]> {
      const result = super.update(...args);
      if (!this.interposed) {
        this.interposed = true;
        super.update(args[0], [{ id: "si_1", price: "price_seat_basic", quantity: 150 }], "create_prorations");
      }
      return result;
    }
  }
  const sim = new InterveningUpdateSim(nowSec);
  const { sub } = freshStripeFixture();
  sim.seedSubscription(structuredClone(sub));
  const store = new QuoteStore();
  const adapter = new StripeAdapter(sim, store);
  const quoteId = await exactQuantityQuote(adapter, store, sub.id, 120);
  const receipt = await adapter.commitChangeQuote(quoteId);
  assert.equal(sim.retrieve(sub.id).items[0].quantity, 150, "the observed state is the intervening operation's landing");
  assert.equal(receipt.resultingSnapshot.items[0].quantity, 150, "the observed state is recorded as context");
  assert.equal(receipt.outcome, "COMMITTED_UNVERIFIED", "the mismatch is not attributable to this operation, so it is not this operation's verified violation");
  assert.equal(receipt.reconciliation.status, "UNVERIFIED", "attribution precedes classification: never VIOLATED from an intervening operation's state");
  assert.equal(receipt.committedEffect.provenance?.committedSource, "unestablished", "no figures are recorded as this operation's determined actuals");
  assert.deepEqual(determinacyOf(receipt.committedEffect), {
    immediateFinancialEffect: "UNKNOWN",
    recurringFinancialEffect: "UNKNOWN",
  });
  assert.deepEqual(receipt.reconciliation.undeterminedDimensions, ["immediateFinancialEffect", "recurringFinancialEffect"]);
});

test("Test 61.18 (R2′): a SKIPPED cancel followed by another actor's ordinary SAME-KIND cancel landing the intended schedule must not verify — kind is not operation identity", async () => {
  // The reviewer's exact construction, on the public sim
  // surface. The adapter's dispatched cancel is SKIPPED (skip
  // fault: nominal scheduled response, nothing persisted,
  // nothing journaled). A distinct actor then issues an ordinary
  // sim.cancel() — the same public method, the same kind — which
  // lands exactly the intended TERM_END schedule and journals
  // exactly one kind:"cancel" transition whose fingerprint
  // matches the verification read. A gate that binds only
  // {kind, fingerprint} attributes the OTHER operation's landing
  // to this commit and reports COMMITTED_AND_VERIFIED / OK for
  // an operation that did nothing. Attribution must bind the
  // journal transition to THIS dispatch by the operation
  // identity its response carries — a skipped dispatch's
  // response carries none, so the chain is absent and the
  // commit is UNVERIFIED (never OK, never VIOLATED: the observed
  // state is not this operation's violation either).
  const nowSec = Math.floor(new Date("2026-08-01T00:00:00Z").getTime() / 1000);
  class SameKindCancelSim extends StripeSim {
    private interposed = false;
    override cancel(id: string, atPeriodEnd: boolean): StripeSubscription {
      if (this.interposed) return super.cancel(id, atPeriodEnd);
      this.interposed = true;
      // (1)+(2) THIS dispatch, with the skip fault armed: the
      // response reports the requested schedule, the persisted
      // record is reverted, and NO transition is journaled.
      this._debugSkipCancelOnNextCancel = true;
      const dispatched = super.cancel(id, atPeriodEnd);
      // (3) A distinct actor's ordinary cancellation of the same
      // kind: persists the intended TERM_END schedule and
      // journals exactly one kind:"cancel" transition.
      super.cancel(id, atPeriodEnd);
      // (4) The adapter receives the FIRST call's response.
      return dispatched;
    }
  }
  const sim = new SameKindCancelSim(nowSec);
  const { sub } = freshStripeFixture();
  sim.seedSubscription(structuredClone(sub));
  const adapter = new StripeAdapter(sim, new QuoteStore());
  const quote = await termEndCancelQuote(adapter, sub.id);
  const receipt = await adapter.commitChangeQuote(quote.id);
  const persisted = sim.retrieve(sub.id);
  assert.equal(persisted.cancel_at_period_end, true, "the intended schedule IS persisted — by the third party's cancel");
  assert.equal(persisted.current_period_end, sub.current_period_end, "at exactly the authorized boundary");
  const transitions = sim.listTransitions(sub.id, 0);
  assert.equal(transitions.length, 1, "construction precondition: the journal window holds exactly one transition");
  assert.equal(transitions[0].kind, "cancel", "construction precondition: of the dispatched kind — kind alone cannot distinguish it from this dispatch");
  assert.equal(receipt.outcome, "COMMITTED_UNVERIFIED", "the matching landing was produced by a DIFFERENT operation of the same kind — it does not verify this commit");
  assert.equal(receipt.reconciliation.status, "UNVERIFIED", "never OK, and never VIOLATED: the observed state is not this operation's determined violation either");
  assert.equal(receipt.committedEffect.provenance?.committedSource, "unestablished", "never defined_equal_exact for a landing this operation did not produce");
  assert.deepEqual(determinacyOf(receipt.committedEffect), {
    immediateFinancialEffect: "UNKNOWN",
    recurringFinancialEffect: "UNKNOWN",
  });
  assert.deepEqual(receipt.reconciliation.undeterminedDimensions, ["immediateFinancialEffect", "recurringFinancialEffect"]);
});

test("Test 61.19 (R2′): the EXACT-update analogue — a SKIPPED update followed by another actor's ordinary SAME-KIND update landing the intended state must not be established as this operation's", async () => {
  // The symmetric construction on the update path, via the
  // store-seeded EXACT record (as in 61.1/61.2) and the mirrored
  // skip hook `_debugSkipUpdateOnNextUpdate`: the dispatched
  // update returns a nominal success (artifact + generated
  // invoice) but persists nothing and journals nothing; a
  // distinct actor's ordinary update() then lands exactly the
  // intended quantity and journals exactly one kind:"update"
  // transition with a matching fingerprint. On the pre-fix code
  // the kind-only journal gate passes this foreign transition;
  // the receipt is then capped at COMMITTED_UNVERIFIED only by
  // the downstream M3 invoice check — which records the SKIPPED
  // call's invoice figures as this operation's DETERMINED
  // provider_actuals, i.e. it establishes an operation that
  // applied nothing. With identity binding the attribution gate
  // itself denies the chain (the skipped response carries no
  // operation identity; the journal's transition carries the
  // third party's), and the figures stay unestablished
  // candidates with both dimensions named.
  const nowSec = Math.floor(new Date("2026-08-01T00:00:00Z").getTime() / 1000);
  class SameKindUpdateSim extends StripeSim {
    private interposed = false;
    override update(...args: Parameters<StripeSim["update"]>): ReturnType<StripeSim["update"]> {
      if (this.interposed) return super.update(...args);
      this.interposed = true;
      // THIS dispatch, with the skip fault armed: nominal success
      // response, nothing persisted, nothing journaled.
      this._debugSkipUpdateOnNextUpdate = true;
      const dispatched = super.update(...args);
      // A distinct actor's ordinary update of the same kind lands
      // exactly the intended state.
      super.update(...args);
      // The adapter receives the FIRST call's result.
      return dispatched;
    }
  }
  const sim = new SameKindUpdateSim(nowSec);
  const { sub } = freshStripeFixture();
  sim.seedSubscription(structuredClone(sub));
  const store = new QuoteStore();
  const adapter = new StripeAdapter(sim, store);
  const quoteId = await exactQuantityQuote(adapter, store, sub.id, 120);
  const receipt = await adapter.commitChangeQuote(quoteId);
  assert.equal(sim.retrieve(sub.id).items[0].quantity, 120, "the intended state IS persisted — by the third party's update");
  const transitions = sim.listTransitions(sub.id, 0);
  assert.equal(transitions.length, 1, "construction precondition: the journal window holds exactly one transition");
  assert.equal(transitions[0].kind, "update", "construction precondition: of the dispatched kind");
  assert.equal(receipt.outcome, "COMMITTED_UNVERIFIED", "the matching landing was produced by a DIFFERENT operation of the same kind");
  assert.equal(receipt.reconciliation.status, "UNVERIFIED");
  assert.equal(receipt.committedEffect.provenance?.committedSource, "unestablished", "the skipped call's invoice figures must NOT be recorded as this operation's determined actuals — the operation applied nothing");
  assert.deepEqual(determinacyOf(receipt.committedEffect), {
    immediateFinancialEffect: "UNKNOWN",
    recurringFinancialEffect: "UNKNOWN",
  });
  assert.deepEqual(
    receipt.reconciliation.undeterminedDimensions,
    ["immediateFinancialEffect", "recurringFinancialEffect"],
    "an attribution-denied receipt whose figures are candidates names BOTH undetermined dimensions"
  );
});

test("Test 61.12: a VIOLATED receipt replays verbatim (no re-dispatch), and the one-shot fault does not leak into the next commit", async () => {
  const { sim, sub } = freshStripeFixture();
  const store = new QuoteStore();
  const adapter = new StripeAdapter(sim, store);
  const quoteId = await exactQuantityQuote(adapter, store, sub.id, 120);
  sim._debugWrongQuantityOnNextUpdate = 130;
  const receipt = await adapter.commitChangeQuote(quoteId);
  assert.equal(receipt.reconciliation.status, "VIOLATED");
  const replay = await adapter.commitChangeQuote(quoteId);
  assert.deepEqual(replay, receipt, "idempotent replay returns the recorded receipt; the mutation is not re-dispatched");
  assert.equal(sim.retrieve(sub.id).items[0].quantity, 130, "persisted state untouched by the replay");
  const quote2Id = await exactQuantityQuote(adapter, store, sub.id, 140);
  const receipt2 = await adapter.commitChangeQuote(quote2Id);
  assert.equal(receipt2.reconciliation.status, "OK", "the fault was one-shot: the next commit verifies cleanly");
  assert.equal(receipt2.resultingSnapshot.items[0].quantity, 140);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { QuoteStore } from "../src/store/quote-store.js";
import { PaddleAdapter } from "../src/adapters/paddle-adapter.js";
import { determinacyOf } from "../src/core/scq-engine.js";
import { freshPaddleFixture } from "./fixtures.js";

// SCQ v0.6.2 — PR-4 / PR #11 review corrections (P1–P3).
//
// Everything here runs against the in-memory Paddle simulator.
// All results are SIMULATED — no live Paddle API is involved, and
// nothing here is evidence about real Paddle behavior.
//
// Failing-first evidence (scratch probes run against the
// pre-correction head 91bd8db, using only pre-existing surface;
// the probe file was deleted after the run):
//   P1 (update): a successful update mutation followed by
//     persistent post-mutation get() failures made
//     commitChangeQuote THROW the raw PaddleSimError and record
//     NO receipt — the fallback snapshot went through
//     snapshotOf → fingerprint → another get(), which failed
//     again. Same for P1 (cancel).
//   P2: with _debugOmitImmediateTransaction on, previewUpdate
//     omitted the figure (correct surface behavior) but update()
//     persisted a transaction with incurredAmount 0 for a change
//     whose true incurred amount was 20000 — the hook shaped the
//     shared computation and rewrote the mutation's artifact.
//   P3a: a TERM_END commit whose subscription a concurrent actor
//     terminated IMMEDIATELY (before the boundary) verified as
//     COMMITTED / OK / defined_equal_exact — a premature
//     termination accepted as a verified scheduled cancellation.
//   P3b: a TERM_END commit whose scheduled date was changed to
//     2026-09-15 with the record's period end drifted to match
//     verified as COMMITTED / OK — the adapter compared the
//     scheduled date against the (drifted) period end instead of
//     the quoted effective date (2026-08-31).
//
// The corrections:
//   P1 — the unverified-candidate paths of BOTH establish methods
//     are constructed entirely from data already in hand (the
//     mutation response + the stored quote); their receipt
//     snapshot is snapshotFromMutationResponse, which performs NO
//     provider read and leaves the snapshot explicitly
//     unversioned. Once a mutation has succeeded, recording its
//     COMMITTED_UNVERIFIED receipt never depends on a subsequent
//     successful provider read. The sim gains a persistent fault
//     hook, _debugFailSubscriptionReadsAfterMutation, modeling
//     reads that fail after a mutation has landed.
//   P2 — _debugOmitImmediateTransaction suppresses the figure
//     only at previewUpdate's return boundary; the internal
//     computation update() uses always carries the true figure,
//     and the generated transaction persists the true
//     incurredAmount.
//   P3 — TERM_END verification compares scheduledChange.effectiveAt
//     against the QUOTED effective date, and a terminal read
//     establishes the cancellation only once that boundary has
//     been reached; a terminal read before it is a premature
//     termination — an established contradiction (MISMATCH /
//     VIOLATED class, per D3: the state WAS read and contradicts
//     the quoted outcome; UNVERIFIED is reserved for state that
//     cannot be read at all).

const GENEROUS_ENVELOPE = {
  maxImmediateNetIncrease: 1_000_000,
  maxImmediateCreditDecrease: 1_000_000,
  maxRecurringIncrease: 1_000_000,
};

// ---------------------------------------------------------------------------
// P1: post-mutation read-failure recovery — no further reads owed
// ---------------------------------------------------------------------------

test("Test 20.1 (P1): an update commit whose post-commit reads fail persistently still records COMMITTED_UNVERIFIED — no throw, no further read required", async () => {
  const { sim, sub } = freshPaddleFixture();
  const store = new QuoteStore();
  const adapter = new PaddleAdapter(sim, store);
  const before = await adapter.getSubscription(sub.id);
  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [{ action: "CHANGE_QUANTITY", itemId: before.items[0].id, quantity: 120 }],
    effectiveIntent: { type: "IMMEDIATE" },
    acceptanceEnvelope: GENEROUS_ENVELOPE,
  });

  // Every subscription read AFTER the mutation lands fails,
  // persistently (the new sim hook). Pre-correction, the
  // unverified fallback's snapshotOf → fingerprint → get() threw
  // here and the successful mutation recorded nothing.
  sim._debugFailSubscriptionReadsAfterMutation = true;

  const receipt = await adapter.commitChangeQuote(quote.id);
  assert.equal(receipt.status, "COMMITTED_UNVERIFIED", "the successful mutation records its unverified receipt without any further successful read");
  assert.equal(receipt.outcome, "COMMITTED_UNVERIFIED");
  assert.equal(receipt.reconciliation.status, "UNVERIFIED");
  assert.equal(receipt.committedEffect.provenance?.committedSource, "unestablished");
  assert.deepEqual(determinacyOf(receipt.committedEffect), {
    immediateFinancialEffect: "UNKNOWN",
    recurringFinancialEffect: "UNKNOWN",
  });
  assert.equal(receipt.committedEffect.immediate?.net, 20000, "the mutation response's candidate figures are recorded — as candidates");
  // The receipt snapshot is built from the mutation response
  // alone: it shows the landed item set, and its version is
  // explicitly UNVERSIONED — the post-mutation fingerprint could
  // not be established without a read, and none was owed.
  assert.equal(receipt.resultingSnapshot.items[0].quantity, 120);
  assert.equal(receipt.resultingSnapshot.version, "", "no fingerprint is fabricated for a snapshot no read established");

  // The receipt is durably recorded, and §6.10 replay returns the
  // ORIGINAL recorded receipt (replay itself needs no provider
  // read — it is served from the store before any sim access).
  assert.deepEqual(store.recordedReceipt(quote.id), receipt);
  const replay = await adapter.commitChangeQuote(quote.id);
  assert.deepEqual(replay, receipt);

  // The mutation really landed, with its true figures: the
  // transaction log (not gated by the subscription-read fault)
  // holds this mutation's transaction...
  const boundId = sim.latestTransactionId(sub.id)!;
  assert.equal(sim.retrieveTransaction(boundId).incurredAmount, 20000);
  // ...and once the fault is disarmed, the provider record shows
  // the landed change.
  sim._debugFailSubscriptionReadsAfterMutation = false;
  assert.equal(sim.get(sub.id).items[0].quantity, 120);
});

test("Test 20.2 (P1): a TERM_END cancel commit whose post-commit reads fail persistently still records COMMITTED_UNVERIFIED", async () => {
  const { sim, sub } = freshPaddleFixture();
  const store = new QuoteStore();
  const adapter = new PaddleAdapter(sim, store);
  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [{ action: "CANCEL" }],
    effectiveIntent: { type: "TERM_END" },
    guaranteeMode: "EXACT",
  });

  sim._debugFailSubscriptionReadsAfterMutation = true;

  const receipt = await adapter.commitChangeQuote(quote.id);
  assert.equal(receipt.status, "COMMITTED_UNVERIFIED", "the landed cancel records its unverified receipt without any further successful read");
  assert.equal(receipt.outcome, "COMMITTED_UNVERIFIED");
  assert.equal(receipt.reconciliation.status, "UNVERIFIED");
  assert.equal(receipt.committedEffect.provenance?.committedSource, "unestablished");
  // Snapshot from the cancel call's own returned subscription:
  // still active, scheduled cancellation in place — reported as
  // the mutation response's candidate state, unversioned.
  assert.equal(receipt.resultingSnapshot.status, "active");
  assert.equal(receipt.resultingSnapshot.term?.autoRenew, false);
  assert.equal(receipt.resultingSnapshot.version, "");
  assert.deepEqual(store.recordedReceipt(quote.id), receipt);

  sim._debugFailSubscriptionReadsAfterMutation = false;
  const record = sim.get(sub.id);
  assert.equal(record.status, "active");
  assert.equal(record.scheduledChange?.action, "cancel", "the cancellation did land provider-side — only its verification read failed");
});

test("Test 20.3 (P1): an IMMEDIATE cancel commit whose post-commit reads fail persistently still records COMMITTED_UNVERIFIED", async () => {
  const { sim, sub } = freshPaddleFixture();
  const store = new QuoteStore();
  const adapter = new PaddleAdapter(sim, store);
  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [{ action: "CANCEL" }],
    effectiveIntent: { type: "IMMEDIATE" },
    guaranteeMode: "EXACT",
  });

  sim._debugFailSubscriptionReadsAfterMutation = true;

  const receipt = await adapter.commitChangeQuote(quote.id);
  assert.equal(receipt.status, "COMMITTED_UNVERIFIED");
  assert.equal(receipt.reconciliation.status, "UNVERIFIED");
  assert.equal(receipt.committedEffect.provenance?.committedSource, "unestablished");
  assert.equal(receipt.resultingSnapshot.status, "canceled", "the snapshot reports the mutation response's terminal state — as a candidate, unversioned");
  assert.equal(receipt.resultingSnapshot.version, "");
  assert.deepEqual(store.recordedReceipt(quote.id), receipt);

  sim._debugFailSubscriptionReadsAfterMutation = false;
  assert.equal(sim.get(sub.id).status, "canceled", "the cancellation did land provider-side");
});

// ---------------------------------------------------------------------------
// P3: TERM_END verification — quoted date is the reference;
// premature termination is a contradiction, not a verification
// ---------------------------------------------------------------------------

test("Test 20.4 (P3): a TERM_END commit whose subscription was terminated BEFORE the quoted boundary is a MISMATCH, not a verified scheduled cancellation", async () => {
  const { sim, sub } = freshPaddleFixture();
  const adapter = new PaddleAdapter(sim, new QuoteStore());
  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [{ action: "CANCEL" }],
    effectiveIntent: { type: "TERM_END" },
    guaranteeMode: "EXACT",
  });

  // A concurrent actor terminates the subscription IMMEDIATELY in
  // the window after this commit's cancel call (which scheduled
  // the cancellation for the boundary) but before its read: the
  // provider ended the subscription EARLIER than the quoted
  // effective date — a different outcome than the one quoted.
  // Pre-correction this verified as TERMINAL ("already
  // effective") with reconciliation OK.
  const realCancel = sim.cancel.bind(sim);
  sim.cancel = ((...args: Parameters<typeof realCancel>) => {
    const result = realCancel(...args);
    sim._debugMutateDirectly(sub.id, (s) => {
      s.status = "canceled";
      s.scheduledChange = null;
    });
    return result;
  }) as typeof realCancel;

  const receipt = await adapter.commitChangeQuote(quote.id);
  assert.equal(receipt.status, "COMMITTED", "an established contradiction is a verified-class (negative) outcome, not unverified (D3)");
  assert.equal(receipt.outcome, "COMMITTED_AND_VERIFIED");
  assert.equal(receipt.reconciliation.status, "VIOLATED", "premature termination must NOT verify a scheduled cancellation");
  assert.ok(receipt.reconciliation.status === "VIOLATED" && /premature termination/i.test(receipt.reconciliation.reason));
  assert.equal(receipt.committedEffect.provenance?.committedSource, "provider_actual");
  assert.equal(
    receipt.committedEffect.recurring?.resultingAmount,
    100000,
    "the committed figures honestly report the observed state — never the quoted post-cancel zero for a state that contradicts the quote"
  );
});

test("Test 20.5 (P3): a scheduled date changed after quoting does not verify — even when the record's period end drifted to match it", async () => {
  const { sim, sub } = freshPaddleFixture();
  const adapter = new PaddleAdapter(sim, new QuoteStore());
  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [{ action: "CANCEL" }],
    effectiveIntent: { type: "TERM_END" },
    guaranteeMode: "EXACT",
  });
  assert.equal(quote.commercialEffect.effectiveAt, sub.currentBillingPeriod.endsAt, "the quoted effective date is the period boundary at quote time");

  // A later change moves the scheduled cancellation to a
  // different date AND drifts the record's billing-period end to
  // the same new date. Pre-correction the adapter compared the
  // scheduled date against the record's (drifted) period end and
  // verified SCHEDULED; the reference must be the QUOTED date.
  const drifted = "2026-09-15T00:00:00.000Z";
  const realCancel = sim.cancel.bind(sim);
  sim.cancel = ((...args: Parameters<typeof realCancel>) => {
    const result = realCancel(...args);
    sim._debugMutateDirectly(sub.id, (s) => {
      s.scheduledChange = { action: "cancel", effectiveAt: drifted };
      s.currentBillingPeriod = { ...s.currentBillingPeriod, endsAt: drifted };
    });
    return result;
  }) as typeof realCancel;

  const receipt = await adapter.commitChangeQuote(quote.id);
  assert.equal(receipt.status, "COMMITTED");
  assert.equal(receipt.outcome, "COMMITTED_AND_VERIFIED");
  assert.equal(receipt.reconciliation.status, "VIOLATED", "a scheduled date other than the quoted one is an established contradiction, not a verification");
  assert.ok(receipt.reconciliation.status === "VIOLATED" && /does not match the quoted/.test(receipt.reconciliation.reason));
});

test("Test 20.6 (P3): a scheduled date differing from the quoted date (period end unchanged) remains a MISMATCH", async () => {
  const { sim, sub } = freshPaddleFixture();
  const adapter = new PaddleAdapter(sim, new QuoteStore());
  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [{ action: "CANCEL" }],
    effectiveIntent: { type: "TERM_END" },
    guaranteeMode: "EXACT",
  });

  const realCancel = sim.cancel.bind(sim);
  sim.cancel = ((...args: Parameters<typeof realCancel>) => {
    const result = realCancel(...args);
    sim._debugMutateDirectly(sub.id, (s) => {
      s.scheduledChange = { action: "cancel", effectiveAt: "2026-09-15T00:00:00.000Z" };
    });
    return result;
  }) as typeof realCancel;

  const receipt = await adapter.commitChangeQuote(quote.id);
  assert.equal(receipt.reconciliation.status, "VIOLATED");
  assert.ok(receipt.reconciliation.status === "VIOLATED" && /does not match the quoted/.test(receipt.reconciliation.reason));
});

test("Test 20.7 (P3, control): a terminal read AT/AFTER the quoted boundary verifies — the scheduled cancellation has taken effect", async () => {
  const { sim, sub } = freshPaddleFixture();
  const adapter = new PaddleAdapter(sim, new QuoteStore());
  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [{ action: "CANCEL" }],
    effectiveIntent: { type: "TERM_END" },
    guaranteeMode: "EXACT",
  });

  // By the time of the verification read, the quoted boundary
  // (30 days out) has passed and the provider has applied the
  // scheduled cancellation: terminal state, schedule consumed.
  const realCancel = sim.cancel.bind(sim);
  sim.cancel = ((...args: Parameters<typeof realCancel>) => {
    const result = realCancel(...args);
    sim.advanceTimeSeconds(31 * 24 * 3600);
    sim._debugMutateDirectly(sub.id, (s) => {
      s.status = "canceled";
      s.scheduledChange = null;
    });
    return result;
  }) as typeof realCancel;

  const receipt = await adapter.commitChangeQuote(quote.id);
  assert.equal(receipt.status, "COMMITTED");
  assert.equal(receipt.outcome, "COMMITTED_AND_VERIFIED");
  assert.equal(receipt.reconciliation.status, "OK", "a terminal read once the quoted boundary has been reached IS the established scheduled cancellation, in effect");
  assert.equal(receipt.committedEffect.provenance?.committedSource, "defined_equal_exact");
  assert.equal(receipt.resultingSnapshot.status, "canceled");
});

// ---------------------------------------------------------------------------
// P2: the omit hook is preview-surface only — direct sim regression
// ---------------------------------------------------------------------------

test("Test 20.8 (P2): _debugOmitImmediateTransaction never shapes a mutation's artifact — update() persists the true incurred amount with the hook on", () => {
  const { sim, sub } = freshPaddleFixture();
  sim._debugOmitImmediateTransaction = true;

  // (i) The public preview surface omits the figure — the
  // established behavior the hook exists to model.
  const preview = sim.previewUpdate(sub.id, [{ priceId: "pri_seat_basic", quantity: 120 }], "prorated_immediately");
  assert.equal(preview.immediateTransaction, undefined, "the preview cannot establish the incurred figure under the hook");

  // (ii) The mutation itself computes from the UNSHAPED internal
  // computation: its persisted transaction carries the TRUE
  // incurred amount (20 x 1000 at period start = 20000).
  // Pre-correction it persisted 0 — the missing preview figure
  // had rewritten the artifact.
  const { transaction } = sim.update(sub.id, [{ priceId: "pri_seat_basic", quantity: 120 }], "prorated_immediately");
  assert.ok(transaction, "an immediate-mode update generates a transaction");
  const persisted = sim.retrieveTransaction(transaction.id);
  assert.equal(persisted.incurredAmount, 20000, "a missing preview figure must never turn a nonzero generated transaction into zero");
  assert.equal(persisted.total, 20000);

  // (iii) Hook off, the same update on an identical subscription
  // persists the identical amount — the hook is surface-only.
  const f2 = freshPaddleFixture();
  const preview2 = f2.sim.previewUpdate(f2.sub.id, [{ priceId: "pri_seat_basic", quantity: 120 }], "prorated_immediately");
  assert.equal(preview2.immediateTransaction?.incurredAmount, 20000);
  const u2 = f2.sim.update(f2.sub.id, [{ priceId: "pri_seat_basic", quantity: 120 }], "prorated_immediately");
  assert.equal(f2.sim.retrieveTransaction(u2.transaction!.id).incurredAmount, persisted.incurredAmount);
});

/**
 * Test 25 — SCQ v0.6.2 PR-6: Chargebee SIMULATOR migration.
 *
 * The simulator-backed adapter (chargebee-adapter.ts +
 * chargebee-sim.ts) is brought to the same v0.6.2 posture as
 * Stripe (PR #10), Paddle (PR #11) and Zuora (PR #14), including
 * PR #14's attribution doctrine (Z1–Z3):
 *
 *  - Quotes resolve the whole proposal against an EVOLVING item
 *    state into ONE final `update_for_items` request and take ONE
 *    estimate of that exact request; the stored request is verbatim
 *    what commit dispatches (pre-migration: per-change previews
 *    against the original state, deltas summed — probes A/B).
 *  - Every effect carries determinacy + provenance. An established
 *    zero is a present { net: 0 } (pre-migration the zero was
 *    re-encoded as absent — probe C / F-2). A figure the estimate
 *    withholds (catalog miss — pre-migration a silent 0, probe E)
 *    is UNKNOWN, never zero-filled. A committed-term cancellation's
 *    termination consequence is UNKNOWN by the sim's own
 *    `earlyTerminationChargeKnown` signal — the sim's invented
 *    pro-rata formula figure is never quoted (probe F).
 *  - M2 fail-closed: an UNKNOWN figure in the quoted or
 *    revalidated effect refuses the commit with
 *    QUOTE_NOT_DETERMINISTIC before any mutation.
 *  - M3 + attribution: committed figures come from the persisted
 *    mutation artifact THIS operation created (bound by id, read
 *    back via retrieveMutation) plus the re-read subscription
 *    state — never from the revalidated preview (pre-migration the
 *    preview WAS the committed effect — probe D / F-1). Chargebee
 *    has no native monotonic version, so attribution rests on the
 *    artifact's fingerprint bracket (state fingerprint before ==
 *    this commit's validated fingerprint; fingerprint after ==
 *    verification-time fingerprint). A broken bracket caps the
 *    outcome at COMMITTED_UNVERIFIED and — per Z3 — records no
 *    recurring figure for the commit.
 *
 * The EXPERIMENTAL LIVE adapter (reference/src/live/**) is out of
 * scope for this migration and untouched; every result here is
 * SIMULATED_PASS.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ChargebeeAdapter } from "../src/adapters/chargebee-adapter.js";
import { ChargebeeSim, ChargebeeSimError, type ChargebeeSubscription } from "../src/adapters/chargebee-sim.js";
import { QuoteStore, establishVerification } from "../src/store/quote-store.js";
import { SCQError } from "../src/core/types.js";

const START = new Date("2026-08-01T00:00:00.000Z");

function evergreenSub(overrides: Partial<ChargebeeSubscription> = {}): ChargebeeSubscription {
  return {
    id: "cb_test1",
    status: "active",
    subscriptionItems: [{ id: "item_1", itemPriceId: "ip_seat_basic_monthly", quantity: 100 }],
    currentTermStart: "2026-08-01T00:00:00.000Z",
    currentTermEnd: "2026-08-31T00:00:00.000Z",
    nextBillingAt: "2026-08-31T00:00:00.000Z",
    ...overrides,
  };
}

function committedTermSub(): ChargebeeSubscription {
  return evergreenSub({
    id: "cb_test2",
    contractTerm: {
      contractStart: "2026-06-01T00:00:00.000Z",
      contractEnd: "2027-05-31T00:00:00.000Z",
      actionAtTermEnd: "renew",
    },
  });
}

function fixture(sub: ChargebeeSubscription = evergreenSub()) {
  const sim = new ChargebeeSim(structuredClone(START));
  sim.seedSubscription(sub);
  const store = new QuoteStore();
  const adapter = new ChargebeeAdapter(sim, store);
  return { sim, store, adapter, sub };
}

const QTY = (quantity: number, itemId = "item_1") => ({ action: "CHANGE_QUANTITY", itemId, quantity }) as const;

/** REVALIDATE (the default mode) requires an explicit acceptance envelope. */
const GENEROUS_ENVELOPE = {
  maxImmediateNetIncrease: 1_000_000,
  maxImmediateCreditDecrease: 1_000_000,
  maxRecurringIncrease: 1_000_000,
};

// ---------------------------------------------------------------------------
// 25.1 — Multi-change pricing: repeated quantity changes on one item are
// priced ONCE, from the single final request (probe A regression).
// ---------------------------------------------------------------------------
test("Test 25.1: repeated quantity changes price from ONE final-request estimate; stored request == dispatched request", async () => {
  const { sim, adapter, sub } = fixture();
  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [QTY(120), QTY(150)],
    effectiveIntent: { type: "IMMEDIATE" }, acceptanceEnvelope: GENEROUS_ENVELOPE,
  });
  // The final request is [basic x150]: recurring 100000 -> 150000,
  // immediate = the final delta alone = 50000 (pre-migration: the
  // per-change deltas 20000 + 50000 summed to 70000).
  assert.equal(quote.commercialEffect.immediate?.net, 50000);
  assert.equal(quote.commercialEffect.recurring?.resultingAmount, 150000);
  assert.deepEqual(quote.commercialEffect.determinacy, {
    immediateFinancialEffect: "DETERMINED",
    recurringFinancialEffect: "DETERMINED",
  });

  // The stored provider request is the single final request.
  const metadata = quote.providerMetadata as { kind: string; input: { items: unknown; prorate: boolean } };
  assert.equal(metadata.kind, "update");
  assert.deepEqual(metadata.input, { items: [{ itemPriceId: "ip_seat_basic_monthly", quantity: 150 }], prorate: true });

  const receipt = await adapter.commitChangeQuote(quote.id);
  assert.equal(receipt.status, "COMMITTED");
  assert.equal(receipt.outcome, "COMMITTED_AND_VERIFIED");
  assert.equal(receipt.reconciliation.status, "OK");
  assert.equal(receipt.committedEffect.immediate?.net, 50000);
  assert.equal(receipt.committedEffect.recurring?.resultingAmount, 150000);
  assert.equal(receipt.committedEffect.provenance?.committedSource, "provider_actual");

  // Final-request equivalence, from the persisted artifact: the
  // request the mutation dispatched IS the request the quote stored.
  const artifacts = sim.mutationsFor(sub.id);
  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0].kind, "update");
  assert.deepEqual(artifacts[0].request, metadata.input);
  assert.equal(receipt.committedEffect.immediate?.net, artifacts[0].netImmediate);
});

// ---------------------------------------------------------------------------
// 25.2 — Multi-change pricing across different items (probe B regression),
// quantity+plan on one item (evolving state), and a cadence change.
// ---------------------------------------------------------------------------
test("Test 25.2a: changes on different items price from the final combined state", async () => {
  const two = evergreenSub({
    id: "cb_two",
    subscriptionItems: [
      { id: "item_1", itemPriceId: "ip_seat_basic_monthly", quantity: 100 },
      { id: "item_2", itemPriceId: "ip_seat_pro_monthly", quantity: 10 },
    ],
  });
  const { adapter, sub } = fixture(two);
  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [QTY(120, "item_1"), { action: "CHANGE_PLAN", itemId: "item_2", offeringRef: "plan:basic:monthly" }],
    effectiveIntent: { type: "IMMEDIATE" }, acceptanceEnvelope: GENEROUS_ENVELOPE,
  });
  // Final state: basic x120 (120000) + basic x10 (10000) = 130000,
  // from 115000 -> immediate delta 15000 (pre-migration the summed
  // per-change deltas double-counted change 1: 55000 in probe B's
  // shape).
  assert.equal(quote.commercialEffect.recurring?.previousAmount, 115000);
  assert.equal(quote.commercialEffect.recurring?.resultingAmount, 130000);
  assert.equal(quote.commercialEffect.immediate?.net, 15000);
  const receipt = await adapter.commitChangeQuote(quote.id);
  assert.equal(receipt.status, "COMMITTED");
  assert.equal(receipt.committedEffect.recurring?.resultingAmount, 130000);
  assert.deepEqual(
    receipt.resultingSnapshot.items.map((i) => [i.offeringRef, i.quantity]),
    [
      ["plan:basic:monthly", 120],
      ["plan:basic:monthly", 10],
    ]
  );
});

test("Test 25.2b: quantity + plan on the SAME item resolve against the evolving state", async () => {
  const { adapter, sub } = fixture();
  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [QTY(120), { action: "CHANGE_PLAN", itemId: "item_1", offeringRef: "plan:pro:monthly" }],
    effectiveIntent: { type: "IMMEDIATE" }, acceptanceEnvelope: GENEROUS_ENVELOPE,
  });
  // The plan swap carries the evolved quantity: pro x120 = 180000,
  // delta 80000. (A swap against the ORIGINAL quantity would price
  // pro x100 = 150000.)
  assert.equal(quote.commercialEffect.recurring?.resultingAmount, 180000);
  assert.equal(quote.commercialEffect.immediate?.net, 80000);
  const receipt = await adapter.commitChangeQuote(quote.id);
  assert.equal(receipt.committedEffect.recurring?.resultingAmount, 180000);
  assert.equal(receipt.resultingSnapshot.items[0].offeringRef, "plan:pro:monthly");
  assert.equal(receipt.resultingSnapshot.items[0].quantity, 120);
});

test("Test 25.2c: cadence change prices from the final request and carries the term dimension", async () => {
  const { adapter, sub } = fixture();
  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [{ action: "CHANGE_CADENCE", cadence: "ANNUAL" }],
    effectiveIntent: { type: "IMMEDIATE" }, acceptanceEnvelope: GENEROUS_ENVELOPE,
  });
  assert.equal(quote.commercialEffect.recurring?.resultingAmount, 1000000);
  assert.equal(quote.commercialEffect.recurring?.cadence, "ANNUAL");
  assert.equal(quote.commercialEffect.immediate?.net, 900000);
  assert.equal(quote.commercialEffect.term?.createsCommitment, "UNKNOWN");
  const receipt = await adapter.commitChangeQuote(quote.id);
  assert.equal(receipt.status, "COMMITTED");
  assert.equal(receipt.committedEffect.recurring?.cadence, "ANNUAL");
});

// ---------------------------------------------------------------------------
// 25.3 — Net-zero combined change: an established zero is a PRESENT
// { net: 0 }, DETERMINED (probe C / F-2 regression).
// ---------------------------------------------------------------------------
test("Test 25.3: a net-zero combined change quotes and commits a present, determined { net: 0 }", async () => {
  const { adapter, sub } = fixture();
  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [QTY(120), QTY(100)],
    effectiveIntent: { type: "IMMEDIATE" }, acceptanceEnvelope: GENEROUS_ENVELOPE,
  });
  assert.deepEqual(quote.commercialEffect.immediate, { net: 0 }, "an established zero is present — never re-encoded as absent");
  assert.equal(quote.commercialEffect.determinacy?.immediateFinancialEffect, "DETERMINED");
  assert.equal(quote.commercialEffect.recurring?.resultingAmount, 100000);

  const receipt = await adapter.commitChangeQuote(quote.id);
  assert.equal(receipt.status, "COMMITTED");
  assert.deepEqual(receipt.committedEffect.immediate, { net: 0 });
  assert.equal(receipt.committedEffect.determinacy?.immediateFinancialEffect, "DETERMINED");
  assert.equal(receipt.reconciliation.status, "OK");
});

// ---------------------------------------------------------------------------
// 25.4 — Missing data is UNKNOWN, never 0: a catalog-miss item makes the
// affected figures unestablishable end to end (probe E regression), and
// the M2 gate refuses the commit with zero mutations.
// ---------------------------------------------------------------------------
test("Test 25.4: catalog-miss item — quote and snapshot figures UNKNOWN; commit refused pre-mutation, state byte-identical", async () => {
  const bad = evergreenSub({
    id: "cb_bad",
    subscriptionItems: [
      { id: "item_1", itemPriceId: "ip_seat_basic_monthly", quantity: 100 },
      { id: "item_x", itemPriceId: "ip_retired_plan", quantity: 5 },
    ],
  });
  const { sim, adapter, sub } = fixture(bad);
  const before = JSON.stringify(sim.get(sub.id));

  const snapshot = await adapter.getSubscription(sub.id);
  assert.equal(snapshot.billing.recurringAmount, undefined, "no partial sum with the unpriceable item at 0");
  assert.equal(snapshot.billing.recurringAmountState, "UNKNOWN");

  const quote = await adapter.createChangeQuote(sub.id, { changes: [QTY(120)], effectiveIntent: { type: "IMMEDIATE" }, acceptanceEnvelope: GENEROUS_ENVELOPE });
  assert.equal(quote.commercialEffect.immediate, undefined);
  assert.equal(quote.commercialEffect.recurring?.resultingAmount, undefined);
  assert.equal(quote.commercialEffect.determinacy?.immediateFinancialEffect, "UNKNOWN");
  assert.equal(quote.commercialEffect.determinacy?.recurringFinancialEffect, "UNKNOWN");

  await assert.rejects(adapter.commitChangeQuote(quote.id), (err: unknown) => {
    assert.ok(err instanceof SCQError);
    assert.equal(err.code, "QUOTE_NOT_DETERMINISTIC");
    assert.equal((err as any).details.stage, "quoted");
    return true;
  });
  assert.equal(sim.mutationsFor(sub.id).length, 0, "zero mutating calls");
  assert.equal(JSON.stringify(sim.get(sub.id)), before, "subscription state byte-identical after the refusal");
});

// ---------------------------------------------------------------------------
// 25.5 — Credits stay economically distinct: the immediate dimension is
// ONLY the change's own incurred obligation (its line-item net). No
// amount-due / customer-balance / next-invoice figure exists in this
// model, and none is ever smuggled into `immediate`.
// ---------------------------------------------------------------------------
test("Test 25.5: immediate carries only the incurred obligation's own charge/credit/net — no balance or amount-due figure", async () => {
  const { sim, adapter, sub } = fixture();
  // A quantity DECREASE incurs a credit — the change's own credit,
  // distinct from any customer balance or invoice amount due.
  const quote = await adapter.createChangeQuote(sub.id, { changes: [QTY(80)], effectiveIntent: { type: "IMMEDIATE" }, acceptanceEnvelope: GENEROUS_ENVELOPE });
  assert.deepEqual(quote.commercialEffect.immediate, { credit: 20000, net: -20000 });
  assert.match(quote.commercialEffect.provenance?.immediate ?? "", /obligation the change itself incurs/);

  // The simulator's estimate surface exposes ONLY the incurred line
  // items and the resulting price level — no payment-side figure.
  const estimate = sim.previewUpdate(sub.id, { items: [{ itemPriceId: "ip_seat_basic_monthly", quantity: 80 }], prorate: true });
  assert.deepEqual(Object.keys(estimate).sort(), ["invoiceEstimateLineItems", "netImmediate", "resultingCadence", "resultingRecurringAmount"]);

  const receipt = await adapter.commitChangeQuote(quote.id);
  assert.deepEqual(receipt.committedEffect.immediate, { credit: 20000, net: -20000 });
  assert.deepEqual(Object.keys(receipt.committedEffect.immediate!).sort(), ["credit", "net"]);
});

// ---------------------------------------------------------------------------
// 25.6 — UNKNOWN in the REVALIDATED effect also refuses pre-mutation.
// ---------------------------------------------------------------------------
test("Test 25.6: a figure that becomes unestablishable at revalidation refuses the commit (stage: revalidated)", async () => {
  const { sim, adapter, sub } = fixture();
  const quote = await adapter.createChangeQuote(sub.id, { changes: [QTY(120)], effectiveIntent: { type: "IMMEDIATE" }, acceptanceEnvelope: GENEROUS_ENVELOPE });
  assert.equal(quote.commercialEffect.determinacy?.immediateFinancialEffect, "DETERMINED");
  const before = JSON.stringify(sim.get(sub.id));

  sim._debugOmitPreviewImmediate = true;
  await assert.rejects(adapter.commitChangeQuote(quote.id), (err: unknown) => {
    assert.ok(err instanceof SCQError);
    assert.equal(err.code, "QUOTE_NOT_DETERMINISTIC");
    assert.equal((err as any).details.stage, "revalidated");
    assert.equal((err as any).details.dimension, "immediateFinancialEffect");
    return true;
  });
  assert.equal(sim.mutationsFor(sub.id).length, 0, "zero mutating calls");
  assert.equal(JSON.stringify(sim.get(sub.id)), before);
});

// ---------------------------------------------------------------------------
// 25.7 — Independent committed evidence: the committed figures come from
// the bound artifact + re-read state, NOT from the revalidated preview
// (probe D / F-1 regression, adversarially: corrupt the revalidation).
// ---------------------------------------------------------------------------
test("Test 25.7: committed figures are established from the bound artifact even when the revalidation preview is corrupted", async () => {
  const { sim, adapter, sub } = fixture();
  const quote = await adapter.createChangeQuote(sub.id, { changes: [QTY(120)], effectiveIntent: { type: "IMMEDIATE" }, acceptanceEnvelope: GENEROUS_ENVELOPE });

  const realPreview = sim.previewUpdate.bind(sim);
  let calls = 0;
  sim.previewUpdate = ((...args: Parameters<typeof realPreview>) => {
    calls += 1;
    const result = realPreview(...args);
    // Corrupt every preview AFTER the quote's own: the revalidation
    // now claims an absurd figure. The committed effect must not
    // follow it (pre-migration it WAS the committed effect).
    return calls > 1 ? { ...result, netImmediate: 999999 } : result;
  }) as typeof realPreview;

  const receipt = await adapter.commitChangeQuote(quote.id);
  assert.equal(receipt.status, "COMMITTED");
  assert.equal(receipt.committedEffect.immediate?.net, 20000, "the artifact's actual — not the corrupted preview's 999999");
  assert.equal(receipt.reconciliation.status, "OK");
  const artifact = sim.mutationsFor(sub.id)[0];
  assert.match(receipt.committedEffect.provenance?.immediate ?? "", new RegExp(artifact.id));
});

// ---------------------------------------------------------------------------
// 25.8 — Attributable wrong landing: the operation provably landed wrong
// (closed bracket) -> determined VIOLATED with the operation's own actuals.
// ---------------------------------------------------------------------------
test("Test 25.8: an attributable wrong landing is a determined VIOLATED with the operation's own actual figures", async () => {
  const { sim, adapter, sub } = fixture();
  const quote = await adapter.createChangeQuote(sub.id, { changes: [QTY(120)], effectiveIntent: { type: "IMMEDIATE" }, acceptanceEnvelope: GENEROUS_ENVELOPE });
  sim._debugWrongQuantityOnNextUpdate = 130;
  const receipt = await adapter.commitChangeQuote(quote.id);
  assert.equal(receipt.status, "COMMITTED");
  assert.equal(receipt.outcome, "COMMITTED_AND_VERIFIED");
  assert.equal(receipt.reconciliation.status, "VIOLATED");
  assert.equal(receipt.committedEffect.recurring?.resultingAmount, 130000, "the observed landing, not the quoted 120000");
  assert.equal(receipt.committedEffect.immediate?.net, 30000, "the bound artifact's actual for the landing that occurred");
  assert.equal(receipt.committedEffect.provenance?.committedSource, "provider_actual");
  assert.equal(receipt.resultingSnapshot.items[0].quantity, 130);
});

// ---------------------------------------------------------------------------
// 25.9 — Third-party mutation in the mutate->verify window breaks
// attribution: COMMITTED_UNVERIFIED, and (Z3) NO recurring figure is
// recorded for this commit — the observed level is context only.
// ---------------------------------------------------------------------------
test("Test 25.9: a third-party mutation after this commit's operation caps at COMMITTED_UNVERIFIED with no committed recurring figure (Z3)", async () => {
  const { sim, adapter, sub } = fixture();
  const quote = await adapter.createChangeQuote(sub.id, { changes: [QTY(120)], effectiveIntent: { type: "IMMEDIATE" }, acceptanceEnvelope: GENEROUS_ENVELOPE });

  const realUpdate = sim.updateForItems.bind(sim);
  sim.updateForItems = ((...args: Parameters<typeof realUpdate>) => {
    const out = realUpdate(...args);
    sim._debugMutateDirectly(sub.id, (s) => {
      s.subscriptionItems[0].quantity = 999;
    });
    return out;
  }) as typeof realUpdate;

  const receipt = await adapter.commitChangeQuote(quote.id);
  assert.equal(receipt.status, "COMMITTED_UNVERIFIED");
  assert.equal(receipt.outcome, "COMMITTED_UNVERIFIED");
  assert.equal(receipt.reconciliation.status, "UNVERIFIED");
  assert.deepEqual(receipt.reconciliation.undeterminedDimensions, ["recurringFinancialEffect"]);
  // Z3: this commit's bound-artifact immediate is established; NO
  // recurring figure is recorded as this commit's actual.
  assert.equal(receipt.committedEffect.immediate?.net, 20000);
  assert.equal(receipt.committedEffect.determinacy?.immediateFinancialEffect, "DETERMINED");
  assert.equal(receipt.committedEffect.recurring?.resultingAmount, undefined);
  assert.equal(receipt.committedEffect.determinacy?.recurringFinancialEffect, "UNKNOWN");
  assert.equal(receipt.committedEffect.provenance?.committedSource, "unestablished");
  // The third-party-influenced state survives only as context.
  assert.equal(receipt.resultingSnapshot.billing.recurringAmount, 999000);
  assert.match(receipt.reconciliation.reason ?? "", /fingerprint bracket does not close/);
});

// ---------------------------------------------------------------------------
// 25.10 — Broken attribution with a COINCIDENTALLY matching final state:
// still UNVERIFIED (Z1 — attribution precedes classification).
// ---------------------------------------------------------------------------
test("Test 25.10: broken attribution with a coincidentally matching final state is still COMMITTED_UNVERIFIED", async () => {
  const { sim, adapter, sub } = fixture();
  const quote = await adapter.createChangeQuote(sub.id, { changes: [QTY(120)], effectiveIntent: { type: "IMMEDIATE" }, acceptanceEnvelope: GENEROUS_ENVELOPE });

  const realUpdate = sim.updateForItems.bind(sim);
  sim.updateForItems = ((...args: Parameters<typeof realUpdate>) => {
    const out = realUpdate(...args);
    // A third party changes the quantity away and back: the final
    // state matches the intent exactly, but the state history is
    // not this commit's alone.
    sim._debugMutateDirectly(sub.id, (s) => {
      s.subscriptionItems[0].quantity = 777;
    });
    sim._debugMutateDirectly(sub.id, (s) => {
      s.subscriptionItems[0].quantity = 120;
    });
    return out;
  }) as typeof realUpdate;

  const receipt = await adapter.commitChangeQuote(quote.id);
  assert.equal(receipt.resultingSnapshot.items[0].quantity, 120, "the observed state matches the intent");
  assert.equal(receipt.status, "COMMITTED_UNVERIFIED", "matching state under broken attribution verifies nothing");
  assert.equal(receipt.reconciliation.status, "UNVERIFIED");
  assert.equal(receipt.committedEffect.recurring?.resultingAmount, undefined);
});

// ---------------------------------------------------------------------------
// 25.11 — Missing/unreadable persisted mutation evidence:
// COMMITTED_UNVERIFIED with candidate figures (P1: no further reads).
// ---------------------------------------------------------------------------
test("Test 25.11: an unreadable bound mutation artifact yields COMMITTED_UNVERIFIED candidates, built without further reads", async () => {
  const { sim, adapter, sub } = fixture();
  const quote = await adapter.createChangeQuote(sub.id, { changes: [QTY(120)], effectiveIntent: { type: "IMMEDIATE" }, acceptanceEnvelope: GENEROUS_ENVELOPE });
  (sim as any).retrieveMutation = () => {
    throw new ChargebeeSimError("api_connection_error", "artifact store unavailable (test-injected)");
  };
  const receipt = await adapter.commitChangeQuote(quote.id);
  assert.equal(receipt.status, "COMMITTED_UNVERIFIED");
  assert.equal(receipt.reconciliation.status, "UNVERIFIED");
  assert.equal(receipt.committedEffect.immediate?.net, 20000, "the mutation response's candidate figure");
  assert.deepEqual(receipt.committedEffect.determinacy, {
    immediateFinancialEffect: "UNKNOWN",
    recurringFinancialEffect: "UNKNOWN",
  });
  assert.equal(receipt.committedEffect.provenance?.committedSource, "unestablished");
  assert.equal(sim.get(sub.id).subscriptionItems[0].quantity, 120, "the mutation DID land — only its verification failed");
});

test("Test 25.11b: a persisted artifact WITHOUT financial actuals cannot establish figures — COMMITTED_UNVERIFIED candidates", async () => {
  const { sim, adapter, sub } = fixture();
  const quote = await adapter.createChangeQuote(sub.id, { changes: [QTY(120)], effectiveIntent: { type: "IMMEDIATE" }, acceptanceEnvelope: GENEROUS_ENVELOPE });
  sim._debugOmitMutationFinancials = true;
  const receipt = await adapter.commitChangeQuote(quote.id);
  assert.equal(receipt.status, "COMMITTED_UNVERIFIED");
  assert.equal(receipt.reconciliation.status, "UNVERIFIED");
  assert.match(receipt.reconciliation.reason ?? "", /carries no financial actuals/);
  assert.equal(receipt.committedEffect.provenance?.committedSource, "unestablished");
  const artifact = sim.mutationsFor(sub.id)[0];
  assert.equal(artifact.netImmediate, undefined, "the artifact persisted figureless (fault injection)");
  assert.equal(sim.get(sub.id).subscriptionItems[0].quantity, 120, "the mutation landed; only its evidence is missing");
});

// ---------------------------------------------------------------------------
// 25.12 — Subscription re-read failure after a landed mutation (P1).
// ---------------------------------------------------------------------------
test("Test 25.12: post-commit re-read failure still records COMMITTED_UNVERIFIED — no throw, no invented verification", async () => {
  const { sim, adapter, sub } = fixture();
  const quote = await adapter.createChangeQuote(sub.id, { changes: [QTY(120)], effectiveIntent: { type: "IMMEDIATE" }, acceptanceEnvelope: GENEROUS_ENVELOPE });
  sim._debugFailSubscriptionReadsAfterMutation = true;
  const receipt = await adapter.commitChangeQuote(quote.id);
  assert.equal(receipt.status, "COMMITTED_UNVERIFIED");
  assert.equal(receipt.outcome, "COMMITTED_UNVERIFIED");
  assert.equal(receipt.committedEffect.provenance?.committedSource, "unestablished");
  sim._debugFailSubscriptionReadsAfterMutation = false;
  assert.equal(sim.get(sub.id).subscriptionItems[0].quantity, 120, "the mutation landed; only the verification read failed");
});

// ---------------------------------------------------------------------------
// 25.13 — Lost response: INDETERMINATE, no receipt, no blind retry, and
// the operation landed exactly once.
// ---------------------------------------------------------------------------
test("Test 25.13: lost mutation response — INDETERMINATE, no receipt, retry refused, single landing", async () => {
  const { sim, store, adapter, sub } = fixture();
  const quote = await adapter.createChangeQuote(sub.id, { changes: [QTY(120)], effectiveIntent: { type: "IMMEDIATE" }, acceptanceEnvelope: GENEROUS_ENVELOPE });
  sim._debugLoseNextMutationResponse = true;
  await assert.rejects(adapter.commitChangeQuote(quote.id), (err: unknown) => {
    assert.ok(err instanceof SCQError);
    assert.equal(err.code, "PROVIDER_ERROR");
    assert.equal((err as any).details.outcome, "INDETERMINATE");
    return true;
  });
  assert.equal(store.get(quote.id)?.commit_receipt, undefined, "no receipt was recorded");
  assert.equal(sim.get(sub.id).subscriptionItems[0].quantity, 120, "the operation landed exactly once");

  await assert.rejects(adapter.commitChangeQuote(quote.id), (err: unknown) => {
    assert.ok(err instanceof SCQError);
    assert.equal((err as any).details.outcome, "INDETERMINATE");
    return true;
  });
  assert.equal(sim.mutationsFor(sub.id).length, 1, "no blind retry — still exactly one dispatched mutation");
});

// ---------------------------------------------------------------------------
// 25.14 — Confirmed pre-effect rejection: CONFIRMED_NON_EXECUTION is
// recorded distinctly, and a later retry is permitted.
// ---------------------------------------------------------------------------
test("Test 25.14: a pre-effect rejection is CONFIRMED_NON_EXECUTION (not INDETERMINATE) and retryable", async () => {
  const { sim, store, adapter, sub } = fixture();
  const quote = await adapter.createChangeQuote(sub.id, { changes: [QTY(120)], effectiveIntent: { type: "IMMEDIATE" }, acceptanceEnvelope: GENEROUS_ENVELOPE });
  const realUpdate = sim.updateForItems.bind(sim);
  let failOnce = true;
  sim.updateForItems = ((...args: Parameters<typeof realUpdate>) => {
    if (failOnce) {
      failOnce = false;
      throw new ChargebeeSimError("invalid_request", "rejected before effect (test-injected)");
    }
    return realUpdate(...args);
  }) as typeof realUpdate;

  await assert.rejects(adapter.commitChangeQuote(quote.id), (err: unknown) => {
    assert.ok(err instanceof SCQError);
    assert.equal((err as any).details.outcome, "CONFIRMED_NON_EXECUTION");
    return true;
  });
  assert.equal(store.get(quote.id)?.commit_outcome?.outcome, "CONFIRMED_NON_EXECUTION");
  assert.equal(sim.get(sub.id).subscriptionItems[0].quantity, 100, "nothing landed");

  const receipt = await adapter.commitChangeQuote(quote.id);
  assert.equal(receipt.status, "COMMITTED", "a confirmed non-execution may be retried");
});

// ---------------------------------------------------------------------------
// 25.15 — Quote expiration and fingerprint mismatch both refuse with no
// mutation.
// ---------------------------------------------------------------------------
test("Test 25.15: expired quote -> QUOTE_EXPIRED; changed subscription -> QUOTE_STALE; neither mutates", async () => {
  const a = fixture();
  const expiredQuote = await a.adapter.createChangeQuote(a.sub.id, { changes: [QTY(120)], effectiveIntent: { type: "IMMEDIATE" }, acceptanceEnvelope: GENEROUS_ENVELOPE });
  // The store's reads are defensive copies (copy-on-read egress),
  // so expiring the quote requires reaching the stored record
  // itself — test-side surgery on the in-memory store only.
  (a.store as any).quotes.get(expiredQuote.id).expires_at = new Date(Date.now() - 1000).toISOString();
  await assert.rejects(a.adapter.commitChangeQuote(expiredQuote.id), (err: unknown) => {
    assert.ok(err instanceof SCQError);
    assert.equal(err.code, "QUOTE_EXPIRED");
    return true;
  });
  assert.equal(a.sim.mutationsFor(a.sub.id).length, 0);

  const b = fixture();
  const staleQuote = await b.adapter.createChangeQuote(b.sub.id, { changes: [QTY(120)], effectiveIntent: { type: "IMMEDIATE" }, acceptanceEnvelope: GENEROUS_ENVELOPE });
  b.sim._debugMutateDirectly(b.sub.id, (s) => {
    s.subscriptionItems[0].quantity = 105;
  });
  await assert.rejects(b.adapter.commitChangeQuote(staleQuote.id), (err: unknown) => {
    assert.ok(err instanceof SCQError);
    assert.equal(err.code, "QUOTE_STALE");
    return true;
  });
  assert.equal(b.sim.mutationsFor(b.sub.id).length, 0);
});

// ---------------------------------------------------------------------------
// 25.16 — Committed-term cancellation: the termination consequence is
// NOT established (probe F regression) — quoted UNKNOWN, commit refused.
// ---------------------------------------------------------------------------
test("Test 25.16: committed-term CANCEL quotes its termination consequence UNKNOWN (never the sim's formula figure) and refuses to commit", async () => {
  const { sim, adapter, sub } = fixture(committedTermSub());
  const before = JSON.stringify(sim.get(sub.id));
  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [{ action: "CANCEL" }],
    effectiveIntent: { type: "TERM_END" },
  });
  assert.equal(quote.commercialEffect.immediate, undefined, "the invented pro-rata fee is never quoted as a figure");
  assert.equal(quote.commercialEffect.determinacy?.immediateFinancialEffect, "UNKNOWN");
  assert.match(quote.commercialEffect.provenance?.immediate ?? "", /NOT established/);
  assert.equal(quote.commercialEffect.recurring?.resultingAmount, 0, "the post-cancellation level itself is protocol-defined");

  await assert.rejects(adapter.commitChangeQuote(quote.id), (err: unknown) => {
    assert.ok(err instanceof SCQError);
    assert.equal(err.code, "QUOTE_NOT_DETERMINISTIC");
    assert.equal((err as any).details.dimension, "immediateFinancialEffect");
    return true;
  });
  assert.equal(sim.mutationsFor(sub.id).length, 0, "zero mutating calls");
  assert.equal(JSON.stringify(sim.get(sub.id)), before, "state byte-identical — no cancellation was scheduled");
});

// ---------------------------------------------------------------------------
// 25.17 — Scheduled vs immediate cancellation, each verified against the
// QUOTED effective date; a premature terminal landing is VIOLATED (P3).
// ---------------------------------------------------------------------------
test("Test 25.17a: TERM_END cancel verifies SCHEDULED at the quoted date; IMMEDIATE cancel verifies TERMINAL", async () => {
  const a = fixture();
  const quoteA = await a.adapter.createChangeQuote(a.sub.id, {
    changes: [{ action: "CANCEL" }],
    effectiveIntent: { type: "TERM_END" },
  });
  assert.deepEqual(quoteA.commercialEffect.immediate, { net: 0 }, "evergreen: the termination consequence is an established zero");
  assert.equal(quoteA.commercialEffect.determinacy?.immediateFinancialEffect, "DETERMINED");
  const receiptA = await a.adapter.commitChangeQuote(quoteA.id);
  assert.equal(receiptA.status, "COMMITTED");
  assert.equal(receiptA.outcome, "COMMITTED_AND_VERIFIED");
  assert.equal(receiptA.committedEffect.provenance?.committedSource, "defined_equal_exact");
  const landedA = a.sim.get(a.sub.id);
  assert.equal(landedA.status, "non_renewing");
  assert.equal(landedA.scheduledCancellationAt, quoteA.commercialEffect.effectiveAt, "scheduled at the QUOTED date");
  // The cancel used the SEPARATE cancel_for_items operation.
  const artifactsA = a.sim.mutationsFor(a.sub.id);
  assert.equal(artifactsA.length, 1);
  assert.equal(artifactsA[0].kind, "cancel");
  assert.deepEqual(artifactsA[0].request, { endOfTerm: true });

  const b = fixture();
  const quoteB = await b.adapter.createChangeQuote(b.sub.id, {
    changes: [{ action: "CANCEL" }],
    effectiveIntent: { type: "IMMEDIATE" }, acceptanceEnvelope: GENEROUS_ENVELOPE,
  });
  const receiptB = await b.adapter.commitChangeQuote(quoteB.id);
  assert.equal(receiptB.status, "COMMITTED");
  assert.equal(b.sim.get(b.sub.id).status, "cancelled");
  assert.deepEqual(b.sim.mutationsFor(b.sub.id)[0].request, { endOfTerm: false });
});

test("Test 25.17b: a TERM_END cancel that lands TERMINAL immediately is an attributable VIOLATED (P3)", async () => {
  const { sim, adapter, sub } = fixture();
  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [{ action: "CANCEL" }],
    effectiveIntent: { type: "TERM_END" },
  });
  sim._debugCancelImmediatelyOnNextCancel = true;
  const receipt = await adapter.commitChangeQuote(quote.id);
  assert.equal(receipt.status, "COMMITTED");
  assert.equal(receipt.outcome, "COMMITTED_AND_VERIFIED");
  assert.equal(receipt.reconciliation.status, "VIOLATED");
  assert.match(receipt.reconciliation.reason ?? "", /premature\/immediate termination/);
  assert.equal(receipt.committedEffect.recurring?.resultingAmount, 100000, "the observed still-standing level — never the quoted post-cancel zero");
});

// ---------------------------------------------------------------------------
// 25.18 — §6.10: replay returns the ORIGINAL receipt, including after a
// later verification transition (PR #8 machinery).
// ---------------------------------------------------------------------------
test("Test 25.18 (§6.10): replay returns the original receipt even after a verification transition", async () => {
  const { sim, store, adapter, sub } = fixture();
  const quote = await adapter.createChangeQuote(sub.id, { changes: [QTY(120)], effectiveIntent: { type: "IMMEDIATE" }, acceptanceEnvelope: GENEROUS_ENVELOPE });
  sim._debugFailSubscriptionReadsAfterMutation = true;
  const first = await adapter.commitChangeQuote(quote.id);
  assert.equal(first.status, "COMMITTED_UNVERIFIED");

  const replay = await adapter.commitChangeQuote(quote.id);
  assert.deepEqual(replay, first, "§6.10: a repeated commit returns the original recorded receipt");

  sim._debugFailSubscriptionReadsAfterMutation = false;
  const artifact = sim.mutationsFor(sub.id)[0];
  const snapshot = await adapter.getSubscription(sub.id);
  const evidence = establishVerification(store.get(quote.id)!, {
    subscriptionRef: sub.id,
    committedEffect: {
      immediate: { net: artifact.netImmediate! },
      recurring: { resultingAmount: 120000, currency: "usd" },
      determinacy: { immediateFinancialEffect: "DETERMINED", recurringFinancialEffect: "DETERMINED" },
      provenance: {
        immediate: "persisted mutation artifact read back from the simulator (synthetic observation)",
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

  // §6.10 as corrected by PR #8 (R1): a replay returns the receipt
  // AS ORIGINALLY RECORDED — not the transitioned current view.
  // The verified state is exposed through the store's current-view
  // read, and the two are deliberately distinct records.
  const replayAfter = await adapter.commitChangeQuote(quote.id);
  assert.deepEqual(replayAfter, first, "§6.10: replay after a verification transition still returns the ORIGINAL recorded receipt");
  assert.equal(store.get(quote.id)?.commit_receipt?.status, "COMMITTED", "the current view carries the verified state");
  assert.equal(sim.mutationsFor(sub.id).length, 1, "replays never re-mutate");
});

// ---------------------------------------------------------------------------
// 25.19 — Capability / guarantee truthfulness: BEST_EFFORT, no DATE, no
// update-backed TERM_END, CANCEL combination refused.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// 25.20 — C1: a cancellation whose bound artifact carries NO financial
// evidence cannot be reported as financially verified, even when the
// cancellation landed and scheduled correctly.
// ---------------------------------------------------------------------------
test("Test 25.20 (C1): evergreen TERM_END cancel with figureless artifact — landed and scheduled, but COMMITTED_UNVERIFIED, immediate not DETERMINED", async () => {
  const { sim, adapter, sub } = fixture();
  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [{ action: "CANCEL" }],
    effectiveIntent: { type: "TERM_END" },
  });
  assert.deepEqual(quote.commercialEffect.immediate, { net: 0 });
  sim._debugOmitMutationFinancials = true;
  const receipt = await adapter.commitChangeQuote(quote.id);
  // The operation DID land and schedule correctly.
  const landed = sim.get(sub.id);
  assert.equal(landed.status, "non_renewing");
  assert.equal(landed.scheduledCancellationAt, quote.commercialEffect.effectiveAt);
  const artifact = sim.mutationsFor(sub.id)[0];
  assert.equal(artifact.kind, "cancel");
  assert.equal(artifact.cancelNetImmediate, undefined, "the artifact persisted without its financial evidence (fault injection)");
  assert.equal(artifact.earlyTerminationChargeKnown, true);
  // But no financial verification may be claimed from a figureless artifact.
  assert.equal(receipt.status, "COMMITTED_UNVERIFIED");
  assert.equal(receipt.outcome, "COMMITTED_UNVERIFIED");
  assert.equal(receipt.reconciliation.status, "UNVERIFIED");
  assert.notEqual(receipt.reconciliation.status, "OK");
  assert.equal(receipt.committedEffect.determinacy?.immediateFinancialEffect, "UNKNOWN", "the committed immediate is NOT determined — never the quoted zero copied through");
  assert.equal(receipt.committedEffect.immediate?.net, undefined, "no determined immediate figure is carried; any candidate is unestablished");
  assert.equal(receipt.committedEffect.provenance?.committedSource, "unestablished");
  assert.ok(receipt.reconciliation.undeterminedDimensions?.includes("immediateFinancialEffect"));
});

test("Test 25.21 (C1): a normal evergreen cancel with established artifact financials stays COMMITTED_AND_VERIFIED / OK", async () => {
  const { sim, adapter, sub } = fixture();
  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [{ action: "CANCEL" }],
    effectiveIntent: { type: "TERM_END" },
  });
  const receipt = await adapter.commitChangeQuote(quote.id);
  assert.equal(receipt.status, "COMMITTED");
  assert.equal(receipt.outcome, "COMMITTED_AND_VERIFIED");
  assert.equal(receipt.reconciliation.status, "OK");
  assert.deepEqual(receipt.committedEffect.immediate, { net: 0 });
  assert.equal(receipt.committedEffect.determinacy?.immediateFinancialEffect, "DETERMINED");
  assert.equal(receipt.committedEffect.provenance?.committedSource, "defined_equal_exact");
  const artifact = sim.mutationsFor(sub.id)[0];
  assert.equal(artifact.cancelNetImmediate, 0);
  assert.equal(artifact.earlyTerminationChargeKnown, true);
});

// ---------------------------------------------------------------------------
// 25.23 — C1 mirrored edge: an artifact whose execution signal says the
// termination consequence was NOT established (earlyTerminationChargeKnown
// !== true) cannot establish a financial figure at verification time, even
// if a figure value is present on the read-back artifact.
// ---------------------------------------------------------------------------
test("Test 25.23 (C1 mirrored): artifact earlyTerminationChargeKnown !== true at verification caps at COMMITTED_UNVERIFIED even with a figure present", async () => {
  const { sim, adapter, sub } = fixture();
  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [{ action: "CANCEL" }],
    effectiveIntent: { type: "TERM_END" },
  });
  const realRetrieve = sim.retrieveMutation.bind(sim);
  sim.retrieveMutation = ((id: string) => {
    const a = realRetrieve(id);
    return { ...a, earlyTerminationChargeKnown: false };
  }) as typeof realRetrieve;
  const receipt = await adapter.commitChangeQuote(quote.id);
  assert.equal(sim.get(sub.id).status, "non_renewing", "the cancellation landed");
  assert.equal(receipt.status, "COMMITTED_UNVERIFIED");
  assert.equal(receipt.outcome, "COMMITTED_UNVERIFIED");
  assert.equal(receipt.reconciliation.status, "UNVERIFIED");
  assert.equal(receipt.committedEffect.determinacy?.immediateFinancialEffect, "UNKNOWN");
  assert.equal(receipt.committedEffect.provenance?.committedSource, "unestablished");
  assert.ok(receipt.reconciliation.undeterminedDimensions?.includes("immediateFinancialEffect"));
});

test("Test 25.22 (C1): an established artifact cancel actual differing from the quote is carried as the actual — not a verified quoted zero", async () => {
  const { sim, adapter, sub } = fixture();
  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [{ action: "CANCEL" }],
    effectiveIntent: { type: "TERM_END" },
  });
  assert.deepEqual(quote.commercialEffect.immediate, { net: 0 }, "the quote established a zero termination consequence");
  sim._debugCancelNetImmediateOnNextCancel = 5000;
  const receipt = await adapter.commitChangeQuote(quote.id);
  const artifact = sim.mutationsFor(sub.id)[0];
  assert.equal(artifact.cancelNetImmediate, 5000, "the persisted artifact carries the established differing actual");
  assert.equal(artifact.earlyTerminationChargeKnown, true);
  // The receipt must carry the ARTIFACT's actual and reconcile it
  // honestly — never report the quoted zero as verified.
  assert.equal(receipt.committedEffect.immediate?.net, 5000, "the artifact's actual, not the quoted zero");
  assert.equal(receipt.committedEffect.determinacy?.immediateFinancialEffect, "DETERMINED");
  assert.equal(receipt.committedEffect.provenance?.committedSource, "provider_actual");
  assert.equal(receipt.reconciliation.status, "VIOLATED", "an established actual contradicting the quote is a determined negative verification, not OK");
  assert.equal(receipt.status, "COMMITTED");
  assert.equal(receipt.outcome, "COMMITTED_AND_VERIFIED");
  assert.equal(sim.get(sub.id).status, "non_renewing", "the cancellation itself landed and scheduled as quoted");
});

test("Test 25.19: capability reporting stays truthful — BEST_EFFORT, restricted intents, CANCEL never bundled", async () => {
  const { adapter, sub } = fixture();
  const caps = adapter.getCapabilities();
  assert.equal(caps.consistencyGuarantee, "BEST_EFFORT");
  assert.deepEqual(caps.quoteCapabilities.CHANGE_QUANTITY?.supportedEffectiveIntents, ["IMMEDIATE"]);
  assert.deepEqual(caps.quoteCapabilities.CANCEL?.supportedEffectiveIntents, ["IMMEDIATE", "TERM_END"]);
  for (const action of ["CHANGE_QUANTITY", "CHANGE_PLAN", "CHANGE_CADENCE", "CANCEL"] as const) {
    assert.equal(caps.quoteCapabilities[action]?.guaranteeCoverage.immediateFinancialEffect, "REVALIDATE");
    assert.equal(caps.quoteCapabilities[action]?.guaranteeCoverage.termEffect, "UNKNOWN");
  }

  await assert.rejects(
    adapter.createChangeQuote(sub.id, { changes: [{ action: "CANCEL" }], effectiveIntent: { type: "DATE", at: "2026-09-15" } }),
    (err: unknown) => err instanceof SCQError && err.code === "UNSUPPORTED_CHANGE"
  );
  await assert.rejects(
    adapter.createChangeQuote(sub.id, { changes: [QTY(120)], effectiveIntent: { type: "TERM_END" } }),
    (err: unknown) => err instanceof SCQError && err.code === "UNSUPPORTED_CHANGE"
  );
  await assert.rejects(
    adapter.createChangeQuote(sub.id, { changes: [{ action: "CANCEL" }, QTY(120)], effectiveIntent: { type: "IMMEDIATE" }, acceptanceEnvelope: GENEROUS_ENVELOPE }),
    (err: unknown) => err instanceof SCQError && err.code === "UNSUPPORTED_CHANGE",
    "CANCEL combined with another change is refused — update and cancel are separate operations"
  );
});

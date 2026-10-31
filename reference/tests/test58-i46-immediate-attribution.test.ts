import { test } from "node:test";
import assert from "node:assert/strict";
import { ChargebeeAdapter } from "../src/adapters/chargebee-adapter.js";
import { ChargebeeSim, type ChargebeeSubscription } from "../src/adapters/chargebee-sim.js";
import { QuoteStore, establishVerification } from "../src/store/quote-store.js";
import type { ProviderObservation } from "../src/core/types.js";

// SCQ v0.6.2 — Issue #46 audit: immediate-effect attribution under a
// broken fingerprint bracket (Chargebee simulator adapter).
//
// THE FINDING (test55.2 / G-20): when a third-party item addition
// lands in the validate -> dispatch window, the operation executes
// on a begin state this commit never validated. The persisted
// artifact prices its execution from THAT begin state
// (chargebee-sim computeUpdateEffect: netImmediate =
// price(dispatched list) - price(begin state), prorated), so the
// recorded immediate (12500) nets +20000 of authorized change
// against -7500 for deleting the third party's item. On unmodified
// main the figure is recorded DETERMINED. Issue #46 asks whether
// that classification is legitimate.
//
// THE AUDIT'S ANSWER (decision B — NARROW), proven by the geometry
// split these tests pin:
//   * The figure is attributable IFF the artifact's begin binding
//     holds: its recorded request is the dispatched request AND its
//     fingerprintBefore equals the fingerprint this commit
//     validated. Then the figure is priced exclusively from
//     (validated state, dispatched request) — interference AFTER
//     execution (the mutate -> verify window, test25.9's geometry)
//     contributes nothing to it, and DETERMINED is legitimate even
//     though the receipt caps at COMMITTED_UNVERIFIED.
//   * When the begin binding fails (validate -> dispatch window),
//     the figure is a function of third-party state: varying ONLY
//     the third party's quantity moves it 1:1 (58.2). Under spec
//     §6.15 ("no third-party or unattributed figure may be recorded
//     as this commit's determined actual") it may not be recorded
//     DETERMINED. It is recorded as a §3.10 CANDIDATE instead:
//     figure retained, determinacy UNKNOWN, committedSource
//     "unestablished", source disclosed in the provenance note,
//     reconciliation UNVERIFIED naming the dimension.
//
// FAILING-FIRST RECORD (measured against unmodified main
// b00e74b): 58.1, 58.2, 58.3, 58.4, 58.5, 58.7, 58.9, 58.10 FAIL
// on their classification assertions (the figure is DETERMINED
// where the audit requires a candidate) — the defect
// reproductions. 58.6, 58.8 are characterization PINS (pass
// before and after). 58.11, 58.12 are POSITIVE CONTROLS (pass
// before and after):
//   attributable figures — including a VIOLATED one — must REMAIN
//   DETERMINED; the narrowing must not overcorrect.
// All evidence is SIMULATED (the Chargebee simulator's own pricing
// and fingerprint mechanics). No live provider behavior is claimed.

const START = new Date("2026-08-01T00:00:00.000Z");

const GENEROUS_ENVELOPE = {
  maxImmediateNetIncrease: 1_000_000,
  maxImmediateCreditDecrease: 1_000_000,
  maxRecurringIncrease: 1_000_000,
};

const QTY = (quantity: number, itemId = "item_1") => ({ action: "CHANGE_QUANTITY", itemId, quantity }) as const;

function fixture(subOverrides: Partial<ChargebeeSubscription> = {}) {
  const sub: ChargebeeSubscription = {
    id: "cb_i46",
    status: "active",
    subscriptionItems: [{ id: "item_1", itemPriceId: "ip_seat_basic_monthly", quantity: 100 }],
    currentTermStart: "2026-08-01T00:00:00.000Z",
    currentTermEnd: "2026-08-31T00:00:00.000Z",
    nextBillingAt: "2026-08-31T00:00:00.000Z",
    ...subOverrides,
  };
  const sim = new ChargebeeSim(structuredClone(START));
  sim.seedSubscription(structuredClone(sub));
  const store = new QuoteStore();
  const adapter = new ChargebeeAdapter(sim, store);
  return { sim, store, adapter, sub };
}

async function quote120(adapter: ChargebeeAdapter, sub: ChargebeeSubscription, envelope = GENEROUS_ENVELOPE) {
  return adapter.createChangeQuote(sub.id, {
    changes: [QTY(120)],
    effectiveIntent: { type: "IMMEDIATE" },
    acceptanceEnvelope: envelope,
  });
}

/** Install the validate -> dispatch interposition: the third-party write lands inside the commit, after validation, before execution. */
function inDispatchWindow(sim: ChargebeeSim, sub: ChargebeeSubscription, mutate: (s: ChargebeeSubscription) => void) {
  const realUpdate = sim.updateForItems.bind(sim);
  sim.updateForItems = ((...args: Parameters<typeof realUpdate>) => {
    sim._debugMutateDirectly(sub.id, mutate);
    return realUpdate(...args);
  }) as typeof realUpdate;
}

const ADD_PRO = (qty: number) => (s: ChargebeeSubscription) => {
  s.subscriptionItems.push({ id: "item_2", itemPriceId: "ip_seat_pro_monthly", quantity: qty });
};

/** The audit's required classification for a begin-unbound artifact figure: a §3.10 candidate. */
function assertCandidate(receipt: any, expectedNet: number) {
  assert.equal(receipt.status, "COMMITTED_UNVERIFIED");
  assert.equal(receipt.outcome, "COMMITTED_UNVERIFIED");
  assert.equal(receipt.reconciliation.status, "UNVERIFIED");
  assert.match(receipt.reconciliation.reason ?? "", /fingerprint bracket does not close/);
  // The figure is RETAINED (a candidate is the original figure a
  // later verification judges — never dropped, never zeroed).
  assert.equal(receipt.committedEffect.immediate?.net, expectedNet);
  // ...but it ESTABLISHES nothing: UNKNOWN determinacy,
  // unestablished source, provenance disclosing the candidate's
  // source, and the dimension named as undetermined.
  assert.equal(receipt.committedEffect.determinacy?.immediateFinancialEffect, "UNKNOWN");
  assert.equal(receipt.committedEffect.determinacy?.recurringFinancialEffect, "UNKNOWN");
  assert.equal(receipt.committedEffect.provenance?.committedSource, "unestablished");
  assert.match(receipt.committedEffect.provenance?.immediate ?? "", /CANDIDATE/);
  assert.deepEqual(receipt.reconciliation.undeterminedDimensions, [
    "immediateFinancialEffect",
    "recurringFinancialEffect",
  ]);
  assert.equal(receipt.committedEffect.recurring?.resultingAmount, undefined);
}

// ---------------------------------------------------------------------------
// 58.1 — (a) The original issue #46 scenario.
// ---------------------------------------------------------------------------

test("Test 58.1 (issue #46, case a): a third-party addition in the validate->dispatch window makes the artifact's immediate a candidate, not a determined actual", async () => {
  const { sim, adapter, sub } = fixture();
  const quote = await quote120(adapter, sub);
  assert.equal(quote.commercialEffect.immediate?.net, 20000, "the validated state's authorized delta");
  inDispatchWindow(sim, sub, ADD_PRO(5));

  const receipt = await adapter.commitChangeQuote(quote.id);
  assert.equal(sim.mutationsFor(sub.id).length, 1, "exactly one dispatch — no duplicate after an uncertain outcome");
  assert.deepEqual(
    sim.get(sub.id).subscriptionItems,
    [{ id: "item_1", itemPriceId: "ip_seat_basic_monthly", quantity: 120 }],
    "scenario mechanics unchanged: the authorized change landed and the concurrent item was deleted by the full-replacement dispatch",
  );
  // 12500 = +20000 (authorized) netted against -7500 (the third
  // party's 5 x 1500 item, deleted by this dispatch). The figure is
  // retained as the original figure for later verification, but it
  // is not this commit's determined actual.
  assertCandidate(receipt, 12500);
});

// ---------------------------------------------------------------------------
// 58.2 — (a2) Invariance probe: the disproof of independent
// attributability. Identical quote, identical dispatched operation;
// only the third party's quantity changes — the recorded figure
// moves 1:1 with it.
// ---------------------------------------------------------------------------

test("Test 58.2 (issue #46, case a2): the recorded figure varies 1:1 with the third party's quantity — it is not independently attributable to the dispatched operation", async () => {
  const { sim, adapter, sub } = fixture();
  const quote = await quote120(adapter, sub);
  inDispatchWindow(sim, sub, ADD_PRO(10));

  const receipt = await adapter.commitChangeQuote(quote.id);
  // 20000 - 10 x 1500 = 5000. Same operation, same authorization:
  // a figure that is a function of the third party's input cannot
  // be this operation's established actual.
  assertCandidate(receipt, 5000);
});

// ---------------------------------------------------------------------------
// 58.3 — (b) Concurrent PRICE change in the gap: the third party
// swaps the existing item's price id (monthly -> annual). The
// begin state's price basis is one this commit never validated.
// ---------------------------------------------------------------------------

test("Test 58.3 (issue #46, case b): a concurrent price-id swap in the validate->dispatch window contaminates the pricing basis — the artifact's large credit is a candidate", async () => {
  const { sim, adapter, sub } = fixture();
  const quote = await quote120(adapter, sub);
  inDispatchWindow(sim, sub, (s) => {
    s.subscriptionItems[0].itemPriceId = "ip_seat_basic_annual";
  });

  const receipt = await adapter.commitChangeQuote(quote.id);
  // Begin level priced at the swapped basis: 100 x 10000 = 1000000;
  // end level 120 x 1000 = 120000; artifact delta = -880000.
  assertCandidate(receipt, -880000);
  assert.equal(receipt.committedEffect.immediate?.credit, 880000, "the candidate retains its full shape — figure kept, claim removed");
});

// ---------------------------------------------------------------------------
// 58.4 — (c) Equal net amount, different third-party configurations.
// Two different begin states with the same price total produce the
// SAME recorded figure: the number carries no information about
// which third-party facts it nets.
// ---------------------------------------------------------------------------

test("Test 58.4 (issue #46, case c): different third-party configurations with equal price totals yield the identical figure — attribution cannot be read off the number", async () => {
  const run = async (mutate: (s: ChargebeeSubscription) => void) => {
    const { sim, adapter, sub } = fixture();
    const quote = await quote120(adapter, sub);
    inDispatchWindow(sim, sub, mutate);
    return adapter.commitChangeQuote(quote.id);
  };
  // Config X: add pro x5 -> begin 100000 + 7500 = 107500.
  const rx = await run(ADD_PRO(5));
  // Config Y: item_1 100 -> 97 AND add pro x7 -> begin 97000 + 10500 = 107500.
  const ry = await run((s) => {
    s.subscriptionItems[0].quantity = 97;
    s.subscriptionItems.push({ id: "item_2", itemPriceId: "ip_seat_pro_monthly", quantity: 7 });
  });
  assert.equal(rx.committedEffect.immediate?.net, 12500);
  assert.equal(ry.committedEffect.immediate?.net, 12500, "identical figure, different third-party facts");
  assertCandidate(rx, 12500);
  assertCandidate(ry, 12500);
});

// ---------------------------------------------------------------------------
// 58.5 — (d) The artifact read back is a DIFFERENT operation's: the
// mutating call's response carries the first operation's id, so the
// establishment reads operation A's artifact for operation B's
// commit. Its figure is not B's, under any reading.
// ---------------------------------------------------------------------------

test("Test 58.5 (issue #46, case d): an artifact belonging to a different operation cannot establish this commit's immediate — its figure is recorded only as a candidate", async () => {
  const { sim, adapter, sub } = fixture();
  // Operation A: a complete, clean commit (100 -> 120, figure 20000).
  const quoteA = await quote120(adapter, sub);
  const receiptA = await adapter.commitChangeQuote(quoteA.id);
  assert.equal(receiptA.outcome, "COMMITTED_AND_VERIFIED");
  const opA = sim.latestMutationId(sub.id);

  // Operation B: a new quote (120 -> 130, authorized delta 10000).
  // Its dispatch lands, but the response reports operation A's id,
  // so the establishment reads A's artifact back by that id.
  const quoteB = await adapter.createChangeQuote(sub.id, {
    changes: [QTY(130)],
    effectiveIntent: { type: "IMMEDIATE" },
    acceptanceEnvelope: GENEROUS_ENVELOPE,
  });
  const realUpdate = sim.updateForItems.bind(sim);
  sim.updateForItems = ((...args: Parameters<typeof realUpdate>) => {
    const out = realUpdate(...args);
    return { ...out, operationId: opA };
  }) as typeof realUpdate;

  const receiptB = await adapter.commitChangeQuote(quoteB.id);
  assert.equal(sim.get(sub.id).subscriptionItems[0].quantity, 130, "B's own dispatch did land");
  // The recorded figure is A's (20000) — not B's operation's
  // (30000 priced off B's begin state, not B's authorized 10000).
  // A different operation's figure is the limiting case of an
  // unattributed figure: candidate only, never determined.
  assertCandidate(receiptB, 20000);
});

// ---------------------------------------------------------------------------
// 58.6 — (e) PIN: a preview figure is never the committed source.
// The recorded figure always comes from the bound artifact (or the
// mutation response as a labeled candidate) — never from the
// revalidated preview, whose figure here (20000) differs from the
// artifact's (12500).
// ---------------------------------------------------------------------------

test("Test 58.6 (issue #46, case e) [PIN]: the committed figure is never sourced from a preview — artifact figures govern, and a figureless artifact leaves only response candidates", async () => {
  // Part 1: in the 58.1 geometry the recorded figure is the
  // artifact's 12500, NOT the validated/revalidated preview's
  // 20000 — on unmodified main and after the fix alike.
  {
    const { sim, adapter, sub } = fixture();
    const quote = await quote120(adapter, sub);
    inDispatchWindow(sim, sub, ADD_PRO(5));
    const receipt = await adapter.commitChangeQuote(quote.id);
    assert.equal(receipt.committedEffect.immediate?.net, 12500, "the artifact's figure, not the preview's 20000");
    assert.match(receipt.committedEffect.provenance?.immediate ?? "", /persisted mutation artifact/, "the provenance names the artifact — not a preview or estimate — as the figure's source");
  }
  // Part 2: with the artifact's financials omitted (sim fault), the
  // establishment falls back to the mutation response's CANDIDATES
  // — labeled unestablished under UNKNOWN determinacy, exactly the
  // §3.10 carve-out — never to a preview.
  {
    const { sim, adapter, sub } = fixture();
    const quote = await quote120(adapter, sub);
    sim._debugOmitMutationFinancials = true;
    const receipt = await adapter.commitChangeQuote(quote.id);
    assert.equal(receipt.status, "COMMITTED_UNVERIFIED");
    assert.equal(receipt.committedEffect.immediate?.net, 20000, "the clean response candidate");
    assert.equal(receipt.committedEffect.determinacy?.immediateFinancialEffect, "UNKNOWN");
    assert.equal(receipt.committedEffect.determinacy?.recurringFinancialEffect, "UNKNOWN");
    assert.equal(receipt.committedEffect.provenance?.committedSource, "unestablished");
  }
});

// ---------------------------------------------------------------------------
// 58.7 — (f) Post-commit observation from a DIFFERENT subscription,
// composed with the broken begin bracket: the foreign record
// supplies no figure and verifies nothing.
// ---------------------------------------------------------------------------

test("Test 58.7 (issue #46, case f): a foreign post-commit record under a broken begin bracket contributes no figure — the artifact's figure stays a candidate", async () => {
  const { sim, adapter, sub } = fixture();
  const quote = await quote120(adapter, sub);
  const realUpdate = sim.updateForItems.bind(sim);
  const realGet = sim.get.bind(sim);
  sim.updateForItems = ((...args: Parameters<typeof realUpdate>) => {
    sim._debugMutateDirectly(sub.id, ADD_PRO(5));
    const out = realUpdate(...args);
    // From here on, reads return a FOREIGN subscription's record
    // (different id, deliberately different items whose price total
    // — 120x1000 + 99x1500 — no figure in this test equals).
    sim.get = ((id: string) => {
      const landed = realGet(id);
      return { ...landed, id: "cb_FOREIGN", subscriptionItems: [...landed.subscriptionItems, { id: "item_9", itemPriceId: "ip_seat_pro_monthly", quantity: 99 }] };
    }) as typeof realGet;
    return out;
  }) as typeof realUpdate;

  const receipt = await adapter.commitChangeQuote(quote.id);
  sim.get = realGet;
  // The only figure recorded is the bound artifact's own (12500) —
  // as a candidate. The foreign record established nothing.
  assertCandidate(receipt, 12500);
});

// ---------------------------------------------------------------------------
// 58.8 — (g) PIN: provider response with incomplete provenance —
// the artifact persists a net figure but NO line items. The
// establishment treats the artifact as carrying no financial
// actuals and records response candidates only.
// ---------------------------------------------------------------------------

test("Test 58.8 (issue #46, case g) [PIN]: an artifact without line items establishes nothing — response candidates only, both dimensions UNKNOWN", async () => {
  const { sim, adapter, sub } = fixture();
  const quote = await quote120(adapter, sub);
  const realRetrieve = sim.retrieveMutation.bind(sim);
  sim.retrieveMutation = ((id: string) => {
    const art = realRetrieve(id);
    const { invoiceEstimateLineItems, ...rest } = art as any;
    return rest;
  }) as typeof realRetrieve;

  const receipt = await adapter.commitChangeQuote(quote.id);
  assert.equal(receipt.status, "COMMITTED_UNVERIFIED");
  assert.equal(receipt.reconciliation.status, "UNVERIFIED");
  assert.equal(receipt.committedEffect.determinacy?.immediateFinancialEffect, "UNKNOWN");
  assert.equal(receipt.committedEffect.determinacy?.recurringFinancialEffect, "UNKNOWN");
  assert.equal(receipt.committedEffect.provenance?.committedSource, "unestablished");
});

// ---------------------------------------------------------------------------
// 58.9 — (h) The candidate lifecycle: later INDEPENDENT evidence
// establishes the dimension against the recorded candidate
// (A-17-1: the candidate is judged, not matched), a conflicting
// actual is appended and flagged without replacing the accepted
// one, and the recorded receipt is never rewritten.
// ---------------------------------------------------------------------------

test("Test 58.9 (issue #46, case h): independent evidence later establishes the candidate's dimension; a conflicting actual flags the view UNVERIFIED and never rewrites the recorded receipt", async () => {
  const { sim, store, adapter, sub } = fixture();
  const quote = await quote120(adapter, sub);
  inDispatchWindow(sim, sub, ADD_PRO(5));
  const receipt = await adapter.commitChangeQuote(quote.id);
  assertCandidate(receipt, 12500);

  const observation = (immediateNet: number): ProviderObservation => ({
    subscriptionRef: sub.id,
    committedEffect: {
      immediate: { net: immediateNet },
      determinacy: { immediateFinancialEffect: "DETERMINED", recurringFinancialEffect: "UNKNOWN" },
      provenance: {
        immediate: "test58: independent post-commit read of the operation-bound charge record (simulated)",
        committedSource: "provider_actual",
      },
    },
    resultingSnapshot: {
      id: sub.id,
      version: "post-i46",
      status: "active",
      items: [{ id: "item_1", offeringRef: "ip_seat_basic_monthly", quantity: 120 }],
      billing: { currency: "usd", cadence: "MONTHLY", recurringAmount: 120000 },
    },
    source: "test58: independent post-commit provider reads (simulated)",
    observedAt: "2026-08-01T01:00:00.000Z",
  });

  // First independent observation establishes the immediate at the
  // same value the candidate recorded: the derived view now shows
  // it ESTABLISHED (from the evidence, not from the candidate),
  // while the receipt as a whole stays unverified (recurring is
  // still unestablished).
  const storedQuote = store.get(quote.id)!;
  const view1 = store.recordReceiptEvidence(quote.id, establishVerification(storedQuote, observation(12500)));
  assert.equal(view1.committedEffect.immediate?.net, 12500);
  assert.equal(view1.committedEffect.determinacy?.immediateFinancialEffect, "DETERMINED");
  assert.equal(view1.status, "COMMITTED_UNVERIFIED", "recurring remains unestablished — no promotion");

  // A second, conflicting established actual (20000): appended and
  // flagged; the accepted actual is NOT replaced; the view reads
  // UNVERIFIED naming the conflict — never an unqualified OK.
  const view2 = store.recordReceiptEvidence(quote.id, establishVerification(storedQuote, observation(20000)));
  assert.equal(view2.status, "COMMITTED_UNVERIFIED");
  assert.equal(view2.reconciliation.status, "UNVERIFIED");
  assert.match(view2.reconciliation.reason ?? "", /conflict/i);
  assert.equal(view2.committedEffect.immediate?.net, 12500, "the first accepted actual stands");

  // The RECORDED receipt (commit_receipt_recorded — the immutable
  // original, as distinct from the derived current view the store
  // keeps in commit_receipt) is untouched by all of this:
  // candidate figure, UNKNOWN determinacy, original
  // reconciliation.
  const recorded = store.get(quote.id)!.commit_receipt_recorded!;
  assert.equal(recorded.committedEffect.immediate?.net, 12500);
  assert.equal(recorded.committedEffect.determinacy?.immediateFinancialEffect, "UNKNOWN");
  assert.equal(recorded.reconciliation.status, "UNVERIFIED");
});

// ---------------------------------------------------------------------------
// 58.10 — (i) Partial application of a bundled change under a
// broken begin bracket: the state contradiction is CONTEXT, not a
// verified failure (Z1) — an unattributable effect must not be
// classified VIOLATED, and its figure is a candidate.
// ---------------------------------------------------------------------------

test("Test 58.10 (issue #46, case i): bundled change, wrong-quantity application, and a begin-window write — UNVERIFIED with a candidate figure, never VIOLATED", async () => {
  const { sim, adapter, sub } = fixture({
    subscriptionItems: [
      { id: "item_1", itemPriceId: "ip_seat_basic_monthly", quantity: 100 },
      { id: "item_2", itemPriceId: "ip_seat_pro_monthly", quantity: 5 },
    ],
  });
  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [QTY(120), QTY(10, "item_2")],
    effectiveIntent: { type: "IMMEDIATE" },
    acceptanceEnvelope: GENEROUS_ENVELOPE,
  });
  // Partial/wrong application: the first item lands at 130, not 120.
  sim._debugWrongQuantityOnNextUpdate = 130;
  // Begin-window write: item_2's quantity moves before execution.
  inDispatchWindow(sim, sub, (s) => {
    s.subscriptionItems[1].quantity = 6;
  });

  const receipt = await adapter.commitChangeQuote(quote.id);
  assert.notEqual(receipt.reconciliation.status, "VIOLATED", "an unattributable contradiction is context, not an established violation");
  // Artifact figure: begin (100x1000 + 6x1500 = 109000) -> applied
  // end (130x1000 + 10x1500 = 145000) = +36000 — retained as a
  // candidate, establishing nothing.
  assertCandidate(receipt, 36000);
});

// ---------------------------------------------------------------------------
// 58.11 — (j) POSITIVE CONTROL 1: a fully attributable committed
// obligation that VIOLATES the authorization envelope stays
// DETERMINED + VIOLATED. The narrowing must never suppress an
// independently established violation.
// ---------------------------------------------------------------------------

test("Test 58.11 (issue #46, case j) [POSITIVE CONTROL]: an attributable wrong landing exceeding the envelope remains DETERMINED and VIOLATED", async () => {
  const { sim, adapter, sub } = fixture();
  const quote = await quote120(adapter, sub, {
    maxImmediateNetIncrease: 25000,
    maxImmediateCreditDecrease: 1_000_000,
    maxRecurringIncrease: 1_000_000,
  });
  sim._debugWrongQuantityOnNextUpdate = 130;
  const receipt = await adapter.commitChangeQuote(quote.id);
  assert.equal(receipt.status, "COMMITTED");
  assert.equal(receipt.outcome, "COMMITTED_AND_VERIFIED");
  assert.equal(receipt.reconciliation.status, "VIOLATED");
  assert.equal(receipt.committedEffect.immediate?.net, 30000, "the operation's own actual for the landing that occurred");
  assert.equal(receipt.committedEffect.determinacy?.immediateFinancialEffect, "DETERMINED");
  assert.equal(receipt.committedEffect.provenance?.committedSource, "provider_actual");
});

// ---------------------------------------------------------------------------
// 58.12 — POSITIVE CONTROL 2 (the anti-overcorrection control for
// the narrowing itself): interference confined to the
// mutate -> verify window (test25.9's geometry) leaves the
// immediate DETERMINED — the operation began on exactly the state
// this commit validated, so its artifact figure is priced from the
// validated baseline alone.
// ---------------------------------------------------------------------------

test("Test 58.12 (issue #46) [POSITIVE CONTROL]: mutate->verify-window interference alone keeps the immediate DETERMINED (begin binding holds)", async () => {
  const { sim, adapter, sub } = fixture();
  const quote = await quote120(adapter, sub);
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
  assert.equal(receipt.reconciliation.status, "UNVERIFIED");
  assert.deepEqual(receipt.reconciliation.undeterminedDimensions, ["recurringFinancialEffect"]);
  assert.equal(receipt.committedEffect.immediate?.net, 20000, "priced from the validated baseline and the dispatched request alone");
  assert.equal(receipt.committedEffect.determinacy?.immediateFinancialEffect, "DETERMINED");
  assert.equal(receipt.committedEffect.recurring?.resultingAmount, undefined);
  assert.equal(receipt.committedEffect.determinacy?.recurringFinancialEffect, "UNKNOWN");
});

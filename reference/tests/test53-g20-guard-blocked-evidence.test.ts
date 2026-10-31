import { test } from "node:test";
import assert from "node:assert/strict";
import { ChargebeeAdapter } from "../src/adapters/chargebee-adapter.js";
import { ChargebeeSim, type ChargebeeSubscription } from "../src/adapters/chargebee-sim.js";
import { QuoteStore } from "../src/store/quote-store.js";
import { SCQError } from "../src/core/types.js";

// SCQ v0.6.2 — G-20 (Issue #29): simulator-level evidence for the
// property family the guard-blocked research harnesses cannot reach.
//
// repro43.1 / repro43.2 (Issue #22, Finding 1) fail in the research
// suite AT the PR-14 authorization-preservation gate: their
// Chargebee-LIVE commits are OPERATION-authorized (the default) and
// the live adapter is FULL_REPLACEMENT_ONLY, so every commit refuses
// pre-dispatch (AUTHORIZATION_PRESERVATION_UNENFORCEABLE) and the
// scenarios never reach a dispatch. That refusal is the converted,
// pinned behavior for the live adapter (test47.1/47.2/47.3) — these
// tests do NOT weaken, bypass, or re-litigate it, and the research
// suite is unchanged (11 pass / 7 fail) by design.
//
// What repro43 was designed to prove, in its disjunctive form: an
// execution affected by a never-authorized concurrent change must
// NOT be reported COMMITTED_AND_VERIFIED / OK — the commit refuses,
// or the receipt surfaces the interference. The two tests below pin
// that property on an adapter that DOES dispatch — the Chargebee
// simulator adapter — in the two windows the live repro exercised:
//
//   53.1  the quote -> commit window: an unrelated item added after
//         the quote refuses the commit QUOTE_STALE (the adapter's
//         fingerprint is a content hash over the FULL subscription
//         state, not only the changed items), with zero dispatches
//         and the concurrent item untouched.
//   53.2  the validate -> dispatch window: the same addition lands
//         after this commit's validation, before its mutation
//         executes (interleaved with the test25.9 wrapper
//         technique). The dispatch DOES land — and, because the
//         dispatched request is built from the validated state, the
//         concurrent item is deleted by it (asserted as scenario
//         mechanics, exactly as repro43.1 asserted them). The
//         receipt nevertheless NEVER reports verified success: the
//         mutation artifact's begin fingerprint differs from the
//         fingerprint this commit validated, the attribution
//         bracket does not close, and the receipt caps at
//         COMMITTED_UNVERIFIED / UNVERIFIED with NO committed
//         recurring figure.
//
// EVIDENCE LABELS (honest reach): 53.1/53.2 are DIRECT PROOF of the
// simulator adapter's full-state bracket and receipt classification.
// For the LIVE adapter's race they are ILLUSTRATIVE: the live
// dispatch is unreachable for OPERATION scope by design (test47),
// so no test can drive it without weakening the guard — and none
// here does. See research/g20-guard-blocked-evidence.md for the
// full seven-case accounting.
//
// PIN STATUS (disclosed): both tests passed on first run against
// unmodified main @ 9bb424b. They are regression pins for existing
// behavior, NOT failing-first defect reproductions; no
// implementation change accompanies them. One nuance they surface
// is recorded, not endorsed: in 53.2 the recorded immediate figure
// (12500) is the bound artifact's own actual, priced by the
// simulator from the state the operation BEGAN on — which already
// included the concurrent addition (begin recurring 107500 ->
// end 120000), not from the state this commit validated (where the
// authorized delta alone is 20000). The figure is pinned so any
// change to that pricing basis is deliberate and reviewed; the
// G-20 note flags it for maintainer attention.

const START = new Date("2026-08-01T00:00:00.000Z");

const GENEROUS_ENVELOPE = {
  maxImmediateNetIncrease: 1_000_000,
  maxImmediateCreditDecrease: 1_000_000,
  maxRecurringIncrease: 1_000_000,
};

const QTY = (quantity: number, itemId = "item_1") => ({ action: "CHANGE_QUANTITY", itemId, quantity }) as const;

function fixture() {
  const sub: ChargebeeSubscription = {
    id: "cb_g20",
    status: "active",
    subscriptionItems: [{ id: "item_1", itemPriceId: "ip_seat_basic_monthly", quantity: 100 }],
    currentTermStart: "2026-08-01T00:00:00.000Z",
    currentTermEnd: "2026-08-31T00:00:00.000Z",
    nextBillingAt: "2026-08-31T00:00:00.000Z",
  };
  const sim = new ChargebeeSim(structuredClone(START));
  sim.seedSubscription(structuredClone(sub));
  const store = new QuoteStore();
  const adapter = new ChargebeeAdapter(sim, store);
  return { sim, store, adapter, sub };
}

/** A third-party addition of an item the authorized change never names. */
const ADD_UNRELATED = (s: ChargebeeSubscription) => {
  s.subscriptionItems.push({ id: "item_2", itemPriceId: "ip_seat_pro_monthly", quantity: 5 });
};

// ---------------------------------------------------------------------------
// 53.1 — Unrelated addition in the quote -> commit window:
// QUOTE_STALE refusal, zero dispatches, the addition survives.
// ---------------------------------------------------------------------------

test("Test 53.1 (G-20, repro43 window 1): an unrelated item added between quote and commit refuses QUOTE_STALE with zero dispatches — the full-state fingerprint covers items the change never names", async () => {
  const { sim, adapter, sub } = fixture();
  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [QTY(120)],
    effectiveIntent: { type: "IMMEDIATE" },
    acceptanceEnvelope: GENEROUS_ENVELOPE,
  });

  // Third-party write in the quote -> commit window: an item the
  // authorized change (item_1 quantity 100 -> 120) never names.
  sim._debugMutateDirectly(sub.id, ADD_UNRELATED);

  await assert.rejects(
    () => adapter.commitChangeQuote(quote.id),
    (e: unknown) => e instanceof SCQError && e.code === "QUOTE_STALE",
  );
  assert.equal(sim.mutationsFor(sub.id).length, 0, "the refusal precedes any dispatch");
  assert.deepEqual(
    sim.get(sub.id).subscriptionItems,
    [
      { id: "item_1", itemPriceId: "ip_seat_basic_monthly", quantity: 100 },
      { id: "item_2", itemPriceId: "ip_seat_pro_monthly", quantity: 5 },
    ],
    "nothing was applied: the authorized change did not land and the concurrent item survives untouched",
  );
});

// ---------------------------------------------------------------------------
// 53.2 — Unrelated addition in the validate -> dispatch window:
// the dispatch lands (and deletes the addition — mechanics), but
// the receipt caps at COMMITTED_UNVERIFIED and never verifies.
// ---------------------------------------------------------------------------

test("Test 53.2 (G-20, repro43 window 2): an unrelated addition landing after validation but before the mutation executes is never reported verified — broken attribution bracket caps the receipt at COMMITTED_UNVERIFIED with no committed recurring figure", async () => {
  const { sim, adapter, sub } = fixture();
  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [QTY(120)],
    effectiveIntent: { type: "IMMEDIATE" },
    acceptanceEnvelope: GENEROUS_ENVELOPE,
  });

  // The third-party write lands INSIDE the commit: after this
  // commit's validation read, before its mutation executes (the
  // wrapper technique of test25.9, applied to the near edge of the
  // operation instead of the far edge).
  const realUpdate = sim.updateForItems.bind(sim);
  sim.updateForItems = ((...args: Parameters<typeof realUpdate>) => {
    sim._debugMutateDirectly(sub.id, ADD_UNRELATED);
    return realUpdate(...args);
  }) as typeof realUpdate;

  const receipt = await adapter.commitChangeQuote(quote.id);

  // ---- Scenario mechanics: the dispatch DID land, and because the
  // ---- dispatched request is the validated state's item list, the
  // ---- concurrent addition is deleted by it. This is the harm
  // ---- repro43.1 demonstrated on the live adapter; here it is
  // ---- reproduced on a dispatching adapter and DISCLOSED, not
  // ---- hidden — what the property below governs is the REPORT.
  assert.equal(sim.mutationsFor(sub.id).length, 1, "exactly one dispatch — this commit's");
  assert.deepEqual(
    sim.get(sub.id).subscriptionItems,
    [{ id: "item_1", itemPriceId: "ip_seat_basic_monthly", quantity: 120 }],
    "the authorized change landed (100 -> 120) and the never-authorized concurrent item is gone — deleted by the dispatch",
  );

  // ---- THE PROPERTY (repro43.1's classification half): an
  // ---- execution whose operation began on state this commit never
  // ---- validated must not be reported as a verified success.
  assert.equal(receipt.status, "COMMITTED_UNVERIFIED");
  assert.equal(receipt.outcome, "COMMITTED_UNVERIFIED");
  assert.equal(receipt.reconciliation.status, "UNVERIFIED");
  assert.match(
    (receipt.reconciliation as { reason?: string }).reason ?? "",
    /fingerprint bracket does not close/,
    "the classification names the broken attribution bracket",
  );
  // No committed recurring figure: the observed recurring level was
  // not produced by this commit alone, so it is not this commit's
  // actual (unattributed context lives only in the snapshot).
  assert.equal(receipt.committedEffect.recurring?.resultingAmount, undefined);
  assert.equal(receipt.committedEffect.determinacy?.recurringFinancialEffect, "UNKNOWN");
  // The recorded immediate is the bound artifact's own actual. Its
  // value (12500) is priced by the simulator off the state the
  // operation BEGAN on — already including the concurrent addition
  // (begin recurring 107500 -> end 120000) — not off the validated
  // state (authorized delta alone: 20000). Pinned deliberately so
  // any change to that pricing basis is reviewed; see the file
  // header and the G-20 note — recorded, not endorsed.
  assert.equal(receipt.committedEffect.immediate?.net, 12500);
  assert.equal(receipt.committedEffect.determinacy?.immediateFinancialEffect, "DETERMINED");
});

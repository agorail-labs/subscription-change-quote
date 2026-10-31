/**
 * Test 53 — SCQ conformance closure G-08 / V62-SV-02 (issue #29):
 * the Chargebee SIMULATOR adapter's update-path state establishment
 * migrates to the shared post-commit state-verification hook
 * (`verifyPostCommitState`, core/state-verification.ts) for the
 * item-set and subscription-identity dimensions.
 *
 * Equivalence analysis (full record in the PR body and the
 * V62-SV-02 traceability note):
 *
 *  - The adapter's previous item comparison was a sorted-multiset
 *    JSON equality over (itemPriceId, quantity) pairs of the
 *    COMPLETE dispatched request vs the re-read items — exactly
 *    the hook's FULL_ITEM_SET contract over the same tuples. On
 *    every state the simulator's data model can produce, the hook
 *    verdict (VERIFIED / MISMATCH) coincides with the old
 *    comparison (equal / not equal). Tests 53.2/53.3/53.5/53.6 are
 *    PINS: the old path was already correct on them, and they must
 *    pass identically before and after the migration.
 *  - The old path had NO subscription-identity check: its
 *    attribution fingerprint (chargebee-sim computeFingerprint)
 *    hashes status, items, term dates, scheduledCancellationAt and
 *    the write sequence — but NOT the record's `id`. A post-commit
 *    re-read that returns a record naming a DIFFERENT subscription
 *    (with this commit's exact landed items and a closed
 *    fingerprint bracket) therefore verified as
 *    COMMITTED_AND_VERIFIED / OK. Test 53.1 is the FAILING-FIRST
 *    regression for that overclaim: it fails against the
 *    un-migrated adapter and passes once the establishment passes
 *    `expectedSubscriptionRef` to the hook, whose identity check
 *    contradicts a foreign record.
 *  - Test 53.4 pins the missing-state posture (re-read unavailable
 *    after landing ⇒ COMMITTED_UNVERIFIED, never verified) on the
 *    unchanged pre-check branch.
 *
 * The adapter's status-stability check and its cancel-path
 * establishment remain adapter-owned (documented state-model
 * divergences from the hook's contract — see the traceability
 * note); nothing in this suite changes their behavior.
 *
 * Simulator only: every result here is SIMULATED evidence. No live
 * provider is touched.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ChargebeeAdapter } from "../src/adapters/chargebee-adapter.js";
import { ChargebeeSim, type ChargebeeSubscription } from "../src/adapters/chargebee-sim.js";
import { QuoteStore } from "../src/store/quote-store.js";

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

function fixture(sub: ChargebeeSubscription = evergreenSub()) {
  const sim = new ChargebeeSim(structuredClone(START));
  sim.seedSubscription(sub);
  const store = new QuoteStore();
  const adapter = new ChargebeeAdapter(sim, store);
  return { sim, store, adapter, sub };
}

const QTY = (quantity: number, itemId = "item_1") => ({ action: "CHANGE_QUANTITY", itemId, quantity }) as const;

const GENEROUS_ENVELOPE = {
  maxImmediateNetIncrease: 1_000_000,
  maxImmediateCreditDecrease: 1_000_000,
  maxRecurringIncrease: 1_000_000,
};

/**
 * Interpose on the sim so that subscription reads AFTER this
 * commit's update has landed pass through `tamper` — the
 * mutate→verify window technique of test25.9/25.10, applied to
 * the read side. The stored record is never modified (the sim's
 * `get` already returns a structured clone); only the adapter's
 * re-read sees the tampered record. This models a faulty read
 * surface: the subscription read returns a record other than the
 * one the operation bound, while the version/fingerprint surface
 * still attests the true stored state — so the fingerprint
 * bracket closes and the divergence is the establishment's to
 * catch, not the bracket's. (The sim's `fingerprint()` is itself
 * computed over `get`, so it is shielded: while fingerprinting,
 * reads are pristine. Everything here is synchronous, so the
 * swap is exact.)
 */
function tamperReadsAfterLanding(sim: ChargebeeSim, tamper: (sub: ChargebeeSubscription) => void): void {
  let landed = false;
  const realUpdate = sim.updateForItems.bind(sim);
  sim.updateForItems = ((...args: Parameters<typeof realUpdate>) => {
    const out = realUpdate(...args);
    landed = true;
    return out;
  }) as typeof realUpdate;
  const realGet = sim.get.bind(sim);
  sim.get = ((id: string) => {
    const sub = realGet(id);
    if (landed) tamper(sub);
    return sub;
  }) as typeof sim.get;
  const realFingerprint = sim.fingerprint.bind(sim);
  sim.fingerprint = ((id: string) => {
    const wrappedGet = sim.get;
    sim.get = realGet;
    try {
      return realFingerprint(id);
    } finally {
      sim.get = wrappedGet;
    }
  }) as typeof sim.fingerprint;
}

// ---------------------------------------------------------------------------
// 53.1 — FAILING-FIRST: a post-commit re-read naming a DIFFERENT
// subscription must not verify, even when the landed item set is
// exactly the dispatched one and the fingerprint bracket closes.
// (Pre-migration: no identity check existed on this path and the
// commit verified OK over the foreign record.)
// ---------------------------------------------------------------------------
test("Test 53.1: a post-commit re-read naming a different subscription is a determined VIOLATED, never a verified commit", async () => {
  const { sim, adapter, sub } = fixture();
  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [QTY(120)],
    effectiveIntent: { type: "IMMEDIATE" },
    acceptanceEnvelope: GENEROUS_ENVELOPE,
  });
  tamperReadsAfterLanding(sim, (s) => {
    s.id = "cb_foreign";
  });
  const receipt = await adapter.commitChangeQuote(quote.id);
  assert.equal(receipt.status, "COMMITTED");
  assert.equal(receipt.outcome, "COMMITTED_AND_VERIFIED");
  assert.equal(
    receipt.reconciliation.status,
    "VIOLATED",
    "state read from a different subscription is not evidence about this quote's subscription"
  );
  assert.match(receipt.reconciliation.reason ?? "", /cb_foreign/);
  assert.match(receipt.reconciliation.reason ?? "", /not the expected subscription "cb_test1"/);
});

// ---------------------------------------------------------------------------
// 53.2 — PIN: mismatched item quantity on landing ⇒ VIOLATED with
// the observed figure (the old sorted-multiset comparison decided
// this identically; the hook's per-item contradiction now names
// it).
// ---------------------------------------------------------------------------
test("Test 53.2: a landing at the wrong quantity is VIOLATED with the observed recurring figure", async () => {
  const { sim, adapter, sub } = fixture();
  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [QTY(120)],
    effectiveIntent: { type: "IMMEDIATE" },
    acceptanceEnvelope: GENEROUS_ENVELOPE,
  });
  sim._debugWrongQuantityOnNextUpdate = 130;
  const receipt = await adapter.commitChangeQuote(quote.id);
  assert.equal(receipt.status, "COMMITTED");
  assert.equal(receipt.outcome, "COMMITTED_AND_VERIFIED");
  assert.equal(receipt.reconciliation.status, "VIOLATED");
  assert.equal(receipt.committedEffect.recurring?.resultingAmount, 130000, "the observed landing, not the quoted 120000");
  assert.match(receipt.reconciliation.reason ?? "", /quantity mismatch for item ip_seat_basic_monthly: intended 120, actual 130/);
});

// ---------------------------------------------------------------------------
// 53.3 — PIN: a landing carrying a different item_price_id than
// dispatched ⇒ VIOLATED (multiset surplus/deficit on both ids).
// ---------------------------------------------------------------------------
test("Test 53.3: a landing on a different item price is VIOLATED", async () => {
  const { sim, adapter, sub } = fixture();
  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [QTY(120)],
    effectiveIntent: { type: "IMMEDIATE" },
    acceptanceEnvelope: GENEROUS_ENVELOPE,
  });
  sim._debugWrongItemPriceOnNextUpdate = "ip_seat_pro_monthly";
  const receipt = await adapter.commitChangeQuote(quote.id);
  assert.equal(receipt.status, "COMMITTED");
  assert.equal(receipt.reconciliation.status, "VIOLATED");
  assert.match(receipt.reconciliation.reason ?? "", /missing item ip_seat_basic_monthly/);
  assert.match(receipt.reconciliation.reason ?? "", /extra item ip_seat_pro_monthly/);
});

// ---------------------------------------------------------------------------
// 53.4 — PIN: the post-commit re-read is unavailable after the
// mutation landed ⇒ COMMITTED_UNVERIFIED; missing state never
// promotes to VERIFIED.
// ---------------------------------------------------------------------------
test("Test 53.4: an unavailable post-commit re-read caps the commit at COMMITTED_UNVERIFIED", async () => {
  const { sim, adapter, sub } = fixture();
  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [QTY(120)],
    effectiveIntent: { type: "IMMEDIATE" },
    acceptanceEnvelope: GENEROUS_ENVELOPE,
  });
  sim._debugFailSubscriptionReadsAfterMutation = true;
  const receipt = await adapter.commitChangeQuote(quote.id);
  assert.equal(receipt.status, "COMMITTED_UNVERIFIED");
  assert.equal(receipt.outcome, "COMMITTED_UNVERIFIED");
  assert.equal(receipt.reconciliation.status, "UNVERIFIED");
});

// ---------------------------------------------------------------------------
// 53.5 — PIN: the undisturbed happy path still verifies, with the
// hook computing the item-set verdict behind the same figures.
// ---------------------------------------------------------------------------
test("Test 53.5: an undisturbed update commit still verifies with the established figures", async () => {
  const { adapter, sub } = fixture();
  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [QTY(120)],
    effectiveIntent: { type: "IMMEDIATE" },
    acceptanceEnvelope: GENEROUS_ENVELOPE,
  });
  const receipt = await adapter.commitChangeQuote(quote.id);
  assert.equal(receipt.status, "COMMITTED");
  assert.equal(receipt.outcome, "COMMITTED_AND_VERIFIED");
  assert.equal(receipt.reconciliation.status, "OK");
  assert.equal(receipt.committedEffect.recurring?.resultingAmount, 120000);
  assert.equal(receipt.committedEffect.provenance?.committedSource, "provider_actual");
});

// ---------------------------------------------------------------------------
// 53.6 — PIN: an EXTRA item in the re-read set (beyond the
// dispatched request) ⇒ VIOLATED; a superset never verifies.
// ---------------------------------------------------------------------------
test("Test 53.6: an extra item in the post-commit state is VIOLATED", async () => {
  const { sim, adapter, sub } = fixture();
  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [QTY(120)],
    effectiveIntent: { type: "IMMEDIATE" },
    acceptanceEnvelope: GENEROUS_ENVELOPE,
  });
  tamperReadsAfterLanding(sim, (s) => {
    s.subscriptionItems.push({ id: "item_2", itemPriceId: "ip_seat_pro_monthly", quantity: 5 });
  });
  const receipt = await adapter.commitChangeQuote(quote.id);
  assert.equal(receipt.status, "COMMITTED");
  assert.equal(receipt.reconciliation.status, "VIOLATED");
  assert.match(receipt.reconciliation.reason ?? "", /extra item ip_seat_pro_monthly/);
});

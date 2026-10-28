import { test } from "node:test";
import assert from "node:assert/strict";
import { QuoteStore } from "../src/store/quote-store.js";
import { StripeAdapter } from "../src/adapters/stripe-adapter.js";
import { PaddleAdapter } from "../src/adapters/paddle-adapter.js";
import { ZuoraAdapter } from "../src/adapters/zuora-adapter.js";
import { SCQError } from "../src/core/types.js";
import { freshStripeFixture, freshPaddleFixture, freshZuoraFixture } from "./fixtures.js";

// v0.5 protocol-level tests, cross-provider (Chargebee-specific tests live
// in test11-chargebee.test.ts). Covers:
//   - effectiveIntent (v0.6; formerly requestedEffectiveAt): DATE is
//     refused on Stripe/Paddle (no native future-dating mechanism), IMMEDIATE
//     is always accepted, and DATE is honored on Zuora (native future-dated
//     orders).
//   - changes[] replacing action: multi-change proposals bundle atomically
//     where the provider genuinely supports it, and multiChangeConsistency
//     correctly reports ATOMIC / UNSUPPORTED per provider/action-pair.
//   - Single-change proposals behave identically to the pre-v0.5 shape
//     (regression coverage for the schema migration itself).

test("Test 10a: effectiveIntent DATE is REFUSED on Stripe with UNSUPPORTED_CHANGE — no native future-dating mechanism", async () => {
  const { sim, sub } = freshStripeFixture();
  const adapter = new StripeAdapter(sim, new QuoteStore());

  const farFuture = new Date(sim.currentTime() * 1000 + 15 * 24 * 3600 * 1000).toISOString();

  await assert.rejects(
    () =>
      adapter.createChangeQuote(sub.id, {
        changes: [{ action: "CHANGE_QUANTITY", itemId: "si_1", quantity: 120 }],
        effectiveIntent: { type: "DATE", at: farFuture },
        acceptanceEnvelope: { maxImmediateNetIncrease: 1_000_000, maxImmediateCreditDecrease: 1_000_000, maxRecurringIncrease: 1_000_000 },
      }),
    (err: unknown) => {
      assert.ok(err instanceof SCQError);
      assert.equal(err.code, "UNSUPPORTED_CHANGE");
      return true;
    }
  );

  // Confirm no side effect: refusal happens before any preview call.
  const after = await adapter.getSubscription(sub.id);
  assert.equal(after.items[0].quantity, 100);
});

test("Test 10b: effectiveIntent DATE is REFUSED on Paddle with UNSUPPORTED_CHANGE — same reasoning as Stripe", async () => {
  const { sim, sub } = freshPaddleFixture();
  const adapter = new PaddleAdapter(sim, new QuoteStore());
  const before = await adapter.getSubscription(sub.id);

  const farFuture = new Date(sim.currentTime().getTime() + 15 * 24 * 3600 * 1000).toISOString();

  await assert.rejects(
    () =>
      adapter.createChangeQuote(sub.id, {
        changes: [{ action: "CHANGE_QUANTITY", itemId: before.items[0].id, quantity: 120 }],
        effectiveIntent: { type: "DATE", at: farFuture },
        acceptanceEnvelope: { maxImmediateNetIncrease: 1_000_000, maxImmediateCreditDecrease: 1_000_000, maxRecurringIncrease: 1_000_000 },
      }),
    (err: unknown) => {
      assert.ok(err instanceof SCQError);
      assert.equal(err.code, "UNSUPPORTED_CHANGE");
      return true;
    }
  );
});

test("Test 10c: effectiveIntent IMMEDIATE is always accepted on Stripe/Paddle (no future-dating requested)", async () => {
  const { sim, sub } = freshStripeFixture();
  const adapter = new StripeAdapter(sim, new QuoteStore());

  // v0.6 note: v0.5's "requestedEffectiveAt within ~1 day of now is
  // tolerated" tested a tolerance window on a bare timestamp field. v0.6
  // replaced that field with the closed EffectiveIntent union — there is no
  // tolerance window anymore because IMMEDIATE simply IS immediate; a
  // caller who means "now" says so directly instead of supplying a
  // near-now timestamp.
  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [{ action: "CHANGE_QUANTITY", itemId: "si_1", quantity: 120 }],
    effectiveIntent: { type: "IMMEDIATE" },
    acceptanceEnvelope: { maxImmediateNetIncrease: 1_000_000, maxImmediateCreditDecrease: 1_000_000, maxRecurringIncrease: 1_000_000 },
  });
  assert.ok(quote.id);
});

test("Test 10d: effectiveIntent DATE IS honored on Zuora — native future-dated order mechanism", async () => {
  const { sim, sub } = freshZuoraFixture();
  const adapter = new ZuoraAdapter(sim, new QuoteStore());

  const farFuture = new Date(sim.currentTime().getTime() + 20 * 24 * 3600 * 1000).toISOString();

  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [{ action: "CHANGE_QUANTITY", itemId: "rpc_1", quantity: 130 }],
    effectiveIntent: { type: "DATE", at: farFuture },
    guaranteeMode: "EXACT",
  });
  assert.equal(quote.guaranteeCoverage.effectiveAt, "EXACT");
  assert.ok(quote.commercialEffect.effectiveAt);

  console.log("[Test 10d] Zuora honored a 20-day-future effectiveIntent DATE — quote effectiveAt:", quote.commercialEffect.effectiveAt);
});

test("Test 10e: multi-change proposal (CHANGE_QUANTITY + CHANGE_PLAN) is ATOMIC on Stripe — bundles into one items[] update", async () => {
  const { sim, sub } = freshStripeFixture();
  const adapter = new StripeAdapter(sim, new QuoteStore());

  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [
      { action: "CHANGE_QUANTITY", itemId: "si_1", quantity: 120 },
      { action: "CHANGE_PLAN", itemId: "si_1", offeringRef: "plan:pro:monthly" },
    ],
    effectiveIntent: { type: "IMMEDIATE" },
    acceptanceEnvelope: { maxImmediateNetIncrease: 1_000_000, maxImmediateCreditDecrease: 1_000_000, maxRecurringIncrease: 1_000_000 },
  });
  assert.equal(quote.multiChangeConsistency, "ATOMIC", "Stripe's items[] parameter genuinely bundles multiple item changes in one call");

  const receipt = await adapter.commitChangeQuote(quote.id);
  assert.equal(receipt.status, "COMMITTED");
  assert.equal(receipt.multiChangeConsistency, "ATOMIC");
  // The single item was quantity-changed AND plan-changed by the same commit.
  assert.equal(receipt.resultingSnapshot.items[0].quantity, 120);
  assert.equal(receipt.resultingSnapshot.billing.recurringAmount, 1500 * 120, "the LAST change in the batch (plan swap to pro) determines the resulting price, applied to the quantity from the first change");

  console.log("[Test 10e] Stripe multi-change (quantity+plan) committed atomically in one items[] update.");
});

test("Test 10f: multi-change proposal mixing CANCEL with CHANGE_QUANTITY is UNSUPPORTED on Stripe — refused outright, not silently sequenced", async () => {
  const { sim, sub } = freshStripeFixture();
  const adapter = new StripeAdapter(sim, new QuoteStore());

  await assert.rejects(
    () =>
      adapter.createChangeQuote(sub.id, {
        changes: [
          { action: "CHANGE_QUANTITY", itemId: "si_1", quantity: 120 },
          { action: "CANCEL" },
        ],
        effectiveIntent: { type: "IMMEDIATE" },
        acceptanceEnvelope: { maxImmediateNetIncrease: 1_000_000, maxImmediateCreditDecrease: 1_000_000, maxRecurringIncrease: 1_000_000 },
      }),
    (err: unknown) => {
      assert.ok(err instanceof SCQError);
      assert.equal(err.code, "UNSUPPORTED_CHANGE");
      return true;
    }
  );

  // Confirm no partial mutation happened — the whole proposal was refused
  // before any preview or provider call, not partially applied.
  const after = await adapter.getSubscription(sub.id);
  assert.equal(after.items[0].quantity, 100);
  assert.equal(after.status, "active");

  console.log("[Test 10f] Stripe correctly REFUSED a CANCEL+CHANGE_QUANTITY bundle rather than silently applying one and not the other.");
});

test("Test 10g: multi-change proposal is ATOMIC on Zuora even when it includes CANCEL — Zuora orders bundle any combination of order actions", async () => {
  const { sim, sub } = freshZuoraFixture();
  const adapter = new ZuoraAdapter(sim, new QuoteStore());

  // This is the concrete demonstration of the real Zuora capability v0.4
  // flagged as unreachable through SCQ: bundling CANCEL with another
  // change in one atomic operation. v0.5's changes[] finally lets a
  // caller ask for this, and Zuora's multiChangePairSupport (always
  // ATOMIC) reflects that it's genuinely possible.
  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [
      { action: "CHANGE_QUANTITY", itemId: "rpc_1", quantity: 110 },
      { action: "CANCEL" },
    ],
    effectiveIntent: { type: "TERM_END" },
    acceptanceEnvelope: { maxImmediateNetIncrease: 1_000_000, maxImmediateCreditDecrease: 1_000_000, maxRecurringIncrease: 1_000_000 },
  });
  assert.equal(quote.multiChangeConsistency, "ATOMIC", "Zuora orders can bundle ANY combination of order actions atomically, unlike Stripe/Paddle/Chargebee where CANCEL is a separate endpoint");

  const receipt = await adapter.commitChangeQuote(quote.id);
  assert.equal(receipt.status, "COMMITTED");
  assert.equal(receipt.multiChangeConsistency, "ATOMIC");
  assert.equal(receipt.resultingSnapshot.items[0].quantity, 110, "the quantity change applied");
  // PERIOD_END schedules cancellation without immediately flipping status
  // (same semantics as the single-action CANCEL test) — but autoRenew is
  // already false, confirming the cancellation half of the bundle WAS
  // applied by the same order/version bump as the quantity change.
  assert.equal(receipt.resultingSnapshot.status, "active", "PERIOD_END schedules cancellation; status stays active until the period actually ends");
  assert.equal(receipt.resultingSnapshot.term?.autoRenew, false, "but the cancellation itself was applied — same order, same version bump as the quantity change");

  console.log(
    "[Test 10g] Zuora bundled CHANGE_QUANTITY + CANCEL into ONE atomic order — a real capability Stripe/Paddle/" +
      "Chargebee do not have (their CANCEL endpoint is always separate from their item-update endpoint)."
  );
});

test("Test 10h: single-change proposal behaves identically to the pre-v0.5 shape (regression check for the schema migration)", async () => {
  const { sim, sub } = freshStripeFixture();
  const adapter = new StripeAdapter(sim, new QuoteStore());

  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [{ action: "CHANGE_QUANTITY", itemId: "si_1", quantity: 120 }],
    effectiveIntent: { type: "IMMEDIATE" },
    acceptanceEnvelope: { maxImmediateNetIncrease: 0, maxImmediateCreditDecrease: 0, maxRecurringIncrease: 0 },
  });
  assert.equal(quote.multiChangeConsistency, "ATOMIC", "single-change is always trivially ATOMIC");
  assert.ok(quote.commercialEffect.immediate);
  assert.equal(quote.commercialEffect.recurring?.resultingAmount, 1000 * 120);

  const receipt = await adapter.commitChangeQuote(quote.id);
  assert.equal(receipt.status, "COMMITTED");
  assert.equal(receipt.resultingSnapshot.items[0].quantity, 120);
  // PR-3 DISCLOSED EXPECTATION CHANGE (v0.6.2 Stripe migration):
  // whole-effect deepEqual(committedEffect, quotedEffect) is no
  // longer the contract — a committed effect carries committed
  // provenance (CORE-2: here, provider_actual figures read back
  // post-commit) that a quote-side effect never asserts. The
  // zero-drift FIGURES still match exactly; assert those.
  assert.deepEqual(receipt.committedEffect.immediate, receipt.quotedEffect.immediate, "single-change zero-drift case: committed figures still match the quote exactly");
  assert.deepEqual(receipt.committedEffect.recurring, receipt.quotedEffect.recurring);
  assert.equal(receipt.committedEffect.provenance?.committedSource, "provider_actual");
});

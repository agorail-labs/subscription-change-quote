import { test } from "node:test";
import assert from "node:assert/strict";
import { QuoteStore } from "../src/store/quote-store.js";
import { StripeAdapter } from "../src/adapters/stripe-adapter.js";
import { PaddleAdapter } from "../src/adapters/paddle-adapter.js";
import { freshStripeFixture, freshPaddleFixture } from "./fixtures.js";

test("Test 3 (Stripe): MONTHLY->ANNUAL — expose what's derivable, leave the rest undefined", async () => {
  const { sim, sub } = freshStripeFixture();
  const adapter = new StripeAdapter(sim, new QuoteStore());

  // v0.4 note: this was EXACT in v0.1-v0.3. Under v0.4's per-dimension
  // split, Stripe's CHANGE_CADENCE reports termEffect: UNKNOWN — exactly
  // the gap this test's own assertions below have documented since v0.1
  // (term.createsCommitment/commitmentUntil are UNKNOWN). REVALIDATE with
  // a permissive envelope is used since this test isn't probing drift.
  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [{ action: "CHANGE_CADENCE", cadence: "ANNUAL" }],
    effectiveIntent: { type: "IMMEDIATE" },
    acceptanceEnvelope: { maxImmediateNetIncrease: 1_000_000, maxImmediateCreditDecrease: 1_000_000, maxRecurringIncrease: 1_000_000 },
  });
  assert.equal(quote.guaranteeMode, "REVALIDATE");
  assert.equal(quote.multiChangeConsistency, "ATOMIC");

  // Derivable: new recurring amount, currency, effective date.
  assert.equal(quote.commercialEffect.recurring?.resultingAmount, 10000 * 100);
  assert.equal(quote.commercialEffect.recurring?.cadence, "ANNUAL");
  assert.ok(quote.commercialEffect.effectiveAt);

  // NOT derivable from a plain Stripe subscription price swap: whether this
  // creates any kind of commitment/lock-in period, or what autoRenew really
  // means beyond cancel_at_period_end. We explicitly leave these undefined
  // rather than inventing contract semantics that Stripe subscriptions
  // don't model.
  assert.equal(quote.commercialEffect.term?.createsCommitment, "UNKNOWN");
  assert.equal(quote.commercialEffect.term?.commitmentUntil, "UNKNOWN");

  console.log("[Test 3 / Stripe] commercialEffect:", JSON.stringify(quote.commercialEffect));
  console.log(
    "[Test 3 / Stripe] GAP: term.createsCommitment/commitmentUntil explicitly UNKNOWN — a plain Stripe subscription " +
      "price swap has no contract-term object to derive this from"
  );

  const receipt = await adapter.commitChangeQuote(quote.id);
  assert.equal(receipt.resultingSnapshot.billing.cadence, "ANNUAL");
  assert.equal(receipt.resultingSnapshot.billing.recurringAmount, 10000 * 100);
});

test("Test 3 (Paddle): MONTHLY->ANNUAL — expose what's derivable, leave the rest undefined", async () => {
  const { sim, sub } = freshPaddleFixture();
  const adapter = new PaddleAdapter(sim, new QuoteStore());

  // Paddle does not advertise EXACT for CHANGE_CADENCE (no proration_date
  // equivalent — see paddle-adapter.ts capabilitiesFor). REVALIDATE is the
  // v0.3 default, so it is omitted here and a permissive envelope is
  // supplied since this test isn't probing drift.
  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [{ action: "CHANGE_CADENCE", cadence: "ANNUAL" }],
    effectiveIntent: { type: "IMMEDIATE" },
    acceptanceEnvelope: { maxImmediateNetIncrease: 1_000_000, maxImmediateCreditDecrease: 1_000_000, maxRecurringIncrease: 1_000_000 },
  });
  assert.equal(quote.guaranteeMode, "REVALIDATE");
  assert.equal(quote.multiChangeConsistency, "ATOMIC");

  assert.equal(quote.commercialEffect.recurring?.resultingAmount, 10000 * 100);
  assert.equal(quote.commercialEffect.term?.createsCommitment, "UNKNOWN");
  assert.equal(quote.commercialEffect.term?.commitmentUntil, "UNKNOWN");

  console.log("[Test 3 / Paddle] commercialEffect:", JSON.stringify(quote.commercialEffect));
  console.log(
    "[Test 3 / Paddle] GAP: same as Stripe — Paddle Billing subscriptions also don't expose a distinct " +
      "contract-term object for a plain price/cadence swap, so commitment semantics are explicit UNKNOWN rather than guessed"
  );

  const receipt = await adapter.commitChangeQuote(quote.id);
  assert.equal(receipt.resultingSnapshot.billing.cadence, "ANNUAL");
  assert.equal(receipt.resultingSnapshot.billing.recurringAmount, 10000 * 100);
});

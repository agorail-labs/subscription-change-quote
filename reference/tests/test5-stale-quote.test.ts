import { test } from "node:test";
import assert from "node:assert/strict";
import { QuoteStore } from "../src/store/quote-store.js";
import { StripeAdapter } from "../src/adapters/stripe-adapter.js";
import { PaddleAdapter } from "../src/adapters/paddle-adapter.js";
import { SCQError } from "../src/core/types.js";
import { freshStripeFixture, freshPaddleFixture } from "./fixtures.js";

test("Test 5 (Stripe): stale quote — out-of-band mutation causes QUOTE_STALE, no double mutation", async () => {
  const { sim, sub } = freshStripeFixture();
  const adapter = new StripeAdapter(sim, new QuoteStore());

  // v0.4 note: this was EXACT in v0.1-v0.3; Stripe's CHANGE_QUANTITY now
  // reports termEffect: UNKNOWN under the per-dimension split, so an
  // overall EXACT request is refused (see test8-capabilities.test.ts).
  // REVALIDATE with a permissive envelope is used since this test's point
  // is staleness detection, not guarantee strength.
  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [{ action: "CHANGE_QUANTITY", itemId: "si_1", quantity: 120 }],
    effectiveIntent: { type: "IMMEDIATE" },
    acceptanceEnvelope: { maxImmediateNetIncrease: 1_000_000, maxImmediateCreditDecrease: 1_000_000, maxRecurringIncrease: 1_000_000 },
  });

  // Simulate another system/webhook changing the subscription directly,
  // bypassing SCQ entirely (e.g. a support agent action via the Stripe dashboard).
  sim._debugMutateDirectly(sub.id, (s) => {
    s.items[0].quantity = 150;
  });

  await assert.rejects(
    () => adapter.commitChangeQuote(quote.id),
    (err: unknown) => {
      assert.ok(err instanceof SCQError);
      assert.equal(err.code, "QUOTE_STALE");
      return true;
    }
  );

  const after = await adapter.getSubscription(sub.id);
  assert.equal(after.items[0].quantity, 150, "only the out-of-band mutation happened; commit performed no mutation");
  console.log("[Test 5 / Stripe] commit correctly rejected with QUOTE_STALE; subscription quantity remains", after.items[0].quantity);
});

test("Test 5 (Paddle): stale quote — out-of-band mutation causes QUOTE_STALE, no double mutation", async () => {
  const { sim, sub } = freshPaddleFixture();
  const adapter = new PaddleAdapter(sim, new QuoteStore());

  const before = await adapter.getSubscription(sub.id);
  // Paddle does not advertise EXACT for CHANGE_QUANTITY — REVALIDATE
  // (the v0.3 default) is used here, requiring an explicit envelope.
  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [{ action: "CHANGE_QUANTITY", itemId: before.items[0].id, quantity: 120 }],
    effectiveIntent: { type: "IMMEDIATE" },
    acceptanceEnvelope: { maxImmediateNetIncrease: 1_000_000, maxImmediateCreditDecrease: 1_000_000, maxRecurringIncrease: 1_000_000 },
  });

  sim._debugMutateDirectly(sub.id, (s) => {
    s.items[0].quantity = 150;
  });

  await assert.rejects(
    () => adapter.commitChangeQuote(quote.id),
    (err: unknown) => {
      assert.ok(err instanceof SCQError);
      assert.equal(err.code, "QUOTE_STALE");
      return true;
    }
  );

  const after = await adapter.getSubscription(sub.id);
  assert.equal(after.items[0].quantity, 150);
  console.log("[Test 5 / Paddle] commit correctly rejected with QUOTE_STALE; subscription quantity remains", after.items[0].quantity);
});

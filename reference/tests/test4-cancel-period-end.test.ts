import { test } from "node:test";
import assert from "node:assert/strict";
import { QuoteStore } from "../src/store/quote-store.js";
import { StripeAdapter } from "../src/adapters/stripe-adapter.js";
import { PaddleAdapter } from "../src/adapters/paddle-adapter.js";
import { freshStripeFixture, freshPaddleFixture } from "./fixtures.js";

test("Test 4 (Stripe): CANCEL at PERIOD_END — remains active until period end, autoRenew false, EXACT (trivially, no proration component)", async () => {
  const { sim, sub } = freshStripeFixture();
  const adapter = new StripeAdapter(sim, new QuoteStore());

  const quote = await adapter.createChangeQuote(sub.id, { changes: [{ action: "CANCEL" }], effectiveIntent: { type: "TERM_END" }, guaranteeMode: "EXACT" });
  assert.equal(quote.commercialEffect.term?.autoRenew, false);

  const receipt = await adapter.commitChangeQuote(quote.id);
  assert.equal(receipt.resultingSnapshot.status, "active", "subscription remains active until period end");
  assert.equal(receipt.resultingSnapshot.term?.autoRenew, false);
  assert.equal(receipt.consistencyGuarantee, "BEST_EFFORT");
  assert.equal(receipt.multiChangeConsistency, "ATOMIC", "single-change is trivially ATOMIC");
  assert.deepEqual(receipt.committedEffect, receipt.quotedEffect, "CANCEL has no proration component; quoted and committed always coincide");

  console.log("[Test 4 / Stripe] resultingSnapshot:", JSON.stringify(receipt.resultingSnapshot));
});

test("Test 4 (Paddle): CANCEL at PERIOD_END — remains active, scheduled cancellation, autoRenew false, EXACT (trivially, no proration component)", async () => {
  const { sim, sub } = freshPaddleFixture();
  const adapter = new PaddleAdapter(sim, new QuoteStore());

  const quote = await adapter.createChangeQuote(sub.id, { changes: [{ action: "CANCEL" }], effectiveIntent: { type: "TERM_END" }, guaranteeMode: "EXACT" });
  assert.equal(quote.commercialEffect.term?.autoRenew, false);

  const receipt = await adapter.commitChangeQuote(quote.id);
  assert.equal(receipt.resultingSnapshot.status, "active", "subscription remains active until period end");
  assert.equal(receipt.resultingSnapshot.term?.autoRenew, false);
  assert.equal(receipt.consistencyGuarantee, "BEST_EFFORT");
  assert.equal(receipt.multiChangeConsistency, "ATOMIC", "single-change is trivially ATOMIC");
  assert.deepEqual(receipt.committedEffect, receipt.quotedEffect, "CANCEL has no proration component; quoted and committed always coincide");

  console.log("[Test 4 / Paddle] resultingSnapshot:", JSON.stringify(receipt.resultingSnapshot));
});

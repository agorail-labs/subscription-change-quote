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
  // PR-3 DISCLOSED EXPECTATION CHANGE (v0.6.2 Stripe migration; the
  // Paddle variant below is NOT migrated and keeps the original
  // whole-effect assertion): this previously asserted whole-effect
  // deepEqual(committedEffect, quotedEffect). The FIGURES still
  // always coincide for CANCEL (no proration component — the point
  // of this test), but under CORE-2 the committed effect
  // additionally records its defined equality in provenance
  // (committedSource: "defined_equal_exact"), which a quote-side
  // effect never carries. Assert the coinciding
  // figures/determinacy and the committed provenance separately.
  assert.deepEqual(receipt.committedEffect.immediate, receipt.quotedEffect.immediate);
  assert.deepEqual(receipt.committedEffect.recurring, receipt.quotedEffect.recurring, "CANCEL has no proration component; quoted and committed figures always coincide");
  assert.deepEqual(receipt.committedEffect.determinacy, receipt.quotedEffect.determinacy);
  assert.equal(receipt.committedEffect.provenance?.committedSource, "defined_equal_exact");

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

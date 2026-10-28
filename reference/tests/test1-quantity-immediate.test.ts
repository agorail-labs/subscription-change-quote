import { test } from "node:test";
import assert from "node:assert/strict";
import { QuoteStore } from "../src/store/quote-store.js";
import { StripeAdapter } from "../src/adapters/stripe-adapter.js";
import { PaddleAdapter } from "../src/adapters/paddle-adapter.js";
import { freshStripeFixture, freshPaddleFixture } from "./fixtures.js";

test("Test 1 (Stripe, REVALIDATE): 100->120 seats immediate — quote doesn't mutate, commit does, quotedEffect === committedEffect with zero elapsed time", async () => {
  const { sim, sub } = freshStripeFixture();
  const adapter = new StripeAdapter(sim, new QuoteStore());

  const before = await adapter.getSubscription(sub.id);
  assert.equal(before.items[0].quantity, 100);

  // v0.4 note: this was EXACT in v0.1-v0.3. Under v0.4's per-dimension
  // capability split, Stripe's CHANGE_QUANTITY reports termEffect: UNKNOWN
  // (a plain Stripe subscription has no contract-term object — this was
  // always true, v0.3's single boolean just wasn't honest about it — see
  // test8-capabilities.test.ts Test 8a), so an overall EXACT request for
  // this action is now correctly refused. REVALIDATE with an envelope is
  // used instead; the financial-exactness point this test originally made
  // is now covered by test6-preview-drift.test.ts's dedicated EXACT/
  // financial-dimension tests instead of by request-level EXACT here.
  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [{ action: "CHANGE_QUANTITY", itemId: "si_1", quantity: 120 }],
    effectiveIntent: { type: "IMMEDIATE" },
    acceptanceEnvelope: { maxImmediateNetIncrease: 0, maxImmediateCreditDecrease: 0, maxRecurringIncrease: 0 },
  });
  assert.equal(quote.guaranteeMode, "REVALIDATE", "quote must echo back the effective guarantee mode it was created under");
  assert.equal(quote.multiChangeConsistency, "ATOMIC", "single-change proposal is trivially ATOMIC");

  // Quote must not mutate.
  const afterQuote = await adapter.getSubscription(sub.id);
  assert.equal(afterQuote.items[0].quantity, 100, "quote must not mutate subscription");
  assert.equal(afterQuote.version, before.version, "fingerprint unchanged after quote");

  assert.ok(quote.commercialEffect.immediate);
  assert.ok((quote.commercialEffect.immediate!.charge ?? 0) > 0, "upgrading 100->120 seats mid-period should charge a proration");
  assert.equal(quote.commercialEffect.recurring?.resultingAmount, 1000 * 120);

  console.log("[Test 1 / Stripe] immediate proration charge:", quote.commercialEffect.immediate);
  console.log("[Test 1 / Stripe] resulting recurring amount:", quote.commercialEffect.recurring?.resultingAmount);

  const receipt = await adapter.commitChangeQuote(quote.id);
  assert.equal(receipt.status, "COMMITTED");
  assert.equal(receipt.guaranteeMode, "REVALIDATE");
  assert.equal(receipt.consistencyGuarantee, "BEST_EFFORT", "Stripe must never claim ATOMIC");
  assert.equal(receipt.resultingSnapshot.items[0].quantity, 120, "commit must mutate subscription");
  // PR-3 DISCLOSED EXPECTATION CHANGE (v0.6.2 Stripe migration):
  // this previously asserted whole-effect deepEqual(committedEffect,
  // quotedEffect). Under CORE-2 a committed effect must record what
  // its figures ARE (provenance.committedSource): here they are
  // post-commit actuals read back after the mutation, NOT the
  // quote's estimates — so whole-object equality with the quote is
  // no longer the contract, and asserting it would erase exactly
  // the lineage distinction the migration exists to create. What
  // still coincides exactly — the point this test makes — is the
  // FIGURES: assert those, plus the committed provenance.
  assert.deepEqual(receipt.committedEffect.immediate, receipt.quotedEffect.immediate, "with zero elapsed time, the committed incurred figure matches the quote");
  assert.deepEqual(receipt.committedEffect.recurring, receipt.quotedEffect.recurring);
  assert.equal(receipt.committedEffect.provenance?.committedSource, "provider_actual");
});

test("Test 1 (Paddle, REVALIDATE): 100->120 seats immediate — quote doesn't mutate, commit does, committedEffect is the re-derived figure", async () => {
  const { sim, sub } = freshPaddleFixture();
  const adapter = new PaddleAdapter(sim, new QuoteStore());

  const before = await adapter.getSubscription(sub.id);
  assert.equal(before.items[0].quantity, 100);

  // Paddle does not advertise EXACT for CHANGE_QUANTITY (see paddle-adapter.ts
  // capabilitiesFor) — REVALIDATE is the only mode available, and is now the
  // v0.3 default, so guaranteeMode is omitted here deliberately to exercise
  // the default path (with an explicit acceptanceEnvelope, still required).
  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [{ action: "CHANGE_QUANTITY", itemId: before.items[0].id, quantity: 120 }],
    effectiveIntent: { type: "IMMEDIATE" },
    acceptanceEnvelope: { maxImmediateNetIncrease: 0, maxImmediateCreditDecrease: 0, maxRecurringIncrease: 0 },
  });
  assert.equal(quote.guaranteeMode, "REVALIDATE", "guaranteeMode must default to REVALIDATE when omitted");
  assert.equal(quote.multiChangeConsistency, "ATOMIC", "single-change proposal is trivially ATOMIC");

  const afterQuote = await adapter.getSubscription(sub.id);
  assert.equal(afterQuote.items[0].quantity, 100, "quote must not mutate subscription");
  assert.equal(afterQuote.version, before.version, "fingerprint unchanged after quote");

  assert.ok(quote.commercialEffect.immediate);
  assert.ok((quote.commercialEffect.immediate!.charge ?? 0) > 0);
  assert.equal(quote.commercialEffect.recurring?.resultingAmount, 1000 * 120);

  console.log("[Test 1 / Paddle] immediate proration charge:", quote.commercialEffect.immediate);
  console.log("[Test 1 / Paddle] resulting recurring amount:", quote.commercialEffect.recurring?.resultingAmount);

  const receipt = await adapter.commitChangeQuote(quote.id);
  assert.equal(receipt.status, "COMMITTED");
  assert.equal(receipt.guaranteeMode, "REVALIDATE");
  assert.equal(receipt.consistencyGuarantee, "BEST_EFFORT", "Paddle must never claim ATOMIC");
  assert.equal(receipt.resultingSnapshot.items[0].quantity, 120);
  // No time elapsed between quote and commit in this test, so the re-preview
  // should agree with the original quote — quotedEffect and committedEffect
  // may differ under REVALIDATE in general (see Test 6), but are not
  // REQUIRED to differ; here they coincide because nothing changed.
  assert.deepEqual(receipt.committedEffect, receipt.quotedEffect, "with zero elapsed time, REVALIDATE's re-derived figure matches the quote");
});

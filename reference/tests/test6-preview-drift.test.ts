import { test } from "node:test";
import assert from "node:assert/strict";
import { QuoteStore } from "../src/store/quote-store.js";
import { StripeAdapter } from "../src/adapters/stripe-adapter.js";
import { PaddleAdapter } from "../src/adapters/paddle-adapter.js";
import { SCQError } from "../src/core/types.js";
import { freshStripeFixture, freshPaddleFixture } from "./fixtures.js";

// v0.1 found: neither provider's commit call can be forced to reproduce a
// frozen preview number once wall-clock time moves, because the SCQ
// fingerprint (hash of items/status/period boundaries) does not and cannot
// hash "now" — it's not a property of the subscription object.
//
// v0.2 added Stripe's real `proration_date` parameter (see stripe-sim.ts)
// to EXACT mode, which pins the time-fraction basis, and found EXACT could
// still be REQUESTED against Paddle even though nothing backs it there —
// v0.2's adapter silently let the request through and produced a receipt
// with numbers that had already drifted.
//
// v0.3 closes that footgun at the schema/request level: EXACT is now
// capability-scoped (see capabilitiesFor() in each adapter) and REFUSED at
// createChangeQuote time — not silently downgraded — when requested for an
// action the provider cannot back it for. This file re-tests both the
// Stripe fix (still working) and the new Paddle refusal behavior.
//
// v0.4 note on Test 6's Stripe case specifically: v0.1-v0.3 requested an
// overall `guaranteeMode: "EXACT"` for CHANGE_QUANTITY and used the
// resulting receipt to prove proration_date replay pins the financial
// number. Under v0.4's per-dimension split, Stripe's CHANGE_QUANTITY now
// correctly reports termEffect: UNKNOWN (see test8-capabilities.test.ts),
// so an overall EXACT request for CHANGE_QUANTITY is refused — this is the
// SAME correction described throughout this cycle's other test files, and
// it has a direct consequence here: the adapter's EXACT-mode commit code
// path (which replays proration_date) is no longer reachable through the
// public createChangeQuote/commitChangeQuote API for CHANGE_QUANTITY,
// because no request that would route through it can be constructed
// without also being refused for termEffect. The proration_date pinning
// MECHANISM in stripe-sim.ts still works exactly as before (v0.4 did not
// touch it) — Test 6 (Stripe) below demonstrates it directly against the
// sim, the same way Test 6e always has, rather than through the adapter's
// EXACT commit path, which v0.4 correctly made unreachable for this
// action. This is flagged explicitly in research-findings.md as a
// "concept that failed to normalize cleanly": v0.4's schema is more
// honest, but it means SCQ can no longer let a caller exercise Stripe's
// genuinely-working financial-EXACT mechanism through an ergonomic
// single-mode request when termEffect is UNKNOWN for the same action —
// only a future partial-dimension EXACT request (not implemented this
// cycle) would restore that ergonomics without relaxing the correctness fix.

test("Test 6 (Stripe): proration_date pins the time basis at the SIM level — mechanism still works, but is no longer reachable via an overall EXACT request for CHANGE_QUANTITY", async () => {
  const { sim, sub } = freshStripeFixture();

  // Demonstrate the mechanism directly (bypassing the adapter's guarantee-
  // mode gate, since CHANGE_QUANTITY can no longer request overall EXACT —
  // see the note above). This confirms stripe-sim.ts's proration_date
  // parameter itself is unaffected by v0.4; only the adapter-level request
  // gating changed.
  const quotedAtDay0 = sim.previewUpcomingInvoice(
    sub.id,
    [{ id: "si_1", price: "price_seat_basic", quantity: 120 }],
    "create_prorations",
    sim.currentTime() // capture proration_date at "quote time"
  );
  const pinnedProrationDate = sim.currentTime();

  sim.advanceTimeSeconds(10 * 24 * 3600);

  const wouldHaveDriftedTo = sim.previewUpcomingInvoice(
    sub.id,
    [{ id: "si_1", price: "price_seat_basic", quantity: 120 }],
    "create_prorations"
    // no prorationDate -> uses current (10-days-later) wall clock
  );

  const { invoice: pinnedResult } = sim.update(
    sub.id,
    [{ id: "si_1", price: "price_seat_basic", quantity: 120 }],
    "create_prorations",
    pinnedProrationDate // replay the captured proration_date, as EXACT mode would have
  );

  console.log("[Test 6 / Stripe] quoted charge at day 0:", quotedAtDay0.amount_due);
  console.log("[Test 6 / Stripe] what an UN-pinned commit at day 10 would have charged:", wouldHaveDriftedTo.amount_due);
  console.log("[Test 6 / Stripe] actual charge when proration_date IS replayed at day 10:", pinnedResult.amount_due);
  console.log(
    "[Test 6 / Stripe] The proration_date pinning mechanism itself is unaffected by v0.4 — it still reproduces " +
      "the day-0 number exactly when replayed. What changed is that CHANGE_QUANTITY's adapter-level EXACT " +
      "request is now refused (termEffect: UNKNOWN), so a caller can no longer reach this code path through an " +
      "overall EXACT proposal for this action — only through REVALIDATE, which does not use the pin (see Test 6d)."
  );

  assert.notEqual(
    wouldHaveDriftedTo.amount_due,
    quotedAtDay0.amount_due,
    "sanity check: without the pin, the same call 10 days later would genuinely have produced a different number"
  );
  assert.equal(pinnedResult.amount_due, quotedAtDay0.amount_due, "proration_date replay still reproduces the quoted charge despite elapsed time, at the sim level");
});

test("Test 6b (Paddle, EXACT requested): refused at quote time with UNSUPPORTED_CHANGE — no quote is ever created", async () => {
  const { sim, sub } = freshPaddleFixture();
  const adapter = new PaddleAdapter(sim, new QuoteStore());

  const before = await adapter.getSubscription(sub.id);

  // v0.2 let this request through and produced a COMMITTED receipt whose
  // numbers had already drifted by commit time — a technically-truthful
  // but misleading outcome. v0.3's capability-scoped EXACT refuses the
  // request outright, before any preview or mutation call is made.
  await assert.rejects(
    () =>
      adapter.createChangeQuote(sub.id, {
        changes: [{ action: "CHANGE_QUANTITY", itemId: before.items[0].id, quantity: 120 }],
        effectiveIntent: { type: "IMMEDIATE" },
        guaranteeMode: "EXACT",
      }),
    (err: unknown) => {
      assert.ok(err instanceof SCQError);
      assert.equal(err.code, "UNSUPPORTED_CHANGE");
      return true;
    }
  );

  // Confirm no quote-adjacent side effect happened either: subscription
  // state is untouched, since the refusal happens before any preview call.
  const after = await adapter.getSubscription(sub.id);
  assert.equal(after.items[0].quantity, 100);
  assert.equal(after.version, before.version);

  console.log(
    "[Test 6b / Paddle] EXACT requested for CHANGE_QUANTITY was refused with UNSUPPORTED_CHANGE before any " +
      "preview call — v0.3's fix for the v0.2 footgun where this request silently degraded to best-effort " +
      "and still returned a COMMITTED receipt."
  );
});

test("Test 6c (Paddle, REVALIDATE): the only mechanism Paddle actually has — refuse via QUOTE_DRIFTED instead of silently drifting", async () => {
  const { sim, sub } = freshPaddleFixture();
  const adapter = new PaddleAdapter(sim, new QuoteStore());

  const before = await adapter.getSubscription(sub.id);
  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [{ action: "CHANGE_QUANTITY", itemId: before.items[0].id, quantity: 120 }],
    effectiveIntent: { type: "IMMEDIATE" },
    guaranteeMode: "REVALIDATE",
    acceptanceEnvelope: { maxImmediateNetIncrease: 0, maxImmediateCreditDecrease: 0, maxRecurringIncrease: 0 },
  });
  const quotedCharge = quote.commercialEffect.immediate?.charge;

  // 10 days is enough for the prorated_immediately charge to fall
  // (less time remaining -> smaller proration), which is a credit-side
  // move — but the envelope above allows zero tolerance in ANY direction,
  // so it should still drift-reject.
  sim.advanceTimeSeconds(10 * 24 * 3600);

  await assert.rejects(
    () => adapter.commitChangeQuote(quote.id),
    (err: unknown) => {
      assert.ok(err instanceof SCQError);
      assert.equal(err.code, "QUOTE_DRIFTED");
      return true;
    }
  );

  // Refusal must mean NO mutation — this is the "refuse safely" requirement.
  const afterAttempt = await adapter.getSubscription(sub.id);
  assert.equal(afterAttempt.items[0].quantity, 100, "REVALIDATE must refuse before mutating when recomputation exceeds the envelope");

  console.log("[Test 6c / Paddle / REVALIDATE] quoted charge:", quotedCharge, "— commit refused with QUOTE_DRIFTED, subscription left untouched");
  console.log(
    "[Test 6c / Paddle / REVALIDATE] This is the finding: since Paddle does not advertise EXACT for " +
      "CHANGE_QUANTITY, REVALIDATE (re-preview against live state, refuse if outside envelope) is the ONLY " +
      "mechanism SCQ can offer on Paddle for proration-bearing changes that isn't silently trusting a stale " +
      "number. It trades 'exact reproduction' for 'safe refusal', a materially weaker but honestly-advertised guarantee."
  );
});

test("Test 6d (Stripe, REVALIDATE): re-preview against live state commits at the NEW number, not the stale one", async () => {
  const { sim, sub } = freshStripeFixture();
  const adapter = new StripeAdapter(sim, new QuoteStore());

  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [{ action: "CHANGE_QUANTITY", itemId: "si_1", quantity: 120 }],
    effectiveIntent: { type: "IMMEDIATE" },
    guaranteeMode: "REVALIDATE",
    acceptanceEnvelope: { maxImmediateCreditDecrease: 100_000 }, // generous: this scenario is a decrease (less time remaining), allow it
  });
  const quotedCharge = quote.commercialEffect.immediate?.charge;

  sim.advanceTimeSeconds(10 * 24 * 3600);

  const receipt = await adapter.commitChangeQuote(quote.id);
  assert.equal(receipt.status, "COMMITTED");
  assert.equal(receipt.guaranteeMode, "REVALIDATE");
  const committedCharge = receipt.committedEffect.immediate?.charge;

  console.log("[Test 6d / Stripe / REVALIDATE] quoted charge (day 0):", quotedCharge, "-> committed charge (day 10):", committedCharge);
  console.log(
    "[Test 6d / Stripe / REVALIDATE] REVALIDATE deliberately does NOT use proration_date — its entire purpose " +
      "is to check against CURRENT state/time and commit the truthful number (inside the envelope), not the " +
      "stale quoted one. receipt.quotedEffect preserves the original quote for audit purposes; " +
      "receipt.committedEffect is what was actually re-derived, gated the commit, and matches what was mutated."
  );
  assert.notEqual(committedCharge, quotedCharge, "committed number reflects the 10 days that actually passed, unlike EXACT mode's pinned replay");
  assert.notDeepEqual(receipt.committedEffect, receipt.quotedEffect, "REVALIDATE's quoted and committed effects may legitimately differ — and did here");
  assert.equal(receipt.quotedEffect.immediate?.charge, quotedCharge, "quotedEffect must remain the untouched historical record of what was originally quoted");
});

test("Test 6e: demonstrating the raw drift magnitude via direct sim re-preview (unchanged from v0.1/v0.2)", async () => {
  const { sim, sub } = freshStripeFixture();

  const previewAt0Days = sim.previewUpcomingInvoice(
    sub.id,
    [{ id: "si_1", price: "price_seat_basic", quantity: 120 }],
    "create_prorations"
  );

  sim.advanceTimeSeconds(10 * 24 * 3600);

  const previewAt10Days = sim.previewUpcomingInvoice(
    sub.id,
    [{ id: "si_1", price: "price_seat_basic", quantity: 120 }],
    "create_prorations"
  );

  console.log("[Test 6e] proration charge if computed at day 0:", previewAt0Days.amount_due);
  console.log("[Test 6e] proration charge if computed at day 10, un-pinned (same fingerprint):", previewAt10Days.amount_due);

  assert.notEqual(
    previewAt0Days.amount_due,
    previewAt10Days.amount_due,
    "proration amount genuinely differs solely due to elapsed time when no proration_date is supplied"
  );
});

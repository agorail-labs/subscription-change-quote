import { test } from "node:test";
import assert from "node:assert/strict";
import { QuoteStore } from "../src/store/quote-store.js";
import { StripeAdapter } from "../src/adapters/stripe-adapter.js";
import { PaddleAdapter } from "../src/adapters/paddle-adapter.js";
import { SCQError } from "../src/core/types.js";
import { freshStripeFixture, freshPaddleFixture } from "./fixtures.js";

// v0.3 required tests (retained, updated for v0.4's per-dimension shape):
//   - EXACT cannot be requested where unsupported.
//   - Paddle proration advertises REVALIDATE only (now per financial dimension).
//   - Stripe proration may advertise EXACT where pinned replay works (now per financial dimension).
//   - receipt always clearly identifies quoted vs committed economics.
//   - capability discovery cannot overstate guarantees.
//   - BEST_EFFORT consistency is surfaced to the caller.
//
// v0.4 note: v0.3's single EXACT boolean for Stripe's CHANGE_QUANTITY /
// CHANGE_PLAN / CHANGE_CADENCE has been CORRECTED here, not just
// re-expressed. v0.3 reported `EXACT: true` for those actions because
// proration_date replay pins the financial numbers — but it never had a
// separate field to be honest about `termEffect`, which was ALWAYS
// UNKNOWN on Stripe (a plain Stripe subscription has no contract-term
// object; see stripe-adapter.ts snapshotFrom()). v0.4's per-dimension
// split surfaces that correction: an overall `guaranteeMode: "EXACT"`
// request for a proration-bearing action is now refused on BOTH Stripe and
// Paddle, because termEffect is UNKNOWN on both for those actions. Only
// CANCEL — where the term question ("does this create a commitment?") is
// exactly answerable as "no" — supports an overall EXACT request on either
// provider. This is itself one of the cycle's findings, not a test-authoring
// artifact: see research-findings.md v0.4, "Stripe/Paddle EXACT re-scoped".

test("Test 8a: Stripe reports EXACT financial coverage but UNKNOWN termEffect for proration-bearing actions; full EXACT (incl. termEffect) only for CANCEL", () => {
  const { sim } = freshStripeFixture();
  const adapter = new StripeAdapter(sim, new QuoteStore());
  const caps = adapter.getCapabilities();

  for (const action of ["CHANGE_QUANTITY", "CHANGE_PLAN", "CHANGE_CADENCE"] as const) {
    const coverage = caps.quoteCapabilities[action];
    assert.ok(coverage, `${action} must be present in quoteCapabilities`);
    assert.equal(coverage!.guaranteeCoverage.immediateFinancialEffect, "EXACT", `${action}: proration_date replay pins the immediate financial effect`);
    assert.equal(coverage!.guaranteeCoverage.recurringFinancialEffect, "EXACT", `${action}: proration_date replay pins the recurring financial effect`);
    assert.equal(coverage!.guaranteeCoverage.termEffect, "UNKNOWN", `${action}: Stripe has no contract-term object — this was always true, v0.3's single boolean just didn't surface it`);
    assert.equal(coverage!.guaranteeCoverage.effectiveAt, "EXACT", `${action}: Stripe mutations apply "now" or a fixed known timestamp, no future-dated-order drift risk`);
  }

  const cancelCoverage = caps.quoteCapabilities.CANCEL;
  assert.deepEqual(cancelCoverage!.guaranteeCoverage, {
    immediateFinancialEffect: "EXACT",
    recurringFinancialEffect: "EXACT",
    termEffect: "EXACT",
    effectiveAt: "EXACT",
  });

  console.log("[Test 8a] Stripe quoteCapabilities:", JSON.stringify(caps.quoteCapabilities));
});

test("Test 8b: Paddle reports REVALIDATE-only financial coverage AND UNKNOWN termEffect for proration-bearing actions; full EXACT only for CANCEL", () => {
  const { sim } = freshPaddleFixture();
  const adapter = new PaddleAdapter(sim, new QuoteStore());
  const caps = adapter.getCapabilities();

  for (const action of ["CHANGE_QUANTITY", "CHANGE_PLAN", "CHANGE_CADENCE"] as const) {
    const coverage = caps.quoteCapabilities[action];
    assert.ok(coverage, `${action} must be present in quoteCapabilities, not omitted`);
    assert.equal(coverage!.guaranteeCoverage.immediateFinancialEffect, "REVALIDATE", `${action}: no proration_date equivalent on Paddle`);
    assert.equal(coverage!.guaranteeCoverage.recurringFinancialEffect, "REVALIDATE", `${action}`);
    assert.equal(coverage!.guaranteeCoverage.termEffect, "UNKNOWN", `${action}: Paddle Billing also has no contract-term object`);
    assert.equal(coverage!.guaranteeCoverage.effectiveAt, "EXACT", `${action}: same reasoning as Stripe — no future-dated-order concept in this sim`);
  }

  const cancelCoverage = caps.quoteCapabilities.CANCEL;
  assert.deepEqual(cancelCoverage!.guaranteeCoverage, {
    immediateFinancialEffect: "EXACT",
    recurringFinancialEffect: "EXACT",
    termEffect: "EXACT",
    effectiveAt: "EXACT",
  });

  console.log("[Test 8b] Paddle quoteCapabilities:", JSON.stringify(caps.quoteCapabilities));
});

test("Test 8c: EXACT cannot be requested where unsupported (Paddle, CHANGE_QUANTITY — fails on immediateFinancialEffect AND termEffect) — refused before any provider call", async () => {
  const { sim, sub } = freshPaddleFixture();
  const adapter = new PaddleAdapter(sim, new QuoteStore());
  const before = await adapter.getSubscription(sub.id);

  await assert.rejects(
    () =>
      adapter.createChangeQuote(sub.id, {
        changes: [{ action: "CHANGE_QUANTITY", itemId: before.items[0].id, quantity: 150 }],
        effectiveIntent: { type: "IMMEDIATE" },
        guaranteeMode: "EXACT",
      }),
    (err: unknown) => {
      assert.ok(err instanceof SCQError);
      assert.equal(err.code, "UNSUPPORTED_CHANGE");
      return true;
    }
  );
});

test("Test 8c2: EXACT cannot be requested where unsupported (Stripe, CHANGE_CADENCE — fails on termEffect even though both financial dimensions are EXACT)", async () => {
  const { sim, sub } = freshStripeFixture();
  const adapter = new StripeAdapter(sim, new QuoteStore());

  // This is the key v0.4 case: Stripe's financial dimensions for
  // CHANGE_CADENCE ARE "EXACT" (proration_date replay works), so a
  // v0.3-style single-boolean check would have let this through. The
  // request must still fail here because termEffect is UNKNOWN — proving
  // the per-dimension enforcement is actually checking every dimension,
  // not just the financial ones.
  await assert.rejects(
    () =>
      adapter.createChangeQuote(sub.id, {
        changes: [{ action: "CHANGE_CADENCE", cadence: "ANNUAL" }],
        effectiveIntent: { type: "IMMEDIATE" },
        guaranteeMode: "EXACT",
      }),
    (err: unknown) => {
      assert.ok(err instanceof SCQError);
      assert.equal(err.code, "UNSUPPORTED_CHANGE");
      assert.equal((err as SCQError).details && (err as any).details.failingDimension, "termEffect", "must name termEffect as the failing dimension, not a financial one");
      return true;
    }
  );
});

test("Test 8d: guaranteeMode defaults to REVALIDATE when omitted (both providers)", async () => {
  const stripe = freshStripeFixture();
  const stripeAdapter = new StripeAdapter(stripe.sim, new QuoteStore());
  const stripeQuote = await stripeAdapter.createChangeQuote(stripe.sub.id, {
    changes: [{ action: "CHANGE_QUANTITY", itemId: "si_1", quantity: 110 }],
    effectiveIntent: { type: "IMMEDIATE" },
    acceptanceEnvelope: { maxImmediateNetIncrease: 1_000_000, maxImmediateCreditDecrease: 1_000_000, maxRecurringIncrease: 1_000_000 },
    // guaranteeMode intentionally omitted
  });
  assert.equal(stripeQuote.guaranteeMode, "REVALIDATE", "Stripe: omitted guaranteeMode must default to REVALIDATE, not silently become EXACT");

  const paddle = freshPaddleFixture();
  const paddleAdapter = new PaddleAdapter(paddle.sim, new QuoteStore());
  const before = await paddleAdapter.getSubscription(paddle.sub.id);
  const paddleQuote = await paddleAdapter.createChangeQuote(paddle.sub.id, {
    changes: [{ action: "CHANGE_QUANTITY", itemId: before.items[0].id, quantity: 110 }],
    effectiveIntent: { type: "IMMEDIATE" },
    acceptanceEnvelope: { maxImmediateNetIncrease: 1_000_000, maxImmediateCreditDecrease: 1_000_000, maxRecurringIncrease: 1_000_000 },
  });
  assert.equal(paddleQuote.guaranteeMode, "REVALIDATE", "Paddle: omitted guaranteeMode must default to REVALIDATE");
});

test("Test 8e: REVALIDATE (explicit or defaulted) requires an acceptanceEnvelope for proration-bearing actions", async () => {
  const { sim, sub } = freshStripeFixture();
  const adapter = new StripeAdapter(sim, new QuoteStore());

  await assert.rejects(
    () =>
      adapter.createChangeQuote(sub.id, {
        changes: [{ action: "CHANGE_QUANTITY", itemId: "si_1", quantity: 110 }],
        effectiveIntent: { type: "IMMEDIATE" },
        // guaranteeMode omitted (defaults to REVALIDATE) AND acceptanceEnvelope omitted — must be refused, not silently
        // given a permissive default the caller never approved.
      }),
    (err: unknown) => {
      assert.ok(err instanceof SCQError);
      assert.equal(err.code, "INVALID_PROPOSAL");
      return true;
    }
  );
});

test("Test 8f: receipt always clearly identifies quoted vs committed economics, and guaranteeMode/consistencyGuarantee are always present", async () => {
  const { sim, sub } = freshStripeFixture();
  const adapter = new StripeAdapter(sim, new QuoteStore());

  // CANCEL is used here (not CHANGE_QUANTITY) because it's the only action
  // where Stripe supports a full overall EXACT request under v0.4's
  // per-dimension enforcement (termEffect is EXACT there, unlike the other
  // three actions) — see Test 8c2.
  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [{ action: "CANCEL" }],
    effectiveIntent: { type: "TERM_END" },
    guaranteeMode: "EXACT",
  });
  assert.equal(quote.multiChangeConsistency, "ATOMIC");
  const receipt = await adapter.commitChangeQuote(quote.id);

  // Neither field may be missing/undefined on any receipt — a caller
  // should never have to guess which mode a receipt was produced under, or
  // fall back to inspecting the quote to find out.
  assert.ok("quotedEffect" in receipt && receipt.quotedEffect !== undefined, "receipt must always carry quotedEffect");
  assert.ok("committedEffect" in receipt && receipt.committedEffect !== undefined, "receipt must always carry committedEffect");
  assert.ok(receipt.guaranteeMode === "EXACT" || receipt.guaranteeMode === "REVALIDATE", "receipt must always state the guaranteeMode it was produced under");
  assert.ok(receipt.consistencyGuarantee === "ATOMIC" || receipt.consistencyGuarantee === "BEST_EFFORT", "receipt must always state its consistency guarantee");

  // The old v0.2 field names must be gone — this is a schema-level check
  // that the ambiguous "commercialEffect"/"revalidatedEffect" naming on the
  // receipt (as opposed to the quote, where commercialEffect is still
  // correct and unambiguous) cannot silently come back.
  assert.ok(!("commercialEffect" in receipt), "receipt must not carry the old ambiguous 'commercialEffect' field name");
  assert.ok(!("revalidatedEffect" in receipt), "receipt must not carry the old 'revalidatedEffect' field name");
});

test("Test 8g: BEST_EFFORT consistency is surfaced to the caller on both getCapabilities() and every receipt, for both providers", async () => {
  const stripe = freshStripeFixture();
  const stripeAdapter = new StripeAdapter(stripe.sim, new QuoteStore());
  assert.equal(stripeAdapter.getCapabilities().consistencyGuarantee, "BEST_EFFORT");

  const stripeQuote = await stripeAdapter.createChangeQuote(stripe.sub.id, {
    changes: [{ action: "CANCEL" }],
    effectiveIntent: { type: "TERM_END" },
    guaranteeMode: "EXACT",
  });
  const stripeReceipt = await stripeAdapter.commitChangeQuote(stripeQuote.id);
  assert.equal(stripeReceipt.consistencyGuarantee, "BEST_EFFORT", "Stripe must never report ATOMIC on a receipt");

  const paddle = freshPaddleFixture();
  const paddleAdapter = new PaddleAdapter(paddle.sim, new QuoteStore());
  assert.equal(paddleAdapter.getCapabilities().consistencyGuarantee, "BEST_EFFORT");

  const paddleQuote = await paddleAdapter.createChangeQuote(paddle.sub.id, {
    changes: [{ action: "CANCEL" }],
    effectiveIntent: { type: "TERM_END" },
    guaranteeMode: "EXACT",
  });
  const paddleReceipt = await paddleAdapter.commitChangeQuote(paddleQuote.id);
  assert.equal(paddleReceipt.consistencyGuarantee, "BEST_EFFORT", "Paddle must never report ATOMIC on a receipt");
});

test("Test 8h: capability discovery cannot overstate guarantees — cross-check getCapabilities() against actual enforcement for every dimension-relevant action on both providers", async () => {
  // This is the regression guard for the core v0.3/v0.4 promise: whatever
  // getCapabilities() advertises must be exactly what createChangeQuote
  // actually allows through for an overall EXACT request, for every
  // action. If these ever disagree, capability discovery is lying.
  const providers = [
    { name: "stripe" as const },
    { name: "paddle" as const },
  ];

  for (const { name } of providers) {
    const fresh = name === "stripe" ? freshStripeFixture() : freshPaddleFixture();
    const adapter = name === "stripe" ? new StripeAdapter(fresh.sim as any, new QuoteStore()) : new PaddleAdapter(fresh.sim as any, new QuoteStore());
    const caps = adapter.getCapabilities();

    const actionsToCheck: Array<{ action: "CHANGE_QUANTITY" | "CHANGE_CADENCE" | "CANCEL"; buildProposal: (itemId: string) => any }> = [
      {
        action: "CHANGE_QUANTITY",
        buildProposal: (itemId) => ({ changes: [{ action: "CHANGE_QUANTITY", itemId, quantity: 105 }], effectiveIntent: { type: "IMMEDIATE" }, guaranteeMode: "EXACT" }),
      },
      {
        action: "CHANGE_CADENCE",
        buildProposal: () => ({ changes: [{ action: "CHANGE_CADENCE", cadence: "ANNUAL" }], effectiveIntent: { type: "IMMEDIATE" }, guaranteeMode: "EXACT" }),
      },
      {
        action: "CANCEL",
        buildProposal: () => ({ changes: [{ action: "CANCEL" }], effectiveIntent: { type: "TERM_END" }, guaranteeMode: "EXACT" }),
      },
    ];

    for (const { action, buildProposal } of actionsToCheck) {
      const coverage = caps.quoteCapabilities[action];
      assert.ok(coverage, `${name}/${action} must be present in quoteCapabilities`);
      // "Advertised as fully-EXACT-capable" means every guaranteeCoverage
      // dimension reports EXACT. (v0.6: coverage is now wrapped in
      // ActionCapabilities alongside supportedEffectiveIntents, so we check
      // the nested guaranteeCoverage object specifically, not the whole
      // ActionCapabilities value.)
      const advertisedFullyExact = Object.values(coverage!.guaranteeCoverage).every((v) => v === "EXACT");

      let actuallyAllowed = true;
      let refusalCode: string | undefined;
      try {
        // Fresh fixture per check so an earlier successful commit in this
        // loop doesn't change subscription state out from under a later check.
        const freshCheck = name === "stripe" ? freshStripeFixture() : freshPaddleFixture();
        const freshAdapter = name === "stripe" ? new StripeAdapter(freshCheck.sim as any, new QuoteStore()) : new PaddleAdapter(freshCheck.sim as any, new QuoteStore());
        const freshBefore = await freshAdapter.getSubscription(freshCheck.sub.id);
        const proposal = buildProposal(freshBefore.items[0].id);
        await freshAdapter.createChangeQuote(freshCheck.sub.id, proposal);
      } catch (e) {
        actuallyAllowed = false;
        refusalCode = e instanceof SCQError ? e.code : String(e);
      }

      assert.equal(
        actuallyAllowed,
        advertisedFullyExact,
        `${name}/${action}: getCapabilities() advertised fully-EXACT=${advertisedFullyExact} (${JSON.stringify(coverage)}) but actual ` +
          `enforcement ${actuallyAllowed ? "allowed" : `refused (${refusalCode})`} an overall EXACT request — capability discovery has drifted from enforcement`
      );
    }
  }

  console.log("[Test 8h] Cross-checked getCapabilities() against actual EXACT enforcement for CHANGE_QUANTITY, CHANGE_CADENCE, and CANCEL on both providers — no drift found");
});

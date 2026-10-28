import { test } from "node:test";
import assert from "node:assert/strict";
import { QuoteStore } from "../src/store/quote-store.js";
import { ChargebeeAdapter } from "../src/adapters/chargebee-adapter.js";
import { SCQError } from "../src/core/types.js";
import { freshChargebeeFixture, freshChargebeeCommittedTermFixture } from "./fixtures.js";

// v0.5 Chargebee validation, addressing the five primary research
// questions directly, each with a dedicated test or test group:
//   1. Can Chargebee map to Snapshot -> Quote -> Commit?           (11a-11c)
//   2. Can future-effective changes use requestedEffectiveAt?      (11d)
//   3. Can multi-change operations avoid provider-specific fields? (11e-11f)
//   4. Does quote-level guaranteeCoverage handle state-dependent
//      capabilities accurately?                                   (11g-11h)
//   5. Does Chargebee provide atomic state-precondition+mutation,
//      or does the same TOCTOU gap remain?                        (11i-11j)

test("Test 11a: Chargebee maps cleanly to getSubscription/createChangeQuote/commitChangeQuote — CHANGE_QUANTITY end-to-end", async () => {
  const { sim, sub } = freshChargebeeFixture();
  const adapter = new ChargebeeAdapter(sim, new QuoteStore());

  const before = await adapter.getSubscription(sub.id);
  assert.equal(before.items[0].quantity, 100);

  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [{ action: "CHANGE_QUANTITY", itemId: "item_1", quantity: 120 }],
    effectiveIntent: { type: "IMMEDIATE" },
    guaranteeMode: "EXACT",
  });
  assert.equal(quote.guaranteeMode, "EXACT", "Chargebee's deterministic (effective_from-pivoted, not wall-clock) proration allows EXACT here, same category as Zuora");

  const afterQuote = await adapter.getSubscription(sub.id);
  assert.equal(afterQuote.items[0].quantity, 100, "quote must not mutate subscription");

  // Elapse real time between quote and commit — the exact scenario that
  // defeats Stripe/Paddle's unpinned proration.
  sim.advanceTimeSeconds(10 * 24 * 3600);

  const receipt = await adapter.commitChangeQuote(quote.id);
  assert.equal(receipt.status, "COMMITTED");
  assert.equal(receipt.resultingSnapshot.items[0].quantity, 120);
  assert.deepEqual(receipt.committedEffect, receipt.quotedEffect, "EXACT mode: quotedEffect === committedEffect despite elapsed time — Chargebee's proration pivots on an explicit instant, not ambient wall-clock");

  console.log("[Test 11a] Chargebee Snapshot->Quote->Commit works end-to-end for CHANGE_QUANTITY, with genuine EXACT financial coverage (no pinning parameter needed, unlike Stripe).");
});

test("Test 11b: Chargebee CHANGE_PLAN and CHANGE_CADENCE map cleanly too — financial dimensions EXACT, termEffect UNKNOWN (bare item swap)", async () => {
  const { sim, sub } = freshChargebeeFixture();
  const adapter = new ChargebeeAdapter(sim, new QuoteStore());

  await assert.rejects(
    () => adapter.createChangeQuote(sub.id, { changes: [{ action: "CHANGE_CADENCE", cadence: "ANNUAL" }], effectiveIntent: { type: "IMMEDIATE" }, guaranteeMode: "EXACT" }),
    (err: unknown) => {
      assert.ok(err instanceof SCQError);
      assert.equal(err.code, "UNSUPPORTED_CHANGE");
      assert.equal((err as any).details.failingDimension, "termEffect");
      return true;
    }
  );

  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [{ action: "CHANGE_CADENCE", cadence: "ANNUAL" }],
    effectiveIntent: { type: "IMMEDIATE" },
    acceptanceEnvelope: { maxImmediateNetIncrease: 1_000_000, maxImmediateCreditDecrease: 1_000_000, maxRecurringIncrease: 1_000_000 },
  });
  assert.equal(quote.commercialEffect.recurring?.resultingAmount, 10000 * 100);
  assert.equal(quote.commercialEffect.recurring?.cadence, "ANNUAL");

  const receipt = await adapter.commitChangeQuote(quote.id);
  assert.equal(receipt.resultingSnapshot.billing.cadence, "ANNUAL");
});

test("Test 11c: Chargebee CANCEL maps cleanly — PERIOD_END (non_renewing) and IMMEDIATE both normalize correctly", async () => {
  const { sim, sub } = freshChargebeeFixture();
  const adapter = new ChargebeeAdapter(sim, new QuoteStore());

  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [{ action: "CANCEL" }],
    effectiveIntent: { type: "TERM_END" },
    guaranteeMode: "EXACT",
  });
  const receipt = await adapter.commitChangeQuote(quote.id);
  assert.equal(receipt.resultingSnapshot.status, "active", "Chargebee's non_renewing status maps to SCQ's 'active until period end', same as Stripe/Paddle/Zuora");
  assert.equal(receipt.resultingSnapshot.term?.autoRenew, false);

  console.log("[Test 11c] Chargebee CANCEL (PERIOD_END -> non_renewing) normalizes cleanly onto the shared SubscriptionSnapshot shape.");
});

test("Test 11d: effectiveIntent DATE IS honored on Chargebee — native Scheduled Changes (effective_from) mechanism, same category as Zuora", async () => {
  const { sim, sub } = freshChargebeeFixture();
  const adapter = new ChargebeeAdapter(sim, new QuoteStore());

  const farFuture = new Date(sim.currentTime().getTime() + 15 * 24 * 3600 * 1000).toISOString();

  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [{ action: "CHANGE_QUANTITY", itemId: "item_1", quantity: 130 }],
    effectiveIntent: { type: "DATE", at: farFuture },
    guaranteeMode: "EXACT",
  });
  assert.equal(quote.guaranteeCoverage.effectiveAt, "EXACT", "Chargebee's effective_from is a caller-supplied input, same as Zuora's effectiveDate");

  // Advance time PAST the requested date, then commit, then advance again
  // to let the sim's scheduled-change mechanism actually apply it —
  // mirroring Chargebee's real async Scheduled Changes execution.
  const receipt = await adapter.commitChangeQuote(quote.id);
  assert.equal(receipt.status, "COMMITTED");
  // Immediately after commit, the item has NOT yet changed (it's scheduled).
  assert.equal(receipt.resultingSnapshot.items[0].quantity, 100, "a future-scheduled change does not apply immediately — subscriptionItems stay as-is until effective_from arrives");

  sim.advanceTimeSeconds(20 * 24 * 3600); // now past farFuture
  const after = await adapter.getSubscription(sub.id);
  assert.equal(after.items[0].quantity, 130, "the scheduled change applied once its effective_from date was reached");

  console.log("[Test 11d] Chargebee's Scheduled Changes correctly deferred item application until the requested future date arrived — a real capability, not immediately visible in the commit receipt.");
});

test("Test 11e: multi-change proposal (CHANGE_QUANTITY + CHANGE_PLAN) is ATOMIC on Chargebee — update_for_items bundles a full item list in one call", async () => {
  const { sim, sub } = freshChargebeeFixture();
  const adapter = new ChargebeeAdapter(sim, new QuoteStore());

  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [
      { action: "CHANGE_QUANTITY", itemId: "item_1", quantity: 120 },
      { action: "CHANGE_PLAN", itemId: "item_1", offeringRef: "plan:pro:monthly" },
    ],
    effectiveIntent: { type: "IMMEDIATE" },
    acceptanceEnvelope: { maxImmediateNetIncrease: 1_000_000, maxImmediateCreditDecrease: 1_000_000, maxRecurringIncrease: 1_000_000 },
  });
  assert.equal(quote.multiChangeConsistency, "ATOMIC");

  const receipt = await adapter.commitChangeQuote(quote.id);
  assert.equal(receipt.multiChangeConsistency, "ATOMIC");
  assert.equal(receipt.resultingSnapshot.items[0].quantity, 120);
  assert.equal(receipt.resultingSnapshot.billing.recurringAmount, 1500 * 120);

  console.log("[Test 11e] Chargebee multi-change (quantity+plan) via update_for_items — no Chargebee-specific fields visible in the SCQ-level proposal/quote/receipt shapes used to express this.");
});

test("Test 11f: multi-change mixing CANCEL with CHANGE_QUANTITY is UNSUPPORTED on Chargebee — cancel_for_items is a separate endpoint, same limitation as Stripe/Paddle (contrast with Zuora)", async () => {
  const { sim, sub } = freshChargebeeFixture();
  const adapter = new ChargebeeAdapter(sim, new QuoteStore());

  await assert.rejects(
    () =>
      adapter.createChangeQuote(sub.id, {
        changes: [
          { action: "CHANGE_QUANTITY", itemId: "item_1", quantity: 120 },
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

  console.log("[Test 11f] Chargebee refuses CANCEL+CHANGE_QUANTITY bundling (separate endpoints) — matches Stripe/Paddle's limitation, NOT Zuora's (Zuora orders can bundle any combination). This is a real, provider-specific capability difference correctly surfaced via multiChangeConsistency, not hidden behind a provider-specific field.");
});

test("Test 11g (v0.6 CORRECTED): quote-level guaranteeCoverage for CANCEL differs by subscription state — evergreen resolves EXACT (real, live-confirmed); committed-term resolves UNKNOWN (UNVERIFIED, not simulated)", async () => {
  const evergreen = freshChargebeeFixture();
  const evergreenAdapter = new ChargebeeAdapter(evergreen.sim, new QuoteStore());
  const evergreenQuote = await evergreenAdapter.createChangeQuote(evergreen.sub.id, {
    changes: [{ action: "CANCEL" }],
    effectiveIntent: { type: "TERM_END" },
    guaranteeMode: "EXACT",
  });
  assert.deepEqual(evergreenQuote.guaranteeCoverage, {
    immediateFinancialEffect: "EXACT",
    recurringFinancialEffect: "EXACT",
    termEffect: "EXACT",
    effectiveAt: "EXACT",
  }, "evergreen CANCEL: confirmed live against the real Chargebee API (v0.5-LIVE Experiment 3) — estimate and commit agreed exactly, no fee");

  // v0.6 CORRECTION — this test previously asserted (per the v0.5
  // simulator) that a committed-term subscription's CANCEL ALSO resolves
  // EXACT, claiming a "Chargebee is stronger than Zuora here" finding. The
  // v0.5-LIVE research cycle attempted to verify this against a real
  // Chargebee test site and could NOT: Contract Terms was not enabled on
  // that site, and `contract_term` creation was rejected outright
  // (400 invalid_request). Per this cycle's explicit instruction ("Mark
  // Chargebee committed-term CANCEL: UNVERIFIED. Do not design around the
  // simulator result."), this test no longer asserts EXACT for the
  // committed-term case — it asserts the honest UNKNOWN, and that an
  // overall EXACT request is correctly REFUSED rather than silently
  // downgraded or (worse) granted on an unverified assumption.
  const committed = freshChargebeeCommittedTermFixture();
  const committedAdapter = new ChargebeeAdapter(committed.sim, new QuoteStore());

  await assert.rejects(
    () =>
      committedAdapter.createChangeQuote(committed.sub.id, {
        changes: [{ action: "CANCEL" }],
        effectiveIntent: { type: "TERM_END" },
        guaranteeMode: "EXACT",
      }),
    (err: unknown) => {
      assert.ok(err instanceof SCQError);
      assert.equal(err.code, "UNSUPPORTED_CHANGE");
      assert.equal((err as any).details.failingDimension, "termEffect");
      return true;
    }
  );

  const revalidateQuote = await committedAdapter.createChangeQuote(committed.sub.id, {
    changes: [{ action: "CANCEL" }],
    effectiveIntent: { type: "TERM_END" },
    acceptanceEnvelope: { maxImmediateNetIncrease: 1_000_000, maxImmediateCreditDecrease: 1_000_000, maxRecurringIncrease: 1_000_000 },
  });
  assert.equal(revalidateQuote.guaranteeCoverage.termEffect, "UNKNOWN", "committed-term CANCEL = UNVERIFIED (Contract Terms feature not enabled on the v0.5-LIVE test site) — this sim's early-termination-fee math is NOT designed around, and the type system's only honest choice is UNKNOWN, not EXACT");

  console.log(
    "[Test 11g] v0.6 CORRECTION confirmed: evergreen CANCEL is EXACT (real, live-verified). Committed-term CANCEL " +
      "is UNKNOWN/UNVERIFIED — the v0.5 simulator's claim that it also resolves EXACT was NEVER validated against " +
      "the real API and has been retracted from both the code and this test."
  );
});

test("Test 11h (v0.6 CORRECTED): capability discovery cannot overstate guarantees for Chargebee — coarse provider-level CANCEL report is conservative (UNKNOWN); quote-level resolves EXACT only for evergreen, stays UNKNOWN for committed-term (UNVERIFIED)", async () => {
  const { sim } = freshChargebeeFixture();
  const adapter = new ChargebeeAdapter(sim, new QuoteStore());
  const caps = adapter.getCapabilities();

  assert.equal(caps.quoteCapabilities.CANCEL?.guaranteeCoverage.termEffect, "UNKNOWN", "coarse report stays conservative — it does not know in advance which subscription it will be asked about");

  const evergreenFresh = freshChargebeeFixture();
  const evergreenQuote = await new ChargebeeAdapter(evergreenFresh.sim, new QuoteStore()).createChangeQuote(evergreenFresh.sub.id, {
    changes: [{ action: "CANCEL" }],
    effectiveIntent: { type: "TERM_END" },
    guaranteeMode: "EXACT",
  });
  assert.equal(evergreenQuote.guaranteeCoverage.termEffect, "EXACT", "quote-level coverage resolves EXACT for an evergreen Chargebee subscription — real, live-verified");

  const committedFresh = freshChargebeeCommittedTermFixture();
  const committedQuote = await new ChargebeeAdapter(committedFresh.sim, new QuoteStore()).createChangeQuote(committedFresh.sub.id, {
    changes: [{ action: "CANCEL" }],
    effectiveIntent: { type: "TERM_END" },
    acceptanceEnvelope: { maxImmediateNetIncrease: 1_000_000, maxImmediateCreditDecrease: 1_000_000, maxRecurringIncrease: 1_000_000 },
  });
  assert.equal(committedQuote.guaranteeCoverage.termEffect, "UNKNOWN", "v0.6: committed-term CANCEL is UNVERIFIED, not EXACT — do not design around the retracted v0.5 simulator claim");

  console.log("[Test 11h] Chargebee's quote-level guaranteeCoverage for CANCEL: EXACT for evergreen (real), UNKNOWN for committed-term (UNVERIFIED) — capability discovery neither overstates the coarse report NOR overstates what a specific quote can honestly back.");
});

test("Test 11i: Chargebee has NO native version field — falls back to a synthetic content-hash fingerprint, same posture as Stripe/Paddle (contrast with Zuora)", async () => {
  const { sim, sub } = freshChargebeeFixture();
  const adapter = new ChargebeeAdapter(sim, new QuoteStore());

  const before = await adapter.getSubscription(sub.id);
  // Chargebee's version is a hex hash, structurally nothing like Zuora's
  // small monotonic integer — confirming no native version field is used.
  assert.match(before.version, /^[0-9a-f]{16}$/, "Chargebee's SubscriptionSnapshot.version is a synthetic content hash, not a native counter");

  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [{ action: "CHANGE_QUANTITY", itemId: "item_1", quantity: 120 }],
    effectiveIntent: { type: "IMMEDIATE" },
    acceptanceEnvelope: { maxImmediateNetIncrease: 1_000_000, maxImmediateCreditDecrease: 1_000_000, maxRecurringIncrease: 1_000_000 },
  });

  sim._debugMutateDirectly(sub.id, (s) => {
    s.subscriptionItems[0].quantity = 150;
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
  assert.equal(after.items[0].quantity, 150, "out-of-band mutation happened; commit performed no mutation");

  console.log("[Test 11i] Chargebee's fingerprint-based staleness detection works (Test passed), but is a client-side content-hash workaround, same category as Stripe/Paddle — NOT a native provider guarantee like Zuora's version integer.");
});

test("Test 11j: TOCTOU — Chargebee has no compare-and-swap precondition on update_for_items/cancel_for_items; the same race window as all three other providers remains", async () => {
  const { sim, sub } = freshChargebeeFixture();
  const adapter = new ChargebeeAdapter(sim, new QuoteStore());

  assert.equal(adapter.getCapabilities().consistencyGuarantee, "BEST_EFFORT");

  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [{ action: "CHANGE_QUANTITY", itemId: "item_1", quantity: 120 }],
    effectiveIntent: { type: "IMMEDIATE" },
    guaranteeMode: "EXACT",
  });

  const realUpdate = sim.updateForItems.bind(sim);
  let injected = false;
  sim.updateForItems = ((...args: Parameters<typeof realUpdate>) => {
    if (!injected) {
      injected = true;
      sim._debugMutateDirectly(sub.id, (s) => {
        s.subscriptionItems[0].quantity = 999;
      });
    }
    return realUpdate(...args);
  }) as typeof realUpdate;

  const receipt = await adapter.commitChangeQuote(quote.id);

  console.log(
    "[Test 11j] TOCTOU confirmed on Chargebee: fingerprint check passed (concurrent write landed after it), " +
      "commit proceeded unconditionally and silently overwrote the concurrent write, landing at quantity",
    receipt.resultingSnapshot.items[0].quantity,
    "— identical structural finding to Stripe/Paddle/Zuora (all four providers modeled in this research share this gap)."
  );
  assert.equal(receipt.resultingSnapshot.items[0].quantity, 120, "silent clobber, no conflict surfaced");
  assert.equal(receipt.consistencyGuarantee, "BEST_EFFORT");
});

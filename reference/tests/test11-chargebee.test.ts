import { test } from "node:test";
import assert from "node:assert/strict";
import { QuoteStore } from "../src/store/quote-store.js";
import { ChargebeeAdapter } from "../src/adapters/chargebee-adapter.js";
import { SCQError } from "../src/core/types.js";
import { freshChargebeeFixture, freshChargebeeCommittedTermFixture } from "./fixtures.js";

// Chargebee validation (originated v0.5; Phase 2A corrected the
// capability claims — see research/chargebee-live-v1/
// CLAIM-CORRECTION-MATRIX.md), addressing the five primary research
// questions directly, each with a dedicated test or test group:
//   1. Can Chargebee map to Snapshot -> Quote -> Commit?           (11a-11c)
//   2. Can future-effective changes use requestedEffectiveAt?
//      Phase 2A answer: NOT as previously claimed — DATE and
//      update-action TERM_END are refused, not honored.             (11d)
//   3. Can multi-change operations avoid provider-specific fields? (11e-11f)
//   4. Does quote-level guaranteeCoverage handle state-dependent
//      capabilities accurately?                                   (11g-11h)
//   5. Does Chargebee provide atomic state-precondition+mutation,
//      or does the same TOCTOU gap remain?                        (11i-11j)

test("Test 11a (Phase 2A CORRECTED): Chargebee maps cleanly to getSubscription/createChangeQuote/commitChangeQuote — CHANGE_QUANTITY end-to-end under REVALIDATE, EXACT refused", async () => {
  const { sim, sub } = freshChargebeeFixture();
  const adapter = new ChargebeeAdapter(sim, new QuoteStore());

  const before = await adapter.getSubscription(sub.id);
  assert.equal(before.items[0].quantity, 100);

  // Phase 2A: this test previously requested guaranteeMode "EXACT" and
  // asserted it succeeded because "Chargebee's proration pivots on an
  // explicit instant". That pinning mechanism (effective_from on
  // update_for_items) is NOT ESTABLISHED in the current documented
  // contract — see CLAIM-CORRECTION-MATRIX.md C-01/C-02. EXACT must now
  // be REFUSED, naming the first failing dimension.
  await assert.rejects(
    () =>
      adapter.createChangeQuote(sub.id, {
        changes: [{ action: "CHANGE_QUANTITY", itemId: "item_1", quantity: 120 }],
        effectiveIntent: { type: "IMMEDIATE" },
        guaranteeMode: "EXACT",
      }),
    (err: unknown) => {
      assert.ok(err instanceof SCQError);
      assert.equal(err.code, "UNSUPPORTED_CHANGE");
      assert.equal((err as any).details.failingDimension, "immediateFinancialEffect");
      return true;
    }
  );

  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [{ action: "CHANGE_QUANTITY", itemId: "item_1", quantity: 120 }],
    effectiveIntent: { type: "IMMEDIATE" },
    acceptanceEnvelope: { maxImmediateNetIncrease: 1_000_000, maxImmediateCreditDecrease: 1_000_000, maxRecurringIncrease: 1_000_000 },
  });
  assert.equal(quote.guaranteeMode, "REVALIDATE");
  assert.deepEqual(quote.guaranteeCoverage, {
    immediateFinancialEffect: "REVALIDATE",
    recurringFinancialEffect: "REVALIDATE",
    termEffect: "UNKNOWN",
    effectiveAt: "REVALIDATE",
  }, "Phase 2A corrected coverage: REVALIDATE financials, UNKNOWN term, REVALIDATE effectiveAt — matching the experimental live adapter's posture (unpublished Change B)");

  const afterQuote = await adapter.getSubscription(sub.id);
  assert.equal(afterQuote.items[0].quantity, 100, "quote must not mutate subscription");

  const receipt = await adapter.commitChangeQuote(quote.id);
  assert.equal(receipt.status, "COMMITTED");
  assert.equal(receipt.resultingSnapshot.items[0].quantity, 120);
  // DISCLOSED CHANGE (PR-6, v0.6.2): whole-effect deepEqual was
  // replaced by figure+determinacy equality plus a committedSource
  // assertion. Under the migration the committed effect's FIGURES
  // still equal the quote's figures at the same instant, but its
  // provenance is — correctly — a different, provider-actual
  // provenance: the committed effect is established from the
  // persisted mutation artifact this operation created plus the
  // post-commit re-read, not from the revalidated preview (finding
  // F-1). Whole-object equality can no longer hold for ANY
  // correctly-implemented commit; this is the PR #10 (Stripe)
  // replacement pattern, also used by PR #11/#14.
  assert.deepEqual(receipt.committedEffect.immediate, receipt.quotedEffect.immediate);
  assert.deepEqual(receipt.committedEffect.recurring, receipt.quotedEffect.recurring);
  assert.deepEqual(receipt.committedEffect.determinacy, receipt.quotedEffect.determinacy);
  assert.equal(receipt.committedEffect.provenance?.committedSource, "provider_actual");

  // The scenario the old test used to "prove" EXACT — elapsed time
  // between quote and commit — now demonstrates the opposite, which is
  // the point of REVALIDATE: with a zero-tolerance envelope the drifted
  // revalidation is refused with QUOTE_DRIFTED and NO mutation occurs.
  const drift = freshChargebeeFixture();
  const driftAdapter = new ChargebeeAdapter(drift.sim, new QuoteStore());
  const driftQuote = await driftAdapter.createChangeQuote(drift.sub.id, {
    changes: [{ action: "CHANGE_QUANTITY", itemId: "item_1", quantity: 120 }],
    effectiveIntent: { type: "IMMEDIATE" },
    acceptanceEnvelope: { maxImmediateNetIncrease: 0, maxImmediateCreditDecrease: 0, maxRecurringIncrease: 0 },
  });
  drift.sim.advanceTimeSeconds(10 * 24 * 3600);
  await assert.rejects(
    () => driftAdapter.commitChangeQuote(driftQuote.id),
    (err: unknown) => {
      assert.ok(err instanceof SCQError);
      assert.equal(err.code, "QUOTE_DRIFTED");
      return true;
    }
  );
  const driftAfter = await driftAdapter.getSubscription(drift.sub.id);
  assert.equal(driftAfter.items[0].quantity, 100, "drift refusal happens before mutation");

  console.log("[Test 11a] Phase 2A: Chargebee Snapshot->Quote->Commit works end-to-end for CHANGE_QUANTITY under REVALIDATE; overall EXACT is refused (no documented pinning mechanism), and elapsed time now produces QUOTE_DRIFTED under a zero-tolerance envelope instead of silently reproducing the quote.");
});

test("Test 11b (Phase 2A CORRECTED): Chargebee CHANGE_PLAN and CHANGE_CADENCE map cleanly too — financial dimensions REVALIDATE, termEffect UNKNOWN (bare item swap)", async () => {
  const { sim, sub } = freshChargebeeFixture();
  const adapter = new ChargebeeAdapter(sim, new QuoteStore());

  // Phase 2A: the EXACT refusal for CHANGE_CADENCE previously named
  // termEffect (the financial dimensions were claimed EXACT, so term
  // was the first failing dimension). With financials corrected to
  // REVALIDATE, the first failing dimension is now
  // immediateFinancialEffect. termEffect remains UNKNOWN as well —
  // the refusal is stronger, not weaker.
  await assert.rejects(
    () => adapter.createChangeQuote(sub.id, { changes: [{ action: "CHANGE_CADENCE", cadence: "ANNUAL" }], effectiveIntent: { type: "IMMEDIATE" }, guaranteeMode: "EXACT" }),
    (err: unknown) => {
      assert.ok(err instanceof SCQError);
      assert.equal(err.code, "UNSUPPORTED_CHANGE");
      assert.equal((err as any).details.failingDimension, "immediateFinancialEffect");
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

  // Phase 2A: TERM_END for CANCEL is retained (deprecated-but-
  // documented end_of_term on the separate cancel endpoint,
  // historically observed — see adapter capabilitiesFor), but the
  // quote is REVALIDATE, not EXACT: CANCEL's financial dimensions
  // were downgraded with every other action, so an overall EXACT
  // request for CANCEL is refused (asserted in Test 11g).
  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [{ action: "CANCEL" }],
    effectiveIntent: { type: "TERM_END" },
  });
  assert.equal(quote.guaranteeCoverage.immediateFinancialEffect, "REVALIDATE");
  const receipt = await adapter.commitChangeQuote(quote.id);
  assert.equal(receipt.resultingSnapshot.status, "active", "Chargebee's non_renewing status maps to SCQ's 'active until period end', same as Stripe/Paddle/Zuora");
  assert.equal(receipt.resultingSnapshot.term?.autoRenew, false);

  console.log("[Test 11c] Chargebee CANCEL (PERIOD_END -> non_renewing) normalizes cleanly onto the shared SubscriptionSnapshot shape, under REVALIDATE coverage (Phase 2A).");
});

test("Test 11d (Phase 2A CORRECTED): effectiveIntent DATE and TERM_END are REFUSED for update-backed Chargebee actions — deprecated/early-access scheduling is not advertised as supported", async () => {
  const { sim, sub } = freshChargebeeFixture();
  const adapter = new ChargebeeAdapter(sim, new QuoteStore());

  const farFuture = new Date(sim.currentTime().getTime() + 15 * 24 * 3600 * 1000).toISOString();

  // Phase 2A: this test previously asserted DATE is HONORED via a
  // "native Scheduled Changes (effective_from) mechanism" with
  // effectiveAt EXACT. That mechanism is NOT ESTABLISHED: effective_from
  // is not a documented update_for_items parameter (it belongs to
  // Create-a-ramp, Early Access), and the future-scheduling path that
  // IS documented on the update endpoint (change_option=specific_date)
  // is deprecated for scheduling. DATE is now refused before any
  // preview or mutation, like the experimental live adapter in the
  // unpublished Change B (its mocked-transport test T14).
  await assert.rejects(
    () =>
      adapter.createChangeQuote(sub.id, {
        changes: [{ action: "CHANGE_QUANTITY", itemId: "item_1", quantity: 130 }],
        effectiveIntent: { type: "DATE", at: farFuture },
        acceptanceEnvelope: { maxImmediateNetIncrease: 1_000_000, maxImmediateCreditDecrease: 1_000_000, maxRecurringIncrease: 1_000_000 },
      }),
    (err: unknown) => {
      assert.ok(err instanceof SCQError);
      assert.equal(err.code, "UNSUPPORTED_CHANGE");
      return true;
    }
  );

  // TERM_END for an update-backed action is likewise refused:
  // end_of_term on update_for_items is deprecated-but-documented
  // (toward Ramps), and the simulator never modeled it as the distinct
  // boolean the real endpoint takes. (TERM_END for CANCEL — a
  // different endpoint with historical live observation — remains
  // supported; see Tests 11c/11g.)
  await assert.rejects(
    () =>
      adapter.createChangeQuote(sub.id, {
        changes: [{ action: "CHANGE_QUANTITY", itemId: "item_1", quantity: 130 }],
        effectiveIntent: { type: "TERM_END" },
        acceptanceEnvelope: { maxImmediateNetIncrease: 1_000_000, maxImmediateCreditDecrease: 1_000_000, maxRecurringIncrease: 1_000_000 },
      }),
    (err: unknown) => {
      assert.ok(err instanceof SCQError);
      assert.equal(err.code, "UNSUPPORTED_CHANGE");
      return true;
    }
  );

  // Capability discovery must agree with enforcement (spec §6.5):
  const caps = adapter.getCapabilities();
  assert.deepEqual(caps.quoteCapabilities.CHANGE_QUANTITY?.supportedEffectiveIntents, ["IMMEDIATE"]);
  assert.deepEqual(caps.quoteCapabilities.CANCEL?.supportedEffectiveIntents, ["IMMEDIATE", "TERM_END"]);

  sim.advanceTimeSeconds(20 * 24 * 3600);
  const after = await adapter.getSubscription(sub.id);
  assert.equal(after.items[0].quantity, 100, "both refusals happened before any preview or mutation — nothing was scheduled or applied");

  console.log("[Test 11d] Phase 2A: DATE and update-action TERM_END are refused on the simulator-backed Chargebee adapter — deprecated-but-documented scheduling and Early-Access Ramps are not advertised as supported capabilities.");
});

test("Test 11e: multi-change proposal (CHANGE_QUANTITY + CHANGE_PLAN) has MultiChangeConsistency ATOMIC on Chargebee — the simulator models update_for_items as one full-item-list call (consistencyGuarantee remains BEST_EFFORT)", async () => {
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
  // "ATOMIC" here is MultiChangeConsistency (single-request bundling
  // in the simulator model), NOT ConsistencyGuarantee — the commit's
  // precondition remains BEST_EFFORT (Test 11j). Phase 2A reviewed
  // this claim against the documented single-call full-item-list
  // shape and retained it with that scope; the documented
  // replace_items_list / mandatory-addon caveats of the real API are
  // recorded in CLAIM-CORRECTION-MATRIX.md C-11.
  assert.equal(quote.multiChangeConsistency, "ATOMIC");

  const receipt = await adapter.commitChangeQuote(quote.id);
  assert.equal(receipt.multiChangeConsistency, "ATOMIC");
  assert.equal(receipt.consistencyGuarantee, "BEST_EFFORT");
  assert.equal(receipt.resultingSnapshot.items[0].quantity, 120);
  assert.equal(receipt.resultingSnapshot.billing.recurringAmount, 1500 * 120);

  console.log("[Test 11e] Chargebee multi-change (quantity+plan) via a single modeled update_for_items call — no Chargebee-specific fields visible in the SCQ-level proposal/quote/receipt shapes used to express this.");
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

test("Test 11g (v0.6 CORRECTED, Phase 2A RE-CORRECTED): quote-level guaranteeCoverage for CANCEL differs by subscription state on the termEffect dimension ONLY — evergreen termEffect EXACT; committed-term termEffect UNKNOWN (UNVERIFIED); financial dimensions REVALIDATE for both", async () => {
  const evergreen = freshChargebeeFixture();
  const evergreenAdapter = new ChargebeeAdapter(evergreen.sim, new QuoteStore());

  // Phase 2A: the evergreen quote previously deep-equaled all-EXACT
  // coverage and was created with guaranteeMode "EXACT". The
  // historical v0.5-LIVE observation supports, at most, the termEffect
  // dimension for evergreen CANCEL (no commitment, no fee observed in
  // that limited research). Financial dimensions are REVALIDATE after
  // Phase 2A, so the quote is created without an EXACT request (an
  // EXACT request is refused — asserted just below) and its coverage
  // is EXACT on termEffect ONLY.
  const evergreenQuote = await evergreenAdapter.createChangeQuote(evergreen.sub.id, {
    changes: [{ action: "CANCEL" }],
    effectiveIntent: { type: "TERM_END" },
  });
  assert.deepEqual(evergreenQuote.guaranteeCoverage, {
    immediateFinancialEffect: "REVALIDATE",
    recurringFinancialEffect: "REVALIDATE",
    termEffect: "EXACT",
    effectiveAt: "REVALIDATE",
  }, "evergreen CANCEL: termEffect EXACT only (limited historical live observation, v0.5-LIVE Experiment 3); financials REVALIDATE per Phase 2A — NOT an all-EXACT quote");

  await assert.rejects(
    () =>
      evergreenAdapter.createChangeQuote(evergreen.sub.id, {
        changes: [{ action: "CANCEL" }],
        effectiveIntent: { type: "TERM_END" },
        guaranteeMode: "EXACT",
      }),
    (err: unknown) => {
      assert.ok(err instanceof SCQError);
      assert.equal(err.code, "UNSUPPORTED_CHANGE");
      assert.equal((err as any).details.failingDimension, "immediateFinancialEffect", "even evergreen CANCEL cannot back overall EXACT after Phase 2A — the financial dimensions fail first");
      return true;
    }
  );

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

  // Phase 2A: the committed-term EXACT refusal previously named
  // termEffect; with financials corrected to REVALIDATE it now names
  // immediateFinancialEffect (the first failing dimension). The
  // termEffect-specific refusal remains observable on the REVALIDATE
  // quote below (UNKNOWN), and the v0.6 correction's substance —
  // committed-term CANCEL is UNVERIFIED, never EXACT — is unchanged.
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
      assert.equal((err as any).details.failingDimension, "immediateFinancialEffect");
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
    "[Test 11g] Phase 2A: evergreen CANCEL termEffect is EXACT (limited historical live observation); financials are REVALIDATE for every CANCEL quote. Committed-term CANCEL " +
      "is UNKNOWN/UNVERIFIED — the v0.5 simulator's claim that it also resolves EXACT was NEVER validated against " +
      "the real API and has been retracted from both the code and this test."
  );
});

test("Test 11h (v0.6 CORRECTED, Phase 2A RE-CORRECTED): capability discovery cannot overstate guarantees for Chargebee — coarse report is REVALIDATE/UNKNOWN on every action; quote-level termEffect resolves EXACT only for evergreen CANCEL, stays UNKNOWN for committed-term (UNVERIFIED)", async () => {
  const { sim } = freshChargebeeFixture();
  const adapter = new ChargebeeAdapter(sim, new QuoteStore());
  const caps = adapter.getCapabilities();

  assert.equal(caps.quoteCapabilities.CANCEL?.guaranteeCoverage.termEffect, "UNKNOWN", "coarse report stays conservative — it does not know in advance which subscription it will be asked about");
  // Phase 2A: coarse financial coverage is REVALIDATE for EVERY action,
  // and no action advertises DATE; update-backed actions do not
  // advertise TERM_END either (see Test 11d).
  for (const action of ["CHANGE_QUANTITY", "CHANGE_PLAN", "CHANGE_CADENCE", "CANCEL"] as const) {
    assert.equal(caps.quoteCapabilities[action]?.guaranteeCoverage.immediateFinancialEffect, "REVALIDATE", `${action}: coarse immediateFinancialEffect must be REVALIDATE after Phase 2A`);
    assert.equal(caps.quoteCapabilities[action]?.guaranteeCoverage.recurringFinancialEffect, "REVALIDATE", `${action}: coarse recurringFinancialEffect must be REVALIDATE after Phase 2A`);
    assert.ok(!caps.quoteCapabilities[action]?.supportedEffectiveIntents.includes("DATE"), `${action}: DATE must not be advertised`);
  }

  // Phase 2A: the evergreen quote is no longer created with
  // guaranteeMode "EXACT" (that request is refused — financials fail
  // first, Test 11g). The quote-level/coarse divergence this test
  // guards is now scoped to the termEffect dimension alone.
  const evergreenFresh = freshChargebeeFixture();
  const evergreenQuote = await new ChargebeeAdapter(evergreenFresh.sim, new QuoteStore()).createChangeQuote(evergreenFresh.sub.id, {
    changes: [{ action: "CANCEL" }],
    effectiveIntent: { type: "TERM_END" },
  });
  assert.equal(evergreenQuote.guaranteeCoverage.termEffect, "EXACT", "quote-level termEffect resolves EXACT for an evergreen Chargebee subscription (limited historical live observation)");
  assert.equal(evergreenQuote.guaranteeCoverage.immediateFinancialEffect, "REVALIDATE", "quote-level financials stay REVALIDATE even for evergreen CANCEL");

  const committedFresh = freshChargebeeCommittedTermFixture();
  const committedQuote = await new ChargebeeAdapter(committedFresh.sim, new QuoteStore()).createChangeQuote(committedFresh.sub.id, {
    changes: [{ action: "CANCEL" }],
    effectiveIntent: { type: "TERM_END" },
    acceptanceEnvelope: { maxImmediateNetIncrease: 1_000_000, maxImmediateCreditDecrease: 1_000_000, maxRecurringIncrease: 1_000_000 },
  });
  assert.equal(committedQuote.guaranteeCoverage.termEffect, "UNKNOWN", "v0.6: committed-term CANCEL is UNVERIFIED, not EXACT — do not design around the retracted v0.5 simulator claim");

  console.log("[Test 11h] Chargebee capability discovery after Phase 2A: coarse REVALIDATE/UNKNOWN everywhere; quote-level divergence survives on termEffect alone (evergreen EXACT, committed-term UNKNOWN) — neither level overstates what enforcement can back.");
});

test("Test 11i: the Chargebee SIMULATOR exposes no native version field — the adapter falls back to a synthetic content-hash fingerprint (the real API's documented resource_version is a millisecond timestamp used by the experimental live adapter (unpublished Change B) for detection, not a CAS precondition — see API-CONTRACT-AUDIT.md A5)", async () => {
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

  // Phase 2A: previously requested with guaranteeMode "EXACT"; now a
  // REVALIDATE quote with a generous envelope — the TOCTOU behavior
  // under test (silent clobber inside the mutating call) is identical,
  // because the race lives between the fingerprint check / last
  // preview and the mutation, not in the guarantee mode.
  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [{ action: "CHANGE_QUANTITY", itemId: "item_1", quantity: 120 }],
    effectiveIntent: { type: "IMMEDIATE" },
    acceptanceEnvelope: { maxImmediateNetIncrease: 1_000_000, maxImmediateCreditDecrease: 1_000_000, maxRecurringIncrease: 1_000_000 },
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
  // DISCLOSED ADDITION (PR-6, v0.6.2) — a strengthening, not a
  // weakening: this test previously asserted NO receipt status.
  // The competing write landed inside the mutate window, so the
  // persisted artifact's fingerprint bracket does not close around
  // this commit (it began on state the competitor had already
  // changed, not the state this commit validated). Under PR #14
  // doctrine Z1 the landing is therefore NOT attributable-verified
  // even though the final state coincidentally matches the intent:
  // the receipt caps at COMMITTED_UNVERIFIED / UNVERIFIED, where
  // the pre-migration code (committed effect = revalidated preview,
  // finding F-1) would have reported COMMITTED / OK. See test25's
  // dedicated broken-attribution cases.
  assert.equal(receipt.status, "COMMITTED_UNVERIFIED");
  assert.equal(receipt.reconciliation.status, "UNVERIFIED");
});

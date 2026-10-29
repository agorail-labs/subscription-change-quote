import { test } from "node:test";
import assert from "node:assert/strict";
import { QuoteStore } from "../src/store/quote-store.js";
import { ZuoraAdapter } from "../src/adapters/zuora-adapter.js";
import { SCQError } from "../src/core/types.js";
import { freshZuoraFixture, freshZuoraCommittedTermFixture } from "./fixtures.js";

// v0.4 required scenarios: CHANGE_QUANTITY, CHANGE_PLAN, CHANGE_CADENCE,
// CANCEL only. Contract-heavy cases: monthly->annual, commitment
// creation/alteration, cancellation during committed term, quantity change
// with future effective date. Also: capability discovery, version-based
// staleness (does Zuora's real version field behave differently from
// Stripe/Paddle's synthetic fingerprint), and whether preview->order can
// guarantee the same commercial result or also needs REVALIDATE.
//
// v0.5 UPDATE: Test 9e and Test 9j below have CHANGED substantively, not
// just been wrapped in `changes: [...]`. v0.4 found (and documented as an
// unresolved gap) that CANCEL's action-level capability report is
// necessarily UNKNOWN for termEffect (since a committed-term subscription
// might exist), even though a SPECIFIC evergreen subscription's
// cancellation term consequence is fully knowable. v0.5's quote-level
// `guaranteeCoverage` field exists PRECISELY to close this gap — Test 9e
// now demonstrates that an overall EXACT request SUCCEEDS for CANCEL on an
// evergreen Zuora subscription, using the quote-level (not provider-level)
// coverage. Test 9j is extended to check quote-level coverage as well as
// provider-level, for both an evergreen and a committed-term subscription.
// Test 9g is also extended to exercise `requestedEffectiveAt` through the
// real ZuoraAdapter API, closing the v0.4 gap where this could only be
// demonstrated against the raw sim.

test("Test 9a: Zuora getCapabilities — EXACT financial+term for CHANGE_QUANTITY, EXACT financial but UNKNOWN termEffect for CHANGE_PLAN/CADENCE/CANCEL (coarse, provider-level report)", () => {
  const { sim } = freshZuoraFixture();
  const adapter = new ZuoraAdapter(sim, new QuoteStore());
  const caps = adapter.getCapabilities();

  assert.deepEqual(caps.quoteCapabilities.CHANGE_QUANTITY!.guaranteeCoverage, {
    immediateFinancialEffect: "EXACT",
    recurringFinancialEffect: "EXACT",
    termEffect: "EXACT",
    effectiveAt: "EXACT",
  }, "a plain quantity change on an existing charge provably does not touch term fields");

  for (const action of ["CHANGE_PLAN", "CHANGE_CADENCE", "CANCEL"] as const) {
    const coverage = caps.quoteCapabilities[action];
    assert.equal(coverage!.guaranteeCoverage.immediateFinancialEffect, "EXACT", `${action}: Zuora order pricing is deterministic given effectiveDate, not wall-clock dependent`);
    assert.equal(coverage!.guaranteeCoverage.recurringFinancialEffect, "EXACT", `${action}`);
    assert.equal(coverage!.guaranteeCoverage.termEffect, "UNKNOWN", `${action}: coarse provider-level report — see Test 9e for the more precise quote-level answer for CANCEL`);
    assert.equal(coverage!.guaranteeCoverage.effectiveAt, "EXACT", `${action}: effectiveDate is a caller-supplied input, never silently substituted`);
  }

  console.log("[Test 9a] Zuora quoteCapabilities (coarse, provider-level):", JSON.stringify(caps.quoteCapabilities));
});

test("Test 9b: Zuora consistencyGuarantee is BEST_EFFORT, not ATOMIC, despite having a real version field", () => {
  const { sim } = freshZuoraFixture();
  const adapter = new ZuoraAdapter(sim, new QuoteStore());
  assert.equal(
    adapter.getCapabilities().consistencyGuarantee,
    "BEST_EFFORT",
    "a real version field strengthens staleness DETECTION but createOrder() still has no compare-and-swap precondition parameter"
  );
});

test("Test 9c: CHANGE_QUANTITY, EXACT — quote doesn't mutate, commit reproduces the quoted amount exactly (no wall-clock dependency to defeat, unlike Stripe/Paddle)", async () => {
  const { sim, sub } = freshZuoraFixture();
  const adapter = new ZuoraAdapter(sim, new QuoteStore());

  const before = await adapter.getSubscription(sub.id);
  assert.equal(before.items[0].quantity, 100);
  assert.equal(before.version, "1", "Zuora's real version field, not a synthetic fingerprint");

  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [{ action: "CHANGE_QUANTITY", itemId: "rpc_1", quantity: 120 }],
    effectiveIntent: { type: "IMMEDIATE" },
    guaranteeMode: "EXACT",
  });
  assert.equal(quote.guaranteeMode, "EXACT");
  assert.equal(quote.multiChangeConsistency, "ATOMIC", "single-change proposal is trivially ATOMIC");
  assert.deepEqual(quote.guaranteeCoverage, { immediateFinancialEffect: "EXACT", recurringFinancialEffect: "EXACT", termEffect: "EXACT", effectiveAt: "EXACT" }, "quote-level coverage must match the coarse report here, since this action's coarse report is already fully EXACT");

  const afterQuote = await adapter.getSubscription(sub.id);
  assert.equal(afterQuote.items[0].quantity, 100, "quote must not mutate subscription");
  assert.equal(afterQuote.version, "1", "preview must not bump version");

  // Simulate real elapsed time between quote and commit — the exact
  // scenario that defeats Stripe/Paddle's unpinned proration (v0.1-v0.3
  // Test 6). Zuora's order math is a function of the order's OWN
  // effectiveDate (captured at quote time and replayed verbatim), not
  // ambient wall-clock "now", so this should NOT cause drift here.
  sim.advanceTimeSeconds(10 * 24 * 3600);

  const receipt = await adapter.commitChangeQuote(quote.id);
  assert.equal(receipt.status, "COMMITTED");
  assert.equal(receipt.resultingSnapshot.items[0].quantity, 120);
  assert.equal(receipt.resultingSnapshot.version, "2", "version must increment by exactly 1 per order");
  // PR-5 DISCLOSED EXPECTATION CHANGE (v0.6.2 Zuora migration):
  // whole-effect deepEqual(committedEffect, quotedEffect) is no
  // longer the contract — a committed effect carries committed
  // provenance (CORE-2: here, provider_actual figures established
  // from the persisted order read back by id) that a quote-side
  // effect never asserts. The zero-drift FIGURES still match
  // exactly — and unlike Stripe this required NO proration_date-
  // style pin, since Zuora's order math was never wall-clock-
  // dependent in the first place; assert those.
  assert.deepEqual(receipt.committedEffect.immediate, receipt.quotedEffect.immediate, "EXACT mode: committed immediate figures match the quote exactly");
  assert.deepEqual(receipt.committedEffect.recurring, receipt.quotedEffect.recurring);
  assert.deepEqual(receipt.committedEffect.determinacy, receipt.quotedEffect.determinacy);
  assert.equal(receipt.committedEffect.provenance?.committedSource, "provider_actual");

  console.log("[Test 9c] quoted/committed immediate charge:", receipt.quotedEffect.immediate, "— unaffected by 10 days elapsing, with no pinning mechanism needed");
});

test("Test 9d: CHANGE_PLAN and CHANGE_CADENCE — EXACT financial dimensions honored, but termEffect UNKNOWN request refused for overall EXACT", async () => {
  const { sim, sub } = freshZuoraFixture();
  const adapter = new ZuoraAdapter(sim, new QuoteStore());

  // Overall EXACT request must be refused — termEffect is UNKNOWN for CHANGE_CADENCE.
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
      assert.equal((err as any).details.failingDimension, "termEffect");
      return true;
    }
  );

  // REVALIDATE works and correctly reports term as UNKNOWN in the quote.
  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [{ action: "CHANGE_CADENCE", cadence: "ANNUAL" }],
    effectiveIntent: { type: "IMMEDIATE" },
    acceptanceEnvelope: { maxImmediateNetIncrease: 1_000_000, maxImmediateCreditDecrease: 1_000_000, maxRecurringIncrease: 1_000_000 },
  });
  assert.equal(quote.guaranteeMode, "REVALIDATE");
  assert.equal(quote.guaranteeCoverage.termEffect, "UNKNOWN", "this action's quote-level coverage matches the coarse report — no per-subscription-state override applies for CHANGE_CADENCE, unlike CANCEL (see Test 9e)");
  assert.equal(quote.commercialEffect.recurring?.resultingAmount, 10000 * 100, "MONTHLY->ANNUAL recurring amount must still be exactly derivable");
  assert.equal(quote.commercialEffect.recurring?.cadence, "ANNUAL");
  assert.equal(quote.commercialEffect.term?.createsCommitment, "UNKNOWN", "the renewal-anchor interaction is genuinely not surfaced by a bare plan-swap preview");
  assert.equal(quote.commercialEffect.term?.commitmentUntil, "UNKNOWN");

  console.log("[Test 9d] MONTHLY->ANNUAL commercialEffect:", JSON.stringify(quote.commercialEffect));
  console.log(
    "[Test 9d] GAP: unlike Stripe/Paddle (where commitment semantics are UNKNOWN because the concept doesn't " +
      "exist at all), Zuora DOES have a real contract-term object — but a bare rate-plan-swap order action does " +
      "not reliably surface whether it interacts with that term structure without an explicit TermsAndConditions " +
      "order action alongside it. This is a narrower, more specific gap than Stripe/Paddle's, not the same gap."
  );

  const receipt = await adapter.commitChangeQuote(quote.id);
  assert.equal(receipt.resultingSnapshot.billing.cadence, "ANNUAL");
  assert.equal(receipt.resultingSnapshot.billing.recurringAmount, 10000 * 100);
});

test("Test 9e (v0.5, CHANGED): CANCEL of an evergreen subscription — quote-level guaranteeCoverage resolves termEffect to EXACT, and an overall EXACT request NOW SUCCEEDS", async () => {
  const { sim, sub } = freshZuoraFixture();
  const adapter = new ZuoraAdapter(sim, new QuoteStore());

  // v0.4 found: capabilitiesFor() reports CANCEL's termEffect as UNKNOWN at
  // the COARSE, action-level (getCapabilities()) because early-termination
  // consequences during a committed term cannot be determined from the
  // order alone in general. v0.4 left this undocumented tension between
  // the coarse report and what's actually knowable for THIS subscription.
  //
  // v0.5 CLOSES this gap: quote-level `guaranteeCoverage` is computed
  // against the ACTUAL subscription state (evergreen, no committed term),
  // resolves termEffect to EXACT for this specific quote, and an overall
  // EXACT request — which is checked against quote-level coverage, not the
  // coarse provider-level report — now SUCCEEDS. This is the core v0.5
  // fix demonstrated end-to-end, not just asserted in isolation.
  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [{ action: "CANCEL" }],
    effectiveIntent: { type: "TERM_END" },
    guaranteeMode: "EXACT",
  });
  assert.deepEqual(
    quote.guaranteeCoverage,
    { immediateFinancialEffect: "EXACT", recurringFinancialEffect: "EXACT", termEffect: "EXACT", effectiveAt: "EXACT" },
    "quote-level coverage for THIS evergreen subscription resolves termEffect to EXACT, even though the coarse provider-level report says UNKNOWN for CANCEL in general"
  );
  assert.equal(quote.guaranteeMode, "EXACT", "the EXACT request was honored, not silently downgraded or refused");
  assert.equal(quote.commercialEffect.term?.createsCommitment, false);

  const receipt = await adapter.commitChangeQuote(quote.id);
  assert.equal(receipt.resultingSnapshot.status, "active", "remains active until period end");
  assert.equal(receipt.resultingSnapshot.term?.autoRenew, false);
  // PR-5 DISCLOSED EXPECTATION CHANGE (v0.6.2 Zuora migration):
  // whole-effect deepEqual(committedEffect, quotedEffect) is no
  // longer the contract — the verified committed effect is labeled
  // defined_equal_exact with its verification kind recorded in
  // provenance (CORE-2), which a quote-side effect never asserts.
  // The FIGURES still coincide exactly; assert those.
  assert.deepEqual(receipt.committedEffect.immediate, receipt.quotedEffect.immediate, "EXACT mode: quoted and committed figures coincide");
  assert.deepEqual(receipt.committedEffect.recurring, receipt.quotedEffect.recurring);
  assert.deepEqual(receipt.committedEffect.determinacy, receipt.quotedEffect.determinacy);
  assert.equal(receipt.committedEffect.provenance?.committedSource, "defined_equal_exact");

  console.log(
    "[Test 9e] v0.5 fix confirmed: quote-level guaranteeCoverage for an evergreen subscription's CANCEL resolved " +
      "termEffect to EXACT, and the overall EXACT request succeeded end-to-end — closing the v0.4 gap where the " +
      "coarse action-level report's UNKNOWN would have refused this even though the answer was fully knowable."
  );
});

test("Test 9e2: CANCEL of a COMMITTED-term subscription (contrast case) — quote-level coverage correctly stays UNKNOWN, EXACT still refused", async () => {
  const { sim, sub } = freshZuoraCommittedTermFixture();
  const adapter = new ZuoraAdapter(sim, new QuoteStore());

  await assert.rejects(
    () => adapter.createChangeQuote(sub.id, { changes: [{ action: "CANCEL" }], effectiveIntent: { type: "TERM_END" }, guaranteeMode: "EXACT" }),
    (err: unknown) => {
      assert.ok(err instanceof SCQError);
      assert.equal(err.code, "UNSUPPORTED_CHANGE");
      assert.equal((err as any).details.failingDimension, "termEffect");
      return true;
    }
  );

  console.log("[Test 9e2] Contrast to Test 9e: quote-level coverage correctly distinguishes evergreen (EXACT) from committed-term (UNKNOWN) CANCEL — this is exactly the per-state precision v0.5's guaranteeCoverage was built to provide.");
});

test("Test 9f: CANCEL during a committed term — early-termination consequence genuinely UNKNOWN from the order preview alone", async () => {
  const { sim, sub } = freshZuoraCommittedTermFixture();
  const adapter = new ZuoraAdapter(sim, new QuoteStore());

  const before = await adapter.getSubscription(sub.id);
  assert.equal(before.term?.autoRenew, false);
  assert.ok(before.term?.commitmentUntil, "committed-term subscription must expose a real commitmentUntil date, unlike Stripe/Paddle");

  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [{ action: "CANCEL" }], // canceling immediately, well before the 12-month term ends
    effectiveIntent: { type: "IMMEDIATE" },
    acceptanceEnvelope: { maxImmediateNetIncrease: 1_000_000, maxImmediateCreditDecrease: 1_000_000, maxRecurringIncrease: 1_000_000 },
  });
  assert.equal(quote.guaranteeCoverage.termEffect, "UNKNOWN", "confirmed at quote level too, not just the coarse report — this subscription genuinely IS under a committed term");

  console.log("[Test 9f] Cancel-during-term commercialEffect:", JSON.stringify(quote.commercialEffect));
  console.log(
    "[Test 9f] GAP: canceling mid-committed-term may trigger an early-termination charge in real Zuora setups, " +
      "governed by account/product configuration OUTSIDE the order itself (custom workflow rules, settlement " +
      "logic) — the order preview response alone does not reliably surface whether such a charge applies. This " +
      "sim models that as an explicit, un-derivable gap rather than assuming no fee (which would be an invented, " +
      "unverified assumption) or a specific fee amount (equally unverifiable)."
  );

  // The order preview's own immediate financial effect (from the
  // CancelSubscription action itself, before any external fee logic) is
  // still reported — but term consequence is explicitly UNKNOWN precisely
  // because the early-termination question could not be resolved.
  assert.equal(quote.commercialEffect.term?.createsCommitment, "UNKNOWN");

  // PR-5 DISCLOSED EXPECTATION CHANGE (v0.6.2 Zuora migration): the
  // pre-migration code COMMITTED this quote — its committedEffect was
  // the revalidated preview (finding F-1), whose absent immediate the
  // frozen v0.6.1 envelope zero-filled, so the unestablished
  // early-termination exposure passed silently. Under v0.6.2 the
  // quote's immediate dimension is UNKNOWN (the total incurred
  // obligation is not established while the fee question is open —
  // never a fabricated zero, never NOT_APPLICABLE), and the
  // adapter-level determinacy gate (M2) refuses the commit BEFORE
  // any mutation. The quote-side assertions above are unchanged.
  assert.equal(quote.commercialEffect.determinacy?.immediateFinancialEffect, "UNKNOWN");
  assert.equal(quote.commercialEffect.immediate, undefined, "no figure is emitted for an unestablished dimension — never zero-filled");
  const stateBefore = JSON.stringify(sim.get(sub.id));
  await assert.rejects(
    () => adapter.commitChangeQuote(quote.id),
    (err: unknown) => {
      assert.ok(err instanceof SCQError);
      assert.equal(err.code, "QUOTE_NOT_DETERMINISTIC");
      assert.equal((err as any).details.stage, "quoted");
      assert.equal((err as any).details.dimension, "immediateFinancialEffect");
      return true;
    }
  );
  assert.equal(sim.ordersFor(sub.id).length, 0, "the refusal performed zero mutating calls");
  assert.equal(JSON.stringify(sim.get(sub.id)), stateBefore, "subscription state is byte-identical after the refusal");
});

test("Test 9g (v0.5, EXTENDED): quantity change with requestedEffectiveAt — now exercised through the real ZuoraAdapter API, not just the raw sim", async () => {
  const { sim, sub } = freshZuoraFixture();
  const adapter = new ZuoraAdapter(sim, new QuoteStore());

  // v0.4 found this could only be demonstrated against the raw sim,
  // because SCQ's proposal schema had no field to let a caller request an
  // arbitrary future date. v0.5 added `requestedEffectiveAt` to the
  // proposal specifically to close this; v0.6 replaced that bare timestamp
  // field with the closed `effectiveIntent` union — `{ type: "DATE", at }`
  // is the v0.6 spelling of the same request. This test exercises it
  // through the public createChangeQuote/commitChangeQuote API.
  const futureDate = new Date(sim.currentTime().getTime() + 15 * 24 * 3600 * 1000).toISOString();

  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [{ action: "CHANGE_QUANTITY", itemId: "rpc_1", quantity: 130 }],
    effectiveIntent: { type: "DATE", at: futureDate },
    guaranteeMode: "EXACT",
  });
  assert.equal(quote.guaranteeCoverage.effectiveAt, "EXACT", "Zuora can honor an arbitrary future effectiveIntent DATE");

  // Advance time PAST the requested future date before committing, to
  // prove the effective date that actually gets used is the REQUESTED
  // one (captured in the order action), not whatever "now" happens to be
  // at commit time.
  sim.advanceTimeSeconds(20 * 24 * 3600);

  const receipt = await adapter.commitChangeQuote(quote.id);
  assert.equal(receipt.status, "COMMITTED");
  assert.equal(receipt.resultingSnapshot.items[0].quantity, 130);
  // PR-5 DISCLOSED EXPECTATION CHANGE (v0.6.2 Zuora migration):
  // whole-effect deepEqual(committedEffect, quotedEffect) is no
  // longer the contract — the committed effect carries committed
  // provenance (provider_actual, established from the persisted
  // order read back by id). The future-dated order action was still
  // replayed verbatim, reproducing the quoted FIGURES exactly;
  // assert those.
  assert.deepEqual(receipt.committedEffect.immediate, receipt.quotedEffect.immediate, "EXACT: the future-dated order action was replayed verbatim, reproducing the quoted figures exactly");
  assert.deepEqual(receipt.committedEffect.recurring, receipt.quotedEffect.recurring);
  assert.deepEqual(receipt.committedEffect.determinacy, receipt.quotedEffect.determinacy);
  assert.equal(receipt.committedEffect.provenance?.committedSource, "provider_actual");

  console.log(
    "[Test 9g] v0.5 fix confirmed: requestedEffectiveAt was honored end-to-end through the real adapter API " +
      "(not just demonstrated against the raw sim as in v0.4) — quoted a change 15 days out, advanced past that " +
      "date, and commit still reproduced the quoted numbers exactly by replaying the captured effectiveDate."
  );
});

test("Test 9h: stale quote — Zuora's real version field detects an out-of-band order, same QUOTE_STALE / no-mutation outcome as Stripe/Paddle's synthetic fingerprint", async () => {
  const { sim, sub } = freshZuoraFixture();
  const adapter = new ZuoraAdapter(sim, new QuoteStore());

  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [{ action: "CHANGE_QUANTITY", itemId: "rpc_1", quantity: 120 }],
    effectiveIntent: { type: "IMMEDIATE" },
    guaranteeMode: "EXACT",
  });

  // Simulate a concurrent, out-of-band order (e.g. a different system, a
  // CSR action) bypassing SCQ. Real Zuora bumps version on ANY order that
  // touches the subscription — modeled faithfully by _debugMutateDirectly.
  sim._debugMutateDirectly(sub.id, (s) => {
    s.ratePlans[0].ratePlanCharges[0].quantity = 150;
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
  assert.equal(after.items[0].quantity, 150, "only the out-of-band order happened; commit performed no mutation");
  assert.equal(after.version, "2", "version bumped by the out-of-band order, not by the refused commit attempt");

  console.log("[Test 9h] Zuora's native version field caught the concurrent order just as reliably as Stripe/Paddle's synthetic fingerprint did — same outcome, different (stronger, native) mechanism.");
});

test("Test 9i: TOCTOU — Zuora's real version field narrows the detectable-drift surface but does NOT close the race window; createOrder() has no compare-and-swap precondition", async () => {
  const { sim, sub } = freshZuoraFixture();
  const adapter = new ZuoraAdapter(sim, new QuoteStore());

  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [{ action: "CHANGE_QUANTITY", itemId: "rpc_1", quantity: 120 }],
    effectiveIntent: { type: "IMMEDIATE" },
    guaranteeMode: "EXACT",
  });

  // Inject a concurrent out-of-band order that lands strictly between the
  // version check (already passed inside commitChangeQuote) and the
  // createOrder() call itself — same technique as the Stripe/Paddle v0.2
  // TOCTOU tests, applied here to prove Zuora's stronger version field
  // does not change the structural outcome.
  const realCreateOrder = sim.createOrder.bind(sim);
  let injected = false;
  sim.createOrder = ((...args: Parameters<typeof realCreateOrder>) => {
    if (!injected) {
      injected = true;
      sim._debugMutateDirectly(sub.id, (s) => {
        s.ratePlans[0].ratePlanCharges[0].quantity = 999;
      });
    }
    return realCreateOrder(...args);
  }) as typeof realCreateOrder;

  const receipt = await adapter.commitChangeQuote(quote.id);

  console.log(
    "[Test 9i] TOCTOU: the version check passed (concurrent order landed AFTER it), then SCQ's own createOrder() " +
      "call proceeded unconditionally and overwrote the concurrent write, landing at quantity",
    receipt.resultingSnapshot.items[0].quantity,
    "- identical structural outcome to Stripe/Paddle (v0.2 Test 7) despite Zuora's version field being a real, " +
      "native concurrency primitive rather than a synthetic hash. The primitive is stronger for DETECTION; it does " +
      "not provide ATOMICITY, because nothing in this call sequence lets SCQ say 'create this order ONLY IF " +
      "version is still N' as a single server-enforced operation."
  );

  assert.equal(receipt.resultingSnapshot.items[0].quantity, 120, "SCQ's mutation silently overwrites the concurrent write; no conflict is ever surfaced, same as Stripe/Paddle");
  assert.equal(receipt.consistencyGuarantee, "BEST_EFFORT", "a stronger detection primitive does not upgrade this to ATOMIC");
});

test("Test 9j: capability discovery cannot overstate guarantees for Zuora (extends v0.3/v0.4's cross-check to the third provider; v0.5 adds quote-level check too)", async () => {
  const { sim, sub } = freshZuoraFixture();
  const adapter = new ZuoraAdapter(sim, new QuoteStore());
  const caps = adapter.getCapabilities();

  const actionsToCheck: Array<{ action: "CHANGE_QUANTITY" | "CHANGE_CADENCE" | "CANCEL"; buildProposal: () => any }> = [
    { action: "CHANGE_QUANTITY", buildProposal: () => ({ changes: [{ action: "CHANGE_QUANTITY", itemId: "rpc_1", quantity: 105 }], effectiveIntent: { type: "IMMEDIATE" }, guaranteeMode: "EXACT" }) },
    { action: "CHANGE_CADENCE", buildProposal: () => ({ changes: [{ action: "CHANGE_CADENCE", cadence: "ANNUAL" }], effectiveIntent: { type: "IMMEDIATE" }, guaranteeMode: "EXACT" }) },
    { action: "CANCEL", buildProposal: () => ({ changes: [{ action: "CANCEL" }], effectiveIntent: { type: "TERM_END" }, guaranteeMode: "EXACT" }) },
  ];

  for (const { action, buildProposal } of actionsToCheck) {
    const coverage = caps.quoteCapabilities[action];
    assert.ok(coverage, `${action} must be present in quoteCapabilities`);
    const advertisedFullyExact = Object.values(coverage!.guaranteeCoverage).every((v) => v === "EXACT");

    let actuallyAllowed = true;
    let quoteLevelCoverage: any;
    try {
      const fresh = freshZuoraFixture();
      const freshAdapter = new ZuoraAdapter(fresh.sim, new QuoteStore());
      const quote = await freshAdapter.createChangeQuote(fresh.sub.id, buildProposal());
      quoteLevelCoverage = quote.guaranteeCoverage;
    } catch {
      actuallyAllowed = false;
    }

    if (action === "CANCEL") {
      // v0.5 KNOWN, DELIBERATE divergence: the coarse provider-level report
      // says CANCEL is NOT fully EXACT (termEffect UNKNOWN in general), but
      // an evergreen subscription's quote-level coverage resolves EXACT —
      // so actual enforcement CORRECTLY allows this even though the coarse
      // advertisement alone would predict a refusal. This is not
      // "capability discovery overstating a guarantee" — getCapabilities()
      // never claimed CANCEL was universally EXACT; it is the quote-level
      // field, checked against the ACTUAL state, that authorizes this.
      assert.equal(advertisedFullyExact, false, "coarse report must NOT claim full EXACT for CANCEL");
      assert.equal(actuallyAllowed, true, "but THIS subscription's quote-level coverage legitimately allows it — see Test 9e");
      assert.deepEqual(quoteLevelCoverage, { immediateFinancialEffect: "EXACT", recurringFinancialEffect: "EXACT", termEffect: "EXACT", effectiveAt: "EXACT" });
    } else {
      assert.equal(
        actuallyAllowed,
        advertisedFullyExact,
        `${action}: getCapabilities() advertised fully-EXACT=${advertisedFullyExact} but actual enforcement allowed=${actuallyAllowed} — these should agree for non-CANCEL actions, which have no quote-level override in this adapter`
      );
    }
  }

  console.log("[Test 9j] Cross-checked Zuora's getCapabilities() (coarse) against actual EXACT enforcement (quote-level) — CANCEL's deliberate, documented divergence confirmed as intentional and correct, not drift.");
});

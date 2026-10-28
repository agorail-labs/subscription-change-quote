import { test } from "node:test";
import assert from "node:assert/strict";
import { QuoteStore, type StoredQuote } from "../src/store/quote-store.js";
import {
  validateCommit,
  checkIdempotentReplay,
  reconcileCommittedEffect,
  enforceNoPartialExecutionRisk,
} from "../src/core/scq-engine.js";
import { SCQError, type SubscriptionChangeReceipt } from "../src/core/types.js";
import { StripeAdapter } from "../src/adapters/stripe-adapter.js";
import { PaddleAdapter } from "../src/adapters/paddle-adapter.js";
import { freshStripeFixture, freshPaddleFixture } from "./fixtures.js";

// v0.6.1 standards-hardening cycle. Covers, per the cycle's explicit scope:
//   1. EXACT wording narrowing — this is a documentation/spec change (see
//      types.ts's GuaranteeMode doc comment and scq-v0.6.1-spec.md §1), not
//      a runtime-checkable behavior change, so it has no dedicated test
//      here beyond what Test 8a/8b/9a/11a-b already assert about EXACT
//      being scoped to specific dimensions (unchanged this cycle).
//   2. REVALIDATE clarifications: pre-mutation envelope check against the
//      LAST preview (unchanged mechanism, already covered by Test 6c/6d/
//      9d etc.); post-commit reconciliation (Test 12a-12c, NEW).
//   3. Quote expiration: commit after validUntil MUST fail QUOTE_EXPIRED
//      with no mutation (Test 12d-12e, NEW — direct unit test against
//      validateCommit with an injected clock, since QUOTE_TTL_MS is 5 real
//      minutes and no adapter currently allows injecting a fake wall clock).
//   4. Commit idempotency: repeated commit of an already-committed quote
//      returns the ORIGINAL receipt, no second mutation (Test 12f-12g, NEW,
//      exercised through the real Stripe/Paddle adapter APIs).
//   5. Conformance gaps closed: Test 7c extended to all four adapters (see
//      test7-toctou.test.ts); UNSUPPORTED_CHANGE_SET direct unit test
//      (Test 12h, NEW — this was conformance-suite gap G-3/spec U-6, since
//      no adapter's real call construction can currently trigger this path
//      end-to-end); Paddle multi-change positive/negative tests (Test
//      12i-12j, NEW — this was gap G-4).

test("Test 12a: post-commit reconciliation reports OK when the committed effect stays within the envelope", () => {
  const quoted = { immediate: { net: 1000 }, recurring: { resultingAmount: 5000, currency: "usd" } };
  const committed = { immediate: { net: 1000 }, recurring: { resultingAmount: 5000, currency: "usd" } };
  const result = reconcileCommittedEffect(quoted, committed, { maxImmediateNetIncrease: 0, maxImmediateCreditDecrease: 0, maxRecurringIncrease: 0 });
  assert.deepEqual(result, { status: "OK" });
});

test("Test 12b: post-commit reconciliation reports VIOLATED when the committed effect exceeds the envelope, and names why", () => {
  const quoted = { immediate: { net: 1000 }, recurring: { resultingAmount: 5000, currency: "usd" } };
  // Simulates the BEST_EFFORT race: a concurrent write landed after the
  // last pre-mutation preview, so what actually got committed exceeds what
  // was checked and approved before the mutating call.
  const committed = { immediate: { net: 50000 }, recurring: { resultingAmount: 5000, currency: "usd" } };
  const result = reconcileCommittedEffect(quoted, committed, { maxImmediateNetIncrease: 0, maxImmediateCreditDecrease: 0, maxRecurringIncrease: 0 });
  assert.equal(result.status, "VIOLATED");
  assert.ok((result as any).reason.includes("BEST_EFFORT"), "reconciliation failure reason must explain WHY this can happen despite the pre-mutation check having passed");
});

test("Test 12c: post-commit reconciliation reports OK (not a fabricated violation) when there is no envelope to check against (CANCEL-only REVALIDATE proposals)", () => {
  const quoted = { term: { createsCommitment: false } };
  const committed = { term: { createsCommitment: false } };
  const result = reconcileCommittedEffect(quoted, committed, undefined);
  assert.deepEqual(result, { status: "OK" }, "no envelope means nothing to reconcile — must not report VIOLATED with no basis");
});

test("Test 12d: commit after validUntil MUST fail QUOTE_EXPIRED with no mutation — direct unit test against validateCommit with an injected clock", () => {
  const store = new QuoteStore();
  const quoteId = "scq_test_expired_1";
  const createdAt = new Date("2026-08-01T00:00:00Z");
  const expiresAt = new Date(createdAt.getTime() + 5 * 60 * 1000); // 5-minute TTL, matching every adapter's QUOTE_TTL_MS
  const stored: StoredQuote = {
    quote_id: quoteId,
    provider: "stripe",
    subscription_id: "sub_x",
    subscription_version_at_quote: "fp_1",
    proposal: { changes: [{ action: "CHANGE_QUANTITY", itemId: "i_1", quantity: 120 }], effectiveIntent: { type: "IMMEDIATE" } },
    effective_guarantee_mode: "REVALIDATE",
    guarantee_coverage: { immediateFinancialEffect: "REVALIDATE", recurringFinancialEffect: "REVALIDATE", termEffect: "UNKNOWN", effectiveAt: "REVALIDATE" },
    multi_change_consistency: "ATOMIC",
    provider_preview_input: {},
    quoted_effect: {},
    created_at: createdAt.toISOString(),
    expires_at: expiresAt.toISOString(),
    status: "ACTIVE",
  };
  store.put(stored);

  // Commit attempted well AFTER validUntil (10 minutes past creation, 5
  // minutes past expiry) with the fingerprint UNCHANGED (isolating the
  // expiry check from the staleness check — this must fail on EXPIRY
  // specifically, not incidentally succeed past staleness first).
  const afterExpiry = () => new Date(createdAt.getTime() + 10 * 60 * 1000);

  assert.throws(
    () => validateCommit(store, quoteId, "fp_1", afterExpiry),
    (err: unknown) => {
      assert.ok(err instanceof SCQError);
      assert.equal(err.code, "QUOTE_EXPIRED");
      return true;
    }
  );

  // No mutation may occur — validateCommit itself performs none, and the
  // status transition to EXPIRED (not COMMITTED) is the only state change,
  // confirming no adapter reached a mutating call.
  assert.equal(store.get(quoteId)!.status, "EXPIRED");
});

test("Test 12e: commit strictly BEFORE validUntil succeeds the expiry check (contrast case — confirms Test 12d isn't vacuously true)", () => {
  const store = new QuoteStore();
  const quoteId = "scq_test_not_expired_1";
  const createdAt = new Date("2026-08-01T00:00:00Z");
  const expiresAt = new Date(createdAt.getTime() + 5 * 60 * 1000);
  const stored: StoredQuote = {
    quote_id: quoteId,
    provider: "stripe",
    subscription_id: "sub_x",
    subscription_version_at_quote: "fp_1",
    proposal: { changes: [{ action: "CANCEL" }], effectiveIntent: { type: "TERM_END" } },
    effective_guarantee_mode: "EXACT",
    guarantee_coverage: { immediateFinancialEffect: "EXACT", recurringFinancialEffect: "EXACT", termEffect: "EXACT", effectiveAt: "EXACT" },
    multi_change_consistency: "ATOMIC",
    provider_preview_input: {},
    quoted_effect: {},
    created_at: createdAt.toISOString(),
    expires_at: expiresAt.toISOString(),
    status: "ACTIVE",
  };
  store.put(stored);

  const beforeExpiry = () => new Date(createdAt.getTime() + 2 * 60 * 1000); // 2 minutes in, well under the 5-minute TTL
  const validated = validateCommit(store, quoteId, "fp_1", beforeExpiry);
  assert.equal(validated.quote_id, quoteId);
  assert.equal(store.get(quoteId)!.status, "ACTIVE", "validateCommit alone does not transition status to COMMITTED — that is the adapter's job after a successful mutation");
});

test("Test 12f (Stripe): repeated commit of an already-committed quote returns the ORIGINAL receipt and does not mutate a second time", async () => {
  const { sim, sub } = freshStripeFixture();
  const adapter = new StripeAdapter(sim, new QuoteStore());

  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [{ action: "CHANGE_QUANTITY", itemId: "si_1", quantity: 120 }],
    effectiveIntent: { type: "IMMEDIATE" },
    acceptanceEnvelope: { maxImmediateNetIncrease: 1_000_000, maxImmediateCreditDecrease: 1_000_000, maxRecurringIncrease: 1_000_000 },
  });

  const firstReceipt = await adapter.commitChangeQuote(quote.id);
  assert.equal(firstReceipt.resultingSnapshot.items[0].quantity, 120);

  // A second commit call against the SAME quote id — simulating a caller
  // retrying because e.g. a network response was lost after the first
  // commit actually succeeded provider-side.
  const secondReceipt = await adapter.commitChangeQuote(quote.id);
  assert.deepEqual(secondReceipt, firstReceipt, "repeated commit must return the EXACT original receipt, not a re-derived one");

  // Confirm no second mutation happened: quantity is still 120 (not, say,
  // 140 from an unintended double-apply), and Stripe's fingerprint is
  // unchanged from what the first commit produced.
  const after = await adapter.getSubscription(sub.id);
  assert.equal(after.items[0].quantity, 120, "the change was applied exactly once, not twice");
  assert.equal(after.version, firstReceipt.resultingSnapshot.version, "no second mutation occurred — fingerprint identical to right after the first commit");
});

test("Test 12g (Paddle): repeated commit is idempotent even when the underlying subscription drifts further out-of-band afterward", async () => {
  const { sim, sub } = freshPaddleFixture();
  const adapter = new PaddleAdapter(sim, new QuoteStore());
  const before = await adapter.getSubscription(sub.id);

  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [{ action: "CHANGE_QUANTITY", itemId: before.items[0].id, quantity: 120 }],
    effectiveIntent: { type: "IMMEDIATE" },
    acceptanceEnvelope: { maxImmediateNetIncrease: 1_000_000, maxImmediateCreditDecrease: 1_000_000, maxRecurringIncrease: 1_000_000 },
  });
  const firstReceipt = await adapter.commitChangeQuote(quote.id);

  // Out-of-band drift AFTER the successful commit — must have NO bearing on
  // whether a repeated commit of the SAME already-committed quote succeeds:
  // idempotent replay is checked and returns before any fingerprint
  // comparison against current live state.
  sim._debugMutateDirectly(sub.id, (s) => {
    s.items[0].quantity = 999;
  });

  const secondReceipt = await adapter.commitChangeQuote(quote.id);
  assert.deepEqual(secondReceipt, firstReceipt, "idempotent replay must succeed and return the original receipt even if the subscription has since drifted out-of-band — that drift is irrelevant to replaying an already-completed commit");

  const after = await adapter.getSubscription(sub.id);
  assert.equal(after.items[0].quantity, 999, "the out-of-band mutation IS visible on a fresh getSubscription call — idempotent replay does not touch or re-fetch live state at all");
});

test("Test 12h: UNSUPPORTED_CHANGE_SET — direct unit test against enforceNoPartialExecutionRisk in isolation", () => {
  // v0.6 left this path with NO test that actually triggers it end-to-end,
  // because no adapter's real call construction currently risks silent
  // partial application (each either bundles genuinely atomically or
  // refuses via multiChangeConsistency first) — see conformance.md gap G-3
  // / scq-v0.6-spec.md unresolved issue U-6. This direct unit test closes
  // that gap for the ENGINE-level enforcement primitive itself, without
  // requiring a synthetic provider built solely to expose the failure mode
  // (which the "do not add providers" scope for both v0.6 and v0.6.1
  // forecloses).
  const changes = [
    { action: "CHANGE_QUANTITY" as const, itemId: "i_1", quantity: 120 },
    { action: "CANCEL" as const },
  ];

  assert.throws(
    () => enforceNoPartialExecutionRisk(changes, true),
    (err: unknown) => {
      assert.ok(err instanceof SCQError);
      assert.equal(err.code, "UNSUPPORTED_CHANGE_SET");
      assert.ok(err.message.includes("CHANGE_QUANTITY+CANCEL"), "error must name the specific changes at risk");
      return true;
    }
  );

  // Contrast case in the same test: mayPartiallyApply=false must NOT throw
  // — confirms this isn't a blanket refusal, only a targeted one.
  assert.doesNotThrow(() => enforceNoPartialExecutionRisk(changes, false));
});

test("Test 12i (Paddle): multi-change proposal (CHANGE_QUANTITY + CHANGE_PLAN) is ATOMIC — closes conformance gap G-4 (no prior Paddle multi-change test existed)", async () => {
  const { sim, sub } = freshPaddleFixture();
  const adapter = new PaddleAdapter(sim, new QuoteStore());
  const before = await adapter.getSubscription(sub.id);

  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [
      { action: "CHANGE_QUANTITY", itemId: before.items[0].id, quantity: 120 },
      { action: "CHANGE_PLAN", itemId: before.items[0].id, offeringRef: "plan:pro:monthly" },
    ],
    effectiveIntent: { type: "IMMEDIATE" },
    acceptanceEnvelope: { maxImmediateNetIncrease: 1_000_000, maxImmediateCreditDecrease: 1_000_000, maxRecurringIncrease: 1_000_000 },
  });
  assert.equal(quote.multiChangeConsistency, "ATOMIC", "Paddle's items[] update parameter bundles multiple item changes in one call, same as Stripe/Chargebee");

  const receipt = await adapter.commitChangeQuote(quote.id);
  assert.equal(receipt.status, "COMMITTED");
  assert.equal(receipt.multiChangeConsistency, "ATOMIC");
  assert.equal(receipt.resultingSnapshot.items[0].quantity, 120, "the quantity change from the bundle applied");

  console.log("[Test 12i] Paddle multi-change (quantity+plan) committed atomically in one call — closes conformance gap G-4.");
});

test("Test 12j (Paddle): multi-change mixing CANCEL with CHANGE_QUANTITY is UNSUPPORTED — closes conformance gap G-4's negative half", async () => {
  const { sim, sub } = freshPaddleFixture();
  const adapter = new PaddleAdapter(sim, new QuoteStore());
  const before = await adapter.getSubscription(sub.id);

  await assert.rejects(
    () =>
      adapter.createChangeQuote(sub.id, {
        changes: [
          { action: "CHANGE_QUANTITY", itemId: before.items[0].id, quantity: 120 },
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

  const after = await adapter.getSubscription(sub.id);
  assert.equal(after.items[0].quantity, 100, "refused before any preview or mutating call — no partial application");

  console.log("[Test 12j] Paddle correctly refused CANCEL+CHANGE_QUANTITY bundling (separate endpoints), matching Stripe/Chargebee's limitation — closes conformance gap G-4.");
});

test("Test 12k: every REVALIDATE receipt across Stripe/Paddle carries a `reconciliation` field that is OK when no concurrent drift occurred", async () => {
  const stripe = freshStripeFixture();
  const stripeAdapter = new StripeAdapter(stripe.sim, new QuoteStore());
  const stripeQuote = await stripeAdapter.createChangeQuote(stripe.sub.id, {
    changes: [{ action: "CHANGE_QUANTITY", itemId: "si_1", quantity: 120 }],
    effectiveIntent: { type: "IMMEDIATE" },
    acceptanceEnvelope: { maxImmediateNetIncrease: 1_000_000, maxImmediateCreditDecrease: 1_000_000, maxRecurringIncrease: 1_000_000 },
  });
  const stripeReceipt = await stripeAdapter.commitChangeQuote(stripeQuote.id);
  assert.deepEqual(stripeReceipt.reconciliation, { status: "OK" });

  const paddle = freshPaddleFixture();
  const paddleAdapter = new PaddleAdapter(paddle.sim, new QuoteStore());
  const paddleBefore = await paddleAdapter.getSubscription(paddle.sub.id);
  const paddleQuote = await paddleAdapter.createChangeQuote(paddle.sub.id, {
    changes: [{ action: "CHANGE_QUANTITY", itemId: paddleBefore.items[0].id, quantity: 120 }],
    effectiveIntent: { type: "IMMEDIATE" },
    acceptanceEnvelope: { maxImmediateNetIncrease: 1_000_000, maxImmediateCreditDecrease: 1_000_000, maxRecurringIncrease: 1_000_000 },
  });
  const paddleReceipt = await paddleAdapter.commitChangeQuote(paddleQuote.id);
  assert.deepEqual(paddleReceipt.reconciliation, { status: "OK" });
});

test("Test 12l: EXACT-mode receipts also carry `reconciliation: OK` (nothing to reconcile, but the field is never omitted)", async () => {
  const { sim, sub } = freshStripeFixture();
  const adapter = new StripeAdapter(sim, new QuoteStore());
  const quote = await adapter.createChangeQuote(sub.id, { changes: [{ action: "CANCEL" }], effectiveIntent: { type: "TERM_END" }, guaranteeMode: "EXACT" });
  const receipt = await adapter.commitChangeQuote(quote.id);
  assert.deepEqual(receipt.reconciliation, { status: "OK" }, "EXACT/no-envelope case must still report OK, not omit the field or fabricate a violation");
});

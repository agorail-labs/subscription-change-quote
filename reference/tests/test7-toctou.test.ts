import { test } from "node:test";
import assert from "node:assert/strict";
import { QuoteStore } from "../src/store/quote-store.js";
import { StripeAdapter } from "../src/adapters/stripe-adapter.js";
import { PaddleAdapter } from "../src/adapters/paddle-adapter.js";
import { freshStripeFixture, freshPaddleFixture } from "./fixtures.js";

// v0.2 required test: does subscription state changing AFTER validation but
// BEFORE mutation cause a problem, and can either provider offer an atomic
// state-precondition + mutation to prevent it?
//
// Both adapters' commitChangeQuote() does:
//   1. read+fingerprint current state  (sim.fingerprint / sim.get)
//   2. compare to quote precondition   (validateCommit)
//   3. [REVALIDATE only: another read — re-preview]
//   4. mutate                          (sim.update / sim.cancel)
//
// Steps 1-2 (and 3, for REVALIDATE) are SEPARATE calls from step 4. Neither
// Stripe's `subscriptions.update` nor Paddle's `PATCH /subscriptions/{id}`
// accepts anything resembling an `If-Match` / compare-and-swap precondition
// that the SERVER enforces atomically against step 4's own mutation. This
// test proves the window exists by mutating the sim directly between steps
// — bypassing SCQ — timed so it lands after validateCommit's check but
// before the sim.update() call actually applies, using a monkey-patch on
// the sim's update method to inject the out-of-band write at exactly that
// point. This is the most faithful way to simulate the real race without
// adding any synchronization primitive of our own: we are not simulating
// atomicity, we are simulating its ABSENCE.

test("Test 7 (Stripe): TOCTOU — subscription mutated between validation and mutation call", async () => {
  const { sim, sub } = freshStripeFixture();
  const adapter = new StripeAdapter(sim, new QuoteStore());

  // v0.4 note: this was EXACT in v0.1-v0.3. Stripe's CHANGE_QUANTITY now
  // reports termEffect: UNKNOWN under the per-dimension split, so an
  // overall EXACT request is refused (see test8-capabilities.test.ts).
  // REVALIDATE is used instead — this test's point (the TOCTOU race
  // window) is independent of guarantee mode.
  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [{ action: "CHANGE_QUANTITY", itemId: "si_1", quantity: 120 }],
    effectiveIntent: { type: "IMMEDIATE" },
    acceptanceEnvelope: { maxImmediateNetIncrease: 1_000_000, maxImmediateCreditDecrease: 1_000_000, maxRecurringIncrease: 1_000_000 },
  });

  // Inject a concurrent out-of-band write that lands strictly between
  // validateCommit's fingerprint check (already happened above/inside
  // commitChangeQuote before update() runs) and the update() call itself.
  // We simulate the race by wrapping sim.update to perform the concurrent
  // mutation on its first invocation, before delegating to the real logic —
  // i.e. the concurrent writer "wins the race" to land inside the window.
  const realUpdate = sim.update.bind(sim);
  let injected = false;
  sim.update = ((...args: Parameters<typeof realUpdate>) => {
    if (!injected) {
      injected = true;
      // Concurrent actor (e.g. another agent, a support dashboard) changes
      // quantity out-of-band, AFTER SCQ already validated the fingerprint
      // but BEFORE SCQ's own mutation call executes.
      sim._debugMutateDirectly(sub.id, (s) => {
        s.items[0].quantity = 999;
      });
    }
    return realUpdate(...args);
  }) as typeof realUpdate;

  const receipt = await adapter.commitChangeQuote(quote.id);

  console.log(
    "[Test 7 / Stripe] TOCTOU: validateCommit's fingerprint check PASSED (no STALE error) because the " +
      "concurrent write happened AFTER that check ran. SCQ's own mutation call then proceeded and overwrote " +
      "whatever the concurrent writer set, landing at quantity", receipt.resultingSnapshot.items[0].quantity,
    "- neither the concurrent write NOR its effect on the base the proration should have been computed from " +
      "was ever detected by SCQ. This is not a bug in this prototype; it is what happens when a client-side " +
      "read-check-write is used against an API with no server-side compare-and-swap primitive."
  );

  // The mutation call itself is unconditional at the provider level once
  // issued — it always succeeds and always applies proposal's target
  // quantity (120), silently clobbering the concurrent writer's 999. This
  // is arguably WORSE than a detected conflict: the concurrent write is
  // not merely missed, it is destroyed without any signal to either actor.
  assert.equal(receipt.resultingSnapshot.items[0].quantity, 120, "SCQ's mutation silently overwrites the concurrent write; no conflict is ever surfaced");
  assert.equal(receipt.consistencyGuarantee, "BEST_EFFORT", "the race demonstrated above is exactly why this must never read ATOMIC");
});

test("Test 7 (Paddle): TOCTOU — same window, same silent-clobber outcome", async () => {
  const { sim, sub } = freshPaddleFixture();
  const adapter = new PaddleAdapter(sim, new QuoteStore());

  const before = await adapter.getSubscription(sub.id);
  // Paddle does not advertise EXACT for CHANGE_QUANTITY — REVALIDATE (the
  // v0.3 default) is used. Note this makes the window this test targets
  // slightly LATER in the call sequence than the Stripe/EXACT case: the
  // injected write below lands after REVALIDATE's re-preview call (which
  // runs first and is unaffected) but still strictly before the mutating
  // update() call, which is the window this test claims to exercise.
  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [{ action: "CHANGE_QUANTITY", itemId: before.items[0].id, quantity: 120 }],
    effectiveIntent: { type: "IMMEDIATE" },
    acceptanceEnvelope: { maxImmediateNetIncrease: 1_000_000, maxImmediateCreditDecrease: 1_000_000, maxRecurringIncrease: 1_000_000 },
  });

  const realUpdate = sim.update.bind(sim);
  let injected = false;
  sim.update = ((...args: Parameters<typeof realUpdate>) => {
    if (!injected) {
      injected = true;
      sim._debugMutateDirectly(sub.id, (s) => {
        s.items[0].quantity = 999;
      });
    }
    return realUpdate(...args);
  }) as typeof realUpdate;

  const receipt = await adapter.commitChangeQuote(quote.id);

  console.log(
    "[Test 7 / Paddle] Same finding as Stripe: PATCH /subscriptions/{id} has no If-Match/compare-and-swap " +
      "precondition parameter either, so the identical race exists (here landing after REVALIDATE's re-preview " +
      "but still before the mutating call). Result: quantity",
    receipt.resultingSnapshot.items[0].quantity, "— concurrent write silently clobbered."
  );
  assert.equal(receipt.resultingSnapshot.items[0].quantity, 120);
  assert.equal(receipt.consistencyGuarantee, "BEST_EFFORT", "the race demonstrated above is exactly why this must never read ATOMIC");
});

test("Test 7c: no adapter-local lock is used to hide the window (source-level check, all four adapters)", async () => {
  // This test exists to keep the finding honest over time: it asserts the
  // adapters contain no mutex/lock/semaphore construct that would make
  // Test 7's race artificial rather than representative of the real APIs.
  // If this test starts failing, someone added exactly the kind of
  // synchronization the research task said not to add.
  //
  // v0.6.1: extended from Stripe/Paddle-only to all FOUR adapters — this
  // was conformance-suite gap G-1 (see conformance.md), flagged in v0.6 as
  // an absence of an automated check for Zuora/Chargebee rather than any
  // known lock construct actually being present in either. Closing it here
  // makes that "no lock" claim mechanically verified for every provider
  // this research covers, not just asserted by manual read.
  //
  // This test compiles into dist/tests/*.js, so import.meta.url points at
  // dist/tests, not the tests/ source dir. Walk up to the project root
  // (two levels: dist/tests -> dist -> project root) and read the actual
  // .ts sources from src/, not whatever landed in dist/.
  const { readFile } = await import("node:fs/promises");
  const projectRoot = new URL("../../", import.meta.url);
  const adapterFiles = [
    "src/adapters/stripe-adapter.ts",
    "src/adapters/paddle-adapter.ts",
    "src/adapters/zuora-adapter.ts",
    "src/adapters/chargebee-adapter.ts",
  ];
  for (const file of adapterFiles) {
    const src = await readFile(new URL(file, projectRoot), "utf8");
    assert.doesNotMatch(src, /\bMutex\b|\bSemaphore\b|\.lock\(|AsyncLock|withLock/i, `${file} must not contain an adapter-local lock construct`);
  }
});

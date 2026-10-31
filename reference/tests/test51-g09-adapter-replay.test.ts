import { test } from "node:test";
import assert from "node:assert/strict";
import { QuoteStore } from "../src/store/quote-store.js";
import { ZuoraAdapter } from "../src/adapters/zuora-adapter.js";
import { ChargebeeAdapter } from "../src/adapters/chargebee-adapter.js";
import { freshZuoraFixture, freshChargebeeFixture } from "./fixtures.js";

// G-09 inherited conformance: replay through the PUBLIC adapter methods,
// not merely through QuoteStore's unit-level idempotency entry point.
// SIMULATED evidence ONLY; not a live-provider exactly-once claim.

test("Test 51.1: Zuora simulator adapter replays original receipt without a second order", async () => {
  const { sim, sub } = freshZuoraFixture();
  const adapter = new ZuoraAdapter(sim, new QuoteStore());

  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [{ action: "CHANGE_QUANTITY", itemId: "rpc_1", quantity: 120 }],
    effectiveIntent: { type: "IMMEDIATE" },
    guaranteeMode: "EXACT",
  });

  assert.equal(sim.ordersFor(sub.id).length, 0, "quote alone must not dispatch");
  const first = await adapter.commitChangeQuote(quote.id);
  assert.equal(first.status, "COMMITTED");
  assert.equal(sim.ordersFor(sub.id).length, 1, "initial commit dispatches one simulator order");
  const afterFirst = await adapter.getSubscription(sub.id);

  const replay = await adapter.commitChangeQuote(quote.id);
  assert.deepEqual(replay, first, "adapter replay must return the original recorded receipt");
  assert.equal(sim.ordersFor(sub.id).length, 1, "replay cannot create a second simulator order");
  assert.deepEqual(await adapter.getSubscription(sub.id), afterFirst, "replay has no state side effect");
});

test("Test 51.2: Chargebee simulator adapter replays original receipt without another update", async () => {
  const { sim, sub } = freshChargebeeFixture();
  const adapter = new ChargebeeAdapter(sim, new QuoteStore());

  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [{ action: "CHANGE_QUANTITY", itemId: "item_1", quantity: 120 }],
    effectiveIntent: { type: "IMMEDIATE" },
    acceptanceEnvelope: {
      maxImmediateNetIncrease: 1_000_000,
      maxImmediateCreditDecrease: 1_000_000,
      maxRecurringIncrease: 1_000_000,
    },
  });

  assert.equal(sim.mutationsFor(sub.id).length, 0, "quote alone must not update the simulator");
  const first = await adapter.commitChangeQuote(quote.id);
  assert.equal(first.status, "COMMITTED");
  assert.equal(sim.mutationsFor(sub.id).length, 1, "initial commit dispatches one update");
  const afterFirst = await adapter.getSubscription(sub.id);

  const replay = await adapter.commitChangeQuote(quote.id);
  assert.deepEqual(replay, first, "adapter replay must return the original recorded receipt");
  assert.equal(sim.mutationsFor(sub.id).length, 1, "replay cannot send another simulator update");
  assert.deepEqual(await adapter.getSubscription(sub.id), afterFirst, "replay has no state side effect");
});

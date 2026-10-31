import { test } from "node:test";
import assert from "node:assert/strict";
import { QuoteStore } from "../src/store/quote-store.js";
import { SCQError } from "../src/core/types.js";
import { ZuoraAdapter } from "../src/adapters/zuora-adapter.js";
import { freshZuoraFixture, freshZuoraCommittedTermFixture } from "./fixtures.js";

// G-09A (inherited conformance gap G-2): TERM_END refusal under EXACT.
//
// Normative requirement (spec/scq-v0.6.2-spec.md §3.4 + §6.4): an overall
// EXACT request MUST be refused — with UNSUPPORTED_CHANGE naming the
// failing dimension — BEFORE any preview or mutating call, for any
// change/action where the AUTHORITATIVE (quote-level) GuaranteeCoverage
// does not report EXACT on every one of its four dimensions.
//
// The exercisable combination: Zuora CANCEL with effectiveIntent TERM_END
// against a COMMITTED-term subscription. Zuora's financial dimensions and
// effectiveAt are EXACT for CANCEL, and TERM_END is a supported intent,
// but the quote-level termEffect resolves to UNKNOWN for a committed term
// (quoteLevelCancelTermCoverage — early-termination consequences may live
// outside the order), so termEffect is the ONLY failing dimension. The
// refusal half of this scenario is also pinned by test9e2; what this file
// adds is the missing proof that the refusal happens BEFORE ANY provider
// mutation: zero simulator orders and byte-identical subscription state.
//
// SIMULATED evidence only; no live provider is involved.

test("Test 52.1: EXACT CANCEL/TERM_END against a committed-term Zuora subscription is refused on termEffect with ZERO simulator mutations", async () => {
  const { sim, sub } = freshZuoraCommittedTermFixture();
  const adapter = new ZuoraAdapter(sim, new QuoteStore());

  const before = await adapter.getSubscription(sub.id);
  assert.equal(sim.ordersFor(sub.id).length, 0, "fixture starts with no orders");

  await assert.rejects(
    () =>
      adapter.createChangeQuote(sub.id, {
        changes: [{ action: "CANCEL" }],
        effectiveIntent: { type: "TERM_END" },
        guaranteeMode: "EXACT",
      }),
    (err: unknown) => {
      assert.ok(err instanceof SCQError);
      assert.equal(err.code, "UNSUPPORTED_CHANGE");
      assert.equal(
        (err as SCQError).details && (err as any).details.failingDimension,
        "termEffect",
        "the refusal must name termEffect — the only dimension not EXACT for this combination"
      );
      return true;
    }
  );

  assert.equal(sim.ordersFor(sub.id).length, 0, "refusal must occur before any mutating simulator call");
  assert.deepEqual(await adapter.getSubscription(sub.id), before, "refusal leaves subscription state untouched");
});

test("Test 52.2 (control): the same EXACT CANCEL/TERM_END proposal against an EVERGREEN Zuora subscription is accepted and its commit dispatches exactly one order", async () => {
  const { sim, sub } = freshZuoraFixture();
  const adapter = new ZuoraAdapter(sim, new QuoteStore());

  // Proves the 52.1 refusal is state-dependent (committed term), not a
  // blanket TERM_END or CANCEL refusal, and that the ordersFor probe does
  // observe mutations when they legitimately happen.
  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [{ action: "CANCEL" }],
    effectiveIntent: { type: "TERM_END" },
    guaranteeMode: "EXACT",
  });
  assert.equal(sim.ordersFor(sub.id).length, 0, "quote alone must not dispatch");

  const receipt = await adapter.commitChangeQuote(quote.id);
  assert.equal(receipt.status, "COMMITTED");
  assert.equal(sim.ordersFor(sub.id).length, 1, "the accepted control commit dispatches exactly one order");
});

test("Test 52.3 (control): REVALIDATE CANCEL/TERM_END against the committed-term subscription is NOT refused — the refusal is specific to the unbacked EXACT request", async () => {
  const { sim, sub } = freshZuoraCommittedTermFixture();
  const adapter = new ZuoraAdapter(sim, new QuoteStore());

  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [{ action: "CANCEL" }],
    effectiveIntent: { type: "TERM_END" },
    // guaranteeMode omitted: REVALIDATE default.
  });
  assert.equal(quote.guaranteeCoverage.termEffect, "UNKNOWN", "the quote honestly reports the unknowable term dimension");
  assert.equal(sim.ordersFor(sub.id).length, 0, "quote alone must not dispatch");
});

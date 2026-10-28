import { test } from "node:test";
import assert from "node:assert/strict";
import { QuoteStore } from "../src/store/quote-store.js";
import { StripeAdapter } from "../src/adapters/stripe-adapter.js";
import { StripeSim, type StripeSubscription } from "../src/adapters/stripe-sim.js";
import { determinacyOf } from "../src/core/scq-engine.js";
import { SCQError } from "../src/core/types.js";
import { freshStripeFixture } from "./fixtures.js";

// SCQ v0.6.2 — PR #10 final-review corrections (M1–M3) to the PR-3
// Stripe simulator migration. Everything runs against the in-memory
// Stripe simulator; all results are SIMULATED and every post-commit
// observation is a SYNTHETIC simulator observation (see test17's
// header for the establishment machinery's stated trust limit).
//
// M1 — multi-change quote correctness. Pre-fix, a multi-change
// quote ran SEQUENTIAL per-change previews against the ORIGINAL
// subscription and combined them: two changes to the SAME item
// double-counted the overlap (each preview measured its delta from
// the original state), and the aggregate recurring took the LAST
// preview's figure (missing earlier changes to other items). The
// commit side already folded (previewInput.items is the final item
// set), so quote and commit could disagree about the same proposal.
// Post-fix, the quote folds the proposal into the final item set
// first and derives the quoted effect from ONE preview of that set.
//
// M2 — UNKNOWN pre-mutation refusal, IN THE STRIPE ADAPTER. The
// frozen v0.6.1 envelope coerces absent figures to 0 (§14.6 pin),
// so a quote — or a commit-time revalidation — whose incurred
// figure is UNKNOWN could pass the gate and mutate: the adapter
// would commit a change whose financial effect it does not know.
// BC-1's fail-closed envelope is PR-9's separate activation and
// the shared engine is NOT touched here; instead the Stripe
// adapter refuses such commits itself, before any mutation call,
// with QUOTE_NOT_DETERMINISTIC. A licensed NOT_APPLICABLE (CANCEL
// immediate, §3.10) is not refused.
//
// M3 — invoice identity binding. Pre-fix, post-commit verification
// read the subscription's `latest_invoice`, which a later/concurrent
// mutation may have replaced — an unrelated invoice's figures could
// be attributed to this commit. Post-fix, verification binds to the
// invoice ID THIS mutation generated and reads that invoice alone
// for financial actuals; the subscription re-read serves item-set /
// state verification only.

const GENEROUS_ENVELOPE = {
  maxImmediateNetIncrease: 1_000_000,
  maxImmediateCreditDecrease: 1_000_000,
  maxRecurringIncrease: 1_000_000,
};

const ZERO_TOLERANCE_ENVELOPE = {
  maxImmediateNetIncrease: 0,
  maxImmediateCreditDecrease: 0,
  maxRecurringIncrease: 0,
};

/** Two-item subscription: si_1 basic @1000 qty 100; si_2 pro @1500 qty 10; period starts "now" (full period remaining). */
function twoItemFixture(): { sim: StripeSim; sub: StripeSubscription } {
  const sim = new StripeSim(Math.floor(new Date("2026-08-01T00:00:00Z").getTime() / 1000));
  const start = sim.currentTime();
  const sub: StripeSubscription = {
    id: "sub_two_item",
    status: "active",
    items: [
      { id: "si_1", price: { id: "price_seat_basic", unitAmount: 1000, currency: "usd", interval: "month" }, quantity: 100 },
      { id: "si_2", price: { id: "price_seat_pro", unitAmount: 1500, currency: "usd", interval: "month" }, quantity: 10 },
    ],
    current_period_start: start,
    current_period_end: start + 30 * 24 * 3600,
    cancel_at_period_end: false,
  };
  sim.seedSubscription(sub);
  return { sim, sub };
}

/** Counts mutating sim calls (update + cancel) — the M2 "no mutation occurred" mechanism, alongside a state fingerprint comparison. */
function countMutations(sim: StripeSim): { update: number; cancel: number } {
  const counts = { update: 0, cancel: 0 };
  const realUpdate = sim.update.bind(sim);
  sim.update = ((...args: Parameters<typeof realUpdate>) => {
    counts.update++;
    return realUpdate(...args);
  }) as typeof realUpdate;
  const realCancel = sim.cancel.bind(sim);
  sim.cancel = ((...args: Parameters<typeof realCancel>) => {
    counts.cancel++;
    return realCancel(...args);
  }) as typeof realCancel;
  return counts;
}

const isNotDeterministic = (err: unknown): boolean => err instanceof SCQError && err.code === "QUOTE_NOT_DETERMINISTIC";

// ---------------------------------------------------------------------------
// M1 — multi-change quotes derive from ONE preview of the folded set
// ---------------------------------------------------------------------------

test("Test 18.1 (M1): same-item overlap — two quantity changes to the SAME item quote the folded result, not the sum of sequential previews", async () => {
  // si_1: 100 -> 120 -> 150, quoted at period start (fraction 1.0).
  // Folded truth: incurred = (150-100) x 1000 = 50000; recurring 150000.
  // Pre-fix sequential previews measured EACH delta from the original
  // 100 (20000 and 50000) and summed them: 70000 — the overlap counted
  // twice.
  const { sim, sub } = freshStripeFixture();
  const adapter = new StripeAdapter(sim, new QuoteStore());

  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [
      { action: "CHANGE_QUANTITY", itemId: "si_1", quantity: 120 },
      { action: "CHANGE_QUANTITY", itemId: "si_1", quantity: 150 },
    ],
    effectiveIntent: { type: "IMMEDIATE" },
    guaranteeMode: "REVALIDATE",
    acceptanceEnvelope: ZERO_TOLERANCE_ENVELOPE,
  });
  assert.equal(quote.commercialEffect.immediate?.net, 50000, "quoted incurred is the folded (150-100) delta — not 20000+50000");
  assert.equal(quote.commercialEffect.recurring?.resultingAmount, 150000);
  assert.deepEqual(determinacyOf(quote.commercialEffect), {
    immediateFinancialEffect: "DETERMINED",
    recurringFinancialEffect: "DETERMINED",
  });
  // The folded quote has ONE invoice estimate (the folded preview's),
  // not per-change estimates.
  const md = quote.providerMetadata as { nextInvoiceEstimate?: { amountDue: number }; changeInvoiceEstimates?: unknown };
  assert.equal(md.nextInvoiceEstimate?.amountDue, 50000, "one folded next-invoice estimate");
  assert.equal(md.changeInvoiceEstimates, undefined, "no per-change estimate list remains");

  // Zero-tolerance acceptance: the commit-time revalidation sees the
  // same folded set, and the committed actuals equal the quote.
  const receipt = await adapter.commitChangeQuote(quote.id);
  assert.equal(receipt.status, "COMMITTED");
  assert.equal(receipt.reconciliation.status, "OK");
  assert.equal(receipt.committedEffect.immediate?.net, 50000, "committed incurred equals the folded quote");
  assert.equal(receipt.committedEffect.recurring?.resultingAmount, 150000);
  assert.equal(receipt.resultingSnapshot.items[0].quantity, 150);
});

test("Test 18.2 (M1): different items — the quoted recurring includes BOTH changes, not just the last preview's", async () => {
  // si_1 qty 100->120 (+20000 incurred; recurring 120000) and si_2
  // plan pro->basic ((1000-1500) x 10 = -5000 incurred; recurring
  // 10000). Folded truth: incurred 15000; recurring 130000.
  // Pre-fix, the aggregate recurring was the LAST per-change
  // preview's: si_1 still at its ORIGINAL quantity there, giving
  // 100000 + 10000 = 110000 — si_1's change silently dropped.
  const { sim, sub } = twoItemFixture();
  const adapter = new StripeAdapter(sim, new QuoteStore());

  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [
      { action: "CHANGE_QUANTITY", itemId: "si_1", quantity: 120 },
      { action: "CHANGE_PLAN", itemId: "si_2", offeringRef: "plan:basic:monthly" },
    ],
    effectiveIntent: { type: "IMMEDIATE" },
    guaranteeMode: "REVALIDATE",
    acceptanceEnvelope: ZERO_TOLERANCE_ENVELOPE,
  });
  assert.equal(quote.commercialEffect.immediate?.net, 15000, "folded incurred: +20000 (seats) - 5000 (downgrade)");
  assert.equal(quote.commercialEffect.recurring?.resultingAmount, 130000, "folded recurring counts BOTH items' changes");

  const receipt = await adapter.commitChangeQuote(quote.id);
  assert.equal(receipt.status, "COMMITTED");
  assert.equal(receipt.reconciliation.status, "OK");
  assert.equal(receipt.committedEffect.immediate?.net, 15000);
  assert.equal(receipt.committedEffect.recurring?.resultingAmount, 130000);
});

test("Test 18.3 (M1 control): a single-change quote is unchanged by the fold", async () => {
  const { sim, sub } = freshStripeFixture();
  const adapter = new StripeAdapter(sim, new QuoteStore());
  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [{ action: "CHANGE_QUANTITY", itemId: "si_1", quantity: 120 }],
    effectiveIntent: { type: "IMMEDIATE" },
    guaranteeMode: "REVALIDATE",
    acceptanceEnvelope: GENEROUS_ENVELOPE,
  });
  assert.equal(quote.commercialEffect.immediate?.net, 20000);
  assert.equal(quote.commercialEffect.recurring?.resultingAmount, 120000);
  const md = quote.providerMetadata as { nextInvoiceEstimate?: { amountDue: number } };
  assert.equal(md.nextInvoiceEstimate?.amountDue, 20000);
});

// ---------------------------------------------------------------------------
// M2 — UNKNOWN financial effect refuses the commit BEFORE any mutation
// ---------------------------------------------------------------------------

test("Test 18.4 (M2): a quote whose incurred figure is UNKNOWN is refused at commit — zero mutation calls, state untouched", async () => {
  const { sim, sub } = freshStripeFixture();
  const store = new QuoteStore();
  const adapter = new StripeAdapter(sim, store);

  // Quote while previews withhold the incurred figure: the quote's
  // immediate dimension is UNKNOWN (test 17.4's shape).
  sim._debugOmitIncurredAmount = true;
  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [{ action: "CHANGE_QUANTITY", itemId: "si_1", quantity: 120 }],
    effectiveIntent: { type: "IMMEDIATE" },
    guaranteeMode: "REVALIDATE",
    acceptanceEnvelope: GENEROUS_ENVELOPE,
  });
  assert.equal(determinacyOf(quote.commercialEffect).immediateFinancialEffect, "UNKNOWN");
  // Restore full previews, so a commit-time REVALIDATION would see a
  // DETERMINED figure (20000, inside the generous envelope even
  // against the coerced 0 baseline). Only the adapter's determinacy
  // refusal on the QUOTED effect can stop this commit — pre-fix it
  // proceeded and mutated.
  sim._debugOmitIncurredAmount = false;

  const mutations = countMutations(sim);
  const fingerprintBefore = sim.fingerprint(sub.id);
  await assert.rejects(() => adapter.commitChangeQuote(quote.id), isNotDeterministic);
  assert.equal(mutations.update, 0, "no update() call was made");
  assert.equal(mutations.cancel, 0, "no cancel() call was made");
  assert.equal(sim.fingerprint(sub.id), fingerprintBefore, "subscription state is byte-identical");
  assert.equal(sim.retrieve(sub.id).items[0].quantity, 100);
  const stored = store.get(quote.id)!;
  assert.equal(stored.status, "ACTIVE", "the refusal records no receipt and no outcome — it is a clean pre-mutation refusal");
  assert.equal(stored.commit_receipt, undefined);
  assert.equal(stored.commit_outcome, undefined);
});

test("Test 18.5 (M2): a revalidation whose incurred figure is UNKNOWN is refused BEFORE mutation (REVALIDATE path)", async () => {
  const { sim, sub } = freshStripeFixture();
  const adapter = new StripeAdapter(sim, new QuoteStore());
  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [{ action: "CHANGE_QUANTITY", itemId: "si_1", quantity: 120 }],
    effectiveIntent: { type: "IMMEDIATE" },
    guaranteeMode: "REVALIDATE",
    acceptanceEnvelope: GENEROUS_ENVELOPE,
  });
  assert.equal(determinacyOf(quote.commercialEffect).immediateFinancialEffect, "DETERMINED");

  // The quote was fine; the commit-time re-preview now withholds its
  // incurred figure. Under the frozen v0.6.1 envelope the absent
  // revalidated net coerces to 0 — a 20000 "credit decrease" well
  // inside the generous envelope — so pre-fix this commit MUTATED
  // against an effect it did not know.
  sim._debugOmitIncurredAmount = true;
  const mutations = countMutations(sim);
  const fingerprintBefore = sim.fingerprint(sub.id);
  await assert.rejects(() => adapter.commitChangeQuote(quote.id), isNotDeterministic);
  assert.equal(mutations.update, 0, "the refusal precedes the mutation call");
  assert.equal(sim.fingerprint(sub.id), fingerprintBefore);
  assert.equal(sim.retrieve(sub.id).items[0].quantity, 100);
});

test("Test 18.6 (M2 controls): a DETERMINED commit proceeds, and a licensed NOT_APPLICABLE CANCEL commit is NOT refused", async () => {
  const { sim, sub } = freshStripeFixture();
  const adapter = new StripeAdapter(sim, new QuoteStore());
  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [{ action: "CHANGE_QUANTITY", itemId: "si_1", quantity: 120 }],
    effectiveIntent: { type: "IMMEDIATE" },
    guaranteeMode: "REVALIDATE",
    acceptanceEnvelope: GENEROUS_ENVELOPE,
  });
  const receipt = await adapter.commitChangeQuote(quote.id);
  assert.equal(receipt.status, "COMMITTED");
  assert.equal(receipt.committedEffect.immediate?.net, 20000);

  // CANCEL: immediate is NOT_APPLICABLE under the §3.10 license
  // (cited). The determinacy refusal must not block it.
  const f2 = freshStripeFixture();
  const adapter2 = new StripeAdapter(f2.sim, new QuoteStore());
  const cancelQuote = await adapter2.createChangeQuote(f2.sub.id, {
    changes: [{ action: "CANCEL" }],
    effectiveIntent: { type: "TERM_END" },
  });
  assert.equal(determinacyOf(cancelQuote.commercialEffect).immediateFinancialEffect, "NOT_APPLICABLE");
  const cancelReceipt = await adapter2.commitChangeQuote(cancelQuote.id);
  assert.equal(cancelReceipt.status, "COMMITTED");
  assert.equal(cancelReceipt.resultingSnapshot.term?.autoRenew, false);
});

// ---------------------------------------------------------------------------
// M3 — verification binds to THIS mutation's invoice, by id
// ---------------------------------------------------------------------------

test("Test 18.7 (M3): the normal path reads back the invoice THIS mutation generated — bound by id and recorded in the committed provenance", async () => {
  const { sim, sub } = freshStripeFixture();
  const adapter = new StripeAdapter(sim, new QuoteStore());
  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [{ action: "CHANGE_QUANTITY", itemId: "si_1", quantity: 120 }],
    effectiveIntent: { type: "IMMEDIATE" },
    guaranteeMode: "REVALIDATE",
    acceptanceEnvelope: GENEROUS_ENVELOPE,
  });

  let mutationInvoiceId: string | undefined;
  const realUpdate = sim.update.bind(sim);
  sim.update = ((...args: Parameters<typeof realUpdate>) => {
    const result = realUpdate(...args);
    mutationInvoiceId = result.invoice.id;
    return result;
  }) as typeof realUpdate;
  const invoiceReads: string[] = [];
  const realRetrieveInvoice = sim.retrieveInvoice.bind(sim);
  sim.retrieveInvoice = ((id: string) => {
    invoiceReads.push(id);
    return realRetrieveInvoice(id);
  }) as typeof realRetrieveInvoice;

  const receipt = await adapter.commitChangeQuote(quote.id);
  assert.equal(receipt.status, "COMMITTED");
  assert.equal(receipt.committedEffect.immediate?.net, 20000);
  assert.ok(mutationInvoiceId, "the mutation returned its generated invoice");
  assert.deepEqual(invoiceReads, [mutationInvoiceId], "the only post-commit invoice read is the mutation's own invoice, by id");
  assert.ok(
    receipt.committedEffect.provenance?.immediate?.includes(mutationInvoiceId!),
    "the bound invoice id is recorded in the committed effect's immediate provenance"
  );
});

test("Test 18.8 (M3): a concurrent update landing before verification never lends its invoice to this commit — bound figures + state MISMATCH", async () => {
  // Commit A: qty 100 -> 120 at period start; A's invoice incurred
  // is 20000. In the window AFTER A's mutation returns but BEFORE
  // A's post-commit read (the test17.9 wrapping pattern), a
  // concurrent actor B updates the same subscription 120 -> 150,
  // generating invoice B (incurred (150-120) x 1000 = 30000) and
  // moving latest_invoice to B. Pre-fix, A's verification read
  // latest_invoice — B's invoice — and attributed 30000 to A.
  const { sim, sub } = freshStripeFixture();
  const adapter = new StripeAdapter(sim, new QuoteStore());
  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [{ action: "CHANGE_QUANTITY", itemId: "si_1", quantity: 120 }],
    effectiveIntent: { type: "IMMEDIATE" },
    guaranteeMode: "REVALIDATE",
    acceptanceEnvelope: GENEROUS_ENVELOPE,
  });

  let aInvoiceId: string | undefined;
  let bInvoiceId: string | undefined;
  const invoiceReads: string[] = [];
  const realRetrieveInvoice = sim.retrieveInvoice.bind(sim);
  sim.retrieveInvoice = ((id: string) => {
    invoiceReads.push(id);
    return realRetrieveInvoice(id);
  }) as typeof realRetrieveInvoice;
  const realUpdate = sim.update.bind(sim);
  let interleaved = false;
  sim.update = ((...args: Parameters<typeof realUpdate>) => {
    const result = realUpdate(...args);
    if (!interleaved) {
      interleaved = true;
      aInvoiceId = result.invoice.id;
      const b = realUpdate(sub.id, [{ id: "si_1", price: "price_seat_basic", quantity: 150 }], "create_prorations");
      bInvoiceId = b.invoice.id;
      assert.equal(b.invoice.incurred_amount, 30000, "fixture check: B's invoice is a DIFFERENT figure from A's");
      assert.equal(sim.retrieve(sub.id).latest_invoice, bInvoiceId, "fixture check: latest_invoice now points at B");
    }
    return result;
  }) as typeof realUpdate;

  const receipt = await adapter.commitChangeQuote(quote.id);
  assert.ok(aInvoiceId && bInvoiceId && aInvoiceId !== bInvoiceId);
  assert.deepEqual(invoiceReads, [aInvoiceId], "verification read A's bound invoice only — never B's");
  assert.equal(receipt.committedEffect.immediate?.net, 20000, "A's committed incurred is A's invoice figure, not B's 30000");
  assert.ok(receipt.committedEffect.provenance?.immediate?.includes(aInvoiceId!), "the receipt binds A's invoice id");
  // The observed state (qty 150) contradicts A's intent (120): a
  // determined MISMATCH — VIOLATED on a verified-class receipt (D3),
  // with the observed recurring honestly reported.
  assert.equal(receipt.status, "COMMITTED");
  assert.equal(receipt.reconciliation.status, "VIOLATED");
  assert.ok(receipt.reconciliation.status === "VIOLATED" && /mismatch/i.test(receipt.reconciliation.reason));
  assert.equal(receipt.committedEffect.recurring?.resultingAmount, 150000, "observed state reported as observed — B's landing is not hidden");
});

test("Test 18.9 (M3): an intervening invoice with state still matching intent is UNVERIFIED — the observed state cannot be attributed to this commit alone", async () => {
  // Two items. A changes si_1 only (100 -> 120, incurred 20000).
  // Concurrent B changes si_2 only (10 -> 20, B invoice incurred
  // (20-10) x 1500 = 15000) in the same post-mutation window. A's
  // intent is intact in the observed state (si_1 = 120), so there
  // is no MISMATCH — but latest_invoice moved to B, so the
  // post-commit state was NOT produced by A alone and the commit
  // must not be reported as verified against it. Pre-fix, A's
  // verification read B's invoice: immediate 15000, state
  // "VERIFIED", COMMITTED/OK — B's figures attributed to A.
  const { sim, sub } = twoItemFixture();
  const adapter = new StripeAdapter(sim, new QuoteStore());
  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [{ action: "CHANGE_QUANTITY", itemId: "si_1", quantity: 120 }],
    effectiveIntent: { type: "IMMEDIATE" },
    guaranteeMode: "REVALIDATE",
    acceptanceEnvelope: GENEROUS_ENVELOPE,
  });

  let aInvoiceId: string | undefined;
  const realUpdate = sim.update.bind(sim);
  let interleaved = false;
  sim.update = ((...args: Parameters<typeof realUpdate>) => {
    const result = realUpdate(...args);
    if (!interleaved) {
      interleaved = true;
      aInvoiceId = result.invoice.id;
      const b = realUpdate(sub.id, [{ id: "si_2", price: "price_seat_pro", quantity: 20 }], "create_prorations");
      assert.equal(b.invoice.incurred_amount, 15000, "fixture check: B's invoice differs from A's");
    }
    return result;
  }) as typeof realUpdate;

  const receipt = await adapter.commitChangeQuote(quote.id);
  assert.equal(receipt.status, "COMMITTED_UNVERIFIED", "landing established, attribution not — never reported as verified");
  assert.equal(receipt.outcome, "COMMITTED_UNVERIFIED");
  assert.equal(receipt.reconciliation.status, "UNVERIFIED");
  assert.ok(
    receipt.reconciliation.status === "UNVERIFIED" && /concurrent|intervening|latest_invoice/i.test(receipt.reconciliation.reason),
    "the reason names the intervening mutation"
  );
  assert.equal(receipt.committedEffect.immediate?.net, 20000, "the recorded immediate is A's bound invoice figure — not B's 15000");
  assert.ok(receipt.committedEffect.provenance?.immediate?.includes(aInvoiceId!), "the receipt binds A's invoice id");
});

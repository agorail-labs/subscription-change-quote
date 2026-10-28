import { test } from "node:test";
import assert from "node:assert/strict";
import { QuoteStore, establishVerification } from "../src/store/quote-store.js";
import { PaddleAdapter } from "../src/adapters/paddle-adapter.js";
import { PaddleSim, type PaddleSubscription } from "../src/adapters/paddle-sim.js";
import { auditDeterminacy, determinacyOf } from "../src/core/scq-engine.js";
import { SCQError, type CommercialEffect } from "../src/core/types.js";
import { freshPaddleFixture } from "./fixtures.js";

// SCQ v0.6.2 — PR-4: Paddle SIMULATOR migration conformance tests.
//
// Everything in this file runs against the in-memory Paddle
// simulator (PaddleSim). All results are SIMULATED — no live Paddle
// API is involved, and nothing here is evidence about real Paddle
// behavior. Post-commit "observations" constructed in these tests
// from simulator reads are SYNTHETIC simulator observations: they
// exercise the PR-1 establishment machinery's shape, and the
// branded evidence token is never treated as proof that an
// observation genuinely came from a provider (see
// establishVerification's own statement of that limit in
// quote-store.ts).
//
// The migration contract under test (issue #7 / v0.6.2 design
// Topics 1–5, adapter migration matrix — Paddle row), applying the
// three PR #10 correction principles from the start:
//   M1 — multi-change quotes fold into the final item set and
//        derive from ONE preview of that set (the pre-migration
//        per-change previews each measured their delta against the
//        ORIGINAL subscription and summed them — double-counting
//        overlapping changes — and combineEffects dropped a net
//        zero into absence, finding F-2).
//   M2 — the adapter refuses, before any mutation, a commit whose
//        quoted or revalidated effect is not determinate
//        (QUOTE_NOT_DETERMINISTIC). BC-1's fail-closed envelope is
//        a separate, later activation; the shared engine — and its
//        v0.6.1 absent-value coercion, pinned by test14 §14.6 — is
//        NOT changed here.
//   M3 — post-commit verification binds to the TRANSACTION this
//        mutation generated, read back by id; never to an
//        unqualified latest-transaction pointer, and never to the
//        pre-mutation revalidated preview (the pre-migration code
//        assigned committedEffect = revalidated BEFORE mutating —
//        finding F-1 — so reconciliation shared the preview's
//        provenance and could not detect a wrong landing).
// Paddle-specific semantics (verified against paddle-sim.ts):
//   - The sim's immediate transaction, in `prorated_immediately`
//     mode, is the change's prorated delta. A NULL immediate
//     transaction occurs iff that amount is exactly 0 (finding
//     F-3) — an established zero, neither not-applicable nor
//     unknown. The migrated sim splits the transaction figure into
//     its INCURRED component (the obligation the change creates)
//     and its PAYMENT total (incurred minus pre-existing customer
//     credits applied); only the incurred component may enter
//     `immediate` (§3.11) — the payment total lives, labeled, in
//     providerMetadata.
//   - TERM_END cancellation is verified as SCHEDULED (the F3
//     kind): the scheduled change record, its effective date at
//     the period boundary, and the still-active subscription are
//     read back after the mutation. The post-cancellation
//     recurring obligation is 0 once effective — never the
//     still-active current price relabeled.

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

/** Standard fixture plus a pre-existing customer credit balance (minor units). */
function paddleWithBalance(creditBalance: number): { sim: PaddleSim; sub: PaddleSubscription } {
  const { sim, sub } = freshPaddleFixture();
  sub.creditBalance = creditBalance;
  sim.seedSubscription(sub);
  return { sim, sub };
}

/** Two-item subscription: item_0 basic @1000 qty 100; item_1 pro @1500 qty 10; 30-day period starting "now". */
function twoItemFixture(): { sim: PaddleSim; sub: PaddleSubscription } {
  const now = new Date("2026-08-01T00:00:00Z");
  const periodEnd = new Date(now.getTime() + 30 * 24 * 3600 * 1000);
  const sim = new PaddleSim(now);
  const sub: PaddleSubscription = {
    id: "sub_paddle_two_item",
    status: "active",
    items: [
      { price: { id: "pri_seat_basic", unitAmount: 1000, currencyCode: "USD", interval: "month" }, quantity: 100 },
      { price: { id: "pri_seat_pro", unitAmount: 1500, currencyCode: "USD", interval: "month" }, quantity: 10 },
    ],
    currencyCode: "USD",
    billingCycle: { interval: "month", frequency: 1 },
    currentBillingPeriod: { startsAt: now.toISOString(), endsAt: periodEnd.toISOString() },
    nextBilledAt: periodEnd.toISOString(),
    scheduledChange: null,
  };
  sim.seedSubscription(sub);
  return { sim, sub };
}

type NextTransactionEstimate = {
  immediateTransactionTotal: number;
  creditBalanceApplied: number;
  incurredAmount?: number;
  nextTransactionAmount: number;
};

function nextTransactionEstimate(quote: { providerMetadata?: unknown }): NextTransactionEstimate {
  const md = quote.providerMetadata as { nextTransactionEstimate?: NextTransactionEstimate };
  assert.ok(md?.nextTransactionEstimate, "quote providerMetadata must carry a labeled nextTransactionEstimate");
  return md.nextTransactionEstimate;
}

/** Counts mutating sim calls (update + cancel) — the M2 "no mutation occurred" mechanism. */
function countMutations(sim: PaddleSim): { update: number; cancel: number } {
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
// Family 1: determined zero versus unknown (finding F-3)
// ---------------------------------------------------------------------------

test("Test 19.1 (family 1): a null immediate transaction under prorated_immediately is a DETERMINED zero — present, numeric, and committable", async () => {
  const { sim, sub } = freshPaddleFixture();
  const store = new QuoteStore();
  const adapter = new PaddleAdapter(sim, store);
  const before = await adapter.getSubscription(sub.id);

  // Quantity "change" to the same quantity: the change incurs
  // exactly nothing. The sim's preview returns NO immediate
  // transaction, which in this mode occurs iff the incurred amount
  // is exactly 0 (F-3) — the adapter reports a present determined
  // zero, NOT an absent figure, NOT not-applicable, NOT unknown.
  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [{ action: "CHANGE_QUANTITY", itemId: before.items[0].id, quantity: 100 }],
    effectiveIntent: { type: "IMMEDIATE" },
    acceptanceEnvelope: GENEROUS_ENVELOPE,
  });
  assert.ok(quote.commercialEffect.immediate, "a determined zero immediate must be PRESENT (CORE-1 purity; the v0.6.1 zero-drop is a conformance bug)");
  assert.equal(quote.commercialEffect.immediate?.net, 0);
  assert.equal(determinacyOf(quote.commercialEffect).immediateFinancialEffect, "DETERMINED");
  const audit = auditDeterminacy(quote.commercialEffect, quote.commercialEffect, "CHANGE_QUANTITY");
  assert.ok(audit.every((e) => e.findings.length === 0), JSON.stringify(audit));

  const receipt = await adapter.commitChangeQuote(quote.id);
  assert.equal(receipt.status, "COMMITTED");
  assert.equal(receipt.outcome, "COMMITTED_AND_VERIFIED");
  assert.equal(receipt.committedEffect.immediate?.net, 0, "the committed zero is established from the bound transaction read back post-commit");
  assert.equal(receipt.committedEffect.provenance?.committedSource, "provider_actual");
});

test("Test 19.1b (family 1): a preview that omits the immediate figure entirely yields UNKNOWN — never a fabricated zero", async () => {
  const { sim, sub } = freshPaddleFixture();
  sim._debugOmitImmediateTransaction = true; // fault injection: the preview cannot establish the incurred amount
  const adapter = new PaddleAdapter(sim, new QuoteStore());
  const before = await adapter.getSubscription(sub.id);

  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [{ action: "CHANGE_QUANTITY", itemId: before.items[0].id, quantity: 120 }],
    effectiveIntent: { type: "IMMEDIATE" },
    acceptanceEnvelope: GENEROUS_ENVELOPE,
  });
  assert.equal(quote.commercialEffect.immediate, undefined, "an unestablishable immediate is ABSENT — never zero-filled");
  assert.deepEqual(determinacyOf(quote.commercialEffect), {
    immediateFinancialEffect: "UNKNOWN",
    recurringFinancialEffect: "DETERMINED",
  });
  const audit = auditDeterminacy(quote.commercialEffect, quote.commercialEffect, "CHANGE_QUANTITY");
  assert.deepEqual(audit.find((e) => e.dimension === "immediateFinancialEffect")?.findings, ["WOULD_REFUSE_UNKNOWN"]);
});

// ---------------------------------------------------------------------------
// Family 2: incurred obligation versus transaction/payment amount
// ---------------------------------------------------------------------------

test("Test 19.2 (family 2): pre-existing credits move the transaction total only — immediate carries the incurred obligation", async () => {
  // Worked example: 100 seats @ 1000, quoted at period start (full
  // period remaining), quantity 100 -> 120. Incurred obligation =
  // 20 x 1000 x 1.0 = 20000. A pre-existing credit balance of 5000
  // is applied to the immediate transaction, so the transaction's
  // PAYMENT total is 15000. The incurred obligation is 20000
  // regardless of the credits.
  const { sim, sub } = paddleWithBalance(5000);
  const adapter = new PaddleAdapter(sim, new QuoteStore());
  const before = await adapter.getSubscription(sub.id);

  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [{ action: "CHANGE_QUANTITY", itemId: before.items[0].id, quantity: 120 }],
    effectiveIntent: { type: "IMMEDIATE" },
    acceptanceEnvelope: GENEROUS_ENVELOPE,
  });
  assert.equal(quote.commercialEffect.immediate?.net, 20000, "immediate.net is the incurred obligation — not the transaction's payment total");
  assert.equal(quote.commercialEffect.immediate?.charge, 20000);
  assert.equal(quote.commercialEffect.recurring?.resultingAmount, 120000);

  const estimate = nextTransactionEstimate(quote);
  assert.equal(estimate.immediateTransactionTotal, 15000, "the transaction total (incurred minus applied credits) is metadata only");
  assert.equal(estimate.creditBalanceApplied, 5000);
  assert.equal(estimate.incurredAmount, 20000);
  assert.equal(estimate.nextTransactionAmount, 120000, "next-transaction totals stay in metadata, out of the effect");
  assert.deepEqual(determinacyOf(quote.commercialEffect), {
    immediateFinancialEffect: "DETERMINED",
    recurringFinancialEffect: "DETERMINED",
  });

  // The commit's actuals come from the bound transaction read back
  // post-commit: its incurred component (20000) is the committed
  // immediate; its payment total (15000) never enters the effect.
  const receipt = await adapter.commitChangeQuote(quote.id);
  assert.equal(receipt.committedEffect.immediate?.net, 20000);
  assert.equal(receipt.committedEffect.provenance?.committedSource, "provider_actual");
  const boundId = sim.latestTransactionId(sub.id)!;
  const boundTxn = sim.retrieveTransaction(boundId);
  assert.equal(boundTxn.incurredAmount, 20000);
  assert.equal(boundTxn.total, 15000, "the persisted transaction keeps the payment total distinct from the incurred amount");
});

test("Test 19.2b (family 2): credits are obligation-invariant — a larger balance changes only the payment figure", async () => {
  const proposal = (itemId: string) => ({
    changes: [{ action: "CHANGE_QUANTITY" as const, itemId, quantity: 120 }],
    effectiveIntent: { type: "IMMEDIATE" as const },
    acceptanceEnvelope: GENEROUS_ENVELOPE,
  });
  const a = paddleWithBalance(0);
  const qa = await new PaddleAdapter(a.sim, new QuoteStore()).createChangeQuote(a.sub.id, proposal(`${a.sub.id}_item_0`));
  const b = paddleWithBalance(8000);
  const qb = await new PaddleAdapter(b.sim, new QuoteStore()).createChangeQuote(b.sub.id, proposal(`${b.sub.id}_item_0`));

  assert.equal(qa.commercialEffect.immediate?.net, 20000);
  assert.equal(qb.commercialEffect.immediate?.net, 20000, "an 8000 credit balance does not change the incurred obligation");
  assert.equal(qb.commercialEffect.recurring?.resultingAmount, qa.commercialEffect.recurring?.resultingAmount, "credits never leak into recurring");
  assert.equal(nextTransactionEstimate(qa).immediateTransactionTotal, 20000);
  assert.equal(nextTransactionEstimate(qb).immediateTransactionTotal, 12000, "only the payment figure moved");
});

// ---------------------------------------------------------------------------
// Family 3: explicit provenance (quote + committed audit-clean)
// ---------------------------------------------------------------------------

test("Test 19.3 (family 3): quote and committed effects carry explicit provenance; the determinacy audit is clean", async () => {
  const { sim, sub } = freshPaddleFixture();
  const adapter = new PaddleAdapter(sim, new QuoteStore());
  const before = await adapter.getSubscription(sub.id);

  const bare: CommercialEffect = {
    immediate: { net: 20000 },
    recurring: { resultingAmount: 120000, currency: "USD" },
    determinacy: { immediateFinancialEffect: "DETERMINED", recurringFinancialEffect: "DETERMINED" },
  };
  const bareAudit = auditDeterminacy(bare, bare, "CHANGE_QUANTITY");
  assert.deepEqual(bareAudit.find((e) => e.dimension === "immediateFinancialEffect")?.findings, ["MISSING_PROVENANCE"]);
  assert.deepEqual(bareAudit.find((e) => e.dimension === "recurringFinancialEffect")?.findings, ["MISSING_PROVENANCE"]);

  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [{ action: "CHANGE_QUANTITY", itemId: before.items[0].id, quantity: 120 }],
    effectiveIntent: { type: "IMMEDIATE" },
    acceptanceEnvelope: GENEROUS_ENVELOPE,
  });
  assert.ok(quote.commercialEffect.provenance?.immediate, "immediate provenance recorded");
  assert.ok(quote.commercialEffect.provenance?.recurring, "recurring provenance recorded");
  const quoteAudit = auditDeterminacy(quote.commercialEffect, quote.commercialEffect, "CHANGE_QUANTITY");
  assert.ok(quoteAudit.every((e) => e.findings.length === 0), JSON.stringify(quoteAudit));

  const receipt = await adapter.commitChangeQuote(quote.id);
  const committedAudit = auditDeterminacy(quote.commercialEffect, receipt.committedEffect, "CHANGE_QUANTITY");
  assert.ok(committedAudit.every((e) => e.findings.length === 0), JSON.stringify(committedAudit));
});

// ---------------------------------------------------------------------------
// Family 4: missing / invalid committed-source provenance — the
// revalidated preview never establishes committed actuals (F-1)
// ---------------------------------------------------------------------------

test("Test 19.4 (family 4): revalidated-preview lineage is flagged by the audit and refused by establishment", async () => {
  const previewDerived: CommercialEffect = {
    immediate: { net: 20000 },
    recurring: { resultingAmount: 120000, currency: "USD" },
    determinacy: { immediateFinancialEffect: "DETERMINED", recurringFinancialEffect: "DETERMINED" },
    provenance: { immediate: "revalidated preview total", recurring: "revalidated preview total", committedSource: "revalidated_preview" },
  };
  const audit = auditDeterminacy(previewDerived, previewDerived, "CHANGE_QUANTITY");
  assert.deepEqual(audit.find((e) => e.dimension === "immediateFinancialEffect")?.findings, ["PROVENANCE_NOT_ESTABLISHING"]);
  assert.deepEqual(audit.find((e) => e.dimension === "recurringFinancialEffect")?.findings, ["PROVENANCE_NOT_ESTABLISHING"]);

  const { sim, sub } = freshPaddleFixture();
  const store = new QuoteStore();
  const adapter = new PaddleAdapter(sim, store);
  const before = await adapter.getSubscription(sub.id);
  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [{ action: "CHANGE_QUANTITY", itemId: before.items[0].id, quantity: 120 }],
    effectiveIntent: { type: "IMMEDIATE" },
    acceptanceEnvelope: GENEROUS_ENVELOPE,
  });
  const stored = store.get(quote.id)!;
  assert.throws(
    () => establishVerification(stored, { subscriptionRef: sub.id, committedEffect: previewDerived, source: "test fixture (synthetic)" }),
    /Establishment refused/
  );
  assert.throws(
    () => establishVerification(stored, { subscriptionRef: sub.id, committedEffect: stored.quoted_effect, source: "test fixture (synthetic)" }),
    /Establishment refused/,
    "the quote's own effect, relabeled, is refused too"
  );
});

// ---------------------------------------------------------------------------
// Family 5: multi-change aggregation correctness (M1)
// ---------------------------------------------------------------------------

test("Test 19.5a (family 5): same-item overlap — two quantity changes quote and commit the folded result, at zero tolerance", async () => {
  // item_0: 100 -> 120 -> 150, quoted at period start (fraction 1.0).
  // Folded truth: incurred = (150-100) x 1000 = 50000; recurring
  // 150000. The pre-migration per-change previews each measured
  // their delta from the ORIGINAL 100 (20000 and 50000) and summed
  // them: 70000 — the overlap counted twice.
  const { sim, sub } = freshPaddleFixture();
  const adapter = new PaddleAdapter(sim, new QuoteStore());
  const before = await adapter.getSubscription(sub.id);
  const itemId = before.items[0].id;

  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [
      { action: "CHANGE_QUANTITY", itemId, quantity: 120 },
      { action: "CHANGE_QUANTITY", itemId, quantity: 150 },
    ],
    effectiveIntent: { type: "IMMEDIATE" },
    acceptanceEnvelope: ZERO_TOLERANCE_ENVELOPE,
  });
  assert.equal(quote.commercialEffect.immediate?.net, 50000, "quoted incurred is the folded (150-100) delta — not 20000+50000");
  assert.equal(quote.commercialEffect.recurring?.resultingAmount, 150000);

  const receipt = await adapter.commitChangeQuote(quote.id);
  assert.equal(receipt.status, "COMMITTED");
  assert.equal(receipt.reconciliation.status, "OK", "zero-tolerance acceptance: state and time basis unchanged, quoted == committed");
  assert.equal(receipt.committedEffect.immediate?.net, 50000);
  assert.equal(receipt.committedEffect.recurring?.resultingAmount, 150000);
});

test("Test 19.5b (family 5): quantity followed by plan change on the same item folds to one preview", async () => {
  // Folded: pro @1500 x 120. Incurred = 180000 - 100000 = 80000;
  // recurring 180000. (Pre-migration per-change previews summed
  // 20000 + 80000 = 100000.)
  const { sim, sub } = freshPaddleFixture();
  const adapter = new PaddleAdapter(sim, new QuoteStore());
  const before = await adapter.getSubscription(sub.id);
  const itemId = before.items[0].id;

  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [
      { action: "CHANGE_QUANTITY", itemId, quantity: 120 },
      { action: "CHANGE_PLAN", itemId, offeringRef: "plan:pro:monthly" },
    ],
    effectiveIntent: { type: "IMMEDIATE" },
    acceptanceEnvelope: ZERO_TOLERANCE_ENVELOPE,
  });
  assert.equal(quote.commercialEffect.immediate?.net, 80000);
  assert.equal(quote.commercialEffect.recurring?.resultingAmount, 180000);

  const receipt = await adapter.commitChangeQuote(quote.id);
  assert.equal(receipt.reconciliation.status, "OK");
  assert.equal(receipt.committedEffect.immediate?.net, 80000);
  assert.equal(receipt.committedEffect.recurring?.resultingAmount, 180000);
  assert.equal(receipt.resultingSnapshot.items[0].quantity, 120);
  assert.equal(receipt.resultingSnapshot.items[0].offeringRef, "plan:pro:monthly");
});

test("Test 19.5c (family 5): changes to different items aggregate from the single folded preview", async () => {
  // item_0 basic 100 -> 120 (+20000); item_1 pro -> basic
  // (10 x (1000-1500) = -5000). Folded: nextTotal = 120000 + 10000
  // = 130000; oldTotal = 115000; incurred 15000; recurring 130000.
  // (Pre-migration previews summed 20000 + 15000 = 35000.)
  const { sim, sub } = twoItemFixture();
  const adapter = new PaddleAdapter(sim, new QuoteStore());
  const before = await adapter.getSubscription(sub.id);

  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [
      { action: "CHANGE_QUANTITY", itemId: before.items[0].id, quantity: 120 },
      { action: "CHANGE_PLAN", itemId: before.items[1].id, offeringRef: "plan:basic:monthly" },
    ],
    effectiveIntent: { type: "IMMEDIATE" },
    acceptanceEnvelope: ZERO_TOLERANCE_ENVELOPE,
  });
  assert.equal(quote.commercialEffect.immediate?.net, 15000, "the folded preview measures every delta against the original state exactly once");
  assert.equal(quote.commercialEffect.recurring?.resultingAmount, 130000);

  const receipt = await adapter.commitChangeQuote(quote.id);
  assert.equal(receipt.reconciliation.status, "OK");
  assert.equal(receipt.committedEffect.immediate?.net, 15000);
  assert.equal(receipt.committedEffect.recurring?.resultingAmount, 130000);
});

test("Test 19.5d (family 5): positive and negative effects offsetting to exactly zero stay PRESENT as a determined zero", async () => {
  // item_0: +5 seats (+5000); item_1: pro -> basic (-500 x 10 =
  // -5000). Folded delta is exactly 0 — under CORE-1 purity the
  // combined zero is a present { net: 0 } under DETERMINED, not
  // dropped into absence (the pre-migration combineEffects did
  // exactly that drop whenever the summed net was 0).
  const { sim, sub } = twoItemFixture();
  const adapter = new PaddleAdapter(sim, new QuoteStore());
  const before = await adapter.getSubscription(sub.id);

  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [
      { action: "CHANGE_QUANTITY", itemId: before.items[0].id, quantity: 105 },
      { action: "CHANGE_PLAN", itemId: before.items[1].id, offeringRef: "plan:basic:monthly" },
    ],
    effectiveIntent: { type: "IMMEDIATE" },
    acceptanceEnvelope: ZERO_TOLERANCE_ENVELOPE,
  });
  assert.ok(quote.commercialEffect.immediate, "an exactly-offsetting batch keeps a present immediate");
  assert.equal(quote.commercialEffect.immediate?.net, 0);
  assert.equal(determinacyOf(quote.commercialEffect).immediateFinancialEffect, "DETERMINED");

  const receipt = await adapter.commitChangeQuote(quote.id);
  assert.equal(receipt.status, "COMMITTED");
  assert.equal(receipt.committedEffect.immediate?.net, 0);
});

// ---------------------------------------------------------------------------
// Family 6: pre-mutation UNKNOWN refusal (M2)
// ---------------------------------------------------------------------------

test("Test 19.6a (family 6): an UNKNOWN quoted effect is refused before any mutation", async () => {
  const { sim, sub } = freshPaddleFixture();
  const store = new QuoteStore();
  const adapter = new PaddleAdapter(sim, store);
  const before = await adapter.getSubscription(sub.id);

  sim._debugOmitImmediateTransaction = true; // quote with an UNKNOWN incurred figure
  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [{ action: "CHANGE_QUANTITY", itemId: before.items[0].id, quantity: 120 }],
    effectiveIntent: { type: "IMMEDIATE" },
    acceptanceEnvelope: GENEROUS_ENVELOPE,
  });
  assert.equal(determinacyOf(quote.commercialEffect).immediateFinancialEffect, "UNKNOWN");
  sim._debugOmitImmediateTransaction = false; // previews healthy again — only the adapter's gate can stop this commit

  const counts = countMutations(sim);
  const fingerprintBefore = sim.fingerprint(sub.id);
  await assert.rejects(() => adapter.commitChangeQuote(quote.id), isNotDeterministic);
  assert.equal(counts.update + counts.cancel, 0, "refusal happens BEFORE any mutating sim call");
  assert.equal(sim.fingerprint(sub.id), fingerprintBefore, "subscription state is byte-identical");
  const stored = store.get(quote.id)!;
  assert.equal(stored.commit_receipt, undefined, "a clean refusal records no receipt");
  assert.equal(stored.commit_outcome, undefined, "and no commit outcome — nothing was dispatched");
  assert.equal(stored.status, "ACTIVE");
});

test("Test 19.6b (family 6): an UNKNOWN revalidated effect is refused before mutation, even with a loose envelope", async () => {
  const { sim, sub } = freshPaddleFixture();
  const store = new QuoteStore();
  const adapter = new PaddleAdapter(sim, store);
  const before = await adapter.getSubscription(sub.id);

  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [{ action: "CHANGE_QUANTITY", itemId: before.items[0].id, quantity: 120 }],
    effectiveIntent: { type: "IMMEDIATE" },
    acceptanceEnvelope: GENEROUS_ENVELOPE,
  });
  assert.equal(determinacyOf(quote.commercialEffect).immediateFinancialEffect, "DETERMINED");

  sim._debugOmitImmediateTransaction = true; // the commit-time revalidation cannot establish the figure
  const counts = countMutations(sim);
  await assert.rejects(() => adapter.commitChangeQuote(quote.id), isNotDeterministic);
  assert.equal(counts.update + counts.cancel, 0, "the revalidation refusal also precedes any mutation");
  assert.equal(store.get(quote.id)!.commit_receipt, undefined);
  assert.equal((await adapter.getSubscription(sub.id)).items[0].quantity, 100);
});

test("Test 19.6c (family 6): controls — a DETERMINED commit and a licensed-N/A CANCEL commit both proceed", async () => {
  const { sim, sub } = freshPaddleFixture();
  const adapter = new PaddleAdapter(sim, new QuoteStore());
  const before = await adapter.getSubscription(sub.id);

  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [{ action: "CHANGE_QUANTITY", itemId: before.items[0].id, quantity: 120 }],
    effectiveIntent: { type: "IMMEDIATE" },
    acceptanceEnvelope: GENEROUS_ENVELOPE,
  });
  const receipt = await adapter.commitChangeQuote(quote.id);
  assert.equal(receipt.status, "COMMITTED");

  const f2 = freshPaddleFixture();
  const adapter2 = new PaddleAdapter(f2.sim, new QuoteStore());
  const cancelQuote = await adapter2.createChangeQuote(f2.sub.id, {
    changes: [{ action: "CANCEL" }],
    effectiveIntent: { type: "IMMEDIATE" },
  });
  const cancelReceipt = await adapter2.commitChangeQuote(cancelQuote.id);
  assert.equal(cancelReceipt.status, "COMMITTED", "the licensed CANCEL NOT_APPLICABLE is not refused by the determinacy gate");
  assert.equal(cancelReceipt.resultingSnapshot.status, "canceled");
});

// ---------------------------------------------------------------------------
// Family 7: independent post-commit financial verification
// ---------------------------------------------------------------------------

test("Test 19.7 (family 7): committed actuals come from the post-commit transaction read — not the quote-time or revalidated preview", async () => {
  const { sim, sub } = freshPaddleFixture();
  const adapter = new PaddleAdapter(sim, new QuoteStore());
  const before = await adapter.getSubscription(sub.id);

  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [{ action: "CHANGE_QUANTITY", itemId: before.items[0].id, quantity: 120 }],
    effectiveIntent: { type: "IMMEDIATE" },
    acceptanceEnvelope: GENEROUS_ENVELOPE,
  });
  assert.equal(quote.commercialEffect.immediate?.net, 20000, "quoted at day 0 with the full period remaining");

  sim.advanceTimeSeconds(15 * 24 * 3600); // half the period elapses before commit

  const receipt = await adapter.commitChangeQuote(quote.id);
  assert.equal(receipt.status, "COMMITTED");
  assert.equal(receipt.outcome, "COMMITTED_AND_VERIFIED");
  assert.equal(receipt.reconciliation.status, "OK");
  assert.equal(receipt.committedEffect.provenance?.committedSource, "provider_actual");
  assert.deepEqual(determinacyOf(receipt.committedEffect), {
    immediateFinancialEffect: "DETERMINED",
    recurringFinancialEffect: "DETERMINED",
  });
  // Half the period remained at mutation time: incurred = 20 x 1000 x 0.5.
  assert.equal(receipt.committedEffect.immediate?.net, 10000, "the committed figure is the mutation's own incurred amount, read back post-commit");
  assert.equal(receipt.committedEffect.recurring?.resultingAmount, 120000);
  assert.equal(receipt.quotedEffect.immediate?.net, 20000, "the quoted effect remains the untouched historical record");

  // Independent test-side read: the transaction the mutation
  // generated, read back through the sim's transaction read path,
  // agrees with the receipt.
  const boundId = sim.latestTransactionId(sub.id)!;
  assert.equal(sim.retrieveTransaction(boundId).incurredAmount, 10000);
});

// ---------------------------------------------------------------------------
// Family 8: commit-specific transaction identity (M3)
// ---------------------------------------------------------------------------

test("Test 19.8 (family 8): verification reads the transaction THIS mutation generated, bound by id", async () => {
  const { sim, sub } = freshPaddleFixture();
  const adapter = new PaddleAdapter(sim, new QuoteStore());
  const before = await adapter.getSubscription(sub.id);
  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [{ action: "CHANGE_QUANTITY", itemId: before.items[0].id, quantity: 120 }],
    effectiveIntent: { type: "IMMEDIATE" },
    acceptanceEnvelope: GENEROUS_ENVELOPE,
  });

  const readIds: string[] = [];
  const realRetrieve = sim.retrieveTransaction.bind(sim);
  sim.retrieveTransaction = ((id: string) => {
    readIds.push(id);
    return realRetrieve(id);
  }) as typeof realRetrieve;

  const receipt = await adapter.commitChangeQuote(quote.id);
  const boundId = sim.latestTransactionId(sub.id)!;
  assert.deepEqual(readIds, [boundId], "exactly one post-commit transaction read, of the mutation's own transaction id");
  assert.ok(
    receipt.committedEffect.provenance?.immediate?.includes(boundId),
    "the committed immediate's provenance names the bound transaction id"
  );
});

// ---------------------------------------------------------------------------
// Family 9: concurrent mutation between commit and observation
// ---------------------------------------------------------------------------

test("Test 19.9 (family 9): a concurrent update's transaction is never attributed to this commit — state MISMATCH is VIOLATED with this commit's bound figures", async () => {
  const { sim, sub } = freshPaddleFixture();
  const adapter = new PaddleAdapter(sim, new QuoteStore());
  const before = await adapter.getSubscription(sub.id);
  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [{ action: "CHANGE_QUANTITY", itemId: before.items[0].id, quantity: 120 }],
    effectiveIntent: { type: "IMMEDIATE" },
    acceptanceEnvelope: GENEROUS_ENVELOPE,
  });

  // A concurrent actor's update B (100->... ->150) lands in the
  // BEST_EFFORT window AFTER this commit's mutation returns but
  // BEFORE its verification read (the test17 wrapping pattern).
  const readIds: string[] = [];
  const realRetrieve = sim.retrieveTransaction.bind(sim);
  sim.retrieveTransaction = ((id: string) => {
    readIds.push(id);
    return realRetrieve(id);
  }) as typeof realRetrieve;
  const realUpdate = sim.update.bind(sim);
  let interleaved = false;
  sim.update = ((...args: Parameters<typeof realUpdate>) => {
    const result = realUpdate(...args);
    if (!interleaved) {
      interleaved = true;
      realUpdate(sub.id, [{ priceId: "pri_seat_basic", quantity: 150 }], "prorated_immediately");
    }
    return result;
  }) as typeof realUpdate;

  const receipt = await adapter.commitChangeQuote(quote.id);
  const boundId = readIds[0];
  assert.ok(boundId, "the adapter read a transaction by id");
  assert.equal(sim.retrieveTransaction(boundId).incurredAmount, 20000, "the bound transaction is THIS commit's (100 -> 120 at period start)");
  assert.equal(receipt.status, "COMMITTED", "a determined mismatch is recorded on a verified-class receipt, not as unverified");
  assert.equal(receipt.outcome, "COMMITTED_AND_VERIFIED");
  assert.equal(receipt.reconciliation.status, "VIOLATED", "mismatch is a determined NEGATIVE verification (D3)");
  assert.ok(receipt.reconciliation.status === "VIOLATED" && /mismatch/i.test(receipt.reconciliation.reason));
  assert.equal(receipt.committedEffect.immediate?.net, 20000, "the committed immediate is THIS commit's bound-transaction actual — never the concurrent transaction's 30000");
  assert.equal(receipt.committedEffect.recurring?.resultingAmount, 150000, "the committed recurring honestly reports the observed state");
  assert.ok(!readIds.includes(sim.latestTransactionId(sub.id)!), "the concurrent transaction was never read for this commit's verification");
});

test("Test 19.9b (family 9): a concurrent transaction that leaves the intended state intact makes attribution UNVERIFIED — figures remain this commit's own", async () => {
  const { sim, sub } = freshPaddleFixture();
  const adapter = new PaddleAdapter(sim, new QuoteStore());
  const before = await adapter.getSubscription(sub.id);
  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [{ action: "CHANGE_QUANTITY", itemId: before.items[0].id, quantity: 120 }],
    effectiveIntent: { type: "IMMEDIATE" },
    acceptanceEnvelope: GENEROUS_ENVELOPE,
  });

  // Concurrent actor re-applies the SAME final state (120) through
  // its own update — generating its own (zero-incurred) transaction
  // and superseding the latest-transaction pointer.
  const realUpdate = sim.update.bind(sim);
  let interleaved = false;
  sim.update = ((...args: Parameters<typeof realUpdate>) => {
    const result = realUpdate(...args);
    if (!interleaved) {
      interleaved = true;
      realUpdate(sub.id, [{ priceId: "pri_seat_basic", quantity: 120 }], "prorated_immediately");
    }
    return result;
  }) as typeof realUpdate;

  const receipt = await adapter.commitChangeQuote(quote.id);
  assert.equal(receipt.status, "COMMITTED_UNVERIFIED", "the state was not produced by this commit alone, so its attribution is unverified");
  assert.equal(receipt.reconciliation.status, "UNVERIFIED");
  assert.ok(receipt.reconciliation.status === "UNVERIFIED" && /concurrent|intervening/i.test(receipt.reconciliation.reason));
  assert.equal(receipt.committedEffect.immediate?.net, 20000, "the recorded figures are still this commit's bound-transaction actuals");
  assert.equal(receipt.committedEffect.recurring?.resultingAmount, 120000);
});

// ---------------------------------------------------------------------------
// Family 10: MISMATCH versus UNVERIFIABLE
// ---------------------------------------------------------------------------

test("Test 19.10 (family 10): an unobservable post-commit state computes UNVERIFIABLE at the machinery level — distinct from an established MISMATCH", async () => {
  const { sim, sub } = freshPaddleFixture();
  const store = new QuoteStore();
  const adapter = new PaddleAdapter(sim, store);
  const before = await adapter.getSubscription(sub.id);
  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [{ action: "CHANGE_QUANTITY", itemId: before.items[0].id, quantity: 120 }],
    effectiveIntent: { type: "IMMEDIATE" },
    acceptanceEnvelope: GENEROUS_ENVELOPE,
  });
  const stored = store.get(quote.id)!;
  // SYNTHETIC observation with establishing figures but NO resulting
  // snapshot: the state check has nothing to read.
  const token = establishVerification(stored, {
    subscriptionRef: sub.id,
    committedEffect: {
      immediate: { net: 20000 },
      recurring: { resultingAmount: 120000, currency: "USD" },
      determinacy: { immediateFinancialEffect: "DETERMINED", recurringFinancialEffect: "DETERMINED" },
      provenance: { immediate: "synthetic fixture", recurring: "synthetic fixture", committedSource: "provider_actual" },
    },
    source: "test fixture (synthetic simulator observation)",
  });
  assert.equal(token.stateVerification, "UNVERIFIABLE");
  // Contrast 19.9: an ESTABLISHED contradiction computes MISMATCH
  // and lands as VIOLATED on a COMMITTED receipt — the two outcomes
  // never collapse into each other (D3).
});

// ---------------------------------------------------------------------------
// Family 11: scheduled (TERM_END) cancellation verification
// ---------------------------------------------------------------------------

test("Test 19.11a (family 11): TERM_END cancellation verifies as SCHEDULED — scheduled change, boundary effective date, still-active subscription", async () => {
  const { sim, sub } = freshPaddleFixture();
  const adapter = new PaddleAdapter(sim, new QuoteStore());

  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [{ action: "CANCEL" }],
    effectiveIntent: { type: "TERM_END" },
    guaranteeMode: "EXACT",
  });
  // Quote-side shape (§3.10): immediate NOT_APPLICABLE (licensed,
  // cited); recurring a DETERMINED zero — the post-cancellation
  // price level — never the still-active current price.
  assert.deepEqual(determinacyOf(quote.commercialEffect), {
    immediateFinancialEffect: "NOT_APPLICABLE",
    recurringFinancialEffect: "DETERMINED",
  });
  assert.equal(quote.commercialEffect.recurring?.resultingAmount, 0);
  assert.deepEqual(quote.commercialEffect.provenance?.applicabilityCitations?.immediateFinancialEffect, {
    action: "CANCEL",
    dimension: "immediateFinancialEffect",
  });
  const audit = auditDeterminacy(quote.commercialEffect, quote.commercialEffect, "CANCEL");
  assert.ok(audit.every((e) => e.findings.length === 0), JSON.stringify(audit));

  const receipt = await adapter.commitChangeQuote(quote.id);
  assert.equal(receipt.status, "COMMITTED");
  assert.equal(receipt.outcome, "COMMITTED_AND_VERIFIED");
  assert.equal(receipt.reconciliation.status, "OK");
  assert.equal(receipt.resultingSnapshot.status, "active", "a TERM_END cancel does NOT require a terminal state now");
  assert.equal(receipt.resultingSnapshot.term?.autoRenew, false);
  assert.equal(receipt.committedEffect.recurring?.resultingAmount, 0, "post-cancellation recurring is the obligation at/after the boundary: zero");
  assert.equal(receipt.committedEffect.provenance?.committedSource, "defined_equal_exact");

  // The scheduled cancellation is established from the provider
  // record itself: scheduledChange present, effective at the
  // period boundary, subscription still active until then.
  const record = sim.get(sub.id);
  assert.equal(record.scheduledChange?.action, "cancel");
  assert.equal(record.scheduledChange?.effectiveAt, record.currentBillingPeriod.endsAt);
  assert.equal(record.status, "active");
});

test("Test 19.11b (family 11): IMMEDIATE cancellation verifies the terminal state", async () => {
  const { sim, sub } = freshPaddleFixture();
  const adapter = new PaddleAdapter(sim, new QuoteStore());
  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [{ action: "CANCEL" }],
    effectiveIntent: { type: "IMMEDIATE" },
    guaranteeMode: "EXACT",
  });
  const receipt = await adapter.commitChangeQuote(quote.id);
  assert.equal(receipt.status, "COMMITTED");
  assert.equal(receipt.outcome, "COMMITTED_AND_VERIFIED");
  assert.equal(receipt.resultingSnapshot.status, "canceled");
  assert.equal(receipt.committedEffect.recurring?.resultingAmount, 0);
  assert.equal(sim.get(sub.id).status, "canceled");
  assert.equal(sim.get(sub.id).scheduledChange, null);
});

test("Test 19.11c (family 11): a TERM_END commit whose scheduled change is absent on read-back is a MISMATCH, not a success", async () => {
  const { sim, sub } = freshPaddleFixture();
  const adapter = new PaddleAdapter(sim, new QuoteStore());
  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [{ action: "CANCEL" }],
    effectiveIntent: { type: "TERM_END" },
    guaranteeMode: "EXACT",
  });

  // A concurrent actor removes the scheduled cancellation in the
  // window after this commit's cancel call but before its read.
  const realCancel = sim.cancel.bind(sim);
  sim.cancel = ((...args: Parameters<typeof realCancel>) => {
    const result = realCancel(...args);
    sim._debugMutateDirectly(sub.id, (s) => {
      s.scheduledChange = null;
    });
    return result;
  }) as typeof realCancel;

  const receipt = await adapter.commitChangeQuote(quote.id);
  assert.equal(receipt.status, "COMMITTED");
  assert.equal(receipt.outcome, "COMMITTED_AND_VERIFIED", "an established negative verification is a verified-class outcome (D3)");
  assert.equal(receipt.reconciliation.status, "VIOLATED");
  assert.ok(receipt.reconciliation.status === "VIOLATED" && /scheduled/i.test(receipt.reconciliation.reason), "the reason names the missing scheduled cancellation");
  assert.equal(
    receipt.committedEffect.recurring?.resultingAmount,
    100000,
    "the committed figures honestly report the observed state — still active at the current price level, not a fabricated post-cancel zero"
  );
});

// ---------------------------------------------------------------------------
// Family 12: COMMITTED_UNVERIFIED recording, §6.10 replay, deferred
// verification; Family 14: conflicting receipt identity
// ---------------------------------------------------------------------------

test("Test 19.12 (families 12+14): unavailable transaction read records COMMITTED_UNVERIFIED; replay returns the ORIGINAL receipt even after deferred verification; conflicting identities are refused", async () => {
  const { sim, sub } = freshPaddleFixture();
  const store = new QuoteStore();
  const adapter = new PaddleAdapter(sim, store);
  const before = await adapter.getSubscription(sub.id);
  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [{ action: "CHANGE_QUANTITY", itemId: before.items[0].id, quantity: 120 }],
    effectiveIntent: { type: "IMMEDIATE" },
    acceptanceEnvelope: GENEROUS_ENVELOPE,
  });

  // The mutation lands, but the post-commit transaction read is
  // unavailable (fault injection): landing is established from the
  // mutation response, financial verification is not.
  sim._debugFailTransactionReads = true;
  const first = await adapter.commitChangeQuote(quote.id);
  assert.equal(first.status, "COMMITTED_UNVERIFIED");
  assert.equal(first.outcome, "COMMITTED_UNVERIFIED");
  assert.equal(first.reconciliation.status, "UNVERIFIED");
  assert.equal(first.committedEffect.immediate?.net, 20000, "the mutation response's candidate figures are recorded — as UNVERIFIED, not as actuals");
  assert.equal(first.committedEffect.provenance?.committedSource, "unestablished");
  assert.deepEqual(determinacyOf(first.committedEffect), {
    immediateFinancialEffect: "UNKNOWN",
    recurringFinancialEffect: "UNKNOWN",
  });
  assert.equal((await adapter.getSubscription(sub.id)).items[0].quantity, 120, "the change did land provider-side");

  // §6.10: a repeated commit returns the ORIGINAL receipt.
  const replay = await adapter.commitChangeQuote(quote.id);
  assert.deepEqual(replay, first);

  // Family 14: a conflicting re-record under the same quote is
  // refused on identity; the original record is preserved.
  assert.throws(
    () =>
      store.recordCommitReceipt(quote.id, {
        ...first,
        committedEffect: { ...first.committedEffect, immediate: { net: 9999 } },
      }),
    (err: unknown) => err instanceof SCQError && err.code === "CONFLICTING_RECEIPT_IDENTITY"
  );
  assert.deepEqual(store.recordedReceipt(quote.id), first, "the original recorded receipt is preserved byte-for-value");

  // Deferred verification: an independent post-commit observation
  // (SYNTHETIC — built here from the test's own simulator reads)
  // establishes verification through the PR-1 machinery.
  sim._debugFailTransactionReads = false;
  const boundId = sim.latestTransactionId(sub.id)!;
  const txn = sim.retrieveTransaction(boundId);
  const readSub = sim.get(sub.id);
  const snapshot = await adapter.getSubscription(sub.id);
  const evidence = establishVerification(store.get(quote.id)!, {
    subscriptionRef: sub.id,
    committedEffect: {
      immediate: { net: txn.incurredAmount },
      recurring: {
        resultingAmount: readSub.items.reduce((s, i) => s + i.price.unitAmount * i.quantity, 0),
        currency: "USD",
      },
      determinacy: { immediateFinancialEffect: "DETERMINED", recurringFinancialEffect: "DETERMINED" },
      provenance: {
        immediate: "post-commit generated transaction read back from the simulator (synthetic observation)",
        recurring: "post-commit subscription state read back from the simulator (synthetic observation)",
        committedSource: "provider_actual",
      },
    },
    resultingSnapshot: snapshot,
    source: "test-side simulator reads (synthetic observation)",
  });
  const verified = store.verifyCommitReceipt(quote.id, evidence);
  assert.equal(verified.status, "COMMITTED");
  assert.equal(verified.outcome, "COMMITTED_AND_VERIFIED");
  assert.equal(verified.reconciliation.status, "OK");

  // Replay STILL returns the original (unverified) receipt; the
  // verified state is visible only through the current-view read.
  const replayAfterVerify = await adapter.commitChangeQuote(quote.id);
  assert.deepEqual(replayAfterVerify, first, "§6.10: replay returns the receipt as originally recorded, not the verified view");
  assert.equal(store.get(quote.id)!.commit_receipt?.reconciliation.status, "OK");
});

// ---------------------------------------------------------------------------
// Family 13: indeterminate mutation and unsafe-retry refusal
// ---------------------------------------------------------------------------

test("Test 19.13 (family 13): a lost mutation response is INDETERMINATE — no receipt, no verified claim, and a retry is refused without re-mutating", async () => {
  const { sim, sub } = freshPaddleFixture();
  const store = new QuoteStore();
  const adapter = new PaddleAdapter(sim, store);
  const before = await adapter.getSubscription(sub.id);
  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [{ action: "CHANGE_QUANTITY", itemId: before.items[0].id, quantity: 120 }],
    effectiveIntent: { type: "IMMEDIATE" },
    acceptanceEnvelope: GENEROUS_ENVELOPE,
  });

  const counts = countMutations(sim);
  sim._debugLoseNextUpdateResponse = true; // the mutation applies and persists its transaction, then the response is lost

  await assert.rejects(
    () => adapter.commitChangeQuote(quote.id),
    (err: unknown) => {
      assert.ok(err instanceof SCQError);
      assert.equal((err.details as { outcome?: string })?.outcome, "INDETERMINATE");
      return true;
    }
  );
  const stored = store.get(quote.id)!;
  assert.equal(stored.commit_outcome?.outcome, "INDETERMINATE", "the attempt's outcome is recorded (CORE-8) even though no receipt exists");
  assert.equal(stored.commit_receipt, undefined, "no receipt — and in particular no VERIFIED receipt — is recorded for an indeterminate attempt");
  assert.equal(stored.status, "ACTIVE");
  assert.equal((await adapter.getSubscription(sub.id)).items[0].quantity, 120, "the mutation DID land — which is exactly why a blind retry would be unsafe");

  await assert.rejects(
    () => adapter.commitChangeQuote(quote.id),
    (err: unknown) => err instanceof SCQError && (err.details as { outcome?: string })?.outcome === "INDETERMINATE"
  );
  assert.equal(counts.update, 1, "the retry was refused BEFORE any second mutation call — recovery never duplicates the mutation");
});

// ---------------------------------------------------------------------------
// Family 15: EXACT / REVALIDATE guarantee boundaries
// ---------------------------------------------------------------------------

test("Test 19.15 (family 15): EXACT is refused for proration-bearing actions and defined-equal for CANCEL; REVALIDATE drift still refuses pre-mutation", async () => {
  const { sim, sub } = freshPaddleFixture();
  const adapter = new PaddleAdapter(sim, new QuoteStore());
  const before = await adapter.getSubscription(sub.id);

  // EXACT for CHANGE_QUANTITY: Paddle has no proration_date
  // equivalent, so the request is refused at quote time.
  await assert.rejects(
    () =>
      adapter.createChangeQuote(sub.id, {
        changes: [{ action: "CHANGE_QUANTITY", itemId: before.items[0].id, quantity: 120 }],
        effectiveIntent: { type: "IMMEDIATE" },
        guaranteeMode: "EXACT",
        acceptanceEnvelope: GENEROUS_ENVELOPE,
      }),
    (err: unknown) => err instanceof SCQError && err.code === "UNSUPPORTED_CHANGE"
  );

  // EXACT CANCEL: committed := quoted BY PROTOCOL DEFINITION,
  // honestly labeled defined_equal_exact (no proration component
  // exists to drift).
  const cancelQuote = await adapter.createChangeQuote(sub.id, {
    changes: [{ action: "CANCEL" }],
    effectiveIntent: { type: "TERM_END" },
    guaranteeMode: "EXACT",
  });
  const cancelReceipt = await adapter.commitChangeQuote(cancelQuote.id);
  assert.equal(cancelReceipt.committedEffect.provenance?.committedSource, "defined_equal_exact");
  assert.deepEqual(cancelReceipt.committedEffect.immediate, cancelReceipt.quotedEffect.immediate);
  assert.deepEqual(cancelReceipt.committedEffect.recurring, cancelReceipt.quotedEffect.recurring);
  assert.deepEqual(cancelReceipt.committedEffect.determinacy, cancelReceipt.quotedEffect.determinacy);

  // REVALIDATE drift refusal is unchanged: zero-tolerance envelope,
  // time passes, commit refuses BEFORE mutating.
  const f2 = freshPaddleFixture();
  const adapter2 = new PaddleAdapter(f2.sim, new QuoteStore());
  const before2 = await adapter2.getSubscription(f2.sub.id);
  const driftQuote = await adapter2.createChangeQuote(f2.sub.id, {
    changes: [{ action: "CHANGE_QUANTITY", itemId: before2.items[0].id, quantity: 120 }],
    effectiveIntent: { type: "IMMEDIATE" },
    acceptanceEnvelope: ZERO_TOLERANCE_ENVELOPE,
  });
  f2.sim.advanceTimeSeconds(10 * 24 * 3600);
  await assert.rejects(
    () => adapter2.commitChangeQuote(driftQuote.id),
    (err: unknown) => err instanceof SCQError && err.code === "QUOTE_DRIFTED"
  );
  assert.equal((await adapter2.getSubscription(f2.sub.id)).items[0].quantity, 100, "drift refusal means no mutation");
});

// ---------------------------------------------------------------------------
// Scenario coverage: downgrade (credit), cadence change
// ---------------------------------------------------------------------------

test("Test 19.16 (scenarios): a downgrade incurs a determined credit; a cadence change carries determinacy and provenance", async () => {
  const { sim, sub } = freshPaddleFixture();
  const adapter = new PaddleAdapter(sim, new QuoteStore());
  const before = await adapter.getSubscription(sub.id);

  const downgrade = await adapter.createChangeQuote(sub.id, {
    changes: [{ action: "CHANGE_QUANTITY", itemId: before.items[0].id, quantity: 80 }],
    effectiveIntent: { type: "IMMEDIATE" },
    acceptanceEnvelope: GENEROUS_ENVELOPE,
  });
  assert.equal(downgrade.commercialEffect.immediate?.net, -20000, "a downgrade incurs a credit — a negative obligation, not a payment figure");
  assert.equal(downgrade.commercialEffect.immediate?.credit, 20000);
  assert.equal(downgrade.commercialEffect.immediate?.charge, undefined);
  assert.equal(determinacyOf(downgrade.commercialEffect).immediateFinancialEffect, "DETERMINED");

  const cadence = await adapter.createChangeQuote(sub.id, {
    changes: [{ action: "CHANGE_CADENCE", cadence: "ANNUAL" }],
    effectiveIntent: { type: "IMMEDIATE" },
    acceptanceEnvelope: GENEROUS_ENVELOPE,
  });
  assert.equal(cadence.commercialEffect.recurring?.resultingAmount, 10000 * 100);
  assert.equal(cadence.commercialEffect.recurring?.cadence, "ANNUAL");
  assert.deepEqual(determinacyOf(cadence.commercialEffect), {
    immediateFinancialEffect: "DETERMINED",
    recurringFinancialEffect: "DETERMINED",
  });
  const cadenceAudit = auditDeterminacy(cadence.commercialEffect, cadence.commercialEffect, "CHANGE_CADENCE");
  assert.ok(cadenceAudit.every((e) => e.findings.length === 0), JSON.stringify(cadenceAudit));
});

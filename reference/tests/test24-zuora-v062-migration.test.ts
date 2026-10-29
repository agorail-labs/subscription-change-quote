import { test } from "node:test";
import assert from "node:assert/strict";
import { QuoteStore, establishVerification } from "../src/store/quote-store.js";
import { ZuoraAdapter } from "../src/adapters/zuora-adapter.js";
import { ZuoraSim, ZuoraSimError, type ZuoraSubscription } from "../src/adapters/zuora-sim.js";
import { auditDeterminacy, determinacyOf } from "../src/core/scq-engine.js";
import { SCQError } from "../src/core/types.js";
import { freshZuoraFixture, freshZuoraCommittedTermFixture } from "./fixtures.js";

// SCQ v0.6.2 — PR-5: Zuora SIMULATOR migration conformance tests.
//
// Everything in this file runs against the in-memory Zuora
// simulator (ZuoraSim). All results are SIMULATED_PASS — no live
// Zuora API is involved, and nothing here is evidence about real
// Zuora behavior.
//
// The migration contract under test (issue #7 / v0.6.2 design
// Topics 1–5), applying the PR #10/#11 correction principles:
//   M1 — multi-change quotes resolve into ONE ordered order-action
//        sequence and derive from ONE preview of that exact
//        sequence. The pre-migration construction previewed each
//        change separately against the SAME original subscription
//        and combined the effects: overlapping quantity changes
//        double-counted (probe A: [100->120, ->150] quoted
//        immediate 70000 instead of 50000), different-item changes
//        dropped all but the last change's recurring contribution
//        (probe B: quoted 130000 instead of 150000), and an
//        established zero was re-encoded as absent with no
//        determinacy record anywhere (probe C; finding F-2 —
//        combineEffects' `?? 0` and the net-zero omission).
//   M2 — the adapter refuses, before any mutation, a commit whose
//        quoted or revalidated effect is not determinate
//        (QUOTE_NOT_DETERMINISTIC). BC-1's fail-closed envelope is
//        a separate, later activation; the shared engine — and its
//        v0.6.1 absent-value coercion, pinned by test14 §14.6 — is
//        NOT changed here.
//   M3 — post-commit verification binds to the ORDER this mutation
//        created, persisted by the sim and read back by id via
//        retrieveOrder; never to an unqualified latest-order
//        pointer, and never to the pre-mutation revalidated
//        preview (the pre-migration code assigned the revalidated
//        preview as committedEffect — finding F-1, probe D: a
//        landing at quantity 130 against a 120 preview reported
//        committed 120000 with reconciliation OK) and never to the
//        destructured-away createOrder result (probe E: no order
//        identity survived the mutation call at all).
// Zuora-specific semantics preserved (and pinned below):
//   - native monotonic version: staleness DETECTION, and the
//     version sequence as the attribution signal — while SCQ's
//     read-check-mutate remains BEST_EFFORT, never ATOMIC;
//   - ONE order carrying multiple actions atomically (as the sim
//     establishes) — a property of the provider operation, kept
//     distinct from precondition atomicity in the receipt itself
//     (multiChangeConsistency ATOMIC + consistencyGuarantee
//     BEST_EFFORT on the same receipt);
//   - IMMEDIATE / TERM_END / DATE intents with pinned order
//     effective dates;
//   - future-dated cancellation verified as correctly SCHEDULED
//     state against the QUOTED date (PR #11 P3): a premature
//     terminal state is a MISMATCH, never a verified schedule;
//   - cancellation during a committed term leaves the incurred
//     obligation UNESTABLISHED (the early-termination decision
//     lives outside the order): immediate UNKNOWN, commit refused
//     pre-mutation — never a fabricated zero and never
//     NOT_APPLICABLE.
// PR #14 review corrections (Z1/Z2) — attribution BEFORE
// classification, in both establishment paths:
//   Z1 — establishCommittedEffect checked state contradictions
//        before attribution, so an intervening actor's change that
//        produced a mismatching state was returned as THIS commit's
//        verified VIOLATED (probe Z1 at f96b957: COMMITTED /
//        COMMITTED_AND_VERIFIED / VIOLATED under a broken version
//        chain). Now: broken chain ⇒ COMMITTED_UNVERIFIED /
//        UNVERIFIED regardless of the observed state (24.23; the
//        matching-state case is 24.12); VIOLATED requires the
//        unbroken chain plus a contradiction produced by this
//        commit's own order (24.13, reworked to the sim's
//        misexecution hooks — its previous _debugMutateDirectly
//        construction encoded the defect).
//   Z2 — establishCancelCommit verified status/date alone, never
//        the bound order or the version chain, so another actor's
//        cancellation could verify as this commit's OK (probe Z2).
//        Now the pure-CANCEL path binds to the persisted order id,
//        checks the order's action identity against the dispatched
//        sequence, and requires the unbroken +1 chain before any
//        OK/VIOLATED verdict (24.24 intervening order, 24.25
//        unreadable bound order; 24.19's premature-terminal case
//        reworked the same way as 24.13 — attributable ⇒ VIOLATED,
//        intervening ⇒ UNVERIFIED).

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

function twoPlanFixture(): { sim: ZuoraSim; sub: ZuoraSubscription } {
  const now = new Date("2026-08-01T00:00:00Z");
  const sim = new ZuoraSim(now);
  const sub: ZuoraSubscription = {
    id: "A-S00000009",
    version: 1,
    status: "Active",
    ratePlans: [
      {
        id: "rp_1",
        productRatePlanId: "ratePlan_seat_basic_monthly",
        ratePlanCharges: [
          { id: "rpc_1", productRatePlanChargeId: "ratePlan_seat_basic_monthly", chargeModel: "PerUnit", unitAmount: 1000, currency: "usd", billingPeriod: "Month", quantity: 100 },
        ],
      },
      {
        id: "rp_2",
        productRatePlanId: "ratePlan_seat_pro_monthly",
        ratePlanCharges: [
          { id: "rpc_2", productRatePlanChargeId: "ratePlan_seat_pro_monthly", chargeModel: "PerUnit", unitAmount: 1500, currency: "usd", billingPeriod: "Month", quantity: 10 },
        ],
      },
    ],
    term: {
      initialTerm: 1,
      initialTermPeriodType: "Month",
      autoRenew: true,
      renewalTerm: 1,
      renewalTermPeriodType: "Month",
      contractEffectiveDate: now.toISOString().slice(0, 10),
      termStartDate: now.toISOString().slice(0, 10),
      termEndDate: new Date(now.getTime() + 30 * 24 * 3600 * 1000).toISOString().slice(0, 10),
    },
  };
  sim.seedSubscription(sub);
  return { sim, sub };
}

const stateString = (sim: ZuoraSim, id: string) => JSON.stringify(sim.get(id));

// ---------------------------------------------------------------------------
// M1 — one ordered sequence, one preview
// ---------------------------------------------------------------------------

test("Test 24.1 (M1): overlapping quantity changes on the SAME item fold through the ordered sequence — no double count", async () => {
  const { sim, sub } = freshZuoraFixture();
  const adapter = new ZuoraAdapter(sim, new QuoteStore());

  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [
      { action: "CHANGE_QUANTITY", itemId: "rpc_1", quantity: 120 },
      { action: "CHANGE_QUANTITY", itemId: "rpc_1", quantity: 150 },
    ],
    effectiveIntent: { type: "IMMEDIATE" },
    acceptanceEnvelope: GENEROUS_ENVELOPE,
  });
  // Pre-migration probe A quoted 70000 here (each change previewed
  // against the ORIGINAL 100 and the deltas summed). The sequence
  // 100 -> 120 -> 150 incurs exactly the 100 -> 150 delta.
  assert.equal(quote.commercialEffect.immediate?.net, 50000);
  assert.equal(quote.commercialEffect.recurring?.resultingAmount, 150000);
  assert.deepEqual(quote.commercialEffect.determinacy, {
    immediateFinancialEffect: "DETERMINED",
    recurringFinancialEffect: "DETERMINED",
  });

  const receipt = await adapter.commitChangeQuote(quote.id);
  assert.equal(receipt.status, "COMMITTED");
  assert.equal(receipt.committedEffect.immediate?.net, 50000);
  assert.equal(receipt.committedEffect.recurring?.resultingAmount, 150000);
  assert.equal(receipt.resultingSnapshot.items[0].quantity, 150);

  // Exactly ONE order was dispatched, and the sequence it persisted
  // is byte-for-value the sequence the quote previewed — quoted
  // sequence == mutation input.
  const orders = sim.ordersFor(sub.id);
  assert.equal(orders.length, 1);
  assert.deepEqual(orders[0].orderActions, (quote.providerMetadata as { orderActions: unknown }).orderActions);
});

test("Test 24.2 (M1): different-item changes — the combined recurring covers EVERY item's change", async () => {
  const { sim, sub } = twoPlanFixture();
  const adapter = new ZuoraAdapter(sim, new QuoteStore());

  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [
      { action: "CHANGE_QUANTITY", itemId: "rpc_1", quantity: 120 },
      { action: "CHANGE_QUANTITY", itemId: "rpc_2", quantity: 20 },
    ],
    effectiveIntent: { type: "IMMEDIATE" },
    acceptanceEnvelope: GENEROUS_ENVELOPE,
  });
  // Pre-migration probe B quoted 130000 (only the LAST change's
  // preview survived combineEffects). Correct: 120*1000 + 20*1500.
  assert.equal(quote.commercialEffect.recurring?.resultingAmount, 150000);
  assert.equal(quote.commercialEffect.immediate?.net, 35000);

  const receipt = await adapter.commitChangeQuote(quote.id);
  assert.equal(receipt.status, "COMMITTED");
  assert.equal(receipt.committedEffect.recurring?.resultingAmount, 150000);
  const quantities = receipt.resultingSnapshot.items.map((i) => i.quantity).sort((a, b) => (a ?? 0) - (b ?? 0));
  assert.deepEqual(quantities, [20, 120]);
});

test("Test 24.3 (M1): quantity + plan replacement — the swap carries the in-sequence quantity forward", async () => {
  const { sim, sub } = freshZuoraFixture();
  const adapter = new ZuoraAdapter(sim, new QuoteStore());

  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [
      { action: "CHANGE_QUANTITY", itemId: "rpc_1", quantity: 120 },
      { action: "CHANGE_PLAN", itemId: "rpc_1", offeringRef: "plan:pro:monthly" },
    ],
    effectiveIntent: { type: "IMMEDIATE" },
    acceptanceEnvelope: GENEROUS_ENVELOPE,
  });
  assert.equal(quote.commercialEffect.recurring?.resultingAmount, 1500 * 120, "the plan swap applies to the quantity the earlier in-sequence change established");
  assert.equal(quote.commercialEffect.immediate?.net, 20000, "the quantity delta, incurred once");
  const addAction = (quote.providerMetadata as { orderActions: Array<{ type: string; quantity?: number }> }).orderActions.find((a) => a.type === "AddProduct");
  assert.equal(addAction?.quantity, 120, "the AddProduct carries the folded quantity, not the original 100");

  const receipt = await adapter.commitChangeQuote(quote.id);
  assert.equal(receipt.status, "COMMITTED");
  assert.equal(receipt.resultingSnapshot.items.length, 1);
  assert.equal(receipt.resultingSnapshot.items[0].offeringRef, "plan:pro:monthly");
  assert.equal(receipt.resultingSnapshot.items[0].quantity, 120);
});

test("Test 24.4 (M1): combinations that cannot be executed as ordered are refused at quote time", async () => {
  const cases: Array<{ name: string; changes: unknown[] }> = [
    {
      name: "plan replacement then a quantity change on the replaced plan",
      changes: [
        { action: "CHANGE_PLAN", itemId: "rpc_1", offeringRef: "plan:pro:monthly" },
        { action: "CHANGE_QUANTITY", itemId: "rpc_1", quantity: 150 },
      ],
    },
    {
      name: "two plan replacements of the same item",
      changes: [
        { action: "CHANGE_PLAN", itemId: "rpc_1", offeringRef: "plan:pro:monthly" },
        { action: "CHANGE_PLAN", itemId: "rpc_1", offeringRef: "plan:basic:monthly" },
      ],
    },
    {
      name: "cadence change then a quantity change on the replaced plan",
      changes: [
        { action: "CHANGE_CADENCE", cadence: "ANNUAL" },
        { action: "CHANGE_QUANTITY", itemId: "rpc_1", quantity: 150 },
      ],
    },
    {
      name: "two cancellations",
      changes: [{ action: "CANCEL" }, { action: "CANCEL" }],
    },
  ];
  for (const { name, changes } of cases) {
    const { sim, sub } = freshZuoraFixture();
    const adapter = new ZuoraAdapter(sim, new QuoteStore());
    const before = stateString(sim, sub.id);
    await assert.rejects(
      () =>
        adapter.createChangeQuote(sub.id, {
          changes: changes as never,
          effectiveIntent: { type: "IMMEDIATE" },
          acceptanceEnvelope: GENEROUS_ENVELOPE,
        }),
      (err: unknown) => err instanceof SCQError && err.code === "INVALID_PROPOSAL",
      name
    );
    assert.equal(sim.ordersFor(sub.id).length, 0, `${name}: no order dispatched`);
    assert.equal(stateString(sim, sub.id), before, `${name}: state untouched`);
  }

  // The mirror-image ordering IS executable and folds: quantity
  // first, then the cadence swap carries it forward.
  const { sim, sub } = freshZuoraFixture();
  const adapter = new ZuoraAdapter(sim, new QuoteStore());
  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [
      { action: "CHANGE_QUANTITY", itemId: "rpc_1", quantity: 120 },
      { action: "CHANGE_CADENCE", cadence: "ANNUAL" },
    ],
    effectiveIntent: { type: "IMMEDIATE" },
    acceptanceEnvelope: GENEROUS_ENVELOPE,
  });
  assert.equal(quote.commercialEffect.recurring?.resultingAmount, 10000 * 120);
});

// ---------------------------------------------------------------------------
// Determinacy — zeros, absences, and the M2 gate
// ---------------------------------------------------------------------------

test("Test 24.5: an established zero is a present DETERMINED zero; an absent figure is UNKNOWN and refuses pre-mutation", async () => {
  // Established zero: a monthly->monthly plan swap produces no
  // invoice items — the preview ESTABLISHES net 0.
  {
    const { sim, sub } = freshZuoraFixture();
    const adapter = new ZuoraAdapter(sim, new QuoteStore());
    const quote = await adapter.createChangeQuote(sub.id, {
      changes: [{ action: "CHANGE_PLAN", itemId: "rpc_1", offeringRef: "plan:pro:monthly" }],
      effectiveIntent: { type: "IMMEDIATE" },
      acceptanceEnvelope: GENEROUS_ENVELOPE,
    });
    // Pre-migration probe C: immediate was ABSENT here and no
    // determinacy record existed at all (finding F-2).
    assert.deepEqual(quote.commercialEffect.immediate, { net: 0 });
    assert.equal(quote.commercialEffect.determinacy?.immediateFinancialEffect, "DETERMINED");
    const receipt = await adapter.commitChangeQuote(quote.id);
    assert.equal(receipt.status, "COMMITTED", "a verified zero passes the determinacy gate as DETERMINED");
    assert.deepEqual(receipt.committedEffect.immediate, { net: 0 });
  }
  // Absent figure: the preview cannot establish the immediate
  // dimension at all.
  {
    const { sim, sub } = freshZuoraFixture();
    const adapter = new ZuoraAdapter(sim, new QuoteStore());
    sim._debugOmitPreviewImmediate = true;
    const quote = await adapter.createChangeQuote(sub.id, {
      changes: [{ action: "CHANGE_QUANTITY", itemId: "rpc_1", quantity: 120 }],
      effectiveIntent: { type: "IMMEDIATE" },
      acceptanceEnvelope: GENEROUS_ENVELOPE,
    });
    assert.equal(quote.commercialEffect.immediate, undefined, "no figure is emitted — never zero-filled");
    assert.equal(quote.commercialEffect.determinacy?.immediateFinancialEffect, "UNKNOWN");
    const before = stateString(sim, sub.id);
    await assert.rejects(
      () => adapter.commitChangeQuote(quote.id),
      (err: unknown) => {
        assert.ok(err instanceof SCQError);
        assert.equal(err.code, "QUOTE_NOT_DETERMINISTIC");
        assert.equal((err as any).details.stage, "quoted");
        return true;
      }
    );
    assert.equal(sim.ordersFor(sub.id).length, 0, "zero mutating calls on refusal");
    assert.equal(stateString(sim, sub.id), before, "subscription state byte-identical after refusal");
  }
});

test("Test 24.6 (M2): a REVALIDATED effect that loses its figure refuses before mutation", async () => {
  const { sim, sub } = freshZuoraFixture();
  const adapter = new ZuoraAdapter(sim, new QuoteStore());
  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [{ action: "CHANGE_QUANTITY", itemId: "rpc_1", quantity: 120 }],
    effectiveIntent: { type: "IMMEDIATE" },
    acceptanceEnvelope: GENEROUS_ENVELOPE,
  });
  sim._debugOmitPreviewImmediate = true; // the commit-time re-preview cannot establish the figure
  const before = stateString(sim, sub.id);
  await assert.rejects(
    () => adapter.commitChangeQuote(quote.id),
    (err: unknown) => {
      assert.ok(err instanceof SCQError);
      assert.equal(err.code, "QUOTE_NOT_DETERMINISTIC");
      assert.equal((err as any).details.stage, "revalidated");
      return true;
    }
  );
  assert.equal(sim.ordersFor(sub.id).length, 0);
  assert.equal(stateString(sim, sub.id), before);
});

test("Test 24.7: a missing recurring source is UNKNOWN — never zero, never NOT_APPLICABLE — and refuses", async () => {
  const { sim, sub } = freshZuoraFixture();
  const adapter = new ZuoraAdapter(sim, new QuoteStore());
  sim._debugOmitPreviewRecurring = true;
  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [{ action: "CHANGE_QUANTITY", itemId: "rpc_1", quantity: 120 }],
    effectiveIntent: { type: "IMMEDIATE" },
    acceptanceEnvelope: GENEROUS_ENVELOPE,
  });
  assert.equal(quote.commercialEffect.recurring?.resultingAmount, undefined);
  assert.equal(determinacyOf(quote.commercialEffect).recurringFinancialEffect, "UNKNOWN");
  await assert.rejects(
    () => adapter.commitChangeQuote(quote.id),
    (err: unknown) => {
      assert.ok(err instanceof SCQError);
      assert.equal(err.code, "QUOTE_NOT_DETERMINISTIC");
      assert.equal((err as any).details.dimension, "recurringFinancialEffect");
      return true;
    }
  );
  assert.equal(sim.ordersFor(sub.id).length, 0);
});

test("Test 24.8: pure CANCEL determinacy — NOT_APPLICABLE immediate under the §3.10 license, DETERMINED zero recurring, audit-clean", async () => {
  const { sim, sub } = freshZuoraFixture();
  const store = new QuoteStore();
  const adapter = new ZuoraAdapter(sim, store);
  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [{ action: "CANCEL" }],
    effectiveIntent: { type: "TERM_END" },
    guaranteeMode: "EXACT",
  });
  assert.equal(quote.commercialEffect.determinacy?.immediateFinancialEffect, "NOT_APPLICABLE");
  assert.deepEqual(quote.commercialEffect.provenance?.applicabilityCitations?.immediateFinancialEffect, {
    action: "CANCEL",
    dimension: "immediateFinancialEffect",
  });
  assert.equal(quote.commercialEffect.determinacy?.recurringFinancialEffect, "DETERMINED");
  assert.equal(quote.commercialEffect.recurring?.resultingAmount, 0, "the post-cancellation level is a determined zero, not an absence");

  const receipt = await adapter.commitChangeQuote(quote.id);
  assert.equal(receipt.status, "COMMITTED", "a licensed NOT_APPLICABLE passes the gate");
  const audit = auditDeterminacy(quote.commercialEffect, receipt.committedEffect, "CANCEL");
  assert.ok(audit.every((e) => e.findings.length === 0), `audit must be clean, got ${JSON.stringify(audit)}`);
});

test("Test 24.9: a mixed sequence containing a mid-term cancellation inherits the UNKNOWN incurred obligation and refuses", async () => {
  const { sim, sub } = freshZuoraCommittedTermFixture();
  const adapter = new ZuoraAdapter(sim, new QuoteStore());
  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [
      { action: "CHANGE_QUANTITY", itemId: "rpc_1", quantity: 120 },
      { action: "CANCEL" },
    ],
    effectiveIntent: { type: "IMMEDIATE" },
    acceptanceEnvelope: GENEROUS_ENVELOPE,
  });
  // The quantity change alone would be priced exactly; the
  // sequence's TOTAL incurred obligation is not established while
  // the cancellation's early-termination question is open.
  assert.equal(quote.commercialEffect.determinacy?.immediateFinancialEffect, "UNKNOWN");
  assert.equal(quote.commercialEffect.immediate, undefined);
  const before = stateString(sim, sub.id);
  await assert.rejects(
    () => adapter.commitChangeQuote(quote.id),
    (err: unknown) => err instanceof SCQError && err.code === "QUOTE_NOT_DETERMINISTIC"
  );
  assert.equal(sim.ordersFor(sub.id).length, 0);
  assert.equal(stateString(sim, sub.id), before);
});

test("Test 24.10: incurred obligation keeps its charge/credit parts — a cadence swap's credit is a component, not a payment figure", async () => {
  const { sim, sub } = freshZuoraFixture();
  const adapter = new ZuoraAdapter(sim, new QuoteStore());
  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [{ action: "CHANGE_CADENCE", cadence: "ANNUAL" }],
    effectiveIntent: { type: "IMMEDIATE" },
    acceptanceEnvelope: GENEROUS_ENVELOPE,
  });
  // The swap's incurred obligation nets a prorated annual charge
  // against the unused-monthly credit — both are components of the
  // SAME incurred obligation (invoice items of the order), carried
  // as distinct charge/credit parts of `immediate`. Zuora's model
  // exposes no amount-due/next-invoice figure to confuse them with.
  assert.equal(quote.commercialEffect.immediate?.charge, 83333);
  assert.equal(quote.commercialEffect.immediate?.credit, 100000);
  assert.equal(quote.commercialEffect.immediate?.net, -16667);

  const receipt = await adapter.commitChangeQuote(quote.id);
  assert.equal(receipt.status, "COMMITTED");
  assert.equal(receipt.committedEffect.immediate?.charge, 83333);
  assert.equal(receipt.committedEffect.immediate?.credit, 100000);
  assert.equal(receipt.committedEffect.immediate?.net, -16667);
  assert.equal(receipt.committedEffect.provenance?.committedSource, "provider_actual");
});

// ---------------------------------------------------------------------------
// M3 — bound-order establishment
// ---------------------------------------------------------------------------

test("Test 24.11 (M3): committed figures bind to THIS mutation's persisted order — a second commit is not attributed the first order's figures", async () => {
  const { sim, sub } = freshZuoraFixture();
  const adapter = new ZuoraAdapter(sim, new QuoteStore());

  const quoteA = await adapter.createChangeQuote(sub.id, {
    changes: [{ action: "CHANGE_QUANTITY", itemId: "rpc_1", quantity: 120 }],
    effectiveIntent: { type: "IMMEDIATE" },
    acceptanceEnvelope: GENEROUS_ENVELOPE,
  });
  const receiptA = await adapter.commitChangeQuote(quoteA.id);
  assert.equal(receiptA.committedEffect.immediate?.net, 20000);

  const quoteB = await adapter.createChangeQuote(sub.id, {
    changes: [{ action: "CHANGE_QUANTITY", itemId: "rpc_1", quantity: 130 }],
    effectiveIntent: { type: "IMMEDIATE" },
    acceptanceEnvelope: GENEROUS_ENVELOPE,
  });
  const receiptB = await adapter.commitChangeQuote(quoteB.id);
  const orders = sim.ordersFor(sub.id);
  assert.equal(orders.length, 2);
  assert.equal(receiptB.committedEffect.immediate?.net, 10000, "the second commit's delta against 120 — its OWN order's figure");
  assert.equal(receiptB.committedEffect.immediate?.net, orders[1].netImmediate);
  assert.ok(
    receiptB.committedEffect.provenance?.immediate?.includes(orders[1].id),
    "the committed provenance names the bound order"
  );
  assert.ok(!receiptB.committedEffect.provenance?.immediate?.includes(orders[0].id));
  assert.notEqual(orders[0].id, orders[1].id);
});

test("Test 24.12 (M3): an order landing in the check->mutate window breaks attribution — COMMITTED_UNVERIFIED, figures still the bound order's", async () => {
  const { sim, sub } = freshZuoraFixture();
  const adapter = new ZuoraAdapter(sim, new QuoteStore());
  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [{ action: "CHANGE_QUANTITY", itemId: "rpc_1", quantity: 120 }],
    effectiveIntent: { type: "IMMEDIATE" },
    acceptanceEnvelope: GENEROUS_ENVELOPE,
  });
  // Test 9i's TOCTOU injection: a concurrent order lands strictly
  // between the version check and createOrder. The state ends up
  // matching intent (this order's update overwrites it), but the
  // version sequence is not the unbroken +1 of this commit alone.
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
  assert.equal(receipt.status, "COMMITTED_UNVERIFIED");
  assert.equal(receipt.outcome, "COMMITTED_UNVERIFIED");
  assert.equal(receipt.reconciliation.status, "UNVERIFIED");
  const order = sim.ordersFor(sub.id)[0];
  assert.equal(receipt.committedEffect.immediate?.net, order.netImmediate, "the figures are THIS order's persisted actuals, read by id");
  assert.equal(receipt.resultingSnapshot.items[0].quantity, 120);
  assert.equal(receipt.consistencyGuarantee, "BEST_EFFORT", "the race is exactly why this never reads ATOMIC");
});

test("Test 24.13 (M3/D3): a wrong landing ATTRIBUTABLE to this commit is a determined VIOLATED — committed figures report the observed state, never the preview", async () => {
  // REQUIRED REWORK (PR #14 review correction Z1): this test
  // previously produced the wrong landing by calling
  // _debugMutateDirectly AFTER createOrder returned — another
  // actor's change, which bumps the version and BREAKS the
  // attribution chain. Under Z1 that construction is no longer a
  // verified violation of this commit (it is test 24.23's
  // intervening-change case, classified UNVERIFIED). The wrong
  // landing here is now produced by THIS commit's own order
  // misapplying its actions (the sim's misexecution hooks): the
  // version advances by exactly our order's +1, the chain is
  // unbroken, and the contradiction is provably this commit's.
  // Wrong final quantity.
  {
    const { sim, sub } = freshZuoraFixture();
    const adapter = new ZuoraAdapter(sim, new QuoteStore());
    const quote = await adapter.createChangeQuote(sub.id, {
      changes: [{ action: "CHANGE_QUANTITY", itemId: "rpc_1", quantity: 120 }],
      effectiveIntent: { type: "IMMEDIATE" },
      acceptanceEnvelope: GENEROUS_ENVELOPE,
    });
    sim._debugWrongQuantityOnNextOrder = 130; // our order applies 130 against its dispatched 120
    const receipt = await adapter.commitChangeQuote(quote.id);
    assert.equal(receipt.status, "COMMITTED");
    assert.equal(receipt.outcome, "COMMITTED_AND_VERIFIED", "a determined negative verification is still a verification (D3)");
    assert.equal(receipt.reconciliation.status, "VIOLATED");
    assert.equal(receipt.committedEffect.recurring?.resultingAmount, 130000, "the observed state, not the previewed 120000 (probe D's false OK is impossible)");
    assert.equal(receipt.committedEffect.provenance?.committedSource, "provider_actual");
    assert.equal(sim.get(sub.id).version, 2, "the version advanced by exactly this order's +1 — attribution unbroken");
  }
  // Wrong final rate plan.
  {
    const { sim, sub } = freshZuoraFixture();
    const adapter = new ZuoraAdapter(sim, new QuoteStore());
    const quote = await adapter.createChangeQuote(sub.id, {
      changes: [{ action: "CHANGE_PLAN", itemId: "rpc_1", offeringRef: "plan:pro:monthly" }],
      effectiveIntent: { type: "IMMEDIATE" },
      acceptanceEnvelope: GENEROUS_ENVELOPE,
    });
    sim._debugWrongRatePlanOnNextOrder = "ratePlan_seat_basic_monthly"; // our order adds the basic plan against its dispatched pro swap
    const receipt = await adapter.commitChangeQuote(quote.id);
    assert.equal(receipt.reconciliation.status, "VIOLATED");
    assert.equal(receipt.status, "COMMITTED");
    assert.equal(sim.get(sub.id).version, 2, "the version advanced by exactly this order's +1 — attribution unbroken");
  }
});

test("Test 24.23 (Z1): an intervening change after our order lands, producing a mismatching state, is UNVERIFIED — never this commit's VIOLATED", async () => {
  // This is test 24.13's PRE-Z1 construction, reclassified: the
  // wrongness is injected by _debugMutateDirectly AFTER our order
  // landed — a different actor's change. It bumps the version
  // (2 -> 3), breaking the attribution chain, so the observed
  // contradiction cannot be assigned to this commit even though
  // the state genuinely contradicts intent. (Failing-first: at
  // f96b957 this exact construction returned COMMITTED /
  // COMMITTED_AND_VERIFIED / VIOLATED — probe Z1.)
  // Intervening wrong quantity.
  {
    const { sim, sub } = freshZuoraFixture();
    const adapter = new ZuoraAdapter(sim, new QuoteStore());
    const quote = await adapter.createChangeQuote(sub.id, {
      changes: [{ action: "CHANGE_QUANTITY", itemId: "rpc_1", quantity: 120 }],
      effectiveIntent: { type: "IMMEDIATE" },
      acceptanceEnvelope: GENEROUS_ENVELOPE,
    });
    const realCreateOrder = sim.createOrder.bind(sim);
    sim.createOrder = ((...args: Parameters<typeof realCreateOrder>) => {
      const out = realCreateOrder(...args);
      sim._debugMutateDirectly(sub.id, (s) => {
        s.ratePlans[0].ratePlanCharges[0].quantity = 130;
      });
      return out;
    }) as typeof realCreateOrder;
    const receipt = await adapter.commitChangeQuote(quote.id);
    assert.equal(receipt.status, "COMMITTED_UNVERIFIED");
    assert.equal(receipt.outcome, "COMMITTED_UNVERIFIED", "an unattributable contradiction is not a verified failure of this commit");
    assert.equal(receipt.reconciliation.status, "UNVERIFIED");
    assert.match(receipt.reconciliation.reason ?? "", /cannot be attributed to\s+it/);
    assert.match(receipt.reconciliation.reason ?? "", /unattributed context/, "the observed mismatch is recorded, as context, without assigning its cause");
    const order = sim.ordersFor(sub.id)[0];
    assert.equal(receipt.committedEffect.immediate?.net, order.netImmediate, "the immediate is still this commit's bound-order actual, read by id");
    assert.equal(receipt.committedEffect.immediate?.net, 20000);
    assert.equal(receipt.committedEffect.recurring?.resultingAmount, 130000, "the recurring figure reports the observed state — labeled unattributed by the reconciliation, not asserted as this commit's result");
  }
  // Intervening wrong rate plan.
  {
    const { sim, sub } = freshZuoraFixture();
    const adapter = new ZuoraAdapter(sim, new QuoteStore());
    const quote = await adapter.createChangeQuote(sub.id, {
      changes: [{ action: "CHANGE_PLAN", itemId: "rpc_1", offeringRef: "plan:pro:monthly" }],
      effectiveIntent: { type: "IMMEDIATE" },
      acceptanceEnvelope: GENEROUS_ENVELOPE,
    });
    const realCreateOrder = sim.createOrder.bind(sim);
    sim.createOrder = ((...args: Parameters<typeof realCreateOrder>) => {
      const out = realCreateOrder(...args);
      sim._debugMutateDirectly(sub.id, (s) => {
        s.ratePlans[0].ratePlanCharges[0].productRatePlanChargeId = "ratePlan_seat_basic_monthly";
      });
      return out;
    }) as typeof realCreateOrder;
    const receipt = await adapter.commitChangeQuote(quote.id);
    assert.equal(receipt.status, "COMMITTED_UNVERIFIED");
    assert.equal(receipt.reconciliation.status, "UNVERIFIED", "the pre-Z1 code returned VIOLATED here, assigning another actor's edit to this commit");
  }
  // The matching-state counterpart — an intervening change whose
  // final state happens to match intent — is test 24.12 (the
  // check->mutate window): also UNVERIFIED, never a verified OK.
});

test("Test 24.14 (P1): verification unavailable after a landed order — COMMITTED_UNVERIFIED recorded from the mutation response alone", async () => {
  const variants: Array<{ name: string; arm: (sim: ZuoraSim) => void }> = [
    { name: "order reads fail", arm: (sim) => { sim._debugFailOrderReads = true; } },
    { name: "persisted order carries no financial actuals", arm: (sim) => { sim._debugOmitOrderFinancials = true; } },
    { name: "subscription reads fail after the order lands", arm: (sim) => { sim._debugFailSubscriptionReadsAfterMutation = true; } },
  ];
  for (const { name, arm } of variants) {
    const { sim, sub } = freshZuoraFixture();
    const store = new QuoteStore();
    const adapter = new ZuoraAdapter(sim, store);
    const quote = await adapter.createChangeQuote(sub.id, {
      changes: [{ action: "CHANGE_QUANTITY", itemId: "rpc_1", quantity: 120 }],
      effectiveIntent: { type: "IMMEDIATE" },
      acceptanceEnvelope: GENEROUS_ENVELOPE,
    });
    arm(sim);
    // Recording the receipt must not throw even though every
    // post-commit read path is broken (PR #11 correction P1).
    const receipt = await adapter.commitChangeQuote(quote.id);
    assert.equal(receipt.status, "COMMITTED_UNVERIFIED", name);
    assert.equal(receipt.outcome, "COMMITTED_UNVERIFIED", name);
    assert.equal(receipt.reconciliation.status, "UNVERIFIED", `${name}: never a false OK`);
    assert.equal(receipt.committedEffect.provenance?.committedSource, "unestablished", name);
    assert.deepEqual(receipt.committedEffect.determinacy, {
      immediateFinancialEffect: "UNKNOWN",
      recurringFinancialEffect: "UNKNOWN",
    });
    assert.equal(receipt.committedEffect.immediate?.net, 20000, `${name}: the candidate figure is the mutation response's, labeled unestablished`);
    assert.equal(receipt.resultingSnapshot.version, "2", `${name}: the candidate snapshot's version is the mutation response's own version — data in hand, not a read`);
    // The audit sees the candidate for what it is.
    const audit = auditDeterminacy(quote.commercialEffect, receipt.committedEffect, "CHANGE_QUANTITY");
    assert.ok(audit.every((e) => e.findings.includes("WOULD_REFUSE_UNKNOWN")), name);
  }
});

// ---------------------------------------------------------------------------
// Outcome classes
// ---------------------------------------------------------------------------

test("Test 24.15: a lost order response is INDETERMINATE — no receipt, no blind retry, the landed order is not double-applied", async () => {
  const { sim, sub } = freshZuoraFixture();
  const store = new QuoteStore();
  const adapter = new ZuoraAdapter(sim, store);
  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [{ action: "CHANGE_QUANTITY", itemId: "rpc_1", quantity: 120 }],
    effectiveIntent: { type: "IMMEDIATE" },
    acceptanceEnvelope: GENEROUS_ENVELOPE,
  });
  sim._debugLoseNextOrderResponse = true; // the order applies and persists; only the response is lost
  await assert.rejects(
    () => adapter.commitChangeQuote(quote.id),
    (err: unknown) => {
      assert.ok(err instanceof SCQError);
      assert.equal((err.details as { outcome?: string })?.outcome, "INDETERMINATE");
      return true;
    }
  );
  assert.equal(store.get(quote.id)?.commit_outcome?.outcome, "INDETERMINATE");
  assert.equal(store.recordedReceipt(quote.id), undefined, "no receipt is invented for an unestablished landing");
  assert.equal(sim.ordersFor(sub.id).length, 1, "the order DID land — that is precisely why this is not a non-execution");
  assert.equal(sim.get(sub.id).ratePlans[0].ratePlanCharges[0].quantity, 120);

  await assert.rejects(
    () => adapter.commitChangeQuote(quote.id),
    (err: unknown) => {
      assert.ok(err instanceof SCQError);
      assert.equal((err.details as { outcome?: string })?.outcome, "INDETERMINATE");
      return true;
    }
  );
  assert.equal(sim.ordersFor(sub.id).length, 1, "the retry refusal issued no second order");
});

test("Test 24.16: a pre-effect rejection is CONFIRMED_NON_EXECUTION — distinguished from indeterminate, state untouched", async () => {
  const { sim, sub } = freshZuoraFixture();
  const store = new QuoteStore();
  const adapter = new ZuoraAdapter(sim, store);
  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [{ action: "CHANGE_QUANTITY", itemId: "rpc_1", quantity: 120 }],
    effectiveIntent: { type: "IMMEDIATE" },
    acceptanceEnvelope: GENEROUS_ENVELOPE,
  });
  const before = stateString(sim, sub.id);
  sim.createOrder = (() => {
    throw new ZuoraSimError("InvalidOrderAction", "Simulated pre-dispatch rejection (test double)");
  }) as typeof sim.createOrder;
  await assert.rejects(
    () => adapter.commitChangeQuote(quote.id),
    (err: unknown) => {
      assert.ok(err instanceof SCQError);
      assert.equal((err.details as { outcome?: string })?.outcome, "CONFIRMED_NON_EXECUTION");
      return true;
    }
  );
  assert.equal(store.get(quote.id)?.commit_outcome?.outcome, "CONFIRMED_NON_EXECUTION");
  assert.equal(store.recordedReceipt(quote.id), undefined);
  assert.equal(stateString(sim, sub.id), before, "provably nothing landed");
});

test("Test 24.17: revalidation drift beyond the envelope refuses with QUOTE_DRIFTED and zero orders", async () => {
  const { sim, sub } = freshZuoraFixture();
  const adapter = new ZuoraAdapter(sim, new QuoteStore());
  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [{ action: "CHANGE_QUANTITY", itemId: "rpc_1", quantity: 120 }],
    effectiveIntent: { type: "IMMEDIATE" },
    acceptanceEnvelope: ZERO_TOLERANCE_ENVELOPE,
  });
  // Simulate a provider whose commit-time re-preview moves (the
  // class of drift REVALIDATE exists to catch): the wrapper is
  // installed after quoting, so the FIRST preview it sees is the
  // commit's re-preview — doctor that one to report a higher
  // incurred figure for the same sequence.
  const realPreview = sim.previewOrder.bind(sim);
  let previewCalls = 0;
  sim.previewOrder = ((...args: Parameters<typeof realPreview>) => {
    previewCalls += 1;
    const result = realPreview(...args);
    if (previewCalls >= 1) return { ...result, netImmediate: result.netImmediate + 5000 };
    return result;
  }) as typeof realPreview;
  const before = stateString(sim, sub.id);
  await assert.rejects(
    () => adapter.commitChangeQuote(quote.id),
    (err: unknown) => err instanceof SCQError && err.code === "QUOTE_DRIFTED"
  );
  assert.equal(sim.ordersFor(sub.id).length, 0, "zero mutating calls on a drift refusal");
  assert.equal(stateString(sim, sub.id), before);
});

test("Test 24.18: stale version and quote expiration refuse with zero orders", async () => {
  // Stale (native version moved out-of-band) — Test 9h's scenario,
  // asserted here with the mutation count.
  {
    const { sim, sub } = freshZuoraFixture();
    const adapter = new ZuoraAdapter(sim, new QuoteStore());
    const quote = await adapter.createChangeQuote(sub.id, {
      changes: [{ action: "CHANGE_QUANTITY", itemId: "rpc_1", quantity: 120 }],
      effectiveIntent: { type: "IMMEDIATE" },
      guaranteeMode: "EXACT",
    });
    sim._debugMutateDirectly(sub.id, (s) => {
      s.ratePlans[0].ratePlanCharges[0].quantity = 150;
    });
    await assert.rejects(
      () => adapter.commitChangeQuote(quote.id),
      (err: unknown) => err instanceof SCQError && err.code === "QUOTE_STALE"
    );
    assert.equal(sim.ordersFor(sub.id).length, 0);
  }
  // Expired (stored record's TTL elapsed — re-put with a past
  // expiry, the store-level equivalent of the clock passing).
  {
    const { sim, sub } = freshZuoraFixture();
    const store = new QuoteStore();
    const adapter = new ZuoraAdapter(sim, store);
    const quote = await adapter.createChangeQuote(sub.id, {
      changes: [{ action: "CHANGE_QUANTITY", itemId: "rpc_1", quantity: 120 }],
      effectiveIntent: { type: "IMMEDIATE" },
      guaranteeMode: "EXACT",
    });
    const stored = store.get(quote.id)!;
    stored.expires_at = new Date(Date.now() - 1000).toISOString();
    store.put(stored);
    await assert.rejects(
      () => adapter.commitChangeQuote(quote.id),
      (err: unknown) => err instanceof SCQError && err.code === "QUOTE_EXPIRED"
    );
    assert.equal(sim.ordersFor(sub.id).length, 0);
  }
});

// ---------------------------------------------------------------------------
// Cancellation state verification (P3) and §6.10
// ---------------------------------------------------------------------------

test("Test 24.19 (P3): a future-dated cancellation verifies as SCHEDULED against the QUOTED date; a premature terminal state is a MISMATCH", async () => {
  const futureDate = new Date("2026-08-21T00:00:00Z").toISOString();
  // Correctly scheduled.
  {
    const { sim, sub } = freshZuoraFixture();
    const adapter = new ZuoraAdapter(sim, new QuoteStore());
    const quote = await adapter.createChangeQuote(sub.id, {
      changes: [{ action: "CANCEL" }],
      effectiveIntent: { type: "DATE", at: futureDate },
      acceptanceEnvelope: GENEROUS_ENVELOPE,
    });
    assert.equal(quote.commercialEffect.effectiveAt, "2026-08-21");
    const receipt = await adapter.commitChangeQuote(quote.id);
    assert.equal(receipt.status, "COMMITTED");
    assert.equal(receipt.reconciliation.status, "OK");
    assert.equal(receipt.resultingSnapshot.status, "active", "a future cancellation must NOT demand a terminal state now");
    assert.equal(receipt.resultingSnapshot.term?.autoRenew, false, "the schedule is nonetheless in effect");
    assert.equal(receipt.committedEffect.recurring?.resultingAmount, 0);
    assert.equal(receipt.committedEffect.provenance?.committedSource, "defined_equal_exact");
    assert.match(receipt.committedEffect.provenance?.recurring ?? "", /SCHEDULED/);
  }
  // Premature termination ATTRIBUTABLE to this commit: OUR order
  // itself terminates the subscription NOW instead of at the
  // quoted future date (the sim's misexecution hook — the version
  // advances by exactly our order's +1 and the bound order's
  // identity/chain verify, so the mis-dated termination is provably
  // this commit's own).
  //
  // REQUIRED REWORK (PR #14 review correction Z2): this case
  // previously produced the terminal state via _debugMutateDirectly
  // AFTER the order landed — another actor's change, which breaks
  // attribution. That construction is the third case below and is
  // now UNVERIFIED; it was a verified VIOLATED at f96b957 only
  // because the cancel path never checked attribution at all.
  {
    const { sim, sub } = freshZuoraFixture();
    const adapter = new ZuoraAdapter(sim, new QuoteStore());
    const quote = await adapter.createChangeQuote(sub.id, {
      changes: [{ action: "CANCEL" }],
      effectiveIntent: { type: "DATE", at: futureDate },
      acceptanceEnvelope: GENEROUS_ENVELOPE,
    });
    sim._debugCancelEffectiveNowOnNextOrder = true; // our cancel order terminates immediately, against its quoted 2026-08-21 date
    const receipt = await adapter.commitChangeQuote(quote.id);
    assert.equal(receipt.status, "COMMITTED");
    assert.equal(receipt.outcome, "COMMITTED_AND_VERIFIED");
    assert.equal(receipt.reconciliation.status, "VIOLATED", "a premature termination attributable to this commit is a determined contradiction, not a verified schedule");
    assert.equal(receipt.committedEffect.recurring?.resultingAmount, 100000, "the committed figure reports the observed state, not a fabricated post-cancel zero");
    assert.equal(sim.get(sub.id).version, 2, "the version advanced by exactly this order's +1 — attribution unbroken");
  }
  // Premature terminal state produced by an INTERVENING actor: our
  // order scheduled the cancellation correctly at the quoted date,
  // then another actor's change forced the terminal state (and
  // bumped the version). The observed state contradicts the quoted
  // schedule, but it cannot be attributed to this commit — the
  // outcome is attribution-uncertain, NOT a verified VIOLATED.
  {
    const { sim, sub } = freshZuoraFixture();
    const adapter = new ZuoraAdapter(sim, new QuoteStore());
    const quote = await adapter.createChangeQuote(sub.id, {
      changes: [{ action: "CANCEL" }],
      effectiveIntent: { type: "DATE", at: futureDate },
      acceptanceEnvelope: GENEROUS_ENVELOPE,
    });
    const realCreateOrder = sim.createOrder.bind(sim);
    sim.createOrder = ((...args: Parameters<typeof realCreateOrder>) => {
      const out = realCreateOrder(...args);
      sim._debugMutateDirectly(sub.id, (s) => {
        s.status = "Cancelled";
      });
      return out;
    }) as typeof realCreateOrder;
    const receipt = await adapter.commitChangeQuote(quote.id);
    assert.equal(receipt.status, "COMMITTED_UNVERIFIED");
    assert.equal(receipt.outcome, "COMMITTED_UNVERIFIED", "an unattributable contradiction is not a verified failure of this commit");
    assert.equal(receipt.reconciliation.status, "UNVERIFIED");
    assert.match(receipt.reconciliation.reason ?? "", /cannot be attributed to this commit/);
  }
});

test("Test 24.24 (Z2): an intervening ORDER after our cancel order — cancellation state matches, chain broken — is UNVERIFIED, never a verified OK", async () => {
  const { sim, sub } = freshZuoraFixture();
  const adapter = new ZuoraAdapter(sim, new QuoteStore());
  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [{ action: "CANCEL" }],
    effectiveIntent: { type: "DATE", at: new Date("2026-08-21T00:00:00Z").toISOString() },
    acceptanceEnvelope: GENEROUS_ENVELOPE,
  });
  // Another actor's ORDER lands strictly after our cancel order:
  // a quantity change that leaves the cancellation fields exactly
  // as quoted (cancelledDate 2026-08-21, still Active). The
  // cancel-relevant state matches the quoted schedule perfectly —
  // but the version chain is broken (our order produced version 2,
  // the re-read is at 3) and the latest order is not ours, so the
  // observed cancellation cannot be attributed to this commit
  // alone. (Failing-first: at f96b957 this returned COMMITTED /
  // COMMITTED_AND_VERIFIED / OK — probe Z2 — because the cancel
  // path never read the bound order or the version chain.)
  const realCreateOrder = sim.createOrder.bind(sim);
  let injected = false;
  sim.createOrder = ((...args: Parameters<typeof realCreateOrder>) => {
    const out = realCreateOrder(...args);
    if (!injected) {
      injected = true;
      realCreateOrder(sub.id, [
        { type: "UpdateProduct", effectiveDate: "2026-08-01", ratePlanId: "rp_1", productRatePlanChargeId: "rpc_1", quantity: 130 },
      ]);
    }
    return out;
  }) as typeof realCreateOrder;
  const receipt = await adapter.commitChangeQuote(quote.id);
  assert.equal(sim.ordersFor(sub.id).length, 2, "our cancel order plus the intervening order");
  assert.equal(receipt.status, "COMMITTED_UNVERIFIED");
  assert.equal(receipt.outcome, "COMMITTED_UNVERIFIED", "a matching cancellation state under a broken chain is not a verified success of this commit");
  assert.equal(receipt.reconciliation.status, "UNVERIFIED");
  assert.match(receipt.reconciliation.reason ?? "", /cannot be attributed to this commit/);
  assert.equal(receipt.committedEffect.provenance?.committedSource, "unestablished");
  assert.deepEqual(receipt.committedEffect.determinacy, {
    immediateFinancialEffect: "UNKNOWN",
    recurringFinancialEffect: "UNKNOWN",
  });
});

test("Test 24.25 (Z2): the bound order unreadable — pure CANCEL records COMMITTED_UNVERIFIED from data in hand, never OK/VIOLATED", async () => {
  const { sim, sub } = freshZuoraFixture();
  const adapter = new ZuoraAdapter(sim, new QuoteStore());
  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [{ action: "CANCEL" }],
    effectiveIntent: { type: "TERM_END" },
    acceptanceEnvelope: GENEROUS_ENVELOPE,
  });
  sim._debugFailOrderReads = true; // the persisted order cannot be read back at all
  const receipt = await adapter.commitChangeQuote(quote.id);
  assert.equal(receipt.status, "COMMITTED_UNVERIFIED");
  assert.equal(receipt.outcome, "COMMITTED_UNVERIFIED");
  assert.equal(receipt.reconciliation.status, "UNVERIFIED", "without the bound order there is nothing to bind the verification to");
  assert.match(receipt.reconciliation.reason ?? "", /could not be read back/);
  assert.equal(receipt.committedEffect.provenance?.committedSource, "unestablished", "the candidate is built from the mutation response and the stored quote — no further reads (P1)");
  assert.deepEqual(receipt.committedEffect.determinacy, {
    immediateFinancialEffect: "UNKNOWN",
    recurringFinancialEffect: "UNKNOWN",
  });
  // The cancellation DID land in the provider record — the
  // unverified classification is about attribution/evidence, not
  // about doubting the mutation's response.
  sim._debugFailOrderReads = false;
  assert.equal(sim.ordersFor(sub.id).length, 1);
  assert.equal(sim.get(sub.id).cancelledDate, quote.commercialEffect.effectiveAt);
});

test("Test 24.20 (§6.10): replay returns the ORIGINAL receipt even after a later verification transition", async () => {
  const { sim, sub } = freshZuoraFixture();
  const store = new QuoteStore();
  const adapter = new ZuoraAdapter(sim, store);
  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [{ action: "CHANGE_QUANTITY", itemId: "rpc_1", quantity: 120 }],
    effectiveIntent: { type: "IMMEDIATE" },
    acceptanceEnvelope: GENEROUS_ENVELOPE,
  });
  sim._debugFailOrderReads = true;
  const first = await adapter.commitChangeQuote(quote.id);
  assert.equal(first.status, "COMMITTED_UNVERIFIED");

  const replay = await adapter.commitChangeQuote(quote.id);
  assert.deepEqual(replay, first, "§6.10: a repeated commit returns the original recorded receipt");

  // Deferred verification via the PR-1 machinery, from an
  // independent post-commit observation (SYNTHETIC — built here
  // from the test's own simulator reads; the branded token is not
  // treated as proof the observation came from a provider).
  sim._debugFailOrderReads = false;
  const order = sim.ordersFor(sub.id)[0];
  const snapshot = await adapter.getSubscription(sub.id);
  const evidence = establishVerification(store.get(quote.id)!, {
    subscriptionRef: sub.id,
    committedEffect: {
      immediate: { net: order.netImmediate },
      recurring: { resultingAmount: 120000, currency: "usd" },
      determinacy: { immediateFinancialEffect: "DETERMINED", recurringFinancialEffect: "DETERMINED" },
      provenance: {
        immediate: "persisted order read back from the simulator (synthetic observation)",
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

  const replayAfterVerify = await adapter.commitChangeQuote(quote.id);
  assert.deepEqual(replayAfterVerify, first, "replay STILL returns the originally recorded (unverified) receipt");
  assert.equal(store.get(quote.id)?.commit_receipt?.reconciliation.status, "OK", "the verified state is visible only through the current view");
});

test("Test 24.21: order atomicity and precondition honesty coexist on one receipt; snapshot determinacy is labeled", async () => {
  const { sim, sub } = freshZuoraFixture();
  const adapter = new ZuoraAdapter(sim, new QuoteStore());
  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [
      { action: "CHANGE_QUANTITY", itemId: "rpc_1", quantity: 110 },
      { action: "CANCEL" },
    ],
    effectiveIntent: { type: "TERM_END" },
    acceptanceEnvelope: GENEROUS_ENVELOPE,
  });
  const receipt = await adapter.commitChangeQuote(quote.id);
  assert.equal(receipt.status, "COMMITTED");
  // The ORDER was atomic (one order, one version bump for both
  // actions — the provider operation's property, as the sim
  // establishes it)...
  assert.equal(receipt.multiChangeConsistency, "ATOMIC");
  assert.equal(sim.ordersFor(sub.id).length, 1);
  assert.equal(receipt.resultingSnapshot.version, "2", "exactly one version bump for the whole bundled order");
  // ...while SCQ's own precondition check + mutation sequence
  // remains a separate-calls race, reported honestly.
  assert.equal(receipt.consistencyGuarantee, "BEST_EFFORT");
  assert.equal(receipt.resultingSnapshot.billing.recurringAmountState, "DETERMINED", "CORE-7: snapshot figures carry their determinacy label");
});

test("Test 24.22: the determinacy audit is clean for a normal verified quote/commit pair", async () => {
  const { sim, sub } = freshZuoraFixture();
  const adapter = new ZuoraAdapter(sim, new QuoteStore());
  const quote = await adapter.createChangeQuote(sub.id, {
    changes: [{ action: "CHANGE_QUANTITY", itemId: "rpc_1", quantity: 120 }],
    effectiveIntent: { type: "IMMEDIATE" },
    acceptanceEnvelope: GENEROUS_ENVELOPE,
  });
  const receipt = await adapter.commitChangeQuote(quote.id);
  const audit = auditDeterminacy(quote.commercialEffect, receipt.committedEffect, "CHANGE_QUANTITY");
  assert.ok(audit.every((e) => e.findings.length === 0), `audit must be clean, got ${JSON.stringify(audit)}`);
});

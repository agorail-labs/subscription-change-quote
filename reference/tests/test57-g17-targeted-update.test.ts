/**
 * Test 57 — SCQ G-17 prototype: authorization-preserving Chargebee
 * (renumbered from test53 per G17-R7: main already carries the
 * G-08 test53 family; G-17's family is test57 / Test 57.x so every
 * persistent test ID stays unique)
 * updates via a minimal additive dispatch (Issue #30, Phase 2/4).
 *
 * What is under test: an ISOLATED prototype
 * (src/live/pilot/g17-targeted-update.ts) that sends
 * `update_for_items` with `replace_items_list=false` and ONLY the
 * authorized target item, against a stateful mock
 * (src/live/pilot/g17-mock-transport.ts) whose rules are labeled
 * DOCUMENTED (D1–D6) or ASSUMED (A1–A2) in the mock's header. The
 * live adapter is NOT modified by this work — 57.4 pins that its
 * capability and its full-replacement builder are unchanged.
 *
 * The adversarial matrix follows Issue #30's T0/T1/T2/T3/T4 threat
 * model: T0 quote-time snapshot, T1 external change, T2
 * pre-dispatch re-read, T3 candidate dispatch, T4 independent
 * re-read. A candidate mechanism FAILS preservation if it silently
 * changes state outside the authorized operation; the tests exercise
 * the actual wire behavior of the mock (57.19 reproduces the
 * Issue #22 Finding 1 deletion under the CURRENT full-replacement
 * wire shape on this same mock, proving the harness can detect the
 * failure it claims to detect).
 *
 * Evidence class: SIMULATED throughout. The CHANGE_QUANTITY runs
 * additionally depend on ASSUMED rule A1 (same-ID update-in-place);
 * 57.5–57.7 run the identical wire request under the other
 * documented-plausible same-ID behaviors and show the outcome does
 * not survive them — which is why the research package keeps G-17
 * OPEN and recommends vendor clarification before any adapter
 * change.
 *
 * CORRECTION ROUND (independent review of PR #38 @ ecc3ff5,
 * findings G17-R1..R4 — see research package §10):
 *  R1. ADD_ADDON is a PROVIDER operation class, not an SCQ action
 *      (core/types.ts ChangeAction has no ADD_ADDON; pinned by
 *      57.31). Its positive result demonstrates provider capability
 *      only.
 *  R2. `resource_version` is a millisecond timestamp, not a counter.
 *      The mock now stamps it from a controllable clock (same-ms
 *      collisions included); the executor no longer classifies on
 *      any delta. CHANGE_QUANTITY's verdict ceiling is
 *      PRESERVATION_UNVERIFIABLE even on its happiest path (57.2),
 *      because an overwritten same-item interleaving is
 *      observationally indistinguishable from a clean run.
 *  R3. Schedule history is unverifiable from the T4 flag: 57.24 is
 *      now an explicit negative test — a schedule created after T2
 *      at the same timestamp is deleted by the dispatch and leaves
 *      T4 identical to baseline; the verdict is item-scoped only.
 *  R4. Positive classifications are ITEM_PRESERVED_* and every
 *      verdict carries scope MOCK_VISIBLE_ITEM_SUBSET_ONLY, the
 *      unobservable-dimensions list, and interleavingExcluded:
 *      false. 57.35 is the collateral-effect counterexample (a
 *      coupon silently dropped by the update does not change the
 *      item verdict — because the verdict never covered coupons).
 *
 * SECOND CORRECTION ROUND (independent re-review @ 90e289f,
 * findings G17-R5..R7 — research package §11):
 *  R5. The prototype is mock-only BY CONSTRUCTION: its constructor
 *      accepts only a G17MockChargebee and builds its own client
 *      over the mock transport. A default/real ChargebeeClient is
 *      ineligible (57.37, zero network requests).
 *  R6. Missing provider evidence fails closed: absent subscription
 *      id, foreign id in both reads, missing scheduling flags,
 *      present scheduled advance invoices, and missing item
 *      identity/amount fields all refuse BEFORE any POST
 *      (57.38–57.43, zero mutating calls asserted in each).
 *  R7. This family is test57 (see the renumber note above).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ChargebeeClient } from "../src/live/chargebee-http.js";
import { ChargebeeLiveAdapter, buildChargebeeUpdateParams } from "../src/live/chargebee-scq-adapter.js";
import { QuoteStore } from "../src/store/quote-store.js";
import {
  G17MockChargebee,
  G17_SUBSCRIPTION_ID,
  G17_PLAN_MONTHLY,
  G17_PLAN_PRO_MONTHLY,
  G17_PLAN_YEARLY,
  G17_ADDON_SEATS,
  G17_ADDON_SUPPORT,
  G17_ADDON_STORAGE,
  G17_ADDON_MANDATORY,
  G17_ADDON_EXTERNAL,
  G17_COUPON_WELCOME,
  type G17MockOptions,
} from "../src/live/pilot/g17-mock-transport.js";
import {
  G17TargetedUpdatePrototype,
  G17_UNOBSERVABLE_DIMENSIONS,
  SCQ_CHANGE_ACTIONS,
  buildTargetedUpdateParams,
  snapshotFromSubscriptionJson,
  type G17Operation,
  type G17Prepared,
} from "../src/live/pilot/g17-targeted-update.js";

const KEY = "g17-test-idempotency-key";

function setup(options: G17MockOptions = {}) {
  const mock = new G17MockChargebee(options);
  const client = new ChargebeeClient({ site: "g17-test", apiKey: "g17-mock-key" }, mock.transport);
  // G17-R5: the prototype takes the MOCK, never a client — it builds
  // its own client over the mock transport by construction.
  const proto = new G17TargetedUpdatePrototype(mock, G17_SUBSCRIPTION_ID);
  return { mock, client, proto };
}

/** A clean T0 snapshot from a well-formed mock, for negative tests
 * whose fault lives in a second mock's reads. */
async function cleanT0() {
  const { proto } = setup();
  return proto.readSnapshot();
}

const ADD_STORAGE: G17Operation = { kind: "ADD_ADDON", itemPriceId: G17_ADDON_STORAGE, quantity: 3 };
const SEATS_TO_21: G17Operation = { kind: "CHANGE_QUANTITY", itemPriceId: G17_ADDON_SEATS, quantity: 21 };

async function staged(proto: G17TargetedUpdatePrototype, op: G17Operation) {
  const t0 = await proto.readSnapshot();
  const prepared = await proto.prepare(op, t0, KEY);
  return { t0, prepared };
}

// ------------------------------------------------------------------
// Positive paths + wire shape
// ------------------------------------------------------------------

test("Test 57.1 (G-17): ADD_ADDON of a new item via additive dispatch — item subset observed preserved (DOCUMENTED additive semantics, SIMULATED; scope-corrected per G17-R1/R4)", async () => {
  const { mock, proto } = setup();
  const t0 = await proto.readSnapshot();
  const verdict = await proto.execute(ADD_STORAGE, t0, KEY);
  assert.equal(verdict.classification, "ITEM_PRESERVED_OBSERVED");
  assert.equal(verdict.evidence, "SIMULATED");
  assert.equal(verdict.scope, "MOCK_VISIBLE_ITEM_SUBSET_ONLY", "G17-R4: the verdict speaks for the visible item subset only, never for preservation in general");
  assert.equal(verdict.interleavingExcluded, false, "G17-R2/R3: interleaving is never excluded by this prototype");
  assert.equal(verdict.inScqActionSchema, false, "G17-R1: ADD_ADDON is a provider operation class, NOT an SCQ ChangeAction");
  const update = mock.calls.find((c) => c.mutating)!;
  assert.equal(update.replaceItemsList, false, "the wire dispatch is additive, never replacement");
  assert.deepEqual(update.itemPriceIds, [G17_ADDON_STORAGE], "the wire payload names ONLY the authorized target item");
  const items = mock.peekItems();
  assert.deepEqual(items, [
    { item_price_id: G17_PLAN_MONTHLY, quantity: 1 },
    { item_price_id: G17_ADDON_SEATS, quantity: 1 },
    { item_price_id: G17_ADDON_SUPPORT, quantity: 2 },
    { item_price_id: G17_ADDON_STORAGE, quantity: 3 },
  ]);
});

test("Test 57.2 (G-17): CHANGE_QUANTITY lands the absolute target under ASSUMED A1 — but the verdict ceiling is PRESERVATION_UNVERIFIABLE (G17-R2: an overwritten same-item interleaving is indistinguishable from this clean run)", async () => {
  const { mock, proto } = setup();
  const t0 = await proto.readSnapshot();
  const verdict = await proto.execute(SEATS_TO_21, t0, KEY);
  assert.equal(verdict.classification, "PRESERVATION_UNVERIFIABLE", "the target state is observed in effect, yet timestamp-only evidence cannot exclude a same-item interleaving — no verified claim is made");
  assert.match(verdict.details.join(" "), /CEILING \(G17-R2\)/);
  assert.equal(verdict.inScqActionSchema, true, "CHANGE_QUANTITY IS an SCQ ChangeAction — and it remains unproven");
  const update = mock.calls.find((c) => c.mutating)!;
  assert.equal(update.replaceItemsList, false);
  assert.deepEqual(update.itemPriceIds, [G17_ADDON_SEATS]);
  assert.deepEqual(mock.peekItems(), [
    { item_price_id: G17_PLAN_MONTHLY, quantity: 1 },
    { item_price_id: G17_ADDON_SEATS, quantity: 21 },
    { item_price_id: G17_ADDON_SUPPORT, quantity: 2 },
  ], "the mock state DID land exactly as authorized — the ceiling is an evidence limit, not an outcome failure");
});

test("Test 57.3 (G-17): the targeted builder emits a minimal payload — target item only, replace_items_list=false, no plan, no retained set", () => {
  const params = buildTargetedUpdateParams(SEATS_TO_21) as any;
  assert.equal(params.replace_items_list, false);
  assert.equal(params.invoice_immediately, false);
  assert.deepEqual(params.subscription_items, [{ item_price_id: G17_ADDON_SEATS, quantity: 21 }]);
  assert.ok(!JSON.stringify(params).includes(G17_PLAN_MONTHLY), "the plan is never named in a targeted payload");
});

test("Test 57.4 (G-17): the LIVE adapter is unchanged — capability still FULL_REPLACEMENT_ONLY and its builder still sends replace_items_list=true", () => {
  const params = buildChargebeeUpdateParams([{ itemPriceId: G17_ADDON_SEATS, quantity: 21 }]) as any;
  assert.equal(params.replace_items_list, true, "the production dispatch remains full replacement; the prototype did not touch it");
  const mock = new G17MockChargebee();
  const client = new ChargebeeClient({ site: "g17-test", apiKey: "g17-mock-key" }, mock.transport);
  const adapter = new ChargebeeLiveAdapter(client, new QuoteStore(), {});
  assert.equal(adapter.mutationCapability, "FULL_REPLACEMENT_ONLY");
});

// ------------------------------------------------------------------
// ASSUMED-semantics dependence: the same wire request, other
// provider behaviors the docs do not exclude.
// ------------------------------------------------------------------

test("Test 57.5 (G-17): same wire request under duplicate-entry same-ID behavior -> PRESERVATION_VIOLATED", async () => {
  const { proto } = setup({ sameIdBehavior: "duplicate_entry" });
  const verdict = await proto.execute(SEATS_TO_21, await proto.readSnapshot(), KEY);
  assert.equal(verdict.classification, "PRESERVATION_VIOLATED");
  assert.match(verdict.details.join(" "), /appears 2 times/);
});

test("Test 57.6 (G-17): same wire request under quantity-summed same-ID behavior -> PRESERVATION_VIOLATED (financial effect exceeds authorization)", async () => {
  const { proto } = setup({ sameIdBehavior: "quantity_summed" });
  const verdict = await proto.execute(SEATS_TO_21, await proto.readSnapshot(), KEY);
  assert.equal(verdict.classification, "PRESERVATION_VIOLATED");
  assert.match(verdict.details.join(" "), /SUMMED/);
});

test("Test 57.7 (G-17): same wire request under reject same-ID behavior -> DISPATCH_REJECTED and provider state unchanged", async () => {
  const { mock, proto } = setup({ sameIdBehavior: "reject" });
  const before = mock.peekItems();
  const verdict = await proto.execute(SEATS_TO_21, await proto.readSnapshot(), KEY);
  assert.equal(verdict.classification, "DISPATCH_REJECTED");
  assert.equal(mock.mutationCount, 1, "exactly one dispatch was attempted");
  assert.deepEqual(mock.peekItems(), before, "the rejection applied no state");
});

// ------------------------------------------------------------------
// Unsupported operation classes fail closed, zero transport calls.
// ------------------------------------------------------------------

for (const [name, op] of [
  ["REMOVE_ADDON", { kind: "REMOVE_ADDON", itemPriceId: G17_ADDON_SUPPORT } as G17Operation],
  ["CHANGE_PLAN", { kind: "CHANGE_PLAN", itemPriceId: G17_PLAN_PRO_MONTHLY } as G17Operation],
  ["CHANGE_CADENCE", { kind: "CHANGE_CADENCE", itemPriceId: G17_PLAN_YEARLY } as G17Operation],
  ["CANCEL", { kind: "CANCEL" } as G17Operation],
] as const) {
  test(`Test 57.8-11 (G-17): ${name} is unsupported by the prototype and fails closed before ANY transport call`, async () => {
    const { mock, proto } = setup();
    const t0 = await proto.readSnapshot();
    const callsAfterT0 = mock.calls.length;
    const verdict = await proto.execute(op, t0, KEY);
    assert.equal(verdict.classification, "REFUSED_UNSUPPORTED_OPERATION");
    assert.equal(verdict.dispatched, false);
    assert.equal(mock.calls.length, callsAfterT0, "not even a re-read is needed: the refusal precedes transport");
    assert.equal(mock.mutationCount, 0);
  });
}

test("Test 57.12 (G-17): class mismatches fail closed — ADD_ADDON of an existing item and CHANGE_QUANTITY of an absent item", async () => {
  const { mock, proto } = setup();
  const t0 = await proto.readSnapshot();
  const v1 = await proto.execute({ kind: "ADD_ADDON", itemPriceId: G17_ADDON_SEATS, quantity: 1 }, t0, KEY);
  assert.equal(v1.classification, "REFUSED_UNSUPPORTED_OPERATION");
  const v2 = await proto.execute({ kind: "CHANGE_QUANTITY", itemPriceId: G17_ADDON_STORAGE, quantity: 5 }, t0, KEY);
  assert.equal(v2.classification, "REFUSED_UNSUPPORTED_OPERATION");
  assert.equal(mock.mutationCount, 0);
});

// ------------------------------------------------------------------
// T1 before T2: drift refusals (scenarios 1a, 2a, 3a, 6a, 5a).
// Every refusal must show ZERO mutating calls.
// ------------------------------------------------------------------

test("Test 57.13 (G-17 scenario 1a): another actor adds an addon after the quote (before T2) -> REFUSED_PRE_DISPATCH_DRIFT, zero dispatches", async () => {
  const { mock, proto } = setup();
  const t0 = await proto.readSnapshot();
  mock.externalAddItem(G17_ADDON_EXTERNAL, 1);
  const verdict = await proto.execute(SEATS_TO_21, t0, KEY);
  assert.equal(verdict.classification, "REFUSED_PRE_DISPATCH_DRIFT");
  assert.equal(mock.mutationCount, 0, "financial basis changed with the new addon; dispatching on the stale quote is refused even though additive dispatch would not delete the new item");
});

test("Test 57.14 (G-17 scenario 2a): another actor modifies the SAME item's quantity after the quote -> REFUSED_PRE_DISPATCH_DRIFT, zero dispatches", async () => {
  const { mock, proto } = setup();
  const t0 = await proto.readSnapshot();
  mock.externalSetQuantity(G17_ADDON_SEATS, 5);
  const verdict = await proto.execute(SEATS_TO_21, t0, KEY);
  assert.equal(verdict.classification, "REFUSED_PRE_DISPATCH_DRIFT");
  assert.equal(mock.mutationCount, 0);
});

test("Test 57.15 (G-17 scenario 3a): an item is removed after the quote -> REFUSED_PRE_DISPATCH_DRIFT, zero dispatches", async () => {
  const { mock, proto } = setup();
  const t0 = await proto.readSnapshot();
  mock.externalRemoveItem(G17_ADDON_SUPPORT);
  const verdict = await proto.execute(ADD_STORAGE, t0, KEY);
  assert.equal(verdict.classification, "REFUSED_PRE_DISPATCH_DRIFT");
  assert.equal(mock.mutationCount, 0);
});

test("Test 57.16 (G-17 scenario 6a): plan/currency changes after the quote -> REFUSED_PRE_DISPATCH_DRIFT, zero dispatches", async () => {
  const { mock, proto } = setup();
  const t0 = await proto.readSnapshot();
  mock.externalChangePlan(G17_PLAN_YEARLY, "EUR");
  const verdict = await proto.execute(SEATS_TO_21, t0, KEY);
  assert.equal(verdict.classification, "REFUSED_PRE_DISPATCH_DRIFT");
  assert.match(verdict.details.join(" "), /currency differs/);
  assert.equal(mock.mutationCount, 0);
});

test("Test 57.17 (G-17 scenario 5a): a scheduled change exists at T2 -> REFUSED_SCHEDULED_CHANGE_AT_RISK, zero dispatches, schedule untouched", async () => {
  const { mock, proto } = setup();
  mock.externalScheduleChange();
  const t0 = await proto.readSnapshot();
  const verdict = await proto.execute(SEATS_TO_21, t0, KEY);
  assert.equal(verdict.classification, "REFUSED_SCHEDULED_CHANGE_AT_RISK");
  assert.equal(mock.mutationCount, 0);
  assert.equal(mock.peekHasScheduledChanges(), true, "the refusal leaves the schedule exactly as found — dispatching would have deleted it (documented D4)");
});

// ------------------------------------------------------------------
// Race window T2 -> T3: staged prepare/dispatch/verify.
// ------------------------------------------------------------------

test("Test 57.18 (G-17 scenario 1b): another actor adds an addon BETWEEN T2 and T3 -> additive dispatch preserves it in the item subset (ITEM_PRESERVED_WITH_CONCURRENT_CHANGE)", async () => {
  const { mock, proto } = setup();
  const { prepared } = await staged(proto, ADD_STORAGE);
  mock.externalAddItem(G17_ADDON_EXTERNAL, 1);
  const outcome = await proto.dispatch(prepared);
  assert.equal(outcome.ok, true);
  const verdict = await proto.verify(prepared);
  assert.equal(verdict.classification, "ITEM_PRESERVED_WITH_CONCURRENT_CHANGE");
  assert.equal(verdict.scope, "MOCK_VISIBLE_ITEM_SUBSET_ONLY");
  assert.ok(mock.peekItems().some((i) => i.item_price_id === G17_ADDON_EXTERNAL && i.quantity === 1), "the concurrent addon survived the dispatch intact");
  assert.ok(mock.peekItems().some((i) => i.item_price_id === G17_ADDON_STORAGE && i.quantity === 3), "the authorized change also landed");
});

test("Test 57.19 (G-17 control): the SAME interleaving under the CURRENT full-replacement wire shape deletes the concurrent addon (Issue #22 Finding 1 reproduced on this mock)", async () => {
  const { mock, client, proto } = setup();
  await proto.readSnapshot();
  mock.externalAddItem(G17_ADDON_EXTERNAL, 1);
  // The production builder's shape: quote-time full list, replace=true.
  const params = buildChargebeeUpdateParams([
    { itemPriceId: G17_PLAN_MONTHLY, quantity: 1 },
    { itemPriceId: G17_ADDON_SEATS, quantity: 21 },
    { itemPriceId: G17_ADDON_SUPPORT, quantity: 2 },
  ]);
  await client.updateForItems(G17_SUBSCRIPTION_ID, params, "g17-control-key");
  assert.ok(!mock.peekItems().some((i) => i.item_price_id === G17_ADDON_EXTERNAL), "full replacement silently deleted the concurrently added addon — the harness detects the failure the prototype is designed to avoid");
});

test("Test 57.20 (G-17 scenario 2b): another actor modifies the SAME item's quantity between T2 and T3 -> PRESERVATION_UNVERIFIABLE, and the T4 state is identical to the clean run in 57.2 (that identity is the G17-R2 point)", async () => {
  const { mock, proto } = setup();
  const { prepared } = await staged(proto, SEATS_TO_21);
  mock.externalSetQuantity(G17_ADDON_SEATS, 5);
  await proto.dispatch(prepared);
  const verdict = await proto.verify(prepared);
  assert.equal(verdict.classification, "PRESERVATION_UNVERIFIABLE");
  assert.match(verdict.details.join(" "), /CEILING \(G17-R2\)/);
  assert.ok(mock.peekItems().some((i) => i.item_price_id === G17_ADDON_SEATS && i.quantity === 21), "the dispatch overwrote the interleaved quantity 5 with the authorized 21 — and no T4 evidence can distinguish this history from 57.2's clean run");
});

test("Test 57.21 (G-17 scenario 3b): an unrelated item is removed between T2 and T3 -> PRESERVATION_VIOLATED (a missing item cannot be attributed away)", async () => {
  const { mock, proto } = setup();
  const { prepared } = await staged(proto, SEATS_TO_21);
  mock.externalRemoveItem(G17_ADDON_SUPPORT);
  await proto.dispatch(prepared);
  const verdict = await proto.verify(prepared);
  assert.equal(verdict.classification, "PRESERVATION_VIOLATED");
  assert.match(verdict.details.join(" "), /g17-addon-support is missing/);
});

test("Test 57.22 (G-17 scenario 4a): a mandatory addon attached between T2 and T3 survives the additive dispatch (ITEM_PRESERVED_WITH_CONCURRENT_CHANGE)", async () => {
  const { mock, proto } = setup();
  const { prepared } = await staged(proto, ADD_STORAGE);
  mock.externalAddItem(G17_ADDON_MANDATORY, 1, { mandatory: true });
  await proto.dispatch(prepared);
  const verdict = await proto.verify(prepared);
  assert.equal(verdict.classification, "ITEM_PRESERVED_WITH_CONCURRENT_CHANGE");
  assert.ok(mock.peekItems().some((i) => i.item_price_id === G17_ADDON_MANDATORY));
  assert.ok(mock.peekItems().some((i) => i.item_price_id === G17_ADDON_STORAGE && i.quantity === 3));
});

test("Test 57.23 (G-17 scenario 4b): a mandatory addon present at T2 disappears by T4 -> PRESERVATION_VIOLATED", async () => {
  const { mock, proto } = setup();
  mock.externalAddItem(G17_ADDON_MANDATORY, 1, { mandatory: true });
  const { prepared } = await staged(proto, SEATS_TO_21);
  mock.externalRemoveItem(G17_ADDON_MANDATORY);
  await proto.dispatch(prepared);
  const verdict = await proto.verify(prepared);
  assert.equal(verdict.classification, "PRESERVATION_VIOLATED");
});

test("Test 57.24 (G-17 scenario 5b, NEGATIVE test per G17-R3): a scheduled change created between T2 and T3 at the SAME timestamp is DELETED by the dispatch (documented D4) and leaves T4 IDENTICAL to the no-schedule baseline — the item verdict cannot see it and must not claim to", async () => {
  const { mock, proto } = setup();
  const { prepared } = await staged(proto, ADD_STORAGE);
  // No clock advance anywhere in this test: the schedule's creation,
  // the dispatch, and the T4 read all share one millisecond
  // timestamp, so not even the version distinguishes this history
  // from a world where the schedule never existed.
  mock.externalScheduleChange();
  assert.equal(mock.peekHasScheduledChanges(), true);
  await proto.dispatch(prepared);
  assert.equal(mock.peekHasScheduledChanges(), false, "the update deleted the concurrently created scheduled change, exactly as the vendor docs describe for Ramps-disabled sites");
  const verdict = await proto.verify(prepared);
  assert.equal(verdict.classification, "ITEM_PRESERVED_OBSERVED", "the ITEM subset is genuinely as authorized — the failure is in what the verdict cannot cover, not in the items");
  assert.equal(verdict.scope, "MOCK_VISIBLE_ITEM_SUBSET_ONLY");
  assert.match(verdict.details.join(" "), /scheduled-change HISTORY is unverifiable/, "the verdict itself declares the destroyed schedule outside its evidence");
  assert.ok(verdict.unobservableDimensions.some((d) => d.includes("scheduled-change history")), "the unverifiable schedule dimension travels with the verdict (G17-R3)");
});

test("Test 57.25 (G-17 scenario 6b): plan/cadence changes between T2 and T3 -> PRESERVATION_VIOLATED at T4", async () => {
  const { mock, proto } = setup();
  const { prepared } = await staged(proto, SEATS_TO_21);
  mock.externalChangePlan(G17_PLAN_YEARLY);
  await proto.dispatch(prepared);
  const verdict = await proto.verify(prepared);
  assert.equal(verdict.classification, "PRESERVATION_VIOLATED");
  assert.match(verdict.details.join(" "), /plan changed/);
});

// ------------------------------------------------------------------
// Provider-behavior faults (scenarios 7 and 8).
// ------------------------------------------------------------------

test("Test 57.26 (G-17 scenario 7): the provider partially applies the request (target lands, an unrelated item is dropped) -> PRESERVATION_VIOLATED", async () => {
  const { proto } = setup({ partialApplyDropItemId: G17_ADDON_SUPPORT });
  const verdict = await proto.execute(SEATS_TO_21, await proto.readSnapshot(), KEY);
  assert.equal(verdict.classification, "PRESERVATION_VIOLATED");
  assert.match(verdict.details.join(" "), /g17-addon-support is missing/);
});

test("Test 57.27 (G-17 scenario 8): the mutation response is lost after execution -> INDETERMINATE, exactly one dispatch, no blind retry, matching state does not promote the verdict", async () => {
  const { mock, proto } = setup({ loseUpdateResponse: true });
  const verdict = await proto.execute(SEATS_TO_21, await proto.readSnapshot(), KEY);
  assert.equal(verdict.classification, "INDETERMINATE");
  assert.equal(mock.mutationCount, 1, "exactly one mutating call was made; nothing re-dispatched");
  assert.ok(mock.peekItems().some((i) => i.item_price_id === G17_ADDON_SEATS && i.quantity === 21), "the change DID land in the mock — and the verdict still stays INDETERMINATE, because landed state is observationally identical to another actor's identical change");
});

test("Test 57.28 (G-17): a success response that silently does not apply the target -> TARGET_NOT_ESTABLISHED", async () => {
  const { proto } = setup({ ignoreTarget: true });
  const verdict = await proto.execute(SEATS_TO_21, await proto.readSnapshot(), KEY);
  assert.equal(verdict.classification, "TARGET_NOT_ESTABLISHED");
});

// ------------------------------------------------------------------
// Mock-level documentation demonstrations (no executor).
// ------------------------------------------------------------------

test("Test 57.29 (G-17, DOCUMENTED D3): additive plan behavior depends on the multi-plan site setting — disabled replaces the plan price, enabled retains the existing plan alongside", async () => {
  const planPayload = { replace_items_list: false, subscription_items: [{ item_price_id: G17_PLAN_PRO_MONTHLY, quantity: 1 }] };
  const off = setup({ multiPlanEnabled: false });
  await off.client.updateForItems(G17_SUBSCRIPTION_ID, planPayload, "k1");
  assert.deepEqual(off.mock.peekItems().filter((i) => i.item_price_id.includes("plan")), [{ item_price_id: G17_PLAN_PRO_MONTHLY, quantity: 1 }], "multi-plan disabled: the existing plan item price is replaced");
  const on = setup({ multiPlanEnabled: true });
  await on.client.updateForItems(G17_SUBSCRIPTION_ID, planPayload, "k2");
  const plans = on.mock.peekItems().filter((i) => i.item_price_id.includes("plan")).map((i) => i.item_price_id).sort();
  assert.deepEqual(plans, [G17_PLAN_MONTHLY, G17_PLAN_PRO_MONTHLY].sort(), "multi-plan enabled: the existing plan is retained AND the new plan is added — a different subscription than the caller authorized");
});

test("Test 57.30 (G-17, DOCUMENTED D5): native idempotency replays the same key+parameters and rejects the same key with different parameters (422)", async () => {
  const { mock, client } = setup();
  const params = buildTargetedUpdateParams(ADD_STORAGE);
  await client.updateForItems(G17_SUBSCRIPTION_ID, params, "replay-key");
  const after = mock.peekItems();
  await client.updateForItems(G17_SUBSCRIPTION_ID, params, "replay-key");
  assert.deepEqual(mock.peekItems(), after, "the replay did not re-apply the addition");
  await assert.rejects(
    () => client.updateForItems(G17_SUBSCRIPTION_ID, buildTargetedUpdateParams(SEATS_TO_21), "replay-key"),
    /422|duplicate_request/,
  );
});

// ------------------------------------------------------------------
// Correction round — independent review findings G17-R1..R4.
// ------------------------------------------------------------------

test("Test 57.31 (G17-R1): ADD_ADDON is NOT an SCQ action — core/types.ts ChangeAction is exactly {CHANGE_QUANTITY, CHANGE_PLAN, CHANGE_CADENCE, CANCEL}, and verdicts carry the distinction", async () => {
  const typesSource = readFileSync(new URL("../../src/core/types.ts", import.meta.url), "utf8");
  assert.match(typesSource, /export type ChangeAction = "CHANGE_QUANTITY" \| "CHANGE_PLAN" \| "CHANGE_CADENCE" \| "CANCEL";/, "the SCQ action schema is pinned from source, not from memory");
  assert.ok(!typesSource.includes("ADD_ADDON"), "no ADD_ADDON exists anywhere in the core types — the prototype's positive class is provider capability only");
  assert.deepEqual([...SCQ_CHANGE_ACTIONS], ["CHANGE_QUANTITY", "CHANGE_PLAN", "CHANGE_CADENCE", "CANCEL"]);
  const { proto } = setup();
  const addVerdict = await proto.execute(ADD_STORAGE, await proto.readSnapshot(), KEY);
  assert.equal(addVerdict.inScqActionSchema, false);
  const cqVerdict = await proto.execute(SEATS_TO_21, await proto.readSnapshot(), KEY);
  assert.equal(cqVerdict.inScqActionSchema, true);
});

test("Test 57.32 (G17-R2): timestamp delta MAGNITUDE carries no evidence — a same-item interleaving 1ms later and one 24h later classify identically", async () => {
  const classifications: string[] = [];
  for (const delta of [1, 86_400_000]) {
    const { mock, proto } = setup();
    const { prepared } = await staged(proto, SEATS_TO_21);
    mock.advanceTime(delta);
    mock.externalSetQuantity(G17_ADDON_SEATS, 5);
    await proto.dispatch(prepared);
    const verdict = await proto.verify(prepared);
    classifications.push(verdict.classification);
    assert.match(verdict.details.join(" "), /counts no changes and attributes none/, "the verdict states the timestamp limit instead of reasoning from the delta");
  }
  assert.deepEqual(classifications, ["PRESERVATION_UNVERIFIABLE", "PRESERVATION_UNVERIFIABLE"], "a larger timestamp delta is not stronger evidence of anything");
});

test("Test 57.33 (G17-R2): same-millisecond collision — interleaved change + dispatch at ONE timestamp leave resource_version unchanged, and the verdict still cannot verify", async () => {
  const { mock, proto } = setup();
  const { prepared } = await staged(proto, SEATS_TO_21);
  const versionAtT2 = mock.currentResourceVersion;
  mock.externalSetQuantity(G17_ADDON_SEATS, 5); // same mock millisecond
  await proto.dispatch(prepared); // same mock millisecond
  assert.equal(mock.currentResourceVersion, versionAtT2, "two state changes occurred and the timestamp version did not move — a timestamp is not a counter");
  const verdict = await proto.verify(prepared);
  assert.equal(verdict.classification, "PRESERVATION_UNVERIFIABLE");
});

test("Test 57.34 (G17-R2/R3): an add-then-remove history inside the window leaves the final item set EXACTLY equal to T2+delta — the verdict observes the item subset and explicitly does not exclude the invisible history", async () => {
  const { mock, proto } = setup();
  const { prepared } = await staged(proto, ADD_STORAGE);
  mock.externalAddItem(G17_ADDON_EXTERNAL, 1);
  mock.externalRemoveItem(G17_ADDON_EXTERNAL);
  await proto.dispatch(prepared);
  const verdict = await proto.verify(prepared);
  assert.equal(verdict.classification, "ITEM_PRESERVED_OBSERVED");
  assert.equal(verdict.interleavingExcluded, false);
  assert.match(verdict.details.join(" "), /interleaving is NOT excluded/);
});

test("Test 57.35 (G17-R4 COUNTEREXAMPLE): the update silently drops a coupon as a collateral effect — the item verdict is unchanged, because coupons were never inside its scope", async () => {
  const { mock, proto } = setup({ collateralDropCouponId: G17_COUPON_WELCOME });
  assert.deepEqual(mock.peekCoupons(), [G17_COUPON_WELCOME]);
  const verdict = await proto.execute(ADD_STORAGE, await proto.readSnapshot(), KEY);
  assert.deepEqual(mock.peekCoupons(), [], "the coupon is GONE — a real preservation-relevant effect outside the item list");
  assert.equal(verdict.classification, "ITEM_PRESERVED_OBSERVED", "and the item verdict still reports the item subset as observed — which is exactly why it may never be read as a general preservation claim");
  assert.ok(verdict.unobservableDimensions.some((d) => d.includes("coupons")), "the verdict carries coupons as an uncertified dimension");
});

test("Test 57.36 (G17-R4): the unobservable-dimensions list names every dimension the review required — coupons, billing timing, mandatory-addon associations, contract terms, financial effects, schedule history", () => {
  const joined = G17_UNOBSERVABLE_DIMENSIONS.join(" | ");
  for (const needle of ["coupons", "billing timing", "mandatory-addon associations", "contractual terms", "credits, unbilled charges", "scheduled-change history"]) {
    assert.ok(joined.includes(needle), `unobservable dimensions must name: ${needle}`);
  }
  assert.ok(G17_UNOBSERVABLE_DIMENSIONS.length >= 6);
});

// ------------------------------------------------------------------
// Second correction round — G17-R5 (mock-only by construction) and
// G17-R6 (fail-closed missing provider evidence). Every R6 test
// asserts ZERO mutating calls.
// ------------------------------------------------------------------

test("Test 57.37 (G17-R5): the prototype cannot be constructed around a real/default ChargebeeClient or any non-mock object — mock-only by construction, zero network requests", async () => {
  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => { fetchCalls++; throw new Error("network must not be touched by this test"); }) as any;
  try {
    const defaultClient = new ChargebeeClient({ site: "real-site", apiKey: "real-key" }); // default fetchTransport = real HTTP
    assert.throws(() => new G17TargetedUpdatePrototype(defaultClient as any, G17_SUBSCRIPTION_ID), /mock-only by construction/);
    const customTransportClient = new ChargebeeClient({ site: "x", apiKey: "y" }, async () => ({ status: 200, headers: {}, json: {} }));
    assert.throws(() => new G17TargetedUpdatePrototype(customTransportClient as any, G17_SUBSCRIPTION_ID), /mock-only by construction/, "a client over a caller-supplied custom transport is equally ineligible");
    assert.throws(() => new G17TargetedUpdatePrototype(undefined as any, G17_SUBSCRIPTION_ID), /mock-only by construction/);
    assert.throws(() => new G17TargetedUpdatePrototype({ transport: async () => ({ status: 200, headers: {}, json: {} }) } as any, G17_SUBSCRIPTION_ID), /mock-only by construction/, "a transport-shaped impostor is not a G17MockChargebee");
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(fetchCalls, 0, "no network request was made at any point");
});

test("Test 57.38 (G17-R6): provider read OMITS the subscription id -> REFUSED_MISSING_PROVIDER_EVIDENCE, zero POST", async () => {
  const t0 = await cleanT0();
  const { mock, proto } = setup({ omitSubscriptionId: true });
  const verdict = await proto.execute(ADD_STORAGE, t0, KEY);
  assert.equal(verdict.classification, "REFUSED_MISSING_PROVIDER_EVIDENCE");
  assert.equal(mock.mutationCount, 0, "identity is never manufactured from the request; no dispatch occurred");
});

test("Test 57.39 (G17-R6): BOTH reads identify a FOREIGN subscription (matching each other) -> REFUSED_MISSING_PROVIDER_EVIDENCE, zero POST", async () => {
  const { mock, client, proto } = setup({ subscriptionIdOverride: "g17-sub-foreign" });
  const { json } = await client.getSubscription(G17_SUBSCRIPTION_ID);
  const foreignT0 = snapshotFromSubscriptionJson(json); // parses: the id is PRESENT, just wrong
  assert.equal(foreignT0.subscriptionId, "g17-sub-foreign");
  const verdict = await proto.execute(ADD_STORAGE, foreignT0, KEY);
  assert.equal(verdict.classification, "REFUSED_MISSING_PROVIDER_EVIDENCE");
  assert.match(verdict.details.join(" "), /not the expected/);
  assert.equal(mock.mutationCount, 0, "two matching foreign reads do not establish the expected identity");
});

test("Test 57.40 (G17-R6): provider read OMITS has_scheduled_changes -> REFUSED_MISSING_PROVIDER_EVIDENCE (a missing flag is NOT read as false), zero POST", async () => {
  const t0 = await cleanT0();
  const { mock, proto } = setup({ omitHasScheduledChanges: true });
  const verdict = await proto.execute(ADD_STORAGE, t0, KEY);
  assert.equal(verdict.classification, "REFUSED_MISSING_PROVIDER_EVIDENCE");
  assert.equal(mock.mutationCount, 0);
});

test("Test 57.41 (G17-R6): provider read OMITS has_scheduled_advance_invoices -> REFUSED_MISSING_PROVIDER_EVIDENCE, zero POST", async () => {
  const t0 = await cleanT0();
  const { mock, proto } = setup({ omitHasScheduledAdvanceInvoices: true });
  const verdict = await proto.execute(ADD_STORAGE, t0, KEY);
  assert.equal(verdict.classification, "REFUSED_MISSING_PROVIDER_EVIDENCE");
  assert.equal(mock.mutationCount, 0);
});

test("Test 57.42 (G17-R6): has_scheduled_advance_invoices is TRUE -> REFUSED_SCHEDULED_CHANGE_AT_RISK, zero POST", async () => {
  const t0 = await cleanT0();
  const { mock, proto } = setup({ hasScheduledAdvanceInvoices: true });
  const verdict = await proto.execute(ADD_STORAGE, t0, KEY);
  assert.equal(verdict.classification, "REFUSED_SCHEDULED_CHANGE_AT_RISK");
  assert.match(verdict.details.join(" "), /advance invoices/);
  assert.equal(mock.mutationCount, 0);
});

test("Test 57.43 (G17-R6): item evidence gaps refuse — each of item_price_id / quantity / unit_price / amount omitted in turn -> REFUSED_MISSING_PROVIDER_EVIDENCE, zero POST", async () => {
  const t0 = await cleanT0();
  for (const field of ["item_price_id", "quantity", "unit_price", "amount"] as const) {
    const { mock, proto } = setup({ omitItemField: field });
    const verdict = await proto.execute(ADD_STORAGE, t0, KEY);
    assert.equal(verdict.classification, "REFUSED_MISSING_PROVIDER_EVIDENCE", `omitted item field ${field} must refuse, not default`);
    assert.equal(mock.mutationCount, 0, `omitted item field ${field}: no dispatch`);
  }
});

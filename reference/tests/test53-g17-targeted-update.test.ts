/**
 * Test 53 — SCQ G-17 prototype: authorization-preserving Chargebee
 * updates via a minimal additive dispatch (Issue #30, Phase 2/4).
 *
 * What is under test: an ISOLATED prototype
 * (src/live/pilot/g17-targeted-update.ts) that sends
 * `update_for_items` with `replace_items_list=false` and ONLY the
 * authorized target item, against a stateful mock
 * (src/live/pilot/g17-mock-transport.ts) whose rules are labeled
 * DOCUMENTED (D1–D6) or ASSUMED (A1–A2) in the mock's header. The
 * live adapter is NOT modified by this work — 53.4 pins that its
 * capability and its full-replacement builder are unchanged.
 *
 * The adversarial matrix follows Issue #30's T0/T1/T2/T3/T4 threat
 * model: T0 quote-time snapshot, T1 external change, T2
 * pre-dispatch re-read, T3 candidate dispatch, T4 independent
 * re-read. A candidate mechanism FAILS preservation if it silently
 * changes state outside the authorized operation; the tests exercise
 * the actual wire behavior of the mock (53.19 reproduces the
 * Issue #22 Finding 1 deletion under the CURRENT full-replacement
 * wire shape on this same mock, proving the harness can detect the
 * failure it claims to detect).
 *
 * Evidence class: SIMULATED throughout. The positive
 * CHANGE_QUANTITY verdict (53.2) additionally depends on ASSUMED
 * rule A1 (same-ID update-in-place); 53.5–53.7 run the identical
 * wire request under the other documented-plausible same-ID
 * behaviors and show the verdict does not survive them — which is
 * why the research package keeps G-17 OPEN and recommends
 * vendor clarification before any adapter change.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
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
  type G17MockOptions,
} from "../src/live/pilot/g17-mock-transport.js";
import {
  G17TargetedUpdatePrototype,
  buildTargetedUpdateParams,
  type G17Operation,
  type G17Prepared,
} from "../src/live/pilot/g17-targeted-update.js";

const KEY = "g17-test-idempotency-key";

function setup(options: G17MockOptions = {}) {
  const mock = new G17MockChargebee(options);
  const client = new ChargebeeClient({ site: "g17-test", apiKey: "g17-mock-key" }, mock.transport);
  const proto = new G17TargetedUpdatePrototype(client, G17_SUBSCRIPTION_ID);
  return { mock, client, proto };
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

test("Test 53.1 (G-17): ADD_ADDON of a new item via additive dispatch preserves all unrelated state (DOCUMENTED additive semantics, SIMULATED)", async () => {
  const { mock, proto } = setup();
  const t0 = await proto.readSnapshot();
  const verdict = await proto.execute(ADD_STORAGE, t0, KEY);
  assert.equal(verdict.classification, "PRESERVED_VERIFIED");
  assert.equal(verdict.evidence, "SIMULATED");
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

test("Test 53.2 (G-17): CHANGE_QUANTITY to an absolute target preserves unrelated state — under ASSUMED same-ID update-in-place semantics (A1, SIMULATED)", async () => {
  const { mock, proto } = setup();
  const t0 = await proto.readSnapshot();
  const verdict = await proto.execute(SEATS_TO_21, t0, KEY);
  assert.equal(verdict.classification, "PRESERVED_VERIFIED");
  const update = mock.calls.find((c) => c.mutating)!;
  assert.equal(update.replaceItemsList, false);
  assert.deepEqual(update.itemPriceIds, [G17_ADDON_SEATS]);
  assert.deepEqual(mock.peekItems(), [
    { item_price_id: G17_PLAN_MONTHLY, quantity: 1 },
    { item_price_id: G17_ADDON_SEATS, quantity: 21 },
    { item_price_id: G17_ADDON_SUPPORT, quantity: 2 },
  ]);
});

test("Test 53.3 (G-17): the targeted builder emits a minimal payload — target item only, replace_items_list=false, no plan, no retained set", () => {
  const params = buildTargetedUpdateParams(SEATS_TO_21) as any;
  assert.equal(params.replace_items_list, false);
  assert.equal(params.invoice_immediately, false);
  assert.deepEqual(params.subscription_items, [{ item_price_id: G17_ADDON_SEATS, quantity: 21 }]);
  assert.ok(!JSON.stringify(params).includes(G17_PLAN_MONTHLY), "the plan is never named in a targeted payload");
});

test("Test 53.4 (G-17): the LIVE adapter is unchanged — capability still FULL_REPLACEMENT_ONLY and its builder still sends replace_items_list=true", () => {
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

test("Test 53.5 (G-17): same wire request under duplicate-entry same-ID behavior -> PRESERVATION_VIOLATED", async () => {
  const { proto } = setup({ sameIdBehavior: "duplicate_entry" });
  const verdict = await proto.execute(SEATS_TO_21, await proto.readSnapshot(), KEY);
  assert.equal(verdict.classification, "PRESERVATION_VIOLATED");
  assert.match(verdict.details.join(" "), /appears 2 times/);
});

test("Test 53.6 (G-17): same wire request under quantity-summed same-ID behavior -> PRESERVATION_VIOLATED (financial effect exceeds authorization)", async () => {
  const { proto } = setup({ sameIdBehavior: "quantity_summed" });
  const verdict = await proto.execute(SEATS_TO_21, await proto.readSnapshot(), KEY);
  assert.equal(verdict.classification, "PRESERVATION_VIOLATED");
  assert.match(verdict.details.join(" "), /SUMMED/);
});

test("Test 53.7 (G-17): same wire request under reject same-ID behavior -> DISPATCH_REJECTED and provider state unchanged", async () => {
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
  test(`Test 53.8-11 (G-17): ${name} is unsupported by the prototype and fails closed before ANY transport call`, async () => {
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

test("Test 53.12 (G-17): class mismatches fail closed — ADD_ADDON of an existing item and CHANGE_QUANTITY of an absent item", async () => {
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

test("Test 53.13 (G-17 scenario 1a): another actor adds an addon after the quote (before T2) -> REFUSED_PRE_DISPATCH_DRIFT, zero dispatches", async () => {
  const { mock, proto } = setup();
  const t0 = await proto.readSnapshot();
  mock.externalAddItem(G17_ADDON_EXTERNAL, 1);
  const verdict = await proto.execute(SEATS_TO_21, t0, KEY);
  assert.equal(verdict.classification, "REFUSED_PRE_DISPATCH_DRIFT");
  assert.equal(mock.mutationCount, 0, "financial basis changed with the new addon; dispatching on the stale quote is refused even though additive dispatch would not delete the new item");
});

test("Test 53.14 (G-17 scenario 2a): another actor modifies the SAME item's quantity after the quote -> REFUSED_PRE_DISPATCH_DRIFT, zero dispatches", async () => {
  const { mock, proto } = setup();
  const t0 = await proto.readSnapshot();
  mock.externalSetQuantity(G17_ADDON_SEATS, 5);
  const verdict = await proto.execute(SEATS_TO_21, t0, KEY);
  assert.equal(verdict.classification, "REFUSED_PRE_DISPATCH_DRIFT");
  assert.equal(mock.mutationCount, 0);
});

test("Test 53.15 (G-17 scenario 3a): an item is removed after the quote -> REFUSED_PRE_DISPATCH_DRIFT, zero dispatches", async () => {
  const { mock, proto } = setup();
  const t0 = await proto.readSnapshot();
  mock.externalRemoveItem(G17_ADDON_SUPPORT);
  const verdict = await proto.execute(ADD_STORAGE, t0, KEY);
  assert.equal(verdict.classification, "REFUSED_PRE_DISPATCH_DRIFT");
  assert.equal(mock.mutationCount, 0);
});

test("Test 53.16 (G-17 scenario 6a): plan/currency changes after the quote -> REFUSED_PRE_DISPATCH_DRIFT, zero dispatches", async () => {
  const { mock, proto } = setup();
  const t0 = await proto.readSnapshot();
  mock.externalChangePlan(G17_PLAN_YEARLY, "EUR");
  const verdict = await proto.execute(SEATS_TO_21, t0, KEY);
  assert.equal(verdict.classification, "REFUSED_PRE_DISPATCH_DRIFT");
  assert.match(verdict.details.join(" "), /currency differs/);
  assert.equal(mock.mutationCount, 0);
});

test("Test 53.17 (G-17 scenario 5a): a scheduled change exists at T2 -> REFUSED_SCHEDULED_CHANGE_AT_RISK, zero dispatches, schedule untouched", async () => {
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

test("Test 53.18 (G-17 scenario 1b): another actor adds an addon BETWEEN T2 and T3 -> additive dispatch preserves it (PRESERVED_WITH_CONCURRENT_CHANGE)", async () => {
  const { mock, proto } = setup();
  const { prepared } = await staged(proto, SEATS_TO_21);
  mock.externalAddItem(G17_ADDON_EXTERNAL, 1);
  const outcome = await proto.dispatch(prepared);
  assert.equal(outcome.ok, true);
  const verdict = await proto.verify(prepared);
  assert.equal(verdict.classification, "PRESERVED_WITH_CONCURRENT_CHANGE");
  assert.ok(mock.peekItems().some((i) => i.item_price_id === G17_ADDON_EXTERNAL && i.quantity === 1), "the concurrent addon survived the dispatch intact");
  assert.ok(mock.peekItems().some((i) => i.item_price_id === G17_ADDON_SEATS && i.quantity === 21), "the authorized change also landed");
});

test("Test 53.19 (G-17 control): the SAME interleaving under the CURRENT full-replacement wire shape deletes the concurrent addon (Issue #22 Finding 1 reproduced on this mock)", async () => {
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

test("Test 53.20 (G-17 scenario 2b): another actor modifies the SAME item's quantity between T2 and T3 -> never VERIFIED (PRESERVATION_UNVERIFIABLE)", async () => {
  const { mock, proto } = setup();
  const { prepared } = await staged(proto, SEATS_TO_21);
  mock.externalSetQuantity(G17_ADDON_SEATS, 5);
  await proto.dispatch(prepared);
  const verdict = await proto.verify(prepared);
  assert.equal(verdict.classification, "PRESERVATION_UNVERIFIABLE");
  assert.match(verdict.details.join(" "), /resource_version advanced/);
});

test("Test 53.21 (G-17 scenario 3b): an unrelated item is removed between T2 and T3 -> PRESERVATION_VIOLATED (a missing item cannot be attributed away)", async () => {
  const { mock, proto } = setup();
  const { prepared } = await staged(proto, SEATS_TO_21);
  mock.externalRemoveItem(G17_ADDON_SUPPORT);
  await proto.dispatch(prepared);
  const verdict = await proto.verify(prepared);
  assert.equal(verdict.classification, "PRESERVATION_VIOLATED");
  assert.match(verdict.details.join(" "), /g17-addon-support is missing/);
});

test("Test 53.22 (G-17 scenario 4a): a mandatory addon attached between T2 and T3 survives the additive dispatch (PRESERVED_WITH_CONCURRENT_CHANGE)", async () => {
  const { mock, proto } = setup();
  const { prepared } = await staged(proto, SEATS_TO_21);
  mock.externalAddItem(G17_ADDON_MANDATORY, 1, { mandatory: true });
  await proto.dispatch(prepared);
  const verdict = await proto.verify(prepared);
  assert.equal(verdict.classification, "PRESERVED_WITH_CONCURRENT_CHANGE");
  assert.ok(mock.peekItems().some((i) => i.item_price_id === G17_ADDON_MANDATORY));
});

test("Test 53.23 (G-17 scenario 4b): a mandatory addon present at T2 disappears by T4 -> PRESERVATION_VIOLATED", async () => {
  const { mock, proto } = setup();
  mock.externalAddItem(G17_ADDON_MANDATORY, 1, { mandatory: true });
  const { prepared } = await staged(proto, SEATS_TO_21);
  mock.externalRemoveItem(G17_ADDON_MANDATORY);
  await proto.dispatch(prepared);
  const verdict = await proto.verify(prepared);
  assert.equal(verdict.classification, "PRESERVATION_VIOLATED");
});

test("Test 53.24 (G-17 scenario 5b): a scheduled change created between T2 and T3 is DELETED by the dispatch (documented D4) — item preservation is not schedule preservation", async () => {
  const { mock, proto } = setup();
  const { prepared } = await staged(proto, SEATS_TO_21);
  mock.externalScheduleChange();
  await proto.dispatch(prepared);
  assert.equal(mock.peekHasScheduledChanges(), false, "the update deleted the concurrently created scheduled change, exactly as the vendor docs describe for Ramps-disabled sites");
  const verdict = await proto.verify(prepared);
  assert.notEqual(verdict.classification, "PRESERVED_VERIFIED", "a dispatch that destroyed a concurrent schedule must never report a clean preservation verdict");
  assert.equal(verdict.classification, "PRESERVATION_UNVERIFIABLE");
});

test("Test 53.25 (G-17 scenario 6b): plan/cadence changes between T2 and T3 -> PRESERVATION_VIOLATED at T4", async () => {
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

test("Test 53.26 (G-17 scenario 7): the provider partially applies the request (target lands, an unrelated item is dropped) -> PRESERVATION_VIOLATED", async () => {
  const { proto } = setup({ partialApplyDropItemId: G17_ADDON_SUPPORT });
  const verdict = await proto.execute(SEATS_TO_21, await proto.readSnapshot(), KEY);
  assert.equal(verdict.classification, "PRESERVATION_VIOLATED");
  assert.match(verdict.details.join(" "), /g17-addon-support is missing/);
});

test("Test 53.27 (G-17 scenario 8): the mutation response is lost after execution -> INDETERMINATE, exactly one dispatch, no blind retry, matching state does not promote the verdict", async () => {
  const { mock, proto } = setup({ loseUpdateResponse: true });
  const verdict = await proto.execute(SEATS_TO_21, await proto.readSnapshot(), KEY);
  assert.equal(verdict.classification, "INDETERMINATE");
  assert.equal(mock.mutationCount, 1, "exactly one mutating call was made; nothing re-dispatched");
  assert.ok(mock.peekItems().some((i) => i.item_price_id === G17_ADDON_SEATS && i.quantity === 21), "the change DID land in the mock — and the verdict still stays INDETERMINATE, because landed state is observationally identical to another actor's identical change");
});

test("Test 53.28 (G-17): a success response that silently does not apply the target -> TARGET_NOT_ESTABLISHED", async () => {
  const { proto } = setup({ ignoreTarget: true });
  const verdict = await proto.execute(SEATS_TO_21, await proto.readSnapshot(), KEY);
  assert.equal(verdict.classification, "TARGET_NOT_ESTABLISHED");
});

// ------------------------------------------------------------------
// Mock-level documentation demonstrations (no executor).
// ------------------------------------------------------------------

test("Test 53.29 (G-17, DOCUMENTED D3): additive plan behavior depends on the multi-plan site setting — disabled replaces the plan price, enabled retains the existing plan alongside", async () => {
  const planPayload = { replace_items_list: false, subscription_items: [{ item_price_id: G17_PLAN_PRO_MONTHLY, quantity: 1 }] };
  const off = setup({ multiPlanEnabled: false });
  await off.client.updateForItems(G17_SUBSCRIPTION_ID, planPayload, "k1");
  assert.deepEqual(off.mock.peekItems().filter((i) => i.item_price_id.includes("plan")), [{ item_price_id: G17_PLAN_PRO_MONTHLY, quantity: 1 }], "multi-plan disabled: the existing plan item price is replaced");
  const on = setup({ multiPlanEnabled: true });
  await on.client.updateForItems(G17_SUBSCRIPTION_ID, planPayload, "k2");
  const plans = on.mock.peekItems().filter((i) => i.item_price_id.includes("plan")).map((i) => i.item_price_id).sort();
  assert.deepEqual(plans, [G17_PLAN_MONTHLY, G17_PLAN_PRO_MONTHLY].sort(), "multi-plan enabled: the existing plan is retained AND the new plan is added — a different subscription than the caller authorized");
});

test("Test 53.30 (G-17, DOCUMENTED D5): native idempotency replays the same key+parameters and rejects the same key with different parameters (422)", async () => {
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

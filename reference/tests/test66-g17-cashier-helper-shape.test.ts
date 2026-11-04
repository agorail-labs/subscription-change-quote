/**
 * Test 66 — G-17: source-audited Chargebee Cashier helper shapes (Issue #30).
 *
 * External source evidence (reviewed 2026-11-03):
 * https://github.com/chargebee/cashier-chargebee/blob/7ab4386b4154eedb62b861e44640adf3605cac73/src/Subscription.php
 * - updateQuantity() lines 345-375 reads the whole subscription item set,
 *   replaces the target quantity in that snapshot, and submits
 *   updateForItems(replace_items_list=true, full item set).
 * - addPrice() lines 615-632 instead submits the new item alone without
 *   the replacement flag.
 *
 * These tests MODEL the relevant request shapes with SCQ's existing
 * G17MockChargebee; they do NOT execute PHP, validate Chargebee production
 * behavior, authenticate an upstream release, or make any network request.
 * The risk under the documented replacement semantics is the point.
 * No test result permits relaxing SCQ's live-adapter OPERATION refusal.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ChargebeeClient } from "../src/live/chargebee-http.js";
import {
  G17MockChargebee,
  G17_SUBSCRIPTION_ID,
  G17_ADDON_SEATS,
  G17_ADDON_STORAGE,
  G17_ADDON_EXTERNAL,
} from "../src/live/pilot/g17-mock-transport.js";

type Item = { item_price_id: string; quantity: number; unit_price: number };

/** Model of the relevant wire shape in Cashier Subscription::updateQuantity.
 * This is OUR fixture, not a port of the upstream PHP implementation.
 * We preserve the other items from the pre-write GET and replace the
 * entire list, deliberately exposing its check/dispatch race.
 */
async function modeledCashierQuantityParams(client: ChargebeeClient, quantity: number) {
  const { json } = await client.getSubscription(G17_SUBSCRIPTION_ID);
  const items = (json.subscription.subscription_items as Item[]);
  assert.ok(items.some((item) => item.item_price_id === G17_ADDON_SEATS));
  return {
    replace_items_list: true,
    subscription_items: items.map((item) => ({
      item_price_id: item.item_price_id,
      quantity: item.item_price_id === G17_ADDON_SEATS ? quantity : item.quantity,
      unit_price: item.unit_price,
    })),
  };
}

function fixture() {
  const mock = new G17MockChargebee();
  const client = new ChargebeeClient(
    { site: "g17-cashier-mock", apiKey: "synthetic-no-network" },
    mock.transport,
  );
  return { mock, client };
}

test("Test 66.1 (G-17): a quantity-named SDK helper modeled with a full-list replacement deletes an unrelated concurrent addon", async () => {
  const { mock, client } = fixture();
  const params = await modeledCashierQuantityParams(client, 21);
  assert.equal(params.replace_items_list, true);
  assert.ok(params.subscription_items.length > 1, "the request is a full pre-read item list, not a field-scoped quantity operation");
  mock.externalAddItem(G17_ADDON_EXTERNAL, 1); // T2 -> T3 interleaving
  await client.updateForItems(G17_SUBSCRIPTION_ID, params, "g17-cashier-66.1");
  const sent = mock.calls.find((c) => c.mutating);
  assert.equal(sent?.replaceItemsList, true, "the modeled SDK call dispatches replacement semantics");
  assert.ok(sent?.itemPriceIds?.includes(G17_ADDON_SEATS));
  assert.ok(!sent?.itemPriceIds?.includes(G17_ADDON_EXTERNAL), "the independently added item was not in the stale request");
  assert.ok(!mock.peekItems().some((i) => i.item_price_id === G17_ADDON_EXTERNAL), "documented full replacement removed the concurrent addon in the MOCK");
  assert.equal(mock.peekItems().find((i) => i.item_price_id === G17_ADDON_SEATS)?.quantity, 21);
});

test("Test 66.2 (G-17): overwriting a same-item interleaving yields the same T4 item set as a clean replacement", async () => {
  async function run(interleave: boolean) {
    const { mock, client } = fixture();
    const params = await modeledCashierQuantityParams(client, 21);
    if (interleave) mock.externalSetQuantity(G17_ADDON_SEATS, 5);
    await client.updateForItems(G17_SUBSCRIPTION_ID, params, interleave ? "g17-cashier-66.2-race" : "g17-cashier-66.2-clean");
    return mock.peekItems();
  }
  assert.deepEqual(await run(true), await run(false), "matching final item state cannot establish that an independent same-item change was not overwritten");
});

test("Test 66.3 (G-17): a scheduled change introduced after the read can be erased invisibly by the modeled SDK update", async () => {
  const { mock, client } = fixture();
  const params = await modeledCashierQuantityParams(client, 21);
  const t2Version = mock.currentResourceVersion;
  mock.externalScheduleChange();
  assert.equal(mock.peekHasScheduledChanges(), true);
  await client.updateForItems(G17_SUBSCRIPTION_ID, params, "g17-cashier-66.3");
  assert.equal(mock.peekHasScheduledChanges(), false, "the simulated documented Ramps-disabled update side effect deleted the schedule");
  assert.equal(mock.currentResourceVersion, t2Version, "same-millisecond timestamp collisions cannot exclude that intervening schedule");
});

test("Test 66.4 (G-17): the source-audited addPrice-style additive shape preserves another addon, but cannot certify whole-subscription safety", async () => {
  const { mock, client } = fixture();
  mock.externalAddItem(G17_ADDON_EXTERNAL, 1);
  mock.externalScheduleChange();
  await client.updateForItems(
    G17_SUBSCRIPTION_ID,
    { subscription_items: [{ item_price_id: G17_ADDON_STORAGE, quantity: 3 }], prorate: true },
    "g17-cashier-66.4",
  );
  const sent = mock.calls.find((c) => c.mutating);
  assert.equal(sent?.replaceItemsList, false, "no replacement flag means additive mode");
  assert.deepEqual(sent?.itemPriceIds, [G17_ADDON_STORAGE], "one provider item, not an SCQ supported ADD_ADDON action");
  assert.ok(mock.peekItems().some((i) => i.item_price_id === G17_ADDON_EXTERNAL), "unrelated addon survives in this MOCK");
  assert.equal(mock.peekHasScheduledChanges(), false, "item preservation does NOT establish scheduled-change preservation");
});

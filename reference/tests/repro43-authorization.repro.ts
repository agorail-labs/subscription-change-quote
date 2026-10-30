import { test } from "node:test";
import assert from "node:assert/strict";
import { QuoteStore } from "../src/store/quote-store.js";
import { SCQError } from "../src/core/types.js";
import { ChargebeeClient, type HttpRequest, type HttpResponse, type HttpTransport } from "../src/live/chargebee-http.js";
import { ChargebeeLiveAdapter } from "../src/live/chargebee-scq-adapter.js";

// Test 43 — Issue #22, Finding 1 (P0): authorization-preserving
// execution is NOT implied by target-state verification.
//
// Independent local rerun of Fabio's externally reported
// counterexample (Discussion #2, tested by him at 963be0b) against
// CURRENT main, using the Chargebee-LIVE adapter over an injected,
// scripted mocked transport. No real Chargebee call, no credentials:
// SIMULATED evidence only. This is a REPRODUCTION file: the
// defect-demonstrating test (43.1) asserts the SAFE behavior and is
// EXPECTED TO FAIL on unmodified main; the two controls (43.2, 43.3)
// pass and bound the defect precisely. Do not weaken 43.1 to make
// it pass — a fix belongs in a separate, gated implementation PR.
//
// RESEARCH SUITE (PR #23 REVIEW-1): this file is NOT part of the
// default `npm test` discovery (`dist/tests/*.test.js`). Build
// (`npm run build` / `npx tsc -p tsconfig.json`), then invoke the
// research suite explicitly: `node --test dist/tests/*.repro.js`.
//
// Scenario (43.1): the subscription holds plan + pilot-addon-vision
// qty 1. The authorized proposal is pilot-addon-vision 1 -> 21 ONLY.
// After the adapter's final pre-commit read + fingerprint validation
// (the commit-phase GET), a third party adds pilot-addon-concurrent
// to the subscription. That item is an ORDINARY unrelated addon in
// this fixture — despite the historical "mandatory" naming this file
// originally carried, nothing provider-enforced-mandatory is
// simulated, and this reproduction does NOT establish whether a
// genuinely provider-enforced mandatory addon could be deleted on
// real Chargebee (the documentation is unsettled for the
// plan-inclusive case; see the capability assessment §1.5). The
// proven race is the GENERIC full-list overwrite of an ordinary
// concurrently added item. The adapter then dispatches the full-list
// replacement built from the quote-time snapshot
// (replace_items_list=true, items = [plan, vision x21]): the
// concurrently added, never-authorized item is deleted by the
// replacement. Post-commit, the landed set equals the EXPECTED
// target set, so state verification is VERIFIED and the receipt is
// COMMITTED_AND_VERIFIED / reconciliation OK — even though the
// execution deleted an item outside the authorized change scope.
//
// The mock below is a self-contained reproduction fixture (modeled
// on the pilot mock's wire shapes, src/live/pilot/mock-transport.ts):
// update_for_items applies replace_items_list=true as a wholesale
// replacement of the item list, which is Chargebee's documented
// semantics for a plan-inclusive list (see the adapter's own comment
// on buildChargebeeUpdateParams and research/issue-22/
// CHARGEBEE-CAPABILITY-ASSESSMENT.md).

const SUB = "pilot-sub-001";
const PLAN = "pilot-plan-business";
const ADDON = "pilot-addon-vision";
const CONCURRENT = "pilot-addon-concurrent";

const CATALOG: Record<string, { price: number; pricing_model: string; item_type: string }> = {
  [PLAN]: { price: 59900, pricing_model: "flat_fee", item_type: "plan" },
  [ADDON]: { price: 10000, pricing_model: "per_unit", item_type: "addon" },
  [CONCURRENT]: { price: 2500, pricing_model: "flat_fee", item_type: "addon" },
};

type MockItem = { item_price_id: string; item_type: string; quantity: number; unit_price: number; amount: number; free_quantity?: number };

function amountOf(itemPriceId: string, quantity: number, unitPrice: number): number {
  return CATALOG[itemPriceId]?.pricing_model === "flat_fee" ? unitPrice : unitPrice * quantity;
}

export class ConcurrentAddMockChargebee {
  /** Ordered wire log: every request the adapter made, in sequence. */
  calls: Array<{ seq: number; method: string; path: string; body?: string }> = [];
  /** The exact update_for_items dispatch (decoded params + raw body). */
  updateDispatches: Array<{ params: Record<string, string>; rawBody: string }> = [];
  /** Set when the scripted concurrent add has landed; records the wire position it landed at. */
  concurrentAddAt: { afterCallSeq: number; stateAfterAdd: string[] } | undefined;
  private seq = 0;
  private resourceVersion = 1700000000000;
  private items: MockItem[] = [
    { item_price_id: PLAN, item_type: "plan", quantity: 1, unit_price: 59900, amount: 59900 },
    { item_price_id: ADDON, item_type: "addon", quantity: 1, unit_price: 1000, amount: 1000, free_quantity: 0 },
  ];
  private armed = false;

  /** Arms the scripted third-party write: it lands when the NEXT estimate POST arrives
   *  (in a commit, that is the revalidation estimate — strictly AFTER the adapter's
   *  final pre-commit subscription GET and fingerprint validation, BEFORE dispatch). */
  armConcurrentAddOnNextEstimate(): void { this.armed = true; }

  /** Applies the third-party write immediately (used by control 43.3, pre-read window). */
  applyConcurrentAddNow(): void { this.addConcurrent(); }

  private addConcurrent(): void {
    if (!this.items.some((i) => i.item_price_id === CONCURRENT)) {
      this.items.push({ item_price_id: CONCURRENT, item_type: "addon", quantity: 1, unit_price: 2500, amount: 2500 });
    }
    this.resourceVersion += 1000;
    this.concurrentAddAt = {
      afterCallSeq: this.seq,
      stateAfterAdd: this.items.map((i) => `${i.item_price_id} x${i.quantity}`),
    };
  }

  itemIds(): string[] { return this.items.map((i) => i.item_price_id); }

  private subscriptionJson(): any {
    return {
      subscription: {
        id: SUB,
        status: "active",
        currency_code: "USD",
        resource_version: this.resourceVersion,
        current_term_start: 1700000000,
        current_term_end: 1702592000,
        next_billing_at: 1702592000,
        has_scheduled_changes: false,
        has_scheduled_advance_invoices: false,
        subscription_items: this.items.map((i) => ({ ...i })),
      },
    };
  }

  private parseItems(body: string): Array<{ item_price_id: string; quantity: number }> {
    const params = new URLSearchParams(body);
    const byIndex = new Map<number, { item_price_id?: string; quantity?: number }>();
    for (const [k, v] of params.entries()) {
      const m = k.match(/^subscription_items\[(item_price_id|quantity)\]\[(\d+)\]$/);
      if (!m) continue;
      const idx = Number(m[2]);
      const entry = byIndex.get(idx) ?? {};
      if (m[1] === "item_price_id") entry.item_price_id = v; else entry.quantity = Number(v);
      byIndex.set(idx, entry);
    }
    return [...byIndex.entries()].sort((a, b) => a[0] - b[0]).map(([, e]) => ({ item_price_id: e.item_price_id!, quantity: e.quantity ?? 1 }));
  }

  private buildEstimate(requested: Array<{ item_price_id: string; quantity: number }>): any {
    const currentAddon = this.items.find((i) => i.item_price_id === ADDON)!;
    const targetAddon = requested.find((i) => i.item_price_id === ADDON);
    const delta = (targetAddon?.quantity ?? currentAddon.quantity) - currentAddon.quantity;
    const incurred = delta * currentAddon.unit_price;
    const stated = requested.map((r) => {
      const cur = this.items.find((i) => i.item_price_id === r.item_price_id);
      const unitPrice = cur?.unit_price ?? CATALOG[r.item_price_id]?.price ?? 0;
      return { item_price_id: r.item_price_id, quantity: r.quantity, unit_price: unitPrice, amount: amountOf(r.item_price_id, r.quantity, unitPrice) };
    });
    return {
      estimate: {
        unbilled_charge_estimates: incurred !== 0 ? [{ amount: incurred }] : [],
        credit_note_estimates: [],
        subscription_estimate: { subscription_items: stated },
      },
    };
  }

  private applyUpdate(requested: Array<{ item_price_id: string; quantity: number }>): any {
    const beforeVision = this.items.find((i) => i.item_price_id === ADDON)?.quantity ?? 0;
    // replace_items_list=true with a plan-inclusive list: the item
    // list BECOMES exactly the requested list. Anything not named —
    // including an item a third party added after our snapshot — is
    // removed. (Documented semantics; see buildChargebeeUpdateParams.)
    this.items = requested.map((r) => {
      const cur = this.items.find((i) => i.item_price_id === r.item_price_id);
      const unitPrice = cur?.unit_price ?? CATALOG[r.item_price_id]?.price ?? 0;
      return {
        item_price_id: r.item_price_id,
        item_type: CATALOG[r.item_price_id]?.item_type ?? "addon",
        quantity: r.quantity,
        unit_price: unitPrice,
        amount: amountOf(r.item_price_id, r.quantity, unitPrice),
        ...(CATALOG[r.item_price_id]?.pricing_model === "per_unit" ? { free_quantity: 0 } : {}),
      };
    });
    this.resourceVersion += 1000;
    const afterVision = this.items.find((i) => i.item_price_id === ADDON)?.quantity ?? 0;
    const incurred = (afterVision - beforeVision) * 1000;
    return { subscription: this.subscriptionJson().subscription, unbilled_charges: [{ amount: incurred }] };
  }

  transport: HttpTransport = async (req: HttpRequest): Promise<HttpResponse> => {
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/api\/v2/, "");
    this.seq += 1;
    this.calls.push({ seq: this.seq, method: req.method, path, body: req.body });
    const json = (status: number, body: any): HttpResponse => ({ status, headers: {}, json: body });

    if (req.method === "GET" && path.startsWith("/subscriptions/")) return json(200, this.subscriptionJson());
    if (req.method === "GET" && path.startsWith("/item_prices/")) {
      const id = decodeURIComponent(path.slice("/item_prices/".length));
      const meta = CATALOG[id];
      if (!meta) return json(404, { api_error_code: "resource_not_found" });
      return json(200, { item_price: { id, pricing_model: meta.pricing_model, price: meta.price, free_quantity: 0, item_type: meta.item_type } });
    }
    if (req.method === "POST" && path === "/estimates/update_subscription_for_items") {
      if (this.armed) {
        // The third-party write lands NOW: after the adapter's final
        // pre-commit read/validation, before any dispatch.
        this.armed = false;
        this.addConcurrent();
      }
      return json(200, this.buildEstimate(this.parseItems(req.body ?? "")));
    }
    if (req.method === "POST" && path.includes("/update_for_items")) {
      const params: Record<string, string> = {};
      for (const [k, v] of new URLSearchParams(req.body ?? "").entries()) params[k] = v;
      this.updateDispatches.push({ params, rawBody: req.body ?? "" });
      return json(200, this.applyUpdate(this.parseItems(req.body ?? "")));
    }
    return json(404, { api_error_code: "resource_not_found" });
  };
}

const PROPOSAL = (qty: number) => ({
  changes: [{ action: "CHANGE_QUANTITY" as const, itemId: ADDON, quantity: qty }],
  effectiveIntent: { type: "IMMEDIATE" as const },
  acceptanceEnvelope: {},
});

function makeAdapter(mock: ConcurrentAddMockChargebee) {
  const client = new ChargebeeClient({ site: "pilot-test", apiKey: "pilot-mock-key" }, mock.transport);
  const store = new QuoteStore();
  const adapter = new ChargebeeLiveAdapter(client, store, { liveCommitEnabled: true });
  return { adapter, store };
}

// ---------------------------------------------------------------------------
// 43.1 — THE DEFECT (expected to FAIL on unmodified main)
// ---------------------------------------------------------------------------

test("Test 43.1 (Issue #22 F1): a concurrent unauthorized addition deleted by the full-list replacement must NOT be reported COMMITTED_AND_VERIFIED / OK", async () => {
  const mock = new ConcurrentAddMockChargebee();
  const { adapter } = makeAdapter(mock);

  // Authorized change ONLY: pilot-addon-vision 1 -> 21.
  const quote = await adapter.createChangeQuote(SUB, PROPOSAL(21));
  assert.equal(quote.commercialEffect.recurring?.resultingAmount, 80900);
  assert.equal(quote.commercialEffect.immediate?.net, 20000);

  // Third-party write lands after the adapter's final pre-commit
  // read + fingerprint validation, before dispatch.
  mock.armConcurrentAddOnNextEstimate();
  const receipt = await adapter.commitChangeQuote(quote.id);

  // ---- Scenario mechanics (these describe what was dispatched and
  // ---- what it did; they PASS on main and pin the repro's shape).
  const dispatch = mock.updateDispatches[0];
  assert.ok(dispatch, "exactly the update_for_items dispatch is captured");
  assert.equal(mock.updateDispatches.length, 1, "one mutating dispatch");
  assert.equal(dispatch.params["replace_items_list"], "true", "the dispatch is a full-list replacement");
  const sentIds = Object.keys(dispatch.params)
    .filter((k) => k.startsWith("subscription_items[item_price_id]"))
    .sort()
    .map((k) => dispatch.params[k]);
  assert.deepEqual(sentIds, [PLAN, ADDON], "the dispatched list is exactly the quote-time authorized set — the concurrent item is not in it");
  assert.ok(mock.concurrentAddAt, "the concurrent add landed");
  const subGetSeqs = mock.calls.filter((c) => c.method === "GET" && c.path.startsWith("/subscriptions/")).map((c) => c.seq);
  assert.ok(subGetSeqs.length >= 2, "wire log shows the quote-time read and the commit-phase read");
  assert.ok(
    mock.concurrentAddAt!.afterCallSeq > subGetSeqs[1],
    "the add landed AFTER the commit-phase (final pre-commit) subscription read — inside the validate->dispatch window",
  );
  assert.deepEqual(mock.concurrentAddAt!.stateAfterAdd, [`${PLAN} x1`, `${ADDON} x1`, `${CONCURRENT} x1`], "before dispatch, the subscription held the concurrent item");
  assert.deepEqual(mock.itemIds(), [PLAN, ADDON], "after the commit, the concurrently added item is GONE from the subscription");

  // ---- Verbatim evidence (printed before the failing assertion so
  // ---- the failing run preserves it; also in research/issue-22/FINDINGS.md).
  console.log("=== TEST43.1 EVIDENCE (observed on unmodified main) ===");
  console.log(JSON.stringify({
    authorizedChange: "CHANGE_QUANTITY pilot-addon-vision 1 -> 21 (only)",
    concurrentMutation: "third party adds pilot-addon-concurrent x1 (an ordinary unrelated addon) after the adapter's final pre-commit read/validation, before dispatch",
    dispatchedRequest: {
      operation: "POST /subscriptions/{subscriptionId}/update_for_items",
      replace_items_list: dispatch.params["replace_items_list"],
      items: sentIds.map((id, i) => ({ item_price_id: id, quantity: dispatch.params[`subscription_items[quantity][${i}]`] })),
      prorate: dispatch.params["prorate"],
      invoice_immediately: dispatch.params["invoice_immediately"],
      change_option: dispatch.params["change_option"],
      rawBody: dispatch.rawBody,
    },
    subscriptionStateAfterCommit: mock.itemIds(),
    unauthorizedItemDeleted: !mock.itemIds().includes(CONCURRENT),
    receipt: {
      status: receipt.status,
      outcome: receipt.outcome,
      reconciliation: receipt.reconciliation,
      committedImmediateNet: receipt.committedEffect.immediate?.net,
      committedRecurring: receipt.committedEffect.recurring?.resultingAmount,
      resultingSnapshotItems: receipt.resultingSnapshot?.items?.map((i: any) => i.id),
    },
  }, null, 2));
  console.log("=== END TEST43.1 EVIDENCE ===");

  // ---- THE SAFE BEHAVIOR (fails on unmodified main = the defect).
  // An execution whose full-list replacement deleted an item that
  // was never part of the authorized change must not be classified
  // as a verified, in-envelope success: the receipt must surface
  // the loss (MISMATCH / UNVERIFIED / VIOLATED) or the commit must
  // have refused. Target-state equality with the STALE intended
  // set is not authorization preservation.
  assert.ok(
    !(receipt.outcome === "COMMITTED_AND_VERIFIED" && receipt.reconciliation.status === "OK"),
    `authorization-preservation violation reported as success: outcome=${receipt.outcome}, reconciliation=${receipt.reconciliation.status} ` +
      `although the dispatch deleted ${CONCURRENT}, which was never part of the authorized change`,
  );
});

// ---------------------------------------------------------------------------
// 43.2 — CONTROL: no concurrent write (passes on main)
// ---------------------------------------------------------------------------

test("Test 43.2 (Issue #22 F1 control): the same quote+commit with NO concurrent write verifies cleanly", async () => {
  const mock = new ConcurrentAddMockChargebee();
  const { adapter } = makeAdapter(mock);
  const quote = await adapter.createChangeQuote(SUB, PROPOSAL(21));
  const receipt = await adapter.commitChangeQuote(quote.id);
  assert.equal(receipt.outcome, "COMMITTED_AND_VERIFIED");
  assert.equal(receipt.reconciliation.status, "OK");
  assert.deepEqual(mock.itemIds(), [PLAN, ADDON]);
  assert.equal(receipt.committedEffect.recurring?.resultingAmount, 80900);
});

// ---------------------------------------------------------------------------
// 43.3 — CONTROL: concurrent write BEFORE the commit's first read
// is caught by the fingerprint (QUOTE_STALE) — the protected window
// ends at the final pre-commit read. (Passes on main.)
// ---------------------------------------------------------------------------

test("Test 43.3 (Issue #22 F1 control): a concurrent addition landing BEFORE the commit-phase read refuses QUOTE_STALE with zero dispatches", async () => {
  const mock = new ConcurrentAddMockChargebee();
  const { adapter } = makeAdapter(mock);
  const quote = await adapter.createChangeQuote(SUB, PROPOSAL(21));
  mock.applyConcurrentAddNow(); // lands between quote and commit — before the commit's first read
  await assert.rejects(
    () => adapter.commitChangeQuote(quote.id),
    (e: unknown) => e instanceof SCQError && e.code === "QUOTE_STALE",
  );
  assert.equal(mock.updateDispatches.length, 0, "no mutating dispatch occurred");
  assert.deepEqual(mock.itemIds(), [PLAN, ADDON, CONCURRENT], "the concurrent item survives — the refusal protected it");
});

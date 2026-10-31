// SCQ G-17 PROTOTYPE — stateful mocked Chargebee transport for the
// authorization-preserving (non-replacement) update investigation
// (Issue #30). SIMULATED ONLY: no network, no credentials, no live
// provider behavior is claimed by anything in this file.
//
// The mock implements the Chargebee `update_for_items` wire surface
// under TWO explicitly separated kinds of rules:
//
//  (D) DOCUMENTED rules — taken from Chargebee's public API docs
//      (consulted 2026-10-31; see research/G17-AUTHORIZATION-
//      PRESERVING-PROTOTYPE.md §2 for the source table):
//        D1. `replace_items_list` defaults to false; with false, the
//            supplied items are ADDED to the existing list; with
//            true and a plan in the payload, the ENTIRE item list
//            is replaced; with true and addons only, existing addons
//            are replaced except mandatory addons not listed in
//            `mandatory_items_to_remove`.
//        D2. Addons-only payloads always retain the existing plan.
//        D3. With false and a plan in the payload: if multi-plan is
//            disabled the existing plan item price is replaced; if
//            multi-plan is enabled the existing plan is RETAINED and
//            the supplied plan is added alongside it.
//        D4. Updating a subscription DELETES an existing (legacy)
//            scheduled change when Ramps are disabled; with Ramps in
//            compatibility mode a single API-created ramp is deleted
//            and later ramps can be moved to draft. (This mock models
//            the Ramps-disabled branch and says so.)
//        D5. Native idempotency: same key + same parameters replays
//            the original response inside the window; same key +
//            different parameters is HTTP 422.
//        D6. `resource_version` is a millisecond TIMESTAMP of the
//            most recent change (per the subscription-object docs:
//            "updated with a new timestamp in milliseconds for every
//            change made to the resource"); it is response-side
//            only. This mock does NOT accept it (or any other field)
//            as a write precondition, because no documented write
//            parameter carries an expected version.
//            CORRECTED in the G17-R2 review round: the first version
//            of this mock advanced the version by a fixed +1000 per
//            change, which made it behave like a change COUNTER.
//            A real timestamp is not a counter: the delta between
//            two versions measures ELAPSED TIME, not the number of
//            changes; several changes inside one millisecond leave
//            the version unchanged (collision), and one change long
//            after another produces a huge delta. The mock now
//            models exactly that, via a controllable clock
//            (setTime/advanceTime): every mutation stamps the
//            version with the current mock time, so tests can
//            produce varying increments and same-millisecond
//            collisions. No verdict may count changes from it.
//
//  (A) ASSUMED rules — the documentation does NOT establish these.
//      They are parameters of this mock precisely so tests can show
//      that the preservation verdict DEPENDS on them:
//        A1. Same-item-price-ID behavior in additive mode. The docs
//            call `subscription_items` "the list of item prices to
//            add or update" and `item_price_id` the id "to add or
//            update", which supports an update-in-place READING —
//            but they never state whether a same-ID entry updates in
//            place, is appended as a duplicate, has its quantity
//            summed, or is rejected. `sameIdBehavior` selects the
//            behavior; the prototype's positive quantity tests run
//            under "update_in_place" and are labeled ASSUMED, and the
//            same wire request is also run under the other three
//            behaviors to prove the verdict is not portable.
//        A2. Proration arithmetic for a quantity delta (full
//            remaining-period delta x unit price). Real Chargebee
//            prorates by remaining time and site settings; no test
//            in this package treats mock financial figures as
//            provider evidence.
//
// Fault injection (test-only, mirrors PilotMockChargebee's style):
// partial application that silently drops an unrelated item, a
// silently ignored target, and a lost response after application.

import type { HttpRequest, HttpResponse, HttpTransport } from "../chargebee-http.js";

export type G17SameIdBehavior = "update_in_place" | "duplicate_entry" | "quantity_summed" | "reject";

export type G17MockOptions = {
  /** ASSUMED rule A1. Default "update_in_place" (the "add or update" reading). */
  sameIdBehavior?: G17SameIdBehavior;
  /** DOCUMENTED rule D3 switch. Default false. */
  multiPlanEnabled?: boolean;
  /** After applying the target, silently drop this unrelated item (partial application). */
  partialApplyDropItemId?: string;
  /** Provider-side COLLATERAL effect: applying the update silently removes this coupon. The item list is unaffected — this exists to prove the prototype's verdict does not cover coupon/discount state (G17-R4 counterexample). */
  collateralDropCouponId?: string;
  /** Return a success-shaped 200 but do not apply the target item at all. */
  ignoreTarget?: boolean;
  /** Apply the update, record idempotency, then throw (lost response). */
  loseUpdateResponse?: boolean;
};

export type G17Call = {
  method: string;
  path: string;
  mutating: boolean;
  /** Parsed `replace_items_list` for update calls; undefined otherwise. */
  replaceItemsList?: boolean;
  /** Parsed item price ids for update calls, in wire order. */
  itemPriceIds?: string[];
  idempotencyKey?: string;
};

type G17Item = {
  item_price_id: string;
  item_type: string;
  quantity: number;
  unit_price: number;
  amount: number;
};

export const G17_SUBSCRIPTION_ID = "g17-sub-001";
export const G17_PLAN_MONTHLY = "g17-plan-monthly";
export const G17_PLAN_PRO_MONTHLY = "g17-plan-pro-monthly";
export const G17_PLAN_YEARLY = "g17-plan-yearly";
export const G17_ADDON_SEATS = "g17-addon-seats";
export const G17_ADDON_SUPPORT = "g17-addon-support";
export const G17_ADDON_STORAGE = "g17-addon-storage";
export const G17_ADDON_MANDATORY = "g17-addon-mandatory";
export const G17_ADDON_EXTERNAL = "g17-addon-external";
export const G17_COUPON_WELCOME = "g17-coupon-welcome10";

const CATALOG: Record<string, { price: number; pricing_model: string; item_type: string; period?: string }> = {
  [G17_PLAN_MONTHLY]: { price: 49900, pricing_model: "flat_fee", item_type: "plan", period: "month" },
  [G17_PLAN_PRO_MONTHLY]: { price: 79900, pricing_model: "flat_fee", item_type: "plan", period: "month" },
  [G17_PLAN_YEARLY]: { price: 499000, pricing_model: "flat_fee", item_type: "plan", period: "year" },
  [G17_ADDON_SEATS]: { price: 1200, pricing_model: "per_unit", item_type: "addon" },
  [G17_ADDON_SUPPORT]: { price: 500, pricing_model: "per_unit", item_type: "addon" },
  [G17_ADDON_STORAGE]: { price: 300, pricing_model: "per_unit", item_type: "addon" },
  [G17_ADDON_MANDATORY]: { price: 2500, pricing_model: "flat_fee", item_type: "addon" },
  [G17_ADDON_EXTERNAL]: { price: 700, pricing_model: "per_unit", item_type: "addon" },
};

function amountFor(itemPriceId: string, quantity: number, unitPrice: number): number {
  return CATALOG[itemPriceId]?.pricing_model === "flat_fee" ? unitPrice : unitPrice * quantity;
}

export class G17MockChargebee {
  calls: G17Call[] = [];
  /** Mock wall clock (ms). `resource_version` is stamped from it (D6). */
  private nowMs = 1700000000000;
  private resourceVersion = 1700000000000;
  private coupons: string[] = [G17_COUPON_WELCOME];
  private items: G17Item[] = [
    { item_price_id: G17_PLAN_MONTHLY, item_type: "plan", quantity: 1, unit_price: 49900, amount: 49900 },
    // Subscription-level unit_price override (catalog 1200, charged 1000).
    { item_price_id: G17_ADDON_SEATS, item_type: "addon", quantity: 1, unit_price: 1000, amount: 1000 },
    { item_price_id: G17_ADDON_SUPPORT, item_type: "addon", quantity: 2, unit_price: 500, amount: 1000 },
  ];
  private mandatoryItemIds = new Set<string>();
  private hasScheduledChanges = false;
  private currencyCode = "USD";
  private status = "active";
  private idempotency = new Map<string, { paramsHash: string; json: any }>();

  constructor(private options: G17MockOptions = {}) {}

  get mutationCount(): number { return this.calls.filter((c) => c.mutating).length; }
  get currentResourceVersion(): number { return this.resourceVersion; }

  /** Test clock controls (D6): set or advance the mock wall clock.
   * Mutations stamp `resource_version` with the CURRENT time, so
   * changes made without advancing the clock collide at the same
   * timestamp — exactly as real same-millisecond changes do. */
  setTime(ms: number): void { this.nowMs = ms; }
  advanceTime(deltaMs: number): void { this.nowMs += deltaMs; }
  private touch(): void { this.resourceVersion = this.nowMs; }

  // ---- Test-facing external-actor surface (NOT part of the wire API).
  // Each helper models an independent actor changing provider state
  // between the prototype's stages and bumps resource_version (D6),
  // exactly as any real change would.

  externalAddItem(itemPriceId: string, quantity: number, opts: { mandatory?: boolean } = {}): void {
    const meta = CATALOG[itemPriceId];
    const unitPrice = meta?.price ?? 0;
    this.items.push({ item_price_id: itemPriceId, item_type: meta?.item_type ?? "addon", quantity, unit_price: unitPrice, amount: amountFor(itemPriceId, quantity, unitPrice) });
    if (opts.mandatory) this.mandatoryItemIds.add(itemPriceId);
    this.touch();
  }

  externalSetQuantity(itemPriceId: string, quantity: number): void {
    const it = this.items.find((i) => i.item_price_id === itemPriceId);
    if (!it) throw new Error(`externalSetQuantity: ${itemPriceId} not present`);
    it.quantity = quantity;
    it.amount = amountFor(itemPriceId, quantity, it.unit_price);
    this.touch();
  }

  externalRemoveItem(itemPriceId: string): void {
    this.items = this.items.filter((i) => i.item_price_id !== itemPriceId);
    this.mandatoryItemIds.delete(itemPriceId);
    this.touch();
  }

  externalChangePlan(newPlanItemPriceId: string, currencyCode?: string): void {
    const meta = CATALOG[newPlanItemPriceId];
    if (!meta || meta.item_type !== "plan") throw new Error(`externalChangePlan: ${newPlanItemPriceId} is not a plan`);
    this.items = this.items.filter((i) => i.item_type !== "plan");
    this.items.unshift({ item_price_id: newPlanItemPriceId, item_type: "plan", quantity: 1, unit_price: meta.price, amount: meta.price });
    if (currencyCode) this.currencyCode = currencyCode;
    this.touch();
  }

  externalScheduleChange(): void { this.hasScheduledChanges = true; this.touch(); }
  externalCancelScheduledChange(): void { this.hasScheduledChanges = false; this.touch(); }

  /** External actor removes a coupon. The prototype executor never
   * reads coupon state — that blindness is the G17-R4 point. */
  externalRemoveCoupon(couponId: string): void {
    this.coupons = this.coupons.filter((c) => c !== couponId);
    this.touch();
  }

  /** Direct state read for test assertions (bypasses the wire log). */
  peekItems(): Array<{ item_price_id: string; quantity: number }> {
    return this.items.map((i) => ({ item_price_id: i.item_price_id, quantity: i.quantity }));
  }
  peekHasScheduledChanges(): boolean { return this.hasScheduledChanges; }
  peekCoupons(): string[] { return [...this.coupons]; }

  private subscriptionJson(): any {
    return {
      subscription: {
        id: G17_SUBSCRIPTION_ID,
        status: this.status,
        currency_code: this.currencyCode,
        resource_version: this.resourceVersion,
        current_term_start: 1700000000,
        current_term_end: 1702592000,
        next_billing_at: 1702592000,
        has_scheduled_changes: this.hasScheduledChanges,
        coupon_ids: [...this.coupons],
        has_scheduled_advance_invoices: false,
        subscription_items: this.items.map((i) => ({ ...i })),
      },
    };
  }

  private parseUpdateBody(body: string): { replaceItemsList: boolean; items: Array<{ item_price_id: string; quantity?: number; unit_price?: number }>; mandatoryItemsToRemove: string[] } {
    const params = new URLSearchParams(body);
    const byIndex = new Map<number, { item_price_id?: string; quantity?: number; unit_price?: number }>();
    const mandatoryItemsToRemove: string[] = [];
    for (const [k, v] of params.entries()) {
      const m = k.match(/^subscription_items\[(item_price_id|quantity|unit_price)\]\[(\d+)\]$/);
      if (m) {
        const idx = Number(m[2]);
        const entry = byIndex.get(idx) ?? {};
        if (m[1] === "item_price_id") entry.item_price_id = v;
        else if (m[1] === "quantity") entry.quantity = Number(v);
        else entry.unit_price = Number(v);
        byIndex.set(idx, entry);
        continue;
      }
      if (k.startsWith("mandatory_items_to_remove")) mandatoryItemsToRemove.push(v);
    }
    const items = [...byIndex.entries()].sort((a, b) => a[0] - b[0]).map(([, e]) => ({ item_price_id: e.item_price_id!, quantity: e.quantity, unit_price: e.unit_price }));
    return { replaceItemsList: params.get("replace_items_list") === "true", items, mandatoryItemsToRemove };
  }

  private applyUpdate(parsed: ReturnType<G17MockChargebee["parseUpdateBody"]>): { status: number; json: any } | undefined {
    const { replaceItemsList, items, mandatoryItemsToRemove } = parsed;
    // ASSUMED rule A1, "reject" branch: a same-ID entry in additive
    // mode is rejected before any state change.
    if (!replaceItemsList && this.options.sameIdBehavior === "reject") {
      const dup = items.find((r) => this.items.some((i) => i.item_price_id === r.item_price_id));
      if (dup) return { status: 400, json: { api_error_code: "invalid_request", message: `subscription_items: ${dup.item_price_id} already exists (ASSUMED reject behavior)` } };
    }

    const before = new Map<string, number>();
    for (const i of this.items) before.set(i.item_price_id, (before.get(i.item_price_id) ?? 0) + i.quantity);

    if (replaceItemsList) {
      // DOCUMENTED rule D1, true branch.
      const hasPlan = items.some((r) => CATALOG[r.item_price_id]?.item_type === "plan");
      const kept: G17Item[] = [];
      if (!hasPlan) {
        // Addons-only replacement: plan retained (D2); mandatory
        // addons kept unless explicitly removed (D1).
        for (const i of this.items) {
          if (i.item_type === "plan") kept.push(i);
          else if (this.mandatoryItemIds.has(i.item_price_id) && !mandatoryItemsToRemove.includes(i.item_price_id)) kept.push(i);
        }
      }
      this.items = kept;
      for (const r of items) this.upsertAbsolute(r);
    } else {
      // Additive mode (DOCUMENTED D1/D2/D3 + ASSUMED A1).
      for (const r of items) {
        const meta = CATALOG[r.item_price_id];
        const existing = this.items.find((i) => i.item_price_id === r.item_price_id);
        if (meta?.item_type === "plan") {
          if (!existing) {
            if (this.options.multiPlanEnabled) {
              // D3, multi-plan enabled: existing plan retained, new plan added.
              this.items.push(this.materialize(r));
            } else {
              // D3, multi-plan disabled: existing plan item price replaced.
              this.items = this.items.filter((i) => i.item_type !== "plan");
              this.items.unshift(this.materialize(r));
            }
          } else {
            this.upsertAbsolute(r);
          }
          continue;
        }
        if (!existing) { this.items.push(this.materialize(r)); continue; }
        switch (this.options.sameIdBehavior ?? "update_in_place") {
          case "update_in_place": this.upsertAbsolute(r); break;
          case "duplicate_entry": this.items.push(this.materialize(r, existing)); break;
          case "quantity_summed": {
            const qty = existing.quantity + (r.quantity ?? 1);
            existing.quantity = qty;
            if (r.unit_price !== undefined) existing.unit_price = r.unit_price;
            existing.amount = amountFor(existing.item_price_id, qty, existing.unit_price);
            break;
          }
          case "reject": break; // handled above
        }
      }
    }

    // DOCUMENTED rule D4 (Ramps-disabled branch): an update deletes
    // an existing legacy scheduled change.
    if (this.hasScheduledChanges) this.hasScheduledChanges = false;

    if (this.options.partialApplyDropItemId) {
      this.items = this.items.filter((i) => i.item_price_id !== this.options.partialApplyDropItemId);
    }

    // G17-R4 collateral fault: the update itself silently removes a
    // coupon. Item state is untouched; only a verdict scoped to the
    // item subset can (and must) remain silent about this.
    if (this.options.collateralDropCouponId) {
      this.coupons = this.coupons.filter((c) => c !== this.options.collateralDropCouponId);
    }

    this.touch();

    // ASSUMED rule A2: full-remaining-period delta pricing for
    // per-unit quantity changes, for response shape only.
    let incurred = 0;
    for (const i of this.items) {
      const was = before.get(i.item_price_id) ?? 0;
      if (CATALOG[i.item_price_id]?.pricing_model === "per_unit") incurred += (i.quantity - was) * i.unit_price;
    }
    const sub = this.subscriptionJson();
    return { status: 200, json: { subscription: sub.subscription, unbilled_charges: [{ amount: incurred }] } };
  }

  private materialize(r: { item_price_id: string; quantity?: number; unit_price?: number }, existing?: G17Item): G17Item {
    const meta = CATALOG[r.item_price_id];
    const unitPrice = r.unit_price ?? existing?.unit_price ?? meta?.price ?? 0;
    const quantity = r.quantity ?? 1;
    return { item_price_id: r.item_price_id, item_type: meta?.item_type ?? existing?.item_type ?? "addon", quantity, unit_price: unitPrice, amount: amountFor(r.item_price_id, quantity, unitPrice) };
  }

  private upsertAbsolute(r: { item_price_id: string; quantity?: number; unit_price?: number }): void {
    const existing = this.items.find((i) => i.item_price_id === r.item_price_id);
    if (!existing) { this.items.push(this.materialize(r)); return; }
    if (r.quantity !== undefined) existing.quantity = r.quantity;
    if (r.unit_price !== undefined) existing.unit_price = r.unit_price;
    existing.amount = amountFor(existing.item_price_id, existing.quantity, existing.unit_price);
  }

  transport: HttpTransport = async (req: HttpRequest): Promise<HttpResponse> => {
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/api\/v2/, "");
    const json = (status: number, body: any, headers: Record<string, string> = {}): HttpResponse => ({ status, headers, json: body });

    if (req.method === "GET" && path.startsWith("/subscriptions/")) {
      this.calls.push({ method: req.method, path, mutating: false });
      return json(200, this.subscriptionJson());
    }

    if (req.method === "POST" && path.includes("/update_for_items")) {
      const parsed = this.parseUpdateBody(req.body ?? "");
      const key = req.headers["chargebee-idempotency-key"];
      this.calls.push({ method: req.method, path, mutating: true, replaceItemsList: parsed.replaceItemsList, itemPriceIds: parsed.items.map((i) => i.item_price_id), idempotencyKey: key });
      // DOCUMENTED rule D5.
      if (key && this.idempotency.has(key)) {
        const prior = this.idempotency.get(key)!;
        if (prior.paramsHash !== (req.body ?? "")) return json(422, { api_error_code: "duplicate_request", message: "Idempotency key reused with different parameters" });
        return json(200, prior.json, { "chargebee-idempotency-replayed": "true" });
      }
      if (this.options.ignoreTarget) {
        // Apply everything EXCEPT the requested items: emulate a
        // provider that acknowledges but does not land the target.
        const saved = this.items;
        const result = this.applyUpdate({ replaceItemsList: parsed.replaceItemsList, items: [], mandatoryItemsToRemove: [] });
        this.items = saved.map((i) => ({ ...i }));
        if (key && result) this.idempotency.set(key, { paramsHash: req.body ?? "", json: result.json });
        return json(result?.status ?? 200, result?.json ?? this.subscriptionJson());
      }
      const result = this.applyUpdate(parsed);
      if (!result) return json(500, { api_error_code: "internal_error" });
      if (result.status !== 200) return json(result.status, result.json);
      if (key) this.idempotency.set(key, { paramsHash: req.body ?? "", json: result.json });
      if (this.options.loseUpdateResponse) throw new Error("socket hang up (simulated lost response)");
      return json(200, result.json);
    }

    this.calls.push({ method: req.method, path, mutating: false });
    return json(404, { api_error_code: "resource_not_found" });
  };
}

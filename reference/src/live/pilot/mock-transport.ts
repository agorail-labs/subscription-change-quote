// SCQ Chargebee PILOT — fixture-driven mocked Chargebee transport.
//
// A deterministic, in-memory fake of the Chargebee API v2 surface the
// live adapter uses (GET subscription, GET item_price, POST estimate,
// POST update_for_items), built for the reproducible pilot harness and
// its negative/recovery tests. It is a SEPARATE, slimmer fixture than
// test13's conformance fake: test13 proves adapter behavior against
// wire shapes captured from the real API; this fixture exists so a
// developer can run the pilot workflow end-to-end and script faults
// against it. Everything backed by this file is SIMULATED — never
// LIVE_PASS.
//
// Fixture subscription (synthetic; mirrors the Phase 3 demo shape):
//   - plan  "pilot-plan-business": flat_fee, 59900 minor units, qty 1.
//   - addon "pilot-addon-vision":  per_unit, subscription unit_price
//     override 1000 (catalog price 10000), qty 1, amount 1000.
//   Baseline recurring = 60900. The canonical pilot proposal raises
//   the addon quantity 1 -> 21: recurring 80900, immediate 20000.
//
// Fixture proration rule (stated, deterministic): the mock models a
// FULL remaining billing period, so a per_unit quantity delta incurs
// delta x unit_price as unbilled charges. Real Chargebee prorates by
// remaining time (the Oct 27 live run observed 20 x 9262 for the same
// shape); time-dependent proration is a live behavior and is NOT
// claimed by this fixture.

import type { HttpRequest, HttpResponse, HttpTransport } from "../chargebee-http.js";

export type PilotMockFaults = {
  /** unbilled_charge_estimates element carries NO amount -> immediate undeterminable. */
  omitUnbilledAmount?: boolean;
  /** credit_note_estimates member absent entirely -> net cannot be finalized. */
  dropCreditNotesMember?: boolean;
  /** subscription_estimate states ONLY the changed item -> partial stated list. */
  partialStatedItems?: boolean;
  /** Adds next_invoice_estimate whose amount_due is reduced by credits (total unchanged). */
  includeNextInvoiceWithCredits?: boolean;
  /** Overrides catalog pricing_model per item price id (e.g. "tiered"). */
  pricingModelOverride?: Record<string, string>;
  /** update_for_items applies, then the transport throws (lost response). */
  loseUpdateResponse?: boolean;
  /** update_for_items returns a success-shaped 200 but changes nothing. */
  silentIgnoreUpdate?: boolean;
  /** update_for_items additionally attaches this item price id (mandatory-addon interference). */
  mandatoryAddonOnUpdate?: string;
  /** Update response carries neither invoice nor unbilled_charges -> immediate actual undetermined. */
  incompleteUpdateResponse?: boolean;
  /** Post-update subscription items lose their stated amounts -> recurring actual undetermined. */
  postUpdateItemsMissingAmounts?: boolean;
};

export type PilotCall = { method: string; path: string; mutating: boolean; idempotencyKey?: string };

type PilotItem = { item_price_id: string; item_type: string; quantity: number; unit_price: number; amount: number; free_quantity?: number };

const CATALOG: Record<string, { price: number; pricing_model: string; free_quantity: number; item_type: string }> = {
  "pilot-plan-business": { price: 59900, pricing_model: "flat_fee", free_quantity: 0, item_type: "plan" },
  "pilot-addon-vision": { price: 10000, pricing_model: "per_unit", free_quantity: 0, item_type: "addon" },
  "pilot-addon-mandatory": { price: 2500, pricing_model: "flat_fee", free_quantity: 0, item_type: "addon" },
};

function itemAmount(itemPriceId: string, quantity: number, unitPrice: number): number {
  const meta = CATALOG[itemPriceId];
  return meta?.pricing_model === "flat_fee" ? unitPrice : unitPrice * quantity;
}

export class PilotMockChargebee {
  calls: PilotCall[] = [];
  lastEstimateJson: any = undefined;
  lastUpdateJson: any = undefined;
  hasScheduledChanges = false;
  private resourceVersion = 1700000000000;
  private items: PilotItem[] = [
    { item_price_id: "pilot-plan-business", item_type: "plan", quantity: 1, unit_price: 59900, amount: 59900 },
    { item_price_id: "pilot-addon-vision", item_type: "addon", quantity: 1, unit_price: 1000, amount: 1000, free_quantity: 0 },
  ];
  private idempotency = new Map<string, { paramsHash: string; json: any }>();

  constructor(private faults: PilotMockFaults = {}) {}

  get mutationCount(): number { return this.calls.filter((c) => c.mutating).length; }
  get estimateCount(): number { return this.calls.filter((c) => c.path.includes("/estimates/")).length; }

  private subscriptionJson(): any {
    return {
      subscription: {
        id: "pilot-sub-001",
        status: "active",
        currency_code: "USD",
        resource_version: this.resourceVersion,
        current_term_start: 1700000000,
        current_term_end: 1702592000,
        next_billing_at: 1702592000,
        has_scheduled_changes: this.hasScheduledChanges,
        has_scheduled_advance_invoices: false,
        subscription_items: this.items.map((i) => ({ ...i })),
      },
    };
  }

  /** Simulates a concurrent actor changing the subscription between quote and commit. */
  applyExternalChange(itemPriceId: string, quantity: number): void {
    const it = this.items.find((i) => i.item_price_id === itemPriceId);
    if (it) { it.quantity = quantity; it.amount = itemAmount(itemPriceId, quantity, it.unit_price); }
    this.resourceVersion += 1000;
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
    const estimate: any = {};
    // Immediate: unbilled charges for the priced delta of the per_unit
    // addon (fixture rule: full remaining period). No priced delta ->
    // both members present and empty (a provider-stated zero).
    const currentAddon = this.items.find((i) => i.item_price_id === "pilot-addon-vision")!;
    const targetAddon = requested.find((i) => i.item_price_id === "pilot-addon-vision");
    const delta = (targetAddon?.quantity ?? currentAddon.quantity) - currentAddon.quantity;
    const incurred = delta * currentAddon.unit_price;
    if (incurred !== 0) {
      estimate.unbilled_charge_estimates = [this.faults.omitUnbilledAmount ? {} : { amount: incurred }];
    } else {
      estimate.unbilled_charge_estimates = [];
    }
    if (!this.faults.dropCreditNotesMember) estimate.credit_note_estimates = [];
    // Recurring: stated item list for the requested set.
    const statedAll = requested.map((r) => {
      const cur = this.items.find((i) => i.item_price_id === r.item_price_id);
      const unitPrice = cur?.unit_price ?? CATALOG[r.item_price_id]?.price ?? 0;
      return { item_price_id: r.item_price_id, quantity: r.quantity, unit_price: unitPrice, amount: itemAmount(r.item_price_id, r.quantity, unitPrice) };
    });
    estimate.subscription_estimate = {
      subscription_items: this.faults.partialStatedItems ? statedAll.filter((s) => s.item_price_id === "pilot-addon-vision") : statedAll,
    };
    if (this.faults.includeNextInvoiceWithCredits) {
      // Next-cycle figure: total is the post-change price level;
      // amount_due is net of a 300 credit. Neither is the incurred
      // obligation and neither may enter the effect.
      estimate.next_invoice_estimate = { total: 80900, amount_due: 80600, credits_applied: 300, date: 1702592000, line_items: [{}, {}] };
    }
    return { estimate };
  }

  private applyUpdate(requested: Array<{ item_price_id: string; quantity: number }>): any {
    const before = new Map(this.items.map((i) => [i.item_price_id, i.quantity]));
    this.items = requested.map((r) => {
      const cur = this.items.find((i) => i.item_price_id === r.item_price_id);
      const unitPrice = cur?.unit_price ?? CATALOG[r.item_price_id]?.price ?? 0;
      return {
        item_price_id: r.item_price_id,
        item_type: CATALOG[r.item_price_id]?.item_type ?? "addon",
        quantity: r.quantity,
        unit_price: unitPrice,
        amount: itemAmount(r.item_price_id, r.quantity, unitPrice),
        ...(CATALOG[r.item_price_id]?.pricing_model === "per_unit" ? { free_quantity: 0 } : {}),
      };
    });
    if (this.faults.mandatoryAddonOnUpdate && !this.items.some((i) => i.item_price_id === this.faults.mandatoryAddonOnUpdate)) {
      const id = this.faults.mandatoryAddonOnUpdate;
      this.items.push({ item_price_id: id, item_type: "addon", quantity: 1, unit_price: CATALOG[id]?.price ?? 0, amount: CATALOG[id]?.price ?? 0 });
    }
    this.resourceVersion += 1000;
    const addonBefore = before.get("pilot-addon-vision") ?? 0;
    const addonAfter = this.items.find((i) => i.item_price_id === "pilot-addon-vision")?.quantity ?? 0;
    const incurred = (addonAfter - addonBefore) * 1000;
    const subJson = this.subscriptionJson();
    if (this.faults.postUpdateItemsMissingAmounts) {
      for (const i of subJson.subscription.subscription_items) delete i.amount;
    }
    return this.faults.incompleteUpdateResponse
      ? { subscription: subJson.subscription }
      : { subscription: subJson.subscription, unbilled_charges: [{ amount: incurred }] };
  }

  transport: HttpTransport = async (req: HttpRequest): Promise<HttpResponse> => {
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/api\/v2/, "");
    const mutating = req.method === "POST" && path.includes("/update_for_items") && !path.includes("/estimates/");
    this.calls.push({ method: req.method, path, mutating, idempotencyKey: req.headers["chargebee-idempotency-key"] });
    const json = (status: number, body: any, headers: Record<string, string> = {}): HttpResponse => ({ status, headers, json: body });

    if (req.method === "GET" && path.startsWith("/subscriptions/")) return json(200, this.subscriptionJson());
    if (req.method === "GET" && path.startsWith("/item_prices/")) {
      const id = decodeURIComponent(path.slice("/item_prices/".length));
      const meta = CATALOG[id];
      if (!meta) return json(404, { api_error_code: "resource_not_found" });
      return json(200, { item_price: { id, pricing_model: this.faults.pricingModelOverride?.[id] ?? meta.pricing_model, price: meta.price, free_quantity: meta.free_quantity, item_type: meta.item_type } });
    }
    if (req.method === "POST" && path === "/estimates/update_subscription_for_items") {
      const body = new URLSearchParams(req.body ?? "");
      if (!body.get("subscription[id]")) return json(400, { api_error_code: "param_required", message: "subscription[id] : cannot be blank" });
      const requested = this.parseItems(req.body ?? "");
      const flatQtyChange = requested.find((r) => {
        const cur = this.items.find((i) => i.item_price_id === r.item_price_id);
        return CATALOG[r.item_price_id]?.pricing_model === "flat_fee" && cur && cur.quantity !== r.quantity;
      });
      if (flatQtyChange) return json(400, { api_error_code: "invalid_request", message: "This param should not be sent for on_off addon type" });
      this.lastEstimateJson = this.buildEstimate(requested);
      return json(200, this.lastEstimateJson);
    }
    if (req.method === "POST" && path.includes("/update_for_items")) {
      const key = req.headers["chargebee-idempotency-key"];
      const paramsHash = req.body ?? "";
      if (key && this.idempotency.has(key)) {
        const prior = this.idempotency.get(key)!;
        if (prior.paramsHash !== paramsHash) return json(422, { api_error_code: "duplicate_request", message: "Idempotency key reused with different parameters" });
        return json(200, prior.json, { "chargebee-idempotency-replayed": "true" });
      }
      const requested = this.parseItems(req.body ?? "");
      const result = this.faults.silentIgnoreUpdate ? { subscription: this.subscriptionJson().subscription } : this.applyUpdate(requested);
      this.lastUpdateJson = result;
      if (key) this.idempotency.set(key, { paramsHash, json: result });
      if (this.faults.loseUpdateResponse) throw new Error("socket hang up (simulated lost response)");
      return json(200, result);
    }
    return json(404, { api_error_code: "resource_not_found" });
  };
}

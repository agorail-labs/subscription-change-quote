// In-memory fake modeling a Stripe-like subscriptions API.
//
// Grounded in documented Stripe behavior as of this writing (not verified
// against live docs in this sandbox — see research-findings.md for explicit
// uncertainty notes):
//
// - Subscription objects have `items.data[].id` / `.price` / `.quantity`,
//   `current_period_end` (Stripe has been migrating some period fields onto
//   subscription *items* in newer API versions — modeled here at the
//   subscription level for simplicity, which is the older/more commonly
//   documented shape), `status`, `latest_invoice`.
// - `subscriptions.update` accepts `items: [{id, price, quantity}]` and
//   `proration_behavior: 'create_prorations' | 'none' | 'always_invoice'`.
// - Proration amounts are only fully knowable by calling the "upcoming
//   invoice" preview (conceptually `invoices.retrieveUpcoming` /
//   `invoices.createPreview` depending on API version) with the *proposed*
//   subscription_items — this does not mutate anything.
// - Stripe subscriptions do NOT expose an explicit optimistic-concurrency
//   version counter. There is no `version` or `etag` field on the object.
//   The closest thing to a change signal is the `created`/webhook event
//   stream (`customer.subscription.updated`), not a field you can compare-
//   and-swap against on the object itself. This simulator therefore does
//   NOT invent a version field — it only exposes what a real Stripe object
//   exposes, and the adapter computes a content hash over mutable fields
//   as an SCQ-layer workaround.
// - There is no native "commit this exact preview" call: the preview
//   (upcoming invoice) and the mutation (subscriptions.update) are two
//   separate API calls: the mutation recomputes proration internally at
//   call time, it does not accept a "frozen" proration result from an
//   earlier preview call.
//
// v0.2 addition — `proration_date`:
// Stripe's `subscriptions.update` (and the upcoming-invoice preview call)
// DOES accept a documented `proration_date` parameter: a unix timestamp
// that Stripe uses IN PLACE OF "now" when computing the remaining-time
// fraction for proration. This is real, documented Stripe behavior (used
// in production to make a preview and a later commit agree on the time
// basis) and is modeled faithfully here: if the SCQ adapter captures
// `proration_date = <preview call time>` and replays that exact value on
// `update()`, the AMOUNT can be pinned even if the update call happens
// later. This closes the specific mechanism gap v0.1 documented in Test 6.
//
// What `proration_date` does NOT fix (see research-findings.md v0.2 section
// for the full analysis):
//   - It only re-derives the *time-remaining fraction*. It does not freeze
//     tax, discounts, or coupon state, which are recomputed independently
//     at invoice-generation time from data that lives outside the
//     subscription object (not modeled in this sim at all).
//   - It is a Stripe-specific parameter with no confirmed Paddle analogue
//     (see paddle-sim.ts) — so "EXACT" guarantee strength is NOT
//     symmetric across providers even after this fix.
//   - Passing a `proration_date` that no longer falls within the CURRENT
//     billing period (e.g. the period rolled over between preview and
//     commit) is rejected by real Stripe, and is modeled here too.

import crypto from "node:crypto";

export type StripePrice = {
  id: string;
  unitAmount: number; // minor units
  currency: string;
  interval: "month" | "year";
};

export type StripeSubscriptionItem = {
  id: string; // si_...
  price: StripePrice;
  quantity: number;
};

export type StripeSubscription = {
  id: string; // sub_...
  status: "active" | "canceled" | "past_due";
  items: StripeSubscriptionItem[];
  current_period_start: number; // unix seconds
  current_period_end: number;
  cancel_at_period_end: boolean;
  canceled_at?: number;
  latest_invoice?: string;
};

export type UpcomingInvoicePreview = {
  amount_due: number; // signed net for this preview (can be negative = credit)
  lines: Array<{ description: string; amount: number; proration: boolean }>;
  next_period_recurring_amount: number;
};

type ProrationBehavior = "create_prorations" | "none" | "always_invoice";

const PRICE_CATALOG: Record<string, StripePrice> = {
  price_seat_basic: { id: "price_seat_basic", unitAmount: 1000, currency: "usd", interval: "month" },
  price_seat_pro: { id: "price_seat_pro", unitAmount: 1500, currency: "usd", interval: "month" },
  price_seat_basic_annual: { id: "price_seat_basic_annual", unitAmount: 10000, currency: "usd", interval: "year" },
};

export class StripeSim {
  private subs = new Map<string, StripeSubscription>();
  private now: number; // unix seconds, mutable so tests can simulate time passing

  constructor(nowUnixSeconds = Math.floor(Date.now() / 1000)) {
    this.now = nowUnixSeconds;
  }

  advanceTimeSeconds(seconds: number): void {
    this.now += seconds;
  }

  currentTime(): number {
    return this.now;
  }

  seedSubscription(sub: StripeSubscription): void {
    this.subs.set(sub.id, sub);
  }

  retrieve(id: string): StripeSubscription {
    const sub = this.subs.get(id);
    if (!sub) throw new StripeSimError("resource_missing", `No such subscription: ${id}`);
    // Return a deep copy — callers must go through update() to mutate.
    return structuredClone(sub);
  }

  /** Out-of-band mutation, simulating another system/webhook changing the sub directly. */
  _debugMutateDirectly(id: string, mutator: (sub: StripeSubscription) => void): void {
    const sub = this.subs.get(id);
    if (!sub) throw new StripeSimError("resource_missing", `No such subscription: ${id}`);
    mutator(sub);
  }

  /**
   * Fake "upcoming invoice" preview. Non-mutating. Computes proration the
   * same way `update()` would, based on current wall-clock (this.now) and
   * current period boundaries — this is the crux of the Test 6 finding:
   * the math is a function of *when you call it*, not frozen at preview time.
   */
  previewUpcomingInvoice(
    subscriptionId: string,
    proposedItems: Array<{ id?: string; price: string; quantity: number }>,
    prorationBehavior: ProrationBehavior,
    prorationDate?: number
  ): UpcomingInvoicePreview {
    const sub = this.retrieve(subscriptionId);
    return this.computeInvoice(sub, proposedItems, prorationBehavior, prorationDate);
  }

  /**
   * Fake `subscriptions.update`. Mutates the subscription and returns the
   * resulting object plus the invoice that was generated (if any).
   *
   * `prorationDate`: real Stripe parameter. When supplied, proration is
   * computed as of this timestamp instead of `this.now`. Real Stripe
   * rejects a `proration_date` outside the current billing period; modeled
   * below via StripeSimError('invalid_request_error', ...).
   */
  update(
    subscriptionId: string,
    proposedItems: Array<{ id?: string; price: string; quantity: number }>,
    prorationBehavior: ProrationBehavior,
    prorationDate?: number
  ): { subscription: StripeSubscription; invoice: UpcomingInvoicePreview } {
    const sub = this.subs.get(subscriptionId);
    if (!sub) throw new StripeSimError("resource_missing", `No such subscription: ${subscriptionId}`);

    if (
      prorationDate !== undefined &&
      (prorationDate < sub.current_period_start || prorationDate > sub.current_period_end)
    ) {
      throw new StripeSimError(
        "invalid_request_error",
        `proration_date (${prorationDate}) is outside the current period ` +
          `[${sub.current_period_start}, ${sub.current_period_end}]; the billing period has ` +
          `rolled over since this value was captured.`
      );
    }

    const invoice = this.computeInvoice(sub, proposedItems, prorationBehavior, prorationDate);

    // Apply item changes.
    for (const proposed of proposedItems) {
      if (proposed.id) {
        const existing = sub.items.find((i) => i.id === proposed.id);
        if (!existing) throw new StripeSimError("resource_missing", `No such item: ${proposed.id}`);
        const price = PRICE_CATALOG[proposed.price];
        if (!price) throw new StripeSimError("invalid_request_error", `No such price: ${proposed.price}`);
        existing.price = price;
        existing.quantity = proposed.quantity;
      } else {
        const price = PRICE_CATALOG[proposed.price];
        if (!price) throw new StripeSimError("invalid_request_error", `No such price: ${proposed.price}`);
        sub.items.push({ id: `si_${crypto.randomBytes(6).toString("hex")}`, price, quantity: proposed.quantity });
      }
    }
    sub.latest_invoice = `in_${crypto.randomBytes(6).toString("hex")}`;

    return { subscription: structuredClone(sub), invoice };
  }

  cancel(subscriptionId: string, atPeriodEnd: boolean): StripeSubscription {
    const sub = this.subs.get(subscriptionId);
    if (!sub) throw new StripeSimError("resource_missing", `No such subscription: ${subscriptionId}`);
    if (atPeriodEnd) {
      sub.cancel_at_period_end = true;
    } else {
      sub.status = "canceled";
      sub.canceled_at = this.now;
    }
    return structuredClone(sub);
  }

  /**
   * Content-hash fingerprint over mutable fields. This is the SCQ-layer
   * workaround for Stripe's lack of a native version/etag field — NOT
   * something Stripe itself exposes.
   */
  fingerprint(subscriptionId: string): string {
    const sub = this.retrieve(subscriptionId);
    const material = JSON.stringify({
      status: sub.status,
      items: sub.items.map((i) => ({ id: i.id, price: i.price.id, quantity: i.quantity })),
      current_period_start: sub.current_period_start,
      current_period_end: sub.current_period_end,
      cancel_at_period_end: sub.cancel_at_period_end,
    });
    return crypto.createHash("sha256").update(material).digest("hex").slice(0, 16);
  }

  private computeInvoice(
    sub: StripeSubscription,
    proposedItems: Array<{ id?: string; price: string; quantity: number }>,
    prorationBehavior: ProrationBehavior,
    prorationDate?: number
  ): UpcomingInvoicePreview {
    const asOf = prorationDate ?? this.now;
    const periodLength = sub.current_period_end - sub.current_period_start;
    const remaining = Math.max(0, sub.current_period_end - asOf);
    const fractionRemaining = periodLength > 0 ? remaining / periodLength : 0;

    const lines: UpcomingInvoicePreview["lines"] = [];
    let nextPeriodRecurring = 0;

    for (const proposed of proposedItems) {
      const newPrice = PRICE_CATALOG[proposed.price];
      if (!newPrice) throw new StripeSimError("invalid_request_error", `No such price: ${proposed.price}`);
      nextPeriodRecurring += newPrice.unitAmount * proposed.quantity;

      if (prorationBehavior === "none") continue;

      const existing = proposed.id ? sub.items.find((i) => i.id === proposed.id) : undefined;
      if (existing) {
        const oldRemainingValue = existing.price.unitAmount * existing.quantity * fractionRemaining;
        const newRemainingValue = newPrice.unitAmount * proposed.quantity * fractionRemaining;
        const delta = Math.round(newRemainingValue - oldRemainingValue);
        if (delta !== 0) {
          lines.push({
            description: delta > 0 ? "Remaining time proration (upgrade)" : "Remaining time credit (downgrade)",
            amount: delta,
            proration: true,
          });
        }
      } else {
        const newItemValue = Math.round(newPrice.unitAmount * proposed.quantity * fractionRemaining);
        lines.push({ description: "Remaining time on new item", amount: newItemValue, proration: true });
      }
    }

    // Unchanged existing items still contribute to next period recurring total.
    for (const existing of sub.items) {
      const touched = proposedItems.some((p) => p.id === existing.id);
      if (!touched) nextPeriodRecurring += existing.price.unitAmount * existing.quantity;
    }

    const amount_due = lines.reduce((sum, l) => sum + l.amount, 0);
    return { amount_due, lines, next_period_recurring_amount: nextPeriodRecurring };
  }
}

export class StripeSimError extends Error {
  constructor(public type: string, message: string) {
    super(message);
  }
}

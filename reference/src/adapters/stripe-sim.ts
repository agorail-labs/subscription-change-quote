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
  /**
   * v0.6.2 (PR-3): pre-existing customer credit balance, in minor
   * units — a CUSTOMER-level payment attribute (modeled on the
   * subscription record here only because this sim has no Customer
   * object). It is applied against invoice amounts due; it is NOT
   * subscription state, never enters the fingerprint, and never
   * changes what a change itself incurs. Modeled as a standing
   * fixture attribute: previews/updates report how much WOULD be
   * applied, but the sim does not deplete it (balance-ledger
   * lifecycle is out of scope for this model).
   */
  customer_balance?: number;
};

export type UpcomingInvoicePreview = {
  /**
   * v0.6.2 (PR-3) — the preview's figures are SPLIT by economic
   * meaning (previously `amount_due` was the bare proration total,
   * which let the adapter conflate a payment figure with an
   * incurred obligation):
   *
   * `incurred_amount` is the net obligation the PROPOSED CHANGE
   * itself incurs at its effective time — here, the sum of the
   * line items the change generates (proration lines; this sim
   * generates no other line kinds). Optional because fault
   * injection can withhold it from previews (see
   * `_debugOmitIncurredAmount`): an absent figure means the
   * preview cannot establish the incurred amount at all.
   */
  incurred_amount?: number;
  /**
   * The portion of the subscription's pre-existing
   * `customer_balance` that would be applied against this
   * invoice. Credits reduce what is DUE; they never change the
   * incurred obligation or any price.
   */
  customer_balance_applied: number;
  /**
   * The PAYMENT figure: `incurred_amount - customer_balance_applied`
   * (can be negative when the change itself nets to a credit).
   * This is what a customer would be charged for the upcoming
   * invoice — it is NOT the obligation the change incurs, and
   * must never be mapped into an SCQ `immediate` effect.
   */
  amount_due: number;
  lines: Array<{ description: string; amount: number; proration: boolean }>;
  next_period_recurring_amount: number;
};

/** An invoice object as persisted by `update()` and read back via `retrieveInvoice()`. */
export type StripeInvoice = UpcomingInvoicePreview & { id: string };

type ProrationBehavior = "create_prorations" | "none" | "always_invoice";

const PRICE_CATALOG: Record<string, StripePrice> = {
  price_seat_basic: { id: "price_seat_basic", unitAmount: 1000, currency: "usd", interval: "month" },
  price_seat_pro: { id: "price_seat_pro", unitAmount: 1500, currency: "usd", interval: "month" },
  price_seat_basic_annual: { id: "price_seat_basic_annual", unitAmount: 10000, currency: "usd", interval: "year" },
};

export class StripeSim {
  private subs = new Map<string, StripeSubscription>();
  private invoices = new Map<string, StripeInvoice>();
  private now: number; // unix seconds, mutable so tests can simulate time passing

  // v0.6.2 (PR-3) fault-injection hooks (migration matrix F-6: the
  // conformance suite needs negative cases the happy-path model
  // cannot produce). All default off; tests set them explicitly.
  /** When true, previews return WITHOUT `incurred_amount` — the preview cannot establish the incurred obligation. Generated invoices are unaffected: the flag models a sparse PREVIEW, not a sparse invoice. */
  _debugOmitIncurredAmount = false;
  /** When true, `retrieveInvoice` throws — the post-commit invoice read is unavailable, so committed finances cannot be independently verified. */
  _debugFailInvoiceReads = false;
  /** When true, the next `update()` fully applies the mutation and persists its invoice, then throws an `api_connection_error` — a response lost AFTER the mutation landed. One-shot: the flag clears itself. */
  _debugLoseNextUpdateResponse = false;

  // Issue #44 (G-21 item 1) misexecution faults — modelled on the
  // Chargebee simulator's wrong-state hooks. Each is opt-in and
  // ONE-SHOT. The shared shape: the mutation's RESPONSE still
  // reports the requested state (the returned subscription is the
  // artifact as requested), while the PERSISTED record diverges —
  // a provider that applied the wrong change but answered as if it
  // had applied the right one. The fault alters persisted state
  // only; it never touches the adapter, never injects a verdict,
  // and the generated invoice keeps the figures computed for the
  // dispatched request (what the provider charged for the call it
  // received — the state, not the billing, is what diverged).
  /** Next `update()` persists THIS quantity for its id-matched mutated item(s) instead of the requested quantity. */
  _debugWrongQuantityOnNextUpdate: number | undefined = undefined;
  /** Next `update()` persists THIS price id for its id-matched mutated item(s) instead of the requested price. */
  _debugWrongPriceOnNextUpdate: string | undefined = undefined;
  /** Next TERM_END `cancel()` lands as an IMMEDIATE cancellation instead (persisted status canceled, no schedule), while the returned subscription reports the requested schedule. One-shot. */
  _debugCancelImmediatelyOnNextCancel = false;
  /** Next `cancel()` returns success reporting the requested cancellation but persists NO cancellation at all (status stays active, no schedule). One-shot. */
  _debugSkipCancelOnNextCancel = false;
  /** Next `cancel()` persists `current_period_end` shifted by this many seconds — a TERM_END schedule whose effective date is not the authorized term boundary. One-shot. */
  _debugShiftPeriodEndOnNextCancel: number | undefined = undefined;
  /** Next mutation (`update()` or `cancel()`) lands and returns its artifact, then the persisted subscription record is REMOVED — post-mutation state is missing to any later read. One-shot. */
  _debugDropSubscriptionOnNextMutation = false;
  /** When true, the next `cancel()` fully applies the cancellation, then throws an `api_connection_error` — a response lost AFTER the cancellation landed. One-shot: the flag clears itself. */
  _debugLoseNextCancelResponse = false;

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
    const preview = this.computeInvoice(sub, proposedItems, prorationBehavior, prorationDate);
    if (this._debugOmitIncurredAmount) {
      // Fault injection: a sparse preview that cannot establish the
      // incurred amount. `amount_due` is still reported (it is the
      // sim's payment figure), which is exactly why it must never
      // be substituted for the missing incurred figure.
      const { incurred_amount: _withheld, ...rest } = preview;
      return rest;
    }
    return preview;
  }

  /**
   * v0.6.2 (PR-3): reads back an invoice that a prior `update()`
   * generated and persisted — the post-commit actual read path,
   * distinct from any preview. Throws `resource_missing` for an
   * unknown id, and whatever `_debugFailInvoiceReads` injects.
   */
  retrieveInvoice(id: string): StripeInvoice {
    if (this._debugFailInvoiceReads) {
      throw new StripeSimError("api_error", `Simulated invoice-read failure for ${id} (fault injection)`);
    }
    const invoice = this.invoices.get(id);
    if (!invoice) throw new StripeSimError("resource_missing", `No such invoice: ${id}`);
    return structuredClone(invoice);
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
  ): { subscription: StripeSubscription; invoice: StripeInvoice } {
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
    // The generated invoice is PERSISTED under its id (and the
    // subscription points at it via latest_invoice) so a caller can
    // read the mutation's actuals back afterwards via
    // retrieveInvoice() — a post-commit read, not the preview object.
    const invoiceId = `in_${crypto.randomBytes(6).toString("hex")}`;
    const generated: StripeInvoice = { ...invoice, id: invoiceId };
    this.invoices.set(invoiceId, structuredClone(generated));
    sub.latest_invoice = invoiceId;

    // Issue #44 misexecution faults: the returned artifact is the
    // subscription AS REQUESTED (captured before the fault is
    // applied); the persisted record then diverges. With no fault
    // armed this is exactly the historical return value.
    const artifact = structuredClone(sub);
    if (this._debugWrongQuantityOnNextUpdate !== undefined || this._debugWrongPriceOnNextUpdate !== undefined) {
      for (const proposed of proposedItems) {
        if (!proposed.id) continue;
        const persisted = sub.items.find((i) => i.id === proposed.id);
        if (!persisted) continue;
        if (this._debugWrongQuantityOnNextUpdate !== undefined) persisted.quantity = this._debugWrongQuantityOnNextUpdate;
        if (this._debugWrongPriceOnNextUpdate !== undefined) {
          const wrongPrice = PRICE_CATALOG[this._debugWrongPriceOnNextUpdate];
          if (wrongPrice) persisted.price = wrongPrice;
        }
      }
      this._debugWrongQuantityOnNextUpdate = undefined;
      this._debugWrongPriceOnNextUpdate = undefined;
    }
    if (this._debugDropSubscriptionOnNextMutation) {
      this._debugDropSubscriptionOnNextMutation = false;
      this.subs.delete(subscriptionId);
    }

    if (this._debugLoseNextUpdateResponse) {
      // Fault injection: everything above HAS landed (items applied,
      // invoice persisted) — only the response is lost. The caller
      // cannot distinguish this from a mutation that never ran,
      // which is precisely the indeterminate case.
      this._debugLoseNextUpdateResponse = false;
      throw new StripeSimError(
        "api_connection_error",
        "Simulated lost response: the update was applied but its response never reached the caller (fault injection)"
      );
    }

    return { subscription: artifact, invoice: generated };
  }

  cancel(subscriptionId: string, atPeriodEnd: boolean): StripeSubscription {
    const sub = this.subs.get(subscriptionId);
    if (!sub) throw new StripeSimError("resource_missing", `No such subscription: ${subscriptionId}`);
    const preCancel = { status: sub.status, cancel_at_period_end: sub.cancel_at_period_end, canceled_at: sub.canceled_at };
    if (atPeriodEnd) {
      sub.cancel_at_period_end = true;
    } else {
      sub.status = "canceled";
      sub.canceled_at = this.now;
    }
    // Issue #44 misexecution faults: as in update(), the returned
    // artifact reports the requested cancellation; the persisted
    // record diverges per the armed fault.
    const artifact = structuredClone(sub);
    if (this._debugCancelImmediatelyOnNextCancel) {
      this._debugCancelImmediatelyOnNextCancel = false;
      if (atPeriodEnd) {
        sub.status = "canceled";
        sub.canceled_at = this.now;
        sub.cancel_at_period_end = false;
      }
    }
    if (this._debugSkipCancelOnNextCancel) {
      this._debugSkipCancelOnNextCancel = false;
      sub.status = preCancel.status;
      sub.cancel_at_period_end = preCancel.cancel_at_period_end;
      sub.canceled_at = preCancel.canceled_at;
    }
    if (this._debugShiftPeriodEndOnNextCancel !== undefined) {
      sub.current_period_end += this._debugShiftPeriodEndOnNextCancel;
      this._debugShiftPeriodEndOnNextCancel = undefined;
    }
    if (this._debugDropSubscriptionOnNextMutation) {
      this._debugDropSubscriptionOnNextMutation = false;
      this.subs.delete(subscriptionId);
    }
    if (this._debugLoseNextCancelResponse) {
      // Fault injection: the cancellation HAS landed (or diverged,
      // if a misexecution fault above was also armed) — only the
      // response is lost.
      this._debugLoseNextCancelResponse = false;
      throw new StripeSimError(
        "api_connection_error",
        "Simulated lost response: the cancellation was applied but its response never reached the caller (fault injection)"
      );
    }
    return artifact;
  }

  /**
   * Content-hash fingerprint over mutable fields. This is the SCQ-layer
   * workaround for Stripe's lack of a native version/etag field — NOT
   * something Stripe itself exposes.
   */
  fingerprint(subscriptionId: string): string {
    const sub = this.retrieve(subscriptionId);
    // Deliberately NOT fingerprinted: `customer_balance` — a
    // customer-level payment attribute. A balance change alters
    // future amounts DUE but neither the subscription's state nor
    // anything a change incurs, so it must not read as subscription
    // drift to SCQ's precondition check.
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

    // v0.6.2 (PR-3): split the figures by economic meaning. The
    // lines total is what the CHANGE incurs; the customer's
    // pre-existing balance is then applied against it to get what
    // would be DUE. Before this split the sim reported the lines
    // total AS `amount_due`, which was numerically the incurred
    // amount wearing a payment figure's name — the conflation the
    // migration eliminates. Balance is applied only against a
    // positive incurred amount: a change that nets to a credit
    // (negative incurred) is a credit, not a payment, and applying
    // balance against it would misstate both figures.
    const incurred_amount = lines.reduce((sum, l) => sum + l.amount, 0);
    const balance = sub.customer_balance ?? 0;
    const customer_balance_applied = incurred_amount > 0 ? Math.min(balance, incurred_amount) : 0;
    const amount_due = incurred_amount - customer_balance_applied;
    return { amount_due, incurred_amount, customer_balance_applied, lines, next_period_recurring_amount: nextPeriodRecurring };
  }
}

export class StripeSimError extends Error {
  constructor(public type: string, message: string) {
    super(message);
  }
}

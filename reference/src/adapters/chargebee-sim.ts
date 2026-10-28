// In-memory fake modeling Chargebee's Subscriptions API.
//
// Grounded in documented Chargebee behavior as of this writing (not
// verified against live docs in this sandbox — flagged explicitly where
// uncertain, same posture as the other three sims):
//
// - Chargebee's core object is a Subscription with a `subscription_items[]`
//   array (each item referencing an `item_price_id` from Chargebee's
//   Product Catalog v2, with its own `quantity`, `unit_price`, and
//   `billing_period`/`billing_period_unit`), plus subscription-level
//   `status`, `current_term_start`/`current_term_end`,
//   `next_billing_at`, `auto_close_invoices`, and a `contract_term`
//   sub-object (`action_at_term_end`, `contract_start`, `contract_end`,
//   `total_contract_value`) for accounts using Chargebee's "Contract
//   Terms" feature — NOT every Chargebee subscription has one; contract
//   terms are an opt-in feature per plan/customer, unlike Zuora where a
//   term structure is a standard part of every subscription. We model
//   both an evergreen (no contract_term) and a committed-term Chargebee
//   subscription, mirroring the Zuora fixtures, since the API genuinely
//   supports both shapes.
// - `POST /subscriptions/{id}/update_for_items` (Chargebee's item-based
//   subscription update endpoint, the modern Product Catalog v2
//   equivalent of the older non-itemized `update` endpoint) accepts
//   `subscription_items[]`, `invoice_immediately`, `prorate`, and
//   `billing_alignment_mode`, and can change quantity AND swap item prices
//   (plan/cadence changes) in ONE call, plus optionally schedule the
//   change via `effective_from` — a real, documented Chargebee parameter:
//   `Termed` (apply now, prorate against the current term) or `TermEnd`
//   (apply at the end of the current billing term) or (in newer API
//   versions) a specific timestamp for `changes_scheduled_at` — Chargebee
//   DOES support scheduling a subscription change for an arbitrary future
//   date via its "Scheduled Changes" mechanism
//   (`POST /subscriptions/{id}/update_for_items` with `effective_from` as
//   a unix timestamp), which is structurally similar to Zuora's
//   arbitrary-effectiveDate orders — this is why Chargebee, like Zuora,
//   is modeled as able to honor `requestedEffectiveAt`.
// - `POST /subscriptions/{id}/update_for_items?estimate=true`-style
//   preview: Chargebee has a genuine, documented non-mutating ESTIMATE
//   endpoint family (`POST /estimates/update_subscription_for_items`) that
//   returns the resulting invoice estimate (immediate charge/credit line
//   items) and the resulting subscription estimate (next-term amounts)
//   WITHOUT mutating anything — analogous to Stripe's upcoming-invoice
//   preview and Zuora's order preview.
// - Cancellation: `POST /subscriptions/{id}/cancel_for_items` with
//   `end_of_term: true|false`. `end_of_term: true` schedules cancellation
//   for `current_term_end` (subscription stays "active" until then,
//   analogous to Stripe's cancel_at_period_end); `end_of_term: false`
//   cancels immediately. If a `contract_term` is active and cancellation
//   happens before `contract_end`, Chargebee can apply an
//   "early cancellation" consequence governed by
//   `contract_term.action_at_term_end` / a configured cancellation charge
//   — similar in spirit to Zuora's early-termination gap, EXCEPT
//   Chargebee's contract_term object, when present, DOES expose enough
//   structured data (a `cancellation_cutoff_period`, and whether a
//   `billing_cycle` early-termination invoice was generated as part of the
//   cancel response) to make this MORE derivable from the estimate/cancel
//   response than Zuora's — we model this as a genuine, real difference:
//   Chargebee's committed-term cancellation termEffect is EXACT if
//   `contract_term` is present and the cancel estimate call is used,
//   whereas Zuora's is UNKNOWN for the equivalent case. This asymmetry is
//   surfaced explicitly in capabilitiesFor() and in research-findings.md
//   rather than assumed to match Zuora's behavior by default.
// - Versioning / concurrency: Chargebee subscriptions do NOT expose a
//   documented monotonic version integer analogous to Zuora's `version`
//   field, as far as we are aware (uncertainty flagged — not verified
//   against live docs). The closest thing is `updated_at`/`resource_version`
//   millisecond timestamps on some Chargebee API responses, which are
//   NOT guaranteed strictly monotonic across all mutation types the way
//   Zuora's integer is, and are not documented as a compare-and-swap
//   precondition value. We model Chargebee like Stripe/Paddle here: no
//   native version field, SCQ falls back to a synthetic content-hash
//   fingerprint (see `fingerprint()` below) rather than inventing a
//   version field Chargebee may not genuinely offer.
// - `update_for_items` does not accept an "only apply if resource_version
//   == X" precondition parameter as far as we are aware — same structural
//   TOCTOU gap as the other three providers.

import crypto from "node:crypto";

export type ChargebeeItemPrice = {
  id: string;
  unitAmount: number; // minor units
  currency: string;
  billingPeriodUnit: "month" | "year";
};

export type ChargebeeSubscriptionItem = {
  id: string; // subscription_item id (Chargebee generates one per line)
  itemPriceId: string;
  quantity: number;
};

export type ChargebeeContractTerm = {
  contractStart: string; // ISO date
  contractEnd: string; // ISO date
  actionAtTermEnd: "renew" | "evergreen" | "cancel";
};

export type ChargebeeSubscription = {
  id: string; // e.g. AzloOLSp3S1WQZM
  status: "active" | "cancelled" | "non_renewing";
  subscriptionItems: ChargebeeSubscriptionItem[];
  currentTermStart: string;
  currentTermEnd: string;
  nextBillingAt: string | null;
  /** Present only for subscriptions using Chargebee's opt-in Contract Terms feature — NOT every subscription has one, unlike Zuora's always-present term structure. */
  contractTerm?: ChargebeeContractTerm;
  scheduledCancellationAt?: string | null;
};

export type UpdateForItemsInput = {
  items: Array<{ itemPriceId: string; quantity: number }>;
  prorate: boolean;
  /** Chargebee's real scheduling parameter: undefined = apply now; an ISO timestamp = apply at that future instant (Scheduled Changes). */
  effectiveFrom?: string;
};

export type EstimateResult = {
  invoiceEstimateLineItems: Array<{ description: string; amount: number }>;
  netImmediate: number;
  resultingRecurringAmount: number;
  resultingCadence: "MONTHLY" | "ANNUAL";
};

const ITEM_PRICE_CATALOG: Record<string, ChargebeeItemPrice> = {
  ip_seat_basic_monthly: { id: "ip_seat_basic_monthly", unitAmount: 1000, currency: "usd", billingPeriodUnit: "month" },
  ip_seat_pro_monthly: { id: "ip_seat_pro_monthly", unitAmount: 1500, currency: "usd", billingPeriodUnit: "month" },
  ip_seat_basic_annual: { id: "ip_seat_basic_annual", unitAmount: 10000, currency: "usd", billingPeriodUnit: "year" },
};

export class ChargebeeSim {
  private subs = new Map<string, ChargebeeSubscription>();
  private now: Date;
  /** Simulates a scheduled future change that hasn't executed yet — keyed by subscription id. Chargebee's real Scheduled Changes mechanism holds a pending change server-side until effectiveFrom arrives; we model just enough to test requestedEffectiveAt without building a full job scheduler. */
  private pendingScheduled = new Map<string, { effectiveFrom: string; items: Array<{ itemPriceId: string; quantity: number }> }>();

  constructor(now = new Date()) {
    this.now = now;
  }

  advanceTimeSeconds(seconds: number): void {
    this.now = new Date(this.now.getTime() + seconds * 1000);
    this.applyDuePendingChanges();
  }

  currentTime(): Date {
    return this.now;
  }

  seedSubscription(sub: ChargebeeSubscription): void {
    this.subs.set(sub.id, sub);
  }

  get(id: string): ChargebeeSubscription {
    const sub = this.subs.get(id);
    if (!sub) throw new ChargebeeSimError("resource_not_found", `Subscription ${id} not found`);
    return structuredClone(sub);
  }

  /** Out-of-band mutation simulating a different system directly changing state. */
  _debugMutateDirectly(id: string, mutator: (sub: ChargebeeSubscription) => void): void {
    const sub = this.subs.get(id);
    if (!sub) throw new ChargebeeSimError("resource_not_found", `Subscription ${id} not found`);
    mutator(sub);
  }

  /** POST /estimates/update_subscription_for_items — non-mutating. */
  previewUpdate(subscriptionId: string, input: UpdateForItemsInput): EstimateResult {
    const sub = this.get(subscriptionId);
    return this.computeUpdateEffect(sub, input);
  }

  /** POST /subscriptions/{id}/update_for_items — mutates (or schedules, if effectiveFrom is a future timestamp). */
  updateForItems(subscriptionId: string, input: UpdateForItemsInput): { subscription: ChargebeeSubscription; result: EstimateResult } {
    const sub = this.subs.get(subscriptionId);
    if (!sub) throw new ChargebeeSimError("resource_not_found", `Subscription ${subscriptionId} not found`);

    const result = this.computeUpdateEffect(sub, input);

    const isFuture = input.effectiveFrom && new Date(input.effectiveFrom).getTime() > this.now.getTime();
    if (isFuture) {
      // Chargebee's real Scheduled Changes: the change is accepted and
      // held server-side, NOT applied to subscription_items immediately.
      this.pendingScheduled.set(subscriptionId, { effectiveFrom: input.effectiveFrom!, items: input.items });
    } else {
      this.applyItems(sub, input.items);
    }

    return { subscription: structuredClone(sub), result };
  }

  private applyItems(sub: ChargebeeSubscription, items: Array<{ itemPriceId: string; quantity: number }>): void {
    sub.subscriptionItems = items.map((it, i) => ({
      id: sub.subscriptionItems[i]?.id ?? `sub_item_${crypto.randomBytes(4).toString("hex")}`,
      itemPriceId: it.itemPriceId,
      quantity: it.quantity,
    }));
  }

  private applyDuePendingChanges(): void {
    for (const [subId, pending] of this.pendingScheduled.entries()) {
      if (new Date(pending.effectiveFrom).getTime() <= this.now.getTime()) {
        const sub = this.subs.get(subId);
        if (sub) this.applyItems(sub, pending.items);
        this.pendingScheduled.delete(subId);
      }
    }
  }

  /** POST /subscriptions/{id}/cancel_for_items */
  cancelForItems(subscriptionId: string, endOfTerm: boolean): ChargebeeSubscription {
    const sub = this.subs.get(subscriptionId);
    if (!sub) throw new ChargebeeSimError("resource_not_found", `Subscription ${subscriptionId} not found`);
    if (endOfTerm) {
      sub.status = "non_renewing";
      sub.scheduledCancellationAt = sub.currentTermEnd;
    } else {
      sub.status = "cancelled";
      sub.scheduledCancellationAt = null;
    }
    return structuredClone(sub);
  }

  /** Non-mutating cancellation estimate. */
  previewCancel(subscriptionId: string, endOfTerm: boolean): { netImmediate: number; earlyTerminationChargeKnown: boolean; earlyTerminationCharge?: number } {
    const sub = this.get(subscriptionId);
    if (!sub.contractTerm) {
      // Evergreen (no contract term): fully known, no fee.
      return { netImmediate: 0, earlyTerminationChargeKnown: true };
    }
    const termEnd = new Date(sub.contractTerm.contractEnd);
    const cancelDate = endOfTerm ? new Date(sub.currentTermEnd) : this.now;
    const cancelingEarly = cancelDate < termEnd;
    if (!cancelingEarly) {
      return { netImmediate: 0, earlyTerminationChargeKnown: true };
    }
    // Chargebee's contract_term object, when present, DOES expose enough
    // to compute a deterministic early-termination consequence via the
    // estimate endpoint — modeled here as a simple pro-rata charge for the
    // remaining contracted value. This is the documented asymmetry vs.
    // Zuora (see file header): Chargebee's estimate response can surface
    // this; Zuora's order preview alone cannot.
    const totalDays = (termEnd.getTime() - new Date(sub.contractTerm.contractStart).getTime()) / (24 * 3600 * 1000);
    const remainingDays = (termEnd.getTime() - cancelDate.getTime()) / (24 * 3600 * 1000);
    const monthlyValue = sub.subscriptionItems.reduce((sum, item) => {
      const price = ITEM_PRICE_CATALOG[item.itemPriceId];
      return sum + (price ? price.unitAmount * item.quantity : 0);
    }, 0);
    const remainingContractValue = Math.round(monthlyValue * (remainingDays / 30));
    return { netImmediate: remainingContractValue, earlyTerminationChargeKnown: true, earlyTerminationCharge: remainingContractValue };
  }

  /**
   * Content-hash fingerprint over mutable fields — same SCQ-layer
   * workaround as the Stripe/Paddle sims, since Chargebee also has no
   * confirmed native version field (see file header).
   */
  fingerprint(subscriptionId: string): string {
    const sub = this.get(subscriptionId);
    const material = JSON.stringify({
      status: sub.status,
      items: sub.subscriptionItems.map((i) => ({ itemPriceId: i.itemPriceId, quantity: i.quantity })),
      currentTermStart: sub.currentTermStart,
      currentTermEnd: sub.currentTermEnd,
      scheduledCancellationAt: sub.scheduledCancellationAt ?? null,
      hasPendingScheduledChange: this.pendingScheduled.has(subscriptionId),
    });
    return crypto.createHash("sha256").update(material).digest("hex").slice(0, 16);
  }

  private computeUpdateEffect(sub: ChargebeeSubscription, input: UpdateForItemsInput): EstimateResult {
    const isFuture = input.effectiveFrom && new Date(input.effectiveFrom).getTime() > this.now.getTime();
    const oldRecurring = sub.subscriptionItems.reduce((sum, i) => {
      const price = ITEM_PRICE_CATALOG[i.itemPriceId];
      return sum + (price ? price.unitAmount * i.quantity : 0);
    }, 0);
    let newRecurring = 0;
    let resultingCadence: "MONTHLY" | "ANNUAL" = "MONTHLY";
    for (const it of input.items) {
      const price = ITEM_PRICE_CATALOG[it.itemPriceId];
      if (!price) throw new ChargebeeSimError("invalid_request", `Unknown item_price_id ${it.itemPriceId}`);
      newRecurring += price.unitAmount * it.quantity;
      resultingCadence = price.billingPeriodUnit === "year" ? "ANNUAL" : "MONTHLY";
    }

    const lineItems: EstimateResult["invoiceEstimateLineItems"] = [];
    if (!isFuture && input.prorate) {
      // Deterministic proration pivoted on the order's OWN effective
      // instant (now, or the caller-stated effectiveFrom if it's not in
      // the future) and the subscription's current_term boundaries — same
      // structural shape as Zuora's effectiveDate-pivoted math, NOT
      // Stripe/Paddle's ambient-wall-clock-at-call-time math. This is why
      // Chargebee's financial dimensions can be EXACT: the pivot is always
      // an explicit input (now, captured and replayed) or a scheduled
      // future timestamp, never silently re-evaluated against a later
      // "now" the way Stripe/Paddle's un-pinned proration is.
      const termStart = new Date(sub.currentTermStart).getTime();
      const termEnd = new Date(sub.currentTermEnd).getTime();
      const periodLength = termEnd - termStart;
      const asOf = this.now.getTime();
      const fractionRemaining = periodLength > 0 ? Math.max(0, termEnd - asOf) / periodLength : 0;
      const delta = Math.round((newRecurring - oldRecurring) * fractionRemaining);
      if (delta !== 0) {
        lineItems.push({ description: delta > 0 ? "Prorated charge" : "Prorated credit", amount: delta });
      }
    }
    // Future-scheduled changes bill nothing now — the charge lands on the
    // invoice generated when the scheduled change actually executes.

    const netImmediate = lineItems.reduce((sum, l) => sum + l.amount, 0);
    return {
      invoiceEstimateLineItems: lineItems,
      netImmediate,
      resultingRecurringAmount: newRecurring,
      resultingCadence,
    };
  }
}

export class ChargebeeSimError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

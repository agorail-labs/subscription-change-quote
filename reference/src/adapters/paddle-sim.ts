// In-memory fake modeling Paddle Billing's subscriptions API.
//
// Grounded in documented Paddle Billing behavior as of this writing (not
// verified against live docs in this sandbox — see research-findings.md):
//
// - Subscription objects have `id`, `status`, `items[]` (each with
//   `price_id`, `quantity`), `currency_code`, `next_billed_at`,
//   `billing_cycle` (interval/frequency), `current_billing_period`
//   ({starts_at, ends_at}).
// - Paddle Billing exposes a real "preview" concept:
//     PATCH /subscriptions/{id}/preview  — dry-runs an update (items,
//     proration_billing_mode) and returns the resulting `immediate_transaction`
//     and `next_transaction` without committing.
//     POST /subscriptions/{id}/preview  variants also exist conceptually for
//     transaction-level previews. We model the update-preview shape since
//     that is the one directly relevant to SCQ.
// - `proration_billing_mode` values (as documented): `prorated_immediately`,
//   `prorated_next_billing_period`, `full_immediately`,
//   `full_next_billing_period`, `do_not_bill`.
// - Cancellation supports `effective_from: immediately | next_billing_period`.
// - Uncertainty: whether Paddle's subscription resource carries any field
//   usable as an optimistic-concurrency token (a version counter or ETag)
//   is NOT something we could verify with confidence in this sandboxed
//   environment. Publicly documented subscription fields we are aware of
//   (id, status, items, billing_cycle, current_billing_period, etc.) do NOT
//   include an explicit version/etag field. This simulator does not invent
//   one — same posture as the Stripe sim.
//
// v0.2 finding — no `proration_date` equivalent:
// Stripe's `subscriptions.update` accepts a `proration_date` parameter that
// pins the remaining-time fraction to a caller-supplied timestamp (see
// stripe-sim.ts). We are not aware of any documented Paddle Billing
// parameter on `PATCH /subscriptions/{id}` or the preview endpoint that
// does the same thing — `proration_billing_mode` controls *how* to prorate
// (immediately vs. next period, full vs. prorated) but not *as-of-when*.
// This simulator therefore does NOT add a prorationDate parameter to
// update()/previewUpdate(): adding one here would misrepresent Paddle's
// actual surface. This is flagged as a real asymmetry between the two
// providers for EXACT guarantee mode — see research-findings.md.

import crypto from "node:crypto";

export type PaddlePrice = {
  id: string;
  unitAmount: number; // minor units
  currencyCode: string;
  interval: "month" | "year";
};

export type PaddleSubscriptionItem = {
  price: PaddlePrice;
  quantity: number;
};

export type PaddleSubscription = {
  id: string; // sub_...
  status: "active" | "canceled" | "past_due" | "paused";
  items: PaddleSubscriptionItem[];
  currencyCode: string;
  billingCycle: { interval: "month" | "year"; frequency: number };
  currentBillingPeriod: { startsAt: string; endsAt: string };
  nextBilledAt: string | null;
  scheduledChange?: { action: "cancel"; effectiveAt: string } | null;
};

export type ProrationBillingMode =
  | "prorated_immediately"
  | "prorated_next_billing_period"
  | "full_immediately"
  | "full_next_billing_period"
  | "do_not_bill";

export type PreviewResult = {
  immediateTransaction: { amount: number; currencyCode: string } | null;
  nextTransaction: { amount: number; currencyCode: string; billedAt: string } | null;
};

const PRICE_CATALOG: Record<string, PaddlePrice> = {
  pri_seat_basic: { id: "pri_seat_basic", unitAmount: 1000, currencyCode: "USD", interval: "month" },
  pri_seat_pro: { id: "pri_seat_pro", unitAmount: 1500, currencyCode: "USD", interval: "month" },
  pri_seat_basic_annual: { id: "pri_seat_basic_annual", unitAmount: 10000, currencyCode: "USD", interval: "year" },
};

export class PaddleSim {
  private subs = new Map<string, PaddleSubscription>();
  private now: Date;

  constructor(now = new Date()) {
    this.now = now;
  }

  advanceTimeSeconds(seconds: number): void {
    this.now = new Date(this.now.getTime() + seconds * 1000);
  }

  currentTime(): Date {
    return this.now;
  }

  seedSubscription(sub: PaddleSubscription): void {
    this.subs.set(sub.id, sub);
  }

  get(id: string): PaddleSubscription {
    const sub = this.subs.get(id);
    if (!sub) throw new PaddleSimError("entity_not_found", `subscription ${id} not found`);
    return structuredClone(sub);
  }

  /** Out-of-band mutation simulating another system/webhook changing state directly. */
  _debugMutateDirectly(id: string, mutator: (sub: PaddleSubscription) => void): void {
    const sub = this.subs.get(id);
    if (!sub) throw new PaddleSimError("entity_not_found", `subscription ${id} not found`);
    mutator(sub);
  }

  /** PATCH /subscriptions/{id}/preview — non-mutating. */
  previewUpdate(
    subscriptionId: string,
    proposedItems: Array<{ priceId: string; quantity: number }>,
    prorationBillingMode: ProrationBillingMode
  ): PreviewResult {
    const sub = this.get(subscriptionId);
    return this.computePreview(sub, proposedItems, prorationBillingMode);
  }

  /** PATCH /subscriptions/{id} — mutates. */
  update(
    subscriptionId: string,
    proposedItems: Array<{ priceId: string; quantity: number }>,
    prorationBillingMode: ProrationBillingMode
  ): { subscription: PaddleSubscription; result: PreviewResult } {
    const sub = this.subs.get(subscriptionId);
    if (!sub) throw new PaddleSimError("entity_not_found", `subscription ${subscriptionId} not found`);

    const result = this.computePreview(sub, proposedItems, prorationBillingMode);

    sub.items = proposedItems.map((p) => {
      const price = PRICE_CATALOG[p.priceId];
      if (!price) throw new PaddleSimError("validation_error", `unknown price ${p.priceId}`);
      return { price, quantity: p.quantity };
    });

    // Paddle Billing's billing_cycle is a property of the subscription that
    // tracks the price interval of its items; a price swap that changes
    // cadence (e.g. monthly -> annual) changes it too. We recompute it from
    // the (assumed single) recurring interval of the updated items, matching
    // documented behavior for plan/cadence changes.
    const newInterval = sub.items[0]?.price.interval ?? sub.billingCycle.interval;
    if (newInterval !== sub.billingCycle.interval) {
      sub.billingCycle = { interval: newInterval, frequency: 1 };
    }

    return { subscription: structuredClone(sub), result };
  }

  cancel(subscriptionId: string, effectiveFrom: "immediately" | "next_billing_period"): PaddleSubscription {
    const sub = this.subs.get(subscriptionId);
    if (!sub) throw new PaddleSimError("entity_not_found", `subscription ${subscriptionId} not found`);
    if (effectiveFrom === "immediately") {
      sub.status = "canceled";
      sub.scheduledChange = null;
      sub.nextBilledAt = null;
    } else {
      sub.scheduledChange = { action: "cancel", effectiveAt: sub.currentBillingPeriod.endsAt };
    }
    return structuredClone(sub);
  }

  /**
   * Content-hash fingerprint over mutable fields — same SCQ-layer workaround
   * as the Stripe sim, since Paddle also has no confirmed native version
   * field on the subscription resource.
   */
  fingerprint(subscriptionId: string): string {
    const sub = this.get(subscriptionId);
    const material = JSON.stringify({
      status: sub.status,
      items: sub.items.map((i) => ({ price: i.price.id, quantity: i.quantity })),
      currentBillingPeriod: sub.currentBillingPeriod,
      scheduledChange: sub.scheduledChange ?? null,
    });
    return crypto.createHash("sha256").update(material).digest("hex").slice(0, 16);
  }

  private computePreview(
    sub: PaddleSubscription,
    proposedItems: Array<{ priceId: string; quantity: number }>,
    mode: ProrationBillingMode
  ): PreviewResult {
    const periodStart = new Date(sub.currentBillingPeriod.startsAt).getTime();
    const periodEnd = new Date(sub.currentBillingPeriod.endsAt).getTime();
    const periodLength = periodEnd - periodStart;
    const remaining = Math.max(0, periodEnd - this.now.getTime());
    const fractionRemaining = periodLength > 0 ? remaining / periodLength : 0;

    let nextTotal = 0;
    for (const p of proposedItems) {
      const price = PRICE_CATALOG[p.priceId];
      if (!price) throw new PaddleSimError("validation_error", `unknown price ${p.priceId}`);
      nextTotal += price.unitAmount * p.quantity;
    }

    if (mode === "do_not_bill" || mode === "full_next_billing_period" || mode === "prorated_next_billing_period") {
      return {
        immediateTransaction: null,
        nextTransaction: { amount: nextTotal, currencyCode: sub.currencyCode, billedAt: sub.currentBillingPeriod.endsAt },
      };
    }

    // immediate modes: compute a delta transaction now.
    let oldTotal = 0;
    for (const item of sub.items) oldTotal += item.price.unitAmount * item.quantity;

    let immediateAmount: number;
    if (mode === "full_immediately") {
      immediateAmount = nextTotal - oldTotal;
    } else {
      // prorated_immediately
      immediateAmount = Math.round((nextTotal - oldTotal) * fractionRemaining);
    }

    return {
      immediateTransaction: immediateAmount !== 0 ? { amount: immediateAmount, currencyCode: sub.currencyCode } : null,
      nextTransaction: { amount: nextTotal, currencyCode: sub.currencyCode, billedAt: sub.currentBillingPeriod.endsAt },
    };
  }
}

export class PaddleSimError extends Error {
  constructor(public type: string, message: string) {
    super(message);
  }
}

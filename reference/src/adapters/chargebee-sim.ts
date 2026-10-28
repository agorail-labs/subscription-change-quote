// In-memory fake modeling Chargebee's Subscriptions API.
//
// Originally grounded in documented Chargebee behavior as understood
// when written; the load-bearing assumptions were re-audited against
// the current official Product Catalog 2.0 documentation in Phase 1
// (research/chargebee-live-v1/API-CONTRACT-AUDIT.md, docs re-read
// 2026-10-27) and corrected in Phase 2A where they did not match —
// each correction is flagged inline below. Remaining uncertain points
// are flagged explicitly, same posture as the other three sims:
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
//   (plan/cadence changes) in ONE call.
//   Phase 2A CORRECTION (supersedes the scheduling paragraph that stood
//   here through v0.6.1): `effective_from` is NOT a documented parameter
//   of `update_for_items` in the current Product Catalog 2.0 docs — it
//   is the required parameter of Create-a-ramp (Ramps, Early Access).
//   Scheduling on the update endpoint itself exists only via
//   deprecated-but-documented paths: the `end_of_term` boolean and
//   `change_option=end_of_term` (both deprecated toward Ramps) and
//   `change_option=specific_date` + `changes_scheduled_at` for a future
//   date (deprecated for scheduling; still documented for backdating).
//   This simulator's `effectiveFrom` field and pending-scheduled-change
//   machinery below are therefore a SIMULATOR-ONLY model of legacy
//   scheduled-change behavior, kept exercisable at the sim layer; the
//   simulator-backed adapter no longer sends a future `effectiveFrom`
//   and refuses DATE (and TERM_END for update-backed actions) — see
//   chargebee-adapter.ts capabilitiesFor. Do not cite this sim as
//   evidence that `update_for_items` accepts `effective_from`: that
//   claim is NOT ESTABLISHED (which is weaker than, and different from,
//   a claim that no equivalent mechanism exists anywhere).
// - Preview: Chargebee has a genuine, documented non-mutating ESTIMATE
//   endpoint family (`POST /estimates/update_subscription_for_items`)
//   that returns the resulting invoice estimate (immediate
//   charge/credit line items) and the resulting subscription estimate
//   (next-term amounts) WITHOUT mutating anything — analogous to
//   Stripe's upcoming-invoice preview and Zuora's order preview.
//   Phase 2A CORRECTION: an earlier version of this header described a
//   `POST /subscriptions/{id}/update_for_items?estimate=true`-style
//   preview on the update endpoint itself; no such preview parameter
//   is documented — the separate estimates family is the documented
//   preview (API-CONTRACT-AUDIT.md A10/D-5).
// - Cancellation: `POST /subscriptions/{id}/cancel_for_items` with
//   `end_of_term: true|false`. `end_of_term: true` schedules cancellation
//   for `current_term_end` (subscription stays "active" until then,
//   analogous to Stripe's cancel_at_period_end); `end_of_term: false`
//   cancels immediately. If a `contract_term` is active and cancellation
//   happens before `contract_end`, Chargebee can apply an
//   "early cancellation" consequence governed by
//   `contract_term.action_at_term_end` / a configured cancellation charge.
//   Phase 2A CORRECTION (the v0.6 correction in chargebee-adapter.ts
//   already retracted the adapter-level claim; this header lagged it):
//   an earlier version of this paragraph claimed Chargebee's
//   contract_term data makes committed-term cancellation termEffect
//   EXACT, as a "genuine, real difference" from Zuora. That claim was
//   simulator-only, was never verified against a site with Contract
//   Terms enabled, and is RETRACTED: the adapter reports UNKNOWN for
//   committed-term CANCEL, and the deterministic early-termination fee
//   this sim computes in previewCancel() is a simulator invention kept
//   only so the sim's arithmetic is exercisable — it is NOT documented
//   Chargebee behavior and no capability claim may be derived from it.
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
  /**
   * SIMULATOR-ONLY scheduling field — NOT a documented
   * `update_for_items` parameter (Phase 2A correction; see file
   * header). undefined = apply now; an ISO timestamp = the sim holds
   * the change as pending until that instant, modeling legacy
   * scheduled-change behavior at the sim layer only. The
   * simulator-backed adapter never sends a future value after
   * Phase 2A.
   */
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
  /** Simulates a scheduled future change that hasn't executed yet — keyed by subscription id. SIMULATOR-ONLY model of legacy scheduled-change behavior (the real mechanisms are the deprecated update paths and Early-Access Ramps — see file header); just enough to exercise the sim's own pending-change arithmetic, not evidence about the real API's scheduling execution. */
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
      // Simulator-only pending-change model: the change is held,
      // NOT applied to subscription_items immediately. (Not a claim
      // about the real API — see file header, Phase 2A correction.)
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
    // SIMULATOR INVENTION (Phase 2A correction): the pro-rata charge
    // computed below is this sim's own simplified formula. It is NOT
    // documented Chargebee behavior, the committed-term case is
    // UNVERIFIED against a real site, and the adapter deliberately
    // does not derive any EXACT claim from this number (it reports
    // termEffect UNKNOWN for committed-term subscriptions). An earlier
    // comment here claimed a "documented asymmetry vs. Zuora"; that
    // claim is retracted — see file header.
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
      // Simulator proration arithmetic: a fraction-of-term calculation
      // against the sim's OWN clock (`this.now` at call time) and the
      // subscription's current_term boundaries. Phase 2A CORRECTION:
      // an earlier version of this comment concluded "this is why
      // Chargebee's financial dimensions can be EXACT" — that does not
      // follow. Determinism INSIDE the simulator proves nothing about
      // the real estimate->update pair, for which no pinning/replay
      // mechanism is documented and multiple drift sources exist
      // (site-setting defaults, balances, conditional tax, the
      // prorate caveat). The adapter therefore reports REVALIDATE for
      // both financial dimensions, and its commit path re-derives the
      // effect and enforces the caller's envelope against the fresh
      // preview — exactly because a later "now" CAN change the number,
      // as Test 11a now demonstrates.
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

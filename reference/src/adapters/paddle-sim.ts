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
  /**
   * v0.6.2 (PR-4): pre-existing customer credit balance (minor
   * units). Same standing-fixture posture as the Stripe sim's
   * `customer_balance`: it is applied against the PAYMENT total of
   * an immediate transaction (see PaddleTransaction.total), but it
   * never changes what a change itself incurs, never changes
   * subscription state, and is deliberately NOT part of the
   * fingerprint. Modeled as non-depleting — previews/updates
   * report how much WOULD be applied; the balance-ledger lifecycle
   * is out of scope for this model.
   */
  creditBalance?: number;
};

export type ProrationBillingMode =
  | "prorated_immediately"
  | "prorated_next_billing_period"
  | "full_immediately"
  | "full_next_billing_period"
  | "do_not_bill";

/**
 * v0.6.2 (PR-4) — the immediate transaction's figures are SPLIT by
 * economic meaning (previously `immediateTransaction.amount` was
 * the bare proration delta, so nothing in the model could express
 * the difference between the obligation a change incurs and the
 * payment a transaction collects, and the adapter mapped the
 * transaction figure straight into `CommercialEffect.immediate`):
 *
 * - `incurredAmount` is the net obligation the PROPOSED CHANGE
 *   itself incurs at its effective time — the prorated (or full)
 *   delta between the current and proposed item totals. This is
 *   the only figure an SCQ `immediate` effect may carry (§3.11).
 * - `creditBalanceApplied` is the portion of the subscription's
 *   pre-existing `creditBalance` applied against this transaction.
 *   Credits reduce what is DUE; they never change the incurred
 *   obligation or any price.
 * - `amount` is the transaction's PAYMENT total:
 *   `incurredAmount - creditBalanceApplied`. It is what would be
 *   collected for this transaction — NOT the obligation the
 *   change incurs — and must never be mapped into an SCQ effect.
 */
export type ImmediateTransactionPreview = {
  incurredAmount: number;
  creditBalanceApplied: number;
  amount: number;
  currencyCode: string;
};

export type PreviewResult = {
  /**
   * `null` under an immediate billing mode means the incurred
   * amount is EXACTLY 0 (see computePreview — the null is produced
   * iff the computed amount is 0): an established zero, not an
   * absence of information. Under a deferred mode
   * (`*_next_billing_period` / `do_not_bill`) null instead means
   * "no transaction now; the obligation bills later" — the SCQ
   * adapter only ever previews with `prorated_immediately`, where
   * the zero reading is the operative one. The field is ABSENT
   * (undefined) only under the `_debugOmitImmediateTransaction`
   * fault hook, modeling a provider response that omits the figure
   * entirely — that absence means NOT ESTABLISHED (unknown).
   */
  immediateTransaction?: ImmediateTransactionPreview | null;
  nextTransaction: { amount: number; currencyCode: string; billedAt: string } | null;
};

/**
 * A transaction record as PERSISTED by `update()` and read back
 * via `retrieveTransaction(id)` — the post-commit read path. The
 * persisted record is what makes M3-style identity binding
 * possible: a mutation's financial actuals are established from
 * the transaction THAT mutation generated, retrieved by its id,
 * not from the mutation response object and not from an
 * unqualified latest-transaction pointer.
 */
export type PaddleTransaction = {
  id: string; // txn_...
  subscriptionId: string;
  /** Net obligation the mutation's change incurred (the transaction's lines total). */
  incurredAmount: number;
  /** Pre-existing customer credits applied against this transaction. */
  creditBalanceApplied: number;
  /** PAYMENT figure: incurredAmount - creditBalanceApplied. Never an incurred obligation. */
  total: number;
  currencyCode: string;
  createdAt: string;
};

const PRICE_CATALOG: Record<string, PaddlePrice> = {
  pri_seat_basic: { id: "pri_seat_basic", unitAmount: 1000, currencyCode: "USD", interval: "month" },
  pri_seat_pro: { id: "pri_seat_pro", unitAmount: 1500, currencyCode: "USD", interval: "month" },
  pri_seat_basic_annual: { id: "pri_seat_basic_annual", unitAmount: 10000, currencyCode: "USD", interval: "year" },
};

export class PaddleSim {
  private subs = new Map<string, PaddleSubscription>();
  private transactions = new Map<string, PaddleTransaction>();
  private transactionIdsBySubscription = new Map<string, string[]>();
  private now: Date;

  // v0.6.2 (PR-4) fault-injection hooks (migration matrix F-6: the
  // conformance suite needs negative cases the happy-path model
  // cannot produce). All default off; tests set them explicitly.
  /** When true, previews return WITHOUT an immediate-transaction figure — the preview cannot establish the incurred obligation. Generated transactions are unaffected: the flag models a sparse PREVIEW, not a sparse transaction. */
  _debugOmitImmediateTransaction = false;
  /** When true, `retrieveTransaction` throws — the post-commit transaction read is unavailable, so committed finances cannot be independently verified. */
  _debugFailTransactionReads = false;
  /** When true, the next `update()` fully applies the mutation and persists its transaction, then throws an `api_connection_error` — a response lost AFTER the mutation landed. One-shot: the flag clears itself. */
  _debugLoseNextUpdateResponse = false;
  /** Same lost-response fault for the next `cancel()` call. One-shot. */
  _debugLoseNextCancelResponse = false;

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

  /**
   * Post-commit read: the persisted transaction record for `id`.
   * Throws `entity_not_found` for an unknown id, and whatever
   * `_debugFailTransactionReads` injects.
   */
  retrieveTransaction(id: string): PaddleTransaction {
    if (this._debugFailTransactionReads) {
      throw new PaddleSimError(
        "api_error",
        "Simulated transaction read failure: the transaction store is unavailable (fault injection)"
      );
    }
    const txn = this.transactions.get(id);
    if (!txn) throw new PaddleSimError("entity_not_found", `transaction ${id} not found`);
    return structuredClone(txn);
  }

  /**
   * The id of the most recent transaction generated for a
   * subscription, or null if none. This is a READ of the
   * transaction log — it exists so a caller can DETECT that a
   * later transaction superseded its own (the M3 divergence
   * signal). It is never a source of financial figures: figures
   * are bound by id via `retrieveTransaction`.
   */
  latestTransactionId(subscriptionId: string): string | null {
    const ids = this.transactionIdsBySubscription.get(subscriptionId);
    return ids && ids.length > 0 ? ids[ids.length - 1] : null;
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
  ): { subscription: PaddleSubscription; result: PreviewResult; transaction?: PaddleTransaction } {
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

    // v0.6.2 (PR-4): under an immediate billing mode the mutation
    // generates a transaction, which is PERSISTED under its id so
    // its actuals can be read back afterwards via
    // retrieveTransaction() — a post-commit read, not the preview
    // object and not this response. The transaction's incurred
    // component is the mutation's own computation (the preview
    // above ran against the pre-mutation state inside this same
    // call, so nothing intervened); a null immediate figure under
    // an immediate mode is the established zero (see
    // computePreview), so the persisted incurred amount is 0.
    // Under a deferred mode no immediate transaction is generated.
    let transaction: PaddleTransaction | undefined;
    if (prorationBillingMode === "prorated_immediately" || prorationBillingMode === "full_immediately") {
      const immediate = result.immediateTransaction;
      const incurredAmount = immediate ? immediate.incurredAmount : 0;
      const creditBalanceApplied = immediate ? immediate.creditBalanceApplied : 0;
      transaction = {
        id: `txn_${crypto.randomBytes(6).toString("hex")}`,
        subscriptionId,
        incurredAmount,
        creditBalanceApplied,
        total: incurredAmount - creditBalanceApplied,
        currencyCode: sub.currencyCode,
        createdAt: this.now.toISOString(),
      };
      this.transactions.set(transaction.id, structuredClone(transaction));
      const ids = this.transactionIdsBySubscription.get(subscriptionId) ?? [];
      ids.push(transaction.id);
      this.transactionIdsBySubscription.set(subscriptionId, ids);
    }

    if (this._debugLoseNextUpdateResponse) {
      // Fault injection: everything above HAS landed (items
      // applied, transaction persisted) — only the response is
      // lost. The caller cannot distinguish this from a mutation
      // that never ran, which is precisely the indeterminate case.
      this._debugLoseNextUpdateResponse = false;
      throw new PaddleSimError(
        "api_connection_error",
        "Simulated lost response: the update was applied but its response never reached the caller (fault injection)"
      );
    }

    return { subscription: structuredClone(sub), result, transaction };
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
    if (this._debugLoseNextCancelResponse) {
      // Fault injection: the cancellation HAS landed — only the
      // response is lost (the indeterminate case, as in update()).
      this._debugLoseNextCancelResponse = false;
      throw new PaddleSimError(
        "api_connection_error",
        "Simulated lost response: the cancel was applied but its response never reached the caller (fault injection)"
      );
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
    // Deliberately NOT fingerprinted: `creditBalance` — a standing
    // credit fixture that changes amounts due on transactions,
    // never subscription state or anything a change incurs.
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

    const nextTransaction = { amount: nextTotal, currencyCode: sub.currencyCode, billedAt: sub.currentBillingPeriod.endsAt };

    if (mode === "do_not_bill" || mode === "full_next_billing_period" || mode === "prorated_next_billing_period") {
      return { immediateTransaction: null, nextTransaction };
    }

    // immediate modes: compute a delta transaction now.
    let oldTotal = 0;
    for (const item of sub.items) oldTotal += item.price.unitAmount * item.quantity;

    let incurredAmount: number;
    if (mode === "full_immediately") {
      incurredAmount = nextTotal - oldTotal;
    } else {
      // prorated_immediately
      incurredAmount = Math.round((nextTotal - oldTotal) * fractionRemaining);
    }

    if (this._debugOmitImmediateTransaction) {
      // Fault injection: the response omits the immediate figure
      // entirely — the incurred obligation cannot be established
      // from this preview (modeled absence, distinct from the
      // established-zero null below).
      return { nextTransaction };
    }

    if (incurredAmount === 0) {
      // F-3: under an immediate mode, NO immediate transaction is
      // produced iff the incurred amount is exactly 0. This null
      // is an established zero — the semantic the SCQ adapter's
      // DETERMINED-zero mapping rests on.
      return { immediateTransaction: null, nextTransaction };
    }

    // Split the transaction figure by economic meaning (PR-4):
    // the incurred obligation is the delta itself; the payment
    // total nets out any pre-existing credits applied against it.
    // Credits apply only against a positive incurred amount (a
    // net-credit change is a credit, not a payment).
    const creditBalanceApplied = incurredAmount > 0 ? Math.min(sub.creditBalance ?? 0, incurredAmount) : 0;
    return {
      immediateTransaction: {
        incurredAmount,
        creditBalanceApplied,
        amount: incurredAmount - creditBalanceApplied,
        currencyCode: sub.currencyCode,
      },
      nextTransaction,
    };
  }
}

export class PaddleSimError extends Error {
  constructor(public type: string, message: string) {
    super(message);
  }
}

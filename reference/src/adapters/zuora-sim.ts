// In-memory fake modeling Zuora's Orders API subscription model.
//
// Grounded in documented Zuora behavior as of this writing (not verified
// against live docs in this sandbox — flagged explicitly where uncertain,
// same posture as the Stripe/Paddle sims):
//
// - Zuora's core object graph, unlike Stripe/Paddle, is Subscription ->
//   RatePlan -> RatePlanCharge, with a subscription carrying an explicit
//   `version` INTEGER that increments on every order that touches it. This
//   is a REAL, documented, monotonic version field — unlike Stripe/Paddle,
//   which have nothing analogous (see stripe-sim.ts / paddle-sim.ts). We
//   model it here as a plain incrementing integer that this sim bumps on
//   every successful order.
// - Changes are made via the Orders API: `POST /v1/orders` with an
//   `orderActions` array (e.g. `AddProduct`, `RemoveProduct`,
//   `UpdateProduct`, `RenewSubscription`, `CancelSubscription`,
//   `TermsAndConditions` for changing the contract term), each carrying an
//   `effectiveDate` (or `triggerDates`/`contractEffectiveDate` depending on
//   version of the API) that can be TODAY or an arbitrary FUTURE date —
//   this is a first-class, caller-specified concept unlike Stripe/Paddle,
//   which only ever mutate "now" (or a fixed period-end for cancellation).
// - Zuora exposes `POST /v1/orders/preview` — a genuinely non-mutating
//   preview of what an order WOULD do: resulting invoice items (immediate
//   charge/credit), the resulting rate plan charges (recurring amount),
//   and in many cases enough information to reason about term/renewal
//   consequences, though NOT uniformly (see below).
// - Subscriptions carry explicit CONTRACT TERM fields:
//   `initialTerm` / `initialTermPeriodType` (e.g. 12 MONTH),
//   `renewalTerm` / `renewalTermPeriodType`,
//   `autoRenew` (boolean),
//   `termStartDate` / `termEndDate` / `contractEffectiveDate`.
//   This is qualitatively richer than Stripe/Paddle, which have no
//   contract-term object at all — Zuora's IS a real object with real
//   fields, not something SCQ has to leave UNKNOWN across the board.
// - HOWEVER: whether a given order action changes those term fields is not
//   uniformly exposed by the preview call. Specifically:
//     * A pure `UpdateProduct` (e.g. changing a rate plan charge's
//       quantity, or swapping a charge, without a `TermsAndConditions`
//       action) does NOT alter initialTerm/renewalTerm and the preview
//       response's `orderActions` items and invoice preview are sufficient
//       to know this deterministically — termEffect is genuinely knowable
//       (and "no change") for a plain quantity/plan swap that keeps the
//       same term structure. We model this as the common case.
//     * A `TermsAndConditions` order action (explicitly changing
///      initialTerm/renewalTerm/autoRenew — the mechanism a MONTHLY ->
//       ANNUAL cadence change would realistically need to go through if it
//       is meant to also change the underlying contract term, not just the
//       recurring rate plan charge's billing period) DOES change term
//       fields, and Zuora's order preview DOES surface the resulting
//       term/contract fields for this action type — so this is also
//       knowable, just via a different, explicit order action.
//     * Where it gets genuinely murky: an order that swaps rate plans
//       (`RemovePlan`+`AddPlan`, i.e. our CHANGE_PLAN / CHANGE_CADENCE)
//       WITHOUT an explicit TermsAndConditions action, on a subscription
//       that has an evergreen (autoRenew, no fixed term) vs. fixed-term
//       structure, can have IMPLICIT interactions with renewal timing that
//       are not always fully surfaced by a single preview call — e.g.
//       whether a rate plan swap resets the "anniversary" billing date
//       used for a fixed-term renewal calculation depends on account-level
//       and product-catalog-level configuration (`SpecificBillingPeriod`,
//       alignment rules) that isn't returned by the preview response body
//       itself. We model this uncertainty explicitly: CHANGE_CADENCE
//       previews return enough to price the change exactly, but the sim
//       deliberately does NOT return enough information to answer "does
//       this shift the renewal anchor date" — mirroring what we believe is
//       a genuine, real gap (flagged as an uncertainty, not asserted with
//       full confidence, since we could not verify this against live Zuora
//       docs in this sandbox).
// - Cancellation: `CancelSubscription` order action takes a
//   `cancellationEffectiveDate` and a `cancellationPolicy`
//   (`EndOfLastInvoicePeriod` / `SpecificDate` / `Today`). Canceling DURING
//   a committed (non-evergreen) initial term can trigger an early
//   termination consequence — real Zuora billing setups often model this
//   via a separate "early termination fee" rate plan/charge that must be
//   explicitly added as another order action, or via account/product
//   configuration that auto-applies one; the plain preview of a
//   CancelSubscription action alone does NOT reliably surface whether such
//   a fee applies, because that logic can live in configuration outside
//   the order itself (workflow rules, custom settlements). We model this
//   as a genuine unknown for cancel-during-term, and as fully knowable
//   (no fee, no term math) for cancel of an evergreen (already
//   auto-renewing, no remaining committed term) subscription.
// - Order preview responses are NOT persisted, addressable resources any
//   more than Stripe/Paddle's — same "preview identifier" gap as v0.1
//   found for the other two providers. There is no native quote id to
//   round-trip.
// - Effective-dated changes: because `effectiveDate` on an order action
//   can be an arbitrary future date, "will the order, when actually
//   created later, honor the SAME effective date and the SAME computed
//   numbers" is its own question distinct from proration timing on
//   Stripe/Paddle. If nothing about the subscription's rate plans changes
//   between preview and order creation, replaying the identical
//   `effectiveDate` and order action inputs verbatim DOES reproduce the
//   same numbers deterministically in this sim (Zuora order pricing is not
//   a function of "wall-clock now" the way Stripe/Paddle proration is —
//   it's a function of the rate plan charges and the stated effective
//   date, both of which are inputs, not ambient state) — this is a
//   genuine, structural difference from Stripe/Paddle's proration-at-
//   call-time behavior, and is the basis for Zuora's stronger EXACT
//   coverage on the financial dimensions. What's NOT guaranteed: whether
//   the SUBSCRIPTION VERSION at order-creation time still matches what was
//   true at preview time (see CHANGE_CONFLICT / version-mismatch below) —
//   that's the compare-and-swap question, analogous to but structurally
//   different from Stripe/Paddle's fingerprint check.

import crypto from "node:crypto";

export type ZuoraRatePlanCharge = {
  id: string;
  productRatePlanChargeId: string; // catalog reference, analogous to a Stripe price id
  chargeModel: "PerUnit" | "FlatFee";
  unitAmount: number; // minor units, per unit if PerUnit
  currency: string;
  billingPeriod: "Month" | "Annual";
  quantity: number;
};

export type ZuoraRatePlan = {
  id: string;
  productRatePlanId: string;
  ratePlanCharges: ZuoraRatePlanCharge[];
};

export type ZuoraTermStructure = {
  initialTerm: number; // count of initialTermPeriodType units
  initialTermPeriodType: "Month" | "Year";
  autoRenew: boolean;
  renewalTerm: number;
  renewalTermPeriodType: "Month" | "Year";
  contractEffectiveDate: string; // ISO date the current term started
  termStartDate: string;
  termEndDate: string; // ISO date the current committed term ends (if not evergreen)
};

export type ZuoraSubscription = {
  id: string; // A-S00000001-style in real Zuora; kept simple here
  /** Real, native, monotonic version counter — Zuora's actual optimistic-concurrency field. Increments on every order. */
  version: number;
  status: "Active" | "Cancelled" | "Expired";
  ratePlans: ZuoraRatePlan[];
  term: ZuoraTermStructure;
  cancelledDate?: string;
};

export type OrderActionType = "AddProduct" | "RemoveProduct" | "UpdateProduct" | "TermsAndConditions" | "CancelSubscription";

export type OrderAction = {
  type: OrderActionType;
  effectiveDate: string; // ISO date — can be today or an arbitrary future date
  // Payloads kept loose/untyped-ish per action type, mirroring how varied Zuora's real orderAction bodies are per type.
  ratePlanId?: string;
  productRatePlanChargeId?: string;
  quantity?: number;
  productRatePlanId?: string; // for AddProduct (new rate plan from catalog)
  newTerm?: Partial<ZuoraTermStructure>; // for TermsAndConditions
  cancellationPolicy?: "EndOfLastInvoicePeriod" | "SpecificDate" | "Today";
};

export type OrderPreviewInvoiceItem = {
  description: string;
  amount: number; // signed: positive = charge, negative = credit
  serviceStartDate: string;
};

export type OrderPreviewResult = {
  invoiceItems: OrderPreviewInvoiceItem[];
  netImmediate: number;
  resultingRecurringAmount: number;
  resultingCadence: "MONTHLY" | "ANNUAL";
  /**
   * Whether this preview's response body itself contains enough
   * information to determine the term/renewal consequence of the order —
   * see file header for exactly when this is true vs. false. When false,
   * `termConsequenceKnown` fields below are not populated even though the
   * preview succeeded; this models a genuine information gap, not a sim
   * limitation elsewhere fixed.
   */
  termConsequenceKnown: boolean;
  resultingTerm?: {
    createsOrExtendsCommitment: boolean;
    commitmentUntil?: string;
    autoRenew: boolean;
  };
  /** Present only when a CancelSubscription action's early-termination consequence could not be determined from the order itself. */
  earlyTerminationChargeUnknown?: boolean;
};

const CATALOG: Record<string, { unitAmount: number; billingPeriod: "Month" | "Annual"; currency: string }> = {
  ratePlan_seat_basic_monthly: { unitAmount: 1000, billingPeriod: "Month", currency: "usd" },
  ratePlan_seat_pro_monthly: { unitAmount: 1500, billingPeriod: "Month", currency: "usd" },
  ratePlan_seat_basic_annual: { unitAmount: 10000, billingPeriod: "Annual", currency: "usd" },
};

export class ZuoraSim {
  private subs = new Map<string, ZuoraSubscription>();
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

  seedSubscription(sub: ZuoraSubscription): void {
    this.subs.set(sub.id, sub);
  }

  get(id: string): ZuoraSubscription {
    const sub = this.subs.get(id);
    if (!sub) throw new ZuoraSimError("SubscriptionNotFound", `Subscription ${id} not found`);
    return structuredClone(sub);
  }

  /** Out-of-band mutation simulating another system directly changing state (e.g. a different order created outside SCQ, or a CSR action). Bumps version, matching real Zuora behavior — ANY order bumps version, not just ones SCQ initiated. */
  _debugMutateDirectly(id: string, mutator: (sub: ZuoraSubscription) => void): void {
    const sub = this.subs.get(id);
    if (!sub) throw new ZuoraSimError("SubscriptionNotFound", `Subscription ${id} not found`);
    mutator(sub);
    sub.version += 1;
  }

  /**
   * POST /v1/orders/preview — non-mutating. Computes exactly what
   * createOrder() would do for the same orderActions, without persisting
   * anything or bumping version.
   */
  previewOrder(subscriptionId: string, orderActions: OrderAction[]): OrderPreviewResult {
    const sub = this.get(subscriptionId);
    return this.computeOrderEffect(sub, orderActions);
  }

  /**
   * POST /v1/orders — mutates. Applies the order actions and bumps
   * `version` by exactly 1, regardless of how many orderActions are in the
   * single order (an order is one atomic unit in real Zuora — multiple
   * order actions in ONE order apply together and bump version once; this
   * is itself a point in Zuora's favor for atomicity of MULTI-STEP changes
   * within a single order, though it does NOT provide a compare-and-swap
   * against a caller-supplied expected version — see zuora-adapter.ts for
   * how SCQ still has to do its own version check before calling this).
   */
  createOrder(
    subscriptionId: string,
    orderActions: OrderAction[]
  ): { subscription: ZuoraSubscription; result: OrderPreviewResult } {
    const sub = this.subs.get(subscriptionId);
    if (!sub) throw new ZuoraSimError("SubscriptionNotFound", `Subscription ${subscriptionId} not found`);

    const result = this.computeOrderEffect(sub, orderActions);

    for (const action of orderActions) {
      this.applyAction(sub, action);
    }
    sub.version += 1;

    return { subscription: structuredClone(sub), result };
  }

  private applyAction(sub: ZuoraSubscription, action: OrderAction): void {
    switch (action.type) {
      case "UpdateProduct": {
        const plan = sub.ratePlans.find((p) => p.id === action.ratePlanId);
        if (!plan) throw new ZuoraSimError("InvalidOrderAction", `RatePlan ${action.ratePlanId} not found`);
        const charge = plan.ratePlanCharges.find((c) => c.id === action.productRatePlanChargeId);
        if (!charge) throw new ZuoraSimError("InvalidOrderAction", `RatePlanCharge ${action.productRatePlanChargeId} not found`);
        if (action.quantity !== undefined) charge.quantity = action.quantity;
        break;
      }
      case "RemoveProduct": {
        sub.ratePlans = sub.ratePlans.filter((p) => p.id !== action.ratePlanId);
        break;
      }
      case "AddProduct": {
        const catalogEntry = action.productRatePlanId ? CATALOG[action.productRatePlanId] : undefined;
        if (!catalogEntry) throw new ZuoraSimError("InvalidOrderAction", `Unknown productRatePlanId ${action.productRatePlanId}`);
        const newRatePlanId = `rp_${crypto.randomBytes(6).toString("hex")}`;
        sub.ratePlans.push({
          id: newRatePlanId,
          productRatePlanId: action.productRatePlanId!,
          ratePlanCharges: [
            {
              id: `rpc_${crypto.randomBytes(6).toString("hex")}`,
              productRatePlanChargeId: action.productRatePlanId!,
              chargeModel: "PerUnit",
              unitAmount: catalogEntry.unitAmount,
              currency: catalogEntry.currency,
              billingPeriod: catalogEntry.billingPeriod,
              quantity: action.quantity ?? 1,
            },
          ],
        });
        break;
      }
      case "TermsAndConditions": {
        if (action.newTerm) Object.assign(sub.term, action.newTerm);
        break;
      }
      case "CancelSubscription": {
        // Real Zuora: a CancelSubscription order with a future
        // effectiveDate schedules the cancellation without immediately
        // changing subscription status — the subscription remains Active
        // until that date is reached. Only a same-day/past effectiveDate
        // cancels immediately. This mirrors the Stripe/Paddle adapters'
        // PERIOD_END vs IMMEDIATE distinction, expressed here via
        // effectiveDate rather than a separate boolean flag, since that's
        // how Zuora's real order action is actually shaped.
        sub.cancelledDate = action.effectiveDate;
        const effectiveDate = new Date(action.effectiveDate);
        if (effectiveDate.getTime() <= this.now.getTime()) {
          sub.status = "Cancelled";
        }
        // else: status stays "Active"; cancelledDate records the scheduled
        // date. This sim does not model a background job that flips status
        // once "now" passes cancelledDate — callers that need to see the
        // post-effective-date state should advance sim time and re-check,
        // same limitation as the other sims' period-end modeling.
        break;
      }
    }
  }

  /**
   * Content-hash fingerprint over mutable fields, provided ONLY for
   * parity/comparison purposes with the Stripe/Paddle sims and NOT used by
   * the Zuora adapter for staleness detection — Zuora's real, native
   * `version` integer is used for that instead (see zuora-adapter.ts). This
   * method exists so research code/tests can directly contrast "a
   * synthetic hash workaround" against "a real native version field" on
   * the same subscription state if useful, but is not part of the normal
   * commit path.
   */
  fingerprint(subscriptionId: string): string {
    const sub = this.get(subscriptionId);
    const material = JSON.stringify({
      status: sub.status,
      ratePlans: sub.ratePlans.map((p) => ({
        id: p.id,
        charges: p.ratePlanCharges.map((c) => ({ id: c.id, productRatePlanChargeId: c.productRatePlanChargeId, quantity: c.quantity })),
      })),
      term: sub.term,
    });
    return crypto.createHash("sha256").update(material).digest("hex").slice(0, 16);
  }

  private computeOrderEffect(sub: ZuoraSubscription, orderActions: OrderAction[]): OrderPreviewResult {
    const invoiceItems: OrderPreviewInvoiceItem[] = [];
    let resultingRecurring = 0;
    let resultingCadence: "MONTHLY" | "ANNUAL" = "MONTHLY";
    let termConsequenceKnown = true;
    let resultingTerm: OrderPreviewResult["resultingTerm"] | undefined;
    let earlyTerminationChargeUnknown = false;

    // Compute prior recurring total for proration-style delta invoicing.
    // Real Zuora order preview for a mid-period quantity/charge change
    // produces a delta invoice item computed from the charge's OWN
    // service-period boundaries (not "now" the way Stripe/Paddle compute
    // proration) — the effectiveDate ITSELF is the pivot, an explicit
    // input rather than ambient wall-clock time. We model that directly:
    // the delta is computed from the difference between old and new
    // per-period value, scaled by the fraction of the current charge
    // period remaining as of the order's stated effectiveDate — which is
    // deterministic given the same inputs, unlike Stripe/Paddle.
    const priorRecurring = sub.ratePlans.reduce(
      (sum, p) => sum + p.ratePlanCharges.reduce((s, c) => s + c.unitAmount * c.quantity, 0),
      0
    );

    let sawTermsAndConditions = false;
    let sawPlanSwapWithoutTerms = false;
    let sawCancel = false;
    let cancelDuringCommittedTerm = false;

    for (const action of orderActions) {
      switch (action.type) {
        case "UpdateProduct": {
          const plan = sub.ratePlans.find((p) => p.id === action.ratePlanId);
          const charge = plan?.ratePlanCharges.find((c) => c.id === action.productRatePlanChargeId);
          if (!plan || !charge) throw new ZuoraSimError("InvalidOrderAction", "RatePlan/charge not found for UpdateProduct preview");
          const newQuantity = action.quantity ?? charge.quantity;
          const effectiveDate = new Date(action.effectiveDate);
          const fractionRemaining = this.fractionOfPeriodRemaining(effectiveDate, charge.billingPeriod);
          const delta = Math.round((newQuantity - charge.quantity) * charge.unitAmount * fractionRemaining);
          if (delta !== 0) {
            invoiceItems.push({
              description: delta > 0 ? "Mid-period quantity increase" : "Mid-period quantity decrease credit",
              amount: delta,
              serviceStartDate: action.effectiveDate,
            });
          }
          resultingCadence = charge.billingPeriod === "Annual" ? "ANNUAL" : "MONTHLY";
          break;
        }
        case "RemoveProduct":
        case "AddProduct": {
          // Plan-swap style action (our CHANGE_PLAN / CHANGE_CADENCE map to
          // Remove+Add pairs). termConsequenceKnown becomes false below
          // UNLESS a TermsAndConditions action is also present in the same
          // order — modeling the genuine gap described in the file header.
          sawPlanSwapWithoutTerms = true;
          break;
        }
        case "TermsAndConditions": {
          sawTermsAndConditions = true;
          resultingTerm = {
            createsOrExtendsCommitment: !!(action.newTerm?.initialTerm || action.newTerm?.renewalTerm),
            commitmentUntil: action.newTerm?.termEndDate,
            autoRenew: action.newTerm?.autoRenew ?? sub.term.autoRenew,
          };
          break;
        }
        case "CancelSubscription": {
          sawCancel = true;
          const effectiveDate = new Date(action.effectiveDate);
          const termEnd = new Date(sub.term.termEndDate);
          cancelDuringCommittedTerm = !sub.term.autoRenew ? effectiveDate < termEnd : false;
          break;
        }
      }
    }

    // Recompute resulting recurring total from ratePlans as they'd stand
    // after applying quantity/plan changes (deterministic, no "now" dependency
    // beyond what's already folded into fractionRemaining above).
    for (const action of orderActions) {
      if (action.type === "UpdateProduct" && action.quantity !== undefined) {
        const plan = sub.ratePlans.find((p) => p.id === action.ratePlanId)!;
        const charge = plan.ratePlanCharges.find((c) => c.id === action.productRatePlanChargeId)!;
        resultingRecurring = priorRecurring - charge.unitAmount * charge.quantity + charge.unitAmount * action.quantity;
      }
    }
    if (orderActions.some((a) => a.type === "AddProduct")) {
      const addAction = orderActions.find((a) => a.type === "AddProduct")!;
      const catalogEntry = CATALOG[addAction.productRatePlanId!];
      const removedTotal = orderActions
        .filter((a) => a.type === "RemoveProduct")
        .reduce((sum, a) => {
          const plan = sub.ratePlans.find((p) => p.id === a.ratePlanId);
          return sum + (plan ? plan.ratePlanCharges.reduce((s, c) => s + c.unitAmount * c.quantity, 0) : 0);
        }, 0);
      const qty = addAction.quantity ?? 1;
      resultingRecurring = priorRecurring - removedTotal + catalogEntry.unitAmount * qty;
      resultingCadence = catalogEntry.billingPeriod === "Annual" ? "ANNUAL" : "MONTHLY";

      if (catalogEntry.billingPeriod === "Annual") {
        // Mid-period cadence-changing swap: charge/credit the prorated
        // difference for the remainder of the CURRENT period, using the
        // order's stated effectiveDate as the pivot (deterministic, not
        // wall-clock-dependent).
        const effectiveDate = new Date(addAction.effectiveDate);
        const oldPlan = sub.ratePlans.find((p) => orderActions.some((a) => a.type === "RemoveProduct" && a.ratePlanId === p.id));
        const oldCharge = oldPlan?.ratePlanCharges[0];
        if (oldCharge) {
          const fractionRemaining = this.fractionOfPeriodRemaining(effectiveDate, oldCharge.billingPeriod);
          const oldRemainingValue = Math.round(oldCharge.unitAmount * oldCharge.quantity * fractionRemaining);
          invoiceItems.push({ description: "Unused monthly plan credit", amount: -oldRemainingValue, serviceStartDate: addAction.effectiveDate });
          const newRemainingValue = Math.round((catalogEntry.unitAmount / 12) * qty * fractionRemaining * 12 * (1 / 12));
          // Simplified: charge a proportional slice of the new annual amount for the remaining days of the current monthly period.
          invoiceItems.push({ description: "Prorated annual plan charge", amount: newRemainingValue, serviceStartDate: addAction.effectiveDate });
        }
      }
    }
    if (orderActions.length === 0) resultingRecurring = priorRecurring;

    termConsequenceKnown = !sawPlanSwapWithoutTerms || sawTermsAndConditions;
    if (sawTermsAndConditions && !resultingTerm) {
      resultingTerm = { createsOrExtendsCommitment: false, autoRenew: sub.term.autoRenew };
    }
    if (!sawTermsAndConditions && !sawPlanSwapWithoutTerms && !sawCancel) {
      // Plain quantity-only change: term is deterministically UNAFFECTED —
      // this is the "genuinely knowable, and the answer is no-change" case
      // from the file header.
      termConsequenceKnown = true;
      resultingTerm = { createsOrExtendsCommitment: false, commitmentUntil: sub.term.autoRenew ? undefined : sub.term.termEndDate, autoRenew: sub.term.autoRenew };
    }

    if (sawCancel) {
      termConsequenceKnown = !cancelDuringCommittedTerm; // evergreen cancel: fully known (no term math). Mid-term cancel: early-termination consequence unknown from the order alone.
      earlyTerminationChargeUnknown = cancelDuringCommittedTerm;
      resultingTerm = { createsOrExtendsCommitment: false, autoRenew: false };
    }

    const netImmediate = invoiceItems.reduce((sum, i) => sum + i.amount, 0);

    return {
      invoiceItems,
      netImmediate,
      resultingRecurringAmount: resultingRecurring,
      resultingCadence,
      termConsequenceKnown,
      resultingTerm,
      earlyTerminationChargeUnknown: earlyTerminationChargeUnknown || undefined,
    };
  }

  private fractionOfPeriodRemaining(effectiveDate: Date, billingPeriod: "Month" | "Annual"): number {
    // Deterministic given effectiveDate as an INPUT (not sim wall-clock) —
    // this models Zuora's real behavior where the order's own effective
    // date, not "now", pivots the proration math. We approximate period
    // length in days for simplicity (30 for Month, 365 for Annual) and
    // compute remaining fraction from effectiveDate to a synthetic period
    // boundary derived from term.termStartDate for determinism across
    // preview/order calls with the same effectiveDate.
    const periodDays = billingPeriod === "Annual" ? 365 : 30;
    const daysIntoMonth = effectiveDate.getUTCDate() - 1;
    const remaining = Math.max(0, periodDays - daysIntoMonth);
    return remaining / periodDays;
  }
}

export class ZuoraSimError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

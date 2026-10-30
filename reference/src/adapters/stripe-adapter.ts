import crypto from "node:crypto";
import {
  SCQError,
  type ActionCapabilities,
  type ChangeAction,
  type ChangeSpec,
  type CommercialEffect,
  type EffectiveIntent,
  type GuaranteeCoverage,
  type MultiChangeConsistency,
  type MutationOutcome,
  type ProviderCapabilities,
  type ProviderObservation,
  type ReconciliationResult,
  type SubscriptionChangeProposal,
  type SubscriptionChangeQuote,
  type SubscriptionChangeReceipt,
  type SubscriptionProvider,
  type SubscriptionSnapshot,
} from "../core/types.js";
import {
  validateCommit,
  checkAcceptanceEnvelope,
  resolveGuaranteeMode,
  enforceGuaranteeRequest,
  computeCombinedCoverage,
  computeMultiChangeConsistency,
  enforceMultiChangeConsistency,
  enforceNoPartialExecutionRisk,
  enforceEffectiveIntent,
  checkIdempotentReplay,
  reconcileCommittedEffect,
  determinacyOf,
} from "../core/scq-engine.js";
import { QuoteStore, establishVerification, type StoredQuote } from "../store/quote-store.js";
import {
  StripeSim,
  StripeSimError,
  type StripeInvoice,
  type StripeSubscription,
  type UpcomingInvoicePreview,
} from "./stripe-sim.js";

const QUOTE_TTL_MS = 5 * 60 * 1000; // 5 minutes — arbitrary research default

type StripeItemInput = { id?: string; price: string; quantity: number };

type StripePreviewInput = {
  items: StripeItemInput[];
  proration_behavior: "create_prorations" | "none" | "always_invoice";
  /** Captured at quote time, replayed verbatim on commit to pin the proration time-basis. Only meaningful for EXACT. */
  proration_date?: number;
  cancel_at_period_end?: boolean;
  cancel_immediately?: boolean;
};

const OFFERING_TO_PRICE: Record<string, string> = {
  "plan:basic:monthly": "price_seat_basic",
  "plan:pro:monthly": "price_seat_pro",
  "plan:basic:annual": "price_seat_basic_annual",
};

/**
 * v0.6 capability source of truth for Stripe. `getCapabilities()` and the
 * enforcement functions in createChangeQuote all call this SAME function,
 * so the coarse advertisement can never drift from what commit actually
 * enforces.
 *
 * GuaranteeCoverage reasoning is unchanged from v0.4/v0.5: financial
 * dimensions EXACT everywhere (proration_date replay pins the time-fraction
 * basis); termEffect UNKNOWN except for CANCEL (no contract-term object on
 * a plain Stripe subscription, except CANCEL's "does this create a
 * commitment" question, exactly answerable as "no"); effectiveAt EXACT
 * everywhere Stripe has a fixed, knowable effective moment.
 *
 * `supportedEffectiveIntents`: Stripe supports "IMMEDIATE" for every
 * action, and "TERM_END" ONLY for CANCEL (`cancel_at_period_end` — the
 * only native period-boundary-deferred primitive Stripe has on a plain
 * subscription). "DATE" (an arbitrary caller-chosen future instant) is
 * NOT supported for ANY action — Stripe has no such mechanism — so
 * requesting `effectiveIntent: { type: "DATE", at: ... }` is refused via
 * enforceEffectiveIntent for every Stripe action.
 */
function capabilitiesFor(action: ChangeAction): ActionCapabilities {
  const guaranteeCoverage: GuaranteeCoverage =
    action === "CANCEL"
      ? { immediateFinancialEffect: "EXACT", recurringFinancialEffect: "EXACT", termEffect: "EXACT", effectiveAt: "EXACT" }
      : { immediateFinancialEffect: "EXACT", recurringFinancialEffect: "EXACT", termEffect: "UNKNOWN", effectiveAt: "EXACT" };
  const supportedEffectiveIntents: Array<EffectiveIntent["type"]> = action === "CANCEL" ? ["IMMEDIATE", "TERM_END"] : ["IMMEDIATE"];
  return { guaranteeCoverage, supportedEffectiveIntents };
}

/**
 * Whether two change actions can be bundled into ONE Stripe
 * `subscriptions.update` call. Stripe's real `items[]` array parameter
 * genuinely accepts multiple item changes (quantity and/or price swaps) in
 * a single API call, applied together — so CHANGE_QUANTITY+CHANGE_PLAN (or
 * +CHANGE_CADENCE, modeled as a plan swap) bundle ATOMICALLY, one call, one
 * server-side transaction. CANCEL is a SEPARATE endpoint/parameter set
 * (`cancel_at_period_end` / DELETE) that cannot be combined with an
 * `items[]` update in the same call — bundling CANCEL with anything else
 * is UNSUPPORTED, not merely best-effort, because there is no way to even
 * attempt it as one call (see also v0.6's enforceNoPartialExecutionRisk:
 * since this adapter never even ATTEMPTS a CANCEL+other bundle as one
 * call, there is no partial-execution risk to separately guard against for
 * this provider — see createChangeQuote for where that's confirmed).
 */
function multiChangePairSupport(a: ChangeAction, b: ChangeAction): MultiChangeConsistency {
  if (a === "CANCEL" || b === "CANCEL") return "UNSUPPORTED";
  return "ATOMIC";
}

// ---------------------------------------------------------------------------
// v0.6.2 (PR-3) financial-semantics helpers.
//
// §3.11 / CORE-3: `CommercialEffect.immediate` is ONLY the net
// obligation the change itself incurs at its effective time. The
// simulator preview now separates that figure (`incurred_amount`)
// from the payment figure (`amount_due` = incurred minus applied
// customer balance) and from next-invoice totals. The adapter maps
// `incurred_amount` — and nothing else — into `immediate`;
// `amount_due`, the applied balance, and next-period totals are
// reported, labeled, in the quote's providerMetadata (see
// `invoiceEstimateMetadata`). A preview that withholds
// `incurred_amount` cannot establish the dimension: the effect
// asserts UNKNOWN for it and emits no figure — never a zero, never
// the amount_due as a substitute.
// ---------------------------------------------------------------------------

const PROV_IMMEDIATE_QUOTE =
  "simulator upcoming-invoice preview of the final folded item set: sum of the proration line items the folded change set generates (preview.incurred_amount) — the obligation incurred at the effective time, before any customer-balance application";
const PROV_RECURRING_QUOTE =
  "simulator upcoming-invoice preview of the final folded item set: next_period_recurring_amount (sum over post-change items of unitAmount x quantity)";
const PROV_IMMEDIATE_WITHHELD =
  "UNESTABLISHED: the simulator preview withheld its incurred-amount figure (preview.incurred_amount absent), so no incurred obligation could be established — the dimension is UNKNOWN, not zero, and amount_due is never substituted for it";
/**
 * PR #10 correction M3: the committed immediate's provenance NAMES
 * the bound invoice — the invoice THIS mutation generated, bound by
 * its id at verification time. The subscription's `latest_invoice`
 * is never the source: a later mutation may have replaced it.
 */
function provImmediateCommitted(invoiceId: string): string {
  return (
    `post-commit actual: incurred_amount of invoice ${invoiceId} — the invoice THIS mutation generated, ` +
    `bound by id and read back from the simulator after the mutation (a provider read, not a preview); ` +
    `the subscription's latest_invoice was not used`
  );
}
const PROV_RECURRING_COMMITTED =
  "post-commit actual: sum over the re-read post-commit subscription's items (unitAmount x quantity)";

/** Splits a signed incurred amount into the immediate {charge, credit, net} shape. */
function immediateParts(net: number): NonNullable<CommercialEffect["immediate"]> {
  return {
    charge: net > 0 ? net : undefined,
    credit: net < 0 ? -net : undefined,
    net,
  };
}

/**
 * v0.6.2 (PR #10 correction M2): adapter-level determinacy gate for
 * commits. The frozen v0.6.1 acceptance envelope coerces absent
 * figures to 0 (§14.6-pinned behavior), so an effect whose incurred
 * figure is UNKNOWN — at quote time, or in the commit-time
 * revalidation — could pass the gate and proceed to MUTATE: the
 * adapter would commit a change whose financial effect it does not
 * know. Fail-closed treatment of UNKNOWN in the shared envelope is
 * BC-1, activated in the core by PR-10 (this PR series' PR-10):
 * checkAcceptanceEnvelope now refuses unenforceable dimensions
 * itself. THIS adapter still refuses such commits itself, before
 * any mutating call, with QUOTE_NOT_DETERMINISTIC — the local gate
 * is the earlier, adapter-specific refusal (it names this
 * adapter's stage and fires before the core gate is reached); the
 * core gate is the protocol-level backstop behind it.
 *
 * A dimension passes iff it is DETERMINED with a finite value, or
 * NOT_APPLICABLE under the §3.10 license — which covers exactly
 * one case: the immediate dimension of a CANCEL proposal, with the
 * matching applicability citation in the effect's provenance (the
 * shape this adapter's own CANCEL quotes carry). Recurring is
 * never licensed NOT_APPLICABLE. Anything else — UNKNOWN
 * (including a legacy payload's absent determinacy), an unjustified
 * NOT_APPLICABLE, or a DETERMINED assertion over a missing /
 * non-finite value — refuses the commit.
 */
function assertEffectDeterminateForCommit(
  effect: CommercialEffect,
  proposal: SubscriptionChangeProposal,
  stage: "quoted" | "revalidated"
): void {
  const states = determinacyOf(effect);
  const dimensions = [
    { dimension: "immediateFinancialEffect", state: states.immediateFinancialEffect, value: effect.immediate?.net },
    { dimension: "recurringFinancialEffect", state: states.recurringFinancialEffect, value: effect.recurring?.resultingAmount },
  ] as const;
  for (const { dimension, state, value } of dimensions) {
    if (state === "DETERMINED" && typeof value === "number" && Number.isFinite(value)) continue;
    if (state === "NOT_APPLICABLE" && dimension === "immediateFinancialEffect") {
      const citation = effect.provenance?.applicabilityCitations?.immediateFinancialEffect;
      const licensed =
        proposal.changes.length === 1 &&
        proposal.changes[0].action === "CANCEL" &&
        citation?.action === "CANCEL" &&
        citation?.dimension === "immediateFinancialEffect";
      if (licensed) continue;
    }
    throw new SCQError(
      "QUOTE_NOT_DETERMINISTIC",
      `Refusing to commit: the ${stage} effect's ${dimension} is ${state}` +
        (state === "DETERMINED" ? " without a finite established value" : "") +
        `. The v0.6.1 acceptance envelope would coerce the missing figure to 0, so this adapter refuses ` +
        `before any mutation rather than commit a change whose financial effect is not established.`,
      { stage, dimension, state }
    );
  }
}

/**
 * The labeled providerMetadata form of a preview's invoice-side
 * figures. These are PAYMENT / next-invoice figures — retained with
 * their meaning and source, and NEVER mapped into a CommercialEffect.
 */
function invoiceEstimateMetadata(preview: UpcomingInvoicePreview): Record<string, unknown> {
  return {
    amountDue: preview.amount_due,
    customerBalanceApplied: preview.customer_balance_applied,
    nextPeriodRecurringAmount: preview.next_period_recurring_amount,
    ...(typeof preview.incurred_amount === "number" ? { incurredAmount: preview.incurred_amount } : {}),
    source: "stripe-simulator upcoming-invoice preview (synthetic simulator figure)",
    meaning:
      "payment-side figures for the upcoming invoice: amountDue is the incurred amount net of the applied customer balance. " +
      "They are NOT the incurred obligation (commercialEffect.immediate) and are never mapped into the effect (spec §3.11).",
  };
}

function snapshotFrom(sub: StripeSubscription): SubscriptionSnapshot {
  const totalRecurring = sub.items.reduce((sum, i) => sum + i.price.unitAmount * i.quantity, 0);
  const cadence = sub.items[0]?.price.interval === "year" ? "ANNUAL" : "MONTHLY";
  return {
    id: sub.id,
    version: "", // filled by caller using fingerprint; kept out here to avoid double sim lookups
    status: sub.status,
    items: sub.items.map((i) => ({
      id: i.id,
      offeringRef: Object.entries(OFFERING_TO_PRICE).find(([, p]) => p === i.price.id)?.[0] ?? i.price.id,
      quantity: i.quantity,
    })),
    billing: {
      currency: sub.items[0]?.price.currency ?? "usd",
      recurringAmount: totalRecurring,
      // v0.6.2 (CORE-7): the total is computed from the item state
      // this snapshot was built from — a determined figure, labeled
      // as such rather than left to imply its own determinacy.
      recurringAmountState: "DETERMINED",
      cadence,
      nextBillingAt: new Date(sub.current_period_end * 1000).toISOString(),
    },
    term: {
      // Stripe subscriptions (non-contract) don't natively express a
      // commitment window. This is not "not applicable" — Stripe genuinely
      // has no field here — so it is explicitly UNKNOWN, not undefined.
      commitmentUntil: "UNKNOWN",
      autoRenew: !sub.cancel_at_period_end,
    },
  };
}

/**
 * Builds the quote-side effect from the folded preview.
 * v0.6.2 (PR-3): `immediate` comes from `preview.incurred_amount`
 * ONLY (§3.11) — this replaces the pre-migration mapping of
 * `preview.amount_due` into `immediate.{charge,credit,net}` at all
 * three per-action sites. Every effect carries explicit determinacy
 * and provenance; a withheld incurred figure asserts UNKNOWN and
 * emits no immediate at all.
 */
function effectFromPreview(
  preview: UpcomingInvoicePreview,
  recurring: CommercialEffect["recurring"],
  term: CommercialEffect["term"],
  effectiveAtIso: string
): CommercialEffect {
  const effect: CommercialEffect = { recurring, effectiveAt: effectiveAtIso };
  if (term !== undefined) effect.term = term;
  const incurred = preview.incurred_amount;
  if (typeof incurred === "number" && Number.isFinite(incurred)) {
    effect.immediate = immediateParts(incurred);
    effect.determinacy = { immediateFinancialEffect: "DETERMINED", recurringFinancialEffect: "DETERMINED" };
    effect.provenance = { immediate: PROV_IMMEDIATE_QUOTE, recurring: PROV_RECURRING_QUOTE };
  } else {
    effect.determinacy = { immediateFinancialEffect: "UNKNOWN", recurringFinancialEffect: "DETERMINED" };
    effect.provenance = { immediate: PROV_IMMEDIATE_WITHHELD, recurring: PROV_RECURRING_QUOTE };
  }
  return effect;
}

/**
 * Folds a single ChangeSpec into the batch's working item set —
 * NO preview is taken here. `workingItems` is the CURRENT state of
 * every item as of this point in the batch — i.e. it already
 * reflects any prior change in the same proposal that touched the
 * same item, so a later change to an item composes on the earlier
 * result (a quantity change sets that item's quantity; a second
 * quantity change to the SAME item supersedes the first one's
 * value — it does not add a second delta).
 *
 * v0.6.2 (PR #10 correction M1): the quote is derived from ONE
 * preview of the FINAL folded item set (see createChangeQuote).
 * The pre-fix construction previewed each change separately
 * against the ORIGINAL subscription and combined the per-change
 * effects — which double-counted overlapping same-item changes
 * (each preview measured its delta from the original state) and
 * took the aggregate recurring from the LAST preview only
 * (dropping earlier changes to other items from the quote, while
 * the commit — which always mutated to the folded set — landed
 * them). The recurring "shape" (currency / cadence) still follows
 * the batch's last change, as before; the FIGURES now come from
 * the single folded preview.
 */
function foldOneChange(
  sub: StripeSubscription,
  workingItems: Map<string, StripeItemInput>,
  change: ChangeSpec
): {
  item: StripeItemInput;
  recurringCurrency: string;
  recurringCadence?: "MONTHLY" | "ANNUAL";
  term?: CommercialEffect["term"];
} {
  const currentFor = (itemId: string): StripeItemInput => {
    const working = workingItems.get(itemId);
    if (working) return working;
    const original = sub.items.find((i) => i.id === itemId);
    if (!original) throw new SCQError("INVALID_PROPOSAL", `Item ${itemId} not found on subscription`);
    return { id: original.id, price: original.price.id, quantity: original.quantity };
  };
  switch (change.action) {
    case "CHANGE_QUANTITY": {
      const current = currentFor(change.itemId);
      const item = sub.items.find((i) => i.id === change.itemId);
      if (!item) throw new SCQError("INVALID_PROPOSAL", `Item ${change.itemId} not found on subscription`);
      return {
        item: { id: current.id, price: current.price, quantity: change.quantity },
        recurringCurrency: item.price.currency,
        recurringCadence: item.price.interval === "year" ? "ANNUAL" : "MONTHLY",
      };
    }
    case "CHANGE_PLAN": {
      const current = currentFor(change.itemId);
      const item = sub.items.find((i) => i.id === change.itemId);
      if (!item) throw new SCQError("INVALID_PROPOSAL", `Item ${change.itemId} not found on subscription`);
      const price = OFFERING_TO_PRICE[change.offeringRef];
      if (!price) throw new SCQError("UNSUPPORTED_CHANGE", `Unknown offeringRef ${change.offeringRef}`);
      return {
        item: { id: current.id, price, quantity: current.quantity },
        recurringCurrency: item.price.currency,
      };
    }
    case "CHANGE_CADENCE": {
      const item = sub.items[0];
      if (!item) throw new SCQError("INVALID_PROPOSAL", "Subscription has no items");
      const current = currentFor(item.id);
      const targetKey = change.cadence === "ANNUAL" ? "plan:basic:annual" : "plan:basic:monthly";
      const price = OFFERING_TO_PRICE[targetKey];
      return {
        item: { id: current.id, price, quantity: current.quantity },
        recurringCurrency: item.price.currency,
        recurringCadence: change.cadence,
        term: { createsCommitment: "UNKNOWN", commitmentUntil: "UNKNOWN", autoRenew: !sub.cancel_at_period_end },
      };
    }
    case "CANCEL":
      throw new SCQError("INVALID_PROPOSAL", "CANCEL cannot be combined with other changes in one Stripe proposal");
  }
}

/**
 * The proposal's FOLDED intent — what the commit actually
 * dispatches (the final item set in `provider_preview_input`) —
 * for post-commit state verification. When a batch repeats an
 * action against the same target (two CHANGE_QUANTITY sets on one
 * item, two plan swaps on one item, two cadence changes), the
 * later change SUPERSEDES the earlier one's stated value in the
 * folded set, so the executed intent for that target is the LAST
 * stated value. The PR-1 state check verifies every change in the
 * proposal against the final snapshot; fed the raw proposal, a
 * correctly landed folded commit would report a false MISMATCH
 * against a superseded intermediate value (e.g. quantity 120 in a
 * [100→120, →150] batch whose folded landing is 150). Verification
 * therefore runs against the folded intent — the same
 * intended-target-set principle the Chargebee adapter's state
 * checks use. The verdict is still COMPUTED by
 * establishVerification from the observation; only the intent it
 * is computed against is the executed one. The stored quote and
 * the caller's proposal are not modified.
 */
function foldedProposal(proposal: SubscriptionChangeProposal): SubscriptionChangeProposal {
  const keyOf = (change: ChangeSpec): string =>
    change.action === "CHANGE_QUANTITY" || change.action === "CHANGE_PLAN"
      ? `${change.action}:${change.itemId}`
      : change.action;
  const lastIndexByKey = new Map<string, number>();
  proposal.changes.forEach((change, i) => lastIndexByKey.set(keyOf(change), i));
  const keep = new Set(lastIndexByKey.values());
  return { ...proposal, changes: proposal.changes.filter((_, i) => keep.has(i)) };
}

export class StripeAdapter implements SubscriptionProvider {
  constructor(private sim: StripeSim, private store: QuoteStore) {}

  getCapabilities(): ProviderCapabilities {
    return {
      quoteCapabilities: {
        CHANGE_QUANTITY: capabilitiesFor("CHANGE_QUANTITY"),
        CHANGE_PLAN: capabilitiesFor("CHANGE_PLAN"),
        CHANGE_CADENCE: capabilitiesFor("CHANGE_CADENCE"),
        CANCEL: capabilitiesFor("CANCEL"),
      },
      // Neither Stripe's subscriptions.update nor its preview endpoint
      // accepts a server-enforced compare-and-swap precondition. SCQ's own
      // read-check-write is client-side and has a real race window. Never
      // report ATOMIC — see types.ts for what that would require.
      consistencyGuarantee: "BEST_EFFORT",
    };
  }

  async getSubscription(subscriptionId: string): Promise<SubscriptionSnapshot> {
    let sub: StripeSubscription;
    try {
      sub = this.sim.retrieve(subscriptionId);
    } catch (e) {
      throw toSCQError(e, subscriptionId);
    }
    const snap = snapshotFrom(sub);
    snap.version = this.sim.fingerprint(subscriptionId);
    return snap;
  }

  async createChangeQuote(
    subscriptionId: string,
    proposal: SubscriptionChangeProposal
  ): Promise<SubscriptionChangeQuote> {
    let sub: StripeSubscription;
    try {
      sub = this.sim.retrieve(subscriptionId);
    } catch (e) {
      throw toSCQError(e, subscriptionId);
    }
    if (proposal.changes.length === 0) {
      throw new SCQError("INVALID_PROPOSAL", "proposal.changes must contain at least one change");
    }

    const perChangeCapabilities = proposal.changes.map((c) => capabilitiesFor(c.action));
    // v0.6: every change in the batch must individually support the
    // requested effectiveIntent.type — checked BEFORE any preview call.
    for (const caps of perChangeCapabilities) {
      enforceEffectiveIntent(proposal.effectiveIntent, caps.supportedEffectiveIntents);
    }

    const guaranteeCoverage = computeCombinedCoverage(perChangeCapabilities.map((c) => c.guaranteeCoverage));
    const multiChangeConsistency = computeMultiChangeConsistency(proposal.changes, multiChangePairSupport);
    enforceMultiChangeConsistency(proposal.changes, multiChangeConsistency);
    // v0.6 normative rule: this adapter NEVER submits a bundle Stripe's
    // real API might silently partially-apply — it either bundles
    // non-CANCEL changes into ONE items[] call (verified atomic) or
    // refuses via multiChangeConsistency above (CANCEL+anything). There is
    // no third case where this adapter would submit something with
    // partial-execution risk, so mayPartiallyApply is always false here.
    enforceNoPartialExecutionRisk(proposal.changes, false);

    const effectiveMode = resolveGuaranteeMode(proposal);
    enforceGuaranteeRequest(proposal.changes, effectiveMode, guaranteeCoverage, proposal.acceptanceEnvelope);

    const fingerprint = this.sim.fingerprint(subscriptionId);
    const now = new Date();
    const nowUnix = this.sim.currentTime();
    const quoteId = `scq_stripe_${crypto.randomBytes(8).toString("hex")}`;

    let previewInput: StripePreviewInput;
    let commercialEffect: CommercialEffect;
    let previews: UpcomingInvoicePreview[] = [];

    if (proposal.changes.length === 1 && proposal.changes[0].action === "CANCEL") {
      const isTermEnd = proposal.effectiveIntent.type === "TERM_END";
      previewInput = {
        items: [],
        proration_behavior: "none",
        cancel_at_period_end: isTermEnd,
        cancel_immediately: !isTermEnd,
      };
      commercialEffect = {
        // v0.6.2 (PR-3): explicit determinacy for CANCEL. Immediate
        // is NOT_APPLICABLE under the §3.10 license (CANCEL x
        // immediateFinancialEffect — under this provider model a
        // cancellation generates no immediate financial event: the
        // sim's cancel issues no invoice and no proration), cited
        // in provenance. Recurring is NEVER not-applicable: the
        // post-cancellation price level is a DETERMINED zero.
        recurring: {
          resultingAmount: 0,
          currency: sub.items[0]?.price.currency ?? "usd",
          cadence: sub.items[0]?.price.interval === "year" ? "ANNUAL" : "MONTHLY",
        },
        term: { createsCommitment: false, autoRenew: false },
        effectiveAt: isTermEnd ? new Date(sub.current_period_end * 1000).toISOString() : now.toISOString(),
        determinacy: { immediateFinancialEffect: "NOT_APPLICABLE", recurringFinancialEffect: "DETERMINED" },
        provenance: {
          recurring:
            "post-cancellation price level: cancellation leaves no billable items once effective, so the resulting recurring amount is a determined zero",
          applicabilityCitations: {
            immediateFinancialEffect: { action: "CANCEL", dimension: "immediateFinancialEffect" },
          },
        },
      };
    } else {
      // One or more non-CANCEL changes, bundled into a single items[]
      // update — genuinely atomic on Stripe (see multiChangePairSupport).
      //
      // PR #10 correction M1: fold ALL changes into the final item
      // set FIRST (workingItems — a later change to an item composes
      // on the earlier result; the folded set is also exactly what
      // the commit will send), then derive the quote from ONE
      // preview of that folded set. The folded preview measures
      // every item's delta against the ORIGINAL state exactly once,
      // so overlapping same-item changes cannot double-count and
      // the aggregate recurring covers every item's change. (The
      // pre-fix code previewed each change against the original
      // subscription and combined the per-change effects.)
      const workingItems = new Map<string, StripeItemInput>();
      const steps = proposal.changes.map((change) => {
        const step = foldOneChange(sub, workingItems, change);
        workingItems.set(step.item.id!, step.item);
        return step;
      });
      const foldedItems = Array.from(workingItems.values());
      const preview = this.sim.previewUpcomingInvoice(subscriptionId, foldedItems, "create_prorations", nowUnix);
      previewInput = {
        items: foldedItems,
        proration_behavior: "create_prorations",
        proration_date: nowUnix,
      };
      previews = [preview];
      const lastStep = steps[steps.length - 1];
      const lastTerm = steps.reduce((t, s) => s.term ?? t, undefined as CommercialEffect["term"] | undefined);
      commercialEffect = effectFromPreview(
        preview,
        {
          previousAmount: sub.items.reduce((s, i) => s + i.price.unitAmount * i.quantity, 0),
          resultingAmount: preview.next_period_recurring_amount,
          currency: lastStep.recurringCurrency,
          ...(lastStep.recurringCadence ? { cadence: lastStep.recurringCadence } : {}),
        },
        lastTerm,
        now.toISOString()
      );
    }

    const expiresAt = new Date(now.getTime() + QUOTE_TTL_MS).toISOString();
    const stored: StoredQuote<StripePreviewInput> = {
      quote_id: quoteId,
      provider: "stripe",
      subscription_id: subscriptionId,
      subscription_version_at_quote: fingerprint,
      proposal,
      effective_guarantee_mode: effectiveMode,
      guarantee_coverage: guaranteeCoverage,
      multi_change_consistency: multiChangeConsistency,
      provider_preview_input: previewInput,
      quoted_effect: commercialEffect,
      created_at: now.toISOString(),
      expires_at: expiresAt,
      status: "ACTIVE",
    };
    this.store.put(stored as StoredQuote);

    return {
      id: quoteId,
      subscriptionRef: subscriptionId,
      preconditions: { subscriptionVersion: fingerprint },
      proposal,
      guaranteeMode: effectiveMode,
      guaranteeCoverage,
      multiChangeConsistency,
      commercialEffect,
      validUntil: expiresAt,
      providerMetadata: {
        proration_behavior: previewInput.proration_behavior,
        proration_date: previewInput.proration_date,
        // v0.6.2 (PR-3, §3.11): the preview's invoice-side figures
        // (amount due, applied customer balance, next-period total)
        // are reported HERE, labeled with meaning and source —
        // never in the effect. PR #10 correction M1: there is now
        // exactly ONE preview per quote — of the final folded item
        // set — so a multi-change quote's nextInvoiceEstimate is
        // that folded preview's figure, not a per-change list (the
        // pre-fix per-change `changeInvoiceEstimates` reported
        // sequential previews that did not compose).
        ...(previews.length === 1 ? { nextInvoiceEstimate: invoiceEstimateMetadata(previews[0]) } : {}),
      },
    };
  }

  async commitChangeQuote(quoteId: string): Promise<SubscriptionChangeReceipt> {
    // v0.6.1: idempotent replay MUST be checked before any read of live
    // provider state or mutating call — see checkIdempotentReplay's doc
    // comment. A repeated commit of an already-successfully-committed quote
    // returns the ORIGINAL receipt verbatim, never re-mutates.
    const cached = checkIdempotentReplay(this.store, quoteId);
    if (cached) return cached;

    const quote = this.store.get(quoteId);
    if (!quote) {
      throw new SCQError("QUOTE_STALE", `No quote found for id ${quoteId}`);
    }

    // v0.6.2 (CORE-8): a prior attempt on this quote whose outcome
    // was INDETERMINATE (the mutation was dispatched but its
    // landing was never established) must never be blindly retried:
    // the change may already have landed, and a second mutation
    // would double-apply it. Refuse here, before any state read or
    // mutation, and direct the caller to reconcile provider state
    // first. (A quote with a recorded RECEIPT never reaches this
    // line — replay above returns it; a CONFIRMED_NON_EXECUTION
    // attempt recorded no such block and may be retried as-is.)
    if (quote.commit_outcome?.outcome === "INDETERMINATE") {
      throw new SCQError(
        "PROVIDER_ERROR",
        `Commit outcome for quote ${quoteId} is INDETERMINATE: a previous commit attempt's mutation was ` +
          `dispatched but its landing was not established. No second mutation was issued. Reconcile the ` +
          `provider state manually before any retry.`,
        { outcome: "INDETERMINATE", indeterminate: true, reconciled: false }
      );
    }

    // --- Read step: fingerprint current live state. ---
    // Separate sim call from the mutation below (and, for REVALIDATE, from
    // the re-preview call below that too) — matching the real shape: no
    // compare-and-swap parameter exists on Stripe's update endpoint. A
    // TOCTOU window exists between this read and whichever call actually
    // mutates state further down. We do NOT paper over it with an
    // adapter-local lock.
    const currentFingerprint = this.sim.fingerprint(quote.subscription_id);
    const validated = validateCommit(this.store, quoteId, currentFingerprint);

    const input = validated.provider_preview_input as StripePreviewInput;
    const proposal = validated.proposal;
    const effectiveMode = validated.effective_guarantee_mode;
    const isCancel = proposal.changes.length === 1 && proposal.changes[0].action === "CANCEL";

    // v0.6.2 (PR #10 correction M2): the QUOTED effect must be
    // determinate before this commit proceeds in ANY mode. The
    // frozen v0.6.1 envelope coerces absent figures to 0, so an
    // UNKNOWN quoted incurred figure could otherwise pass a loose
    // envelope and mutate (see assertEffectDeterminateForCommit).
    // This refusal happens before the re-preview and before any
    // mutating call; a licensed CANCEL NOT_APPLICABLE passes.
    assertEffectDeterminateForCommit(validated.quoted_effect, proposal, "quoted");

    if (effectiveMode === "REVALIDATE" && !isCancel) {
      // Order per spec: re-preview -> evaluate acceptance envelope -> mutate
      // -> fetch resulting state -> receipt. Re-preview is non-mutating and
      // runs BEFORE any mutating call, so a drift verdict of QUOTE_DRIFTED
      // means a genuine refusal, not a report filed after the fact.
      const freshPreview = this.sim.previewUpcomingInvoice(
        validated.subscription_id,
        input.items,
        input.proration_behavior
        // Deliberately NOT passing input.proration_date: REVALIDATE's whole
        // point is to check against CURRENT state/time, not the frozen
        // quote-time basis (that would make it identical to EXACT).
      );
      // v0.6.2 (PR-3): the revalidated effect is built from the
      // preview's INCURRED figure (never amount_due) and is used
      // ONLY as this pre-mutation gate's input. It is quote-side
      // data — labeled revalidated_preview — and is NEVER assigned
      // as the committed effect (the pre-migration code did exactly
      // that, which made post-commit reconciliation structurally
      // blind: it compared the quote against the preview that gated
      // the commit, not against what actually landed).
      const revalidated: CommercialEffect = {
        ...(typeof freshPreview.incurred_amount === "number" ? { immediate: immediateParts(freshPreview.incurred_amount) } : {}),
        recurring: {
          ...validated.quoted_effect.recurring,
          currency: validated.quoted_effect.recurring?.currency ?? "usd",
          resultingAmount: freshPreview.next_period_recurring_amount,
        },
        effectiveAt: validated.quoted_effect.effectiveAt,
        determinacy: {
          immediateFinancialEffect: typeof freshPreview.incurred_amount === "number" ? "DETERMINED" : "UNKNOWN",
          recurringFinancialEffect: "DETERMINED",
        },
        provenance: {
          immediate: "commit-time revalidated preview incurred_amount — PRE-MUTATION GATE ONLY; never the committed actual",
          recurring: "commit-time revalidated preview next_period_recurring_amount — gate only",
          committedSource: "revalidated_preview",
        },
      };
      // v0.6.2 (PR #10 correction M2): the REVALIDATED effect must
      // also be determinate BEFORE the envelope gate runs — the
      // v0.6.1 envelope would coerce an absent revalidated figure
      // to 0 and could pass it (a withheld incurred figure reads
      // as a bounded "credit decrease"), letting the commit mutate
      // against an effect it does not know. Refuse here, still
      // before any mutating call.
      assertEffectDeterminateForCommit(revalidated, proposal, "revalidated");
      const violation = checkAcceptanceEnvelope(validated.quoted_effect, revalidated, proposal.acceptanceEnvelope!, proposal);
      if (violation) {
        throw new SCQError(
          "QUOTE_DRIFTED",
          `Recomputed commercial effect fell outside the caller's acceptance envelope: ${violation}. No mutation was performed.`,
          { quoted: validated.quoted_effect, revalidated, envelope: proposal.acceptanceEnvelope }
        );
      }
    }

    let resultingSub: StripeSubscription;
    let mutationInvoice: StripeInvoice | undefined;
    try {
      if (isCancel) {
        resultingSub = this.sim.cancel(validated.subscription_id, !!input.cancel_at_period_end);
      } else if (effectiveMode === "EXACT") {
        // EXACT replays proration_date verbatim from the quote, pinning the
        // time basis so the mutation reproduces the quoted number exactly
        // (capabilitiesFor() only advertises EXACT where this holds).
        const { subscription, invoice } = this.sim.update(
          validated.subscription_id,
          input.items,
          input.proration_behavior,
          input.proration_date
        );
        resultingSub = subscription;
        mutationInvoice = invoice;
      } else {
        // REVALIDATE: commit using CURRENT-time semantics (no proration_date
        // pin) so the resulting invoice matches what was just revalidated
        // and accepted above, not the stale quoted figure.
        const { subscription, invoice } = this.sim.update(validated.subscription_id, input.items, input.proration_behavior);
        resultingSub = subscription;
        mutationInvoice = invoice;
      }
    } catch (e) {
      // v0.6.2 (CORE-5/CORE-8): a connection-class failure from the
      // mutating call means the request was dispatched but its
      // landing is NOT established — the mutation may have fully
      // applied (the sim's lost-response fault models exactly
      // that). Classify INDETERMINATE, record the outcome, record
      // NO receipt, and refuse any blind retry (see the guard at
      // the top of this method). Pre-mutation rejections (invalid
      // proration_date, unknown price/item) keep the existing
      // error mapping: the mutation provably never took effect.
      if (e instanceof StripeSimError && e.type === "api_connection_error") {
        this.store.recordCommitOutcome(quoteId, {
          outcome: "INDETERMINATE",
          at: new Date().toISOString(),
          details: { reason: "the mutating call's response was lost after dispatch; its landing is not established" },
        });
        throw new SCQError(
          "PROVIDER_ERROR",
          `Commit outcome is INDETERMINATE: the mutating request's response was lost, so whether the change ` +
            `landed is not established. No receipt was recorded and no second mutation was issued. Reconcile ` +
            `provider state manually before any retry.`,
          { outcome: "INDETERMINATE", indeterminate: true, reconciled: false }
        );
      }
      throw toSCQError(e, validated.subscription_id);
    }

    // --- v0.6.2 (PR-3): establish the committed effect. ---
    let committedEffect: CommercialEffect;
    let reconciliation: ReconciliationResult;
    let receiptStatus: SubscriptionChangeReceipt["status"];
    let receiptOutcome: MutationOutcome;
    let snap: SubscriptionSnapshot;

    if (isCancel || effectiveMode === "EXACT") {
      // Defined equality (CORE-2): EXACT commits reproduce the
      // quoted effect BY PROTOCOL DEFINITION (proration_date replay
      // pins the basis; CANCEL has no proration component), so the
      // committed figures ARE the quoted figures, honestly labeled
      // defined_equal_exact — not a preview passed off as an actual.
      committedEffect = {
        ...validated.quoted_effect,
        provenance: { ...validated.quoted_effect.provenance, committedSource: "defined_equal_exact" },
      };
      // v0.6.1 post-commit reconciliation, retained for this path:
      // re-check the committed effect against the same envelope used
      // pre-mutation. It cannot undo the mutation; it exists so a
      // violation is never silent.
      reconciliation = reconcileCommittedEffect(validated.quoted_effect, committedEffect, proposal.acceptanceEnvelope, proposal);
      receiptStatus = "COMMITTED";
      receiptOutcome = "COMMITTED_AND_VERIFIED";
      snap = snapshotFrom(resultingSub);
      snap.version = this.sim.fingerprint(validated.subscription_id);
    } else {
      // REVALIDATE: committed actuals are established from
      // post-commit state read back after the mutation — never from
      // the revalidated preview above.
      const established = this.establishCommittedEffect(validated, mutationInvoice!, resultingSub);
      committedEffect = established.effect;
      reconciliation = established.reconciliation;
      receiptStatus = established.status;
      receiptOutcome = established.outcome;
      snap = established.snapshot;
    }

    const receipt: SubscriptionChangeReceipt = {
      quoteId,
      subscriptionRef: validated.subscription_id,
      status: receiptStatus,
      outcome: receiptOutcome,
      quotedEffect: validated.quoted_effect,
      committedEffect,
      guaranteeMode: effectiveMode,
      consistencyGuarantee: "BEST_EFFORT",
      multiChangeConsistency: validated.multi_change_consistency,
      reconciliation,
      resultingSnapshot: snap,
      committedAt: new Date().toISOString(),
    };
    // v0.6.1: records the receipt AND flips status to COMMITTED atomically,
    // so a subsequent commit call is guaranteed to find a receipt whenever
    // it finds status === "COMMITTED" (see checkIdempotentReplay).
    this.store.recordCommitReceipt(quoteId, receipt);
    return receipt;
  }

  /**
   * v0.6.2 (PR-3): establishes a REVALIDATE commit's committed
   * effect from POST-COMMIT state, independently of every preview.
   *
   * The independent read: a fresh `retrieve` of the subscription
   * plus the invoice the mutation generated, read back by id via
   * `retrieveInvoice`. (These are SYNTHETIC simulator reads; the
   * observation built from them is constructed here, inside the
   * adapter, and never crosses a caller boundary — the duty PR-1
   * assigned to adapters. The establishment token is not treated
   * as proof of the observation's authenticity.)
   *
   * PR #10 correction M3 — INVOICE IDENTITY BINDING: the financial
   * actuals come from the invoice THIS mutation generated, bound
   * by the id the mutation returned (`mutationInvoice.id`) and
   * read via `retrieveInvoice(thatId)` — NEVER from the
   * subscription's `latest_invoice`, which a later/concurrent
   * mutation may already have replaced (the pre-fix read did
   * exactly that, and could attribute an unrelated invoice's
   * figures to this commit). The subscription re-read serves the
   * item-set / state verification only. Divergence is handled
   * explicitly: if `latest_invoice` no longer points at the bound
   * invoice, a later mutation intervened — a state MISMATCH
   * against this commit's intent still reports as the determined
   * negative verification below, but if the observed state still
   * matches intent, the commit is COMMITTED_UNVERIFIED: the state
   * was not produced by this commit alone, so it cannot be
   * attributed to it, and the recorded figures are this commit's
   * bound-invoice actuals only.
   *
   * Outcomes:
   *  - read succeeds + state VERIFIED (computed by
   *    establishVerification from the read-back snapshot against
   *    the proposal) + no intervening invoice: COMMITTED /
   *    COMMITTED_AND_VERIFIED with the establishment's computed
   *    reconciliation.
   *  - read succeeds + state MISMATCH: the landed state is
   *    ESTABLISHED and contradicts intent — a determined negative
   *    verification (Decision D3): COMMITTED /
   *    COMMITTED_AND_VERIFIED with a VIOLATED reconciliation
   *    naming the mismatch. Never collapsed into UNVERIFIED.
   *  - read succeeds + state matches intent + an intervening
   *    invoice superseded `latest_invoice`: COMMITTED_UNVERIFIED
   *    (attribution unverified; figures are the bound invoice's).
   *  - read succeeds + state UNVERIFIABLE, or the read itself is
   *    unavailable / its incurred figure withheld: landing is
   *    established (the mutation returned) but verification is
   *    incomplete — COMMITTED_UNVERIFIED with an UNVERIFIED
   *    reconciliation. Where the read failed, the recorded figures
   *    are the mutation response's CANDIDATE figures, labeled
   *    unestablished under UNKNOWN determinacy: they are what a
   *    later independent observation must confirm, verbatim, for
   *    verifyCommitReceipt to transition the record.
   */
  private establishCommittedEffect(
    validated: StoredQuote,
    mutationInvoice: StripeInvoice,
    mutationSub: StripeSubscription
  ): {
    effect: CommercialEffect;
    reconciliation: ReconciliationResult;
    status: SubscriptionChangeReceipt["status"];
    outcome: MutationOutcome;
    snapshot: SubscriptionSnapshot;
  } {
    const subscriptionId = validated.subscription_id;
    const quoted = validated.quoted_effect;
    const recurringFrom = (sub: StripeSubscription): CommercialEffect["recurring"] => ({
      previousAmount: quoted.recurring?.previousAmount,
      resultingAmount: sub.items.reduce((s, i) => s + i.price.unitAmount * i.quantity, 0),
      currency: sub.items[0]?.price.currency ?? quoted.recurring?.currency ?? "usd",
      cadence: quoted.recurring?.cadence ?? (sub.items[0]?.price.interval === "year" ? "ANNUAL" : "MONTHLY"),
    });
    const snapshotOf = (sub: StripeSubscription): SubscriptionSnapshot => {
      const s = snapshotFrom(sub);
      s.version = this.sim.fingerprint(subscriptionId);
      return s;
    };

    // Independent post-commit read of persisted simulator state.
    // M3: the invoice read is BOUND to this mutation's own invoice
    // id — `mutationInvoice.id`, returned by the mutating call —
    // never to `readSub.latest_invoice` (see the doc comment).
    let readSub: StripeSubscription | undefined;
    let readIncurred: number | undefined;
    try {
      readSub = this.sim.retrieve(subscriptionId);
      const readInvoice = this.sim.retrieveInvoice(mutationInvoice.id);
      if (typeof readInvoice.incurred_amount === "number" && Number.isFinite(readInvoice.incurred_amount)) {
        readIncurred = readInvoice.incurred_amount;
      }
    } catch {
      readSub = undefined;
      readIncurred = undefined;
    }

    if (!readSub || readIncurred === undefined) {
      // Verification unavailable: record the mutation response's
      // candidate figures as UNVERIFIED — present (so a later
      // verification has a record to verify against) but labeled
      // unestablished, under UNKNOWN determinacy.
      const candidate: CommercialEffect = {
        ...(typeof mutationInvoice.incurred_amount === "number" ? { immediate: immediateParts(mutationInvoice.incurred_amount) } : {}),
        recurring: recurringFrom(mutationSub),
        ...(quoted.term ? { term: quoted.term } : {}),
        effectiveAt: quoted.effectiveAt,
        determinacy: { immediateFinancialEffect: "UNKNOWN", recurringFinancialEffect: "UNKNOWN" },
        provenance: {
          immediate:
            "candidate figure reported by the mutating call's own response; the independent post-commit read was unavailable, so this is NOT an established actual",
          recurring:
            "candidate figure from the mutating call's returned subscription; not independently re-read — NOT an established actual",
          committedSource: "unestablished",
        },
      };
      return {
        effect: candidate,
        reconciliation: {
          status: "UNVERIFIED",
          reason:
            "the mutation landed (its response was received) but the independent post-commit read was unavailable, " +
            "so the committed figures could not be established from provider actuals; the recorded figures are the " +
            "mutation response's candidates, pending a later verification",
          undeterminedDimensions: ["immediateFinancialEffect", "recurringFinancialEffect"],
        },
        status: "COMMITTED_UNVERIFIED",
        outcome: "COMMITTED_UNVERIFIED",
        snapshot: snapshotOf(mutationSub),
      };
    }

    const committedEffect: CommercialEffect = {
      immediate: immediateParts(readIncurred),
      recurring: recurringFrom(readSub),
      ...(quoted.term ? { term: quoted.term } : {}),
      effectiveAt: quoted.effectiveAt,
      determinacy: { immediateFinancialEffect: "DETERMINED", recurringFinancialEffect: "DETERMINED" },
      provenance: {
        immediate: provImmediateCommitted(mutationInvoice.id),
        recurring: PROV_RECURRING_COMMITTED,
        committedSource: "provider_actual",
      },
    };
    const snap = snapshotOf(readSub);

    // M3 divergence signal: the subscription's latest_invoice no
    // longer points at THIS mutation's invoice — a later mutation
    // intervened between this commit's mutation and its read.
    const interveningInvoiceId = readSub.latest_invoice !== mutationInvoice.id ? readSub.latest_invoice : undefined;

    // The verification itself — state match and reconciliation —
    // is COMPUTED by the PR-1 establishment procedure from this
    // adapter-constructed observation, never asserted here.
    const observation: ProviderObservation = {
      subscriptionRef: subscriptionId,
      committedEffect,
      resultingSnapshot: snap,
      source:
        `stripe-adapter post-commit read: simulator retrieve(subscription) + retrieveInvoice(${mutationInvoice.id}) — ` +
        `the invoice THIS mutation generated, bound by id; latest_invoice is never used for financial actuals ` +
        `(synthetic simulator observation)`,
      observedAt: new Date().toISOString(),
    };
    // M1: verify against the FOLDED intent — the item set the
    // mutation was actually instructed to produce (see
    // foldedProposal). The stored quote itself is untouched; the
    // establishment still computes the verdict and reconciliation.
    const verificationQuote: StoredQuote = { ...validated, proposal: foldedProposal(validated.proposal) };
    const evidence = establishVerification(verificationQuote, observation);

    if (evidence.stateVerification === "MISMATCH") {
      return {
        effect: committedEffect,
        reconciliation: {
          status: "VIOLATED",
          reason:
            `Post-commit state verification MISMATCH — a determined negative verification (Decision D3): ` +
            `${describeStateMismatch(verificationQuote.proposal, snap)} The committed immediate is this mutation's ` +
            `bound-invoice actual and the recurring figure reports the observed state; the mutation has ` +
            `already occurred and cannot be rolled back by this reconciliation.`,
        },
        status: "COMMITTED",
        outcome: "COMMITTED_AND_VERIFIED",
        snapshot: snap,
      };
    }
    if (evidence.stateVerification === "VERIFIED" && interveningInvoiceId !== undefined) {
      // M3: the observed state still matches this commit's intent,
      // but a concurrent mutation superseded latest_invoice in the
      // meantime — the state was not produced by this commit
      // alone, so its attribution to this commit is UNVERIFIED.
      // The recorded figures remain this commit's bound-invoice
      // actuals; nothing is taken from the intervening invoice.
      return {
        effect: committedEffect,
        reconciliation: {
          status: "UNVERIFIED",
          reason:
            `a concurrent mutation intervened between this commit's mutation and its verification read: the ` +
            `subscription's latest_invoice is ${interveningInvoiceId}, not this commit's bound invoice ` +
            `${mutationInvoice.id}, so the observed post-commit state was not produced by this commit alone ` +
            `and cannot be attributed to it. The recorded financial figures are this commit's own ` +
            `bound-invoice actuals, read by id; no figure was taken from the intervening invoice.`,
          undeterminedDimensions: [],
        },
        status: "COMMITTED_UNVERIFIED",
        outcome: "COMMITTED_UNVERIFIED",
        snapshot: snap,
      };
    }
    if (evidence.stateVerification === "VERIFIED") {
      return {
        effect: committedEffect,
        reconciliation: evidence.reconciliation,
        status: "COMMITTED",
        outcome: "COMMITTED_AND_VERIFIED",
        snapshot: snap,
      };
    }
    // UNVERIFIABLE state despite established figures.
    return {
      effect: committedEffect,
      reconciliation: {
        status: "UNVERIFIED",
        reason:
          "the committed figures were established from provider actuals, but the post-commit state verification " +
          "could not be completed from the read-back snapshot, so the commit is not reported as verified",
        undeterminedDimensions: [],
      },
      status: "COMMITTED_UNVERIFIED",
      outcome: "COMMITTED_UNVERIFIED",
      snapshot: snap,
    };
  }
}

/**
 * Human-readable description of where an observed post-commit
 * snapshot contradicts a proposal's intent — used only for the
 * MISMATCH reconciliation reason (the verification VERDICT itself
 * is computed by establishVerification, never here).
 */
function describeStateMismatch(proposal: SubscriptionChangeProposal, snap: SubscriptionSnapshot): string {
  const fragments: string[] = [];
  for (const change of proposal.changes) {
    switch (change.action) {
      case "CHANGE_QUANTITY": {
        const item = snap.items.find((i) => i.id === change.itemId);
        if (!item) fragments.push(`item ${change.itemId} is absent from the post-commit state (intended quantity ${change.quantity})`);
        else if (item.quantity !== change.quantity)
          fragments.push(`item ${change.itemId} quantity is ${item.quantity}, intended ${change.quantity}`);
        break;
      }
      case "CHANGE_PLAN": {
        const item = snap.items.find((i) => i.id === change.itemId);
        if (!item) fragments.push(`item ${change.itemId} is absent from the post-commit state (intended offering ${change.offeringRef})`);
        else if (item.offeringRef !== change.offeringRef)
          fragments.push(`item ${change.itemId} carries offering ${item.offeringRef}, intended ${change.offeringRef}`);
        break;
      }
      case "CHANGE_CADENCE": {
        if (snap.billing.cadence !== change.cadence)
          fragments.push(`billing cadence is ${snap.billing.cadence ?? "unreadable"}, intended ${change.cadence}`);
        break;
      }
      case "CANCEL": {
        const terminal = ["cancelled", "canceled", "terminated"].includes(snap.status.toLowerCase());
        if (!terminal) fragments.push(`subscription status is ${snap.status}, intended a terminal state`);
        break;
      }
    }
  }
  return fragments.length > 0 ? fragments.join("; ") + "." : "the observed state contradicts the proposal intent.";
}

function toSCQError(e: unknown, subscriptionId: string): SCQError {
  if (e instanceof StripeSimError) {
    if (e.type === "resource_missing") return new SCQError("SUBSCRIPTION_NOT_FOUND", `Subscription ${subscriptionId} not found`, e);
    return new SCQError("PROVIDER_ERROR", e.message, e);
  }
  if (e instanceof SCQError) return e;
  return new SCQError("PROVIDER_ERROR", String(e));
}

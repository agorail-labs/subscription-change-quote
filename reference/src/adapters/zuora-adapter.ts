import crypto from "node:crypto";
import {
  SCQError,
  type ActionCapabilities,
  type ChangeAction,
  type ChangeSpec,
  type CommercialEffect,
  type DimensionState,
  type EffectiveIntent,
  type GuaranteeCoverage,
  type MultiChangeConsistency,
  type MutationOutcome,
  type ProviderCapabilities,
  type ReconciliationResult,
  type SubscriptionChangeProposal,
  type SubscriptionChangeQuote,
  type SubscriptionChangeReceipt,
  type SubscriptionProvider,
  type SubscriptionSnapshot,
} from "../core/types.js";
import {
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
  validateCommit,
  validateProposalRuntime,
  validateStoredQuoteRuntime,
} from "../core/scq-engine.js";
import { QuoteStore, type StoredQuote } from "../store/quote-store.js";
import { ZuoraSim, ZuoraSimError, type OrderAction, type ZuoraOrder, type ZuoraSubscription } from "./zuora-sim.js";

const QUOTE_TTL_MS = 5 * 60 * 1000;

type ZuoraPreviewInput = {
  orderActions: OrderAction[];
};

const OFFERING_TO_RATEPLAN: Record<string, string> = {
  "plan:basic:monthly": "ratePlan_seat_basic_monthly",
  "plan:pro:monthly": "ratePlan_seat_pro_monthly",
  "plan:basic:annual": "ratePlan_seat_basic_annual",
};

/**
 * v0.6 capability source of truth for Zuora. `getCapabilities()` and the
 * enforcement functions in createChangeQuote all call this SAME function.
 *
 * GuaranteeCoverage reasoning unchanged from v0.4/v0.5: financial
 * dimensions EXACT everywhere (Zuora order pricing is a deterministic
 * function of the order's own effectiveDate and rate plan charge values,
 * not ambient wall-clock time); termEffect EXACT for CHANGE_QUANTITY,
 * UNKNOWN for CHANGE_PLAN/CHANGE_CADENCE/CANCEL at the coarse level (see
 * quoteLevelCancelTermCoverage below for CANCEL's quote-level refinement);
 * effectiveAt EXACT everywhere.
 *
 * `supportedEffectiveIntents`: Zuora supports ALL THREE — "IMMEDIATE"
 * (effectiveDate = today), "TERM_END" (effectiveDate = the current term's
 * termEndDate, achievable for any action since effectiveDate is just an
 * input), and "DATE" (an arbitrary caller-chosen effectiveDate — Zuora's
 * signature real capability among the four providers modeled in this
 * research). This is the only provider that supports "DATE" for
 * non-CANCEL actions.
 */
function capabilitiesFor(action: ChangeAction): ActionCapabilities {
  const guaranteeCoverage: GuaranteeCoverage =
    action === "CHANGE_QUANTITY"
      ? { immediateFinancialEffect: "EXACT", recurringFinancialEffect: "EXACT", termEffect: "EXACT", effectiveAt: "EXACT" }
      : { immediateFinancialEffect: "EXACT", recurringFinancialEffect: "EXACT", termEffect: "UNKNOWN", effectiveAt: "EXACT" };
  return { guaranteeCoverage, supportedEffectiveIntents: ["IMMEDIATE", "TERM_END", "DATE"] };
}

/**
 * v0.5: whether two change actions can be bundled into ONE Zuora order.
 * Real Zuora orders genuinely accept MULTIPLE orderActions applied
 * together as a single atomic unit (one version bump for the whole order —
 * see zuora-sim.ts createOrder) — this is a real capability Zuora has that
 * Stripe/Paddle do NOT (their multi-change bundling is limited to
 * same-endpoint item array updates; CANCEL cannot join that array). Zuora
 * has no such restriction: a RemoveProduct+AddProduct+CancelSubscription
 * order (any combination of the four SCQ actions) is a single, valid,
 * atomically-applied order. So EVERY pair is ATOMIC on Zuora.
 *
 * v0.6.2 (PR-5) distinction, kept explicit: the ORDER's atomicity is a
 * property of the provider operation (all actions in one order apply
 * together or not at all, as the simulator establishes). It is NOT
 * atomicity of SCQ's quote-precondition check plus mutation — the
 * version check in commitChangeQuote and the createOrder call remain
 * two separate calls with a race window (see commitChangeQuote), so
 * `consistencyGuarantee` stays BEST_EFFORT.
 */
function multiChangePairSupport(_a: ChangeAction, _b: ChangeAction): MultiChangeConsistency {
  return "ATOMIC";
}

function snapshotFrom(sub: ZuoraSubscription): SubscriptionSnapshot {
  const totalRecurring = sub.ratePlans.reduce(
    (sum, p) => sum + p.ratePlanCharges.reduce((s, c) => s + c.unitAmount * c.quantity, 0),
    0
  );
  const firstCharge = sub.ratePlans[0]?.ratePlanCharges[0];
  const cadence = firstCharge?.billingPeriod === "Annual" ? "ANNUAL" : "MONTHLY";
  return {
    id: sub.id,
    version: String(sub.version), // Zuora's REAL native version, not a synthetic hash — see zuora-adapter.ts commitChangeQuote
    status: sub.status === "Active" ? "active" : sub.status === "Cancelled" ? "canceled" : "expired",
    items: sub.ratePlans.flatMap((p) =>
      p.ratePlanCharges.map((c) => ({
        id: c.id,
        offeringRef: Object.entries(OFFERING_TO_RATEPLAN).find(([, rp]) => rp === c.productRatePlanChargeId)?.[0] ?? c.productRatePlanChargeId,
        quantity: c.quantity,
      }))
    ),
    billing: {
      currency: firstCharge?.currency ?? "usd",
      recurringAmount: totalRecurring,
      // v0.6.2 (CORE-7): the total is computed from the rate-plan
      // state this snapshot was built from — a determined figure,
      // labeled as such rather than left to imply its own
      // determinacy.
      recurringAmountState: "DETERMINED",
      cadence,
      nextBillingAt: sub.term.termEndDate,
    },
    term: {
      // UNLIKE Stripe/Paddle, Zuora subscriptions DO carry a real
      // contract-term object — this is populated with real data, not
      // UNKNOWN, when the subscription has a fixed (non-evergreen) term.
      commitmentUntil: sub.term.autoRenew ? "UNKNOWN" : sub.term.termEndDate,
      // A pending CancelSubscription order (cancelledDate set, but status
      // still Active because the effective date hasn't arrived yet) means
      // the subscription will not renew once that date is reached — mirror
      // Stripe's cancel_at_period_end / Paddle's scheduledChange semantics
      // here rather than reporting the term structure's raw autoRenew,
      // which would incorrectly still say true for an evergreen sub with a
      // cancellation already scheduled.
      autoRenew: sub.cancelledDate ? false : sub.term.autoRenew,
    },
  };
}

/**
 * v0.5: authoritative, QUOTE-LEVEL termEffect for a CANCEL change against
 * THIS SPECIFIC subscription's actual term state — more precise than the
 * coarse, action-only capabilitiesFor("CANCEL") report above. An evergreen
 * subscription (no committed term to interact with) has a fully knowable
 * cancellation term consequence (no commitment, full stop); a subscription
 * under an active committed term does not (early-termination fee logic may
 * live outside the order — see zuora-sim.ts). This is exactly the v0.4
 * Test 9e tension that v0.5's quote-level guaranteeCoverage field exists
 * to resolve honestly rather than leave undocumented.
 */
function quoteLevelCancelTermCoverage(sub: ZuoraSubscription): "EXACT" | "UNKNOWN" {
  return sub.term.autoRenew ? "EXACT" : "UNKNOWN";
}

// ---------------------------------------------------------------------------
// v0.6.2 (PR-5) financial-semantics helpers.
//
// §3.11 / CORE-3: `CommercialEffect.immediate` is ONLY the net
// obligation the change itself incurs at its effective time — the
// order preview's invoice-item total for the exact order-action
// sequence. Zuora's order model exposes no amount-due / customer-
// balance / next-invoice figure in this simulator, so there is no
// payment-side figure to confuse it with; credits and charges are
// the signed invoice items themselves, summed once, from ONE
// preview of the full sequence.
//
// The preview's figures have three distinct states per dimension,
// kept distinct end to end:
//   - a finite number: DETERMINED — including an established 0,
//     which is emitted as a present `{ net: 0 }`, never re-encoded
//     as absent (the pre-migration buildCommercialEffect dropped a
//     zero net into `undefined`, and the pre-migration
//     combineEffects zero-filled absent dimensions with `?? 0` —
//     finding F-2; both behaviors are eliminated);
//   - absent (fault-injected omission at the preview surface):
//     UNKNOWN — no figure emitted, never zero-filled;
//   - for a sequence containing a mid-committed-term cancellation,
//     the preview flags `earlyTerminationChargeUnknown`: whether an
//     early-termination charge applies is decided OUTSIDE the order
//     (see zuora-sim.ts), so the sequence's total incurred
//     obligation is NOT established — the immediate dimension is
//     UNKNOWN even though the order's own invoice items total a
//     number. An applicable-but-undetermined amount is never
//     reported as a determined zero and never as NOT_APPLICABLE.
// A pure CANCEL whose termination consequence IS established
// asserts immediate NOT_APPLICABLE under the §3.10 license (a
// cancellation generates no immediate financial event in this
// provider model), cited in provenance.
// ---------------------------------------------------------------------------

const PROV_IMMEDIATE_QUOTE =
  "simulator order preview of the exact order-action sequence that would be dispatched: net of the preview's invoice items — the obligation the sequence itself incurs at its effective date (preview.netImmediate)";
const PROV_IMMEDIATE_WITHHELD =
  "UNESTABLISHED: the simulator order preview omitted its immediate figure entirely, so no incurred obligation could be established — the dimension is UNKNOWN, not zero";
const PROV_IMMEDIATE_FEE_UNKNOWN =
  "UNESTABLISHED: the order preview flags the cancellation's early-termination consequence as not determinable from the order itself (the fee decision lives in configuration outside the order), so the sequence's total incurred obligation is not established — the dimension is UNKNOWN; the order's own invoice-item total is not asserted as the total obligation";
const PROV_RECURRING_QUOTE =
  "simulator order preview of the exact order-action sequence: the post-sequence price level — the rate-plan charges as they stand after the full ordered sequence applies (preview.resultingRecurringAmount); zero when the sequence contains a cancellation, once that cancellation is effective";
const PROV_RECURRING_WITHHELD =
  "UNESTABLISHED: the simulator order preview omitted its resulting recurring figure entirely — the dimension is UNKNOWN, not zero";
const PROV_CANCEL_RECURRING_QUOTE =
  "post-cancellation price level: cancellation leaves no billable recurring obligation once effective, so the resulting recurring amount is a determined zero";
/** M3: the committed immediate's provenance NAMES the bound order. */
function provImmediateCommitted(orderId: string): string {
  return (
    `post-commit actual: netImmediate of persisted order ${orderId} — the order THIS mutation created, bound by its id ` +
    `and read back via retrieveOrder after the mutation (a provider read, not a preview and not the mutation ` +
    `response); no latest-order pointer was used`
  );
}
/**
 * Z3 (PR #14 review correction): the recurring provenance on a
 * BROKEN-attribution receipt. The re-read post-commit recurring
 * level was not produced by this commit alone, so no committed
 * recurring figure is established for this commit; the observed
 * level survives only as context (resulting snapshot /
 * reconciliation reason), never as a figure on the effect.
 */
const PROV_RECURRING_UNATTRIBUTED =
  "UNESTABLISHED for this commit: the version sequence around this commit's order is broken, so the recurring level read back from the post-commit subscription was not produced by this commit alone — it is third-party-influenced observed state, retained only as unattributed context in the resulting snapshot and the reconciliation reason. No committed recurring figure is established for this commit; the bound order artifact establishes this commit's IMMEDIATE actual only (see the immediate provenance)";
const PROV_RECURRING_COMMITTED =
  "post-commit actual: sum over the re-read post-commit subscription's rate-plan charges (unitAmount x quantity)";
const PROV_RECURRING_COMMITTED_CANCEL =
  "post-commit actual: the sequence's cancellation is verified present in the re-read post-commit state (its cancelledDate equals the quoted effective date), so the post-cancellation price level is a determined zero once effective";

/**
 * Builds the immediate {charge, credit, net} shape from an order's
 * invoice items: charge/credit are the sums of the positive /
 * negative items — the incurred obligation's own components — and
 * net is the order's established total. Zero components are
 * OMITTED (an absent charge key means the order incurred no
 * charges), while a zero NET is a present `{ net: 0 }`.
 */
function immediateFromInvoiceItems(
  items: Array<{ amount: number }>,
  net: number
): NonNullable<CommercialEffect["immediate"]> {
  const charge = items.reduce((s, i) => (i.amount > 0 ? s + i.amount : s), 0);
  const credit = items.reduce((s, i) => (i.amount < 0 ? s - i.amount : s), 0);
  return {
    ...(charge > 0 ? { charge } : {}),
    ...(credit > 0 ? { credit } : {}),
    net,
  };
}

/** Net-only fallback for a candidate figure whose itemization is unavailable. */
function immediateParts(net: number): NonNullable<CommercialEffect["immediate"]> {
  return {
    ...(net > 0 ? { charge: net } : {}),
    ...(net < 0 ? { credit: -net } : {}),
    net,
  };
}

/**
 * v0.6.2 (PR-5, correction principle M2 — as applied to Stripe in
 * PR #10 and Paddle in PR #11): adapter-level determinacy gate for
 * commits. The frozen v0.6.1 acceptance envelope coerces absent
 * figures to 0 (§14.6-pinned behavior), so an effect whose incurred
 * figure is UNKNOWN — at quote time, or in the commit-time
 * revalidation — could pass the gate and proceed to MUTATE: the
 * adapter would commit a change whose financial effect it does not
 * know. Fail-closed treatment of UNKNOWN in the shared envelope is
 * BC-1, activated in the core by PR-10: checkAcceptanceEnvelope
 * now refuses unenforceable dimensions itself. THIS adapter still
 * refuses such commits itself, before any mutating call, with
 * QUOTE_NOT_DETERMINISTIC — the local gate is the earlier,
 * adapter-specific refusal; the core gate is the protocol-level
 * backstop behind it.
 *
 * A dimension passes iff it is DETERMINED with a finite value, or
 * NOT_APPLICABLE under the §3.10 license — which covers exactly
 * one case: the immediate dimension of a pure CANCEL proposal,
 * with the matching applicability citation in the effect's
 * provenance (the shape this adapter's own pure-CANCEL quotes
 * carry). Recurring is never licensed NOT_APPLICABLE. Anything
 * else — UNKNOWN (including a legacy payload's absent
 * determinacy), an unjustified NOT_APPLICABLE, or a DETERMINED
 * assertion over a missing / non-finite value — refuses the commit.
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
 * v0.6.2 (PR-5): resolves a proposal's changes into ONE ordered
 * Zuora order-action sequence — the exact sequence that will be
 * previewed once and, at commit, dispatched verbatim in a single
 * createOrder call.
 *
 * Zuora's model is an ORDERED orderActions sequence, not Stripe's
 * item folding: actions apply in sequence, and later actions see
 * the results of earlier ones. Resolution therefore tracks the
 * sequence's evolving shape:
 *   - a plan removed by an earlier change in the sequence is gone:
 *     a later change targeting one of its charges (a second plan
 *     swap on the same item, a quantity change on a replaced plan,
 *     a cadence change whose target plan was replaced) cannot be
 *     executed as ordered and is REFUSED at quote time
 *     (INVALID_PROPOSAL) rather than silently re-targeted;
 *   - a quantity established by an earlier change in the sequence
 *     is the quantity a later plan/cadence swap on that plan
 *     carries forward (the overlay below) — a swap must not revert
 *     an in-sequence quantity change;
 *   - a second CANCEL in one proposal is refused: one order carries
 *     at most one cancellation.
 * `effectiveDate` is the proposal's single resolved effective date,
 * shared by every action in the sequence (effectiveIntent is
 * proposal-level).
 */
function resolveSequence(
  sim: ZuoraSim,
  sub: ZuoraSubscription,
  changes: ChangeSpec[],
  effectiveDate: string
): { orderActions: OrderAction[]; quoteLevelTermOverrides: Array<"EXACT" | "UNKNOWN" | undefined> } {
  const orderActions: OrderAction[] = [];
  const quoteLevelTermOverrides: Array<"EXACT" | "UNKNOWN" | undefined> = [];
  const removedPlanIds = new Set<string>();
  const quantityOverlay = new Map<string, number>(); // charge instance id -> quantity as of this point in the sequence
  let cancelSeen = false;

  const planContaining = (itemId: string) => sub.ratePlans.find((p) => p.ratePlanCharges.some((c) => c.id === itemId));

  for (const change of changes) {
    switch (change.action) {
      case "CHANGE_QUANTITY": {
        const plan = planContaining(change.itemId);
        const charge = plan?.ratePlanCharges.find((c) => c.id === change.itemId);
        if (!plan || !charge) throw new SCQError("INVALID_PROPOSAL", `Item ${change.itemId} not found on subscription`);
        if (removedPlanIds.has(plan.id)) {
          throw new SCQError(
            "INVALID_PROPOSAL",
            `Item ${change.itemId}'s rate plan is removed by an earlier change in this proposal's ordered sequence; ` +
              `a later quantity change against it cannot be executed as ordered and is refused rather than re-targeted.`
          );
        }
        orderActions.push({ type: "UpdateProduct", effectiveDate, ratePlanId: plan.id, productRatePlanChargeId: charge.id, quantity: change.quantity });
        quantityOverlay.set(charge.id, change.quantity);
        quoteLevelTermOverrides.push(undefined);
        break;
      }
      case "CHANGE_PLAN": {
        const plan = planContaining(change.itemId);
        if (!plan) throw new SCQError("INVALID_PROPOSAL", `Item ${change.itemId} not found on subscription`);
        if (removedPlanIds.has(plan.id)) {
          throw new SCQError(
            "INVALID_PROPOSAL",
            `Item ${change.itemId}'s rate plan is already replaced by an earlier change in this proposal's ordered sequence; ` +
              `a second plan change against it cannot be executed as ordered and is refused rather than re-targeted.`
          );
        }
        const targetRatePlan = OFFERING_TO_RATEPLAN[change.offeringRef];
        if (!targetRatePlan) throw new SCQError("UNSUPPORTED_CHANGE", `Unknown offeringRef ${change.offeringRef}`);
        const firstCharge = plan.ratePlanCharges[0];
        orderActions.push(
          { type: "RemoveProduct", effectiveDate, ratePlanId: plan.id },
          {
            type: "AddProduct",
            effectiveDate,
            productRatePlanId: targetRatePlan,
            quantity: quantityOverlay.get(firstCharge.id) ?? firstCharge.quantity,
          }
        );
        removedPlanIds.add(plan.id);
        quoteLevelTermOverrides.push(undefined);
        break;
      }
      case "CHANGE_CADENCE": {
        const plan = sub.ratePlans[0];
        if (!plan) throw new SCQError("INVALID_PROPOSAL", "Subscription has no rate plans");
        if (removedPlanIds.has(plan.id)) {
          throw new SCQError(
            "INVALID_PROPOSAL",
            `The cadence change's target rate plan is replaced by an earlier change in this proposal's ordered sequence; ` +
              `its target cannot be re-resolved unambiguously and the combination is refused rather than re-targeted.`
          );
        }
        const targetKey = change.cadence === "ANNUAL" ? "plan:basic:annual" : "plan:basic:monthly";
        const targetRatePlan = OFFERING_TO_RATEPLAN[targetKey];
        const firstCharge = plan.ratePlanCharges[0];
        orderActions.push(
          { type: "RemoveProduct", effectiveDate, ratePlanId: plan.id },
          {
            type: "AddProduct",
            effectiveDate,
            productRatePlanId: targetRatePlan,
            quantity: quantityOverlay.get(firstCharge.id) ?? firstCharge.quantity,
          }
          // Deliberately NO TermsAndConditions action here — see
          // capabilitiesFor(): this is why CHANGE_CADENCE's termEffect is
          // UNKNOWN, not EXACT, even though financial dimensions are.
        );
        removedPlanIds.add(plan.id);
        quoteLevelTermOverrides.push(undefined);
        break;
      }
      case "CANCEL": {
        if (cancelSeen) {
          throw new SCQError("INVALID_PROPOSAL", "A proposal may contain at most one CANCEL change; a second cancellation in one ordered sequence has no additional effect to execute.");
        }
        cancelSeen = true;
        // cancellationPolicy is Zuora's own real parameter naming for the
        // same distinction (EndOfLastInvoicePeriod only makes sense when
        // the date being passed genuinely IS the term end — this sim
        // treats any non-"today" date the same way Zuora's real API
        // would for a scheduled cancellation).
        const isToday = effectiveDate === new Date(sim.currentTime()).toISOString().slice(0, 10);
        const cancellationPolicy = isToday ? "Today" : "EndOfLastInvoicePeriod";
        orderActions.push({ type: "CancelSubscription", effectiveDate, cancellationPolicy });
        quoteLevelTermOverrides.push(quoteLevelCancelTermCoverage(sub));
        break;
      }
    }
  }
  return { orderActions, quoteLevelTermOverrides };
}

/**
 * Builds the v0.6.2 commercial effect from ONE preview of the full
 * order-action sequence (see the helpers header for the three-state
 * discipline). `pureCancel` is true iff the proposal is exactly one
 * CANCEL change — the only shape whose immediate dimension may be
 * licensed NOT_APPLICABLE.
 */
function buildCommercialEffect(
  preview: import("./zuora-sim.js").OrderPreviewResult,
  effectiveAt: string,
  ctx: { pureCancel: boolean; previousRecurring: number }
): CommercialEffect {
  const effect: CommercialEffect = { effectiveAt };

  // --- recurring ---
  const recurringFigure = (preview as { resultingRecurringAmount?: unknown }).resultingRecurringAmount;
  const recurringDetermined = typeof recurringFigure === "number" && Number.isFinite(recurringFigure);
  effect.recurring = {
    previousAmount: ctx.previousRecurring,
    ...(recurringDetermined ? { resultingAmount: recurringFigure as number } : {}),
    currency: "usd",
    cadence: preview.resultingCadence,
  };

  // --- immediate ---
  const immediateFigure = (preview as { netImmediate?: unknown }).netImmediate;
  const immediateDetermined = typeof immediateFigure === "number" && Number.isFinite(immediateFigure);
  const feeUnknown = preview.earlyTerminationChargeUnknown === true;
  let immediateState: DimensionState;
  let immediateProvenance: string;
  if (feeUnknown) {
    immediateState = "UNKNOWN";
    immediateProvenance = PROV_IMMEDIATE_FEE_UNKNOWN;
  } else if (!immediateDetermined) {
    immediateState = "UNKNOWN";
    immediateProvenance = PROV_IMMEDIATE_WITHHELD;
  } else if (ctx.pureCancel) {
    immediateState = "NOT_APPLICABLE";
    immediateProvenance =
      "no immediate financial event: a pure cancellation in this provider model generates no invoice items and its termination consequence is established (no early-termination question outstanding), so the immediate dimension does not arise — NOT_APPLICABLE under the §3.10 license (CANCEL x immediateFinancialEffect), cited in provenance";
  } else {
    immediateState = "DETERMINED";
    // An established zero is a present { net: 0 } — never absent.
    // The charge/credit parts come from the preview's invoice
    // items (the obligation's own components).
    effect.immediate = immediateFromInvoiceItems(preview.invoiceItems ?? [], immediateFigure as number);
    immediateProvenance = PROV_IMMEDIATE_QUOTE;
  }

  effect.determinacy = {
    immediateFinancialEffect: immediateState,
    recurringFinancialEffect: recurringDetermined ? "DETERMINED" : "UNKNOWN",
  };
  effect.provenance = {
    immediate: immediateProvenance,
    recurring: ctx.pureCancel ? PROV_CANCEL_RECURRING_QUOTE : recurringDetermined ? PROV_RECURRING_QUOTE : PROV_RECURRING_WITHHELD,
    ...(immediateState === "NOT_APPLICABLE"
      ? { applicabilityCitations: { immediateFinancialEffect: { action: "CANCEL" as const, dimension: "immediateFinancialEffect" as const } } }
      : {}),
  };

  // --- term (shape and semantics unchanged from v0.6.1) ---
  effect.term = preview.termConsequenceKnown
    ? {
        createsCommitment: preview.resultingTerm?.createsOrExtendsCommitment ?? false,
        commitmentUntil: preview.resultingTerm?.commitmentUntil ?? "UNKNOWN",
        autoRenew: preview.resultingTerm?.autoRenew ?? true,
      }
    : {
        // Explicit UNKNOWN — the order preview genuinely did not surface
        // enough to answer this, not an oversight. See zuora-sim.ts and
        // capabilitiesFor() above for exactly which actions land here.
        createsCommitment: "UNKNOWN",
        commitmentUntil: "UNKNOWN",
        autoRenew: preview.resultingTerm?.autoRenew ?? true,
      };
  return effect;
}

/**
 * The expected post-order subscription state implied by an ordered
 * action sequence applied to a known pre-state — the adapter-level
 * §6.12 state verification's intent side. Zuora's verification
 * cannot use the PR-1 machinery's generic snapshot check: a plan
 * swap REPLACES the rate plan (the targeted item's instance id does
 * not survive it, so an identity-keyed check reports a correct
 * landing as a mismatch), and the generic check cannot see a
 * scheduled cancellation. The adapter therefore computes the
 * expected FINAL state from the complete intended sequence — every
 * action, in order — and compares it against the independently
 * re-read actual state (the Paddle PR #11 cancellation precedent:
 * adapter-owned establishment where the generic check cannot
 * express the provider's state model). The verdict is computed
 * here from the two states, never asserted by a caller.
 */
function expectedStateAfter(
  preState: ZuoraSubscription,
  orderActions: OrderAction[],
  now: Date
): { charges: Array<{ catalogId: string; quantity: number }>; cancelledDate?: string; status: ZuoraSubscription["status"] } {
  const plans: Array<{ planId: string; charges: Array<{ instanceId: string; catalogId: string; quantity: number }> }> =
    preState.ratePlans.map((p) => ({
      planId: p.id,
      charges: p.ratePlanCharges.map((c) => ({ instanceId: c.id, catalogId: c.productRatePlanChargeId, quantity: c.quantity })),
    }));
  let cancelledDate = preState.cancelledDate;
  let status = preState.status;
  for (const action of orderActions) {
    switch (action.type) {
      case "UpdateProduct": {
        const plan = plans.find((p) => p.planId === action.ratePlanId);
        const charge = plan?.charges.find((c) => c.instanceId === action.productRatePlanChargeId);
        if (charge && action.quantity !== undefined) charge.quantity = action.quantity;
        break;
      }
      case "RemoveProduct": {
        const idx = plans.findIndex((p) => p.planId === action.ratePlanId);
        if (idx >= 0) plans.splice(idx, 1);
        break;
      }
      case "AddProduct": {
        plans.push({
          planId: "(added)",
          charges: [{ instanceId: "(added)", catalogId: action.productRatePlanId!, quantity: action.quantity ?? 1 }],
        });
        break;
      }
      case "TermsAndConditions":
        break; // term fields are reported via the effect's term dimension, not the state comparison
      case "CancelSubscription": {
        cancelledDate = action.effectiveDate;
        if (new Date(action.effectiveDate).getTime() <= now.getTime()) status = "Cancelled";
        break;
      }
    }
  }
  const charges = plans
    .flatMap((p) => p.charges.map((c) => ({ catalogId: c.catalogId, quantity: c.quantity })))
    .sort((a, b) => (a.catalogId === b.catalogId ? a.quantity - b.quantity : a.catalogId < b.catalogId ? -1 : 1));
  return { charges, cancelledDate, status };
}

function observedStateOf(sub: ZuoraSubscription): ReturnType<typeof expectedStateAfter> {
  const charges = sub.ratePlans
    .flatMap((p) => p.ratePlanCharges.map((c) => ({ catalogId: c.productRatePlanChargeId, quantity: c.quantity })))
    .sort((a, b) => (a.catalogId === b.catalogId ? a.quantity - b.quantity : a.catalogId < b.catalogId ? -1 : 1));
  return { charges, cancelledDate: sub.cancelledDate, status: sub.status };
}

/** Compares expected vs observed post-order state; returns the list of contradictions (empty = verified). */
function stateContradictions(
  expected: ReturnType<typeof expectedStateAfter>,
  observed: ReturnType<typeof expectedStateAfter>,
  orderActions: OrderAction[]
): string[] {
  const problems: string[] = [];
  if (JSON.stringify(expected.charges) !== JSON.stringify(observed.charges)) {
    problems.push(
      `rate-plan charge state differs from the intended sequence's result: expected ${JSON.stringify(expected.charges)}, observed ${JSON.stringify(observed.charges)}`
    );
  }
  if (expected.cancelledDate !== observed.cancelledDate) {
    const cancelAction = orderActions.find((a) => a.type === "CancelSubscription");
    problems.push(
      cancelAction && observed.status === "Cancelled"
        ? `the subscription is in the terminal Cancelled state with cancelledDate ${observed.cancelledDate ?? "(none)"}, not the quoted ` +
            `cancellation date ${cancelAction.effectiveDate} — it was ended on a different date than the one quoted (a premature or ` +
            `mis-dated termination is a different outcome than the scheduled cancellation quoted)`
        : `cancelledDate is ${observed.cancelledDate ?? "(none)"}, expected ${expected.cancelledDate ?? "(none)"} from the intended sequence`
    );
  }
  if (expected.status !== observed.status) {
    problems.push(
      expected.status !== "Cancelled" && observed.status === "Cancelled"
        ? `the subscription is in the terminal Cancelled state although the intended sequence leaves it ${expected.status} ` +
            `(a future-dated cancellation must read as scheduled, not terminal)`
        : `subscription status is ${observed.status}, expected ${expected.status} from the intended sequence`
    );
  }
  return problems;
}

/** Key-order-insensitive JSON for comparing a persisted order's actions against the sequence a commit dispatched. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function recurringTotalOf(sub: ZuoraSubscription): number {
  return sub.ratePlans.reduce((sum, p) => sum + p.ratePlanCharges.reduce((s, c) => s + c.unitAmount * c.quantity, 0), 0);
}

export class ZuoraAdapter implements SubscriptionProvider {
  constructor(private sim: ZuoraSim, private store: QuoteStore) {}

  getCapabilities(): ProviderCapabilities {
    return {
      quoteCapabilities: {
        CHANGE_QUANTITY: capabilitiesFor("CHANGE_QUANTITY"),
        CHANGE_PLAN: capabilitiesFor("CHANGE_PLAN"),
        CHANGE_CADENCE: capabilitiesFor("CHANGE_CADENCE"),
        CANCEL: capabilitiesFor("CANCEL"),
      },
      // Zuora's `version` field IS a real, native, monotonic
      // optimistic-concurrency counter — genuinely stronger than
      // Stripe/Paddle's complete absence of one (see research-findings.md
      // "Does Zuora provide stronger native concurrency semantics"). BUT
      // this only strengthens DETECTION of a concurrent mutation, not
      // ATOMICITY of "check version, then mutate" as one server-enforced
      // operation: `POST /v1/orders` does not accept an
      // "only apply if current version == N" precondition parameter as
      // far as we are aware (uncertainty noted — not verified against
      // live docs). SCQ's own read-check-write is still two separate
      // calls with a race window, structurally identical to Stripe/Paddle
      // — see zuora-adapter.ts commitChangeQuote and the v0.4/v0.5 TOCTOU
      // re-tests. Never report ATOMIC.
      consistencyGuarantee: "BEST_EFFORT",
    };
  }

  async getSubscription(subscriptionId: string): Promise<SubscriptionSnapshot> {
    let sub: ZuoraSubscription;
    try {
      sub = this.sim.get(subscriptionId);
    } catch (e) {
      throw toSCQError(e, subscriptionId);
    }
    return snapshotFrom(sub);
  }

  async createChangeQuote(
    subscriptionId: string,
    proposal: SubscriptionChangeProposal
  ): Promise<SubscriptionChangeQuote> {
    // PR-15 (Finding 2): the shared runtime validator runs FIRST —
    // before any provider read, preview, or mutation — so malformed
    // caller input refuses identically on every adapter. This
    // adapter's provider-specific checks below run after it.
    validateProposalRuntime(proposal);
    let sub: ZuoraSubscription;
    try {
      sub = this.sim.get(subscriptionId);
    } catch (e) {
      throw toSCQError(e, subscriptionId);
    }
    if (proposal.changes.length === 0) {
      throw new SCQError("INVALID_PROPOSAL", "proposal.changes must contain at least one change");
    }

    // Two distinct clocks, deliberately not conflated — see v0.4 comment
    // history: `now` (sim time) drives Zuora order effectiveDate math;
    // `wallNow` (real wall-clock) drives SCQ's OWN quote-TTL bookkeeping.
    const now = this.sim.currentTime();
    const wallNow = new Date();

    const perChangeCapabilities = proposal.changes.map((c) => capabilitiesFor(c.action));
    for (const caps of perChangeCapabilities) {
      enforceEffectiveIntent(proposal.effectiveIntent, caps.supportedEffectiveIntents);
    }

    // v0.6: resolve the proposal-level effectiveIntent into a concrete
    // Zuora effectiveDate ONCE for the whole batch (effectiveIntent is
    // proposal-level, not per-change). "TERM_END" resolves against
    // sub.term.termEndDate — the CURRENT subscription's own term boundary,
    // which is why this resolution needs `sub`, not just the intent.
    const effectiveDate =
      proposal.effectiveIntent.type === "DATE"
        ? new Date(proposal.effectiveIntent.at).toISOString().slice(0, 10)
        : proposal.effectiveIntent.type === "TERM_END"
          ? sub.term.termEndDate
          : now.toISOString().slice(0, 10);

    const versionAtQuote = String(sub.version);
    const quoteId = `scq_zuora_${crypto.randomBytes(8).toString("hex")}`;

    const multiChangeConsistency = computeMultiChangeConsistency(proposal.changes, multiChangePairSupport);
    enforceMultiChangeConsistency(proposal.changes, multiChangeConsistency);
    // v0.6 normative rule: Zuora orders bundle ANY combination of order
    // actions as ONE atomic unit (see multiChangePairSupport — always
    // ATOMIC). There is no partial-execution risk to guard against here:
    // this adapter never submits a bundle where the provider might apply
    // only some of the requested order actions.
    enforceNoPartialExecutionRisk(proposal.changes, false);

    // v0.6.2 (PR-5): resolve the WHOLE proposal into one ordered
    // order-action sequence, then take ONE preview of that exact
    // sequence and derive the combined effect from it alone. The
    // pre-migration construction previewed each change separately
    // against the SAME original subscription and combined the
    // per-change effects — double-counting overlapping changes and
    // dropping all but the last change's recurring contribution
    // (probes A/B in the PR-5 work record). The sequence stored on
    // the quote is exactly the sequence the commit dispatches:
    // quoted sequence == mutation input, by construction.
    const { orderActions, quoteLevelTermOverrides } = resolveSequence(this.sim, sub, proposal.changes, effectiveDate);
    let preview: import("./zuora-sim.js").OrderPreviewResult;
    try {
      preview = this.sim.previewOrder(subscriptionId, orderActions);
    } catch (e) {
      throw toSCQError(e, subscriptionId);
    }
    const pureCancel = proposal.changes.length === 1 && proposal.changes[0].action === "CANCEL";
    const commercialEffect = buildCommercialEffect(preview, effectiveDate, {
      pureCancel,
      previousRecurring: recurringTotalOf(sub),
    });

    // Per-change coverage, but a CANCEL's termEffect is resolved at the
    // QUOTE level (per this specific subscription's term state), not just
    // the coarse action-level default — see quoteLevelCancelTermCoverage.
    const perChangeCoverage = proposal.changes.map((change, i) => {
      const base = perChangeCapabilities[i].guaranteeCoverage;
      const override = quoteLevelTermOverrides[i];
      return override !== undefined ? { ...base, termEffect: override } : base;
    });
    const guaranteeCoverage = computeCombinedCoverage(perChangeCoverage);

    const effectiveMode = resolveGuaranteeMode(proposal);
    enforceGuaranteeRequest(proposal.changes, effectiveMode, guaranteeCoverage, proposal.acceptanceEnvelope);

    const expiresAt = new Date(wallNow.getTime() + QUOTE_TTL_MS).toISOString();
    const stored: StoredQuote<ZuoraPreviewInput> = {
      quote_id: quoteId,
      provider: "zuora",
      subscription_id: subscriptionId,
      subscription_version_at_quote: versionAtQuote,
      proposal,
      effective_guarantee_mode: effectiveMode,
      guarantee_coverage: guaranteeCoverage,
      multi_change_consistency: multiChangeConsistency,
      provider_preview_input: { orderActions },
      quoted_effect: commercialEffect,
      created_at: wallNow.toISOString(),
      expires_at: expiresAt,
      status: "ACTIVE",
    };
    this.store.put(stored as StoredQuote);

    return {
      id: quoteId,
      subscriptionRef: subscriptionId,
      preconditions: { subscriptionVersion: versionAtQuote },
      proposal,
      guaranteeMode: effectiveMode,
      guaranteeCoverage,
      multiChangeConsistency,
      commercialEffect,
      validUntil: expiresAt,
      providerMetadata: { orderActions },
    };
  }

  async commitChangeQuote(quoteId: string): Promise<SubscriptionChangeReceipt> {
    // v0.6.1: idempotent replay checked before any read of live provider
    // state or mutating call — see checkIdempotentReplay's doc comment in
    // scq-engine.ts. (PR-1/PR #8: replay returns the ORIGINAL recorded
    // receipt, §6.10 — including after a later verification transition.)
    const cached = checkIdempotentReplay(this.store, quoteId);
    if (cached) return cached;

    const quote = this.store.get(quoteId);
    if (!quote) {
      throw new SCQError("QUOTE_STALE", `No quote found for id ${quoteId}`);
    }

    // v0.6.2 (CORE-8): a prior attempt on this quote whose outcome was
    // INDETERMINATE (the mutation was dispatched but its landing is not
    // established) must never be blindly retried: the order may already
    // have landed, and a second order would double-apply it. Refuse
    // here, before any state read or mutation.
    if (quote.commit_outcome?.outcome === "INDETERMINATE") {
      throw new SCQError(
        "PROVIDER_ERROR",
        `Commit outcome for quote ${quoteId} is INDETERMINATE: a previous commit attempt's order was ` +
          `dispatched but its landing was not established. No second order was issued. Reconcile the ` +
          `provider state manually before any retry.`,
        { outcome: "INDETERMINATE", indeterminate: true, reconciled: false }
      );
    }

    // --- Version check: Zuora's REAL, native, monotonic version integer,
    // compared against the version captured at quote time (via the
    // shared validateCommit). This is a stronger DETECTION primitive
    // than Stripe/Paddle's synthetic content hash. HOWEVER the read
    // here is still a SEPARATE call from the mutating createOrder()
    // call below — see the extensive v0.4 comment history and the
    // v0.5 TOCTOU re-test. Zuora's version field makes staleness
    // DETECTION more reliable; it does not make the commit ATOMIC,
    // and this adapter never claims otherwise (BEST_EFFORT).
    let currentSub: ZuoraSubscription;
    try {
      currentSub = this.sim.get(quote.subscription_id);
    } catch (e) {
      throw toSCQError(e, quote.subscription_id);
    }
    const validated = validateCommit(this.store, quoteId, String(currentSub.version));

    // PR-15 (Finding 2): the STORED record is validated before it
    // feeds any gate below — the same shared rules as quote
    // creation, applied to the persisted proposal and the stored
    // effective guarantee mode. Placement: after §6.10 replay, the
    // recorded-INDETERMINATE guard, and validateCommit (their
    // precedence is preserved), before any re-preview or mutation.
    validateStoredQuoteRuntime(validated);

    const input = validated.provider_preview_input as ZuoraPreviewInput;
    const proposal = validated.proposal;
    const effectiveMode = validated.effective_guarantee_mode;
    const isPureCancel = proposal.changes.length === 1 && proposal.changes[0].action === "CANCEL";

    // v0.6.2 (PR-5, M2): the QUOTED effect must be determinate before
    // this commit proceeds in ANY mode — the frozen v0.6.1 envelope
    // coerces absent figures to 0, so an UNKNOWN quoted figure could
    // otherwise pass a loose envelope and mutate. This refusal
    // happens before the re-preview and before any mutating call; a
    // licensed pure-CANCEL NOT_APPLICABLE passes.
    assertEffectDeterminateForCommit(validated.quoted_effect, proposal, "quoted");

    if (effectiveMode === "REVALIDATE" && !isPureCancel) {
      // Order per spec: re-preview -> determinacy gate -> evaluate
      // acceptance envelope -> mutate -> establish from post-commit
      // reads -> receipt. Zuora's order preview is non-mutating, so
      // this ordering is achievable here too.
      //
      // The revalidated effect is built from a FRESH preview of the
      // exact stored sequence and is used ONLY as this pre-mutation
      // gate's input. It is quote-side data — labeled
      // revalidated_preview in its provenance — and is NEVER
      // assigned as the committed effect. (The pre-migration code
      // did exactly that assignment — finding F-1 — so post-commit
      // reconciliation compared the quote against the preview that
      // gated the commit and could never detect a wrong landing.)
      let freshPreview: import("./zuora-sim.js").OrderPreviewResult;
      try {
        freshPreview = this.sim.previewOrder(validated.subscription_id, input.orderActions);
      } catch (e) {
        throw toSCQError(e, validated.subscription_id);
      }
      const revalidated = buildCommercialEffect(freshPreview, validated.quoted_effect.effectiveAt ?? effectiveDate0(validated), {
        pureCancel: false,
        previousRecurring: validated.quoted_effect.recurring?.previousAmount ?? recurringTotalOf(currentSub),
      });
      revalidated.provenance = {
        immediate:
          revalidated.determinacy?.immediateFinancialEffect === "UNKNOWN"
            ? "commit-time revalidated preview could not establish its immediate figure — PRE-MUTATION GATE ONLY; never the committed actual"
            : "commit-time revalidated preview of the stored order-action sequence (its invoice-item net) — PRE-MUTATION GATE ONLY; never the committed actual",
        recurring: "commit-time revalidated preview resulting recurring amount — gate only",
        committedSource: "revalidated_preview",
      };
      // The REVALIDATED effect must also be determinate BEFORE the
      // envelope gate runs — the v0.6.1 envelope would coerce an
      // absent revalidated figure to 0 and could pass it.
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
    // EXACT mode: no re-preview — the stored sequence (including its
    // pinned effectiveDate) is replayed verbatim, and Zuora order
    // pricing is a deterministic function of (rate plan charges,
    // effectiveDate), not ambient wall-clock "now". The committed
    // effect is STILL established from post-commit evidence below —
    // EXACT defines what the figures must equal, it does not exempt
    // the commit from verification.

    let mutation: { subscription: ZuoraSubscription; result: import("./zuora-sim.js").OrderPreviewResult; orderId: string };
    try {
      // A single createOrder() call carries ALL orderActions from
      // every change in the batch — this is what makes multi-change
      // Zuora proposals genuinely ATOMIC at the provider-operation
      // level: one order, one version bump, applied together or not
      // at all (see multiChangePairSupport). The dispatch is the
      // stored sequence verbatim — the same sequence the quote
      // previewed.
      mutation = this.sim.createOrder(validated.subscription_id, input.orderActions);
    } catch (e) {
      // v0.6.2 (CORE-5/CORE-8): a connection-class failure from the
      // mutating call means the request was dispatched but its
      // landing is NOT established — the order may have fully
      // applied (the sim's lost-response fault models exactly
      // that). Classify INDETERMINATE, record the outcome, record
      // NO receipt, and refuse any blind retry (see the guard at
      // the top of this method). A rejection the sim raises BEFORE
      // applying anything is a CONFIRMED_NON_EXECUTION: the order
      // provably never took effect, and the distinction is recorded
      // rather than collapsed into the indeterminate class.
      if (e instanceof ZuoraSimError && e.code === "ApiConnectionError") {
        this.store.recordCommitOutcome(quoteId, {
          outcome: "INDETERMINATE",
          at: new Date().toISOString(),
          details: { reason: "the mutating call's response was lost after dispatch; its landing is not established" },
        });
        throw new SCQError(
          "PROVIDER_ERROR",
          `Commit outcome is INDETERMINATE: the order request's response was lost, so whether the change ` +
            `landed is not established. No receipt was recorded and no second order was issued. Reconcile ` +
            `provider state manually before any retry.`,
          { outcome: "INDETERMINATE", indeterminate: true, reconciled: false }
        );
      }
      if (e instanceof ZuoraSimError) {
        this.store.recordCommitOutcome(quoteId, {
          outcome: "CONFIRMED_NON_EXECUTION",
          at: new Date().toISOString(),
          details: { reason: `the order request was rejected before effect (${e.code}: ${e.message})` },
        });
        const mapped = toSCQError(e, validated.subscription_id);
        throw new SCQError(mapped.code, mapped.message, { outcome: "CONFIRMED_NON_EXECUTION", cause: e });
      }
      throw toSCQError(e, validated.subscription_id);
    }

    // --- v0.6.2 (PR-5): establish the committed effect from
    // post-commit evidence, independently of every preview. ---
    const established = isPureCancel
      ? this.establishCancelCommit(validated, mutation)
      : this.establishCommittedEffect(validated, mutation, currentSub);

    const receipt: SubscriptionChangeReceipt = {
      quoteId,
      subscriptionRef: validated.subscription_id,
      status: established.status,
      outcome: established.outcome,
      quotedEffect: validated.quoted_effect,
      committedEffect: established.effect,
      guaranteeMode: effectiveMode,
      consistencyGuarantee: "BEST_EFFORT",
      multiChangeConsistency: validated.multi_change_consistency,
      reconciliation: established.reconciliation,
      resultingSnapshot: established.snapshot,
      committedAt: new Date().toISOString(),
    };
    this.store.recordCommitReceipt(quoteId, receipt);
    return receipt;
  }

  /**
   * v0.6.2 (PR-5): establishes a non-pure-CANCEL commit's committed
   * effect from POST-COMMIT state, independently of every preview.
   *
   * The independent reads: a fresh `get` of the subscription plus
   * the ORDER this mutation created, read back by its id via
   * `retrieveOrder`. (These are SYNTHETIC simulator reads; the
   * observation is constructed here, inside the adapter, and never
   * crosses a caller boundary.)
   *
   * M3 — ORDER IDENTITY BINDING: the financial actuals come from
   * the persisted order THIS mutation created, bound by the id the
   * mutation returned — NEVER from an unqualified latest-order
   * pointer (a later/concurrent order may already have replaced
   * it), and never from the pre-mutation revalidated preview
   * (finding F-1) or the mutation's pre-execution computation.
   * Attribution is checked against the order record itself: the
   * record states the subscription version it produced
   * (`subscriptionVersionAfter`); the version sequence must be the
   * unbroken +1 from the version this commit validated against to
   * the re-read version — any other order landing before (the
   * check→mutate window) or after (before the verification read)
   * breaks it, and the observed state is then not attributable to
   * this commit alone.
   *
   * State verification is the adapter-level sequence check (see
   * expectedStateAfter): the re-read state is compared against the
   * result the COMPLETE intended sequence implies, including a
   * sequence-contained cancellation's scheduled-vs-terminal kind
   * against the QUOTED effective date (a premature terminal state
   * is a MISMATCH, never a verified scheduled cancellation — the
   * PR #11 P3 lesson).
   *
   * Outcomes (PR #14 review correction Z1 — classification order
   * is attribution FIRST, contradiction second):
   *  - reads succeed + version chain broken (an order intervened
   *    before or after this commit's order): COMMITTED_UNVERIFIED
   *    with an UNVERIFIED reconciliation — whether the observed
   *    state matches intent or contradicts it. A contradiction
   *    under a broken chain may have been caused by the intervening
   *    actor, so it is recorded as unattributed context, never as
   *    this commit's verified failure. The only figure recorded is
   *    this commit's bound-order IMMEDIATE actual; the recurring
   *    dimension is UNKNOWN with NO figure (PR #14 review
   *    correction Z3): the re-read recurring level is
   *    third-party-influenced observed state, retained only as
   *    unattributed context in the resulting snapshot and the
   *    reconciliation reason — never as this commit's determined
   *    actual.
   *  - reads succeed + chain unbroken + state contradicts intent:
   *    COMMITTED / COMMITTED_AND_VERIFIED with a VIOLATED
   *    reconciliation naming the contradictions (Decision D3 — a
   *    determined negative verification, never UNVERIFIED, never a
   *    false success). The unbroken chain is what makes the
   *    contradiction provably this commit's own wrong landing.
   *  - reads succeed + chain unbroken + state matches:
   *    COMMITTED / COMMITTED_AND_VERIFIED, reconciliation computed
   *    by the core from quoted vs established actuals.
   *  - a read is unavailable, the bound order is unavailable, or
   *    the persisted order carries no financial actuals:
   *    COMMITTED_UNVERIFIED with an UNVERIFIED reconciliation. The
   *    recorded figures are the mutation response's CANDIDATE
   *    figures, labeled unestablished under UNKNOWN determinacy —
   *    and the candidate record is built ENTIRELY from data already
   *    in hand (the mutation response and the stored quote), so
   *    recording it never depends on a further successful provider
   *    read after the mutation has landed (PR #11 correction P1).
   */
  private establishCommittedEffect(
    validated: StoredQuote,
    mutation: { subscription: ZuoraSubscription; result: import("./zuora-sim.js").OrderPreviewResult; orderId: string },
    preState: ZuoraSubscription
  ): {
    effect: CommercialEffect;
    reconciliation: ReconciliationResult;
    status: SubscriptionChangeReceipt["status"];
    outcome: MutationOutcome;
    snapshot: SubscriptionSnapshot;
  } {
    const subscriptionId = validated.subscription_id;
    const quoted = validated.quoted_effect;
    const proposal = validated.proposal;
    const input = validated.provider_preview_input as ZuoraPreviewInput;
    const cancelAction = input.orderActions.find((a) => a.type === "CancelSubscription");

    // Independent post-commit reads, bound to THIS mutation's order.
    let readSub: ZuoraSubscription | undefined;
    let readOrder: ZuoraOrder | undefined;
    try {
      readSub = this.sim.get(subscriptionId);
    } catch {
      readSub = undefined;
    }
    if (readSub) {
      try {
        const order = this.sim.retrieveOrder(mutation.orderId);
        if (order.subscriptionId === subscriptionId) readOrder = order;
      } catch {
        readOrder = undefined;
      }
    }
    const orderFiguresPresent =
      readOrder !== undefined &&
      typeof readOrder.netImmediate === "number" &&
      Number.isFinite(readOrder.netImmediate) &&
      Array.isArray(readOrder.invoiceItems);

    if (!readSub || !readOrder || !orderFiguresPresent) {
      // Verification unavailable: record the mutation response's
      // candidate figures as UNVERIFIED — present (so a later
      // verification has a record to verify against) but labeled
      // unestablished, under UNKNOWN determinacy. Built entirely
      // from data already in hand — NO further provider read.
      const resultNet = (mutation.result as { netImmediate?: unknown }).netImmediate;
      const candidate: CommercialEffect = {
        ...(typeof resultNet === "number" && Number.isFinite(resultNet)
          ? {
              immediate: Array.isArray(mutation.result.invoiceItems)
                ? immediateFromInvoiceItems(mutation.result.invoiceItems, resultNet)
                : immediateParts(resultNet),
            }
          : {}),
        recurring: {
          previousAmount: quoted.recurring?.previousAmount,
          resultingAmount: recurringTotalOf(mutation.subscription),
          currency: quoted.recurring?.currency ?? "usd",
          ...(quoted.recurring?.cadence ? { cadence: quoted.recurring.cadence } : {}),
        },
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
            "the order landed (its response was received, carrying order " +
            `${mutation.orderId}) but the independent post-commit verification could not be completed — ` +
            (!readSub
              ? "the post-commit subscription re-read was unavailable"
              : !readOrder
                ? `the persisted order ${mutation.orderId} could not be read back`
                : `the persisted order ${mutation.orderId} carries no financial actuals to establish the committed figures from`) +
            "; the recorded figures are the mutation response's candidates, pending a later verification",
          undeterminedDimensions: ["immediateFinancialEffect", "recurringFinancialEffect"],
        },
        status: "COMMITTED_UNVERIFIED",
        outcome: "COMMITTED_UNVERIFIED",
        snapshot: snapshotFrom(mutation.subscription),
      };
    }

    const committedImmediateNet = readOrder.netImmediate;
    const observedRecurring = recurringTotalOf(readSub);
    const snap = snapshotFrom(readSub);

    // State-vs-intent verification over the COMPLETE sequence.
    const expected = expectedStateAfter(preState, input.orderActions, this.sim.currentTime());
    const observed = observedStateOf(readSub);
    const problems = stateContradictions(expected, observed, input.orderActions);

    // Attribution: the bound order states the version it produced.
    // The re-read version must be exactly that (nothing landed
    // AFTER this order), AND that version must be exactly one past
    // the version this commit validated against (nothing landed
    // BETWEEN the version check and this order either — the 9i
    // TOCTOU window: an intervening order there is absorbed into
    // this order's versionAfter, so the second comparison is the
    // one that detects it).
    const attributable =
      readSub.version === readOrder.subscriptionVersionAfter &&
      readOrder.subscriptionVersionAfter === Number(validated.subscription_version_at_quote) + 1;
    const latestId = this.sim.latestOrderId(subscriptionId);

    // This fully-determined effect is returned ONLY by the two
    // attributable branches below (verified OK and D3 VIOLATED):
    // its recurring figure is the re-read state's, which is this
    // commit's own result only behind the unbroken chain. The
    // broken-chain branch builds its own effect (correction Z3).
    const committedEffect: CommercialEffect = {
      immediate: immediateFromInvoiceItems(readOrder.invoiceItems, committedImmediateNet),
      recurring: {
        previousAmount: quoted.recurring?.previousAmount,
        // A verified sequence-contained cancellation ends the
        // subscription: the post-cancellation price level is 0 once
        // effective (established by the verified cancelledDate in
        // the state check above), not the still-active charge sum.
        // On a state MISMATCH the figure reports the observed state
        // as it actually stands.
        resultingAmount: cancelAction && problems.length === 0 ? 0 : observedRecurring,
        currency: quoted.recurring?.currency ?? "usd",
        ...(quoted.recurring?.cadence ? { cadence: quoted.recurring.cadence } : {}),
      },
      ...(quoted.term ? { term: quoted.term } : {}),
      effectiveAt: quoted.effectiveAt,
      determinacy: { immediateFinancialEffect: "DETERMINED", recurringFinancialEffect: "DETERMINED" },
      provenance: {
        immediate: provImmediateCommitted(readOrder.id),
        recurring: cancelAction && problems.length === 0 ? PROV_RECURRING_COMMITTED_CANCEL : PROV_RECURRING_COMMITTED,
        committedSource: "provider_actual",
      },
    };

    // PR #14 review correction Z1: ATTRIBUTION IS ESTABLISHED
    // BEFORE ANY CONTRADICTION IS CLASSIFIED. A state contradiction
    // may be declared a verified failure of THIS commit (D3's
    // VIOLATED) only when the observed state is attributable to this
    // commit — the unbroken version chain above. When the chain is
    // broken, another actor's change may have produced the observed
    // mismatch, so the outcome is COMMITTED_UNVERIFIED / UNVERIFIED
    // whether or not the observed state happens to match intent:
    // any observed state contradiction is recorded as UNATTRIBUTED
    // CONTEXT, its cause not assigned to this commit.
    //
    // PR #14 review correction Z3: FINANCIAL ATTRIBUTION FOLLOWS
    // THE SAME RULE. The committedEffect built above takes its
    // recurring figure from the re-read subscription
    // (observedRecurring) — legitimate ONLY behind the unbroken
    // chain, where that state is this commit's own result. Under a
    // broken chain the re-read state is third-party-influenced, so
    // carrying its recurring level as this commit's DETERMINED
    // actual would attribute another actor's figure to this commit
    // — the same misattribution Z1 removed from the verdict, one
    // layer down (at 9efc4a5 test 24.23's receipt recorded the
    // intervening actor's 130000 as this commit's determined
    // recurring actual). The broken-chain branch therefore returns
    // a DIFFERENT effect: the immediate stays — it is the bound
    // order's own persisted actual, read by id, exactly the scope
    // that order establishes — while the recurring dimension is
    // UNKNOWN with NO resultingAmount: no committed recurring
    // figure is established for this commit. The observed state,
    // including its recurring level, remains visible only as
    // unattributed context in the resulting snapshot and in the
    // reconciliation reason. The effect-level committedSource is
    // "unestablished" — the committed effect AS A WHOLE is not an
    // established set of actuals; the immediate dimension's own
    // determinacy and provenance carry its narrower claim.
    if (!attributable) {
      const unattributedEffect: CommercialEffect = {
        immediate: immediateFromInvoiceItems(readOrder.invoiceItems, committedImmediateNet),
        recurring: {
          previousAmount: quoted.recurring?.previousAmount,
          // NO resultingAmount (Z3): the observed post-commit
          // recurring level was not produced by this commit alone
          // and is not recorded as this commit's figure.
          currency: quoted.recurring?.currency ?? "usd",
          ...(quoted.recurring?.cadence ? { cadence: quoted.recurring.cadence } : {}),
        },
        ...(quoted.term ? { term: quoted.term } : {}),
        effectiveAt: quoted.effectiveAt,
        determinacy: { immediateFinancialEffect: "DETERMINED", recurringFinancialEffect: "UNKNOWN" },
        provenance: {
          immediate: provImmediateCommitted(readOrder.id),
          recurring: PROV_RECURRING_UNATTRIBUTED,
          committedSource: "unestablished",
        },
      };
      return {
        effect: unattributedEffect,
        reconciliation: {
          status: "UNVERIFIED",
          reason:
            `another order intervened around this commit's order: this commit validated against subscription ` +
            `version ${validated.subscription_version_at_quote}, order ${readOrder.id} recorded version ` +
            `${readOrder.subscriptionVersionAfter} after it applied, and the re-read subscription is at ` +
            `version ${readSub.version}` +
            (latestId && latestId !== readOrder.id ? ` with latest order ${latestId}` : "") +
            ` — the version sequence is not the unbroken +1 this commit alone would produce, so the ` +
            `observed post-commit state was not produced by this commit alone and cannot be attributed to ` +
            `it. The recorded immediate figure is this commit's own bound-order actual, read by id; NO ` +
            `committed recurring figure is recorded for this commit (the recurring dimension is UNKNOWN): ` +
            `the recurring level in the observed state was not produced by this commit alone, so it is ` +
            `retained only as unattributed context in the resulting snapshot — not as this commit's ` +
            `determined actual. No figure was taken from any intervening order.` +
            (problems.length > 0
              ? ` The observed state ALSO contradicts the intended sequence (${problems.join("; ")}), but ` +
                `because attribution is broken that contradiction is recorded as unattributed context ` +
                `only — it is NOT classified as a verified failure of this commit, since the intervening ` +
                `change may have caused it.`
              : ``),
          undeterminedDimensions: ["recurringFinancialEffect"],
        },
        status: "COMMITTED_UNVERIFIED",
        outcome: "COMMITTED_UNVERIFIED",
        snapshot: snap,
      };
    }
    if (problems.length > 0) {
      return {
        effect: committedEffect,
        reconciliation: {
          status: "VIOLATED",
          reason:
            `Post-commit state verification MISMATCH — a determined negative verification (Decision D3): ` +
            `${problems.join("; ")}. The contradiction is attributable to this commit: the version sequence ` +
            `is the unbroken +1 this commit alone produces, so no intervening change can account for it. ` +
            `The committed immediate is this mutation's bound-order actual and the ` +
            `recurring figure reports the observed state; the order has already been created and cannot be ` +
            `rolled back by this reconciliation.`,
        },
        status: "COMMITTED",
        outcome: "COMMITTED_AND_VERIFIED",
        snapshot: snap,
      };
    }
    return {
      effect: committedEffect,
      reconciliation: reconcileCommittedEffect(quoted, committedEffect, proposal.acceptanceEnvelope, proposal),
      status: "COMMITTED",
      outcome: "COMMITTED_AND_VERIFIED",
      snapshot: snap,
    };
  }

  /**
   * v0.6.2 (PR-5): establishes a pure CANCEL commit's committed
   * effect.
   *
   * Cancellation figures are defined by the protocol (CORE-2):
   * immediate is NOT_APPLICABLE (no immediate financial event) and
   * the post-cancellation recurring level is 0 once effective, so
   * committed := quoted, labeled defined_equal_exact — but ONLY
   * after the cancellation's STATE is independently verified from
   * a post-commit re-read of the subscription record AND — PR #14
   * review correction Z2 — attributed to THIS commit: the
   * persisted order this mutation created is read back by id, its
   * actions are checked against the dispatched sequence, and the
   * version sequence must be the unbroken +1 this commit alone
   * produces (the same attribution establishCommittedEffect
   * requires; this path previously verified status/date alone, so
   * another actor's cancellation could verify as this commit's).
   * If the bound order cannot be read, its identity does not
   * match, or the chain is broken, the outcome is
   * COMMITTED_UNVERIFIED / UNVERIFIED with candidate figures —
   * neither OK nor VIOLATED may be issued for an unattributable
   * cancellation. (The adapter owns this establishment because the
   * PR-1 machinery's generic snapshot check cannot see a
   * cancellation schedule — the F3 limitation; the sim's
   * subscription record carries `cancelledDate`, so the richer
   * read is available here.)
   *
   * With attribution established, the state verdicts are:
   *
   *  - IMMEDIATE intent: the re-read status must be the terminal
   *    "Cancelled" — kind TERMINAL. A non-terminal read is an
   *    established contradiction: MISMATCH.
   *  - TERM_END / DATE intent: the re-read must carry the
   *    cancellation at the QUOTED effective date — `cancelledDate`
   *    equal to the date recorded on the quote at quote time —
   *    while the subscription is still Active (kind SCHEDULED), or
   *    in the terminal state once that date has been reached
   *    (kind TERMINAL). A terminal read whose cancelledDate is NOT
   *    the quoted date is a premature or mis-dated termination —
   *    the subscription was ended on a different date than the one
   *    quoted — and is an established contradiction: MISMATCH
   *    (PR #11 review correction P3: the comparison reference is
   *    the QUOTED date, never a re-derived current boundary). A
   *    still-active subscription WITHOUT the cancellation at the
   *    quoted date is likewise MISMATCH.
   *  - MISMATCH (D3): COMMITTED / COMMITTED_AND_VERIFIED with a
   *    VIOLATED reconciliation, and the committed figures honestly
   *    report the OBSERVED state (the still-active price level),
   *    never a fabricated post-cancel zero. Reachable ONLY with
   *    attribution established (above) — an unattributable
   *    contradiction is UNVERIFIED, not this commit's VIOLATED.
   *  - Re-read unavailable: landing is established (the createOrder
   *    call returned) but verification is not —
   *    COMMITTED_UNVERIFIED with candidate figures labeled
   *    unestablished under UNKNOWN determinacy, built entirely
   *    from data already in hand (PR #11 correction P1).
   *
   * Z3 audit (PR #14 review correction Z3): this path was audited
   * for the broken-attribution financial-claim defect fixed in
   * establishCommittedEffect, and it is CLEAN: its unverified
   * branches record only the candidateEffect — the QUOTED
   * post-cancellation level under UNKNOWN determinacy with
   * committedSource "unestablished", never a figure sourced from
   * the (possibly third-party-influenced) re-read state, and never
   * a zero asserted from an observed terminal state. The only
   * re-read-derived DETERMINED figure in this path is the D3
   * mismatch branch's observed recurring, reachable only AFTER
   * the Z2 attribution gate above — an attributable contradiction,
   * which Z3 does not touch.
   */
  private establishCancelCommit(
    validated: StoredQuote,
    mutation: { subscription: ZuoraSubscription; result: import("./zuora-sim.js").OrderPreviewResult; orderId: string }
  ): {
    effect: CommercialEffect;
    reconciliation: ReconciliationResult;
    status: SubscriptionChangeReceipt["status"];
    outcome: MutationOutcome;
    snapshot: SubscriptionSnapshot;
  } {
    const subscriptionId = validated.subscription_id;
    const quoted = validated.quoted_effect;
    const proposal = validated.proposal;
    const input = validated.provider_preview_input as ZuoraPreviewInput;

    // Candidate figures for an unverifiable landing, built
    // ENTIRELY from data already in hand (the stored quote and the
    // mutation response) — recording a COMMITTED_UNVERIFIED
    // receipt never depends on a further successful provider read
    // after the order has landed (PR #11 correction P1).
    const candidateEffect = (recurringProvenance: string): CommercialEffect => ({
      recurring: {
        previousAmount: quoted.recurring?.previousAmount,
        resultingAmount: 0,
        currency: quoted.recurring?.currency ?? "usd",
        ...(quoted.recurring?.cadence ? { cadence: quoted.recurring.cadence } : {}),
      },
      ...(quoted.term ? { term: quoted.term } : {}),
      effectiveAt: quoted.effectiveAt,
      determinacy: { immediateFinancialEffect: "UNKNOWN", recurringFinancialEffect: "UNKNOWN" },
      provenance: {
        recurring: recurringProvenance,
        committedSource: "unestablished",
        applicabilityCitations: {
          immediateFinancialEffect: { action: "CANCEL", dimension: "immediateFinancialEffect" },
        },
      },
    });

    // Independent post-commit reads: the subscription AND — PR #14
    // review correction Z2 — the persisted ORDER this mutation
    // created, read back by its id via retrieveOrder. Cancellation
    // verification is bound to that order exactly as the general
    // path (establishCommittedEffect) binds to it: the order's
    // identity, its action identity against the stored dispatched
    // sequence, and the unbroken +1 version chain must ALL be
    // established before the observed cancellation state may be
    // classified as this commit's verified success (OK) or verified
    // failure (VIOLATED). Previously this path re-read only the
    // subscription, so a matching cancelledDate or terminal status
    // produced by some OTHER actor's order verified as this
    // commit's own result.
    let readSub: ZuoraSubscription | undefined;
    try {
      readSub = this.sim.get(subscriptionId);
    } catch {
      readSub = undefined;
    }
    let readOrder: ZuoraOrder | undefined;
    try {
      const order = this.sim.retrieveOrder(mutation.orderId);
      if (order.subscriptionId === subscriptionId) readOrder = order;
    } catch {
      readOrder = undefined;
    }

    if (!readSub) {
      return {
        effect: candidateEffect(
          "candidate figure: the quoted post-cancellation level, reported by the mutating call's own response path; the independent post-commit re-read was unavailable, so the cancellation's landing is NOT independently established"
        ),
        reconciliation: {
          status: "UNVERIFIED",
          reason:
            "the order landed (its response was received) but the independent post-commit re-read of the " +
            "subscription was unavailable, so the cancellation state could not be verified; the recorded " +
            "figures are candidates, pending a later verification",
          undeterminedDimensions: ["immediateFinancialEffect", "recurringFinancialEffect"],
        },
        status: "COMMITTED_UNVERIFIED",
        outcome: "COMMITTED_UNVERIFIED",
        // Built from the mutation response alone — NO further
        // provider read (PR #11 correction P1). Recording this
        // receipt must never depend on a read succeeding after the
        // order has landed.
        snapshot: snapshotFrom(mutation.subscription),
      };
    }

    const snap = snapshotFrom(readSub);

    // Attribution (Z2): the bound order must be THIS mutation's
    // order (bound by the returned id, on this subscription),
    // carrying exactly the action sequence this commit dispatched,
    // and the version sequence must be the unbroken +1 from the
    // version this commit validated against to the re-read version
    // — the same chain establishCommittedEffect requires.
    const orderActionsMatch =
      readOrder !== undefined && canonicalJson(readOrder.orderActions) === canonicalJson(input.orderActions);
    const attributable =
      readOrder !== undefined &&
      orderActionsMatch &&
      readOrder.subscriptionVersionAfter === Number(validated.subscription_version_at_quote) + 1 &&
      readSub.version === readOrder.subscriptionVersionAfter;

    if (!attributable) {
      let failure: string;
      if (readOrder === undefined) {
        failure =
          `the persisted order ${mutation.orderId} this mutation created could not be read back, so the ` +
          `cancellation cannot be bound to this commit's order at all`;
      } else if (!orderActionsMatch) {
        failure =
          `the persisted order ${readOrder.id} read back for this mutation does not carry the order-action ` +
          `sequence this commit dispatched, so it does not establish this cancellation's identity`;
      } else {
        const latestId = this.sim.latestOrderId(subscriptionId);
        failure =
          `another order intervened around this commit's cancellation order: this commit validated ` +
          `against subscription version ${validated.subscription_version_at_quote}, order ${readOrder.id} ` +
          `recorded version ${readOrder.subscriptionVersionAfter} after it applied, and the re-read ` +
          `subscription is at version ${readSub.version}` +
          (latestId && latestId !== readOrder.id ? ` with latest order ${latestId}` : "") +
          ` — the version sequence is not the unbroken +1 this commit alone would produce`;
      }
      return {
        effect: candidateEffect(
          "candidate figure: the quoted post-cancellation level; the cancellation's attribution to this commit could not be established, so the observed state is NOT an established actual of this commit"
        ),
        reconciliation: {
          status: "UNVERIFIED",
          reason:
            `the cancellation order landed (its response was received, carrying order ${mutation.orderId}) ` +
            `but its result cannot be attributed to this commit: ${failure}. The observed state ` +
            `(status ${readSub.status}, cancelledDate ${readSub.cancelledDate ?? "(none)"}) is recorded as ` +
            `unattributed context only — it is NOT classified as this commit's verified cancellation, nor ` +
            `as its verified failure, since an intervening change may have produced it; the recorded ` +
            `figures are candidates, pending a later verification`,
          undeterminedDimensions: ["immediateFinancialEffect", "recurringFinancialEffect"],
        },
        status: "COMMITTED_UNVERIFIED",
        outcome: "COMMITTED_UNVERIFIED",
        snapshot: snap,
      };
    }

    // Attribution is established: the state evaluation below speaks
    // about THIS commit's cancellation alone, so its verdicts —
    // verified SCHEDULED/TERMINAL, or a D3 MISMATCH — are this
    // commit's own.
    const intentType = proposal.effectiveIntent.type;
    const quotedDate = quoted.effectiveAt;
    let verifiedKind: "TERMINAL" | "SCHEDULED" | undefined;
    let mismatchReason: string | undefined;
    if (intentType === "IMMEDIATE") {
      if (readSub.status === "Cancelled") {
        verifiedKind = "TERMINAL";
      } else {
        mismatchReason =
          `the post-commit re-read shows subscription status "${readSub.status}", not the terminal "Cancelled" ` +
          `state an immediate cancellation must produce`;
      }
    } else {
      // TERM_END / DATE: do NOT require a terminal state now —
      // verify the cancellation AT THE QUOTED DATE: the effective
      // date recorded on the quote at quote time
      // (`quoted.effectiveAt`). Correction P3: the comparison
      // reference is the quoted date, NOT the record's current
      // term end — the record's term can drift after quoting, and
      // a cancellation that merely matches a drifted boundary is
      // not the cancellation that was quoted.
      if (readSub.cancelledDate !== undefined && readSub.cancelledDate === quotedDate) {
        if (readSub.status === "Cancelled") {
          if (quotedDate !== undefined && new Date(quotedDate).getTime() <= this.sim.currentTime().getTime()) {
            verifiedKind = "TERMINAL"; // quoted date reached — the scheduled cancellation is in effect
          } else {
            mismatchReason =
              `the post-commit re-read shows the subscription in the terminal "Cancelled" state BEFORE the ` +
              `quoted effective date (${quotedDate}) — a premature termination: the subscription was ended ` +
              `earlier than the effective date this commit was quoted for`;
          }
        } else {
          verifiedKind = "SCHEDULED";
        }
      } else if (readSub.status === "Cancelled") {
        mismatchReason =
          `the post-commit re-read shows the subscription in the terminal "Cancelled" state with ` +
          `cancelledDate ${readSub.cancelledDate ?? "(none)"}, not the quoted effective date (${quotedDate}) — ` +
          `it was ended on a different date than the cancellation that was quoted`;
      } else {
        mismatchReason =
          `the post-commit re-read shows cancelledDate ${readSub.cancelledDate ?? "(none)"} on a still-active ` +
          `subscription, not the quoted cancellation date (${quotedDate}) — the cancellation this commit ` +
          `dispatched is absent or mis-dated in the provider record`;
      }
    }

    if (mismatchReason) {
      // Established negative verification (D3): the committed
      // figures report the OBSERVED state — for a cancel that did
      // not land as intended, that is the still-active price
      // level, read back from the provider record (provider_actual)
      // — never the quoted post-cancel zero.
      const observed: CommercialEffect = {
        recurring: {
          previousAmount: quoted.recurring?.previousAmount,
          resultingAmount: recurringTotalOf(readSub),
          currency: quoted.recurring?.currency ?? "usd",
          ...(quoted.recurring?.cadence ? { cadence: quoted.recurring.cadence } : {}),
        },
        ...(quoted.term ? { term: quoted.term } : {}),
        effectiveAt: quoted.effectiveAt,
        determinacy: { immediateFinancialEffect: "NOT_APPLICABLE", recurringFinancialEffect: "DETERMINED" },
        provenance: {
          recurring: PROV_RECURRING_COMMITTED,
          committedSource: "provider_actual",
          applicabilityCitations: {
            immediateFinancialEffect: { action: "CANCEL", dimension: "immediateFinancialEffect" },
          },
        },
      };
      return {
        effect: observed,
        reconciliation: {
          status: "VIOLATED",
          reason:
            `Post-commit cancellation state verification MISMATCH — a determined negative verification (Decision D3): ` +
            `${mismatchReason}. The contradiction is attributable to this commit: the bound order's ` +
            `identity and the unbroken +1 version chain were established before this evaluation, so no ` +
            `intervening change can account for it. The committed recurring figure reports the observed ` +
            `state; the order has already been created and cannot be rolled back by this reconciliation.`,
        },
        status: "COMMITTED",
        outcome: "COMMITTED_AND_VERIFIED",
        snapshot: snap,
      };
    }

    // Verified: the figures are the quoted figures BY PROTOCOL
    // DEFINITION (a pure cancellation has no proration component
    // to drift), now backed by the established state — honestly
    // labeled defined_equal_exact, with the verification kind
    // recorded.
    const committedEffect: CommercialEffect = {
      ...quoted,
      provenance: {
        ...quoted.provenance,
        recurring:
          `${PROV_CANCEL_RECURRING_QUOTE} — established at commit by the post-commit re-read: ` +
          (verifiedKind === "TERMINAL"
            ? intentType === "IMMEDIATE"
              ? `the subscription reads in the terminal "Cancelled" state (verification kind TERMINAL)`
              : `the subscription reads in the terminal "Cancelled" state at/after the quoted effective ` +
                `date (${quotedDate}) — the scheduled cancellation has taken effect (verification kind TERMINAL)`
            : `the cancellation is present with cancelledDate ${readSub.cancelledDate} (the quoted effective ` +
              `date) on a still-active subscription (verification kind SCHEDULED)`),
        committedSource: "defined_equal_exact",
      },
    };
    return {
      effect: committedEffect,
      reconciliation: reconcileCommittedEffect(quoted, committedEffect, proposal.acceptanceEnvelope, proposal),
      status: "COMMITTED",
      outcome: "COMMITTED_AND_VERIFIED",
      snapshot: snap,
    };
  }
}

/** The stored quote's resolved effective date (a YYYY-MM-DD order date), for revalidated-effect construction. */
function effectiveDate0(validated: StoredQuote): string {
  const input = validated.provider_preview_input as ZuoraPreviewInput;
  return input.orderActions[0]?.effectiveDate ?? new Date().toISOString().slice(0, 10);
}

function toSCQError(e: unknown, subscriptionId: string): SCQError {
  if (e instanceof ZuoraSimError) {
    if (e.code === "SubscriptionNotFound") return new SCQError("SUBSCRIPTION_NOT_FOUND", `Subscription ${subscriptionId} not found`, e);
    return new SCQError("PROVIDER_ERROR", e.message, e);
  }
  if (e instanceof SCQError) return e;
  return new SCQError("PROVIDER_ERROR", String(e));
}

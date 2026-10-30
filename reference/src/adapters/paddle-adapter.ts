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
  validateProposalRuntime,
  validateStoredQuoteRuntime,
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
  PaddleSim,
  PaddleSimError,
  type PaddleSubscription,
  type PaddleTransaction,
  type PreviewResult,
  type ProrationBillingMode,
} from "./paddle-sim.js";

const QUOTE_TTL_MS = 5 * 60 * 1000;

type PaddleItemInput = { priceId: string; quantity: number };

type PaddlePreviewInput = {
  items: PaddleItemInput[];
  prorationBillingMode: ProrationBillingMode;
  cancelEffectiveFrom?: "immediately" | "next_billing_period";
};

const OFFERING_TO_PRICE: Record<string, string> = {
  "plan:basic:monthly": "pri_seat_basic",
  "plan:pro:monthly": "pri_seat_pro",
  "plan:basic:annual": "pri_seat_basic_annual",
};

/**
 * v0.6 capability source of truth for Paddle. `getCapabilities()` and the
 * enforcement functions in createChangeQuote all call this SAME function.
 *
 * GuaranteeCoverage reasoning unchanged from v0.4/v0.5: REVALIDATE-only
 * financial dimensions for CHANGE_QUANTITY/PLAN/CADENCE (no
 * proration_date-equivalent parameter on Paddle); EXACT for CANCEL.
 * termEffect UNKNOWN except CANCEL, same reasoning as Stripe.
 *
 * `supportedEffectiveIntents`: "IMMEDIATE" everywhere; "TERM_END" ONLY for
 * CANCEL (`next_billing_period` — Paddle's real period-boundary-deferred
 * cancellation primitive). "DATE" is NOT supported anywhere — Paddle has
 * no arbitrary-future-date scheduling mechanism.
 */
function capabilitiesFor(action: ChangeAction): ActionCapabilities {
  const guaranteeCoverage: GuaranteeCoverage =
    action === "CANCEL"
      ? { immediateFinancialEffect: "EXACT", recurringFinancialEffect: "EXACT", termEffect: "EXACT", effectiveAt: "EXACT" }
      : { immediateFinancialEffect: "REVALIDATE", recurringFinancialEffect: "REVALIDATE", termEffect: "UNKNOWN", effectiveAt: "EXACT" };
  const supportedEffectiveIntents: Array<EffectiveIntent["type"]> = action === "CANCEL" ? ["IMMEDIATE", "TERM_END"] : ["IMMEDIATE"];
  return { guaranteeCoverage, supportedEffectiveIntents };
}

/**
 * v0.5: Paddle Billing's `PATCH /subscriptions/{id}` accepts a full
 * `items[]` replacement in a single call, so multiple non-CANCEL changes
 * (quantity and/or plan/cadence swaps) bundle ATOMICALLY, same reasoning
 * as Stripe. CANCEL is a distinct action/endpoint concept
 * (`scheduled_change` / cancel semantics) that cannot be combined with an
 * items[] update in the same call.
 */
function multiChangePairSupport(a: ChangeAction, b: ChangeAction): MultiChangeConsistency {
  if (a === "CANCEL" || b === "CANCEL") return "UNSUPPORTED";
  return "ATOMIC";
}

// ---------------------------------------------------------------------------
// v0.6.2 (PR-4) financial-semantics helpers.
//
// §3.11 / CORE-3: `CommercialEffect.immediate` is ONLY the net
// obligation the change itself incurs at its effective time. The
// simulator preview now separates that figure (the immediate
// transaction's INCURRED component) from the transaction's PAYMENT
// total (incurred minus pre-existing customer credits applied) and
// from next-transaction totals. The adapter maps the incurred
// component — and nothing else — into `immediate`; the payment
// total, the applied credits, and next-transaction figures are
// reported, labeled, in the quote's providerMetadata (see
// `transactionEstimateMetadata`).
//
// The preview's immediate figure has THREE distinct states, and
// the migration keeps them distinct (finding F-3):
//   - a transaction object: the incurred amount is its
//     `incurredAmount` (DETERMINED);
//   - `null`: under `prorated_immediately` the sim produces no
//     immediate transaction iff the incurred amount is exactly 0
//     — an ESTABLISHED zero (DETERMINED 0), not not-applicable and
//     not unknown;
//   - absent (fault-injected omission): the preview cannot
//     establish the figure at all — UNKNOWN, no figure emitted,
//     never zero-filled, never back-filled from the payment total.
// ---------------------------------------------------------------------------

const PROV_IMMEDIATE_QUOTE =
  "simulator update-preview of the final folded item set (proration_billing_mode prorated_immediately): the immediate transaction's incurred component — the net obligation the folded change set incurs at its effective time, before any pre-existing credit-balance application (preview.immediateTransaction.incurredAmount)";
const PROV_IMMEDIATE_ZERO =
  "simulator update-preview of the final folded item set returned NO immediate transaction; under prorated_immediately the simulator produces a null immediate transaction iff the incurred amount is exactly 0 (paddle-sim computePreview) — an established DETERMINED zero, not an absence of information and not not-applicable";
const PROV_IMMEDIATE_WITHHELD =
  "UNESTABLISHED: the simulator preview omitted its immediate-transaction figure entirely, so no incurred obligation could be established — the dimension is UNKNOWN, not zero, and the transaction's payment total is never substituted for it";
const PROV_RECURRING_QUOTE =
  "simulator update-preview of the final folded item set: next_transaction amount — the post-change item set's price level (sum over the folded items of unitAmount x quantity) billed at the next billing boundary (preview.nextTransaction.amount)";
/**
 * M3: the committed immediate's provenance NAMES the bound
 * transaction — the transaction THIS mutation generated, bound by
 * its id at verification time. An unqualified latest-transaction
 * pointer is never the source: a later mutation may have replaced
 * it.
 */
function provImmediateCommitted(transactionId: string): string {
  return (
    `post-commit actual: incurredAmount of transaction ${transactionId} — the transaction THIS mutation generated, ` +
    `bound by id and read back from the simulator after the mutation (a provider read, not a preview and not the ` +
    `mutation response); no latest-transaction pointer was used`
  );
}
const PROV_RECURRING_COMMITTED =
  "post-commit actual: sum over the re-read post-commit subscription's items (unitAmount x quantity)";
const PROV_CANCEL_RECURRING_QUOTE =
  "post-cancellation price level: cancellation leaves no billable recurring obligation once effective, so the resulting recurring amount is a determined zero (established at commit by the verified terminal state, or by the verified scheduled cancellation at its period-boundary effective date)";

/** Splits a signed incurred amount into the immediate {charge, credit, net} shape. */
function immediateParts(net: number): NonNullable<CommercialEffect["immediate"]> {
  return {
    charge: net > 0 ? net : undefined,
    credit: net < 0 ? -net : undefined,
    net,
  };
}

/**
 * v0.6.2 (PR-4, correction principle M2 — as first applied to the
 * Stripe adapter in PR #10): adapter-level determinacy gate for
 * commits. The frozen v0.6.1 acceptance envelope coerces absent
 * figures to 0 (§14.6-pinned behavior), so an effect whose
 * incurred figure is UNKNOWN — at quote time, or in the commit-time
 * revalidation — could pass the gate and proceed to MUTATE: the
 * adapter would commit a change whose financial effect it does
 * not know. Fail-closed treatment of UNKNOWN in the shared
 * envelope is BC-1, activated in the core by PR-10:
 * checkAcceptanceEnvelope now refuses unenforceable dimensions
 * itself. THIS adapter still refuses such commits itself, before
 * any mutating call, with QUOTE_NOT_DETERMINISTIC — the local gate
 * is the earlier, adapter-specific refusal; the core gate is the
 * protocol-level backstop behind it.
 *
 * A dimension passes iff it is DETERMINED with a finite value, or
 * NOT_APPLICABLE under the §3.10 license — which covers exactly
 * one case: the immediate dimension of a CANCEL proposal, with
 * the matching applicability citation in the effect's provenance
 * (the shape this adapter's own CANCEL quotes carry). Recurring
 * is never licensed NOT_APPLICABLE. Anything else — UNKNOWN
 * (including a legacy payload's absent determinacy), an
 * unjustified NOT_APPLICABLE, or a DETERMINED assertion over a
 * missing / non-finite value — refuses the commit.
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
 * The labeled providerMetadata form of a preview's transaction-side
 * figures. These are PAYMENT / next-transaction figures — retained
 * with their meaning and source, and NEVER mapped into a
 * CommercialEffect.
 */
function transactionEstimateMetadata(preview: PreviewResult): Record<string, unknown> {
  const immediate = preview.immediateTransaction;
  return {
    ...(immediate
      ? {
          immediateTransactionTotal: immediate.amount,
          creditBalanceApplied: immediate.creditBalanceApplied,
          incurredAmount: immediate.incurredAmount,
        }
      : {}),
    nextTransactionAmount: preview.nextTransaction?.amount,
    nextTransactionBilledAt: preview.nextTransaction?.billedAt,
    source: "paddle-simulator update-preview (synthetic simulator figure)",
    meaning:
      "payment-side figures for the immediate and next transactions: immediateTransactionTotal is the immediate " +
      "transaction's payment total (its incurred amount net of pre-existing customer credits applied). They are NOT " +
      "the incurred obligation (commercialEffect.immediate) and are never mapped into the effect (spec §3.11).",
  };
}

function snapshotFrom(sub: PaddleSubscription): SubscriptionSnapshot {
  const totalRecurring = sub.items.reduce((sum, i) => sum + i.price.unitAmount * i.quantity, 0);
  return {
    id: sub.id,
    version: "",
    status: sub.status,
    items: sub.items.map((i, idx) => ({
      id: `${sub.id}_item_${idx}`, // Paddle items are not independently id'd the way Stripe si_ are; synthesize a stable-ish ref
      offeringRef: Object.entries(OFFERING_TO_PRICE).find(([, p]) => p === i.price.id)?.[0] ?? i.price.id,
      quantity: i.quantity,
    })),
    billing: {
      currency: sub.currencyCode,
      recurringAmount: totalRecurring,
      // v0.6.2 (CORE-7): the total is computed from the item state
      // this snapshot was built from — a determined figure, labeled
      // as such rather than left to imply its own determinacy.
      recurringAmountState: "DETERMINED",
      cadence: sub.billingCycle.interval === "year" ? "ANNUAL" : "MONTHLY",
      nextBillingAt: sub.nextBilledAt ?? undefined,
    },
    term: {
      // Paddle Billing subscriptions don't expose a distinct contract-term
      // field either. Explicit UNKNOWN — this is a genuine provider gap,
      // not an "N/A".
      commitmentUntil: "UNKNOWN",
      autoRenew: !sub.scheduledChange || sub.scheduledChange.action !== "cancel",
    },
  };
}

/**
 * v0.6.2 (PR-4, PR #11 review correction P1): a receipt snapshot
 * built ENTIRELY from data already in hand — the mutation
 * response's subscription object — performing NO provider read.
 *
 * The establish methods' `snapshotOf` stamps the snapshot's
 * version via `fingerprint()`, which performs another `get`. On
 * the unverified-candidate paths — reached precisely BECAUSE
 * post-commit reads are failing — that extra read can throw after
 * the mutation has already landed, and a successful mutation
 * would then record NOTHING instead of its COMMITTED_UNVERIFIED
 * receipt. The candidate paths therefore use this construction:
 * the snapshot's contents come from the mutation response, and
 * its version is left explicitly UNVERSIONED ("", the value
 * `snapshotFrom` itself produces before any stamping) — the
 * fingerprint of the post-mutation state cannot be established
 * without a read, and inventing one would mislabel it (reusing
 * the quote's `subscription_version_at_quote`, for instance,
 * would present the PRE-mutation state's fingerprint as the
 * post-mutation snapshot's version). The receipt this snapshot
 * rides on is COMMITTED_UNVERIFIED: the snapshot is a candidate
 * record of the mutation response, not a verified post-commit
 * read, and its unversioned state says exactly that.
 */
function snapshotFromMutationResponse(sub: PaddleSubscription): SubscriptionSnapshot {
  return snapshotFrom(sub);
}

/**
 * Builds an effect from a folded-set preview (§3.11): `immediate`
 * comes from the preview immediate transaction's INCURRED
 * component ONLY; the transaction's payment total never enters
 * the effect. The three preview states map to the three
 * determinacy outcomes (see the helpers header): object →
 * DETERMINED figure; null → DETERMINED zero (F-3); absent →
 * UNKNOWN with no figure emitted.
 */
function effectFromPreview(
  preview: PreviewResult,
  recurring: CommercialEffect["recurring"],
  term: CommercialEffect["term"],
  effectiveAtIso: string,
  provenanceOverride?: CommercialEffect["provenance"]
): CommercialEffect {
  const effect: CommercialEffect = { recurring, effectiveAt: effectiveAtIso };
  if (term !== undefined) effect.term = term;
  if (preview.immediateTransaction === undefined) {
    effect.determinacy = { immediateFinancialEffect: "UNKNOWN", recurringFinancialEffect: "DETERMINED" };
    effect.provenance = provenanceOverride ?? { immediate: PROV_IMMEDIATE_WITHHELD, recurring: PROV_RECURRING_QUOTE };
  } else if (preview.immediateTransaction === null) {
    effect.immediate = { net: 0 };
    effect.determinacy = { immediateFinancialEffect: "DETERMINED", recurringFinancialEffect: "DETERMINED" };
    effect.provenance = provenanceOverride ?? { immediate: PROV_IMMEDIATE_ZERO, recurring: PROV_RECURRING_QUOTE };
  } else {
    effect.immediate = immediateParts(preview.immediateTransaction.incurredAmount);
    effect.determinacy = { immediateFinancialEffect: "DETERMINED", recurringFinancialEffect: "DETERMINED" };
    effect.provenance = provenanceOverride ?? { immediate: PROV_IMMEDIATE_QUOTE, recurring: PROV_RECURRING_QUOTE };
  }
  return effect;
}

/**
 * Folds a single ChangeSpec into the batch's working item set —
 * NO preview is taken here. `workingItems` (keyed by item index)
 * is the CURRENT state of every item as of this point in the
 * batch, so a later change targeting the SAME item composes on
 * the prior change's result rather than the original state.
 *
 * v0.6.2 (PR-4, correction principle M1 — as corrected for Stripe
 * in PR #10): the quote is derived from ONE preview of the FINAL
 * folded item set (see createChangeQuote). The pre-migration
 * construction previewed each change separately and combined the
 * per-change effects with combineEffects — which double-counted
 * overlapping changes (EVERY preview's delta is measured against
 * the ORIGINAL subscription, so an earlier change's contribution
 * was counted once per subsequent preview) and dropped a combined
 * zero into absence (finding F-2). The recurring "shape"
 * (cadence) still follows the batch's changes, as before; the
 * FIGURES now come from the single folded preview.
 */
function foldOneChange(
  sub: PaddleSubscription,
  workingItems: Map<number, PaddleItemInput>,
  change: ChangeSpec
): { itemIndex: number; item: PaddleItemInput; recurringCadence?: "MONTHLY" | "ANNUAL"; term?: CommercialEffect["term"] } {
  const currentAt = (idx: number): PaddleItemInput =>
    workingItems.get(idx) ?? { priceId: sub.items[idx].price.id, quantity: sub.items[idx].quantity };
  const indexOfItem = (itemId: string): number => {
    const idx = sub.items.findIndex((_, i) => `${sub.id}_item_${i}` === itemId);
    if (idx < 0) throw new SCQError("INVALID_PROPOSAL", `Item ${itemId} not found on subscription`);
    return idx;
  };
  switch (change.action) {
    case "CHANGE_QUANTITY": {
      const idx = indexOfItem(change.itemId);
      return {
        itemIndex: idx,
        item: { priceId: currentAt(idx).priceId, quantity: change.quantity },
        recurringCadence: sub.billingCycle.interval === "year" ? "ANNUAL" : "MONTHLY",
      };
    }
    case "CHANGE_PLAN": {
      const idx = indexOfItem(change.itemId);
      const priceId = OFFERING_TO_PRICE[change.offeringRef];
      if (!priceId) throw new SCQError("UNSUPPORTED_CHANGE", `Unknown offeringRef ${change.offeringRef}`);
      return { itemIndex: idx, item: { priceId, quantity: currentAt(idx).quantity } };
    }
    case "CHANGE_CADENCE": {
      const idx = 0;
      const priceId = OFFERING_TO_PRICE[change.cadence === "ANNUAL" ? "plan:basic:annual" : "plan:basic:monthly"];
      return {
        itemIndex: idx,
        item: { priceId, quantity: currentAt(idx).quantity },
        recurringCadence: change.cadence,
        term: { createsCommitment: "UNKNOWN", commitmentUntil: "UNKNOWN", autoRenew: !sub.scheduledChange },
      };
    }
    case "CANCEL":
      throw new SCQError("INVALID_PROPOSAL", "CANCEL cannot be combined with other changes in one Paddle proposal");
  }
}

/**
 * The proposal's FOLDED intent — what the commit actually
 * dispatches (the final item set in `provider_preview_input`) —
 * for post-commit state verification. When a batch repeats an
 * action against the same target, the later change SUPERSEDES
 * the earlier one's stated value in the folded set, so the
 * executed intent for that target is the LAST stated value. The
 * PR-1 state check verifies every change in the proposal against
 * the final snapshot; fed the raw proposal, a correctly landed
 * folded commit would report a false MISMATCH against a
 * superseded intermediate value. Verification therefore runs
 * against the folded intent — the same intended-target-set
 * principle the Chargebee adapter's state checks use. The verdict
 * is still COMPUTED by establishVerification from the observation;
 * only the intent it is computed against is the executed one. The
 * stored quote and the caller's proposal are not modified.
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

export class PaddleAdapter implements SubscriptionProvider {
  constructor(private sim: PaddleSim, private store: QuoteStore) {}

  getCapabilities(): ProviderCapabilities {
    return {
      quoteCapabilities: {
        CHANGE_QUANTITY: capabilitiesFor("CHANGE_QUANTITY"),
        CHANGE_PLAN: capabilitiesFor("CHANGE_PLAN"),
        CHANGE_CADENCE: capabilitiesFor("CHANGE_CADENCE"),
        CANCEL: capabilitiesFor("CANCEL"),
      },
      // No compare-and-swap precondition on PATCH /subscriptions/{id}
      // either. Never report ATOMIC.
      consistencyGuarantee: "BEST_EFFORT",
    };
  }

  async getSubscription(subscriptionId: string): Promise<SubscriptionSnapshot> {
    let sub: PaddleSubscription;
    try {
      sub = this.sim.get(subscriptionId);
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
    // PR-15 (Finding 2): the shared runtime validator runs FIRST —
    // before any provider read, preview, or mutation — so malformed
    // caller input refuses identically on every adapter. This
    // adapter's provider-specific checks below run after it.
    validateProposalRuntime(proposal);
    let sub: PaddleSubscription;
    try {
      sub = this.sim.get(subscriptionId);
    } catch (e) {
      throw toSCQError(e, subscriptionId);
    }
    if (proposal.changes.length === 0) {
      throw new SCQError("INVALID_PROPOSAL", "proposal.changes must contain at least one change");
    }

    const perChangeCapabilities = proposal.changes.map((c) => capabilitiesFor(c.action));
    for (const caps of perChangeCapabilities) {
      enforceEffectiveIntent(proposal.effectiveIntent, caps.supportedEffectiveIntents);
    }

    const guaranteeCoverage = computeCombinedCoverage(perChangeCapabilities.map((c) => c.guaranteeCoverage));
    const multiChangeConsistency = computeMultiChangeConsistency(proposal.changes, multiChangePairSupport);
    enforceMultiChangeConsistency(proposal.changes, multiChangeConsistency);
    // v0.6 normative rule: this adapter never attempts a bundle Paddle's
    // real API might silently partially-apply — non-CANCEL changes fold
    // into one verified-atomic items[] replacement; CANCEL+anything is
    // refused above via multiChangeConsistency. No partial-execution risk
    // remains to guard against for this provider.
    enforceNoPartialExecutionRisk(proposal.changes, false);

    const effectiveMode = resolveGuaranteeMode(proposal);
    enforceGuaranteeRequest(proposal.changes, effectiveMode, guaranteeCoverage, proposal.acceptanceEnvelope);

    const fingerprint = this.sim.fingerprint(subscriptionId);
    const now = new Date();
    const quoteId = `scq_paddle_${crypto.randomBytes(8).toString("hex")}`;
    const oldRecurring = sub.items.reduce((s, i) => s + i.price.unitAmount * i.quantity, 0);

    let previewInput: PaddlePreviewInput;
    let commercialEffect: CommercialEffect;
    let preview: PreviewResult | undefined;

    if (proposal.changes.length === 1 && proposal.changes[0].action === "CANCEL") {
      const effectiveFrom = proposal.effectiveIntent.type === "TERM_END" ? "next_billing_period" : "immediately";
      previewInput = { items: [], prorationBillingMode: "do_not_bill", cancelEffectiveFrom: effectiveFrom };
      commercialEffect = {
        // v0.6.2 (PR-4): explicit determinacy for CANCEL. Immediate
        // is NOT_APPLICABLE under the §3.10 license (CANCEL x
        // immediateFinancialEffect — under this provider model a
        // cancellation generates no immediate financial event: the
        // sim's cancel creates no transaction and no proration),
        // cited in provenance. Recurring is NEVER not-applicable:
        // the post-cancellation price level is a DETERMINED zero —
        // the obligation at/after the cancellation's effective
        // boundary, NOT the still-active subscription's current
        // price (which remains the price level UNTIL that boundary
        // for a TERM_END cancel, and is reported as such by the
        // snapshot, not by this effect).
        recurring: {
          previousAmount: oldRecurring,
          resultingAmount: 0,
          currency: sub.currencyCode,
          cadence: sub.billingCycle.interval === "year" ? "ANNUAL" : "MONTHLY",
        },
        term: { createsCommitment: false, autoRenew: false },
        effectiveAt: effectiveFrom === "next_billing_period" ? sub.currentBillingPeriod.endsAt : now.toISOString(),
        determinacy: { immediateFinancialEffect: "NOT_APPLICABLE", recurringFinancialEffect: "DETERMINED" },
        provenance: {
          recurring: PROV_CANCEL_RECURRING_QUOTE,
          applicabilityCitations: {
            immediateFinancialEffect: { action: "CANCEL", dimension: "immediateFinancialEffect" },
          },
        },
      };
    } else {
      // One or more non-CANCEL changes, bundled into a single items[]
      // replacement — genuinely atomic on Paddle (see
      // multiChangePairSupport).
      //
      // v0.6.2 M1: fold ALL changes into the final item set FIRST
      // (workingItems — a later change to an item composes on the
      // earlier result; the folded set is also exactly what the
      // commit will send), then derive the quote from ONE preview
      // of that folded set. The folded preview measures every
      // item's delta against the ORIGINAL state exactly once, so
      // overlapping changes cannot double-count and the aggregate
      // recurring covers every item's change.
      const workingItems = new Map<number, PaddleItemInput>();
      const steps = proposal.changes.map((change) => {
        const step = foldOneChange(sub, workingItems, change);
        workingItems.set(step.itemIndex, step.item);
        return step;
      });
      const finalItems = sub.items.map((it, i) => workingItems.get(i) ?? { priceId: it.price.id, quantity: it.quantity });
      previewInput = { items: finalItems, prorationBillingMode: "prorated_immediately" };
      try {
        preview = this.sim.previewUpdate(subscriptionId, finalItems, "prorated_immediately");
      } catch (e) {
        throw toSCQError(e, subscriptionId);
      }
      const lastStep = steps[steps.length - 1];
      const lastTerm = steps.reduce((t, s) => s.term ?? t, undefined as CommercialEffect["term"] | undefined);
      commercialEffect = effectFromPreview(
        preview,
        {
          previousAmount: oldRecurring,
          // nextTransaction.amount is the folded item set's price
          // level (Σ unitAmount x quantity), billed at the period
          // boundary — validated as exactly the post-change
          // recurring price level in this simulator's model (the
          // sim computes it as that sum; it carries no tax, balance,
          // or one-off components).
          resultingAmount: preview.nextTransaction?.amount,
          currency: sub.currencyCode,
          ...(lastStep.recurringCadence ? { cadence: lastStep.recurringCadence } : {}),
        },
        lastTerm,
        now.toISOString()
      );
    }

    const expiresAt = new Date(now.getTime() + QUOTE_TTL_MS).toISOString();
    const stored: StoredQuote<PaddlePreviewInput> = {
      quote_id: quoteId,
      provider: "paddle",
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
        proration_billing_mode: previewInput.prorationBillingMode,
        // v0.6.2 (PR-4, §3.11): the preview's transaction-side
        // figures (payment total, applied credits, next-transaction
        // total) are reported HERE, labeled with meaning and
        // source — never in the effect. There is exactly ONE
        // preview per quote — of the final folded item set (M1).
        ...(preview ? { nextTransactionEstimate: transactionEstimateMetadata(preview) } : {}),
      },
    };
  }

  async commitChangeQuote(quoteId: string): Promise<SubscriptionChangeReceipt> {
    // v0.6.1: idempotent replay checked before any read of live provider
    // state or mutating call — see checkIdempotentReplay's doc comment.
    // (PR-1/PR #8: replay returns the ORIGINAL recorded receipt, §6.10.)
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
    // line — replay above returns it.)
    if (quote.commit_outcome?.outcome === "INDETERMINATE") {
      throw new SCQError(
        "PROVIDER_ERROR",
        `Commit outcome for quote ${quoteId} is INDETERMINATE: a previous commit attempt's mutation was ` +
          `dispatched but its landing was not established. No second mutation was issued. Reconcile the ` +
          `provider state manually before any retry.`,
        { outcome: "INDETERMINATE", indeterminate: true, reconciled: false }
      );
    }

    // Same read/write separation and TOCTOU window as the Stripe adapter —
    // no compare-and-swap parameter exists on Paddle's update endpoint
    // either, and no adapter-local lock is used to hide that.
    const currentFingerprint = this.sim.fingerprint(quote.subscription_id);
    const validated = validateCommit(this.store, quoteId, currentFingerprint);

    // PR-15 (Finding 2): the STORED record is validated before it
    // feeds any gate below — the same shared rules as quote
    // creation, applied to the persisted proposal and the stored
    // effective guarantee mode. Placement: after §6.10 replay, the
    // recorded-INDETERMINATE guard, and validateCommit (their
    // precedence is preserved), before any re-preview or mutation.
    validateStoredQuoteRuntime(validated);

    const input = validated.provider_preview_input as PaddlePreviewInput;
    const proposal = validated.proposal;
    const effectiveMode = validated.effective_guarantee_mode;
    const isCancel = proposal.changes.length === 1 && proposal.changes[0].action === "CANCEL";

    // v0.6.2 (PR-4, M2): the QUOTED effect must be determinate
    // before this commit proceeds in ANY mode. The frozen v0.6.1
    // envelope coerces absent figures to 0, so an UNKNOWN quoted
    // incurred figure could otherwise pass a loose envelope and
    // mutate (see assertEffectDeterminateForCommit). This refusal
    // happens before the re-preview and before any mutating call;
    // a licensed CANCEL NOT_APPLICABLE passes.
    assertEffectDeterminateForCommit(validated.quoted_effect, proposal, "quoted");

    if (effectiveMode === "REVALIDATE" && !isCancel) {
      // Order per spec: re-preview -> evaluate acceptance envelope -> mutate
      // -> fetch resulting state -> receipt. This is Paddle's ONLY lever
      // for closing proration drift at all — since Paddle has no
      // proration_date equivalent, REVALIDATE is not just an option here,
      // it is the only mechanism SCQ can offer for proration-bearing
      // changes on Paddle that isn't silently trusting a stale number
      // (which is exactly why EXACT is not advertised for these actions).
      const freshPreview = this.sim.previewUpdate(validated.subscription_id, input.items, input.prorationBillingMode);
      // v0.6.2 (PR-4): the revalidated effect is built from the
      // preview's INCURRED component (never the transaction's
      // payment total) and is used ONLY as this pre-mutation gate's
      // input. It is quote-side data — labeled revalidated_preview —
      // and is NEVER assigned as the committed effect. (The
      // pre-migration code did exactly that assignment BEFORE the
      // mutation executed — finding F-1 — so post-commit
      // reconciliation compared the quote against the preview that
      // gated the commit and could never detect a wrong landing.)
      const revalidated = effectFromPreview(
        freshPreview,
        {
          ...validated.quoted_effect.recurring,
          currency: validated.quoted_effect.recurring?.currency ?? "USD",
          resultingAmount: freshPreview.nextTransaction?.amount,
        },
        validated.quoted_effect.term,
        validated.quoted_effect.effectiveAt ?? new Date().toISOString(),
        {
          immediate:
            freshPreview.immediateTransaction === undefined
              ? "commit-time revalidated preview omitted its immediate-transaction figure — PRE-MUTATION GATE ONLY; never the committed actual"
              : "commit-time revalidated preview incurred component — PRE-MUTATION GATE ONLY; never the committed actual",
          recurring: "commit-time revalidated preview next-transaction amount — gate only",
          committedSource: "revalidated_preview",
        }
      );
      // v0.6.2 (PR-4, M2): the REVALIDATED effect must also be
      // determinate BEFORE the envelope gate runs — the v0.6.1
      // envelope would coerce an absent revalidated figure to 0
      // and could pass it, letting the commit mutate against an
      // effect it does not know. Refuse here, still before any
      // mutating call.
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

    let resultingSub: PaddleSubscription;
    let mutationTransaction: PaddleTransaction | undefined;
    try {
      if (isCancel) {
        resultingSub = this.sim.cancel(validated.subscription_id, input.cancelEffectiveFrom!);
      } else {
        // EXACT is never reachable here for proration-bearing actions —
        // enforceGuaranteeRequest refused it at quote time. This call
        // always runs under REVALIDATE for those actions; the committed
        // effect is established from post-commit reads below, never
        // from the gate preview above.
        const { subscription, transaction } = this.sim.update(validated.subscription_id, input.items, input.prorationBillingMode);
        resultingSub = subscription;
        mutationTransaction = transaction;
      }
    } catch (e) {
      // v0.6.2 (CORE-5/CORE-8): a connection-class failure from the
      // mutating call means the request was dispatched but its
      // landing is NOT established — the mutation may have fully
      // applied (the sim's lost-response faults model exactly
      // that). Classify INDETERMINATE, record the outcome, record
      // NO receipt, and refuse any blind retry (see the guard at
      // the top of this method). Pre-mutation rejections keep the
      // existing error mapping: the mutation provably never took
      // effect.
      if (e instanceof PaddleSimError && e.type === "api_connection_error") {
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

    // --- v0.6.2 (PR-4): establish the committed effect. ---
    let committedEffect: CommercialEffect;
    let reconciliation: ReconciliationResult;
    let receiptStatus: SubscriptionChangeReceipt["status"];
    let receiptOutcome: MutationOutcome;
    let snap: SubscriptionSnapshot;

    if (isCancel) {
      const established = this.establishCancelCommit(validated, input.cancelEffectiveFrom!, resultingSub);
      committedEffect = established.effect;
      reconciliation = established.reconciliation;
      receiptStatus = established.status;
      receiptOutcome = established.outcome;
      snap = established.snapshot;
    } else {
      const established = this.establishCommittedEffect(validated, mutationTransaction, resultingSub);
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
    this.store.recordCommitReceipt(quoteId, receipt);
    return receipt;
  }

  /**
   * v0.6.2 (PR-4): establishes a REVALIDATE commit's committed
   * effect from POST-COMMIT state, independently of every preview.
   *
   * The independent read: a fresh `get` of the subscription plus
   * the transaction the mutation generated, read back by id via
   * `retrieveTransaction`. (These are SYNTHETIC simulator reads;
   * the observation built from them is constructed here, inside
   * the adapter, and never crosses a caller boundary — the duty
   * PR-1 assigned to adapters. The establishment token is not
   * treated as proof of the observation's authenticity.)
   *
   * M3 — TRANSACTION IDENTITY BINDING: the financial actuals come
   * from the transaction THIS mutation generated, bound by the id
   * the mutation returned and read via
   * `retrieveTransaction(thatId)` — NEVER from an unqualified
   * latest-transaction pointer, which a later/concurrent mutation
   * may already have replaced (attributing an unrelated
   * transaction's figures to this commit). The subscription
   * re-read serves the item-set / state verification only.
   * Divergence is handled explicitly: if the subscription's
   * latest transaction no longer is the bound one, a later
   * mutation intervened — a state MISMATCH against this commit's
   * intent still reports as the determined negative verification
   * below, but if the observed state still matches intent, the
   * commit is COMMITTED_UNVERIFIED: the state was not produced by
   * this commit alone, so it cannot be attributed to it, and the
   * recorded figures are this commit's bound-transaction actuals
   * only.
   *
   * Outcomes mirror the Stripe migration's:
   *  - read succeeds + state VERIFIED + no intervening
   *    transaction: COMMITTED / COMMITTED_AND_VERIFIED with the
   *    establishment's computed reconciliation.
   *  - read succeeds + state MISMATCH: COMMITTED /
   *    COMMITTED_AND_VERIFIED with a VIOLATED reconciliation
   *    naming the mismatch (Decision D3 — never UNVERIFIED).
   *  - read succeeds + state matches intent + an intervening
   *    transaction superseded the latest pointer:
   *    COMMITTED_UNVERIFIED (attribution unverified; figures are
   *    the bound transaction's).
   *  - read succeeds + state UNVERIFIABLE, or the read itself is
   *    unavailable: COMMITTED_UNVERIFIED with an UNVERIFIED
   *    reconciliation. Where the read failed, the recorded figures
   *    are the mutation response's CANDIDATE figures, labeled
   *    unestablished under UNKNOWN determinacy — what a later
   *    independent observation must confirm, verbatim, for
   *    verifyCommitReceipt to transition the record.
   *
   * Correction P1: the read-failed path is constructed ENTIRELY
   * from data already in hand (the mutation response and the
   * stored quote) — its receipt snapshot is
   * `snapshotFromMutationResponse`, which performs no provider
   * read. (Previously the snapshot went through `snapshotOf`,
   * whose `fingerprint()` performs another `get`; under a
   * persistent post-mutation read failure that threw, and the
   * successful mutation recorded nothing.) Once the mutation has
   * succeeded, recording the COMMITTED_UNVERIFIED receipt never
   * depends on a subsequent successful provider read.
   */
  private establishCommittedEffect(
    validated: StoredQuote,
    mutationTransaction: PaddleTransaction | undefined,
    mutationSub: PaddleSubscription
  ): {
    effect: CommercialEffect;
    reconciliation: ReconciliationResult;
    status: SubscriptionChangeReceipt["status"];
    outcome: MutationOutcome;
    snapshot: SubscriptionSnapshot;
  } {
    const subscriptionId = validated.subscription_id;
    const quoted = validated.quoted_effect;
    const recurringFrom = (sub: PaddleSubscription): CommercialEffect["recurring"] => ({
      previousAmount: quoted.recurring?.previousAmount,
      resultingAmount: sub.items.reduce((s, i) => s + i.price.unitAmount * i.quantity, 0),
      currency: sub.currencyCode,
      ...(quoted.recurring?.cadence ? { cadence: quoted.recurring.cadence } : {}),
    });
    const snapshotOf = (sub: PaddleSubscription): SubscriptionSnapshot => {
      const s = snapshotFrom(sub);
      s.version = this.sim.fingerprint(subscriptionId);
      return s;
    };

    // Independent post-commit read of persisted simulator state.
    // M3: the transaction read is BOUND to this mutation's own
    // transaction id — returned by the mutating call — never to
    // the subscription's latest transaction.
    let readSub: PaddleSubscription | undefined;
    let readIncurred: number | undefined;
    if (mutationTransaction) {
      try {
        readSub = this.sim.get(subscriptionId);
        const readTxn = this.sim.retrieveTransaction(mutationTransaction.id);
        if (readTxn.subscriptionId === subscriptionId && Number.isFinite(readTxn.incurredAmount)) {
          readIncurred = readTxn.incurredAmount;
        } else {
          readSub = undefined;
        }
      } catch {
        readSub = undefined;
        readIncurred = undefined;
      }
    }

    if (!mutationTransaction || !readSub || readIncurred === undefined) {
      // Verification unavailable: record the mutation response's
      // candidate figures as UNVERIFIED — present (so a later
      // verification has a record to verify against) but labeled
      // unestablished, under UNKNOWN determinacy. (If the mutation
      // returned no transaction at all — not reachable under the
      // adapter's prorated_immediately mode — the immediate
      // candidate is omitted entirely rather than fabricated.)
      const candidate: CommercialEffect = {
        ...(mutationTransaction ? { immediate: immediateParts(mutationTransaction.incurredAmount) } : {}),
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
        // Correction P1: built from the mutation response alone —
        // NO further provider read (see
        // snapshotFromMutationResponse). Recording this receipt
        // must never depend on a read succeeding after the
        // mutation has landed.
        snapshot: snapshotFromMutationResponse(mutationSub),
      };
    }

    const committedEffect: CommercialEffect = {
      immediate: immediateParts(readIncurred),
      recurring: recurringFrom(readSub),
      ...(quoted.term ? { term: quoted.term } : {}),
      effectiveAt: quoted.effectiveAt,
      determinacy: { immediateFinancialEffect: "DETERMINED", recurringFinancialEffect: "DETERMINED" },
      provenance: {
        immediate: provImmediateCommitted(mutationTransaction.id),
        recurring: PROV_RECURRING_COMMITTED,
        committedSource: "provider_actual",
      },
    };
    const snap = snapshotOf(readSub);

    // M3 divergence signal: the subscription's latest transaction
    // is no longer THIS mutation's — a later mutation intervened
    // between this commit's mutation and its read.
    const latestId = this.sim.latestTransactionId(subscriptionId);
    const interveningTransactionId = latestId !== null && latestId !== mutationTransaction.id ? latestId : undefined;

    // The verification itself — state match and reconciliation —
    // is COMPUTED by the PR-1 establishment procedure from this
    // adapter-constructed observation, never asserted here.
    const observation: ProviderObservation = {
      subscriptionRef: subscriptionId,
      committedEffect,
      resultingSnapshot: snap,
      source:
        `paddle-adapter post-commit read: simulator get(subscription) + retrieveTransaction(${mutationTransaction.id}) — ` +
        `the transaction THIS mutation generated, bound by id; no latest-transaction pointer is used for financial ` +
        `actuals (synthetic simulator observation)`,
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
            `bound-transaction actual and the recurring figure reports the observed state; the mutation has ` +
            `already occurred and cannot be rolled back by this reconciliation.`,
        },
        status: "COMMITTED",
        outcome: "COMMITTED_AND_VERIFIED",
        snapshot: snap,
      };
    }
    if (evidence.stateVerification === "VERIFIED" && interveningTransactionId !== undefined) {
      // M3: the observed state still matches this commit's intent,
      // but a concurrent mutation generated a later transaction in
      // the meantime — the state was not produced by this commit
      // alone, so its attribution to this commit is UNVERIFIED.
      // The recorded figures remain this commit's bound-transaction
      // actuals; nothing is taken from the intervening transaction.
      return {
        effect: committedEffect,
        reconciliation: {
          status: "UNVERIFIED",
          reason:
            `a concurrent mutation intervened between this commit's mutation and its verification read: the ` +
            `subscription's latest transaction is ${interveningTransactionId}, not this commit's bound transaction ` +
            `${mutationTransaction.id}, so the observed post-commit state was not produced by this commit alone ` +
            `and cannot be attributed to it. The recorded financial figures are this commit's own ` +
            `bound-transaction actuals, read by id; no figure was taken from the intervening transaction.`,
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

  /**
   * v0.6.2 (PR-4): establishes a CANCEL commit's committed effect.
   *
   * Cancellation figures are defined by the protocol (CORE-2):
   * immediate is NOT_APPLICABLE (no immediate financial event) and
   * the post-cancellation recurring level is 0 once effective, so
   * committed := quoted, labeled defined_equal_exact — but ONLY
   * after the cancellation's STATE is independently verified from
   * a post-commit re-read of the subscription record (the adapter
   * owns this establishment because the PR-1 machinery's generic
   * snapshot check cannot see a cancellation schedule — the F3
   * limitation; the sim's subscription record carries
   * `scheduledChange`, so the richer read is available here):
   *
   *  - IMMEDIATE intent: the re-read status must be the terminal
   *    "canceled" — kind TERMINAL. A non-terminal read is an
   *    established contradiction: MISMATCH.
   *  - TERM_END intent: the re-read must carry the SCHEDULED
   *    cancellation — `scheduledChange.action === "cancel"` with
   *    its effective date equal to the QUOTED effective date (the
   *    boundary recorded on the quote at quote time) — while the
   *    subscription is still active (kind SCHEDULED). A terminal
   *    read establishes the cancellation (kind TERMINAL) ONLY
   *    once that quoted boundary has been reached; a terminal
   *    read BEFORE it is a premature termination — the provider
   *    ended the subscription earlier than the quoted effective
   *    date, a different outcome than the one quoted — and is an
   *    established contradiction: MISMATCH (PR #11 review
   *    correction P3; previously any terminal read verified, and
   *    the scheduled date was compared against the record's
   *    current period end, which a later change can drift). A
   *    still-active subscription WITHOUT the scheduled change, or
   *    with a different effective date, is likewise MISMATCH.
   *  - MISMATCH (D3): a determined negative verification —
   *    COMMITTED / COMMITTED_AND_VERIFIED with a VIOLATED
   *    reconciliation, and the committed figures honestly report
   *    the OBSERVED state (the still-active price level), never a
   *    fabricated post-cancel zero.
   *  - Re-read unavailable: landing is established (the cancel
   *    call returned) but verification is not —
   *    COMMITTED_UNVERIFIED with candidate figures labeled
   *    unestablished under UNKNOWN determinacy. Correction P1:
   *    this path is constructed entirely from data already in
   *    hand (its snapshot is `snapshotFromMutationResponse`, no
   *    provider read), so recording it never depends on a further
   *    successful read after the mutation has landed.
   */
  private establishCancelCommit(
    validated: StoredQuote,
    effectiveFrom: "immediately" | "next_billing_period",
    mutationSub: PaddleSubscription
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
    const snapshotOf = (sub: PaddleSubscription): SubscriptionSnapshot => {
      const s = snapshotFrom(sub);
      s.version = this.sim.fingerprint(subscriptionId);
      return s;
    };

    let readSub: PaddleSubscription | undefined;
    try {
      readSub = this.sim.get(subscriptionId);
    } catch {
      readSub = undefined;
    }

    if (!readSub) {
      const candidate: CommercialEffect = {
        recurring: {
          previousAmount: quoted.recurring?.previousAmount,
          resultingAmount: 0,
          currency: quoted.recurring?.currency ?? "USD",
          ...(quoted.recurring?.cadence ? { cadence: quoted.recurring.cadence } : {}),
        },
        ...(quoted.term ? { term: quoted.term } : {}),
        effectiveAt: quoted.effectiveAt,
        determinacy: { immediateFinancialEffect: "UNKNOWN", recurringFinancialEffect: "UNKNOWN" },
        provenance: {
          recurring:
            "candidate figure: the quoted post-cancellation level, reported by the mutating call's own response path; the independent post-commit re-read was unavailable, so the cancellation's landing is NOT independently established",
          committedSource: "unestablished",
          applicabilityCitations: {
            immediateFinancialEffect: { action: "CANCEL", dimension: "immediateFinancialEffect" },
          },
        },
      };
      return {
        effect: candidate,
        reconciliation: {
          status: "UNVERIFIED",
          reason:
            "the cancel call returned (landing established from its response) but the independent post-commit " +
            "re-read of the subscription was unavailable, so the cancellation state could not be verified; the " +
            "recorded figures are candidates, pending a later verification",
          undeterminedDimensions: ["immediateFinancialEffect", "recurringFinancialEffect"],
        },
        status: "COMMITTED_UNVERIFIED",
        outcome: "COMMITTED_UNVERIFIED",
        // Correction P1: built from the mutation response alone —
        // NO further provider read (see
        // snapshotFromMutationResponse). Recording this receipt
        // must never depend on a read succeeding after the
        // mutation has landed.
        snapshot: snapshotFromMutationResponse(mutationSub),
      };
    }

    const snap = snapshotOf(readSub);
    let verifiedKind: "TERMINAL" | "SCHEDULED" | undefined;
    let mismatchReason: string | undefined;
    if (effectiveFrom === "immediately") {
      if (readSub.status === "canceled") {
        verifiedKind = "TERMINAL";
      } else {
        mismatchReason =
          `the post-commit re-read shows subscription status "${readSub.status}", not the terminal "canceled" ` +
          `state an immediate cancellation must produce`;
      }
    } else {
      // TERM_END: do NOT require a terminal state now — verify the
      // SCHEDULED cancellation itself, against the QUOTED
      // effective date: the boundary recorded on the quote at
      // quote time (`quoted.effectiveAt`). Correction P3: the
      // comparison reference is the quoted date, NOT the record's
      // current billing-period end — the record's period end can
      // drift after quoting, and a scheduled date that merely
      // matches a drifted period end is not the cancellation that
      // was quoted.
      const quotedEffectiveAt = quoted.effectiveAt;
      if (readSub.status === "canceled") {
        // A terminal read establishes the cancellation ONLY once
        // the quoted boundary has been reached (the scheduled
        // cancellation has taken effect). A terminal state
        // observed BEFORE the boundary is a PREMATURE termination:
        // the subscription was ended earlier than the quoted
        // effective date, which is a different outcome than the
        // scheduled cancellation that was quoted — an established
        // contradiction (MISMATCH), never a verified scheduled
        // cancellation. (The sim's clock is the provider clock for
        // this comparison; the quoted date is a provider-domain
        // timestamp recorded at quote time.)
        if (quotedEffectiveAt !== undefined && this.sim.currentTime().getTime() >= Date.parse(quotedEffectiveAt)) {
          verifiedKind = "TERMINAL"; // boundary reached — the scheduled cancellation is in effect
        } else {
          mismatchReason =
            `the post-commit re-read shows the subscription in the terminal "canceled" state BEFORE the ` +
            `quoted TERM_END effective boundary (${quotedEffectiveAt}) — a premature termination: the ` +
            `subscription was ended earlier than the effective date this commit was quoted for, which is a ` +
            `different outcome than the scheduled cancellation quoted`;
        }
      } else if (
        readSub.scheduledChange?.action === "cancel" &&
        quotedEffectiveAt !== undefined &&
        readSub.scheduledChange.effectiveAt === quotedEffectiveAt &&
        readSub.status === "active"
      ) {
        verifiedKind = "SCHEDULED";
      } else if (!readSub.scheduledChange) {
        mismatchReason =
          `the post-commit re-read shows NO scheduled cancellation on a still-active subscription — the ` +
          `TERM_END cancellation this commit dispatched is absent from the provider record`;
      } else {
        mismatchReason =
          `the post-commit re-read shows a scheduled change (action ${readSub.scheduledChange.action}, effective ` +
          `${readSub.scheduledChange.effectiveAt}) that does not match the quoted scheduled cancellation's ` +
          `effective date (${quotedEffectiveAt})`;
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
          resultingAmount: readSub.items.reduce((s, i) => s + i.price.unitAmount * i.quantity, 0),
          currency: readSub.currencyCode,
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
            `${mismatchReason}. The committed recurring figure reports the observed state; the mutation has ` +
            `already occurred and cannot be rolled back by this reconciliation.`,
        },
        status: "COMMITTED",
        outcome: "COMMITTED_AND_VERIFIED",
        snapshot: snap,
      };
    }

    // Verified: the figures are the quoted figures BY PROTOCOL
    // DEFINITION (no proration component exists to drift), now
    // backed by the established state — honestly labeled
    // defined_equal_exact, with the verification kind recorded.
    const committedEffect: CommercialEffect = {
      ...quoted,
      provenance: {
        ...quoted.provenance,
        recurring:
          `${PROV_CANCEL_RECURRING_QUOTE} — established at commit by the post-commit re-read: ` +
          (verifiedKind === "TERMINAL"
            ? effectiveFrom === "next_billing_period"
              ? `the subscription reads in the terminal "canceled" state at/after the quoted effective boundary ` +
                `(${quoted.effectiveAt}) — the scheduled cancellation has taken effect (verification kind TERMINAL)`
              : `the subscription reads in the terminal "canceled" state (verification kind TERMINAL)`
            : `the scheduled cancellation is present with effective date ${readSub.scheduledChange?.effectiveAt} ` +
              `(the quoted effective date) on a still-active subscription (verification kind SCHEDULED)`),
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
  if (e instanceof PaddleSimError) {
    if (e.type === "entity_not_found") return new SCQError("SUBSCRIPTION_NOT_FOUND", `Subscription ${subscriptionId} not found`, e);
    return new SCQError("PROVIDER_ERROR", e.message, e);
  }
  if (e instanceof SCQError) return e;
  return new SCQError("PROVIDER_ERROR", String(e));
}

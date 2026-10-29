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
import { QuoteStore, type StoredQuote } from "../store/quote-store.js";
import {
  ChargebeeSim,
  ChargebeeSimError,
  type ChargebeeMutationArtifact,
  type ChargebeeSubscription,
  type EstimateResult,
  type UpdateForItemsInput,
} from "./chargebee-sim.js";

const QUOTE_TTL_MS = 5 * 60 * 1000;

type ChargebeePreviewInput =
  | { kind: "update"; input: UpdateForItemsInput }
  | { kind: "cancel"; endOfTerm: boolean };

const OFFERING_TO_ITEM_PRICE: Record<string, string> = {
  "plan:basic:monthly": "ip_seat_basic_monthly",
  "plan:pro:monthly": "ip_seat_pro_monthly",
  "plan:basic:annual": "ip_seat_basic_annual",
};

/** The modeled item-price catalog, mirrored from chargebee-sim.ts (the adapter already kept its own copy for snapshot construction pre-migration). */
const ITEM_PRICE_LOOKUP: Record<string, { unitAmount: number; currency: string; billingPeriodUnit: "month" | "year" }> = {
  ip_seat_basic_monthly: { unitAmount: 1000, currency: "usd", billingPeriodUnit: "month" },
  ip_seat_pro_monthly: { unitAmount: 1500, currency: "usd", billingPeriodUnit: "month" },
  ip_seat_basic_annual: { unitAmount: 10000, currency: "usd", billingPeriodUnit: "year" },
};

/**
 * Capability source of truth for the SIMULATOR-BACKED Chargebee adapter.
 * `getCapabilities()` and the enforcement functions in createChangeQuote
 * all call this SAME function.
 *
 * Phase 2A correction (2026-10-27, see
 * research/chargebee-live-v1/CLAIM-CORRECTION-MATRIX.md and
 * API-CONTRACT-AUDIT.md A6/A8): the pre-correction values claimed EXACT
 * on both financial dimensions for every action, EXACT termEffect for
 * CHANGE_QUANTITY, EXACT effectiveAt, and supportedEffectiveIntents
 * ["IMMEDIATE", "TERM_END", "DATE"] for every action. Current Chargebee
 * Product Catalog 2.0 documentation does NOT establish those claims:
 *
 * - Financial dimensions are REVALIDATE, not EXACT. No estimate-pinning
 *   or replay mechanism is documented for the estimate->update pair, and
 *   `effective_from` is NOT a documented `update_for_items` parameter
 *   (it is the required parameter of Create-a-ramp). This adapter now
 *   matches the posture of the experimental live adapter in the
 *   unpublished Change B (REVALIDATE / REVALIDATE). One
 *   historical live case where estimate and commit agreed ($840,
 *   research/EVIDENCE.md item 1) is a single observation, not a
 *   guarantee mechanism. NOTE the language discipline: undocumented
 *   pinning is NOT ESTABLISHED — this correction does not claim proof
 *   that no equivalent mechanism exists anywhere; it claims only that
 *   none is documented for this endpoint pair, so EXACT is not an
 *   honest advertisement.
 * - termEffect is UNKNOWN for every action at this coarse level.
 *   CHANGE_QUANTITY previously claimed EXACT; documented term
 *   interactions (force_term_reset, automatic term reset on billing-
 *   period change, contract-term parameters) mean term consequences
 *   are not fully derivable from the estimate/update pair. The ONE
 *   quote-level exception is CANCEL on an evergreen subscription —
 *   see quoteLevelCancelTermCoverage.
 * - effectiveAt is REVALIDATE, not EXACT, for the same reason as the
 *   financial dimensions.
 * - Scheduling: deprecated-but-documented is NOT the same as
 *   supported-by-this-adapter. `end_of_term` and
 *   `change_option=specific_date`/`changes_scheduled_at` (future) on
 *   `update_for_items` are documented but DEPRECATED in favor of Ramps
 *   (Early Access, site-gated, a separate resource this adapter does
 *   not call). DATE is therefore refused for every action, and
 *   TERM_END is refused for the update-backed actions
 *   (CHANGE_QUANTITY/CHANGE_PLAN/CHANGE_CADENCE) — the simulator never
 *   modeled `end_of_term` as the distinct boolean the real endpoint
 *   takes; it folded TERM_END into a timestamp parameter that is not
 *   documented on that endpoint (see chargebee-sim.ts).
 * - CANCEL keeps ["IMMEDIATE", "TERM_END"]: `end_of_term=true` on the
 *   SEPARATE `cancel_for_items` endpoint is also deprecated-adjacent
 *   in current docs, but it is the mechanism that was historically
 *   observed working in the prior v0.5-LIVE cycle (limited historical
 *   research against a real test site — see research/EVIDENCE.md
 *   items 3-4), and the simulator models that endpoint's boolean
 *   faithfully rather than folding it into another parameter. It is
 *   retained as deprecated-but-documented + historically observed,
 *   with financial coverage downgraded to REVALIDATE like everything
 *   else, so an overall EXACT request is still refused for CANCEL.
 */
/**
 * Scheduling taxonomy (Phase 2B, 2026-10-27 — canonical table in
 * spec/ERRATA-v0.6.1.md §6; every advertised Chargebee scheduling
 * capability carries exactly one classification):
 * - IMMEDIATE (all actions, this adapter): Supported and tested.
 * - TERM_END for CANCEL (cancel_for_items `end_of_term`): Documented
 *   but deprecated (retained under that label; historically observed).
 * - TERM_END for update-backed actions: Unsupported by the current
 *   adapter (mechanism documented but deprecated; refused).
 * - DATE via update_for_items: Unsupported by the current adapter
 *   (deprecated paths refused; `effective_from`-on-update NOT
 *   ESTABLISHED).
 * - DATE/TERM_END via Ramps: Site-feature-dependent or early-access
 *   (not implemented).
 * - CANCEL on a committed-term subscription: Site-feature-dependent
 *   (Contract Terms feature; UNVERIFIED).
 */
function capabilitiesFor(action: ChangeAction): ActionCapabilities {
  const guaranteeCoverage: GuaranteeCoverage = {
    immediateFinancialEffect: "REVALIDATE",
    recurringFinancialEffect: "REVALIDATE",
    termEffect: "UNKNOWN",
    effectiveAt: "REVALIDATE",
  };
  return {
    guaranteeCoverage,
    supportedEffectiveIntents: action === "CANCEL" ? ["IMMEDIATE", "TERM_END"] : ["IMMEDIATE"],
  };
}

/**
 * v0.6 CORRECTION — do not design around the v0.5 simulator's result.
 *
 * v0.5's simulator claimed committed-term CANCEL resolves EXACT on
 * Chargebee (a "Chargebee is stronger than Zuora here" finding). The
 * v0.5-LIVE research cycle attempted to verify this against a real
 * Chargebee test site and could NOT: the site did not have the Contract
 * Terms feature enabled, `contract_term` creation was rejected with
 * `400 invalid_request`, and no subscription on the site carried a
 * contract_term. The evergreen case WAS verified live (estimate and
 * commit agreed exactly, no fee) — see research-findings.md v0.5-LIVE
 * Experiment 3. The committed-term case remains explicitly:
 *
 *     UNVERIFIED — Contract Terms feature not enabled on test site.
 *
 * This function reflects that honestly, for the termEffect DIMENSION
 * ONLY: evergreen resolves EXACT (the term outcome of cancelling an
 * evergreen subscription — no commitment created, auto-renew off — was
 * observed in the limited historical v0.5-LIVE research); a subscription
 * WITH a contract_term resolves UNKNOWN, not EXACT — the type system's
 * only conservative choice, since GuaranteeCoverage.termEffect has no
 * third "UNVERIFIED" value and claiming EXACT for an unverified case
 * would be exactly the mistake this correction exists to prevent. If a
 * future cycle verifies real committed-term Chargebee CANCEL behavior
 * against a site with Contract Terms enabled, THIS is the function to
 * update — with real evidence, not inference.
 *
 * Phase 2A note: this EXACT applies to termEffect alone. Since Phase 2A
 * the financial dimensions of a CANCEL quote are REVALIDATE (see
 * capabilitiesFor), so an evergreen CANCEL quote no longer backs an
 * overall EXACT request — overall EXACT requires every dimension.
 */
function quoteLevelCancelTermCoverage(sub: ChargebeeSubscription): "EXACT" | "UNKNOWN" {
  return sub.contractTerm ? "UNKNOWN" : "EXACT";
}

/**
 * Chargebee's documented `update_for_items` accepts a full item list in
 * one call, so quantity AND plan/cadence swaps bundle into a single
 * provider request in this model — MultiChangeConsistency "ATOMIC" here
 * means single-request bundling in the simulator model, NOT a provider
 * compare-and-swap or transactional guarantee (consistencyGuarantee
 * remains BEST_EFFORT). Note the documented replacement caveats the
 * simulator does not model: `replace_items_list` defaults to false
 * (additive) on the real API, and mandatory addons behave specially
 * (see API-CONTRACT-AUDIT.md A9 and the experimental live adapter in
 * the unpublished Change B). CANCEL is a
 * distinct endpoint (`cancel_for_items`) that cannot be combined with
 * an update_for_items call in the same request — bundling CANCEL with
 * anything else is UNSUPPORTED.
 */
function multiChangePairSupport(a: ChangeAction, b: ChangeAction): MultiChangeConsistency {
  if (a === "CANCEL" || b === "CANCEL") return "UNSUPPORTED";
  return "ATOMIC";
}

// ---------------------------------------------------------------------------
// v0.6.2 (PR-6) financial-semantics helpers.
//
// §3.11 / CORE-3: `CommercialEffect.immediate` is ONLY the net
// obligation the change itself incurs at its effective time — for an
// update, the estimate's invoice line-item net for the exact final
// request. Chargebee surfaces several economically distinct figures
// around an invoice (amount due, customer balance/credits applied,
// next-invoice projections); NONE of them is the incurred obligation,
// and none is ever carried in `immediate` or `recurring` here (the
// simulator's estimate models only the incurred line items and the
// resulting price level — there is no payment-side figure in this
// model to confuse them with, and this adapter invents none).
//
// The estimate's figures have three distinct states per dimension,
// kept distinct end to end:
//   - a finite number: DETERMINED — including an established 0,
//     which is emitted as a present `{ net: 0 }`, never re-encoded
//     as absent (the pre-migration build path dropped a zero net
//     into `undefined` in every branch, and combineEffects summed
//     per-change deltas with `(e.immediate?.net ?? 0)` — finding
//     F-2; both behaviors are eliminated);
//   - absent from the estimate: UNKNOWN — no figure emitted, never
//     zero-filled (the simulator withholds a figure when a priced
//     item is missing from its modeled catalog — the pre-migration
//     sim priced such an item at a silent 0 in its recurring sums);
//   - the cancellation consequence of a committed-term subscription
//     whose contract has not ended: UNKNOWN by the sim's own
//     `earlyTerminationChargeKnown` signal — the sim's pro-rata
//     formula is a simulator invention (see chargebee-sim.ts), so
//     its output is a modeled candidate, never an established
//     figure, and the adapter never quotes it as one (probe F).
// This adapter asserts NOT_APPLICABLE for NO Chargebee dimension:
// the cancel estimate always either establishes the immediate
// amount (an established zero) or leaves it UNKNOWN — there is no
// Chargebee action whose financial dimension "does not arise" in
// this provider model, so the §3.10 license is never invoked here.
// ---------------------------------------------------------------------------

const PROV_IMMEDIATE_QUOTE =
  "simulator estimate of the exact final update_for_items request (previewUpdate over the stored request): net of the estimate's invoice line items — the obligation the change itself incurs at its effective time (estimate.netImmediate)";
const PROV_IMMEDIATE_WITHHELD =
  "UNESTABLISHED: the simulator estimate omitted its immediate figure entirely (a priced item is missing from the modeled catalog, or the estimate surface withheld it), so no incurred obligation could be established — the dimension is UNKNOWN, not zero";
const PROV_RECURRING_QUOTE =
  "simulator estimate of the exact final update_for_items request: the post-change price level over the FULL final item list — every changed and unchanged item priced from the modeled catalog (estimate.resultingRecurringAmount)";
const PROV_RECURRING_WITHHELD =
  "UNESTABLISHED: the simulator estimate omitted its resulting recurring figure entirely — the dimension is UNKNOWN, not zero";
const PROV_CANCEL_IMMEDIATE_KNOWN =
  "simulator cancel estimate (previewCancel): the cancellation's termination consequence is established for this subscription (no contract term, or the cancellation does not precede the contract end) and its immediate amount is an established zero — no early-termination charge arises";
const PROV_CANCEL_FEE_UNKNOWN =
  "UNESTABLISHED: this subscription carries a contract term and the cancellation precedes the contract end; whether an early-termination charge applies — and its amount — is NOT established. The simulator's pro-rata formula is a simulator invention, not documented Chargebee behavior (see chargebee-sim.ts); its candidate output is never quoted as a figure. The dimension is UNKNOWN — never the formula's number, never zero";
const PROV_CANCEL_RECURRING_QUOTE =
  "post-cancellation price level: cancellation leaves no billable recurring obligation once effective, so the resulting recurring amount is a determined zero";
/** M3: the committed immediate's provenance NAMES the bound mutation artifact. */
function provImmediateCommitted(artifactId: string): string {
  return (
    `post-commit actual: netImmediate recorded on persisted mutation artifact ${artifactId} — the update operation THIS ` +
    `mutation dispatched, bound by its id and read back via retrieveMutation after the mutation (a provider-side read, ` +
    `not an estimate and not the mutation response); no latest-mutation pointer was used`
  );
}
/**
 * Z3 (PR #14 doctrine, applied here): the recurring provenance on a
 * BROKEN-attribution receipt. The re-read post-commit recurring
 * level was not produced by this commit alone, so no committed
 * recurring figure is established for this commit; the observed
 * level survives only as context (resulting snapshot /
 * reconciliation reason), never as a figure on the effect.
 */
const PROV_RECURRING_UNATTRIBUTED =
  "UNESTABLISHED for this commit: the fingerprint bracket around this commit's operation is broken, so the recurring level read back from the post-commit subscription was not produced by this commit alone — it is third-party-influenced observed state, retained only as unattributed context in the resulting snapshot and the reconciliation reason. No committed recurring figure is established for this commit; the bound mutation artifact establishes this commit's IMMEDIATE actual only (see the immediate provenance)";
const PROV_RECURRING_COMMITTED =
  "post-commit actual: sum over the re-read post-commit subscription's items (modeled catalog unit price x quantity), read back behind the closed fingerprint attribution bracket";
const PROV_CANCEL_RECURRING_COMMITTED =
  "post-cancellation price level: cancellation leaves no billable recurring obligation once effective, so the resulting recurring amount is a determined zero";

/**
 * The subscription's recurring price level, STRICTLY: undefined
 * when ANY item's price is missing from the modeled catalog. (The
 * pre-migration snapshot/recurring sums priced a missing item at a
 * silent 0 — probe E. A level that cannot be priced in full is not
 * a level.)
 */
function recurringTotalStrict(sub: ChargebeeSubscription): number | undefined {
  let total = 0;
  for (const i of sub.subscriptionItems) {
    const price = ITEM_PRICE_LOOKUP[i.itemPriceId];
    if (!price) return undefined;
    total += price.unitAmount * i.quantity;
  }
  return total;
}

function snapshotFrom(sub: ChargebeeSubscription): SubscriptionSnapshot {
  const totalRecurring = recurringTotalStrict(sub);
  const firstPrice = ITEM_PRICE_LOOKUP[sub.subscriptionItems[0]?.itemPriceId];
  return {
    id: sub.id,
    version: "", // filled by caller using fingerprint — Chargebee has no native version field, see chargebee-sim.ts
    status: sub.status === "active" ? "active" : sub.status === "cancelled" ? "canceled" : "active",
    items: sub.subscriptionItems.map((i) => ({
      id: i.id,
      offeringRef: Object.entries(OFFERING_TO_ITEM_PRICE).find(([, ip]) => ip === i.itemPriceId)?.[0] ?? i.itemPriceId,
      quantity: i.quantity,
    })),
    billing: {
      currency: firstPrice?.currency ?? "usd",
      // v0.6.2 (CORE-7): the total is labeled with the determinacy
      // its producer actually established. When an item's price is
      // missing from the modeled catalog the figure is WITHHELD
      // and the state reads UNKNOWN — the pre-migration code
      // emitted the partial sum with the missing item priced at a
      // silent 0 and no label at all (probe E).
      ...(totalRecurring !== undefined ? { recurringAmount: totalRecurring } : {}),
      recurringAmountState: totalRecurring !== undefined ? "DETERMINED" : "UNKNOWN",
      cadence: firstPrice?.billingPeriodUnit === "year" ? "ANNUAL" : "MONTHLY",
      nextBillingAt: sub.nextBillingAt ?? undefined,
    },
    term: {
      // UNLIKE Stripe/Paddle, and similarly to Zuora, Chargebee CAN carry
      // a real contract_term object — but UNLIKE Zuora, it's opt-in, not
      // present on every subscription. When absent (evergreen), UNKNOWN is
      // correct because there genuinely is no commitment concept active,
      // matching Stripe/Paddle's posture for THAT subscription.
      commitmentUntil: sub.contractTerm ? sub.contractTerm.contractEnd : "UNKNOWN",
      autoRenew: sub.scheduledCancellationAt ? false : sub.contractTerm ? sub.contractTerm.actionAtTermEnd !== "cancel" : true,
    },
  };
}

/**
 * Builds the immediate {charge, credit, net} shape from estimate /
 * artifact line items: charge/credit are the sums of the positive /
 * negative items — the incurred obligation's own components — and
 * net is the established total. Zero components are OMITTED (an
 * absent charge key means no charges were incurred), while a zero
 * NET is a present `{ net: 0 }`.
 */
function immediateFromLineItems(
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

/** Net-only shape for a figure whose itemization is unavailable. */
function immediateParts(net: number): NonNullable<CommercialEffect["immediate"]> {
  return {
    ...(net > 0 ? { charge: net } : {}),
    ...(net < 0 ? { credit: -net } : {}),
    net,
  };
}

/** Key-order-insensitive JSON for comparing a persisted artifact's request against the request a commit dispatched. */
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

/**
 * v0.6.2 (PR-6, correction principle M2 — as applied to Stripe in
 * PR #10, Paddle in PR #11, Zuora in PR #14): adapter-level
 * determinacy gate for commits. The frozen v0.6.1 acceptance
 * envelope coerces absent figures to 0 (§14.6-pinned behavior), so
 * an effect whose incurred figure is UNKNOWN — at quote time, or
 * in the commit-time revalidation — could pass the gate and
 * proceed to MUTATE: the adapter would commit a change whose
 * financial effect it does not know. Fail-closed treatment of
 * UNKNOWN in the shared envelope is BC-1, a separately gated
 * activation; the engine is NOT changed here. Until then, THIS
 * adapter refuses such commits itself, before any mutating call,
 * with QUOTE_NOT_DETERMINISTIC.
 *
 * A dimension passes iff it is DETERMINED with a finite value.
 * This adapter asserts NOT_APPLICABLE for no Chargebee dimension
 * (see the helpers header), so there is no licensed-absence case
 * to pass here — anything else — UNKNOWN (including a legacy
 * payload's absent determinacy), an unjustified NOT_APPLICABLE,
 * or a DETERMINED assertion over a missing / non-finite value —
 * refuses the commit.
 */
function assertEffectDeterminateForCommit(effect: CommercialEffect, stage: "quoted" | "revalidated"): void {
  const states = determinacyOf(effect);
  const dimensions = [
    { dimension: "immediateFinancialEffect", state: states.immediateFinancialEffect, value: effect.immediate?.net },
    { dimension: "recurringFinancialEffect", state: states.recurringFinancialEffect, value: effect.recurring?.resultingAmount },
  ] as const;
  for (const { dimension, state, value } of dimensions) {
    if (state === "DETERMINED" && typeof value === "number" && Number.isFinite(value)) continue;
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
 * v0.6.2 (PR-6): resolves a proposal's update changes into the
 * FINAL `update_for_items` request item list — every change applied
 * against a coherent EVOLVING item state, so a later change
 * targeting the same item sees the prior change's result rather
 * than the original state, and unchanged items are carried through
 * at their current price/quantity (the resulting recurring level
 * covers them). The returned list is the exact request the quote
 * estimates and the commit dispatches, verbatim.
 *
 * (The pre-migration construction previewed each change separately
 * and summed the per-change immediate deltas — each computed
 * against the ORIGINAL subscription — double-counting overlapping
 * changes: probes A/B. Its recurring figure survived only because
 * "last preview wins" happened to carry the full list.)
 */
function resolveFinalItems(
  sub: ChargebeeSubscription,
  changes: ChangeSpec[]
): { items: Array<{ itemPriceId: string; quantity: number }>; includesCadenceChange: boolean } {
  const working = sub.subscriptionItems.map((i) => ({ itemPriceId: i.itemPriceId, quantity: i.quantity }));
  let includesCadenceChange = false;
  for (const change of changes) {
    switch (change.action) {
      case "CHANGE_QUANTITY": {
        const idx = sub.subscriptionItems.findIndex((i) => i.id === change.itemId);
        if (idx < 0) throw new SCQError("INVALID_PROPOSAL", `Item ${change.itemId} not found on subscription`);
        working[idx] = { itemPriceId: working[idx].itemPriceId, quantity: change.quantity };
        break;
      }
      case "CHANGE_PLAN": {
        const idx = sub.subscriptionItems.findIndex((i) => i.id === change.itemId);
        if (idx < 0) throw new SCQError("INVALID_PROPOSAL", `Item ${change.itemId} not found on subscription`);
        const itemPriceId = OFFERING_TO_ITEM_PRICE[change.offeringRef];
        if (!itemPriceId) throw new SCQError("UNSUPPORTED_CHANGE", `Unknown offeringRef ${change.offeringRef}`);
        // The swap carries forward the quantity the evolving state
        // holds for this item — an earlier in-proposal quantity
        // change is not reverted by the swap.
        working[idx] = { itemPriceId, quantity: working[idx].quantity };
        break;
      }
      case "CHANGE_CADENCE": {
        includesCadenceChange = true;
        const itemPriceId = OFFERING_TO_ITEM_PRICE[change.cadence === "ANNUAL" ? "plan:basic:annual" : "plan:basic:monthly"];
        working[0] = { itemPriceId, quantity: working[0].quantity };
        break;
      }
      case "CANCEL":
        throw new SCQError("INVALID_PROPOSAL", "CANCEL cannot be combined with other changes in one Chargebee proposal");
    }
  }
  return { items: working, includesCadenceChange };
}

/**
 * Builds the v0.6.2 commercial effect for an update from ONE
 * estimate of the final request (see the helpers header for the
 * three-state discipline).
 */
function buildUpdateEffect(
  estimate: EstimateResult,
  ctx: { previousRecurring: number | undefined; effectiveAt: string; term?: CommercialEffect["term"] }
): CommercialEffect {
  const immediateFigure = (estimate as { netImmediate?: unknown }).netImmediate;
  const immediateDetermined = typeof immediateFigure === "number" && Number.isFinite(immediateFigure);
  const recurringFigure = (estimate as { resultingRecurringAmount?: unknown }).resultingRecurringAmount;
  const recurringDetermined = typeof recurringFigure === "number" && Number.isFinite(recurringFigure);

  const effect: CommercialEffect = { effectiveAt: ctx.effectiveAt };
  if (immediateDetermined) {
    // An established zero is a present { net: 0 } — never absent.
    // The charge/credit parts come from the estimate's invoice
    // line items (the obligation's own components).
    effect.immediate = immediateFromLineItems(estimate.invoiceEstimateLineItems ?? [], immediateFigure as number);
  }
  effect.recurring = {
    ...(ctx.previousRecurring !== undefined ? { previousAmount: ctx.previousRecurring } : {}),
    ...(recurringDetermined ? { resultingAmount: recurringFigure as number } : {}),
    currency: "usd",
    cadence: estimate.resultingCadence,
  };
  if (ctx.term) effect.term = ctx.term;
  effect.determinacy = {
    immediateFinancialEffect: immediateDetermined ? "DETERMINED" : "UNKNOWN",
    recurringFinancialEffect: recurringDetermined ? "DETERMINED" : "UNKNOWN",
  };
  effect.provenance = {
    immediate: immediateDetermined ? PROV_IMMEDIATE_QUOTE : PROV_IMMEDIATE_WITHHELD,
    recurring: recurringDetermined ? PROV_RECURRING_QUOTE : PROV_RECURRING_WITHHELD,
  };
  return effect;
}

/**
 * Builds the v0.6.2 commercial effect for a pure CANCEL from the
 * cancel estimate. The immediate dimension is an established zero
 * when the sim's signal establishes the termination consequence,
 * and UNKNOWN when it does not (committed-term, canceling early) —
 * the sim's invented formula figure is never carried. Recurring is
 * the protocol-defined post-cancellation level: a DETERMINED zero.
 */
function buildCancelEffect(
  cancelPreview: { netImmediate?: number; earlyTerminationChargeKnown: boolean },
  sub: ChargebeeSubscription,
  effectiveAt: string
): CommercialEffect {
  const figure = (cancelPreview as { netImmediate?: unknown }).netImmediate;
  const known =
    cancelPreview.earlyTerminationChargeKnown === true && typeof figure === "number" && Number.isFinite(figure);
  const previousRecurring = recurringTotalStrict(sub);
  const firstPrice = ITEM_PRICE_LOOKUP[sub.subscriptionItems[0]?.itemPriceId];
  const effect: CommercialEffect = {
    ...(known ? { immediate: immediateParts(figure as number) } : {}),
    recurring: {
      ...(previousRecurring !== undefined ? { previousAmount: previousRecurring } : {}),
      resultingAmount: 0,
      currency: firstPrice?.currency ?? "usd",
      cadence: firstPrice?.billingPeriodUnit === "year" ? "ANNUAL" : "MONTHLY",
    },
    term: { createsCommitment: false, autoRenew: false },
    effectiveAt,
    determinacy: {
      immediateFinancialEffect: known ? "DETERMINED" : "UNKNOWN",
      recurringFinancialEffect: "DETERMINED",
    },
    provenance: {
      immediate: known ? PROV_CANCEL_IMMEDIATE_KNOWN : PROV_CANCEL_FEE_UNKNOWN,
      recurring: PROV_CANCEL_RECURRING_QUOTE,
    },
  };
  return effect;
}

/** Sorted item content for state-vs-intent comparison (item identity in this model is the item_price_id + quantity pair). */
function sortedItems(items: Array<{ itemPriceId: string; quantity: number }>): Array<{ itemPriceId: string; quantity: number }> {
  return items
    .map((i) => ({ itemPriceId: i.itemPriceId, quantity: i.quantity }))
    .sort((a, b) => (a.itemPriceId === b.itemPriceId ? a.quantity - b.quantity : a.itemPriceId < b.itemPriceId ? -1 : 1));
}

export class ChargebeeAdapter implements SubscriptionProvider {
  constructor(private sim: ChargebeeSim, private store: QuoteStore) {}

  getCapabilities(): ProviderCapabilities {
    return {
      quoteCapabilities: {
        CHANGE_QUANTITY: capabilitiesFor("CHANGE_QUANTITY"),
        CHANGE_PLAN: capabilitiesFor("CHANGE_PLAN"),
        CHANGE_CADENCE: capabilitiesFor("CHANGE_CADENCE"),
        CANCEL: capabilitiesFor("CANCEL"),
      },
      // No documented compare-and-swap precondition on
      // update_for_items/cancel_for_items (see chargebee-sim.ts) —
      // Chargebee sits in the SAME BEST_EFFORT bucket as
      // Stripe/Paddle/Zuora for this reason. (Phase 2A: the earlier
      // wording here cited "Zuora-like financial-EXACT coverage" as a
      // contrast; that coverage claim was not established and has been
      // corrected to REVALIDATE — see capabilitiesFor.)
      consistencyGuarantee: "BEST_EFFORT",
    };
  }

  async getSubscription(subscriptionId: string): Promise<SubscriptionSnapshot> {
    let sub: ChargebeeSubscription;
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
    let sub: ChargebeeSubscription;
    try {
      sub = this.sim.get(subscriptionId);
    } catch (e) {
      throw toSCQError(e, subscriptionId);
    }
    if (proposal.changes.length === 0) {
      throw new SCQError("INVALID_PROPOSAL", "proposal.changes must contain at least one change");
    }

    const now = this.sim.currentTime();
    const wallNow = new Date();

    const perChangeCapabilities = proposal.changes.map((c) => capabilitiesFor(c.action));
    for (const caps of perChangeCapabilities) {
      enforceEffectiveIntent(proposal.effectiveIntent, caps.supportedEffectiveIntents);
    }

    // Phase 2A: the enforceEffectiveIntent loop above has ALREADY
    // refused every intent this adapter does not support, so by this
    // point the only reachable cases are: IMMEDIATE for any action, and
    // TERM_END for a single CANCEL. DATE never reaches here (refused:
    // its previously claimed mechanism, `effective_from` on
    // `update_for_items`, is not a documented parameter of that
    // endpoint — it belongs to Create-a-ramp, Early Access, which this
    // adapter does not call), and TERM_END for update-backed actions
    // never reaches here either (refused: `end_of_term` on
    // `update_for_items` is documented but deprecated toward Ramps,
    // and the simulator never modeled it as the distinct boolean the
    // real endpoint takes). For CANCEL, TERM_END maps to the real
    // `end_of_term=true` boolean on `cancel_for_items` (Chargebee
    // itself determines the date — the current term boundary, no
    // timestamp is sent). The adapter therefore NEVER sends an
    // `effectiveFrom` to the simulator's update path after this
    // correction; that field remains in the sim input shape only so
    // the simulator's legacy scheduled-change model remains
    // exercisable at the sim layer, explicitly labeled simulator-only
    // there (see chargebee-sim.ts).
    const isTermEnd = proposal.effectiveIntent.type === "TERM_END";
    const effectiveAtIso = isTermEnd ? sub.currentTermEnd : now.toISOString();

    const fingerprint = this.sim.fingerprint(subscriptionId);
    const quoteId = `scq_chargebee_${crypto.randomBytes(8).toString("hex")}`;

    const multiChangeConsistency = computeMultiChangeConsistency(proposal.changes, multiChangePairSupport);
    enforceMultiChangeConsistency(proposal.changes, multiChangeConsistency);
    // v0.6 normative rule: this adapter never submits update_for_items and
    // cancel_for_items parameters together, and never sends a
    // cross-endpoint bundle that Chargebee's real API might silently
    // partially apply (the v0.5-LIVE session confirmed LIVE that
    // unrecognized/foreign parameters on either endpoint are silently
    // dropped, HTTP 200, no error) — CANCEL+anything is refused above via
    // multiChangeConsistency instead of ever being attempted. No residual
    // partial-execution risk remains for what this adapter actually sends.
    enforceNoPartialExecutionRisk(proposal.changes, false);

    let previewInput: ChargebeePreviewInput;
    let commercialEffect: CommercialEffect;
    let guaranteeCoverage: GuaranteeCoverage;

    if (proposal.changes.length === 1 && proposal.changes[0].action === "CANCEL") {
      previewInput = { kind: "cancel", endOfTerm: isTermEnd };
      let cancelPreview: { netImmediate?: number; earlyTerminationChargeKnown: boolean };
      try {
        cancelPreview = this.sim.previewCancel(subscriptionId, isTermEnd);
      } catch (e) {
        throw toSCQError(e, subscriptionId);
      }
      commercialEffect = buildCancelEffect(cancelPreview, sub, effectiveAtIso);
      // Quote-level override — see quoteLevelCancelTermCoverage's v0.6
      // doc comment for why committed-term subscriptions now correctly
      // resolve UNKNOWN (UNVERIFIED live), not EXACT.
      guaranteeCoverage = { ...capabilitiesFor("CANCEL").guaranteeCoverage, termEffect: quoteLevelCancelTermCoverage(sub) };
    } else {
      // v0.6.2 (PR-6): resolve the WHOLE proposal into the final
      // update_for_items request against an evolving item state,
      // then take ONE estimate of that exact request and derive the
      // quoted effect from it alone. The stored request is verbatim
      // what commit dispatches: quoted request == mutation input,
      // by construction. (Pre-migration: per-change previews against
      // the original subscription, deltas summed — probes A/B/F-2.)
      const { items: finalItems, includesCadenceChange } = resolveFinalItems(sub, proposal.changes);
      const request: UpdateForItemsInput = { items: finalItems, prorate: true };
      previewInput = { kind: "update", input: request };
      let estimate: EstimateResult;
      try {
        estimate = this.sim.previewUpdate(subscriptionId, request);
      } catch (e) {
        throw toSCQError(e, subscriptionId);
      }
      commercialEffect = buildUpdateEffect(estimate, {
        previousRecurring: recurringTotalStrict(sub),
        effectiveAt: effectiveAtIso,
        // Preserved from the pre-migration shape: a cadence change
        // carries the term dimension (its consequence genuinely
        // UNKNOWN at this level — see capabilitiesFor); other
        // update shapes carry none.
        term: includesCadenceChange
          ? {
              createsCommitment: "UNKNOWN",
              commitmentUntil: "UNKNOWN",
              autoRenew: sub.contractTerm ? sub.contractTerm.actionAtTermEnd !== "cancel" : true,
            }
          : undefined,
      });
      guaranteeCoverage = computeCombinedCoverage(perChangeCapabilities.map((c) => c.guaranteeCoverage));
    }

    const effectiveMode = resolveGuaranteeMode(proposal);
    enforceGuaranteeRequest(proposal.changes, effectiveMode, guaranteeCoverage, proposal.acceptanceEnvelope);

    const expiresAt = new Date(wallNow.getTime() + QUOTE_TTL_MS).toISOString();
    const stored: StoredQuote<ChargebeePreviewInput> = {
      quote_id: quoteId,
      provider: "chargebee",
      subscription_id: subscriptionId,
      subscription_version_at_quote: fingerprint,
      proposal,
      effective_guarantee_mode: effectiveMode,
      guarantee_coverage: guaranteeCoverage,
      multi_change_consistency: multiChangeConsistency,
      provider_preview_input: previewInput,
      quoted_effect: commercialEffect,
      created_at: wallNow.toISOString(),
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
      providerMetadata: previewInput,
    };
  }

  async commitChangeQuote(quoteId: string): Promise<SubscriptionChangeReceipt> {
    // v0.6.1: idempotent replay checked before any read of live provider
    // state or mutating call — see checkIdempotentReplay's doc comment in
    // scq-engine.ts. DURABILITY LIMIT (Phase 2A, Task 6): that replay is
    // NOT indefinitely safe. It depends on the volatile in-memory
    // QuoteStore — after a process restart the receipt is unrecoverable
    // and this method can only fail closed (QUOTE_STALE below), never
    // prove the commit did not already happen. On the real API the only
    // native backstop is Chargebee's documented 30-minute idempotency
    // window, which this simulator adapter does not model at all. A
    // conforming deployment requires a durable transactional store
    // (LIMITATIONS-AND-GAPS.md D-3).
    const cached = checkIdempotentReplay(this.store, quoteId);
    if (cached) return cached;

    const quote = this.store.get(quoteId);
    if (!quote) {
      throw new SCQError("QUOTE_STALE", `No quote found for id ${quoteId}`);
    }

    // v0.6.2 (CORE-8): a prior attempt on this quote whose outcome was
    // INDETERMINATE (the mutation was dispatched but its landing is not
    // established) must never be blindly retried: the operation may
    // already have landed, and a second dispatch would double-apply it.
    // Refuse here, before any state read or mutation.
    if (quote.commit_outcome?.outcome === "INDETERMINATE") {
      throw new SCQError(
        "PROVIDER_ERROR",
        `Commit outcome for quote ${quoteId} is INDETERMINATE: a previous commit attempt's mutation was ` +
          `dispatched but its landing was not established. No second mutation was issued. Reconcile the ` +
          `provider state manually before any retry.`,
        { outcome: "INDETERMINATE", indeterminate: true, reconciled: false }
      );
    }

    // Same read/write separation and TOCTOU window as the other three
    // adapters — no compare-and-swap parameter exists on Chargebee's
    // update/cancel endpoints either (see chargebee-sim.ts), and no
    // adapter-local synchronization is used to hide that. What v0.6.2
    // adds is DETECTION with attribution discipline: the persisted
    // mutation artifact brackets its execution with the state
    // fingerprints it observed and produced, so a competing change in
    // either window is detectable at verification time and caps the
    // outcome at COMMITTED_UNVERIFIED (see establish* below) instead
    // of passing silently or being misattributed to this commit.
    let currentSub: ChargebeeSubscription;
    try {
      currentSub = this.sim.get(quote.subscription_id);
    } catch (e) {
      throw toSCQError(e, quote.subscription_id);
    }
    let currentFingerprint: string;
    try {
      currentFingerprint = this.sim.fingerprint(quote.subscription_id);
    } catch (e) {
      throw toSCQError(e, quote.subscription_id);
    }
    const validated = validateCommit(this.store, quoteId, currentFingerprint);

    const input = validated.provider_preview_input as ChargebeePreviewInput;
    const proposal = validated.proposal;
    const effectiveMode = validated.effective_guarantee_mode;
    const isCancel = input.kind === "cancel";

    // v0.6.2 (PR-6, M2): the QUOTED effect must be determinate before
    // this commit proceeds in ANY mode — the frozen v0.6.1 envelope
    // coerces absent figures to 0, so an UNKNOWN quoted figure (a
    // withheld estimate figure; a committed-term cancellation whose
    // termination consequence is not established) could otherwise
    // pass a loose envelope and mutate. This refusal happens before
    // the revalidation and before any mutating call.
    assertEffectDeterminateForCommit(validated.quoted_effect, "quoted");

    if (effectiveMode === "REVALIDATE") {
      // Order per spec: re-estimate -> determinacy gate -> evaluate
      // acceptance envelope -> mutate -> establish from post-commit
      // reads -> receipt. The revalidated effect is built from a
      // FRESH estimate of the exact stored request and is used ONLY
      // as this pre-mutation gate's input. It is quote-side data —
      // labeled revalidated_preview in its provenance — and is NEVER
      // assigned as the committed effect. (The pre-migration code
      // did exactly that assignment — finding F-1 — so post-commit
      // reconciliation compared the quote against the estimate that
      // gated the commit and could never detect a wrong landing.)
      if (!isCancel) {
        let freshEstimate: EstimateResult;
        try {
          freshEstimate = this.sim.previewUpdate(validated.subscription_id, input.input);
        } catch (e) {
          throw toSCQError(e, validated.subscription_id);
        }
        const revalidated = buildUpdateEffect(freshEstimate, {
          previousRecurring: validated.quoted_effect.recurring?.previousAmount,
          effectiveAt: validated.quoted_effect.effectiveAt ?? currentSub.currentTermEnd,
          term: validated.quoted_effect.term,
        });
        revalidated.provenance = {
          immediate:
            revalidated.determinacy?.immediateFinancialEffect === "UNKNOWN"
              ? "commit-time revalidated estimate could not establish its immediate figure — PRE-MUTATION GATE ONLY; never the committed actual"
              : "commit-time revalidated estimate of the stored update_for_items request (its invoice line-item net) — PRE-MUTATION GATE ONLY; never the committed actual",
          recurring: "commit-time revalidated estimate resulting recurring amount — gate only",
          committedSource: "revalidated_preview",
        };
        assertEffectDeterminateForCommit(revalidated, "revalidated");
        const violation = checkAcceptanceEnvelope(validated.quoted_effect, revalidated, proposal.acceptanceEnvelope!);
        if (violation) {
          throw new SCQError(
            "QUOTE_DRIFTED",
            `Recomputed commercial effect fell outside the caller's acceptance envelope: ${violation}. No mutation was performed.`,
            { quoted: validated.quoted_effect, revalidated, envelope: proposal.acceptanceEnvelope }
          );
        }
      } else {
        // CANCEL revalidation: re-run the cancel estimate — the
        // termination consequence must STILL be established at
        // commit time (the sim's signal is re-read; a consequence
        // that became unestablishable refuses here), then the
        // envelope gate where the caller stated one.
        let cancelPreview: { netImmediate?: number; earlyTerminationChargeKnown: boolean };
        try {
          cancelPreview = this.sim.previewCancel(validated.subscription_id, input.endOfTerm);
        } catch (e) {
          throw toSCQError(e, validated.subscription_id);
        }
        const revalidated = buildCancelEffect(cancelPreview, currentSub, validated.quoted_effect.effectiveAt ?? currentSub.currentTermEnd);
        revalidated.provenance = {
          immediate: "commit-time revalidated cancel estimate — PRE-MUTATION GATE ONLY; never the committed actual",
          recurring: "commit-time revalidated cancel estimate — gate only",
          committedSource: "revalidated_preview",
        };
        assertEffectDeterminateForCommit(revalidated, "revalidated");
        if (proposal.acceptanceEnvelope) {
          const violation = checkAcceptanceEnvelope(validated.quoted_effect, revalidated, proposal.acceptanceEnvelope);
          if (violation) {
            throw new SCQError(
              "QUOTE_DRIFTED",
              `Recomputed commercial effect fell outside the caller's acceptance envelope: ${violation}. No mutation was performed.`,
              { quoted: validated.quoted_effect, revalidated, envelope: proposal.acceptanceEnvelope }
            );
          }
        }
      }
    }

    let mutation: { subscription: ChargebeeSubscription; operationId: string; result?: EstimateResult };
    try {
      // The dispatch is the stored request verbatim — the same
      // request the quote estimated (updates: one update_for_items
      // call carrying the full final item list; cancels: the
      // separate cancel_for_items endpoint with its end_of_term
      // boolean — the two operations are never bundled).
      if (input.kind === "cancel") {
        const out = this.sim.cancelForItems(validated.subscription_id, input.endOfTerm);
        mutation = { subscription: out.subscription, operationId: out.operationId };
      } else {
        const out = this.sim.updateForItems(validated.subscription_id, input.input);
        mutation = { subscription: out.subscription, operationId: out.operationId, result: out.result };
      }
    } catch (e) {
      // v0.6.2 (CORE-5/CORE-8): a connection-class failure from the
      // mutating call means the request was dispatched but its
      // landing is NOT established — the operation may have fully
      // applied (the sim's lost-response fault models exactly
      // that). Classify INDETERMINATE, record the outcome, record
      // NO receipt, and refuse any blind retry (see the guard at
      // the top of this method). A rejection the sim raises BEFORE
      // applying anything is a CONFIRMED_NON_EXECUTION: the
      // operation provably never took effect, and the distinction
      // is recorded rather than collapsed into the indeterminate
      // class.
      if (e instanceof ChargebeeSimError && e.code === "api_connection_error") {
        this.store.recordCommitOutcome(quoteId, {
          outcome: "INDETERMINATE",
          at: new Date().toISOString(),
          details: { reason: "the mutating call's response was lost after dispatch; its landing is not established" },
        });
        throw new SCQError(
          "PROVIDER_ERROR",
          `Commit outcome is INDETERMINATE: the mutation request's response was lost, so whether the change ` +
            `landed is not established. No receipt was recorded and no second mutation was issued. Reconcile ` +
            `provider state manually before any retry.`,
          { outcome: "INDETERMINATE", indeterminate: true, reconciled: false }
        );
      }
      if (e instanceof ChargebeeSimError) {
        this.store.recordCommitOutcome(quoteId, {
          outcome: "CONFIRMED_NON_EXECUTION",
          at: new Date().toISOString(),
          details: { reason: `the mutation request was rejected before effect (${e.code}: ${e.message})` },
        });
        const mapped = toSCQError(e, validated.subscription_id);
        throw new SCQError(mapped.code, mapped.message, { outcome: "CONFIRMED_NON_EXECUTION", cause: e });
      }
      throw toSCQError(e, validated.subscription_id);
    }

    // --- v0.6.2 (PR-6): establish the committed effect from
    // post-commit evidence, independently of every estimate. ---
    const established =
      input.kind === "cancel"
        ? this.establishCancelCommit(validated, mutation, currentFingerprint)
        : this.establishCommittedEffect(validated, mutation, currentSub, currentFingerprint);

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
   * v0.6.2 (PR-6): establishes a non-CANCEL commit's committed
   * effect from POST-COMMIT state, independently of every estimate.
   *
   * The independent reads: a fresh `get` of the subscription plus
   * the MUTATION ARTIFACT this operation created, read back by its
   * id via `retrieveMutation`. (These are SYNTHETIC simulator
   * reads; the observation is constructed here, inside the adapter,
   * and never crosses a caller boundary.)
   *
   * M3 — OPERATION IDENTITY BINDING: the financial actuals come
   * from the persisted artifact THIS mutation created, bound by
   * the id the mutation returned — NEVER from an unqualified
   * latest-mutation pointer (a later/concurrent operation may
   * already have replaced it), never from the pre-mutation
   * revalidated estimate (finding F-1), and never from the mutation
   * response alone (the response's figures are candidates until
   * the artifact read confirms them).
   *
   * ATTRIBUTION (PR #14 doctrine Z1–Z3): Chargebee has no native
   * monotonic version, so attribution rests on the artifact's
   * fingerprint bracket: the state fingerprint the operation
   * observed when it began must equal the fingerprint THIS commit
   * validated, and the state fingerprint read back at verification
   * must equal the fingerprint the operation produced. A competing
   * change in the check→mutate window breaks the first equality; a
   * competing change in the mutate→verify window breaks the
   * second. Where the bracket does not close, the observed state
   * is not attributable to this commit alone and the outcome caps
   * at COMMITTED_UNVERIFIED — with the financial discipline of Z3:
   * the bound artifact's immediate stays (the scope that operation
   * establishes), while the recurring dimension is UNKNOWN with NO
   * figure, because the re-read level is third-party-influenced.
   *
   * Outcomes:
   *  - bracket closed + state matches intent: COMMITTED /
   *    COMMITTED_AND_VERIFIED, reconciliation from the core over
   *    established actuals.
   *  - bracket closed + state contradicts intent: COMMITTED /
   *    COMMITTED_AND_VERIFIED with a VIOLATED reconciliation
   *    (Decision D3 — a determined negative verification). The
   *    closed bracket is what makes the contradiction provably
   *    this operation's own wrong landing.
   *  - bracket broken: COMMITTED_UNVERIFIED / UNVERIFIED, whether
   *    the observed state matches or contradicts — any
   *    contradiction is recorded as unattributed context only.
   *  - a read unavailable, the bound artifact unavailable, or the
   *    artifact carrying no financial actuals:
   *    COMMITTED_UNVERIFIED with an UNVERIFIED reconciliation; the
   *    recorded figures are the mutation response's CANDIDATES,
   *    labeled unestablished under UNKNOWN determinacy — built
   *    ENTIRELY from data already in hand, so recording never
   *    depends on a further successful provider read after the
   *    mutation has landed (PR #11 correction P1).
   */
  private establishCommittedEffect(
    validated: StoredQuote,
    mutation: { subscription: ChargebeeSubscription; operationId: string; result?: EstimateResult },
    preState: ChargebeeSubscription,
    validatedFingerprint: string
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
    const input = validated.provider_preview_input as Extract<ChargebeePreviewInput, { kind: "update" }>;

    // Independent post-commit reads, bound to THIS mutation's artifact.
    let readSub: ChargebeeSubscription | undefined;
    let readArtifact: ChargebeeMutationArtifact | undefined;
    let currentFingerprint: string | undefined;
    try {
      readSub = this.sim.get(subscriptionId);
    } catch {
      readSub = undefined;
    }
    if (readSub) {
      try {
        const artifact = this.sim.retrieveMutation(mutation.operationId);
        if (artifact.subscriptionId === subscriptionId && artifact.kind === "update") readArtifact = artifact;
      } catch {
        readArtifact = undefined;
      }
      try {
        currentFingerprint = this.sim.fingerprint(subscriptionId);
      } catch {
        currentFingerprint = undefined;
      }
    }
    const artifactFiguresPresent =
      readArtifact !== undefined &&
      typeof readArtifact.netImmediate === "number" &&
      Number.isFinite(readArtifact.netImmediate) &&
      Array.isArray(readArtifact.invoiceEstimateLineItems);

    if (!readSub || !readArtifact || !artifactFiguresPresent || currentFingerprint === undefined) {
      // Verification unavailable: record the mutation response's
      // candidate figures as UNVERIFIED — present (so a later
      // verification has a record to verify against) but labeled
      // unestablished, under UNKNOWN determinacy. Built entirely
      // from data already in hand — NO further provider read.
      const resultNet = (mutation.result as { netImmediate?: unknown } | undefined)?.netImmediate;
      const candidateRecurring = recurringTotalStrict(mutation.subscription);
      const candidate: CommercialEffect = {
        ...(typeof resultNet === "number" && Number.isFinite(resultNet)
          ? {
              immediate: Array.isArray(mutation.result?.invoiceEstimateLineItems)
                ? immediateFromLineItems(mutation.result.invoiceEstimateLineItems, resultNet)
                : immediateParts(resultNet),
            }
          : {}),
        recurring: {
          previousAmount: quoted.recurring?.previousAmount,
          ...(candidateRecurring !== undefined ? { resultingAmount: candidateRecurring } : {}),
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
            "the update landed (its response was received, carrying operation " +
            `${mutation.operationId}) but the independent post-commit verification could not be completed — ` +
            (!readSub
              ? "the post-commit subscription re-read was unavailable"
              : !readArtifact
                ? `the persisted mutation artifact ${mutation.operationId} could not be read back`
                : `the persisted mutation artifact ${mutation.operationId} carries no financial actuals to establish the committed figures from`) +
            "; the recorded figures are the mutation response's candidates, pending a later verification",
          undeterminedDimensions: ["immediateFinancialEffect", "recurringFinancialEffect"],
        },
        status: "COMMITTED_UNVERIFIED",
        outcome: "COMMITTED_UNVERIFIED",
        snapshot: snapshotFrom(mutation.subscription),
      };
    }

    const snap = snapshotFrom(readSub);
    const committedImmediateNet = readArtifact.netImmediate as number;

    // State-vs-intent verification: the re-read state is compared
    // against the result the COMPLETE final request implies —
    // every item in the stored request, changed and unchanged.
    const expectedItems = sortedItems(input.input.items);
    const observedItems = sortedItems(readSub.subscriptionItems);
    const problems: string[] = [];
    if (JSON.stringify(expectedItems) !== JSON.stringify(observedItems)) {
      problems.push(
        `subscription item state differs from the dispatched request's result: expected ${JSON.stringify(expectedItems)}, observed ${JSON.stringify(observedItems)}`
      );
    }
    if (readSub.status !== preState.status) {
      problems.push(`subscription status is ${readSub.status}, expected it to remain ${preState.status} across an update operation`);
    }

    // Attribution: the artifact's fingerprint bracket must close
    // around THIS commit — the state the operation observed when
    // it began is the state this commit validated, and the state
    // read back now is the state the operation produced. The
    // artifact's recorded request must also be the request this
    // commit dispatched (operation identity, not just timing).
    const requestMatches = canonicalJson(readArtifact.request) === canonicalJson({ items: input.input.items, prorate: input.input.prorate });
    const attributable =
      requestMatches && readArtifact.fingerprintBefore === validatedFingerprint && readArtifact.fingerprintAfter === currentFingerprint;
    const latestId = this.sim.latestMutationId(subscriptionId);

    // The observed recurring level, strictly priced. Behind the
    // closed bracket it is this commit's own result; the artifact's
    // own execution figure is the fallback when the observed state
    // contains an item the catalog cannot price (a state this
    // commit's gated quote could not itself have produced).
    const strictObserved = recurringTotalStrict(readSub);
    const observedRecurring =
      strictObserved ??
      (typeof readArtifact.resultingRecurringAmount === "number" && Number.isFinite(readArtifact.resultingRecurringAmount)
        ? readArtifact.resultingRecurringAmount
        : undefined);

    // PR #14 Z1: ATTRIBUTION IS ESTABLISHED BEFORE ANY
    // CONTRADICTION IS CLASSIFIED. A state contradiction may be
    // declared a verified failure of THIS commit (D3's VIOLATED)
    // only when the observed state is attributable to this commit —
    // the closed fingerprint bracket above. When the bracket is
    // broken, another actor's change may have produced the observed
    // state (or overwritten this commit's result), so the outcome
    // is COMMITTED_UNVERIFIED / UNVERIFIED whether or not the
    // observed state happens to match intent: any contradiction is
    // recorded as UNATTRIBUTED CONTEXT, its cause not assigned.
    //
    // PR #14 Z3: FINANCIAL ATTRIBUTION FOLLOWS THE SAME RULE. The
    // recurring figure from the re-read subscription is legitimate
    // ONLY behind the closed bracket. Under a broken bracket the
    // re-read state is third-party-influenced, so the broken-chain
    // branch returns a DIFFERENT effect: the immediate stays — it
    // is the bound artifact's own persisted actual, read by id,
    // exactly the scope that operation establishes — while the
    // recurring dimension is UNKNOWN with NO resultingAmount: no
    // committed recurring figure is established for this commit.
    // The observed state, including its recurring level, remains
    // visible only as unattributed context in the resulting
    // snapshot and in the reconciliation reason. The effect-level
    // committedSource is "unestablished" — the committed effect AS
    // A WHOLE is not an established set of actuals; the immediate
    // dimension's own determinacy and provenance carry its narrower
    // claim.
    if (!attributable) {
      const unattributedEffect: CommercialEffect = {
        immediate: immediateFromLineItems(readArtifact.invoiceEstimateLineItems ?? [], committedImmediateNet),
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
          immediate: provImmediateCommitted(readArtifact.id),
          recurring: PROV_RECURRING_UNATTRIBUTED,
          committedSource: "unestablished",
        },
      };
      return {
        effect: unattributedEffect,
        reconciliation: {
          status: "UNVERIFIED",
          reason:
            `a competing change intervened around this commit's operation: this commit validated state fingerprint ` +
            `${validatedFingerprint}, artifact ${readArtifact.id} recorded fingerprint ${readArtifact.fingerprintBefore} when it began ` +
            `and ${readArtifact.fingerprintAfter} when it completed, and the re-read subscription state fingerprints ` +
            `${currentFingerprint}` +
            (latestId && latestId !== readArtifact.id ? ` with latest mutation ${latestId}` : "") +
            (!requestMatches ? `; the artifact's recorded request also differs from the request this commit dispatched` : "") +
            ` — the fingerprint bracket does not close around this commit alone, so the observed post-commit state ` +
            `was not produced by this commit alone and cannot be attributed to it. The recorded immediate figure is ` +
            `this commit's own bound-artifact actual, read by id; NO committed recurring figure is recorded for this ` +
            `commit (the recurring dimension is UNKNOWN): the recurring level in the observed state was not produced ` +
            `by this commit alone, so it is retained only as unattributed context in the resulting snapshot — not as ` +
            `this commit's determined actual. No figure was taken from any intervening operation.` +
            (problems.length > 0
              ? ` The observed state ALSO contradicts the dispatched request (${problems.join("; ")}), but because ` +
                `attribution is broken that contradiction is recorded as unattributed context only — it is NOT ` +
                `classified as a verified failure of this commit, since the intervening change may have caused it.`
              : ``),
          undeterminedDimensions: ["recurringFinancialEffect"],
        },
        status: "COMMITTED_UNVERIFIED",
        outcome: "COMMITTED_UNVERIFIED",
        snapshot: snap,
      };
    }

    // This fully-determined effect is returned ONLY by the two
    // attributable branches below (verified OK and D3 VIOLATED):
    // its recurring figure is the re-read state's, which is this
    // commit's own result only behind the closed bracket.
    const committedEffect: CommercialEffect = {
      immediate: immediateFromLineItems(readArtifact.invoiceEstimateLineItems ?? [], committedImmediateNet),
      recurring: {
        previousAmount: quoted.recurring?.previousAmount,
        ...(observedRecurring !== undefined ? { resultingAmount: observedRecurring } : {}),
        currency: quoted.recurring?.currency ?? "usd",
        ...(quoted.recurring?.cadence ? { cadence: quoted.recurring.cadence } : {}),
      },
      ...(quoted.term ? { term: quoted.term } : {}),
      effectiveAt: quoted.effectiveAt,
      determinacy: {
        immediateFinancialEffect: "DETERMINED",
        recurringFinancialEffect: observedRecurring !== undefined ? "DETERMINED" : "UNKNOWN",
      },
      provenance: {
        immediate: provImmediateCommitted(readArtifact.id),
        recurring: PROV_RECURRING_COMMITTED,
        committedSource: "provider_actual",
      },
    };

    if (problems.length > 0) {
      return {
        effect: committedEffect,
        reconciliation: {
          status: "VIOLATED",
          reason:
            `Post-commit state verification MISMATCH — a determined negative verification (Decision D3): ` +
            `${problems.join("; ")}. The contradiction is attributable to this commit: the mutation artifact's ` +
            `fingerprint bracket closes around it (the operation began on exactly the state this commit validated ` +
            `and the re-read state is exactly the state the operation produced), so no intervening change can ` +
            `account for it. The committed immediate is this mutation's bound-artifact actual and the recurring ` +
            `figure reports the observed state; the mutation has already occurred and cannot be rolled back by ` +
            `this reconciliation.`,
        },
        status: "COMMITTED",
        outcome: "COMMITTED_AND_VERIFIED",
        snapshot: snap,
      };
    }
    return {
      effect: committedEffect,
      reconciliation: reconcileCommittedEffect(quoted, committedEffect, proposal.acceptanceEnvelope),
      status: "COMMITTED",
      outcome: "COMMITTED_AND_VERIFIED",
      snapshot: snap,
    };
  }

  /**
   * v0.6.2 (PR-6): establishes a pure CANCEL commit's committed
   * effect.
   *
   * Cancellation figures are defined by the protocol: the
   * post-cancellation recurring level is 0 once effective, so
   * committed := quoted, labeled defined_equal_exact — but ONLY
   * after the cancellation's STATE is independently verified from
   * a post-commit re-read of the subscription AND attributed to
   * THIS commit: the persisted cancel artifact this operation
   * created is read back by id, its kind and its recorded request
   * (the end_of_term boolean) are checked against the stored
   * quote, and the fingerprint bracket must close exactly as the
   * update path requires (PR #14 correction Z2, applied here —
   * this path previously carried the quoted effect through with
   * no post-commit read at all, so another actor's cancellation
   * could verify as this commit's). If the bound artifact cannot
   * be read, its identity does not match, or the bracket is
   * broken, the outcome is COMMITTED_UNVERIFIED / UNVERIFIED with
   * candidate figures — neither OK nor VIOLATED may be issued for
   * an unattributable cancellation.
   *
   * With attribution established, the state verdicts are:
   *
   *  - TERM_END intent (end_of_term=true): the re-read must carry
   *    the cancellation SCHEDULED at the QUOTED effective date —
   *    status "non_renewing" with scheduledCancellationAt equal to
   *    the date recorded on the quote at quote time — kind
   *    SCHEDULED. A terminal "cancelled" read is a premature /
   *    immediate termination: MISMATCH (PR #11 correction P3: the
   *    comparison reference is the QUOTED date, never a
   *    re-derived current boundary).
   *  - IMMEDIATE intent (end_of_term=false): the re-read status
   *    must be the terminal "cancelled" — kind TERMINAL. A
   *    "non_renewing" or still-"active" read is an established
   *    contradiction: MISMATCH.
   *  - MISMATCH (D3): COMMITTED / COMMITTED_AND_VERIFIED with a
   *    VIOLATED reconciliation, and the committed figures honestly
   *    report the OBSERVED state — never a fabricated post-cancel
   *    zero. Reachable ONLY with attribution established.
   *  - Re-read unavailable: landing is established (the
   *    cancelForItems call returned) but verification is not —
   *    COMMITTED_UNVERIFIED with candidate figures labeled
   *    unestablished under UNKNOWN determinacy, built entirely
   *    from data already in hand (PR #11 correction P1).
   *
   * Z3 audit (PR #14 doctrine): this path's unverified branches
   * record only the candidateEffect — the QUOTED post-cancellation
   * level under UNKNOWN determinacy with committedSource
   * "unestablished", never a figure sourced from the (possibly
   * third-party-influenced) re-read state, and never a zero
   * asserted from an observed terminal state. The only
   * re-read-derived DETERMINED figure in this path is the D3
   * mismatch branch's observed recurring, reachable only AFTER
   * the attribution gate above.
   */
  private establishCancelCommit(
    validated: StoredQuote,
    mutation: { subscription: ChargebeeSubscription; operationId: string },
    validatedFingerprint: string
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
    const input = validated.provider_preview_input as Extract<ChargebeePreviewInput, { kind: "cancel" }>;

    // Candidate figures for an unverifiable landing, built
    // ENTIRELY from data already in hand (the stored quote and the
    // mutation response) — recording a COMMITTED_UNVERIFIED
    // receipt never depends on a further successful provider read
    // after the operation has landed (PR #11 correction P1).
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
      },
    });

    // Independent post-commit reads: the subscription AND the
    // persisted cancel artifact this operation created, read back
    // by its id via retrieveMutation.
    let readSub: ChargebeeSubscription | undefined;
    try {
      readSub = this.sim.get(subscriptionId);
    } catch {
      readSub = undefined;
    }
    let readArtifact: ChargebeeMutationArtifact | undefined;
    try {
      const artifact = this.sim.retrieveMutation(mutation.operationId);
      if (artifact.subscriptionId === subscriptionId && artifact.kind === "cancel") readArtifact = artifact;
    } catch {
      readArtifact = undefined;
    }
    let currentFingerprint: string | undefined;
    if (readSub) {
      try {
        currentFingerprint = this.sim.fingerprint(subscriptionId);
      } catch {
        currentFingerprint = undefined;
      }
    }

    if (!readSub) {
      return {
        effect: candidateEffect(
          "candidate figure: the quoted post-cancellation level, reported by the mutating call's own response path; the independent post-commit re-read was unavailable, so the cancellation's landing is NOT independently established"
        ),
        reconciliation: {
          status: "UNVERIFIED",
          reason:
            "the cancellation landed (its response was received) but the independent post-commit re-read of the " +
            "subscription was unavailable, so the cancellation state could not be verified; the recorded " +
            "figures are candidates, pending a later verification",
          undeterminedDimensions: ["immediateFinancialEffect", "recurringFinancialEffect"],
        },
        status: "COMMITTED_UNVERIFIED",
        outcome: "COMMITTED_UNVERIFIED",
        // Built from the mutation response alone — NO further
        // provider read (PR #11 correction P1).
        snapshot: snapshotFrom(mutation.subscription),
      };
    }

    const snap = snapshotFrom(readSub);

    // Attribution (Z2 pattern): the bound artifact must be THIS
    // operation's artifact (bound by the returned id, kind
    // "cancel", on this subscription), carrying exactly the
    // request this commit dispatched (the end_of_term boolean),
    // and the fingerprint bracket must close — the same bracket
    // the update path requires.
    const dispatchedRequest = { endOfTerm: input.endOfTerm };
    const requestMatches = readArtifact !== undefined && canonicalJson(readArtifact.request) === canonicalJson(dispatchedRequest);
    const attributable =
      readArtifact !== undefined &&
      requestMatches &&
      readArtifact.fingerprintBefore === validatedFingerprint &&
      currentFingerprint !== undefined &&
      readArtifact.fingerprintAfter === currentFingerprint;

    if (!attributable) {
      let failure: string;
      if (readArtifact === undefined) {
        failure =
          `the persisted cancel artifact ${mutation.operationId} this operation created could not be read back, so the ` +
          `cancellation cannot be bound to this commit's operation at all`;
      } else if (!requestMatches) {
        failure =
          `the persisted cancel artifact ${readArtifact.id} read back for this operation does not carry the ` +
          `end_of_term request this commit dispatched, so it does not establish this cancellation's identity`;
      } else {
        const latestId = this.sim.latestMutationId(subscriptionId);
        failure =
          `a competing change intervened around this commit's cancellation: this commit validated state fingerprint ` +
          `${validatedFingerprint}, artifact ${readArtifact.id} recorded fingerprint ${readArtifact.fingerprintBefore} when it ` +
          `began and ${readArtifact.fingerprintAfter} when it completed, and the re-read subscription state fingerprints ` +
          `${currentFingerprint}` +
          (latestId && latestId !== readArtifact.id ? ` with latest mutation ${latestId}` : "") +
          ` — the fingerprint bracket does not close around this commit alone`;
      }
      return {
        effect: candidateEffect(
          "candidate figure: the quoted post-cancellation level; the cancellation's attribution to this commit could not be established, so the observed state is NOT an established actual of this commit"
        ),
        reconciliation: {
          status: "UNVERIFIED",
          reason:
            `the cancellation operation landed (its response was received, carrying operation ${mutation.operationId}) ` +
            `but its result cannot be attributed to this commit: ${failure}. The observed state ` +
            `(status ${readSub.status}, scheduledCancellationAt ${readSub.scheduledCancellationAt ?? "(none)"}) is recorded as ` +
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
    // commit's own. (attributable === true implies the artifact
    // read succeeded; bind it under a name the type checker can
    // narrow past the boolean.)
    const boundArtifact = readArtifact as ChargebeeMutationArtifact;
    const quotedDate = quoted.effectiveAt;
    let verifiedKind: "TERMINAL" | "SCHEDULED" | undefined;
    let mismatchReason: string | undefined;
    if (input.endOfTerm) {
      // TERM_END: do NOT require a terminal state now — verify the
      // cancellation SCHEDULED AT THE QUOTED DATE: the effective
      // date recorded on the quote at quote time
      // (`quoted.effectiveAt`). Correction P3: the comparison
      // reference is the quoted date, NOT the record's current
      // term end — the record's term can drift after quoting, and
      // a cancellation that merely matches a drifted boundary is
      // not the cancellation that was quoted.
      if (readSub.status === "cancelled") {
        mismatchReason =
          `the post-commit re-read shows the subscription in the terminal "cancelled" state although the quoted ` +
          `cancellation is scheduled for the quoted effective date (${quotedDate}) — a premature/immediate ` +
          `termination: the subscription was ended now, not at the term end that was quoted`;
      } else if (readSub.status === "non_renewing" && readSub.scheduledCancellationAt === quotedDate) {
        verifiedKind = "SCHEDULED";
      } else {
        mismatchReason =
          `the post-commit re-read shows status "${readSub.status}" with scheduledCancellationAt ` +
          `${readSub.scheduledCancellationAt ?? "(none)"}, not the quoted cancellation date (${quotedDate}) on a ` +
          `non-renewing subscription — the cancellation this commit dispatched is absent or mis-dated in the provider record`;
      }
    } else {
      if (readSub.status === "cancelled") {
        verifiedKind = "TERMINAL";
      } else {
        mismatchReason =
          `the post-commit re-read shows subscription status "${readSub.status}", not the terminal "cancelled" ` +
          `state an immediate cancellation must produce`;
      }
    }

    if (mismatchReason) {
      // Established negative verification (D3): the committed
      // figures report the OBSERVED state — for a cancel that did
      // not land as intended, the still-standing price level, read
      // back from the provider record (provider_actual), plus the
      // bound artifact's own established immediate figure — never
      // the quoted post-cancel zero.
      const observedStrict = recurringTotalStrict(readSub);
      const observed: CommercialEffect = {
        ...(typeof boundArtifact.cancelNetImmediate === "number" && Number.isFinite(boundArtifact.cancelNetImmediate)
          ? { immediate: immediateParts(boundArtifact.cancelNetImmediate) }
          : {}),
        recurring: {
          previousAmount: quoted.recurring?.previousAmount,
          ...(observedStrict !== undefined ? { resultingAmount: observedStrict } : {}),
          currency: quoted.recurring?.currency ?? "usd",
          ...(quoted.recurring?.cadence ? { cadence: quoted.recurring.cadence } : {}),
        },
        ...(quoted.term ? { term: quoted.term } : {}),
        effectiveAt: quoted.effectiveAt,
        determinacy: {
          immediateFinancialEffect:
            typeof boundArtifact.cancelNetImmediate === "number" && Number.isFinite(boundArtifact.cancelNetImmediate)
              ? "DETERMINED"
              : "UNKNOWN",
          recurringFinancialEffect: observedStrict !== undefined ? "DETERMINED" : "UNKNOWN",
        },
        provenance: {
          immediate: `post-commit actual: the bound cancel artifact ${boundArtifact.id}'s established immediate figure — the operation this commit dispatched`,
          recurring: PROV_RECURRING_COMMITTED,
          committedSource: "provider_actual",
        },
      };
      return {
        effect: observed,
        reconciliation: {
          status: "VIOLATED",
          reason:
            `Post-commit cancellation state verification MISMATCH — a determined negative verification (Decision D3): ` +
            `${mismatchReason}. The contradiction is attributable to this commit: the bound artifact's ` +
            `identity and the closed fingerprint bracket were established before this evaluation, so no ` +
            `intervening change can account for it. The committed recurring figure reports the observed ` +
            `state; the operation has already been dispatched and cannot be rolled back by this reconciliation.`,
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
          `${PROV_CANCEL_RECURRING_COMMITTED} — established at commit by the post-commit re-read: ` +
          (verifiedKind === "TERMINAL"
            ? `the subscription reads in the terminal "cancelled" state (verification kind TERMINAL)`
            : `the cancellation is present with scheduledCancellationAt ${readSub.scheduledCancellationAt} (the quoted ` +
              `effective date) on a still-active, non-renewing subscription (verification kind SCHEDULED)`),
        committedSource: "defined_equal_exact",
      },
    };
    return {
      effect: committedEffect,
      reconciliation: reconcileCommittedEffect(quoted, committedEffect, proposal.acceptanceEnvelope),
      status: "COMMITTED",
      outcome: "COMMITTED_AND_VERIFIED",
      snapshot: snap,
    };
  }
}

function toSCQError(e: unknown, subscriptionId: string): SCQError {
  if (e instanceof ChargebeeSimError) {
    if (e.code === "resource_not_found") return new SCQError("SUBSCRIPTION_NOT_FOUND", `Subscription ${subscriptionId} not found`, e);
    return new SCQError("PROVIDER_ERROR", e.message, e);
  }
  if (e instanceof SCQError) return e;
  return new SCQError("PROVIDER_ERROR", String(e));
}

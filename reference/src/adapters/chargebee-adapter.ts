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
  type ProviderCapabilities,
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
} from "../core/scq-engine.js";
import { QuoteStore, type StoredQuote } from "../store/quote-store.js";
import { ChargebeeSim, ChargebeeSimError, type ChargebeeSubscription, type UpdateForItemsInput } from "./chargebee-sim.js";

const QUOTE_TTL_MS = 5 * 60 * 1000;

type ChargebeePreviewInput =
  | { kind: "update"; input: UpdateForItemsInput }
  | { kind: "cancel"; endOfTerm: boolean };

const OFFERING_TO_ITEM_PRICE: Record<string, string> = {
  "plan:basic:monthly": "ip_seat_basic_monthly",
  "plan:pro:monthly": "ip_seat_pro_monthly",
  "plan:basic:annual": "ip_seat_basic_annual",
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

function snapshotFrom(sub: ChargebeeSubscription): SubscriptionSnapshot {
  const ITEM_CATALOG_LOOKUP: Record<string, { unitAmount: number; currency: string; billingPeriodUnit: "month" | "year" }> = {
    ip_seat_basic_monthly: { unitAmount: 1000, currency: "usd", billingPeriodUnit: "month" },
    ip_seat_pro_monthly: { unitAmount: 1500, currency: "usd", billingPeriodUnit: "month" },
    ip_seat_basic_annual: { unitAmount: 10000, currency: "usd", billingPeriodUnit: "year" },
  };
  const totalRecurring = sub.subscriptionItems.reduce((sum, i) => {
    const price = ITEM_CATALOG_LOOKUP[i.itemPriceId];
    return sum + (price ? price.unitAmount * i.quantity : 0);
  }, 0);
  const firstPrice = ITEM_CATALOG_LOOKUP[sub.subscriptionItems[0]?.itemPriceId];
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
      recurringAmount: totalRecurring,
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
 * Resolves a single ChangeSpec into a Chargebee item-input fragment + its
 * commercial effect fragment. `workingItems` (keyed by item index) is the
 * CURRENT state of every item as of this point in the batch, so a later
 * change targeting the SAME item sees the prior change's result rather
 * than the original state — see the identical fix/comment in
 * stripe-adapter.ts's previewOneChange for the bug this closes.
 */
function resolveOneChange(
  sim: ChargebeeSim,
  subscriptionId: string,
  sub: ChargebeeSubscription,
  workingItems: Map<number, { itemPriceId: string; quantity: number }>,
  change: ChangeSpec,
  effectiveFrom: string | undefined,
  effectiveAtIso: string
): { item: { itemPriceId: string; quantity: number }; itemIndex: number; effect: CommercialEffect } {
  const currentAt = (idx: number) => workingItems.get(idx) ?? { itemPriceId: sub.subscriptionItems[idx].itemPriceId, quantity: sub.subscriptionItems[idx].quantity };
  const buildFullItems = (idx: number, item: { itemPriceId: string; quantity: number }) =>
    sub.subscriptionItems.map((it, i) => (i === idx ? item : workingItems.get(i) ?? { itemPriceId: it.itemPriceId, quantity: it.quantity }));

  switch (change.action) {
    case "CHANGE_QUANTITY": {
      const idx = sub.subscriptionItems.findIndex((i) => i.id === change.itemId);
      if (idx < 0) throw new SCQError("INVALID_PROPOSAL", `Item ${change.itemId} not found on subscription`);
      const item = { itemPriceId: currentAt(idx).itemPriceId, quantity: change.quantity };
      const items = buildFullItems(idx, item);
      const preview = sim.previewUpdate(subscriptionId, { items, prorate: true, effectiveFrom });
      return {
        item,
        itemIndex: idx,
        effect: {
          immediate: preview.netImmediate !== 0 ? { charge: preview.netImmediate > 0 ? preview.netImmediate : undefined, credit: preview.netImmediate < 0 ? -preview.netImmediate : undefined, net: preview.netImmediate } : undefined,
          recurring: { resultingAmount: preview.resultingRecurringAmount, currency: "usd", cadence: preview.resultingCadence },
          effectiveAt: effectiveAtIso,
        },
      };
    }
    case "CHANGE_PLAN": {
      const idx = sub.subscriptionItems.findIndex((i) => i.id === change.itemId);
      if (idx < 0) throw new SCQError("INVALID_PROPOSAL", `Item ${change.itemId} not found on subscription`);
      const itemPriceId = OFFERING_TO_ITEM_PRICE[change.offeringRef];
      if (!itemPriceId) throw new SCQError("UNSUPPORTED_CHANGE", `Unknown offeringRef ${change.offeringRef}`);
      const item = { itemPriceId, quantity: currentAt(idx).quantity };
      const items = buildFullItems(idx, item);
      const preview = sim.previewUpdate(subscriptionId, { items, prorate: true, effectiveFrom });
      return {
        item,
        itemIndex: idx,
        effect: {
          immediate: preview.netImmediate !== 0 ? { charge: preview.netImmediate > 0 ? preview.netImmediate : undefined, credit: preview.netImmediate < 0 ? -preview.netImmediate : undefined, net: preview.netImmediate } : undefined,
          recurring: { resultingAmount: preview.resultingRecurringAmount, currency: "usd" },
          effectiveAt: effectiveAtIso,
        },
      };
    }
    case "CHANGE_CADENCE": {
      const idx = 0;
      const itemPriceId = OFFERING_TO_ITEM_PRICE[change.cadence === "ANNUAL" ? "plan:basic:annual" : "plan:basic:monthly"];
      const item = { itemPriceId, quantity: currentAt(idx).quantity };
      const items = buildFullItems(idx, item);
      const preview = sim.previewUpdate(subscriptionId, { items, prorate: true, effectiveFrom });
      return {
        item,
        itemIndex: idx,
        effect: {
          immediate: preview.netImmediate !== 0 ? { charge: preview.netImmediate > 0 ? preview.netImmediate : undefined, credit: preview.netImmediate < 0 ? -preview.netImmediate : undefined, net: preview.netImmediate } : undefined,
          recurring: { resultingAmount: preview.resultingRecurringAmount, currency: "usd", cadence: change.cadence },
          term: { createsCommitment: "UNKNOWN", commitmentUntil: "UNKNOWN", autoRenew: sub.contractTerm ? sub.contractTerm.actionAtTermEnd !== "cancel" : true },
          effectiveAt: effectiveAtIso,
        },
      };
    }
    case "CANCEL":
      throw new SCQError("INVALID_PROPOSAL", "CANCEL cannot be combined with other changes in one Chargebee proposal");
  }
}

function combineEffects(effects: CommercialEffect[]): CommercialEffect {
  const immediateNet = effects.reduce((sum, e) => sum + (e.immediate?.net ?? 0), 0);
  const lastRecurring = effects.reduce((r, e) => e.recurring ?? r, effects[0].recurring);
  const lastTerm = effects.reduce((t, e) => e.term ?? t, undefined as CommercialEffect["term"] | undefined);
  const lastEffectiveAt = effects[effects.length - 1]?.effectiveAt;
  // Only include keys that are actually defined — a single-change batch
  // must produce a result INDISTINGUISHABLE from the pre-v0.5 flat shape,
  // since assert.deepEqual and any downstream consumer treats an explicit
  // `undefined` value differently from an absent key.
  const combined: CommercialEffect = {};
  if (immediateNet !== 0) {
    combined.immediate = { charge: immediateNet > 0 ? immediateNet : undefined, credit: immediateNet < 0 ? -immediateNet : undefined, net: immediateNet };
  }
  if (lastRecurring !== undefined) combined.recurring = lastRecurring;
  if (lastTerm !== undefined) combined.term = lastTerm;
  if (lastEffectiveAt !== undefined) combined.effectiveAt = lastEffectiveAt;
  return combined;
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
    // timestamp is sent). `effectiveFrom` below is therefore ALWAYS
    // undefined for update previews after this correction; it is kept
    // in the sim input shape only so the simulator's legacy
    // scheduled-change model remains exercisable at the sim layer,
    // explicitly labeled simulator-only there (see chargebee-sim.ts).
    const isTermEnd = proposal.effectiveIntent.type === "TERM_END";
    const effectiveFrom: string | undefined = undefined;
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
      const cancelPreview = this.sim.previewCancel(subscriptionId, isTermEnd);
      commercialEffect = {
        immediate: cancelPreview.netImmediate !== 0 ? { charge: cancelPreview.netImmediate, net: cancelPreview.netImmediate } : undefined,
        term: { createsCommitment: false, autoRenew: false },
        effectiveAt: isTermEnd ? sub.currentTermEnd : now.toISOString(),
      };
      // Quote-level override — see quoteLevelCancelTermCoverage's v0.6
      // doc comment for why committed-term subscriptions now correctly
      // resolve UNKNOWN (UNVERIFIED live), not EXACT.
      guaranteeCoverage = { ...capabilitiesFor("CANCEL").guaranteeCoverage, termEffect: quoteLevelCancelTermCoverage(sub) };
    } else {
      // workingItems folds sequentially by item INDEX so a later change
      // targeting the same item sees the prior change's result, not the
      // original state (see resolveOneChange doc comment).
      const workingItems = new Map<number, { itemPriceId: string; quantity: number }>();
      const resolved = proposal.changes.map((change) => {
        const result = resolveOneChange(this.sim, subscriptionId, sub, workingItems, change, effectiveFrom, effectiveAtIso);
        workingItems.set(result.itemIndex, result.item);
        return result;
      });
      const finalItems = sub.subscriptionItems.map((it, i) => workingItems.get(i) ?? { itemPriceId: it.itemPriceId, quantity: it.quantity });
      previewInput = { kind: "update", input: { items: finalItems, prorate: true, effectiveFrom } };
      commercialEffect = combineEffects(resolved.map((r) => r.effect));
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

    // Same read/write separation and TOCTOU window as the other three
    // adapters — no compare-and-swap parameter exists on Chargebee's
    // update/cancel endpoints either (see chargebee-sim.ts), and no
    // adapter-local lock is used to hide that.
    const currentFingerprint = this.sim.fingerprint(quote.subscription_id);
    const validated = validateCommit(this.store, quoteId, currentFingerprint);

    const input = validated.provider_preview_input as ChargebeePreviewInput;
    const proposal = validated.proposal;
    const effectiveMode = validated.effective_guarantee_mode;
    const isCancel = input.kind === "cancel";
    let committedEffect: CommercialEffect;

    if (effectiveMode === "REVALIDATE" && !isCancel) {
      const freshPreview = this.sim.previewUpdate(validated.subscription_id, input.input);
      const revalidated: CommercialEffect = {
        immediate: freshPreview.netImmediate !== 0 ? { charge: freshPreview.netImmediate > 0 ? freshPreview.netImmediate : undefined, credit: freshPreview.netImmediate < 0 ? -freshPreview.netImmediate : undefined, net: freshPreview.netImmediate } : undefined,
        recurring: { ...validated.quoted_effect.recurring, currency: validated.quoted_effect.recurring?.currency ?? "usd", resultingAmount: freshPreview.resultingRecurringAmount },
        effectiveAt: validated.quoted_effect.effectiveAt,
      };
      const violation = checkAcceptanceEnvelope(validated.quoted_effect, revalidated, proposal.acceptanceEnvelope!);
      if (violation) {
        throw new SCQError(
          "QUOTE_DRIFTED",
          `Recomputed commercial effect fell outside the caller's acceptance envelope: ${violation}. No mutation was performed.`,
          { quoted: validated.quoted_effect, revalidated, envelope: proposal.acceptanceEnvelope }
        );
      }
      committedEffect = revalidated;
    } else {
      // CANCEL path (the only non-REVALIDATE-update case reachable
      // after the Phase 2A correction — no Chargebee action in this
      // adapter backs an overall EXACT request anymore, because the
      // financial dimensions are REVALIDATE): a CANCEL quote carries
      // no proration to re-derive in the simulator, so the quoted
      // effect is carried through. Phase 2A removed the earlier
      // justification here ("proration pivots on an explicit
      // effective_from input, so replay reproduces the quoted number
      // exactly") — that pinning mechanism is NOT ESTABLISHED in the
      // documented update contract and must not be cited as the reason
      // any number reproduces.
      committedEffect = validated.quoted_effect;
    }

    let resultingSub: ChargebeeSubscription;
    try {
      if (input.kind === "cancel") {
        resultingSub = this.sim.cancelForItems(validated.subscription_id, input.endOfTerm);
      } else {
        const { subscription } = this.sim.updateForItems(validated.subscription_id, input.input);
        resultingSub = subscription;
      }
    } catch (e) {
      throw toSCQError(e, validated.subscription_id);
    }

    const snap = snapshotFrom(resultingSub);
    snap.version = this.sim.fingerprint(validated.subscription_id);

    // v0.6.1: post-commit reconciliation — see stripe-adapter.ts's
    // identical comment for full rationale.
    const reconciliation = reconcileCommittedEffect(validated.quoted_effect, committedEffect, proposal.acceptanceEnvelope);

    const receipt: SubscriptionChangeReceipt = {
      quoteId,
      subscriptionRef: validated.subscription_id,
      status: "COMMITTED",
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
}

function toSCQError(e: unknown, subscriptionId: string): SCQError {
  if (e instanceof ChargebeeSimError) {
    if (e.code === "resource_not_found") return new SCQError("SUBSCRIPTION_NOT_FOUND", `Subscription ${subscriptionId} not found`, e);
    return new SCQError("PROVIDER_ERROR", e.message, e);
  }
  if (e instanceof SCQError) return e;
  return new SCQError("PROVIDER_ERROR", String(e));
}

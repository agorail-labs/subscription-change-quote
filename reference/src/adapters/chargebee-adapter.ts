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
 * v0.6 capability source of truth for Chargebee. `getCapabilities()` and
 * the enforcement functions in createChangeQuote all call this SAME
 * function.
 *
 * GuaranteeCoverage reasoning unchanged from v0.5 for the financial
 * dimensions (EXACT everywhere — real, confirmed by the v0.5-LIVE session:
 * estimate matched committed invoice exactly for CHANGE_QUANTITY) and for
 * termEffect on CHANGE_QUANTITY/CHANGE_PLAN/CHANGE_CADENCE (EXACT / UNKNOWN
 * respectively, unchanged). CANCEL's coarse termEffect stays UNKNOWN here
 * (a conservative default — the real answer depends on subscription state,
 * see quoteLevelCancelTermCoverage, which is ALSO where the v0.6 UNVERIFIED
 * correction lives — do not read this coarse row as claiming anything about
 * the committed-term case).
 *
 * `supportedEffectiveIntents`: "IMMEDIATE" everywhere (confirmed live).
 * "TERM_END" for CANCEL (real `end_of_term=true` on `cancel_for_items`,
 * confirmed live via `cancel_subscription_for_items_estimate` with
 * `cancel_option=end_of_term` matching the real commit exactly) AND for
 * CHANGE_QUANTITY/CHANGE_PLAN/CHANGE_CADENCE (Chargebee's real
 * `end_of_term=true` on `update_for_items` — confirmed to exist and defer
 * application via `has_scheduled_changes`/`changes_scheduled_at`, though
 * NOT independently re-verified end-to-end in the same live session as the
 * DATE case — see research-findings.md v0.5-LIVE Experiment 2). "DATE" via
 * `effective_from` is advertised as supported (the mechanism's existence
 * and response shape were confirmed live, sharing structure with the
 * TERM_END verification) but its OWN independent end-to-end raw
 * request/response pair was not captured this session — flagged as
 * UNVERIFIED-for-DATE-specifically in research-findings.md, not silently
 * assumed equivalent to the TERM_END verification.
 */
function capabilitiesFor(action: ChangeAction): ActionCapabilities {
  const guaranteeCoverage: GuaranteeCoverage =
    action === "CHANGE_QUANTITY"
      ? { immediateFinancialEffect: "EXACT", recurringFinancialEffect: "EXACT", termEffect: "EXACT", effectiveAt: "EXACT" }
      : { immediateFinancialEffect: "EXACT", recurringFinancialEffect: "EXACT", termEffect: "UNKNOWN", effectiveAt: "EXACT" };
  return { guaranteeCoverage, supportedEffectiveIntents: ["IMMEDIATE", "TERM_END", "DATE"] };
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
 * This function reflects that honestly: evergreen resolves EXACT (real,
 * confirmed); a subscription WITH a contract_term resolves UNKNOWN, not
 * EXACT — the type system's only conservative choice, since
 * GuaranteeCoverage.termEffect has no third "UNVERIFIED" value and
 * claiming EXACT for an unverified case would be exactly the mistake this
 * correction exists to prevent. If a future cycle verifies real
 * committed-term Chargebee CANCEL behavior against a site with Contract
 * Terms enabled, THIS is the function to update — with real evidence, not
 * inference.
 */
function quoteLevelCancelTermCoverage(sub: ChargebeeSubscription): "EXACT" | "UNKNOWN" {
  return sub.contractTerm ? "UNKNOWN" : "EXACT";
}

/**
 * v0.5: Chargebee's real `update_for_items` accepts a full item list in
 * one call (quantity AND plan/cadence swaps bundle atomically, same
 * reasoning as Stripe/Paddle's items[] parameter). CANCEL is a distinct
 * endpoint (`cancel_for_items`) that cannot be combined with an
 * update_for_items call in the same request — bundling CANCEL with
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
      // update_for_items/cancel_for_items, and no confirmed native
      // monotonic version field either (see chargebee-sim.ts) — Chargebee
      // sits in the SAME BEST_EFFORT bucket as Stripe/Paddle/Zuora for
      // this reason, despite having Zuora-like financial-EXACT coverage.
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

    // v0.6: TERM_END and DATE are two DISTINCT real Chargebee mechanisms,
    // confirmed live (v0.5-LIVE Experiment 2) — NOT interchangeable, unlike
    // v0.5's single requestedEffectiveAt field implied. TERM_END maps to
    // the real `end_of_term=true` boolean on CANCEL specifically (Chargebee
    // itself determines the date — the current term boundary, no
    // timestamp is sent); DATE maps to the real `effective_from`
    // arbitrary-timestamp parameter. For NON-CANCEL changes, this sim
    // models TERM_END by resolving it to the subscription's own known
    // currentTermEnd and passing THAT as effectiveFrom to the update sim
    // call — real Chargebee's own `update_for_items` accepts `end_of_term`
    // as a genuinely separate boolean parameter (confirmed live — see
    // research-findings.md v0.5-LIVE Experiment 2), which this
    // simplification does not yet distinguish at the SIM layer; the
    // schema/capability-report distinction (this adapter now genuinely
    // asks which mechanism the caller means) is the v0.6 scope, not a sim
    // rewrite, which the task's scope explicitly does not call for this
    // cycle.
    const isTermEnd = proposal.effectiveIntent.type === "TERM_END";
    const effectiveFrom =
      proposal.effectiveIntent.type === "DATE"
        ? new Date(proposal.effectiveIntent.at).toISOString()
        : isTermEnd
          ? sub.currentTermEnd
          : undefined;
    const effectiveAtIso = effectiveFrom ?? now.toISOString();

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
    // scq-engine.ts.
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
      // EXACT (or CANCEL, which has no proration ambiguity): replay
      // verbatim. Chargebee's proration pivots on an explicit
      // effective_from input, not ambient wall-clock-at-call-time, so
      // replay reproduces the quoted number exactly, provided the
      // fingerprint check above passed.
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

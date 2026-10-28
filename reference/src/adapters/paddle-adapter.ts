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
import { PaddleSim, PaddleSimError, type PaddleSubscription, type ProrationBillingMode } from "./paddle-sim.js";

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
 * Resolves a single ChangeSpec into a Paddle item-input fragment + its
 * commercial effect fragment. `workingItems` (keyed by item index) is the
 * CURRENT state of every item as of this point in the batch, so a later
 * change targeting the SAME item sees the prior change's result rather
 * than the original state — see the identical fix/comment in
 * stripe-adapter.ts's previewOneChange for the bug this closes.
 */
function previewOneChange(
  sim: PaddleSim,
  subscriptionId: string,
  sub: PaddleSubscription,
  workingItems: Map<number, PaddleItemInput>,
  change: ChangeSpec,
  oldRecurring: number,
  nowIso: string
): { item: PaddleItemInput; itemIndex: number; effect: CommercialEffect } {
  const currentAt = (idx: number): PaddleItemInput => workingItems.get(idx) ?? { priceId: sub.items[idx].price.id, quantity: sub.items[idx].quantity };
  const buildFullItems = (idx: number, item: PaddleItemInput): PaddleItemInput[] =>
    sub.items.map((it, i) => (i === idx ? item : workingItems.get(i) ?? { priceId: it.price.id, quantity: it.quantity }));

  switch (change.action) {
    case "CHANGE_QUANTITY": {
      const idx = sub.items.findIndex((_, i) => `${sub.id}_item_${i}` === change.itemId);
      if (idx < 0) throw new SCQError("INVALID_PROPOSAL", `Item ${change.itemId} not found on subscription`);
      const item: PaddleItemInput = { priceId: currentAt(idx).priceId, quantity: change.quantity };
      const items = buildFullItems(idx, item);
      const preview = sim.previewUpdate(subscriptionId, items, "prorated_immediately");
      return {
        item,
        itemIndex: idx,
        effect: {
          immediate: preview.immediateTransaction
            ? {
                charge: preview.immediateTransaction.amount > 0 ? preview.immediateTransaction.amount : undefined,
                credit: preview.immediateTransaction.amount < 0 ? -preview.immediateTransaction.amount : undefined,
                net: preview.immediateTransaction.amount,
              }
            : undefined,
          recurring: {
            previousAmount: oldRecurring,
            resultingAmount: preview.nextTransaction?.amount,
            currency: sub.currencyCode,
            cadence: sub.billingCycle.interval === "year" ? "ANNUAL" : "MONTHLY",
          },
          effectiveAt: nowIso,
        },
      };
    }
    case "CHANGE_PLAN": {
      const idx = sub.items.findIndex((_, i) => `${sub.id}_item_${i}` === change.itemId);
      if (idx < 0) throw new SCQError("INVALID_PROPOSAL", `Item ${change.itemId} not found on subscription`);
      const priceId = OFFERING_TO_PRICE[change.offeringRef];
      if (!priceId) throw new SCQError("UNSUPPORTED_CHANGE", `Unknown offeringRef ${change.offeringRef}`);
      const item: PaddleItemInput = { priceId, quantity: currentAt(idx).quantity };
      const items = buildFullItems(idx, item);
      const preview = sim.previewUpdate(subscriptionId, items, "prorated_immediately");
      return {
        item,
        itemIndex: idx,
        effect: {
          immediate: preview.immediateTransaction
            ? { charge: preview.immediateTransaction.amount > 0 ? preview.immediateTransaction.amount : undefined, credit: preview.immediateTransaction.amount < 0 ? -preview.immediateTransaction.amount : undefined, net: preview.immediateTransaction.amount }
            : undefined,
          recurring: { previousAmount: oldRecurring, resultingAmount: preview.nextTransaction?.amount, currency: sub.currencyCode },
          effectiveAt: nowIso,
        },
      };
    }
    case "CHANGE_CADENCE": {
      const idx = 0;
      const priceId = OFFERING_TO_PRICE[change.cadence === "ANNUAL" ? "plan:basic:annual" : "plan:basic:monthly"];
      const item: PaddleItemInput = { priceId, quantity: currentAt(idx).quantity };
      const items = buildFullItems(idx, item);
      const preview = sim.previewUpdate(subscriptionId, items, "prorated_immediately");
      return {
        item,
        itemIndex: idx,
        effect: {
          immediate: preview.immediateTransaction
            ? { charge: preview.immediateTransaction.amount > 0 ? preview.immediateTransaction.amount : undefined, credit: preview.immediateTransaction.amount < 0 ? -preview.immediateTransaction.amount : undefined, net: preview.immediateTransaction.amount }
            : undefined,
          recurring: { previousAmount: oldRecurring, resultingAmount: preview.nextTransaction?.amount, currency: sub.currencyCode, cadence: change.cadence },
          term: { createsCommitment: "UNKNOWN", commitmentUntil: "UNKNOWN", autoRenew: !sub.scheduledChange },
          effectiveAt: nowIso,
        },
      };
    }
    case "CANCEL":
      throw new SCQError("INVALID_PROPOSAL", "CANCEL cannot be combined with other changes in one Paddle proposal");
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

    if (proposal.changes.length === 1 && proposal.changes[0].action === "CANCEL") {
      const effectiveFrom = proposal.effectiveIntent.type === "TERM_END" ? "next_billing_period" : "immediately";
      previewInput = { items: [], prorationBillingMode: "do_not_bill", cancelEffectiveFrom: effectiveFrom };
      commercialEffect = {
        term: { createsCommitment: false, autoRenew: false },
        effectiveAt: effectiveFrom === "next_billing_period" ? sub.currentBillingPeriod.endsAt : now.toISOString(),
      };
    } else {
      // One or more non-CANCEL changes, bundled into a single items[]
      // replacement — genuinely atomic on Paddle (see multiChangePairSupport).
      // workingItems folds sequentially by item INDEX so a later change
      // targeting the same item sees the prior change's result, not the
      // original state (see previewOneChange doc comment).
      const workingItems = new Map<number, PaddleItemInput>();
      const results = proposal.changes.map((change) => {
        const result = previewOneChange(this.sim, subscriptionId, sub, workingItems, change, oldRecurring, now.toISOString());
        workingItems.set(result.itemIndex, result.item);
        return result;
      });
      // Final items[] array: one entry per original item, using the LAST
      // fold result for any item touched by the batch.
      const finalItems = sub.items.map((it, i) => workingItems.get(i) ?? { priceId: it.price.id, quantity: it.quantity });
      previewInput = { items: finalItems, prorationBillingMode: "prorated_immediately" };
      commercialEffect = combineEffects(results.map((r) => r.effect));
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
      providerMetadata: { proration_billing_mode: previewInput.prorationBillingMode },
    };
  }

  async commitChangeQuote(quoteId: string): Promise<SubscriptionChangeReceipt> {
    // v0.6.1: idempotent replay checked before any read of live provider
    // state or mutating call — see checkIdempotentReplay's doc comment.
    const cached = checkIdempotentReplay(this.store, quoteId);
    if (cached) return cached;

    const quote = this.store.get(quoteId);
    if (!quote) {
      throw new SCQError("QUOTE_STALE", `No quote found for id ${quoteId}`);
    }

    // Same read/write separation and TOCTOU window as the Stripe adapter —
    // no compare-and-swap parameter exists on Paddle's update endpoint
    // either, and no adapter-local lock is used to hide that.
    const currentFingerprint = this.sim.fingerprint(quote.subscription_id);
    const validated = validateCommit(this.store, quoteId, currentFingerprint);

    const input = validated.provider_preview_input as PaddlePreviewInput;
    const proposal = validated.proposal;
    const effectiveMode = validated.effective_guarantee_mode;
    const isCancel = proposal.changes.length === 1 && proposal.changes[0].action === "CANCEL";
    let committedEffect: CommercialEffect;

    if (effectiveMode === "REVALIDATE" && !isCancel) {
      // Order per spec: re-preview -> evaluate acceptance envelope -> mutate
      // -> fetch resulting state -> receipt. This is Paddle's ONLY lever
      // for closing proration drift at all — since Paddle has no
      // proration_date equivalent, REVALIDATE is not just an option here,
      // it is the only mechanism SCQ can offer for proration-bearing
      // changes on Paddle that isn't silently trusting a stale number
      // (which is exactly why EXACT is not advertised for these actions).
      const freshPreview = this.sim.previewUpdate(validated.subscription_id, input.items, input.prorationBillingMode);
      const revalidated: CommercialEffect = {
        immediate: freshPreview.immediateTransaction
          ? {
              charge: freshPreview.immediateTransaction.amount > 0 ? freshPreview.immediateTransaction.amount : undefined,
              credit: freshPreview.immediateTransaction.amount < 0 ? -freshPreview.immediateTransaction.amount : undefined,
              net: freshPreview.immediateTransaction.amount,
            }
          : undefined,
        recurring: {
          ...validated.quoted_effect.recurring,
          currency: validated.quoted_effect.recurring?.currency ?? "USD",
          resultingAmount: freshPreview.nextTransaction?.amount,
        },
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
    }

    let resultingSub: PaddleSubscription;
    try {
      if (isCancel) {
        resultingSub = this.sim.cancel(validated.subscription_id, input.cancelEffectiveFrom!);
        committedEffect = validated.quoted_effect; // no proration component; quoted === committed by construction
      } else {
        // EXACT is never reachable here for proration-bearing actions —
        // enforceGuaranteeRequest refused it at quote time. This call
        // always runs under REVALIDATE for those actions, so
        // committedEffect is already set to the revalidated figure above.
        const { subscription } = this.sim.update(validated.subscription_id, input.items, input.prorationBillingMode);
        resultingSub = subscription;
      }
    } catch (e) {
      throw toSCQError(e, validated.subscription_id);
    }

    const snap = snapshotFrom(resultingSub);
    snap.version = this.sim.fingerprint(validated.subscription_id);

    // v0.6.1: post-commit reconciliation — see stripe-adapter.ts's
    // identical comment for full rationale.
    const reconciliation = reconcileCommittedEffect(validated.quoted_effect, committedEffect!, proposal.acceptanceEnvelope);

    const receipt: SubscriptionChangeReceipt = {
      quoteId,
      subscriptionRef: validated.subscription_id,
      status: "COMMITTED",
      quotedEffect: validated.quoted_effect,
      committedEffect: committedEffect!,
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
  if (e instanceof PaddleSimError) {
    if (e.type === "entity_not_found") return new SCQError("SUBSCRIPTION_NOT_FOUND", `Subscription ${subscriptionId} not found`, e);
    return new SCQError("PROVIDER_ERROR", e.message, e);
  }
  if (e instanceof SCQError) return e;
  return new SCQError("PROVIDER_ERROR", String(e));
}

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
import { StripeSim, StripeSimError, type StripeSubscription } from "./stripe-sim.js";

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
 * Resolves a single ChangeSpec into a Stripe item-update fragment + its
 * commercial effect fragment. `workingItems` is the CURRENT state of every
 * item as of this point in the batch — i.e. it already reflects any prior
 * change in the same proposal that touched the same item. This matters for
 * a batch like [CHANGE_QUANTITY(item, 120), CHANGE_PLAN(item, "pro")]: the
 * plan-change preview must be computed against quantity 120, not the
 * ORIGINAL quantity 100, or the earlier change in the batch would be lost
 * — Stripe's real subscriptions.update() applies the FINAL items[] array
 * you send it, so previewing must build up that final state the same way.
 */
function previewOneChange(
  sim: StripeSim,
  subscriptionId: string,
  sub: StripeSubscription,
  workingItems: Map<string, StripeItemInput>,
  change: ChangeSpec,
  prorationDate: number,
  effectiveAtIso: string
): { item: StripeItemInput; effect: CommercialEffect } {
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
      const itemInput: StripeItemInput = { id: current.id, price: current.price, quantity: change.quantity };
      const preview = sim.previewUpcomingInvoice(subscriptionId, [itemInput], "create_prorations", prorationDate);
      return {
        item: itemInput,
        effect: {
          immediate: {
            charge: preview.amount_due > 0 ? preview.amount_due : undefined,
            credit: preview.amount_due < 0 ? -preview.amount_due : undefined,
            net: preview.amount_due,
          },
          recurring: {
            previousAmount: sub.items.reduce((s, i) => s + i.price.unitAmount * i.quantity, 0),
            resultingAmount: preview.next_period_recurring_amount,
            currency: item.price.currency,
            cadence: item.price.interval === "year" ? "ANNUAL" : "MONTHLY",
          },
          effectiveAt: effectiveAtIso,
        },
      };
    }
    case "CHANGE_PLAN": {
      const current = currentFor(change.itemId);
      const item = sub.items.find((i) => i.id === change.itemId);
      if (!item) throw new SCQError("INVALID_PROPOSAL", `Item ${change.itemId} not found on subscription`);
      const price = OFFERING_TO_PRICE[change.offeringRef];
      if (!price) throw new SCQError("UNSUPPORTED_CHANGE", `Unknown offeringRef ${change.offeringRef}`);
      const itemInput: StripeItemInput = { id: current.id, price, quantity: current.quantity };
      const preview = sim.previewUpcomingInvoice(subscriptionId, [itemInput], "create_prorations", prorationDate);
      return {
        item: itemInput,
        effect: {
          immediate: {
            charge: preview.amount_due > 0 ? preview.amount_due : undefined,
            credit: preview.amount_due < 0 ? -preview.amount_due : undefined,
            net: preview.amount_due,
          },
          recurring: {
            previousAmount: sub.items.reduce((s, i) => s + i.price.unitAmount * i.quantity, 0),
            resultingAmount: preview.next_period_recurring_amount,
            currency: item.price.currency,
          },
          effectiveAt: effectiveAtIso,
        },
      };
    }
    case "CHANGE_CADENCE": {
      const item = sub.items[0];
      if (!item) throw new SCQError("INVALID_PROPOSAL", "Subscription has no items");
      const current = currentFor(item.id);
      const targetKey = change.cadence === "ANNUAL" ? "plan:basic:annual" : "plan:basic:monthly";
      const price = OFFERING_TO_PRICE[targetKey];
      const itemInput: StripeItemInput = { id: current.id, price, quantity: current.quantity };
      const preview = sim.previewUpcomingInvoice(subscriptionId, [itemInput], "create_prorations", prorationDate);
      return {
        item: itemInput,
        effect: {
          immediate: {
            charge: preview.amount_due > 0 ? preview.amount_due : undefined,
            credit: preview.amount_due < 0 ? -preview.amount_due : undefined,
            net: preview.amount_due,
          },
          recurring: {
            previousAmount: sub.items.reduce((s, i) => s + i.price.unitAmount * i.quantity, 0),
            resultingAmount: preview.next_period_recurring_amount,
            currency: item.price.currency,
            cadence: change.cadence,
          },
          term: { createsCommitment: "UNKNOWN", commitmentUntil: "UNKNOWN", autoRenew: !sub.cancel_at_period_end },
          effectiveAt: effectiveAtIso,
        },
      };
    }
    case "CANCEL":
      throw new SCQError("INVALID_PROPOSAL", "CANCEL cannot be combined with other changes in one Stripe proposal");
  }
}

/** Combines multiple per-change CommercialEffects into one aggregate — sums financial amounts, keeps the last non-undefined term/cadence info. */
function combineEffects(effects: CommercialEffect[]): CommercialEffect {
  const immediateNet = effects.reduce((sum, e) => sum + (e.immediate?.net ?? 0), 0);
  const lastRecurring = effects.reduce((r, e) => e.recurring ?? r, effects[0].recurring);
  const lastTerm = effects.reduce((t, e) => e.term ?? t, undefined as CommercialEffect["term"] | undefined);
  const lastEffectiveAt = effects[effects.length - 1]?.effectiveAt;
  const combined: CommercialEffect = {};
  if (immediateNet !== 0) {
    combined.immediate = { charge: immediateNet > 0 ? immediateNet : undefined, credit: immediateNet < 0 ? -immediateNet : undefined, net: immediateNet };
  }
  if (lastRecurring !== undefined) combined.recurring = lastRecurring;
  if (lastTerm !== undefined) combined.term = lastTerm;
  if (lastEffectiveAt !== undefined) combined.effectiveAt = lastEffectiveAt;
  return combined;
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

    if (proposal.changes.length === 1 && proposal.changes[0].action === "CANCEL") {
      const isTermEnd = proposal.effectiveIntent.type === "TERM_END";
      previewInput = {
        items: [],
        proration_behavior: "none",
        cancel_at_period_end: isTermEnd,
        cancel_immediately: !isTermEnd,
      };
      commercialEffect = {
        term: { createsCommitment: false, autoRenew: false },
        effectiveAt: isTermEnd ? new Date(sub.current_period_end * 1000).toISOString() : now.toISOString(),
      };
    } else {
      // One or more non-CANCEL changes, bundled into a single items[]
      // update — genuinely atomic on Stripe (see multiChangePairSupport).
      // workingItems folds sequentially so a later change targeting the
      // SAME item sees the prior change's result, not the original state.
      const workingItems = new Map<string, StripeItemInput>();
      const results = proposal.changes.map((change) => {
        const result = previewOneChange(this.sim, subscriptionId, sub, workingItems, change, nowUnix, now.toISOString());
        workingItems.set(result.item.id!, result.item);
        return result;
      });
      previewInput = {
        // Use the final folded state per item (workingItems.values()), not
        // results.map(r => r.item) — if two changes in the batch target
        // the same item, the latter would otherwise produce a DUPLICATE
        // entry for that item id in items[].
        items: Array.from(workingItems.values()),
        proration_behavior: "create_prorations",
        proration_date: nowUnix,
      };
      commercialEffect = combineEffects(results.map((r) => r.effect));
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
    let committedEffect: CommercialEffect;

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
      const revalidated: CommercialEffect = {
        immediate: {
          charge: freshPreview.amount_due > 0 ? freshPreview.amount_due : undefined,
          credit: freshPreview.amount_due < 0 ? -freshPreview.amount_due : undefined,
          net: freshPreview.amount_due,
        },
        recurring: {
          ...validated.quoted_effect.recurring,
          currency: validated.quoted_effect.recurring?.currency ?? "usd",
          resultingAmount: freshPreview.next_period_recurring_amount,
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

    let resultingSub: StripeSubscription;
    try {
      if (isCancel) {
        resultingSub = this.sim.cancel(validated.subscription_id, !!input.cancel_at_period_end);
        committedEffect = validated.quoted_effect; // no proration component; quoted === committed by construction
      } else if (effectiveMode === "EXACT") {
        // EXACT replays proration_date verbatim from the quote, pinning the
        // time basis so the mutation reproduces the quoted number exactly
        // (capabilitiesFor() only advertises EXACT where this holds).
        const { subscription } = this.sim.update(
          validated.subscription_id,
          input.items,
          input.proration_behavior,
          input.proration_date
        );
        resultingSub = subscription;
        committedEffect = validated.quoted_effect; // defined equality for EXACT — see types.ts
      } else {
        // REVALIDATE: commit using CURRENT-time semantics (no proration_date
        // pin) so the resulting invoice matches what was just revalidated
        // and accepted above, not the stale quoted figure.
        const { subscription } = this.sim.update(validated.subscription_id, input.items, input.proration_behavior);
        resultingSub = subscription;
        // committedEffect already set to the revalidated figure above.
      }
    } catch (e) {
      throw toSCQError(e, validated.subscription_id);
    }

    const snap = snapshotFrom(resultingSub);
    snap.version = this.sim.fingerprint(validated.subscription_id);

    // v0.6.1: post-commit reconciliation — re-check the ACTUALLY-committed
    // effect against the same envelope used pre-mutation. This cannot undo
    // the mutation that already happened; it exists so a violation (a
    // concurrent write landing in the BEST_EFFORT race window between the
    // last pre-mutation preview and this mutating call) is never silent.
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
    // v0.6.1: records the receipt AND flips status to COMMITTED atomically,
    // so a subsequent commit call is guaranteed to find a receipt whenever
    // it finds status === "COMMITTED" (see checkIdempotentReplay).
    this.store.recordCommitReceipt(quoteId, receipt);
    return receipt;
  }
}

function toSCQError(e: unknown, subscriptionId: string): SCQError {
  if (e instanceof StripeSimError) {
    if (e.type === "resource_missing") return new SCQError("SUBSCRIPTION_NOT_FOUND", `Subscription ${subscriptionId} not found`, e);
    return new SCQError("PROVIDER_ERROR", e.message, e);
  }
  if (e instanceof SCQError) return e;
  return new SCQError("PROVIDER_ERROR", String(e));
}

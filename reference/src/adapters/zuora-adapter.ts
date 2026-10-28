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
import { ZuoraSim, ZuoraSimError, type OrderAction, type ZuoraSubscription } from "./zuora-sim.js";

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

/**
 * Resolves a single ChangeSpec into Zuora order action(s) + its commercial
 * effect fragment, previewed against the CURRENT sub state passed in.
 * `effectiveDate` is already resolved from the PROPOSAL-level
 * `effectiveIntent` (IMMEDIATE -> today, TERM_END -> sub.term.termEndDate,
 * DATE -> the caller's requested date) — see createChangeQuote, where this
 * resolution happens once for the whole batch, since effectiveIntent is
 * proposal-level, not per-change.
 */
function resolveOneChange(
  sim: ZuoraSim,
  subscriptionId: string,
  sub: ZuoraSubscription,
  change: ChangeSpec,
  effectiveDate: string
): { orderActions: OrderAction[]; effect: CommercialEffect; quoteLevelTermOverride?: "EXACT" | "UNKNOWN" } {
  switch (change.action) {
    case "CHANGE_QUANTITY": {
      const plan = sub.ratePlans.find((p) => p.ratePlanCharges.some((c) => c.id === change.itemId));
      const charge = plan?.ratePlanCharges.find((c) => c.id === change.itemId);
      if (!plan || !charge) throw new SCQError("INVALID_PROPOSAL", `Item ${change.itemId} not found on subscription`);
      const orderActions: OrderAction[] = [
        { type: "UpdateProduct", effectiveDate, ratePlanId: plan.id, productRatePlanChargeId: charge.id, quantity: change.quantity },
      ];
      const preview = sim.previewOrder(subscriptionId, orderActions);
      return { orderActions, effect: buildCommercialEffect(preview, effectiveDate) };
    }
    case "CHANGE_PLAN": {
      const plan = sub.ratePlans.find((p) => p.ratePlanCharges.some((c) => c.id === change.itemId));
      if (!plan) throw new SCQError("INVALID_PROPOSAL", `Item ${change.itemId} not found on subscription`);
      const targetRatePlan = OFFERING_TO_RATEPLAN[change.offeringRef];
      if (!targetRatePlan) throw new SCQError("UNSUPPORTED_CHANGE", `Unknown offeringRef ${change.offeringRef}`);
      const orderActions: OrderAction[] = [
        { type: "RemoveProduct", effectiveDate, ratePlanId: plan.id },
        { type: "AddProduct", effectiveDate, productRatePlanId: targetRatePlan, quantity: plan.ratePlanCharges[0].quantity },
      ];
      const preview = sim.previewOrder(subscriptionId, orderActions);
      return { orderActions, effect: buildCommercialEffect(preview, effectiveDate) };
    }
    case "CHANGE_CADENCE": {
      const plan = sub.ratePlans[0];
      if (!plan) throw new SCQError("INVALID_PROPOSAL", "Subscription has no rate plans");
      const targetKey = change.cadence === "ANNUAL" ? "plan:basic:annual" : "plan:basic:monthly";
      const targetRatePlan = OFFERING_TO_RATEPLAN[targetKey];
      const orderActions: OrderAction[] = [
        { type: "RemoveProduct", effectiveDate, ratePlanId: plan.id },
        { type: "AddProduct", effectiveDate, productRatePlanId: targetRatePlan, quantity: plan.ratePlanCharges[0].quantity },
        // Deliberately NO TermsAndConditions action here — see
        // capabilitiesFor(): this is why CHANGE_CADENCE's termEffect is
        // UNKNOWN, not EXACT, even though financial dimensions are.
      ];
      const preview = sim.previewOrder(subscriptionId, orderActions);
      return { orderActions, effect: buildCommercialEffect(preview, effectiveDate) };
    }
    case "CANCEL": {
      // effectiveDate has ALREADY been resolved from the proposal-level
      // effectiveIntent by the caller (createChangeQuote) — for
      // "TERM_END" it is already sub.term.termEndDate, for "DATE" it is
      // already the caller's requested date, for "IMMEDIATE" it is today.
      // cancellationPolicy is Zuora's own real parameter naming for the
      // same distinction (EndOfLastInvoicePeriod only makes sense when the
      // date being passed genuinely IS the term end — this sim treats any
      // non-"today" date the same way Zuora's real API would for a
      // scheduled cancellation).
      const isToday = effectiveDate === new Date(sim.currentTime()).toISOString().slice(0, 10);
      const cancellationPolicy = isToday ? "Today" : "EndOfLastInvoicePeriod";
      const orderActions: OrderAction[] = [{ type: "CancelSubscription", effectiveDate, cancellationPolicy }];
      const preview = sim.previewOrder(subscriptionId, orderActions);
      return {
        orderActions,
        effect: buildCommercialEffect(preview, effectiveDate),
        quoteLevelTermOverride: quoteLevelCancelTermCoverage(sub),
      };
    }
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

    const resolved = proposal.changes.map((change) => resolveOneChange(this.sim, subscriptionId, sub, change, effectiveDate));
    const orderActions = resolved.flatMap((r) => r.orderActions);
    const commercialEffect = combineEffects(resolved.map((r) => r.effect));

    // Per-change coverage, but a CANCEL's termEffect is resolved at the
    // QUOTE level (per this specific subscription's term state), not just
    // the coarse action-level default — see quoteLevelCancelTermCoverage.
    const perChangeCoverage = proposal.changes.map((change, i) => {
      const base = perChangeCapabilities[i].guaranteeCoverage;
      const override = resolved[i].quoteLevelTermOverride;
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
    // scq-engine.ts.
    const cached = checkIdempotentReplay(this.store, quoteId);
    if (cached) return cached;

    const quote = this.store.get(quoteId);
    if (!quote) {
      throw new SCQError("QUOTE_STALE", `No quote found for id ${quoteId}`);
    }

    // --- Version check: Zuora's REAL, native, monotonic version integer,
    // compared against the version captured at quote time. This is a
    // stronger DETECTION primitive than Stripe/Paddle's synthetic content
    // hash. HOWEVER this is still a SEPARATE read call from the mutating
    // createOrder() call below — see the extensive v0.4 comment history
    // and the v0.5 TOCTOU re-test. Zuora's version field makes staleness
    // DETECTION more reliable; it does not make the commit ATOMIC.
    const currentSub = this.sim.get(quote.subscription_id);
    const currentVersion = String(currentSub.version);

    // Reachable only if COMMITTED without a commit_receipt (structurally
    // impossible given recordCommitReceipt's atomic write) — a normal
    // repeated commit is already handled by checkIdempotentReplay above.
    if (quote.status === "COMMITTED") throw new SCQError("CHANGE_CONFLICT", `Quote ${quoteId} is marked COMMITTED but has no recorded receipt.`);
    if (quote.status === "SUPERSEDED") throw new SCQError("QUOTE_STALE", `Quote ${quoteId} was superseded.`);
    if (new Date() > new Date(quote.expires_at)) {
      this.store.updateStatus(quoteId, "EXPIRED");
      throw new SCQError("QUOTE_EXPIRED", `Quote ${quoteId} expired at ${quote.expires_at}.`);
    }
    if (quote.subscription_version_at_quote !== currentVersion) {
      this.store.updateStatus(quoteId, "STALE");
      throw new SCQError(
        "QUOTE_STALE",
        `Subscription ${quote.subscription_id} version changed since quote ${quoteId} was created ` +
          `(quoted version ${quote.subscription_version_at_quote}, current ${currentVersion}). No mutation was performed.`,
        { quotedVersion: quote.subscription_version_at_quote, currentVersion }
      );
    }

    const input = quote.provider_preview_input as ZuoraPreviewInput;
    const proposal = quote.proposal;
    const effectiveMode = quote.effective_guarantee_mode;
    const allCancel = proposal.changes.every((c) => c.action === "CANCEL");
    let committedEffect: CommercialEffect;

    if (effectiveMode === "REVALIDATE" && !allCancel) {
      // Order per spec: re-preview -> evaluate acceptance envelope -> mutate
      // -> fetch resulting state -> receipt. Zuora's order preview is
      // non-mutating, same as Stripe/Paddle's, so this ordering is
      // achievable here too.
      const freshPreview = this.sim.previewOrder(quote.subscription_id, input.orderActions);
      const revalidated = buildCommercialEffect(freshPreview, quote.quoted_effect.effectiveAt ?? new Date().toISOString());
      const violation = checkAcceptanceEnvelope(quote.quoted_effect, revalidated, proposal.acceptanceEnvelope!);
      if (violation) {
        throw new SCQError(
          "QUOTE_DRIFTED",
          `Recomputed commercial effect fell outside the caller's acceptance envelope: ${violation}. No mutation was performed.`,
          { quoted: quote.quoted_effect, revalidated, envelope: proposal.acceptanceEnvelope }
        );
      }
      committedEffect = revalidated;
    } else {
      // EXACT: replay the exact orderActions captured at quote time,
      // including the exact effectiveDate(s). Because Zuora order pricing
      // is a deterministic function of (rate plan charges, effectiveDate)
      // — not ambient wall-clock "now" — replaying verbatim reproduces the
      // quoted numbers exactly, PROVIDED the version check above passed.
      committedEffect = quote.quoted_effect;
    }

    let resultingSub: ZuoraSubscription;
    try {
      // A single createOrder() call carries ALL orderActions from every
      // change in the batch — this is what makes multi-change Zuora
      // proposals genuinely ATOMIC: one order, one version bump, applied
      // together or not at all (see multiChangePairSupport).
      const { subscription } = this.sim.createOrder(quote.subscription_id, input.orderActions);
      resultingSub = subscription;
    } catch (e) {
      throw toSCQError(e, quote.subscription_id);
    }

    // v0.6.1: post-commit reconciliation — see stripe-adapter.ts's
    // identical comment for full rationale.
    const reconciliation = reconcileCommittedEffect(quote.quoted_effect, committedEffect, proposal.acceptanceEnvelope);

    const receipt: SubscriptionChangeReceipt = {
      quoteId,
      subscriptionRef: quote.subscription_id,
      status: "COMMITTED",
      quotedEffect: quote.quoted_effect,
      committedEffect,
      guaranteeMode: effectiveMode,
      consistencyGuarantee: "BEST_EFFORT",
      multiChangeConsistency: quote.multi_change_consistency,
      reconciliation,
      resultingSnapshot: snapshotFrom(resultingSub),
      committedAt: new Date().toISOString(),
    };
    this.store.recordCommitReceipt(quoteId, receipt);
    return receipt;
  }
}

function buildCommercialEffect(
  preview: import("./zuora-sim.js").OrderPreviewResult,
  effectiveAt: string
): CommercialEffect {
  return {
    immediate: preview.netImmediate !== 0
      ? {
          charge: preview.netImmediate > 0 ? preview.netImmediate : undefined,
          credit: preview.netImmediate < 0 ? -preview.netImmediate : undefined,
          net: preview.netImmediate,
        }
      : undefined,
    recurring: {
      resultingAmount: preview.resultingRecurringAmount,
      currency: "usd",
      cadence: preview.resultingCadence,
    },
    term: preview.termConsequenceKnown
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
        },
    effectiveAt,
  };
}

function toSCQError(e: unknown, subscriptionId: string): SCQError {
  if (e instanceof ZuoraSimError) {
    if (e.code === "SubscriptionNotFound") return new SCQError("SUBSCRIPTION_NOT_FOUND", `Subscription ${subscriptionId} not found`, e);
    return new SCQError("PROVIDER_ERROR", e.message, e);
  }
  if (e instanceof SCQError) return e;
  return new SCQError("PROVIDER_ERROR", String(e));
}

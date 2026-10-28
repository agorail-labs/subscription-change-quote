// EXPERIMENTAL — SCQ Live Chargebee Validation (v1), NOT a production SDK.
//
// A Chargebee (Product Catalog 2.0) adapter for SCQ v0.6.1 backed by the
// real HTTP API shape (via chargebee-http.ts), isolated from the four
// simulator-backed adapters. It exists to test SCQ's claims against
// Chargebee's documented contract, not to be deployed.
//
// HONEST CAPABILITY POSTURE (see research/chargebee-live-v1/API-CONTRACT-AUDIT.md):
//   - No documented pinning mechanism (no proration_date equivalent, no
//     effective-date-pinned estimate token) exists that would let an
//     estimate be replayed verbatim at commit. Financial coverage is
//     therefore REVALIDATE, never EXACT, in this adapter. Requesting
//     EXACT is refused, naming the failing dimension.
//   - termEffect is UNKNOWN: term reset (force_term_reset / billing-period
//     change), contract terms, and scheduled-change interactions are not
//     deterministically derivable from the estimate/update responses.
//   - Scheduling taxonomy (Phase 2B, 2026-10-27 — canonical table in
//     spec/ERRATA-v0.6.1.md §6): IMMEDIATE in this adapter is
//     "Supported and tested" (mocked-transport tests; live execution
//     BLOCKED). TERM_END and DATE via update_for_items are
//     "Unsupported by the current adapter" (mechanisms documented but
//     deprecated). DATE/TERM_END via Ramps is "Site-feature-dependent
//     or early-access" (not implemented). Committed-term CANCEL is
//     "Site-feature-dependent" (Contract Terms; UNVERIFIED).
//   - Only IMMEDIATE is supported. Rationale (Phase 2A, Task 3 — kept
//     explicit so a future reader does not "fix" this by wiring the
//     deprecated parameters back in): scheduling on update_for_items
//     exists in current docs ONLY as deprecated-but-documented paths —
//     the `end_of_term` boolean / `change_option=end_of_term`, and
//     `change_option=specific_date` + `changes_scheduled_at` for a
//     future date (deprecated for scheduling; still documented for
//     backdating) — all deprecated in favor of Ramps. Ramps is Early
//     Access, site-gated, and a separate resource with its own
//     semantics (effective_from required, future-only, >=24h between
//     ramps, max 12 upcoming) that this experiment does not implement
//     and no site-specific validation has covered. Deprecated-but-
//     documented is therefore treated as NOT SUPPORTED by this
//     adapter: TERM_END and DATE are refused with UNSUPPORTED_CHANGE
//     before any provider call, not silently mapped onto a deprecated
//     parameter, and they stay refused until a Ramps implementation
//     is validated against a specific site's configuration.
//   - consistencyGuarantee is BEST_EFFORT: resource_version is a
//     millisecond timestamp useful for stale-state DETECTION, but no
//     documented compare-and-swap precondition exists on
//     update_for_items, so the check-then-mutate TOCTOU window is real.
//   - Commit is DISABLED unless liveCommitEnabled is explicitly true
//     (SCQ_LIVE_COMMIT_ENABLED=true in the demo/driver). When disabled,
//     commitChangeQuote refuses BEFORE any mutating call.
//   - The mutating call always sends invoice_immediately=false (charges
//     land as unbilled charges; no invoice collection is triggered by
//     default) and replace_items_list=true with the FULL intended item
//     list (without it, Chargebee's documented default is additive —
//     see the audit).
//   - Native idempotency: the mutating call carries
//     chargebee-idempotency-key = a deterministic key derived from the
//     SCQ quote id, so a legitimate retry of the SAME commit within
//     Chargebee's documented 30-minute window replays instead of
//     re-applying. SCQ's own receipt replay (checkIdempotentReplay) is
//     checked first and has no 30-minute limit, but it lives in the
//     in-memory QuoteStore: after a process restart it cannot prove
//     exactly-once anything (see LIMITATIONS-AND-GAPS.md).
//   - DURABILITY LIMIT (Phase 2A, Task 6 — do not soften): there is NO
//     indefinitely-safe idempotency in this stack. Receipt replay
//     depends on volatile in-memory state (lost on restart; T13 fails
//     closed rather than proving exactly-once), and the native
//     backstop expires after 30 minutes, rejects same-key/different-
//     parameters retries with 422, returns 409 while the original is
//     in flight, and CACHES 5xx responses under the key (a 5xx retry
//     needs a NEW key, which re-opens double-mutation risk unless
//     state is reconciled by re-reading first). A conforming live
//     deployment requires a durable transactional quote/receipt
//     store plus retention of the native key and exact request
//     parameters — neither is provided here.
//   - SCHEDULED CHANGES / MANDATORY ADDONS (Phase 2A recovery audit):
//     a forward update_for_items call can delete or override a
//     subscription's pre-existing scheduled changes (documented
//     product behavior: a new change overrides the scheduled one;
//     even unrelated subscription changes can remove a scheduled
//     cancellation), and NOTHING in this adapter snapshots or
//     restores them. Likewise the adapter sends no
//     `mandatory_items_to_remove`, so mandatory addons auto-attached
//     to a plan are outside its item-set guarantee. See
//     research/chargebee-live-v1/RECOVERY-AUDIT.md before treating
//     any forward-then-reverse procedure as a complete recovery.

import crypto from "node:crypto";
import {
  SCQError,
  type CommercialEffect,
  type GuaranteeCoverage,
  type ProviderCapabilities,
  type SubscriptionChangeProposal,
  type SubscriptionChangeQuote,
  type SubscriptionChangeReceipt,
  type SubscriptionProvider,
  type SubscriptionSnapshot,
} from "../core/types.js";
import {
  checkIdempotentReplay,
  enforceEffectiveIntent,
  enforceGuaranteeRequest,
  reconcileCommittedEffect,
  resolveGuaranteeMode,
  validateCommit,
  checkAcceptanceEnvelope,
} from "../core/scq-engine.js";
import { QuoteStore, type StoredQuote } from "../store/quote-store.js";
import { ChargebeeClient, ChargebeeHttpError } from "./chargebee-http.js";

const QUOTE_TTL_MS = 5 * 60 * 1000;

const COVERAGE: GuaranteeCoverage = {
  immediateFinancialEffect: "REVALIDATE",
  recurringFinancialEffect: "REVALIDATE",
  termEffect: "UNKNOWN",
  effectiveAt: "REVALIDATE",
};

type LivePreviewInput = {
  items: Array<{ itemPriceId: string; quantity: number }>;
  idempotencyKey: string;
};

type CbSubscription = {
  id: string;
  status: string;
  currency_code?: string;
  resource_version?: number;
  current_term_start?: number;
  current_term_end?: number;
  next_billing_at?: number;
  has_scheduled_changes?: boolean;
  has_scheduled_advance_invoices?: boolean;
  subscription_items?: Array<{ item_price_id: string; quantity: number; unit_price?: number; amount?: number }>;
};

function fingerprintOf(sub: CbSubscription): string {
  if (typeof sub.resource_version === "number") return `rv:${sub.resource_version}`;
  const material = JSON.stringify({
    status: sub.status,
    items: (sub.subscription_items ?? []).map((i) => ({ p: i.item_price_id, q: i.quantity, u: i.unit_price })),
    termEnd: sub.current_term_end ?? null,
    sched: sub.has_scheduled_changes ?? false,
  });
  return "hash:" + crypto.createHash("sha256").update(material).digest("hex").slice(0, 16);
}

function snapshotFrom(sub: CbSubscription): SubscriptionSnapshot {
  const items = sub.subscription_items ?? [];
  const recurring = items.reduce((s, i) => s + (i.amount ?? (i.unit_price ?? 0) * i.quantity), 0);
  return {
    id: sub.id,
    version: fingerprintOf(sub),
    status: sub.status === "cancelled" ? "canceled" : sub.status,
    // For the live API, the stable per-item identifier available in every
    // payload is item_price_id; SCQ itemId in this adapter IS the
    // item_price_id. (Simulator adapters use synthetic line ids instead.)
    items: items.map((i) => ({ id: i.item_price_id, offeringRef: i.item_price_id, quantity: i.quantity })),
    billing: {
      currency: sub.currency_code ?? "USD",
      recurringAmount: recurring,
      cadence: "MONTHLY",
      nextBillingAt: sub.next_billing_at ? new Date(sub.next_billing_at * 1000).toISOString() : undefined,
    },
    term: { commitmentUntil: "UNKNOWN", autoRenew: undefined },
  };
}

function estimateEffect(estimate: any, currency: string): CommercialEffect {
  const inv = estimate?.invoice_estimate;
  const unbilled = (estimate?.unbilled_charge_estimates ?? []) as Array<{ amount?: number }>;
  const creditNotes = (estimate?.credit_note_estimates ?? []) as Array<{ total?: number }>;
  let net: number | undefined;
  if (inv && typeof inv.total === "number") net = inv.total;
  else if (unbilled.length > 0) net = unbilled.reduce((s, u) => s + (u.amount ?? 0), 0);
  if (net !== undefined) net -= creditNotes.reduce((s, c) => s + (c.total ?? 0), 0);
  const subEstItems = (estimate?.subscription_estimate?.subscription_items ?? []) as Array<{ quantity: number; unit_price?: number; amount?: number }>;
  const recurring = subEstItems.length > 0
    ? subEstItems.reduce((s, i) => s + (i.amount ?? (i.unit_price ?? 0) * i.quantity), 0)
    : undefined;
  const effect: CommercialEffect = { recurring: recurring !== undefined ? { resultingAmount: recurring, currency } : undefined };
  if (net !== undefined && net !== 0) effect.immediate = { charge: net > 0 ? net : undefined, credit: net < 0 ? -net : undefined, net };
  return effect;
}

export type ChargebeeLiveAdapterOptions = {
  /** Default false. When false, commitChangeQuote refuses before any mutating call. */
  liveCommitEnabled?: boolean;
  now?: () => Date;
};

export class ChargebeeLiveAdapter implements SubscriptionProvider {
  private now: () => Date;
  constructor(
    private client: ChargebeeClient,
    private store: QuoteStore,
    private opts: ChargebeeLiveAdapterOptions = {},
  ) { this.now = opts.now ?? (() => new Date()); }

  getCapabilities(): ProviderCapabilities {
    const caps = { guaranteeCoverage: { ...COVERAGE }, supportedEffectiveIntents: ["IMMEDIATE"] as Array<"IMMEDIATE"> };
    return {
      quoteCapabilities: {
        CHANGE_QUANTITY: caps,
        CHANGE_PLAN: caps,
        // CHANGE_CADENCE and CANCEL are refused by this experimental
        // adapter (term-reset and cancel_for_items semantics are outside
        // the validated scope) — they are intentionally absent here
        // rather than advertised and then mishandled.
      },
      consistencyGuarantee: "BEST_EFFORT",
    };
  }

  private async readSubscription(id: string): Promise<CbSubscription> {
    try {
      const { json } = await this.client.getSubscription(id);
      const sub = (json as any)?.subscription as CbSubscription | undefined;
      if (!sub) throw new SCQError("PROVIDER_ERROR", `Chargebee retrieve for subscription ${id} returned no subscription object`);
      return sub;
    } catch (e) {
      throw this.toSCQ(e, id);
    }
  }

  async getSubscription(subscriptionId: string): Promise<SubscriptionSnapshot> {
    return snapshotFrom(await this.readSubscription(subscriptionId));
  }

  private updateParams(items: Array<{ itemPriceId: string; quantity: number }>): Record<string, unknown> {
    return {
      subscription_items: items.map((i) => ({ item_price_id: i.itemPriceId, quantity: i.quantity })),
      // Full-list replacement semantics are REQUIRED for the SCQ intent
      // ("the item list becomes exactly this") — Chargebee's documented
      // default (false) is additive and would silently retain addons.
      // Documented caveat (Phase 2A re-verified on the update page):
      // with a plan in the list, replace_items_list=true replaces the
      // ENTIRE list; with an addons-only list the plan is always
      // retained and mandatory addons survive replacement unless named
      // in `mandatory_items_to_remove`. This adapter sends no
      // mandatory_items_to_remove and targets plan-inclusive lists, so
      // it does NOT claim the resulting item set is exact for
      // subscriptions carrying mandatory addons auto-attached to the
      // target plan — post-commit reconciliation reads the ACTUAL
      // state rather than assuming the sent list is the final list.
      replace_items_list: true,
      prorate: true,
      // No default invoice collection: charges land as unbilled charges.
      invoice_immediately: false,
      change_option: "immediately",
    };
  }

  async createChangeQuote(subscriptionId: string, proposal: SubscriptionChangeProposal): Promise<SubscriptionChangeQuote> {
    if (proposal.changes.length === 0) throw new SCQError("INVALID_PROPOSAL", "proposal.changes must contain at least one change");
    if (proposal.changes.length > 1) {
      throw new SCQError("UNSUPPORTED_CHANGE", "The experimental live Chargebee adapter validates single-change proposals only; multi-change live behavior is UNVERIFIED and is refused before any provider call.", { changes: proposal.changes.map((c) => c.action).join("+") });
    }
    const change = proposal.changes[0];
    if (change.action !== "CHANGE_QUANTITY" && change.action !== "CHANGE_PLAN") {
      throw new SCQError("UNSUPPORTED_CHANGE", `The experimental live Chargebee adapter does not implement ${change.action} (outside the validated scope); refused before any provider call.`);
    }
    // Refuse unsupported effective intents BEFORE any provider call at all
    // (stronger than the spec's "before preview/mutation" floor).
    enforceEffectiveIntent(proposal.effectiveIntent, ["IMMEDIATE"]);

    const sub = await this.readSubscription(subscriptionId);
    const effectiveMode = resolveGuaranteeMode(proposal);
    // EXACT is refused here, before the estimate call, naming the failing
    // dimension — this adapter cannot back EXACT on any financial dim.
    enforceGuaranteeRequest(proposal.changes, effectiveMode, COVERAGE, proposal.acceptanceEnvelope);

    const currentItems = (sub.subscription_items ?? []).map((i) => ({ itemPriceId: i.item_price_id, quantity: i.quantity }));
    let targetItems: Array<{ itemPriceId: string; quantity: number }>;
    if (change.action === "CHANGE_QUANTITY") {
      if (!currentItems.some((i) => i.itemPriceId === change.itemId)) throw new SCQError("INVALID_PROPOSAL", `Item ${change.itemId} (item_price_id) not found on subscription`);
      targetItems = currentItems.map((i) => (i.itemPriceId === change.itemId ? { ...i, quantity: change.quantity } : i));
    } else {
      if (!currentItems.some((i) => i.itemPriceId === change.itemId)) throw new SCQError("INVALID_PROPOSAL", `Item ${change.itemId} (item_price_id) not found on subscription`);
      targetItems = currentItems.map((i) => (i.itemPriceId === change.itemId ? { ...i, itemPriceId: change.offeringRef } : i));
    }

    let estimate: any;
    try {
      const { json } = await this.client.estimateUpdateForItems(subscriptionId, this.updateParams(targetItems));
      estimate = (json as any)?.estimate;
    } catch (e) { throw this.toSCQ(e, subscriptionId); }
    if (!estimate) throw new SCQError("PROVIDER_ERROR", "Chargebee estimate returned no estimate object");

    const currency = sub.currency_code ?? "USD";
    const commercialEffect = estimateEffect(estimate, currency);
    commercialEffect.effectiveAt = this.now().toISOString();
    if (!commercialEffect.recurring) {
      // The estimate's subscription_estimate is the only documented source
      // for the resulting item set; if it is absent we compute recurring
      // from the target items at CURRENT unit prices and mark nothing
      // stronger — coverage is already REVALIDATE.
      const priceById = new Map((sub.subscription_items ?? []).map((i) => [i.item_price_id, i.unit_price ?? 0]));
      commercialEffect.recurring = { resultingAmount: targetItems.reduce((s, i) => s + (priceById.get(i.itemPriceId) ?? 0) * i.quantity, 0), currency };
    }

    const quoteId = `scq_cblive_${crypto.randomBytes(8).toString("hex")}`;
    const expiresAt = new Date(this.now().getTime() + QUOTE_TTL_MS).toISOString();
    const stored: StoredQuote<LivePreviewInput> = {
      quote_id: quoteId,
      provider: "chargebee",
      subscription_id: subscriptionId,
      subscription_version_at_quote: fingerprintOf(sub),
      proposal,
      effective_guarantee_mode: effectiveMode,
      guarantee_coverage: { ...COVERAGE },
      multi_change_consistency: "ATOMIC",
      provider_preview_input: { items: targetItems, idempotencyKey: `scq-${quoteId}`.slice(0, 100) },
      quoted_effect: commercialEffect,
      created_at: this.now().toISOString(),
      expires_at: expiresAt,
      status: "ACTIVE",
    };
    this.store.put(stored as StoredQuote);
    return {
      id: quoteId,
      subscriptionRef: subscriptionId,
      preconditions: { subscriptionVersion: fingerprintOf(sub) },
      proposal,
      guaranteeMode: effectiveMode,
      guaranteeCoverage: { ...COVERAGE },
      multiChangeConsistency: "ATOMIC",
      commercialEffect,
      validUntil: expiresAt,
      providerMetadata: {
        source: "chargebee-live-experimental",
        resourceVersion: sub.resource_version ?? null,
        hasScheduledChanges: sub.has_scheduled_changes ?? false,
        hasScheduledAdvanceInvoices: sub.has_scheduled_advance_invoices ?? false,
        scheduledChangesWarning: sub.has_scheduled_changes
          ? "Subscription has scheduled changes (has_scheduled_changes=true). An immediate update can interact with / supersede scheduled changes per Chargebee's documented 'impacts on existing scheduled changes'; SCQ does not model that interaction — termEffect is UNKNOWN and no scheduled-change guarantee is made."
          : undefined,
        rampsNote: "TERM_END/DATE scheduling via the deprecated change_option paths and via Ramps (early access) is NOT implemented or validated by this adapter.",
      },
    };
  }

  async commitChangeQuote(quoteId: string): Promise<SubscriptionChangeReceipt> {
    // SCQ receipt replay first — before any provider read or mutation
    // (spec §6.10). Bounded by the in-memory store's lifetime; see T13.
    const cached = checkIdempotentReplay(this.store, quoteId);
    if (cached) return cached;
    const stored0 = this.store.get(quoteId);
    if (!stored0) throw new SCQError("QUOTE_STALE", `No quote found for id ${quoteId}; if the process restarted, the in-memory quote store lost this quote and exactly-once cannot be proven — refusing rather than re-mutating blindly.`);

    const input = stored0.provider_preview_input as LivePreviewInput;
    const current = await this.readSubscription(stored0.subscription_id);
    const validated = validateCommit(this.store, quoteId, fingerprintOf(current), this.now);
    const proposal = validated.proposal;

    // Final pre-mutation preview (REVALIDATE): envelope is enforced
    // against THIS preview, before mutation (spec §4.2 clarification 1).
    let freshEstimate: any;
    try {
      const { json } = await this.client.estimateUpdateForItems(validated.subscription_id, this.updateParams(input.items));
      freshEstimate = (json as any)?.estimate;
    } catch (e) { throw this.toSCQ(e, validated.subscription_id); }
    const currency = current.currency_code ?? "USD";
    const revalidated = estimateEffect(freshEstimate, currency);
    revalidated.effectiveAt = validated.quoted_effect.effectiveAt;
    if (!revalidated.recurring) revalidated.recurring = validated.quoted_effect.recurring;
    const violation = checkAcceptanceEnvelope(validated.quoted_effect, revalidated, proposal.acceptanceEnvelope!);
    if (violation) {
      throw new SCQError("QUOTE_DRIFTED", `Recomputed commercial effect fell outside the caller's acceptance envelope: ${violation}. No mutation was performed.`, { quoted: validated.quoted_effect, revalidated, envelope: proposal.acceptanceEnvelope });
    }

    if (!this.opts.liveCommitEnabled) {
      throw new SCQError("PROVIDER_ERROR", "BLOCKED — LIVE COMMIT DISABLED (SCQ_LIVE_COMMIT_ENABLED is not 'true'). Quote and pre-mutation revalidation completed; no mutating call was made.", { blocked: "LIVE_COMMIT_DISABLED" });
    }

    let updateJson: any;
    try {
      const { json } = await this.client.updateForItems(validated.subscription_id, this.updateParams(input.items), input.idempotencyKey);
      updateJson = json;
    } catch (e) {
      if (e instanceof ChargebeeHttpError && e.indeterminate) {
        // Lost-response path: DO NOT re-issue the mutation. Reconcile by
        // re-reading provider state. If the intended item set is exactly
        // present, the mutation landed — record the receipt from actual
        // state. Otherwise fail closed as indeterminate.
        const after = await this.readSubscription(validated.subscription_id);
        const actualItems = (after.subscription_items ?? []).map((i) => ({ itemPriceId: i.item_price_id, quantity: i.quantity }));
        const landed = JSON.stringify(actualItems) === JSON.stringify(input.items);
        if (!landed) {
          throw new SCQError("PROVIDER_ERROR", "Commit outcome is INDETERMINATE: the mutating request's response was lost and provider state does not show the intended change. No second mutation was issued. Reconcile manually before any retry.", { indeterminate: true, reconciled: false });
        }
        const committedEffect = this.committedEffectFromState(validated.quoted_effect, after, revalidated);
        return this.recordReceipt(validated, snapshotFrom(after), committedEffect, proposal);
      }
      throw this.toSCQ(e, validated.subscription_id);
    }

    // Post-commit reconciliation (§6.11): committedEffect is derived from
    // ACTUAL post-commit state (re-read) plus the invoice/unbilled total
    // the mutating call itself returned — not from the pre-mutation
    // preview — so a concurrent write landing in the TOCTOU window is
    // reported as VIOLATED, never silently absorbed.
    const after = await this.readSubscription(validated.subscription_id);
    const committedEffect = this.committedEffectFromState(validated.quoted_effect, after, revalidated, updateJson);
    return this.recordReceipt(validated, snapshotFrom(after), committedEffect, proposal);
  }

  private committedEffectFromState(quoted: CommercialEffect, after: CbSubscription, fallback: CommercialEffect, updateJson?: any): CommercialEffect {
    const items = after.subscription_items ?? [];
    const recurringAmount = items.reduce((s, i) => s + (i.amount ?? (i.unit_price ?? 0) * i.quantity), 0);
    const invoiceTotal = updateJson?.invoice?.total;
    const unbilledTotal = (updateJson?.unbilled_charges as Array<{ amount?: number }> | undefined)?.reduce((s, u) => s + (u.amount ?? 0), 0);
    const net = typeof invoiceTotal === "number" ? invoiceTotal : typeof unbilledTotal === "number" && unbilledTotal !== 0 ? unbilledTotal : fallback.immediate?.net;
    const effect: CommercialEffect = {
      recurring: { resultingAmount: recurringAmount, currency: after.currency_code ?? quoted.recurring?.currency ?? "USD" },
      effectiveAt: quoted.effectiveAt,
    };
    if (net !== undefined && net !== 0) effect.immediate = { charge: net > 0 ? net : undefined, credit: net < 0 ? -net : undefined, net };
    return effect;
  }

  private recordReceipt(validated: StoredQuote, snap: SubscriptionSnapshot, committedEffect: CommercialEffect, proposal: SubscriptionChangeProposal): SubscriptionChangeReceipt {
    const reconciliation = reconcileCommittedEffect(validated.quoted_effect, committedEffect, proposal.acceptanceEnvelope);
    const receipt: SubscriptionChangeReceipt = {
      quoteId: validated.quote_id,
      subscriptionRef: validated.subscription_id,
      status: "COMMITTED",
      resultingSnapshot: snap,
      quotedEffect: validated.quoted_effect,
      committedEffect,
      guaranteeMode: validated.effective_guarantee_mode,
      consistencyGuarantee: "BEST_EFFORT",
      multiChangeConsistency: validated.multi_change_consistency,
      reconciliation,
      committedAt: this.now().toISOString(),
    };
    this.store.recordCommitReceipt(validated.quote_id, receipt);
    return receipt;
  }

  private toSCQ(e: unknown, subscriptionId: string): SCQError {
    if (e instanceof SCQError) return e;
    if (e instanceof ChargebeeHttpError) {
      if (e.httpStatus === 404) return new SCQError("SUBSCRIPTION_NOT_FOUND", `Subscription ${subscriptionId} not found`, { httpStatus: e.httpStatus, apiErrorCode: e.apiErrorCode });
      return new SCQError("PROVIDER_ERROR", e.message, { httpStatus: e.httpStatus, apiErrorCode: e.apiErrorCode, indeterminate: e.indeterminate, retryAfterSeconds: e.retryAfterSeconds });
    }
    return new SCQError("PROVIDER_ERROR", String(e));
  }
}

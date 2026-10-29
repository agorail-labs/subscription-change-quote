// In-memory fake modeling Chargebee's Subscriptions API.
//
// Originally grounded in documented Chargebee behavior as understood
// when written; the load-bearing assumptions were re-audited against
// the current official Product Catalog 2.0 documentation in Phase 1
// (research/chargebee-live-v1/API-CONTRACT-AUDIT.md, docs re-read
// 2026-10-27) and corrected in Phase 2A where they did not match —
// each correction is flagged inline below. Remaining uncertain points
// are flagged explicitly, same posture as the other three sims:
//
// - Chargebee's core object is a Subscription with a `subscription_items[]`
//   array (each item referencing an `item_price_id` from Chargebee's
//   Product Catalog v2, with its own `quantity`, `unit_price`, and
//   `billing_period`/`billing_period_unit`), plus subscription-level
//   `status`, `current_term_start`/`current_term_end`,
//   `next_billing_at`, `auto_close_invoices`, and a `contract_term`
//   sub-object (`action_at_term_end`, `contract_start`, `contract_end`,
//   `total_contract_value`) for accounts using Chargebee's "Contract
//   Terms" feature — NOT every Chargebee subscription has one; contract
//   terms are an opt-in feature per plan/customer, unlike Zuora where a
//   term structure is a standard part of every subscription. We model
//   both an evergreen (no contract_term) and a committed-term Chargebee
//   subscription, mirroring the Zuora fixtures, since the API genuinely
//   supports both shapes.
// - `POST /subscriptions/{id}/update_for_items` (Chargebee's item-based
//   subscription update endpoint, the modern Product Catalog v2
//   equivalent of the older non-itemized `update` endpoint) accepts
//   `subscription_items[]`, `invoice_immediately`, `prorate`, and
//   `billing_alignment_mode`, and can change quantity AND swap item prices
//   (plan/cadence changes) in ONE call.
//   Phase 2A CORRECTION (supersedes the scheduling paragraph that stood
//   here through v0.6.1): `effective_from` is NOT a documented parameter
//   of `update_for_items` in the current Product Catalog 2.0 docs — it
//   is the required parameter of Create-a-ramp (Ramps, Early Access).
//   Scheduling on the update endpoint itself exists only via
//   deprecated-but-documented paths: the `end_of_term` boolean and
//   `change_option=end_of_term` (both deprecated toward Ramps) and
//   `change_option=specific_date` + `changes_scheduled_at` for a future
//   date (deprecated for scheduling; still documented for backdating).
//   This simulator's `effectiveFrom` field and pending-scheduled-change
//   machinery below are therefore a SIMULATOR-ONLY model of legacy
//   scheduled-change behavior, kept exercisable at the sim layer; the
//   simulator-backed adapter no longer sends a future `effectiveFrom`
//   and refuses DATE (and TERM_END for update-backed actions) — see
//   chargebee-adapter.ts capabilitiesFor. Do not cite this sim as
//   evidence that `update_for_items` accepts `effective_from`: that
//   claim is NOT ESTABLISHED (which is weaker than, and different from,
//   a claim that no equivalent mechanism exists anywhere).
// - Preview: Chargebee has a genuine, documented non-mutating ESTIMATE
//   endpoint family (`POST /estimates/update_subscription_for_items`)
//   that returns the resulting invoice estimate (immediate
//   charge/credit line items) and the resulting subscription estimate
//   (next-term amounts) WITHOUT mutating anything — analogous to
//   Stripe's upcoming-invoice preview and Zuora's order preview.
//   Phase 2A CORRECTION: an earlier version of this header described a
//   `POST /subscriptions/{id}/update_for_items?estimate=true`-style
//   preview on the update endpoint itself; no such preview parameter
//   is documented — the separate estimates family is the documented
//   preview (API-CONTRACT-AUDIT.md A10/D-5).
// - Cancellation: `POST /subscriptions/{id}/cancel_for_items` with
//   `end_of_term: true|false`. `end_of_term: true` schedules cancellation
//   for `current_term_end` (subscription stays "active" until then,
//   analogous to Stripe's cancel_at_period_end); `end_of_term: false`
//   cancels immediately. If a `contract_term` is active and cancellation
//   happens before `contract_end`, Chargebee can apply an
//   "early cancellation" consequence governed by
//   `contract_term.action_at_term_end` / a configured cancellation charge.
//   Phase 2A CORRECTION (the v0.6 correction in chargebee-adapter.ts
//   already retracted the adapter-level claim; this header lagged it):
//   an earlier version of this paragraph claimed Chargebee's
//   contract_term data makes committed-term cancellation termEffect
//   EXACT, as a "genuine, real difference" from Zuora. That claim was
//   simulator-only, was never verified against a site with Contract
//   Terms enabled, and is RETRACTED: the adapter reports UNKNOWN for
//   committed-term CANCEL, and the deterministic early-termination fee
//   this sim computes in previewCancel() is a simulator invention kept
//   only so the sim's arithmetic is exercisable — it is NOT documented
//   Chargebee behavior and no capability claim may be derived from it.
// - Versioning / concurrency: Chargebee subscriptions do NOT expose a
//   documented monotonic version integer analogous to Zuora's `version`
//   field, as far as we are aware (uncertainty flagged — not verified
//   against live docs). The closest thing is `updated_at`/`resource_version`
//   millisecond timestamps on some Chargebee API responses, which are
//   NOT guaranteed strictly monotonic across all mutation types the way
//   Zuora's integer is, and are not documented as a compare-and-swap
//   precondition value. We model Chargebee like Stripe/Paddle here: no
//   native version field, SCQ falls back to a synthetic content-hash
//   fingerprint (see `fingerprint()` below) rather than inventing a
//   version field Chargebee may not genuinely offer.
// - `update_for_items` does not accept an "only apply if resource_version
//   == X" precondition parameter as far as we are aware — same structural
//   TOCTOU gap as the other three providers.
// - v0.6.2 (PR-6): every mutating call now also persists a
//   `ChargebeeMutationArtifact` (see its type doc) — a SIMULATOR-ONLY
//   model of an independently retrievable operation record, so the
//   adapter's post-commit verification has provider-side evidence to
//   bind to (the real API's operation retrieval surface is not what
//   is modeled here; nothing about the artifact is a claim about the
//   real API). Because there is no native version, the artifact
//   brackets its execution with content-hash fingerprints — the
//   strongest attribution evidence this model can honestly offer,
//   and attribution still caps outcomes (adapter, PR #14 Z1–Z3).

import crypto from "node:crypto";

export type ChargebeeItemPrice = {
  id: string;
  unitAmount: number; // minor units
  currency: string;
  billingPeriodUnit: "month" | "year";
};

export type ChargebeeSubscriptionItem = {
  id: string; // subscription_item id (Chargebee generates one per line)
  itemPriceId: string;
  quantity: number;
};

export type ChargebeeContractTerm = {
  contractStart: string; // ISO date
  contractEnd: string; // ISO date
  actionAtTermEnd: "renew" | "evergreen" | "cancel";
};

export type ChargebeeSubscription = {
  id: string; // e.g. AzloOLSp3S1WQZM
  status: "active" | "cancelled" | "non_renewing";
  subscriptionItems: ChargebeeSubscriptionItem[];
  currentTermStart: string;
  currentTermEnd: string;
  nextBillingAt: string | null;
  /** Present only for subscriptions using Chargebee's opt-in Contract Terms feature — NOT every subscription has one, unlike Zuora's always-present term structure. */
  contractTerm?: ChargebeeContractTerm;
  scheduledCancellationAt?: string | null;
};

export type UpdateForItemsInput = {
  items: Array<{ itemPriceId: string; quantity: number }>;
  prorate: boolean;
  /**
   * SIMULATOR-ONLY scheduling field — NOT a documented
   * `update_for_items` parameter (Phase 2A correction; see file
   * header). undefined = apply now; an ISO timestamp = the sim holds
   * the change as pending until that instant, modeling legacy
   * scheduled-change behavior at the sim layer only. The
   * simulator-backed adapter never sends a future value after
   * Phase 2A.
   */
  effectiveFrom?: string;
};

export type EstimateResult = {
  invoiceEstimateLineItems: Array<{ description: string; amount: number }>;
  /**
   * v0.6.2 (PR-6): figure fields are OPTIONAL — absent means the
   * estimate could NOT establish that dimension (e.g. an existing
   * subscription item whose item_price_id is absent from the
   * modeled catalog: the pre-migration code priced such an item at
   * a silent 0, which fabricated both the proration delta and the
   * resulting level). Absent is UNKNOWN — never a zero, never a
   * fallback. Present values (including a present 0) are the
   * estimate's established figures.
   */
  netImmediate?: number;
  resultingRecurringAmount?: number;
  resultingCadence: "MONTHLY" | "ANNUAL";
};

/**
 * v0.6.2 (PR-6): a PERSISTED mutation artifact — the identifiable
 * record an `updateForItems` / `cancelForItems` call leaves behind,
 * independently readable via `retrieveMutation()`. This is the
 * minimal sim-only model the migration requires: pre-migration, the
 * mutating calls returned only the mutated subscription (and, for
 * updates, a preview-shaped result computed from the PRE-mutation
 * state), so no operation identity survived and post-commit
 * verification had nothing provider-side to bind to. The record's
 * financial fields are the figures the operation computed AT
 * EXECUTION for the request exactly as dispatched — the operation's
 * own financial evidence, distinct from any pre-execution estimate
 * the adapter took. Under the `_debugOmitMutationFinancials` fault
 * the financial fields are absent at runtime — readers must treat a
 * missing figure as unestablished, never as zero.
 *
 * Attribution evidence: Chargebee has NO native monotonic version
 * (see file header), so the artifact brackets its execution with
 * the subscription's content-hash fingerprints — the state it
 * observed when it began (`fingerprintBefore`) and the state it
 * produced (`fingerprintAfter`). Those two hashes, compared
 * against the fingerprint a commit validated and the fingerprint
 * of the state read back at verification time, are the strongest
 * attribution evidence this provider model can honestly provide;
 * where the bracket does not close, the adapter caps the outcome
 * at COMMITTED_UNVERIFIED (PR #14 corrections Z1–Z3, applied
 * here). Update and cancel artifacts are DISTINCT kinds with
 * distinct id namespaces — the two endpoints are separate
 * operations and their identities are never conflated.
 */
export type ChargebeeMutationArtifact = {
  id: string;
  kind: "update" | "cancel";
  subscriptionId: string;
  /**
   * The request exactly as dispatched — for an update, the full
   * item list + prorate flag (the commercial content of the
   * `update_for_items` request); for a cancel, the `end_of_term`
   * boolean (the whole content of the `cancel_for_items` request).
   */
  request: { items: Array<{ itemPriceId: string; quantity: number }>; prorate: boolean } | { endOfTerm: boolean };
  /** Update only: the execution's established immediate figure (absent = not established). */
  netImmediate?: number;
  /** Update only: the execution's invoice line items. */
  invoiceEstimateLineItems?: Array<{ description: string; amount: number }>;
  /** Update only: the execution's established resulting recurring level (absent = not established). */
  resultingRecurringAmount?: number;
  /** Update only: the execution's resulting cadence. */
  resultingCadence?: "MONTHLY" | "ANNUAL";
  /**
   * Cancel only: the cancellation's established immediate figure,
   * present only when the execution's own cancel estimate
   * established the termination consequence
   * (`earlyTerminationChargeKnown`). Absent when not established.
   */
  cancelNetImmediate?: number;
  /** Cancel only: whether the execution established the termination consequence at all. */
  earlyTerminationChargeKnown?: boolean;
  /** Content-hash fingerprint of the subscription state when this operation began executing. */
  fingerprintBefore: string;
  /** Content-hash fingerprint of the subscription state this operation produced. */
  fingerprintAfter: string;
  /** The subscription status the execution produced. */
  resultingStatus: ChargebeeSubscription["status"];
  /** The scheduled cancellation timestamp the execution produced (cancel operations). */
  resultingScheduledCancellationAt?: string | null;
  executedAt: string;
};

const ITEM_PRICE_CATALOG: Record<string, ChargebeeItemPrice> = {
  ip_seat_basic_monthly: { id: "ip_seat_basic_monthly", unitAmount: 1000, currency: "usd", billingPeriodUnit: "month" },
  ip_seat_pro_monthly: { id: "ip_seat_pro_monthly", unitAmount: 1500, currency: "usd", billingPeriodUnit: "month" },
  ip_seat_basic_annual: { id: "ip_seat_basic_annual", unitAmount: 10000, currency: "usd", billingPeriodUnit: "year" },
};

export class ChargebeeSim {
  private subs = new Map<string, ChargebeeSubscription>();
  private mutations = new Map<string, ChargebeeMutationArtifact>();
  private now: Date;

  // v0.6.2 (PR-6) fault-injection hooks (the states the migration's
  // negative matrix needs and ordinary simulator flows cannot
  // produce). All default off; tests set them explicitly. Confined
  // to this simulator — the adapter contains no fault branches.
  /** previewUpdate returns its result WITHOUT the immediate figure (surface only). */
  _debugOmitPreviewImmediate = false;
  /** previewUpdate returns its result WITHOUT the recurring figure (surface only). */
  _debugOmitPreviewRecurring = false;
  /** The persisted mutation artifact is stored WITHOUT its financial fields. */
  _debugOmitMutationFinancials = false;
  /** retrieveMutation throws — the persisted artifact is unavailable to readers. */
  _debugFailMutationReads = false;
  /** Subscription reads throw once any mutation has landed (post-mutation read outage). */
  _debugFailSubscriptionReadsAfterMutation = false;
  /** The next mutating call APPLIES and PERSISTS its artifact, then throws a connection-class error instead of returning (lost response). One-shot. */
  _debugLoseNextMutationResponse = false;
  /**
   * Misexecution hooks (PR #14 Z1/Z2 pattern): the next update's
   * own APPLICATION diverges from the request it was given — the
   * operation itself lands wrong while its artifact keeps the
   * dispatched request and figures and the fingerprint bracket
   * closes honestly around the applied state (attribution
   * unbroken: the wrongness is THIS operation's, provably).
   * Distinct from `_debugMutateDirectly`, which models a DIFFERENT
   * actor's change (and therefore breaks attribution). One-shot.
   */
  /** Next update applies its first item with THIS quantity instead of the requested one. */
  _debugWrongQuantityOnNextUpdate: number | undefined = undefined;
  /** Next update applies its first item with THIS item_price_id instead of the requested one. */
  _debugWrongItemPriceOnNextUpdate: string | undefined = undefined;
  /** Next end-of-term cancel applies as an IMMEDIATE cancellation instead. One-shot. */
  _debugCancelImmediatelyOnNextCancel = false;
  /** Set once any mutation has landed in this sim; gates `_debugFailSubscriptionReadsAfterMutation`. */
  private hasLandedMutation = false;
  /**
   * Per-subscription WRITE SEQUENCE, mixed into the state
   * fingerprint (see computeFingerprint). The real API's
   * `resource_version` is a millisecond timestamp that changes on
   * EVERY write — including a write that restores the exact prior
   * content. A pure content hash cannot see such a round-trip; the
   * write sequence gives the sim's synthetic fingerprint the same
   * write-sensitivity, so attribution evidence can distinguish
   * "never touched" from "touched and restored". It is NOT a
   * compare-and-swap precondition: nothing compares or enforces
   * it; it only makes intervening writes DETECTABLE.
   */
  private writeSequence = new Map<string, number>();

  private bumpWriteSequence(subscriptionId: string): void {
    this.writeSequence.set(subscriptionId, (this.writeSequence.get(subscriptionId) ?? 0) + 1);
  }
  /** Simulates a scheduled future change that hasn't executed yet — keyed by subscription id. SIMULATOR-ONLY model of legacy scheduled-change behavior (the real mechanisms are the deprecated update paths and Early-Access Ramps — see file header); just enough to exercise the sim's own pending-change arithmetic, not evidence about the real API's scheduling execution. */
  private pendingScheduled = new Map<string, { effectiveFrom: string; items: Array<{ itemPriceId: string; quantity: number }> }>();

  constructor(now = new Date()) {
    this.now = now;
  }

  advanceTimeSeconds(seconds: number): void {
    this.now = new Date(this.now.getTime() + seconds * 1000);
    this.applyDuePendingChanges();
  }

  currentTime(): Date {
    return this.now;
  }

  seedSubscription(sub: ChargebeeSubscription): void {
    this.subs.set(sub.id, sub);
  }

  get(id: string): ChargebeeSubscription {
    if (this._debugFailSubscriptionReadsAfterMutation && this.hasLandedMutation) {
      throw new ChargebeeSimError(
        "read_unavailable",
        "Simulated subscription read failure: subscription reads are unavailable after a mutation has landed (fault injection)"
      );
    }
    const sub = this.subs.get(id);
    if (!sub) throw new ChargebeeSimError("resource_not_found", `Subscription ${id} not found`);
    return structuredClone(sub);
  }

  /** Out-of-band mutation simulating a different system directly changing state. */
  _debugMutateDirectly(id: string, mutator: (sub: ChargebeeSubscription) => void): void {
    const sub = this.subs.get(id);
    if (!sub) throw new ChargebeeSimError("resource_not_found", `Subscription ${id} not found`);
    mutator(sub);
    this.bumpWriteSequence(id);
  }

  /** POST /estimates/update_subscription_for_items — non-mutating. */
  previewUpdate(subscriptionId: string, input: UpdateForItemsInput): EstimateResult {
    const sub = this.get(subscriptionId);
    const result = this.computeUpdateEffect(sub, input);
    if (this._debugOmitPreviewImmediate || this._debugOmitPreviewRecurring) {
      // Fault injection at the preview SURFACE only: the returned
      // result omits the figure(s), modeling an estimate response
      // that cannot establish them. The underlying computation (and
      // any later mutation for the same request) is unaffected.
      const shaped = { ...result } as unknown as Record<string, unknown>;
      if (this._debugOmitPreviewImmediate) {
        delete shaped.netImmediate;
        delete shaped.invoiceEstimateLineItems;
      }
      if (this._debugOmitPreviewRecurring) {
        delete shaped.resultingRecurringAmount;
      }
      return shaped as unknown as EstimateResult;
    }
    return result;
  }

  /** POST /subscriptions/{id}/update_for_items — mutates (or schedules, if effectiveFrom is a future timestamp). */
  updateForItems(
    subscriptionId: string,
    input: UpdateForItemsInput
  ): { subscription: ChargebeeSubscription; result: EstimateResult; operationId: string } {
    const sub = this.subs.get(subscriptionId);
    if (!sub) throw new ChargebeeSimError("resource_not_found", `Subscription ${subscriptionId} not found`);

    const fingerprintBefore = this.computeFingerprint(sub, subscriptionId);

    // Misexecution fault injection (see the hooks' declarations):
    // transform the items used for application. The execution's
    // financials below are computed over the APPLIED items — a
    // misexecution bills for what it actually applied — while the
    // artifact's `request` keeps the request exactly as dispatched,
    // which is what lets post-commit verification detect the
    // divergence between the two.
    let appliedItems = input.items;
    if (this._debugWrongQuantityOnNextUpdate !== undefined || this._debugWrongItemPriceOnNextUpdate !== undefined) {
      const wrongQuantity = this._debugWrongQuantityOnNextUpdate;
      const wrongItemPrice = this._debugWrongItemPriceOnNextUpdate;
      this._debugWrongQuantityOnNextUpdate = undefined;
      this._debugWrongItemPriceOnNextUpdate = undefined;
      appliedItems = input.items.map((it, i) =>
        i === 0
          ? {
              itemPriceId: wrongItemPrice ?? it.itemPriceId,
              quantity: wrongQuantity ?? it.quantity,
            }
          : it
      );
    }
    const result = this.computeUpdateEffect(sub, { ...input, items: appliedItems });

    const isFuture = input.effectiveFrom && new Date(input.effectiveFrom).getTime() > this.now.getTime();
    if (isFuture) {
      // Simulator-only pending-change model: the change is held,
      // NOT applied to subscription_items immediately. (Not a claim
      // about the real API — see file header, Phase 2A correction.)
      this.pendingScheduled.set(subscriptionId, { effectiveFrom: input.effectiveFrom!, items: appliedItems });
    } else {
      this.applyItems(sub, appliedItems);
    }
    this.bumpWriteSequence(subscriptionId);

    // v0.6.2 (PR-6): persist the mutation as an identifiable,
    // independently readable artifact BEFORE returning — the
    // operation's own record of the request it dispatched, the
    // figures it computed at execution, and the state fingerprints
    // bracketing its execution. Post-commit verification binds to
    // THIS record by id, never to a latest-mutation pointer and
    // never to a pre-execution estimate.
    const artifact: ChargebeeMutationArtifact = {
      id: `cbupd_${crypto.randomBytes(8).toString("hex")}`,
      kind: "update",
      subscriptionId,
      request: { items: structuredClone(input.items), prorate: input.prorate },
      ...(result.netImmediate !== undefined ? { netImmediate: result.netImmediate } : {}),
      invoiceEstimateLineItems: structuredClone(result.invoiceEstimateLineItems),
      ...(result.resultingRecurringAmount !== undefined ? { resultingRecurringAmount: result.resultingRecurringAmount } : {}),
      resultingCadence: result.resultingCadence,
      fingerprintBefore,
      fingerprintAfter: this.computeFingerprint(sub, subscriptionId),
      resultingStatus: sub.status,
      resultingScheduledCancellationAt: sub.scheduledCancellationAt ?? null,
      executedAt: this.now.toISOString(),
    };
    this.persistMutation(artifact);
    this.throwIfResponseLost("update_for_items");

    return { subscription: structuredClone(sub), result, operationId: artifact.id };
  }

  private applyItems(sub: ChargebeeSubscription, items: Array<{ itemPriceId: string; quantity: number }>): void {
    sub.subscriptionItems = items.map((it, i) => ({
      id: sub.subscriptionItems[i]?.id ?? `sub_item_${crypto.randomBytes(4).toString("hex")}`,
      itemPriceId: it.itemPriceId,
      quantity: it.quantity,
    }));
  }

  private applyDuePendingChanges(): void {
    for (const [subId, pending] of this.pendingScheduled.entries()) {
      if (new Date(pending.effectiveFrom).getTime() <= this.now.getTime()) {
        const sub = this.subs.get(subId);
        if (sub) {
          this.applyItems(sub, pending.items);
          this.bumpWriteSequence(subId);
        }
        this.pendingScheduled.delete(subId);
      }
    }
  }

  /** POST /subscriptions/{id}/cancel_for_items */
  cancelForItems(subscriptionId: string, endOfTerm: boolean): { subscription: ChargebeeSubscription; operationId: string } {
    const sub = this.subs.get(subscriptionId);
    if (!sub) throw new ChargebeeSimError("resource_not_found", `Subscription ${subscriptionId} not found`);

    const fingerprintBefore = this.computeFingerprint(sub, subscriptionId);
    // The execution's own cancel estimate, computed BEFORE applying:
    // the operation's financial evidence — what the cancellation
    // itself established at execution (NOT a later re-derivation).
    const executionEstimate = this.previewCancel(subscriptionId, endOfTerm);

    // Misexecution fault injection: an end-of-term cancel that
    // lands as an immediate termination. The artifact below keeps
    // the DISPATCHED endOfTerm; only the applied state diverges.
    let appliedEndOfTerm = endOfTerm;
    if (this._debugCancelImmediatelyOnNextCancel) {
      this._debugCancelImmediatelyOnNextCancel = false;
      appliedEndOfTerm = false;
    }

    if (appliedEndOfTerm) {
      sub.status = "non_renewing";
      sub.scheduledCancellationAt = sub.currentTermEnd;
    } else {
      sub.status = "cancelled";
      sub.scheduledCancellationAt = null;
    }
    this.bumpWriteSequence(subscriptionId);

    // v0.6.2 (PR-6): persist the cancellation as its own artifact
    // kind — a cancel operation's identity is never an update's.
    const artifact: ChargebeeMutationArtifact = {
      id: `cbcxl_${crypto.randomBytes(8).toString("hex")}`,
      kind: "cancel",
      subscriptionId,
      request: { endOfTerm },
      ...(executionEstimate.earlyTerminationChargeKnown && executionEstimate.netImmediate !== undefined
        ? { cancelNetImmediate: executionEstimate.netImmediate }
        : {}),
      earlyTerminationChargeKnown: executionEstimate.earlyTerminationChargeKnown,
      fingerprintBefore,
      fingerprintAfter: this.computeFingerprint(sub, subscriptionId),
      resultingStatus: sub.status,
      resultingScheduledCancellationAt: sub.scheduledCancellationAt ?? null,
      executedAt: this.now.toISOString(),
    };
    this.persistMutation(artifact);
    this.throwIfResponseLost("cancel_for_items");

    return { subscription: structuredClone(sub), operationId: artifact.id };
  }

  private persistMutation(artifact: ChargebeeMutationArtifact): void {
    if (this._debugOmitMutationFinancials) {
      // Fault injection: the artifact persists WITHOUT its
      // financial evidence — readers find the artifact but no
      // actuals in it.
      const shaped = artifact as unknown as Record<string, unknown>;
      delete shaped.netImmediate;
      delete shaped.invoiceEstimateLineItems;
      delete shaped.resultingRecurringAmount;
      delete shaped.cancelNetImmediate;
    }
    this.mutations.set(artifact.id, artifact);
    this.hasLandedMutation = true;
  }

  private throwIfResponseLost(endpoint: string): void {
    if (this._debugLoseNextMutationResponse) {
      // Fault injection: everything above HAS landed (state
      // applied, artifact persisted) — only the response never
      // reaches the caller.
      this._debugLoseNextMutationResponse = false;
      throw new ChargebeeSimError(
        "api_connection_error",
        `Simulated lost response: the ${endpoint} mutation was applied and persisted but its response never reached the caller (fault injection)`
      );
    }
  }

  /**
   * v0.6.2 (PR-6): reads back a PERSISTED mutation artifact by its
   * id — the independent post-commit read the adapter's
   * verification binds to.
   */
  retrieveMutation(operationId: string): ChargebeeMutationArtifact {
    if (this._debugFailMutationReads) {
      throw new ChargebeeSimError("read_unavailable", "Simulated mutation read failure: the mutation store is unavailable (fault injection)");
    }
    const artifact = this.mutations.get(operationId);
    if (!artifact) throw new ChargebeeSimError("resource_not_found", `Mutation ${operationId} not found`);
    return structuredClone(artifact);
  }

  /** All persisted mutation artifacts for a subscription, in execution order (defensive copies). */
  mutationsFor(subscriptionId: string): ChargebeeMutationArtifact[] {
    return Array.from(this.mutations.values())
      .filter((m) => m.subscriptionId === subscriptionId)
      .map((m) => structuredClone(m));
  }

  /**
   * The id of the most recent persisted mutation for a
   * subscription, or null. A DIVERGENCE SIGNAL ONLY (mirrors
   * Zuora's latestOrderId): financial actuals are never read
   * through this pointer — a later mutation may have replaced it.
   */
  latestMutationId(subscriptionId: string): string | null {
    const list = Array.from(this.mutations.values()).filter((m) => m.subscriptionId === subscriptionId);
    return list.length > 0 ? list[list.length - 1].id : null;
  }

  /** Non-mutating cancellation estimate. */
  previewCancel(
    subscriptionId: string,
    endOfTerm: boolean
  ): { netImmediate?: number; earlyTerminationChargeKnown: boolean; earlyTerminationCharge?: number } {
    const sub = this.get(subscriptionId);
    if (!sub.contractTerm) {
      // Evergreen (no contract term): fully known, no fee.
      return { netImmediate: 0, earlyTerminationChargeKnown: true };
    }
    const termEnd = new Date(sub.contractTerm.contractEnd);
    const cancelDate = endOfTerm ? new Date(sub.currentTermEnd) : this.now;
    const cancelingEarly = cancelDate < termEnd;
    if (!cancelingEarly) {
      return { netImmediate: 0, earlyTerminationChargeKnown: true };
    }
    // SIMULATOR INVENTION (Phase 2A correction): the pro-rata charge
    // computed below is this sim's own simplified formula. It is NOT
    // documented Chargebee behavior, the committed-term case is
    // UNVERIFIED against a real site, and the adapter deliberately
    // does not derive any EXACT claim from this number (it reports
    // termEffect UNKNOWN for committed-term subscriptions). An earlier
    // comment here claimed a "documented asymmetry vs. Zuora"; that
    // claim is retracted — see file header.
    //
    // v0.6.2 (PR-6): the determinacy signal now reports this
    // honestly. `earlyTerminationChargeKnown` is FALSE for this
    // branch: the formula's output survives only as
    // `earlyTerminationCharge` — a modeled candidate figure, NOT an
    // established consequence — and NO `netImmediate` is asserted.
    // (Pre-migration this branch returned known: true with the
    // formula as netImmediate, and the adapter quoted that invented
    // fee as the cancellation's plain immediate figure — probe F.)
    // A catalog miss on any existing item makes even the candidate
    // uncomputable; it is then absent too (never a silent 0).
    const remainingDays = (termEnd.getTime() - cancelDate.getTime()) / (24 * 3600 * 1000);
    let monthlyValue = 0;
    let monthlyValueKnown = true;
    for (const item of sub.subscriptionItems) {
      const price = ITEM_PRICE_CATALOG[item.itemPriceId];
      if (!price) {
        monthlyValueKnown = false;
        break;
      }
      monthlyValue += price.unitAmount * item.quantity;
    }
    return {
      earlyTerminationChargeKnown: false,
      ...(monthlyValueKnown ? { earlyTerminationCharge: Math.round(monthlyValue * (remainingDays / 30)) } : {}),
    };
  }

  /**
   * Content-hash fingerprint over mutable fields — same SCQ-layer
   * workaround as the Stripe/Paddle sims, since Chargebee also has no
   * confirmed native version field (see file header).
   */
  fingerprint(subscriptionId: string): string {
    return this.computeFingerprint(this.get(subscriptionId), subscriptionId);
  }

  /** The fingerprint computation itself, over a state in hand — used for the public fingerprint and for mutation artifacts' execution brackets. */
  private computeFingerprint(sub: ChargebeeSubscription, subscriptionId: string): string {
    const material = JSON.stringify({
      status: sub.status,
      items: sub.subscriptionItems.map((i) => ({ itemPriceId: i.itemPriceId, quantity: i.quantity })),
      currentTermStart: sub.currentTermStart,
      currentTermEnd: sub.currentTermEnd,
      scheduledCancellationAt: sub.scheduledCancellationAt ?? null,
      hasPendingScheduledChange: this.pendingScheduled.has(subscriptionId),
      // Write-sensitivity, modeling resource_version semantics (see
      // the writeSequence declaration): every state write — even
      // one restoring identical content — yields a new fingerprint.
      writeSequence: this.writeSequence.get(subscriptionId) ?? 0,
    });
    return crypto.createHash("sha256").update(material).digest("hex").slice(0, 16);
  }

  private computeUpdateEffect(sub: ChargebeeSubscription, input: UpdateForItemsInput): EstimateResult {
    const isFuture = input.effectiveFrom && new Date(input.effectiveFrom).getTime() > this.now.getTime();
    // v0.6.2 (PR-6): a catalog miss on ANY priced item — an existing
    // subscription item or an item in the requested list — makes the
    // affected figures UNESTABLISHABLE (absent from the result),
    // never a silent 0 and never a fabricated total. Pre-migration,
    // an existing item missing from the catalog silently contributed
    // 0 to oldRecurring (probe E), and an unknown requested price
    // threw — two different wrong answers to the same gap.
    let oldRecurring = 0;
    let oldRecurringKnown = true;
    for (const i of sub.subscriptionItems) {
      const price = ITEM_PRICE_CATALOG[i.itemPriceId];
      if (!price) {
        oldRecurringKnown = false;
        break;
      }
      oldRecurring += price.unitAmount * i.quantity;
    }
    let newRecurring = 0;
    let newRecurringKnown = true;
    let resultingCadence: "MONTHLY" | "ANNUAL" = "MONTHLY";
    for (const it of input.items) {
      const price = ITEM_PRICE_CATALOG[it.itemPriceId];
      if (!price) {
        newRecurringKnown = false;
        continue;
      }
      newRecurring += price.unitAmount * it.quantity;
      resultingCadence = price.billingPeriodUnit === "year" ? "ANNUAL" : "MONTHLY";
    }
    const figuresKnown = oldRecurringKnown && newRecurringKnown;

    const lineItems: EstimateResult["invoiceEstimateLineItems"] = [];
    if (!isFuture && input.prorate && figuresKnown) {
      // Simulator proration arithmetic: a fraction-of-term calculation
      // against the sim's OWN clock (`this.now` at call time) and the
      // subscription's current_term boundaries. Phase 2A CORRECTION:
      // an earlier version of this comment concluded "this is why
      // Chargebee's financial dimensions can be EXACT" — that does not
      // follow. Determinism INSIDE the simulator proves nothing about
      // the real estimate->update pair, for which no pinning/replay
      // mechanism is documented and multiple drift sources exist
      // (site-setting defaults, balances, conditional tax, the
      // prorate caveat). The adapter therefore reports REVALIDATE for
      // both financial dimensions, and its commit path re-derives the
      // effect and enforces the caller's envelope against the fresh
      // preview — exactly because a later "now" CAN change the number,
      // as Test 11a now demonstrates.
      const termStart = new Date(sub.currentTermStart).getTime();
      const termEnd = new Date(sub.currentTermEnd).getTime();
      const periodLength = termEnd - termStart;
      const asOf = this.now.getTime();
      const fractionRemaining = periodLength > 0 ? Math.max(0, termEnd - asOf) / periodLength : 0;
      const delta = Math.round((newRecurring - oldRecurring) * fractionRemaining);
      if (delta !== 0) {
        lineItems.push({ description: delta > 0 ? "Prorated charge" : "Prorated credit", amount: delta });
      }
    }
    // Future-scheduled changes bill nothing now — the charge lands on the
    // invoice generated when the scheduled change actually executes.

    const netImmediate = lineItems.reduce((sum, l) => sum + l.amount, 0);
    return {
      invoiceEstimateLineItems: lineItems,
      // v0.6.2 (PR-6): figures are present only when established.
      // The proration delta needs BOTH recurring levels; the
      // resulting level needs the requested list fully priced. An
      // unestablishable figure is ABSENT (UNKNOWN to its reader),
      // never the partial sum the priced subset would produce.
      ...(figuresKnown ? { netImmediate } : {}),
      ...(newRecurringKnown ? { resultingRecurringAmount: newRecurring } : {}),
      resultingCadence,
    };
  }
}

export class ChargebeeSimError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

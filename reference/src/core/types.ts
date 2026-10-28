// SCQ v0.6 — normalized subscription-change-quote types (PROTOCOL FREEZE
// CANDIDATE).
//
// Changes from v0.5 (see research-findings.md "v0.6" section, and
// scq-v0.6-spec.md for the normative spec this cycle produces):
//
//   - `requestedEffectiveAt: string | undefined` (a bare optional ISO
//     date) is REPLACED by `effectiveIntent: EffectiveIntent`, a closed,
//     REQUIRED, discriminated union:
//       { type: "IMMEDIATE" } | { type: "TERM_END" } | { type: "DATE"; at: string }
//     This was forced by a real finding from the v0.5-LIVE Chargebee
//     validation cycle, not invented speculatively: real Chargebee exposes
//     TWO distinct, non-interchangeable scheduling mechanisms —
//     `effective_from` (an arbitrary caller-chosen future timestamp) and
//     `end_of_term=true` (deferred to the CURRENT billing term's natural
//     boundary, a structurally different concept a caller might
//     deliberately prefer for billing-alignment reasons). v0.5's single
//     `requestedEffectiveAt: string` could not express this distinction —
//     a caller wanting "at term end" had no way to say so without either
//     computing the term-end date themselves (fragile — the adapter, not
//     the caller, knows the current term boundary) or omitting the field
//     and getting "now." `EffectiveIntent` makes the three cases the
//     research has actually found across four providers into a closed
//     enum: "apply now" (all four providers), "apply at the current term
//     boundary" (CANCEL's PERIOD_END on Stripe/Paddle/Zuora/Chargebee, and
//     now also CHANGE_QUANTITY/CHANGE_PLAN via Chargebee's real
//     `end_of_term`), and "apply on this arbitrary caller-chosen date"
//     (Zuora's order effectiveDate, Chargebee's effective_from). No fourth
//     case was added speculatively — see scq-v0.6-spec.md "non-goals" for
//     what was deliberately left out.
//   - `effectiveIntent` REPLACES `ChangeSpec.effectivePolicy` too, not just
//     the old `requestedEffectiveAt`. v0.5's `effectivePolicy` was a
//     per-change field with a real design flaw the freeze candidate closes:
//     three of the four ChangeSpec variants had `effectivePolicy: "IMMEDIATE"`
//     as their ONLY legal value (a single-member literal type — not a real
//     choice, just inherited shape from CANCEL's genuine two-value case),
//     and CANCEL's own "IMMEDIATE" | "PERIOD_END" is exactly the same
//     concept "TERM_END" now names consistently across every action. Having
//     the concept spelled two different ways (`effectivePolicy` on
//     ChangeSpec vs. `requestedEffectiveAt` on the proposal, for what is
//     structurally the same "when does this take effect" question) was a
//     genuine inconsistency this freeze candidate must not carry forward.
//     `effectiveIntent` is therefore PROPOSAL-LEVEL (applying to the whole
//     batch, unchanged from v0.5's proposal-level `requestedEffectiveAt`
//     placement — see v0.5 rationale below for why per-change granularity
//     was not added), and `ChangeSpec.effectivePolicy` is REMOVED entirely.
//   - Providers MUST explicitly report which `EffectiveIntent.type` values
//     they support, per action, via the NEW `supportedEffectiveIntents`
//     field on `GuaranteeCoverage`-adjacent... actually placed directly on
//     `QuoteCapabilities`'s per-action entry (see `ActionCapabilities`
//     below) — NOT silently inferred from `effectiveAt` coverage, because
//     "can this dimension be pinned exactly" (an EXACT/REVALIDATE question)
//     and "which scheduling mechanisms exist at all" (a support/no-support
//     question, independent of exactness) are two different questions a
//     single field conflated in earlier cycles. Requesting an unsupported
//     `EffectiveIntent.type` is refused with `UNSUPPORTED_CHANGE` at
//     `createChangeQuote` time, exactly as v0.5 already refused an
//     unsupported arbitrary date — this generalizes that same enforcement
//     to all three intent types, not just DATE.
//   - `UNSUPPORTED_CHANGE_SET` (new `SCQErrorCode`) is added as a NORMATIVE
//     requirement, not just an implementation choice: if a provider adapter
//     determines that submitting a multi-change proposal AS SUBMITTED could
//     result in the provider silently applying only a SUBSET of the
//     requested changes (i.e. a genuine partial-execution risk, distinct
//     from `MultiChangeConsistency: "UNSUPPORTED"` which already covers
//     "this combination cannot even be attempted together"), the adapter
//     MUST return `UNSUPPORTED_CHANGE_SET` and MUST NOT perform ANY
//     mutating call. This was forced by a real, confirmed finding from the
//     v0.5-LIVE cycle: real Chargebee's `update_for_items` and
//     `cancel_for_items` endpoints do NOT reject unrecognized/foreign
//     parameters with an error — they silently ignore them and return
//     HTTP 200, meaning a naively-constructed bundled request could
//     "succeed" while only partially applying. `MultiChangeConsistency:
//     "UNSUPPORTED"` (v0.5) already causes a refusal for combinations an
//     adapter statically knows can't be attempted together at all; this new
//     rule is a stricter, complementary safety net specifically against
//     the "the provider might ACCEPT the request but silently drop part of
//     it" failure mode the live cycle discovered — see
//     scq-v0.6-spec.md §4 for the normative rule text.
//   - No other new abstractions were added, per the task's explicit
//     "protocol freeze candidate — do not add providers, make only these
//     changes" scope. `GuaranteeCoverage`, `REVALIDATE` as default,
//     `quotedEffect`/`committedEffect`, `ConsistencyGuarantee`,
//     `MultiChangeConsistency`, and the `UNKNOWN` sentinel are ALL
//     PRESERVED UNCHANGED from v0.5 — see the preserved rationale sections
//     below for why each exists. Nothing about Chargebee's committed-term
//     CANCEL row was "fixed" or designed around; it remains marked
//     UNVERIFIED (see research-findings.md v0.6 section) because the v0.5-
//     LIVE cycle found no real evidence for or against the simulator's
//     claim, and this freeze candidate must not encode an unverified
//     simulator result into the frozen schema as though it were confirmed.
//
// IMPORTANT: nothing in this file may name a specific provider ("stripe" /
// "paddle" / "zuora" / "chargebee"). Provider-specific concepts live only
// inside src/adapters/*.
//
// --- v0.5 rationale (preserved) ---
//
//   - `action: ChangeAction` + flat per-action proposal fields were
//     replaced by `changes: ChangeSpec[]` — one or more change specs in a
//     single proposal, forced by Zuora's/Chargebee's real ability to bundle
//     multiple changes into one atomic provider-side operation.
//   - `guaranteeCoverage` (quote-level, NOT provider-level) is the
//     AUTHORITATIVE answer for the SPECIFIC proposal + subscription state a
//     quote was created against. `getCapabilities()` remains coarse,
//     general-purpose discovery. The two MAY differ, by design.
//   - `multiChangeConsistency: "ATOMIC" | "BEST_EFFORT" | "UNSUPPORTED"` is
//     required whenever `changes.length > 1`, always "ATOMIC" trivially for
//     a single-change proposal. "UNSUPPORTED" proposals must be refused
//     outright at quote time, never silently degraded.
//   - No per-change guaranteeMode/acceptanceEnvelope — these stay
//     proposal-level, applying uniformly to the whole batch (still true in
//     v0.6 — this freeze candidate did not revisit that decision).
//
// --- v0.4 rationale (preserved) ---
//
//   - `GuaranteeCoverage` (`immediateFinancialEffect`,
//     `recurringFinancialEffect`, `termEffect`, `effectiveAt`) replaced a
//     single EXACT/REVALIDATE boolean pair, forced by Zuora's order
//     preview genuinely separating these as different guarantee surfaces.
//   - `termEffect` uses `"EXACT" | "UNKNOWN"` (no REVALIDATE option)
//     because there is no non-mutating "re-preview the term consequence"
//     call to fall back to for the cases where it isn't derivable.
//
// --- v0.3 rationale (preserved) ---
//
//   - `guaranteeMode` is optional on the proposal and defaults to
//     "REVALIDATE" when omitted — REVALIDATE remains the protocol default
//     in v0.6, unchanged.
//   - `EXACT` may only be requested where the AUTHORITATIVE (quote-level,
//     since v0.5) coverage backs it on every dimension; requesting EXACT
//     where unsupported is UNSUPPORTED_CHANGE at createChangeQuote time.
//   - `quotedEffect` / `committedEffect` on the receipt: quotedEffect is
//     the untouched historical record of what was quoted; committedEffect
//     is what was actually true at mutation time (defined to equal
//     quotedEffect for EXACT; may legitimately differ for REVALIDATE).
//   - `consistencyGuarantee: "ATOMIC" | "BEST_EFFORT"` reports whether
//     SCQ's own precondition-check-then-mutate sequence is provider-backed
//     atomic or a client-side best-effort race. No adapter in this
//     research has ever reported "ATOMIC" — confirmed directly against a
//     real Chargebee API in the v0.5-LIVE cycle (an `If-Match` header was
//     silently ignored).

export type ChangeAction = "CHANGE_QUANTITY" | "CHANGE_PLAN" | "CHANGE_CADENCE" | "CANCEL";

export type Unknown = "UNKNOWN";

/**
 * v0.6.1 STANDARDS-HARDENING NOTE (no schema change to this type itself —
 * wording only): `"EXACT"` on any `GuaranteeCoverage` dimension means
 * ONLY that the specific commercial-effect dimension it names
 * (`immediateFinancialEffect`, `recurringFinancialEffect`, `termEffect`, or
 * `effectiveAt`) is reproduced exactly between quote and commit. It is NOT
 * a claim that the QUOTE's `CommercialEffect` is a complete or
 * exhaustive accounting of every consequence of the change — in
 * particular, EXACT makes NO claim whatsoever about tax, discounts,
 * currency-conversion effects, or any other commercial dimension that
 * `CommercialEffect` does not model as a field. A caller relying on
 * `guaranteeCoverage.immediateFinancialEffect === "EXACT"` for a
 * tax-inclusive final charge, for example, is relying on something SCQ has
 * never claimed and no adapter in this research computes — every adapter's
 * EXACT mechanism (Stripe's `proration_date` replay, Zuora's/Chargebee's
 * effective-date-pinned order/estimate math) pins ONLY the modeled
 * dimension's own basis; if the underlying provider applies tax or a
 * discount as a SEPARATE step outside that pinned computation, EXACT says
 * nothing about whether that separate step also stayed pinned. This
 * clarification was added because prior cycles' prose ("commit reproduces
 * the quoted effect exactly") could be read as a broader guarantee than
 * the type ever actually backs — see scq-v0.6.1-spec.md §1 for the
 * corrected normative wording.
 */
export type GuaranteeMode = "EXACT" | "REVALIDATE";

/**
 * v0.6: replaces v0.5's bare `requestedEffectiveAt?: string` and v0.1-v0.5's
 * per-ChangeSpec `effectivePolicy` field. A closed, REQUIRED, three-member
 * union — see file header for exactly which real provider mechanisms each
 * case corresponds to and why no fourth case was added.
 *
 *   "IMMEDIATE": apply now. Supported by all four providers modeled in
 *     this research, for every action.
 *   "TERM_END": apply at the CURRENT billing term's natural boundary — the
 *     provider (not the caller) determines the actual date. This is the
 *     same concept v0.1-v0.5 called CANCEL's "PERIOD_END", generalized to
 *     every action, because Chargebee's real `end_of_term=true` mechanism
 *     (confirmed live) applies to CHANGE_QUANTITY/CHANGE_PLAN too, not just
 *     CANCEL.
 *   "DATE": apply on an arbitrary, caller-specified future (or present)
 *     instant. Only Zuora and Chargebee are confirmed (Chargebee: `DATE`
 *     via `effective_from`, NOT independently re-verified end-to-end in
 *     the v0.5-LIVE session — see research-findings.md) to have a genuine
 *     mechanism for this; Stripe/Paddle have none and must refuse a `DATE`
 *     request that isn't effectively "now" (see enforceEffectiveIntent in
 *     scq-engine.ts).
 */
export type EffectiveIntent = { type: "IMMEDIATE" } | { type: "TERM_END" } | { type: "DATE"; at: string };

export type SubscriptionSnapshot = {
  id: string;
  version: string;
  status: string;
  items: Array<{
    id: string;
    offeringRef: string;
    quantity?: number;
  }>;
  billing: {
    currency: string;
    recurringAmount?: number;
    cadence?: string;
    nextBillingAt?: string;
  };
  term?: {
    commitmentUntil?: string | Unknown;
    autoRenew?: boolean;
  };
};

/**
 * Caller-stated tolerance for how far REVALIDATE's recomputed commercial
 * effect may deviate from what was quoted before commit must refuse with
 * QUOTE_DRIFTED. Amounts are minor units, matching commercialEffect shapes.
 * Omitted bounds are treated as "no tolerance in that dimension" (i.e. any
 * deviation there drifts) — callers must opt into slack, not get it by default.
 * Applies to the PROPOSAL as a whole (i.e. to the combined effect of every
 * change in `changes[]`), not per individual change.
 */
export type AcceptanceEnvelope = {
  /** Max increase in immediate.net the caller will accept without reconfirming, minor units. */
  maxImmediateNetIncrease?: number;
  /** Max decrease in an immediate credit magnitude the caller will accept, minor units. */
  maxImmediateCreditDecrease?: number;
  /** Max increase in recurring.resultingAmount the caller will accept, minor units. */
  maxRecurringIncrease?: number;
};

/**
 * v0.6: `effectivePolicy` is REMOVED from every variant — "when does this
 * take effect" is now expressed once, at the proposal level, via
 * `effectiveIntent` (see file header for why the old per-ChangeSpec field
 * was a real design inconsistency, not a stylistic preference).
 */
export type ChangeSpec =
  | { action: "CHANGE_QUANTITY"; itemId: string; quantity: number }
  | { action: "CHANGE_PLAN"; itemId: string; offeringRef: string }
  | { action: "CHANGE_CADENCE"; cadence: "MONTHLY" | "ANNUAL" }
  | { action: "CANCEL" };

// guaranteeMode is optional at the call site; REVALIDATE is the protocol
// default. acceptanceEnvelope is required whenever REVALIDATE is the
// EFFECTIVE mode (explicit or defaulted) — enforced by adapters at
// createChangeQuote time via INVALID_PROPOSAL.
type GuaranteeFields = {
  guaranteeMode?: GuaranteeMode;
  acceptanceEnvelope?: AcceptanceEnvelope;
};

/**
 * v0.6: `effectiveIntent` is now REQUIRED (not optional the way v0.5's
 * `requestedEffectiveAt` was) — a caller must state explicitly when the
 * batch should take effect rather than relying on an implicit "now"
 * default. This is a deliberate normative tightening for the freeze
 * candidate: an unstated default was a source of exactly the kind of
 * silent-behavior-divergence this cycle's other changes (③, the
 * partial-execution rule) are working to eliminate elsewhere in the
 * protocol. `{ type: "IMMEDIATE" }` is the explicit spelling of what v0.5
 * defaulted to silently.
 */
export type SubscriptionChangeProposal = {
  changes: ChangeSpec[];
  effectiveIntent: EffectiveIntent;
} & GuaranteeFields;

export type CommercialEffect = {
  immediate?: { charge?: number; credit?: number; net?: number };
  recurring?: { previousAmount?: number; resultingAmount?: number; currency: string; cadence?: string };
  term?: { createsCommitment?: boolean | Unknown; commitmentUntil?: string | Unknown; autoRenew?: boolean };
  effectiveAt?: string;
};

/**
 * v0.4/v0.5, unchanged: per-dimension guarantee coverage. See file header
 * (v0.4 rationale) for what each dimension means.
 */
export type GuaranteeCoverage = {
  immediateFinancialEffect: "EXACT" | "REVALIDATE";
  recurringFinancialEffect: "EXACT" | "REVALIDATE";
  termEffect: "EXACT" | Unknown;
  effectiveAt: "EXACT" | "REVALIDATE";
};

/**
 * v0.6: per-action capability report, now carrying BOTH the existing
 * GuaranteeCoverage AND the new, independent
 * `supportedEffectiveIntents` — which `EffectiveIntent.type` values this
 * action supports AT ALL, on this provider, in general (coarse,
 * provider-level; a specific quote's actual support is authoritative via
 * the quote's own guaranteeCoverage/commercialEffect.effectiveAt, same
 * "coarse vs. quote-level" split v0.5 established for the other
 * dimensions). Deliberately a SEPARATE field from GuaranteeCoverage, not
 * folded into `effectiveAt`, because "is this schedulable at all" and "if
 * schedulable, is the date pinned EXACTly or only REVALIDATE-able" are two
 * independent questions — see file header.
 */
export type ActionCapabilities = {
  guaranteeCoverage: GuaranteeCoverage;
  supportedEffectiveIntents: Array<EffectiveIntent["type"]>;
};

export type QuoteCapabilities = Partial<Record<ChangeAction, ActionCapabilities>>;

/**
 * "ATOMIC": the provider can guarantee no other actor's mutation lands
 * between SCQ's precondition check and SCQ's own mutation (a real
 * compare-and-swap primitive). "BEST_EFFORT": SCQ's precondition check and
 * its mutation are separate calls with an inherent, unclosable race window.
 * No adapter in this repo has ever reported "ATOMIC" for this — confirmed
 * directly against a real Chargebee API in the v0.5-LIVE cycle (an
 * `If-Match` header was silently ignored, a stale mutation applied
 * unconditionally over a genuine concurrent write). This field must never
 * be "ATOMIC" unless a provider genuinely offers a server-enforced
 * precondition; SCQ has no way to manufacture that itself.
 */
export type ConsistencyGuarantee = "ATOMIC" | "BEST_EFFORT";

/**
 * v0.5, unchanged: whether committing MULTIPLE changes in one proposal
 * (changes.length > 1) applies as a single provider-side atomic operation,
 * a best-effort unrollback-able sequence of separate calls, or isn't
 * offered at all for this combination. Always "ATOMIC" trivially for
 * changes.length === 1. "UNSUPPORTED" proposals are refused outright at
 * quote time (enforceMultiChangeConsistency in scq-engine.ts) — see also
 * the NEW, stricter `UNSUPPORTED_CHANGE_SET` rule below, which covers a
 * distinct failure mode this field alone does not.
 */
export type MultiChangeConsistency = "ATOMIC" | "BEST_EFFORT" | "UNSUPPORTED";

/** Provider-level, coarse discovery — see file header: NOT authoritative for a specific quote. Use quote.guaranteeCoverage (and, for scheduling, the quote's own accepted effectiveIntent) for that. */
export type ProviderCapabilities = {
  quoteCapabilities: QuoteCapabilities;
  consistencyGuarantee: ConsistencyGuarantee;
};

export type SubscriptionChangeQuote = {
  id: string;
  subscriptionRef: string;
  preconditions: { subscriptionVersion: string };
  proposal: SubscriptionChangeProposal;
  /** The effective guaranteeMode this quote was created under (proposal.guaranteeMode, or "REVALIDATE" if omitted). Always present so a caller never has to re-derive the default. */
  guaranteeMode: GuaranteeMode;
  /**
   * AUTHORITATIVE, state-aware guarantee coverage for THIS quote
   * specifically — computed against the actual proposal and actual
   * subscription state at quote time, not just the action type in the
   * abstract. When `changes.length > 1`, this reflects the coverage of
   * the COMBINED effect (the narrowest coverage across all changes in the
   * batch, per dimension).
   */
  guaranteeCoverage: GuaranteeCoverage;
  /** Always present. "ATOMIC" (trivially) when changes.length === 1. */
  multiChangeConsistency: MultiChangeConsistency;
  commercialEffect: CommercialEffect;
  validUntil: string;
  providerMetadata?: unknown;
};

/**
 * v0.6.1 (NEW, minimal schema addition — see scq-v0.6.1-spec.md §2/§6.11):
 * whether the receipt's `committedEffect` was checked against the caller's
 * `AcceptanceEnvelope` AFTER mutation (not just before), and whether it
 * actually passed. `"OK"` covers both "REVALIDATE and reconciled cleanly"
 * and "EXACT / no envelope applicable, nothing to reconcile" — a caller
 * checking this field never needs to branch on guaranteeMode first. See
 * `reconcileCommittedEffect` in scq-engine.ts for how this is computed.
 *
 * This is a REPORTING field, not a re-authorization gate: by the time a
 * receipt exists, the mutation has already happened. A `"VIOLATED"` result
 * cannot be undone by SCQ — it exists so a caller is never told a commit
 * succeeded within their stated tolerance when, because
 * `ConsistencyGuarantee: "BEST_EFFORT"` means a concurrent write could have
 * landed after the last pre-mutation check, that turned out not to be true.
 */
export type ReconciliationResult =
  | { status: "OK" }
  | { status: "VIOLATED"; reason: string };

export type SubscriptionChangeReceipt = {
  quoteId: string;
  subscriptionRef: string;
  status: "COMMITTED";
  resultingSnapshot: SubscriptionSnapshot;
  /** What was computed and shown to the caller at quote time. Never mutated after the quote is created; this is the historical/audit record of what was proposed and approved. */
  quotedEffect: CommercialEffect;
  /**
   * What was actually true at the moment of mutation. For guaranteeMode
   * "EXACT", this is DEFINED to equal `quotedEffect` exactly. For
   * "REVALIDATE", this is the freshly re-derived number from the
   * pre-mutation re-preview that gated the commit — it may legitimately
   * differ from `quotedEffect`. Note this reflects the LAST PRE-MUTATION
   * preview, not necessarily what the provider's mutating call itself
   * ultimately applied if a concurrent write landed in between — see
   * `reconciliation` below for the field that reports on that possibility.
   */
  committedEffect: CommercialEffect;
  guaranteeMode: GuaranteeMode;
  consistencyGuarantee: ConsistencyGuarantee;
  /** Echoes the quote's multiChangeConsistency — what was actually true of the commit that happened. */
  multiChangeConsistency: MultiChangeConsistency;
  /**
   * v0.6.1: whether `committedEffect` was (re-)checked against the
   * proposal's `acceptanceEnvelope` post-mutation, and whether it actually
   * held. ALWAYS present, regardless of guaranteeMode — see
   * `ReconciliationResult` above.
   */
  reconciliation: ReconciliationResult;
  committedAt: string;
};

/**
 * v0.6: `UNSUPPORTED_CHANGE_SET` added. Distinct from `UNSUPPORTED_CHANGE`
 * (a single change, or an entire guarantee-mode request, unsupported) and
 * from `MultiChangeConsistency: "UNSUPPORTED"` (a combination that cannot
 * even be ATTEMPTED together at all). `UNSUPPORTED_CHANGE_SET` is
 * specifically for the case where a provider's real API WOULD accept a
 * bundled request (return success) but the adapter has determined it may
 * silently apply only a SUBSET of the requested changes — see
 * scq-v0.6-spec.md §4 for the full normative rule and
 * research-findings.md v0.5-LIVE for the real Chargebee behavior
 * (`update_for_items`/`cancel_for_items` silently ignoring unrecognized
 * parameters, returning HTTP 200) that forced this rule to exist.
 */
export type SCQErrorCode =
  | "SUBSCRIPTION_NOT_FOUND" | "UNSUPPORTED_CHANGE" | "INVALID_PROPOSAL"
  | "QUOTE_NOT_DETERMINISTIC" | "QUOTE_EXPIRED" | "QUOTE_STALE"
  | "CHANGE_CONFLICT" | "PROVIDER_ERROR" | "QUOTE_DRIFTED" | "UNSUPPORTED_CHANGE_SET";

export class SCQError extends Error {
  constructor(public code: SCQErrorCode, message: string, public details?: unknown) { super(message); }
}

export interface SubscriptionProvider {
  getSubscription(subscriptionId: string): Promise<SubscriptionSnapshot>;
  createChangeQuote(subscriptionId: string, proposal: SubscriptionChangeProposal): Promise<SubscriptionChangeQuote>;
  commitChangeQuote(quoteId: string): Promise<SubscriptionChangeReceipt>;
  /**
   * Coarse, provider-level capability discovery — "what MIGHT this
   * provider be able to do for this action, in general," including which
   * EffectiveIntent types it supports at all. NOT authoritative for any
   * specific quote; see `SubscriptionChangeQuote.guaranteeCoverage` for
   * the state-aware, authoritative financial/term answer. Must still not
   * overstate: whatever this reports as EXACT or as a supported
   * EffectiveIntent type must be achievable for AT LEAST SOME reachable
   * subscription state, even if not universally.
   */
  getCapabilities(): ProviderCapabilities;
}

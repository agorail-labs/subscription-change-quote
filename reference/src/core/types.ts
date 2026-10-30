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
    /**
     * v0.6.2 (CORE-7, additive): the determinacy state of
     * `recurringAmount` — whether the figure is a determined value or
     * was produced by a fallback computation whose result is not
     * established. Absent on a legacy (v0.6.1) snapshot => the figure
     * reads UNKNOWN under the v0.6.2 migration reading. No v0.6.1
     * consumer reads this field; it exists so a number is never left
     * to imply a determinacy its producer did not establish.
     */
    recurringAmountState?: DimensionState;
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
  /**
   * v0.6.2 DEFINITION (CORE-3 — this field previously had NO normative
   * definition; see the v0.6.2 design, Topic 3): `immediate` is the net
   * financial obligation the change itself incurs at its effective
   * time — prorations, immediate charges/credits — whether or not an
   * invoice has been issued, an amount is due, or cash has moved. It
   * is NOT a next-invoice total and NOT an amount due: an amount due
   * is net of customer balance/credits applied to a future invoice,
   * and credits reduce amounts due without ever changing incurred
   * obligations or prices, so amount-due and next-invoice figures
   * must NEVER be carried in this field (or in `recurring`) — they
   * belong in `providerMetadata` under the `nextInvoiceEstimate`
   * convention. An invoiced total may populate this field ONLY
   * insofar as it is this same incurred obligation in invoiced form;
   * an invoice total aggregating other charges is not `immediate`.
   * Cash collected is not modeled anywhere in SCQ.
   */
  immediate?: { charge?: number; credit?: number; net?: number };
  recurring?: { previousAmount?: number; resultingAmount?: number; currency: string; cadence?: string };
  term?: { createsCommitment?: boolean | Unknown; commitmentUntil?: string | Unknown; autoRenew?: boolean };
  effectiveAt?: string;
  /**
   * v0.6.2 (CORE-1, additive): explicit per-dimension determinacy.
   * Absent on a legacy (v0.6.1) payload => every dimension reads
   * UNKNOWN for enforcement/reconciliation (see `determinacyOf` in
   * scq-engine.ts and spec §10). v0.6.2-conforming adapters MUST emit
   * this on every effect they produce. Dimension-level, matching the
   * granularity the acceptance envelope bounds (immediate.net,
   * recurring.resultingAmount); `term`/`effectiveAt` keep their
   * existing coverage mechanisms (GuaranteeCoverage.termEffect
   * already has an UNKNOWN state). A field present with value 0 under
   * DETERMINED is a verified zero and MUST be emitted as
   * present-with-0 — never re-encoded as absent.
   */
  determinacy?: {
    immediateFinancialEffect: DimensionState;
    recurringFinancialEffect: DimensionState;
  };
  /**
   * v0.6.2 (CORE-2, additive): provenance for this effect's figures.
   * A determinacy assertion is only as good as the provenance that
   * backs it; reconciliation (in a later v0.6.2 step) reads
   * `committedSource` to decide whether committed figures are
   * reconcilable actuals at all.
   */
  provenance?: {
    /** Adapter-recorded basis for the immediate figure (provider field(s) or computation). Free-form audit string. */
    immediate?: string;
    /** Same, for the recurring figure. */
    recurring?: string;
    /** Meaningful on committed effects: what the committed figures ARE. Absent => "unestablished" for reconciliation. */
    committedSource?: CommittedFigureSource;
    /**
     * Findings-closure F2: the licensing citations for any
     * NOT_APPLICABLE assertions on this effect, keyed by dimension.
     * Each citation names the (action, dimension) pair in the
     * applicability table that licenses the assertion, and its
     * `action` must match the authoritative action of the proposal
     * under evaluation. An assertion without a valid citation is
     * unjustified — agreement between two effects asserting the
     * same NOT_APPLICABLE is not proof of applicability.
     */
    applicabilityCitations?: Partial<Record<FinancialDimension, ApplicabilityCitation>>;
  };
};

/**
 * v0.6.2 (CORE-1): the determinacy state of one financial dimension
 * of a CommercialEffect. The three states are mutually exclusive and
 * exhaustive, with NO implicit conversions between them at any layer:
 * a verified zero is DETERMINED with value 0; NOT_APPLICABLE is a
 * claim that the dimension does not arise for the action (licensed
 * only by the applicability table — see `ApplicabilityCitation`);
 * UNKNOWN is the absence of an established value, and is also the
 * reading of any dimension on a legacy payload that carries no
 * determinacy record.
 */
export type DimensionState = "DETERMINED" | "NOT_APPLICABLE" | "UNKNOWN";

/** The two financial dimensions a CommercialEffect's determinacy record covers. */
export type FinancialDimension = "immediateFinancialEffect" | "recurringFinancialEffect";

/**
 * v0.6.2 (CORE-2 / findings-closure F2): a citation of the
 * applicability-table entry that licenses a NOT_APPLICABLE assertion
 * — the (action, dimension) pair relied upon.
 */
export type ApplicabilityCitation = { action: ChangeAction; dimension: FinancialDimension };

/**
 * v0.6.2 (CORE-2): what a committed effect's figures ARE, as recorded
 * by the adapter that produced them. Only "provider_actual" (derived
 * from provider state/actuals read after — or returned by — the
 * mutating call) and "defined_equal_exact" (EXACT mode: committed :=
 * quoted BY PROTOCOL DEFINITION) are reconcilable sources; a
 * revalidated preview or a pre-mutation estimate is quote-side data
 * and can never serve as the committed actual, and "unestablished"
 * (also the reading when the field is absent) means no source could
 * be established.
 */
export type CommittedFigureSource =
  | "provider_actual"
  | "revalidated_preview"
  | "pre_mutation_estimate"
  | "defined_equal_exact"
  | "unestablished";

/**
 * v0.6.2 (CORE-8, PR #8 review correction C1): the evidence required
 * to transition a COMMITTED_UNVERIFIED receipt to verified. The
 * transition NEVER happens on a caller-supplied verdict alone: a
 * bare "OK"/"VIOLATED" is an assertion, not evidence. The presenter
 * must supply the material the verdict was computed FROM, and the
 * store validates that material against the stored record before
 * transitioning:
 *
 *  - `committedEffect` — the committed figures as INDEPENDENTLY
 *    re-derived (from provider actuals, after the fact). Their
 *    identity amounts (immediate.net, recurring.resultingAmount)
 *    must equal the amounts recorded on the receipt at commit
 *    time: those recorded actuals are what is being verified. (A
 *    VIOLATED outcome is expressed through `reconciliation`, not
 *    by substituting different figures: the actuals legitimately
 *    differ from the QUOTE, never from the record of themselves.)
 *  - `committedSource` — the provenance of those figures. Must be
 *    an independently reconcilable source ("provider_actual" or
 *    "defined_equal_exact"); estimate-derived or quote-shared
 *    provenance ("pre_mutation_estimate", "revalidated_preview",
 *    "unestablished") is refused — the same rule reconciliation
 *    applies to committed figures generally.
 *  - `stateVerification` — the post-commit state-verification
 *    result under the §6.12 contract (VERIFIED / MISMATCH /
 *    UNVERIFIABLE). Only VERIFIED can support a transition.
 *  - `reconciliation` — the outcome computed FROM the inputs
 *    above (OK or VIOLATED; never UNVERIFIED). The store
 *    recomputes the reconciliation from the recorded quoted
 *    effect, the evidence's committed figures, and the quote's
 *    acceptance envelope, and refuses evidence whose claimed
 *    outcome contradicts that recomputation.
 *
 * A successful transition ends in exactly one of two terminal
 * shapes, both with outcome COMMITTED_AND_VERIFIED (the figures
 * ARE established — verified means measured): reconciliation OK
 * (verified within envelope), or reconciliation VIOLATED
 * (verified-with-violation — established actuals outside the
 * envelope; never reportable as OK).
 *
 * PR #8 review correction, round 2 (R3): this type is a TOKEN,
 * not a form a caller fills in. `verifyCommitReceipt` accepts
 * only evidence minted by `establishVerification` (quote-store.ts)
 * from a `ProviderObservation` — the establishment procedure
 * computes the state verification and the reconciliation FROM the
 * observation and brands the resulting object; a caller-constructed
 * object with identical fields (even one built from the stored
 * receipt's own figures, labeled "provider_actual", asserting
 * state VERIFIED) is self-asserted and is refused. The brand
 * guarantees the evidence passed through the establishment
 * computation over a caller-supplied observation; it cannot prove
 * the observation truly came from a provider — binding an
 * observation to a real provider read is the adapters' duty
 * (PR-3..PR-7), and the store additionally re-validates the
 * token's contents against the recorded receipt at the
 * transition, so a token whose contents were altered after
 * minting is refused as well.
 */
export type VerificationEvidence = {
  committedEffect: CommercialEffect;
  committedSource: CommittedFigureSource;
  stateVerification: "VERIFIED" | "MISMATCH" | "UNVERIFIABLE";
  reconciliation: ReconciliationResult;
  /** When the verification was performed (ISO timestamp); defaults to the transition time. */
  at?: string;
};

/**
 * v0.6.2 (CORE-8, PR #8 review correction round 2 — R3): an
 * INDEPENDENT post-commit provider observation — the raw material
 * `establishVerification` computes verification evidence from.
 *
 * "Independent" is the load-bearing word: the observation is a
 * read of provider-side state made after the commit, NOT derived
 * from the stored receipt and NOT the quote's own figures. Its
 * `committedEffect` must carry an establishing committedSource
 * ("provider_actual" / "defined_equal_exact"): an observation
 * whose figures are a revalidated preview or a pre-mutation
 * estimate is quote-side data and establishment refuses it, and an
 * observation that IS the quote's quoted effect (the estimate
 * itself, relabeled) is refused on sight. `resultingSnapshot` is
 * the post-commit subscription state as read from the provider;
 * the establishment procedure computes the §6.12 state
 * verification from it against the proposal's intent — the caller
 * never asserts the state result. Absent snapshot (or absent
 * members the intent's checks need) computes UNVERIFIABLE, never
 * VERIFIED.
 */
export type ProviderObservation = {
  /** The subscription the observation is OF — must name the quote's subscription. */
  subscriptionRef: string;
  /** The committed figures as read from the provider side after the commit. */
  committedEffect: CommercialEffect;
  /** The post-commit subscription state as read from the provider (drives the computed state verification). */
  resultingSnapshot?: SubscriptionSnapshot;
  /** Descriptor of the read that produced this observation (adapter read path, for the audit trail). */
  source: string;
  /** When the observation was made (ISO timestamp). */
  observedAt?: string;
};

/**
 * v0.6.2 (PR-9, additive — protocol change): the provider-neutral
 * post-commit STATE verification contract, implemented by
 * `verifyPostCommitState` (core/state-verification.ts) and consumed
 * by the store's establishment procedure and by adapters that
 * perform their own post-commit establishment. This is issue #7
 * Topic 5's shared hook: the §6.12 state verification, generalized
 * from the store's formerly private per-action check into one
 * provider-neutral computation.
 *
 * The verdict is about OBSERVED STATE ONLY. Four questions are kept
 * distinct throughout: (1) is the intended state observed? — this
 * contract's verdict; (2) is the operation's execution established?
 * (3) is the observed state ATTRIBUTABLE to this operation?
 * (4) are the financial figures established? A state verdict
 * answers question (1) and is structurally incapable of asserting
 * the others: the result type carries them as constant-false
 * fields. In particular a VERIFIED state NEVER upgrades a
 * lost-response INDETERMINATE outcome (PR #16 L1: a matching state
 * is observationally identical to another actor making the same
 * change), and a state MISMATCH is never, by itself, a financial
 * VIOLATED — that translation requires independently attributable
 * financial evidence, which is the establishing adapter's burden.
 */
export type StateVerificationVerdict = "VERIFIED" | "MISMATCH" | "UNVERIFIABLE";

/**
 * What the verification actually covered. FULL_ITEM_SET: the
 * expected RESULTING item set was compared against the observed
 * collection as a multiset (identifiers + quantities [+ stated
 * offerings]) — additions, removals, extras, and duplicates are
 * all detectable. ACTION_LEVEL: only the per-change checks the
 * proposal targets were performed (the historical §6.12
 * semantics); state outside the targeted items/dimensions is NOT
 * examined, and the result says so in its limitations.
 */
export type StateVerificationCoverage = "FULL_ITEM_SET" | "ACTION_LEVEL";

/** One performed check, reported whether it passed, contradicted, or could not be performed. */
export type StateVerificationCheck = {
  /** Check identifier, e.g. "item-set", "change[0]:CHANGE_QUANTITY". */
  check: string;
  /** The state dimension examined, e.g. "state:itemSet", "state:cadence". */
  dimension: string;
  outcome: "VERIFIED" | "CONTRADICTED" | "UNVERIFIABLE";
  /** Human-readable statement of what was compared and what was found. */
  detail: string;
};

/**
 * One entry of the expected resulting item set (FULL_ITEM_SET
 * coverage). Derived by the CALLER from the authorized quote /
 * dispatched request — never from the post-mutation state.
 * `offeringRef` is compared only where the expectation states it.
 */
export type ExpectedItemState = {
  id: string;
  quantity?: number;
  offeringRef?: string;
};

/**
 * The trusted expectation side of state verification: the stored
 * quote's authorized proposal, plus — where full item-set
 * verification is claimed — the expected resulting item set
 * derived from that authorized request.
 */
export type PostCommitStateExpectation = {
  /** The authorized proposal (the stored quote's proposal). The hook checks its intent; it never accepts a caller-supplied verdict. */
  proposal: SubscriptionChangeProposal;
  /**
   * The expected RESULTING item set (complete collection, multiset
   * semantics). Supplied => FULL_ITEM_SET coverage; omitted =>
   * ACTION_LEVEL coverage, reported as such.
   */
  expectedItems?: ReadonlyArray<ExpectedItemState>;
  /**
   * The authorized current-term boundary instant, where the caller
   * can derive it from the authorized quote / request context (for
   * example the quoted period boundary recorded at quote time).
   * Used ONLY to align a TERM_END cancellation: a schedule or
   * effected cancellation is verified for TERM_END when its
   * independently established instant equals this boundary, or
   * when provider schedule-kind evidence establishes the TERM_END
   * kind directly. This value must come from the expectation
   * (authorized) side — never from the post-commit snapshot being
   * checked: a boundary read out of the observed state would be
   * the state proving itself. Absent => TERM_END alignment rests
   * on schedule-kind evidence alone, and a schedule carrying
   * neither kind nor an alignable instant is UNVERIFIABLE.
   */
  termBoundaryAt?: string;
};

/**
 * The observed subscription state, normalized for state
 * verification. Unlike `SubscriptionSnapshot`, the item collection
 * is OPTIONAL here: a read that omits the collection must be
 * representable, because an omitted collection is UNVERIFIABLE —
 * it is never an empty set.
 */
export type PostCommitObservedSnapshot = Omit<SubscriptionSnapshot, "items"> & {
  items?: SubscriptionSnapshot["items"];
};

/**
 * The observation side of state verification: a normalized
 * post-commit read, adapted by the caller from whatever provider
 * read it performed. Binding this value to a REAL provider read
 * (bound to the operation where attribution matters) is the
 * caller's duty — exactly as with `ProviderObservation`, the hook
 * computes over what it is given and cannot prove provenance;
 * `establishVerification`'s evidence branding remains the boundary
 * that keeps a computed verdict from becoming evidence by itself.
 */
export type PostCommitStateObservation = {
  /** The post-commit subscription state as read; absent => nothing about the state is established. */
  snapshot?: PostCommitObservedSnapshot;
  /**
   * Whether `snapshot.items` is the COMPLETE collection.
   * `false` => a partial return: contradictions established by
   * PRESENT entries stand, but absence-based contradictions
   * (missing items) are NOT established and the item-set dimension
   * is at best UNVERIFIABLE. Absent => the collection is taken as
   * complete (the shape of every read this repo's adapters make).
   */
  itemsComplete?: boolean;
  /**
   * Independently established cancellation schedule / cancellation
   * evidence, for scheduled (TERM_END / DATE) CANCEL intents: the
   * subscription snapshot carries no schedule, so a scheduled
   * cancellation can only be verified from evidence established by
   * a provider read (e.g. a scheduled-change record bound to the
   * operation). `kind` is the provider-established schedule kind
   * (TERM_END evidence can verify a TERM_END intent without a
   * numeric boundary); `effectiveAt` is the established scheduled
   * instant — or, for an already-terminal subscription, the
   * established instant the cancellation took effect. Absent => a
   * non-terminal scheduled cancel is UNVERIFIABLE; a schedule is
   * never invented, and a terminal state carrying no cancellation
   * instant cannot be distinguished from a premature termination
   * for a DATE / TERM_END intent.
   */
  cancellationSchedule?: { kind?: EffectiveIntent["type"]; effectiveAt?: string };
  /** Descriptor of the read that produced this observation (provenance, for the audit trail). */
  source: string;
  /** When the observation was made (ISO timestamp). */
  observedAt?: string;
};

/** The computed result of `verifyPostCommitState`. A value, not evidence: it carries no brand and mints nothing. */
export type PostCommitStateVerification = {
  verdict: StateVerificationVerdict;
  coverage: StateVerificationCoverage;
  /** Every check performed, with its outcome — the verdict is derived from these, never asserted beside them. */
  checks: StateVerificationCheck[];
  /** Dimensions at least one check VERIFIED. */
  verifiedDimensions: string[];
  /** Established contradictions (present iff verdict is MISMATCH). */
  contradictions: string[];
  /** Dimensions no check could verify from the observation. */
  unverifiableDimensions: string[];
  /** Whether any post-commit snapshot was observed at all. */
  stateObserved: boolean;
  /**
   * Constant false, by construction: this result does NOT
   * establish that the operation executed. Execution establishment
   * lives in operation-bound evidence (a mutation response, an
   * operation-keyed read), never in a state comparison.
   */
  executionEstablished: false;
  /**
   * Constant false, by construction: this result does NOT
   * establish that the observed state was caused by the operation
   * under verification. Attribution requires an operation-bound
   * bracket or equivalent; a matching state is observationally
   * identical to another actor's identical change.
   */
  stateAttributableToThisOperation: false;
  /**
   * Constant false, by construction: this result examines state
   * only and establishes NO financial outcome. A state VERIFIED
   * does not make figures established; a state MISMATCH does not
   * make a reconciliation VIOLATED.
   */
  financialOutcomeEstablished: false;
  provenance: { source: string; observedAt?: string };
  /** What this verification did NOT cover or cannot support — stated in the result, not just in prose. */
  limitations: string[];
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
 *
 * v0.6.2 (CORE-4): the union gains a third variant, `"UNVERIFIED"` — the
 * reconciliation could not be established at all (committed figures of
 * unestablished or quote-side provenance, or a dimension whose
 * determinacy is UNKNOWN), which is a DIFFERENT claim from both "OK"
 * (verified within envelope) and "VIOLATED" (verified outside it). An
 * unverified commit must never be reported as OK, and must never be
 * silently collapsed into VIOLATED either: the figures were never
 * measured, so there is nothing to have violated. Widening this union
 * is deliberately loud for exhaustive consumers (BC-5): a switch that
 * handled only OK/VIOLATED fails to compile against the new variant
 * rather than silently misclassifying unverified commits. This type
 * is defined HERE, in types.ts, as the single canonical definition —
 * scq-engine.ts re-exports it (the pre-v0.6.2 duplicate definition in
 * the engine is removed so the two can never fork).
 */
export type ReconciliationResult =
  | { status: "OK" }
  | { status: "VIOLATED"; reason: string }
  | { status: "UNVERIFIED"; reason: string; undeterminedDimensions: string[] };

/**
 * v0.6.2 (CORE-5): the classification of a commit ATTEMPT's outcome.
 * Receipts are recorded ONLY for the two COMMITTED_* classes; the two
 * no-receipt classes (INDETERMINATE, CONFIRMED_NON_EXECUTION) surface
 * in the thrown SCQError's `details.outcome` and in the store's
 * per-quote outcome record (CORE-8). The distinction between
 * INDETERMINATE (the mutation was dispatched but its landing is not
 * established — NO blind retry; provider-state reconciliation first)
 * and CONFIRMED_NON_EXECUTION (the mutation provably never took
 * effect — safe to retry as a NEW quote) is normative and must never
 * be collapsed: they carry opposite retry rules.
 */
export type MutationOutcome =
  | "COMMITTED_AND_VERIFIED"
  | "COMMITTED_UNVERIFIED"
  | "INDETERMINATE"
  | "CONFIRMED_NON_EXECUTION";

export type SubscriptionChangeReceipt = {
  quoteId: string;
  subscriptionRef: string;
  /**
   * v0.6.2 (CORE-8 / findings-closure F4): an optional receipt-level
   * identifier, distinct from the quote id. When present, the store
   * enforces its uniqueness across ALL recorded receipts: reusing a
   * receiptId under a different identity (different quote,
   * subscription, figures, or recorded outcome) is a
   * CONFLICTING_RECEIPT_IDENTITY refusal. Absent on v0.6.1 receipts;
   * the store's identity tuple reads it as null there.
   */
  receiptId?: string;
  /**
   * v0.6.2 (CORE-6, BREAKING — explicit compatibility change per the
   * recorded design decision): widened from the single v0.6.1 literal
   * so a commit whose landing is established but whose finances are
   * NOT verified is distinguishable at the status level alone:
   * "COMMITTED" iff `outcome` is COMMITTED_AND_VERIFIED,
   * "COMMITTED_UNVERIFIED" iff `outcome` is COMMITTED_UNVERIFIED
   * (in which case `reconciliation` is the UNVERIFIED variant). A
   * consumer matching only `status === "COMMITTED"` must never be
   * able to mistake an unverified commit for a verified one — that
   * distinguishability is the point of the widening, and it
   * deliberately breaks v0.6.1 consumers that assumed the single
   * literal.
   */
  status: "COMMITTED" | "COMMITTED_UNVERIFIED";
  /**
   * v0.6.2 (CORE-6): the commit's outcome classification. Present on
   * v0.6.2 receipts; COMMITTED_AND_VERIFIED iff reconciliation is OK
   * or VIOLATED over established actuals, COMMITTED_UNVERIFIED iff
   * reconciliation is UNVERIFIED. Receipts are recorded ONLY for
   * these two outcome classes. Absent on v0.6.1 receipts, where it
   * reads as COMMITTED_AND_VERIFIED (their status literal could
   * express nothing else).
   */
  outcome?: MutationOutcome;
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
  | "CHANGE_CONFLICT" | "PROVIDER_ERROR" | "QUOTE_DRIFTED" | "UNSUPPORTED_CHANGE_SET"
  /**
   * v0.6.2 (CORE-8 / findings-closure F4): a receipt recording,
   * verification, or recovery attempt whose receipt IDENTITY (the
   * canonical tuple of receiptId, quoteId, subscriptionId, recorded
   * outcome, recorded reconciliation status, and recorded committed
   * figures) conflicts with the identity already recorded under that
   * quote or receiptId — or a persisted record whose fields no
   * longer match its recorded identity digest at recovery. The
   * original record is always preserved; identity is never resolved
   * by overwriting.
   */
  | "CONFLICTING_RECEIPT_IDENTITY";

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

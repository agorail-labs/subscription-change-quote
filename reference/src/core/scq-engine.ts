// Shared quote/commit bookkeeping used by all adapters, so STALE/EXPIRED
// logic, guarantee-mode defaulting/enforcement, effectiveIntent
// enforcement, and multi-change consistency computation are written once.
// Provider-specific mutation replay stays in the adapters — this only
// decides whether replay is allowed to happen, and what the quote is
// authorized to claim.

import {
  SCQError,
  type AcceptanceEnvelope,
  type ChangeAction,
  type ChangeSpec,
  type CommercialEffect,
  type DimensionState,
  type EffectiveIntent,
  type FinancialDimension,
  type GuaranteeCoverage,
  type GuaranteeMode,
  type MultiChangeConsistency,
  type ReconciliationResult,
  type SubscriptionChangeProposal,
  type SubscriptionChangeReceipt,
} from "./types.js";

// v0.6.2 (CORE-4): `ReconciliationResult` is defined ONCE, in
// types.ts, and re-exported here for import compatibility. Before
// v0.6.2 this module carried a duplicate local definition of the
// same type; the two were structurally identical, so TypeScript
// accepted assignments between them, but widening only one (as
// CORE-4 does) would have silently forked them.
export type { ReconciliationResult } from "./types.js";
import type { QuoteStore, StoredQuote } from "../store/quote-store.js";

/**
 * v0.6.1 NORMATIVE RULE (commit idempotency, scq-v0.6.1-spec.md §6.10): a
 * repeated commit attempt against a quote that has ALREADY been
 * successfully committed MUST NOT apply the change a second time and MUST
 * return the ORIGINAL receipt from the first successful commit, verbatim —
 * not a re-derived or re-fetched one. This is checked FIRST, before
 * `validateCommit`'s expiry/staleness checks below, because idempotent
 * replay of an already-committed quote must succeed even if the
 * subscription has since drifted further (that drift is irrelevant to
 * returning a receipt that already describes a completed, historical
 * commit) and even if `validUntil` has since passed (an expired quote that
 * was already committed before expiring is not retroactively un-committed
 * by the clock — QUOTE_EXPIRED only applies to a commit ATTEMPT on a quote
 * that was never successfully committed).
 *
 * Callers (adapters) MUST invoke this before performing ANY read of live
 * provider state or any mutating call, so that a caller who retries a
 * commit purely out of network uncertainty (e.g. it committed successfully
 * but the response was lost) never causes a second provider mutation.
 *
 * Returns the cached receipt if this quote was already committed, or
 * `undefined` if the commit should proceed normally through
 * `validateCommit`.
 */
export function checkIdempotentReplay(store: QuoteStore, quoteId: string): SubscriptionChangeReceipt | undefined {
  // §6.10: a repeated commit returns the ORIGINAL receipt — the
  // receipt as recorded at commit time (commit_receipt_recorded),
  // NOT the mutable current view (commit_receipt). After a
  // verification transition the current view shows the verified
  // state, but a replaying caller must receive the receipt it
  // originally got; the latest verified state is exposed only
  // through the store's separate current-view reads (store.get()'s
  // commit_receipt / receiptsWithReconciliation). PR #8 review
  // correction, round 2 (R1): this previously returned
  // commit_receipt, so a post-verification replay silently
  // returned the VERIFIED receipt — changing what §6.10 promises.
  // The store returns a defensive copy of the recorded snapshot.
  return store.recordedReceipt(quoteId);
}

/**
 * Validates a commit attempt against the store: existence, expiry, and
 * fingerprint match against current provider state. Throws SCQError and
 * performs NO provider mutation if any check fails.
 *
 * Returns the stored quote if the commit may proceed. Caller is responsible
 * for actually replaying the provider-specific mutation.
 *
 * v0.6.1: callers MUST call `checkIdempotentReplay` first and short-circuit
 * on a hit — by the time this function runs, `quote.status === "COMMITTED"`
 * always indicates a genuine anomaly (a COMMITTED quote with no
 * commit_receipt, which should be structurally impossible given
 * `QuoteStore.recordCommitReceipt`'s atomic status+receipt write) rather
 * than the normal repeated-commit case, which is why this still throws
 * CHANGE_CONFLICT rather than silently succeeding.
 */
export function validateCommit(
  store: QuoteStore,
  quoteId: string,
  currentFingerprint: string,
  now: () => Date = () => new Date()
): StoredQuote {
  const quote = store.get(quoteId);
  if (!quote) {
    throw new SCQError("QUOTE_STALE", `No quote found for id ${quoteId}; cannot verify it is still current.`);
  }

  if (quote.status === "COMMITTED") {
    // Reachable only if COMMITTED without a commit_receipt — see the
    // doc comment above. A normal repeated commit never reaches this line
    // because commitChangeQuote must check checkIdempotentReplay first.
    throw new SCQError(
      "CHANGE_CONFLICT",
      `Quote ${quoteId} is marked COMMITTED but has no recorded receipt — this is an internal inconsistency, ` +
        `not a normal repeated-commit case (which should have been handled by checkIdempotentReplay before this call).`
    );
  }

  if (quote.status === "SUPERSEDED") {
    throw new SCQError("QUOTE_STALE", `Quote ${quoteId} was superseded by a newer quote on the same subscription.`);
  }

  if (now().getTime() > new Date(quote.expires_at).getTime()) {
    store.updateStatus(quoteId, "EXPIRED");
    throw new SCQError("QUOTE_EXPIRED", `Quote ${quoteId} expired at ${quote.expires_at}.`);
  }

  if (quote.subscription_version_at_quote !== currentFingerprint) {
    store.updateStatus(quoteId, "STALE");
    throw new SCQError(
      "QUOTE_STALE",
      `Subscription ${quote.subscription_id} changed since quote ${quoteId} was created ` +
        `(quoted fingerprint ${quote.subscription_version_at_quote}, current ${currentFingerprint}). ` +
        `No mutation was performed.`,
      { quotedFingerprint: quote.subscription_version_at_quote, currentFingerprint }
    );
  }

  return quote;
}

/**
 * v0.6.2 BC-1 — the shared fail-closed enforcement assessment.
 *
 * One per-dimension, per-side assessment drives BOTH the pre-mutation
 * envelope gate (`checkAcceptanceEnvelope`) and post-commit
 * reconciliation (`reconcileCommittedEffect`), so the two can never
 * develop parallel interpretations of the three-state model. The
 * state machine mirrors `auditDeterminacy`'s exactly (same
 * `determinacyOf` reading, same value-validity rule, same
 * applicability-table license and citation validation — the audit
 * remains the report-only diagnostic over the same rules, and the
 * BC-1 suite pins gate/audit agreement on the refusal cases).
 *
 * Two ROLE differences from the audit are deliberate and documented
 * (research/bc1-fail-closed-enforcement.md):
 *  - Quote role (the quoted effect in both functions; the
 *    revalidated effect in the envelope gate): quote-side figures
 *    are estimates by nature, so DETERMINED requires the dimension's
 *    provenance NOTE (the audit's C4 basis record).
 *    `provenance.committedSource` is meaningless on a quote-side
 *    effect (types.ts: it is meaningful only on committed effects)
 *    and is ignored here — including on revalidated effects, whose
 *    role in the gate is quote-side and whose `revalidated_preview`
 *    label is lineage metadata, not a claim of actuals.
 *  - Committed role (the committed effect in reconciliation):
 *    DETERMINED establishes actuals ONLY through an establishing
 *    `committedSource` — "provider_actual" or
 *    "defined_equal_exact". An estimate-derived source
 *    ("revalidated_preview" / "pre_mutation_estimate") reports
 *    PROVENANCE_NOT_ESTABLISHING; an absent or "unestablished"
 *    source reports MISSING_PROVENANCE (types.ts: an absent
 *    committedSource READS as "unestablished" for reconciliation —
 *    a free-form basis note is not a source classification, and no
 *    provenance string by itself authenticates a provider event;
 *    adapters remain responsible for binding figures to their
 *    operation-bound provider reads).
 */
type DimensionRole = "quote" | "committed";

type SideAssessment = {
  state: DimensionState;
  /** The finite numeric value, present only for a valid DETERMINED side. */
  value?: number;
  findings: DeterminacyAuditFinding[];
  /** "determined" (valid value + role provenance), "not-applicable" (justified), or "unenforceable". */
  kind: "determined" | "not-applicable" | "unenforceable";
};

type DimensionAssessment = {
  dimension: FinancialDimension;
  quoted: SideAssessment;
  compared: SideAssessment;
  /** Both sides DETERMINED and valid: the dimension can be numerically compared. */
  comparable: boolean;
  /** Both sides justified NOT_APPLICABLE: the dimension is legitimately skipped — never compared as zero. */
  skipped: boolean;
};

const ENFORCEMENT_DIMENSIONS: FinancialDimension[] = ["immediateFinancialEffect", "recurringFinancialEffect"];

function dimensionValue(effect: CommercialEffect, dimension: FinancialDimension): unknown {
  return dimension === "immediateFinancialEffect" ? effect.immediate?.net : effect.recurring?.resultingAmount;
}

/**
 * The authoritative action context for applicability licensing: the
 * proposal's single change action. A multi-change proposal has no
 * single action context — its combined effect's dimensions genuinely
 * arise — so NOT_APPLICABLE cannot be licensed for it (the same
 * single-CANCEL rule the adapters' local gates apply). A caller that
 * supplies no proposal supplies no context, and a self-asserted
 * citation is never validated without it.
 */
function authoritativeAction(proposal?: SubscriptionChangeProposal): string | undefined {
  return proposal && proposal.changes.length === 1 ? proposal.changes[0].action : undefined;
}

function assessDimensionSide(
  effect: CommercialEffect,
  dimension: FinancialDimension,
  action: string | undefined,
  role: DimensionRole
): SideAssessment {
  const state = determinacyOf(effect)[dimension];
  if (state === "NOT_APPLICABLE") {
    // Same justification preconditions, in the same order, as the
    // audit: context, then license, then citation.
    if (!action) return { state, findings: ["MISSING_ACTION_CONTEXT"], kind: "unenforceable" };
    if (!applicabilityLicensed(action, dimension)) return { state, findings: ["UNJUSTIFIED_NOT_APPLICABLE"], kind: "unenforceable" };
    const citation = effect.provenance?.applicabilityCitations?.[dimension];
    if (!citation || citation.action !== action || citation.dimension !== dimension) {
      return { state, findings: ["MISSING_APPLICABILITY_PROVENANCE"], kind: "unenforceable" };
    }
    return { state, findings: [], kind: "not-applicable" };
  }
  if (state !== "DETERMINED") {
    // UNKNOWN — including a legacy payload's absent determinacy and
    // any unrecognized state value at runtime.
    return { state: "UNKNOWN", findings: ["WOULD_REFUSE_UNKNOWN"], kind: "unenforceable" };
  }
  const value = dimensionValue(effect, dimension);
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return { state, findings: ["INVALID_DETERMINED_VALUE"], kind: "unenforceable" };
  }
  if (role === "committed") {
    const source = effect.provenance?.committedSource;
    if (source === "revalidated_preview" || source === "pre_mutation_estimate") {
      return { state, findings: ["PROVENANCE_NOT_ESTABLISHING"], kind: "unenforceable" };
    }
    if (source !== "provider_actual" && source !== "defined_equal_exact") {
      return { state, findings: ["MISSING_PROVENANCE"], kind: "unenforceable" };
    }
    return { state, value, findings: [], kind: "determined" };
  }
  // Quote role: the dimension's provenance note is the basis record.
  const note = dimension === "immediateFinancialEffect" ? effect.provenance?.immediate : effect.provenance?.recurring;
  if (typeof note !== "string" || note.length === 0) {
    return { state, findings: ["MISSING_PROVENANCE"], kind: "unenforceable" };
  }
  return { state, value, findings: [], kind: "determined" };
}

function assessEnvelopePair(
  quoted: CommercialEffect,
  compared: CommercialEffect,
  proposal: SubscriptionChangeProposal | undefined,
  comparedRole: DimensionRole
): DimensionAssessment[] {
  const action = authoritativeAction(proposal);
  return ENFORCEMENT_DIMENSIONS.map((dimension) => {
    const q = assessDimensionSide(quoted, dimension, action, "quote");
    const c = assessDimensionSide(compared, dimension, action, comparedRole);
    return {
      dimension,
      quoted: q,
      compared: c,
      comparable: q.kind === "determined" && c.kind === "determined",
      skipped: q.kind === "not-applicable" && c.kind === "not-applicable",
    };
  });
}

function describeAssessment(d: DimensionAssessment, comparedLabel: string): string {
  const side = (s: SideAssessment) => (s.findings.length > 0 ? `${s.state} [${s.findings.join(", ")}]` : s.state);
  return `${d.dimension}: quoted ${side(d.quoted)} vs ${comparedLabel} ${side(d.compared)}`;
}

/**
 * v0.6.2 BC-1 — the fail-closed pre-mutation guard, exported for
 * callers (and adapter gates) that need the enforcement decision
 * without the comparison. Throws SCQError QUOTE_NOT_DETERMINISTIC —
 * before any mutating call at every call site — naming each
 * unenforceable dimension and which side failed it. A dimension is
 * enforceable iff BOTH sides are DETERMINED with finite values and
 * role-appropriate provenance, or BOTH sides assert a justified
 * NOT_APPLICABLE under the proposal's authoritative action context.
 * Anything else — UNKNOWN on either side (legacy payloads included),
 * an invalid DETERMINED value, an unjustified or one-sided
 * NOT_APPLICABLE — refuses: UNKNOWN is never zero, and a skipped
 * dimension is never a zero comparison.
 */
export function assertEnvelopeEnforceable(
  quoted: CommercialEffect,
  compared: CommercialEffect,
  proposal?: SubscriptionChangeProposal
): void {
  const assessments = assessEnvelopePair(quoted, compared, proposal, "quote");
  const failing = assessments.filter((d) => !d.comparable && !d.skipped);
  if (failing.length === 0) return;
  throw new SCQError(
    "QUOTE_NOT_DETERMINISTIC",
    `Refusing before any mutation: the acceptance envelope cannot be enforced because ` +
      `${failing.map((d) => describeAssessment(d, "revalidated")).join("; ")}. An UNKNOWN or ` +
      `unjustified dimension is never compared as zero (BC-1). Re-derive the undetermined ` +
      `dimension(s) from provider evidence or re-quote. No provider mutation was performed; ` +
      `this refusal is a CONFIRMED_NON_EXECUTION.`,
    {
      outcome: "CONFIRMED_NON_EXECUTION",
      dimensions: failing.map((d) => ({
        dimension: d.dimension,
        quoted: { state: d.quoted.state, findings: d.quoted.findings },
        revalidated: { state: d.compared.state, findings: d.compared.findings },
      })),
    }
  );
}

/**
 * The v0.6.1 numeric comparison, restricted to dimensions BC-1 has
 * established as comparable (both sides DETERMINED with finite
 * values). Violation strings are unchanged from v0.6.1. Bounds not
 * stated in the envelope default to "zero tolerance" for that
 * dimension — a caller must opt into slack, not receive it
 * implicitly (fail-closed governs the VALUES compared, not the
 * caller's tolerances).
 */
function compareDeterminedDimensions(
  quoted: CommercialEffect,
  compared: CommercialEffect,
  envelope: AcceptanceEnvelope,
  comparable: ReadonlySet<FinancialDimension>
): string | null {
  if (comparable.has("immediateFinancialEffect")) {
    const quotedNet = quoted.immediate!.net!;
    const revalidatedNet = compared.immediate!.net!;
    const netIncrease = revalidatedNet - quotedNet;

    if (netIncrease > 0) {
      const allowed = envelope.maxImmediateNetIncrease ?? 0;
      if (netIncrease > allowed) {
        return `immediate.net increased by ${netIncrease} (quoted ${quotedNet} -> revalidated ${revalidatedNet}), exceeding maxImmediateNetIncrease=${allowed}`;
      }
    } else if (netIncrease < 0) {
      // Net moved in the caller's favor (smaller charge / bigger credit) —
      // treat as a credit-side change, bounded separately since a caller may
      // reasonably want a tighter or looser tolerance on "I got charged less
      // than expected" than on being charged more.
      const creditDecrease = -netIncrease;
      const allowed = envelope.maxImmediateCreditDecrease ?? 0;
      if (creditDecrease > allowed) {
        return `immediate.net moved in the caller's favor by ${creditDecrease} (quoted ${quotedNet} -> revalidated ${revalidatedNet}), exceeding maxImmediateCreditDecrease=${allowed}`;
      }
    }
  }

  if (comparable.has("recurringFinancialEffect")) {
    const quotedRecurring = quoted.recurring!.resultingAmount!;
    const revalidatedRecurring = compared.recurring!.resultingAmount!;
    const recurringIncrease = revalidatedRecurring - quotedRecurring;
    if (recurringIncrease > 0) {
      const allowed = envelope.maxRecurringIncrease ?? 0;
      if (recurringIncrease > allowed) {
        return `recurring.resultingAmount increased by ${recurringIncrease} (quoted ${quotedRecurring} -> revalidated ${revalidatedRecurring}), exceeding maxRecurringIncrease=${allowed}`;
      }
    }
  }

  return null;
}

/**
 * Checks a freshly-recomputed commercialEffect against the quoted one,
 * within the caller-stated acceptance envelope. Returns a human-readable
 * violation reason string if the envelope is exceeded, or null if the
 * recomputation is acceptable.
 *
 * v0.6.2 BC-1 (fail-closed activation): BEFORE any comparison, both
 * sides' determinacy is established per dimension via
 * `assertEnvelopeEnforceable` — an unenforceable dimension THROWS
 * QUOTE_NOT_DETERMINISTIC (it does not return a drift string: no
 * comparison took place, and callers must not mistake the refusal
 * for drift). The v0.6.1 `?? 0` coercions are removed: a dimension
 * is compared only when both sides are DETERMINED, and skipped only
 * when both sides assert a NOT_APPLICABLE the proposal's action
 * context licenses. `proposal` carries that authoritative context;
 * omitting it leaves NOT_APPLICABLE assertions unjustified
 * (MISSING_ACTION_CONTEXT) while DETERMINED/UNKNOWN handling is
 * unaffected.
 */
export function checkAcceptanceEnvelope(
  quoted: CommercialEffect,
  revalidated: CommercialEffect,
  envelope: AcceptanceEnvelope,
  proposal?: SubscriptionChangeProposal
): string | null {
  assertEnvelopeEnforceable(quoted, revalidated, proposal);
  const assessments = assessEnvelopePair(quoted, revalidated, proposal, "quote");
  const comparable = new Set(assessments.filter((d) => d.comparable).map((d) => d.dimension));
  return compareDeterminedDimensions(quoted, revalidated, envelope, comparable);
}

/**
 * v0.6.1 NORMATIVE RULE (post-commit reconciliation, scq-v0.6.1-spec.md
 * §6.11): REVALIDATE's pre-mutation envelope check (checkAcceptanceEnvelope,
 * called against the LAST pre-mutation preview) reduces but does NOT
 * eliminate the risk that the committed outcome ends up outside the
 * caller's envelope — because `ConsistencyGuarantee: BEST_EFFORT` means a
 * concurrent write can land in the window between that last preview and the
 * mutating call itself (the same TOCTOU gap documented since v0.2, see
 * Test 7/9i/11j). SCQ cannot PREVENT this; what it can and must do is never
 * let it pass silently. After a REVALIDATE commit's mutating call returns,
 * the adapter MUST re-run this check with `committedEffect` (what actually
 * happened) against the SAME envelope used for the pre-mutation check, and
 * MUST surface a `QUOTE_DRIFTED`-shaped reconciliation failure — the
 * mutation has ALREADY happened at this point, so this cannot roll it back;
 * it exists so the caller is never told a receipt was "COMMITTED" as if it
 * were fully within their stated tolerance when in fact it was not. This is
 * strictly a REPORTING obligation, not a re-authorization gate: a
 * reconciliation failure is returned as a property on a normal receipt
 * (`reconciliation`), not thrown, because the commit already happened and
 * the caller needs the mutated state regardless.
 *
 * (The `ReconciliationResult` type itself lives in types.ts — see the
 * re-export at the top of this file.)
 *
 * v0.6.2 BC-1 (truthful reconciliation): the verdict is computed from
 * the SAME shared assessment as the pre-mutation gate (the committed
 * side assessed under the committed role), and this function NEVER
 * throws a pre-mutation refusal — the mutation has already landed,
 * so an unenforceable dimension is reported, not refused:
 *
 *  - VIOLATED — an ESTABLISHED violation: a dimension both sides
 *    establish (quoted DETERMINED; committed DETERMINED through an
 *    establishing committedSource) whose committed value exceeds
 *    the envelope. Precedence: an established violation is reported
 *    even when ANOTHER dimension remains unestablished — a proven
 *    violation is never downgraded by an unrelated unknown.
 *  - UNVERIFIED — no established violation, but at least one
 *    dimension cannot be established (UNKNOWN on either side, an
 *    invalid DETERMINED value, committed figures of estimate or
 *    unestablished provenance, an unjustified NOT_APPLICABLE):
 *    compliance was not proven, so OK is not available. An UNKNOWN
 *    committed dimension cannot produce OK by absence, by numeric
 *    coincidence, or by sharing the quote's number.
 *  - OK — every dimension is established and within the envelope
 *    (or legitimately skipped as justified NOT_APPLICABLE on both
 *    sides).
 *
 * No-envelope case (CANCEL-only REVALIDATE proposals may omit one —
 * see enforceGuaranteeRequest): there is nothing to COMPARE, and OK
 * keeps its v0.6.1 meaning of "no comparison applies" — but only
 * when the committed figures the receipt reports are themselves
 * established actuals (every dimension DETERMINED through an
 * establishing source, or justified NOT_APPLICABLE). If any
 * committed dimension is unestablished, the result is UNVERIFIED:
 * an unknown financial outcome must not masquerade as verified
 * actuals merely because no envelope was stated. The distinction is
 * between "nothing to reconcile against" (no envelope) and "the
 * figures were established" (provenance) — OK requires the former
 * to be the ONLY gap.
 */
export function reconcileCommittedEffect(
  quoted: CommercialEffect,
  committed: CommercialEffect,
  envelope: AcceptanceEnvelope | undefined,
  proposal?: SubscriptionChangeProposal
): ReconciliationResult {
  const assessments = assessEnvelopePair(quoted, committed, proposal, "committed");
  const undetermined = assessments.filter((d) => !d.comparable && !d.skipped);

  if (!envelope) {
    // Judge the COMMITTED side alone: with nothing to compare
    // against, the quoted side's determinacy is not the question —
    // whether the reported actuals are established is.
    const unestablishedCommitted = assessments.filter(
      (d) => d.compared.kind === "unenforceable"
    );
    if (unestablishedCommitted.length === 0) return { status: "OK" };
    return {
      status: "UNVERIFIED",
      reason:
        `Post-commit reconciliation cannot be established: no acceptance envelope applies, and the committed ` +
        `financial outcome is itself unestablished (${unestablishedCommitted.map((d) => describeAssessment(d, "committed")).join("; ")}). ` +
        `Reporting OK would present unmeasured figures as verified actuals; the commit stands, but its finances are unverified.`,
      undeterminedDimensions: unestablishedCommitted.map((d) => d.dimension),
    };
  }

  const comparable = new Set(assessments.filter((d) => d.comparable).map((d) => d.dimension));
  const violation = compareDeterminedDimensions(quoted, committed, envelope, comparable);
  if (violation) {
    return {
      status: "VIOLATED",
      reason:
        `Post-commit reconciliation failed: the ACTUALLY-committed effect falls outside the caller's ` +
        `acceptance envelope, even though the last pre-mutation preview did not (${violation}). This can happen ` +
        `because ConsistencyGuarantee is BEST_EFFORT — a concurrent write may have landed between the ` +
        `pre-mutation preview and the mutating call itself. The mutation has already occurred and cannot be ` +
        `rolled back by this reconciliation check; it exists solely so this is never reported silently.`,
    };
  }
  if (undetermined.length > 0) {
    return {
      status: "UNVERIFIED",
      reason:
        `Post-commit reconciliation cannot be established: ${undetermined.map((d) => describeAssessment(d, "committed")).join("; ")}. ` +
        `Missing evidence is never proof of compliance — an UNKNOWN or unestablished dimension is not ` +
        `compared as zero and cannot reconcile OK (BC-1). The mutation has already occurred; its ` +
        `unestablished dimension(s) require operator follow-up, not a silent OK.`,
      undeterminedDimensions: undetermined.map((d) => d.dimension),
    };
  }
  return { status: "OK" };
}

/**
 * SCQ's protocol default is REVALIDATE. This resolves what the EFFECTIVE
 * guaranteeMode for a proposal is — the caller's explicit choice, or
 * REVALIDATE if omitted — and is the single place that default lives, so
 * all adapters can't drift out of sync on it.
 */
export function resolveGuaranteeMode(proposal: SubscriptionChangeProposal): GuaranteeMode {
  return proposal.guaranteeMode ?? "REVALIDATE";
}

/**
 * Names of the GuaranteeCoverage dimensions that matter for an overall
 * EXACT request. Every dimension listed here must independently report
 * "EXACT" for the provider to honor a proposal-level guaranteeMode:
 * "EXACT" request. `termEffect` uses the Unknown sentinel instead of
 * "REVALIDATE" but the check is the same shape: anything other than the
 * literal "EXACT" fails an overall EXACT request.
 */
const COVERAGE_DIMENSIONS: Array<keyof GuaranteeCoverage> = [
  "immediateFinancialEffect",
  "recurringFinancialEffect",
  "termEffect",
  "effectiveAt",
];

/**
 * Combines per-change GuaranteeCoverage reports into the single coverage a
 * multi-change proposal can honestly claim, by taking the WEAKEST value
 * per dimension across all changes in the batch ("EXACT" only if every
 * change is EXACT on that dimension; otherwise "REVALIDATE"/"UNKNOWN" per
 * the dimension's own weaker-value convention). This is deliberately
 * conservative: a batch is only as strong as its weakest member on each
 * axis. Order of `coverages` does not matter.
 */
export function computeCombinedCoverage(coverages: GuaranteeCoverage[]): GuaranteeCoverage {
  if (coverages.length === 0) {
    throw new Error("computeCombinedCoverage requires at least one coverage report");
  }
  const combine = (values: Array<"EXACT" | "REVALIDATE" | "UNKNOWN">, weakValue: "REVALIDATE" | "UNKNOWN") =>
    values.every((v) => v === "EXACT") ? "EXACT" : weakValue;

  return {
    immediateFinancialEffect: combine(coverages.map((c) => c.immediateFinancialEffect), "REVALIDATE") as "EXACT" | "REVALIDATE",
    recurringFinancialEffect: combine(coverages.map((c) => c.recurringFinancialEffect), "REVALIDATE") as "EXACT" | "REVALIDATE",
    termEffect: combine(coverages.map((c) => c.termEffect), "UNKNOWN") as "EXACT" | "UNKNOWN",
    effectiveAt: combine(coverages.map((c) => c.effectiveAt), "REVALIDATE") as "EXACT" | "REVALIDATE",
  };
}

/**
 * Enforces that EXACT is only ever requested where the AUTHORITATIVE,
 * quote-level coverage (not just the coarse provider-level one) actually
 * backs it, on every dimension. Throws UNSUPPORTED_CHANGE at
 * quote-creation time — BEFORE any preview or mutation call — if EXACT is
 * requested for a proposal+state that does not support it on every
 * dimension, naming the first dimension that fails.
 *
 * Also enforces that REVALIDATE (explicit or defaulted) carries an
 * acceptanceEnvelope, UNLESS every change in the batch is CANCEL (no
 * proration/immediate-charge component to have drift tolerance about).
 * This is INVALID_PROPOSAL, not UNSUPPORTED_CHANGE, because it's a caller
 * input-shape problem, not a provider-capability one.
 */
export function enforceGuaranteeRequest(
  changes: ChangeSpec[],
  effectiveMode: GuaranteeMode,
  coverage: GuaranteeCoverage,
  acceptanceEnvelope: AcceptanceEnvelope | undefined
): void {
  const actionsLabel = changes.map((c) => c.action).join("+");
  if (effectiveMode === "EXACT") {
    const failingDimension = COVERAGE_DIMENSIONS.find((dim) => coverage[dim] !== "EXACT");
    if (failingDimension) {
      throw new SCQError(
        "UNSUPPORTED_CHANGE",
        `guaranteeMode "EXACT" was requested for changes [${actionsLabel}], but the authoritative quote-level ` +
          `coverage for this proposal+subscription-state does not back EXACT on the "${failingDimension}" ` +
          `dimension (=== "${coverage[failingDimension]}"). An overall EXACT request requires EXACT on every ` +
          `guarantee dimension, for every change in the batch. Request REVALIDATE instead.`,
        { changes: actionsLabel, requestedMode: effectiveMode, failingDimension, coverage }
      );
    }
  }
  const allCancel = changes.every((c) => c.action === "CANCEL");
  if (effectiveMode === "REVALIDATE" && !allCancel && !acceptanceEnvelope) {
    throw new SCQError(
      "INVALID_PROPOSAL",
      `guaranteeMode "REVALIDATE" (explicit or defaulted) requires an acceptanceEnvelope for changes ` +
        `[${actionsLabel}], so the caller's tolerance for drift is explicit rather than assumed. None was provided.`,
      { changes: actionsLabel, effectiveMode }
    );
  }
}

/**
 * Determines the MultiChangeConsistency for a batch of changes, calling
 * the adapter-supplied `resolve` function once per UNORDERED PAIR of
 * change actions in the batch (a provider's ability to bundle A+B
 * atomically may differ from A+C). The overall result is the WEAKEST
 * pairwise result (ATOMIC only if every pair the provider was asked about
 * resolves ATOMIC; UNSUPPORTED if any pair does).
 *
 * For a single-change batch (changes.length === 1), always returns
 * "ATOMIC" trivially — there is nothing to sequence.
 */
export function computeMultiChangeConsistency(
  changes: ChangeSpec[],
  resolvePair: (a: ChangeAction, b: ChangeAction) => MultiChangeConsistency
): MultiChangeConsistency {
  if (changes.length <= 1) return "ATOMIC";

  const rank: Record<MultiChangeConsistency, number> = { ATOMIC: 2, BEST_EFFORT: 1, UNSUPPORTED: 0 };
  let weakest: MultiChangeConsistency = "ATOMIC";
  for (let i = 0; i < changes.length; i++) {
    for (let j = i + 1; j < changes.length; j++) {
      const pairResult = resolvePair(changes[i].action, changes[j].action);
      if (rank[pairResult] < rank[weakest]) weakest = pairResult;
    }
  }
  return weakest;
}

/**
 * Enforces that a multi-change proposal is refused outright
 * (UNSUPPORTED_CHANGE) if its computed MultiChangeConsistency is
 * "UNSUPPORTED" — the protocol requires SCQ to refuse rather than
 * silently degrade an unsupported bundle into a partial, unrollback-able
 * sequence of separate provider calls. BEST_EFFORT is allowed through (the
 * caller is told via multiChangeConsistency on the quote/receipt and can
 * decide whether that's acceptable), but UNSUPPORTED is a hard stop.
 *
 * See also `enforceNoPartialExecutionRisk` below — a DISTINCT, stricter
 * check for a different failure mode this one does not cover.
 */
export function enforceMultiChangeConsistency(changes: ChangeSpec[], consistency: MultiChangeConsistency): void {
  if (consistency === "UNSUPPORTED") {
    const actionsLabel = changes.map((c) => c.action).join("+");
    throw new SCQError(
      "UNSUPPORTED_CHANGE",
      `This provider does not support bundling changes [${actionsLabel}] into a single commit — ` +
        `multiChangeConsistency resolved to "UNSUPPORTED". Submit these as separate proposals instead.`,
      { changes: actionsLabel }
    );
  }
}

/**
 * v0.6 NORMATIVE RULE (scq-v0.6-spec.md §4): if a provider adapter
 * determines that submitting a multi-change proposal AS SUBMITTED risks
 * the provider silently applying only a SUBSET of the requested changes —
 * a distinct failure mode from `MultiChangeConsistency: "UNSUPPORTED"`,
 * which covers combinations that cannot even be ATTEMPTED together at all
 * — the adapter MUST call this function BEFORE any mutating call, and it
 * MUST throw `UNSUPPORTED_CHANGE_SET` if `mayPartiallyApply` is true. This
 * was forced by a real, confirmed finding: the v0.5-LIVE Chargebee session
 * found that `update_for_items`/`cancel_for_items` silently ignore
 * unrecognized/foreign parameters and return HTTP 200 rather than
 * rejecting them — meaning a naively-constructed bundled request that
 * "looks" like it might work could actually succeed while dropping part of
 * the caller's intent, with no error signal at all. `mayPartiallyApply` is
 * an explicit boolean the ADAPTER computes from its own knowledge of the
 * real provider's endpoint shapes (e.g. "this combination requires two
 * different endpoints, and I have no way to make both calls atomic or
 * detect that only one succeeded") — this function does not and cannot
 * infer that risk itself; it only enforces the REFUSAL once the adapter
 * has determined the risk exists.
 */
export function enforceNoPartialExecutionRisk(changes: ChangeSpec[], mayPartiallyApply: boolean): void {
  if (mayPartiallyApply) {
    const actionsLabel = changes.map((c) => c.action).join("+");
    throw new SCQError(
      "UNSUPPORTED_CHANGE_SET",
      `This provider may silently apply only a SUBSET of changes [${actionsLabel}] if submitted together — ` +
        `refusing before any mutating call rather than risking partial, undetectable execution. Submit these ` +
        `as separate proposals instead.`,
      { changes: actionsLabel }
    );
  }
}

/**
 * v0.6: validates a proposal's effectiveIntent against what the provider
 * can actually honor. `supportedTypes` is the adapter's own coarse (or, if
 * the caller prefers, quote-state-aware) list of EffectiveIntent.type
 * values it can back for the given action(s). Throws UNSUPPORTED_CHANGE —
 * BEFORE any preview or mutation call — if the requested intent type is
 * not in that list. This generalizes v0.5's `enforceRequestedEffectiveAt`
 * (which only handled the DATE case) to all three EffectiveIntent types,
 * per the v0.6 schema change forcing providers to explicitly report
 * support rather than have SCQ infer it from a single dimension.
 */
export function enforceEffectiveIntent(intent: EffectiveIntent, supportedTypes: Array<EffectiveIntent["type"]>): void {
  if (!supportedTypes.includes(intent.type)) {
    throw new SCQError(
      "UNSUPPORTED_CHANGE",
      `effectiveIntent.type "${intent.type}" was requested, but this provider/action only supports ` +
        `[${supportedTypes.join(", ")}]. Choose a supported EffectiveIntent type, or check ` +
        `getCapabilities().quoteCapabilities[...].supportedEffectiveIntents before requesting.`,
      { requestedType: intent.type, supportedTypes }
    );
  }
}

/**
 * v0.6.2 (CORE-9, exported for audit/migration tooling): the legacy
 * reading of a CommercialEffect's determinacy. An absent determinacy
 * map — or an absent entry in it — reads UNKNOWN, never
 * grandfathered: legacy (v0.6.1) numbers were produced by code paths
 * that zero-filled absent dimensions and, in places, conflated
 * economically different quantities, so the mere presence of a
 * number is not provenance. This function is the single place that
 * reading lives.
 *
 * History: in PR-1 this reading was consumed ONLY by
 * `auditDeterminacy` (report-only). PR-10 (BC-1) activates it in
 * enforcement: `checkAcceptanceEnvelope` and
 * `reconcileCommittedEffect` now assess through the same reading
 * (see the BC-1 assessment above `checkAcceptanceEnvelope`).
 */
export function determinacyOf(effect: CommercialEffect): {
  immediateFinancialEffect: DimensionState;
  recurringFinancialEffect: DimensionState;
} {
  return {
    immediateFinancialEffect: effect.determinacy?.immediateFinancialEffect ?? "UNKNOWN",
    recurringFinancialEffect: effect.determinacy?.recurringFinancialEffect ?? "UNKNOWN",
  };
}

export type DeterminacyAuditFinding =
  | "WOULD_REFUSE_UNKNOWN"
  | "INVALID_DETERMINED_VALUE"
  | "MISSING_PROVENANCE"
  | "PROVENANCE_NOT_ESTABLISHING"
  | "UNJUSTIFIED_NOT_APPLICABLE"
  | "MISSING_ACTION_CONTEXT"
  | "MISSING_APPLICABILITY_PROVENANCE";

export type DeterminacyAuditEntry = {
  dimension: FinancialDimension;
  quotedState: DimensionState;
  comparedState: DimensionState;
  findings: DeterminacyAuditFinding[];
};

const AUDIT_DIMENSIONS: FinancialDimension[] = ["immediateFinancialEffect", "recurringFinancialEffect"];

/**
 * The v0.6.2 applicability table (spec §3.10): which dimensions an
 * action may legitimately assert NOT_APPLICABLE for. Only CANCEL's
 * immediate dimension is eligible — CANCEL is the one action a
 * provider model may define as purely prospective (effective at term
 * end, with no immediate financial event by rule). `recurring` is
 * never NOT_APPLICABLE for any action: every supported action leaves
 * a post-change price level (for CANCEL, zero — a DETERMINED zero,
 * not an absence). An action with no entry here licenses nothing
 * (fail closed).
 */
function applicabilityLicensed(action: string, dimension: FinancialDimension): boolean {
  return action === "CANCEL" && dimension === "immediateFinancialEffect";
}

function auditDimensionValue(effect: CommercialEffect, dimension: FinancialDimension): unknown {
  return dimension === "immediateFinancialEffect" ? effect.immediate?.net : effect.recurring?.resultingAmount;
}

function auditOneEffect(
  effect: CommercialEffect,
  dimension: FinancialDimension,
  action: string | undefined,
  findings: Set<DeterminacyAuditFinding>
): void {
  const state = determinacyOf(effect)[dimension];
  if (state === "DETERMINED") {
    const value = auditDimensionValue(effect, dimension);
    if (typeof value !== "number" || !Number.isFinite(value)) {
      // A DETERMINED assertion over a missing, non-numeric, NaN, or
      // infinite value is not a determined value. (An unvalidated NaN
      // would otherwise drift through a bound comparison silently:
      // every comparison with NaN is false.)
      findings.add("INVALID_DETERMINED_VALUE");
      return;
    }
    // PR #8 review correction C4: a finite number alone is not
    // verification. A DETERMINED dimension must carry supporting
    // provenance — the dimension's own provenance note
    // (provenance.immediate / provenance.recurring), or, on a
    // committed effect, an ESTABLISHING committedSource.
    // Provenance is reported ONLY for otherwise-valid determined
    // values (an invalid value reports INVALID_DETERMINED_VALUE
    // alone), and never for UNKNOWN dimensions (already
    // WOULD_REFUSE_UNKNOWN) or NOT_APPLICABLE assertions (whose
    // provenance mechanism is the applicability citation, checked
    // below).
    //
    // Round 2 (R4) — the committedSource rule is ROLE-AWARE.
    // Asserting a committedSource presents the effect's figures as
    // committed actuals (committedSource is meaningful only on a
    // committed effect — see types.ts), and only two sources
    // ESTABLISH actuals: "provider_actual" and
    // "defined_equal_exact". An estimate-derived source
    // ("revalidated_preview" / "pre_mutation_estimate") reports
    // PROVENANCE_NOT_ESTABLISHING for the dimension: revalidated
    // and estimate figures must never establish committed actuals,
    // so presenting them as provenance for committed figures is
    // itself the finding — distinct from MISSING_PROVENANCE
    // (nothing offered at all). C4's original rule counted ANY
    // source other than "unestablished" as provenance, which let
    // exactly those estimate lineages pass the migration audit.
    // Quote-side effects assert no committedSource (their figures
    // are estimates by nature) and keep the note-based treatment.
    const dimensionProvenance =
      dimension === "immediateFinancialEffect" ? effect.provenance?.immediate : effect.provenance?.recurring;
    const committedSource = effect.provenance?.committedSource;
    if (committedSource === "revalidated_preview" || committedSource === "pre_mutation_estimate") {
      findings.add("PROVENANCE_NOT_ESTABLISHING");
      return;
    }
    const hasProvenance =
      (typeof dimensionProvenance === "string" && dimensionProvenance.length > 0) ||
      committedSource === "provider_actual" ||
      committedSource === "defined_equal_exact";
    if (!hasProvenance) {
      findings.add("MISSING_PROVENANCE");
    }
    return;
  }
  if (state === "NOT_APPLICABLE") {
    // Justification preconditions, in order (findings-closure F2):
    // context, then license, then citation — the first failing
    // precondition is the finding.
    if (!action) {
      findings.add("MISSING_ACTION_CONTEXT");
      return;
    }
    if (!applicabilityLicensed(action, dimension)) {
      findings.add("UNJUSTIFIED_NOT_APPLICABLE");
      return;
    }
    const citation = effect.provenance?.applicabilityCitations?.[dimension];
    if (!citation || citation.action !== action || citation.dimension !== dimension) {
      findings.add("MISSING_APPLICABILITY_PROVENANCE");
    }
    return;
  }
  // UNKNOWN — including a legacy payload's absent determinacy, and
  // any unrecognized state value at runtime.
  findings.add("WOULD_REFUSE_UNKNOWN");
}

/**
 * v0.6.2 TRANSITIONAL determinacy audit (implementation plan §A.2) —
 * NON-NORMATIVE, report-only diagnostic tooling. It computes, per
 * financial dimension, exactly what the v0.6.2 fail-closed envelope
 * guard refuses about a (quoted, compared) effect pair, and changes
 * no verdict: it never throws on malformed payloads, it mutates
 * nothing, and nothing in any commit/enforcement path branches on
 * its output (the BC-1 gate shares the audit's RULES through the
 * common assessment above `checkAcceptanceEnvelope`; it does not
 * consume this function's output — this diagnostic stays
 * independent so gate/audit agreement can be tested, per PR-10).
 * Its purpose is pre-activation migration gating: adapter migrations
 * run it over their conformance fixtures in CI, and a migrated
 * adapter's fixtures must produce no findings (except where a
 * finding is the fixture's asserted expectation). It is never
 * serialized and never part of a receipt.
 *
 * `action` is the authoritative action of the proposal under
 * evaluation (from the proposal record, never from either effect's
 * self-assertion); omit it when no action context is established —
 * a NOT_APPLICABLE assertion then reports MISSING_ACTION_CONTEXT.
 */
export function auditDeterminacy(
  quoted: CommercialEffect,
  compared: CommercialEffect,
  action?: string
): DeterminacyAuditEntry[] {
  return AUDIT_DIMENSIONS.map((dimension) => {
    const findings = new Set<DeterminacyAuditFinding>();
    auditOneEffect(quoted, dimension, action, findings);
    auditOneEffect(compared, dimension, action, findings);
    const quotedStates = determinacyOf(quoted);
    const comparedStates = determinacyOf(compared);
    return {
      dimension,
      quotedState: quotedStates[dimension],
      comparedState: comparedStates[dimension],
      findings: Array.from(findings),
    };
  });
}

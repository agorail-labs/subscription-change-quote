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
  type ComparisonUnitContext,
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
export type { ComparisonUnitContext } from "./types.js";
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
 * PR-15 (Issue #22, Finding 2): RUNTIME proposal validation — the
 * shared, provider-neutral validator every adapter applies.
 *
 * TypeScript unions do not validate runtime input: a proposal can
 * arrive as parsed JSON, a deserialized persisted record, or an
 * unsafe cast, carrying values the types claim impossible. Before
 * this PR the runtime trusted the types, and the failures were
 * silent-pass shaped (PR #23, repro44):
 *  - a misspelled guaranteeMode ("REVALDIATE") was returned
 *    verbatim by resolveGuaranteeMode and satisfied NEITHER branch
 *    of enforceGuaranteeRequest — EXACT's coverage check and
 *    REVALIDATE's envelope requirement were both skipped, and the
 *    commit paths' mode branches fell through the same way;
 *  - malformed envelope bounds (NaN, negative, string-typed) were
 *    compared numerically: every comparison against NaN is false,
 *    so a drifted revalidation silently PASSED its envelope;
 *  - an authorizationScope declaration was validated only inside
 *    the Chargebee-live adapter (PR #24); the simulator adapters
 *    never read the field, so an unimplemented broader
 *    authorization was silently accepted there.
 *
 * `validateProposalRuntime` is the ONE authoritative validator.
 * Every adapter calls it at the entry of createChangeQuote —
 * before any provider read, preview, estimate, or mutation — and
 * `validateStoredQuoteRuntime` applies the same rules to the
 * STORED record at commit time (see its comment). Adapters keep
 * their provider-specific capability checks AFTER this shared
 * validation; the rules are not duplicated per adapter.
 *
 * Refusal codes follow the codebase's established taxonomy:
 * malformed caller input is INVALID_PROPOSAL; a RECOGNIZED but
 * unimplemented declaration (TARGET_REPLACEMENT authorization) is
 * UNSUPPORTED_CHANGE — the same code PR #24's live-adapter refusal
 * used — never a silent downgrade and never execution.
 *
 * Deliberate non-restrictions (recorded in
 * research/pr-15-runtime-proposal-validation.md): envelope bounds
 * must be finite and nonnegative but are NOT required to be
 * integers or safe integers (whether minor-unit bounds should be
 * integral is a normative question for the v0.6.2 candidate, not a
 * restriction this PR imposes); a CHANGE_QUANTITY quantity must be
 * a finite, nonnegative number — zero is left to provider
 * semantics, while a negative or non-finite "quantity" denotes no
 * quantity at all; unknown fields are rejected only inside the
 * acceptance envelope, whose field set the protocol closes.
 */

const CHANGE_ACTION_VALUES: ReadonlySet<string> = new Set(["CHANGE_QUANTITY", "CHANGE_PLAN", "CHANGE_CADENCE", "CANCEL"]);
const EFFECTIVE_INTENT_TYPE_VALUES: ReadonlySet<string> = new Set(["IMMEDIATE", "TERM_END", "DATE"]);
const CADENCE_VALUES: ReadonlySet<string> = new Set(["MONTHLY", "ANNUAL"]);
const ENVELOPE_FIELD_NAMES = ["maxImmediateNetIncrease", "maxImmediateCreditDecrease", "maxRecurringIncrease"] as const;

/** Renders an arbitrary runtime value for an error message, safely (never throws). */
function runtimeValueForMessage(raw: unknown): string {
  if (typeof raw === "string") return JSON.stringify(raw);
  try {
    return JSON.stringify(raw) ?? String(raw);
  } catch {
    return String(raw);
  }
}

/**
 * The shape problem with a supplied acceptance envelope, or null
 * if the envelope is shape-valid. An ABSENT envelope (undefined)
 * is shape-valid: whether an envelope must be PRESENT is a
 * separate rule (the REVALIDATE presence rule), judged by the
 * caller with the proposal's mode and actions in hand. A supplied
 * envelope must be a plain object carrying ONLY the supported
 * tolerance fields, and every supplied bound must be a finite,
 * nonnegative number: NaN would silently disable the comparison
 * it bounds (every comparison against NaN is false), a string
 * bound coerces unpredictably, a negative "tolerance" inverts the
 * check's meaning, and an unknown field may be a misspelled bound
 * whose intended tolerance would otherwise be silently dropped.
 * Malformed bounds are NEVER coerced to zero.
 */
export function envelopeShapeProblem(envelope: unknown): string | null {
  if (envelope === undefined) return null;
  if (typeof envelope !== "object" || envelope === null || Array.isArray(envelope)) {
    return `the acceptance envelope must be an object carrying tolerance bounds; got ${runtimeValueForMessage(envelope)}`;
  }
  const record = envelope as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!(ENVELOPE_FIELD_NAMES as readonly string[]).includes(key)) {
      return `the acceptance envelope carries unsupported field "${key}" (supported fields: ${ENVELOPE_FIELD_NAMES.join(", ")}) — an unknown field is never silently ignored, because it may be a misspelled bound whose tolerance would otherwise be dropped`;
    }
  }
  for (const field of ENVELOPE_FIELD_NAMES) {
    const value = ownEnvelopeBound(record, field);
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      return `acceptance envelope bound ${field} must be a finite, nonnegative number (minor units); got ${runtimeValueForMessage(value)} — a malformed bound is never coerced to zero`;
    }
  }
  return null;
}

/**
 * PR-15 correction (P15-2): reads a bound through the envelope's
 * OWN properties only. The unknown-field check above iterates
 * Object.keys (own names), but a plain `record[field]` read walks
 * the prototype chain — an INHERITED bound (e.g. an envelope built
 * on a prototype carrying maxRecurringIncrease) would be validated
 * and compared as if the caller had stated it, silently enlarging
 * the permitted drift. An inherited property is not part of the
 * envelope the caller supplied: it states no bound, validates
 * nothing, and tolerates nothing. Every envelope read in this
 * module goes through this helper or through the sanitized
 * projection below.
 */
function ownEnvelopeBound(record: Record<string, unknown>, field: (typeof ENVELOPE_FIELD_NAMES)[number]): unknown {
  return Object.prototype.hasOwnProperty.call(record, field) ? record[field] : undefined;
}

/**
 * PR-15 correction (P15-2): the SANITIZED envelope — a fresh
 * object carrying ONLY the envelope's own, supported bounds. For a
 * shape-valid envelope every own bound is already known valid
 * (assertEnvelopeShapeValid / envelopeShapeProblem ran first), so
 * the copy preserves semantics exactly while severing the
 * prototype chain: downstream comparisons consume this form and
 * can never observe an inherited property. Applied at the single
 * shared comparison entry (compareDeterminedDimensions), so the
 * quote-time gate, post-commit reconciliation, and the fireable
 * projection path all compare the same sanitized form.
 *
 * FINAL correction (P15-2 completion): the copy is a
 * NULL-PROTOTYPE object (Object.create(null)), not an ordinary
 * `{}`. An ordinary object inherits from Object.prototype, so if
 * that prototype is polluted (Object.prototype.maxRecurring-
 * Increase set), an ABSENT bound on the sanitized copy would
 * still read as the polluted value at any ordinary property read.
 * The null prototype removes the last chain: an absent bound is
 * absent, full stop. Defense in depth: compareDeterminedDimensions
 * additionally reads bounds own-properties-only (ownEnvelopeBound)
 * rather than trusting construction alone.
 */
function sanitizedEnvelope(envelope: AcceptanceEnvelope): AcceptanceEnvelope {
  const record = envelope as Record<string, unknown>;
  const out = Object.create(null) as AcceptanceEnvelope;
  for (const field of ENVELOPE_FIELD_NAMES) {
    const value = ownEnvelopeBound(record, field);
    if (value !== undefined) out[field] = value as number;
  }
  return out;
}

/** Throws INVALID_PROPOSAL naming the shape problem, if any. An absent envelope is not a shape problem. */
function assertEnvelopeShapeValid(envelope: unknown): asserts envelope is AcceptanceEnvelope | undefined {
  const problem = envelopeShapeProblem(envelope);
  if (problem) {
    throw new SCQError("INVALID_PROPOSAL", `Invalid acceptance envelope: ${problem}.`, { envelopeProblem: problem });
  }
}

function validateProposalRuntimeInternal(
  proposal: unknown,
  validateAuthorizationScope: boolean
): asserts proposal is SubscriptionChangeProposal {
  const invalid = (why: string, details?: unknown): never => {
    throw new SCQError("INVALID_PROPOSAL", `Invalid proposal: ${why}.`, details);
  };

  if (typeof proposal !== "object" || proposal === null || Array.isArray(proposal)) {
    invalid(`a proposal must be an object with changes and effectiveIntent; got ${runtimeValueForMessage(proposal)}`);
  }
  const p = proposal as Record<string, unknown>;

  // --- changes[]: a non-empty array of well-formed change specs.
  if (!Array.isArray(p.changes) || p.changes.length === 0) {
    invalid("proposal.changes must be a non-empty array of change specs");
  }
  const changes = p.changes as unknown[];
  for (let i = 0; i < changes.length; i++) {
    const rawChange = changes[i];
    if (typeof rawChange !== "object" || rawChange === null || Array.isArray(rawChange)) {
      invalid(`changes[${i}] must be a change-spec object`);
    }
    const change = rawChange as Record<string, unknown>;
    if (typeof change.action !== "string" || !CHANGE_ACTION_VALUES.has(change.action)) {
      invalid(`changes[${i}].action ${runtimeValueForMessage(change.action)} is not a supported change action (${[...CHANGE_ACTION_VALUES].join(", ")}) — a valid-but-provider-unsupported action is the provider's UNSUPPORTED_CHANGE decision, but an unknown action value is malformed input`, { action: change.action ?? null });
    }
    switch (change.action) {
      case "CHANGE_QUANTITY": {
        if (typeof change.itemId !== "string" || change.itemId.length === 0) {
          invalid(`changes[${i}] (CHANGE_QUANTITY) requires a non-empty string itemId`);
        }
        if (typeof change.quantity !== "number" || !Number.isFinite(change.quantity) || change.quantity < 0) {
          invalid(`changes[${i}] (CHANGE_QUANTITY) requires quantity to be a finite, nonnegative number; got ${runtimeValueForMessage(change.quantity)}`, { quantity: change.quantity ?? null });
        }
        break;
      }
      case "CHANGE_PLAN": {
        if (typeof change.itemId !== "string" || change.itemId.length === 0) {
          invalid(`changes[${i}] (CHANGE_PLAN) requires a non-empty string itemId`);
        }
        if (typeof change.offeringRef !== "string" || change.offeringRef.length === 0) {
          invalid(`changes[${i}] (CHANGE_PLAN) requires a non-empty string offeringRef`);
        }
        break;
      }
      case "CHANGE_CADENCE": {
        if (typeof change.cadence !== "string" || !CADENCE_VALUES.has(change.cadence)) {
          invalid(`changes[${i}] (CHANGE_CADENCE) requires cadence to be one of ${[...CADENCE_VALUES].join(", ")}; got ${runtimeValueForMessage(change.cadence)}`, { cadence: change.cadence ?? null });
        }
        break;
      }
      case "CANCEL":
        break; // The established CANCEL form carries no required fields.
    }
  }

  // --- effectiveIntent: a supported shape; DATE carries a valid
  // timestamp representation. (Whether a provider can HONOR the
  // intent stays the provider's UNSUPPORTED_CHANGE decision.)
  const intent = p.effectiveIntent;
  if (typeof intent !== "object" || intent === null || Array.isArray(intent)) {
    invalid("proposal.effectiveIntent is required and must be an object");
  }
  const intentType = (intent as Record<string, unknown>).type;
  if (typeof intentType !== "string" || !EFFECTIVE_INTENT_TYPE_VALUES.has(intentType)) {
    invalid(`proposal.effectiveIntent.type ${runtimeValueForMessage(intentType)} is not a supported effective intent (${[...EFFECTIVE_INTENT_TYPE_VALUES].join(", ")})`, { effectiveIntentType: intentType ?? null });
  }
  if (intentType === "DATE") {
    const at = (intent as Record<string, unknown>).at;
    if (typeof at !== "string" || at.length === 0 || Number.isNaN(Date.parse(at))) {
      invalid(`proposal.effectiveIntent { type: "DATE" } requires "at" to be a valid timestamp string; got ${runtimeValueForMessage(at)}`, { at: at ?? null });
    }
  }

  // --- guaranteeMode: omitted defaults to REVALIDATE; the two
  // literals are the only recognized values. An explicit null is
  // NOT an omission — it is an invalid value (the pre-PR-15 `??`
  // defaulting silently read it as one).
  const mode = p.guaranteeMode;
  if (mode !== undefined && mode !== "EXACT" && mode !== "REVALIDATE") {
    invalid(`guaranteeMode ${runtimeValueForMessage(mode)} is not a recognized guarantee mode — the only values are "EXACT" and "REVALIDATE" (omit the field for the REVALIDATE default); a malformed mode must never fall through both modes' enforcement`, { guaranteeMode: mode ?? null });
  }
  const effectiveMode = mode === undefined ? "REVALIDATE" : (mode as GuaranteeMode);

  // --- acceptanceEnvelope: SHAPE only. The established PRESENCE
  // rule (REVALIDATE requires an envelope unless every change is
  // CANCEL) deliberately stays in enforceGuaranteeRequest, which
  // every adapter calls during createChangeQuote AFTER its
  // effectiveIntent support checks: a proposal that is both
  // envelope-less AND intent-unsupported refuses
  // UNSUPPORTED_CHANGE for the intent (test25.19 pins that
  // precedence), and duplicating the presence rule here — ahead
  // of every adapter check — would invert it. Presence is still
  // enforced at quote creation with the same INVALID_PROPOSAL
  // code, and at commit the envelope gates refuse a missing
  // envelope themselves (checkAcceptanceEnvelope requires an
  // envelope object; a stored REVALIDATE quote's gates never see
  // a silent absence).
  assertEnvelopeShapeValid(p.acceptanceEnvelope);

  // --- authorizationScope: absent (or null, PR #24's established
  // reading of an undeclared scope) defaults to OPERATION;
  // OPERATION is the only scope this release executes;
  // TARGET_REPLACEMENT is recognized but unsupported in this
  // release — refused as UNSUPPORTED_CHANGE wherever it is
  // declared, never silently accepted and never downgraded; any
  // other value or runtime type is invalid input.
  if (validateAuthorizationScope) {
    const scope = p.authorizationScope;
    if (scope !== undefined && scope !== null) {
      if (scope === "TARGET_REPLACEMENT") {
        throw new SCQError(
          "UNSUPPORTED_CHANGE",
          "TARGET_REPLACEMENT authorization is not supported: no adapter in this build gives wholesale target-state replacement reviewed authorization semantics, and the declaration is never silently downgraded to OPERATION.",
          { authorizationScope: scope }
        );
      }
      if (scope !== "OPERATION") {
        invalid(`authorizationScope ${runtimeValueForMessage(scope)} is not a recognized authorization scope — the only values are "OPERATION" (or omission, which defaults to OPERATION) and "TARGET_REPLACEMENT" (recognized but unsupported in this release)`, { authorizationScope: scope });
      }
    }
  }
}

/**
 * The ONE authoritative runtime validator for caller-controlled
 * proposals (PR-15). Asserts the proposal is a well-formed
 * SubscriptionChangeProposal at RUNTIME — structure, change
 * specs, effectiveIntent shape, guaranteeMode, acceptance-envelope
 * shape, and the authorization-scope declaration. (Envelope
 * PRESENCE stays in enforceGuaranteeRequest by design — see the
 * ordering note at the envelope check below.)
 * Throws SCQError (INVALID_PROPOSAL for malformed input,
 * UNSUPPORTED_CHANGE for a recognized-but-unimplemented
 * TARGET_REPLACEMENT declaration) and performs no provider call,
 * so adapters invoke it before any provider read.
 */
export function validateProposalRuntime(proposal: unknown): asserts proposal is SubscriptionChangeProposal {
  validateProposalRuntimeInternal(proposal, true);
}

/**
 * PR-15: commit-time validation of a STORED quote record. Quote-
 * creation validation is insufficient on its own: a persisted
 * record can be tampered with, deserialized from an older shape,
 * or seeded outside createChangeQuote, and the commit path
 * consumes the stored proposal's guarantee mode, envelope, scope,
 * and effective intent as enforcement inputs. This applies the
 * SAME shared rules to the stored proposal and additionally
 * requires the record's stored effective guarantee mode to be a
 * recognized mode AND consistent with the stored proposal (the
 * value createChangeQuote resolved) — a desynchronized record is
 * invalid input, never reinterpreted as a permissive default.
 *
 * ORDERING (deliberate, uniform across adapters): callers invoke
 * this AFTER checkIdempotentReplay (a recorded receipt replays
 * verbatim per §6.10 — validation never refuses a legitimate
 * replay), AFTER the recorded-INDETERMINATE guard (that refusal's
 * precedence is preserved), and AFTER validateCommit (expiry and
 * fingerprint refusals keep their precedence) — and BEFORE any
 * re-preview that feeds a gate, any mutating dispatch, and any
 * durable DISPATCHING attempt. The refusal is a pre-dispatch
 * refusal with CONFIRMED_NON_EXECUTION semantics: nothing was
 * dispatched, so it is never INDETERMINATE.
 *
 * `deferAuthorizationScopeToAdapterGate`: the Chargebee-live
 * adapter passes true — its PR #14 preservation gate validates
 * BOTH stored scope declaration sites (the record field and the
 * stored proposal) with outcome recording, a superset of the
 * single-site proposal check here, and that gate's recorded
 * refusal semantics (test47.17/47.18) must not be preempted.
 */
export function validateStoredQuoteRuntime(
  quote: StoredQuote,
  options?: { deferAuthorizationScopeToAdapterGate?: boolean }
): void {
  validateProposalRuntimeInternal(quote?.proposal, !(options?.deferAuthorizationScopeToAdapterGate ?? false));
  const storedMode: unknown = (quote as { effective_guarantee_mode?: unknown })?.effective_guarantee_mode;
  if (storedMode !== "EXACT" && storedMode !== "REVALIDATE") {
    throw new SCQError(
      "INVALID_PROPOSAL",
      `Commit refused before dispatch: the stored quote's effective guarantee mode ${runtimeValueForMessage(storedMode)} is not a recognized guarantee mode ("EXACT" or "REVALIDATE"). The stored record is invalid input; it is never reinterpreted as a default that weakens enforcement. No provider mutation was performed; this refusal is a CONFIRMED_NON_EXECUTION.`,
      { outcome: "CONFIRMED_NON_EXECUTION", effectiveGuaranteeMode: storedMode ?? null }
    );
  }
  const resolved = resolveGuaranteeMode(quote.proposal);
  if (storedMode !== resolved) {
    throw new SCQError(
      "INVALID_PROPOSAL",
      `Commit refused before dispatch: the stored quote's effective guarantee mode (${storedMode}) is desynchronized from its stored proposal, which resolves to ${resolved}. A record whose enforcement inputs disagree is invalid input; neither value is trusted over the other. No provider mutation was performed; this refusal is a CONFIRMED_NON_EXECUTION.`,
      { outcome: "CONFIRMED_NON_EXECUTION", effectiveGuaranteeMode: storedMode, resolvedGuaranteeMode: resolved }
    );
  }
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
 * NOT_APPLICABLE validation — BC1-R1 field-absence purity first,
 * then the applicability-table license and citation validation —
 * the audit remains the report-only diagnostic over the same rules,
 * and the BC-1 suites pin gate/audit agreement on the refusal cases).
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
 * The dimension's whole financial FIELD (not one figure within it).
 * BC1-R1 judges NOT_APPLICABLE purity against this: the assertion
 * claims the dimension does not arise, so the field itself must be
 * absent — a present field in ANY shape (a nonzero amount, an
 * explicit zero, a partial shape such as { charge } without net)
 * contradicts the assertion.
 */
function dimensionField(effect: CommercialEffect, dimension: FinancialDimension): unknown {
  return dimension === "immediateFinancialEffect" ? effect.immediate : effect.recurring;
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
    // BC1-R1 — field-absence purity is judged FIRST, before the
    // justification preconditions below. NOT_APPLICABLE claims the
    // dimension does not arise (issue #7 Topic 1), which requires
    // its financial field to be ABSENT: a present field in any
    // shape — a nonzero amount, an explicit zero (a verified zero
    // is DETERMINED, present as 0), a partial shape such as
    // { charge } without net — is a value the assertion itself
    // contradicts, and no action context, license, or citation can
    // cure the payload's internal inconsistency. The order mirrors
    // the DETERMINED branch, where value validity dominates
    // provenance findings; the audit reports the same first finding
    // for the same shape (gate/audit agreement, pinned in test36).
    if (dimensionField(effect, dimension) !== undefined) {
      return { state, findings: ["INCONSISTENT_NOT_APPLICABLE_VALUE"], kind: "unenforceable" };
    }
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
 * an invalid DETERMINED value, an unjustified, one-sided, or
 * internally inconsistent NOT_APPLICABLE (BC1-R1: asserted over a
 * present financial field) — refuses: UNKNOWN is never zero, and a
 * skipped dimension is never a zero comparison.
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
  // PR-15 correction (P15-2): compare the SANITIZED envelope —
  // own bounds only — so a bound inherited through the caller's
  // prototype chain can never enlarge the permitted drift here,
  // whatever object the caller passed in.
  const bounds = sanitizedEnvelope(envelope);
  // FINAL correction (P15-2 completion): bounds are READ through
  // ownEnvelopeBound as well. The sanitized copy is null-prototype
  // (see sanitizedEnvelope), but the reads do not rely on that
  // construction alone: an own-property read states the rule at
  // the point of use and stays correct for any envelope-shaped
  // object this function may ever be handed.
  const boundsRecord = bounds as unknown as Record<string, unknown>;
  if (comparable.has("immediateFinancialEffect")) {
    const quotedNet = quoted.immediate!.net!;
    const revalidatedNet = compared.immediate!.net!;
    const netIncrease = revalidatedNet - quotedNet;

    if (netIncrease > 0) {
      const allowed = (ownEnvelopeBound(boundsRecord, "maxImmediateNetIncrease") as number | undefined) ?? 0;
      if (netIncrease > allowed) {
        return `immediate.net increased by ${netIncrease} (quoted ${quotedNet} -> revalidated ${revalidatedNet}), exceeding maxImmediateNetIncrease=${allowed}`;
      }
    } else if (netIncrease < 0) {
      // Net moved in the caller's favor (smaller charge / bigger credit) —
      // treat as a credit-side change, bounded separately since a caller may
      // reasonably want a tighter or looser tolerance on "I got charged less
      // than expected" than on being charged more.
      const creditDecrease = -netIncrease;
      const allowed = (ownEnvelopeBound(boundsRecord, "maxImmediateCreditDecrease") as number | undefined) ?? 0;
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
      const allowed = (ownEnvelopeBound(boundsRecord, "maxRecurringIncrease") as number | undefined) ?? 0;
      if (recurringIncrease > allowed) {
        return `recurring.resultingAmount increased by ${recurringIncrease} (quoted ${quotedRecurring} -> revalidated ${revalidatedRecurring}), exceeding maxRecurringIncrease=${allowed}`;
      }
    }
  }

  return null;
}

/**
 * PR-16 (Issue #22, Finding 4): UNIT COMPARABILITY — the
 * precondition the numeric comparison above silently assumed.
 * `compareDeterminedDimensions` compares raw numbers; numbers
 * denominated in different units are not comparable, so a
 * USD-quoted amount and an EUR-committed amount at the same
 * number are NOT equal, and the same number at a MONTHLY vs an
 * ANNUAL cadence is a different recurring obligation. This
 * assessment runs over exactly the dimensions BC-1 established
 * as comparable (both sides DETERMINED) — a dimension that does
 * not participate in the numeric comparison raises no unit
 * question — and reports, per participating dimension:
 *
 *   - "contradiction": both sides' units are ESTABLISHED and
 *     they differ. An established contradiction classifies like
 *     an established numeric violation (VIOLATED / a pre-dispatch
 *     refusal): the comparison the caller asked for cannot come
 *     out in the compared effect's favor.
 *   - "unestablishable": a participating CURRENCY cannot be
 *     established on one side. Currency is a required field on
 *     the recurring effect, so its runtime absence is not a
 *     legacy shape but missing unit evidence; and the immediate
 *     dimension's currency exists only as the subscription's
 *     billing currency (the schema carries no immediate currency
 *     field), sourced from the effect's recurring currency or
 *     the caller's threaded snapshot context. An unestablishable
 *     unit classifies UNVERIFIED — never OK (absence is not
 *     agreement) and never VIOLATED (nothing was contradicted).
 *
 * CADENCE is narrower, deliberately: the schema makes it
 * optional and committed-effect constructions legitimately omit
 * it, so a cadence contradiction is decidable only where BOTH
 * sides state a cadence (on the effect, or via threaded
 * context). A one-sided cadence omission raises no problem —
 * the amounts were produced under one cadence regime the record
 * does not fully state; making the resulting cadence a required
 * recorded dimension is proposed for PR #21 (see
 * research/pr-16-identity-currency-comparability.md).
 *
 * Currency and cadence codes compare case-insensitively
 * ("USD" and "usd" are the same unit; adapters in this codebase
 * emit both casings).
 */
type UnitComparabilityProblem = {
  dimension: FinancialDimension;
  kind: "contradiction" | "unestablishable";
  detail: string;
};

function unitValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Correction round (P16-1): the numeric violation of ONE
 * dimension, computed in isolation. `compareDeterminedDimensions`
 * reports the first violation across a set; the classification
 * logic below needs per-dimension answers, because unit
 * comparability is a per-dimension precondition for numeric
 * evidence (a violation on a dimension whose units cannot be
 * established is not evidence, while a violation on an
 * established-units dimension stands on its own).
 */
function numericViolationOnDimension(
  quoted: CommercialEffect,
  compared: CommercialEffect,
  envelope: AcceptanceEnvelope,
  dimension: FinancialDimension
): string | null {
  return compareDeterminedDimensions(quoted, compared, envelope, new Set([dimension]));
}

function assessUnitComparability(
  quoted: CommercialEffect,
  compared: CommercialEffect,
  comparable: ReadonlySet<FinancialDimension>,
  unitContext?: ComparisonUnitContext
): UnitComparabilityProblem[] {
  const problems: UnitComparabilityProblem[] = [];
  const differs = (a: string, b: string) => a.toUpperCase() !== b.toUpperCase();
  if (comparable.has("recurringFinancialEffect")) {
    const quotedCurrency = unitValue(quoted.recurring?.currency) ?? unitValue(unitContext?.quotedBillingCurrency);
    const comparedCurrency = unitValue(compared.recurring?.currency) ?? unitValue(unitContext?.comparedBillingCurrency);
    if (quotedCurrency !== undefined && comparedCurrency !== undefined) {
      if (differs(quotedCurrency, comparedCurrency)) {
        problems.push({
          dimension: "recurringFinancialEffect",
          kind: "contradiction",
          detail:
            `the quoted recurring amount is denominated in ${quotedCurrency} but the compared recurring amount is denominated in ${comparedCurrency} — ` +
            `amounts in different currencies are not comparable, so numeric equality between them establishes nothing`,
        });
      }
    } else {
      problems.push({
        dimension: "recurringFinancialEffect",
        kind: "unestablishable",
        detail:
          `the recurring currency cannot be established on the ${quotedCurrency === undefined ? "quoted" : "compared"} side — ` +
          `a recurring amount whose currency is unknown cannot be compared against a denominated amount`,
      });
    }
    const quotedCadence = unitValue(quoted.recurring?.cadence) ?? unitValue(unitContext?.quotedBillingCadence);
    const comparedCadence = unitValue(compared.recurring?.cadence) ?? unitValue(unitContext?.comparedBillingCadence);
    if (quotedCadence !== undefined && comparedCadence !== undefined && differs(quotedCadence, comparedCadence)) {
      problems.push({
        dimension: "recurringFinancialEffect",
        kind: "contradiction",
        detail:
          `the quoted recurring amount is stated at a ${quotedCadence} cadence but the compared recurring amount is stated at a ${comparedCadence} cadence — ` +
          `the same number at a different cadence is a different recurring obligation`,
      });
    }
  }
  if (comparable.has("immediateFinancialEffect")) {
    // The schema carries no immediate currency field: an
    // immediate figure is denominated in the subscription's
    // billing currency, established from the caller's threaded
    // snapshot context first (the state the figures were
    // observed with), then from the side's own recurring
    // currency.
    const quotedCurrency = unitValue(unitContext?.quotedBillingCurrency) ?? unitValue(quoted.recurring?.currency);
    const comparedCurrency = unitValue(unitContext?.comparedBillingCurrency) ?? unitValue(compared.recurring?.currency);
    if (quotedCurrency !== undefined && comparedCurrency !== undefined) {
      if (differs(quotedCurrency, comparedCurrency)) {
        problems.push({
          dimension: "immediateFinancialEffect",
          kind: "contradiction",
          detail:
            `the quoted immediate amount is denominated in the subscription's billing currency ${quotedCurrency} but the compared immediate amount is denominated in ${comparedCurrency} — ` +
            `amounts in different currencies are not comparable, so numeric equality between them establishes nothing`,
        });
      }
    } else {
      problems.push({
        dimension: "immediateFinancialEffect",
        kind: "unestablishable",
        detail:
          `the immediate dimension's currency cannot be established on the ${quotedCurrency === undefined ? "quoted" : "compared"} side — ` +
          `the schema carries no immediate currency field, and neither the side's recurring currency nor threaded snapshot context denominates it`,
      });
    }
  }
  return problems;
}

/**
 * PR-15: the FIREABLE projection of a malformed envelope, used ONLY
 * by reconcileCommittedEffect's malformed-envelope classification.
 * Each malformed bound is replaced by +Infinity — an internal
 * "this check cannot fire" sentinel for that one bound, never a
 * tolerance the caller stated and never reported as one — while
 * valid bounds keep their values and absent bounds keep their
 * zero-tolerance meaning. A non-object envelope has no
 * interpretable bound at all, so no check can fire. The projection
 * exists so a violation established through the interpretable
 * bounds can still be reported truthfully; the classification that
 * consumes it is never OK (see reconcileCommittedEffect).
 */
function fireableEnvelopeProjection(envelope: unknown): AcceptanceEnvelope {
  const NEVER = Number.POSITIVE_INFINITY;
  // FINAL correction (P15-2 completion): the projection is
  // NULL-PROTOTYPE, like the sanitized envelope — it is an
  // envelope-shaped object whose absent fields must stay absent
  // under any Object.prototype pollution when it is later read
  // for bounds (via compareDeterminedDimensions).
  if (typeof envelope !== "object" || envelope === null || Array.isArray(envelope)) {
    const none = Object.create(null) as AcceptanceEnvelope;
    none.maxImmediateNetIncrease = NEVER;
    none.maxImmediateCreditDecrease = NEVER;
    none.maxRecurringIncrease = NEVER;
    return none;
  }
  const record = envelope as Record<string, unknown>;
  const out = Object.create(null) as AcceptanceEnvelope;
  for (const field of ENVELOPE_FIELD_NAMES) {
    // Own properties only (P15-2): an inherited bound is not part
    // of the recorded envelope, so it neither fires nor is
    // projected — it is absent, exactly as in validation.
    const value = ownEnvelopeBound(record, field);
    if (value === undefined) continue;
    out[field] = typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : NEVER;
  }
  return out;
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
  proposal?: SubscriptionChangeProposal,
  unitContext?: ComparisonUnitContext
): string | null {
  // PR-15 (Finding 2): the envelope is caller input, validated
  // BEFORE the determinacy assessment and any comparison — a
  // malformed bound (NaN, negative, string-typed) or an unknown
  // field refuses as INVALID_PROPOSAL here, at this pre-dispatch
  // gate, rather than silently disabling the comparison it bounds
  // (every comparison against NaN is false — repro44.5). A missing
  // envelope at this entry point is likewise invalid input: an
  // empty object is the way to state zero tolerance explicitly.
  if (envelope === undefined || envelope === null) {
    throw new SCQError(
      "INVALID_PROPOSAL",
      "checkAcceptanceEnvelope requires an acceptance envelope object (an empty object states zero tolerance on every dimension); a missing envelope at this pre-dispatch gate is invalid input, not tolerance by silence.",
      { envelopeProblem: "envelope missing" }
    );
  }
  assertEnvelopeShapeValid(envelope);
  assertEnvelopeEnforceable(quoted, revalidated, proposal);
  const assessments = assessEnvelopePair(quoted, revalidated, proposal, "quote");
  const comparable = new Set(assessments.filter((d) => d.comparable).map((d) => d.dimension));
  // PR-16 (Finding 4): unit comparability gates the pass. A
  // numeric pass across differing established units is not a
  // pass (the numbers are not comparable), and a participating
  // currency that cannot be established means compliance cannot
  // be established either. Both refuse at this pre-dispatch gate
  // (a returned violation string, like numeric drift); the
  // VIOLATED / UNVERIFIED distinction belongs to the
  // post-dispatch reconciliation, where an outcome exists to
  // classify.
  //
  // Correction round (P16-1): the REASON must be truthful, and
  // unit comparability is a per-dimension PRECONDITION for
  // numeric evidence. An established unit contradiction refuses
  // on the contradiction; a numeric drift refuses as drift only
  // on a dimension whose units are established (and compatible);
  // a numeric difference on a dimension whose currency cannot be
  // established refuses as UNESTABLISHABLE UNITS — the gate
  // refuses either way (nothing dispatches on an unproven
  // comparison), but it never reports an uninterpretable
  // difference as a proven drift.
  const unitProblems = assessUnitComparability(quoted, revalidated, comparable, unitContext);
  const unitContradiction = unitProblems.find((p) => p.kind === "contradiction");
  if (unitContradiction) {
    return `unit comparability precondition failed: ${unitContradiction.detail}`;
  }
  const unestablishableDims = new Set(unitProblems.filter((p) => p.kind === "unestablishable").map((p) => p.dimension));
  for (const dimension of comparable) {
    if (unestablishableDims.has(dimension)) continue;
    const violation = numericViolationOnDimension(quoted, revalidated, envelope, dimension);
    if (violation) return violation;
  }
  const unitUnestablishable = unitProblems.find((p) => p.kind === "unestablishable");
  if (unitUnestablishable) {
    return `unit comparability cannot be established: ${unitUnestablishable.detail}`;
  }
  return null;
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
 *    unestablished provenance, an unjustified NOT_APPLICABLE, or a
 *    NOT_APPLICABLE asserted over a present financial field —
 *    BC1-R1): compliance was not proven, so OK is not available. An UNKNOWN
 *    committed dimension cannot produce OK by absence, by numeric
 *    coincidence, or by sharing the quote's number.
 *  - OK — every dimension is established and within the envelope
 *    (or legitimately skipped as justified NOT_APPLICABLE on both
 *    sides).
 *
 * PR-15 (Finding 2) adds the malformed-envelope rule, in the same
 * spirit: an envelope that cannot be interpreted as recorded (a
 * NaN / negative / string-typed bound, an unknown field, a
 * non-object shape) never throws here and never reads as
 * compliance — a violation established through its interpretable
 * bounds reports VIOLATED, and anything else reports UNVERIFIED.
 * The pre-dispatch counterpart (checkAcceptanceEnvelope) refuses
 * the same input as INVALID_PROPOSAL: invalid input refuses
 * BEFORE dispatch and classifies AFTER it.
 *
 * PR-16 (Finding 4) adds the unit-comparability precondition to
 * both envelope-bearing paths: over the dimensions BC-1
 * established as comparable, an established currency or cadence
 * contradiction classifies VIOLATED (it is envelope-independent
 * and outranks unverifiability), and a participating currency
 * that cannot be established on one side classifies UNVERIFIED.
 * Equal numbers across differing units never reconcile OK. See
 * `assessUnitComparability`.
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
 *
 * Correction round (P16-1, P16-2 — independent review of PR-16):
 *
 *  - P16-1: unit comparability is a per-dimension PRECONDITION
 *    for numeric evidence, not a check performed after it. As
 *    delivered, PR-16 compared numbers first, so a numeric
 *    difference on a dimension whose currency could not be
 *    established classified VIOLATED — but amounts in
 *    unestablished units cannot be meaningfully compared, so
 *    that difference is not evidence of a violation. Now: a
 *    dimension's numeric difference establishes VIOLATED only
 *    when that dimension's units are established (and, for a
 *    contradiction, the contradiction itself is the established
 *    evidence). A masked numeric difference leaves the dimension
 *    UNVERIFIED unless an independent established violation
 *    (another dimension's established numeric violation, or an
 *    established unit contradiction) classifies the commit
 *    VIOLATED.
 *  - P16-2: the no-envelope path applies unit comparability
 *    too. An established unit contradiction is established
 *    evidence, envelope or not, and classifies VIOLATED; a
 *    participating currency that cannot be established
 *    classifies UNVERIFIED (a commit whose units cannot be
 *    established cannot be verified as matching). Two paths are
 *    excepted, by construction: EXACT's defined_equal_exact
 *    committed figures ARE the quoted figures (their units are
 *    the quote's units, identically), and a dimension that does
 *    not participate (justified NOT_APPLICABLE / no established
 *    figures) raises no unit question. The cancellation
 *    exception itself — no envelope required — is unchanged.
 */
export function reconcileCommittedEffect(
  quoted: CommercialEffect,
  committed: CommercialEffect,
  envelope: AcceptanceEnvelope | undefined,
  proposal?: SubscriptionChangeProposal,
  unitContext?: ComparisonUnitContext
): ReconciliationResult {
  const assessments = assessEnvelopePair(quoted, committed, proposal, "committed");
  const undetermined = assessments.filter((d) => !d.comparable && !d.skipped);
  const comparable = new Set(assessments.filter((d) => d.comparable).map((d) => d.dimension));

  // PR-16 (Finding 4) + correction round (P16-1/P16-2): unit
  // comparability over the participating dimensions — computed
  // once, BEFORE any path can return, and consumed by every
  // classification path below, the no-envelope path included. A
  // unit CONTRADICTION is an established negative (it outranks
  // unverifiability, exactly like an established numeric
  // violation); an UNESTABLISHABLE participating currency makes
  // compliance unprovable (UNVERIFIED) and — P16-1 — strips that
  // dimension's numeric difference of evidential force. Neither
  // can read OK.
  const unitProblems = assessUnitComparability(quoted, committed, comparable, unitContext);
  const unitContradiction = unitProblems.find((p) => p.kind === "contradiction");
  const unitUnestablishable = unitProblems.filter((p) => p.kind === "unestablishable");
  const unestablishableDims = new Set(unitUnestablishable.map((p) => p.dimension));

  // PR-15 correction (P15-1): ONLY `undefined` is an omitted
  // envelope. The pre-correction `if (!envelope)` also routed
  // SUPPLIED falsy values (null, false, 0, "") down this
  // no-envelope path, where established committed figures returned
  // OK for malformed input. A supplied-but-falsy envelope now
  // falls through to the malformed-envelope classification below:
  // it never throws (the receipt must be recorded) and never
  // reads OK.
  if (envelope === undefined) {
    // Judge the COMMITTED side alone: with nothing to compare
    // against, the quoted side's determinacy is not the question —
    // whether the reported actuals are established is.
    const unestablishedCommitted = assessments.filter(
      (d) => d.compared.kind === "unenforceable"
    );
    // Correction round (P16-2): unit comparability applies here
    // too — "no envelope" removes the tolerance comparison, not
    // the question of whether the committed figures are in the
    // units the quote stated. An established contradiction is
    // established evidence and classifies VIOLATED; an
    // unestablishable participating currency blocks OK
    // (UNVERIFIED: the commit cannot be verified as matching in
    // units that cannot be established). EXCEPTED by
    // construction: committed figures whose source is
    // defined_equal_exact ARE the quoted figures — EXACT defines
    // committed := quoted, so their units are the quote's units
    // identically and no unit question arises; dimensions that
    // do not participate (not comparable) likewise raise none.
    const definedEqualByConstruction = committed.provenance?.committedSource === "defined_equal_exact";
    if (!definedEqualByConstruction) {
      if (unitContradiction) {
        return {
          status: "VIOLATED",
          reason:
            `Post-commit reconciliation failed: no acceptance envelope applies, but the ACTUALLY-committed effect's ` +
            `established units contradict the quoted effect's — ${unitContradiction.detail}. A unit contradiction is ` +
            `established evidence and is envelope-independent: no tolerance comparison is needed to know that amounts ` +
            `in differing currencies or at differing cadences are not the amounts quoted. The mutation has already ` +
            `occurred and cannot be rolled back by this reconciliation check; it exists solely so this is never ` +
            `reported silently.`,
        };
      }
      if (unitUnestablishable.length > 0 && unestablishedCommitted.length === 0) {
        return {
          status: "UNVERIFIED",
          reason:
            `Post-commit reconciliation cannot be established: no acceptance envelope applies and the committed ` +
            `figures are established, but their units cannot be verified as the quoted units — ` +
            `${unitUnestablishable.map((p) => p.detail).join("; ")}. A commit whose participating units cannot be ` +
            `established cannot be verified as matching, so OK is not available (correction round, P16-2). The ` +
            `mutation has already occurred; its unestablished unit(s) require operator follow-up, not a silent OK.`,
          undeterminedDimensions: unitUnestablishable.map((p) => p.dimension),
        };
      }
    }
    if (unestablishedCommitted.length === 0) return { status: "OK" };
    return {
      status: "UNVERIFIED",
      reason:
        `Post-commit reconciliation cannot be established: no acceptance envelope applies, and the committed ` +
        `financial outcome is itself unestablished (${unestablishedCommitted.map((d) => describeAssessment(d, "committed")).join("; ")}). ` +
        `Reporting OK would present unmeasured figures as verified actuals; the commit stands, but its finances are unverified.` +
        (!definedEqualByConstruction && unitUnestablishable.length > 0
          ? ` Unit comparability is additionally unestablishable: ${unitUnestablishable.map((p) => p.detail).join("; ")}.`
          : ""),
      undeterminedDimensions: [
        ...new Set([
          ...unestablishedCommitted.map((d) => d.dimension),
          ...(!definedEqualByConstruction ? unitUnestablishable.map((p) => p.dimension) : []),
        ]),
      ],
    };
  }

  // PR-15 (Finding 2): a MALFORMED envelope (a NaN / negative /
  // string-typed bound, an unknown field, a non-object shape)
  // encountered POST-commit classifies — it never throws (this
  // function never throws: the mutation has already landed and its
  // receipt must be recorded) and it never silently passes (a NaN
  // bound makes every comparison against it false, which the
  // pre-PR-15 code read as compliance). Comparisons run on the
  // envelope's FIREABLE projection (see fireableEnvelopeProjection):
  // a violation established through the interpretable bounds
  // reports VIOLATED — a proven violation is never downgraded by
  // an unrelated uninterpretable term — and otherwise compliance
  // is UNVERIFIED, because the caller's tolerance as recorded
  // cannot be fully interpreted.
  const envelopeProblem = envelopeShapeProblem(envelope);
  if (envelopeProblem) {
    // Correction round (P16-1): the fireable projection's numeric
    // evidence is subject to the same per-dimension unit
    // precondition — a violation "established through the
    // interpretable bounds" must be established on a dimension
    // whose units are established; a numeric difference on an
    // unestablishable-unit dimension fires nothing.
    const fireable = fireableEnvelopeProjection(envelope);
    let fireableViolation: string | null = null;
    for (const dimension of comparable) {
      if (unestablishableDims.has(dimension)) continue;
      fireableViolation = numericViolationOnDimension(quoted, committed, fireable, dimension);
      if (fireableViolation) break;
    }
    if (fireableViolation) {
      return {
        status: "VIOLATED",
        reason:
          `Post-commit reconciliation failed: the ACTUALLY-committed effect falls outside the caller's ` +
          `acceptance envelope (${fireableViolation}). This violation is established through the envelope's ` +
          `interpretable bounds alone; the recorded envelope is additionally malformed (${envelopeProblem}), ` +
          `which does not downgrade a proven violation. The mutation has already occurred and cannot be ` +
          `rolled back by this reconciliation check; it exists solely so this is never reported silently.`,
      };
    }
    if (unitContradiction) {
      return {
        status: "VIOLATED",
        reason:
          `Post-commit reconciliation failed: the ACTUALLY-committed effect is not comparable with the quoted effect — ` +
          `${unitContradiction.detail}. A unit contradiction is envelope-independent (no tolerance denominates across ` +
          `currencies or cadences), so it is established even though the recorded envelope is additionally malformed ` +
          `(${envelopeProblem}). The mutation has already occurred and cannot be rolled back by this reconciliation ` +
          `check; it exists solely so this is never reported silently.`,
      };
    }
    return {
      status: "UNVERIFIED",
      reason:
        `Post-commit reconciliation cannot be established: the recorded acceptance envelope is malformed ` +
        `(${envelopeProblem}), so compliance with the caller's tolerance as recorded cannot be established — ` +
        `a malformed bound is never compared as zero and never read as compliance (PR-15). The mutation has ` +
        `already occurred; its receipt is recorded with this classification, and the malformed envelope ` +
        `requires operator follow-up.` +
        (unitUnestablishable.length > 0
          ? ` Unit comparability is additionally unestablishable: ${unitUnestablishable.map((p) => p.detail).join("; ")}.`
          : ""),
      undeterminedDimensions: [...new Set([...undetermined.map((d) => d.dimension), ...unitUnestablishable.map((p) => p.dimension)])],
    };
  }

  // Correction round (P16-1): classification order. An
  // established unit CONTRADICTION classifies first — it is
  // established evidence in its own right, and it must not be
  // displaced by a numeric difference computed across the very
  // units that contradict (or across a dimension whose units
  // cannot be established at all). A numeric violation then
  // classifies only where it is established: on a dimension
  // whose units are established and compatible. A numeric
  // difference on an unestablishable-unit dimension is masked —
  // it is not evidence — and the commit falls through to the
  // UNVERIFIED classification below.
  if (unitContradiction) {
    return {
      status: "VIOLATED",
      reason:
        `Post-commit reconciliation failed: the ACTUALLY-committed effect is not comparable with the quoted effect — ` +
        `${unitContradiction.detail}. The numeric comparison is not meaningful across differing units, so numeric ` +
        `equality does not reconcile this commit. The mutation has already occurred and cannot be rolled back by ` +
        `this reconciliation check; it exists solely so this is never reported silently.`,
    };
  }
  let violation: string | null = null;
  for (const dimension of comparable) {
    if (unestablishableDims.has(dimension)) continue;
    violation = numericViolationOnDimension(quoted, committed, envelope, dimension);
    if (violation) break;
  }
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
  if (unitUnestablishable.length > 0) {
    return {
      status: "UNVERIFIED",
      reason:
        `Post-commit reconciliation cannot be established: ${unitUnestablishable.map((p) => p.detail).join("; ")}. ` +
        `A unit that cannot be established is not a unit that agrees — an unmeasured denomination cannot reconcile ` +
        `OK (PR-16, Finding 4). The mutation has already occurred; its unestablished unit(s) require operator ` +
        `follow-up, not a silent OK.`,
      undeterminedDimensions: [...new Set([...unitUnestablishable.map((p) => p.dimension), ...undetermined.map((d) => d.dimension)])],
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
 *
 * PR-15 hardening (Finding 2): the pre-PR-15 implementation returned
 * `proposal.guaranteeMode ?? "REVALIDATE"` VERBATIM, so a runtime
 * value outside the type union ("REVALDIATE", an explicit null,
 * a number) flowed into every consumer's mode branches and
 * satisfied none of them — enforcement fell through both branches.
 * An omitted (undefined) mode still defaults to REVALIDATE; the
 * two literals resolve to themselves; ANY other runtime value —
 * explicit null included — refuses as INVALID_PROPOSAL, so a
 * direct caller of this shared entry point cannot bypass
 * enforcement with an invalid mode.
 */
export function resolveGuaranteeMode(proposal: SubscriptionChangeProposal): GuaranteeMode {
  if (!proposal || typeof proposal !== "object") {
    throw new SCQError("INVALID_PROPOSAL", `resolveGuaranteeMode requires a proposal object; got ${runtimeValueForMessage(proposal)}.`);
  }
  const mode: unknown = (proposal as { guaranteeMode?: unknown }).guaranteeMode;
  if (mode === undefined) return "REVALIDATE";
  if (mode === "EXACT" || mode === "REVALIDATE") return mode;
  throw new SCQError(
    "INVALID_PROPOSAL",
    `guaranteeMode ${runtimeValueForMessage(mode)} is not a recognized guarantee mode — the only values are "EXACT" and "REVALIDATE" (omit the field for the REVALIDATE default). A malformed mode is refused here, at the shared resolution point, rather than falling through both modes' enforcement.`,
    { guaranteeMode: mode ?? null }
  );
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
  // PR-15 hardening (Finding 2): this function's branches key on
  // the literals "EXACT" and "REVALIDATE", so a direct caller
  // passing an invalid runtime mode fell through BOTH branches —
  // no coverage check, no envelope requirement. An unrecognized
  // mode is invalid input and refuses here, at the enforcement
  // entry point, not downstream by accident. The same applies to
  // a malformed envelope and to an empty change set (whose
  // vacuous `every` would otherwise read as all-CANCEL and skip
  // the envelope requirement).
  if (effectiveMode !== "EXACT" && effectiveMode !== "REVALIDATE") {
    throw new SCQError(
      "INVALID_PROPOSAL",
      `guaranteeMode ${runtimeValueForMessage(effectiveMode)} is not a recognized guarantee mode — the only values are "EXACT" and "REVALIDATE". Refusing at the enforcement entry point: a malformed mode must never fall through both modes' branches.`,
      { guaranteeMode: effectiveMode ?? null }
    );
  }
  if (!Array.isArray(changes) || changes.length === 0) {
    throw new SCQError("INVALID_PROPOSAL", "enforceGuaranteeRequest requires a non-empty changes array.", { changes: Array.isArray(changes) ? changes.length : null });
  }
  assertEnvelopeShapeValid(acceptanceEnvelope);
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
  // `=== undefined`, not falsiness (P15-1 consistency): the shape
  // assertion above has already refused every supplied malformed
  // value, so only a genuinely omitted envelope reaches this test.
  if (effectiveMode === "REVALIDATE" && !allCancel && acceptanceEnvelope === undefined) {
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
  | "MISSING_APPLICABILITY_PROVENANCE"
  | "INCONSISTENT_NOT_APPLICABLE_VALUE";

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

/** The dimension's whole financial field — the BC1-R1 purity test (see dimensionField). */
function auditDimensionField(effect: CommercialEffect, dimension: FinancialDimension): unknown {
  return dimension === "immediateFinancialEffect" ? effect.immediate : effect.recurring;
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
    // BC1-R1 — field-absence purity first, exactly as in the gate's
    // assessment (assessDimensionSide): a NOT_APPLICABLE assertion
    // over a PRESENT financial field is internally inconsistent
    // (the dimension is claimed not to arise while its field
    // carries a value — an explicit zero included), and reports
    // INCONSISTENT_NOT_APPLICABLE_VALUE regardless of how the
    // justification preconditions below would have resolved.
    if (auditDimensionField(effect, dimension) !== undefined) {
      findings.add("INCONSISTENT_NOT_APPLICABLE_VALUE");
      return;
    }
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

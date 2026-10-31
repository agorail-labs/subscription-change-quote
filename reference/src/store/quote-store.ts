// In-memory quote store, keyed by quote_id.
//
// This is intentionally a dumb bag of records — no provider logic lives here.
// It exists so both adapters share the exact same STALE/EXPIRED bookkeeping
// instead of re-implementing it per provider.
//
// DURABILITY LIMIT (explicit — do not soften): this store is a volatile
// in-process Map. NOTHING in it survives a process restart. SCQ's
// receipt-replay idempotency (§6.10) is therefore bounded by process
// lifetime: after a restart an already-committed quote's receipt is
// unrecoverable, adapters can only fail closed, and exactly-once cannot
// be proven from this store. There is no indefinitely-safe idempotency
// here — on the real Chargebee API the only native backstop is the
// documented 30-minute idempotency window. A conforming deployment
// MUST substitute a durable, transactional store (atomic
// status+receipt write keyed by quote id, surviving restart) before
// relying on replay semantics; see
// research/chargebee-live-v1/LIMITATIONS-AND-GAPS.md D-3.

import { createHash } from "node:crypto";
import { SCQError, type AuthorizationScope, type CommercialEffect, type GuaranteeCoverage, type GuaranteeMode, type MultiChangeConsistency, type MutationCapability, type MutationOutcome, type ProviderObservation, type ReconciliationResult, type SubscriptionChangeProposal, type SubscriptionChangeReceipt, type VerificationEvidence } from "../core/types.js";
import { reconcileCommittedEffect } from "../core/scq-engine.js";
import { verifyPostCommitState } from "../core/state-verification.js";

/**
 * v0.6.2 (CORE-8 / findings-closure F4): a receipt's IDENTITY — the
 * canonical tuple of what was recorded, not merely its outcome
 * class. Comparing only status/outcome is non-conforming: two
 * receipts in the same outcome class with different figures are
 * DIFFERENT receipts, and re-recording one over the other would
 * rewrite history.
 *
 * The tuple is (receiptId, quoteId, subscriptionId, recorded
 * outcome, recorded reconciliation status, committed immediate.net,
 * recorded committed recurring.resultingAmount), canonically
 * serialized by `receiptIdentityDigest` (fixed key order, JSON —
 * the prototype model's reference shape). The recorded outcome is
 * read from the receipt as RECORDED: after a verification
 * transition the record's CURRENT outcome advances, but its
 * recorded identity — and therefore this digest — does not.
 */
export function receiptIdentityFields(receipt: SubscriptionChangeReceipt): {
  receiptId: string | null;
  quoteId: string | null;
  subscriptionId: string | null;
  recordedOutcome: "COMMITTED_AND_VERIFIED" | "COMMITTED_UNVERIFIED";
  recordedReconciliationStatus: ReconciliationResult["status"] | null;
  immediateNet: number | null;
  recurringAmount: number | null;
} {
  return {
    receiptId: receipt.receiptId ?? null,
    quoteId: receipt.quoteId ?? null,
    subscriptionId: receipt.subscriptionRef ?? null,
    recordedOutcome:
      receipt.outcome === "COMMITTED_AND_VERIFIED" || receipt.outcome === "COMMITTED_UNVERIFIED"
        ? receipt.outcome
        : receipt.status === "COMMITTED_UNVERIFIED"
          ? "COMMITTED_UNVERIFIED"
          : "COMMITTED_AND_VERIFIED",
    recordedReconciliationStatus: receipt.reconciliation?.status ?? null,
    immediateNet: receipt.committedEffect?.immediate?.net ?? null,
    recurringAmount: receipt.committedEffect?.recurring?.resultingAmount ?? null,
  };
}

/** Canonical identity string for a receipt as recorded. Stable across the verification transition. */
export function receiptIdentityDigest(receipt: SubscriptionChangeReceipt): string {
  return JSON.stringify(receiptIdentityFields(receipt));
}

/**
 * Structural deep copy. Deliberately NOT a JSON round-trip: JSON
 * drops `undefined`-valued members (adapters build receipts with
 * e.g. `credit: undefined`), and a stored copy that silently loses
 * members is not the recorded receipt — replay must return the
 * original verbatim (§6.10). This clone preserves undefined-valued
 * keys exactly; the identity digest (JSON-based) is unaffected,
 * since JSON serialization drops those members deterministically
 * on both sides of every comparison.
 */
function deepCopy<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((child) => deepCopy(child)) as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = deepCopy(v);
  return out as T;
}

/**
 * PR #8 review correction C3: the recorded receipt snapshot is
 * frozen at record time — it is the immutable original every
 * identity comparison and recovery check runs against, and no
 * code path (store-internal or caller, via any returned reference)
 * may rewrite it.
 */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Key-order-insensitive canonical serialization, for coherence comparisons in recovery (C2). */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}

function deepEqualCanonical(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

export type QuoteStatus = "ACTIVE" | "COMMITTED" | "EXPIRED" | "STALE" | "SUPERSEDED";

/**
 * PR-17 (Issue #22, Finding 5): the disposition of one evidence
 * entry toward the RECORDED CANDIDATE of one financial dimension:
 *  - "ESTABLISHES": the dimension had no recorded candidate; this
 *    entry independently establishes its actual (F5a);
 *  - "CONFIRMS": the entry establishes the same actual the
 *    candidate recorded;
 *  - "CONTRADICTS_CANDIDATE": the entry establishes a DIFFERENT
 *    actual than the candidate recorded (F5b) — a statement about
 *    the candidate, never an identity conflict: the recorded
 *    receipt and its identity digest do not move;
 *  - "UNRESOLVED": this entry does not establish the dimension
 *    (its determinacy there is not DETERMINED/NOT_APPLICABLE, or
 *    it carries no figure).
 */
export type ReceiptEvidenceDimensionDisposition =
  | "ESTABLISHES"
  | "CONFIRMS"
  | "CONTRADICTS_CANDIDATE"
  | "UNRESOLVED";

/**
 * PR-17 (Issue #22, Finding 5): one entry of a receipt's
 * append-only EVIDENCE RECORD — the second layer of the receipt
 * model, between the immutable recorded receipt (layer 1) and the
 * derived current view (layer 3, `commit_receipt`).
 *
 * Entries are appended by `recordReceiptEvidence` /
 * `verifyCommitReceipt` and never edited or removed afterwards.
 * An entry is bound to the recorded receipt by `identityDigest`
 * (the receipt's canonical recorded identity, candidates
 * included) and carries its own content-derived `evidenceId`:
 * resubmitting the same evidence is an idempotent no-op, and a
 * persisted trail whose stated ids do not match their contents
 * is refused at recovery.
 *
 * `disposition` records, per financial dimension, what this entry
 * does to the recorded candidate. `conflicts` records, per
 * dimension, that this entry's established actual contradicts an
 * ALREADY-ACCEPTED established actual from an earlier entry: the
 * deterministic conflict rule is first-established stands — the
 * conflicting entry is appended and flagged, the accepted actual
 * is never silently replaced, and the derived view carries an
 * unresolved evidence conflict (never an unqualified OK) while
 * any conflict stands.
 *
 * Entries persisted before PR-17 (the legacy one-transition
 * trail) carry only {at, reconciliation, identityDigest,
 * evidence}; the PR-17 fields are derived deterministically from
 * their contents at recovery and filled in on adoption.
 */
export type ReceiptEvidenceEntry = {
  at: string;
  reconciliation: ReconciliationResult;
  /** The recorded identity digest this entry is bound to (see C1/C2). */
  identityDigest: string;
  evidence: VerificationEvidence;
  /** PR-17: content-derived evidence identity (sha-256 over the bound identity digest + canonical evidence contents). */
  evidenceId?: string;
  /**
   * PR-17 review correction (cross-observation coherence): the
   * identity of the post-commit state this entry's evidence was
   * established AGAINST — a digest of the originating
   * observation's resulting-snapshot identity (its subscription
   * id + state revision `version`, the state identity the
   * protocol's own staleness semantics already use). Stamped at
   * minting from the observation itself and bound into the
   * entry's `evidenceId`; absent when the observation carried
   * no resulting snapshot — or one whose subscription id or
   * state revision was degenerate (empty / missing / non-string:
   * no identity is established, see `observedStateDigestOf`) —
   * and on legacy entries. It is a
   * COHERENCE KEY for composition, not an authenticity proof:
   * it lets the promotion rule require that the entries a
   * promoted view rests on were established against ONE observed
   * state revision, instead of silently composing actuals and a
   * state verdict that were observed against different states.
   */
  observedStateDigest?: string;
  /** PR-17: per-dimension disposition toward the recorded candidates. */
  disposition?: {
    immediateFinancialEffect: ReceiptEvidenceDimensionDisposition;
    recurringFinancialEffect: ReceiptEvidenceDimensionDisposition;
  };
  /** PR-17: per-dimension conflict notes — present only for dimensions where this entry contradicts an earlier accepted established actual. */
  conflicts?: {
    immediateFinancialEffect?: string;
    recurringFinancialEffect?: string;
  };
};

/**
 * PR-17: the canonical identity of one evidence entry — a digest
 * of the receipt identity it is bound to and its own contents.
 * Derived, never asserted: two entries with the same id have the
 * same bound identity and the same evidence contents, so a
 * resubmission is detectable as a duplicate, and a persisted
 * entry whose stated id differs from its contents has been
 * altered.
 */
export function evidenceEntryId(
  identityDigest: string,
  evidence: VerificationEvidence,
  observedStateDigest?: string
): string {
  return createHash("sha256")
    .update(canonical({ identityDigest, evidence, observedStateDigest: observedStateDigest ?? null }), "utf8")
    .digest("hex");
}

/**
 * PR-17 re-review (degenerate-revision edge case): one component
 * of an observed-state identity is ESTABLISHED only when it is a
 * non-empty string (after trimming). Anything else — absent,
 * undefined, a non-string runtime value (a deserialized record
 * can carry any shape), an empty string, a whitespace-only
 * string — establishes nothing. The check is deliberately
 * runtime-shaped, not type-shaped: the snapshots this runs over
 * cross serialization boundaries where the declared types are
 * not enforced.
 */
function isEstablishedIdentityComponent(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * PR-17 review correction: the observed-state identity of one
 * provider observation — the (subscription, state-revision)
 * pair of its resulting snapshot, digested. Two observations of
 * the SAME state revision share this identity however much of
 * the state each read presented (a read omitting the item
 * collection and a full read of that revision are observations
 * of one state); observations of different revisions never do.
 * An observation carrying no resulting snapshot has NO observed
 * state identity (undefined): its figures may be recorded, but
 * they cannot take part in a cross-entry promotion (see the
 * coherence rule in `analyzeEvidenceTrail`).
 *
 * PR-17 re-review (degenerate-revision edge case): the identity
 * exists only when BOTH components are established (see
 * `isEstablishedIdentityComponent`). The original form checked
 * only that a snapshot EXISTS, so every observation of a
 * subscription whose snapshot carried an empty (or runtime-
 * missing) version received the SAME identity — the digest of
 * {subscription, ""} — and two observations of DIFFERENT states
 * composed as though they were one state: the §8 false
 * promotion, re-entering through degenerate revisions. A
 * degenerate component now yields no identity at all, and the
 * observation is treated exactly like a snapshot-less one.
 * Components that ARE established are digested verbatim (exact-
 * string identity, as before): the trim decides existence only,
 * never equality.
 */
export function observedStateDigestOf(snapshot: { id: string; version: string } | undefined): string | undefined {
  if (!snapshot) return undefined;
  if (!isEstablishedIdentityComponent(snapshot.id) || !isEstablishedIdentityComponent(snapshot.version)) {
    return undefined;
  }
  return createHash("sha256")
    .update(canonical({ subscriptionId: snapshot.id, version: snapshot.version }), "utf8")
    .digest("hex");
}

type FinancialDimensionKey = "immediateFinancialEffect" | "recurringFinancialEffect";
const FINANCIAL_DIMENSIONS: FinancialDimensionKey[] = ["immediateFinancialEffect", "recurringFinancialEffect"];

function dimensionFigure(effect: CommercialEffect, dim: FinancialDimensionKey): number | null {
  return dim === "immediateFinancialEffect"
    ? effect.immediate?.net ?? null
    : effect.recurring?.resultingAmount ?? null;
}

/**
 * PR-17: whether an evidence effect INDEPENDENTLY ESTABLISHES a
 * dimension: its determinacy there is DETERMINED with a figure,
 * or NOT_APPLICABLE (the dimension is resolved as not arising).
 * A figure riding under UNKNOWN determinacy is candidate-grade —
 * it establishes nothing, exactly the F5 distinction between a
 * recorded candidate and an established actual.
 */
function dimensionEstablished(effect: CommercialEffect, dim: FinancialDimensionKey): boolean {
  const state = effect.determinacy?.[dim];
  if (state === "DETERMINED") return dimensionFigure(effect, dim) !== null;
  return state === "NOT_APPLICABLE";
}

/**
 * PR-17: the pure trail analysis behind every derived view and
 * every recovery coherence check. Given the recorded receipt and
 * its evidence trail IN ORDER, it computes:
 *  - each entry's disposition toward the recorded candidates and
 *    its conflicts against earlier accepted actuals;
 *  - the COMPOSED committed effect: per dimension, the
 *    establishing entry's figures, determinacy, and provenance
 *    replace the recorded candidate's; unestablished dimensions
 *    keep the candidate's slice and labels verbatim;
 *  - whether any entry established the post-commit state as
 *    VERIFIED, and whether any unresolved actuals conflict
 *    stands.
 *
 * Composition rule (explicit, per the PR-17 design): per
 * dimension, the FIRST entry that establishes the dimension sets
 * the accepted actual; a later entry establishing the SAME value
 * confirms it; a later entry establishing a DIFFERENT value is a
 * conflict — flagged on that entry, never substituted.
 *
 * Cross-observation coherence (PR-17 review correction):
 * composition composes FIGURES per dimension, but a promotion
 * also claims the post-commit STATE was verified — and that
 * verdict was computed inside ONE entry's originating
 * observation, against the state THAT observation read. The
 * PROMOTION BASIS is the set of entries the promoted view's
 * claims rest on: the accepted establisher of each dimension,
 * plus — when none of them carries the VERIFIED verdict — the
 * first VERIFIED entry. The basis is COHERENT only when it is a
 * single entry (one observation is coherent with itself by
 * construction), or when every basis entry carries the SAME
 * observed-state identity (the same state revision; see
 * `observedStateDigestOf`). A basis entry with NO observed-state
 * identity cannot take part in a cross-entry promotion: its
 * figures are recordable and displayable, but a promotion that
 * would rest on composing it with other entries' observations
 * is not available. Without this rule, actuals established
 * against one post-commit state and a VERIFIED verdict
 * established against a different, incompatible state composed
 * into a COMMITTED_AND_VERIFIED view no single observation
 * ever supported.
 *
 * The composed effect's whole-effect `committedSource` claims an
 * establishing source ONLY when every participating dimension
 * (one not resolved NOT_APPLICABLE) is established; otherwise it
 * reads "unestablished" — a verified label never rides on
 * partially unestablished figures (F5c).
 */
function analyzeEvidenceTrail(
  recorded: SubscriptionChangeReceipt,
  entries: ReceiptEvidenceEntry[]
): {
  perEntry: Array<{
    disposition: NonNullable<ReceiptEvidenceEntry["disposition"]>;
    conflicts: NonNullable<ReceiptEvidenceEntry["conflicts"]>;
  }>;
  composedEffect: CommercialEffect;
  anyConflict: boolean;
  conflictDimensions: FinancialDimensionKey[];
  stateVerified: boolean;
  /** PR-17 review correction: the entries a promotion would rest on, and whether they share one observed-state identity. */
  promotionBasis: number[];
  promotionCoherent: boolean;
} {
  const fields = receiptIdentityFields(recorded);
  const candidateFigure: Record<FinancialDimensionKey, number | null> = {
    immediateFinancialEffect: fields.immediateNet,
    recurringFinancialEffect: fields.recurringAmount,
  };
  const accepted = new Map<FinancialDimensionKey, { figure: number | null; entryIndex: number }>();
  const perEntry = entries.map((entry, entryIndex) => {
    const effect = entry.evidence.committedEffect;
    const disposition = {} as NonNullable<ReceiptEvidenceEntry["disposition"]>;
    const conflicts = {} as NonNullable<ReceiptEvidenceEntry["conflicts"]>;
    for (const dim of FINANCIAL_DIMENSIONS) {
      if (!dimensionEstablished(effect, dim)) {
        disposition[dim] = "UNRESOLVED";
        continue;
      }
      const figure = dimensionFigure(effect, dim);
      disposition[dim] =
        candidateFigure[dim] === null ? "ESTABLISHES" : candidateFigure[dim] === figure ? "CONFIRMS" : "CONTRADICTS_CANDIDATE";
      const prior = accepted.get(dim);
      if (!prior) {
        accepted.set(dim, { figure, entryIndex });
      } else if (prior.figure !== figure) {
        conflicts[dim] =
          `this entry establishes ${dim} = ${figure}, contradicting the already-accepted established actual ` +
          `${prior.figure} from evidence entry ${prior.entryIndex + 1}; the first-established actual stands ` +
          `and this conflict is recorded for investigation`;
      }
    }
    return { disposition, conflicts };
  });

  const composed = deepCopy(recorded.committedEffect);
  composed.determinacy = {
    immediateFinancialEffect: recorded.committedEffect.determinacy?.immediateFinancialEffect ?? "UNKNOWN",
    recurringFinancialEffect: recorded.committedEffect.determinacy?.recurringFinancialEffect ?? "UNKNOWN",
  };
  composed.provenance = { ...(recorded.committedEffect.provenance ?? {}) };
  let anyEstablished = false;
  let allParticipatingEstablished = true;
  let sawProviderActual = false;
  for (const dim of FINANCIAL_DIMENSIONS) {
    const acc = accepted.get(dim);
    if (!acc) {
      if (composed.determinacy[dim] !== "NOT_APPLICABLE") allParticipatingEstablished = false;
      continue;
    }
    anyEstablished = true;
    const src = entries[acc.entryIndex].evidence.committedEffect;
    if (entries[acc.entryIndex].evidence.committedSource === "provider_actual") sawProviderActual = true;
    if (dim === "immediateFinancialEffect") {
      if (src.immediate !== undefined) composed.immediate = deepCopy(src.immediate);
      else delete composed.immediate;
      if (src.provenance?.immediate !== undefined) composed.provenance.immediate = src.provenance.immediate;
    } else {
      if (src.recurring !== undefined) composed.recurring = deepCopy(src.recurring);
      else delete composed.recurring;
      if (src.provenance?.recurring !== undefined) composed.provenance.recurring = src.provenance.recurring;
    }
    composed.determinacy[dim] = src.determinacy?.[dim] ?? "DETERMINED";
  }
  composed.provenance.committedSource = !anyEstablished
    ? recorded.committedEffect.provenance?.committedSource ?? "unestablished"
    : allParticipatingEstablished
      ? sawProviderActual
        ? "provider_actual"
        : "defined_equal_exact"
      : "unestablished";

  const conflictDimensions = FINANCIAL_DIMENSIONS.filter((dim) =>
    perEntry.some((p) => p.conflicts[dim] !== undefined)
  );
  const stateVerified = entries.some((e) => e.evidence.stateVerification === "VERIFIED");
  // The promotion basis: the accepted establisher of each
  // dimension, plus the first VERIFIED entry when no establisher
  // carries the verdict itself.
  const promotionBasis: number[] = [];
  for (const acc of accepted.values()) {
    if (!promotionBasis.includes(acc.entryIndex)) promotionBasis.push(acc.entryIndex);
  }
  if (stateVerified && !promotionBasis.some((i) => entries[i].evidence.stateVerification === "VERIFIED")) {
    promotionBasis.push(entries.findIndex((e) => e.evidence.stateVerification === "VERIFIED"));
  }
  const basisDigests = promotionBasis.map((i) => entries[i].observedStateDigest);
  const promotionCoherent =
    promotionBasis.length <= 1 ||
    (basisDigests.every((d) => d !== undefined) && basisDigests.every((d) => d === basisDigests[0]));
  return {
    perEntry,
    composedEffect: composed,
    anyConflict: conflictDimensions.length > 0,
    conflictDimensions,
    stateVerified,
    promotionBasis,
    promotionCoherent,
  };
}

export type StoredQuote<TPreviewInput = unknown> = {
  quote_id: string;
  provider: "stripe" | "paddle" | "zuora" | "chargebee";
  subscription_id: string;
  subscription_version_at_quote: string;
  proposal: SubscriptionChangeProposal;
  /** proposal.guaranteeMode resolved against the v0.3 REVALIDATE default — stored explicitly so commit-time code never has to re-derive the default. */
  effective_guarantee_mode: GuaranteeMode;
  /** v0.5: authoritative, state-aware coverage computed at quote time — becomes the quote's/receipt's guaranteeCoverage. */
  guarantee_coverage: GuaranteeCoverage;
  /** v0.5: whether committing changes.length > 1 changes together is ATOMIC / BEST_EFFORT / UNSUPPORTED for this proposal. */
  multi_change_consistency: MultiChangeConsistency;
  /**
   * PR-14 (additive, optional): the effective authorization scope
   * recorded at quote creation (the proposal's declaration, or
   * OPERATION when undeclared). Absent on quotes persisted before
   * PR-14 — readers MUST treat absence as OPERATION, never as
   * broader consent.
   */
  authorization_scope?: AuthorizationScope;
  /**
   * PR-14 (additive, optional): the mutation capability the creating
   * adapter declared for this quote at creation. A record of what
   * was disclosed, NOT an authority: at commit the adapter's current
   * declaration governs, and an absent or unknown value classifies
   * as the weakest (FULL_REPLACEMENT_ONLY).
   */
  authorization_capability?: MutationCapability;
  // Provider-specific inputs captured at quote time, replayed verbatim on commit.
  provider_preview_input: TPreviewInput;
  /** What was computed and shown to the caller at quote time — becomes the receipt's quotedEffect, unmodified. */
  quoted_effect: CommercialEffect;
  created_at: string;
  expires_at: string;
  status: QuoteStatus;
  /**
   * v0.6.1: the receipt produced the FIRST time this quote was successfully
   * committed. Populated exactly once, by `recordCommitReceipt` below, at
   * the moment `status` transitions to "COMMITTED". A repeated commit
   * attempt against an already-COMMITTED quote MUST return this SAME
   * receipt object (not re-derive or re-mutate) — see
   * `scq-engine.ts`'s `checkIdempotentReplay` and scq-v0.6.1-spec.md
   * normative rule 6.10. `undefined` for any quote that has never
   * successfully committed.
   *
   * v0.6.2: this is the record's CURRENT view — the one place a
   * verification transition (see `verifyCommitReceipt`) advances
   * outcome/status/reconciliation. The as-recorded original is
   * preserved separately in `commit_receipt_recorded` and is never
   * rewritten.
   *
   * Round 2 (R1): idempotent replay does NOT read this field —
   * §6.10's "return the original receipt" is served from
   * `commit_receipt_recorded` (see `recordedReceipt` below), so a
   * replay after verification still returns the receipt as
   * recorded. This field is the separate current-state read.
   */
  commit_receipt?: SubscriptionChangeReceipt;
  /**
   * v0.6.2 (CORE-8 / F4): the receipt EXACTLY as first recorded —
   * an immutable snapshot taken by `recordCommitReceipt`. Identity
   * comparisons and recovery verification run against this record,
   * never against the mutable current view, and nothing in the
   * store ever writes to it after recording.
   */
  commit_receipt_recorded?: SubscriptionChangeReceipt;
  /**
   * v0.6.2 (CORE-8 / F4): `receiptIdentityDigest` of
   * `commit_receipt_recorded`, computed at record time. Stable
   * across the verification transition (the digest covers the
   * RECORDED fields), and re-verified on recovery
   * (`restoreReceiptRecords`).
   */
  commit_receipt_identity_digest?: string;
  /**
   * v0.6.2 (CORE-8 / F4): the verification append-trail.
   *
   * PR-17 (Finding 5) re-founds this field as the receipt's
   * append-only EVIDENCE RECORD (see `ReceiptEvidenceEntry`):
   * entries are appended by `recordReceiptEvidence` and by the
   * `verifyCommitReceipt` transition; an entry is never edited or
   * removed, and appending never rewrites the recorded receipt or
   * its digest. Multiple entries are expected — partial evidence
   * first, completing or conflicting evidence later. The current
   * view (`commit_receipt`) is DERIVED from the recorded receipt
   * plus this trail (see `deriveCurrentView`); it is never an
   * independently stored fact.
   */
  commit_receipt_verifications?: ReceiptEvidenceEntry[];
  /**
   * v0.6.2 (CORE-8): the terminal outcome of the LAST commit attempt
   * against this quote — recorded for EVERY terminal attempt,
   * including the no-receipt classes (INDETERMINATE /
   * CONFIRMED_NON_EXECUTION), so an indeterminate attempt leaves a
   * durable typed trace in the store instead of existing only in a
   * thrown error. Written by `recordCommitOutcome`; does not affect
   * `status` or any receipt.
   */
  commit_outcome?: { outcome: MutationOutcome; at: string; details?: unknown };
};

export class QuoteStore {
  private quotes = new Map<string, StoredQuote>();

  /**
   * Stores the store's OWN copy of the quote (PR #8 review
   * correction, round 2 — R2): the caller keeps no alias into
   * stored state, symmetric with the copy-on-read rule on `get`.
   * Callers that keep mutating their local object after `put`
   * (adapters build their response objects separately) are
   * unaffected; a caller that needs later state changes goes
   * through the store's write methods.
   */
  put(quote: StoredQuote): void {
    this.quotes.set(quote.quote_id, deepCopy(quote));
  }

   /**
   * Reads a quote as a DEFENSIVE COPY, never the internal record
   * (PR #8 review correction, round 2 — R2). Round 1 (C3) made
   * `recordCommitReceipt` copy defensively, but `get` kept handing
   * out the internal StoredQuote — including its mutable
   * `commit_receipt` — so any caller holding that reference could
   * rewrite the record's current reconciliation (or its recorded
   * snapshot reference) without `verifyCommitReceipt`, bypassing
   * every evidence check. Copy-on-read closes that route on this
   * and every other egress (`all`, `recordedReceipt`,
   * `recordCommitReceipt` / `verifyCommitReceipt` returns,
   * `receiptsWithReconciliation`); `serializeReceiptRecords`
   * returns an immutable JSON string by construction. Mutating a
   * returned object changes nothing stored — the identity digest
   * included. State changes flow only through this class's write
   * methods (`put`, `updateStatus`, `recordCommitReceipt`,
   * `verifyCommitReceipt`, `recordCommitOutcome`,
   * `restoreReceiptRecords`).
   */
  get(quoteId: string): StoredQuote | undefined {
    const q = this.quotes.get(quoteId);
    return q ? deepCopy(q) : undefined;
  }

  /**
   * v0.6.2 (PR #8 review correction, round 2 — R1): the §6.10
   * replay read — a defensive copy of the receipt EXACTLY as
   * recorded (`commit_receipt_recorded`), for a COMMITTED quote.
   * This is the only read idempotent replay may use: after a
   * verification transition the current view (`commit_receipt`)
   * shows the verified state, but a repeated commit returns the
   * ORIGINAL receipt. The latest verified state is read through
   * `get()`'s `commit_receipt` / `receiptsWithReconciliation`.
   */
  recordedReceipt(quoteId: string): SubscriptionChangeReceipt | undefined {
    const q = this.quotes.get(quoteId);
    if (q && q.status === "COMMITTED" && q.commit_receipt_recorded) {
      return deepCopy(q.commit_receipt_recorded);
    }
    return undefined;
  }

  updateStatus(quoteId: string, status: QuoteStatus): void {
    const q = this.quotes.get(quoteId);
    if (q) q.status = status;
  }

  /**
   * v0.6.1: records the receipt for a quote's FIRST successful commit and
   * marks it COMMITTED in one step, so there is no window where `status`
   * reads "COMMITTED" but `commit_receipt` is still unset. Callers MUST NOT
   * call this more than once per quote — `commitChangeQuote` is expected to
   * check for an existing `commit_receipt` (via `checkIdempotentReplay`)
   * BEFORE reaching the code path that would call this again.
   *
   * v0.6.2 (CORE-8 / findings-closure F4): recording is keyed on the
   * receipt's IDENTITY (see `receiptIdentityDigest`), not on its
   * outcome class:
   *  - Re-recording the SAME identity under the same quote is an
   *    idempotent replay: the existing record is returned and
   *    NOTHING changes — replaying a COMMITTED_UNVERIFIED receipt
   *    can never upgrade it.
   *  - A record attempt whose identity DIFFERS from the stored one
   *    — under the same quote, or reusing an existing `receiptId`
   *    under any other quote/subscription/figures — throws
   *    CONFLICTING_RECEIPT_IDENTITY and leaves the original record
   *    byte-identical. Identity is never resolved by overwriting.
   * Returns the receipt AS RECORDED (a defensive copy of
   * `commit_receipt_recorded`) — for a first recording and for a
   * replay alike, per §6.10 (round 2, R1) — or `undefined` when
   * no such quote exists (the historical no-op for unknown quotes).
   */
  recordCommitReceipt(quoteId: string, receipt: SubscriptionChangeReceipt): SubscriptionChangeReceipt | undefined {
    const q = this.quotes.get(quoteId);
    if (!q) return undefined;

    // PR #8 review correction C3: binding. A receipt is recorded
    // UNDER a StoredQuote, and its own quoteId / subscriptionRef
    // must name THAT quote and ITS subscription — a receipt bound
    // to a different quote or subscription is not this quote's
    // receipt, whatever its figures say, and is refused before any
    // identity comparison.
    if (receipt.quoteId !== quoteId || receipt.subscriptionRef !== q.subscription_id) {
      throw new SCQError(
        "CONFLICTING_RECEIPT_IDENTITY",
        `Receipt binding refused: the receipt names quote ${receipt.quoteId} / subscription ` +
          `${receipt.subscriptionRef}, but it was presented for recording under quote ${quoteId} ` +
          `(subscription ${q.subscription_id}). A receipt is recorded only under its own quote ` +
          `and subscription.`,
        { quoteId, receiptId: receipt.receiptId }
      );
    }

    const digest = receiptIdentityDigest(receipt);

    // A receiptId is a global identity: reusing it under ANY
    // differing identity is a conflict, whichever quote carries the
    // attempt.
    if (receipt.receiptId != null) {
      for (const other of this.quotes.values()) {
        if (
          other.quote_id !== quoteId &&
          other.commit_receipt_recorded?.receiptId === receipt.receiptId &&
          other.commit_receipt_identity_digest !== digest
        ) {
          throw new SCQError(
            "CONFLICTING_RECEIPT_IDENTITY",
            `Conflicting receipt identity: receipt ${receipt.receiptId} is already recorded under quote ` +
              `${other.quote_id} with a different identity (quote, subscription, figures, or recorded outcome). ` +
              `The original record is preserved; the conflicting attempt changes nothing.`,
            { quoteId, receiptId: receipt.receiptId, recordedUnderQuoteId: other.quote_id }
          );
        }
      }
    }

    if (q.commit_receipt) {
      if (q.commit_receipt_identity_digest === digest) {
        // Idempotent replay of the ORIGINAL recorded identity —
        // including after a verification transition. Per §6.10 the
        // caller gets the ORIGINAL receipt as recorded (round 2,
        // R1 — this corrects round 1's C3 behavior, which returned
        // the current view and so handed a post-verification
        // replay the VERIFIED receipt). The latest verified state
        // remains available through the separate current-view
        // reads. Never a conflict, never a second record, and the
        // replay itself transitions nothing.
        return deepCopy(q.commit_receipt_recorded!);
      }
      throw new SCQError(
        "CONFLICTING_RECEIPT_IDENTITY",
        `Conflicting receipt identity: quote ${quoteId} already has a recorded receipt whose identity ` +
          `differs from the attempted record (identity covers quote, subscription, recorded outcome, ` +
          `recorded reconciliation status, and committed figures — not merely outcome/status). ` +
          `A replay cannot rewrite history; the original record is preserved.`,
        { quoteId, receiptId: receipt.receiptId }
      );
    }

    // PR #8 review correction C3: defensive copies on ingress AND
    // egress (this supersedes PR-1's caller-reference semantics for
    // the current view). The store keeps its OWN copies: the
    // recorded snapshot is deep-frozen, and neither the caller's
    // original object nor any object the store returns aliases the
    // stored record — mutating either cannot alter the record or
    // its identity digest.
    q.commit_receipt_recorded = deepFreeze(deepCopy(receipt));
    q.commit_receipt_identity_digest = digest;
    q.commit_receipt = deepCopy(receipt);
    q.status = "COMMITTED";
    return deepCopy(q.commit_receipt);
  }

  /**
   * v0.6.2 (CORE-8): records the terminal outcome of a commit
   * attempt against this quote — including attempts that record no
   * receipt (INDETERMINATE / CONFIRMED_NON_EXECUTION), which in
   * v0.6.1 existed only in the thrown error. Does not touch the
   * quote's status or receipt.
   */
  recordCommitOutcome(
    quoteId: string,
    record: { outcome: MutationOutcome; at?: string; details?: unknown }
  ): void {
    const q = this.quotes.get(quoteId);
    if (!q) return;
    q.commit_outcome = {
      outcome: record.outcome,
      at: record.at ?? new Date().toISOString(),
      ...(record.details !== undefined ? { details: record.details } : {}),
    };
  }

  /**
   * v0.6.2 (CORE-8): enumerates recorded receipts (current view) by
   * reconciliation status — in particular, a deployment's way to
   * list every UNVERIFIED receipt for operator review, which the
   * v0.6.2 recovery obligations require to be enumerable.
   */
  receiptsWithReconciliation(status: ReconciliationResult["status"]): SubscriptionChangeReceipt[] {
    const out: SubscriptionChangeReceipt[] = [];
    for (const q of this.quotes.values()) {
      if (q.commit_receipt && q.commit_receipt.reconciliation.status === status) {
        out.push(deepCopy(q.commit_receipt));
      }
    }
    return out;
  }

  /**
   * PR-17 (Finding 5): the ADMISSIBILITY validation for evidence —
   * the first of the three questions the receipt model keeps
   * separate. Is this evidence recordable against this recorded
   * receipt at all? Shape, establishing provenance, internal
   * consistency, and agreement between the evidence's claimed
   * reconciliation and the store's own recomputation from the
   * recorded quote, the evidence's figures, and the envelope.
   *
   * PR #8 review correction C1 originally validated evidence here
   * for the single verification transition, including a
   * requirement that the evidence's figures EQUAL the recorded
   * candidates. PR-17 removes that equality requirement — it was
   * Finding 5's root defect: candidate equality is not identity
   * preservation. The recorded identity (digest, candidates
   * included) is preserved by never rewriting the recorded
   * receipt, not by refusing later actuals. What an entry
   * establishes, and whether the record may be promoted, are
   * separate questions answered by the trail analysis and the
   * promotion rule — not by admissibility.
   *
   * Shared by `recordReceiptEvidence`, `verifyCommitReceipt`
   * (which adds the promotion requirements), and
   * `restoreReceiptRecords` (recovery coherence: a persisted
   * trail entry's evidence must validate the same way).
   *
   * Round 2 (R3) note: this is the CONTENT validation. The live
   * paths additionally require the establishment brand (checked
   * before this runs). Recovery deliberately does NOT require the
   * brand: it is a runtime property that serialization cannot
   * carry, so a restored record's trust rests on this content
   * validation plus the identity-digest binding, the derived-view
   * coherence (C2), and the per-entry content identities — a
   * persisted trail entry whose evidence was self-asserted before
   * persistence is indistinguishable from an established one
   * after the fact, which is one more reason the live path must
   * refuse self-assertion at issuance time.
   */
  private assertEvidenceAdmissible(
    q: StoredQuote,
    recorded: SubscriptionChangeReceipt,
    evidence: VerificationEvidence
  ): void {
    this.assertEvidenceShape(q, evidence);
    this.assertEvidenceRecomputation(q, recorded, evidence);
  }

  /** The shape / provenance / internal-consistency limb of admissibility. */
  private assertEvidenceShape(q: StoredQuote, evidence: VerificationEvidence): void {
    const quoteId = q.quote_id;
    if (
      !evidence ||
      typeof evidence !== "object" ||
      !evidence.committedEffect ||
      typeof evidence.committedEffect !== "object" ||
      !evidence.committedSource ||
      !evidence.stateVerification ||
      !evidence.reconciliation
    ) {
      throw new Error(
        `Verification refused: the transition requires independently established verification ` +
          `evidence (independently re-derived committed figures, their provenance, the post-commit ` +
          `state-verification result, and the reconciliation computed from them) — a caller-supplied ` +
          `verdict alone is not evidence and cannot promote a COMMITTED_UNVERIFIED record.`
      );
    }
    if (evidence.committedSource !== "provider_actual" && evidence.committedSource !== "defined_equal_exact") {
      throw new Error(
        `Verification refused: the evidence's committed-figure provenance is "${evidence.committedSource}" — ` +
          `estimate-derived or quote-shared sources (pre_mutation_estimate, revalidated_preview, ` +
          `unestablished) are not independent provenance and cannot verify a record.`
      );
    }
    const effectSource = evidence.committedEffect.provenance?.committedSource;
    if (effectSource !== undefined && effectSource !== evidence.committedSource) {
      throw new Error(
        `Verification refused: the evidence is internally inconsistent — its committed effect ` +
          `declares committedSource "${effectSource}" but the evidence presents "${evidence.committedSource}".`
      );
    }
  }

  /**
   * The recomputation limb of admissibility: the claimed outcome
   * must be the outcome the inputs actually compute — the store
   * recomputes the reconciliation from the recorded quoted
   * effect, the evidence's committed figures, and the quote's
   * acceptance envelope. (This is also a mutation detector for
   * caller-held tokens: a token whose figures or verdict were
   * altered after minting often no longer recomputes to its
   * claimed reconciliation; the minting-time content digest in
   * `assertTokenUnaltered` covers the alterations it cannot see.)
   */
  private assertEvidenceRecomputation(
    q: StoredQuote,
    recorded: SubscriptionChangeReceipt,
    evidence: VerificationEvidence
  ): void {
    const recomputed = reconcileCommittedEffect(
      recorded.quotedEffect,
      evidence.committedEffect,
      q.proposal.acceptanceEnvelope,
      q.proposal,
      // PR-16 (Finding 4): the recomputation applies the SAME
      // unit-comparability rule as every other comparison site —
      // a recomputation that ignored units would re-admit the
      // defect at this boundary. The compared side's unit context
      // is the recorded receipt's own resulting snapshot (the
      // state the committed figures were established from).
      {
        comparedBillingCurrency: recorded.resultingSnapshot?.billing?.currency,
        comparedBillingCadence: recorded.resultingSnapshot?.billing?.cadence,
      }
    );
    if (recomputed.status !== evidence.reconciliation.status) {
      throw new Error(
        `Verification refused: the evidence's claimed reconciliation (${evidence.reconciliation.status}) ` +
          `is inconsistent with the store's recomputation from the recorded quote, the evidence's ` +
          `committed figures, and the acceptance envelope (${recomputed.status}).`
      );
    }
  }

  /**
   * PR-17: the PROMOTION requirements, layered on admissibility —
   * the third question. The `verifyCommitReceipt` transition
   * additionally requires the presented evidence itself to carry
   * an established VERIFIED post-commit state and a DETERMINED
   * reconciliation: the transition is the single-shot promotion,
   * and a partial or state-unestablished token cannot perform it
   * (it remains recordable via `recordReceiptEvidence`, where it
   * contributes its established dimensions to the derived view
   * without promoting the record).
   */
  private assertEvidencePromotable(
    q: StoredQuote,
    recorded: SubscriptionChangeReceipt,
    evidence: VerificationEvidence
  ): void {
    // Check order preserves the pre-PR-17 refusal semantics: the
    // state and determined-reconciliation requirements are named
    // before the recomputation consistency check, exactly as the
    // single fused validator ordered them.
    this.assertEvidenceShape(q, evidence);
    if (evidence.stateVerification !== "VERIFIED") {
      throw new Error(
        `Verification refused: the post-commit state verification is ${evidence.stateVerification}; ` +
          `only an established VERIFIED state (§6.12) can support a verification transition.`
      );
    }
    if (evidence.reconciliation.status === "UNVERIFIED") {
      throw new Error(
        `Verification refused: a verification transition must carry a determined reconciliation ` +
          `(OK or VIOLATED), not UNVERIFIED.`
      );
    }
    this.assertEvidenceRecomputation(q, recorded, evidence);
  }

  /**
   * PR-17: the issuance checks shared by both evidence entry
   * points — the establishment brand (R3) and the token's quote
   * binding. `establishVerification` stamps every token it mints
   * with the quote and subscription it was minted for (a
   * module-private WeakMap, exactly as unforgeable as the brand
   * itself); a token minted for one quote presented against
   * another is refused here, before content validation. Tokens
   * adopted at recovery carry no runtime binding — recovery's
   * trust rests on content validation and coherence instead, as
   * with the brand (see the R3 note on `assertEvidenceAdmissible`).
   */
  private assertEvidenceIssuance(
    quoteId: string,
    q: StoredQuote,
    evidence: VerificationEvidence,
    presentedReceipt?: SubscriptionChangeReceipt
  ): void {
    if (!evidence || !establishedEvidenceTokens.has(evidence)) {
      throw new Error(
        `Verification refused: the presented evidence is not an established evidence token. Evidence is ` +
          `accepted only as minted by establishVerification from an independent provider observation; a ` +
          `caller-constructed evidence object is self-asserted, and self-asserted evidence cannot verify ` +
          `the record for quote ${quoteId}.`
      );
    }
    const binding = establishedTokenBindings.get(evidence);
    if (binding && (binding.quoteId !== quoteId || binding.subscriptionId !== q.subscription_id)) {
      throw new SCQError(
        "CONFLICTING_RECEIPT_IDENTITY",
        `Verification refused: the evidence token was established for quote ${binding.quoteId} / ` +
          `subscription ${binding.subscriptionId}, but it was presented for quote ${quoteId} / subscription ` +
          `${q.subscription_id}; evidence is bound to the quote and subscription it was established from.`,
        { quoteId }
      );
    }
    if (presentedReceipt && receiptIdentityDigest(presentedReceipt) !== q.commit_receipt_identity_digest) {
      throw new SCQError(
        "CONFLICTING_RECEIPT_IDENTITY",
        `Verification refused: the presented receipt's identity does not match the recorded identity ` +
          `for quote ${quoteId}; a verification under a conflicting identity cannot transition the original record.`,
        { quoteId, receiptId: presentedReceipt.receiptId }
      );
    }
  }

  /**
   * PR-17: the post-establishment alteration check. The token
   * object is caller-held and mutable; the brand proves issuance,
   * not content integrity. The digest stamped beside the binding
   * at minting detects ANY alteration after establishment —
   * figures, verdict, or reconciliation — including substitutions
   * the recomputation check cannot see (a figure change that
   * happens to recompute to the same reconciliation status, e.g.
   * under a no-envelope reconciliation). It runs AFTER content
   * validation in both entry points, so an alteration that the
   * older, more specific checks name (a replaced reconciliation,
   * a contradicted recomputation) is still refused under those
   * names; the digest is the backstop for everything else.
   */
  private assertTokenUnaltered(quoteId: string, evidence: VerificationEvidence): void {
    const binding = establishedTokenBindings.get(evidence);
    if (binding && binding.contentDigest !== canonical(evidence)) {
      throw new Error(
        `Verification refused: the evidence token's contents were altered after establishment — a minted ` +
          `token is evidence only as established; substituting different figures or a different verdict ` +
          `after minting is detected and refused for quote ${quoteId}.`
      );
    }
  }

  /**
   * PR-17: builds the append-only evidence entry for a validated
   * token: bound to the recorded identity digest, carrying its
   * content-derived evidence id, its per-dimension disposition
   * toward the recorded candidates, and any conflict it creates
   * against the trail-so-far's accepted actuals. The evidence is
   * deep-copied on ingress (and the store's copies are what every
   * later read returns): mutating the caller's token after
   * acceptance cannot rewrite recorded history.
   */
  private buildEvidenceEntry(
    q: StoredQuote,
    recorded: SubscriptionChangeReceipt,
    evidence: VerificationEvidence,
    at: string | undefined,
    trailSoFar: ReceiptEvidenceEntry[]
  ): ReceiptEvidenceEntry {
    const entry: ReceiptEvidenceEntry = {
      at: at ?? evidence.at ?? new Date().toISOString(),
      reconciliation: deepCopy(evidence.reconciliation),
      identityDigest: q.commit_receipt_identity_digest!,
      evidence: deepCopy(evidence),
    };
    // PR-17 review correction: carry the observed-state
    // identity stamped at minting (module-private binding) into
    // the entry, bound by its content-derived evidence id.
    const binding = establishedTokenBindings.get(evidence);
    if (binding?.observedStateDigest !== undefined) entry.observedStateDigest = binding.observedStateDigest;
    entry.evidenceId = evidenceEntryId(entry.identityDigest, entry.evidence, entry.observedStateDigest);
    const analysis = analyzeEvidenceTrail(recorded, [...trailSoFar, entry]);
    const mine = analysis.perEntry[analysis.perEntry.length - 1];
    entry.disposition = mine.disposition;
    if (Object.keys(mine.conflicts).length > 0) entry.conflicts = mine.conflicts;
    return entry;
  }

  /**
   * PR-17: THE DERIVED CURRENT VIEW — layer 3 of the receipt
   * model. Computed deterministically from the recorded receipt
   * (layer 1) and its evidence trail (layer 2); never an
   * independently asserted fact. With an empty trail the view IS
   * the recorded receipt. Otherwise:
   *
   *  - the displayed committed effect is the COMPOSED effect
   *    (established actuals with their establishing determinacy
   *    and provenance; unestablished dimensions keep the recorded
   *    candidates' figures and labels verbatim);
   *  - PROMOTION to COMMITTED_AND_VERIFIED requires ALL of: no
   *    unresolved evidence conflict; at least one accepted entry
   *    whose state verification is VERIFIED; a reconciliation
   *    — recomputed here from the recorded QUOTED effect, the
   *    composed actuals, and the envelope (never from the
   *    candidates as a baseline) — that is determined (OK, or
   *    VIOLATED: verified-with-violation); and CROSS-OBSERVATION
   *    COHERENCE (PR-17 review correction): the entries the
   *    promotion rests on (the accepted establishers, plus the
   *    VERIFIED entry when no establisher carries the verdict)
   *    share ONE observed-state identity — actuals established
   *    against one post-commit state and a verdict established
   *    against a different state never compose into a verified
   *    view. The promoted view's reconciliation is that
   *    recomputation.
   *  - a non-promoted view keeps outcome COMMITTED_UNVERIFIED
   *    and reports an UNVERIFIED reconciliation naming the
   *    blocker (the conflict, the still-undetermined dimensions,
   *    or the unestablished state, in that precedence).
   */
  private deriveCurrentView(
    q: StoredQuote,
    recorded: SubscriptionChangeReceipt,
    entries: ReceiptEvidenceEntry[]
  ): SubscriptionChangeReceipt {
    if (entries.length === 0) return deepCopy(recorded);
    const analysis = analyzeEvidenceTrail(recorded, entries);
    const recomputed = reconcileCommittedEffect(
      recorded.quotedEffect,
      analysis.composedEffect,
      q.proposal.acceptanceEnvelope,
      q.proposal,
      {
        comparedBillingCurrency: recorded.resultingSnapshot?.billing?.currency,
        comparedBillingCadence: recorded.resultingSnapshot?.billing?.cadence,
      }
    );
    let reconciliation: ReconciliationResult;
    let promoted = false;
    if (analysis.anyConflict) {
      reconciliation = {
        status: "UNVERIFIED",
        reason:
          `accepted evidence conflicts on ${analysis.conflictDimensions.join(", ")}: a later entry established ` +
          `different actuals than the accepted established actuals; the first-established actuals stand, the ` +
          `conflict is recorded on the trail for investigation, and the record is not verified while it stands`,
        undeterminedDimensions: [...analysis.conflictDimensions],
      };
    } else if (recomputed.status === "UNVERIFIED") {
      reconciliation = recomputed;
    } else if (!analysis.stateVerified) {
      reconciliation = {
        status: "UNVERIFIED",
        reason:
          `the financial actuals are established, but no accepted evidence establishes the post-commit state ` +
          `as VERIFIED (§6.12); the record remains COMMITTED_UNVERIFIED`,
        undeterminedDimensions: [],
      };
    } else if (!analysis.promotionCoherent) {
      reconciliation = {
        status: "UNVERIFIED",
        reason:
          `the accepted actuals and the VERIFIED post-commit state were established against different observed ` +
          `post-commit states (evidence entries ${analysis.promotionBasis.map((i) => i + 1).join(", ")} do not share ` +
          `one observed-state identity): no single coherent observation supports the composed figures together ` +
          `with the verified state, so the record remains COMMITTED_UNVERIFIED while the composition is incoherent`,
        undeterminedDimensions: [],
      };
    } else {
      reconciliation = recomputed;
      promoted = true;
    }
    return {
      ...deepCopy(recorded),
      status: promoted ? "COMMITTED" : "COMMITTED_UNVERIFIED",
      outcome: promoted ? "COMMITTED_AND_VERIFIED" : "COMMITTED_UNVERIFIED",
      committedEffect: analysis.composedEffect,
      reconciliation,
    };
  }

  /**
   * PR-17 (Issue #22, Finding 5): appends one established
   * evidence token to a recorded receipt's append-only evidence
   * record and returns the re-derived current view.
   *
   * This is the RECORDING path, deliberately separated from
   * promotion: admissibility (branded token, minted for THIS
   * quote/subscription, establishing provenance, internally
   * consistent, recomputation-consistent) is all that recording
   * requires. The entry is appended — with its disposition
   * toward the recorded candidates and any conflict it creates —
   * and the current view is re-derived: established dimensions
   * display their actuals, missing dimensions stay UNKNOWN, and
   * the record promotes only when the derivation's promotion
   * rule is met by the whole trail. Evidence establishing a
   * different actual than a recorded candidate is RECORDED
   * (F5b), as is evidence filling a candidate-less dimension
   * (F5a); neither is an identity conflict.
   *
   * Refusals: no recorded receipt; a receipt recorded already
   * verified (nothing to establish against — its trail must stay
   * empty for recovery coherence); unbranded or foreign-bound
   * tokens; a presented receipt under a conflicting identity;
   * non-establishing provenance; content that no longer
   * recomputes to its claimed reconciliation (post-minting
   * mutation); and evidence whose computed state verification is
   * MISMATCH — figures observed against a state that contradicts
   * the operation's intent (including a foreign subscription's
   * state, PR-16) are not attributable to this operation and
   * cannot be recorded as its actuals.
   *
   * Resubmitting the SAME evidence (same content-derived
   * evidence id) is idempotent: no duplicate is appended and the
   * current view is returned unchanged.
   */
  recordReceiptEvidence(
    quoteId: string,
    evidence: VerificationEvidence,
    presentedReceipt?: SubscriptionChangeReceipt,
    at?: string
  ): SubscriptionChangeReceipt {
    const q = this.quotes.get(quoteId);
    if (!q || !q.commit_receipt || !q.commit_receipt_recorded) {
      throw new Error(
        `Evidence recording refused: no receipt recorded for quote ${quoteId}; evidence appends to a ` +
          `recorded receipt, and verification can never create one — an attempt with no recorded receipt ` +
          `(INDETERMINATE / CONFIRMED_NON_EXECUTION) stays exactly as classified.`
      );
    }
    const recorded = q.commit_receipt_recorded;
    if (receiptIdentityFields(recorded).recordedOutcome !== "COMMITTED_UNVERIFIED") {
      throw new Error(
        `Evidence recording refused: the receipt for quote ${quoteId} was recorded already verified; ` +
          `there is no unverified record for evidence to establish against.`
      );
    }
    this.assertEvidenceIssuance(quoteId, q, evidence, presentedReceipt);
    this.assertEvidenceAdmissible(q, recorded, evidence);
    this.assertTokenUnaltered(quoteId, evidence);
    if (evidence.stateVerification === "MISMATCH") {
      throw new Error(
        `Evidence recording refused: the evidence's post-commit state verification is MISMATCH; figures ` +
          `observed against a state that contradicts the operation's intent are not attributable to this ` +
          `operation and cannot be recorded as its actuals.`
      );
    }
    const trail = q.commit_receipt_verifications ?? [];
    const entry = this.buildEvidenceEntry(q, recorded, evidence, at, trail);
    if (trail.some((e) => (e.evidenceId ?? evidenceEntryId(e.identityDigest, e.evidence, e.observedStateDigest)) === entry.evidenceId)) {
      // Idempotent resubmission of the same evidence: nothing is
      // appended, nothing is re-derived, the current view stands.
      return deepCopy(q.commit_receipt);
    }
    const nextTrail = [...trail, entry];
    q.commit_receipt_verifications = nextTrail;
    q.commit_receipt = this.deriveCurrentView(q, recorded, nextTrail);
    return deepCopy(q.commit_receipt);
  }

  /**
   * v0.6.2 (CORE-8 / findings-closure F4): the single permitted
   * verification transition — reshaped by PR #8 review correction
   * C1. A COMMITTED_UNVERIFIED record becomes verified EXACTLY
   * ONCE, and only on independently established
   * `VerificationEvidence` (see types.ts): a bare caller-supplied
   * verdict is refused, because a verdict is an assertion, not
   * evidence. The store validates the evidence against the
   * recorded receipt (identity-bound figures, independent
   * provenance, VERIFIED post-commit state, and a reconciliation
   * the store itself recomputes from the evidence's inputs)
   * before transitioning.
   *
   * Round 2 (R3) tightens "independently established" from a
   * content property to an issuance property: C1 validated the
   * evidence object's CONTENTS, and a caller could construct a
   * passing object from the receipt's own data (the old test 15.4
   * did exactly that). Now the evidence must additionally be a
   * token minted by `establishVerification` — computed FROM an
   * independent provider observation — and unbranded objects are
   * refused as self-asserted before content validation runs.
   *
   * PR-17 (Finding 5) re-founds the transition on the evidence
   * record: the presented token must be PROMOTABLE (admissible,
   * state VERIFIED, determined reconciliation — see
   * `assertEvidencePromotable`); it is then APPENDED to the
   * trail like any recorded evidence, and the transition's
   * result is the DERIVED current view over the whole trail. Two
   * consequences of the F5 corrections:
   *  - the evidence's figures need NOT equal the recorded
   *    candidates: a differing established actual transitions to
   *    verified-with-violation (or OK, if within the envelope
   *    against the QUOTE), never to an identity conflict (F5b);
   *  - the verified view displays the ESTABLISHING evidence's
   *    committed effect — its determinacy and provenance — not
   *    the recorded candidates' UNKNOWN / "unestablished" labels
   *    (F5c).
   * If the composed trail still does not promote (an earlier
   * entry's unresolved conflict, or the presented token is a
   * duplicate of already-recorded non-promoting evidence), the
   * transition is refused and NOTHING is appended — the
   * transition is atomic, exactly as before. Partial or
   * state-unestablished evidence belongs on the recording path
   * (`recordReceiptEvidence`).
   *
   * The transition remains identity-bound on presentation too:
   * if `presentedReceipt` is given, its identity digest must
   * equal the recorded digest (F4).
   */
  verifyCommitReceipt(
    quoteId: string,
    evidence: VerificationEvidence,
    presentedReceipt?: SubscriptionChangeReceipt,
    at?: string
  ): SubscriptionChangeReceipt {
    const q = this.quotes.get(quoteId);
    if (!q || !q.commit_receipt || !q.commit_receipt_recorded) {
      throw new Error(`Verification refused: no receipt recorded for quote ${quoteId}; nothing to verify.`);
    }
    // Round 2 (R3): the evidence must be an ESTABLISHED token —
    // minted by `establishVerification` from an independent
    // provider observation and carrying its brand. A
    // caller-constructed object is self-asserted evidence: round 1
    // accepted one built from the receipt's own figures, labeled
    // provider_actual, asserting state VERIFIED — nothing in it
    // established an independent observation. Unbranded evidence
    // is refused here, before any content validation, because
    // content checks alone cannot distinguish an assertion from
    // an observation. Branded tokens are STILL fully
    // content-validated below: the token object remains
    // caller-held after minting, so altered contents are refused
    // on recomputation grounds (see `assertEvidenceAdmissible`),
    // with the minting-time content digest as the backstop for
    // alterations recomputation cannot see (see
    // `assertTokenUnaltered`).
    this.assertEvidenceIssuance(quoteId, q, evidence, presentedReceipt);
    const currentOutcome =
      q.commit_receipt.outcome ??
      (q.commit_receipt.status === "COMMITTED_UNVERIFIED" ? "COMMITTED_UNVERIFIED" : "COMMITTED_AND_VERIFIED");
    if (currentOutcome !== "COMMITTED_UNVERIFIED") {
      throw new Error(
        `Verification refused: the receipt for quote ${quoteId} is ${currentOutcome}; only a ` +
          `COMMITTED_UNVERIFIED record can transition to verified, and only once.`
      );
    }
    const recorded = q.commit_receipt_recorded;
    this.assertEvidencePromotable(q, recorded, evidence);
    this.assertTokenUnaltered(quoteId, evidence);
    const trail = q.commit_receipt_verifications ?? [];
    const entry = this.buildEvidenceEntry(q, recorded, evidence, at, trail);
    const alreadyRecorded = trail.some(
      (e) => (e.evidenceId ?? evidenceEntryId(e.identityDigest, e.evidence, e.observedStateDigest)) === entry.evidenceId
    );
    const candidateTrail = alreadyRecorded ? trail : [...trail, entry];
    const derived = this.deriveCurrentView(q, recorded, candidateTrail);
    if (derived.outcome !== "COMMITTED_AND_VERIFIED") {
      throw new Error(
        `Verification refused: the evidence does not promote the record for quote ${quoteId} — the ` +
          `derived current view remains COMMITTED_UNVERIFIED (${derived.reconciliation.status}: ` +
          `${derived.reconciliation.status === "UNVERIFIED" ? derived.reconciliation.reason : "see derived view"}). ` +
          `Nothing was appended; record partial or blocked evidence via recordReceiptEvidence instead.`
      );
    }
    if (!alreadyRecorded) q.commit_receipt_verifications = candidateTrail;
    q.commit_receipt = derived;
    return deepCopy(q.commit_receipt);
  }

  /**
   * PR-17: re-derives a stored record's evidence-entry derived
   * fields (evidenceId, disposition, conflicts) and its current
   * view from the recorded receipt + trail, installing both.
   * Recovery paths use this after substituting verbatim-decoded
   * records (DurableQuoteStore's load path), so the adopted
   * in-memory state is exactly the state the coherence validation
   * approved — derived, never the persisted view as asserted.
   * Returns a copy of the installed current view.
   */
  adoptDerivedView(quoteId: string): SubscriptionChangeReceipt | undefined {
    const q = this.quotes.get(quoteId);
    if (!q || !q.commit_receipt_recorded) return undefined;
    const recorded = q.commit_receipt_recorded;
    const entries = q.commit_receipt_verifications ?? [];
    if (entries.length > 0) {
      const analysis = analyzeEvidenceTrail(recorded, entries);
      entries.forEach((entry, i) => {
        entry.evidenceId = evidenceEntryId(entry.identityDigest, entry.evidence, entry.observedStateDigest);
        entry.disposition = analysis.perEntry[i].disposition;
        if (Object.keys(analysis.perEntry[i].conflicts).length > 0) {
          entry.conflicts = analysis.perEntry[i].conflicts;
        } else {
          delete entry.conflicts;
        }
      });
      q.commit_receipt_verifications = entries;
    }
    q.commit_receipt = this.deriveCurrentView(q, recorded, entries);
    return deepCopy(q.commit_receipt);
  }

  /**
   * PR #8 review correction C2: the coherence validation behind
   * `restoreReceiptRecords` — see that method's comment for the
   * three legal record shapes. Throws on the first incoherence;
   * `raw` is adopted only if this returns normally for EVERY
   * record in the set.
   */
  private assertRestoredRecordCoherent(
    destination: StoredQuote,
    raw: {
      quote_id: string;
      recorded_receipt: SubscriptionChangeReceipt;
      current_receipt: SubscriptionChangeReceipt;
      identity_digest: string;
      verifications?: ReceiptEvidenceEntry[];
    }
  ): void {
    const recorded = raw.recorded_receipt;
    const current = raw.current_receipt;
    const trail = raw.verifications ?? [];
    const incoherent = (why: string): Error =>
      new Error(
        `Recovery refused: the persisted receipt record for quote ${raw.quote_id} is not coherent — ${why}. ` +
          `The whole set is rejected; nothing is adopted from an incoherent record.`
      );

    // Quote association (C2/C3): the record, its recorded receipt,
    // and its current view must all name THIS quote and the
    // destination quote's subscription.
    if (
      recorded.quoteId !== raw.quote_id ||
      current.quoteId !== raw.quote_id ||
      recorded.subscriptionRef !== destination.subscription_id ||
      current.subscriptionRef !== destination.subscription_id
    ) {
      throw incoherent(
        `quote association mismatch: the record is filed under quote ${raw.quote_id} ` +
          `(subscription ${destination.subscription_id}) but its receipts name quote ` +
          `${recorded.quoteId}/${current.quoteId} and subscription ` +
          `${recorded.subscriptionRef}/${current.subscriptionRef}`
      );
    }

    // The recorded snapshot must itself be a recordable initial
    // state: COMMITTED_UNVERIFIED pairs with an UNVERIFIED
    // reconciliation; a verified-at-record receipt pairs with a
    // determined one.
    const recordedOutcome = receiptIdentityFields(recorded).recordedOutcome;
    const recordedStatus = recorded.reconciliation?.status;
    if (recordedOutcome === "COMMITTED_UNVERIFIED" && recordedStatus !== "UNVERIFIED") {
      throw incoherent(
        `the recorded receipt claims COMMITTED_UNVERIFIED but its recorded reconciliation is ${recordedStatus}`
      );
    }
    if (recordedOutcome === "COMMITTED_AND_VERIFIED" && (recordedStatus === "UNVERIFIED" || recordedStatus == null)) {
      throw incoherent(
        `the recorded receipt claims a verified outcome but its recorded reconciliation is ${recordedStatus}`
      );
    }

    if (trail.length === 0) {
      // No evidence: the current view must BE the record. A
      // verified (or otherwise altered) current view with an
      // empty trail is a forged verification.
      if (!deepEqualCanonical(current, recorded)) {
        throw incoherent(
          `the current view differs from the recorded receipt but the verification trail is empty — ` +
            `a verified current view without a verification transition is a forgery`
        );
      }
      return;
    }

    // Evidence exists: only on a record that was recorded
    // COMMITTED_UNVERIFIED (a verified-at-record receipt admits
    // no trail). EVERY entry must be bound to this record's
    // identity, carry admissible evidence, and carry derived
    // fields that match its contents; entry identities must be
    // unique (a duplicated entry — identical, or one id over
    // different contents — is not a trail the live paths can
    // produce).
    if (recordedOutcome !== "COMMITTED_UNVERIFIED") {
      throw incoherent(`a verification trail exists on a record that was never COMMITTED_UNVERIFIED`);
    }
    // PR-17 re-review (degenerate-revision edge case): the two
    // observed-state digests the PRE-FIX minting rule produced
    // from a degenerate state revision of THIS subscription —
    // an empty version, and an absent version (the canonical
    // form drops undefined components). A stored entry carrying
    // either was minted from a revision that established no
    // state identity (or forged to look like one): its
    // coherence claim was never sound — EVERY degenerate-
    // revision observation of the subscription shared the value
    // — so the set is refused rather than deriving a promotion
    // from it. The current minting rule stamps no identity for
    // such observations at all, so no entry the live paths can
    // produce carries either value; a sound digest (a real
    // revision's) cannot collide with them short of a hash
    // break. (Digests minted pre-fix from whitespace-only or
    // non-string version components are not enumerable this
    // way; they remain stated fields, as all entry content is —
    // recovery's posture toward them is unchanged and they
    // cannot be minted anymore.)
    const degenerateStateDigests = new Set([
      createHash("sha256")
        .update(canonical({ subscriptionId: destination.subscription_id, version: "" }), "utf8")
        .digest("hex"),
      createHash("sha256")
        .update(canonical({ subscriptionId: destination.subscription_id }), "utf8")
        .digest("hex"),
    ]);
    const seenIds = new Set<string>();
    for (const entry of trail) {
      if (entry.observedStateDigest !== undefined && degenerateStateDigests.has(entry.observedStateDigest)) {
        throw incoherent(
          `the trail entry's observed-state identity is the digest of a degenerate state revision ` +
            `(an empty or absent version) for subscription ${destination.subscription_id} — an identity ` +
            `no established revision produces, shared by every degenerate-revision observation of the ` +
            `subscription; a promotion derived from it would rest on a coherence claim that was never sound`
        );
      }
      if (entry.identityDigest !== raw.identity_digest) {
        throw new SCQError(
          "CONFLICTING_RECEIPT_IDENTITY",
          `Recovery refused: the verification trail entry for quote ${raw.quote_id} is bound to a ` +
            `different receipt identity than the record it accompanies; the set is not adopted.`,
          { quoteId: raw.quote_id }
        );
      }
      try {
        this.assertEvidenceAdmissible(destination, recorded, entry.evidence);
      } catch (e) {
        throw incoherent(
          `the trail entry's verification evidence does not validate against the recorded receipt ` +
            `(${(e as Error).message})`
        );
      }
      if (!deepEqualCanonical(entry.reconciliation, entry.evidence.reconciliation)) {
        throw incoherent(`the trail entry's reconciliation differs from its own evidence's reconciliation`);
      }
      const derivedId = evidenceEntryId(entry.identityDigest, entry.evidence, entry.observedStateDigest);
      if (entry.evidenceId !== undefined && entry.evidenceId !== derivedId) {
        throw incoherent(
          `the trail entry's stated evidenceId does not match its contents — the entry has been altered`
        );
      }
      if (seenIds.has(derivedId)) {
        throw incoherent(`the verification trail records a duplicate evidence identity — entries must be unique`);
      }
      seenIds.add(derivedId);
    }
    // Only now — every entry's evidence shape-validated — is the
    // trail safe to analyze for the stated-field comparisons.
    const analysis = analyzeEvidenceTrail(recorded, trail as ReceiptEvidenceEntry[]);
    trail.forEach((entry, i) => {
      if (entry.disposition !== undefined && !deepEqualCanonical(entry.disposition, analysis.perEntry[i].disposition)) {
        throw incoherent(`the trail entry's stated disposition does not match its contents`);
      }
      const statedConflicts = entry.conflicts ?? {};
      if (!deepEqualCanonical(statedConflicts, analysis.perEntry[i].conflicts)) {
        throw incoherent(`the trail entry's stated conflicts do not match its contents`);
      }
    });

    // The current view must be the DERIVED view of the recorded
    // receipt + this trail — derivation is the coherence proof:
    // a persisted view that is not what the validated evidence
    // derives (a forged promotion, stale candidate labels over a
    // verified outcome, a view claiming more than the evidence
    // establishes) is refused, and the adopted in-memory view is
    // the derivation, not the persisted assertion.
    const derived = this.deriveCurrentView(destination, recorded, trail as ReceiptEvidenceEntry[]);
    if (deepEqualCanonical(current, derived)) return;
    // Legacy acceptance (PR-17 migration): a ONE-entry trail
    // persisted by pre-PR-17 code carries the old transition
    // shape — recorded committed effect under the verified
    // outcome — for an entry that was promotable under the old
    // rules. Accept the set; adoption installs the derived
    // (truthful) view in its place.
    if (trail.length === 1) {
      const entry = trail[0];
      const legacyCurrent = {
        ...recorded,
        status: "COMMITTED",
        outcome: "COMMITTED_AND_VERIFIED",
        reconciliation: entry.reconciliation,
      };
      if (
        entry.evidence.stateVerification === "VERIFIED" &&
        entry.evidence.reconciliation.status !== "UNVERIFIED" &&
        deepEqualCanonical(current, legacyCurrent)
      ) {
        return;
      }
    }
    throw incoherent(
      `the current view is not the derived view of the recorded receipt and its evidence trail — ` +
        `a current view is derived from validated evidence, never trusted as persisted`
    );
  }

  /**
   * v0.6.2 (CORE-8 / findings-closure F4): the persisted form of
   * every recorded receipt in this store — each record WITH its
   * recorded (immutable) receipt, its current view, its identity
   * digest, and its verification trail. This is the surface a
   * durability layer persists; `restoreReceiptRecords` is its
   * recovery counterpart.
   */
  serializeReceiptRecords(): string {
    const records = [];
    for (const q of this.quotes.values()) {
      if (!q.commit_receipt_recorded) continue;
      records.push({
        quote_id: q.quote_id,
        recorded_receipt: q.commit_receipt_recorded,
        current_receipt: q.commit_receipt,
        identity_digest: q.commit_receipt_identity_digest,
        verifications: q.commit_receipt_verifications ?? [],
      });
    }
    return JSON.stringify({ records });
  }

  /**
   * v0.6.2 (CORE-8 / findings-closure F4): recovery of persisted
   * receipt records (see `serializeReceiptRecords`). EVERY record's
   * identity digest is re-computed from its recorded fields and
   * compared BEFORE anything is adopted: a record whose fields no
   * longer match its digest — tampered or rewritten history — is
   * refused (CONFLICTING_RECEIPT_IDENTITY) and the whole set is
   * rejected, never partially adopted. Records attach to quotes
   * already present in this store (the durability layer restores
   * quote records first); an unknown quote id refuses the set the
   * same way.
   *
   * PR #8 review correction C2: digest re-verification alone is
   * NOT sufficient — each record is validated as a COHERENT UNIT
   * (current view + recorded snapshot + evidence trail + quote
   * association), because a forged record can carry a perfectly
   * valid digest over its recorded half while its current view
   * lies.
   *
   * PR-17 (Finding 5) re-founds the coherence proof on
   * DERIVATION, replacing C2's exactly-one-transition shapes:
   *   - the trail may hold ANY number of entries (partial,
   *     completing, and conflicting evidence are all recordable),
   *     but every entry must be bound to the record's identity
   *     digest, carry ADMISSIBLE evidence (content-validated,
   *     recomputation-consistent), carry derived fields
   *     (evidenceId, disposition, conflicts) matching its
   *     contents where stated, and have a unique evidence id;
   *   - the current view must EQUAL the view derived from the
   *     recorded receipt + validated trail — a persisted view is
   *     never trusted as asserted; adoption installs the
   *     derivation. One legacy shape is additionally accepted
   *     for one-entry trails persisted by pre-PR-17 code (the old
   *     transition view, recorded effect under a verified
   *     outcome, on a then-promotable entry) and is normalized to
   *     the derived view on adoption;
   *   - a verified-at-record receipt admits no trail; an
   *     unverified record with an empty trail must have
   *     current == recorded.
   * Anything else — a verified current view with no trail entry
   * (a forgery), a trail bound to a different identity, altered
   * evidence, a duplicate evidence identity, a current view the
   * evidence does not derive — refuses the WHOLE set.
   */
  restoreReceiptRecords(json: string): void {
    const data = JSON.parse(json) as {
      records?: Array<{
        quote_id: string;
        recorded_receipt: SubscriptionChangeReceipt;
        current_receipt: SubscriptionChangeReceipt;
        identity_digest: string;
        verifications?: ReceiptEvidenceEntry[];
      }>;
    };
    const records = data.records ?? [];
    // Validate the entire set before adopting any of it.
    for (const raw of records) {
      if (receiptIdentityDigest(raw.recorded_receipt) !== raw.identity_digest) {
        throw new SCQError(
          "CONFLICTING_RECEIPT_IDENTITY",
          `Recovery refused: the persisted receipt record for quote ${raw.quote_id} does not match its ` +
            `recorded identity digest — the persisted history has been altered and is not adopted.`,
          { quoteId: raw.quote_id }
        );
      }
      const destination = this.quotes.get(raw.quote_id);
      if (!destination) {
        throw new Error(
          `Recovery refused: persisted receipt record names quote ${raw.quote_id}, which is not present ` +
            `in this store; restore quote records before receipt records.`
        );
      }
      this.assertRestoredRecordCoherent(destination, raw);
    }
    for (const raw of records) {
      const q = this.quotes.get(raw.quote_id)!;
      q.commit_receipt_recorded = deepFreeze(deepCopy(raw.recorded_receipt));
      q.commit_receipt_identity_digest = raw.identity_digest;
      // PR-17: entries are adopted with their derived fields
      // filled in (legacy entries gain evidenceId / disposition /
      // conflicts deterministically), and the current view is
      // installed as the DERIVATION over the adopted record —
      // never as the persisted current_receipt assertion.
      q.commit_receipt_verifications = deepCopy(raw.verifications ?? []);
      q.status = "COMMITTED";
      this.adoptDerivedView(raw.quote_id);
    }
  }

  /** Marks any other ACTIVE quotes for the same subscription as SUPERSEDED. */
  supersedeOthersFor(subscriptionId: string, keepQuoteId: string): void {
    for (const q of this.quotes.values()) {
      if (q.subscription_id === subscriptionId && q.quote_id !== keepQuoteId && q.status === "ACTIVE") {
        q.status = "SUPERSEDED";
      }
    }
  }

  /** Defensive copies, like `get` (round 2, R2) — never the internal records. */
  all(): StoredQuote[] {
    return Array.from(this.quotes.values(), (q) => deepCopy(q));
  }
}

/**
 * PR #8 review correction, round 2 (R3): the brand on established
 * evidence tokens. `establishVerification` adds every token it
 * mints to this module-private WeakSet; `verifyCommitReceipt`
 * accepts only branded tokens. The set is unforgeable from outside
 * this module — a caller cannot brand a hand-built object — and
 * being a WeakSet it neither leaks into serialization nor keeps
 * tokens alive.
 */
const establishedEvidenceTokens = new WeakSet<object>();

/**
 * PR-17: the quote binding stamped on every minted token —
 * which quote and subscription the evidence was established
 * FOR, plus a digest of the token's contents as minted. Kept in
 * a module-private WeakMap beside the brand, so it is exactly as
 * unforgeable: a token minted for one quote presented against
 * another is refused at ingestion (`assertEvidenceIssuance`),
 * instead of relying on figure equality to catch the mismatch
 * (the F5-era proxy), and a token whose contents were altered
 * after minting — different figures, a different verdict — is
 * detected against the stamped digest and refused. Like the
 * brand, the binding is a runtime property and does not survive
 * serialization; recovery binds entries to their record by the
 * identity digest instead.
 */
const establishedTokenBindings = new WeakMap<
  object,
  { quoteId: string; subscriptionId: string; contentDigest: string; observedStateDigest?: string }
>();

/**
 * v0.6.2 (PR-9): the §6.12 state verification this module used to
 * compute with a private `observedStateVerification` now lives in
 * ONE shared provider-neutral core implementation —
 * `verifyPostCommitState` (core/state-verification.ts) — consumed
 * here by `establishVerification` (at ACTION_LEVEL coverage, the
 * historical semantics exactly) and directly by adapters that
 * perform their own post-commit establishment (at FULL_ITEM_SET
 * coverage where they derive the expected resulting set). There
 * is deliberately no second implementation left in this module:
 * one computation, one set of semantics, pinned by test15
 * (establishment, unchanged) and test31 (the shared hook).
 */

/**
 * v0.6.2 (PR #8 review correction, round 2 — R3): THE trusted
 * evidence path — the only way a `VerificationEvidence` token
 * comes into existence. It takes a quote and an INDEPENDENT
 * post-commit `ProviderObservation` (see types.ts), and COMPUTES
 * the evidence from the observation:
 *
 *   - association: the observation must name the quote's own
 *     subscription;
 *   - provenance: the observation's committed figures must carry
 *     an establishing committedSource ("provider_actual" /
 *     "defined_equal_exact") — an observation whose figures are
 *     a revalidated preview, a pre-mutation estimate, or
 *     unestablished is refused, as is an observation that IS the
 *     quote's own quoted effect (the estimate itself, relabeled);
 *   - state verification: computed by the shared core hook
 *     `verifyPostCommitState` from the observation's resulting
 *     snapshot against the proposal's intent (ACTION_LEVEL
 *     coverage — the establishment contract's historical
 *     semantics) — the caller never asserts it;
 *   - reconciliation: computed by `reconcileCommittedEffect` from
 *     the quote, the observation's figures, and the envelope —
 *     never asserted either.
 *
 * The minted token is branded (module-private WeakSet);
 * `verifyCommitReceipt` refuses unbranded objects and then
 * re-validates the token's contents against the recorded receipt
 * (the token object remains caller-held, so its contents are
 * never trusted merely for carrying the brand).
 *
 * WHAT "TRUSTED" MEANS HERE — AND ITS LIMIT, stated plainly: the
 * brand guarantees the evidence passed through this establishment
 * computation over a caller-supplied observation, with the
 * provenance, state, and reconciliation results computed rather
 * than asserted. It CANNOT prove the observation truly came from
 * a provider: nothing in this module can distinguish a genuine
 * provider read from a fabricated observation object with
 * establishing labels. Binding observations to real provider
 * reads is the adapters' duty in the PR-3..PR-7 migrations, where
 * the observation is constructed inside the adapter from its own
 * provider call and never crosses a caller boundary. Until then
 * this path removes SELF-ASSERTED evidence (the round-1 defect);
 * it does not — and does not claim to — authenticate the provider
 * channel.
 */
export function establishVerification(quote: StoredQuote, observation: ProviderObservation): VerificationEvidence {
  if (!observation || observation.subscriptionRef !== quote.subscription_id) {
    throw new Error(
      `Establishment refused: the observation names subscription ${observation?.subscriptionRef}, but quote ` +
        `${quote.quote_id} is for subscription ${quote.subscription_id}; an observation of one subscription ` +
        `cannot establish verification for another.`
    );
  }
  if (observation.committedEffect === quote.quoted_effect) {
    throw new Error(
      `Establishment refused: the observation's committed figures ARE the quote's own quoted effect — the ` +
        `estimate itself, relabeled. Verification is established from an independent post-commit provider ` +
        `read, never from quote-side figures.`
    );
  }
  const source = observation.committedEffect?.provenance?.committedSource;
  if (source !== "provider_actual" && source !== "defined_equal_exact") {
    throw new Error(
      `Establishment refused: the observation's committed figures carry committedSource ` +
        `${source === undefined ? "(absent — unestablished)" : JSON.stringify(source)}; only "provider_actual" / ` +
        `"defined_equal_exact" figures establish committed actuals. Revalidated previews and pre-mutation ` +
        `estimates are quote-side data — the lineage the v0.6.2 migration eliminates — and can never ` +
        `establish a verification.`
    );
  }
  const token: VerificationEvidence = {
    committedEffect: deepCopy(observation.committedEffect),
    committedSource: source,
    stateVerification: verifyPostCommitState(
      // PR-16 (Finding 3): the expectation carries the quote's
      // bound subscription, so an observation whose resulting
      // snapshot names a DIFFERENT subscription computes MISMATCH
      // here — the subscriptionRef check above binds the
      // observation's CLAIM, this binds the observed STATE to the
      // same subscription.
      { proposal: quote.proposal, expectedSubscriptionRef: quote.subscription_id },
      {
        snapshot: observation.resultingSnapshot,
        source: observation.source,
        ...(observation.observedAt ? { observedAt: observation.observedAt } : {}),
      }
    ).verdict,
    reconciliation: reconcileCommittedEffect(
      quote.quoted_effect,
      observation.committedEffect,
      quote.proposal.acceptanceEnvelope,
      quote.proposal,
      // PR-16 (Finding 4): the observation's own snapshot
      // denominates its committed figures.
      {
        comparedBillingCurrency: observation.resultingSnapshot?.billing?.currency,
        comparedBillingCadence: observation.resultingSnapshot?.billing?.cadence,
      }
    ),
    ...(observation.observedAt ? { at: observation.observedAt } : {}),
  };
  establishedEvidenceTokens.add(token);
  const observedStateDigest = observedStateDigestOf(observation.resultingSnapshot);
  establishedTokenBindings.set(token, {
    quoteId: quote.quote_id,
    subscriptionId: quote.subscription_id,
    contentDigest: canonical(token),
    // PR-17 review correction: the identity of the state THIS
    // observation read — stamped beside the binding so the
    // evidence entry built from this token can carry it into
    // the trail, where the promotion rule's cross-observation
    // coherence check compares it across entries. (An
    // observation with no resulting snapshot — or a degenerate
    // subscription id / state revision on it — stamps nothing:
    // no observed-state identity was established.)
    ...(observedStateDigest !== undefined ? { observedStateDigest } : {}),
  });
  return token;
}

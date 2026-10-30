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

import { SCQError, type CommercialEffect, type GuaranteeCoverage, type GuaranteeMode, type MultiChangeConsistency, type MutationOutcome, type ProviderObservation, type ReconciliationResult, type SubscriptionChangeProposal, type SubscriptionChangeReceipt, type VerificationEvidence } from "../core/types.js";
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
   * v0.6.2 (CORE-8 / F4): the verification append-trail — one entry
   * per verification transition applied to this record (at most one
   * can ever succeed). Recording a verification APPENDS here; it
   * never rewrites the recorded receipt or its digest.
   */
  commit_receipt_verifications?: Array<{
    at: string;
    reconciliation: ReconciliationResult;
    /**
     * PR #8 review correction C1/C2: the recorded identity digest
     * this transition was bound to, and the evidence it was granted
     * on. Recovery validates the trail as part of the record's
     * coherence: a verified current view is coherent ONLY with
     * exactly one trail entry, bound to the same identity, whose
     * evidence itself validates against the recorded receipt.
     */
    identityDigest: string;
    evidence: VerificationEvidence;
  }>;
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
   * PR #8 review correction C1: validates VerificationEvidence
   * against a recorded receipt and its quote. Shared by
   * `verifyCommitReceipt` (the live transition) and
   * `restoreReceiptRecords` (recovery coherence: a persisted
   * trail entry's evidence must validate the same way). Throws on
   * the first failed requirement; returns nothing on success.
   *
   * Round 2 (R3) note: this is the CONTENT validation. The live
   * transition additionally requires the establishment brand
   * (checked in `verifyCommitReceipt` before this runs). Recovery
   * deliberately does NOT require the brand: it is a runtime
   * property that serialization cannot carry, so a restored
   * record's trust rests on this content validation plus the
   * identity-digest binding and whole-set coherence (C2) — a
   * persisted trail entry whose evidence was self-asserted before
   * persistence is indistinguishable from an established one
   * after the fact, which is one more reason the live path must
   * refuse self-assertion at issuance time.
   */
  private assertEvidenceValid(
    q: StoredQuote,
    recorded: SubscriptionChangeReceipt,
    evidence: VerificationEvidence
  ): void {
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
    // The evidence's figures must be the figures ON THE RECORD:
    // the recorded actuals are what is being verified. (Where the
    // honest outcome is VIOLATED, the actuals differ from the
    // QUOTE — the reconciliation says so — never from the record
    // of themselves.)
    const recordedFields = receiptIdentityFields(recorded);
    const evidenceImmediate = evidence.committedEffect.immediate?.net ?? null;
    const evidenceRecurring = evidence.committedEffect.recurring?.resultingAmount ?? null;
    if (evidenceImmediate !== recordedFields.immediateNet || evidenceRecurring !== recordedFields.recurringAmount) {
      throw new SCQError(
        "CONFLICTING_RECEIPT_IDENTITY",
        `Verification refused: the evidence's committed figures (immediate.net=${evidenceImmediate}, ` +
          `recurring.resultingAmount=${evidenceRecurring}) contradict the figures recorded on the ` +
          `receipt for quote ${quoteId} (immediate.net=${recordedFields.immediateNet}, ` +
          `recurring.resultingAmount=${recordedFields.recurringAmount}); evidence about different ` +
          `figures cannot verify this record.`,
        { quoteId, receiptId: recorded.receiptId }
      );
    }
    // The claimed outcome must be the outcome the inputs actually
    // compute: the store recomputes the reconciliation from the
    // recorded quoted effect, the evidence's committed figures,
    // and the quote's acceptance envelope.
    const recomputed = reconcileCommittedEffect(
      recorded.quotedEffect,
      evidence.committedEffect,
      q.proposal.acceptanceEnvelope,
      q.proposal
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
   * On success the record's CURRENT view advances to
   * status "COMMITTED" / outcome COMMITTED_AND_VERIFIED carrying
   * the evidence's determined reconciliation — OK (verified
   * within envelope) or VIOLATED (verified-with-violation:
   * established actuals outside the envelope, never OK) — and
   * the verification, bound to the record's identity digest and
   * carrying the evidence, is appended to the record's trail.
   * The recorded receipt, its identity fields, and its digest
   * are NEVER rewritten by the transition.
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
    // content-validated below (assertEvidenceValid): the token
    // object remains caller-held after minting, so altered
    // contents are refused on recomputation/identity grounds.
    if (!evidence || !establishedEvidenceTokens.has(evidence)) {
      throw new Error(
        `Verification refused: the presented evidence is not an established evidence token. Evidence is ` +
          `accepted only as minted by establishVerification from an independent provider observation; a ` +
          `caller-constructed evidence object is self-asserted, and self-asserted evidence cannot verify ` +
          `the record for quote ${quoteId}.`
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
    const currentOutcome =
      q.commit_receipt.outcome ??
      (q.commit_receipt.status === "COMMITTED_UNVERIFIED" ? "COMMITTED_UNVERIFIED" : "COMMITTED_AND_VERIFIED");
    if (currentOutcome !== "COMMITTED_UNVERIFIED") {
      throw new Error(
        `Verification refused: the receipt for quote ${quoteId} is ${currentOutcome}; only a ` +
          `COMMITTED_UNVERIFIED record can transition to verified, and only once.`
      );
    }
    this.assertEvidenceValid(q, q.commit_receipt_recorded, evidence);
    q.commit_receipt = {
      ...deepCopy(q.commit_receipt_recorded),
      status: "COMMITTED",
      outcome: "COMMITTED_AND_VERIFIED",
      reconciliation: deepCopy(evidence.reconciliation),
    };
    (q.commit_receipt_verifications ??= []).push({
      at: at ?? evidence.at ?? new Date().toISOString(),
      reconciliation: deepCopy(evidence.reconciliation),
      identityDigest: q.commit_receipt_identity_digest!,
      evidence: deepCopy(evidence),
    });
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
      verifications?: Array<{
        at: string;
        reconciliation: ReconciliationResult;
        identityDigest: string;
        evidence: VerificationEvidence;
      }>;
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
      // No transition: the current view must BE the record. A
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

    // A transition exists: exactly one, only from an UNVERIFIED
    // record, bound to this identity, carrying evidence that
    // validates against the record, and the current view must be
    // exactly that transition's result.
    if (recordedOutcome !== "COMMITTED_UNVERIFIED") {
      throw incoherent(`a verification trail exists on a record that was never COMMITTED_UNVERIFIED`);
    }
    if (trail.length !== 1) {
      throw incoherent(
        `the verification trail records ${trail.length} transitions; a receipt record admits exactly one`
      );
    }
    const entry = trail[0];
    if (entry.identityDigest !== raw.identity_digest) {
      throw new SCQError(
        "CONFLICTING_RECEIPT_IDENTITY",
        `Recovery refused: the verification trail entry for quote ${raw.quote_id} is bound to a ` +
          `different receipt identity than the record it accompanies; the set is not adopted.`,
        { quoteId: raw.quote_id }
      );
    }
    try {
      this.assertEvidenceValid(destination, recorded, entry.evidence);
    } catch (e) {
      throw incoherent(
        `the trail entry's verification evidence does not validate against the recorded receipt ` +
          `(${(e as Error).message})`
      );
    }
    if (!deepEqualCanonical(entry.reconciliation, entry.evidence.reconciliation)) {
      throw incoherent(`the trail entry's reconciliation differs from its own evidence's reconciliation`);
    }
    const expectedCurrent = {
      ...recorded,
      status: "COMMITTED",
      outcome: "COMMITTED_AND_VERIFIED",
      reconciliation: entry.reconciliation,
    };
    if (!deepEqualCanonical(current, expectedCurrent)) {
      throw incoherent(
        `the current view is not the legal verification transition of the recorded receipt ` +
          `(recorded UNVERIFIED + exactly one identity-bound verification)`
      );
    }
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
   * (current view + recorded snapshot + verification trail +
   * quote association + legal state transitions), because a
   * forged record can carry a perfectly valid digest over its
   * recorded half while its current view lies. The legal shapes
   * are exactly:
   *   - recorded verified-at-record (OK/VIOLATED reconciliation),
   *     current view identical to the record, trail empty — no
   *     transition exists or is possible;
   *   - recorded COMMITTED_UNVERIFIED, current view identical to
   *     the record, trail empty — recorded, not yet verified;
   *   - recorded COMMITTED_UNVERIFIED, current view equal to the
   *     ONE legal transition of the record, and a trail of
   *     EXACTLY ONE entry, bound to the record's identity digest,
   *     whose evidence validates against the record (C1 rules)
   *     and whose reconciliation is the current view's.
   * Anything else — a verified current view with no trail entry
   * (a forgery), two trail entries, a trail bound to a different
   * identity, a current view that is neither the record nor its
   * legal transition — refuses the WHOLE set.
   */
  restoreReceiptRecords(json: string): void {
    const data = JSON.parse(json) as {
      records?: Array<{
        quote_id: string;
        recorded_receipt: SubscriptionChangeReceipt;
        current_receipt: SubscriptionChangeReceipt;
        identity_digest: string;
        verifications?: Array<{
          at: string;
          reconciliation: ReconciliationResult;
          identityDigest: string;
          evidence: VerificationEvidence;
        }>;
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
      q.commit_receipt = deepCopy(raw.current_receipt);
      q.commit_receipt_identity_digest = raw.identity_digest;
      q.commit_receipt_verifications = deepCopy(raw.verifications ?? []);
      q.status = "COMMITTED";
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
      { proposal: quote.proposal },
      {
        snapshot: observation.resultingSnapshot,
        source: observation.source,
        ...(observation.observedAt ? { observedAt: observation.observedAt } : {}),
      }
    ).verdict,
    reconciliation: reconcileCommittedEffect(quote.quoted_effect, observation.committedEffect, quote.proposal.acceptanceEnvelope, quote.proposal),
    ...(observation.observedAt ? { at: observation.observedAt } : {}),
  };
  establishedEvidenceTokens.add(token);
  return token;
}

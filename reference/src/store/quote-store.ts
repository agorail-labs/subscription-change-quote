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

import { SCQError, type CommercialEffect, type GuaranteeCoverage, type GuaranteeMode, type MultiChangeConsistency, type MutationOutcome, type ReconciliationResult, type SubscriptionChangeProposal, type SubscriptionChangeReceipt } from "../core/types.js";

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

function deepCopy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
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
  commit_receipt_verifications?: Array<{ at: string; reconciliation: ReconciliationResult }>;
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

  put(quote: StoredQuote): void {
    this.quotes.set(quote.quote_id, quote);
  }

  get(quoteId: string): StoredQuote | undefined {
    return this.quotes.get(quoteId);
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
   * Returns the stored (current-view) receipt, or `undefined` when
   * no such quote exists (the historical no-op for unknown quotes).
   */
  recordCommitReceipt(quoteId: string, receipt: SubscriptionChangeReceipt): SubscriptionChangeReceipt | undefined {
    const q = this.quotes.get(quoteId);
    if (!q) return undefined;
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
        return q.commit_receipt;
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

    q.commit_receipt_recorded = deepCopy(receipt);
    q.commit_receipt_identity_digest = digest;
    q.commit_receipt = receipt;
    q.status = "COMMITTED";
    return q.commit_receipt;
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
        out.push(q.commit_receipt);
      }
    }
    return out;
  }

  /**
   * v0.6.2 (CORE-8 / findings-closure F4): the single permitted
   * verification transition. A COMMITTED_UNVERIFIED record, its
   * figures re-derived from provider actuals, becomes verified
   * EXACTLY ONCE: the record's CURRENT view advances to
   * status "COMMITTED" / outcome COMMITTED_AND_VERIFIED carrying
   * the determined reconciliation, and the verification is appended
   * to the record's trail. The recorded receipt, its identity
   * fields, and its digest are NEVER rewritten by the transition.
   *
   * The transition is identity-bound: if `presentedReceipt` is
   * given, its identity digest must equal the recorded digest —
   * a verification presented under a conflicting identity is
   * refused (CONFLICTING_RECEIPT_IDENTITY) and transitions nothing.
   * The verified reconciliation must be determined (OK or
   * VIOLATED); an UNVERIFIED "verification" is refused.
   */
  verifyCommitReceipt(
    quoteId: string,
    verifiedReconciliation: ReconciliationResult,
    presentedReceipt?: SubscriptionChangeReceipt,
    at?: string
  ): SubscriptionChangeReceipt {
    const q = this.quotes.get(quoteId);
    if (!q || !q.commit_receipt || !q.commit_receipt_recorded) {
      throw new Error(`Verification refused: no receipt recorded for quote ${quoteId}; nothing to verify.`);
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
    if (verifiedReconciliation.status === "UNVERIFIED") {
      throw new Error(
        `Verification refused: a verification transition must carry a determined reconciliation ` +
          `(OK or VIOLATED), not UNVERIFIED.`
      );
    }
    q.commit_receipt = {
      ...deepCopy(q.commit_receipt_recorded),
      status: "COMMITTED",
      outcome: "COMMITTED_AND_VERIFIED",
      reconciliation: verifiedReconciliation,
    };
    (q.commit_receipt_verifications ??= []).push({
      at: at ?? new Date().toISOString(),
      reconciliation: verifiedReconciliation,
    });
    return q.commit_receipt;
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
   */
  restoreReceiptRecords(json: string): void {
    const data = JSON.parse(json) as {
      records?: Array<{
        quote_id: string;
        recorded_receipt: SubscriptionChangeReceipt;
        current_receipt: SubscriptionChangeReceipt;
        identity_digest: string;
        verifications?: Array<{ at: string; reconciliation: ReconciliationResult }>;
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
      if (!this.quotes.has(raw.quote_id)) {
        throw new Error(
          `Recovery refused: persisted receipt record names quote ${raw.quote_id}, which is not present ` +
            `in this store; restore quote records before receipt records.`
        );
      }
    }
    for (const raw of records) {
      const q = this.quotes.get(raw.quote_id)!;
      q.commit_receipt_recorded = deepCopy(raw.recorded_receipt);
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

  all(): StoredQuote[] {
    return Array.from(this.quotes.values());
  }
}

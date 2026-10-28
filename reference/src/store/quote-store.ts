// In-memory quote store, keyed by quote_id.
//
// This is intentionally a dumb bag of records — no provider logic lives here.
// It exists so both adapters share the exact same STALE/EXPIRED bookkeeping
// instead of re-implementing it per provider.

import type { CommercialEffect, GuaranteeCoverage, GuaranteeMode, MultiChangeConsistency, SubscriptionChangeProposal, SubscriptionChangeReceipt } from "../core/types.js";

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
   */
  commit_receipt?: SubscriptionChangeReceipt;
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
   */
  recordCommitReceipt(quoteId: string, receipt: SubscriptionChangeReceipt): void {
    const q = this.quotes.get(quoteId);
    if (!q) return;
    q.status = "COMMITTED";
    q.commit_receipt = receipt;
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

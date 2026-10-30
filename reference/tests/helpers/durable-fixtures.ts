// Shared fixtures for the PR-8 durable-store suites and their child
// processes. Plain data only — no test registration in this file.
import type { ProviderObservation, SubscriptionChangeReceipt } from "../../src/core/types.js";
import type { StoredQuote } from "../../src/store/quote-store.js";

export function makeStoredQuote(quoteId: string, subscriptionId = "sub_1"): StoredQuote {
  return {
    quote_id: quoteId,
    provider: "chargebee",
    subscription_id: subscriptionId,
    subscription_version_at_quote: "v1",
    proposal: {
      changes: [{ action: "CHANGE_QUANTITY", itemId: "item_1", quantity: 2 }],
      effectiveIntent: { type: "IMMEDIATE" },
    } as StoredQuote["proposal"],
    effective_guarantee_mode: "REVALIDATE",
    guarantee_coverage: {
      immediateFinancialEffect: "REVALIDATE",
      recurringFinancialEffect: "REVALIDATE",
      termEffect: "UNKNOWN",
      effectiveAt: "REVALIDATE",
    },
    multi_change_consistency: "BEST_EFFORT",
    provider_preview_input: { items: [{ itemPriceId: "item_1", quantity: 2 }], idempotencyKey: `scq-${quoteId}` },
    quoted_effect: { immediate: { net: 1000 }, recurring: { resultingAmount: 5000, currency: "usd" } },
    created_at: "2026-10-29T00:00:00.000Z",
    expires_at: "2026-10-29T01:00:00.000Z",
    status: "ACTIVE",
  };
}

export function makeReceipt(quoteId = "q1", subscriptionId = "sub_1", overrides: Partial<SubscriptionChangeReceipt> = {}): SubscriptionChangeReceipt {
  return {
    receiptId: `rcpt-${quoteId}`,
    quoteId,
    subscriptionRef: subscriptionId,
    status: "COMMITTED",
    outcome: "COMMITTED_AND_VERIFIED",
    resultingSnapshot: { id: subscriptionId, version: "v2", status: "active", items: [], billing: { currency: "usd" } },
    quotedEffect: { immediate: { net: 1000 }, recurring: { resultingAmount: 5000, currency: "usd" } },
    committedEffect: {
      immediate: { charge: 1000, credit: undefined, net: 1000 },
      recurring: { resultingAmount: 5000, currency: "usd" },
      provenance: { committedSource: "provider_actual" },
    },
    guaranteeMode: "REVALIDATE",
    consistencyGuarantee: "BEST_EFFORT",
    multiChangeConsistency: "BEST_EFFORT",
    reconciliation: { status: "OK" },
    committedAt: "2026-10-29T00:05:00.000Z",
    ...overrides,
  } as SubscriptionChangeReceipt;
}

export function makeUnverifiedReceipt(quoteId = "q1", subscriptionId = "sub_1"): SubscriptionChangeReceipt {
  return makeReceipt(quoteId, subscriptionId, {
    status: "COMMITTED_UNVERIFIED",
    outcome: "COMMITTED_UNVERIFIED",
    reconciliation: {
      status: "UNVERIFIED",
      reason: "committed figures could not be established from provider actuals",
      undeterminedDimensions: ["immediateFinancialEffect"],
    },
  });
}

export function makeObservation(quoteId = "q1", subscriptionId = "sub_1"): ProviderObservation {
  return {
    subscriptionRef: subscriptionId,
    source: "test fixture: simulated post-commit provider read",
    observedAt: "2026-10-29T00:06:00.000Z",
    committedEffect: {
      immediate: { net: 1000 },
      recurring: { resultingAmount: 5000, currency: "usd" },
      // PR-10 (BC-1) fixture completion: this simulated provider read
      // DETERMINES both dimensions — both figures are literal values
      // from the read and the source is provider_actual — so the
      // determinacy record says so. Without it, BC-1 reconciliation
      // correctly reads the figures as UNKNOWN and establishment
      // computes UNVERIFIED; the durable suites' subject is store
      // recovery, not legacy-effect reconciliation (covered in
      // test35). No assertion in the consuming suites changes.
      determinacy: { immediateFinancialEffect: "DETERMINED", recurringFinancialEffect: "DETERMINED" },
      provenance: { committedSource: "provider_actual" },
    },
    resultingSnapshot: {
      id: subscriptionId,
      version: "v2",
      status: "active",
      items: [{ id: "item_1", offeringRef: "plan", quantity: 2 }],
      billing: { currency: "usd" },
    },
  };
}

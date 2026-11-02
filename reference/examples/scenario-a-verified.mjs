/**
 * SCQ quick start — Scenario A: a successful, authorized change.
 *
 * SIMULATOR ONLY. ChargebeeSim is an in-memory, provider-shaped model;
 * this file makes no real billing API call and is not a production
 * integration. Amounts are minor units (for USD, cents).
 *
 * Flow: seed a simulated subscription -> create a quote -> inspect the
 * proposed commercial effect, its determinacy, and the guarantee
 * coverage -> apply a separate (example) approval policy -> commit
 * once -> read the receipt and its reconciliation result.
 *
 * Expected outcome: receipt COMMITTED_AND_VERIFIED, reconciliation OK.
 */
import { ChargebeeAdapter, ChargebeeSim, QuoteStore } from "@agorail-labs/scq-reference";

const START = new Date("2026-08-01T00:00:00.000Z");

const sim = new ChargebeeSim(new Date(START));
const subscription = {
  id: "cb_quickstart_a",
  status: "active",
  subscriptionItems: [{ id: "item_1", itemPriceId: "ip_seat_basic_monthly", quantity: 100 }],
  currentTermStart: "2026-08-01T00:00:00.000Z",
  currentTermEnd: "2026-08-31T00:00:00.000Z",
  nextBillingAt: "2026-08-31T00:00:00.000Z",
};
sim.seedSubscription(structuredClone(subscription));

const adapter = new ChargebeeAdapter(sim, new QuoteStore());

// 1-2. Create a quote: seats 100 -> 120, effective immediately.
const quote = await adapter.createChangeQuote(subscription.id, {
  changes: [{ action: "CHANGE_QUANTITY", itemId: "item_1", quantity: 120 }],
  effectiveIntent: { type: "IMMEDIATE" },
  guaranteeMode: "REVALIDATE",
  // The acceptance envelope bounds quote-relative DRIFT between the
  // quote and the refreshed preview at commit time. It is NOT a total
  // spending cap and NOT an authorization grant (see step 5).
  acceptanceEnvelope: {
    maxImmediateNetIncrease: 0,
    maxImmediateCreditDecrease: 0,
    maxRecurringIncrease: 0,
  },
});

// 3-4. Inspect the proposed commercial effect and its determinacy.
// A dimension is DETERMINED only when its value is established with
// provenance; UNKNOWN means "no established value" — it is never a
// synonym for zero.
console.log("Quote:", quote.id);
console.log("Guarantee mode:", quote.guaranteeMode);
console.log("Proposed immediate net (minor units):", quote.commercialEffect.immediate?.net);
console.log("Proposed recurring amount (minor units):", quote.commercialEffect.recurring?.resultingAmount);
console.log("Currency:", quote.commercialEffect.recurring?.currency);
console.log("Determinacy:", JSON.stringify(quote.commercialEffect.determinacy));

// 5. Inspect guarantee coverage, then apply a SEPARATE approval
// policy. SCQ's envelope is drift tolerance; whether this change is
// authorized at all is a business decision the integrator must make
// (identity, approval, absolute budget, entitlements). This example
// stands in for that decision with explicit absolute caps.
console.log("Guarantee coverage:", JSON.stringify(quote.guaranteeCoverage));
console.log("Adapter consistency guarantee:", adapter.getCapabilities().consistencyGuarantee);

const approvalPolicy = { maxImmediateNetMinor: 25_000, maxResultingRecurringMinor: 125_000 };
const immediateNet = quote.commercialEffect.immediate?.net;
const resultingRecurring = quote.commercialEffect.recurring?.resultingAmount;
if (
  quote.commercialEffect.determinacy?.immediateFinancialEffect !== "DETERMINED" ||
  immediateNet === undefined ||
  resultingRecurring === undefined ||
  immediateNet > approvalPolicy.maxImmediateNetMinor ||
  resultingRecurring > approvalPolicy.maxResultingRecurringMinor
) {
  console.log("NOT APPROVED by the example policy — no commit performed.");
  process.exit(1);
}
console.log("Approved under the example policy (absolute caps, separate from the SCQ envelope).");

// 6-7. Commit exactly once.
const receipt = await adapter.commitChangeQuote(quote.id);

// 8. Read the receipt and the reconciliation result. VERIFIED/OK means
// the committed effect was established from operation-bound evidence
// and agrees with the authorized quote — it is the only outcome that
// should be treated as a clean success.
console.log("Receipt status:", receipt.status, "| outcome:", receipt.outcome);
console.log("Reconciliation:", receipt.reconciliation.status);
console.log("Committed immediate net (minor units):", receipt.committedEffect?.immediate?.net);
console.log("Committed determinacy:", JSON.stringify(receipt.committedEffect?.determinacy));
console.log("Resulting quantity:", receipt.resultingSnapshot?.items?.[0]?.quantity);

if (receipt.reconciliation.status !== "OK") {
  console.error("Unexpected outcome for scenario A: expected reconciliation OK.");
  process.exit(1);
}
console.log("Scenario A complete: COMMITTED_AND_VERIFIED / OK.");

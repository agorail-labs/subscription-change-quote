/**
 * SCQ consumer example: subscription seat expansion.
 *
 * Runs against the published @agorail-labs/scq-reference package.
 * SIMULATOR ONLY: ChargebeeSim is an in-memory, provider-shaped
 * model. This file makes no real billing API call and is not a
 * production integration. Amounts are minor units (for USD, cents).
 *
 * Flow: seed a simulated subscription -> create a quote for seats
 * 100 -> 120 -> inspect the quoted financial change and its
 * determinacy -> evaluate acceptance under a SEPARATE approval
 * policy -> commit once against the simulator -> inspect the
 * receipt.
 *
 * Expected outcome: receipt COMMITTED_AND_VERIFIED, reconciliation
 * OK.
 */
import { ChargebeeAdapter, ChargebeeSim, QuoteStore } from "@agorail-labs/scq-reference";

const START = new Date("2026-08-01T00:00:00.000Z");

const sim = new ChargebeeSim(new Date(START));
const subscription = {
  id: "cb_consumer_seats",
  status: "active",
  subscriptionItems: [{ id: "item_1", itemPriceId: "ip_seat_basic_monthly", quantity: 100 }],
  currentTermStart: "2026-08-01T00:00:00.000Z",
  currentTermEnd: "2026-08-31T00:00:00.000Z",
  nextBillingAt: "2026-08-31T00:00:00.000Z",
};
sim.seedSubscription(structuredClone(subscription));

const adapter = new ChargebeeAdapter(sim, new QuoteStore());

// 1. Quote the change: seats 100 -> 120, effective immediately.
// The acceptance envelope bounds quote-relative DRIFT between the
// quote and the refreshed preview at commit time. It is NOT a total
// spending cap and NOT an authorization grant.
const quote = await adapter.createChangeQuote(subscription.id, {
  changes: [{ action: "CHANGE_QUANTITY", itemId: "item_1", quantity: 120 }],
  effectiveIntent: { type: "IMMEDIATE" },
  guaranteeMode: "REVALIDATE",
  acceptanceEnvelope: {
    maxImmediateNetIncrease: 0,
    maxImmediateCreditDecrease: 0,
    maxRecurringIncrease: 0,
  },
});

// 2. Inspect the quoted financial change. A dimension is DETERMINED
// only when its value is established with provenance; UNKNOWN means
// "no established value" — never a synonym for zero.
console.log("Quote:", quote.id);
console.log("Guarantee mode:", quote.guaranteeMode);
console.log("Proposed immediate net (minor units):", quote.commercialEffect.immediate?.net);
console.log("Proposed recurring amount (minor units):", quote.commercialEffect.recurring?.resultingAmount);
console.log("Currency:", quote.commercialEffect.recurring?.currency);
console.log("Determinacy:", JSON.stringify(quote.commercialEffect.determinacy));
console.log("Guarantee coverage:", JSON.stringify(quote.guaranteeCoverage));

// 3. Acceptance evaluation. SCQ's envelope is drift tolerance only;
// whether this change is authorized at all is a separate business
// decision (identity, approval, absolute budget, entitlements).
// This example stands in for that decision with explicit absolute
// caps.
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
console.log("Accepted under the example approval policy (absolute caps, separate from the SCQ envelope).");

// 4. Commit exactly once against the simulator.
const receipt = await adapter.commitChangeQuote(quote.id);

// 5. Inspect the receipt. COMMITTED_AND_VERIFIED / OK means the
// committed effect was established from operation-bound evidence
// and agrees with the quoted change. The recorded receipt is
// immutable; later verification is append-only evidence, and the
// presented view is derived from it.
console.log("Receipt status:", receipt.status);
console.log("Receipt outcome:", receipt.outcome);
console.log("Reconciliation:", receipt.reconciliation.status);
console.log("Committed immediate net (minor units):", receipt.committedEffect?.immediate?.net);
console.log("Committed determinacy:", JSON.stringify(receipt.committedEffect?.determinacy));
console.log("Resulting quantity:", receipt.resultingSnapshot?.items?.[0]?.quantity);
console.log("Provider dispatches:", sim.mutationsFor(subscription.id).length);

if (
  receipt.status !== "COMMITTED" ||
  receipt.outcome !== "COMMITTED_AND_VERIFIED" ||
  receipt.reconciliation.status !== "OK"
) {
  console.error("Unexpected outcome: expected COMMITTED / COMMITTED_AND_VERIFIED / OK.");
  process.exit(1);
}
console.log("Done: seat expansion committed and verified against the simulator.");

/**
 * SCQ seat-expansion onboarding demo.
 *
 * SIMULATOR ONLY. StripeSim is an in-memory, documentation-backed model; this
 * file makes no real billing API call and is not a production integration.
 * Amounts are minor units (for USD, cents). Tax, external entitlements and
 * contractual consequences are NOT completely covered by the quote model.
 *
 * Default: quote only. To exercise an explicitly simulated outside-the-protocol
 * approval, pass --simulate-approved-commit.
 */
import { StripeSim, type StripeSubscription } from "../src/adapters/stripe-sim.js";
import { StripeAdapter } from "../src/adapters/stripe-adapter.js";
import { QuoteStore } from "../src/store/quote-store.js";

async function main(): Promise<void> {
  const simulationStart = Math.floor(new Date("2026-08-01T00:00:00Z").getTime() / 1000);
  const sim = new StripeSim(simulationStart);
  const subscription: StripeSubscription = {
    id: "sub_scq_demo",
    status: "active",
    items: [{
      id: "si_demo",
      price: { id: "price_seat_basic", unitAmount: 1000, currency: "usd", interval: "month" },
      quantity: 100,
    }],
    current_period_start: simulationStart,
    current_period_end: simulationStart + 30 * 24 * 60 * 60,
    cancel_at_period_end: false,
  };
  sim.seedSubscription(subscription);

  const adapter = new StripeAdapter(sim, new QuoteStore());
  const before = await adapter.getSubscription(subscription.id);

  const quote = await adapter.createChangeQuote(subscription.id, {
    changes: [{ action: "CHANGE_QUANTITY", itemId: before.items[0].id, quantity: 120 }],
    effectiveIntent: { type: "IMMEDIATE" },
    guaranteeMode: "REVALIDATE",
    // Drift tolerance is NOT a total spending cap. This allows no increase
    // between the quoted amount and the refreshed preview at commit time.
    acceptanceEnvelope: {
      maxImmediateNetIncrease: 0,
      maxImmediateCreditDecrease: 0,
      maxRecurringIncrease: 0,
    },
  });

  const immediateNet = quote.commercialEffect.immediate?.net;
  const recurring = quote.commercialEffect.recurring;
  const resultAmount = recurring?.resultingAmount;

  console.log("Quote:", quote.id);
  console.log("Guarantee mode:", quote.guaranteeMode);
  console.log("Concurrency guarantee:", adapter.getCapabilities().consistencyGuarantee);
  console.log("Term coverage:", quote.guaranteeCoverage.termEffect);
  console.log("Quote expires:", quote.validUntil);

  // Separate example business authorization policy: these are absolute caps,
  // not SCQ's relative quote-drift acceptance envelope.
  const absolutePolicy = {
    maxImmediateNetChargeMinor: 25_000, // $250.00
    maxResultingRecurringMinor: 125_000, // $1,250.00
    currency: "usd",
  };

  if (
    immediateNet === undefined ||
    resultAmount === undefined ||
    recurring?.currency.toLowerCase() !== absolutePolicy.currency
  ) {
    console.log("REFUSED: quote is missing required financial information.");
    return;
  }

  console.log("Quoted immediate net (USD minor units):", immediateNet);
  console.log("Quoted resulting monthly amount (USD minor units):", resultAmount);

  if (
    immediateNet > absolutePolicy.maxImmediateNetChargeMinor ||
    resultAmount > absolutePolicy.maxResultingRecurringMinor
  ) {
    console.log("REFUSED: financial quote exceeds the illustrative authorization caps.");
    return;
  }

  const simulatedExternalApproval = process.argv.includes("--simulate-approved-commit");
  if (quote.guaranteeCoverage.termEffect !== "EXACT" && !simulatedExternalApproval) {
    console.log("REFUSED: contractual/term consequences are UNKNOWN and have not been separately approved.");
    console.log("The default demo performs no subscription mutation.");
    return;
  }
  if (!simulatedExternalApproval) {
    console.log("Quote inspected; explicit commit approval not supplied. No mutation performed.");
    return;
  }

  // This flag represents a hypothetical external approval of unmodeled
  // consequences FOR THE SYNTHETIC FIXTURE ONLY. It is not real user consent,
  // an authentication check, or permission to perform a production mutation.
  console.log("SIMULATION ONLY: assuming a separate explicit approval of unmodeled consequences.");
  const receipt = await adapter.commitChangeQuote(quote.id);
  console.log("Receipt status:", receipt.status);
  console.log("Resulting quantity:", receipt.resultingSnapshot.items[0].quantity);
  console.log("Commit consistency:", receipt.consistencyGuarantee);
  console.log("Post-commit reconciliation:", receipt.reconciliation.status);

  if (receipt.reconciliation.status !== "OK") {
    console.error("ALERT: reconciliation violated after mutation; investigate the completed change.");
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

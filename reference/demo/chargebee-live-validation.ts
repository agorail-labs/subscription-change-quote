/**
 * SCQ Live Chargebee Validation driver — EXPERIMENTAL, not a production SDK.
 *
 * Default behavior is READ-ONLY / ESTIMATE-ONLY:
 *   - With no CHARGEBEE_SITE / CHARGEBEE_API_KEY in the environment it
 *     prints "BLOCKED — CREDENTIALS NOT AVAILABLE" and exits 0. It never
 *     fabricates a result.
 *   - With credentials and CHARGEBEE_TEST_SUBSCRIPTION_ID set, it reads
 *     the (synthetic, test-site) subscription and creates an SCQ quote
 *     for 100 -> 120 seats, IMMEDIATE, REVALIDATE with a zero-tolerance
 *     envelope. Creating a quote performs only a retrieve + an estimate
 *     call; both are non-mutating.
 *   - It does NOT commit. Commit requires SCQ_LIVE_COMMIT_ENABLED=true
 *     AND a separate explicit approval for the exact operation (see
 *     research/chargebee-live-v1/TEST-RESULTS.md §"Approval needed").
 *
 * No credentials, authorization headers, or provider payloads are printed.
 */
import { ChargebeeClient, chargebeeConfigFromEnv } from "../src/live/chargebee-http.js";
import { ChargebeeLiveAdapter } from "../src/live/chargebee-scq-adapter.js";
import { QuoteStore } from "../src/store/quote-store.js";

async function main(): Promise<void> {
  const env = chargebeeConfigFromEnv();
  if (!env.ok) {
    console.log(`BLOCKED — CREDENTIALS NOT AVAILABLE (missing: ${env.missing.join(", ")})`);
    console.log("No live calls were made and no results are claimed.");
    return;
  }
  if (!env.testSubscriptionId) {
    console.log("BLOCKED — CHARGEBEE_TEST_SUBSCRIPTION_ID not set; refusing to guess a subscription.");
    return;
  }
  const client = new ChargebeeClient(env.config);
  const adapter = new ChargebeeLiveAdapter(client, new QuoteStore(), { liveCommitEnabled: env.liveCommitEnabled });
  const snap = await adapter.getSubscription(env.testSubscriptionId);
  console.log("Snapshot (normalized, redacted):", JSON.stringify({ id: snap.id, status: snap.status, version: snap.version, items: snap.items, billing: snap.billing }));
  const itemId = snap.items[0]?.id;
  const qty = snap.items[0]?.quantity;
  if (!itemId || qty === undefined) { console.log("Subscription has no items to validate against."); return; }
  const quote = await adapter.createChangeQuote(env.testSubscriptionId, {
    changes: [{ action: "CHANGE_QUANTITY", itemId, quantity: qty + 20 }],
    effectiveIntent: { type: "IMMEDIATE" },
    acceptanceEnvelope: { maxImmediateNetIncrease: 0, maxImmediateCreditDecrease: 0, maxRecurringIncrease: 0 },
  });
  console.log("Quote:", JSON.stringify({ id: quote.id, guaranteeMode: quote.guaranteeMode, guaranteeCoverage: quote.guaranteeCoverage, commercialEffect: quote.commercialEffect, validUntil: quote.validUntil, providerMetadata: quote.providerMetadata }));
  console.log(env.liveCommitEnabled
    ? "SCQ_LIVE_COMMIT_ENABLED=true is set, but this driver still does not commit: live mutation requires a separate explicit approval for the exact operation."
    : "Live commit disabled by default (SCQ_LIVE_COMMIT_ENABLED != 'true'); stopping after the non-mutating quote.");
}

main().catch((e) => { console.error("Validation driver failed:", e instanceof Error ? e.message : String(e)); process.exitCode = 1; });

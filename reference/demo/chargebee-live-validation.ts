/**
 * SCQ Live Chargebee Validation driver — EXPERIMENTAL, not a production SDK.
 *
 * Default behavior is READ-ONLY / ESTIMATE-ONLY:
 *   - With no CHARGEBEE_SITE / CHARGEBEE_API_KEY in the environment it
 *     prints "BLOCKED — CREDENTIALS NOT AVAILABLE" and exits 0. It never
 *     fabricates a result.
 *   - With credentials and CHARGEBEE_TEST_SUBSCRIPTION_ID set, it reads
 *     the (synthetic, test-site) subscription and runs TWO non-mutating
 *     quote scenarios through the SCQ live adapter (Phase 3):
 *       A) a quantity change on the FIRST subscription item (on the
 *          Oct 2026 demo subscription this is a flat_fee plan — the
 *          adapter is expected to REFUSE it before any provider call,
 *          because quantity is not a settable dimension of a flat_fee
 *          item; the refusal is printed as a first-class outcome), and
 *       B) a quantity change (+20) on the first quantity-priced
 *          (per_unit) ADDON item, when one exists — the scenario that
 *          produces a real end-to-end quote.
 *     Creating a quote performs only retrieves + estimate calls; all
 *     are non-mutating. Subscription state is printed before and after
 *     so the run record shows whether anything changed.
 *   - It does NOT commit. Commit requires SCQ_LIVE_COMMIT_ENABLED=true
 *     AND a separate explicit approval for the exact operation (see
 *     research/chargebee-live-v1/TEST-RESULTS.md §"Approval needed").
 *
 * No credentials, authorization headers, or provider payloads are printed.
 */
import { ChargebeeClient, chargebeeConfigFromEnv } from "../src/live/chargebee-http.js";
import { ChargebeeLiveAdapter } from "../src/live/chargebee-scq-adapter.js";
import { QuoteStore } from "../src/store/quote-store.js";
import { SCQError } from "../src/core/types.js";

const ENVELOPE0 = { maxImmediateNetIncrease: 0, maxImmediateCreditDecrease: 0, maxRecurringIncrease: 0 };

async function scenario(adapter: ChargebeeLiveAdapter, subId: string, label: string, itemId: string, quantity: number): Promise<void> {
  try {
    const quote = await adapter.createChangeQuote(subId, {
      changes: [{ action: "CHANGE_QUANTITY", itemId, quantity }],
      effectiveIntent: { type: "IMMEDIATE" },
      acceptanceEnvelope: { ...ENVELOPE0 },
    });
    console.log(`Scenario ${label}: QUOTE CREATED`, JSON.stringify({ id: quote.id, guaranteeMode: quote.guaranteeMode, guaranteeCoverage: quote.guaranteeCoverage, commercialEffect: quote.commercialEffect, validUntil: quote.validUntil, providerMetadata: quote.providerMetadata }));
  } catch (e) {
    if (e instanceof SCQError) {
      console.log(`Scenario ${label}: REFUSED (${e.code}) — ${e.message}`);
    } else {
      console.log(`Scenario ${label}: FAILED — ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

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
  const before = await adapter.getSubscription(env.testSubscriptionId);
  console.log("Snapshot BEFORE (normalized, redacted):", JSON.stringify({ id: before.id, status: before.status, version: before.version, items: before.items, billing: before.billing }));

  // Raw item types (plan vs addon) for scenario selection — the
  // normalized snapshot intentionally does not carry provider item types.
  const { json } = await client.getSubscription(env.testSubscriptionId);
  const rawItems = ((json as any)?.subscription?.subscription_items ?? []) as Array<{ item_price_id: string; item_type: string; quantity: number }>;

  const first = rawItems[0];
  if (first) await scenario(adapter, env.testSubscriptionId, `A (first item ${first.item_price_id}, quantity ${first.quantity} -> ${first.quantity + 20})`, first.item_price_id, first.quantity + 20);
  const addon = rawItems.find((i) => i.item_type === "addon");
  if (addon) {
    await scenario(adapter, env.testSubscriptionId, `B (per-unit addon ${addon.item_price_id}, quantity ${addon.quantity} -> ${addon.quantity + 20})`, addon.item_price_id, addon.quantity + 20);
  } else {
    console.log("Scenario B: SKIPPED — subscription has no addon item.");
  }

  const after = await adapter.getSubscription(env.testSubscriptionId);
  console.log("Snapshot AFTER (normalized, redacted):", JSON.stringify({ id: after.id, status: after.status, version: after.version, items: after.items, billing: after.billing }));
  console.log(before.version === after.version && JSON.stringify(before.items) === JSON.stringify(after.items)
    ? "State check: subscription version and items UNCHANGED by this run."
    : "State check: WARNING — subscription version/items differ after the run.");
  console.log(env.liveCommitEnabled
    ? "SCQ_LIVE_COMMIT_ENABLED=true is set, but this driver still does not commit: live mutation requires a separate explicit approval for the exact operation."
    : "Live commit disabled by default (SCQ_LIVE_COMMIT_ENABLED != 'true'); stopping after the non-mutating quotes.");
}

main().catch((e) => { console.error("Validation driver failed:", e instanceof Error ? e.message : String(e)); process.exitCode = 1; });

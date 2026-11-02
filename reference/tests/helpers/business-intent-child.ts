/** Child fixture for genuinely separate-process SQLite claim contention. */
import { BusinessIntentLedger } from "../../src/integration/business-intent-bridge.js";
const [path, quoteId] = process.argv.slice(2);
if (!path || !quoteId) throw Error("Usage: child dbPath quoteId");
const ledger = new BusinessIntentLedger(path);
try {
  const result = ledger.claim({
    tenantId: "tenant-x",
    businessIntentId: "single-customer-approval",
    actorId: "customer-a",
    authorizationRef: "approval-a",
    provider: "chargebee",
    site: "test-site",
    subscriptionId: "sub_1",
    operation: { action: "CHANGE_QUANTITY", itemId: "addon-1", quantity: 120 },
    quoteId,
  }, { evaluatedAt: "2026-11-01T19:00:00.000Z", failures: [], coverage: [] });
  process.stdout.write(JSON.stringify({
    acquired: result.acquired,
    originalQuoteId: result.claim.quoteId,
  }) + "\n");
} finally {
  ledger.close();
}

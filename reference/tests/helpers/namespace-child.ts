// Child-process entry point for the Issue #45 suite (test64).
// Runs as a GENUINELY NEW process (spawned with process.execPath)
// against a real temporary database file shared with a sibling
// process — cross-process exclusion claims are proven here, not by
// re-creating objects in the parent process.
//
// Mode:
//   begin <db> <quoteId> <subscriptionId> <provider> <site> <key> <resultFile>
//     Opens the store, attempts beginDispatch for the given
//     namespace, and writes a JSON outcome to <resultFile>:
//     {"ok":true,"attemptId":...} (exit 0) or
//     {"ok":false,"blockedBy":...} (exit 3).
import { writeFileSync } from "node:fs";
import { DurableQuoteStore } from "../../src/store/durable-store.js";

const [mode, dbPath, quoteId, subscriptionId, provider, site, key, resultFile] = process.argv.slice(2);

function main(): void {
  if (mode !== "begin") process.exit(2);
  const store = new DurableQuoteStore(dbPath, { busyTimeoutMs: 10_000 });
  try {
    const attempt = store.beginDispatch({
      quoteId,
      subscriptionId,
      provider,
      ...(site !== "-" ? { site } : {}),
      request: { subscription_items: [{ item_price_id: "item_1", quantity: 2 }], replace_items_list: true },
      idempotencyKey: key,
      preDispatchFingerprint: "fp-1",
    });
    writeFileSync(resultFile, JSON.stringify({ ok: true, attemptId: attempt.attemptId, state: attempt.state }));
    process.exit(0);
  } catch (e) {
    const details = (e as { details?: { attemptId?: string } }).details;
    writeFileSync(resultFile, JSON.stringify({ ok: false, blockedBy: details?.attemptId ?? null, error: String((e as Error).message).slice(0, 200) }));
    process.exit(3);
  } finally {
    try { store.close(); } catch { /* process is exiting */ }
  }
}

main();

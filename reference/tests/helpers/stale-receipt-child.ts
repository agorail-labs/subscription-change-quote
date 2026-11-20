// Child-process worker for test68 (stale-receipt replay): an
// ALREADY-OPEN SCQ worker sharing one SQLite database with the
// parent process. It opens its store, signals readiness, waits for
// the parent's explicit settled signal (a file handshake — no
// timing assumption about the other process), and only then runs
// the coordinator for the same job. Its dispatch callback appends
// to the effect file if it is EVER invoked; a correct replay never
// invokes it.
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { DurableQuoteStore } from "../../src/store/durable-store.js";
import { DurableMutationCoordinator } from "../../src/store/mutation-coordinator.js";
import { makeReceipt } from "./durable-fixtures.js";

const [dbPath, readyFile, settledFile, effectFile] = process.argv.slice(2);
if (!dbPath || !readyFile || !settledFile || !effectFile) {
  throw new Error("Usage: stale-receipt-child <db> <readyFile> <settledFile> <effectFile>");
}

// The exact job the parent executes (handoff fixture): same quote,
// same idempotency key, same canonical request.
const job = {
  quoteId: "q1",
  subscriptionId: "sub_1",
  provider: "chargebee",
  site: "site-1",
  request: { replace_items_list: false, items: [{ id: "item_1", quantity: 120 }] },
  idempotencyKey: "provider-key-q1",
};

async function main(): Promise<void> {
  const store = new DurableQuoteStore(dbPath, { recoveryGraceMs: 0 });
  const coordinator = new DurableMutationCoordinator(store);
  writeFileSync(readyFile, "open");
  // Handshake: proceed only when the parent signals that worker A
  // has settled. Polling for the signal file IS the synchronization;
  // the outcome does not depend on how long either side takes.
  const deadline = Date.now() + 60_000;
  while (!existsSync(settledFile)) {
    if (Date.now() > deadline) {
      store.close();
      process.stdout.write(JSON.stringify({ error: "settled signal never arrived" }) + "\n");
      process.exit(2);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  try {
    const result = await coordinator.execute(job, async () => {
      appendFileSync(effectFile, "dispatch\n");
      return { type: "receipt" as const, receipt: makeReceipt("q1") };
    });
    process.stdout.write(
      JSON.stringify({ type: result.type, receiptId: result.type === "replay" || result.type === "settled" ? result.receipt?.receiptId ?? null : null }) + "\n",
    );
    store.close();
    process.exit(0);
  } catch (e) {
    process.stdout.write(JSON.stringify({ error: (e as Error).message, name: (e as Error).name }) + "\n");
    store.close();
    process.exit(3);
  }
}

main().catch((e) => {
  process.stderr.write(String(e instanceof Error ? e.stack ?? e.message : e) + "\n");
  process.exit(1);
});

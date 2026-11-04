/**
 * Child process for Test 67. This is a COMPLETE MSE admission -> SCQ
 * durable-intent bridge execution, not merely BusinessIntentLedger.claim().
 * Both databases are real SQLite files shared with other processes.
 *
 * Synthetic dispatch appends a line to a local file. NO provider/network API.
 * Kill modes stop at a *synchronous* boundary after writing a marker; the
 * parent sends SIGKILL. Nothing relies on an orderly close/finally.
 */
import { appendFileSync, writeFileSync } from "node:fs";
import { DurableQuoteStore } from "../../src/store/durable-store.js";
import { DurableMutationCoordinator } from "../../src/store/mutation-coordinator.js";
import {
  BusinessIntentLedger, MseScqIntentBridge, type BusinessIntent, type BridgeHooks,
} from "../../src/integration/business-intent-bridge.js";
import { makeReceipt } from "./durable-fixtures.js";

const [mode, intentPath, scqPath, effectFile, readyFile, quoteId = "q1"] = process.argv.slice(2);
if (!mode || !intentPath || !scqPath || !effectFile || !readyFile) {
  throw Error("Usage: worker mode intentDb scqDb effectFile readyFile [quoteId]");
}
const business: BusinessIntent = {
  tenantId: "tenant-a",
  businessIntentId: "approved-action-1",
  actorId: "customer-7",
  authorizationRef: "authorization-immutable-1",
  provider: "chargebee",
  site: "site-1",
  subscriptionId: "sub_1",
  operation: { action: "CHANGE_QUANTITY", itemId: "item_1", quantity: 120 },
  quoteId,
};
const mutation = {
  quoteId,
  subscriptionId: "sub_1",
  provider: "chargebee",
  site: "site-1",
  request: { replace_items_list: false, items: [{ id: "item_1", quantity: 120 }] },
  idempotencyKey: `provider-key-${quoteId}`,
};
const admission = {
  quoteId: "mse-q1", proposalId: "mse-p1", evaluatedAt: "2026-11-03T00:00:00.000Z",
  failures: [], coverage: [{ relationId: "addon-dep", status: "PASSED" }],
};
const hooks: BridgeHooks = {
  // Synthetic authorization, admission and commercial validation. These are
  // trusted callbacks for the integration fixture, NOT production proof.
  authorize: async () => {},
  admission: async () => ({ kind: "PASSED", report: admission }),
  validatePassedAdmission: report => {
    if (report !== admission) throw Error("Fixture admission report mismatch");
  },
  validateCommercial: async () => {},
};

function holdUntilKilled(stage: string): never {
  // Marker is flushed to disk before blocking. The parent SIGKILLs
  // this process, never resumes the hook, and checks recovered ledgers.
  writeFileSync(readyFile, stage);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
  throw Error(`Unsafe fixture resumed past ${stage} without SIGKILL`);
}
async function main(): Promise<void> {
  const ledger = new BusinessIntentLedger(intentPath);
  const store = new DurableQuoteStore(scqPath, { recoveryGraceMs: mode === "race" ? 60_000 : 0 });
  try {
    if (mode === "kill-after-claim") {
      const claim = ledger.claim(business, admission);
      if (!claim.acquired) throw Error("Intent claim unexpectedly lost");
      holdUntilKilled("CLAIM_PERSISTED_NO_SCQ_ATTEMPT");
    }
    const coordinator = new DurableMutationCoordinator(store, {
      afterIntentPersisted: mode === "kill-after-write-ahead"
        ? () => holdUntilKilled("SCQ_ATTEMPT_PERSISTED_NO_PROVIDER_EFFECT")
        : undefined,
      afterDispatchBeforePersist: mode === "kill-after-effect"
        ? () => holdUntilKilled("SYNTHETIC_EFFECT_DONE_NO_RECEIPT")
        : undefined,
    });
    const bridge = new MseScqIntentBridge(ledger, coordinator);
    const response = await bridge.execute(business, mutation, hooks, async () => {
      appendFileSync(effectFile, `synthetic-effect quote=${quoteId}\n`);
      if (mode === "race") await new Promise(resolve => setTimeout(resolve, 250));
      return { type: "receipt" as const, receipt: makeReceipt(quoteId) };
    });
    process.stdout.write(JSON.stringify({
      kind: response.kind,
      originalQuoteId: response.kind === "EXISTING_RECEIPT" || response.kind === "BLOCKED"
        ? response.originalQuoteId
        : undefined,
    }) + "\n");
  } finally {
    ledger.close();
    store.close();
  }
}
main().catch(e => {
  process.stderr.write(String(e instanceof Error ? e.stack ?? e.message : e) + "\n");
  process.exitCode = 1;
});

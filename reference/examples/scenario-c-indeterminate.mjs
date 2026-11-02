/**
 * SCQ quick start — Scenario C: the unknown outcome.
 *
 * SIMULATOR ONLY. ChargebeeSim is an in-memory, provider-shaped model;
 * this file makes no real billing API call. Amounts are minor units.
 *
 * The hardest case in billing mutation is not failure — it is not
 * knowing. If the mutation is dispatched but its response is lost,
 * the change may or may not have landed. SCQ classifies that outcome
 * INDETERMINATE and enforces three rules this scenario demonstrates:
 *
 *   1. No blind retry. Re-committing the same quote is refused and
 *      dispatches nothing: a retry could double-apply the change.
 *   2. Reconciliation is independent. You establish what happened by
 *      observing the provider state, not by re-running the mutation.
 *   3. No silent reuse. A fresh quote is a NEW authorization object;
 *      it does not resolve, inherit, or quietly bypass the unresolved
 *      attempt. (With the durable store + write-ahead coordinator
 *      used for real integrations, dispatch for a subscription with
 *      an unresolved attempt is blocked outright until an operator
 *      resolves it from independently reviewed evidence — see the
 *      developer guide. This example exposes no bypass, because
 *      there isn't one.)
 *
 * Part 2 shows the durable half of the story: with a DurableQuoteStore
 * (SQLite), a committed receipt survives a process restart, and
 * re-committing the same quote replays the ORIGINAL receipt without
 * a second dispatch (spec section 6.10).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ChargebeeAdapter,
  ChargebeeSim,
  DurableQuoteStore,
  QuoteStore,
  SCQError,
} from "@agorail-labs/scq-reference";

const START = new Date("2026-08-01T00:00:00.000Z");

function fixture(id, store) {
  const sub = {
    id,
    status: "active",
    subscriptionItems: [{ id: "item_1", itemPriceId: "ip_seat_basic_monthly", quantity: 100 }],
    currentTermStart: "2026-08-01T00:00:00.000Z",
    currentTermEnd: "2026-08-31T00:00:00.000Z",
    nextBillingAt: "2026-08-31T00:00:00.000Z",
  };
  const sim = new ChargebeeSim(new Date(START));
  sim.seedSubscription(structuredClone(sub));
  return { sim, sub, adapter: new ChargebeeAdapter(sim, store) };
}

const proposal = {
  changes: [{ action: "CHANGE_QUANTITY", itemId: "item_1", quantity: 120 }],
  effectiveIntent: { type: "IMMEDIATE" },
  acceptanceEnvelope: {
    maxImmediateNetIncrease: 0,
    maxImmediateCreditDecrease: 0,
    maxRecurringIncrease: 0,
  },
};

// ------------------------------------------------------------------
// Part 1 — lost response after dispatch -> INDETERMINATE.
// ------------------------------------------------------------------
{
  const store = new QuoteStore();
  const { sim, sub, adapter } = fixture("cb_quickstart_c1", store);
  const quote = await adapter.createChangeQuote(sub.id, proposal);

  sim._debugLoseNextMutationResponse = true; // the mutation lands; its response never arrives

  let firstError;
  try {
    await adapter.commitChangeQuote(quote.id);
  } catch (err) {
    firstError = err;
  }
  if (!(firstError instanceof SCQError) || firstError.details?.outcome !== "INDETERMINATE") {
    console.error("Unexpected outcome for scenario C part 1: expected an INDETERMINATE refusal.");
    process.exit(1);
  }
  console.log("Commit outcome: INDETERMINATE —", firstError.message);
  console.log("Recorded outcome on the quote:", store.get(quote.id)?.commit_outcome?.outcome);
  console.log("Dispatches so far:", sim.mutationsFor(sub.id).length);

  // Rule 1: no blind retry. The refusal is deterministic and free of
  // side effects — the provider sees no second mutation.
  let retryError;
  try {
    await adapter.commitChangeQuote(quote.id);
  } catch (err) {
    retryError = err;
  }
  console.log(
    "Blind retry refused:",
    retryError instanceof SCQError && retryError.details?.outcome === "INDETERMINATE",
    "| dispatches still:",
    sim.mutationsFor(sub.id).length,
  );
  if (sim.mutationsFor(sub.id).length !== 1) {
    console.error("A retry dispatched a second mutation — this must never happen.");
    process.exit(1);
  }

  // Rule 2: reconcile by independent observation. In this simulation
  // the change DID land — which is exactly why retrying was dangerous.
  const observed = await adapter.getSubscription(sub.id);
  console.log(
    "Independent observation: quantity is now",
    observed.items?.[0]?.quantity,
    "— the change landed; only its response was lost.",
  );

  // Rule 3: a fresh quote does not resolve the old attempt. It is a
  // new authorization object, priced from the CURRENT (landed) state.
  // An operator reconciles the indeterminate attempt first; software
  // must not treat the new quote as a retry channel.
  const fresh = await adapter.createChangeQuote(sub.id, {
    changes: [{ action: "CHANGE_QUANTITY", itemId: "item_1", quantity: 130 }],
    effectiveIntent: { type: "IMMEDIATE" },
    acceptanceEnvelope: proposal.acceptanceEnvelope,
  });
  console.log(
    "Fresh quote created as a distinct object:",
    fresh.id !== quote.id,
    "| original attempt still:",
    store.get(quote.id)?.commit_outcome?.outcome,
    "(this example deliberately does not commit the fresh quote)",
  );
}

// ------------------------------------------------------------------
// Part 2 — durable receipts: restart, replay, no second dispatch.
// Requires the optional better-sqlite3 native binding; if it is not
// installed for this Node version, DurableQuoteStore says so
// explicitly and the in-memory parts above are unaffected.
// ------------------------------------------------------------------
{
  const dir = mkdtempSync(join(tmpdir(), "scq-quickstart-c-"));
  const dbPath = join(dir, "scq.db");
  try {
    const firstStore = new DurableQuoteStore(dbPath);
    const first = fixture("cb_quickstart_c2", firstStore);
    const quote = await first.adapter.createChangeQuote(first.sub.id, proposal);
    const receipt = await first.adapter.commitChangeQuote(quote.id);
    console.log("Durable commit:", receipt.status, "/", receipt.reconciliation.status);
    const dispatches = first.sim.mutationsFor(first.sub.id).length;
    firstStore.close();

    // Simulated restart: a brand-new store and adapter over the same
    // database file and the same provider (simulator).
    const reopenedStore = new DurableQuoteStore(dbPath);
    const reopened = new ChargebeeAdapter(first.sim, reopenedStore);
    const replayed = await reopened.commitChangeQuote(quote.id);
    const sameReceipt =
      replayed.receiptId !== undefined
        ? replayed.receiptId === receipt.receiptId
        : JSON.stringify(replayed) === JSON.stringify(receipt);
    console.log(
      "After restart, re-commit replays the original receipt:",
      sameReceipt,
      "| no second dispatch:",
      first.sim.mutationsFor(first.sub.id).length === dispatches,
    );
    reopenedStore.close();
    if (!sameReceipt || first.sim.mutationsFor(first.sub.id).length !== dispatches) {
      console.error("Replay after restart did not return the original receipt.");
      process.exit(1);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("Scenario C complete: INDETERMINATE blocks retry; reconciliation is by observation, not re-dispatch.");

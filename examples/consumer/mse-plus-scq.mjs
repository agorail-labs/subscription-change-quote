/**
 * MSE + SCQ consumer example: a seat change with a dependent add-on.
 *
 * CROSS-REPOSITORY INTEGRATION — EXPERIMENTAL EXAMPLE SOURCE.
 * This file wires two independently published packages together in
 * user code. The integration itself is NOT an API exported by either
 * @agorail-labs/mse-reference or @agorail-labs/scq-reference; each
 * package's own surface is used exactly as published.
 *
 * SIMULATOR ONLY: the SCQ half runs against ChargebeeSim, an
 * in-memory, provider-shaped model. No real billing API is called.
 * Amounts are minor units (for USD, cents).
 *
 * Pipeline:
 *   1. MSE evaluateAdmissionOnly acts as a READ-ONLY admission gate
 *      over the whole multi-unit change (seats + dependent add-on).
 *      An incomplete change is refused before anything is quoted.
 *   2. SCQ quotes the financial change, a separate approval policy
 *      accepts it, and the change is committed against the
 *      simulator with a DurableQuoteStore (SQLite) recording the
 *      receipt.
 *   3. Durable dispatch protection: after a simulated restart, a
 *      DurableMutationCoordinator asked to execute the SAME
 *      mutation intent replays the recorded receipt and never
 *      invokes the dispatch callback — the change is not
 *      re-executed.
 *
 * Neither step grants authorization. MSE admission decides
 * admissibility of the change set; SCQ governs the quote/commit/
 * receipt lifecycle. Whether the change may happen at all remains
 * the integrator's business decision.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateAdmissionOnly } from "@agorail-labs/mse-reference";
import {
  ChargebeeAdapter,
  ChargebeeSim,
  DurableMutationCoordinator,
  DurableQuoteStore,
} from "@agorail-labs/scq-reference";

const START = new Date("2026-08-01T00:00:00.000Z");
const SUBSCRIPTION_ID = "cb_consumer_combined";

// ------------------------------------------------------------------
// Step 1 — MSE admission gate (read-only; nothing is dispatched).
// The seat unit REQUIRES the analytics add-on unit to be co-included.
// ------------------------------------------------------------------
const seatTransition = { kind: "SET_ITEM_QUANTITY", itemId: "seats", quantity: 120 };
const addonTransition = { kind: "ADD_ITEM", itemId: "addon-analytics" };
const seatUnit = {
  unitRef: "unit-seats",
  unitLocator: { scopeRef: SUBSCRIPTION_ID, unitKey: "seats" },
  transition: seatTransition,
  effects: [
    {
      effectId: "eff-seat-qty",
      type: "subscription:seat_quantity",
      value: { type: "number", value: 120 },
      guarantee: { mode: "EXACT" },
    },
  ],
};
const addonUnit = {
  unitRef: "unit-addon",
  unitLocator: { scopeRef: SUBSCRIPTION_ID, unitKey: "addon-analytics" },
  transition: addonTransition,
  effects: [],
};
const relations = [
  {
    relationId: "rel-seats-require-addon",
    type: "REQUIRES_COINCLUSION",
    triggerUnitRefs: ["unit-seats"],
    scopeRef: SUBSCRIPTION_ID,
  },
];
const proposal = {
  proposalId: "prop-combined-1",
  target: { subscriptionId: SUBSCRIPTION_ID },
  change: { description: "seats 100 -> 120 with dependent analytics add-on" },
};

function mseQuote(units) {
  return {
    quoteId: `mse-quote-${units.length}`,
    target: { subscriptionId: SUBSCRIPTION_ID },
    units,
    admissionRelations: relations,
  };
}

// 1a. The incomplete change (seats only) is refused at the gate; the
// witness names the missing add-on. Nothing reaches SCQ.
const refused = evaluateAdmissionOnly(
  proposal,
  mseQuote([seatUnit]),
  () => ({
    failures: [
      {
        relationId: "rel-seats-require-addon",
        witness: {
          disposition: "COMPLETE",
          requiredTransitions: [
            { unitLocator: { scopeRef: SUBSCRIPTION_ID, unitKey: "addon-analytics" }, transition: addonTransition },
          ],
        },
      },
    ],
    coverage: [{ relationId: "rel-seats-require-addon", status: "FAILED" }],
  }),
  new Date(START),
);
console.log("MSE gate, incomplete change:", refused.kind);
if (refused.kind === "ADMISSION_REFUSED") {
  console.log(
    "  witness names the missing unit:",
    refused.admissionRefusal.failures[0].witness.requiredTransitions.map((r) => r.unitLocator.unitKey).join(", "),
  );
  console.log("  -> refused before quoting or dispatch; the SCQ steps below never run for this change");
}

// 1b. The complete change (seats + add-on) passes the gate.
const passed = evaluateAdmissionOnly(
  proposal,
  mseQuote([seatUnit, addonUnit]),
  () => ({
    failures: [],
    coverage: [
      {
        relationId: "rel-seats-require-addon",
        status: "PASSED",
        satisfactions: [
          { source: "CURRENT_REQUEST", unitRef: "unit-addon", transition: addonTransition },
        ],
      },
    ],
  }),
  new Date(START),
);
console.log("MSE gate, complete change:", passed.kind);
if (passed.kind !== "ADMISSION_PASSED") {
  console.error("The complete change should have passed admission.");
  process.exit(1);
}

// ------------------------------------------------------------------
// Steps 2+3 — SCQ lifecycle with durable dispatch protection.
// ------------------------------------------------------------------
const dir = mkdtempSync(join(tmpdir(), "scq-consumer-combined-"));
const dbPath = join(dir, "scq.db");
try {
  const sim = new ChargebeeSim(new Date(START));
  sim.seedSubscription({
    id: SUBSCRIPTION_ID,
    status: "active",
    subscriptionItems: [{ id: "item_1", itemPriceId: "ip_seat_basic_monthly", quantity: 100 }],
    currentTermStart: "2026-08-01T00:00:00.000Z",
    currentTermEnd: "2026-08-31T00:00:00.000Z",
    nextBillingAt: "2026-08-31T00:00:00.000Z",
  });

  // Step 2: quote, evaluate acceptance, commit — with the receipt
  // recorded in a durable (SQLite) store.
  const store = new DurableQuoteStore(dbPath);
  const adapter = new ChargebeeAdapter(sim, store);
  const quote = await adapter.createChangeQuote(SUBSCRIPTION_ID, {
    changes: [{ action: "CHANGE_QUANTITY", itemId: "item_1", quantity: 120 }],
    effectiveIntent: { type: "IMMEDIATE" },
    guaranteeMode: "REVALIDATE",
    acceptanceEnvelope: {
      maxImmediateNetIncrease: 0,
      maxImmediateCreditDecrease: 0,
      maxRecurringIncrease: 0,
    },
  });
  console.log("SCQ quote:", quote.id);
  console.log("Quoted immediate net (minor units):", quote.commercialEffect.immediate?.net);
  console.log("Quoted recurring amount (minor units):", quote.commercialEffect.recurring?.resultingAmount);
  console.log("Determinacy:", JSON.stringify(quote.commercialEffect.determinacy));

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
  console.log("Accepted under the example approval policy (separate from SCQ's drift envelope).");

  const receipt = await adapter.commitChangeQuote(quote.id);
  console.log("Receipt status:", receipt.status, "| reconciliation:", receipt.reconciliation.status);
  const dispatchesAfterCommit = sim.mutationsFor(SUBSCRIPTION_ID).length;
  console.log("Provider dispatches after commit:", dispatchesAfterCommit);
  store.close();

  // Step 3: simulated restart. A fresh durable store and a
  // write-ahead DurableMutationCoordinator over the same database
  // are asked to execute the SAME mutation intent. The recorded
  // receipt is replayed; the dispatch callback is never invoked,
  // so the provider sees no second mutation.
  const reopenedStore = new DurableQuoteStore(dbPath);
  const coordinator = new DurableMutationCoordinator(reopenedStore);
  const intent = {
    quoteId: quote.id,
    subscriptionId: SUBSCRIPTION_ID,
    provider: "chargebee",
    request: { changes: [{ action: "CHANGE_QUANTITY", itemId: "item_1", quantity: 120 }] },
    idempotencyKey: `consumer-combined-${quote.id}`,
  };
  let dispatchInvocations = 0;
  const result = await coordinator.execute(intent, async () => {
    dispatchInvocations += 1;
    throw new Error("dispatch must never run for an already-settled intent");
  });
  console.log("Second dispatch of the same intent:", result.type);
  console.log("Replayed receipt status:", result.receipt?.status);
  console.log("Dispatch callback invocations:", dispatchInvocations);
  console.log("Provider dispatches still:", sim.mutationsFor(SUBSCRIPTION_ID).length);
  console.log(
    "Unresolved attempts in recovery report:",
    coordinator.recoveryReport().unresolvedAttempts.length,
  );
  reopenedStore.close();

  if (
    result.type !== "replay" ||
    dispatchInvocations !== 0 ||
    sim.mutationsFor(SUBSCRIPTION_ID).length !== dispatchesAfterCommit
  ) {
    console.error("Durable dispatch protection did not hold.");
    process.exit(1);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log("Done: MSE admitted the complete change; SCQ committed it once; the duplicate intent replayed, not re-executed.");

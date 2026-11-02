/**
 * Agorail cross-repository SUBSCRIPTION fixture (simulator only).
 * Imports actual MSE admission-only validator and actual SCQ coordinator.
 *
 * Seat expansion must co-include an addon entitlement quantity update.
 * The MSE binding is a simulated in-process state evaluator, not a read
 * from Chargebee. SCQ financial and provider-preservation preflight is
 * simulated too. No live provider calls and no multi-unit atomicity claim.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateAdmissionOnly } from "../../mse-dependency/src/core/admission-only.ts";
import { assertAdmissionReportWellFormed } from "../../mse-dependency/src/core/validate.ts";
import { DurableQuoteStore } from "../src/store/durable-store.ts";
import { DurableMutationCoordinator } from "../src/store/mutation-coordinator.ts";
import { BusinessIntentLedger, MseScqIntentBridge } from "../src/integration/business-intent-bridge.ts";
import { makeReceipt, makeStoredQuote } from "../tests/helpers/durable-fixtures.ts";

const scope = "subscription:sub_1";
const target = { provider: "chargebee", site: "simulated", subscriptionId: "sub_1" };
const seats = {
  unitRef: "seat-change",
  unitLocator: { scopeRef: scope, unitKey: "seat-item" },
  transition: { action: "CHANGE_QUANTITY", itemId: "seat-item", quantity: 120 },
  effects: [],
};
const addon = {
  unitRef: "addon-entitlement",
  unitLocator: { scopeRef: scope, unitKey: "addon-item" },
  transition: { action: "CHANGE_QUANTITY", itemId: "addon-item", quantity: 120 },
  effects: [],
};
const relation = {
  relationId: "subscription:seat-change-requires-addon-entitlement",
  type: "REQUIRES_COINCLUSION" as const,
  triggerUnitRefs: [seats.unitRef],
  scopeRef: scope,
  passEvidence: "REQUIRED" as const,
};
const proposal = {
  proposalId: "approved-seat-expansion",
  target,
  change: { transitions: [seats.transition, addon.transition] },
};
const mseQuote = {
  quoteId: "mse-subscription-q1",
  target,
  snapshot: { subscriptionVersion: "v1" },
  commitConsistency: "SNAPSHOT_REQUIRED" as const,
  units: [seats, addon],
  admissionRelations: [relation],
};
const refusalProposal = {
  proposalId: "incomplete-seat-expansion",
  target,
  change: { transitions: [seats.transition] },
};
const refusalQuote = {
  ...mseQuote,
  quoteId: "mse-subscription-q2",
  units: [seats],
};
const at = new Date("2026-11-01T18:40:00.000Z");

/** Binding-specific live co-inclusion evaluation over simulated current state. */
function evaluateSubscriptionUnits(_proposal: typeof proposal, quote: typeof mseQuote | typeof refusalQuote) {
  const present = quote.units.some(u =>
    u.unitLocator.scopeRef === scope && u.unitLocator.unitKey === addon.unitLocator.unitKey &&
    JSON.stringify(u.transition) === JSON.stringify(addon.transition));
  const failure = {
    relationId: relation.relationId,
    witness: {
      disposition: "COMPLETE" as const,
      requiredTransitions: [{ unitLocator: addon.unitLocator, transition: addon.transition }],
    },
  };
  return present
    ? {
        stateRef: { subscriptionVersion: "v1" },
        failures: [],
        coverage: [{
          relationId: relation.relationId, status: "PASSED" as const,
          requiredParticipants: [{ unitLocator: addon.unitLocator, transition: addon.transition }],
          satisfactions: [{
            source: "CURRENT_REQUEST" as const, unitRef: addon.unitRef, transition: addon.transition,
          }],
        }],
      }
    : {
        stateRef: { subscriptionVersion: "v1" },
        failures: [failure],
        coverage: [{ relationId: relation.relationId, status: "FAILED" as const }],
      };
}
const approved = evaluateAdmissionOnly(proposal, mseQuote, (p,q) =>
  evaluateSubscriptionUnits(p as typeof proposal, q as typeof mseQuote), at);
assert.equal(approved.kind, "ADMISSION_PASSED");
const rejected = evaluateAdmissionOnly(refusalProposal, refusalQuote, (p,q) =>
  evaluateSubscriptionUnits(p as typeof proposal, q as typeof refusalQuote), at);
assert.equal(rejected.kind, "ADMISSION_REFUSED");

const business = (quoteId: string, id: string) => ({
  tenantId: "tenant-1", businessIntentId: id,
  actorId: "customer-7", authorizationRef: "approved-operation-42",
  provider: "chargebee", site: "simulated", subscriptionId: "sub_1",
  operation: { change: "CHANGE_QUANTITY", itemId: "seat-item", seats: 120,
    dependentAddonItemId: "addon-item", addonQuantity: 120 },
  quoteId,
});
const mutation = (quoteId: string) => ({
  quoteId, subscriptionId: "sub_1", provider: "chargebee", site: "simulated",
  idempotencyKey: "unique-" + quoteId,
  // Mock operation only. Provider-safe targeted semantics NOT established.
  request: { items: [{ id: "seat-item", quantity: 120 }, { id: "addon-item", quantity: 120 }] },
});
const dir = mkdtempSync(join(tmpdir(), "agorail-cross-repo-"));
let store: DurableQuoteStore | undefined;
let ledger: BusinessIntentLedger | undefined;
try {
  store = new DurableQuoteStore(join(dir, "scq.sqlite"), { recoveryGraceMs: 0 });
  ledger = new BusinessIntentLedger(join(dir, "business-intent.sqlite"));
  store.put(makeStoredQuote("scq-q1"));
  store.put(makeStoredQuote("scq-q2"));
  const bridge = new MseScqIntentBridge(ledger, new DurableMutationCoordinator(store));
  let dispatchCount = 0;
  let authorizedCalls = 0;
  const hooks = {
    authorize: async () => { authorizedCalls++; }, // simulated authorization
    admission: async () => {
      if (approved.kind !== "ADMISSION_PASSED") throw new Error("MSE admission failed");
      return { kind: "PASSED" as const, report: approved.admissionReport };
    },
    validatePassedAdmission: (candidate: unknown) => {
      assertAdmissionReportWellFormed(mseQuote, proposal, candidate as any);
    },
    validateCommercial: async () => {
      // SCQ preflight stub only; no Chargebee provider safety guaranteed.
      assert.ok(store!.get("scq-q1"));
    },
  };
  const first = await bridge.execute(business("scq-q1", "intent-1"), mutation("scq-q1"), hooks, async () => {
    dispatchCount++;
    return { type: "receipt", receipt: makeReceipt("scq-q1") };
  });
  assert.equal(first.kind, "EXECUTED");

  // Same approved action, new quote/new provider key: no second dispatch.
  const reQuote = await bridge.execute(business("scq-q2", "intent-1"), mutation("scq-q2"), hooks, async () => {
    dispatchCount++;
    throw new Error("Requote illegally dispatched");
  });
  assert.equal(reQuote.kind, "EXISTING_RECEIPT");

  // MSE dependency refusal is before SCQ's write-ahead gate.
  const refused = await bridge.execute(business("scq-q2", "different-intent"), mutation("scq-q2"), {
    ...hooks,
    admission: async () => {
      if (rejected.kind !== "ADMISSION_REFUSED") throw new Error("Expected MSE refusal");
      return { kind: "REFUSED" as const, refusal: rejected.admissionRefusal };
    },
  }, async () => {
    dispatchCount++;
    throw new Error("MSE refusal illegally dispatched");
  });
  assert.equal(refused.kind, "ADMISSION_REFUSED");
  assert.equal(dispatchCount, 1);
  assert.equal(authorizedCalls, 3);
  assert.equal(ledger.lookup(business("scq-q2", "different-intent")), undefined);
  process.stdout.write("PASS: subscription seat+addon MSE admission -> SCQ durable receipt/replay, missing-addon refusal, zero illicit simulated dispatches\n");
} finally {
  ledger?.close();
  store?.close();
  rmSync(dir, { recursive: true, force: true });
}

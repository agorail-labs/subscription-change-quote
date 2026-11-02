/**
 * Adversarial multi-unit outcome/finality characterization using the real
 * MSE v0.4 reference implementation. This is an MSE SIMULATION, not SCQ's
 * provider execution and not an atomic multi-provider coordinator.
 */
import assert from "node:assert/strict";
import { ReferenceProvider } from "../../mse-dependency/src/core/reference-provider.ts";

const effects = (unitRef: string, amount: number) => [{
  effectId: unitRef + ":effect",
  type: "subscription:financial_or_entitlement_effect",
  value: { type: "number" as const, value: amount },
  guarantee: { mode: "UNKNOWN" as const },
}];
const units = [
  { unitRef: "seat-change", unitLocator: { scopeRef: "subscription:1", unitKey: "seat" }, transition: { action: "CHANGE_QUANTITY", quantity: 120 }, effects: effects("seat-change", 120) },
  { unitRef: "addon-change", unitLocator: { scopeRef: "subscription:1", unitKey: "addon" }, transition: { action: "CHANGE_QUANTITY", quantity: 120 }, effects: effects("addon-change", 120) },
  { unitRef: "invoice-ledger", unitLocator: { scopeRef: "billing:1", unitKey: "invoice" }, transition: { action: "INVOICE" }, effects: effects("invoice-ledger", 30) },
  { unitRef: "support-entitlement", unitLocator: { scopeRef: "subscription:1", unitKey: "support" }, transition: { action: "ENABLE" }, effects: effects("support-entitlement", 1) },
];
let effectDispatches = 0;
let reconciliations = 0;
const provider = new ReferenceProvider(
  proposal => ({ target: proposal.target, units, admissionRelations: [], commitConsistency: "NONE" }),
  {
    onCommit: (_q, u) => {
      effectDispatches++;
      return u.effects;
    },
    onReceipt: (_q, unitResults) => unitResults
      .filter(u => u.unitRef === "seat-change" && u.outcome === "APPLIED")
      .flatMap(u => (u.committedEffects ?? []).map(e => ({
        effectId: e.effectId,
        unitRef: u.unitRef,
        finality: "PENDING" as const,
      }))),
    // Omitting the support-entitlement receipt deliberately forces UNKNOWN.
  },
  {
    shouldTimeout: (_request, _quote, unit) => unit.unitRef === "invoice-ledger",
    reconciliationOutcome: () => { reconciliations++; return "REFUSED"; },
  },
);
const quote = provider.quote({
  proposalId: "multi-unit-partial",
  target: { subscriptionId: "sub_1" },
  change: units.map(u => u.transition),
});
const response = provider.commit({
  quoteId: quote.quoteId,
  acceptanceConstraints: [{
    effectId: "addon-change:effect",
    operator: "==",
    // Deliberately false: offered effect is 120, not 999.
    value: { type: "number", value: 999 },
  }],
});
assert.equal(response.kind, "COMMIT_RESULT");
if (response.kind !== "COMMIT_RESULT") throw Error("MSE commit response missing");
const outcomes = new Map(response.commitResult.unitResults.map(u => [u.unitRef, u.outcome]));
assert.equal(outcomes.get("seat-change"), "APPLIED");
assert.equal(outcomes.get("addon-change"), "REFUSED");
assert.equal(outcomes.get("invoice-ledger"), "INDETERMINATE");
assert.equal(outcomes.get("support-entitlement"), "APPLIED");
assert.equal(effectDispatches, 2, "only the units actually applied simulate committed effects");
assert.equal(response.commitResult.aggregateHint, "PARTIAL");

const receipt = provider.receipt(quote.quoteId);
const finalities = new Map(receipt.effectReceipts.map(e => [e.effectId, e.finality]));
assert.equal(finalities.get("seat-change:effect"), "PENDING");
assert.equal(finalities.get("support-entitlement:effect"), "UNKNOWN");
assert.equal(finalities.has("addon-change:effect"), false);
assert.equal(finalities.has("invoice-ledger:effect"), false);
assert.equal([...finalities.values()].includes("FINAL"), false, "no simulated pending or unknown effect may become final by default");
const unresolved = response.commitResult.unitResults.find(u => u.unitRef === "invoice-ledger");
assert.equal(unresolved?.outcome, "INDETERMINATE");
const correlationId = unresolved?.reconciliation?.correlationId;
assert.ok(correlationId);
assert.equal(provider.reconcile(correlationId), "REFUSED");
assert.equal(reconciliations, 1);
assert.equal(effectDispatches, 2, "reconciliation is a status read, never a dispatch retry");
console.log("PASS: MSE four-unit APPLIED/REFUSED/INDETERMINATE partial simulation, PENDING/UNKNOWN finality; reconciliation performs no dispatch");

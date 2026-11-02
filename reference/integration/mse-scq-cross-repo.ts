/**
 * Cross-repository simulated MSE v0.4 -> SCQ v0.7 integration fixture.
 *
 * This script uses the ACTUAL MSE admission-only evaluator/validator source
 * pinned by CI checkout, and the ACTUAL SCQ durable coordinator/SQLite store.
 * The binding's historical-state reader, customer authorization and provider
 * operation remain simulated. No live provider mutation occurs.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateAdmissionOnly } from "../../mse-dependency/src/core/admission-only.ts";
import { assertAdmissionReportWellFormed } from "../../mse-dependency/src/core/validate.ts";
import { DurableQuoteStore } from "../src/store/durable-store.ts";
import { DurableMutationCoordinator } from "../src/store/mutation-coordinator.ts";
import { BusinessIntentLedger, MseScqIntentBridge } from "../src/integration/business-intent-bridge.ts";
import { makeReceipt, makeStoredQuote } from "../tests/helpers/durable-fixtures.ts";

const base = fileURLToPath(new URL("../../mse-dependency/examples/retail/", import.meta.url));
const passFixture = JSON.parse(readFileSync(join(base, "amended-quote.fixture.json"), "utf8"));
const refusalFixture = JSON.parse(readFileSync(join(base, "admission-refusal.fixture.json"), "utf8"));
const report = passFixture.commitResponse.admissionReport;
const proposal = {
  proposalId: report.proposalId,
  target: passFixture.quote.target,
  change: { transitions: passFixture.quote.units.map((u: any) => u.transition) },
};
const business = (quoteId: string, id: string) => ({
  tenantId: "tenant-1", businessIntentId: id,
  actorId: "customer-7", authorizationRef: "approved-operation-42",
  provider: "chargebee", site: "simulated", subscriptionId: "sub_1",
  operation: { change: "CHANGE_QUANTITY", itemId: "item_1", seats: 120 },
  quoteId,
});
const mutation = (quoteId: string) => ({
  quoteId, subscriptionId: "sub_1", provider: "chargebee", site: "simulated",
  idempotencyKey: "unique-" + quoteId,
  request: { subscription_items: [{ item_price_id: "item_1", quantity: 120 }] },
});
function actualMsePass() {
  return evaluateAdmissionOnly(proposal, passFixture.quote, () => ({
    coverage: report.coverage,
    failures: [],
    stateRef: report.stateRef,
  }), new Date(report.evaluatedAt));
}
function actualMseRefusal() {
  const r = refusalFixture.commitResponse.admissionRefusal;
  return evaluateAdmissionOnly(refusalFixture.proposal, refusalFixture.quote, () => ({
    coverage: r.coverage, failures: r.failures, stateRef: r.stateRef,
  }), new Date(r.evaluatedAt));
}

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
  let passedValidations = 0;
  const hooks = {
    authorize: async () => { authorizedCalls++; },
    admission: async () => {
      const decision = actualMsePass();
      assert.equal(decision.kind, "ADMISSION_PASSED");
      return { kind: "PASSED" as const, report: decision.kind === "ADMISSION_PASSED" ? decision.admissionReport : undefined };
    },
    validatePassedAdmission: (candidate: unknown) => {
      assertAdmissionReportWellFormed(passFixture.quote, proposal, candidate as any);
      passedValidations++;
    },
    validateCommercial: async () => {
      // This example uses a simulated, side-effect-free SCQ preflight.
      // It does not certify Chargebee's live update mechanism.
      assert.ok(store!.get("scq-q1"));
    },
  };

  const first = await bridge.execute(business("scq-q1", "intent-1"), mutation("scq-q1"), hooks, async () => {
    dispatchCount++;
    return { type: "receipt", receipt: makeReceipt("scq-q1") };
  });
  assert.equal(first.kind, "EXECUTED");
  assert.equal(passedValidations, 1);
  const afterRequote = await bridge.execute(business("scq-q2", "intent-1"), mutation("scq-q2"), hooks, async () => {
    dispatchCount++;
    throw new Error("Requote illegally dispatched");
  });
  assert.equal(afterRequote.kind, "EXISTING_RECEIPT");
  assert.equal(dispatchCount, 1);

  const refusal = await bridge.execute(business("scq-q2", "intent-new"), mutation("scq-q2"), {
    ...hooks,
    admission: async () => {
      const decision = actualMseRefusal();
      assert.equal(decision.kind, "ADMISSION_REFUSED");
      return { kind: "REFUSED" as const, refusal: decision.kind === "ADMISSION_REFUSED" ? decision.admissionRefusal : undefined };
    },
  }, async () => {
    dispatchCount++;
    throw new Error("MSE refusal illegally dispatched");
  });
  assert.equal(refusal.kind, "ADMISSION_REFUSED");
  assert.equal(dispatchCount, 1);
  assert.equal(authorizedCalls, 3);
  assert.equal(ledger.lookup(business("scq-q2", "intent-new")), undefined);
  process.stdout.write("PASS: actual MSE admission validation + real SCQ durable dispatch/replay + actual MSE refusal; zero illicit dispatches (SIMULATED provider)\n");
} finally {
  ledger?.close();
  store?.close();
  rmSync(dir, { recursive: true, force: true });
}

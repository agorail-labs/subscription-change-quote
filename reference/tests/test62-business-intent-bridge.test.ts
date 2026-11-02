import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DurableQuoteStore } from "../src/store/durable-store.js";
import { DurableMutationCoordinator } from "../src/store/mutation-coordinator.js";
import {
  BusinessIntentConflict, BusinessIntentLedger, MseScqIntentBridge,
  type BusinessIntent, type BridgeHooks,
} from "../src/integration/business-intent-bridge.js";
import { makeReceipt, makeStoredQuote } from "./helpers/durable-fixtures.js";

// All cases use real SQLite/SCQ ledgers and SIMULATED provider dispatch.
// No Chargebee/other network operation, no atomic-provider-write claim.
const dirs: string[] = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "agorail-intent-"));
  dirs.push(dir);
  const storePath = join(dir, "scq.sqlite");
  const intentPath = join(dir, "intent.sqlite");
  const store = new DurableQuoteStore(storePath, { recoveryGraceMs: 0 });
  const ledger = new BusinessIntentLedger(intentPath);
  const bridge = new MseScqIntentBridge(ledger, new DurableMutationCoordinator(store));
  return { storePath, intentPath, store, ledger, bridge };
}
const business = (quoteId = "q1", businessIntentId = "approved-action-1"): BusinessIntent => ({
  tenantId: "tenant-a", businessIntentId, actorId: "customer-7",
  authorizationRef: "authorization-immutable-1", provider: "chargebee",
  site: "site-1", subscriptionId: "sub_1",
  operation: { action: "CHANGE_QUANTITY", itemId: "item_1", quantity: 120 },
  quoteId,
});
const mutation = (quoteId = "q1") => ({
  quoteId, subscriptionId: "sub_1", provider: "chargebee", site: "site-1",
  request: { replace_items_list: false, items: [{ id: "item_1", quantity: 120 }] },
  idempotencyKey: `provider-key-${quoteId}`,
});
const admission = { quoteId: "mse-q1", proposalId: "mse-p1", evaluatedAt: "2026-11-01T00:00:00.000Z", failures: [], coverage: [{ relationId: "addon-dep", status: "PASSED" }] };
function hooks(overrides: Partial<BridgeHooks> = {}): BridgeHooks {
  return {
    authorize: async () => {},
    admission: async () => ({ kind: "PASSED", report: admission }),
    // Real deployments MUST call MSE v0.4 assertAdmissionReportWellFormed
    // on the exact quoted proposal; this fixture only checks handoff.
    validatePassedAdmission: r => assert.equal(r, admission),
    validateCommercial: async () => {},
    ...overrides,
  };
}

test("v0.7-intent-01: simultaneous requests with one business intent authorize at most one SCQ dispatch", async () => {
  const { store, ledger, bridge } = setup();
  store.put(makeStoredQuote("q1"));
  let dispatches = 0;
  let release!: () => void;
  const paused = new Promise<void>(resolve => { release = resolve; });
  const first = bridge.execute(business(), mutation(), hooks(), async () => {
    dispatches++;
    await paused;
    return { type: "receipt", receipt: makeReceipt("q1") };
  });
  const second = await bridge.execute(business(), mutation(), hooks(), async () => {
    dispatches++;
    return { type: "receipt", receipt: makeReceipt("q1") };
  });
  assert.equal(second.kind, "BLOCKED");
  assert.equal(dispatches, 1);
  release();
  const done = await first;
  assert.equal(done.kind, "EXECUTED");
  const replay = await bridge.execute(business("q-new"), mutation("q-new"), hooks(), async () => {
    dispatches++; throw new Error("should never dispatch");
  });
  assert.equal(replay.kind, "EXISTING_RECEIPT");
  if (replay.kind === "EXISTING_RECEIPT") assert.equal(replay.originalQuoteId, "q1");
  assert.equal(dispatches, 1);
  ledger.close(); store.close();
});

test("v0.7-intent-02: restart and agent re-quote preserve original receipt and block new provider operation", async () => {
  const x = setup();
  x.store.put(makeStoredQuote("q1"));
  let dispatches = 0;
  await x.bridge.execute(business(), mutation(), hooks(), async () => {
    dispatches++;
    return { type: "receipt", receipt: makeReceipt("q1") };
  });
  x.ledger.close(); x.store.close();
  const store = new DurableQuoteStore(x.storePath, { recoveryGraceMs: 0 });
  const ledger = new BusinessIntentLedger(x.intentPath);
  const bridge = new MseScqIntentBridge(ledger, new DurableMutationCoordinator(store));
  const replay = await bridge.execute(business("q2"), mutation("q2"), hooks(), async () => {
    dispatches++;
    return { type: "receipt", receipt: makeReceipt("q2") };
  });
  assert.equal(replay.kind, "EXISTING_RECEIPT");
  assert.equal(dispatches, 1);
  ledger.close(); store.close();
});

test("v0.7-intent-03: altered authorization, actor, provider, subscription or operation refuses reuse", async () => {
  const { store, ledger, bridge } = setup();
  store.put(makeStoredQuote("q1"));
  await bridge.execute(business(), mutation(), hooks(), async () => ({
    type: "receipt", receipt: makeReceipt("q1"),
  }));
  for (const edited of [
    { authorizationRef: "new-authority" },
    { actorId: "attacker" },
    { provider: "other-provider" },
    { subscriptionId: "sub-other" },
    { operation: { action: "CHANGE_QUANTITY", itemId: "item_1", quantity: 121 } },
  ]) {
    await assert.rejects(
      () => bridge.execute({ ...business("q2"), ...edited }, mutation("q2"), hooks(), async () => {
        throw new Error("no dispatch");
      }),
      (e: unknown) => e instanceof BusinessIntentConflict,
    );
  }
  ledger.close(); store.close();
});

test("v0.7-intent-04: lost provider response remains blocked across restart, even with a fresh quote/key", async () => {
  const x = setup();
  x.store.put(makeStoredQuote("q1"));
  let dispatches = 0;
  await assert.rejects(() => x.bridge.execute(business(), mutation(), hooks(), async () => {
    dispatches++;
    throw new Error("simulated lost response after provider effect");
  }), /simulated lost response/);
  assert.equal(x.store.attemptsForQuote("q1")[0].state, "INDETERMINATE");
  x.ledger.close(); x.store.close();
  const store = new DurableQuoteStore(x.storePath, { recoveryGraceMs: 0 });
  const ledger = new BusinessIntentLedger(x.intentPath);
  const bridge = new MseScqIntentBridge(ledger, new DurableMutationCoordinator(store));
  const replay = await bridge.execute(business("q2"), mutation("q2"), hooks(), async () => {
    dispatches++;
    throw new Error("must not dispatch");
  });
  assert.equal(replay.kind, "BLOCKED");
  assert.equal(dispatches, 1);
  ledger.close(); store.close();
});

test("v0.7-intent-05: MSE refusal and SCQ commercial refusal both cause zero dispatches and no intent claim", async () => {
  const { store, ledger, bridge } = setup();
  store.put(makeStoredQuote("q1"));
  let dispatches = 0;
  const refusal = { failures: [{ relationId: "addon-dep", witness: { disposition: "COMPLETE" } }] };
  const rejected = await bridge.execute(business(), mutation(), hooks({
    admission: async () => ({ kind: "REFUSED", refusal }),
  }), async () => { dispatches++; throw new Error("must not dispatch"); });
  assert.equal(rejected.kind, "ADMISSION_REFUSED");
  assert.equal(ledger.lookup(business()), undefined);
  await assert.rejects(() => bridge.execute(business(), mutation(), hooks({
    validateCommercial: async () => { throw new Error("unsafe full-list provider replacement"); },
  }), async () => { dispatches++; throw new Error("must not dispatch"); }), /unsafe full-list/);
  assert.equal(ledger.lookup(business()), undefined);
  assert.equal(dispatches, 0);
  ledger.close(); store.close();
});

test("v0.7-intent-06: identical payload with separately approved business intent IDs is not falsely deduplicated", () => {
  const { store, ledger } = setup();
  const a = business("q1", "approved-a");
  const b = business("q2", "approved-b");
  assert.equal(ledger.claim(a, admission).acquired, true);
  assert.equal(ledger.claim(b, admission).acquired, true);
  assert.equal(ledger.claim(a, admission).acquired, false);
  ledger.close(); store.close();
});

test("v0.7-intent-07: untrusted or malformed business-operation identity fails closed", () => {
  const { store, ledger } = setup();
  assert.throws(() => ledger.claim({ ...business(), operation: { qty: undefined } }, admission), BusinessIntentConflict);
  assert.throws(() => ledger.claim({ ...business(), actorId: " " }, admission), BusinessIntentConflict);
  assert.throws(() => ledger.claim({ ...business(), operation: Number.NaN }, admission), BusinessIntentConflict);
  ledger.close(); store.close();
});

test("v0.7-intent-08: separate processes race one intent and only one wins durable claim", async () => {
  const x = setup();
  x.ledger.close();
  x.store.close();
  const child = new URL("./helpers/business-intent-child.js", import.meta.url).pathname;
  function claim(quoteId: string): Promise<{ acquired: boolean; originalQuoteId: string }> {
    return new Promise((resolve, reject) => {
      const p = spawn(process.execPath, [child, x.intentPath, quoteId], { stdio: ["ignore", "pipe", "pipe"] });
      let out = ""; let err = "";
      p.stdout.setEncoding("utf8").on("data", data => { out += data; });
      p.stderr.setEncoding("utf8").on("data", data => { err += data; });
      p.on("error", reject);
      p.on("close", code => {
        if (code !== 0) return reject(Error("Child claim failed " + code + ": " + err));
        try { resolve(JSON.parse(out.trim())); } catch (e) { reject(e); }
      });
    });
  }
  const claims = await Promise.all([claim("q-child-a"), claim("q-child-b")]);
  assert.equal(claims.filter(c => c.acquired).length, 1);
  assert.equal(claims[0].originalQuoteId, claims[1].originalQuoteId);
  const after = new BusinessIntentLedger(x.intentPath);
  assert.equal(after.lookup({
    tenantId: "tenant-x", businessIntentId: "single-customer-approval",
    actorId: "customer-a", authorizationRef: "approval-a", provider: "chargebee",
    site: "test-site", subscriptionId: "sub_1",
    operation: { action: "CHANGE_QUANTITY", itemId: "addon-1", quantity: 120 }, quoteId: "yet-another-quote",
  })?.quoteId, claims[0].originalQuoteId);
  after.close();
});

test("v0.7-intent-09: process crash between separate intent claim and SCQ beginDispatch fails closed, no blind reissue", async () => {
  const x = setup();
  x.store.put(makeStoredQuote("q1"));
  assert.equal(x.ledger.claim(business(), admission).acquired, true);
  assert.equal(x.store.allAttempts().length, 0, "crash gap has NO SCQ attempt, not proof of non-execution");
  x.ledger.close(); x.store.close();
  const store = new DurableQuoteStore(x.storePath, { recoveryGraceMs: 0 });
  const ledger = new BusinessIntentLedger(x.intentPath);
  const bridge = new MseScqIntentBridge(ledger, new DurableMutationCoordinator(store));
  let dispatchCount = 0;
  const retry = await bridge.execute(business("q-fresh"), mutation("q-fresh"), hooks(), async () => {
    dispatchCount++; return { type: "receipt", receipt: makeReceipt("q-fresh") };
  });
  assert.equal(retry.kind, "BLOCKED");
  assert.equal(dispatchCount, 0);
  assert.equal(store.allAttempts().length, 0, "do not rewrite an unknown gap as confirmed non-execution");
  ledger.close(); store.close();
});

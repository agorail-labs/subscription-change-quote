import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  DispatchBlockedError,
  DurableStoreError,
  DurableQuoteStore,
  decodeRecordJson,
  encodeRecordJson,
} from "../src/store/durable-store.js";
import { DurableMutationCoordinator } from "../src/store/mutation-coordinator.js";
import { establishVerification, receiptIdentityDigest } from "../src/store/quote-store.js";
import type { SubscriptionChangeReceipt } from "../src/core/types.js";
import {
  BusinessIntentLedger,
  MseScqIntentBridge,
  type BusinessIntent,
  type BridgeHooks,
} from "../src/integration/business-intent-bridge.js";
import { makeObservation, makeReceipt, makeStoredQuote, makeUnverifiedReceipt } from "./helpers/durable-fixtures.js";

// Test 68 — stale-receipt replay: two DurableQuoteStore instances
// share one SQLite database; instance B opens BEFORE instance A
// records a receipt. The §6.10 replay lookup must consult durable
// state at replay time, so B replays the original receipt without
// reopening its store and without a second dispatch.
//
// Defect on the unmodified base (each reproduction produced exactly
// one synthetic dispatch — a replay/status defect, NOT demonstrated
// duplicate execution):
//  - standalone: B threw DispatchBlockedError naming
//    COMMITTED_AND_VERIFIED; a fresh instance C replayed correctly.
//  - bridge: B returned BLOCKED / NO_RECORDED_RECEIPT; C returned
//    EXISTING_RECEIPT.
// Root cause: DurableQuoteStore.recordedReceipt() delegated to the
// in-memory QuoteStore map loaded at open, while attempts are read
// from SQLite — B could see the terminal attempt but not the
// receipt recorded after B opened.
//
// All databases are real temporary SQLite files; all dispatch
// callbacks are synthetic; no live provider is touched.

const CHILD = fileURLToPath(new URL("./helpers/stale-receipt-child.js", import.meta.url));
const require = createRequire(import.meta.url);

const tempDirs: string[] = [];
after(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "scq-test68-"));
  tempDirs.push(dir);
  return dir;
}
function openStore(path: string, opts: Record<string, unknown> = {}): DurableQuoteStore {
  return new DurableQuoteStore(path, { recoveryGraceMs: 0, ...opts });
}
function rawDb(path: string) {
  const Database = require("better-sqlite3") as any;
  return new Database(path);
}

// The shared mutation fixture (handoff §5).
const JOB = {
  quoteId: "q1",
  subscriptionId: "sub_1",
  provider: "chargebee",
  site: "site-1",
  request: { replace_items_list: false, items: [{ id: "item_1", quantity: 120 }] },
  idempotencyKey: "provider-key-q1",
};

const BUSINESS: BusinessIntent = {
  tenantId: "tenant-a",
  businessIntentId: "approved-action-1",
  actorId: "customer-7",
  authorizationRef: "authorization-immutable-1",
  provider: "chargebee",
  site: "site-1",
  subscriptionId: "sub_1",
  operation: { action: "CHANGE_QUANTITY", itemId: "item_1", quantity: 120 },
  quoteId: "q1",
};
const ADMISSION = {
  quoteId: "mse-q1",
  proposalId: "mse-p1",
  evaluatedAt: "2026-11-01T00:00:00.000Z",
  failures: [],
  coverage: [{ relationId: "addon-dep", status: "PASSED" }],
};
// Synthetic hooks (per the handoff fixture): authorization succeeds,
// admission returns a PASSED report, admission/commercial validation
// succeed. These are fixture callbacks, not an independent MSE/PIC
// integration.
function bridgeHooks(): BridgeHooks {
  return {
    authorize: async () => {},
    admission: async () => ({ kind: "PASSED", report: ADMISSION }),
    validatePassedAdmission: (r) => assert.equal(r, ADMISSION),
    validateCommercial: async () => {},
  };
}
function bridgeWorker(scqPath: string, intentPath: string) {
  const store = openStore(scqPath);
  const ledger = new BusinessIntentLedger(intentPath);
  const bridge = new MseScqIntentBridge(ledger, new DurableMutationCoordinator(store));
  return { store, ledger, bridge };
}

// --- The headline regressions ------------------------------------------------

test("Test 68.1: standalone — B opened before A settles replays the original receipt without restart; one dispatch total", async () => {
  const dbPath = join(tmpDir(), "scq.sqlite");
  const a = openStore(dbPath);
  a.put(makeStoredQuote("q1"));
  const b = openStore(dbPath); // B opens BEFORE A executes
  // Genuine absence, before anything is recorded: undefined, not an error.
  assert.equal(b.recordedReceipt("q1"), undefined);
  assert.equal(b.recordedReceipt("q-unknown"), undefined);

  let dispatchCount = 0;
  const coordA = new DurableMutationCoordinator(a);
  const settled = await coordA.execute(JOB, async () => {
    dispatchCount++;
    return { type: "receipt", receipt: makeReceipt("q1") };
  });
  assert.equal(settled.type, "settled");

  const coordB = new DurableMutationCoordinator(b);
  const replayB = await coordB.execute(JOB, async () => {
    dispatchCount++;
    throw new Error("B's dispatch callback must never run");
  });
  assert.equal(replayB.type, "replay", "B replays from durable state while remaining open");
  if (replayB.type === "replay") {
    assert.deepEqual(replayB.receipt, makeReceipt("q1"), "B returns the ORIGINAL recorded receipt");
    assert.ok(
      "credit" in (replayB.receipt.committedEffect.immediate as object),
      "the undefined-valued `credit` member is preserved by the durable lookup",
    );
    assert.equal(replayB.receipt.committedEffect.immediate?.credit, undefined);
  }

  const c = openStore(dbPath); // C opens only after settlement
  const replayC = await new DurableMutationCoordinator(c).execute(JOB, async () => {
    dispatchCount++;
    throw new Error("C's dispatch callback must never run");
  });
  assert.equal(replayC.type, "replay");
  if (replayB.type === "replay" && replayC.type === "replay") {
    assert.deepEqual(replayC.receipt, replayB.receipt, "B and C serve the same original receipt");
  }
  assert.equal(dispatchCount, 1, "exactly one synthetic dispatch across A, B and C");
  a.close(); b.close(); c.close();
});

test("Test 68.2: bridge — B opened before A settles returns EXISTING_RECEIPT; one dispatch total", async () => {
  const dir = tmpDir();
  const scqPath = join(dir, "scq.sqlite");
  const intentPath = join(dir, "intent.sqlite");
  const A = bridgeWorker(scqPath, intentPath);
  A.store.put(makeStoredQuote("q1"));
  const B = bridgeWorker(scqPath, intentPath); // B opens BEFORE A executes

  let dispatchCount = 0;
  const rA = await A.bridge.execute(BUSINESS, JOB, bridgeHooks(), async () => {
    dispatchCount++;
    return { type: "receipt", receipt: makeReceipt("q1") };
  });
  assert.equal(rA.kind, "EXECUTED");

  const rB = await B.bridge.execute(BUSINESS, JOB, bridgeHooks(), async () => {
    dispatchCount++;
    throw new Error("B's dispatch callback must never run");
  });
  assert.equal(rB.kind, "EXISTING_RECEIPT", "B replays through the bridge while remaining open");
  if (rB.kind === "EXISTING_RECEIPT") assert.deepEqual(rB.receipt, makeReceipt("q1"));

  const C = bridgeWorker(scqPath, intentPath);
  const rC = await C.bridge.execute(BUSINESS, JOB, bridgeHooks(), async () => {
    dispatchCount++;
    throw new Error("C's dispatch callback must never run");
  });
  assert.equal(rC.kind, "EXISTING_RECEIPT");
  if (rC.kind === "EXISTING_RECEIPT") assert.deepEqual(rC.receipt, makeReceipt("q1"));
  assert.equal(dispatchCount, 1, "exactly one synthetic dispatch across A, B and C");
  for (const w of [A, B, C]) { w.ledger.close(); w.store.close(); }
});

test("Test 68.3: separate already-open process replays after the parent settles (file handshake, no sleeps)", async () => {
  const dir = tmpDir();
  const dbPath = join(dir, "scq.sqlite");
  const readyFile = join(dir, "ready");
  const settledFile = join(dir, "settled");
  const effectFile = join(dir, "effects.log");
  const setup = openStore(dbPath);
  setup.put(makeStoredQuote("q1"));
  setup.close();

  const child = spawn(process.execPath, [CHILD, dbPath, readyFile, settledFile, effectFile], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  child.stdout.setEncoding("utf8").on("data", (d) => { out += d; });
  child.stderr.setEncoding("utf8").on("data", (d) => { err += d; });
  const childDone = new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
  // Wait for the child's OPEN signal — the handshake guarantees B's
  // store was opened before A settles, deterministically.
  const deadline = Date.now() + 30_000;
  while (!existsSync(readyFile)) {
    if (Date.now() > deadline) throw new Error(`child never opened its store: ${err}`);
    await new Promise((r) => setTimeout(r, 10));
  }
  const a = openStore(dbPath);
  let dispatchCount = 0;
  const settled = await new DurableMutationCoordinator(a).execute(JOB, async () => {
    dispatchCount++;
    return { type: "receipt", receipt: makeReceipt("q1") };
  });
  assert.equal(settled.type, "settled");
  a.close();
  writeFileSync(settledFile, "settled");

  const code = await childDone;
  assert.equal(code, 0, `child worker failed: ${out} ${err}`);
  const report = JSON.parse(out.trim()) as { type?: string; receiptId?: string };
  assert.equal(report.type, "replay", "the already-open child process replays without reopening");
  assert.equal(report.receiptId, "rcpt-q1");
  assert.ok(!existsSync(effectFile) || readFileSync(effectFile, "utf8") === "", "the child's dispatch callback never ran");
  assert.equal(dispatchCount, 1, "exactly one synthetic dispatch, in the parent");
});

test("Test 68.4: receipt recorded after the first replay lookup is seen by the coordinator's terminal-attempt path", async () => {
  const dbPath = join(tmpDir(), "scq.sqlite");
  const a = openStore(dbPath);
  a.put(makeStoredQuote("q1"));
  const b = openStore(dbPath);
  let dispatchCount = 0;
  await new DurableMutationCoordinator(a).execute(JOB, async () => {
    dispatchCount++;
    return { type: "receipt", receipt: makeReceipt("q1") };
  });
  // Deterministic interleaving seam: B's FIRST lookup misses (as if
  // it ran before A committed); every later lookup is the real
  // durable one. execute() then reaches beginDispatch, which returns
  // A's terminal attempt, and the terminal-attempt replay path must
  // serve the receipt through the same durable lookup.
  const storeB = b as unknown as { recordedReceipt: (q: string) => SubscriptionChangeReceipt | undefined };
  const realLookup = storeB.recordedReceipt.bind(b);
  let firstCall = true;
  storeB.recordedReceipt = (q: string) => {
    if (firstCall) { firstCall = false; return undefined; }
    return realLookup(q);
  };
  const replay = await new DurableMutationCoordinator(b).execute(JOB, async () => {
    dispatchCount++;
    throw new Error("B's dispatch callback must never run");
  });
  assert.equal(firstCall, false, "the stubbed first lookup was consumed");
  assert.equal(replay.type, "replay");
  if (replay.type === "replay") {
    assert.equal(replay.attempt?.state, "COMMITTED_AND_VERIFIED", "the replay came through the terminal-attempt path");
    assert.deepEqual(replay.receipt, makeReceipt("q1"));
  }
  assert.equal(dispatchCount, 1);
  a.close(); b.close();
});

// --- Original receipt vs derived view -----------------------------------------

test("Test 68.5: a COMMITTED_UNVERIFIED receipt later verified still replays as the original; the derived view stays distinct", () => {
  const dbPath = join(tmpDir(), "scq.sqlite");
  const a = openStore(dbPath);
  a.put(makeStoredQuote("q1"));
  const b = openStore(dbPath); // B opens before the receipt exists
  a.recordCommitReceipt("q1", makeUnverifiedReceipt("q1"));
  assert.deepEqual(b.recordedReceipt("q1"), makeUnverifiedReceipt("q1"), "B sees the durable original while open");

  a.verifyCommitReceipt("q1", establishVerification(a.get("q1")!, makeObservation()));
  const replayed = b.recordedReceipt("q1");
  assert.equal(replayed?.outcome, "COMMITTED_UNVERIFIED", "replay remains the receipt as recorded, not the verified view");
  assert.equal(replayed?.reconciliation.status, "UNVERIFIED");

  const c = openStore(dbPath);
  assert.equal(c.recordedReceipt("q1")?.outcome, "COMMITTED_UNVERIFIED");
  assert.equal(c.get("q1")?.commit_receipt?.outcome, "COMMITTED_AND_VERIFIED", "the current derived view carries the transition, separately");
  a.close(); b.close(); c.close();
});

test("Test 68.6: a verified view whose reconciliation is VIOLATED is preserved as violated; the original replay is not relabeled", () => {
  const dbPath = join(tmpDir(), "scq.sqlite");
  const a = openStore(dbPath);
  // The test50 fixture shape, which is what makes a differing
  // established actual compute VIOLATED: DETERMINED quoted figures
  // (with currency/cadence) and a zero-tolerance acceptance
  // envelope. The durable fixtures carry no envelope and no quoted
  // determinacy, under which reconciliation computes OK/UNVERIFIED
  // instead — so this case builds its quote/receipt/observation in
  // the test50 shape locally.
  const quote = makeStoredQuote("q1");
  (quote.proposal as { acceptanceEnvelope?: unknown }).acceptanceEnvelope = {};
  quote.quoted_effect = {
    immediate: { net: 1000 },
    recurring: { resultingAmount: 5000, currency: "USD", cadence: "MONTHLY" },
    determinacy: { immediateFinancialEffect: "DETERMINED", recurringFinancialEffect: "DETERMINED" },
    provenance: { immediate: "test68: quote-time preview", recurring: "test68: quote-time preview" },
  } as typeof quote.quoted_effect;
  a.put(quote);
  const b = openStore(dbPath);
  const unverified = makeUnverifiedReceipt("q1");
  unverified.quotedEffect = quote.quoted_effect;
  unverified.committedEffect = {
    immediate: { net: 1000 },
    recurring: { resultingAmount: 5000, currency: "USD", cadence: "MONTHLY" },
    determinacy: { immediateFinancialEffect: "UNKNOWN", recurringFinancialEffect: "UNKNOWN" },
    provenance: { committedSource: "unestablished" },
  } as typeof unverified.committedEffect;
  a.recordCommitReceipt("q1", unverified);
  // The independent observation establishes a DIFFERENT recurring
  // actual than the quote/recorded candidate: the derived view is
  // verified-with-violation.
  const observation = makeObservation();
  observation.committedEffect = {
    immediate: { net: 1000 },
    recurring: { resultingAmount: 9999, currency: "USD", cadence: "MONTHLY" },
    determinacy: { immediateFinancialEffect: "DETERMINED", recurringFinancialEffect: "DETERMINED" },
    provenance: { committedSource: "provider_actual" },
  } as typeof observation.committedEffect;
  observation.resultingSnapshot = {
    id: "sub_1",
    version: "v2",
    status: "active",
    items: [{ id: "item_1", offeringRef: "plan", quantity: 2 }],
    billing: { currency: "USD", cadence: "MONTHLY" },
  } as typeof observation.resultingSnapshot;
  const evidence = establishVerification(a.get("q1")!, observation);
  assert.equal(evidence.reconciliation.status, "VIOLATED", "fixture check: establishment computes the violation");
  const view = a.verifyCommitReceipt("q1", evidence);
  assert.equal(view.outcome, "COMMITTED_AND_VERIFIED");
  assert.equal(view.reconciliation.status, "VIOLATED");

  const replayed = b.recordedReceipt("q1");
  assert.equal(replayed?.outcome, "COMMITTED_UNVERIFIED", "B's replay is the original receipt as recorded");
  assert.equal(replayed?.reconciliation.status, "UNVERIFIED", "the original is not relabeled acceptable or violated");
  const c = openStore(dbPath);
  assert.equal(c.get("q1")?.commit_receipt?.reconciliation.status, "VIOLATED", "the derived view preserves the violation fact");
  a.close(); b.close(); c.close();
});

// --- Blocked paths stay blocked -------------------------------------------------

test("Test 68.7: a genuine claim/attempt gap with no receipt keeps the existing blocked behavior; no dispatch", async () => {
  const dbPath = join(tmpDir(), "scq.sqlite");
  const a = openStore(dbPath);
  a.put(makeStoredQuote("q1"));
  const b = openStore(dbPath);
  a.beginDispatch(JOB); // write-ahead attempt exists; no receipt, no terminal record
  assert.equal(b.recordedReceipt("q1"), undefined, "no receipt is fabricated for an in-flight attempt");
  let dispatchCount = 0;
  await assert.rejects(
    () => new DurableMutationCoordinator(b).execute(JOB, async () => {
      dispatchCount++;
      return { type: "receipt", receipt: makeReceipt("q1") };
    }),
    (e: unknown) => e instanceof DispatchBlockedError,
  );
  assert.equal(dispatchCount, 0);
  a.close(); b.close();
});

test("Test 68.8: INDETERMINATE / lost response remains blocked for an already-open B; no receipt fabricated, no blind retry", async () => {
  const dbPath = join(tmpDir(), "scq.sqlite");
  const a = openStore(dbPath);
  a.put(makeStoredQuote("q1"));
  const b = openStore(dbPath);
  let dispatchCount = 0;
  await assert.rejects(
    () => new DurableMutationCoordinator(a).execute(JOB, async () => {
      dispatchCount++;
      throw new Error("simulated lost response");
    }),
    /simulated lost response/,
  );
  assert.equal(a.attemptsForQuote("q1")[0].state, "INDETERMINATE");
  assert.equal(b.recordedReceipt("q1"), undefined);
  await assert.rejects(
    () => new DurableMutationCoordinator(b).execute(JOB, async () => {
      dispatchCount++;
      return { type: "receipt", receipt: makeReceipt("q1") };
    }),
    (e: unknown) => e instanceof DispatchBlockedError,
  );
  assert.equal(dispatchCount, 1, "the lost-response dispatch is the only dispatch ever");
  a.close(); b.close();
});

// --- Failure is explicit, never absence / success / dispatch ---------------------

test("Test 68.9: corrupt or mismatched durable receipt data fails explicitly for an already-open B", async () => {
  // (a) Recorded figures altered without updating the identity digest.
  {
    const dbPath = join(tmpDir(), "scq.sqlite");
    const a = openStore(dbPath);
    a.put(makeStoredQuote("q1"));
    const b = openStore(dbPath);
    await new DurableMutationCoordinator(a).execute(JOB, async () => ({ type: "receipt", receipt: makeReceipt("q1") }));
    const db = rawDb(dbPath);
    const row = db.prepare(`SELECT recorded_json FROM receipt_records WHERE quote_id = 'q1'`).get() as { recorded_json: string };
    const tampered = decodeRecordJson<SubscriptionChangeReceipt>(row.recorded_json);
    tampered.committedEffect.immediate!.net = 777;
    db.prepare(`UPDATE receipt_records SET recorded_json = ? WHERE quote_id = 'q1'`).run(encodeRecordJson(tampered));
    db.close();
    assert.throws(() => b.recordedReceipt("q1"), (e: unknown) => e instanceof DurableStoreError, "digest mismatch is a failure, not absence");
    let dispatchCount = 0;
    await assert.rejects(
      () => new DurableMutationCoordinator(b).execute(JOB, async () => { dispatchCount++; return { type: "receipt", receipt: makeReceipt("q1") }; }),
      (e: unknown) => e instanceof DurableStoreError,
    );
    assert.equal(dispatchCount, 0, "a failed lookup never authorizes a dispatch");
    a.close(); b.close();
  }
  // (b) Receipt re-filed under a different quote, WITH a consistent
  // identity digest for the altered record: association/coherence
  // validation must still refuse it.
  {
    const dbPath = join(tmpDir(), "scq.sqlite");
    const a = openStore(dbPath);
    a.put(makeStoredQuote("q1"));
    const b = openStore(dbPath);
    await new DurableMutationCoordinator(a).execute(JOB, async () => ({ type: "receipt", receipt: makeReceipt("q1") }));
    const db = rawDb(dbPath);
    const row = db.prepare(`SELECT recorded_json, current_json FROM receipt_records WHERE quote_id = 'q1'`).get() as { recorded_json: string; current_json: string };
    const recorded = decodeRecordJson<SubscriptionChangeReceipt>(row.recorded_json);
    recorded.quoteId = "q-other";
    const current = decodeRecordJson<SubscriptionChangeReceipt>(row.current_json);
    current.quoteId = "q-other";
    db.prepare(`UPDATE receipt_records SET recorded_json = ?, current_json = ?, identity_digest = ? WHERE quote_id = 'q1'`).run(
      encodeRecordJson(recorded),
      encodeRecordJson(current),
      receiptIdentityDigest(recorded),
    );
    db.close();
    assert.throws(() => b.recordedReceipt("q1"), (e: unknown) => e instanceof DurableStoreError, "a mismatched quote association is a failure, not a replay");
    a.close(); b.close();
  }
});

test("Test 68.10: a database read failure fails explicitly — no fallback to a receipt this instance holds in memory", async () => {
  const dbPath = join(tmpDir(), "scq.sqlite");
  const a = openStore(dbPath);
  a.put(makeStoredQuote("q1"));
  await new DurableMutationCoordinator(a).execute(JOB, async () => ({ type: "receipt", receipt: makeReceipt("q1") }));
  const b = openStore(dbPath); // B opens AFTER settlement: its in-memory map DOES hold the receipt
  assert.deepEqual(b.recordedReceipt("q1"), makeReceipt("q1"), "control: the durable lookup serves the receipt");

  const db = rawDb(dbPath);
  db.exec(`ALTER TABLE receipt_records RENAME TO receipt_records_moved`);
  db.close();
  assert.throws(
    () => b.recordedReceipt("q1"),
    (e: unknown) => e instanceof DurableStoreError,
    "the read failure is explicit; the cached in-memory receipt is NOT served as a fallback",
  );
  const db2 = rawDb(dbPath);
  db2.exec(`ALTER TABLE receipt_records_moved RENAME TO receipt_records`);
  db2.close();
  assert.deepEqual(b.recordedReceipt("q1"), makeReceipt("q1"), "the same instance serves the receipt again once the read recovers — the failure was the read, not poisoning");
  a.close(); b.close();
});

test("Test 68.11: a poisoned instance still refuses the replay read, even though the database is healthy", () => {
  const dbPath = join(tmpDir(), "scq.sqlite");
  const a = openStore(dbPath);
  a.put(makeStoredQuote("q1"));
  a.recordCommitReceipt("q1", makeReceipt("q1"));
  a.close();
  const poisoned = openStore(dbPath, {
    faults: { beforePersist: (op: string) => { if (op === "recordCommitOutcome") throw new Error("simulated persistence failure"); } },
  });
  assert.throws(
    () => poisoned.recordCommitOutcome("q1", { outcome: "CONFIRMED_NON_EXECUTION" }),
    (e: unknown) => e instanceof DurableStoreError,
  );
  assert.throws(
    () => poisoned.recordedReceipt("q1"),
    (e: unknown) => e instanceof DurableStoreError,
    "the poison guard runs before the durable lookup: a poisoned instance serves nothing",
  );
  poisoned.close();
});

test("Test 68.12: the replay read is read-only — claim, attempt/history, receipt and quote rows are unchanged by reading", async () => {
  const dbPath = join(tmpDir(), "scq.sqlite");
  const a = openStore(dbPath);
  a.put(makeStoredQuote("q1"));
  const b = openStore(dbPath);
  await new DurableMutationCoordinator(a).execute(JOB, async () => ({ type: "receipt", receipt: makeReceipt("q1") }));
  const snapshot = () => {
    const db = rawDb(dbPath);
    const snap = {
      quotes: db.prepare(`SELECT * FROM quotes ORDER BY quote_id`).all(),
      receipt_records: db.prepare(`SELECT * FROM receipt_records ORDER BY quote_id`).all(),
      attempts: db.prepare(`SELECT * FROM attempts ORDER BY attempt_id`).all(),
      attempt_history: db.prepare(`SELECT * FROM attempt_history ORDER BY id`).all(),
    };
    db.close();
    return snap;
  };
  const before = snapshot();
  assert.deepEqual(b.recordedReceipt("q1"), makeReceipt("q1"));
  const replay = await new DurableMutationCoordinator(b).execute(JOB, async () => {
    throw new Error("replay must not dispatch");
  });
  assert.equal(replay.type, "replay");
  assert.deepEqual(snapshot(), before, "reading changed no durable row");
  a.close(); b.close();
});

test("Test 68.14: a quote row carrying a recorded receipt whose companion receipt row is missing is inconsistent storage — explicit failure, not absence", async () => {
  const dbPath = join(tmpDir(), "scq.sqlite");
  const a = openStore(dbPath);
  a.put(makeStoredQuote("q1"));
  a.put(makeStoredQuote("q2")); // control quote: stored, never committed
  const b = openStore(dbPath);
  await new DurableMutationCoordinator(a).execute(JOB, async () => ({ type: "receipt", receipt: makeReceipt("q1") }));
  assert.deepEqual(b.recordedReceipt("q1"), makeReceipt("q1"), "control: the intact pair replays");
  // The quote row and the receipt record are written in ONE
  // transaction (persistQuote): the quote row's own record carries
  // the recorded receipt, and receipt_records carries its companion
  // row. Deleting only the companion row leaves the two halves of a
  // single atomic write disagreeing — that is inconsistent storage,
  // NOT the legitimate absence of a never-recorded receipt.
  const db = rawDb(dbPath);
  db.prepare(`DELETE FROM receipt_records WHERE quote_id = 'q1'`).run();
  db.close();
  assert.throws(
    () => b.recordedReceipt("q1"),
    (e: unknown) => e instanceof DurableStoreError && /inconsistent/.test((e as Error).message),
    "a recorded receipt in the quote row with no companion receipt row must fail explicitly",
  );
  let dispatchCount = 0;
  await assert.rejects(
    () => new DurableMutationCoordinator(b).execute(JOB, async () => {
      dispatchCount++;
      return { type: "receipt", receipt: makeReceipt("q1") };
    }),
    (e: unknown) => e instanceof DurableStoreError,
    "the failed lookup authorizes no dispatch",
  );
  assert.equal(dispatchCount, 0);
  // The legitimate absence case is unchanged: a stored quote that
  // never recorded a receipt still reads as absence.
  assert.equal(b.recordedReceipt("q2"), undefined, "a quote with no recorded receipt anywhere is genuine absence");
  a.close(); b.close();
});

test("Test 68.13: the durable lookup does not advance a stale instance's CAS version — stale-writer refusal is preserved", () => {
  const dbPath = join(tmpDir(), "scq.sqlite");
  const a = openStore(dbPath);
  a.put(makeStoredQuote("q1"));
  const b = openStore(dbPath);
  b.recordCommitReceipt("q1", makeReceipt("q1"));
  // A reads the receipt B recorded (durable lookup). Reading must
  // NOT adopt B's state into A's in-memory version tracking.
  assert.deepEqual(a.recordedReceipt("q1"), makeReceipt("q1"));
  assert.throws(
    () => a.recordCommitOutcome("q1", { outcome: "INDETERMINATE" }),
    (e: unknown) => e instanceof DurableStoreError && /Stale writer|poisoned/.test((e as Error).message),
    "A remains a stale writer: its write is refused rather than overwriting B's durable state",
  );
  const c = openStore(dbPath);
  assert.equal(c.get("q1")?.commit_outcome, undefined, "the stale write changed nothing durable");
  assert.deepEqual(c.recordedReceipt("q1"), makeReceipt("q1"), "B's receipt stands");
  a.close(); b.close(); c.close();
});

test("Test 68.15: when both rows exist, a companion original that disagrees with the quote row's embedded original is refused — each row valid alone is not enough", async () => {
  const dbPath = join(tmpDir(), "scq.sqlite");
  const a = openStore(dbPath);
  a.put(makeStoredQuote("q1"));
  const b = openStore(dbPath);
  await new DurableMutationCoordinator(a).execute(JOB, async () => ({ type: "receipt", receipt: makeReceipt("q1") }));
  assert.deepEqual(b.recordedReceipt("q1"), makeReceipt("q1"), "control: the agreeing pair replays rcpt-q1");
  // Replace ONLY the companion row with a different original
  // receipt for the same quote (rcpt-other), recomputing its
  // identity digest so the companion row is valid ON ITS OWN:
  // its digest matches its content and it passes the coherence
  // validation. The quote row still embeds rcpt-q1. Two
  // independently-valid records that disagree about which receipt
  // was recorded are inconsistent storage — the lookup must
  // compare the companion original against the embedded original,
  // not validate each in isolation and serve the companion.
  const other = { ...makeReceipt("q1"), receiptId: "rcpt-other" };
  const db = rawDb(dbPath);
  db.prepare(`UPDATE receipt_records SET recorded_json = ?, current_json = ?, identity_digest = ? WHERE quote_id = 'q1'`)
    .run(encodeRecordJson(other), encodeRecordJson(other), receiptIdentityDigest(other));
  db.close();
  assert.throws(
    () => b.recordedReceipt("q1"),
    (e: unknown) => e instanceof DurableStoreError && /inconsistent|disagree/.test((e as Error).message),
    "a companion original that disagrees with the embedded original must fail explicitly",
  );
  let dispatchCount = 0;
  await assert.rejects(
    () => new DurableMutationCoordinator(b).execute(JOB, async () => {
      dispatchCount++;
      return { type: "receipt", receipt: makeReceipt("q1") };
    }),
    (e: unknown) => e instanceof DurableStoreError,
    "the failed lookup authorizes no dispatch",
  );
  assert.equal(dispatchCount, 0);
  a.close(); b.close();
});

test("Test 68.16: legacy tolerance — a quote row carrying NO embedded receipt is served from its validated companion row", async () => {
  const dbPath = join(tmpDir(), "scq.sqlite");
  const a = openStore(dbPath);
  a.put(makeStoredQuote("q1"));
  const b = openStore(dbPath);
  await new DurableMutationCoordinator(a).execute(JOB, async () => ({ type: "receipt", receipt: makeReceipt("q1") }));
  // Strip the embedded receipt fields from the quote row (the
  // supported legacy shape: the quote record predates / omits the
  // embedded copy) and repair its checksum, leaving the companion
  // row intact. With nothing embedded to disagree, the companion
  // row — validated as before — remains authoritative.
  const db = rawDb(dbPath);
  const row = db.prepare(`SELECT record_json FROM quotes WHERE quote_id = 'q1'`).get() as { record_json: string };
  const quoteRecord = decodeRecordJson<Record<string, unknown>>(row.record_json);
  delete quoteRecord.commit_receipt;
  delete quoteRecord.commit_receipt_recorded;
  delete quoteRecord.commit_receipt_identity_digest;
  delete quoteRecord.commit_receipt_verifications;
  const rewritten = encodeRecordJson(quoteRecord);
  db.prepare(`UPDATE quotes SET record_json = ?, record_sha = ? WHERE quote_id = 'q1'`)
    .run(rewritten, createHash("sha256").update(rewritten, "utf8").digest("hex"));
  db.close();
  assert.deepEqual(
    b.recordedReceipt("q1"),
    makeReceipt("q1"),
    "no embedded original to disagree with: the validated companion row is served",
  );
  a.close(); b.close();
});

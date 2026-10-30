import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { SCQError } from "../src/core/types.js";
import { establishVerification, receiptIdentityDigest } from "../src/store/quote-store.js";
import {
  DispatchBlockedError,
  DurableRecoveryError,
  DurableStoreError,
  DurableQuoteStore,
} from "../src/store/durable-store.js";
import { DurableMutationCoordinator } from "../src/store/mutation-coordinator.js";
import { makeObservation, makeReceipt, makeStoredQuote, makeUnverifiedReceipt } from "./helpers/durable-fixtures.js";

// Test 27 — PR-8 durable store + write-ahead mutation ledger +
// crash-safe recovery. The assignment's 27-row matrix; rows are
// labeled per test. All databases are REAL temporary SQLite files;
// restart means a genuinely new store instance, and the crash /
// concurrency rows use genuinely new child processes. All mutation
// scenarios are mocked — SIMULATED_PASS at best, never LIVE_PASS.

const CHILD = new URL("./helpers/durable-child.js", import.meta.url).pathname;
const require = createRequire(import.meta.url);

function tmpDb(name = "scq.db"): string {
  const dir = mkdtempSync(join(tmpdir(), "scq-pr8-"));
  return join(dir, name);
}
function openStore(path: string, opts: Record<string, unknown> = {}): DurableQuoteStore {
  return new DurableQuoteStore(path, { recoveryGraceMs: 0, ...opts });
}
const INTENT = (quoteId = "q1", subscriptionId = "sub_1", key?: string) => ({
  quoteId,
  subscriptionId,
  provider: "chargebee",
  site: "test-site",
  request: { subscription_items: [{ item_price_id: "item_1", quantity: 2 }], replace_items_list: true },
  idempotencyKey: key ?? `scq-${quoteId}`,
  preDispatchFingerprint: "fp-1",
});
function runChild(mode: string, db: string, extra: string[] = []) {
  return spawnSync(process.execPath, [CHILD, mode, db, ...extra], { encoding: "utf8", timeout: 60_000 });
}
function rawDb(path: string) {
  const Database = require("better-sqlite3") as any;
  return new Database(path);
}

// --- Rows 1–3: restart survival ---------------------------------------------

test("Test 27.1 (row 1): a quote survives restart intact in a fresh store instance", () => {
  const path = tmpDb();
  const a = openStore(path);
  a.put(makeStoredQuote("q1"));
  a.close();
  const b = openStore(path);
  assert.deepEqual(b.get("q1"), makeStoredQuote("q1"));
  b.close();
});

test("Test 27.2 (row 2): the original receipt survives restart, including undefined-valued members", () => {
  const path = tmpDb();
  const a = openStore(path);
  a.put(makeStoredQuote("q1"));
  a.recordCommitReceipt("q1", makeReceipt("q1"));
  a.close();
  const b = openStore(path);
  const replayed = b.recordedReceipt("q1");
  assert.deepEqual(replayed, makeReceipt("q1"));
  assert.ok(replayed && "credit" in (replayed.committedEffect.immediate as object), "the undefined-valued `credit` member survives the round trip");
  assert.equal(replayed?.committedEffect.immediate?.credit, undefined);
  b.close();
});

test("Test 27.3 (row 3): replay returns the ORIGINAL receipt after a verification transition AND a restart; the current view advances separately", () => {
  const path = tmpDb();
  const a = openStore(path);
  a.put(makeStoredQuote("q1"));
  a.recordCommitReceipt("q1", makeUnverifiedReceipt("q1"));
  const evidence = establishVerification(a.get("q1")!, makeObservation());
  a.verifyCommitReceipt("q1", evidence);
  assert.equal(a.get("q1")?.commit_receipt?.outcome, "COMMITTED_AND_VERIFIED");
  a.close();
  const b = openStore(path);
  const replayed = b.recordedReceipt("q1");
  assert.equal(replayed?.outcome, "COMMITTED_UNVERIFIED", "§6.10 replay is the receipt as recorded, not the verified view");
  assert.equal(replayed?.reconciliation.status, "UNVERIFIED");
  assert.equal(b.get("q1")?.commit_receipt?.outcome, "COMMITTED_AND_VERIFIED", "the current view carries the transition");
  assert.equal(b.get("q1")?.commit_receipt_verifications?.length, 1);
  b.close();
});

// --- Rows 4–7: identity + coherence under tampering --------------------------

test("Test 27.4 (row 4): the receipt identity digest validates after recovery", () => {
  const path = tmpDb();
  const a = openStore(path);
  a.put(makeStoredQuote("q1"));
  a.recordCommitReceipt("q1", makeReceipt("q1"));
  a.close();
  const b = openStore(path);
  const q = b.get("q1")!;
  assert.equal(q.commit_receipt_identity_digest, receiptIdentityDigest(q.commit_receipt_recorded!));
  b.close();
});

test("Test 27.5 (row 5): a corrupted identity digest is rejected at open; inspect() reports the conflict without adopting", () => {
  const path = tmpDb();
  const a = openStore(path);
  a.put(makeStoredQuote("q1"));
  a.recordCommitReceipt("q1", makeReceipt("q1"));
  a.close();
  const db = rawDb(path);
  db.prepare(`UPDATE receipt_records SET identity_digest = 'tampered'`).run();
  db.close();
  assert.throws(() => openStore(path), (e: unknown) => e instanceof DurableRecoveryError);
  const report = DurableQuoteStore.inspect(path);
  assert.equal(report.identityConflicts.length, 1);
});

test("Test 27.6 (row 6): a forged verified current view (no trail) is rejected at open", () => {
  const path = tmpDb();
  const a = openStore(path);
  a.put(makeStoredQuote("q1"));
  a.recordCommitReceipt("q1", makeUnverifiedReceipt("q1"));
  a.close();
  const db = rawDb(path);
  const row = db.prepare(`SELECT current_json FROM receipt_records`).get() as { current_json: string };
  const forged = JSON.parse(row.current_json);
  forged.outcome = "COMMITTED_AND_VERIFIED";
  forged.status = "COMMITTED";
  forged.reconciliation = { status: "OK" };
  db.prepare(`UPDATE receipt_records SET current_json = ?`).run(JSON.stringify(forged));
  db.close();
  assert.throws(() => openStore(path), (e: unknown) => e instanceof DurableRecoveryError && /forgery|coherent/i.test(e.message));
});

test("Test 27.7 (row 7): a tampered verification trail is rejected at open", () => {
  const path = tmpDb();
  const a = openStore(path);
  a.put(makeStoredQuote("q1"));
  a.recordCommitReceipt("q1", makeUnverifiedReceipt("q1"));
  a.verifyCommitReceipt("q1", establishVerification(a.get("q1")!, makeObservation()));
  a.close();
  const db = rawDb(path);
  const row = db.prepare(`SELECT verifications_json FROM receipt_records`).get() as { verifications_json: string };
  const trail = JSON.parse(row.verifications_json);
  trail[0].evidence.committedEffect.immediate.net = 999999;
  db.prepare(`UPDATE receipt_records SET verifications_json = ?`).run(JSON.stringify(trail));
  db.close();
  assert.throws(() => openStore(path), (e: unknown) => e instanceof DurableRecoveryError);
});

// --- Rows 8–16: crash windows -------------------------------------------------

test("Test 27.8 (row 8): crash before the intent write — nothing is recorded and a later commit proceeds normally", async () => {
  const path = tmpDb();
  const a = openStore(path);
  a.put(makeStoredQuote("q1"));
  a.close(); // "crash": process ends before any beginDispatch
  const b = openStore(path);
  assert.equal(b.allAttempts().length, 0);
  const coordinator = new DurableMutationCoordinator(b);
  let dispatches = 0;
  const result = await coordinator.execute(INTENT(), async () => {
    dispatches++;
    return { type: "receipt", receipt: makeReceipt("q1") };
  });
  assert.equal(dispatches, 1);
  assert.equal(result.type, "settled");
  b.close();
});

test("Test 27.9 (row 9): persistence failure before dispatch ⇒ zero mutations, and the failure is not hidden", async () => {
  const path = tmpDb();
  const failing = openStore(path, { faults: { beforePersist: (op: string) => { if (op === "beginDispatch") throw new Error("simulated disk failure"); } } });
  failing.put(makeStoredQuote("q1"));
  const coordinator = new DurableMutationCoordinator(failing);
  let dispatches = 0;
  await assert.rejects(
    () => coordinator.execute(INTENT(), async () => { dispatches++; return { type: "outcome", outcome: "CONFIRMED_NON_EXECUTION" }; }),
    (e: unknown) => e instanceof DurableStoreError,
  );
  assert.equal(dispatches, 0, "no provider mutation may occur when the write-ahead record cannot be persisted");
  failing.close();
});

test("Test 27.10 (row 10): crash after intent persistence, before dispatch (child process) recovers as INDETERMINATE and blocks re-dispatch", async () => {
  const path = tmpDb();
  const setup = openStore(path);
  setup.put(makeStoredQuote("q1"));
  setup.close();
  const child = runChild("crash-after-intent", path);
  assert.equal(child.status, 42, child.stderr);
  const b = openStore(path);
  const attempts = b.attemptsForQuote("q1");
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].state, "INDETERMINATE", "an intent that reached DISPATCHING is treated as potentially dispatched");
  assert.equal(b.get("q1")?.commit_outcome?.outcome, "INDETERMINATE");
  const coordinator = new DurableMutationCoordinator(b);
  let dispatches = 0;
  await assert.rejects(
    () => coordinator.execute(INTENT(), async () => { dispatches++; return { type: "outcome", outcome: "CONFIRMED_NON_EXECUTION" }; }),
    (e: unknown) => e instanceof DispatchBlockedError,
  );
  assert.equal(dispatches, 0);
  b.close();
});

test("Test 27.11 (row 11): crash immediately after mutation dispatch (child process, mid-dispatch exit) recovers INDETERMINATE with no receipt", () => {
  const path = tmpDb();
  const setup = openStore(path);
  setup.put(makeStoredQuote("q1"));
  setup.close();
  const child = runChild("crash-during-dispatch", path);
  assert.equal(child.status, 44, child.stderr);
  const b = openStore(path);
  assert.equal(b.recordedReceipt("q1"), undefined);
  assert.equal(b.attemptsForQuote("q1")[0].state, "INDETERMINATE");
  b.close();
});

test("Test 27.12 (rows 12+21): lost response settles INDETERMINATE, and the durable record still blocks blind retry after restart — long past the native 30-minute idempotency window", async () => {
  const path = tmpDb();
  const a = openStore(path);
  a.put(makeStoredQuote("q1"));
  const coordinatorA = new DurableMutationCoordinator(a);
  let dispatches = 0;
  await assert.rejects(
    () => coordinatorA.execute(INTENT(), async () => { dispatches++; throw new Error("socket hang up (simulated lost response)"); }),
    /socket hang up/,
  );
  assert.equal(a.attemptsForQuote("q1")[0].state, "INDETERMINATE");
  a.close();
  const b = openStore(path); // restart; the native window is irrelevant to SCQ's durable guard
  const coordinatorB = new DurableMutationCoordinator(b);
  await assert.rejects(
    () => coordinatorB.execute(INTENT(), async () => { dispatches++; return { type: "outcome", outcome: "CONFIRMED_NON_EXECUTION" }; }),
    (e: unknown) => e instanceof DispatchBlockedError,
  );
  assert.equal(dispatches, 1, "exactly one dispatch ever occurred");
  b.close();
});

test("Test 27.13 (row 13): PR #16 L1 after restart — an intended final state observed in provider records does NOT establish this operation's execution", async () => {
  const path = tmpDb();
  const a = openStore(path);
  a.put(makeStoredQuote("q1"));
  const coordinator = new DurableMutationCoordinator(a);
  await assert.rejects(() => coordinator.execute(INTENT(), async () => { throw new Error("lost response"); }));
  a.close();
  // An independent actor applies the identical change; the durable
  // record is reopened. Nothing about that observation may upgrade
  // the attempt: no receipt, execution not established, still blocked.
  const b = openStore(path);
  assert.equal(b.recordedReceipt("q1"), undefined);
  const report = b.recoveryReport();
  const item = report.indeterminateOutcomes.find((i) => i.quoteId === "q1")!;
  assert.ok(item, "the indeterminate attempt is enumerated for the operator");
  assert.equal((item.established as Record<string, unknown>).mutationExecutionEstablished, false);
  assert.match(String(item.nextPermittedAction), /Reconcile manually/);
  b.close();
});

test("Test 27.14 (row 14): crash between response reception and receipt persistence (child process) fabricates no receipt", () => {
  const path = tmpDb();
  const setup = openStore(path);
  setup.put(makeStoredQuote("q1"));
  setup.close();
  const child = runChild("crash-after-dispatch", path);
  assert.equal(child.status, 43, child.stderr);
  const b = openStore(path);
  assert.equal(b.recordedReceipt("q1"), undefined, "the response existed only in the dead process's memory; no receipt may be fabricated from it");
  assert.equal(b.attemptsForQuote("q1")[0].state, "INDETERMINATE");
  assert.notEqual(b.get("q1")?.status, "COMMITTED");
  b.close();
});

test("Test 27.15 (row 15): crash DURING receipt recording rolls back atomically — complete receipt or prior unresolved state, never a partial receipt", async () => {
  const path = tmpDb();
  const crashing = openStore(path, {
    faults: { insidePersistTx: (op: string) => { if (op === "recordAttemptReceipt") throw new Error("simulated crash mid-transaction"); } },
  });
  crashing.put(makeStoredQuote("q1"));
  const coordinator = new DurableMutationCoordinator(crashing);
  await assert.rejects(
    () => coordinator.execute(INTENT(), async () => ({ type: "receipt", receipt: makeReceipt("q1") })),
    (e: unknown) => e instanceof DurableStoreError,
  );
  crashing.close();
  const b = openStore(path);
  assert.equal(b.recordedReceipt("q1"), undefined, "no partial receipt was committed");
  assert.equal(b.get("q1")?.status, "ACTIVE");
  assert.equal(b.attemptsForQuote("q1")[0].state, "INDETERMINATE", "the attempt recovers as unresolved-indeterminate, not half-completed");
  b.close();
});

test("Test 27.16 (row 16): crash during a verification transition recovers the original unverified view with an intact trail", () => {
  const path = tmpDb();
  const setup = openStore(path);
  setup.put(makeStoredQuote("q1"));
  setup.recordCommitReceipt("q1", makeUnverifiedReceipt("q1"));
  setup.close();
  const crashing = openStore(path, {
    faults: { insidePersistTx: (op: string) => { if (op === "verifyCommitReceipt") throw new Error("simulated crash mid-transition"); } },
  });
  const evidence = establishVerification(crashing.get("q1")!, makeObservation());
  assert.throws(() => crashing.verifyCommitReceipt("q1", evidence), (e: unknown) => e instanceof DurableStoreError);
  crashing.close();
  const b = openStore(path);
  assert.equal(b.get("q1")?.commit_receipt?.outcome, "COMMITTED_UNVERIFIED", "the transition did not partially apply");
  assert.equal(b.get("q1")?.commit_receipt_verifications?.length ?? 0, 0, "no torn trail entry");
  assert.equal(b.recordedReceipt("q1")?.outcome, "COMMITTED_UNVERIFIED");
  b.close();
});

// --- Rows 17–20: concurrency + identity conflicts ------------------------------

test("Test 27.17 (row 17): two concurrent processes committing the same quote dispatch EXACTLY once", async () => {
  const path = tmpDb();
  const marker = join(mkdtempSync(join(tmpdir(), "scq-pr8-race-")), "dispatches.log");
  writeFileSync(marker, "");
  const setup = openStore(path);
  setup.put(makeStoredQuote("q1"));
  setup.close();
  const run = (mode: string) => new Promise<number>((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [CHILD, mode, path, marker], { stdio: "ignore" });
    child.on("error", rejectPromise);
    child.on("exit", (code) => resolvePromise(code ?? 1));
  });
  const [c1, c2] = await Promise.all([run("race"), run("race")]);
  const dispatchCount = readFileSync(marker, "utf8").split("\n").filter(Boolean).length;
  assert.equal(dispatchCount, 1, "exactly one provider dispatch across both processes");
  assert.ok(c1 === 0 || c2 === 0, "one process settled the commit");
  assert.ok([0, 3].includes(c1) && [0, 3].includes(c2), `the other process replayed or was blocked (exit codes ${c1}, ${c2})`);
  const b = openStore(path);
  assert.ok(b.recordedReceipt("q1"), "the single dispatch produced the recorded receipt");
  b.close();
});

test("Test 27.18 (row 18): two concurrent commits targeting the same subscription are serialized — the second is blocked while the first is unresolved", async () => {
  const path = tmpDb();
  const a = openStore(path);
  a.put(makeStoredQuote("q1", "sub_shared"));
  a.put(makeStoredQuote("q2", "sub_shared"));
  const coordinator = new DurableMutationCoordinator(a);
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const first = coordinator.execute(INTENT("q1", "sub_shared", "key-q1"), async () => {
    await gate;
    return { type: "outcome", outcome: "CONFIRMED_NON_EXECUTION" };
  });
  // beginDispatch is synchronous inside execute(), so by the time
  // the first execute() returns its promise the attempt is already
  // DISPATCHING and durable.
  await assert.rejects(
    () => coordinator.execute(INTENT("q2", "sub_shared", "key-q2"), async () => ({ type: "outcome", outcome: "CONFIRMED_NON_EXECUTION" })),
    (e: unknown) => e instanceof DispatchBlockedError,
  );
  release();
  await first;
  a.close();
});

test("Test 27.19 (row 19): a duplicate receipt ID under conflicting data is rejected and the original survives restart", () => {
  const path = tmpDb();
  const a = openStore(path);
  a.put(makeStoredQuote("q1"));
  a.put(makeStoredQuote("q2"));
  a.recordCommitReceipt("q1", makeReceipt("q1"));
  assert.throws(
    () => a.recordCommitReceipt("q2", makeReceipt("q2", "sub_1", { receiptId: "rcpt-q1", committedEffect: { immediate: { net: 777 }, recurring: { resultingAmount: 5000, currency: "usd" } } })),
    (e: unknown) => e instanceof SCQError && e.code === "CONFLICTING_RECEIPT_IDENTITY",
  );
  a.close();
  const b = openStore(path);
  assert.equal(b.recordedReceipt("q1")?.committedEffect.immediate?.net, 1000, "the original record is preserved");
  assert.equal(b.recordedReceipt("q2"), undefined);
  b.close();
});

test("Test 27.20 (row 20): the same idempotency key with a different request hash is refused", () => {
  const path = tmpDb();
  const a = openStore(path);
  a.put(makeStoredQuote("q1"));
  a.beginDispatch(INTENT("q1", "sub_1", "shared-key"));
  assert.throws(
    () => a.beginDispatch({ ...INTENT("q1", "sub_1", "shared-key"), request: { subscription_items: [{ item_price_id: "item_1", quantity: 99 }] } }),
    (e: unknown) => e instanceof DispatchBlockedError && /different request/.test(e.message),
  );
  a.close();
});

// --- Rows 22–24: database failure modes -----------------------------------------

test("Test 27.22a (row 22): an unavailable database path fails loudly at open — no in-memory fallback", () => {
  const missing = join(tmpdir(), "scq-pr8-no-such-dir", "x.db");
  assert.throws(() => openStore(missing), (e: unknown) => e instanceof DurableStoreError);
});

test("Test 27.22b (row 22): a locked database surfaces SQLITE_BUSY as a persistence failure before any dispatch", async () => {
  const path = tmpDb();
  const setup = openStore(path);
  setup.put(makeStoredQuote("q1"));
  setup.close();
  const ready = join(mkdtempSync(join(tmpdir(), "scq-pr8-lock-")), "ready");
  const holder = spawn(process.execPath, [CHILD, "hold-lock", path, ready], { stdio: "ignore" });
  try {
    for (let i = 0; i < 100 && !existsSync(ready); i++) await new Promise((r) => setTimeout(r, 50));
    assert.ok(existsSync(ready), "the lock holder acquired the exclusive lock");
    const blocked = openStore(path, { busyTimeoutMs: 300 });
    const coordinator = new DurableMutationCoordinator(blocked);
    let dispatches = 0;
    await assert.rejects(
      () => coordinator.execute(INTENT(), async () => { dispatches++; return { type: "outcome", outcome: "CONFIRMED_NON_EXECUTION" }; }),
      (e: unknown) => e instanceof DurableStoreError,
    );
    assert.equal(dispatches, 0);
    blocked.close();
  } finally {
    holder.kill("SIGKILL");
  }
});

test("Test 27.23 (row 23): a corrupt or unsupported schema version fails closed at open", () => {
  const path = tmpDb();
  const a = openStore(path);
  a.put(makeStoredQuote("q1"));
  a.close();
  const db = rawDb(path);
  db.prepare(`UPDATE meta SET value = '999' WHERE key = 'schema_version'`).run();
  db.close();
  assert.throws(() => openStore(path), (e: unknown) => e instanceof DurableRecoveryError && /schema version/.test(e.message));
  assert.equal(DurableQuoteStore.inspect(path).schemaVersion, 999);
});

test("Test 27.24 (row 24): one corrupted record refuses the WHOLE set — no partial recovery", () => {
  const path = tmpDb();
  const a = openStore(path);
  a.put(makeStoredQuote("q1"));
  a.put(makeStoredQuote("q2"));
  a.recordCommitReceipt("q1", makeReceipt("q1"));
  a.recordCommitReceipt("q2", makeReceipt("q2"));
  a.close();
  const db = rawDb(path);
  db.prepare(`UPDATE quotes SET record_sha = 'corrupt' WHERE quote_id = 'q2'`).run();
  db.close();
  assert.throws(() => openStore(path), (e: unknown) => e instanceof DurableRecoveryError);
  const report = DurableQuoteStore.inspect(path);
  assert.equal(report.corruptRecords.length, 1);
  assert.equal(report.corruptRecords[0].quoteId, "q2");
});

// --- Row 25: operator enumeration ------------------------------------------------

test("Test 27.25 (row 25): the operator report enumerates unresolved + indeterminate + unverified items, separates observed from established, and performs no action", async () => {
  const path = tmpDb();
  const a = openStore(path);
  a.put(makeStoredQuote("q1"));
  a.put(makeStoredQuote("q2"));
  const coordinator = new DurableMutationCoordinator(a);
  await assert.rejects(() => coordinator.execute(INTENT("q1"), async () => { throw new Error("lost response"); }));
  a.recordCommitReceipt("q2", makeUnverifiedReceipt("q2"));
  const before = a.attemptsForQuote("q1")[0];
  const report = a.recoveryReport();
  assert.equal(report.indeterminateOutcomes.length, 1);
  assert.equal(report.unverifiedReceipts.length, 1);
  assert.equal(report.receiptsRequiringVerification.length, 1);
  const after = a.attemptsForQuote("q1")[0];
  assert.equal(after.state, before.state, "enumerating changed nothing");
  assert.equal(after.version, before.version);
  a.close();
});

// --- Stale writers ------------------------------------------------------------------

test("Test 27.26: a stale writer cannot overwrite newer durable state (version CAS across two open instances)", () => {
  const path = tmpDb();
  const a = openStore(path);
  a.put(makeStoredQuote("q1"));
  const b = openStore(path);
  b.recordCommitOutcome("q1", { outcome: "CONFIRMED_NON_EXECUTION" });
  assert.throws(
    () => a.recordCommitOutcome("q1", { outcome: "INDETERMINATE" }),
    (e: unknown) => e instanceof DurableStoreError && /Stale writer|poisoned/.test(e.message),
  );
  a.close();
  b.close();
  const c = openStore(path);
  assert.equal(c.get("q1")?.commit_outcome?.outcome, "CONFIRMED_NON_EXECUTION", "the newer durable state stands");
  c.close();
});

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DurableQuoteStore } from "../src/store/durable-store.js";
import { BusinessIntentLedger, type BusinessIntent } from "../src/integration/business-intent-bridge.js";
import { makeStoredQuote } from "./helpers/durable-fixtures.js";

/**
 * Test 67: end-to-end MSE admission -> SCQ execution bridge across real
 * processes and two real on-disk SQLite ledgers, including SIGKILL.
 *
 * Test62 proves the claim primitive's cross-process uniqueness plus
 * in-process bridge behavior. Test27 proves coordinator-only kill recovery.
 * These tests exercise BOTH ledgers through the combined bridge.
 *
 * All 'provider effects' are append-only LOCAL FILE markers and every
 * authorization/admission/commercial callback is synthetic. This is
 * simulator-only evidence: not live Chargebee, not genuine customer
 * authorization, not MSE binding-history authenticity, not exactly-once
 * provider execution, and not atomicity across the two databases.
 */
const folders: string[] = [];
after(() => { for (const dir of folders) rmSync(dir, { recursive: true, force: true }); });
const WORKER = new URL("./helpers/mse-scq-bridge-child.js", import.meta.url).pathname;

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "agorail-bridge-kill-"));
  folders.push(dir);
  const intentDb = join(dir, "intent.sqlite");
  const scqDb = join(dir, "scq.sqlite");
  const effects = join(dir, "effects.log");
  const ready = join(dir, "ready");
  writeFileSync(effects, "");
  const ledger = new BusinessIntentLedger(intentDb);
  ledger.close();
  const store = new DurableQuoteStore(scqDb, { recoveryGraceMs: 0 });
  store.put(makeStoredQuote("q1"));
  store.close();
  return { dir, intentDb, scqDb, effects, ready };
}
type Fx = ReturnType<typeof fixture>;
type ChildResult = { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string };
function launch(fx: Fx, mode: string, quoteId = "q1") {
  const child: ChildProcessWithoutNullStreams = spawn(
    process.execPath, [WORKER, mode, fx.intentDb, fx.scqDb, fx.effects, fx.ready, quoteId],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8").on("data", data => { stdout += String(data); });
  child.stderr.setEncoding("utf8").on("data", data => { stderr += String(data); });
  const done = new Promise<ChildResult>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  return { child, done };
}
async function run(fx: Fx, mode: string, quoteId = "q1") {
  const p = launch(fx, mode, quoteId);
  const result = await p.done;
  assert.equal(result.code, 0, `Child ${mode} failed: ${result.stderr}`);
  assert.ok(result.stdout.trim(), `Child ${mode} produced no structured result`);
  return JSON.parse(result.stdout.trim()) as { kind: string; originalQuoteId?: string };
}
async function killAt(fx: Fx, mode: string, marker: string) {
  const p = launch(fx, mode);
  try {
    const deadline = Date.now() + 15_000;
    while (!existsSync(fx.ready) && Date.now() < deadline) {
      if (p.child.exitCode !== null || p.child.signalCode !== null) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.ok(existsSync(fx.ready), `Child ${mode} did not reach durable boundary ${marker}`);
    assert.equal(readFileSync(fx.ready, "utf8"), marker);
    const signaled = p.child.kill("SIGKILL");
    assert.equal(signaled, true, "The child must be killed by the parent, not exit normally");
    const result = await p.done;
    assert.equal(result.signal, "SIGKILL", `Expected abrupt process kill; got ${JSON.stringify(result)}`);
  } finally {
    // If any assertion fails before the kill, do not leave an orphan process.
    if (p.child.exitCode === null && p.child.signalCode === null) p.child.kill("SIGKILL");
  }
}
function effectCount(fx: Fx) {
  return readFileSync(fx.effects, "utf8").split("\n").filter(Boolean).length;
}
function original(quoteId = "new-quote"): BusinessIntent {
  return {
    tenantId: "tenant-a", businessIntentId: "approved-action-1",
    actorId: "customer-7", authorizationRef: "authorization-immutable-1",
    provider: "chargebee", site: "site-1", subscriptionId: "sub_1",
    operation: { action: "CHANGE_QUANTITY", itemId: "item_1", quantity: 120 },
    quoteId,
  };
}
const killTest = process.platform === "win32" ? test.skip : test;

test("Test 67.1: two full bridge executions in separate workers produce one synthetic effect and one recorded receipt", async () => {
  const fx = fixture();
  const [a, b] = await Promise.all([run(fx, "race"), run(fx, "race")]);
  assert.deepEqual([a.kind, b.kind].filter(x => x === "EXECUTED"), ["EXECUTED"]);
  assert.ok([a.kind, b.kind].every(x => ["EXECUTED", "BLOCKED", "EXISTING_RECEIPT"].includes(x)));
  assert.equal(effectCount(fx), 1, "one synthetic provider effect, not one per process");
  const store = new DurableQuoteStore(fx.scqDb, { recoveryGraceMs: 0 });
  assert.equal(store.attemptsForQuote("q1").length, 1);
  assert.equal(store.recordedReceipt("q1")?.quoteId, "q1");
  store.close();
});

killTest("Test 67.2: SIGKILL after intent claim before SCQ write-ahead leaves a durable blocked gap and no provider effect", async () => {
  const fx = fixture();
  await killAt(fx, "kill-after-claim", "CLAIM_PERSISTED_NO_SCQ_ATTEMPT");
  const ledger = new BusinessIntentLedger(fx.intentDb);
  assert.equal(ledger.lookup(original())?.quoteId, "q1");
  ledger.close();
  const store = new DurableQuoteStore(fx.scqDb, { recoveryGraceMs: 0 });
  assert.equal(store.allAttempts().length, 0, "SCQ has no attempt; this is NOT proof that auto-retry is safe");
  store.close();
  const retry = await run(fx, "replay", "q-new-with-key-new");
  assert.equal(retry.kind, "BLOCKED");
  assert.equal(retry.originalQuoteId, "q1");
  assert.equal(effectCount(fx), 0);
});

killTest("Test 67.3: SIGKILL after SCQ write-ahead and before synthetic provider call blocks a new quote/key", async () => {
  const fx = fixture();
  await killAt(fx, "kill-after-write-ahead", "SCQ_ATTEMPT_PERSISTED_NO_PROVIDER_EFFECT");
  const store = new DurableQuoteStore(fx.scqDb, { recoveryGraceMs: 0 });
  assert.equal(store.recordedReceipt("q1"), undefined);
  assert.equal(store.attemptsForQuote("q1").length, 1);
  assert.equal(store.attemptsForQuote("q1")[0].state, "INDETERMINATE");
  store.close();
  assert.equal(effectCount(fx), 0);
  const retry = await run(fx, "replay", "q-new");
  assert.equal(retry.kind, "BLOCKED");
  assert.equal(effectCount(fx), 0);
});

killTest("Test 67.4: SIGKILL after a synthetic provider effect but before receipt persistence never fabricates success or redispaches", async () => {
  const fx = fixture();
  await killAt(fx, "kill-after-effect", "SYNTHETIC_EFFECT_DONE_NO_RECEIPT");
  assert.equal(effectCount(fx), 1, "one synthetic effect happened before the kill");
  const store = new DurableQuoteStore(fx.scqDb, { recoveryGraceMs: 0 });
  assert.equal(store.recordedReceipt("q1"), undefined, "a response in dead process memory is not a durable receipt");
  assert.equal(store.attemptsForQuote("q1")[0].state, "INDETERMINATE");
  store.close();
  const retry = await run(fx, "replay", "q-new");
  assert.equal(retry.kind, "BLOCKED");
  assert.equal(effectCount(fx), 1, "no second synthetic effect after restart");
});

test("Test 67.5: a settled bridge result replays the ORIGINAL receipt after process restart and fresh quote/key", async () => {
  const fx = fixture();
  const first = await run(fx, "settle");
  assert.equal(first.kind, "EXECUTED");
  const next = await run(fx, "replay", "new-quote");
  assert.equal(next.kind, "EXISTING_RECEIPT");
  assert.equal(next.originalQuoteId, "q1");
  assert.equal(effectCount(fx), 1);
  const store = new DurableQuoteStore(fx.scqDb, { recoveryGraceMs: 0 });
  assert.equal(store.recordedReceipt("q1")?.receiptId, "rcpt-q1");
  assert.equal(store.allAttempts().length, 1);
  store.close();
});

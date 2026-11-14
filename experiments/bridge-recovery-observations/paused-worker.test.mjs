import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ref = process.env.AGORAIL_SCQ_REFERENCE;
assert.ok(ref && isAbsolute(ref), 'Set AGORAIL_SCQ_REFERENCE to the absolute SCQ reference/ directory');
const expectedCommit = '8597852e918fb31e1470e4b5aa3b50fd2df00dcd';
assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ref, encoding: 'utf8' }).trim(), expectedCommit);
assert.equal(execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: ref, encoding: 'utf8' }).trim(), '', 'Use unmodified tracked source');
const load = relative => import(pathToFileURL(join(ref, 'dist', relative)).href);
const { DurableQuoteStore } = await load('src/store/durable-store.js');
const { BusinessIntentLedger } = await load('src/integration/business-intent-bridge.js');
const { makeStoredQuote } = await load('tests/helpers/durable-fixtures.js');
const Sqlite = createRequire(join(ref, 'package.json'))('better-sqlite3');
const worker = fileURLToPath(new URL('./paused-worker.mjs', import.meta.url));

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'agorail-delayed-worker-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'effects.log'), '');
  writeFileSync(join(dir, 'authorization-checks.log'), '');
  const ledger = new BusinessIntentLedger(join(dir, 'intent.sqlite'));
  ledger.close();
  const store = new DurableQuoteStore(join(dir, 'scq.sqlite'), { recoveryGraceMs: 60000 });
  store.put(makeStoredQuote('q1'));
  store.put(makeStoredQuote('q2'));
  store.close();
  return dir;
}
function launch(t, dir, mode, quoteId) {
  const child = spawn(process.execPath, [worker, ref, dir, mode, quoteId], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8').on('data', x => { stdout += x; });
  child.stderr.setEncoding('utf8').on('data', x => { stderr += x; });
  const done = new Promise((resolveDone, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      try {
        assert.equal(code, 0, `Worker failed (${signal}): ${stderr}`);
        resolveDone(JSON.parse(stdout.trim()));
      } catch (error) { reject(error); }
    });
  });
  // A startup failure must not become an unhandled rejection while awaiting ready.
  done.catch(() => {});
  return { child, done };
}
async function ready(dir, child) {
  const deadline = Date.now() + 10000;
  while (!existsSync(join(dir, 'ready'))) {
    assert.equal(child.exitCode, null, 'Worker exited before reaching the pause');
    assert.ok(Date.now() < deadline, 'Worker did not reach the pause');
    await new Promise(resolveWait => setTimeout(resolveWait, 10));
  }
  assert.equal(readFileSync(join(dir, 'ready'), 'utf8'), 'CLAIM_PRESENT_NO_SCQ_ATTEMPT');
  const raw = new Sqlite(join(dir, 'intent.sqlite'));
  try { assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM business_intent_claims').get().n, 1); }
  finally { raw.close(); }
  const store = new DurableQuoteStore(join(dir, 'scq.sqlite'), { recoveryGraceMs: 60000 });
  try { assert.equal(store.allAttempts().length, 0); }
  finally { store.close(); }
}
const effects = dir => readFileSync(join(dir, 'effects.log'), 'utf8').trim().split('\n').filter(Boolean);
const resume = dir => writeFileSync(join(dir, 'resume'), 'resume');
const revoke = dir => writeFileSync(join(dir, 'approval-revoked'), 'withdrawn');
const approvalChecks = dir => readFileSync(join(dir, 'authorization-checks.log'), 'utf8').trim().split('\n').filter(Boolean);

test('Delayed worker: retained claim blocks another caller; original can later dispatch', { timeout: 20000 }, async t => {
  const dir = fixture(t);
  const a = launch(t, dir, 'pause', 'q1');
  await ready(dir, a.child);
  assert.deepEqual(effects(dir), []);
  const b = await launch(t, dir, 'normal', 'q2').done;
  assert.deepEqual(b, { kind: 'BLOCKED', originalQuoteId: 'q1' });
  assert.deepEqual(effects(dir), []);
  resume(dir);
  assert.equal((await a.done).kind, 'EXECUTED');
  assert.deepEqual(effects(dir), ['q1']);
  const replay = await launch(t, dir, 'normal', 'q2').done;
  assert.deepEqual(replay, { kind: 'EXISTING_RECEIPT', originalQuoteId: 'q1' });
  assert.deepEqual(effects(dir), ['q1']);
  console.log('OBSERVATION retained claim: zero attempts at inspection; blocked second caller; resumed worker emitted one effect; original receipt replayed');
});

test('Counterexample ONLY: unsupported claim deletion lets replacement and delayed original both dispatch', { timeout: 20000 }, async t => {
  const dir = fixture(t);
  const a = launch(t, dir, 'pause', 'q1');
  await ready(dir, a.child);
  // Deliberately model a proposed BAD recovery rule on a disposable fixture.
  // No product release/delete API is implemented or invoked.
  const raw = new Sqlite(join(dir, 'intent.sqlite'));
  try {
    assert.equal(raw.prepare('DELETE FROM business_intent_claims WHERE tenant_id=? AND intent_id=?').run('tenant-a', 'approved-action-1').changes, 1);
  } finally { raw.close(); }
  assert.equal((await launch(t, dir, 'normal', 'q2').done).kind, 'EXECUTED');
  assert.deepEqual(effects(dir), ['q2']);
  resume(dir);
  assert.equal((await a.done).kind, 'EXECUTED');
  assert.deepEqual(effects(dir), ['q2', 'q1']);
  const store = new DurableQuoteStore(join(dir, 'scq.sqlite'), { recoveryGraceMs: 60000 });
  try {
    assert.equal(store.allAttempts().length, 2);
    assert.equal(store.recordedReceipt('q1').quoteId, 'q1');
    assert.equal(store.recordedReceipt('q2').quoteId, 'q2');
  } finally { store.close(); }
  console.log('OBSERVATION unsupported deletion: q2 dispatched and settled, then resumed q1 dispatched; two synthetic effects for one business intent');
});

test('Control: approval withdrawn before entry prevents claim, attempt and effect', { timeout: 20000 }, async t => {
  const dir = fixture(t);
  revoke(dir);
  assert.deepEqual(await launch(t, dir, 'normal', 'q1').done, { kind: 'ERROR', code: 'APPROVAL_REVOKED' });
  assert.deepEqual(approvalChecks(dir), ['q1']);
  assert.deepEqual(effects(dir), []);
  const raw = new Sqlite(join(dir, 'intent.sqlite'));
  try { assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM business_intent_claims').get().n, 0); }
  finally { raw.close(); }
  const store = new DurableQuoteStore(join(dir, 'scq.sqlite'), { recoveryGraceMs: 60000 });
  try { assert.equal(store.allAttempts().length, 0); }
  finally { store.close(); }
  console.log('OBSERVATION entry revocation: authorization refused; zero claims, attempts or synthetic effects');
});

test('Counterexample: approval withdrawn while reserved is not rechecked by the current bridge before dispatch', { timeout: 20000 }, async t => {
  const dir = fixture(t);
  const a = launch(t, dir, 'pause', 'q1');
  await ready(dir, a.child);
  assert.deepEqual(approvalChecks(dir), ['q1']);
  revoke(dir);
  // There is no competing worker or takeover. The old approval passed at entry,
  // but customer permission is now withdrawn before SCQ dispatch authorization.
  resume(dir);
  assert.equal((await a.done).kind, 'EXECUTED');
  assert.deepEqual(approvalChecks(dir), ['q1'], 'the bridge did not call its authorization hook again');
  assert.deepEqual(effects(dir), ['q1'], 'current behavior: one effect despite post-reservation revocation');
  const store = new DurableQuoteStore(join(dir, 'scq.sqlite'), { recoveryGraceMs: 60000 });
  try {
    assert.equal(store.allAttempts().length, 1);
    assert.equal(store.recordedReceipt('q1').quoteId, 'q1');
  } finally { store.close(); }
  console.log('OBSERVATION paused revocation GAP: approval withdrawn with zero attempts; resumed worker still dispatched; this is a counterexample, not desired behavior');
});

test('Lost provider response: later revocation neither erases the indeterminate attempt nor proves non-execution', { timeout: 20000 }, async t => {
  const dir = fixture(t);
  assert.deepEqual(await launch(t, dir, 'lost-response', 'q1').done, { kind: 'ERROR', code: 'LOST_RESPONSE' });
  assert.deepEqual(effects(dir), ['q1']);
  // Without changing approval, the business-intent fence already blocks a new quote.
  assert.deepEqual(await launch(t, dir, 'normal', 'q2').done, { kind: 'BLOCKED', originalQuoteId: 'q1' });
  revoke(dir);
  assert.deepEqual(await launch(t, dir, 'normal', 'q2').done, { kind: 'ERROR', code: 'APPROVAL_REVOKED' });
  const store = new DurableQuoteStore(join(dir, 'scq.sqlite'), { recoveryGraceMs: 60000 });
  try {
    assert.equal(store.allAttempts().length, 1);
    assert.equal(store.attemptsForQuote('q1')[0].state, 'INDETERMINATE');
    assert.equal(store.recordedReceipt('q1'), undefined);
  } finally { store.close(); }
  assert.deepEqual(effects(dir), ['q1']);
  console.log('OBSERVATION lost response: one synthetic effect; no receipt; INDETERMINATE remains; no second dispatch after revocation');
});

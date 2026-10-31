import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";

// ---------------------------------------------------------------------------
// Temp-dir cleanup (same discipline as test56).
// ---------------------------------------------------------------------------
const tempDirs: string[] = [];
function trackTempDir(dir: string): string {
  tempDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

import {
  DispatchBlockedError,
  DurableRecoveryError,
  DurableQuoteStore,
  type DurableStoreOptions,
} from "../src/store/durable-store.js";
import { makeStoredQuote } from "./helpers/durable-fixtures.js";

// Test 58 — SCQ P0 (issue #43): durable INDETERMINATE recovery evidence.
//
// FAILING-FIRST provenance: this file was written against the NEW
// structured-evidence contract and run against the UNMODIFIED main
// implementation first (output preserved outside the repo; summary in
// the PR body). On the baseline, resolveAttempt(attemptId, note)
// accepted a free-text string and lifted the dispatch block on the
// operator's assertion alone, and the resolution readers / evidence
// error / schema v2 did not exist — the cases below failed there.
//
// The store's new API is reached through `any` casts in this file so
// the SAME test file compiles and runs against both the baseline
// (failing-first) and the fixed implementation: on the baseline the
// casts let the old (attemptId, string) signature execute and fail
// the assertions; on the fixed code they exercise the real contract.
//
// Every evidence object below is a SIMULATED operator-supplied record
// of an independent provider lookup (mock/durable-store tests only).
// No live provider is touched, and no test equates a recorded
// evidence record with the provider behaviour it describes: the
// store's job is to bind, preserve, and gate on the record.

const require = createRequire(import.meta.url);
function rawDb(path: string): any {
  const Database = require("better-sqlite3") as any;
  return new Database(path);
}
function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function tmpDb(name = "scq.db"): string {
  const dir = trackTempDir(mkdtempSync(join(tmpdir(), "scq-p043-")));
  return join(dir, name);
}
function openStore(path: string, opts: DurableStoreOptions = {}): DurableQuoteStore {
  return new DurableQuoteStore(path, { recoveryGraceMs: 0, ...opts });
}
const INTENT = (quoteId: string, subscriptionId: string, key: string, site = "site-a") => ({
  quoteId,
  subscriptionId,
  provider: "chargebee",
  site,
  request: { subscription_items: [{ item_price_id: "item_1", quantity: 2 }], replace_items_list: true },
  idempotencyKey: key,
  preDispatchFingerprint: "fp-1",
});

function makeIndeterminate(
  store: DurableQuoteStore,
  quoteId = "q1",
  subscriptionId = "sub_1",
  key = "key-1",
): string {
  const att = store.beginDispatch(INTENT(quoteId, subscriptionId, key));
  store.recordAttemptOutcome(att.attemptId, "INDETERMINATE");
  return att.attemptId;
}

/** A fully valid CONFIRMED_NON_EXECUTION evidence record (simulated provider operation-log lookup). */
function validEvidence(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    classification: "CONFIRMED_NON_EXECUTION",
    operatorId: "operator-1",
    evidenceSource: "PROVIDER_OPERATION_LOG",
    evidenceKind: "OPERATION_LOG_NO_RECORD_FOR_KEY",
    evidenceReference: "oplog-ref-1",
    observedAt: new Date().toISOString(),
    observedProviderStateDigest: sha256("test58: observed provider state"),
    reconciliationDecision: "PERMIT_NEW_DISPATCH",
    justification: "Provider operation log queried for this attempt's idempotency key: no operation record exists.",
    ...overrides,
  };
}
function validLandingEvidence(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return validEvidence({
    classification: "CONFIRMED_LANDING",
    evidenceKind: "OPERATION_LOG_RECORD_FOR_KEY",
    evidenceReference: "oplog-ref-landing-1",
    providerOperationId: "op_58_landing",
    reconciliationDecision: "RECONCILE_LANDED_STATE_NO_REDISPATCH",
    justification: "Provider operation log records this attempt's idempotency key as executed; landed state reconciled, no re-dispatch.",
    ...overrides,
  });
}

// New-API accessors (absent on the baseline — the helpers degrade to
// empty results there, and the surrounding assertions fail).
function resolve(store: DurableQuoteStore, attemptId: string, evidence: unknown): any {
  return (store as any).resolveAttempt(attemptId, evidence);
}
function resolutions(store: DurableQuoteStore, attemptId: string): any[] {
  return typeof (store as any).resolutionsForAttempt === "function" ? (store as any).resolutionsForAttempt(attemptId) : [];
}
function getResolution(store: DurableQuoteStore, attemptId: string): any {
  return typeof (store as any).getResolution === "function" ? (store as any).getResolution(attemptId) : undefined;
}
function isEvidenceRefusal(e: unknown): boolean {
  return (e as { code?: string })?.code === "RESOLUTION_EVIDENCE_REFUSED";
}

// ---------------------------------------------------------------------------
// 58.1 Free-text-only operator resolution
// ---------------------------------------------------------------------------

test("Test 58.1: a free-text-only operator resolution is refused and unblocks nothing", () => {
  const store = openStore(tmpDb());
  store.put(makeStoredQuote("q1", "sub_1"));
  const attemptId = makeIndeterminate(store);

  assert.throws(
    () => resolve(store, attemptId, "reconciled, trust me"),
    (e: unknown) => isEvidenceRefusal(e),
    "a string note is not resolution evidence",
  );
  assert.equal(resolutions(store, attemptId).length, 0, "the refusal persists zero resolution rows");
  assert.equal(store.getAttempt(attemptId)?.operatorReviewState, "REQUIRED");
  assert.throws(() => store.beginDispatch(INTENT("q1", "sub_1", "key-2")), DispatchBlockedError, "a different key remains blocked");
  store.close();
});

// ---------------------------------------------------------------------------
// 58.2 Missing / non-evidence source
// ---------------------------------------------------------------------------

test("Test 58.2: CONFIRMED_NON_EXECUTION with a missing or operator-assertion evidence source refuses", () => {
  const store = openStore(tmpDb());
  store.put(makeStoredQuote("q1", "sub_1"));
  const attemptId = makeIndeterminate(store);

  for (const evidenceSource of ["", "OPERATOR_ASSERTION", "FREE_TEXT"]) {
    assert.throws(
      () => resolve(store, attemptId, validEvidence({ evidenceSource })),
      (e: unknown) => isEvidenceRefusal(e),
      `evidenceSource ${JSON.stringify(evidenceSource)} must refuse`,
    );
  }
  assert.equal(resolutions(store, attemptId).length, 0);
  assert.throws(() => store.beginDispatch(INTENT("q1", "sub_1", "key-2")), DispatchBlockedError);
  store.close();
});

// ---------------------------------------------------------------------------
// 58.3 Foreign binding via caller-supplied fields; cross-subscription
// isolation
// ---------------------------------------------------------------------------

test("Test 58.3: caller-supplied binding fields that disagree with the attempt refuse; resolving one subscription never unblocks another", () => {
  const store = openStore(tmpDb());
  store.put(makeStoredQuote("q1", "sub_1"));
  store.put(makeStoredQuote("q2", "sub_2"));
  const att1 = makeIndeterminate(store, "q1", "sub_1", "key-1");
  const att2 = makeIndeterminate(store, "q2", "sub_2", "key-2");

  for (const foreign of [
    { quoteId: "q2" },
    { subscriptionId: "sub_2" },
    { provider: "stripe" },
    { site: "site-b" },
    { attemptId: att2 },
  ]) {
    assert.throws(
      () => resolve(store, att1, validEvidence(foreign)),
      (e: unknown) => isEvidenceRefusal(e),
      `foreign binding field ${JSON.stringify(foreign)} must refuse`,
    );
  }
  assert.equal(resolutions(store, att1).length, 0);

  // Legitimate resolution of sub_1's attempt…
  resolve(store, att1, validEvidence({ evidenceReference: "oplog-ref-sub1" }));
  assert.equal(store.getAttempt(att1)?.operatorReviewState, "RESOLVED");
  // …does NOT touch sub_2's separate INDETERMINATE attempt.
  assert.equal(store.findBlockingAttempt("q2", "sub_2")?.attemptId, att2);
  assert.throws(() => store.beginDispatch(INTENT("q2", "sub_2", "key-2b")), DispatchBlockedError);
  store.close();
});

// ---------------------------------------------------------------------------
// 58.4 Foreign quote / request hash via evidence input
// ---------------------------------------------------------------------------

test("Test 58.4: evidence input carrying a foreign request hash or idempotency key refuses", () => {
  const store = openStore(tmpDb());
  store.put(makeStoredQuote("q1", "sub_1"));
  const attemptId = makeIndeterminate(store);

  for (const foreign of [
    { requestHash: "0".repeat(64) },
    { requestHash: sha256("a different request") },
    { idempotencyKey: "key-OTHER" },
  ]) {
    assert.throws(
      () => resolve(store, attemptId, validEvidence(foreign)),
      (e: unknown) => isEvidenceRefusal(e),
      `foreign field ${JSON.stringify(foreign)} must refuse`,
    );
  }
  assert.equal(resolutions(store, attemptId).length, 0);
  assert.throws(() => store.beginDispatch(INTENT("q1", "sub_1", "key-2")), DispatchBlockedError);
  store.close();
});

// ---------------------------------------------------------------------------
// 58.5 Replayed / tampered evidence
// ---------------------------------------------------------------------------

test("Test 58.5a: the same (evidenceSource, evidenceReference) cannot be replayed for a second attempt", () => {
  const store = openStore(tmpDb());
  store.put(makeStoredQuote("q1", "sub_1"));
  store.put(makeStoredQuote("q2", "sub_2"));
  const att1 = makeIndeterminate(store, "q1", "sub_1", "key-1");
  const att2 = makeIndeterminate(store, "q2", "sub_2", "key-2");

  resolve(store, att1, validEvidence({ evidenceReference: "oplog-ref-shared" }));
  assert.throws(
    () => resolve(store, att2, validEvidence({ evidenceReference: "oplog-ref-shared" })),
    (e: unknown) => isEvidenceRefusal(e),
    "one provider-evidence reference establishes one attempt's resolution, not two",
  );
  assert.equal(resolutions(store, att2).length, 0);
  assert.throws(() => store.beginDispatch(INTENT("q2", "sub_2", "key-2b")), DispatchBlockedError);
  store.close();
});

test("Test 58.5b: a tampered persisted resolution payload refuses the whole store open (fail closed)", () => {
  const path = tmpDb();
  const store = openStore(path);
  store.put(makeStoredQuote("q1", "sub_1"));
  const attemptId = makeIndeterminate(store);
  resolve(store, attemptId, validEvidence());
  assert.equal(resolutions(store, attemptId).length, 1);
  store.close();

  const db = rawDb(path);
  db.prepare(`UPDATE attempt_resolutions SET evidence_payload_json = '{"tampered":true}'`).run();
  db.close();

  assert.throws(
    () => openStore(path),
    (e: unknown) => e instanceof DurableRecoveryError,
    "a resolution whose payload no longer matches its evidence hash adopts nothing",
  );
});

// ---------------------------------------------------------------------------
// 58.6 Stale provider observations
// ---------------------------------------------------------------------------

test("Test 58.6: stale observations and observations predating the attempt refuse", () => {
  const t0 = Date.parse("2026-10-31T12:00:00.000Z");
  let nowMs = t0;
  const store = openStore(tmpDb(), { now: () => new Date(nowMs) });
  store.put(makeStoredQuote("q1", "sub_1"));
  store.put(makeStoredQuote("q2", "sub_2"));
  const att1 = makeIndeterminate(store, "q1", "sub_1", "key-1");
  const att2 = makeIndeterminate(store, "q2", "sub_2", "key-2");

  // (a) observed at attempt creation, resolved 48h later: stale (>24h).
  nowMs = t0 + 48 * 3600 * 1000;
  assert.throws(
    () => resolve(store, att1, validEvidence({ observedAt: new Date(t0).toISOString(), evidenceReference: "oplog-ref-stale" })),
    (e: unknown) => isEvidenceRefusal(e),
    "an observation 48h old at resolution is stale",
  );
  // (b) observed BEFORE the attempt was created (fresh at resolution).
  nowMs = t0;
  assert.throws(
    () => resolve(store, att2, validEvidence({ observedAt: new Date(t0 - 3600 * 1000).toISOString(), evidenceReference: "oplog-ref-predated" })),
    (e: unknown) => isEvidenceRefusal(e),
    "an observation predating the attempt cannot describe it",
  );
  assert.equal(resolutions(store, att1).length, 0);
  assert.equal(resolutions(store, att2).length, 0);
  assert.throws(() => store.beginDispatch(INTENT("q1", "sub_1", "key-1b")), DispatchBlockedError);
  store.close();
});

// ---------------------------------------------------------------------------
// 58.7 Restart durability
// ---------------------------------------------------------------------------

test("Test 58.7: a valid resolution survives restart byte-identically and governs dispatch after reopen", () => {
  const path = tmpDb();
  const a = openStore(path);
  a.put(makeStoredQuote("q1", "sub_1"));
  const attemptId = makeIndeterminate(a);
  resolve(a, attemptId, validEvidence());
  const before = getResolution(a, attemptId);
  assert.ok(before, "a resolution record exists before restart");
  a.close();

  const b = openStore(path);
  const after = getResolution(b, attemptId);
  assert.deepEqual(after, before, "the persisted resolution record is identical after restart, evidence hash included");
  assert.match(after.evidenceHash, /^[0-9a-f]{64}$/);

  const standing = b.beginDispatch(INTENT("q1", "sub_1", "key-1"));
  assert.equal(standing.attemptId, attemptId, "same key returns the standing INDETERMINATE attempt");
  assert.equal(standing.state, "INDETERMINATE", "the standing attempt is never re-armed");
  const fresh = b.beginDispatch(INTENT("q1", "sub_1", "key-2"));
  assert.equal(fresh.state, "DISPATCHING", "a new key may dispatch after restart on the persisted evidence");
  b.close();
});

// ---------------------------------------------------------------------------
// 58.8 Crash during resolution persistence
// ---------------------------------------------------------------------------

test("Test 58.8: a crash inside the resolution transaction persists no resolution and leaves the attempt blocked", () => {
  const path = tmpDb();
  const crashing = openStore(path, {
    faults: {
      insidePersistTx: (op: string) => {
        if (op === "resolveAttempt") throw new Error("simulated crash inside the resolution transaction");
      },
    },
  });
  crashing.put(makeStoredQuote("q1", "sub_1"));
  const attemptId = makeIndeterminate(crashing);
  assert.throws(() => resolve(crashing, attemptId, validEvidence()));
  crashing.close();

  const reopened = openStore(path);
  assert.equal(resolutions(reopened, attemptId).length, 0, "the rolled-back transaction left no resolution row");
  assert.equal(reopened.getAttempt(attemptId)?.state, "INDETERMINATE");
  assert.equal(reopened.getAttempt(attemptId)?.operatorReviewState, "REQUIRED");
  assert.throws(() => reopened.beginDispatch(INTENT("q1", "sub_1", "key-2")), DispatchBlockedError);
  reopened.close();
});

// ---------------------------------------------------------------------------
// 58.9 Concurrent resolution attempts
// (Sequential calls on one synchronous store are the deterministic
// form: the second call runs inside the same immediate-transaction
// discipline a concurrent writer would face.)
// ---------------------------------------------------------------------------

test("Test 58.9: a second terminal resolution for the same attempt refuses; exactly one resolution row exists", () => {
  const store = openStore(tmpDb());
  store.put(makeStoredQuote("q1", "sub_1"));
  const attemptId = makeIndeterminate(store);

  resolve(store, attemptId, validEvidence({ evidenceReference: "oplog-ref-first" }));
  assert.throws(
    () => resolve(store, attemptId, validEvidence({ evidenceReference: "oplog-ref-second" })),
    (e: unknown) => isEvidenceRefusal(e) && /ALREADY_RESOLVED/.test((e as Error).message),
    "an attempt with a terminal resolution cannot be resolved again",
  );
  assert.equal(resolutions(store, attemptId).length, 1, "exactly one resolution row was persisted");
  store.close();
});

// ---------------------------------------------------------------------------
// 58.10 Different-key re-dispatch after an UNRESOLVED record
// ---------------------------------------------------------------------------

test("Test 58.10: an UNRESOLVED resolution record is audit trail only — it lifts no block", () => {
  const store = openStore(tmpDb());
  store.put(makeStoredQuote("q1", "sub_1"));
  const attemptId = makeIndeterminate(store);

  const attempt = resolve(store, attemptId, {
    classification: "UNRESOLVED",
    operatorId: "operator-1",
    justification: "Provider records are ambiguous; the operation log has not yet been obtained.",
  });
  assert.equal(attempt.operatorReviewState, "REQUIRED", "UNRESOLVED does not set the resolved flag");
  assert.equal(resolutions(store, attemptId).length, 1, "the UNRESOLVED record is appended for audit");
  assert.equal(getResolution(store, attemptId)?.classification, "UNRESOLVED");

  const report = store.recoveryReport();
  const item = report.indeterminateOutcomes.find((i) => i.attemptId === attemptId) as any;
  assert.equal(item?.resolution?.classification, "UNRESOLVED");
  assert.match(String(item?.nextPermittedAction), /No automatic re-dispatch is permitted\./);

  assert.throws(() => store.beginDispatch(INTENT("q1", "sub_1", "key-2")), DispatchBlockedError, "new key still blocked");
  assert.throws(() => store.beginDispatch(INTENT("q1", "sub_1", "key-1")), DispatchBlockedError, "same key still blocked");
  store.close();
});

// ---------------------------------------------------------------------------
// 58.11 Matching final state without operation attribution
// ---------------------------------------------------------------------------

test("Test 58.11: a provider-state snapshot that merely matches the intended state is not operation proof for either terminal classification", () => {
  const store = openStore(tmpDb());
  store.put(makeStoredQuote("q1", "sub_1"));
  const attemptId = makeIndeterminate(store);
  // The digest of a snapshot that EXACTLY matches the intended final
  // state — matching state is precisely what must not suffice.
  const snapshotDigest = sha256("test58: snapshot exactly matching the intended final state");

  for (const classification of ["CONFIRMED_NON_EXECUTION", "CONFIRMED_LANDING"] as const) {
    assert.throws(
      () =>
        resolve(
          store,
          attemptId,
          validEvidence({
            classification,
            evidenceSource: "PROVIDER_STATE_SNAPSHOT",
            evidenceKind: "STATE_SNAPSHOT_MATCH",
            evidenceReference: `snapshot-${classification}`,
            observedProviderStateDigest: snapshotDigest,
            ...(classification === "CONFIRMED_LANDING"
              ? { providerOperationId: "op_claimed", reconciliationDecision: "RECONCILE_LANDED_STATE_NO_REDISPATCH" }
              : {}),
          }),
        ),
      (e: unknown) => isEvidenceRefusal(e),
      `a state snapshot must refuse for ${classification}`,
    );
  }
  assert.equal(resolutions(store, attemptId).length, 0);
  assert.throws(() => store.beginDispatch(INTENT("q1", "sub_1", "key-2")), DispatchBlockedError);
  store.close();
});

// ---------------------------------------------------------------------------
// 58.12 Confirmed non-execution supported by adequate evidence (positive)
// ---------------------------------------------------------------------------

test("Test 58.12: valid CONFIRMED_NON_EXECUTION evidence resolves with a bound record and permits new dispatch", () => {
  // Scenario A: a different quote on the same subscription unblocks.
  {
    const store = openStore(tmpDb());
    store.put(makeStoredQuote("q1", "sub_1"));
    store.put(makeStoredQuote("q2", "sub_1"));
    const attemptId = makeIndeterminate(store, "q1", "sub_1", "key-1");
    const attempt = store.getAttempt(attemptId)!;
    const resolved = resolve(store, attemptId, validEvidence());
    assert.equal(resolved.operatorReviewState, "RESOLVED");

    const record = getResolution(store, attemptId);
    assert.ok(record, "a structured resolution record exists");
    assert.equal(record.attemptId, attemptId);
    assert.equal(record.quoteId, "q1");
    assert.equal(record.subscriptionId, "sub_1");
    assert.equal(record.provider, "chargebee");
    assert.equal(record.site, "site-a");
    assert.equal(record.requestHash, attempt.requestHash, "the record is bound to the attempt's request hash");
    assert.equal(record.idempotencyKey, "key-1");
    assert.equal(record.classification, "CONFIRMED_NON_EXECUTION");
    assert.equal(record.operatorId, "operator-1");
    assert.equal(record.evidenceSource, "PROVIDER_OPERATION_LOG");
    assert.equal(record.evidenceReference, "oplog-ref-1");
    assert.match(record.evidenceHash, /^[0-9a-f]{64}$/);
    assert.ok(record.resolvedAt && record.observedAt, "resolution and observation timestamps are recorded");

    const report = store.recoveryReport();
    const item = report.indeterminateOutcomes.find((i) => i.attemptId === attemptId) as any;
    assert.equal(item?.resolution?.classification, "CONFIRMED_NON_EXECUTION");
    assert.equal(item?.resolution?.evidenceHash, record.evidenceHash);

    const other = store.beginDispatch(INTENT("q2", "sub_1", "key-2"));
    assert.equal(other.state, "DISPATCHING", "a different quote on the same subscription is unblocked");
    store.close();
  }
  // Scenario B: a new key on the SAME quote dispatches.
  {
    const store = openStore(tmpDb());
    store.put(makeStoredQuote("q1", "sub_1"));
    const attemptId = makeIndeterminate(store, "q1", "sub_1", "key-1");
    resolve(store, attemptId, validEvidence());
    const fresh = store.beginDispatch(INTENT("q1", "sub_1", "key-2"));
    assert.equal(fresh.state, "DISPATCHING");
    store.close();
  }
});

// ---------------------------------------------------------------------------
// 58.13 Confirmed landing without duplicate execution
// ---------------------------------------------------------------------------

test("Test 58.13: valid CONFIRMED_LANDING evidence reconciles the landed operation — its own quote never re-dispatches, a new quote may proceed", () => {
  const store = openStore(tmpDb());
  store.put(makeStoredQuote("q1", "sub_1"));
  store.put(makeStoredQuote("q2", "sub_1"));
  const attemptId = makeIndeterminate(store, "q1", "sub_1", "key-1");

  const resolved = resolve(store, attemptId, validLandingEvidence());
  assert.equal(resolved.operatorReviewState, "RESOLVED");
  const record = getResolution(store, attemptId);
  assert.equal(record?.classification, "CONFIRMED_LANDING");
  assert.equal(record?.providerOperationId, "op_58_landing");

  const standing = store.beginDispatch(INTENT("q1", "sub_1", "key-1"));
  assert.equal(standing.attemptId, attemptId, "same key returns the standing attempt");
  assert.equal(standing.state, "INDETERMINATE", "the landed attempt is never re-armed");

  assert.throws(
    () => store.beginDispatch(INTENT("q1", "sub_1", "key-2")),
    DispatchBlockedError,
    "a new key on the SAME quote would duplicate the landed operation",
  );
  const other = store.beginDispatch(INTENT("q2", "sub_1", "key-3"));
  assert.equal(other.state, "DISPATCHING", "a different quote is a new, separately authorized change on the reconciled state");
  store.close();
});

// ---------------------------------------------------------------------------
// 58.14 Legacy records
// ---------------------------------------------------------------------------

test("Test 58.14a: a legacy RESOLVED flag with NO resolution record still blocks — it is never silently upgraded", () => {
  const path = tmpDb();
  const a = openStore(path);
  a.put(makeStoredQuote("q1", "sub_1"));
  const attemptId = makeIndeterminate(a);
  a.close();

  // Simulate a pre-fix resolution: the flag alone, set by raw SQL.
  const db = rawDb(path);
  db.prepare(`UPDATE attempts SET operator_review_state='RESOLVED' WHERE attempt_id = ?`).run(attemptId);
  db.close();

  const b = openStore(path);
  assert.equal(b.getAttempt(attemptId)?.operatorReviewState, "RESOLVED", "the legacy flag is preserved as-is");
  assert.equal(resolutions(b, attemptId).length, 0, "no resolution record was fabricated for it");
  assert.equal(b.findBlockingAttempt("q1", "sub_1")?.attemptId, attemptId, "flag-only legacy resolution remains blocking");
  assert.throws(() => b.beginDispatch(INTENT("q1", "sub_1", "key-2")), DispatchBlockedError);
  b.close();
});

test("Test 58.14b: a hand-built v1 database migrates to schema v2 in place — attempts intact and blocking, resolutions table empty", () => {
  const path = tmpDb();
  // Minimal v1 schema, copied from the baseline (schema v1)
  // SCHEMA_STATEMENTS in durable-store.ts.
  const db = rawDb(path);
  db.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  db.exec(`CREATE TABLE quotes (
     quote_id TEXT PRIMARY KEY, subscription_id TEXT NOT NULL, provider TEXT NOT NULL,
     status TEXT NOT NULL, version INTEGER NOT NULL, record_json TEXT NOT NULL,
     record_sha TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  db.exec(`CREATE TABLE receipt_records (
     quote_id TEXT PRIMARY KEY, recorded_json TEXT NOT NULL, current_json TEXT NOT NULL,
     identity_digest TEXT NOT NULL, verifications_json TEXT NOT NULL)`);
  db.exec(`CREATE TABLE attempts (
     attempt_id TEXT PRIMARY KEY, quote_id TEXT NOT NULL, subscription_id TEXT NOT NULL,
     provider TEXT NOT NULL, site TEXT, state TEXT NOT NULL,
     idempotency_key TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL,
     request_json TEXT NOT NULL, pre_dispatch_fingerprint TEXT,
     recovery_classification TEXT, outcome TEXT, details_json TEXT,
     operator_review_state TEXT NOT NULL DEFAULT 'NONE', version INTEGER NOT NULL,
     created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  db.exec(`CREATE TABLE attempt_history (
     id INTEGER PRIMARY KEY AUTOINCREMENT, attempt_id TEXT NOT NULL,
     state TEXT NOT NULL, at TEXT NOT NULL, note TEXT)`);
  db.exec(`CREATE INDEX idx_attempts_quote ON attempts(quote_id)`);
  db.exec(`CREATE INDEX idx_attempts_subscription ON attempts(subscription_id)`);
  db.prepare(`INSERT INTO meta (key, value) VALUES ('schema_version', '1')`).run();
  db.prepare(`INSERT INTO meta (key, value) VALUES ('created_at', '2026-10-29T00:00:00.000Z')`).run();
  db.prepare(
    `INSERT INTO attempts (attempt_id, quote_id, subscription_id, provider, site, state, idempotency_key, request_hash, request_json, pre_dispatch_fingerprint, recovery_classification, outcome, details_json, operator_review_state, version, created_at, updated_at)
     VALUES ('att_legacy_v1', 'q-legacy', 'sub_legacy', 'chargebee', 'site-a', 'INDETERMINATE', 'key-legacy', ?, '{}', NULL, NULL, 'INDETERMINATE', NULL, 'REQUIRED', 1, '2026-10-29T00:00:00.000Z', '2026-10-29T00:00:00.000Z')`,
  ).run(sha256("legacy request"));
  db.close();

  const store = openStore(path);
  const attempt = store.getAttempt("att_legacy_v1");
  assert.ok(attempt, "the pre-existing v1 attempt row is intact after migration");
  assert.equal(attempt.state, "INDETERMINATE");
  assert.equal(store.findBlockingAttempt("q-legacy", "sub_legacy")?.attemptId, "att_legacy_v1", "the migrated attempt still blocks");
  assert.equal(resolutions(store, "att_legacy_v1").length, 0);
  store.close();

  const check = rawDb(path);
  const version = check.prepare(`SELECT value FROM meta WHERE key='schema_version'`).get() as { value: string };
  assert.equal(version.value, "2", "the database was migrated to schema v2");
  const table = check.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='attempt_resolutions'`).get();
  assert.ok(table, "attempt_resolutions exists after migration");
  const count = check.prepare(`SELECT COUNT(*) AS n FROM attempt_resolutions`).get() as { n: number };
  assert.equal(count.n, 0, "migration fabricates no resolution records");
  check.close();
});

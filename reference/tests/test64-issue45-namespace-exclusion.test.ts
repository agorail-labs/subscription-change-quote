import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

// ---------------------------------------------------------------------------
// Temp-dir cleanup (same discipline as test56/test58/test59).
// ---------------------------------------------------------------------------
const tempDirs: string[] = [];
function trackTempDir(dir: string): string {
  tempDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

import { DispatchBlockedError, DurableQuoteStore, type DurableStoreOptions } from "../src/store/durable-store.js";
import * as durableModule from "../src/store/durable-store.js";
import { makeStoredQuote } from "./helpers/durable-fixtures.js";

// Test 64 — Issue #45: namespace-aware durable dispatch exclusion.
//
// The defect (pinned as a LIMITATION by test56.1/56.2 before this
// fix): findBlockingAttempt keyed exclusion on
// (quote_id OR subscription_id) with no provider/site predicate, so
// an unresolved attempt for subscription id X on Chargebee site A
// blocked a valid dispatch for the same id on unrelated site B —
// cross-site/cross-provider availability interference, in the
// fail-closed direction.
//
// The contract pinned here (the brief's mandatory matrix):
//   - identity is the tuple (provider, site, subscription_id);
//   - two attempts in the same tuple remain mutually exclusive, in
//     DISPATCHING and unresolved-INDETERMINATE states alike;
//   - distinct sites / distinct providers proceed independently
//     ONLY when both identities are complete and genuinely
//     distinct ("provably distinct");
//   - a matching quote id blocks regardless of namespace;
//   - missing or malformed provider/site never weakens exclusion;
//   - legacy rows without a complete namespace block conservatively;
//   - idempotency-key and request-hash bindings are untouched
//     (test27–test30 pin them; 64.4 exercises the key path's
//     neighborhood);
//   - stale-quote protection after a reconciled landing applies
//     the same namespace rule (64.8);
//   - the behavior holds across processes sharing one SQLite store
//     (64.9) and across restarts (64.10).
//
// A caller that states no namespace (the optional parameter is
// omitted) gets the historical conservative behavior —
// findBlockingAttempt's direct-call contract is unchanged.
//
// FAILING-FIRST provenance: the independence cases (64.2, 64.3,
// 64.8-namespace half, 64.9 distinct-site half, 64.10 distinct-site
// half) fail against the unmodified store, where every
// cross-namespace dispatch is refused by the other namespace's
// attempt. All provider records are SIMULATED; no live provider is
// touched.

const require = createRequire(import.meta.url);
function rawDb(path: string): any {
  const Database = require("better-sqlite3") as any;
  return new Database(path);
}

function tmpDb(name = "scq.db"): string {
  const dir = trackTempDir(mkdtempSync(join(tmpdir(), "scq-i45-")));
  return join(dir, name);
}
function openStore(path: string, opts: DurableStoreOptions = {}): DurableQuoteStore {
  return new DurableQuoteStore(path, { recoveryGraceMs: 0, ...opts });
}
const INTENT = (quoteId: string, subscriptionId: string, site: string | undefined, key: string, provider = "chargebee") => ({
  quoteId,
  subscriptionId,
  provider,
  ...(site !== undefined ? { site } : {}),
  request: { subscription_items: [{ item_price_id: "item_1", quantity: 2 }], replace_items_list: true },
  idempotencyKey: key,
  preDispatchFingerprint: "fp-1",
});
const NS = (provider: string, site: string) => ({ provider, site });

// ---------------------------------------------------------------------------
// 64.1 Same tuple blocks (DISPATCHING and INDETERMINATE)
// ---------------------------------------------------------------------------

test("Test 64.1 (Issue #45): same provider, same site, same subscription — DISPATCHING and unresolved INDETERMINATE attempts block", () => {
  const store = openStore(tmpDb());
  store.put(makeStoredQuote("q1", "sub_x"));
  store.put(makeStoredQuote("q2", "sub_x"));
  const att = store.beginDispatch(INTENT("q1", "sub_x", "site-a", "key-1"));
  assert.throws(
    () => store.beginDispatch(INTENT("q2", "sub_x", "site-a", "key-2")),
    (e: unknown) => e instanceof DispatchBlockedError && (e.details as any)?.attemptId === att.attemptId,
    "a second dispatch in the same tuple is refused by the DISPATCHING attempt",
  );
  store.recordAttemptOutcome(att.attemptId, "INDETERMINATE");
  assert.throws(
    () => store.beginDispatch(INTENT("q2", "sub_x", "site-a", "key-2")),
    DispatchBlockedError,
    "an unresolved INDETERMINATE attempt in the same tuple keeps blocking",
  );
  assert.equal(store.findBlockingAttempt("q2", "sub_x", undefined, NS("chargebee", "site-a"))?.attemptId, att.attemptId);
  store.close();
});

// ---------------------------------------------------------------------------
// 64.2 Different verified sites proceed independently
// ---------------------------------------------------------------------------

test("Test 64.2 (Issue #45): same provider, different verified sites — independent, including an unresolved INDETERMINATE in one site", () => {
  const store = openStore(tmpDb());
  store.put(makeStoredQuote("q1", "sub_x"));
  store.put(makeStoredQuote("q2", "sub_x"));
  store.put(makeStoredQuote("q3", "sub_x"));
  store.put(makeStoredQuote("q4", "sub_x"));
  const attA = store.beginDispatch(INTENT("q1", "sub_x", "site-a", "key-1"));
  const attB = store.beginDispatch(INTENT("q2", "sub_x", "site-b", "key-2"));
  assert.equal(attB.state, "DISPATCHING", "site-b dispatches while site-a is DISPATCHING");
  // attA settles INDETERMINATE (unresolved); attB settles terminally.
  store.recordAttemptOutcome(attA.attemptId, "INDETERMINATE");
  store.recordAttemptOutcome(attB.attemptId, "CONFIRMED_NON_EXECUTION");
  const attC = store.beginDispatch(INTENT("q3", "sub_x", "site-b", "key-3"));
  assert.equal(attC.state, "DISPATCHING", "site-a's unresolved INDETERMINATE does not block site-b");
  assert.throws(
    () => store.beginDispatch(INTENT("q4", "sub_x", "site-a", "key-4")),
    (e: unknown) => e instanceof DispatchBlockedError && (e.details as any)?.attemptId === attA.attemptId,
    "site-a remains blocked by its own unresolved attempt",
  );
  store.close();
});

// ---------------------------------------------------------------------------
// 64.3 Different verified providers proceed independently
// ---------------------------------------------------------------------------

test("Test 64.3 (Issue #45): different verified providers, same subscription id, same site string — independent", () => {
  const store = openStore(tmpDb());
  store.put(makeStoredQuote("q1", "sub_x"));
  store.put({ ...makeStoredQuote("q2", "sub_x"), provider: "stripe" });
  const attA = store.beginDispatch(INTENT("q1", "sub_x", "site-a", "key-1", "chargebee"));
  const attB = store.beginDispatch(INTENT("q2", "sub_x", "site-a", "key-2", "stripe"));
  assert.equal(attA.state, "DISPATCHING");
  assert.equal(attB.state, "DISPATCHING", "a different provider's namespace is not blocked by the chargebee attempt");
  assert.equal(store.findBlockingAttempt("q9", "sub_x", undefined, NS("stripe", "site-a"))?.attemptId, attB.attemptId);
  assert.equal(store.findBlockingAttempt("q9", "sub_x", undefined, NS("chargebee", "site-a"))?.attemptId, attA.attemptId);
  store.close();
});

// ---------------------------------------------------------------------------
// 64.4 Same quote id, conflicting namespace — refused
// ---------------------------------------------------------------------------

test("Test 64.4 (Issue #45): a matching quote id blocks regardless of the namespace the second dispatch claims", () => {
  const store = openStore(tmpDb());
  store.put(makeStoredQuote("q1", "sub_x"));
  const att = store.beginDispatch(INTENT("q1", "sub_x", "site-a", "key-1"));
  assert.throws(
    () => store.beginDispatch(INTENT("q1", "sub_x", "site-b", "key-2")),
    (e: unknown) => e instanceof DispatchBlockedError && (e.details as any)?.attemptId === att.attemptId,
    "the same quote under a conflicting site claim is refused by its own DISPATCHING attempt",
  );
  assert.equal(
    store.findBlockingAttempt("q1", "sub_x", undefined, NS("chargebee", "site-b"))?.attemptId,
    att.attemptId,
    "the quote branch ignores namespace claims entirely",
  );
  store.close();
});

// ---------------------------------------------------------------------------
// 64.5 Missing provider/site fails closed (both directions)
// ---------------------------------------------------------------------------

test("Test 64.5 (Issue #45): missing or malformed namespace information never weakens exclusion", () => {
  const store = openStore(tmpDb());
  store.put(makeStoredQuote("q1", "sub_x"));
  store.put(makeStoredQuote("q2", "sub_x"));
  store.put(makeStoredQuote("q3", "sub_x"));
  // A site-less dispatch records an attempt with NO site (the
  // legacy-row shape); it blocks every later candidate on the
  // subscription id, namespaced or not.
  const attLegacy = store.beginDispatch(INTENT("q1", "sub_x", undefined, "key-1"));
  assert.equal(attLegacy.site, null, "fixture: the site-less intent recorded a NULL site");
  assert.throws(
    () => store.beginDispatch(INTENT("q2", "sub_x", "site-a", "key-2")),
    DispatchBlockedError,
    "a complete candidate namespace cannot skip a row whose namespace is incomplete",
  );
  store.recordAttemptOutcome(attLegacy.attemptId, "CONFIRMED_NON_EXECUTION");
  // A complete row, then a site-less candidate: also blocked.
  const attA = store.beginDispatch(INTENT("q2", "sub_x", "site-a", "key-2"));
  assert.throws(
    () => store.beginDispatch(INTENT("q3", "sub_x", undefined, "key-3")),
    DispatchBlockedError,
    "a candidate with no site cannot skip a complete row",
  );
  // Direct lookups with incomplete namespaces never skip either.
  assert.equal(store.findBlockingAttempt("q3", "sub_x", undefined, { provider: "chargebee" })?.attemptId, attA.attemptId, "provider-only namespace is incomplete");
  assert.equal(store.findBlockingAttempt("q3", "sub_x", undefined, { provider: "chargebee", site: "" })?.attemptId, attA.attemptId, "empty site is incomplete");
  assert.equal(store.findBlockingAttempt("q3", "sub_x", undefined, { provider: "chargebee", site: "   " })?.attemptId, attA.attemptId, "whitespace-only site is incomplete");
  assert.equal(store.findBlockingAttempt("q3", "sub_x", undefined, {})?.attemptId, attA.attemptId, "empty namespace is incomplete");
  store.close();
});

// ---------------------------------------------------------------------------
// 64.6 A raw legacy row (NULL site, written outside the API) blocks
// ---------------------------------------------------------------------------

test("Test 64.6 (Issue #45): a legacy attempt row with an unknown namespace conservatively blocks a namespaced dispatch", () => {
  const path = tmpDb();
  const store = openStore(path);
  store.put(makeStoredQuote("qL", "sub_legacy"));
  store.put(makeStoredQuote("qM", "sub_legacy"));
  store.close();
  const db = rawDb(path);
  db.prepare(
    `INSERT INTO attempts (attempt_id, quote_id, subscription_id, provider, site, state, idempotency_key, request_hash, request_json, pre_dispatch_fingerprint, recovery_classification, outcome, details_json, operator_review_state, version, created_at, updated_at)
     VALUES ('att_legacy_ns', 'qL', 'sub_legacy', 'chargebee', NULL, 'DISPATCHING', 'key-legacy', 'hash-legacy', '{}', NULL, NULL, NULL, NULL, 'NONE', 1, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`,
  ).run();
  db.close();
  const reopened = openStore(path);
  assert.throws(
    () => reopened.beginDispatch(INTENT("qM", "sub_legacy", "site-a", "key-m")),
    (e: unknown) => e instanceof DispatchBlockedError && (e.details as any)?.attemptId === "att_legacy_ns",
    "the NULL-site legacy row blocks the namespaced candidate — identity cannot be proved distinct",
  );
  reopened.close();
});

// ---------------------------------------------------------------------------
// 64.7 (covered by 64.1/64.2) — see 64.1 INDETERMINATE and 64.2
// cross-site INDETERMINATE assertions.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 64.8 Reconciled landing: stale-quote rules apply per namespace
// ---------------------------------------------------------------------------

const createProviderEvidenceVerifier: any = (durableModule as any).createProviderEvidenceVerifier;
type TestSource = { operationRecords: Map<string, unknown>; reconciliationRecords: Map<string, unknown>; api: any };
function makeSource(): TestSource {
  const src: TestSource = { operationRecords: new Map(), reconciliationRecords: new Map(), api: null };
  src.api = {
    fetchOperationRecord: (q: Record<string, unknown>) => src.operationRecords.get(q.idempotencyKey as string),
    fetchFinancialReconciliation: (q: Record<string, unknown>) => src.reconciliationRecords.get(q.idempotencyKey as string),
  };
  return src;
}
function landedStateFor(subscriptionId: string): Record<string, unknown> {
  return { id: subscriptionId, version: "v2", status: "active", items: [{ id: "item_1", offeringRef: "plan", quantity: 2 }] };
}

test("Test 64.8 (Issue #45): stale-quote protection after a reconciled landing applies only within the landing's namespace", () => {
  const path = tmpDb();
  const source = makeSource();
  const verifier = createProviderEvidenceVerifier(source.api);
  let nowMs = Date.parse("2026-11-02T12:00:00.000Z");
  const nowIso = () => new Date(nowMs).toISOString();
  const store = new DurableQuoteStore(path, { recoveryGraceMs: 0, now: () => new Date(nowMs), evidenceVerifier: verifier } as DurableStoreOptions);

  // Land an attempt in site-a and reconcile it fully.
  store.put(makeStoredQuote("q-land", "sub_x"));
  const att = store.beginDispatch(INTENT("q-land", "sub_x", "site-a", "key-land"));
  nowMs += 60_000;
  store.recordAttemptOutcome(att.attemptId, "INDETERMINATE");
  nowMs += 1_000;
  const attempt = store.getAttempt(att.attemptId)!;
  source.operationRecords.set("key-land", {
    source: "PROVIDER_OPERATION_LOG",
    kind: "OPERATION_LOG_RECORD_FOR_KEY",
    reference: "oplog-64-land",
    operationFound: true,
    providerOperationId: "op_64",
    observedState: landedStateFor("sub_x"),
    provider: attempt.provider,
    site: attempt.site ?? undefined,
    subscriptionId: attempt.subscriptionId,
    quoteId: attempt.quoteId,
    idempotencyKey: attempt.idempotencyKey,
    requestHash: attempt.requestHash,
    observedAt: nowIso(),
    logFinal: true,
    completeThrough: nowIso(),
  });
  const token = verifier.establish(attempt, "CONFIRMED_LANDING", new Date(nowMs));
  (store as any).resolveAttempt(att.attemptId, {
    evidence: token,
    operatorId: "operator-1",
    reconciliationDecision: "RECONCILE_LANDED_STATE_NO_REDISPATCH",
    justification: "Provider operation log records this attempt's key as executed; landed state to be reconciled.",
  });
  const governing = (store as any).getResolution(att.attemptId);
  source.reconciliationRecords.set("key-land", {
    source: "PROVIDER_OPERATION_LOG",
    reference: "finrec-64-land",
    provider: attempt.provider,
    site: attempt.site ?? undefined,
    subscriptionId: attempt.subscriptionId,
    quoteId: attempt.quoteId,
    idempotencyKey: attempt.idempotencyKey,
    requestHash: attempt.requestHash,
    resolutionReference: governing.evidenceReference,
    landedState: landedStateFor("sub_x"),
    financialOutcome: { status: "RECONCILED", currency: "usd", immediateNet: 1000, recurringAmount: 5000 },
    reconciledAt: nowIso(),
  });
  (store as any).reconcileLandedAttempt(att.attemptId, { operatorId: "operator-1", justification: "Reconciled against the provider record." });

  // A pre-landing quote (issued before the landing, at the
  // pre-landing version) is stale WITHIN site-a…
  store.put({ ...makeStoredQuote("q-stale-a", "sub_x"), created_at: "2026-10-29T00:00:00.000Z" });
  assert.throws(
    () => store.beginDispatch(INTENT("q-stale-a", "sub_x", "site-a", "key-stale-a")),
    (e: unknown) => e instanceof DispatchBlockedError && /stale/i.test((e as Error).message),
    "the site-a landing stale-blocks a pre-landing site-a quote",
  );
  // …but the SAME stale-shaped quote dispatched under site-b is
  // not governed by site-a's landing: namespaces are independent.
  store.put({ ...makeStoredQuote("q-stale-b", "sub_x"), created_at: "2026-10-29T00:00:00.000Z" });
  const attB = store.beginDispatch(INTENT("q-stale-b", "sub_x", "site-b", "key-stale-b"));
  assert.equal(attB.state, "DISPATCHING", "site-a's reconciled landing does not stale-block a site-b dispatch");
  store.close();
});

// ---------------------------------------------------------------------------
// 64.9 Parallel processes sharing one SQLite store
// ---------------------------------------------------------------------------

const CHILD = new URL("./helpers/namespace-child.js", import.meta.url).pathname;
function runBeginChild(path: string, quoteId: string, sub: string, provider: string, site: string, key: string, resultFile: string): Promise<number> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [CHILD, "begin", path, quoteId, sub, provider, site, key, resultFile], { stdio: "ignore" });
    child.on("error", rejectPromise);
    child.on("exit", (code) => resolvePromise(code ?? -1));
  });
}

test("Test 64.9 (Issue #45): parallel processes — same tuple yields exactly one dispatch; distinct sites both dispatch", async () => {
  const dir = trackTempDir(mkdtempSync(join(tmpdir(), "scq-i45-par-")));
  const path = join(dir, "scq.db");
  const store = openStore(path);
  store.put(makeStoredQuote("qP1", "sub_par"));
  store.put(makeStoredQuote("qP2", "sub_par"));
  store.put(makeStoredQuote("qP3", "sub_par"));
  store.close();

  // Same tuple race: qP1 and qP2 both claim (chargebee, site-a, sub_par).
  const r1 = join(dir, "r1.json");
  const r2 = join(dir, "r2.json");
  const [c1, c2] = await Promise.all([
    runBeginChild(path, "qP1", "sub_par", "chargebee", "site-a", "key-p1", r1),
    runBeginChild(path, "qP2", "sub_par", "chargebee", "site-a", "key-p2", r2),
  ]);
  const outcomes = [JSON.parse(readFileSync(r1, "utf8")), JSON.parse(readFileSync(r2, "utf8"))];
  assert.equal(outcomes.filter((o) => o.ok).length, 1, `exactly one same-tuple process may dispatch (exit codes ${c1}/${c2})`);
  assert.equal(outcomes.filter((o) => !o.ok).length, 1, "the other process is refused by the winner's attempt");

  // Distinct namespace: qP3 claims site-b — proceeds despite the
  // site-a DISPATCHING winner (run after the race, still parallel-
  // safe because the winner's attempt persists).
  const r3 = join(dir, "r3.json");
  const c3 = await runBeginChild(path, "qP3", "sub_par", "chargebee", "site-b", "key-p3", r3);
  const o3 = JSON.parse(readFileSync(r3, "utf8"));
  assert.equal(c3, 0);
  assert.equal(o3.ok, true, "a site-b process dispatches independently of the site-a winner");
});

// ---------------------------------------------------------------------------
// 64.10 Restart preserves namespace isolation
// ---------------------------------------------------------------------------

test("Test 64.10 (Issue #45): process restart with an unresolved attempt — protection and isolation both survive", () => {
  const path = tmpDb();
  const store = openStore(path);
  store.put(makeStoredQuote("q1", "sub_x"));
  store.put(makeStoredQuote("q2", "sub_x"));
  store.put(makeStoredQuote("q3", "sub_x"));
  const att = store.beginDispatch(INTENT("q1", "sub_x", "site-a", "key-1"));
  store.close();

  const reopened = openStore(path);
  assert.throws(
    () => reopened.beginDispatch(INTENT("q2", "sub_x", "site-a", "key-2")),
    DispatchBlockedError,
    "the same tuple remains blocked after restart",
  );
  const attB = reopened.beginDispatch(INTENT("q3", "sub_x", "site-b", "key-3"));
  assert.equal(attB.state, "DISPATCHING", "the distinct site remains independent after restart");
  assert.equal(reopened.findBlockingAttempt("q2", "sub_x", undefined, NS("chargebee", "site-a"))?.attemptId, att.attemptId);
  reopened.close();
});

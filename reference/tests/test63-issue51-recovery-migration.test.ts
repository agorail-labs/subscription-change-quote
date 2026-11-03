import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
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

import {
  DispatchBlockedError,
  DurableQuoteStore,
  type DurableStoreOptions,
} from "../src/store/durable-store.js";
import * as durableModule from "../src/store/durable-store.js";
import { makeStoredQuote } from "./helpers/durable-fixtures.js";

// Test 63 — Issue #51: append-only VERIFIED recovery after legacy
// evidence migration (schema v5).
//
// The defect (verified against the pre-fix head): a pre-v4 landing
// attempt whose records migrated to ASSERTED could never complete
// recovery, even with later trustworthy evidence:
//   - landing_reconciliations.attempt_id carried a table-level
//     UNIQUE constraint, so a VERIFIED barrier row could not be
//     appended beside the preserved ASSERTED history row;
//   - reconcileLandedAttempt refused when ANY reconciliation row
//     existed for the attempt (the any-record check), not only when
//     a VERIFIED barrier already stood;
//   - landingReconciliationRecordFor returned an arbitrary single
//     row, so tier-aware reading was impossible with history present;
//   - resolveAttempt's replay query was not scoped to VERIFIED
//     rows (the SQL replay index is), so re-establishing the SAME
//     provider record a legacy ASSERTED row names was refused as
//     replay even though no VERIFIED row had consumed it.
//
// The v5 contract pinned here:
//   - migration (v4 → v5, and v3 → v5 through the v4 steps) rebuilds
//     the table in ONE transaction, copying every row verbatim;
//     history stays ASSERTED, checksum-valid, and NON-LIFTING;
//   - a migrated attempt can then acquire a VERIFIED resolution
//     (appended; the same provider reference the ASSERTED row names
//     is NOT consumed) and a VERIFIED landing reconciliation
//     (appended beside the ASSERTED row) — without deletion,
//     promotion, or rewriting of the historical records;
//   - VERIFIED-tier uniqueness is enforced consistently: duplicate
//     VERIFIED barrier for one attempt refused; a VERIFIED evidence
//     reference reused across attempts refused (resolution and
//     reconciliation alike); SQL partial unique indexes backstop
//     the runtime checks;
//   - readers are deterministic: landingReconciliationFor returns
//     the VERIFIED barrier; landingReconciliationRecordsFor returns
//     the full append-order history.
//
// FAILING-FIRST provenance: this file was run against the unmodified
// pre-fix store (schema v4) before the fix was applied; the
// migration, upgrade, and replay-scope cases fail there for the
// reasons above. Every provider record below is SIMULATED by an
// in-memory source playing the provider; no live provider is
// touched, and no dispatch occurs during resolution/reconciliation
// (asserted in 63.2).

const require = createRequire(import.meta.url);
function rawDb(path: string): any {
  const Database = require("better-sqlite3") as any;
  return new Database(path);
}
function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
/** Canonical stringify identical to the store's (sorted keys, undefined dropped). */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}

function tmpDb(name = "scq.db"): string {
  const dir = trackTempDir(mkdtempSync(join(tmpdir(), "scq-i51-")));
  return join(dir, name);
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

const T0 = Date.parse("2026-11-02T12:00:00.000Z");

// ---------------------------------------------------------------------------
// In-memory provider record source + verifier rig (mirrors test59).
// ---------------------------------------------------------------------------
type TestSource = {
  operationRecords: Map<string, unknown>;
  reconciliationRecords: Map<string, unknown>;
  api: any;
};
function makeSource(): TestSource {
  const src: TestSource = { operationRecords: new Map(), reconciliationRecords: new Map(), api: null };
  src.api = {
    fetchOperationRecord: (query: Record<string, unknown>) => src.operationRecords.get(query.idempotencyKey as string),
    fetchFinancialReconciliation: (query: Record<string, unknown>) => src.reconciliationRecords.get(query.idempotencyKey as string),
  };
  return src;
}
const createProviderEvidenceVerifier: any = (durableModule as any).createProviderEvidenceVerifier;

type Rig = {
  store: DurableQuoteStore;
  source: TestSource;
  verifier: any;
  tick: (ms: number) => void;
  now: () => Date;
  nowIso: () => string;
};
function openRig(path: string, opts: { verifier?: boolean } = {}): Rig {
  let nowMs = T0;
  const source = makeSource();
  const verifier = createProviderEvidenceVerifier(source.api);
  const storeOpts: any = { recoveryGraceMs: 0, now: () => new Date(nowMs) };
  if (opts.verifier !== false) storeOpts.evidenceVerifier = verifier;
  const store = new DurableQuoteStore(path, storeOpts as DurableStoreOptions);
  return {
    store,
    source,
    verifier,
    tick: (ms: number) => {
      nowMs += ms;
    },
    now: () => new Date(nowMs),
    nowIso: () => new Date(nowMs).toISOString(),
  };
}

type Ctx = { store: DurableQuoteStore; nowIso: () => string };

function landedStateFor(subscriptionId: string): Record<string, unknown> {
  return {
    id: subscriptionId,
    version: "v2",
    status: "active",
    items: [{ id: "item_1", offeringRef: "plan", quantity: 2 }],
  };
}

let refSeq = 0;
function operationRecord(ctx: Ctx, attemptId: string, classification: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const attempt = ctx.store.getAttempt(attemptId)!;
  const base: Record<string, unknown> =
    classification === "CONFIRMED_LANDING"
      ? {
          source: "PROVIDER_OPERATION_LOG",
          kind: "OPERATION_LOG_RECORD_FOR_KEY",
          reference: `oplog-ref-${++refSeq}`,
          operationFound: true,
          providerOperationId: "op_63_landing",
          observedState: landedStateFor(attempt.subscriptionId),
        }
      : {
          source: "PROVIDER_OPERATION_LOG",
          kind: "OPERATION_LOG_NO_RECORD_FOR_KEY",
          reference: `oplog-ref-${++refSeq}`,
          operationFound: false,
          observedState: { lookupResult: "NO_RECORD_FOR_KEY", idempotencyKey: attempt.idempotencyKey },
        };
  return {
    ...base,
    provider: attempt.provider,
    site: attempt.site ?? undefined,
    subscriptionId: attempt.subscriptionId,
    quoteId: attempt.quoteId,
    idempotencyKey: attempt.idempotencyKey,
    requestHash: attempt.requestHash,
    observedAt: ctx.nowIso(),
    logFinal: true,
    completeThrough: ctx.nowIso(),
    ...overrides,
  };
}
function stageOperationRecord(rig: Rig, attemptId: string, classification: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const record = operationRecord(rig, attemptId, classification, overrides);
  rig.source.operationRecords.set(rig.store.getAttempt(attemptId)!.idempotencyKey, record);
  return record;
}
function establish(rig: Rig, attemptId: string, classification: string, overrides: Record<string, unknown> = {}): any {
  stageOperationRecord(rig, attemptId, classification, overrides);
  const attempt = rig.store.getAttempt(attemptId)!;
  return rig.verifier.establish(attempt, classification, rig.now());
}

let finSeq = 0;
function reconciliationRecord(ctx: Ctx, attemptId: string, resolution: any, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const attempt = ctx.store.getAttempt(attemptId)!;
  return {
    source: "PROVIDER_OPERATION_LOG",
    reference: `finrec-ref-${++finSeq}`,
    provider: attempt.provider,
    site: attempt.site ?? undefined,
    subscriptionId: attempt.subscriptionId,
    quoteId: attempt.quoteId,
    idempotencyKey: attempt.idempotencyKey,
    requestHash: attempt.requestHash,
    resolutionReference: resolution.evidenceReference,
    landedState: landedStateFor(attempt.subscriptionId),
    financialOutcome: { status: "RECONCILED", currency: "usd", immediateNet: 1000, recurringAmount: 5000 },
    reconciledAt: ctx.nowIso(),
    ...overrides,
  };
}
function stageReconciliation(rig: Rig, attemptId: string, resolution: any, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const record = reconciliationRecord(rig, attemptId, resolution, overrides);
  rig.source.reconciliationRecords.set(rig.store.getAttempt(attemptId)!.idempotencyKey, record);
  return record;
}

function resolve(store: DurableQuoteStore, attemptId: string, input: unknown): any {
  return (store as any).resolveAttempt(attemptId, input);
}
function resolveInput(classification: string, token: unknown): Record<string, unknown> {
  return {
    evidence: token,
    operatorId: "operator-1",
    reconciliationDecision: classification === "CONFIRMED_LANDING" ? "RECONCILE_LANDED_STATE_NO_REDISPATCH" : "PERMIT_NEW_DISPATCH",
    justification:
      classification === "CONFIRMED_LANDING"
        ? "Provider operation log records this attempt's idempotency key as executed; landed state to be reconciled, no re-dispatch."
        : "Provider operation log, final through the settlement, records no operation for this attempt's idempotency key.",
  };
}
function reconcileLanded(store: DurableQuoteStore, attemptId: string, input: unknown): any {
  return (store as any).reconcileLandedAttempt(attemptId, input);
}
function resolutions(store: DurableQuoteStore, attemptId: string): any[] {
  return (store as any).resolutionsForAttempt(attemptId);
}
function getResolution(store: DurableQuoteStore, attemptId: string): any {
  return (store as any).getResolution(attemptId);
}
function landingReconciliation(store: DurableQuoteStore, attemptId: string): any {
  return (store as any).landingReconciliationFor(attemptId);
}
function landingReconciliationRecord(store: DurableQuoteStore, attemptId: string): any {
  return (store as any).landingReconciliationRecordFor(attemptId);
}
function landingReconciliationRecords(store: DurableQuoteStore, attemptId: string): any[] {
  return typeof (store as any).landingReconciliationRecordsFor === "function" ? (store as any).landingReconciliationRecordsFor(attemptId) : [];
}
function isEvidenceRefusal(e: unknown): boolean {
  return (e as { code?: string })?.code === "RESOLUTION_EVIDENCE_REFUSED";
}

// ---------------------------------------------------------------------------
// Hand-built v4 database: a landed INDETERMINATE attempt whose
// terminal CONFIRMED_LANDING resolution and landing reconciliation
// were recorded pre-v5 and therefore sit at trust_tier ASSERTED
// (the v3 rows of test59.5 after the v4 backfill — the exact state
// Issue #51 covers). Payloads and hashes are constructed exactly as
// the store verifies them on open.
// ---------------------------------------------------------------------------
const LEGACY_REF = "oplog-v4-land-ref";
function buildV4LandingDb(path: string): { attemptId: string; quoteId: string; subscriptionId: string; reconHash: string } {
  const attemptId = "att_v4_land";
  const quoteId = "q-v4l";
  const subscriptionId = "sub_v4l";
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
  // v4 attempt_resolutions (v3 columns + trust_tier; VERIFIED-scoped replay index).
  db.exec(`CREATE TABLE attempt_resolutions (
     resolution_id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL, quote_id TEXT NOT NULL,
     subscription_id TEXT NOT NULL, provider TEXT NOT NULL, site TEXT,
     request_hash TEXT NOT NULL, idempotency_key TEXT NOT NULL, classification TEXT NOT NULL,
     operator_id TEXT NOT NULL, resolved_at TEXT NOT NULL, evidence_source TEXT NOT NULL,
     evidence_kind TEXT NOT NULL, evidence_reference TEXT NOT NULL, observed_at TEXT NOT NULL,
     observed_provider_state_digest TEXT NOT NULL, provider_operation_id TEXT,
     reconciliation_decision TEXT NOT NULL, justification TEXT NOT NULL,
     evidence_payload_json TEXT NOT NULL, evidence_hash TEXT NOT NULL UNIQUE,
     log_final INTEGER, complete_through TEXT, registry_coverage TEXT, landed_state_version TEXT,
     trust_tier TEXT)`);
  db.exec(`CREATE INDEX idx_attempt_resolutions_attempt ON attempt_resolutions(attempt_id)`);
  db.exec(`CREATE UNIQUE INDEX idx_attempt_resolutions_evidence_ref ON attempt_resolutions(evidence_source, evidence_reference) WHERE classification != 'UNRESOLVED' AND trust_tier = 'VERIFIED'`);
  // v4 landing_reconciliations — WITH the attempt_id UNIQUE constraint (the Issue #51 defect).
  db.exec(`CREATE TABLE landing_reconciliations (
     reconciliation_id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL UNIQUE, quote_id TEXT NOT NULL,
     subscription_id TEXT NOT NULL, landed_state_version TEXT NOT NULL, landed_state_digest TEXT NOT NULL,
     financial_outcome_digest TEXT NOT NULL, operator_id TEXT NOT NULL, reconciled_at TEXT NOT NULL,
     justification TEXT NOT NULL, payload_json TEXT NOT NULL, record_hash TEXT NOT NULL UNIQUE,
     trust_tier TEXT, evidence_reference TEXT)`);
  db.exec(`CREATE INDEX idx_landing_reconciliations_attempt ON landing_reconciliations(attempt_id)`);
  db.prepare(`INSERT INTO meta (key, value) VALUES ('schema_version', '4')`).run();
  db.prepare(`INSERT INTO meta (key, value) VALUES ('created_at', '2026-10-30T00:00:00.000Z')`).run();

  const requestHash = sha256("v4 land request");
  db.prepare(
    `INSERT INTO attempts (attempt_id, quote_id, subscription_id, provider, site, state, idempotency_key, request_hash, request_json, pre_dispatch_fingerprint, recovery_classification, outcome, details_json, operator_review_state, version, created_at, updated_at)
     VALUES (?,?,?,?,?,'INDETERMINATE',?,?,'{}',NULL,NULL,'INDETERMINATE',NULL,'RESOLVED',3,'2026-10-30T00:00:00.000Z','2026-10-30T00:01:00.000Z')`,
  ).run(attemptId, quoteId, subscriptionId, "chargebee", "site-a", "key-v4l", requestHash);

  const landedState = landedStateFor(subscriptionId);
  const landedDigest = sha256(canonical(landedState));
  const landPayload = {
    resolutionId: "res_v4_land",
    attemptId,
    quoteId,
    subscriptionId,
    provider: "chargebee",
    site: "site-a",
    requestHash,
    idempotencyKey: "key-v4l",
    classification: "CONFIRMED_LANDING",
    operatorId: "operator-1",
    resolvedAt: "2026-10-30T00:10:00.000Z",
    evidenceSource: "PROVIDER_OPERATION_LOG",
    evidenceKind: "OPERATION_LOG_RECORD_FOR_KEY",
    evidenceReference: LEGACY_REF,
    observedAt: "2026-10-30T00:05:00.000Z",
    observedProviderStateDigest: landedDigest,
    providerOperationId: "op_v4_land",
    reconciliationDecision: "RECONCILE_LANDED_STATE_NO_REDISPATCH",
    justification: "Pre-v5 landing resolution (since backfilled ASSERTED).",
    logFinal: true,
    completeThrough: "2026-10-30T00:05:00.000Z",
    registryCoverage: null,
    landedStateVersion: "v2",
    establishmentProcedure: "establishResolutionEvidence",
  };
  db.prepare(
    `INSERT INTO attempt_resolutions (resolution_id, attempt_id, quote_id, subscription_id, provider, site, request_hash, idempotency_key, classification, operator_id, resolved_at, evidence_source, evidence_kind, evidence_reference, observed_at, observed_provider_state_digest, provider_operation_id, reconciliation_decision, justification, evidence_payload_json, evidence_hash, log_final, complete_through, registry_coverage, landed_state_version, trust_tier)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,'2026-10-30T00:05:00.000Z',NULL,'v2','ASSERTED')`,
  ).run(
    landPayload.resolutionId, landPayload.attemptId, landPayload.quoteId, landPayload.subscriptionId, landPayload.provider, landPayload.site,
    landPayload.requestHash, landPayload.idempotencyKey, landPayload.classification, landPayload.operatorId, landPayload.resolvedAt,
    landPayload.evidenceSource, landPayload.evidenceKind, landPayload.evidenceReference, landPayload.observedAt,
    landPayload.observedProviderStateDigest, landPayload.providerOperationId, landPayload.reconciliationDecision,
    landPayload.justification, JSON.stringify(landPayload), sha256(canonical(landPayload)),
  );

  const reconPayload = {
    reconciliationId: "rec_v4_land",
    attemptId,
    quoteId,
    subscriptionId,
    landedStateVersion: "v2",
    landedStateDigest: landedDigest,
    financialOutcomeDigest: sha256("v4 financial outcome record"),
    operatorId: "operator-1",
    reconciledAt: "2026-10-30T00:12:00.000Z",
    justification: "Pre-v5 barrier record (caller-supplied digests).",
  };
  const reconHash = sha256(canonical(reconPayload));
  db.prepare(
    `INSERT INTO landing_reconciliations (reconciliation_id, attempt_id, quote_id, subscription_id, landed_state_version, landed_state_digest, financial_outcome_digest, operator_id, reconciled_at, justification, payload_json, record_hash, trust_tier, evidence_reference)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'ASSERTED',NULL)`,
  ).run(
    reconPayload.reconciliationId, reconPayload.attemptId, reconPayload.quoteId, reconPayload.subscriptionId,
    reconPayload.landedStateVersion, reconPayload.landedStateDigest, reconPayload.financialOutcomeDigest,
    reconPayload.operatorId, reconPayload.reconciledAt, reconPayload.justification,
    JSON.stringify(reconPayload), reconHash,
  );
  db.close();
  return { attemptId, quoteId, subscriptionId, reconHash };
}

/** Drive a migrated attempt through the full VERIFIED recovery: fresh VERIFIED landing resolution + VERIFIED reconciliation. Returns the rig open on the db. */
function completeRecovery(path: string): { rig: Rig; ids: ReturnType<typeof buildV4LandingDb> } {
  const ids = buildV4LandingDb(path);
  const rig = openRig(path);
  const token = establish(rig, ids.attemptId, "CONFIRMED_LANDING", { reference: LEGACY_REF });
  resolve(rig.store, ids.attemptId, resolveInput("CONFIRMED_LANDING", token));
  const governing = getResolution(rig.store, ids.attemptId);
  stageReconciliation(rig, ids.attemptId, governing);
  reconcileLanded(rig.store, ids.attemptId, { operatorId: "operator-1", justification: "Financial reconciliation verified against the provider record." });
  return { rig, ids };
}

// ---------------------------------------------------------------------------
// 63.1 Migration: history preserved verbatim, still non-lifting
// ---------------------------------------------------------------------------

test("Test 63.1 (Issue #51): a v4 database migrates to schema v5 — the ASSERTED resolution + reconciliation history is preserved verbatim and remains NON-LIFTING", () => {
  const path = tmpDb();
  const ids = buildV4LandingDb(path);
  const store = new DurableQuoteStore(path, { recoveryGraceMs: 0 });
  const check = rawDb(path);
  const version = check.prepare(`SELECT value FROM meta WHERE key='schema_version'`).get() as { value: string };
  assert.equal(version.value, "5", "the v4 database was migrated to schema v5");
  const row = check.prepare(`SELECT record_hash, trust_tier FROM landing_reconciliations WHERE reconciliation_id='rec_v4_land'`).get() as { record_hash: string; trust_tier: string };
  assert.equal(row.record_hash, ids.reconHash, "the legacy reconciliation row's checksum is untouched by migration");
  assert.equal(row.trust_tier, "ASSERTED", "migration does not promote the legacy row");
  check.close();

  const history = landingReconciliationRecords(store, ids.attemptId);
  assert.equal(history.length, 1, "the preserved history is inspectable");
  assert.equal(history[0].trustTier, "ASSERTED");
  assert.equal(history[0].recordHash, ids.reconHash, "the preserved record re-verified on open (its checksum still validates)");
  assert.equal(landingReconciliationRecord(store, ids.attemptId)?.reconciliationId, "rec_v4_land");
  assert.equal(landingReconciliation(store, ids.attemptId), undefined, "an ASSERTED reconciliation never satisfies the barrier");
  assert.equal(getResolution(store, ids.attemptId)?.trustTier, "ASSERTED");
  assert.equal(
    store.findBlockingAttempt("q-other", ids.subscriptionId)?.attemptId,
    ids.attemptId,
    "the migrated landing attempt still blocks the whole subscription",
  );
  assert.equal(store.findBlockingAttempt(ids.quoteId, ids.subscriptionId)?.attemptId, ids.attemptId, "and its own quote");
  store.close();
});

// ---------------------------------------------------------------------------
// 63.2 The completion gate: VERIFIED recovery appended beside history
// ---------------------------------------------------------------------------

test("Test 63.2 (Issue #51): a migrated landing attempt acquires a VERIFIED resolution and reconciliation WITHOUT deletion, promotion, or rewriting of its ASSERTED history", () => {
  const path = tmpDb();
  const ids = buildV4LandingDb(path);
  const rig = openRig(path);
  const { store } = rig;

  // No VERIFIED landing resolution yet: reconciliation refuses.
  assert.throws(
    () => reconcileLanded(store, ids.attemptId, { operatorId: "operator-1", justification: "too early" }),
    (e: unknown) => isEvidenceRefusal(e),
    "reconciliation before any VERIFIED landing resolution refuses — ASSERTED history establishes nothing",
  );

  // Fresh VERIFIED resolution, established from the SAME provider
  // record (same source + reference) the legacy ASSERTED row names:
  // the ASSERTED row never consumed the reference.
  const token = establish(rig, ids.attemptId, "CONFIRMED_LANDING", { reference: LEGACY_REF });
  resolve(store, ids.attemptId, resolveInput("CONFIRMED_LANDING", token));
  assert.equal(resolutions(store, ids.attemptId).length, 2, "the VERIFIED resolution is appended beside the ASSERTED one");
  assert.equal(getResolution(store, ids.attemptId)?.trustTier, "VERIFIED", "the governing resolution is the VERIFIED one");
  assert.equal(resolutions(store, ids.attemptId)[0].trustTier, "ASSERTED", "the historical resolution is preserved, unpromoted");
  assert.equal(landingReconciliation(store, ids.attemptId), undefined, "resolution alone does not satisfy the reconciliation barrier");

  // Now the VERIFIED reconciliation appends beside the ASSERTED row.
  const governing = getResolution(store, ids.attemptId);
  stageReconciliation(rig, ids.attemptId, governing);
  const attemptsBefore = (store as any).attemptsForQuote ? 0 : 0;
  const record = reconcileLanded(store, ids.attemptId, { operatorId: "operator-1", justification: "Financial reconciliation verified against the provider record." });
  assert.equal(record.trustTier, "VERIFIED");
  const history = landingReconciliationRecords(store, ids.attemptId);
  assert.equal(history.length, 2, "history now holds the preserved ASSERTED row AND the VERIFIED barrier");
  assert.deepEqual(
    history.map((h: any) => [h.reconciliationId, h.trustTier]),
    [["rec_v4_land", "ASSERTED"], [record.reconciliationId, "VERIFIED"]],
    "append order preserved; the legacy row is neither deleted nor promoted",
  );
  assert.equal(history[0].recordHash, ids.reconHash, "the legacy row's checksum is still valid and unchanged");
  assert.equal(landingReconciliation(store, ids.attemptId)?.reconciliationId, record.reconciliationId, "the barrier reader returns the VERIFIED record deterministically");
  assert.equal(landingReconciliationRecord(store, ids.attemptId)?.reconciliationId, record.reconciliationId, "the effective-record reader prefers the VERIFIED barrier");

  // Recovery semantics after the barrier: own quote stays blocked
  // (R1), other quotes unblock subject to the stale-quote rule, and
  // no dispatch happened anywhere in resolution/reconciliation.
  assert.equal(store.findBlockingAttempt(ids.quoteId, ids.subscriptionId)?.attemptId, ids.attemptId, "same-quote retry remains prohibited");
  assert.equal(store.findBlockingAttempt("q-other", ids.subscriptionId), undefined, "the subscription unblocks for other quotes once reconciled");
  assert.equal(attemptsBefore, 0);
  store.put({ ...makeStoredQuote("q-stale", ids.subscriptionId), created_at: "2026-10-29T00:00:00.000Z" });
  assert.throws(
    () => store.beginDispatch(INTENT("q-stale", ids.subscriptionId, "key-stale")),
    (e: unknown) => e instanceof DispatchBlockedError && /stale/i.test((e as Error).message),
    "a pre-landing quote remains stale after the VERIFIED barrier",
  );
  rig.tick(1_000);
  store.put({ ...makeStoredQuote("q-fresh", ids.subscriptionId), created_at: rig.nowIso(), subscription_version_at_quote: "v2" });
  const fresh = store.beginDispatch(INTENT("q-fresh", ids.subscriptionId, "key-fresh"));
  assert.equal(fresh.state, "DISPATCHING", "a fresh quote validated against the landed state may dispatch");
  store.close();
});

// ---------------------------------------------------------------------------
// 63.3 Duplicate VERIFIED barrier refused
// ---------------------------------------------------------------------------

test("Test 63.3 (Issue #51): a duplicate VERIFIED reconciliation for one attempt is rejected", () => {
  const path = tmpDb();
  const { rig, ids } = completeRecovery(path);
  assert.equal(landingReconciliationRecords(rig.store, ids.attemptId).length, 2);
  assert.throws(
    () => reconcileLanded(rig.store, ids.attemptId, { operatorId: "operator-1", justification: "again" }),
    (e: unknown) => isEvidenceRefusal(e) && /ALREADY_RECONCILED/.test((e as Error).message),
    "a second VERIFIED barrier for the same attempt refuses",
  );
  assert.equal(landingReconciliationRecords(rig.store, ids.attemptId).length, 2, "the refused duplicate appended nothing");
  rig.store.close();
});

// ---------------------------------------------------------------------------
// 63.4 VERIFIED reference reuse across attempts refused (both tables)
// ---------------------------------------------------------------------------

test("Test 63.4 (Issue #51): a VERIFIED evidence reference cannot be reused across attempts — resolution replay and reconciliation replay both refuse", () => {
  const path = tmpDb();
  const { rig, ids } = completeRecovery(path);
  const { store } = rig;
  const verifiedRecon = landingReconciliation(store, ids.attemptId);
  assert.ok(verifiedRecon?.evidenceReference, "fixture: the VERIFIED barrier carries an evidence reference");

  // A second landed attempt on another subscription, driven to the
  // reconciliation step with a record carrying the SAME reference.
  store.put(makeStoredQuote("q-b", "sub_b"));
  const attB = store.beginDispatch(INTENT("q-b", "sub_b", "key-b"));
  rig.tick(60_000);
  store.recordAttemptOutcome(attB.attemptId, "INDETERMINATE");
  rig.tick(1_000); // the establishing observation must postdate the settlement
  const tokenB = establish(rig, attB.attemptId, "CONFIRMED_LANDING");
  resolve(store, attB.attemptId, resolveInput("CONFIRMED_LANDING", tokenB));
  const governingB = getResolution(store, attB.attemptId);
  stageReconciliation(rig, attB.attemptId, governingB, { reference: verifiedRecon.evidenceReference });
  assert.throws(
    () => reconcileLanded(store, attB.attemptId, { operatorId: "operator-1", justification: "reuse attempt" }),
    (e: unknown) => isEvidenceRefusal(e) && /already used by VERIFIED reconciliation/.test((e as Error).message),
    "reusing a VERIFIED reconciliation reference for another attempt refuses",
  );
  assert.equal(landingReconciliationRecords(store, attB.attemptId).length, 0, "nothing was recorded for the replayed reference");
  assert.equal(store.findBlockingAttempt("q-other-b", "sub_b")?.attemptId, attB.attemptId, "the second attempt remains blocked");

  // Resolution side: attempt B's VERIFIED resolution reference
  // cannot resolve a third attempt either.
  store.put(makeStoredQuote("q-c", "sub_c"));
  const attC = store.beginDispatch(INTENT("q-c", "sub_c", "key-c"));
  rig.tick(60_000);
  store.recordAttemptOutcome(attC.attemptId, "INDETERMINATE");
  rig.tick(1_000); // the establishing observation must postdate the settlement
  const tokenC = establish(rig, attC.attemptId, "CONFIRMED_NON_EXECUTION", { reference: governingB.evidenceReference });
  assert.throws(
    () => resolve(store, attC.attemptId, resolveInput("CONFIRMED_NON_EXECUTION", tokenC)),
    (e: unknown) => isEvidenceRefusal(e) && /already used by resolution/.test((e as Error).message),
    "reusing a VERIFIED resolution reference for another attempt refuses",
  );
  store.close();
});

// ---------------------------------------------------------------------------
// 63.5 Restart preserves the effective recovery state
// ---------------------------------------------------------------------------

test("Test 63.5 (Issue #51): restarts preserve the effective recovery state — history, barrier, and governing resolution survive reopen", () => {
  const path = tmpDb();
  const { rig, ids } = completeRecovery(path);
  const barrierId = landingReconciliation(rig.store, ids.attemptId)?.reconciliationId;
  rig.store.close();

  const rig2 = openRig(path);
  const history = landingReconciliationRecords(rig2.store, ids.attemptId);
  assert.equal(history.length, 2, "both records survive the restart");
  assert.equal(history[0].recordHash, ids.reconHash, "the legacy row still re-verifies on open");
  assert.equal(landingReconciliation(rig2.store, ids.attemptId)?.reconciliationId, barrierId, "the VERIFIED barrier still satisfies after restart");
  assert.equal(getResolution(rig2.store, ids.attemptId)?.trustTier, "VERIFIED");
  assert.equal(rig2.store.findBlockingAttempt("q-other", ids.subscriptionId), undefined, "the subscription stays unblocked for other quotes");
  assert.equal(rig2.store.findBlockingAttempt(ids.quoteId, ids.subscriptionId)?.attemptId, ids.attemptId, "the own-quote block survives too");
  rig2.store.close();
});

// ---------------------------------------------------------------------------
// 63.6 Migration failure cannot produce partially trusted data
// ---------------------------------------------------------------------------

test("Test 63.6 (Issue #51): a failed v4 → v5 migration leaves the database at v4 with every row intact — retry then migrates cleanly", () => {
  const path = tmpDb();
  const ids = buildV4LandingDb(path);
  // Sabotage: occupy the rebuild's staging table name so the
  // migration transaction fails midway.
  const sabotage = rawDb(path);
  sabotage.exec(`CREATE TABLE landing_reconciliations_v5 (x TEXT)`);
  sabotage.close();
  assert.throws(() => new DurableQuoteStore(path, { recoveryGraceMs: 0 }), "the sabotaged migration refuses the open");
  const check = rawDb(path);
  const version = check.prepare(`SELECT value FROM meta WHERE key='schema_version'`).get() as { value: string };
  assert.equal(version.value, "4", "the failed migration did not advance the version marker");
  const row = check.prepare(`SELECT record_hash FROM landing_reconciliations WHERE reconciliation_id='rec_v4_land'`).get() as { record_hash: string };
  assert.equal(row.record_hash, ids.reconHash, "the original table and row are intact — no partial rebuild leaked");
  check.exec(`DROP TABLE landing_reconciliations_v5`);
  check.close();

  const store = new DurableQuoteStore(path, { recoveryGraceMs: 0 });
  const check2 = rawDb(path);
  const version2 = check2.prepare(`SELECT value FROM meta WHERE key='schema_version'`).get() as { value: string };
  assert.equal(version2.value, "5", "the retried migration completes");
  check2.close();
  assert.equal(landingReconciliationRecords(store, ids.attemptId).length, 1, "history intact after the retried migration");
  assert.equal(store.findBlockingAttempt("q-other", ids.subscriptionId)?.attemptId, ids.attemptId, "and still blocking — failure never produced trusted state");
  store.close();
});

// ---------------------------------------------------------------------------
// 63.7 Tampered legacy evidence fails closed on open
// ---------------------------------------------------------------------------

test("Test 63.7 (Issue #51): a tampered legacy reconciliation payload refuses the open — malformed history is never adopted", () => {
  const path = tmpDb();
  const ids = buildV4LandingDb(path);
  const db = rawDb(path);
  db.prepare(`UPDATE landing_reconciliations SET payload_json = ? WHERE reconciliation_id='rec_v4_land'`).run('{"reconciliationId":"rec_v4_land","tampered":true}');
  db.close();
  assert.throws(
    () => new DurableQuoteStore(path, { recoveryGraceMs: 0 }),
    (e: unknown) => (e as { code?: string })?.code === "DURABLE_RECOVERY_REFUSED" || /Recovery refused/.test((e as Error).message),
    "the open refuses: the tampered row fails its record-hash consistency check",
  );
});

// ---------------------------------------------------------------------------
// 63.8 Contradictory reconciliation evidence refuses
// ---------------------------------------------------------------------------

test("Test 63.8 (Issue #51): reconciliation evidence contradicting the established landing refuses and changes nothing", () => {
  const path = tmpDb();
  const ids = buildV4LandingDb(path);
  const rig = openRig(path);
  const token = establish(rig, ids.attemptId, "CONFIRMED_LANDING", { reference: LEGACY_REF });
  resolve(rig.store, ids.attemptId, resolveInput("CONFIRMED_LANDING", token));
  const governing = getResolution(rig.store, ids.attemptId);
  // The reconciliation record's landed state contradicts the
  // resolution's established landed state.
  stageReconciliation(rig, ids.attemptId, governing, {
    landedState: { id: ids.subscriptionId, version: "v9", status: "active", items: [] },
  });
  assert.throws(
    () => reconcileLanded(rig.store, ids.attemptId, { operatorId: "operator-1", justification: "contradictory" }),
    "establishment refuses a reconciliation record whose landed state contradicts the established resolution",
  );
  assert.equal(landingReconciliationRecords(rig.store, ids.attemptId).length, 1, "only the preserved ASSERTED history exists");
  assert.equal(landingReconciliation(rig.store, ids.attemptId), undefined, "no barrier was satisfied");
  assert.equal(rig.store.findBlockingAttempt("q-other", ids.subscriptionId)?.attemptId, ids.attemptId, "the attempt still blocks");
  rig.store.close();
});

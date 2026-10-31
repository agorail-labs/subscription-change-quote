import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";

// ---------------------------------------------------------------------------
// Temp-dir cleanup (same discipline as test56/test58).
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
import * as publicApi from "../src/index.js";
import { makeStoredQuote } from "./helpers/durable-fixtures.js";

// Test 59 — SCQ P0 (issue #43), PR #50 correction round 3: the evidence
// TRUST BOUNDARY (second-round review findings R2' and R4').
//
// FAILING-FIRST provenance: this file was written against the round-3
// contract and run against the UNMODIFIED round-2 head (2010e73)
// first. On that head the cases fail for the review's reasons:
//   - `establishResolutionEvidence` is a PUBLIC export that mints a
//     branded token from a caller-supplied object — a developer with
//     getAttempt() and no provider access can fabricate a final
//     "no record for key" record, resolve, and free another quote on
//     the subscription (R2'; demonstrated live against the round-2
//     build by the delivery PoC recorded with this round's
//     failing-first output);
//   - `reconcileLandedAttempt` accepts caller digests — a correct
//     landed digest plus sha256("not actually reconciled") satisfies
//     the barrier and unblocks other quotes (R4').
//
// The round-3 contract pinned here:
//   - NO public minting path exists. Evidence tokens are minted ONLY
//     by a verifier created by `createProviderEvidenceVerifier(source)`,
//     whose source RETRIEVES the record (the caller never supplies
//     one in the lifting path), and a store accepts only tokens
//     minted by ITS OWN configured verifier instance
//     (DurableStoreOptions.evidenceVerifier). The library ships no
//     ProviderRecordSource implementation: out of the box, nothing
//     can lift a block.
//   - A store with no configured verifier refuses every terminal
//     resolution. An operator's terminal CLAIM can still be recorded
//     (`recordAssertedResolution`) as an append-only ASSERTED audit
//     record — it never lifts, and the recovery report surfaces it
//     as unverified with intervention still required.
//   - The landing barrier is satisfied only through the same
//     boundary: the store invokes its verifier's
//     establishReconciliation, which fetches an operation-bound
//     financial reconciliation record from the source and computes
//     both digests internally. No caller-supplied digest or record
//     input exists anywhere in the path.
//   - Schema v4: every pre-v4 resolution / reconciliation row is
//     backfilled trust_tier='ASSERTED' on migration — preserved and
//     readable, but NON-LIFTING, because round-2/3-era rows were
//     minted through the now-removed public path or caller digests.
//
// The round-3 API is reached through `any` casts so this file
// compiles and runs against both the round-2 head (failing-first)
// and the corrected implementation. Every provider record below is
// SIMULATED by an in-memory source playing the provider; no live
// provider is touched.

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
  const dir = trackTempDir(mkdtempSync(join(tmpdir(), "scq-p043r3-")));
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

const T0 = Date.parse("2026-10-31T12:00:00.000Z");

// ---------------------------------------------------------------------------
// In-memory provider record source (test double playing the provider).
// Records are keyed by idempotency key, exactly as a provider lookup
// by operation key would be; the queries the verifier issues are
// captured so tests can assert the indirection is binding-built.
// ---------------------------------------------------------------------------
type TestSource = {
  operationRecords: Map<string, unknown>;
  reconciliationRecords: Map<string, unknown>;
  operationQueries: Array<Record<string, unknown>>;
  reconciliationQueries: Array<Record<string, unknown>>;
  api: any;
};
function makeSource(withReconciliation: boolean): TestSource {
  const src: TestSource = {
    operationRecords: new Map(),
    reconciliationRecords: new Map(),
    operationQueries: [],
    reconciliationQueries: [],
    api: null,
  };
  const api: any = {
    fetchOperationRecord: (query: Record<string, unknown>) => {
      src.operationQueries.push(query);
      return src.operationRecords.get(query.idempotencyKey as string);
    },
  };
  if (withReconciliation) {
    api.fetchFinancialReconciliation = (query: Record<string, unknown>) => {
      src.reconciliationQueries.push(query);
      return src.reconciliationRecords.get(query.idempotencyKey as string);
    };
  }
  src.api = api;
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
function openRig(
  path: string = tmpDb(),
  opts: { verifier?: boolean; reconciliation?: boolean; store?: DurableStoreOptions } = {},
): Rig {
  let nowMs = T0;
  const source = makeSource(opts.reconciliation ?? true);
  const verifier =
    typeof createProviderEvidenceVerifier === "function" ? createProviderEvidenceVerifier(source.api) : undefined;
  const storeOpts: any = { recoveryGraceMs: 0, now: () => new Date(nowMs), ...(opts.store ?? {}) };
  if (opts.verifier !== false && verifier) storeOpts.evidenceVerifier = verifier;
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

/** Dispatch at the current time, then settle INDETERMINATE one minute later. Returns the attempt id. */
function settleIndeterminate(rig: Rig, quoteId = "q1", subscriptionId = "sub_1", key = "key-1"): string {
  const att = rig.store.beginDispatch(INTENT(quoteId, subscriptionId, key));
  rig.tick(60_000);
  rig.store.recordAttemptOutcome(att.attemptId, "INDETERMINATE");
  return att.attemptId;
}

/** The landed subscription state a landing record observes (shared by the operation record and the reconciliation record). */
function landedStateFor(subscriptionId: string): Record<string, unknown> {
  return {
    id: subscriptionId,
    version: "v2",
    status: "active",
    items: [{ id: "item_1", offeringRef: "plan", quantity: 2 }],
  };
}

let refSeq = 0;
/** A simulated provider operation record for an attempt, bound in every identity field, final past the settlement. */
function operationRecord(ctx: Ctx, attemptId: string, classification: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const attempt = ctx.store.getAttempt(attemptId)!;
  const base: Record<string, unknown> =
    classification === "CONFIRMED_LANDING"
      ? {
          source: "PROVIDER_OPERATION_LOG",
          kind: "OPERATION_LOG_RECORD_FOR_KEY",
          reference: `oplog-ref-${++refSeq}`,
          operationFound: true,
          providerOperationId: "op_59_landing",
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
/** Stage the record at the rig's source and establish through the rig's verifier (the only minting path). */
function establish(rig: Rig, attemptId: string, classification: string, overrides: Record<string, unknown> = {}): any {
  stageOperationRecord(rig, attemptId, classification, overrides);
  const attempt = rig.store.getAttempt(attemptId)!;
  return rig.verifier.establish(attempt, classification, rig.now());
}

let finSeq = 0;
/** A simulated financial reconciliation record, bound to the attempt AND to the resolution's evidence reference. */
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
function resolveInput(classification: string, token: unknown, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    evidence: token,
    operatorId: "operator-1",
    reconciliationDecision: classification === "CONFIRMED_LANDING" ? "RECONCILE_LANDED_STATE_NO_REDISPATCH" : "PERMIT_NEW_DISPATCH",
    justification:
      classification === "CONFIRMED_LANDING"
        ? "Provider operation log records this attempt's idempotency key as executed; landed state to be reconciled, no re-dispatch."
        : "Provider operation log, final through the settlement, records no operation for this attempt's idempotency key.",
    ...overrides,
  };
}
function resolveValid(rig: Rig, attemptId: string, classification: string, recordOverrides: Record<string, unknown> = {}): any {
  const token = establish(rig, attemptId, classification, recordOverrides);
  return resolve(rig.store, attemptId, resolveInput(classification, token));
}
function recordAsserted(store: DurableQuoteStore, attemptId: string, input: unknown): any {
  return (store as any).recordAssertedResolution(attemptId, input);
}
function reconcileLanded(store: DurableQuoteStore, attemptId: string, input: unknown): any {
  return (store as any).reconcileLandedAttempt(attemptId, input);
}
function resolutions(store: DurableQuoteStore, attemptId: string): any[] {
  return typeof (store as any).resolutionsForAttempt === "function" ? (store as any).resolutionsForAttempt(attemptId) : [];
}
function getResolution(store: DurableQuoteStore, attemptId: string): any {
  return typeof (store as any).getResolution === "function" ? (store as any).getResolution(attemptId) : undefined;
}
function landingReconciliation(store: DurableQuoteStore, attemptId: string): any {
  return typeof (store as any).landingReconciliationFor === "function" ? (store as any).landingReconciliationFor(attemptId) : undefined;
}
function landingReconciliationRecord(store: DurableQuoteStore, attemptId: string): any {
  return typeof (store as any).landingReconciliationRecordFor === "function" ? (store as any).landingReconciliationRecordFor(attemptId) : undefined;
}
function isEvidenceRefusal(e: unknown): boolean {
  return (e as { code?: string })?.code === "RESOLUTION_EVIDENCE_REFUSED";
}

// ---------------------------------------------------------------------------
// 59.1 R2' counterexample (the review's exact negative): a developer
// with getAttempt() and the library's public API but NO provider
// access must not be able to free another quote on the subscription.
// ---------------------------------------------------------------------------

test("Test 59.1 (R2'): no public minting path — a fabricated final no-operation record cannot free another quote; the asserted path records a claim and lifts nothing", () => {
  // The round-2 public establishment function is GONE from the
  // package's public surface.
  assert.equal(
    (publicApi as any).establishResolutionEvidence,
    undefined,
    "the public record-minting function must not be exported — it branded caller-asserted objects",
  );

  // A store with NO configured verifier: the fail-closed default.
  const rig = openRig(tmpDb(), { verifier: false });
  rig.store.put(makeStoredQuote("q1", "sub_1"));
  rig.store.put(makeStoredQuote("q2", "sub_1"));
  const attemptId = settleIndeterminate(rig);
  rig.tick(60_000);
  const attempt = rig.store.getAttempt(attemptId)!;

  // (a) A hand-assembled token-shaped object over a fabricated,
  // syntactically plausible FINAL no-operation record: unbranded,
  // refused.
  const fabricatedRecord = operationRecord(rig, attemptId, "CONFIRMED_NON_EXECUTION", { reference: "oplog-ref-invented" });
  const handAssembledToken = {
    attemptId,
    quoteId: attempt.quoteId,
    subscriptionId: attempt.subscriptionId,
    provider: attempt.provider,
    site: attempt.site,
    requestHash: attempt.requestHash,
    idempotencyKey: attempt.idempotencyKey,
    classification: "CONFIRMED_NON_EXECUTION",
    source: fabricatedRecord.source,
    kind: fabricatedRecord.kind,
    reference: fabricatedRecord.reference,
    operationFound: false,
    providerOperationId: null,
    observedAt: fabricatedRecord.observedAt,
    observedProviderStateDigest: sha256(canonical(fabricatedRecord.observedState)),
    logFinal: true,
    completeThrough: fabricatedRecord.completeThrough,
    registryCoverage: null,
    landedStateVersion: null,
  };
  assert.throws(
    () => resolve(rig.store, attemptId, resolveInput("CONFIRMED_NON_EXECUTION", handAssembledToken)),
    (e: unknown) => isEvidenceRefusal(e),
    "a hand-assembled token over a fabricated record is self-asserted and refuses",
  );

  // (b) A GENUINELY branded token — minted by a verifier the
  // developer created over their OWN fabricated source. The store
  // does not hold that verifier (it holds none), so the token is
  // not acceptable capability: refused.
  const attackerSource = { fetchOperationRecord: () => fabricatedRecord };
  const attackerVerifier = createProviderEvidenceVerifier(attackerSource);
  const attackerToken = attackerVerifier.establish(attempt, "CONFIRMED_NON_EXECUTION", rig.now());
  assert.throws(
    () => resolve(rig.store, attemptId, resolveInput("CONFIRMED_NON_EXECUTION", attackerToken)),
    (e: unknown) => isEvidenceRefusal(e),
    "a token minted by a verifier the store does not hold is not evidence THIS store accepts",
  );
  assert.equal(resolutions(rig.store, attemptId).length, 0, "both refusals persisted zero rows");

  // The review's bottom line: another quote on the subscription
  // remains BLOCKED, and so does the attempt's own quote.
  assert.throws(() => rig.store.beginDispatch(INTENT("q2", "sub_1", "key-2")), DispatchBlockedError, "another quote stays blocked");
  assert.throws(() => rig.store.beginDispatch(INTENT("q1", "sub_1", "key-1b")), DispatchBlockedError, "the same quote stays blocked");

  // (c) The fail-closed asserted path: the operator's claim is
  // recorded for audit — and lifts NOTHING.
  const after = recordAsserted(rig.store, attemptId, {
    classification: "CONFIRMED_NON_EXECUTION",
    operatorId: "operator-1",
    justification: "Operator believes, from an out-of-band console check, that the operation did not execute; no verified provider evidence is available.",
  });
  assert.equal(after.operatorReviewState, "REQUIRED", "an asserted claim does not set the resolved flag");
  const rows = resolutions(rig.store, attemptId);
  assert.equal(rows.length, 1, "the asserted claim is appended for audit");
  assert.equal(rows[0].classification, "CONFIRMED_NON_EXECUTION");
  assert.equal(rows[0].trustTier, "ASSERTED", "the claim is recorded at the ASSERTED trust tier");
  assert.throws(() => rig.store.beginDispatch(INTENT("q2", "sub_1", "key-2")), DispatchBlockedError, "an asserted claim never frees another quote");
  assert.throws(() => rig.store.beginDispatch(INTENT("q1", "sub_1", "key-1b")), DispatchBlockedError, "an asserted claim never frees the same quote");

  const item = rig.store.recoveryReport().indeterminateOutcomes.find((i) => i.attemptId === attemptId) as any;
  assert.equal(item?.resolution?.classification, "CONFIRMED_NON_EXECUTION", "the report surfaces the asserted claim's classification");
  assert.equal(item?.resolution?.trustTier, "ASSERTED_UNVERIFIED", "the report marks the claim unverified");
  assert.equal(item?.operatorInterventionRequired, true, "an asserted claim still requires intervention");
  assert.match(String(item?.nextPermittedAction), /unverified/i);
  assert.match(String(item?.nextPermittedAction), /No automatic re-dispatch is permitted\./);
  rig.store.close();
});

// ---------------------------------------------------------------------------
// 59.2 Verifier-instance binding: a store accepts ONLY its own
// configured verifier's tokens — a different instance over the SAME
// source data refuses; the configured instance is the positive
// control.
// ---------------------------------------------------------------------------

test("Test 59.2: verifier-instance binding — tokens from another verifier instance refuse; the store's own verifier resolves (positive control)", () => {
  const rig = openRig();
  rig.store.put(makeStoredQuote("q1", "sub_1"));
  rig.store.put(makeStoredQuote("q2", "sub_1"));
  const attemptId = settleIndeterminate(rig);
  rig.tick(60_000);
  const attempt = rig.store.getAttempt(attemptId)!;
  stageOperationRecord(rig, attemptId, "CONFIRMED_NON_EXECUTION");

  // A second verifier instance over the very same source: its
  // tokens are genuinely branded, but they are not THIS store's
  // capability.
  const otherVerifier = createProviderEvidenceVerifier(rig.source.api);
  const foreignToken = otherVerifier.establish(attempt, "CONFIRMED_NON_EXECUTION", rig.now());
  assert.throws(
    () => resolve(rig.store, attemptId, resolveInput("CONFIRMED_NON_EXECUTION", foreignToken)),
    (e: unknown) => isEvidenceRefusal(e),
    "a token minted by a different verifier instance refuses (verifier mismatch)",
  );
  assert.equal(resolutions(rig.store, attemptId).length, 0);

  // Positive control: the store's own verifier.
  const token = rig.verifier.establish(attempt, "CONFIRMED_NON_EXECUTION", rig.now());
  const resolved = resolve(rig.store, attemptId, resolveInput("CONFIRMED_NON_EXECUTION", token));
  assert.equal(resolved.operatorReviewState, "RESOLVED");
  const record = getResolution(rig.store, attemptId);
  assert.equal(record?.trustTier, "VERIFIED", "a resolution established through the store's verifier persists at the VERIFIED tier");

  assert.throws(
    () => rig.store.beginDispatch(INTENT("q1", "sub_1", "key-2")),
    DispatchBlockedError,
    "R1 retained: the resolved attempt's own quote stays blocked for any key",
  );
  const fresh = rig.store.beginDispatch(INTENT("q2", "sub_1", "key-2"));
  assert.equal(fresh.state, "DISPATCHING", "a genuinely new quote dispatches after a VERIFIED resolution");
  rig.store.close();
});

// ---------------------------------------------------------------------------
// 59.3 Source indirection: the verifier RETRIEVES the record through
// a binding-built query — no record, a record about a different
// operation, and a non-final record all refuse inside the verifier.
// ---------------------------------------------------------------------------

test("Test 59.3: source indirection — the verifier fetches by attempt binding; missing, foreign, and non-final records refuse", () => {
  const rig = openRig();
  rig.store.put(makeStoredQuote("q1", "sub_1"));
  const attemptId = settleIndeterminate(rig);
  rig.tick(60_000);
  const attempt = rig.store.getAttempt(attemptId)!;

  // (a) The source has no record for this operation.
  assert.throws(
    () => rig.verifier.establish(attempt, "CONFIRMED_NON_EXECUTION", rig.now()),
    (e: unknown) => isEvidenceRefusal(e),
    "no record at the source: nothing can be established",
  );
  // The query the verifier issued was built from the attempt binding.
  const query = rig.source.operationQueries[rig.source.operationQueries.length - 1];
  assert.equal(query.provider, attempt.provider);
  assert.equal(query.site, attempt.site);
  assert.equal(query.subscriptionId, attempt.subscriptionId);
  assert.equal(query.quoteId, attempt.quoteId);
  assert.equal(query.idempotencyKey, attempt.idempotencyKey);
  assert.equal(query.requestHash, attempt.requestHash);

  // (b) The source returns a record about a DIFFERENT operation.
  stageOperationRecord(rig, attemptId, "CONFIRMED_NON_EXECUTION", { idempotencyKey: "key-OTHER", quoteId: "q-other" });
  assert.throws(
    () => rig.verifier.establish(attempt, "CONFIRMED_NON_EXECUTION", rig.now()),
    (e: unknown) => isEvidenceRefusal(e),
    "a record bound to a different operation establishes nothing about this attempt",
  );

  // (c) The source returns a record, but it is not final (R3 rules
  // retained inside the verifier).
  stageOperationRecord(rig, attemptId, "CONFIRMED_NON_EXECUTION", { logFinal: false });
  assert.throws(
    () => rig.verifier.establish(attempt, "CONFIRMED_NON_EXECUTION", rig.now()),
    (e: unknown) => isEvidenceRefusal(e),
    "a non-final record cannot establish non-execution",
  );

  assert.equal(resolutions(rig.store, attemptId).length, 0, "every refusal persisted zero rows");
  assert.throws(() => rig.store.beginDispatch(INTENT("q1", "sub_1", "key-1b")), DispatchBlockedError);
  rig.store.close();
});

// ---------------------------------------------------------------------------
// 59.4 R4' counterexample (the review's exact negative): a correct
// landed digest + an arbitrary fresh well-formed financial hash,
// with NO actual financial reconciliation, must NOT make a new
// quote dispatch-eligible.
// ---------------------------------------------------------------------------

test("Test 59.4 (R4'): caller digests are not a reconciliation path — the barrier requires source-fetched, operation-bound reconciliation evidence", () => {
  // The source starts WITHOUT any financial-reconciliation
  // capability at all.
  const rig = openRig(tmpDb(), { reconciliation: false });
  rig.store.put(makeStoredQuote("q1", "sub_1"));
  rig.store.put(makeStoredQuote("q2", "sub_1"));
  const attemptId = settleIndeterminate(rig, "q1", "sub_1", "key-1");
  rig.tick(60_000);

  resolveValid(rig, attemptId, "CONFIRMED_LANDING");
  const resolution = getResolution(rig.store, attemptId);
  assert.equal(resolution?.classification, "CONFIRMED_LANDING");
  assert.equal(resolution?.trustTier, "VERIFIED");

  // (a) The round-2 argument shape: the CORRECT landed-state digest
  // (publicly readable from the store) plus sha256("not actually
  // reconciled") — the review's exact counterexample. There is no
  // such input path any more: refused.
  assert.throws(
    () =>
      reconcileLanded(rig.store, attemptId, {
        operatorId: "operator-1",
        landedStateDigest: resolution.observedProviderStateDigest,
        financialOutcomeDigest: sha256("not actually reconciled"),
        justification: "Trust me, the books are reconciled.",
      }),
    (e: unknown) => isEvidenceRefusal(e),
    "caller-supplied digests are refused — no digest input exists in the reconciliation path",
  );
  assert.equal(landingReconciliation(rig.store, attemptId), undefined, "the refused call recorded nothing");

  // (b) The clean round-3 shape, but the store's verifier has no
  // reconciliation capability (its source cannot fetch financial
  // reconciliations): refused — fail closed until an independent
  // reconciliation source exists.
  assert.throws(
    () =>
      reconcileLanded(rig.store, attemptId, {
        operatorId: "operator-1",
        justification: "Landed state and financial consequences reconciled against provider records.",
      }),
    (e: unknown) => isEvidenceRefusal(e),
    "without a reconciliation capability at the boundary, the barrier cannot be satisfied",
  );
  assert.equal(landingReconciliation(rig.store, attemptId), undefined);
  assert.throws(
    () => rig.store.beginDispatch(INTENT("q2", "sub_1", "key-3")),
    DispatchBlockedError,
    "the review's bottom line: no new quote became dispatch-eligible from either call",
  );

  // (c) Capability present, but the fetched record's landed state
  // is a DIFFERENT state than the resolution established: its
  // computed digest cannot match, refused.
  rig.source.api.fetchFinancialReconciliation = (query: Record<string, unknown>) => {
    rig.source.reconciliationQueries.push(query);
    return rig.source.reconciliationRecords.get(query.idempotencyKey as string);
  };
  stageReconciliation(rig, attemptId, resolution, {
    landedState: { id: "sub_1", version: "v2", status: "active", items: [] },
  });
  assert.throws(
    () =>
      reconcileLanded(rig.store, attemptId, {
        operatorId: "operator-1",
        justification: "Landed state and financial consequences reconciled against provider records.",
      }),
    (e: unknown) => isEvidenceRefusal(e),
    "a reconciliation of a different landed state refuses",
  );
  assert.equal(landingReconciliation(rig.store, attemptId), undefined);
  assert.throws(() => rig.store.beginDispatch(INTENT("q2", "sub_1", "key-3")), DispatchBlockedError);

  // (d) Positive control: the source returns a bound reconciliation
  // record whose landed state IS the established landed state.
  const finRecord = stageReconciliation(rig, attemptId, resolution);
  const reconciliation = reconcileLanded(rig.store, attemptId, {
    operatorId: "operator-1",
    justification: "Landed state and financial consequences reconciled against provider records.",
  });
  assert.equal(reconciliation.attemptId, attemptId);
  assert.equal(reconciliation.trustTier, "VERIFIED", "the barrier record persists at the VERIFIED tier");
  assert.equal(reconciliation.evidenceReference, finRecord.reference, "the barrier record names the reconciliation evidence it rests on");
  assert.equal(reconciliation.landedStateDigest, resolution.observedProviderStateDigest, "the landed digest was computed from the fetched record, not supplied");
  assert.equal(
    reconciliation.financialOutcomeDigest,
    sha256(canonical(finRecord.financialOutcome)),
    "the financial-outcome digest was computed from the fetched record's outcome, not supplied",
  );
  assert.deepEqual(landingReconciliation(rig.store, attemptId), reconciliation);
  const reconQuery = rig.source.reconciliationQueries[rig.source.reconciliationQueries.length - 1];
  assert.equal(reconQuery.resolutionReference, resolution.evidenceReference, "the reconciliation query is bound to the resolution's evidence reference");

  // The stale-quote rule still governs: q2 predates the landing.
  assert.throws(
    () => rig.store.beginDispatch(INTENT("q2", "sub_1", "key-3")),
    (e: unknown) => e instanceof DispatchBlockedError && /stale/i.test(e.message),
    "a pre-landing quote remains stale after a VERIFIED barrier",
  );
  // A fresh quote at the landed version is the positive case.
  rig.tick(1_000);
  rig.store.put({ ...makeStoredQuote("q3", "sub_1"), created_at: rig.nowIso(), subscription_version_at_quote: "v2" });
  const fresh = rig.store.beginDispatch(INTENT("q3", "sub_1", "key-5"));
  assert.equal(fresh.state, "DISPATCHING", "a fresh quote validated against the landed state may dispatch");
  rig.store.close();
});

// ---------------------------------------------------------------------------
// 59.5 Schema v3 → v4 migration: pre-v4 terminal resolutions and
// landing reconciliations were minted through the removed public
// path / caller digests — preserved and readable, backfilled
// ASSERTED, NON-LIFTING. A fresh v4 verifier-established resolution
// can still lift the attempt.
// ---------------------------------------------------------------------------

test("Test 59.5: a hand-built v3 database migrates to schema v4 — terminal + reconciliation rows preserved as ASSERTED and NON-LIFTING; a fresh v4 resolution lifts", () => {
  const path = tmpDb();
  const db = rawDb(path);
  // Base schema (identical across versions).
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
  // v3 attempt_resolutions (v2 shape + the v3 finality columns; NO trust_tier).
  db.exec(`CREATE TABLE attempt_resolutions (
     resolution_id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL, quote_id TEXT NOT NULL,
     subscription_id TEXT NOT NULL, provider TEXT NOT NULL, site TEXT,
     request_hash TEXT NOT NULL, idempotency_key TEXT NOT NULL, classification TEXT NOT NULL,
     operator_id TEXT NOT NULL, resolved_at TEXT NOT NULL, evidence_source TEXT NOT NULL,
     evidence_kind TEXT NOT NULL, evidence_reference TEXT NOT NULL, observed_at TEXT NOT NULL,
     observed_provider_state_digest TEXT NOT NULL, provider_operation_id TEXT,
     reconciliation_decision TEXT NOT NULL, justification TEXT NOT NULL,
     evidence_payload_json TEXT NOT NULL, evidence_hash TEXT NOT NULL UNIQUE,
     log_final INTEGER, complete_through TEXT, registry_coverage TEXT, landed_state_version TEXT)`);
  db.exec(`CREATE INDEX idx_attempt_resolutions_attempt ON attempt_resolutions(attempt_id)`);
  db.exec(`CREATE UNIQUE INDEX idx_attempt_resolutions_evidence_ref ON attempt_resolutions(evidence_source, evidence_reference) WHERE classification != 'UNRESOLVED'`);
  // v3 landing_reconciliations (NO trust_tier / evidence_reference).
  db.exec(`CREATE TABLE landing_reconciliations (
     reconciliation_id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL UNIQUE, quote_id TEXT NOT NULL,
     subscription_id TEXT NOT NULL, landed_state_version TEXT NOT NULL, landed_state_digest TEXT NOT NULL,
     financial_outcome_digest TEXT NOT NULL, operator_id TEXT NOT NULL, reconciled_at TEXT NOT NULL,
     justification TEXT NOT NULL, payload_json TEXT NOT NULL, record_hash TEXT NOT NULL UNIQUE)`);
  db.exec(`CREATE INDEX idx_landing_reconciliations_attempt ON landing_reconciliations(attempt_id)`);
  db.prepare(`INSERT INTO meta (key, value) VALUES ('schema_version', '3')`).run();
  db.prepare(`INSERT INTO meta (key, value) VALUES ('created_at', '2026-10-30T00:00:00.000Z')`).run();

  const insertAttempt = db.prepare(
    `INSERT INTO attempts (attempt_id, quote_id, subscription_id, provider, site, state, idempotency_key, request_hash, request_json, pre_dispatch_fingerprint, recovery_classification, outcome, details_json, operator_review_state, version, created_at, updated_at)
     VALUES (?,?,?,?,?,'INDETERMINATE',?,?,'{}',NULL,NULL,'INDETERMINATE',NULL,'RESOLVED',3,'2026-10-30T00:00:00.000Z','2026-10-30T00:01:00.000Z')`,
  );
  const insertResolution = db.prepare(
    `INSERT INTO attempt_resolutions (resolution_id, attempt_id, quote_id, subscription_id, provider, site, request_hash, idempotency_key, classification, operator_id, resolved_at, evidence_source, evidence_kind, evidence_reference, observed_at, observed_provider_state_digest, provider_operation_id, reconciliation_decision, justification, evidence_payload_json, evidence_hash, log_final, complete_through, registry_coverage, landed_state_version)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,'2026-10-30T00:05:00.000Z',NULL,?)`,
  );

  // Attempt A: v3-era terminal CONFIRMED_NON_EXECUTION (was lifting under v3).
  const execRequestHash = sha256("v3 exec request");
  insertAttempt.run("att_v3_exec", "q-v3", "sub_v3", "chargebee", "site-a", "key-v3", execRequestHash);
  const execPayload = {
    resolutionId: "res_v3_exec",
    attemptId: "att_v3_exec",
    quoteId: "q-v3",
    subscriptionId: "sub_v3",
    provider: "chargebee",
    site: "site-a",
    requestHash: execRequestHash,
    idempotencyKey: "key-v3",
    classification: "CONFIRMED_NON_EXECUTION",
    operatorId: "operator-1",
    resolvedAt: "2026-10-30T00:10:00.000Z",
    evidenceSource: "PROVIDER_OPERATION_LOG",
    evidenceKind: "OPERATION_LOG_NO_RECORD_FOR_KEY",
    evidenceReference: "oplog-v3-ref",
    observedAt: "2026-10-30T00:05:00.000Z",
    observedProviderStateDigest: sha256("v3 observed state"),
    providerOperationId: null,
    reconciliationDecision: "PERMIT_NEW_DISPATCH",
    justification: "v3-era resolution via the (then public) establishment procedure.",
    logFinal: true,
    completeThrough: "2026-10-30T00:05:00.000Z",
    registryCoverage: null,
    landedStateVersion: null,
    establishmentProcedure: "establishResolutionEvidence",
  };
  insertResolution.run(
    execPayload.resolutionId, execPayload.attemptId, execPayload.quoteId, execPayload.subscriptionId, execPayload.provider, execPayload.site,
    execPayload.requestHash, execPayload.idempotencyKey, execPayload.classification, execPayload.operatorId, execPayload.resolvedAt,
    execPayload.evidenceSource, execPayload.evidenceKind, execPayload.evidenceReference, execPayload.observedAt,
    execPayload.observedProviderStateDigest, execPayload.providerOperationId, execPayload.reconciliationDecision,
    execPayload.justification, JSON.stringify(execPayload), sha256(canonical(execPayload)), null,
  );

  // Attempt B: v3-era CONFIRMED_LANDING + a recorded reconciliation (was unblocking under v3).
  const landRequestHash = sha256("v3 land request");
  const v3LandedState = landedStateFor("sub_v3l");
  const v3LandedDigest = sha256(canonical(v3LandedState));
  insertAttempt.run("att_v3_land", "q-v3l", "sub_v3l", "chargebee", "site-a", "key-v3l", landRequestHash);
  const landPayload = {
    resolutionId: "res_v3_land",
    attemptId: "att_v3_land",
    quoteId: "q-v3l",
    subscriptionId: "sub_v3l",
    provider: "chargebee",
    site: "site-a",
    requestHash: landRequestHash,
    idempotencyKey: "key-v3l",
    classification: "CONFIRMED_LANDING",
    operatorId: "operator-1",
    resolvedAt: "2026-10-30T00:10:00.000Z",
    evidenceSource: "PROVIDER_OPERATION_LOG",
    evidenceKind: "OPERATION_LOG_RECORD_FOR_KEY",
    evidenceReference: "oplog-v3-land-ref",
    observedAt: "2026-10-30T00:05:00.000Z",
    observedProviderStateDigest: v3LandedDigest,
    providerOperationId: "op_v3_land",
    reconciliationDecision: "RECONCILE_LANDED_STATE_NO_REDISPATCH",
    justification: "v3-era landing resolution via the (then public) establishment procedure.",
    logFinal: true,
    completeThrough: "2026-10-30T00:05:00.000Z",
    registryCoverage: null,
    landedStateVersion: "v2",
    establishmentProcedure: "establishResolutionEvidence",
  };
  insertResolution.run(
    landPayload.resolutionId, landPayload.attemptId, landPayload.quoteId, landPayload.subscriptionId, landPayload.provider, landPayload.site,
    landPayload.requestHash, landPayload.idempotencyKey, landPayload.classification, landPayload.operatorId, landPayload.resolvedAt,
    landPayload.evidenceSource, landPayload.evidenceKind, landPayload.evidenceReference, landPayload.observedAt,
    landPayload.observedProviderStateDigest, landPayload.providerOperationId, landPayload.reconciliationDecision,
    landPayload.justification, JSON.stringify(landPayload), sha256(canonical(landPayload)), "v2",
  );
  const reconPayload = {
    reconciliationId: "rec_v3_land",
    attemptId: "att_v3_land",
    quoteId: "q-v3l",
    subscriptionId: "sub_v3l",
    landedStateVersion: "v2",
    landedStateDigest: v3LandedDigest,
    financialOutcomeDigest: sha256("v3 financial outcome record"),
    operatorId: "operator-1",
    reconciledAt: "2026-10-30T00:12:00.000Z",
    justification: "v3-era barrier record (caller-supplied digests).",
  };
  db.prepare(
    `INSERT INTO landing_reconciliations (reconciliation_id, attempt_id, quote_id, subscription_id, landed_state_version, landed_state_digest, financial_outcome_digest, operator_id, reconciled_at, justification, payload_json, record_hash)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    reconPayload.reconciliationId, reconPayload.attemptId, reconPayload.quoteId, reconPayload.subscriptionId,
    reconPayload.landedStateVersion, reconPayload.landedStateDigest, reconPayload.financialOutcomeDigest,
    reconPayload.operatorId, reconPayload.reconciledAt, reconPayload.justification,
    JSON.stringify(reconPayload), sha256(canonical(reconPayload)),
  );
  db.close();

  // Open with v4 code: migration runs.
  const store = new DurableQuoteStore(path, { recoveryGraceMs: 0 });
  const check = rawDb(path);
  const version = check.prepare(`SELECT value FROM meta WHERE key='schema_version'`).get() as { value: string };
  assert.equal(version.value, "4", "the v3 database was migrated to schema v4");
  const tiers = check.prepare(`SELECT resolution_id, trust_tier FROM attempt_resolutions ORDER BY resolution_id`).all() as Array<{ resolution_id: string; trust_tier: string }>;
  assert.deepEqual(
    tiers.map((t) => [t.resolution_id, t.trust_tier]),
    [["res_v3_exec", "ASSERTED"], ["res_v3_land", "ASSERTED"]],
    "every pre-v4 resolution row is backfilled ASSERTED — none is silently upgraded to VERIFIED",
  );
  const reconTier = check.prepare(`SELECT trust_tier, evidence_reference FROM landing_reconciliations WHERE reconciliation_id='rec_v3_land'`).get() as { trust_tier: string; evidence_reference: unknown };
  assert.equal(reconTier.trust_tier, "ASSERTED", "the pre-v4 reconciliation row is backfilled ASSERTED");
  assert.equal(reconTier.evidence_reference, null, "the pre-v4 reconciliation row carries no evidence reference");
  check.close();

  // Preserved and readable…
  const execRecord = getResolution(store, "att_v3_exec");
  assert.ok(execRecord, "the v3-era resolution record is preserved and readable");
  assert.equal(execRecord.classification, "CONFIRMED_NON_EXECUTION");
  assert.equal(execRecord.trustTier, "ASSERTED");
  const reconRecord = landingReconciliationRecord(store, "att_v3_land");
  assert.ok(reconRecord, "the v3-era reconciliation record is preserved and readable via the raw reader");
  assert.equal(reconRecord.trustTier, "ASSERTED");

  // …but NON-LIFTING: neither record satisfies any blocking lookup.
  assert.equal(landingReconciliation(store, "att_v3_land"), undefined, "an ASSERTED reconciliation does not satisfy the barrier");
  assert.equal(
    store.findBlockingAttempt("q-v3-other", "sub_v3")?.attemptId,
    "att_v3_exec",
    "the v3-era non-execution resolution no longer lifts — its attempt blocks again",
  );
  assert.equal(
    store.findBlockingAttempt("q-v3l-other", "sub_v3l")?.attemptId,
    "att_v3_land",
    "the v3-era landing + reconciliation no longer unblocks — its attempt blocks again",
  );
  store.close();

  // A fresh v4 resolution, established through a configured
  // verifier from a fresh provider record, CAN lift attempt A.
  let nowMs = Date.parse("2026-10-31T12:00:00.000Z");
  const source = makeSource(true);
  const verifier = createProviderEvidenceVerifier(source.api);
  const store2 = new DurableQuoteStore(path, { recoveryGraceMs: 0, now: () => new Date(nowMs), evidenceVerifier: verifier } as DurableStoreOptions);
  const ctx: Ctx = { store: store2, nowIso: () => new Date(nowMs).toISOString() };
  const freshRecord = operationRecord(ctx, "att_v3_exec", "CONFIRMED_NON_EXECUTION", { reference: "oplog-v4-fresh-ref" });
  source.operationRecords.set("key-v3", freshRecord);
  const attemptA = store2.getAttempt("att_v3_exec")!;
  const token = verifier.establish(attemptA, "CONFIRMED_NON_EXECUTION", new Date(nowMs));
  resolve(store2, "att_v3_exec", resolveInput("CONFIRMED_NON_EXECUTION", token));
  assert.equal(resolutions(store2, "att_v3_exec").length, 2, "the v4 VERIFIED record is appended alongside the preserved ASSERTED one");
  const current = getResolution(store2, "att_v3_exec");
  assert.equal(current?.trustTier, "VERIFIED", "the attempt's governing resolution is now the VERIFIED one");
  store2.put(makeStoredQuote("q-v3-new", "sub_v3"));
  const fresh = store2.beginDispatch(INTENT("q-v3-new", "sub_v3", "key-v3-new"));
  assert.equal(fresh.state, "DISPATCHING", "a new quote dispatches once a VERIFIED v4 resolution exists");
  store2.close();
});

// ---------------------------------------------------------------------------
// 59.6 An ASSERTED landing claim satisfies nothing: it does not
// unblock, and it does not satisfy the reconciliation barrier.
// UNRESOLVED stays on its own audit-only method.
// ---------------------------------------------------------------------------

test("Test 59.6: an asserted CONFIRMED_LANDING claim never unblocks and never satisfies the barrier", () => {
  const rig = openRig(tmpDb(), { verifier: false });
  rig.store.put(makeStoredQuote("q1", "sub_1"));
  rig.store.put(makeStoredQuote("q2", "sub_1"));
  const attemptId = settleIndeterminate(rig, "q1", "sub_1", "key-1");
  rig.tick(60_000);

  recordAsserted(rig.store, attemptId, {
    classification: "CONFIRMED_LANDING",
    operatorId: "operator-1",
    justification: "Operator believes the operation landed, from an out-of-band console check; no verified provider evidence is available.",
  });
  const rows = resolutions(rig.store, attemptId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].classification, "CONFIRMED_LANDING");
  assert.equal(rows[0].trustTier, "ASSERTED");

  assert.equal(
    rig.store.findBlockingAttempt("q2", "sub_1")?.attemptId,
    attemptId,
    "an asserted landing blocks the whole subscription exactly like an unresolved attempt",
  );
  assert.throws(() => rig.store.beginDispatch(INTENT("q2", "sub_1", "key-3")), DispatchBlockedError);
  assert.equal(landingReconciliation(rig.store, attemptId), undefined, "no barrier record exists");
  assert.throws(
    () =>
      reconcileLanded(rig.store, attemptId, {
        operatorId: "operator-1",
        justification: "Reconcile on the strength of the asserted claim.",
      }),
    (e: unknown) => isEvidenceRefusal(e),
    "an asserted landing is not an established landing — there is nothing the barrier can rest on",
  );

  const item = rig.store.recoveryReport().indeterminateOutcomes.find((i) => i.attemptId === attemptId) as any;
  assert.equal(item?.resolution?.classification, "CONFIRMED_LANDING");
  assert.equal(item?.resolution?.trustTier, "ASSERTED_UNVERIFIED");
  assert.equal(item?.operatorInterventionRequired, true);
  assert.match(String(item?.nextPermittedAction), /unverified/i);
  assert.match(String(item?.nextPermittedAction), /No automatic re-dispatch is permitted\./);

  // UNRESOLVED is not a claim classification for this method — it
  // stays on recordUnresolvedResolution.
  assert.throws(
    () =>
      recordAsserted(rig.store, attemptId, {
        classification: "UNRESOLVED",
        operatorId: "operator-1",
        justification: "Still unresolved.",
      }),
    (e: unknown) => isEvidenceRefusal(e),
    "UNRESOLVED recordings stay on recordUnresolvedResolution",
  );
  rig.store.close();
});

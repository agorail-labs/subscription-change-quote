// Durable, transactional quote/receipt store (SCQ v0.6.2, PR-8).
//
// Backend: SQLite via better-sqlite3, WAL journal mode,
// synchronous=FULL. Every write that spans related records (quote
// row + receipt record + mutation-attempt ledger row) commits in
// ONE SQLite transaction (BEGIN IMMEDIATE): a crash either side of
// the commit leaves exactly one of the two complete states, never a
// partial receipt or a torn verification trail.
//
// This class EXTENDS the in-memory QuoteStore and routes every
// receipt recording / verification through the parent's existing
// validation semantics unchanged (identity digest, binding checks,
// established-evidence requirement, restore coherence). The durable
// layer adds persistence AROUND those semantics; it never replaces
// or weakens them. On open, persisted receipt records are adopted
// ONLY through the parent's restoreReceiptRecords coherence
// validation, after per-record checksum and identity-digest
// re-verification; any corruption refuses the whole set and the
// store does not open (fail closed — see DurableRecoveryError).
//
// Loading of the native binding is LAZY: it happens only when a
// DurableQuoteStore is constructed, so modules and tests that never
// touch durable persistence never load better-sqlite3.
//
// What durability does and does not claim: it provides
// exactly-once RECORDING and at-most-once dispatch AUTHORIZATION
// (a quote's mutation may be authorized for dispatch at most once;
// unresolved attempts block re-dispatch). It does NOT create true
// exactly-once provider execution — Chargebee's native idempotency
// remains a limited backstop, and a dispatch whose response is lost
// recovers as INDETERMINATE (PR #16 L1: a matching observed state
// after restart is NOT proof this mutation executed).
//
// No credentials or authorization headers are ever written here:
// records contain quotes, requests, receipts, and outcomes only.

import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { SCQError, type MutationOutcome, type SubscriptionChangeReceipt, type VerificationEvidence } from "../core/types.js";
import {
  QuoteStore,
  receiptIdentityDigest,
  type QuoteStatus,
  type StoredQuote,
} from "./quote-store.js";

export const DURABLE_SCHEMA_VERSION = 1;

export class DurableStoreError extends Error {
  readonly code: string = "DURABLE_STORE_ERROR";
  constructor(message: string, readonly details?: Record<string, unknown>) {
    super(message);
    this.name = "DurableStoreError";
  }
}

/** Recovery/open failure: persisted state was corrupt, incoherent, or of an unsupported schema. Nothing was adopted. */
export class DurableRecoveryError extends DurableStoreError {
  override readonly code = "DURABLE_RECOVERY_REFUSED";
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, details);
    this.name = "DurableRecoveryError";
  }
}

/** A dispatch was refused because a prior unresolved attempt (or a conflicting idempotency key) blocks it. */
export class DispatchBlockedError extends Error {
  readonly code = "DISPATCH_BLOCKED";
  constructor(message: string, readonly details?: Record<string, unknown>) {
    super(message);
    this.name = "DispatchBlockedError";
  }
}

// ---------------------------------------------------------------------------
// Persistence representation
// ---------------------------------------------------------------------------

/**
 * JSON round-tripping discards `undefined`-valued members, and the
 * parent store's receipts deliberately carry such members (e.g.
 * `credit: undefined`): a stored copy that silently loses them is
 * not the recorded receipt. The persistence representation encodes
 * `undefined` as an explicit sentinel object so a recovered record
 * deep-equals the pre-restart record member-for-member, including
 * its undefined-valued keys. The identity digest is unaffected (it
 * is JSON-based and drops those members deterministically on both
 * sides of every comparison).
 */
const UNDEFINED_SENTINEL = "$scqUndefined";
export function encodeForPersistence(value: unknown): unknown {
  if (value === undefined) return { [UNDEFINED_SENTINEL]: true };
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(encodeForPersistence);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = encodeForPersistence(v);
  return out;
}
export function decodeFromPersistence(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(decodeFromPersistence);
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 1 && entries[0][0] === UNDEFINED_SENTINEL && entries[0][1] === true) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of entries) out[k] = decodeFromPersistence(v);
  return out;
}

export function encodeRecordJson(value: unknown): string {
  return JSON.stringify(encodeForPersistence(value));
}
export function decodeRecordJson<T>(json: string): T {
  return decodeFromPersistence(JSON.parse(json)) as T;
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Local structural copy/freeze (the parent store's are module-private). Preserves undefined-valued keys. */
function deepCopyLocal<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((child) => deepCopyLocal(child)) as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = deepCopyLocal(v);
  return out as T;
}
function deepFreezeLocal<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreezeLocal(child);
    Object.freeze(value);
  }
  return value;
}

/** Canonical serialization (sorted keys, undefined members dropped) for request hashing. */
export function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalStringify(v)}`).join(",")}}`;
}
export function requestHashOf(request: unknown): string {
  return sha256(canonicalStringify(request));
}

// ---------------------------------------------------------------------------
// Mutation attempt ledger
// ---------------------------------------------------------------------------

export type AttemptState =
  | "PREPARED"
  | "DISPATCHING"
  | "COMMITTED_AND_VERIFIED"
  | "COMMITTED_UNVERIFIED"
  | "INDETERMINATE"
  | "CONFIRMED_NON_EXECUTION"
  | "SUPERSEDED";

export type MutationIntent = {
  quoteId: string;
  subscriptionId: string;
  provider: string;
  /** Provider site identifier (e.g. the Chargebee site). Never a credential. */
  site?: string;
  /** The exact canonical provider request that will be dispatched. */
  request: unknown;
  idempotencyKey: string;
  preDispatchFingerprint?: string;
};

export type StoredAttempt = {
  attemptId: string;
  quoteId: string;
  subscriptionId: string;
  provider: string;
  site: string | null;
  state: AttemptState;
  idempotencyKey: string;
  requestHash: string;
  request: unknown;
  preDispatchFingerprint: string | null;
  recoveryClassification: string | null;
  outcome: MutationOutcome | null;
  details: unknown;
  operatorReviewState: "NONE" | "REQUIRED" | "RESOLVED";
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type DurableStoreOptions = {
  busyTimeoutMs?: number;
  /**
   * Restart-recovery grace window: a DISPATCHING attempt younger
   * than this is NOT recovered on open, because a second process
   * opening the database cannot distinguish a crashed writer from
   * a live one mid-dispatch (the deployment model is a single
   * writer service; recovery targets ITS restart). Default 30s —
   * comfortably above any modeled dispatch. Tests that simulate a
   * crash pass 0: the writer is provably dead.
   */
  recoveryGraceMs?: number;
  /** Deterministic fault injection for crash/atomicity tests. Hooks run inside the persistence path; throwing simulates a crash/failure at that boundary. */
  faults?: {
    /** Called at the start of a persist operation, before any statement. */
    beforePersist?: (op: string) => void;
    /** Called INSIDE the persist transaction, after the first write statement. Throwing rolls the whole transaction back. */
    insidePersistTx?: (op: string) => void;
  };
  now?: () => Date;
};

type Db = Database.Database;

function loadSqlite(): typeof Database {
  try {
    const require = createRequire(import.meta.url);
    return require("better-sqlite3") as typeof Database;
  } catch (e) {
    throw new DurableStoreError(
      `Durable store unavailable: the better-sqlite3 native binding failed to load (${(e as Error).message}). ` +
        `Durable persistence is required in this configuration; there is no silent in-memory fallback.`,
    );
  }
}

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS quotes (
     quote_id TEXT PRIMARY KEY,
     subscription_id TEXT NOT NULL,
     provider TEXT NOT NULL,
     status TEXT NOT NULL,
     version INTEGER NOT NULL,
     record_json TEXT NOT NULL,
     record_sha TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS receipt_records (
     quote_id TEXT PRIMARY KEY,
     recorded_json TEXT NOT NULL,
     current_json TEXT NOT NULL,
     identity_digest TEXT NOT NULL,
     verifications_json TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS attempts (
     attempt_id TEXT PRIMARY KEY,
     quote_id TEXT NOT NULL,
     subscription_id TEXT NOT NULL,
     provider TEXT NOT NULL,
     site TEXT,
     state TEXT NOT NULL,
     idempotency_key TEXT NOT NULL UNIQUE,
     request_hash TEXT NOT NULL,
     request_json TEXT NOT NULL,
     pre_dispatch_fingerprint TEXT,
     recovery_classification TEXT,
     outcome TEXT,
     details_json TEXT,
     operator_review_state TEXT NOT NULL DEFAULT 'NONE',
     version INTEGER NOT NULL,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS attempt_history (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     attempt_id TEXT NOT NULL,
     state TEXT NOT NULL,
     at TEXT NOT NULL,
     note TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS idx_attempts_quote ON attempts(quote_id)`,
  `CREATE INDEX IF NOT EXISTS idx_attempts_subscription ON attempts(subscription_id)`,
];

export class DurableQuoteStore extends QuoteStore {
  private db: Db;
  private versions = new Map<string, number>();
  private poisoned: Error | undefined;
  private readonly recoveryGraceMs: number;
  private readonly faults: DurableStoreOptions["faults"];
  private readonly nowFn: () => Date;
  private attemptSeq = 0;

  constructor(
    private readonly dbPath: string,
    opts: DurableStoreOptions = {},
  ) {
    super();
    this.faults = opts.faults;
    this.recoveryGraceMs = opts.recoveryGraceMs ?? 30_000;
    this.nowFn = opts.now ?? (() => new Date());
    const Sqlite = loadSqlite();
    let db: Db;
    try {
      db = new Sqlite(dbPath, { timeout: opts.busyTimeoutMs ?? 5000 });
    } catch (e) {
      throw new DurableStoreError(`Durable store unavailable: cannot open database at ${dbPath} (${(e as Error).message}).`);
    }
    this.db = db;
    try {
      db.pragma("journal_mode = WAL");
      db.pragma("synchronous = FULL");
      db.pragma(`busy_timeout = ${Math.floor(opts.busyTimeoutMs ?? 5000)}`);
      this.migrate();
      this.loadAndRecover();
    } catch (e) {
      try { db.close(); } catch { /* already failing */ }
      throw e;
    }
  }

  close(): void {
    try { this.db.close(); } catch { /* closing twice is harmless */ }
  }

  // -- schema ---------------------------------------------------------------

  private migrate(): void {
    const hasMeta = this.db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='meta'`).get();
    if (hasMeta) {
      const row = this.db.prepare(`SELECT value FROM meta WHERE key='schema_version'`).get() as { value: string } | undefined;
      const version = row ? Number(row.value) : NaN;
      if (!Number.isInteger(version) || version !== DURABLE_SCHEMA_VERSION) {
        throw new DurableRecoveryError(
          `Recovery refused: unsupported durable schema version ${row?.value ?? "(missing)"}; this build supports ${DURABLE_SCHEMA_VERSION}. Nothing was adopted.`,
          { schemaVersion: row?.value ?? null },
        );
      }
      return;
    }
    const tx = this.db.transaction(() => {
      for (const stmt of SCHEMA_STATEMENTS) this.db.exec(stmt);
      this.db.prepare(`INSERT INTO meta (key, value) VALUES ('schema_version', ?)`).run(String(DURABLE_SCHEMA_VERSION));
      this.db.prepare(`INSERT INTO meta (key, value) VALUES ('created_at', ?)`).run(this.nowFn().toISOString());
    });
    tx.immediate();
  }

  // -- load + recovery --------------------------------------------------------

  private loadAndRecover(): void {
    const quoteRows = this.db.prepare(`SELECT * FROM quotes ORDER BY quote_id`).all() as Array<Record<string, unknown>>;
    const decodedQuotes: StoredQuote[] = [];
    for (const row of quoteRows) {
      const recordJson = row.record_json as string;
      if (sha256(recordJson) !== row.record_sha) {
        throw new DurableRecoveryError(
          `Recovery refused: the persisted quote record for ${row.quote_id} fails its integrity checksum — the record set is corrupt and nothing is adopted.`,
          { quoteId: row.quote_id },
        );
      }
      let quote: StoredQuote;
      try {
        quote = decodeRecordJson<StoredQuote>(recordJson);
      } catch (e) {
        throw new DurableRecoveryError(
          `Recovery refused: the persisted quote record for ${row.quote_id} is not decodable (${(e as Error).message}); nothing is adopted.`,
          { quoteId: row.quote_id },
        );
      }
      decodedQuotes.push(quote);
      this.versions.set(quote.quote_id, row.version as number);
    }
    // Adopt quotes WITHOUT their receipt fields first; receipt
    // records are then adopted exclusively through the parent's
    // coherence-validating restore path.
    for (const quote of decodedQuotes) {
      const { commit_receipt, commit_receipt_recorded, commit_receipt_identity_digest, commit_receipt_verifications, ...rest } =
        quote as StoredQuote & Record<string, unknown>;
      void commit_receipt; void commit_receipt_recorded; void commit_receipt_identity_digest; void commit_receipt_verifications;
      QuoteStore.prototype.put.call(this, rest as StoredQuote);
    }
    const receiptRows = this.db.prepare(`SELECT * FROM receipt_records ORDER BY quote_id`).all() as Array<Record<string, unknown>>;
    if (receiptRows.length > 0) {
      const records = receiptRows.map((row) => {
        let recorded: SubscriptionChangeReceipt; let current: SubscriptionChangeReceipt; let verifications: unknown[];
        try {
          recorded = decodeRecordJson<SubscriptionChangeReceipt>(row.recorded_json as string);
          current = decodeRecordJson<SubscriptionChangeReceipt>(row.current_json as string);
          verifications = decodeRecordJson<unknown[]>(row.verifications_json as string);
        } catch (e) {
          throw new DurableRecoveryError(
            `Recovery refused: the persisted receipt record for quote ${row.quote_id} is not decodable (${(e as Error).message}); nothing is adopted.`,
            { quoteId: row.quote_id },
          );
        }
        return { quote_id: row.quote_id as string, recorded_receipt: recorded, current_receipt: current, identity_digest: row.identity_digest as string, verifications };
      });
      try {
        QuoteStore.prototype.restoreReceiptRecords.call(this, JSON.stringify({ records }));
      } catch (e) {
        // The parent's validation refused the set (digest mismatch,
        // forged view, tampered trail, incoherent unit). Adoption is
        // all-or-nothing: refuse the open.
        if (e instanceof SCQError || e instanceof Error) {
          throw new DurableRecoveryError(`Recovery refused: ${(e as Error).message}`, { quoteId: records[0]?.quote_id });
        }
        throw e;
      }
      // The parent's restore API is JSON-shaped, and JSON drops
      // undefined-valued members; the validation it performed is
      // unaffected (the identity digest and the coherence canonical
      // form both drop those members deterministically). But the
      // ADOPTED records must be the recorded receipts verbatim —
      // undefined-valued keys included — so the in-memory records
      // the restore just adopted are replaced with the fully
      // decoded persisted values (same objects the validation
      // approved, member-for-member). This reaches the parent's
      // record map directly because the parent exposes no setter
      // for an already-validated record; it changes nothing the
      // validation decided.
      const internal = (this as unknown as { quotes: Map<string, StoredQuote> }).quotes;
      for (const rec of records) {
        const q = internal.get(rec.quote_id);
        if (!q) continue;
        q.commit_receipt_recorded = deepFreezeLocal(deepCopyLocal(rec.recorded_receipt));
        q.commit_receipt = deepCopyLocal(rec.current_receipt);
        q.commit_receipt_verifications = deepCopyLocal(rec.verifications) as StoredQuote["commit_receipt_verifications"];
      }
    }
    this.recoverAttempts();
  }

  /**
   * Deterministic attempt recovery, run on open. Rules:
   *  - an attempt whose quote carries a recorded receipt is
   *    completed FROM that receipt (the receipt record is the
   *    authority; the ledger row catches up);
   *  - a DISPATCHING attempt with no receipt and no terminal
   *    outcome is recovered as INDETERMINATE (it may have been
   *    dispatched; PR #16 L1 — observed state is never consulted
   *    as execution proof), and the INDETERMINATE outcome is
   *    recorded on the quote so the adapter's blind-retry guard
   *    engages after restart exactly as it did in-process;
   *  - a PREPARED attempt provably never reached dispatch (the
   *    protocol dispatches only after the DISPATCHING transition
   *    commits), so it is classified PREPARED_NOT_DISPATCHED and
   *    does not block a future attempt.
   */
  private recoverAttempts(): void {
    const graceMs = this.recoveryGraceMs;
    const rows = this.db.prepare(`SELECT * FROM attempts WHERE state IN ('PREPARED','DISPATCHING')`).all() as Array<Record<string, unknown>>;
    for (const row of rows) {
      const attempt = this.rowToAttempt(row);
      if (attempt.state === "DISPATCHING" && graceMs > 0 && Date.now() - Date.parse(attempt.updatedAt) < graceMs) {
        continue; // within the dispatch grace window: possibly a live writer; do not recover another process's in-flight attempt
      }
      const quote = QuoteStore.prototype.get.call(this, attempt.quoteId) as StoredQuote | undefined;
      if (quote?.commit_receipt_recorded) {
        const outcome = quote.commit_receipt_recorded.outcome === "COMMITTED_UNVERIFIED" ? "COMMITTED_UNVERIFIED" : "COMMITTED_AND_VERIFIED";
        this.completeAttemptRow(attempt.attemptId, outcome, outcome, "recovered from the recorded receipt on restart", attempt.version);
        continue;
      }
      if (attempt.state === "DISPATCHING") {
        this.completeAttemptRow(attempt.attemptId, "INDETERMINATE", "INDETERMINATE", "recovered on restart: dispatch was authorized and no terminal record exists; execution cannot be established", attempt.version);
        QuoteStore.prototype.recordCommitOutcome.call(this, attempt.quoteId, {
          outcome: "INDETERMINATE",
          at: this.nowFn().toISOString(),
          details: { recoveredOnRestart: true, attemptId: attempt.attemptId, reason: "process restarted with a DISPATCHING attempt and no recorded receipt or outcome; the mutation may have been dispatched and its landing cannot be established" },
        });
        this.persistQuote(attempt.quoteId, "recovery");
      } else {
        this.db.prepare(`UPDATE attempts SET recovery_classification = 'PREPARED_NOT_DISPATCHED' WHERE attempt_id = ?`).run(attempt.attemptId);
      }
    }
  }

  // -- persistence plumbing ---------------------------------------------------

  private assertHealthy(): void {
    if (this.poisoned) {
      throw new DurableStoreError(
        `Durable store is poisoned by an earlier persistence failure (${this.poisoned.message}); refusing further operations rather than diverging from durable state. Restart from the database to recover.`,
      );
    }
  }

  private failPoison(op: string, e: unknown): never {
    const err = e instanceof DurableStoreError ? e : new DurableStoreError(`Persistence failed during ${op}: ${(e as Error).message}`);
    this.poisoned = err;
    throw err;
  }

  /** Persists one quote (row + receipt record) in a single transaction, with version CAS. */
  private persistQuote(quoteId: string, op: string): void {
    this.faults?.beforePersist?.(op);
    const quote = QuoteStore.prototype.get.call(this, quoteId) as StoredQuote | undefined;
    if (!quote) return;
    const expected = this.versions.get(quoteId) ?? 0;
    const next = expected + 1;
    const recordJson = encodeRecordJson(quote);
    const recordSha = sha256(recordJson);
    try {
      const tx = this.db.transaction(() => {
        if (expected === 0) {
          this.db.prepare(
            `INSERT INTO quotes (quote_id, subscription_id, provider, status, version, record_json, record_sha, updated_at) VALUES (?,?,?,?,?,?,?,?)`,
          ).run(quoteId, quote.subscription_id, quote.provider, quote.status, next, recordJson, recordSha, this.nowFn().toISOString());
        } else {
          const res = this.db.prepare(
            `UPDATE quotes SET subscription_id=?, provider=?, status=?, version=?, record_json=?, record_sha=?, updated_at=? WHERE quote_id=? AND version=?`,
          ).run(quote.subscription_id, quote.provider, quote.status, next, recordJson, recordSha, this.nowFn().toISOString(), quoteId, expected);
          if (res.changes !== 1) {
            throw new DurableStoreError(`Stale writer refused: quote ${quoteId} was modified by another writer (expected version ${expected}); durable state was not overwritten.`);
          }
        }
        this.faults?.insidePersistTx?.(op);
        if (quote.commit_receipt_recorded) {
          this.db.prepare(
            `INSERT INTO receipt_records (quote_id, recorded_json, current_json, identity_digest, verifications_json) VALUES (?,?,?,?,?)
             ON CONFLICT(quote_id) DO UPDATE SET recorded_json=excluded.recorded_json, current_json=excluded.current_json, identity_digest=excluded.identity_digest, verifications_json=excluded.verifications_json`,
          ).run(
            quoteId,
            encodeRecordJson(quote.commit_receipt_recorded),
            encodeRecordJson(quote.commit_receipt),
            quote.commit_receipt_identity_digest,
            encodeRecordJson(quote.commit_receipt_verifications ?? []),
          );
        } else {
          this.db.prepare(`DELETE FROM receipt_records WHERE quote_id = ?`).run(quoteId);
        }
      });
      tx.immediate();
      this.versions.set(quoteId, next);
    } catch (e) {
      this.failPoison(op, e);
    }
  }

  // -- QuoteStore write-through overrides --------------------------------------

  override put(quote: StoredQuote): void {
    this.assertHealthy();
    QuoteStore.prototype.put.call(this, quote);
    this.persistQuote(quote.quote_id, "put");
  }

  override updateStatus(quoteId: string, status: QuoteStatus): void {
    this.assertHealthy();
    QuoteStore.prototype.updateStatus.call(this, quoteId, status);
    this.persistQuote(quoteId, "updateStatus");
  }

  override recordCommitReceipt(quoteId: string, receipt: SubscriptionChangeReceipt): SubscriptionChangeReceipt | undefined {
    this.assertHealthy();
    const recorded = QuoteStore.prototype.recordCommitReceipt.call(this, quoteId, receipt);
    this.persistQuote(quoteId, "recordCommitReceipt");
    return recorded;
  }

  override recordCommitOutcome(quoteId: string, record: { outcome: MutationOutcome; at?: string; details?: unknown }): void {
    this.assertHealthy();
    QuoteStore.prototype.recordCommitOutcome.call(this, quoteId, record);
    this.persistQuote(quoteId, "recordCommitOutcome");
  }

  override verifyCommitReceipt(
    quoteId: string,
    evidence: VerificationEvidence,
    presentedReceipt?: SubscriptionChangeReceipt,
    at?: string,
  ): SubscriptionChangeReceipt {
    this.assertHealthy();
    const current = QuoteStore.prototype.verifyCommitReceipt.call(this, quoteId, evidence, presentedReceipt, at);
    this.persistQuote(quoteId, "verifyCommitReceipt");
    return current;
  }

  override supersedeOthersFor(subscriptionId: string, keepQuoteId: string): void {
    this.assertHealthy();
    const before = new Map((QuoteStore.prototype.all.call(this) as StoredQuote[]).map((q) => [q.quote_id, q.status]));
    QuoteStore.prototype.supersedeOthersFor.call(this, subscriptionId, keepQuoteId);
    for (const q of QuoteStore.prototype.all.call(this) as StoredQuote[]) {
      if (before.get(q.quote_id) !== q.status) this.persistQuote(q.quote_id, "supersedeOthersFor");
    }
  }

  override restoreReceiptRecords(json: string): void {
    this.assertHealthy();
    QuoteStore.prototype.restoreReceiptRecords.call(this, json);
    for (const q of QuoteStore.prototype.all.call(this) as StoredQuote[]) {
      if (q.commit_receipt_recorded) this.persistQuote(q.quote_id, "restoreReceiptRecords");
    }
  }

  // -- attempt ledger -----------------------------------------------------------

  private rowToAttempt(row: Record<string, unknown>): StoredAttempt {
    return {
      attemptId: row.attempt_id as string,
      quoteId: row.quote_id as string,
      subscriptionId: row.subscription_id as string,
      provider: row.provider as string,
      site: (row.site as string | null) ?? null,
      state: row.state as AttemptState,
      idempotencyKey: row.idempotency_key as string,
      requestHash: row.request_hash as string,
      request: decodeRecordJson(row.request_json as string),
      preDispatchFingerprint: (row.pre_dispatch_fingerprint as string | null) ?? null,
      recoveryClassification: (row.recovery_classification as string | null) ?? null,
      outcome: (row.outcome as MutationOutcome | null) ?? null,
      details: row.details_json ? decodeRecordJson(row.details_json as string) : null,
      operatorReviewState: (row.operator_review_state as "NONE" | "REQUIRED" | "RESOLVED") ?? "NONE",
      version: row.version as number,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    };
  }

  getAttempt(attemptId: string): StoredAttempt | undefined {
    const row = this.db.prepare(`SELECT * FROM attempts WHERE attempt_id = ?`).get(attemptId) as Record<string, unknown> | undefined;
    return row ? this.rowToAttempt(row) : undefined;
  }

  attemptsForQuote(quoteId: string): StoredAttempt[] {
    return (this.db.prepare(`SELECT * FROM attempts WHERE quote_id = ? ORDER BY created_at, attempt_id`).all(quoteId) as Array<Record<string, unknown>>).map((r) => this.rowToAttempt(r));
  }

  allAttempts(): StoredAttempt[] {
    return (this.db.prepare(`SELECT * FROM attempts ORDER BY created_at, attempt_id`).all() as Array<Record<string, unknown>>).map((r) => this.rowToAttempt(r));
  }

  /**
   * A blocking attempt is one that forbids a new dispatch for the
   * same quote or the same subscription: a non-terminal attempt
   * (PREPARED is NOT blocking — dispatch provably never occurred;
   * DISPATCHING is), or an INDETERMINATE terminal attempt that an
   * operator has not explicitly resolved.
   */
  findBlockingAttempt(quoteId: string, subscriptionId: string): StoredAttempt | undefined {
    const rows = this.db.prepare(
      `SELECT * FROM attempts WHERE (quote_id = ? OR subscription_id = ?) AND (
         state = 'DISPATCHING' OR (state = 'INDETERMINATE' AND operator_review_state != 'RESOLVED')
       ) ORDER BY created_at LIMIT 1`,
    ).get(quoteId, subscriptionId) as Record<string, unknown> | undefined;
    return rows ? this.rowToAttempt(rows) : undefined;
  }

  /**
   * THE write-ahead gate. In ONE immediate transaction:
   *   - refuses when the idempotency key is already bound to a
   *     DIFFERENT request hash (key reuse with different parameters);
   *   - returns the existing attempt when the same key + same
   *     request is presented again (the original attempt stands);
   *   - refuses when a blocking attempt exists for this quote or
   *     subscription;
   *   - supersedes any PREPARED (never-dispatched) attempt for the
   *     quote;
   *   - inserts the intent (PREPARED) and transitions it to
   *     DISPATCHING, with both transitions in the attempt history.
   * Only after this transaction commits may the caller dispatch.
   * If it throws, zero provider mutations may occur.
   */
  beginDispatch(intent: MutationIntent): StoredAttempt {
    this.assertHealthy();
    if (this.faults?.beforePersist) {
      try { this.faults.beforePersist("beginDispatch"); } catch (e) { this.failPoison("beginDispatch", e); }
    }
    const hash = requestHashOf(intent.request);
    const attemptId = `att_${sha256(`${intent.quoteId}|${intent.idempotencyKey}`).slice(0, 24)}_${++this.attemptSeq}`;
    const now = this.nowFn().toISOString();
    try {
      let result: StoredAttempt | undefined;
      const tx = this.db.transaction(() => {
        const byKey = this.db.prepare(`SELECT * FROM attempts WHERE idempotency_key = ?`).get(intent.idempotencyKey) as Record<string, unknown> | undefined;
        if (byKey) {
          const existing = this.rowToAttempt(byKey);
          if (existing.requestHash !== hash) {
            throw new DispatchBlockedError(
              `Idempotency key ${intent.idempotencyKey} is already bound to a different request (hash ${existing.requestHash} != ${hash}); key reuse with different parameters is refused.`,
              { attemptId: existing.attemptId, existingRequestHash: existing.requestHash, requestHash: hash },
            );
          }
          if (existing.state === "DISPATCHING" || (existing.state === "INDETERMINATE" && existing.operatorReviewState !== "RESOLVED")) {
            throw new DispatchBlockedError(
              `Dispatch blocked: the attempt bound to this idempotency key (${existing.attemptId}) is ${existing.state} and unresolved — blind retry is prohibited.`,
              { attemptId: existing.attemptId, state: existing.state },
            );
          }
          if (existing.state === "CONFIRMED_NON_EXECUTION") {
            // Non-execution was DEMONSTRABLY established for the
            // prior attempt, so a fresh attempt under the same key
            // and identical request is the one re-dispatch the
            // classification permits. The row is reset in-place
            // (the key stays bound to the same request hash) with
            // the re-dispatch recorded in the history.
            this.db.prepare(`UPDATE attempts SET state='DISPATCHING', outcome=NULL, recovery_classification=NULL, version=version+1, updated_at=? WHERE attempt_id=?`).run(now, existing.attemptId);
            this.db.prepare(`INSERT INTO attempt_history (attempt_id, state, at, note) VALUES (?,?,?,?)`).run(existing.attemptId, "DISPATCHING", now, "re-dispatch authorized: prior attempt terminally CONFIRMED_NON_EXECUTION with the identical request");
            result = this.getAttempt(existing.attemptId);
            return;
          }
          // Terminal committed attempt under the same key + request:
          // the original attempt stands; the coordinator serves the
          // recorded receipt/outcome from the store.
          result = existing;
          return;
        }
        const blocking = this.findBlockingAttempt(intent.quoteId, intent.subscriptionId);
        if (blocking) {
          throw new DispatchBlockedError(
            `Dispatch blocked: attempt ${blocking.attemptId} for quote ${blocking.quoteId} / subscription ${blocking.subscriptionId} is ${blocking.state}` +
              (blocking.state === "INDETERMINATE" ? " and unresolved — blind retry is prohibited until an operator resolves it after reconciliation." : " and has no terminal record."),
            { attemptId: blocking.attemptId, state: blocking.state },
          );
        }
        this.db.prepare(
          `UPDATE attempts SET state='SUPERSEDED', updated_at=? WHERE quote_id=? AND state='PREPARED'`,
        ).run(now, intent.quoteId);
        this.db.prepare(
          `INSERT INTO attempts (attempt_id, quote_id, subscription_id, provider, site, state, idempotency_key, request_hash, request_json, pre_dispatch_fingerprint, recovery_classification, outcome, details_json, operator_review_state, version, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?, 'NONE', 1, ?, ?)`,
        ).run(
          attemptId, intent.quoteId, intent.subscriptionId, intent.provider, intent.site ?? null,
          "PREPARED", intent.idempotencyKey, hash, encodeRecordJson(intent.request),
          intent.preDispatchFingerprint ?? null, null, null, null, now, now,
        );
        this.db.prepare(`INSERT INTO attempt_history (attempt_id, state, at, note) VALUES (?,?,?,?)`).run(attemptId, "PREPARED", now, "write-ahead intent persisted");
        this.db.prepare(`UPDATE attempts SET state='DISPATCHING', updated_at=? WHERE attempt_id=?`).run(now, attemptId);
        this.db.prepare(`INSERT INTO attempt_history (attempt_id, state, at, note) VALUES (?,?,?,?)`).run(attemptId, "DISPATCHING", now, "dispatch authorized; intent and DISPATCHING transition committed atomically before any provider call");
        result = this.getAttempt(attemptId);
      });
      tx.immediate();
      return result!;
    } catch (e) {
      if (e instanceof DispatchBlockedError) throw e;
      this.failPoison("beginDispatch", e);
    }
  }

  private completeAttemptRow(attemptId: string, state: AttemptState, outcome: MutationOutcome | null, note: string, expectedVersion?: number): void {
    const now = this.nowFn().toISOString();
    const res = this.db.prepare(
      `UPDATE attempts SET state=?, outcome=?, operator_review_state = CASE WHEN ? = 'INDETERMINATE' THEN 'REQUIRED' ELSE operator_review_state END, version = version + 1, updated_at=? WHERE attempt_id=?${expectedVersion !== undefined ? " AND version=?" : ""}`,
    ).run(...(expectedVersion !== undefined
      ? [state, outcome, state, now, attemptId, expectedVersion]
      : [state, outcome, state, now, attemptId]));
    if (res.changes !== 1) throw new DurableStoreError(`Attempt ${attemptId} completion refused: the attempt row was concurrently modified or is missing.`);
    this.db.prepare(`INSERT INTO attempt_history (attempt_id, state, at, note) VALUES (?,?,?,?)`).run(attemptId, state, now, note);
  }

  /**
   * Atomically records a commit receipt AND completes the attempt:
   * the parent's recordCommitReceipt validation runs first; the
   * quote row, receipt record, and attempt terminal state then
   * commit in ONE SQLite transaction — a crash recovers either the
   * complete receipt + terminal attempt or neither.
   */
  recordAttemptReceipt(attemptId: string, receipt: SubscriptionChangeReceipt): SubscriptionChangeReceipt {
    this.assertHealthy();
    const attempt = this.getAttempt(attemptId);
    if (!attempt) throw new DurableStoreError(`Cannot record a receipt for unknown attempt ${attemptId}.`);
    const recorded = QuoteStore.prototype.recordCommitReceipt.call(this, attempt.quoteId, receipt);
    const outcome: MutationOutcome = receipt.outcome === "COMMITTED_UNVERIFIED" ? "COMMITTED_UNVERIFIED" : "COMMITTED_AND_VERIFIED";
    try {
      const tx = this.db.transaction(() => {
        this.persistQuoteInTx(attempt.quoteId, "recordAttemptReceipt");
        this.completeAttemptRow(attemptId, outcome, outcome, "receipt recorded atomically with attempt completion", attempt.version);
      });
      tx.immediate();
    } catch (e) {
      this.failPoison("recordAttemptReceipt", e);
    }
    return recorded!;
  }

  /** Atomically records a no-receipt terminal outcome (INDETERMINATE / CONFIRMED_NON_EXECUTION) and completes the attempt. */
  recordAttemptOutcome(attemptId: string, outcome: MutationOutcome, details?: unknown): void {
    this.assertHealthy();
    const attempt = this.getAttempt(attemptId);
    if (!attempt) throw new DurableStoreError(`Cannot record an outcome for unknown attempt ${attemptId}.`);
    QuoteStore.prototype.recordCommitOutcome.call(this, attempt.quoteId, {
      outcome,
      at: this.nowFn().toISOString(),
      ...(details !== undefined ? { details } : {}),
    });
    try {
      const tx = this.db.transaction(() => {
        this.persistQuoteInTx(attempt.quoteId, "recordAttemptOutcome");
        this.completeAttemptRow(attemptId, outcome, outcome, "terminal outcome recorded atomically with attempt completion", attempt.version);
      });
      tx.immediate();
    } catch (e) {
      this.failPoison("recordAttemptOutcome", e);
    }
  }

  /**
   * Completes an attempt from whatever terminal record the quote
   * durably carries (used by adapter wiring, where establishment
   * records through the store's own methods): recorded receipt →
   * its outcome; recorded outcome → that outcome; neither →
   * INDETERMINATE (the conservative recovery classification).
   */
  settleAttemptFromStore(attemptId: string): StoredAttempt {
    this.assertHealthy();
    const attempt = this.getAttempt(attemptId);
    if (!attempt) throw new DurableStoreError(`Cannot settle unknown attempt ${attemptId}.`);
    if (attempt.state !== "DISPATCHING" && attempt.state !== "PREPARED") return attempt;
    const quote = QuoteStore.prototype.get.call(this, attempt.quoteId) as StoredQuote | undefined;
    let state: AttemptState = "INDETERMINATE";
    let outcome: MutationOutcome = "INDETERMINATE";
    if (quote?.commit_receipt_recorded) {
      outcome = quote.commit_receipt_recorded.outcome === "COMMITTED_UNVERIFIED" ? "COMMITTED_UNVERIFIED" : "COMMITTED_AND_VERIFIED";
      state = outcome;
    } else if (quote?.commit_outcome) {
      outcome = quote.commit_outcome.outcome;
      state = outcome === "INDETERMINATE" ? "INDETERMINATE" : outcome === "CONFIRMED_NON_EXECUTION" ? "CONFIRMED_NON_EXECUTION" : "INDETERMINATE";
    }
    try {
      const tx = this.db.transaction(() => {
        this.completeAttemptRow(attemptId, state, outcome, "settled from the quote's durable terminal record", attempt.version);
      });
      tx.immediate();
    } catch (e) {
      this.failPoison("settleAttemptFromStore", e);
    }
    return this.getAttempt(attemptId)!;
  }

  /** Explicit operator action: mark an INDETERMINATE attempt resolved after manual reconciliation. Never called by any recovery or reconciliation-report path. */
  resolveAttempt(attemptId: string, note: string): StoredAttempt {
    this.assertHealthy();
    const attempt = this.getAttempt(attemptId);
    if (!attempt) throw new DurableStoreError(`Cannot resolve unknown attempt ${attemptId}.`);
    const tx = this.db.transaction(() => {
      this.db.prepare(`UPDATE attempts SET operator_review_state='RESOLVED', version=version+1, updated_at=? WHERE attempt_id=?`).run(this.nowFn().toISOString(), attemptId);
      this.db.prepare(`INSERT INTO attempt_history (attempt_id, state, at, note) VALUES (?,?,?,?)`).run(attemptId, attempt.state, this.nowFn().toISOString(), `operator resolved: ${note}`);
    });
    tx.immediate();
    return this.getAttempt(attemptId)!;
  }

  /** persistQuote variant for use inside a caller-managed transaction (no nested transaction, no version double-count). */
  private persistQuoteInTx(quoteId: string, op: string): void {
    this.faults?.beforePersist?.(op);
    const quote = QuoteStore.prototype.get.call(this, quoteId) as StoredQuote | undefined;
    if (!quote) return;
    const expected = this.versions.get(quoteId) ?? 0;
    const next = expected + 1;
    const recordJson = encodeRecordJson(quote);
    const recordSha = sha256(recordJson);
    if (expected === 0) {
      this.db.prepare(
        `INSERT INTO quotes (quote_id, subscription_id, provider, status, version, record_json, record_sha, updated_at) VALUES (?,?,?,?,?,?,?,?)`,
      ).run(quoteId, quote.subscription_id, quote.provider, quote.status, next, recordJson, recordSha, this.nowFn().toISOString());
    } else {
      const res = this.db.prepare(
        `UPDATE quotes SET subscription_id=?, provider=?, status=?, version=?, record_json=?, record_sha=?, updated_at=? WHERE quote_id=? AND version=?`,
      ).run(quote.subscription_id, quote.provider, quote.status, next, recordJson, recordSha, this.nowFn().toISOString(), quoteId, expected);
      if (res.changes !== 1) throw new DurableStoreError(`Stale writer refused for quote ${quoteId} (expected version ${expected}).`);
    }
    this.faults?.insidePersistTx?.(op);
    if (quote.commit_receipt_recorded) {
      this.db.prepare(
        `INSERT INTO receipt_records (quote_id, recorded_json, current_json, identity_digest, verifications_json) VALUES (?,?,?,?,?)
         ON CONFLICT(quote_id) DO UPDATE SET recorded_json=excluded.recorded_json, current_json=excluded.current_json, identity_digest=excluded.identity_digest, verifications_json=excluded.verifications_json`,
      ).run(quoteId, encodeRecordJson(quote.commit_receipt_recorded), encodeRecordJson(quote.commit_receipt), quote.commit_receipt_identity_digest, encodeRecordJson(quote.commit_receipt_verifications ?? []));
    } else {
      this.db.prepare(`DELETE FROM receipt_records WHERE quote_id = ?`).run(quoteId);
    }
    this.versions.set(quoteId, next);
  }

  // -- operator / reconciliation surface (READ-ONLY) ----------------------------

  /**
   * Read-only recovery enumeration. It performs no action: it does
   * not dispatch, overwrite, resolve, or convert observed state
   * into execution proof. For every item it separates what was
   * OBSERVED from what is ESTABLISHED and names the next PERMITTED
   * action for an operator to take outside this report.
   */
  recoveryReport(): {
    unresolvedAttempts: Array<Record<string, unknown>>;
    indeterminateOutcomes: Array<Record<string, unknown>>;
    unverifiedReceipts: Array<Record<string, unknown>>;
    receiptsRequiringVerification: Array<Record<string, unknown>>;
    identityConflicts: Array<Record<string, unknown>>;
    corruptRecords: Array<Record<string, unknown>>;
  } {
    const item = (a: StoredAttempt): Record<string, unknown> => {
      const quote = QuoteStore.prototype.get.call(this, a.quoteId) as StoredQuote | undefined;
      return {
        attemptId: a.attemptId,
        quoteId: a.quoteId,
        subscriptionId: a.subscriptionId,
        state: a.state,
        recoveryClassification: a.recoveryClassification,
        observed: {
          providerStateObserved: quote?.commit_outcome?.details ?? null,
        },
        established: {
          mutationExecutionEstablished: a.state === "COMMITTED_AND_VERIFIED" || a.state === "COMMITTED_UNVERIFIED",
          financialResultEstablished: a.state === "COMMITTED_AND_VERIFIED",
          stateAttributableToThisMutation: a.state === "COMMITTED_AND_VERIFIED" || a.state === "COMMITTED_UNVERIFIED",
        },
        operatorInterventionRequired: a.state === "INDETERMINATE" || a.state === "DISPATCHING",
        nextPermittedAction:
          a.state === "INDETERMINATE"
            ? "Reconcile manually from provider records; only after reconciliation may an operator explicitly resolve this attempt (resolveAttempt). No automatic re-dispatch is permitted."
            : a.state === "DISPATCHING"
              ? "Treat as potentially dispatched: reconcile from provider records before any further action. No re-dispatch."
              : "None.",
      };
    };
    const attempts = this.allAttempts();
    const unverified = this.receiptsWithReconciliation("UNVERIFIED").map((r) => ({
      quoteId: r.quoteId,
      receiptId: r.receiptId ?? null,
      outcome: r.outcome ?? "COMMITTED_UNVERIFIED",
      established: { mutationExecutionEstablished: true, financialResultEstablished: false, stateAttributableToThisMutation: true },
      operatorInterventionRequired: true,
      nextPermittedAction: "Establish verification from an independent provider observation (establishVerification + verifyCommitReceipt), or leave unverified. Never re-dispatch.",
    }));
    return {
      unresolvedAttempts: attempts.filter((a) => a.state === "DISPATCHING" || a.state === "PREPARED").map(item),
      indeterminateOutcomes: attempts.filter((a) => a.state === "INDETERMINATE").map(item),
      unverifiedReceipts: unverified,
      receiptsRequiringVerification: unverified,
      identityConflicts: [],
      corruptRecords: [],
    };
  }

  /**
   * Static, non-adopting inspection of a database file: reports
   * corrupt/incoherent records WITHOUT opening the store (used when
   * the store itself refuses to open). Read-only connection.
   */
  static inspect(dbPath: string): { schemaVersion: number | null; corruptRecords: Array<Record<string, unknown>>; identityConflicts: Array<Record<string, unknown>> } {
    const Sqlite = loadSqlite();
    const db = new Sqlite(dbPath, { readonly: true, timeout: 2000 });
    try {
      const meta = db.prepare(`SELECT value FROM meta WHERE key='schema_version'`).get() as { value: string } | undefined;
      const corrupt: Array<Record<string, unknown>> = [];
      const conflicts: Array<Record<string, unknown>> = [];
      for (const row of db.prepare(`SELECT quote_id, record_json, record_sha FROM quotes`).all() as Array<Record<string, unknown>>) {
        if (sha256(row.record_json as string) !== row.record_sha) corrupt.push({ kind: "quote", quoteId: row.quote_id, problem: "integrity checksum mismatch" });
      }
      for (const row of db.prepare(`SELECT quote_id, recorded_json, identity_digest FROM receipt_records`).all() as Array<Record<string, unknown>>) {
        try {
          const recorded = decodeRecordJson<SubscriptionChangeReceipt>(row.recorded_json as string);
          if (receiptIdentityDigest(recorded) !== row.identity_digest) {
            conflicts.push({ kind: "receipt", quoteId: row.quote_id, problem: "recorded receipt does not match its identity digest" });
          }
        } catch (e) {
          corrupt.push({ kind: "receipt", quoteId: row.quote_id, problem: `undecodable (${(e as Error).message})` });
        }
      }
      return { schemaVersion: meta ? Number(meta.value) : null, corruptRecords: corrupt, identityConflicts: conflicts };
    } finally {
      db.close();
    }
  }
}

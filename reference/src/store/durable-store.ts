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
import { SCQError, type MutationOutcome, type ReconciliationResult, type SubscriptionChangeReceipt, type VerificationEvidence } from "../core/types.js";
import {
  QuoteStore,
  receiptIdentityDigest,
  type QuoteStatus,
  type StoredQuote,
} from "./quote-store.js";

export const DURABLE_SCHEMA_VERSION = 4;

/**
 * Maximum age, at resolution time, of the provider observation a
 * terminal (block-lifting) resolution may rest on (P0, issue #43).
 * Older observations are stale: they cannot establish what the
 * provider holds for THIS attempt now.
 */
export const RESOLUTION_EVIDENCE_MAX_AGE_MS = 24 * 3600 * 1000;

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

/**
 * A resolution of an INDETERMINATE attempt was refused because the
 * structured recovery evidence was missing, insufficient, stale,
 * replayed, or not bound to the attempt (P0, issue #43). A refusal
 * persists NOTHING: no resolution row, no flag change — the attempt
 * remains blocked exactly as it was.
 */
export class ResolutionEvidenceError extends DurableStoreError {
  override readonly code = "RESOLUTION_EVIDENCE_REFUSED";
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, details);
    this.name = "ResolutionEvidenceError";
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

/**
 * How an INDETERMINATE attempt's recovery is classified (P0, issue
 * #43; PR #50 correction round, findings R1–R4):
 *  - CONFIRMED_NON_EXECUTION: an established provider record (below)
 *    establishes the attempted operation did NOT execute. Lifting
 *    effect: the subscription unblocks for OTHER quotes; the
 *    attempt's OWN quote remains blocked for any key — frozen §6.15
 *    requires re-authorization after INDETERMINATE to proceed as a
 *    NEW quote, never as a re-issue of the indeterminate attempt
 *    (R1). (The same-quote/same-key re-arm exception in
 *    beginDispatch applies only to attempts that were ORIGINALLY
 *    terminal CONFIRMED_NON_EXECUTION, never to a retroactively
 *    resolved INDETERMINATE attempt.)
 *  - CONFIRMED_LANDING: an established provider record establishes
 *    the operation DID land (with its provider operation id). The
 *    attempt's own quote remains blocked for any key, and the
 *    subscription stays blocked until a separate landing
 *    reconciliation is recorded (R4, `reconcileLandedAttempt`);
 *    after that, only fresh quotes validated against the landed
 *    state may dispatch (stale pre-landing quotes refuse).
 *  - UNRESOLVED: evidence is absent, ambiguous, stale, premature, or
 *    insufficiently bound to the attempted operation. Recorded for
 *    audit only (`recordUnresolvedResolution`); lifts nothing.
 * A provider-state snapshot that merely MATCHES the intended state
 * is none of these: matching state is not operation attribution.
 */
export type ResolutionClassification = "CONFIRMED_NON_EXECUTION" | "CONFIRMED_LANDING" | "UNRESOLVED";

/** Evidence sources that are operation-bound provider records. Operator assertions, free text, and state snapshots are NOT evidence sources. */
export type ResolutionEvidenceSource = "PROVIDER_OPERATION_LOG" | "PROVIDER_IDEMPOTENCY_REGISTRY" | "PROVIDER_AUDIT_EXPORT";

/**
 * An actual provider-record object, as returned by a
 * `ProviderRecordSource` that read the provider's operation log /
 * idempotency registry / audit export for THIS attempt. It is
 * validated field by field against the attempt and, for absence
 * claims, against provider finality (R3) by the verifier's private
 * establishment core. It is never itself accepted by
 * `resolveAttempt`, and — since PR #50 correction round 3 (R2') —
 * it is never SUPPLIED by the caller in the lifting path either:
 * the verifier fetches it from its configured source. A record a
 * caller constructs by hand has no path to a token.
 */
export type ResolutionProviderRecord = {
  source: ResolutionEvidenceSource;
  /** Operation-bound kind, per classification (see the allowlists beside the establishment core). */
  kind: string;
  /** The provider record's own reference (log entry / lookup id). One reference establishes one attempt. */
  reference: string;
  provider: string;
  site?: string;
  subscriptionId: string;
  quoteId: string;
  idempotencyKey: string;
  requestHash: string;
  /** Whether the provider record shows the attempted operation. */
  operationFound: boolean;
  /** The provider's operation id — required when operationFound, forbidden when not. */
  providerOperationId?: string;
  /**
   * The provider state/record payload the observed-state digest is
   * computed FROM (by the establishment procedure — callers never
   * supply a digest). For a landing this is the landed subscription
   * state object and must carry its `version`; for non-execution it
   * is the lookup-result payload attesting the absence.
   */
  observedState: unknown;
  /** When the provider record was observed. Must be strictly after the attempt settled INDETERMINATE (R3). */
  observedAt: string;
  /** Provider finality: the log/registry is declared final (not eventually-consistent-in-flight) at observation. */
  logFinal: boolean;
  /** Completeness watermark: the log/registry is complete through this instant; must cover the settlement. */
  completeThrough: string;
  /** Required for PROVIDER_IDEMPOTENCY_REGISTRY records: only "FULL" coverage can establish an absence. */
  registryCoverage?: "FULL" | "PARTIAL" | "UNKNOWN";
};

/**
 * A resolution-evidence token minted ONLY by a provider-evidence
 * verifier (`createProviderEvidenceVerifier`) from a record the
 * verifier FETCHED from its configured `ProviderRecordSource` —
 * the durable-store analogue of quote-store's
 * `establishVerification` brand (PR #50 review R2), hardened in
 * correction round 3 (R2'). The object carries the validated
 * fields; its authority is the module-private brand + binding
 * registered at minting, not its shape: a caller-constructed object
 * with identical fields is self-asserted and refused by
 * `resolveAttempt`, a token whose contents were altered after
 * minting is detected against the minting-time content digest and
 * refused, and a token minted by any verifier OTHER than the
 * store's own configured verifier instance is refused (the binding
 * records the minting verifier's identity).
 *
 * TRUST MODEL (round 3): the brand no longer stands alone. In
 * round 2 the establishment procedure was a public export and
 * branded caller-supplied objects — the brand proved processing,
 * not provider origin, and a fabricated record could lift a block.
 * That path is removed: there is no public function that mints a
 * token from a caller-supplied record. The remaining trust
 * decision is explicit and deployment-side: WHOEVER CONFIGURES the
 * record source behind a store's verifier decides what counts as a
 * provider read. The library ships NO `ProviderRecordSource`
 * implementation, and a store configured with no verifier accepts
 * no terminal evidence at all — out of the box, nothing lifts.
 */
export type EstablishedResolutionEvidence = {
  attemptId: string;
  quoteId: string;
  subscriptionId: string;
  provider: string;
  site: string | null;
  requestHash: string;
  idempotencyKey: string;
  classification: "CONFIRMED_NON_EXECUTION" | "CONFIRMED_LANDING";
  source: ResolutionEvidenceSource;
  kind: string;
  reference: string;
  operationFound: boolean;
  providerOperationId: string | null;
  observedAt: string;
  /** sha256 over the canonical form of the record's observedState — computed at establishment, never caller-supplied. */
  observedProviderStateDigest: string;
  logFinal: true;
  completeThrough: string;
  registryCoverage: "FULL" | null;
  /** CONFIRMED_LANDING only: the landed state's `version`, extracted from the established observed state. */
  landedStateVersion: string | null;
};

/** What `resolveAttempt` accepts: a branded established token plus the operator's recorded decision. Raw evidence objects are refused. */
export type ResolveAttemptInput = {
  evidence: EstablishedResolutionEvidence;
  operatorId: string;
  reconciliationDecision: string;
  justification: string;
};

/** A persisted, append-only resolution record, bound to its attempt row in every identity field. */
export type StoredResolution = {
  resolutionId: string;
  attemptId: string;
  quoteId: string;
  subscriptionId: string;
  provider: string;
  site: string | null;
  requestHash: string;
  idempotencyKey: string;
  classification: ResolutionClassification;
  operatorId: string;
  resolvedAt: string;
  evidenceSource: string;
  evidenceKind: string;
  evidenceReference: string;
  observedAt: string;
  observedProviderStateDigest: string;
  providerOperationId: string | null;
  reconciliationDecision: string;
  justification: string;
  evidenceHash: string;
  /** Provider finality attested at establishment (v3). FALSE for v2-era records, which are therefore non-lifting. */
  logFinal: boolean;
  /** Completeness watermark attested at establishment ("" when none — e.g. UNRESOLVED audit records and v2-era rows). */
  completeThrough: string;
  registryCoverage: string | null;
  landedStateVersion: string | null;
  /** The path that minted the evidence ("createProviderEvidenceVerifier" for v4 VERIFIED records); "" for UNRESOLVED and asserted records and pre-v4 rows. */
  establishmentProcedure: string;
  /**
   * Trust tier (schema v4, PR #50 correction round 3): "VERIFIED"
   * for records established through a store-configured
   * provider-evidence verifier — the only tier that can lift a
   * dispatch block; "ASSERTED" for operator claims recorded without
   * verified evidence (`recordAssertedResolution`, UNRESOLVED audit
   * records) and for EVERY pre-v4 row, which migration backfills to
   * ASSERTED because pre-v4 evidence was minted through the removed
   * public establishment function or caller digests.
   */
  trustTier: ResolutionTrustTier;
};

/** The trust tier of a persisted evidence record (schema v4). Only VERIFIED records can lift a dispatch block. */
export type ResolutionTrustTier = "VERIFIED" | "ASSERTED";

/**
 * A persisted landing reconciliation (R4, hardened in correction
 * round 3 — R4'): the separate, recorded barrier between a
 * CONFIRMED_LANDING resolution and any subscription-wide unblock.
 * Since round 3 the barrier can only be recorded from a financial
 * reconciliation record FETCHED through the store's configured
 * verifier: `landedStateDigest` and `financialOutcomeDigest` are
 * computed by the verifier from that record (the landed-state
 * digest must equal the resolution's established observed-state
 * digest — the barrier is bound to the SAME landed state), and
 * `evidenceReference` names the fetched reconciliation record.
 * No caller-supplied digest or record input exists in the path.
 * Pre-v4 rows carry trustTier "ASSERTED" and a null
 * evidenceReference (migration backfill) and never satisfy the
 * barrier.
 */
export type StoredLandingReconciliation = {
  reconciliationId: string;
  attemptId: string;
  quoteId: string;
  subscriptionId: string;
  landedStateVersion: string;
  landedStateDigest: string;
  financialOutcomeDigest: string;
  operatorId: string;
  reconciledAt: string;
  justification: string;
  recordHash: string;
  /** Trust tier (schema v4): only "VERIFIED" rows satisfy the barrier; pre-v4 rows are backfilled "ASSERTED". */
  trustTier: ResolutionTrustTier;
  /** The fetched financial reconciliation record's own reference; null for pre-v4 rows. */
  evidenceReference: string | null;
};

const RESOLUTION_EVIDENCE_SOURCES = new Set<string>([
  "PROVIDER_OPERATION_LOG",
  "PROVIDER_IDEMPOTENCY_REGISTRY",
  "PROVIDER_AUDIT_EXPORT",
]);
const NON_EXECUTION_EVIDENCE_KINDS = new Set([
  "OPERATION_LOG_NO_RECORD_FOR_KEY",
  "IDEMPOTENCY_REGISTRY_NO_RECORD_FOR_KEY",
]);
const LANDING_EVIDENCE_KINDS = new Set([
  "OPERATION_LOG_RECORD_FOR_KEY",
  "PROVIDER_OPERATION_RECEIPT_FOR_KEY",
]);

/**
 * The establishment brands (PR #50 review R2; verifier binding
 * added in correction round 3, R2'), exactly the quote-store
 * pattern for receipt evidence (PR #8 R3 / PR-17): module-private
 * WeakSets brand every token a provider-evidence verifier mints,
 * and WeakMaps beside them stamp the token's attempt binding, a
 * digest of its contents as minted, and THE IDENTITY OF THE
 * MINTING VERIFIER INSTANCE. None of it is forgeable or
 * serializable: a caller-constructed object is unbranded however
 * faithful its fields, a token minted for one attempt cannot
 * resolve another, a token altered after minting no longer matches
 * its stamped content digest, and a token minted by a verifier the
 * store does not hold is not the store's capability.
 */
const establishedResolutionTokens = new WeakSet<object>();
const establishedResolutionBindings = new WeakMap<object, { attemptId: string; verifier: object; contentDigest: string }>();
const establishedReconciliationTokens = new WeakSet<object>();
const establishedReconciliationBindings = new WeakMap<object, { attemptId: string; verifier: object; contentDigest: string }>();

/**
 * The PRIVATE establishment core (PR #50 review R2/R3; made
 * private in correction round 3, R2') — the validation half of the
 * verifier, and the only code that mints an
 * `EstablishedResolutionEvidence` token. It is NOT exported: in
 * round 2 this computation was the public `establishResolutionEvidence`
 * and branded caller-supplied records, which is exactly the defect
 * R2' names. It now runs only inside a verifier, over a record the
 * verifier FETCHED from its configured source, and stamps the
 * minting verifier's identity into the token binding. It VALIDATES:
 *
 *  - binding: every identity field of the record (provider, site,
 *    subscription, quote, idempotency key, request hash) equals the
 *    attempt's — a record about a different operation establishes
 *    nothing about this one;
 *  - source/kind: the source is an operation-bound provider record
 *    source and the kind is the classification's operation-bound
 *    kind; a state snapshot is refused — matching state is not
 *    operation attribution;
 *  - outcome coherence: non-execution requires
 *    `operationFound === false` and NO provider operation id;
 *    landing requires `operationFound === true` and the operation
 *    id, and its observed state must carry the landed state
 *    `version` (the stale-quote rule keys on it);
 *  - digest: computed HERE, from the record's observedState —
 *    callers never supply one;
 *  - finality (R3): an absence is premature until the provider
 *    record is final past the settlement — the observation must be
 *    STRICTLY AFTER the attempt settled INDETERMINATE
 *    (`attempt.updatedAt`), the log must be declared final, its
 *    completeness watermark must cover the settlement, and an
 *    idempotency-registry record must declare FULL coverage
 *    (PARTIAL/UNKNOWN refuse — if finality is unavailable, the
 *    attempt stays UNRESOLVED);
 *  - the observation is not future-dated against `now`.
 */
function establishResolutionEvidenceCore(
  attempt: StoredAttempt,
  record: ResolutionProviderRecord,
  classification: "CONFIRMED_NON_EXECUTION" | "CONFIRMED_LANDING",
  now: Date,
  verifier: object,
): EstablishedResolutionEvidence {
  const refuse = (problem: string): never => {
    throw new ResolutionEvidenceError(
      `Establishment refused for attempt ${attempt?.attemptId ?? "(unknown)"}: ${problem}`,
      { attemptId: attempt?.attemptId },
    );
  };
  if (!attempt || typeof attempt !== "object") refuse("an attempt record is required");
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    refuse("a provider record object is required — an operator assertion or a free-text note is not a provider record");
  }
  if (attempt.state !== "INDETERMINATE") {
    refuse(`the attempt is ${attempt.state}; resolution evidence can only be established for an INDETERMINATE attempt`);
  }
  if (classification !== "CONFIRMED_NON_EXECUTION" && classification !== "CONFIRMED_LANDING") {
    refuse(`classification ${String(classification)} cannot be established — UNRESOLVED outcomes are recorded via recordUnresolvedResolution, not established`);
  }
  // Binding: the record must be ABOUT this attempt, in every field.
  if (record.provider !== attempt.provider) refuse(`the record's provider (${String(record.provider)}) does not match the attempt's provider (${attempt.provider})`);
  if ((record.site ?? null) !== attempt.site) refuse(`the record's site (${String(record.site ?? null)}) does not match the attempt's site (${String(attempt.site)})`);
  if (record.subscriptionId !== attempt.subscriptionId) refuse(`the record's subscriptionId (${String(record.subscriptionId)}) does not match the attempt's (${attempt.subscriptionId})`);
  if (record.quoteId !== attempt.quoteId) refuse(`the record's quoteId (${String(record.quoteId)}) does not match the attempt's (${attempt.quoteId})`);
  if (record.idempotencyKey !== attempt.idempotencyKey) refuse(`the record's idempotencyKey does not match the attempt's — the record must be keyed to THIS operation`);
  if (record.requestHash !== attempt.requestHash) refuse(`the record's requestHash does not match the attempt's — the record must be bound to the exact attempted request`);
  // Source / kind pairing.
  if (!RESOLUTION_EVIDENCE_SOURCES.has(record.source)) {
    refuse(
      record.source === ("PROVIDER_STATE_SNAPSHOT" as string)
        ? "a provider-state snapshot is not operation-bound evidence: a state that merely matches the intended outcome does not establish whether THIS operation executed"
        : `source ${JSON.stringify(record.source ?? null)} is not an operation-bound provider evidence source (one of ${[...RESOLUTION_EVIDENCE_SOURCES].join(", ")})`,
    );
  }
  const kinds = classification === "CONFIRMED_NON_EXECUTION" ? NON_EXECUTION_EVIDENCE_KINDS : LANDING_EVIDENCE_KINDS;
  if (!kinds.has(record.kind)) {
    refuse(`kind ${JSON.stringify(record.kind ?? null)} does not establish ${classification} (one of ${[...kinds].join(", ")}) — the record must be operation-bound, keyed to this attempt's operation`);
  }
  const reference = typeof record.reference === "string" ? record.reference.trim() : "";
  if (!reference) refuse("a non-empty reference identifying the provider record is required");
  // Outcome coherence.
  let providerOperationId: string | null = null;
  if (classification === "CONFIRMED_NON_EXECUTION") {
    if (record.operationFound !== false) refuse("CONFIRMED_NON_EXECUTION requires the provider record to show the operation NOT found (operationFound === false)");
    if (record.providerOperationId !== undefined && record.providerOperationId !== null && record.providerOperationId !== "") {
      refuse("CONFIRMED_NON_EXECUTION must not carry a providerOperationId — an operation id would be evidence the operation exists");
    }
  } else {
    if (record.operationFound !== true) refuse("CONFIRMED_LANDING requires the provider record to show the operation found (operationFound === true)");
    providerOperationId = typeof record.providerOperationId === "string" ? record.providerOperationId.trim() : "";
    if (!providerOperationId) refuse("CONFIRMED_LANDING requires the non-empty providerOperationId of the landed operation");
  }
  // Observed state: present, digested here, and (for landing) the
  // bearer of the landed state version.
  if (record.observedState === undefined || record.observedState === null) {
    refuse("the record must carry the observed provider state/record payload the digest is computed from — a bare digest assertion establishes nothing");
  }
  const observedProviderStateDigest = sha256(canonicalStringify(record.observedState));
  let landedStateVersion: string | null = null;
  if (classification === "CONFIRMED_LANDING") {
    const state = record.observedState as Record<string, unknown>;
    const version = typeof state === "object" && !Array.isArray(state) ? state.version : undefined;
    if (typeof version !== "string" || version.trim().length === 0) {
      refuse("CONFIRMED_LANDING requires the observed state to be the landed subscription state carrying a non-empty string `version` — without it, no later quote can be validated against the landed state");
    }
    landedStateVersion = typeof version === "string" ? version : null;
  }
  // Finality (R3): absence becomes non-execution only once the
  // provider record is final and complete past the settlement.
  const settledMs = Date.parse(attempt.updatedAt);
  const observedMs = Date.parse(record.observedAt ?? "");
  if (Number.isNaN(observedMs)) refuse("the record's observedAt must be a parseable ISO timestamp");
  if (observedMs <= settledMs) {
    refuse("the observation is not after the attempt settled INDETERMINATE — an absence observed before (or at) settlement may be premature: the dispatch may not yet be reflected in the provider's records");
  }
  if (observedMs > now.getTime()) refuse("the record's observedAt is after the establishment time; a future observation cannot be established from");
  if (record.logFinal !== true) {
    refuse("the provider log/registry is not declared final — an absence in a not-yet-final log may be premature and cannot establish non-execution");
  }
  const completeThroughMs = Date.parse(record.completeThrough ?? "");
  if (Number.isNaN(completeThroughMs)) refuse("the record's completeThrough watermark must be a parseable ISO timestamp");
  if (completeThroughMs < settledMs) {
    refuse("the provider record's completeness watermark does not cover the attempt's settlement — the log/registry may not yet contain the dispatched operation's record");
  }
  let registryCoverage: "FULL" | null = null;
  if (record.source === "PROVIDER_IDEMPOTENCY_REGISTRY") {
    if (record.registryCoverage !== "FULL") {
      refuse(`idempotency-registry coverage ${JSON.stringify(record.registryCoverage ?? null)} cannot establish an absence — only FULL coverage can (PARTIAL/UNKNOWN leave the attempt UNRESOLVED)`);
    }
    registryCoverage = "FULL";
  } else if (record.registryCoverage !== undefined) {
    registryCoverage = record.registryCoverage === "FULL" ? "FULL" : null;
  }

  const token: EstablishedResolutionEvidence = {
    attemptId: attempt.attemptId,
    quoteId: attempt.quoteId,
    subscriptionId: attempt.subscriptionId,
    provider: attempt.provider,
    site: attempt.site,
    requestHash: attempt.requestHash,
    idempotencyKey: attempt.idempotencyKey,
    classification,
    source: record.source,
    kind: record.kind,
    reference,
    operationFound: record.operationFound,
    providerOperationId,
    observedAt: record.observedAt,
    observedProviderStateDigest,
    logFinal: true,
    completeThrough: record.completeThrough,
    registryCoverage,
    landedStateVersion,
  };
  establishedResolutionTokens.add(token);
  establishedResolutionBindings.set(token, {
    attemptId: attempt.attemptId,
    verifier,
    contentDigest: sha256(canonicalStringify(token)),
  });
  return token;
}

/** The lookup a verifier issues for an attempt's operation record — built from the attempt binding, never from caller fields. */
export type ProviderOperationRecordQuery = {
  provider: string;
  site: string | null;
  subscriptionId: string;
  quoteId: string;
  idempotencyKey: string;
  requestHash: string;
};

/** The lookup a verifier issues for a landed attempt's financial reconciliation — the operation query plus the resolution's evidence reference. */
export type ProviderReconciliationQuery = ProviderOperationRecordQuery & {
  /** The CONFIRMED_LANDING resolution's evidence reference: the reconciliation must be OF that established landing. */
  resolutionReference: string;
  providerOperationId: string | null;
};

/**
 * A financial reconciliation record, as returned by a
 * `ProviderRecordSource`'s reconciliation lookup (round 3, R4').
 * The verifier validates it against the attempt and the landing
 * resolution and computes BOTH digests from it — the caller of the
 * barrier never sees a digest input. `landedState` must be the
 * landed subscription state the resolution established (its
 * computed digest must equal the resolution's
 * observedProviderStateDigest); `financialOutcome` is the
 * reconciliation service's own outcome record for the landed
 * operation's financial consequences.
 */
export type FinancialReconciliationRecord = {
  /** The reconciliation source's name (non-empty; recorded on the barrier row). */
  source: string;
  /** The reconciliation record's own reference (non-empty; persisted as the barrier's evidenceReference). */
  reference: string;
  provider: string;
  site?: string;
  subscriptionId: string;
  quoteId: string;
  idempotencyKey: string;
  requestHash: string;
  /** Must equal the landing resolution's evidenceReference — the reconciliation is bound to THAT resolution. */
  resolutionReference: string;
  /** The landed subscription state object; its computed digest must equal the resolution's observed-state digest. */
  landedState: unknown;
  /** The financial outcome object for the landed operation; its digest is computed by the verifier, never supplied. */
  financialOutcome: unknown;
  /** When the reconciliation was performed (parseable ISO timestamp). */
  reconciledAt: string;
};

/**
 * The deployment-side capability that RETRIEVES provider records
 * (round 3, R2'/R4'). A verifier holds one and fetches through it;
 * the caller in the lifting path never supplies a record.
 *
 * THE LIBRARY SHIPS NO IMPLEMENTATION of this interface. Whoever
 * provides one — an adapter that reads an authenticated provider
 * operation log, an internal reconciliation service client — makes
 * the deployment's trust decision about what counts as provider
 * evidence. Until a deployment configures one, no evidence can be
 * established and every INDETERMINATE attempt stays blocked (the
 * fail-closed production default).
 */
export type ProviderRecordSource = {
  /** Fetch the operation record for the queried attempt binding, or undefined when the source holds none. */
  fetchOperationRecord(query: ProviderOperationRecordQuery): ResolutionProviderRecord | undefined;
  /**
   * Fetch the financial reconciliation record for a landed attempt,
   * or undefined. OPTIONAL capability: a source without it can
   * establish resolutions but can never satisfy the landing
   * reconciliation barrier.
   */
  fetchFinancialReconciliation?(query: ProviderReconciliationQuery): FinancialReconciliationRecord | undefined;
};

/**
 * A branded landing-reconciliation token minted ONLY by a
 * verifier's `establishReconciliation` from a FETCHED
 * `FinancialReconciliationRecord`. Both digests were computed by
 * the verifier from the record; the token is bound to the attempt,
 * the resolution it reconciles, and the minting verifier instance.
 */
export type EstablishedLandingReconciliation = {
  attemptId: string;
  quoteId: string;
  subscriptionId: string;
  provider: string;
  site: string | null;
  requestHash: string;
  idempotencyKey: string;
  /** The landing resolution's evidence reference this reconciliation is bound to. */
  resolutionReference: string;
  evidenceSource: string;
  evidenceReference: string;
  landedStateVersion: string | null;
  /** sha256 of the fetched record's landedState — computed at minting, equal to the resolution's observed-state digest. */
  landedStateDigest: string;
  /** sha256 of the fetched record's financialOutcome — computed at minting, never caller-supplied. */
  financialOutcomeDigest: string;
  reconciledAt: string;
};

/**
 * A provider-evidence verifier (round 3): the capability object a
 * deployment creates over ITS record source and configures on the
 * store (`DurableStoreOptions.evidenceVerifier`). The store accepts
 * resolution tokens ONLY from its own configured verifier instance
 * and invokes that same instance for landing reconciliations.
 */
export type ResolutionEvidenceVerifier = {
  /**
   * Fetch the attempt's operation record from the source (query
   * built from the attempt binding) and establish it as resolution
   * evidence: binding, source/kind pairing, outcome coherence,
   * provider finality (R3), and the minting-time digest all run
   * inside. Refuses when the source holds no record or the record
   * fails validation. The caller supplies NO record.
   */
  establish(
    attempt: StoredAttempt,
    classification: "CONFIRMED_NON_EXECUTION" | "CONFIRMED_LANDING",
    now: Date,
  ): EstablishedResolutionEvidence;
  /**
   * Fetch the financial reconciliation record for a landed attempt
   * from the source and establish it as a reconciliation token:
   * binding to the attempt AND to the resolution's evidence
   * reference, the landed-state digest computed from the record
   * and required to equal the resolution's established digest, and
   * the financial-outcome digest computed from the record. Refuses
   * when the source lacks the reconciliation capability or holds
   * no record, and when the record fails validation.
   */
  establishReconciliation(attempt: StoredAttempt, resolution: StoredResolution): EstablishedLandingReconciliation;
};

function operationQueryOf(attempt: StoredAttempt): ProviderOperationRecordQuery {
  return {
    provider: attempt.provider,
    site: attempt.site,
    subscriptionId: attempt.subscriptionId,
    quoteId: attempt.quoteId,
    idempotencyKey: attempt.idempotencyKey,
    requestHash: attempt.requestHash,
  };
}

/**
 * Create a provider-evidence verifier over a deployment-supplied
 * record source (round 3, R2'/R4'). This factory is the ONLY way
 * evidence tokens come into existence, and it mints them solely
 * from records the source RETURNS for a binding-built query —
 * there is no overload, option, or sibling function that mints
 * from a caller-supplied record. Configuring the resulting
 * verifier on a store is the deployment's explicit trust decision;
 * a store with no verifier configured accepts no terminal evidence
 * (see `DurableStoreOptions.evidenceVerifier`).
 */
export function createProviderEvidenceVerifier(source: ProviderRecordSource): ResolutionEvidenceVerifier {
  if (!source || typeof source !== "object" || typeof source.fetchOperationRecord !== "function") {
    throw new ResolutionEvidenceError(
      "A provider-evidence verifier requires a record source with fetchOperationRecord(query) — the verifier retrieves provider records; it does not accept them from callers.",
    );
  }
  const verifier: ResolutionEvidenceVerifier = {
    establish(attempt, classification, now) {
      if (!attempt || typeof attempt !== "object") {
        throw new ResolutionEvidenceError("Establishment refused: an attempt record is required.", {});
      }
      const record = source.fetchOperationRecord(operationQueryOf(attempt));
      if (record === undefined || record === null) {
        throw new ResolutionEvidenceError(
          `Establishment refused for attempt ${attempt.attemptId}: the configured provider record source holds no operation record for this attempt's binding — without a fetched provider record there is nothing to establish, and the attempt remains blocked.`,
          { attemptId: attempt.attemptId },
        );
      }
      return establishResolutionEvidenceCore(attempt, record, classification, now, verifier);
    },
    establishReconciliation(attempt, resolution) {
      const refuse = (problem: string): never => {
        throw new ResolutionEvidenceError(
          `Reconciliation establishment refused for attempt ${attempt?.attemptId ?? "(unknown)"}: ${problem}`,
          { attemptId: attempt?.attemptId },
        );
      };
      if (!attempt || typeof attempt !== "object") refuse("an attempt record is required");
      if (!resolution || typeof resolution !== "object" || resolution.classification !== "CONFIRMED_LANDING") {
        refuse("a terminal CONFIRMED_LANDING resolution is required — reconciliation evidence is established against an established landing, not against a claim");
      }
      if (typeof source.fetchFinancialReconciliation !== "function") {
        refuse("the configured provider record source has no financial-reconciliation capability (fetchFinancialReconciliation) — the landing barrier cannot be satisfied until an independent reconciliation source is configured; the subscription remains blocked");
      }
      const query: ProviderReconciliationQuery = {
        ...operationQueryOf(attempt!),
        resolutionReference: resolution!.evidenceReference,
        providerOperationId: resolution!.providerOperationId,
      };
      const record = source.fetchFinancialReconciliation!(query);
      if (record === undefined || record === null) {
        refuse("the configured provider record source holds no financial reconciliation record for this landed attempt — the barrier cannot be satisfied from an attestation");
      }
      if (typeof record !== "object" || Array.isArray(record)) refuse("the fetched reconciliation is not a record object");
      // Binding: the reconciliation must be ABOUT this attempt and
      // THIS resolution, in every field.
      if (record!.provider !== attempt!.provider) refuse(`the reconciliation's provider (${String(record!.provider)}) does not match the attempt's provider (${attempt!.provider})`);
      if ((record!.site ?? null) !== attempt!.site) refuse(`the reconciliation's site (${String(record!.site ?? null)}) does not match the attempt's site (${String(attempt!.site)})`);
      if (record!.subscriptionId !== attempt!.subscriptionId) refuse(`the reconciliation's subscriptionId (${String(record!.subscriptionId)}) does not match the attempt's (${attempt!.subscriptionId})`);
      if (record!.quoteId !== attempt!.quoteId) refuse(`the reconciliation's quoteId (${String(record!.quoteId)}) does not match the attempt's (${attempt!.quoteId})`);
      if (record!.idempotencyKey !== attempt!.idempotencyKey) refuse("the reconciliation's idempotencyKey does not match the attempt's — the reconciliation must be keyed to THIS operation");
      if (record!.requestHash !== attempt!.requestHash) refuse("the reconciliation's requestHash does not match the attempt's — the reconciliation must be bound to the exact attempted request");
      if (typeof record!.resolutionReference !== "string" || record!.resolutionReference.trim() === "" || record!.resolutionReference !== resolution!.evidenceReference) {
        refuse("the reconciliation is not bound to the landing resolution's evidence reference — a reconciliation of some other (or no) resolution establishes nothing here");
      }
      const evidenceSource = typeof record!.source === "string" ? record!.source.trim() : "";
      if (!evidenceSource) refuse("the reconciliation record must name its (non-empty) source");
      const evidenceReference = typeof record!.reference === "string" ? record!.reference.trim() : "";
      if (!evidenceReference) refuse("a non-empty reference identifying the financial reconciliation record is required");
      if (record!.landedState === undefined || record!.landedState === null) {
        refuse("the reconciliation record must carry the landed state it reconciled — a bare digest assertion establishes nothing");
      }
      // The landed-state digest is COMPUTED from the fetched
      // record and must equal the digest the resolution
      // established: the barrier is bound to the SAME landed state.
      const landedStateDigest = sha256(canonicalStringify(record!.landedState));
      if (landedStateDigest !== resolution!.observedProviderStateDigest) {
        refuse("the reconciliation's landed state does not digest to the landed state the resolution established — the reconciliation must be OF the established landed state, not of some other state");
      }
      if (!record!.financialOutcome || typeof record!.financialOutcome !== "object" || Array.isArray(record!.financialOutcome)) {
        refuse("the reconciliation record must carry its financial outcome object — the financial-outcome digest is computed from it, never supplied by a caller");
      }
      const financialOutcomeDigest = sha256(canonicalStringify(record!.financialOutcome));
      if (Number.isNaN(Date.parse(record!.reconciledAt ?? ""))) refuse("the reconciliation record's reconciledAt must be a parseable ISO timestamp");
      const token: EstablishedLandingReconciliation = {
        attemptId: attempt!.attemptId,
        quoteId: attempt!.quoteId,
        subscriptionId: attempt!.subscriptionId,
        provider: attempt!.provider,
        site: attempt!.site,
        requestHash: attempt!.requestHash,
        idempotencyKey: attempt!.idempotencyKey,
        resolutionReference: resolution!.evidenceReference,
        evidenceSource,
        evidenceReference,
        landedStateVersion: resolution!.landedStateVersion,
        landedStateDigest,
        financialOutcomeDigest,
        reconciledAt: record!.reconciledAt,
      };
      establishedReconciliationTokens.add(token);
      establishedReconciliationBindings.set(token, {
        attemptId: attempt!.attemptId,
        verifier,
        contentDigest: sha256(canonicalStringify(token)),
      });
      return token;
    },
  };
  return verifier;
}

export type DurableStoreOptions = {
  busyTimeoutMs?: number;
  /**
   * The provider-evidence verifier whose established tokens this
   * store accepts and whose reconciliation establishments satisfy
   * the landing barrier (round 3, R2'/R4'). Configuring it is the
   * deployment's explicit trust decision: the verifier's record
   * source defines what counts as provider evidence. When ABSENT
   * (the default), the store has no evidence capability at all —
   * every terminal `resolveAttempt` refuses, the landing barrier
   * can never be satisfied, and operators may record only ASSERTED
   * (unverified, non-lifting) claims and UNRESOLVED audit records.
   * Fail closed by construction.
   */
  evidenceVerifier?: ResolutionEvidenceVerifier;
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

/**
 * Schema v2 addition (P0, issue #43): the append-only resolution
 * evidence table. No code path updates or deletes from this table;
 * a record, once persisted, is immutable, and on open every row is
 * re-verified (payload hash + attempt binding) before adoption.
 * The (evidence_source, evidence_reference) uniqueness is a PARTIAL
 * unique index over terminal (block-lifting) records: one provider
 * evidence reference may establish exactly one attempt's terminal
 * resolution, while UNRESOLVED audit records (which may carry no
 * evidence reference at all) are not forced to mint one.
 * Schema v3 (PR #50 correction round) adds the provider-finality
 * columns (log_final, complete_through, registry_coverage) and
 * landed_state_version: a v2-era terminal row migrates with these
 * NULL — preserved as a record, but NON-LIFTING at runtime, because
 * finality was never attested for it (see `terminalResolutionFor`).
 * Schema v4 (PR #50 correction round 3) adds trust_tier: EVERY
 * pre-v4 row backfills to 'ASSERTED' on migration — pre-v4 evidence
 * was minted through the removed public establishment function or
 * accepted as caller digests, i.e. untrusted under the round-3
 * boundary — so it is preserved and readable but NON-LIFTING; only
 * rows written by v4 code from a store-configured verifier carry
 * 'VERIFIED'. The (evidence_source, evidence_reference) replay
 * uniqueness is scoped accordingly: it covers VERIFIED terminal
 * records, the only ones whose reference is evidence.
 */
const RESOLUTION_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS attempt_resolutions (
     resolution_id TEXT PRIMARY KEY,
     attempt_id TEXT NOT NULL,
     quote_id TEXT NOT NULL,
     subscription_id TEXT NOT NULL,
     provider TEXT NOT NULL,
     site TEXT,
     request_hash TEXT NOT NULL,
     idempotency_key TEXT NOT NULL,
     classification TEXT NOT NULL,
     operator_id TEXT NOT NULL,
     resolved_at TEXT NOT NULL,
     evidence_source TEXT NOT NULL,
     evidence_kind TEXT NOT NULL,
     evidence_reference TEXT NOT NULL,
     observed_at TEXT NOT NULL,
     observed_provider_state_digest TEXT NOT NULL,
     provider_operation_id TEXT,
     reconciliation_decision TEXT NOT NULL,
     justification TEXT NOT NULL,
     evidence_payload_json TEXT NOT NULL,
     evidence_hash TEXT NOT NULL UNIQUE,
     log_final INTEGER,
     complete_through TEXT,
     registry_coverage TEXT,
     landed_state_version TEXT,
     trust_tier TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS idx_attempt_resolutions_attempt ON attempt_resolutions(attempt_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_attempt_resolutions_evidence_ref ON attempt_resolutions(evidence_source, evidence_reference) WHERE classification != 'UNRESOLVED' AND trust_tier = 'VERIFIED'`,
];

/** Columns added to attempt_resolutions by the v2 → v3 migration (PR #50 correction round). */
const RESOLUTION_V3_COLUMNS: Array<readonly [string, string]> = [
  ["log_final", "INTEGER"],
  ["complete_through", "TEXT"],
  ["registry_coverage", "TEXT"],
  ["landed_state_version", "TEXT"],
];

/**
 * Schema v3 addition (PR #50 review R4): the append-only landing
 * reconciliation table — one row per landed attempt, recording that
 * the landed state and the financial consequences were reconciled
 * before the subscription unblocked. Its `record_hash` is the sha256
 * checksum of the row's canonical payload: an internal-consistency
 * checksum (it detects mismatched edits; it is not keyed
 * authentication), re-verified on open like the resolution rows.
 * Schema v4 (correction round 3) adds trust_tier and
 * evidence_reference: a v4 row is written only from a fetched,
 * verifier-established reconciliation record and names it; pre-v4
 * rows backfill to trust_tier 'ASSERTED' with a NULL reference and
 * never satisfy the barrier.
 */
const LANDING_RECONCILIATION_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS landing_reconciliations (
     reconciliation_id TEXT PRIMARY KEY,
     attempt_id TEXT NOT NULL UNIQUE,
     quote_id TEXT NOT NULL,
     subscription_id TEXT NOT NULL,
     landed_state_version TEXT NOT NULL,
     landed_state_digest TEXT NOT NULL,
     financial_outcome_digest TEXT NOT NULL,
     operator_id TEXT NOT NULL,
     reconciled_at TEXT NOT NULL,
     justification TEXT NOT NULL,
     payload_json TEXT NOT NULL,
     record_hash TEXT NOT NULL UNIQUE,
     trust_tier TEXT,
     evidence_reference TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS idx_landing_reconciliations_attempt ON landing_reconciliations(attempt_id)`,
];

export class DurableQuoteStore extends QuoteStore {
  private db: Db;
  private versions = new Map<string, number>();
  private poisoned: Error | undefined;
  private readonly recoveryGraceMs: number;
  private readonly faults: DurableStoreOptions["faults"];
  private readonly nowFn: () => Date;
  private readonly evidenceVerifier?: ResolutionEvidenceVerifier;
  private attemptSeq = 0;
  private resolutionSeq = 0;

  constructor(
    private readonly dbPath: string,
    opts: DurableStoreOptions = {},
  ) {
    super();
    this.faults = opts.faults;
    this.recoveryGraceMs = opts.recoveryGraceMs ?? 30_000;
    this.nowFn = opts.now ?? (() => new Date());
    if (opts.evidenceVerifier !== undefined) {
      if (!opts.evidenceVerifier || typeof opts.evidenceVerifier !== "object" || typeof opts.evidenceVerifier.establish !== "function") {
        throw new DurableStoreError(
          "Durable store misconfigured: evidenceVerifier must be a verifier created by createProviderEvidenceVerifier(source) — the store accepts evidence only through that capability boundary.",
        );
      }
      this.evidenceVerifier = opts.evidenceVerifier;
    }
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
      if (Number.isInteger(version) && version === DURABLE_SCHEMA_VERSION) return;
      if (Number.isInteger(version) && version === 1) {
        // v1 → v4: ONE transaction creates the append-only
        // attempt_resolutions table (at its v4 shape) and the
        // landing_reconciliations table and advances the version
        // marker. No existing row is touched: v1 attempts keep their
        // state and their operator_review_state flag verbatim — in
        // particular a legacy flag-only 'RESOLVED' attempt gains NO
        // resolution record here and therefore remains blocking
        // under the evidence-derived rules (it is never silently
        // upgraded).
        const tx = this.db.transaction(() => {
          for (const stmt of RESOLUTION_SCHEMA_STATEMENTS) this.db.exec(stmt);
          for (const stmt of LANDING_RECONCILIATION_SCHEMA_STATEMENTS) this.db.exec(stmt);
          this.db.prepare(`UPDATE meta SET value = ? WHERE key = 'schema_version'`).run(String(DURABLE_SCHEMA_VERSION));
        });
        tx.immediate();
        return;
      }
      if (Number.isInteger(version) && version === 2) {
        // v2 → v4 (PR #50 correction rounds 1+3): ONE transaction
        // adds the provider-finality / landed-version columns
        // (v3) and the trust_tier column (v4) to
        // attempt_resolutions, creates landing_reconciliations at
        // its v4 shape, backfills trust, and re-scopes the replay
        // index. No existing row is altered in content: a v2-era
        // terminal resolution keeps log_final NULL (finality was
        // never attested) and gains trust_tier 'ASSERTED' — under
        // both rules it is preserved as a record but NON-LIFTING.
        const tx = this.db.transaction(() => {
          for (const [name, type] of RESOLUTION_V3_COLUMNS) {
            this.db.exec(`ALTER TABLE attempt_resolutions ADD COLUMN ${name} ${type}`);
          }
          for (const stmt of LANDING_RECONCILIATION_SCHEMA_STATEMENTS) this.db.exec(stmt);
          this.migrateTrustTierV4();
          this.db.prepare(`UPDATE meta SET value = ? WHERE key = 'schema_version'`).run(String(DURABLE_SCHEMA_VERSION));
        });
        tx.immediate();
        return;
      }
      if (Number.isInteger(version) && version === 3) {
        // v3 → v4 (PR #50 correction round 3): ONE transaction adds
        // trust_tier to attempt_resolutions and trust_tier +
        // evidence_reference to landing_reconciliations, backfills
        // EVERY pre-v4 row to 'ASSERTED', and re-scopes the replay
        // index to VERIFIED rows. Round-2/3-era evidence was minted
        // through the public establishment function (R2') or
        // accepted as caller digests (R4') — untrusted under the
        // round-3 boundary — so no pre-v4 row may keep lifting;
        // each remains preserved and readable at the ASSERTED tier.
        const tx = this.db.transaction(() => {
          this.db.exec(`ALTER TABLE landing_reconciliations ADD COLUMN trust_tier TEXT`);
          this.db.exec(`ALTER TABLE landing_reconciliations ADD COLUMN evidence_reference TEXT`);
          this.migrateTrustTierV4();
          this.db.prepare(`UPDATE meta SET value = ? WHERE key = 'schema_version'`).run(String(DURABLE_SCHEMA_VERSION));
        });
        tx.immediate();
        return;
      }
      throw new DurableRecoveryError(
        `Recovery refused: unsupported durable schema version ${row?.value ?? "(missing)"}; this build supports ${DURABLE_SCHEMA_VERSION} (with in-place migrations from versions 1, 2 and 3). Nothing was adopted.`,
        { schemaVersion: row?.value ?? null },
      );
    }
    const tx = this.db.transaction(() => {
      for (const stmt of SCHEMA_STATEMENTS) this.db.exec(stmt);
      for (const stmt of RESOLUTION_SCHEMA_STATEMENTS) this.db.exec(stmt);
      for (const stmt of LANDING_RECONCILIATION_SCHEMA_STATEMENTS) this.db.exec(stmt);
      this.db.prepare(`INSERT INTO meta (key, value) VALUES ('schema_version', ?)`).run(String(DURABLE_SCHEMA_VERSION));
      this.db.prepare(`INSERT INTO meta (key, value) VALUES ('created_at', ?)`).run(this.nowFn().toISOString());
    });
    tx.immediate();
  }

  /**
   * The shared v3/v2 → v4 trust-tier step (runs INSIDE the caller's
   * migration transaction): add the trust_tier column to
   * attempt_resolutions, backfill EVERY pre-existing resolution and
   * reconciliation row to 'ASSERTED' (the conservative tier — see
   * the v3 branch comment), and re-scope the (source, reference)
   * replay index to VERIFIED terminal rows. Index replacement is
   * metadata, not row alteration: no row is modified except the
   * trust_tier backfill itself, and no row is deleted.
   */
  private migrateTrustTierV4(): void {
    this.db.exec(`ALTER TABLE attempt_resolutions ADD COLUMN trust_tier TEXT`);
    this.db.exec(`UPDATE attempt_resolutions SET trust_tier = 'ASSERTED' WHERE trust_tier IS NULL`);
    this.db.exec(`UPDATE landing_reconciliations SET trust_tier = 'ASSERTED' WHERE trust_tier IS NULL`);
    this.db.exec(`DROP INDEX IF EXISTS idx_attempt_resolutions_evidence_ref`);
    this.db.exec(
      `CREATE UNIQUE INDEX idx_attempt_resolutions_evidence_ref ON attempt_resolutions(evidence_source, evidence_reference) WHERE classification != 'UNRESOLVED' AND trust_tier = 'VERIFIED'`,
    );
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
      //
      // PR-17: the current view is NOT copied from the persisted
      // current_json — the view is a derived value (recorded
      // receipt + evidence trail), so after the verbatim recorded
      // receipt and trail are substituted, the view and the
      // entries' derived fields are re-derived from those verbatim
      // inputs via the parent's adoptDerivedView. A persisted
      // legacy (pre-PR-17) current view therefore recovers as the
      // truthful derived view, exactly as the parent's restore
      // coherence approved.
      const internal = (this as unknown as { quotes: Map<string, StoredQuote> }).quotes;
      for (const rec of records) {
        const q = internal.get(rec.quote_id);
        if (!q) continue;
        q.commit_receipt_recorded = deepFreezeLocal(deepCopyLocal(rec.recorded_receipt));
        q.commit_receipt_verifications = deepCopyLocal(rec.verifications) as StoredQuote["commit_receipt_verifications"];
        QuoteStore.prototype.adoptDerivedView.call(this, rec.quote_id);
      }
    }
    this.verifyResolutionsOnOpen();
    this.verifyLandingReconciliationsOnOpen();
    this.recoverAttempts();
  }

  /**
   * R4: landing reconciliation rows are adopted only after the same
   * consistency discipline as resolution rows — the record checksum
   * recomputes from the stored payload, the payload's fields equal
   * the row columns, the referenced attempt exists, and the row is
   * bound to a terminal CONFIRMED_LANDING resolution of its attempt
   * (same landed state version and state digest). A reconciliation
   * that does not re-verify must never unblock a subscription.
   * Round 3: the binding check accepts a terminal landing
   * resolution at EITHER trust tier — a pre-v4 (ASSERTED) row was
   * recorded against a pre-v4 resolution and must still verify as a
   * RECORD; whether it can satisfy the barrier is a separate,
   * tier-gated question (`landingReconciliationFor`).
   */
  private verifyLandingReconciliationsOnOpen(): void {
    const rows = this.db.prepare(`SELECT * FROM landing_reconciliations ORDER BY rowid`).all() as Array<Record<string, unknown>>;
    for (const row of rows) {
      const refuse = (problem: string): never => {
        throw new DurableRecoveryError(
          `Recovery refused: the persisted landing reconciliation ${row.reconciliation_id} for attempt ${row.attempt_id} ${problem}; nothing is adopted.`,
          { reconciliationId: row.reconciliation_id, attemptId: row.attempt_id },
        );
      };
      let payload: StoredLandingReconciliation & { recordHash?: unknown };
      try {
        payload = decodeRecordJson<StoredLandingReconciliation>(row.payload_json as string);
      } catch (e) {
        refuse(`is not decodable (${(e as Error).message})`);
      }
      const { recordHash: _payloadHash, ...payloadFields } = payload!;
      if (sha256(canonicalStringify(payloadFields)) !== row.record_hash) {
        refuse("fails its record-hash consistency check — the payload and its stored checksum disagree (a mismatched or transplanted edit)");
      }
      const columnBinding: Record<string, unknown> = {
        reconciliationId: row.reconciliation_id, attemptId: row.attempt_id, quoteId: row.quote_id,
        subscriptionId: row.subscription_id, landedStateVersion: row.landed_state_version,
        landedStateDigest: row.landed_state_digest, financialOutcomeDigest: row.financial_outcome_digest,
        operatorId: row.operator_id, reconciledAt: row.reconciled_at, justification: row.justification,
        // v4 fields. A pre-v4 payload does not carry them: it reads
        // as the migration backfill (ASSERTED, no reference), which
        // is exactly the preserved-but-non-lifting rule.
        trustTier: (row.trust_tier as string | null) ?? "ASSERTED",
        evidenceReference: (row.evidence_reference as string | null) ?? null,
      };
      const payloadDefaults: Record<string, unknown> = { trustTier: "ASSERTED", evidenceReference: null };
      for (const [k, v] of Object.entries(columnBinding)) {
        const carried = (payloadFields as Record<string, unknown>)[k];
        const actual = carried === undefined ? payloadDefaults[k] : carried;
        if (actual !== v) refuse(`has a payload binding that disagrees with its record columns (${k})`);
      }
      const attemptRow = this.db.prepare(`SELECT * FROM attempts WHERE attempt_id = ?`).get(row.attempt_id) as Record<string, unknown> | undefined;
      if (!attemptRow) refuse("references an attempt that does not exist");
      const bound = this.resolutionsForAttempt(row.attempt_id as string).some(
        (r) =>
          r.classification === "CONFIRMED_LANDING" &&
          r.landedStateVersion === (row.landed_state_version as string) &&
          r.observedProviderStateDigest === (row.landed_state_digest as string),
      );
      if (!bound) {
        refuse("is not bound to a terminal CONFIRMED_LANDING resolution for its attempt with the same landed state");
      }
    }
  }

  /**
   * P0 (issue #43): persisted resolution evidence is adopted ONLY
   * after every row re-verifies — the evidence checksum recomputes
   * from the stored payload, the payload's binding fields equal the
   * row columns, and the referenced attempt exists with the SAME
   * quote / subscription / provider / site / request hash /
   * idempotency key the payload claims. Any mismatch refuses the
   * whole open (fail closed, exactly like receipt corruption): a
   * resolution record whose payload and checksum disagree must
   * never lift a dispatch block. (The checksum is an
   * internal-consistency check — it detects mismatched edits; it
   * is not keyed authentication, and a writer who can rewrite both
   * payload and digest consistently is outside this mechanism's
   * threat model. See the research note.)
   */
  private verifyResolutionsOnOpen(): void {
    const rows = this.db.prepare(`SELECT * FROM attempt_resolutions ORDER BY rowid`).all() as Array<Record<string, unknown>>;
    for (const row of rows) {
      const refuse = (problem: string): never => {
        throw new DurableRecoveryError(
          `Recovery refused: the persisted resolution record ${row.resolution_id} for attempt ${row.attempt_id} ${problem}; nothing is adopted.`,
          { resolutionId: row.resolution_id, attemptId: row.attempt_id },
        );
      };
      let payload: StoredResolution & { evidenceHash?: unknown };
      try {
        payload = decodeRecordJson<StoredResolution>(row.evidence_payload_json as string);
      } catch (e) {
        refuse(`is not decodable (${(e as Error).message})`);
      }
      const { evidenceHash: _payloadHash, ...payloadFields } = payload!;
      if (sha256(canonicalStringify(payloadFields)) !== row.evidence_hash) {
        refuse("fails its evidence-hash consistency check — the payload and its stored checksum disagree (a mismatched or transplanted edit)");
      }
      const columnBinding: Record<string, unknown> = {
        resolutionId: row.resolution_id, attemptId: row.attempt_id, quoteId: row.quote_id,
        subscriptionId: row.subscription_id, provider: row.provider, site: row.site ?? null,
        requestHash: row.request_hash, idempotencyKey: row.idempotency_key,
        classification: row.classification, operatorId: row.operator_id, resolvedAt: row.resolved_at,
        evidenceSource: row.evidence_source, evidenceKind: row.evidence_kind, evidenceReference: row.evidence_reference,
        observedAt: row.observed_at, observedProviderStateDigest: row.observed_provider_state_digest,
        providerOperationId: row.provider_operation_id ?? null, reconciliationDecision: row.reconciliation_decision,
        justification: row.justification,
        // v3 fields. A v2-era payload predates them: it reads as the
        // defaults (log_final NULL → false, watermark absent), which
        // is exactly the non-lifting compatibility rule — the row is
        // adopted as a record but can never lift a block.
        logFinal: row.log_final === 1,
        completeThrough: row.complete_through ?? "",
        registryCoverage: row.registry_coverage ?? null,
        landedStateVersion: row.landed_state_version ?? null,
        // v4 field. A pre-v4 payload predates it: it reads as the
        // migration backfill (ASSERTED), the non-lifting tier.
        trustTier: (row.trust_tier as string | null) ?? "ASSERTED",
      };
      // Defaults for fields a pre-v4 payload does not carry at all
      // (an explicitly-null payload field is a real value, not an
      // absence — hence the undefined test, not ??).
      const payloadDefaults: Record<string, unknown> = { logFinal: false, completeThrough: "", registryCoverage: null, landedStateVersion: null, establishmentProcedure: "", trustTier: "ASSERTED" };
      for (const [k, v] of Object.entries(columnBinding)) {
        const carried = (payloadFields as Record<string, unknown>)[k];
        const actual = carried === undefined ? payloadDefaults[k] : carried;
        if (actual !== v) refuse(`has a payload binding that disagrees with its record columns (${k})`);
      }
      const attemptRow = this.db.prepare(`SELECT * FROM attempts WHERE attempt_id = ?`).get(row.attempt_id) as Record<string, unknown> | undefined;
      if (!attemptRow) refuse("references an attempt that does not exist");
      const attempt = this.rowToAttempt(attemptRow!);
      if (
        payloadFields.attemptId !== attempt.attemptId || payloadFields.quoteId !== attempt.quoteId ||
        payloadFields.subscriptionId !== attempt.subscriptionId || payloadFields.provider !== attempt.provider ||
        payloadFields.site !== attempt.site || payloadFields.requestHash !== attempt.requestHash ||
        payloadFields.idempotencyKey !== attempt.idempotencyKey
      ) {
        refuse("is bound to different attempt identity fields than the attempt it resolves");
      }
    }
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
    // PR-17 review correction D1: EVERY step of the persistence
    // path — the pre-persist fault hook, the persistence encoding,
    // and the transaction itself — is inside the fail-closed
    // coverage. A failure in any of them poisons the store: the
    // parent's in-memory mutation has already happened by the time
    // write-through runs, and a store that cannot prove its memory
    // matches disk must not serve that memory as durable (reads are
    // poison-guarded below). Previously the hook and the encoding
    // ran outside the try/catch, so a hook failure left the store
    // unpoisoned AND its volatile state readable.
    try {
      this.faults?.beforePersist?.(op);
      const quote = QuoteStore.prototype.get.call(this, quoteId) as StoredQuote | undefined;
      if (!quote) return;
      const expected = this.versions.get(quoteId) ?? 0;
      const next = expected + 1;
      const recordJson = encodeRecordJson(quote);
      const recordSha = sha256(recordJson);
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

  /**
   * PR-17: evidence appends are write-through like every other
   * receipt mutation — the in-memory append + view re-derivation
   * and the SQLite transaction (quote row + receipt record, ONE
   * transaction in persistQuote) are the atomicity boundary: a
   * persistence failure poisons the instance (D1), so an append
   * that did not reach disk is never served as durable, and a
   * restart recovers exactly the pre- or post-append record,
   * never a promoted view without its supporting evidence.
   */
  override recordReceiptEvidence(
    quoteId: string,
    evidence: VerificationEvidence,
    presentedReceipt?: SubscriptionChangeReceipt,
    at?: string,
  ): SubscriptionChangeReceipt {
    this.assertHealthy();
    const current = QuoteStore.prototype.recordReceiptEvidence.call(this, quoteId, evidence, presentedReceipt, at);
    this.persistQuote(quoteId, "recordReceiptEvidence");
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

  // -- QuoteStore read guards (PR-17 review correction D1) --------------------
  //
  // Every write-through override above mutates the parent's
  // in-memory state FIRST and persists second. If persistence
  // fails, the store is poisoned — but poison alone only stopped
  // WRITES; the inherited reads kept serving the newer volatile
  // state (a receipt that was never persisted could be returned by
  // recordedReceipt, and with it by checkIdempotentReplay's §6.10
  // replay in the adapters, as if it were durable — a restart then
  // lost it). So every read / replay / enumeration egress is
  // poison-guarded here: once a persistence failure has occurred,
  // NO read on this instance serves state that may not be on disk.
  // The only recovery is a restart from the database file, whose
  // contents are exactly what actually committed. (The internal
  // load/recovery path deliberately calls the parent's prototype
  // methods directly, before any poisoning can exist; the attempt
  // ledger reads below hit SQLite directly and always reflect
  // durable truth.)

  override get(quoteId: string): StoredQuote | undefined {
    this.assertHealthy();
    return QuoteStore.prototype.get.call(this, quoteId) as StoredQuote | undefined;
  }

  override all(): StoredQuote[] {
    this.assertHealthy();
    return QuoteStore.prototype.all.call(this) as StoredQuote[];
  }

  override recordedReceipt(quoteId: string): SubscriptionChangeReceipt | undefined {
    this.assertHealthy();
    return QuoteStore.prototype.recordedReceipt.call(this, quoteId);
  }

  override receiptsWithReconciliation(status: ReconciliationResult["status"]): SubscriptionChangeReceipt[] {
    this.assertHealthy();
    return QuoteStore.prototype.receiptsWithReconciliation.call(this, status);
  }

  override serializeReceiptRecords(): string {
    this.assertHealthy();
    return QuoteStore.prototype.serializeReceiptRecords.call(this);
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

  // -- resolution evidence (P0, issue #43) ------------------------------------

  private rowToResolution(row: Record<string, unknown>): StoredResolution {
    return {
      resolutionId: row.resolution_id as string,
      attemptId: row.attempt_id as string,
      quoteId: row.quote_id as string,
      subscriptionId: row.subscription_id as string,
      provider: row.provider as string,
      site: (row.site as string | null) ?? null,
      requestHash: row.request_hash as string,
      idempotencyKey: row.idempotency_key as string,
      classification: row.classification as ResolutionClassification,
      operatorId: row.operator_id as string,
      resolvedAt: row.resolved_at as string,
      evidenceSource: row.evidence_source as string,
      evidenceKind: row.evidence_kind as string,
      evidenceReference: row.evidence_reference as string,
      observedAt: row.observed_at as string,
      observedProviderStateDigest: row.observed_provider_state_digest as string,
      providerOperationId: (row.provider_operation_id as string | null) ?? null,
      reconciliationDecision: row.reconciliation_decision as string,
      justification: row.justification as string,
      evidenceHash: row.evidence_hash as string,
      logFinal: row.log_final === 1,
      completeThrough: (row.complete_through as string | null) ?? "",
      registryCoverage: (row.registry_coverage as string | null) ?? null,
      landedStateVersion: (row.landed_state_version as string | null) ?? null,
      // Payload-only provenance (no column of its own): how the
      // evidence was minted. "" for UNRESOLVED audit records and
      // v2-era rows, which predate the establishment procedure.
      establishmentProcedure: (() => {
        try {
          const payload = decodeRecordJson<Record<string, unknown>>(row.evidence_payload_json as string);
          return typeof payload.establishmentProcedure === "string" ? payload.establishmentProcedure : "";
        } catch {
          return "";
        }
      })(),
      trustTier: (row.trust_tier as string) === "VERIFIED" ? "VERIFIED" : "ASSERTED",
    };
  }

  /** Every resolution record for an attempt, in append order (terminal and UNRESOLVED records alike). */
  resolutionsForAttempt(attemptId: string): StoredResolution[] {
    return (this.db.prepare(`SELECT * FROM attempt_resolutions WHERE attempt_id = ? ORDER BY rowid`).all(attemptId) as Array<Record<string, unknown>>).map((r) => this.rowToResolution(r));
  }

  /**
   * The attempt's governing resolution record: a VERIFIED terminal
   * (CONFIRMED_*) record if one exists, else any terminal record
   * (an ASSERTED claim), else its latest record, else undefined.
   */
  getResolution(attemptId: string): StoredResolution | undefined {
    const all = this.resolutionsForAttempt(attemptId);
    return (
      all.find((r) => r.classification !== "UNRESOLVED" && r.trustTier === "VERIFIED") ??
      all.find((r) => r.classification !== "UNRESOLVED") ??
      all[all.length - 1]
    );
  }

  /**
   * The terminal (block-LIFTING) resolution for an attempt, if one
   * was established through this store's verifier boundary WITH
   * provider finality. COMPATIBILITY RULES: a v2-era terminal row
   * carries log_final NULL — finality was never attested for it
   * (schema v3) — and EVERY pre-v4 row carries trust_tier ASSERTED
   * — its evidence was minted through the removed public
   * establishment function or, for reconciliations, caller digests
   * (schema v4). Either defect makes the row a preserved record
   * (see `getResolution` / `resolutionsForAttempt`) that is
   * NON-LIFTING here and can never satisfy this lookup. ASSERTED
   * operator claims (`recordAssertedResolution`) are non-lifting
   * by the same tier rule.
   */
  private terminalResolutionFor(attemptId: string): StoredResolution | undefined {
    return this.resolutionsForAttempt(attemptId).find(
      (r) => r.classification !== "UNRESOLVED" && r.logFinal && r.trustTier === "VERIFIED",
    );
  }

  /** Any terminal-classification record for an attempt (either trust tier), for append-order discipline checks that a standing terminal claim/record already exists. */
  private anyTerminalResolutionFor(attemptId: string): StoredResolution | undefined {
    return this.resolutionsForAttempt(attemptId).find((r) => r.classification !== "UNRESOLVED");
  }

  private rowToLandingReconciliation(row: Record<string, unknown>): StoredLandingReconciliation {
    return {
      reconciliationId: row.reconciliation_id as string,
      attemptId: row.attempt_id as string,
      quoteId: row.quote_id as string,
      subscriptionId: row.subscription_id as string,
      landedStateVersion: row.landed_state_version as string,
      landedStateDigest: row.landed_state_digest as string,
      financialOutcomeDigest: row.financial_outcome_digest as string,
      operatorId: row.operator_id as string,
      reconciledAt: row.reconciled_at as string,
      justification: row.justification as string,
      recordHash: row.record_hash as string,
      trustTier: (row.trust_tier as string) === "VERIFIED" ? "VERIFIED" : "ASSERTED",
      evidenceReference: (row.evidence_reference as string | null) ?? null,
    };
  }

  /**
   * The VERIFIED landing reconciliation for an attempt, if the
   * R4/R4' barrier has been satisfied for it through the verifier
   * boundary. This is the only reader the blocking paths consult:
   * a pre-v4 (ASSERTED) reconciliation row never satisfies it.
   */
  landingReconciliationFor(attemptId: string): StoredLandingReconciliation | undefined {
    const record = this.landingReconciliationRecordFor(attemptId);
    return record && record.trustTier === "VERIFIED" ? record : undefined;
  }

  /** The recorded landing reconciliation for an attempt at ANY trust tier (the preserved record, e.g. a pre-v4 ASSERTED row), or undefined. */
  landingReconciliationRecordFor(attemptId: string): StoredLandingReconciliation | undefined {
    const row = this.db.prepare(`SELECT * FROM landing_reconciliations WHERE attempt_id = ?`).get(attemptId) as Record<string, unknown> | undefined;
    return row ? this.rowToLandingReconciliation(row) : undefined;
  }

  /**
   * A blocking attempt is one that forbids a new dispatch for the
   * same quote or the same subscription: a non-terminal attempt
   * (PREPARED is NOT blocking — dispatch provably never occurred;
   * DISPATCHING is), or an INDETERMINATE terminal attempt with no
   * terminal structured-evidence resolution.
   *
   * P0 (issue #43): blocking is derived from the resolution EVIDENCE
   * TABLE, never from the operator_review_state flag alone.
   * PR #50 correction round (R1/R4):
   *  - a terminally resolved attempt (EITHER class) ALWAYS blocks
   *    its OWN quote, for any key: frozen §6.15 requires
   *    re-authorization after INDETERMINATE to proceed as a NEW
   *    quote, never as a re-issue of the indeterminate attempt.
   *    (The re-arm exception in `beginDispatch` covers only
   *    attempts that were ORIGINALLY terminal
   *    CONFIRMED_NON_EXECUTION — a different state path, untouched
   *    by this rule.)
   *  - CONFIRMED_NON_EXECUTION: other quotes on the subscription
   *    are not blocked (non-execution was established for THIS
   *    operation; a new quote is a new authorization);
   *  - CONFIRMED_LANDING without a recorded landing reconciliation:
   *    the attempt blocks the WHOLE subscription — the landed
   *    state and its financial consequences are unreconciled, so
   *    no quote may build on unknown state. With the reconciliation
   *    recorded, other quotes unblock SUBJECT TO the stale-quote
   *    rule in `beginDispatch`;
   *  - no record, only UNRESOLVED records, a non-lifting v2-era
   *    record, an ASSERTED (unverified) operator claim, a pre-v4
   *    ASSERTED-tier record, or a legacy v1
   *    operator_review_state='RESOLVED' flag with NO record: the
   *    attempt BLOCKS. A legacy flag is never silently upgraded,
   *    and an asserted claim is never silently verified.
   */
  findBlockingAttempt(quoteId: string, subscriptionId: string, excludeAttemptId?: string): StoredAttempt | undefined {
    const rows = this.db.prepare(
      `SELECT * FROM attempts WHERE (quote_id = ? OR subscription_id = ?) AND state IN ('DISPATCHING','INDETERMINATE')${excludeAttemptId !== undefined ? " AND attempt_id != ?" : ""} ORDER BY created_at, attempt_id`,
    ).all(...(excludeAttemptId !== undefined ? [quoteId, subscriptionId, excludeAttemptId] : [quoteId, subscriptionId])) as Array<Record<string, unknown>>;
    for (const row of rows) {
      const attempt = this.rowToAttempt(row);
      if (attempt.state === "DISPATCHING") return attempt;
      const terminal = this.terminalResolutionFor(attempt.attemptId);
      if (!terminal) return attempt;
      if (attempt.quoteId === quoteId) return attempt; // R1: a resolved attempt always blocks its own quote, any key
      if (terminal.classification === "CONFIRMED_LANDING" && !this.landingReconciliationFor(attempt.attemptId)) {
        return attempt; // R4: an unreconciled landing blocks the whole subscription
      }
      // Otherwise the attempt does not block this (different) quote:
      // CONFIRMED_NON_EXECUTION releases the subscription, and a
      // reconciled landing releases it subject to the stale-quote
      // rule enforced in beginDispatch.
    }
    return undefined;
  }

  /**
   * R4 stale-quote protection, enforced inside the beginDispatch
   * transaction: once a landed attempt on the candidate's
   * subscription has been reconciled, a candidate quote may
   * dispatch only if it was issued AFTER the landing resolution
   * AND was computed against the landed state version. A quote
   * issued before the landing carries pre-landing terms and a
   * pre-landing subscription version; letting it dispatch after
   * the unblock would apply a change computed against a state the
   * landing already replaced. The landed attempt's own quote never
   * reaches this check — `findBlockingAttempt` blocks it outright.
   */
  private assertQuoteNotStaleAfterLanding(candidateQuoteId: string): void {
    const row = this.db.prepare(`SELECT record_json FROM quotes WHERE quote_id = ?`).get(candidateQuoteId) as { record_json: string } | undefined;
    if (!row) return; // the D5 stored-quote check in beginDispatch refuses unknown quotes separately
    const candidate = decodeRecordJson<StoredQuote>(row.record_json);
    const landedRows = this.db.prepare(
      `SELECT * FROM attempts WHERE subscription_id = ? AND state = 'INDETERMINATE' ORDER BY created_at, attempt_id`,
    ).all(candidate.subscription_id) as Array<Record<string, unknown>>;
    for (const landedRow of landedRows) {
      const landed = this.rowToAttempt(landedRow);
      const resolution = this.terminalResolutionFor(landed.attemptId);
      if (!resolution || resolution.classification !== "CONFIRMED_LANDING") continue;
      if (!this.landingReconciliationFor(landed.attemptId)) continue; // unreconciled landings block via findBlockingAttempt
      const createdBeforeLanding = candidate.created_at <= resolution.resolvedAt;
      const versionMismatch = candidate.subscription_version_at_quote !== resolution.landedStateVersion;
      if (createdBeforeLanding || versionMismatch) {
        throw new DispatchBlockedError(
          `Dispatch blocked: quote ${candidateQuoteId} is stale after the reconciled landing of attempt ${landed.attemptId} — ` +
            (createdBeforeLanding
              ? `it was issued at ${candidate.created_at}, before the landing resolution at ${resolution.resolvedAt}, so its terms predate the landed state`
              : `it was computed against subscription version ${JSON.stringify(candidate.subscription_version_at_quote)}, not the landed state version ${JSON.stringify(resolution.landedStateVersion)}`) +
            `; only a fresh quote validated against the landed state may dispatch.`,
          { quoteId: candidateQuoteId, attemptId: landed.attemptId, landedStateVersion: resolution.landedStateVersion },
        );
      }
    }
  }

  /**
   * THE write-ahead gate. In ONE immediate transaction:
   *   - refuses when the intent's quote is not durably stored in
   *     THIS database, or the stored quote's subscription /
   *     provider binding differs from the intent's (D5: no orphan
   *     attempts — the intent and the receipt must live in the
   *     same database, bound to the same stored quote);
   *   - refuses when the idempotency key is already bound to a
   *     DIFFERENT request hash (key reuse with different parameters);
   *   - refuses when the key is bound to a different quote /
   *     subscription / provider / site (D2: a key is never
   *     re-associated, whatever the bound attempt's state);
   *   - returns the existing attempt when the same key + same
   *     request is presented again (the original attempt stands) —
   *     except a CONFIRMED_NON_EXECUTION attempt, which may be
   *     re-armed ONLY after the blocking-attempt exclusion is
   *     re-checked in this same transaction (D2);
   *   - refuses when a blocking attempt exists for this quote or
   *     subscription;
   *   - refuses a candidate quote that is stale after a reconciled
   *     landing on its subscription (R4: issued before the landing
   *     resolution, or computed against a pre-landing subscription
   *     version);
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
        // PR-17 review correction D5: the intent must name a quote
        // DURABLY stored in THIS database, and the stored quote's
        // subscription / provider binding must match the intent.
        // Without this check a coordinator bound to the wrong
        // database could record a write-ahead attempt for a quote
        // that database has never held (an orphan attempt), while
        // the receipt landed in another database — each database
        // individually coherent, the atomic intent↔receipt
        // association void. The check runs inside the same
        // immediate transaction as every other beginDispatch
        // validation, so a refusal rolls back and leaves zero new
        // attempt rows.
        const quoteRow = this.db.prepare(`SELECT subscription_id, provider FROM quotes WHERE quote_id = ?`).get(intent.quoteId) as { subscription_id: string; provider: string } | undefined;
        if (!quoteRow) {
          throw new DispatchBlockedError(
            `Dispatch blocked: quote ${intent.quoteId} is not durably stored in this database; a write-ahead attempt cannot be authorized for a quote this store does not hold.`,
            { quoteId: intent.quoteId },
          );
        }
        if (quoteRow.subscription_id !== intent.subscriptionId || quoteRow.provider !== intent.provider) {
          throw new DispatchBlockedError(
            `Dispatch blocked: the intent for quote ${intent.quoteId} names subscription ${intent.subscriptionId} / provider ${intent.provider}, ` +
              `but the durably stored quote belongs to subscription ${quoteRow.subscription_id} / provider ${quoteRow.provider}; ` +
              `an attempt's binding must match the stored quote it authorizes.`,
            { quoteId: intent.quoteId, subscriptionId: quoteRow.subscription_id, provider: quoteRow.provider },
          );
        }
        const byKey = this.db.prepare(`SELECT * FROM attempts WHERE idempotency_key = ?`).get(intent.idempotencyKey) as Record<string, unknown> | undefined;
        if (byKey) {
          const existing = this.rowToAttempt(byKey);
          if (existing.requestHash !== hash) {
            throw new DispatchBlockedError(
              `Idempotency key ${intent.idempotencyKey} is already bound to a different request (hash ${existing.requestHash} != ${hash}); key reuse with different parameters is refused.`,
              { attemptId: existing.attemptId, existingRequestHash: existing.requestHash, requestHash: hash },
            );
          }
          // PR-17 review correction D2: the key is bound to ONE
          // quote / subscription / provider / site, not merely to a
          // request hash. The same key + identical request presented
          // under a different quote, subscription, provider, or site
          // is a collision, never a re-association — in ANY state of
          // the bound attempt.
          if (
            existing.quoteId !== intent.quoteId ||
            existing.subscriptionId !== intent.subscriptionId ||
            existing.provider !== intent.provider ||
            (existing.site ?? undefined) !== (intent.site ?? undefined)
          ) {
            throw new DispatchBlockedError(
              `Idempotency key ${intent.idempotencyKey} is already bound to a different quote/subscription/provider/site ` +
                `(attempt ${existing.attemptId}: quote ${existing.quoteId}, subscription ${existing.subscriptionId}, provider ${existing.provider}, site ${existing.site ?? "(none)"}); ` +
                `it cannot be re-associated with quote ${intent.quoteId}, subscription ${intent.subscriptionId}, provider ${intent.provider}, site ${intent.site ?? "(none)"}.`,
              { attemptId: existing.attemptId, quoteId: existing.quoteId, subscriptionId: existing.subscriptionId, provider: existing.provider, site: existing.site },
            );
          }
          if (existing.state === "DISPATCHING" || (existing.state === "INDETERMINATE" && !this.terminalResolutionFor(existing.attemptId))) {
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
            //
            // PR-17 review correction D2: BEFORE re-arming, the
            // same-quote / same-subscription exclusion is re-checked
            // under THIS SAME immediate transaction, excluding only
            // this terminal row itself. Previously this branch
            // returned before (and instead of) the exclusion query,
            // so a retry of a confirmed-non-executed attempt could
            // dispatch concurrently with another quote's unresolved
            // mutation of the same subscription.
            const blocking = this.findBlockingAttempt(intent.quoteId, intent.subscriptionId, existing.attemptId);
            if (blocking) {
              throw new DispatchBlockedError(
                `Dispatch blocked: re-dispatch of the confirmed-non-execution attempt ${existing.attemptId} must wait — attempt ${blocking.attemptId} for quote ${blocking.quoteId} / subscription ${blocking.subscriptionId} is ${blocking.state}` +
                  (blocking.state === "INDETERMINATE" ? " and unresolved — blind retry is prohibited until an operator resolves it after reconciliation." : " and has no terminal record."),
                { attemptId: blocking.attemptId, state: blocking.state, rearmedAttemptId: existing.attemptId },
              );
            }
            this.assertQuoteNotStaleAfterLanding(intent.quoteId);
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
        this.assertQuoteNotStaleAfterLanding(intent.quoteId);
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

  /**
   * Explicit operator action: resolve an INDETERMINATE attempt from
   * ESTABLISHED recovery evidence (P0, issue #43; PR #50 correction
   * round, R2; trust boundary hardened in round 3, R2'). Never
   * called by any recovery or report path.
   *
   * The round-1 signature accepted a raw caller-asserted evidence
   * object (enum strings, an arbitrary reference, a caller-supplied
   * digest); the round-2 signature accepted a token minted by a
   * PUBLIC establishment function over a caller-supplied record.
   * Both are now impossible — the input must carry a token minted
   * by THIS STORE'S configured provider-evidence verifier from a
   * record the verifier fetched from its source:
   *
   *  - a store with NO configured verifier refuses every terminal
   *    resolution (no capability — fail closed);
   *  - a non-object argument, or one whose `evidence` is not a
   *    branded established token, refuses outright — free text and
   *    caller-constructed evidence objects alike;
   *  - a token minted by a DIFFERENT verifier instance refuses
   *    (verifier mismatch): capability is instance-bound;
   *  - the token must be bound to THIS attempt and must match its
   *    minting-time content digest (a token altered after minting
   *    refuses);
   *  - the attempt must be INDETERMINATE and carry no terminal
   *    resolution yet (both checked INSIDE the immediate
   *    transaction — the concurrency rule);
   *  - the classification's exact reconciliation decision is
   *    required (PERMIT_NEW_DISPATCH for CONFIRMED_NON_EXECUTION,
   *    RECONCILE_LANDED_STATE_NO_REDISPATCH for CONFIRMED_LANDING);
   *  - the established observation must still be fresh at
   *    resolution time (24h window, as before);
   *  - one (source, reference) pair establishes exactly ONE
   *    attempt's terminal resolution (replay refuses);
   *  - the persisted record's binding is copied FROM THE TOKEN,
   *    which the establishment procedure bound to the attempt row —
   *    never from free caller fields.
   *
   * UNRESOLVED outcomes are NOT recorded here — see
   * `recordUnresolvedResolution`. Every refusal persists ZERO
   * resolution rows and leaves the attempt blocked. A successful
   * terminal resolution inserts the immutable record, flips
   * operator_review_state, and appends the history entry atomically
   * in the same transaction.
   */
  resolveAttempt(attemptId: string, input: ResolveAttemptInput): StoredAttempt {
    this.assertHealthy();
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new ResolutionEvidenceError(
        `Resolution refused for attempt ${attemptId}: an established-evidence resolution input is required — a free-text operator note is not evidence and raw caller-asserted evidence is no longer accepted; evidence must be established by this store's configured provider-evidence verifier from a record it fetched.`,
        { attemptId },
      );
    }
    const known = this.getAttempt(attemptId);
    if (!known) throw new DurableStoreError(`Cannot resolve unknown attempt ${attemptId}.`);
    if (this.faults?.beforePersist) {
      try { this.faults.beforePersist("resolveAttempt"); } catch (e) { this.failPoison("resolveAttempt", e); }
    }
    const resolvedAt = this.nowFn().toISOString();
    const resolvedMs = Date.parse(resolvedAt);
    try {
      const tx = this.db.transaction(() => {
        const attempt = this.getAttempt(attemptId)!;
        const refuse = (problem: string): never => {
          throw new ResolutionEvidenceError(`Resolution refused for attempt ${attemptId}: ${problem}`, { attemptId });
        };
        if (attempt.state !== "INDETERMINATE") {
          refuse(`the attempt is ${attempt.state}; only an INDETERMINATE attempt can be resolved`);
        }
        if (this.terminalResolutionFor(attemptId)) {
          refuse(`ALREADY_RESOLVED: the attempt already carries a terminal resolution record; resolution evidence is append-only and a terminal resolution cannot be replaced`);
        }
        // The trust boundary (R2, hardened R2'): only a branded
        // token, minted by THIS store's configured verifier, bound
        // to this attempt, unaltered since minting.
        const token = (input as { evidence?: unknown }).evidence as EstablishedResolutionEvidence | undefined;
        if (!token || typeof token !== "object" || !establishedResolutionTokens.has(token)) {
          refuse("the supplied evidence was not established — resolveAttempt accepts only a token minted by a provider-evidence verifier from a fetched provider record; caller-asserted evidence objects are refused");
        }
        const binding = establishedResolutionBindings.get(token!)!;
        if (!this.evidenceVerifier) {
          refuse("this store has no provider-evidence verifier configured — terminal resolution is disabled (fail closed): only a verifier the deployment configured on this store can establish lifting evidence");
        }
        if (binding.verifier !== this.evidenceVerifier) {
          refuse("the established evidence was minted by a different verifier instance than the one configured on this store — a token is capability only for the store whose verifier minted it (verifier mismatch)");
        }
        if (binding.attemptId !== attemptId) {
          refuse(`the established evidence is bound to attempt ${binding.attemptId}, not to this attempt — a token minted for one attempt cannot resolve another`);
        }
        if (sha256(canonicalStringify(token)) !== binding.contentDigest) {
          refuse("the established evidence token was altered after minting (its contents no longer match the minting-time content digest)");
        }
        if (
          token!.attemptId !== attempt.attemptId || token!.quoteId !== attempt.quoteId ||
          token!.subscriptionId !== attempt.subscriptionId || token!.provider !== attempt.provider ||
          token!.site !== attempt.site || token!.requestHash !== attempt.requestHash ||
          token!.idempotencyKey !== attempt.idempotencyKey
        ) {
          refuse("the established evidence is not bound to this attempt's identity fields");
        }
        const classification = token!.classification;
        const operatorId = typeof input.operatorId === "string" ? input.operatorId.trim() : "";
        if (!operatorId) refuse("a non-empty operatorId is required — an unattributed resolution is not auditable");
        const justification = typeof input.justification === "string" ? input.justification.trim() : "";
        if (!justification) refuse("a non-empty justification is required");
        const reconciliationDecision = typeof input.reconciliationDecision === "string" ? input.reconciliationDecision : "";
        if (classification === "CONFIRMED_NON_EXECUTION" && reconciliationDecision !== "PERMIT_NEW_DISPATCH") {
          refuse(`CONFIRMED_NON_EXECUTION requires reconciliationDecision "PERMIT_NEW_DISPATCH" (got ${JSON.stringify(input.reconciliationDecision ?? null)}) — a new authorization proceeds as a NEW quote; the original quote remains blocked`);
        }
        if (classification === "CONFIRMED_LANDING" && reconciliationDecision !== "RECONCILE_LANDED_STATE_NO_REDISPATCH") {
          refuse(`CONFIRMED_LANDING requires reconciliationDecision "RECONCILE_LANDED_STATE_NO_REDISPATCH" (got ${JSON.stringify(input.reconciliationDecision ?? null)})`);
        }
        const observedMs = Date.parse(token!.observedAt);
        if (resolvedMs - observedMs > RESOLUTION_EVIDENCE_MAX_AGE_MS) {
          refuse(`the established provider observation is stale at resolution time: observed ${Math.round((resolvedMs - observedMs) / 1000)}s before resolution, beyond the ${RESOLUTION_EVIDENCE_MAX_AGE_MS / 1000}s freshness window — re-establish from a fresh provider record`);
        }
        const replay = this.db.prepare(
          `SELECT resolution_id FROM attempt_resolutions WHERE evidence_source = ? AND evidence_reference = ? AND classification != 'UNRESOLVED' LIMIT 1`,
        ).get(token!.source, token!.reference) as { resolution_id: string } | undefined;
        if (replay) {
          refuse(`evidence (${token!.source}, ${token!.reference}) was already used by resolution ${replay.resolution_id}; one provider evidence record establishes one attempt's resolution — replay is refused`);
        }

        const payloadFields = {
          resolutionId: `res_${sha256(`${attemptId}|${resolvedAt}|${classification}|${token!.reference}`).slice(0, 24)}_${++this.resolutionSeq}`,
          attemptId: attempt.attemptId,
          quoteId: attempt.quoteId,
          subscriptionId: attempt.subscriptionId,
          provider: attempt.provider,
          site: attempt.site,
          requestHash: attempt.requestHash,
          idempotencyKey: attempt.idempotencyKey,
          classification,
          operatorId,
          resolvedAt,
          evidenceSource: token!.source,
          evidenceKind: token!.kind,
          evidenceReference: token!.reference,
          observedAt: token!.observedAt,
          observedProviderStateDigest: token!.observedProviderStateDigest,
          providerOperationId: token!.providerOperationId,
          reconciliationDecision,
          justification,
          logFinal: true,
          completeThrough: token!.completeThrough,
          registryCoverage: token!.registryCoverage,
          landedStateVersion: token!.landedStateVersion,
          establishmentProcedure: "createProviderEvidenceVerifier",
          trustTier: "VERIFIED" as ResolutionTrustTier,
        };
        const evidenceHash = sha256(canonicalStringify(payloadFields));
        const record: StoredResolution = { ...payloadFields, evidenceHash };
        this.db.prepare(
          `INSERT INTO attempt_resolutions (resolution_id, attempt_id, quote_id, subscription_id, provider, site, request_hash, idempotency_key, classification, operator_id, resolved_at, evidence_source, evidence_kind, evidence_reference, observed_at, observed_provider_state_digest, provider_operation_id, reconciliation_decision, justification, evidence_payload_json, evidence_hash, log_final, complete_through, registry_coverage, landed_state_version, trust_tier)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        ).run(
          record.resolutionId, record.attemptId, record.quoteId, record.subscriptionId, record.provider, record.site,
          record.requestHash, record.idempotencyKey, record.classification, record.operatorId, record.resolvedAt,
          record.evidenceSource, record.evidenceKind, record.evidenceReference, record.observedAt,
          record.observedProviderStateDigest, record.providerOperationId, record.reconciliationDecision,
          record.justification, encodeRecordJson(payloadFields), record.evidenceHash,
          1, record.completeThrough, record.registryCoverage, record.landedStateVersion, record.trustTier,
        );
        this.faults?.insidePersistTx?.("resolveAttempt");
        this.db.prepare(`UPDATE attempts SET operator_review_state='RESOLVED', version=version+1, updated_at=? WHERE attempt_id=?`).run(resolvedAt, attemptId);
        this.db.prepare(`INSERT INTO attempt_history (attempt_id, state, at, note) VALUES (?,?,?,?)`).run(
          attemptId, attempt.state, resolvedAt,
          `operator resolution recorded (${classification}; VERIFIED evidence ${record.evidenceSource} ${record.evidenceReference} established via the store's configured provider-evidence verifier; checksum ${evidenceHash.slice(0, 12)}…): ${justification}`,
        );
      });
      tx.immediate();
    } catch (e) {
      if (e instanceof ResolutionEvidenceError || e instanceof DispatchBlockedError) throw e;
      this.failPoison("resolveAttempt", e);
    }
    return this.getAttempt(attemptId)!;
  }

  /**
   * Record an UNRESOLVED recovery outcome for an INDETERMINATE
   * attempt (PR #50 correction round): the audit-trail half of the
   * round-1 `resolveAttempt` UNRESOLVED path, split out because an
   * unresolved outcome carries NO evidence and must not travel the
   * established-evidence path. The record is append-only audit: it
   * lifts nothing, flips no flag, and the attempt keeps blocking
   * every key. Refuses for non-INDETERMINATE attempts, attempts
   * already terminally resolved, and unattributed records.
   */
  recordUnresolvedResolution(attemptId: string, input: { operatorId: string; justification: string }): StoredAttempt {
    this.assertHealthy();
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new ResolutionEvidenceError(
        `UNRESOLVED record refused for attempt ${attemptId}: an operator record { operatorId, justification } is required.`,
        { attemptId },
      );
    }
    const known = this.getAttempt(attemptId);
    if (!known) throw new DurableStoreError(`Cannot record an UNRESOLVED outcome for unknown attempt ${attemptId}.`);
    if (this.faults?.beforePersist) {
      try { this.faults.beforePersist("recordUnresolvedResolution"); } catch (e) { this.failPoison("recordUnresolvedResolution", e); }
    }
    const resolvedAt = this.nowFn().toISOString();
    try {
      const tx = this.db.transaction(() => {
        const attempt = this.getAttempt(attemptId)!;
        const refuse = (problem: string): never => {
          throw new ResolutionEvidenceError(`UNRESOLVED record refused for attempt ${attemptId}: ${problem}`, { attemptId });
        };
        if (attempt.state !== "INDETERMINATE") {
          refuse(`the attempt is ${attempt.state}; only an INDETERMINATE attempt can carry a recovery outcome record`);
        }
        if (this.anyTerminalResolutionFor(attemptId)) {
          refuse(`ALREADY_RESOLVED: the attempt already carries a terminal resolution record (verified or asserted); an UNRESOLVED record cannot follow it`);
        }
        const operatorId = typeof input.operatorId === "string" ? input.operatorId.trim() : "";
        if (!operatorId) refuse("a non-empty operatorId is required — an unattributed record is not auditable");
        const justification = typeof input.justification === "string" ? input.justification.trim() : "";
        if (!justification) refuse("a non-empty justification is required");
        const payloadFields = {
          resolutionId: `res_${sha256(`${attemptId}|${resolvedAt}|UNRESOLVED|`).slice(0, 24)}_${++this.resolutionSeq}`,
          attemptId: attempt.attemptId,
          quoteId: attempt.quoteId,
          subscriptionId: attempt.subscriptionId,
          provider: attempt.provider,
          site: attempt.site,
          requestHash: attempt.requestHash,
          idempotencyKey: attempt.idempotencyKey,
          classification: "UNRESOLVED" as ResolutionClassification,
          operatorId,
          resolvedAt,
          evidenceSource: "",
          evidenceKind: "",
          evidenceReference: "",
          observedAt: resolvedAt,
          observedProviderStateDigest: "",
          providerOperationId: null as string | null,
          reconciliationDecision: "",
          justification,
          logFinal: false,
          completeThrough: "",
          registryCoverage: null as string | null,
          landedStateVersion: null as string | null,
          establishmentProcedure: "",
          trustTier: "ASSERTED" as ResolutionTrustTier,
        };
        const evidenceHash = sha256(canonicalStringify(payloadFields));
        this.db.prepare(
          `INSERT INTO attempt_resolutions (resolution_id, attempt_id, quote_id, subscription_id, provider, site, request_hash, idempotency_key, classification, operator_id, resolved_at, evidence_source, evidence_kind, evidence_reference, observed_at, observed_provider_state_digest, provider_operation_id, reconciliation_decision, justification, evidence_payload_json, evidence_hash, log_final, complete_through, registry_coverage, landed_state_version, trust_tier)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        ).run(
          payloadFields.resolutionId, payloadFields.attemptId, payloadFields.quoteId, payloadFields.subscriptionId, payloadFields.provider, payloadFields.site,
          payloadFields.requestHash, payloadFields.idempotencyKey, payloadFields.classification, payloadFields.operatorId, payloadFields.resolvedAt,
          payloadFields.evidenceSource, payloadFields.evidenceKind, payloadFields.evidenceReference, payloadFields.observedAt,
          payloadFields.observedProviderStateDigest, payloadFields.providerOperationId, payloadFields.reconciliationDecision,
          payloadFields.justification, encodeRecordJson(payloadFields), evidenceHash,
          0, payloadFields.completeThrough, payloadFields.registryCoverage, payloadFields.landedStateVersion, payloadFields.trustTier,
        );
        this.faults?.insidePersistTx?.("recordUnresolvedResolution");
        this.db.prepare(`INSERT INTO attempt_history (attempt_id, state, at, note) VALUES (?,?,?,?)`).run(
          attemptId, attempt.state, resolvedAt,
          `operator recorded the recovery outcome as UNRESOLVED (no established evidence; the attempt remains blocked): ${justification}`,
        );
      });
      tx.immediate();
    } catch (e) {
      if (e instanceof ResolutionEvidenceError || e instanceof DispatchBlockedError) throw e;
      this.failPoison("recordUnresolvedResolution", e);
    }
    return this.getAttempt(attemptId)!;
  }

  /**
   * Record an operator's terminal CLAIM about an INDETERMINATE
   * attempt WITHOUT verified provider evidence (round 3, R2' —
   * the fail-closed asserted path). The claim is appended to
   * attempt_resolutions at the ASSERTED trust tier with no evidence
   * fields at all: it is an audit record of what the operator
   * asserted, and it is explicitly NOT provider evidence — an
   * explicitly recorded human claim must not be presented as
   * independently verified evidence, and this method does not
   * pretend otherwise. It NEVER lifts: `terminalResolutionFor`
   * returns only VERIFIED records, the operator_review_state flag
   * is NOT flipped, the attempt keeps blocking every key, and the
   * recovery report surfaces the claim as ASSERTED_UNVERIFIED with
   * intervention still required. A later VERIFIED resolution
   * through the store's configured verifier remains possible and
   * supersedes the claim. UNRESOLVED outcomes are not claims of a
   * terminal outcome — they stay on `recordUnresolvedResolution`.
   * Refuses for non-INDETERMINATE attempts, for attempts already
   * VERIFIED-resolved, and for unattributed claims.
   */
  recordAssertedResolution(
    attemptId: string,
    input: { classification: ResolutionClassification; operatorId: string; justification: string },
  ): StoredAttempt {
    this.assertHealthy();
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new ResolutionEvidenceError(
        `Asserted claim refused for attempt ${attemptId}: a claim record { classification, operatorId, justification } is required.`,
        { attemptId },
      );
    }
    const known = this.getAttempt(attemptId);
    if (!known) throw new DurableStoreError(`Cannot record an asserted claim for unknown attempt ${attemptId}.`);
    if (this.faults?.beforePersist) {
      try { this.faults.beforePersist("recordAssertedResolution"); } catch (e) { this.failPoison("recordAssertedResolution", e); }
    }
    const resolvedAt = this.nowFn().toISOString();
    try {
      const tx = this.db.transaction(() => {
        const attempt = this.getAttempt(attemptId)!;
        const refuse = (problem: string): never => {
          throw new ResolutionEvidenceError(`Asserted claim refused for attempt ${attemptId}: ${problem}`, { attemptId });
        };
        if (attempt.state !== "INDETERMINATE") {
          refuse(`the attempt is ${attempt.state}; only an INDETERMINATE attempt can carry an asserted claim`);
        }
        if (input.classification !== "CONFIRMED_NON_EXECUTION" && input.classification !== "CONFIRMED_LANDING") {
          refuse(`classification ${String(input.classification)} is not a terminal claim — UNRESOLVED outcomes are recorded via recordUnresolvedResolution, not as asserted claims`);
        }
        if (this.terminalResolutionFor(attemptId)) {
          refuse(`ALREADY_RESOLVED: the attempt already carries a VERIFIED terminal resolution; an asserted claim cannot follow it`);
        }
        const operatorId = typeof input.operatorId === "string" ? input.operatorId.trim() : "";
        if (!operatorId) refuse("a non-empty operatorId is required — an unattributed claim is not auditable");
        const justification = typeof input.justification === "string" ? input.justification.trim() : "";
        if (!justification) refuse("a non-empty justification is required");
        const classification = input.classification;
        const payloadFields = {
          resolutionId: `res_${sha256(`${attemptId}|${resolvedAt}|${classification}|asserted`).slice(0, 24)}_${++this.resolutionSeq}`,
          attemptId: attempt.attemptId,
          quoteId: attempt.quoteId,
          subscriptionId: attempt.subscriptionId,
          provider: attempt.provider,
          site: attempt.site,
          requestHash: attempt.requestHash,
          idempotencyKey: attempt.idempotencyKey,
          classification,
          operatorId,
          resolvedAt,
          evidenceSource: "",
          evidenceKind: "",
          evidenceReference: "",
          observedAt: resolvedAt,
          observedProviderStateDigest: "",
          providerOperationId: null as string | null,
          reconciliationDecision: "",
          justification,
          logFinal: false,
          completeThrough: "",
          registryCoverage: null as string | null,
          landedStateVersion: null as string | null,
          establishmentProcedure: "",
          trustTier: "ASSERTED" as ResolutionTrustTier,
        };
        const evidenceHash = sha256(canonicalStringify(payloadFields));
        this.db.prepare(
          `INSERT INTO attempt_resolutions (resolution_id, attempt_id, quote_id, subscription_id, provider, site, request_hash, idempotency_key, classification, operator_id, resolved_at, evidence_source, evidence_kind, evidence_reference, observed_at, observed_provider_state_digest, provider_operation_id, reconciliation_decision, justification, evidence_payload_json, evidence_hash, log_final, complete_through, registry_coverage, landed_state_version, trust_tier)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        ).run(
          payloadFields.resolutionId, payloadFields.attemptId, payloadFields.quoteId, payloadFields.subscriptionId, payloadFields.provider, payloadFields.site,
          payloadFields.requestHash, payloadFields.idempotencyKey, payloadFields.classification, payloadFields.operatorId, payloadFields.resolvedAt,
          payloadFields.evidenceSource, payloadFields.evidenceKind, payloadFields.evidenceReference, payloadFields.observedAt,
          payloadFields.observedProviderStateDigest, payloadFields.providerOperationId, payloadFields.reconciliationDecision,
          payloadFields.justification, encodeRecordJson(payloadFields), evidenceHash,
          0, payloadFields.completeThrough, payloadFields.registryCoverage, payloadFields.landedStateVersion, payloadFields.trustTier,
        );
        this.faults?.insidePersistTx?.("recordAssertedResolution");
        this.db.prepare(`INSERT INTO attempt_history (attempt_id, state, at, note) VALUES (?,?,?,?)`).run(
          attemptId, attempt.state, resolvedAt,
          `operator recorded an ASSERTED (unverified) claim of ${classification} — no provider evidence was established; the claim lifts nothing and the attempt remains blocked: ${justification}`,
        );
      });
      tx.immediate();
    } catch (e) {
      if (e instanceof ResolutionEvidenceError || e instanceof DispatchBlockedError) throw e;
      this.failPoison("recordAssertedResolution", e);
    }
    return this.getAttempt(attemptId)!;
  }

  /**
   * The R4 reconciliation barrier, hardened in correction round 3
   * (R4'): record that a CONFIRMED_LANDING attempt's landed state
   * and financial consequences have been reconciled — from
   * VERIFIED, operation-bound financial reconciliation evidence,
   * not from caller assertions. A landing resolution alone NEVER
   * unblocks the subscription — until this record exists, the
   * landed attempt blocks every quote on it
   * (`findBlockingAttempt`); once it exists, other quotes unblock
   * subject to the stale-quote rule in `beginDispatch`, and the
   * landed attempt's own quote remains blocked regardless (R1).
   *
   * Round-2 shape (caller-supplied `landedStateDigest` /
   * `financialOutcomeDigest`) is REMOVED: a correct-format hash is
   * not reconciliation, and sha256("not actually reconciled")
   * satisfied the old barrier. Now the store invokes ITS OWN
   * configured verifier's `establishReconciliation`, which FETCHES
   * the financial reconciliation record from the deployment's
   * record source (bound to the attempt and to the resolution's
   * evidence reference) and computes both digests from it — the
   * landed-state digest must equal the resolution's established
   * observed-state digest. No caller-supplied digest or record
   * input exists anywhere in the path; an input carrying the old
   * digest fields refuses explicitly. A store with no verifier, or
   * whose source lacks the reconciliation capability, refuses —
   * fail closed until an independent reconciliation source exists.
   * One reconciliation per attempt; a second refuses. Append-only
   * and checksum-verified on open, like the resolution rows.
   */
  reconcileLandedAttempt(
    attemptId: string,
    input: { operatorId: string; justification: string },
  ): StoredLandingReconciliation {
    this.assertHealthy();
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new ResolutionEvidenceError(
        `Landing reconciliation refused for attempt ${attemptId}: a reconciliation request { operatorId, justification } is required — digests and records are established through the store's verifier, never supplied by the caller.`,
        { attemptId },
      );
    }
    if (
      Object.prototype.hasOwnProperty.call(input, "landedStateDigest") ||
      Object.prototype.hasOwnProperty.call(input, "financialOutcomeDigest")
    ) {
      throw new ResolutionEvidenceError(
        `Landing reconciliation refused for attempt ${attemptId}: caller-supplied digests are not accepted (round 3, R4') — the barrier rests on financial reconciliation evidence fetched and digested by the store's configured verifier, not on hashes a caller presents.`,
        { attemptId },
      );
    }
    const known = this.getAttempt(attemptId);
    if (!known) throw new DurableStoreError(`Cannot reconcile unknown attempt ${attemptId}.`);
    if (this.faults?.beforePersist) {
      try { this.faults.beforePersist("reconcileLandedAttempt"); } catch (e) { this.failPoison("reconcileLandedAttempt", e); }
    }
    // Capability + establishment run BEFORE the transaction: the
    // store invokes ITS OWN verifier, which fetches the financial
    // reconciliation record from its source and mints the branded
    // token. Establishment refusals are evidence refusals, not
    // persistence failures — they propagate without poisoning.
    if (!this.evidenceVerifier) {
      throw new ResolutionEvidenceError(
        `Landing reconciliation refused for attempt ${attemptId}: this store has no provider-evidence verifier configured — the RECONCILIATION capability is absent (fail closed): the barrier can only rest on reconciliation evidence established through a configured verifier.`,
        { attemptId },
      );
    }
    const preAttempt = this.getAttempt(attemptId)!;
    const preResolution = this.terminalResolutionFor(attemptId);
    if (preAttempt.state !== "INDETERMINATE" || !preResolution || preResolution.classification !== "CONFIRMED_LANDING") {
      throw new ResolutionEvidenceError(
        `Landing reconciliation refused for attempt ${attemptId}: the attempt carries no VERIFIED terminal CONFIRMED_LANDING resolution — there is no established landing to reconcile.`,
        { attemptId },
      );
    }
    const token = this.evidenceVerifier.establishReconciliation(preAttempt, preResolution);
    const reconciledAt = token.reconciledAt;
    let record: StoredLandingReconciliation | undefined;
    try {
      const tx = this.db.transaction(() => {
        const attempt = this.getAttempt(attemptId)!;
        const refuse = (problem: string): never => {
          throw new ResolutionEvidenceError(`Landing reconciliation refused for attempt ${attemptId}: ${problem}`, { attemptId });
        };
        if (attempt.state !== "INDETERMINATE") {
          refuse(`the attempt is ${attempt.state}; only a landed INDETERMINATE attempt can be reconciled`);
        }
        const resolution = this.terminalResolutionFor(attemptId);
        if (!resolution || resolution.classification !== "CONFIRMED_LANDING") {
          refuse("the attempt carries no VERIFIED terminal CONFIRMED_LANDING resolution — there is no established landing to reconcile");
        }
        if (this.landingReconciliationRecordFor(attemptId)) {
          refuse("ALREADY_RECONCILED: a landing reconciliation is already recorded for this attempt; the barrier record is append-only and singular");
        }
        const operatorId = typeof input.operatorId === "string" ? input.operatorId.trim() : "";
        if (!operatorId) refuse("a non-empty operatorId is required — an unattributed reconciliation is not auditable");
        const justification = typeof input.justification === "string" ? input.justification.trim() : "";
        if (!justification) refuse("a non-empty justification is required");
        // The token must be the one THIS store's verifier minted
        // for THIS attempt and THIS resolution, unaltered since
        // minting (defense in depth: this store just minted it via
        // its own verifier above; the checks keep the acceptance
        // rule identical in form to resolveAttempt's).
        if (!establishedReconciliationTokens.has(token)) {
          refuse("the reconciliation evidence was not established by a provider-evidence verifier");
        }
        const binding = establishedReconciliationBindings.get(token)!;
        if (binding.verifier !== this.evidenceVerifier) {
          refuse("the reconciliation evidence was minted by a different verifier instance than the one configured on this store (verifier mismatch)");
        }
        if (binding.attemptId !== attemptId || sha256(canonicalStringify(token)) !== binding.contentDigest) {
          refuse("the reconciliation evidence token is not bound to this attempt or was altered after minting");
        }
        if (token.resolutionReference !== resolution!.evidenceReference || token.landedStateDigest !== resolution!.observedProviderStateDigest) {
          refuse("the reconciliation evidence is not bound to this attempt's established landing resolution");
        }
        const payloadFields = {
          reconciliationId: `rec_${sha256(`${attemptId}|${reconciledAt}|landing`).slice(0, 24)}`,
          attemptId: attempt.attemptId,
          quoteId: attempt.quoteId,
          subscriptionId: attempt.subscriptionId,
          landedStateVersion: resolution!.landedStateVersion!,
          landedStateDigest: token.landedStateDigest,
          financialOutcomeDigest: token.financialOutcomeDigest,
          operatorId,
          reconciledAt,
          justification,
          trustTier: "VERIFIED" as ResolutionTrustTier,
          evidenceReference: token.evidenceReference as string | null,
        };
        const recordHash = sha256(canonicalStringify(payloadFields));
        record = { ...payloadFields, recordHash };
        this.db.prepare(
          `INSERT INTO landing_reconciliations (reconciliation_id, attempt_id, quote_id, subscription_id, landed_state_version, landed_state_digest, financial_outcome_digest, operator_id, reconciled_at, justification, payload_json, record_hash, trust_tier, evidence_reference)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        ).run(
          record.reconciliationId, record.attemptId, record.quoteId, record.subscriptionId, record.landedStateVersion,
          record.landedStateDigest, record.financialOutcomeDigest, record.operatorId, record.reconciledAt,
          record.justification, encodeRecordJson(payloadFields), record.recordHash, record.trustTier, record.evidenceReference,
        );
        this.faults?.insidePersistTx?.("reconcileLandedAttempt");
        this.db.prepare(`INSERT INTO attempt_history (attempt_id, state, at, note) VALUES (?,?,?,?)`).run(
          attemptId, attempt.state, reconciledAt,
          `landing reconciliation recorded (VERIFIED; landed state version ${record.landedStateVersion}; landed-state checksum ${record.landedStateDigest.slice(0, 12)}…; financial-outcome checksum ${record.financialOutcomeDigest.slice(0, 12)}…; reconciliation evidence ${token.evidenceSource} ${token.evidenceReference}): ${justification}`,
        );
      });
      tx.immediate();
    } catch (e) {
      if (e instanceof ResolutionEvidenceError || e instanceof DispatchBlockedError) throw e;
      this.failPoison("reconcileLandedAttempt", e);
    }
    return record!;
  }

  /** persistQuote variant for use inside a caller-managed transaction (no nested transaction, no version double-count). */
  private persistQuoteInTx(quoteId: string, op: string): void {
    // PR-17 review correction D1: same complete fail-closed
    // coverage as persistQuote — a hook or encoding failure here
    // propagates (rolling the caller's transaction back) AND
    // poisons the store, so the already-mutated in-memory state is
    // never served as durable by a later read.
    try {
      this.persistQuoteInTxInner(quoteId, op);
    } catch (e) {
      this.failPoison(op, e);
    }
  }

  private persistQuoteInTxInner(quoteId: string, op: string): void {
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
    this.assertHealthy(); // D1: a poisoned store's report would describe volatile state as if durable
    const item = (a: StoredAttempt): Record<string, unknown> => {
      const quote = QuoteStore.prototype.get.call(this, a.quoteId) as StoredQuote | undefined;
      const recorded = quote?.commit_receipt_recorded;
      const committedClass = a.state === "COMMITTED_AND_VERIFIED" || a.state === "COMMITTED_UNVERIFIED";
      // PR #50 correction round (docs item b): for an INDETERMINATE
      // attempt, intervention and the next permitted action are
      // DERIVED FROM THE ACTUAL TERMINAL RECORD, not from the state
      // alone — a terminally resolved attempt is not reported as
      // "intervention required / reconcile manually", while the
      // historical INDETERMINATE outcome itself is preserved
      // verbatim (the state field above is never rewritten).
      const resolutionRecords = a.state === "INDETERMINATE" ? this.resolutionsForAttempt(a.attemptId) : [];
      const terminalResolution = a.state === "INDETERMINATE" ? this.terminalResolutionFor(a.attemptId) : undefined;
      // Round 3: an ASSERTED terminal claim (operator-asserted, no
      // verified evidence) is surfaced as a claim — classification
      // shown, tier marked unverified, intervention still required.
      // It is never reported with the VERIFIED derivations.
      const assertedTerminal =
        a.state === "INDETERMINATE" && !terminalResolution
          ? [...resolutionRecords].reverse().find((r) => r.classification !== "UNRESOLVED" && r.trustTier === "ASSERTED")
          : undefined;
      const landingReconciled = terminalResolution?.classification === "CONFIRMED_LANDING"
        ? this.landingReconciliationFor(a.attemptId) !== undefined
        : false;
      const derivedInterventionRequired =
        a.state === "DISPATCHING" ||
        (a.state === "INDETERMINATE" &&
          (!terminalResolution || (terminalResolution.classification === "CONFIRMED_LANDING" && !landingReconciled)));
      const derivedNextPermittedAction =
        a.state === "INDETERMINATE"
          ? terminalResolution?.classification === "CONFIRMED_NON_EXECUTION"
            ? "Resolved as CONFIRMED_NON_EXECUTION from established provider evidence; the original quote remains blocked — any re-authorization proceeds as a NEW quote. No automatic re-dispatch is permitted."
            : terminalResolution?.classification === "CONFIRMED_LANDING"
              ? landingReconciled
                ? "Resolved as CONFIRMED_LANDING and reconciled: the subscription is unblocked for fresh quotes validated against the landed state only; the original quote remains blocked. No automatic re-dispatch is permitted."
                : "Resolved as CONFIRMED_LANDING from established provider evidence, but the landing is not yet reconciled: record the landed-state reconciliation (reconcileLandedAttempt) before any subscription-wide unblock — until then this attempt blocks the whole subscription. No automatic re-dispatch is permitted."
              : assertedTerminal
                ? `An operator claim of ${assertedTerminal.classification} is recorded but UNVERIFIED (asserted only — no provider evidence was established through this store's configured verifier): this attempt remains blocked until verified evidence resolves it. No automatic re-dispatch is permitted.`
                : "Reconcile manually from provider records; only after reconciliation establishes the outcome from structured, operation-bound provider evidence may an operator explicitly resolve this attempt (resolveAttempt) — a free-text note or a matching provider-state snapshot is not sufficient evidence. No automatic re-dispatch is permitted."
          : a.state === "DISPATCHING"
            ? "Treat as potentially dispatched: reconcile from provider records before any further action. No re-dispatch."
            : "None.";
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
          // PR-17 review correction D3: derived from the recorded
          // evidence, not the outcome class alone. Execution is
          // established only when a recorded receipt exists (a
          // receipt is recorded solely from the response-received
          // side — PR #16 L1); the financial result only by a
          // verified recorded outcome; attribution from the
          // receipt's own provenance/determinacy via
          // attributionFromReceipt. For a non-committed attempt
          // there is no attributable state at all, so attribution
          // is false rather than unknown.
          mutationExecutionEstablished: committedClass && recorded !== undefined,
          financialResultEstablished: a.state === "COMMITTED_AND_VERIFIED" && recorded?.outcome === "COMMITTED_AND_VERIFIED",
          stateAttributableToThisMutation: committedClass ? attributionFromReceipt(quote?.commit_receipt ?? recorded) : false,
        },
        operatorInterventionRequired: derivedInterventionRequired,
        ...(a.state === "INDETERMINATE"
          ? {
              resolution: {
                classification: terminalResolution?.classification ?? assertedTerminal?.classification ?? "UNRESOLVED",
                trustTier: terminalResolution ? "VERIFIED" : assertedTerminal ? "ASSERTED_UNVERIFIED" : null,
                evidenceHash: terminalResolution?.evidenceHash ?? assertedTerminal?.evidenceHash ?? resolutionRecords[resolutionRecords.length - 1]?.evidenceHash ?? null,
              },
            }
          : {}),
        nextPermittedAction: derivedNextPermittedAction,
      };
    };
    const attempts = this.allAttempts();
    const unverified = this.receiptsWithReconciliation("UNVERIFIED").map((r) => ({
      quoteId: r.quoteId,
      receiptId: r.receiptId ?? null,
      outcome: r.outcome ?? "COMMITTED_UNVERIFIED",
      established: {
        // Execution is established by the record's existence: a
        // receipt is recorded only from the response-received side
        // (PR #16 L1). The financial result is NOT established —
        // that is what this receipt's UNVERIFIED reconciliation
        // records. Attribution is derived per-receipt (D3): a
        // broken-bracket record reports false, bound provider
        // actuals report true, and unprovenanced candidates report
        // "unknown" — none of them default from the outcome class.
        mutationExecutionEstablished: true,
        financialResultEstablished: false,
        stateAttributableToThisMutation: attributionFromReceipt(r),
      },
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

/**
 * PR-17 review correction D3: whether the state a receipt OBSERVED
 * is attributable to THIS mutation, derived from the receipt's own
 * recorded evidence — never defaulted from its outcome class.
 * COMMITTED_UNVERIFIED covers materially different records:
 * figures bound to this operation (attributable), the PR #16 Z3
 * broken-bracket record (an intervening write broke the
 * response→re-read fingerprint bracket; the observed recurring
 * state is explicitly NOT this commit's), and candidate figures
 * with no independent observation (genuinely unknown). The return
 * type is honest about that third case: `boolean | "unknown"`.
 */
export function attributionFromReceipt(receipt: SubscriptionChangeReceipt | undefined): boolean | "unknown" {
  if (!receipt) return "unknown";
  // A completed verification transition is an established-evidence
  // judgment over exactly this question.
  if (receipt.outcome === "COMMITTED_AND_VERIFIED" && receipt.reconciliation?.status === "OK") return true;
  const effect = receipt.committedEffect;
  const source = effect?.provenance?.committedSource;
  if (source === "provider_actual" || source === "defined_equal_exact") {
    // The committed figures ARE this operation's bound actuals.
    return true;
  }
  if (source === "revalidated_preview" || source === "pre_mutation_estimate") {
    // Quote-side provenance never establishes attribution.
    return false;
  }
  if (source === "unestablished") {
    const recurringFigureRecorded = effect?.recurring?.resultingAmount !== undefined;
    if (recurringFigureRecorded && effect?.determinacy?.recurringFinancialEffect === "DETERMINED") {
      // PR #16 (test 26.10a) shape: the whole-effect source label
      // is "unestablished" because ONE dimension is, but the
      // recurring figure was established from a bracket-closed
      // independent re-read — the observed recurring state IS
      // attributable to this commit; only the other dimension is
      // unestablished.
      return true;
    }
    if (!recurringFigureRecorded) {
      // PR #16 Z3 broken-bracket shape (tests 26.14a/b): no
      // recurring figure is recorded as this commit's precisely
      // because attribution failed — the observed state is an
      // intervening actor's, retained as unattributed context.
      return false;
    }
    // Candidate figures present under UNKNOWN determinacy, with no
    // independent state observation (PR #16, test 26.17 shape):
    // attribution is not established in either direction.
    return "unknown";
  }
  // No provenance recorded: unknown, explicitly — never defaulted.
  return "unknown";
}

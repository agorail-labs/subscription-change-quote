/**
 * Read-only exact-commit preflight (PR-11).
 *
 * Given an identified quote and its AUTHORITATIVE durable record,
 * this module produces the evidence package a human would need
 * before a future, separately authorized Chargebee TEST-site commit
 * (COMMIT-RECOVERY-SAFETY conditions 3–5). It is deliberately
 * incapable of committing anything:
 *
 * - Its transport is the pilot's existing guarded read-only
 *   allowlist (GET subscription, GET item_price, POST
 *   estimate-update). Every other operation — update_for_items
 *   included — is rejected BEFORE dispatch, and the report's
 *   zero-mutation statement is computed from the OBSERVED transport
 *   log, never asserted as a constant.
 * - The hypothetical mutation it displays is derived with
 *   `buildChargebeeUpdateParams` — the SAME builder the adapter's
 *   commit path uses (extracted and shared in PR-11 with zero
 *   behavior change) — and hashed with the durable ledger's own
 *   canonical `requestHashOf`. Divergence from the stored
 *   `provider_preview_input`, the stored idempotency key, or any
 *   recorded attempt's request hash is a blocker.
 * - Running the preflight persists NO mutation intent: it performs
 *   only read-only store lookups.
 * - Reports are sanitized: provider payloads are reduced to the
 *   fields the report names; API keys and credential-shaped strings
 *   are scrubbed from every string in the output; no raw responses,
 *   headers, or PII are emitted.
 * - Injected or mocked transports NEVER yield LIVE_PASS, and the
 *   readiness model can return at most READY_FOR_HUMAN_REVIEW —
 *   never GO. Software cannot grant the reconciliation-owner
 *   condition (4) or the commit-authorization condition (5); it can
 *   only record operator-supplied inputs as such. Condition 1
 *   (v0.6.2 release approval) is likewise never inferred from merged
 *   pull requests.
 *
 * PR #20 review corrections (PF1–PF3):
 * - PF1: transport provenance is STRUCTURAL, never caller-asserted.
 *   There is no origin input. A caller-supplied transport is always
 *   "injected" (simulated evidence); the only LIVE-eligible
 *   transport is the one this module constructs itself around the
 *   real network transport (`createRealPreflightTransport`).
 *   Condition 3 additionally requires actual operator attestation of
 *   test-tenant ownership/mode and verified provider identity.
 * - PF4 (re-review): the PF1 construction originally returned the
 *   genuine transport and its log as WRITABLE properties of the
 *   branded handle, and runPreflight trusted those properties — a
 *   caller could overwrite both with a mocked transport and its log
 *   and obtain LIVE_PASS + a Condition 3 PASS from simulated
 *   responses (a private-symbol brand cannot prevent this: the
 *   symbol is readable off any genuine handle). The handle is now
 *   OPAQUE and the authoritative transport + observed log live in a
 *   module-private registry keyed by the handle; runPreflight
 *   resolves real-mode only through that registry and never reads
 *   handle properties, so a mutated, cloned, or property-copied
 *   handle is simply absent from the registry and is refused.
 * - PF5 (re-review): Condition 3's gate counted only blockers, so
 *   safety-critical UNKNOWN checks (scheduled changes, scheduled
 *   advance invoices, request coherence) could not stop a PASS —
 *   uncertainty was silently treated as clearance. The gate now
 *   evaluates the safety-critical unknowns explicitly: while any is
 *   unresolved, Condition 3 stays UNVERIFIED (or BLOCKED when
 *   blockers also stand) and the reason names each unresolved fact.
 * - PF2: the exact-request check validates the FULL resulting
 *   (itemPriceId, quantity) multiset: the authorized proposal
 *   applied to the INDEPENDENTLY re-read current item set, compared
 *   tuple-for-tuple against the stored dispatch target. Checking
 *   only the changed item let an unauthorized change to any other
 *   item pass undetected.
 * - PF3: site/subscription binding rests on the quote-origin
 *   manifest (see quote-origin.ts) — a record captured at issuance,
 *   keyed by quote id + the ledger-canonical digest of the stored
 *   quote. Caller-supplied site/subscription expectations survive
 *   only as consistency inputs; they are not origin evidence, and
 *   absence of origin evidence BLOCKS.
 */

import { ChargebeeClient, fetchTransport, formEncode, type HttpTransport } from "../chargebee-http.js";
import {
  buildChargebeeUpdateParams,
  chargebeeEffectWithDeterminacy,
  chargebeeSubscriptionFingerprint,
  interpretChargebeeEstimate,
  type CbSubscription,
} from "../chargebee-scq-adapter.js";
import { ChargebeeOperationNotAllowedError, createGuardedLiveTransport, isApprovedTestSite, isSyntheticSubscriptionId, observedSuccessfulOps, summarizeTransportLog, type TransportLogEntry, type TransportSummary } from "./live-guard.js";
import { QuoteOriginManifest, quoteOriginDigest } from "./quote-origin.js";
import { classifyRunCapability } from "./run-pilot.js";
import { checkAcceptanceEnvelope } from "../../core/scq-engine.js";
import { DurableQuoteStore, requestHashOf, type StoredAttempt } from "../../store/durable-store.js";
import { SCQError, type SubscriptionChangeProposal } from "../../core/types.js";
import type { StoredQuote } from "../../store/quote-store.js";

/** The Chargebee adapter's stored preview-input shape (its commit replays this verbatim). */
type StoredPreviewInput = { items: Array<{ itemPriceId: string; quantity: number }>; idempotencyKey: string };

// ---------------------------------------------------------------------------
// Guarded preflight transport
// ---------------------------------------------------------------------------

/**
 * Wraps a transport in the pilot's existing read-only guard and
 * exposes the observed log. The guard rejects every non-allowlisted
 * operation (including update_for_items) before dispatch.
 */
export function createPreflightTransport(inner: HttpTransport): { transport: HttpTransport; log: TransportLogEntry[] } {
  return createGuardedLiveTransport(inner);
}

// ---------------------------------------------------------------------------
// Structural transport provenance (PF1)
// ---------------------------------------------------------------------------

/**
 * PF4: the authoritative real transport and its observed log live
 * in this module-private registry, keyed by the opaque handle
 * `createRealPreflightTransport()` returns. The PF1 design returned
 * `{ brand, transport, log }` with transport and log as WRITABLE
 * public properties, and runPreflight trusted them: a caller could
 * take a genuine handle, overwrite both properties with a mocked
 * transport and its log, and the preflight treated simulated
 * responses as real-network evidence (LIVE_PASS + Condition 3
 * PASS). No brand or symbol fixes that class — a private symbol is
 * readable off any genuine handle via Object.getOwnPropertySymbols,
 * and a copied brand is indistinguishable from a genuine one.
 *
 * The registry is therefore the ONLY authority. The factory below —
 * which takes NO caller transport — constructs the guarded real
 * network transport, stores `{ transport, log }` here, and returns
 * an opaque handle carrying neither. runPreflight resolves
 * real-mode exclusively through this registry and never reads
 * handle properties: a mutated handle, a clone, and a
 * property-copied forgery are all simply ABSENT from the registry
 * and are refused. The authoritative log never leaves the module —
 * no caller-reachable reference to it exists; reports carry only
 * summaries computed from it inside runPreflight.
 */
const REAL_TRANSPORT_REGISTRY = new WeakMap<RealPreflightTransport, { transport: HttpTransport; log: TransportLogEntry[] }>();

const REAL_HANDLE_MARKER: unique symbol = Symbol("scq-real-preflight-transport-handle");

/**
 * An OPAQUE handle for the preflight's own internally constructed
 * guarded real-network transport. It exposes no transport, no log,
 * and no other state: its only meaning is its identity as a key in
 * the module-private registry above. (The marker property exists
 * only to give the type a nominal shape; authority is registry
 * membership, never the marker — a handle copied property-for-
 * property, marker included, is still refused.)
 */
export type RealPreflightTransport = { readonly [REAL_HANDLE_MARKER]: true };

/**
 * Constructs the preflight's own guarded REAL-network transport
 * (the pilot allowlist wrapped around the real fetch transport) and
 * returns its opaque handle. This is the only LIVE-eligible
 * transport source: runs over it are classified by what the
 * registry's observed log shows, exactly as runs over
 * caller-supplied transports are classified SIMULATED — the
 * difference is construction, not assertion.
 */
export function createRealPreflightTransport(): RealPreflightTransport {
  const { transport, log } = createGuardedLiveTransport(fetchTransport);
  const handle: RealPreflightTransport = { [REAL_HANDLE_MARKER]: true };
  REAL_TRANSPORT_REGISTRY.set(handle, { transport, log });
  return handle;
}

// ---------------------------------------------------------------------------
// Report types
// ---------------------------------------------------------------------------

/**
 * Where the run's evidence came from, established STRUCTURALLY by
 * runPreflight (PF1): "real" only when the transport was this
 * module's internally constructed guarded network transport;
 * "injected" for every caller-supplied transport (mocked fixtures
 * included), whatever label a caller attaches to it.
 */
export type PreflightTransportOrigin = "real" | "injected";

export type PreflightCheck = {
  id: string;
  status: "pass" | "blocker" | "unknown";
  detail: string;
};

export type FinancialQuantityId =
  | "incurred_immediate_obligation"
  | "post_change_recurring_price"
  | "next_invoice_estimate"
  | "amount_due_after_credits";

export type FinancialQuantity = {
  quantity: FinancialQuantityId;
  /** Minor units; null unless the provider source establishes the figure. Zero is a value only when established. */
  amountMinorUnits: number | null;
  currency: string | null;
  determinacy: "DETERMINED" | "NOT_APPLICABLE" | "UNKNOWN";
  /** The provider field/source the figure was read from. */
  providerSource: string;
  evidence: string;
  /** What is missing when the figure is not established. */
  missingData?: string;
  /** Estimated (from a preview/estimate read) vs observed (from committed provider state). Preflight figures are always estimates. */
  basis: "estimated" | "observed";
};

export type ReadinessCondition = {
  condition: 1 | 2 | 3 | 4 | 5;
  name: string;
  status: "PASS" | "BLOCKED" | "UNVERIFIED";
  evidence: string;
  reason: string;
};

export type PreflightReport = {
  kind: "scq-chargebee-exact-commit-preflight";
  generatedAt: string;
  /** True when a hard gate (site approval, live-commit env flag, synthetic designation) stopped the run before provider reads. */
  refused: boolean;
  refusalReasons: string[];
  identity: {
    provider: string;
    site: string;
    /** F1: the configured site exactly matched a per-run approved-site entry. Configuration validation, NOT provider attestation. */
    siteApprovedForReadOnly: boolean;
    /** Operator attestation is an INPUT. It is never inferred from site names, prefixes, or provider responses. */
    operatorAttestation: { testTenantAttested: boolean; attestedBy?: string; note?: string } | null;
    tenantModeEstablished: "ATTESTED" | "UNVERIFIED";
    subscriptionId: string | null;
    syntheticFixtureDesignation: boolean;
    quoteId: string;
    quoteStatus: string | null;
    quoteCreatedAt: string | null;
    quoteExpiresAt: string | null;
    storedFingerprint: string | null;
    currentResourceVersion: number | null;
    currentFingerprint: string | null;
    action: string | null;
    changes: Array<{ action: string; itemId?: string; quantity?: number; offeringRef?: string }>;
    targetItems: Array<{ itemPriceId: string; quantity: number }>;
  };
  exactRequest: {
    /** The complete parameter object the adapter's commit path would send to update_for_items, derived by the shared builder. */
    params: Record<string, unknown>;
    /** The exact form-encoded body those parameters produce. */
    formEncodedBody: string;
    replaceItemsList: boolean;
    prorate: boolean;
    invoiceImmediately: boolean;
    changeOption: string;
    /** The ORIGINAL idempotency key stored on the quote — never regenerated. */
    idempotencyKey: string;
    /** Canonical hash (the durable ledger's requestHashOf) of the parameter object. */
    requestHash: string;
    storedPreviewInput: { items: Array<{ itemPriceId: string; quantity: number }>; idempotencyKey: string } | null;
    matchesStoredPreviewInput: boolean;
    /** True/false when settled attempts exist for the quote; null when none do. */
    matchesStoredAttempts: boolean | null;
  } | null;
  providerState: {
    /** The subscription id the provider's re-read actually returned — checked against the bound id (PF3). */
    subscriptionId: string | null;
    subscriptionStatus: string | null;
    items: Array<{ itemPriceId: string; quantity: number | null; unitPrice: number | null; amount: number | null; complete: boolean }>;
    itemSetComplete: boolean;
    pricingModels: Record<string, string | null>;
    currency: string | null;
    /** "true"/"false" only when the provider read carries the flag; absent data is UNKNOWN — never an affirmative "none". */
    scheduledChanges: "true" | "false" | "UNKNOWN";
    scheduledAdvanceInvoices: "true" | "false" | "UNKNOWN";
    /** The read-only allowlist exposes no unbilled-charge or credit-note enumeration: standing UNKNOWN. */
    unbilledChargeVisibility: "UNKNOWN";
    creditVisibility: "UNKNOWN";
  } | null;
  financials: FinancialQuantity[];
  sideEffects: string[];
  durableReadiness: {
    quoteExistsDurably: boolean;
    providerMatch: boolean | null;
    /** Derived from the quote-origin record vs the stored quote (PF3) — never from a caller-supplied expectation. Null only when no stored quote exists. */
    subscriptionMatch: boolean | null;
    /** Derived from the quote-origin record vs the run's site (PF3). Null only when no stored quote exists. */
    siteBindingOk: boolean | null;
    /**
     * PF3 quote-origin binding: ESTABLISHED only when an issuance
     * record in the origin manifest matches this quote's site,
     * subscription, and canonical digest. MISSING (no record) and
     * MISMATCH (conflicting/corrupt/divergent record) both block.
     * Null only when no stored quote exists.
     */
    originBinding: "ESTABLISHED" | "MISSING" | "MISMATCH" | null;
    originSite: string | null;
    originSubscriptionId: string | null;
    requestCoherence: boolean | null;
    unresolvedAttempts: Array<{ attemptId: string; state: string; quoteId: string }>;
    recordedReceiptPresent: boolean;
    wouldReplay: boolean;
    /** The store's own recovery view, reduced to counts — reporting never resolves anything. */
    recoverySummary: { attemptsRequiringIntervention: number; recordedReceipts: number } | null;
  };
  checks: PreflightCheck[];
  blockers: string[];
  transport: TransportSummary & { updateForItemsDispatched: number };
  evidence: {
    transportOrigin: PreflightTransportOrigin;
    capabilities: Array<{ capability: string; result: string; detail: string }>;
  };
  conditions: ReadinessCondition[];
  /** The ceiling is READY_FOR_HUMAN_REVIEW. This software never emits GO. */
  overall: "NO-GO" | "READY_FOR_HUMAN_REVIEW";
};

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export type PreflightInput = {
  quoteId: string;
  /** The authoritative durable record. A quote that exists only in an in-memory store is not a preflight candidate. */
  store: DurableQuoteStore;
  /**
   * A caller-supplied transport. ALWAYS classified as injected /
   * simulated evidence (PF1), whatever it actually is: provenance
   * is structural, and no caller-supplied label can upgrade it.
   * Mutually exclusive in effect with `realTransport` — when both
   * are supplied, the internally constructed transport is the one
   * used and classified, because it is the one that produced the
   * evidence.
   */
  transport?: HttpTransport;
  /**
   * The opaque handle for the preflight's own internally
   * constructed guarded real-network transport, obtained ONLY from
   * `createRealPreflightTransport()`. This is the sole LIVE-eligible
   * source. A handle not constructed by that factory — including a
   * mutated genuine handle or a property-copied forgery — is
   * refused (module-private registry lookup) rather than classified.
   */
  realTransport?: RealPreflightTransport;
  /**
   * The quote-origin manifest (PF3): issuance records captured when
   * quotes were issued. Origin evidence comes from here — never
   * from caller-supplied site/subscription expectations. Omitting
   * it leaves every quote's origin MISSING, which blocks.
   */
  originManifest?: QuoteOriginManifest;
  site: string;
  /** Per-run explicitly approved site entry (F1 model): must exactly match `site`. */
  approvedSite?: string;
  approvedTestSites?: readonly string[];
  /** Operator attestation of actual test-tenant ownership/mode. An input — never inferred. */
  operatorAttestation?: { testTenantAttested: boolean; attestedBy?: string; note?: string };
  /** Used ONLY to construct the provider client; never recorded, and automatically added to the redaction set. */
  apiKey?: string;
  env?: Record<string, string | undefined>;
  now?: () => Date;
  /** Additional secret strings to scrub from every output string. */
  redactionSecrets?: string[];
  /**
   * Consistency inputs ONLY (PF3): when supplied, the stored
   * subscription / run site are compared against them and a mismatch
   * blocks — but agreement between two caller inputs is NOT origin
   * evidence and never establishes binding. Origin comes from
   * `originManifest` alone.
   */
  expectedSubscriptionId?: string;
  expectedSite?: string;
  /** Summary of a completed mocked rehearsal run (condition 2 evidence). */
  rehearsal?: { completed: boolean; scenariosPassed: number; scenariosTotal: number; reference?: string };
  /** Operator/human-supplied records. Recorded as supplied — never granted, inferred, or fabricated by this software. */
  humanInputs?: {
    releaseApproval?: { approved: boolean; reference?: string };
    reconciliationOwner?: { name?: string; backupName?: string; rehearsalReference?: string };
    commitAuthorization?: { granted: boolean; reference?: string };
  };
};

// ---------------------------------------------------------------------------
// Readiness aggregation (pure)
// ---------------------------------------------------------------------------

const CONDITION_NAMES: Record<number, string> = {
  1: "v0.6.2 Chargebee migration complete AND the v0.6.2 specification/release approved",
  2: "Durable idempotency storage implemented and recovery-tested",
  3: "Executed preflight for the exact commit (this report)",
  4: "Named reconciliation owner for unresolved outcomes",
  5: "Separate authorization for the controlled test-site commit",
};

/**
 * The overall assessment. READY_FOR_HUMAN_REVIEW requires every
 * condition PASS and zero blockers; anything else is NO-GO. There is
 * deliberately no path to "GO": the commit decision belongs to a
 * human, on evidence this report assembles but does not create.
 */
export function assessReadiness(conditions: ReadinessCondition[], blockers: readonly string[]): "NO-GO" | "READY_FOR_HUMAN_REVIEW" {
  if (blockers.length > 0) return "NO-GO";
  return conditions.every((c) => c.status === "PASS") ? "READY_FOR_HUMAN_REVIEW" : "NO-GO";
}

// ---------------------------------------------------------------------------
// Sanitization
// ---------------------------------------------------------------------------

const BASIC_CREDENTIAL = /Basic\s+[A-Za-z0-9+/=]{8,}/g;

function sanitize(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") {
    let out = value.replace(BASIC_CREDENTIAL, "[REDACTED]");
    for (const s of secrets) if (s && s.length >= 4) out = out.split(s).join("[REDACTED]");
    return out;
  }
  if (Array.isArray(value)) return value.map((v) => sanitize(v, secrets));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = sanitize(v, secrets);
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// The preflight
// ---------------------------------------------------------------------------

const SIDE_EFFECT_STATEMENTS: string[] = [
  "invoice_immediately=false does not mean there is no financial consequence: the change's charges land as unbilled charges and are invoiced at the next term renewal.",
  "Proration: the adapter sends prorate=true with change_option=immediately, so mid-term quantity/plan changes accrue prorated charges for the remainder of the current term (the incurred immediate obligation in this report).",
  "Unbilled charges already outstanding are invoiced at the next cycle alongside this change's charges; the read-only allowlist exposes no unbilled-charge enumeration, so their total is not established here.",
  "Credits: an amount due net of credits is established only from a provider next_invoice_estimate carrying credits_applied; subscription credit balances are not enumerable through the read-only allowlist.",
  "Scheduled changes: the adapter sends no cancellation or neutralization of pre-existing scheduled changes; a subscription with scheduled changes is a preflight blocker, not a detail.",
  "Mandatory addons: the adapter sends NO mandatory_items_to_remove; mandatory addons attached to the target plan survive replace_items_list=true and appear in the post-commit item set — an unlisted item in the current set is a blocker here.",
  "There is no atomic rollback. If a commit's outcome is wrong, reversal is a NEW, separately authorized transaction (itself subject to proration and provider rules) and may incur further financial consequences; reconciliation reporting a violation does not undo anything.",
];

function emptyTransportSummary(): TransportSummary & { updateForItemsDispatched: number } {
  return { totalCalls: 0, mutatingCalls: 0, estimateCalls: 0, byOperation: {}, rejectedAttempts: 0, updateForItemsDispatched: 0 };
}

// ---------------------------------------------------------------------------
// Full resulting-multiset validation (PF2)
// ---------------------------------------------------------------------------

type ItemTuple = { itemPriceId: string; quantity: number };

/**
 * The item multiset the recorded proposal AUTHORIZES as the
 * resulting state: the proposal's single change applied to the
 * AUTHORITATIVE current item set (the independent provider
 * re-read) — mirroring the adapter's own target construction
 * (CHANGE_QUANTITY replaces the target item's quantity in place;
 * CHANGE_PLAN swaps the target item's id for the offering,
 * quantity preserved). The baseline is NEVER the stored preview
 * input: that is the artifact under examination, and a tainted
 * preview input must not be allowed to define its own expectation.
 * Anything outside the adapter's single-change scope (multi-change
 * proposals, other actions, a target item absent from the current
 * set) cannot be reconstructed and blocks.
 */
function expectedTargetItems(
  proposal: SubscriptionChangeProposal,
  baseline: readonly ItemTuple[],
): { ok: true; items: ItemTuple[] } | { ok: false; reason: string } {
  const changes = proposal.changes;
  if (changes.length !== 1) {
    return { ok: false, reason: `the recorded proposal carries ${changes.length} changes; exact-request validation covers the adapter's single-change scope only, so the authorized resulting set cannot be reconstructed and the request is not validated` };
  }
  const change = changes[0];
  if (change.action === "CHANGE_QUANTITY") {
    if (change.itemId === undefined || typeof change.quantity !== "number") {
      return { ok: false, reason: "the recorded CHANGE_QUANTITY change lacks its item id or quantity — the authorized resulting set cannot be reconstructed" };
    }
    if (!baseline.some((i) => i.itemPriceId === change.itemId)) {
      return { ok: false, reason: `the proposal's target item "${change.itemId}" is absent from the independently re-read current item set — the authorized resulting set cannot be reconstructed` };
    }
    return { ok: true, items: baseline.map((i) => (i.itemPriceId === change.itemId ? { itemPriceId: i.itemPriceId, quantity: change.quantity as number } : { ...i })) };
  }
  if (change.action === "CHANGE_PLAN") {
    if (change.itemId === undefined || change.offeringRef === undefined) {
      return { ok: false, reason: "the recorded CHANGE_PLAN change lacks its item id or offering reference — the authorized resulting set cannot be reconstructed" };
    }
    if (!baseline.some((i) => i.itemPriceId === change.itemId)) {
      return { ok: false, reason: `the proposal's target item "${change.itemId}" is absent from the independently re-read current item set — the authorized resulting set cannot be reconstructed` };
    }
    return { ok: true, items: baseline.map((i) => (i.itemPriceId === change.itemId ? { itemPriceId: change.offeringRef as string, quantity: i.quantity } : { ...i })) };
  }
  return { ok: false, reason: `proposal action "${change.action}" is outside the exact-request validation scope (CHANGE_QUANTITY / CHANGE_PLAN) — unsupported proposal actions block` };
}

/**
 * Tuple-multiset divergences between the authorized resulting set
 * and the stored dispatch target, described per item id: quantity
 * changes on ANY item (not just the changed one), extra entries,
 * duplicates, and omissions all surface here.
 */
function multisetDivergences(expected: readonly ItemTuple[], target: readonly ItemTuple[]): string[] {
  const byId = (list: readonly ItemTuple[]): Map<string, number[]> => {
    const m = new Map<string, number[]>();
    for (const i of list) {
      const arr = m.get(i.itemPriceId) ?? [];
      arr.push(i.quantity);
      m.set(i.itemPriceId, arr);
    }
    for (const arr of m.values()) arr.sort((a, b) => a - b);
    return m;
  };
  const e = byId(expected);
  const t = byId(target);
  const out: string[] = [];
  for (const id of new Set([...e.keys(), ...t.keys()])) {
    const ev = e.get(id);
    const tv = t.get(id);
    if (JSON.stringify(ev ?? null) !== JSON.stringify(tv ?? null)) {
      out.push(`${id}: authorized resulting quantities [${ev ? ev.join(", ") : "absent"}] vs stored target [${tv ? tv.join(", ") : "absent"}]`);
    }
  }
  return out;
}

export async function runPreflight(input: PreflightInput): Promise<PreflightReport> {
  const now = input.now ?? (() => new Date());
  const env = input.env ?? {};
  const checks: PreflightCheck[] = [];
  const blockers: string[] = [];
  const check = (id: string, status: PreflightCheck["status"], detail: string) => {
    checks.push({ id, status, detail });
    if (status === "blocker") blockers.push(`${id}: ${detail}`);
  };

  // --- Structural transport provenance (PF1 + PF4) -------------------
  // Provenance is decided HERE, from how the transport was obtained:
  // a handle found in the module-private registry is "real"; every
  // caller-supplied transport is "injected". There is no origin
  // input. PF4: the registry — never handle properties — is the
  // authority, so a forged, cloned, or property-mutated handle is
  // refused outright: a caller must not be able to assemble the
  // appearance of the real network path around a mocked transport,
  // nor substitute a fabricated log for the observed one.
  let provenance: PreflightTransportOrigin;
  let realEntry: { transport: HttpTransport; log: TransportLogEntry[] } | undefined;
  if (input.realTransport !== undefined) {
    realEntry = REAL_TRANSPORT_REGISTRY.get(input.realTransport);
    if (realEntry === undefined) {
      throw new Error("runPreflight: realTransport was not constructed by createRealPreflightTransport() — refusing to classify a caller-assembled, cloned, or property-mutated handle as the internally constructed real-network transport");
    }
    provenance = "real";
  } else if (input.transport !== undefined) {
    provenance = "injected";
  } else {
    throw new Error("runPreflight: no transport supplied — pass a caller-supplied transport (injected/simulated evidence) or realTransport from createRealPreflightTransport()");
  }

  const approvedSites = [...(input.approvedTestSites ?? []), ...(input.approvedSite ? [input.approvedSite] : [])];
  const siteApproved = isApprovedTestSite(input.site, approvedSites);
  const attestation = input.operatorAttestation ?? null;

  const report: PreflightReport = {
    kind: "scq-chargebee-exact-commit-preflight",
    generatedAt: now().toISOString(),
    refused: false,
    refusalReasons: [],
    identity: {
      provider: "chargebee",
      site: input.site,
      siteApprovedForReadOnly: siteApproved,
      operatorAttestation: attestation,
      tenantModeEstablished: attestation?.testTenantAttested ? "ATTESTED" : "UNVERIFIED",
      subscriptionId: null,
      syntheticFixtureDesignation: false,
      quoteId: input.quoteId,
      quoteStatus: null,
      quoteCreatedAt: null,
      quoteExpiresAt: null,
      storedFingerprint: null,
      currentResourceVersion: null,
      currentFingerprint: null,
      action: null,
      changes: [],
      targetItems: [],
    },
    exactRequest: null,
    providerState: null,
    financials: [],
    sideEffects: [...SIDE_EFFECT_STATEMENTS],
    durableReadiness: {
      quoteExistsDurably: false,
      providerMatch: null,
      subscriptionMatch: null,
      siteBindingOk: null,
      originBinding: null,
      originSite: null,
      originSubscriptionId: null,
      requestCoherence: null,
      unresolvedAttempts: [],
      recordedReceiptPresent: false,
      wouldReplay: false,
      recoverySummary: null,
    },
    checks,
    blockers,
    transport: emptyTransportSummary(),
    evidence: { transportOrigin: provenance, capabilities: [] },
    conditions: [],
    overall: "NO-GO",
  };

  // --- Gates evaluated before any provider read --------------------------
  if (env.SCQ_LIVE_COMMIT_ENABLED === "true") {
    report.refused = true;
    report.refusalReasons.push("SCQ_LIVE_COMMIT_ENABLED=true is present in the preflight environment; a read-only preflight refuses to run alongside an enabled live-commit flag");
    check("live_commit_flag_absent", "blocker", "SCQ_LIVE_COMMIT_ENABLED=true present in the environment");
  } else {
    check("live_commit_flag_absent", "pass", "SCQ_LIVE_COMMIT_ENABLED is not set to true in the preflight environment");
  }
  if (!siteApproved) {
    report.refused = true;
    report.refusalReasons.push(`site "${input.site}" is not in the per-run approved test-site list (F1 configuration validation; a -test suffix alone is not approval)`);
    check("site_approved", "blocker", `configured site "${input.site}" has no exactly-matching per-run approved-site entry`);
  } else {
    check("site_approved", "pass", `configured site "${input.site}" exactly matches a per-run approved-site entry (configuration validation only — not provider attestation of tenant mode)`);
  }
  if (attestation?.testTenantAttested) {
    check("operator_attestation", "pass", `operator attestation of test-tenant ownership/mode recorded as supplied${attestation.attestedBy ? ` by ${attestation.attestedBy}` : ""} (an input, never inferred)`);
  } else {
    check("operator_attestation", "unknown", "no operator attestation of actual test-tenant ownership/mode was supplied; a test-looking site name is not proof of tenant safety, so tenant mode stays UNVERIFIED");
  }

  // --- Durable record (read-only local lookups; no intent persisted) -----
  const stored: StoredQuote | undefined = input.store.get(input.quoteId);
  const attempts: StoredAttempt[] = input.store.allAttempts();
  const recovery = input.store.recoveryReport();
  report.durableReadiness.recoverySummary = {
    attemptsRequiringIntervention: [...recovery.unresolvedAttempts, ...recovery.indeterminateOutcomes].filter((a) => a.operatorInterventionRequired === true).length,
    recordedReceipts: input.store.all().filter((q) => q.commit_receipt !== undefined).length,
  };
  const previewInput = stored?.provider_preview_input as StoredPreviewInput | undefined;

  let proposal: SubscriptionChangeProposal | undefined;
  if (!stored) {
    check("quote_exists_durably", "blocker", "no durable record exists for this quote id — a quote held only in memory is not a preflight candidate (durable storage is a hard precondition)");
  } else {
    proposal = stored.proposal;
    report.durableReadiness.quoteExistsDurably = true;
    check("quote_exists_durably", "pass", "the quote exists in the authoritative durable store");
    report.identity.subscriptionId = stored.subscription_id;
    report.identity.quoteStatus = stored.status;
    report.identity.quoteCreatedAt = stored.created_at;
    report.identity.quoteExpiresAt = stored.expires_at;
    report.identity.storedFingerprint = stored.subscription_version_at_quote;
    report.identity.action = stored.proposal.changes.map((c) => c.action).join("+") || null;
    report.identity.changes = stored.proposal.changes.map((c) =>
      c.action === "CHANGE_QUANTITY" ? { action: c.action, itemId: c.itemId, quantity: c.quantity }
        : c.action === "CHANGE_PLAN" ? { action: c.action, itemId: c.itemId, offeringRef: c.offeringRef }
          : { action: c.action });
    report.identity.targetItems = (previewInput?.items ?? []).map((i) => ({ itemPriceId: i.itemPriceId, quantity: i.quantity }));
    report.identity.syntheticFixtureDesignation = isSyntheticSubscriptionId(stored.subscription_id);

    report.durableReadiness.providerMatch = stored.provider === "chargebee";
    check("provider_binding", stored.provider === "chargebee" ? "pass" : "blocker",
      stored.provider === "chargebee" ? "stored provider binding is chargebee" : `stored provider binding is "${stored.provider}" — this preflight covers chargebee quotes only`);

    // PF3: quote-origin binding. A StoredQuote carries no site, so
    // the ONLY origin evidence is the issuance record in the origin
    // manifest — captured when the quote was issued, keyed by quote
    // id, and digest-bound to the stored quote. Absence BLOCKS (it
    // no longer sits null beside zero blockers): without it, a quote
    // issued on one site could be replayed against another approved
    // site with a coincidentally matching subscription id and
    // fingerprint, and nothing here could tell.
    const manifest = input.originManifest;
    if (manifest?.corrupt) {
      report.durableReadiness.originBinding = "MISMATCH";
      report.durableReadiness.siteBindingOk = false;
      report.durableReadiness.subscriptionMatch = false;
      check("quote_origin_binding", "blocker", "the quote-origin manifest is corrupt, partially unreadable, or fails record-digest / hash-chain integrity verification — origin evidence is untrustworthy, so site/subscription binding cannot be established");
    } else {
      const origins = manifest?.recordsFor(stored.quote_id) ?? [];
      if (origins.length === 0) {
        report.durableReadiness.originBinding = "MISSING";
        report.durableReadiness.siteBindingOk = false;
        report.durableReadiness.subscriptionMatch = false;
        check("quote_origin_binding", "blocker", "no quote-origin record exists for this quote: the site and subscription it was ISSUED against are not independently established. Caller-supplied site expectations are consistency inputs, not origin evidence — origin binding is a hard precondition and its absence blocks");
      } else {
        const first = origins[0];
        report.durableReadiness.originSite = first.site;
        report.durableReadiness.originSubscriptionId = first.subscriptionId;
        const conflicting = origins.some((r) => r.site !== first.site || r.subscriptionId !== first.subscriptionId || r.quoteDigest !== first.quoteDigest || r.provider !== first.provider);
        if (conflicting) {
          report.durableReadiness.originBinding = "MISMATCH";
          report.durableReadiness.siteBindingOk = false;
          report.durableReadiness.subscriptionMatch = false;
          check("quote_origin_binding", "blocker", `${origins.length} origin records exist for this quote and they conflict (site, subscription, provider, or digest) — the quote's origin is ambiguous and cannot be established`);
        } else if (first.provider !== "chargebee" || first.subscriptionId !== stored.subscription_id) {
          report.durableReadiness.originBinding = "MISMATCH";
          report.durableReadiness.siteBindingOk = false;
          report.durableReadiness.subscriptionMatch = false;
          check("quote_origin_binding", "blocker", `the origin record binds this quote to provider "${first.provider}" / subscription "${first.subscriptionId}", but the stored quote names provider "${stored.provider}" / subscription "${stored.subscription_id}" — the record does not belong to this quote`);
        } else if (first.quoteDigest !== quoteOriginDigest(stored)) {
          report.durableReadiness.originBinding = "MISMATCH";
          report.durableReadiness.siteBindingOk = false;
          report.durableReadiness.subscriptionMatch = false;
          check("quote_origin_binding", "blocker", "the stored quote no longer matches the canonical digest captured in its origin record at issuance — the quote was altered after issuance (or the record was transplanted), so its origin cannot be trusted for this record");
        } else if (first.site !== input.site) {
          report.durableReadiness.originBinding = "MISMATCH";
          report.durableReadiness.siteBindingOk = false;
          report.durableReadiness.subscriptionMatch = false;
          check("quote_origin_binding", "blocker", `cross-site replay refused: this quote was issued against site "${first.site}" (origin record) but this preflight runs against site "${input.site}" — the same site identity must bind the issuance, the request, the read, the ledger, and any future authorization`);
        } else {
          report.durableReadiness.originBinding = "ESTABLISHED";
          report.durableReadiness.siteBindingOk = true;
          report.durableReadiness.subscriptionMatch = true;
          check("quote_origin_binding", "pass", `quote origin is established by its issuance record: issued against site "${first.site}" for subscription "${first.subscriptionId}", digest-bound to the stored quote — the same site identity binds this run's request, re-read, and ledger`);
        }
      }
    }
    // Consistency inputs (PF3): agreement or disagreement between
    // caller inputs — recorded, and a mismatch blocks — but never
    // treated as origin evidence.
    if (input.expectedSubscriptionId !== undefined) {
      const consistent = stored.subscription_id === input.expectedSubscriptionId;
      check("subscription_consistency", consistent ? "pass" : "blocker",
        consistent ? "stored subscription matches the caller-supplied expected subscription (consistency input only — not origin evidence)" : `stored subscription "${stored.subscription_id}" does not match the caller-supplied expected subscription "${input.expectedSubscriptionId}"`);
    }
    if (input.expectedSite !== undefined) {
      const consistent = input.expectedSite === input.site;
      check("site_consistency", consistent ? "pass" : "blocker",
        consistent ? "the run's site matches the caller-supplied expected site (consistency input only — not origin evidence)" : `the run's site "${input.site}" does not match the caller-supplied expected site "${input.expectedSite}"`);
    }
    if (new Date(stored.expires_at).getTime() <= now().getTime()) {
      check("quote_not_expired", "blocker", `quote expired at ${stored.expires_at}`);
    } else {
      check("quote_not_expired", "pass", `quote expires at ${stored.expires_at}`);
    }
    if (!report.identity.syntheticFixtureDesignation) {
      report.refused = true;
      report.refusalReasons.push(`subscription id "${stored.subscription_id}" carries no synthetic-fixture designation (cbdemo_/pilot-/synthetic-/test- prefix); preflight refuses to treat an undesignated subscription as a commit candidate`);
      check("synthetic_designation", "blocker", `subscription id "${stored.subscription_id}" has no synthetic-fixture designation`);
    } else {
      check("synthetic_designation", "pass", `subscription id "${stored.subscription_id}" carries a synthetic-fixture designation (a designation is a scoping signal, not proof of tenant safety)`);
    }
    if (stored.commit_receipt) {
      report.durableReadiness.recordedReceiptPresent = true;
      report.durableReadiness.wouldReplay = true;
      check("not_already_committed", "blocker", "a receipt is already recorded for this quote: a further commit call would REPLAY the recorded receipt, not recommit — there is no new commit for this preflight to clear");
    }
    if (stored.commit_outcome?.outcome === "INDETERMINATE") {
      check("no_indeterminate_outcome", "blocker", "the quote carries a recorded INDETERMINATE commit outcome — blind retry is refused until a human resolves the attempt through the reconciliation procedure");
    }
  }

  // Unresolved attempts for the quote OR the subscription: hard blocker,
  // never cleared, reclassified, or overridden by this report.
  const unresolved = attempts.filter((a) =>
    (a.state === "PREPARED" || a.state === "DISPATCHING" || a.state === "INDETERMINATE") &&
    (a.quoteId === input.quoteId || (stored !== undefined && a.subscriptionId === stored.subscription_id)));
  report.durableReadiness.unresolvedAttempts = unresolved.map((a) => ({ attemptId: a.attemptId, state: a.state, quoteId: a.quoteId }));
  if (unresolved.length > 0) {
    check("no_unresolved_attempts", "blocker", `${unresolved.length} unresolved durable attempt(s) for this quote/subscription (${unresolved.map((a) => `${a.attemptId}:${a.state}`).join(", ")}); this report does not clear, reclassify, or override them`);
  } else if (stored) {
    check("no_unresolved_attempts", "pass", "no unresolved durable attempt exists for this quote or subscription");
  }

  // --- Exact request derivation (shared builder; local, no dispatch) ----
  let derivedParams: Record<string, unknown> | null = null;
  let derivedHash: string | null = null;
  if (stored && previewInput) {
    const pii = previewInput;
    derivedParams = buildChargebeeUpdateParams(pii.items);
    derivedHash = requestHashOf(derivedParams);
    const expectedKey = `scq-${stored.quote_id}`.slice(0, 100);
    const storedItems = pii.items.map((i) => ({ itemPriceId: i.itemPriceId, quantity: i.quantity }));
    report.exactRequest = {
      params: derivedParams,
      formEncodedBody: formEncode(derivedParams),
      replaceItemsList: derivedParams.replace_items_list === true,
      prorate: derivedParams.prorate === true,
      invoiceImmediately: derivedParams.invoice_immediately === true,
      changeOption: String(derivedParams.change_option ?? ""),
      idempotencyKey: pii.idempotencyKey,
      requestHash: derivedHash,
      storedPreviewInput: { items: storedItems, idempotencyKey: pii.idempotencyKey },
      // PF2: settled ONLY by the post-read full-multiset validation
      // below — until the independent baseline exists, the request
      // is NOT reported as matching the authorized change.
      matchesStoredPreviewInput: false,
      matchesStoredAttempts: null,
    };
    if (pii.idempotencyKey !== expectedKey) {
      check("idempotency_key_coherence", "blocker", `the stored idempotency key is not the key the adapter derives for this quote ("scq-<quoteId>") — the key has changed or was not adapter-issued`);
    } else {
      check("idempotency_key_coherence", "pass", "the stored idempotency key is the original adapter-derived key for this quote; it is reported, never regenerated");
    }
    // Proposal coherence is deliberately NOT settled here (PF2):
    // whether the stored target is exactly the authorized change
    // can only be judged against the independent provider re-read
    // (see the full-multiset validation in the re-read below). The
    // pre-correction check compared only the changed item against
    // the stored target — the artifact under examination grading
    // itself.
    // Recorded-attempt hash coherence.
    const quoteAttempts = attempts.filter((a) => a.quoteId === input.quoteId);
    if (quoteAttempts.length > 0) {
      const mismatch = quoteAttempts.find((a) => a.requestHash !== derivedHash);
      report.exactRequest.matchesStoredAttempts = mismatch === undefined;
      check("attempt_request_hash", mismatch === undefined ? "pass" : "blocker",
        mismatch === undefined ? "every recorded attempt for this quote carries this exact request hash" : `recorded attempt ${mismatch.attemptId} carries a different request hash — a different request was prepared under this quote`);
    }
  }

  // --- Independent provider re-read (guarded, read-only) ------------------
  let runLog: TransportLogEntry[] = [];
  let proposalCoherenceSettled = false;
  let identityVerified = false;
  if (!report.refused && stored && derivedParams) {
    // The internally constructed real transport is already guarded
    // by its factory; its authoritative transport + log come from
    // the module-private registry (PF4) — handle properties are
    // never read. A caller-supplied transport is wrapped in the
    // same guard here.
    const { transport: guarded, log } = provenance === "real"
      ? realEntry!
      : createPreflightTransport(input.transport!);
    runLog = log;
    const client = new ChargebeeClient({ site: input.site, apiKey: input.apiKey ?? "" }, guarded);
    try {
      const subRes = await client.getSubscription(stored.subscription_id);
      const sub = ((subRes.json as any)?.subscription ?? {}) as CbSubscription;
      // PF3: the re-read must actually BE the bound subscription.
      // The id the provider returns is compared against the stored
      // (origin-bound) subscription id — a response about any other
      // subscription is not evidence about this quote.
      const responseSubscriptionId = typeof sub.id === "string" && sub.id.length > 0 ? sub.id : null;
      if (responseSubscriptionId === null) {
        check("provider_subscription_identity", "unknown", "the provider re-read carries no subscription id — the identity of the re-read subscription cannot be verified against the bound subscription id, so the read is not verified identity evidence");
      } else if (responseSubscriptionId !== stored.subscription_id) {
        check("provider_subscription_identity", "blocker", `the provider re-read returned subscription "${responseSubscriptionId}", which is not the bound subscription "${stored.subscription_id}" — state read from a different subscription is not evidence for this quote`);
      } else {
        identityVerified = true;
        check("provider_subscription_identity", "pass", `the provider re-read returned the bound subscription "${stored.subscription_id}"`);
      }
      report.identity.currentResourceVersion = typeof sub.resource_version === "number" ? sub.resource_version : null;
      report.identity.currentFingerprint = chargebeeSubscriptionFingerprint(sub);
      if (report.identity.currentFingerprint === stored.subscription_version_at_quote) {
        check("fingerprint_stable", "pass", `provider fingerprint is unchanged since quote time (${stored.subscription_version_at_quote})`);
      } else {
        check("fingerprint_stable", "blocker", `provider fingerprint moved since quote time (stored ${stored.subscription_version_at_quote}, current ${report.identity.currentFingerprint}) — the quote no longer describes current provider state`);
      }
      const rawItems = sub.subscription_items ?? [];
      const items = rawItems.map((i) => {
        const complete = typeof i.item_price_id === "string" && typeof i.quantity === "number" && typeof i.amount === "number";
        return { itemPriceId: String(i.item_price_id ?? ""), quantity: typeof i.quantity === "number" ? i.quantity : null, unitPrice: typeof i.unit_price === "number" ? i.unit_price : null, amount: typeof i.amount === "number" ? i.amount : null, complete };
      });
      const itemSetComplete = items.length > 0 && items.every((i) => i.complete);
      const scheduledChanges = typeof sub.has_scheduled_changes === "boolean" ? (sub.has_scheduled_changes ? "true" : "false") : "UNKNOWN";
      const scheduledAdvance = typeof sub.has_scheduled_advance_invoices === "boolean" ? (sub.has_scheduled_advance_invoices ? "true" : "false") : "UNKNOWN";
      report.providerState = {
        subscriptionId: responseSubscriptionId,
        subscriptionStatus: typeof sub.status === "string" ? sub.status : null,
        items,
        itemSetComplete,
        pricingModels: {},
        currency: typeof sub.currency_code === "string" ? sub.currency_code : null,
        scheduledChanges: scheduledChanges as "true" | "false" | "UNKNOWN",
        scheduledAdvanceInvoices: scheduledAdvance as "true" | "false" | "UNKNOWN",
        unbilledChargeVisibility: "UNKNOWN",
        creditVisibility: "UNKNOWN",
      };
      check("item_set_complete", itemSetComplete ? "pass" : "blocker",
        itemSetComplete ? "the full current item collection was read with id, quantity, and amount for every entry" : "the current item collection is incomplete (an entry lacks id, quantity, or stated amount) — the resulting state cannot be fully compared");
      // PF2: full resulting-multiset validation. The authorized
      // resulting set is reconstructed from THIS independent read
      // plus the recorded proposal, then compared tuple-for-tuple
      // (as a multiset) against the stored dispatch target. Every
      // item is judged — a quantity change smuggled onto a
      // non-target item, an extra or duplicated entry, or an
      // omission diverges and blocks. Until this runs, request
      // coherence cannot be PASS.
      {
        const baselineUsable = items.length > 0 && items.every((i) => i.itemPriceId.length > 0 && i.quantity !== null);
        if (!baselineUsable) {
          check("request_matches_proposal", "unknown", "the independent re-read did not yield a complete current item set (id + quantity for every entry), so the full resulting item set cannot be validated — request coherence is NOT established");
        } else {
          const baseline: ItemTuple[] = items.map((i) => ({ itemPriceId: i.itemPriceId, quantity: i.quantity as number }));
          const expected = expectedTargetItems(stored.proposal, baseline);
          if (!expected.ok) {
            report.durableReadiness.requestCoherence = false;
            check("request_matches_proposal", "blocker", expected.reason);
          } else {
            const target: ItemTuple[] = (previewInput?.items ?? []).map((i) => ({ itemPriceId: i.itemPriceId, quantity: i.quantity }));
            const divergences = multisetDivergences(expected.items, target);
            const coherent = divergences.length === 0;
            report.exactRequest!.matchesStoredPreviewInput = coherent;
            report.durableReadiness.requestCoherence = coherent;
            check("request_matches_proposal", coherent ? "pass" : "blocker",
              coherent
                ? "the stored dispatch target is exactly the full resulting item multiset the recorded proposal authorizes over the independently re-read current item set (every item's id and quantity compared, not just the changed item)"
                : `the stored dispatch target diverges from the authorized resulting item set: ${divergences.join("; ")} — the request a commit would send is not the authorized change`);
          }
        }
        proposalCoherenceSettled = true;
      }
      // Target-set coverage: replace_items_list=true drops anything the
      // target set omits (mandatory addons excepted — and those are
      // precisely the interference this check names).
      const targetIds = new Set(report.identity.targetItems.map((i) => i.itemPriceId));
      const omitted = items.filter((i) => !targetIds.has(i.itemPriceId));
      if (omitted.length > 0) {
        check("target_covers_current_items", "blocker", `current item(s) ${omitted.map((i) => i.itemPriceId).join(", ")} are absent from the target set: replacement would remove them, or (for mandatory addons) they would survive and make the resulting set differ from the authorized change`);
      } else {
        check("target_covers_current_items", "pass", "every current item is present in the target set");
      }
      if (scheduledChanges === "true") check("scheduled_changes", "blocker", "the subscription has outstanding SCHEDULED CHANGES; their interaction with this change is unresolved");
      else if (scheduledChanges === "UNKNOWN") check("scheduled_changes", "unknown", "the provider read carries no scheduled-changes flag: absence of the data is NOT an affirmative 'none exist'");
      else check("scheduled_changes", "pass", "the provider read reports no scheduled changes");
      if (scheduledAdvance === "true") check("scheduled_advance_invoices", "blocker", "the subscription has SCHEDULED ADVANCE INVOICES outstanding");
      else if (scheduledAdvance === "UNKNOWN") check("scheduled_advance_invoices", "unknown", "the provider read carries no scheduled-advance-invoices flag; status UNKNOWN");
      else check("scheduled_advance_invoices", "pass", "the provider read reports no scheduled advance invoices");

      // Pricing models for every involved item price.
      const involvedIds = [...new Set([...items.map((i) => i.itemPriceId), ...report.identity.targetItems.map((i) => i.itemPriceId)])];
      const priceById = new Map<string, number | undefined>();
      for (const id of involvedIds) {
        try {
          const priceRes = await client.getItemPrice(id);
          const model = (priceRes.json as any)?.item_price?.pricing_model;
          const price = (priceRes.json as any)?.item_price?.price;
          report.providerState.pricingModels[id] = typeof model === "string" ? model : null;
          priceById.set(id, typeof price === "number" ? price : undefined);
        } catch {
          report.providerState.pricingModels[id] = null;
        }
      }
      const missingPrices = involvedIds.filter((id) => report.providerState!.pricingModels[id] === null || report.providerState!.pricingModels[id] === undefined);
      if (missingPrices.length > 0) {
        check("item_prices_readable", "blocker", `item price(s) could not be read for ${missingPrices.join(", ")} — pricing model and currency consistency cannot be established`);
      } else {
        check("item_prices_readable", "pass", "every involved item price was read");
      }
      const unsupported = involvedIds.filter((id) => { const m = report.providerState!.pricingModels[id]; return m !== null && m !== undefined && m !== "flat_fee" && m !== "per_unit"; });
      if (unsupported.length > 0) {
        check("pricing_models_supported", "blocker", `unsupported pricing model(s): ${unsupported.map((id) => `${id}=${report.providerState!.pricingModels[id]}`).join(", ")} — the adapter implements flat_fee and per_unit only; contributions under other models are not established`);
      } else if (missingPrices.length === 0) {
        check("pricing_models_supported", "pass", "all involved pricing models are implemented (flat_fee / per_unit)");
      }
      if (report.providerState.currency !== null && stored.quoted_effect?.recurring?.currency && report.providerState.currency.toLowerCase() !== String(stored.quoted_effect.recurring.currency).toLowerCase()) {
        check("currency_consistent", "blocker", `provider currency "${report.providerState.currency}" does not match the quoted currency "${stored.quoted_effect.recurring.currency}"`);
      }

      // Financials from a fresh guarded estimate of the exact request.
      const estRes = await client.estimateUpdateForItems(stored.subscription_id, derivedParams);
      const interpreted = interpretChargebeeEstimate((estRes.json as any)?.estimate, {
        currency: report.providerState.currency ?? String(stored.quoted_effect?.recurring?.currency ?? ""),
        currentItems: items.map((i) => ({ itemPriceId: i.itemPriceId, quantity: i.quantity ?? 0, ...(i.unitPrice !== null ? { unitPrice: i.unitPrice } : {}), ...(i.amount !== null ? { amount: i.amount } : {}) })),
        targetItems: report.identity.targetItems,
        priceInfo: new Map(involvedIds.map((id) => [id, { itemPriceId: id, pricingModel: report.providerState!.pricingModels[id] ?? undefined, price: priceById.get(id) }])),
      });
      const freshEffect = chargebeeEffectWithDeterminacy(interpreted);
      const currency = typeof interpreted.effect.recurring?.currency === "string" ? interpreted.effect.recurring.currency : report.providerState.currency;
      const immediate = interpreted.effect.immediate?.net;
      const recurring = interpreted.effect.recurring?.resultingAmount;
      const nextInvoice = interpreted.nextInvoice;
      const nonInteger = [immediate, recurring, nextInvoice?.total, nextInvoice?.amountDue].some((v) => typeof v === "number" && !Number.isInteger(v));
      if (nonInteger) {
        check("amount_units_consistent", "blocker", "a provider figure is not an integer number of minor units — amount-unit consistency cannot be established");
      }
      const fin = (quantity: FinancialQuantityId, amount: number | undefined, source: string, missing: string): FinancialQuantity => {
        const determined = typeof amount === "number" && Number.isFinite(amount) && Number.isInteger(amount);
        return {
          quantity,
          amountMinorUnits: determined ? amount! : null,
          currency: determined ? currency : null,
          determinacy: determined ? "DETERMINED" : "UNKNOWN",
          providerSource: source,
          evidence: determined ? `established from ${source} by the fresh preflight estimate` : `not established: ${missing}`,
          ...(determined ? {} : { missingData: missing }),
          basis: "estimated" as const,
        };
      };
      report.financials = [
        fin("incurred_immediate_obligation", immediate, "estimate unbilled_charge_estimates (prorated charges landing as unbilled charges)", "the estimate establishes no immediate figure (no complete unbilled-charge amount)"),
        fin("post_change_recurring_price", recurring, "estimate subscription_items stated amounts / implemented per-item pricing", "neither a complete stated item list nor implemented per-item pricing establishes the recurring figure"),
        fin("next_invoice_estimate", nextInvoice?.total, "estimate next_invoice_estimate.total", "the estimate carries no next_invoice_estimate — the next-invoice total is a distinct quantity and is never back-filled from the recurring figure"),
        fin("amount_due_after_credits", nextInvoice?.amountDue, "estimate next_invoice_estimate.amount_due (net of credits_applied)", "no next_invoice_estimate amount_due is established; unbilled-charge/credit visibility through the read-only allowlist is insufficient to derive it"),
      ];
      // Envelope drift: the fresh estimate must still sit inside the
      // envelope the quote was issued under.
      if (proposal) {
        try {
          const violation = checkAcceptanceEnvelope(stored.quoted_effect, freshEffect, proposal.acceptanceEnvelope ?? {}, proposal);
          if (violation) check("envelope_still_satisfied", "blocker", `the fresh estimate violates the quote's acceptance envelope: ${violation}`);
          else check("envelope_still_satisfied", "pass", "the fresh estimate sits inside the quote's acceptance envelope");
        } catch (e) {
          check("envelope_still_satisfied", "blocker", `the fresh estimate cannot be shown deterministic under BC-1: ${e instanceof SCQError || e instanceof Error ? e.message : String(e)}`);
        }
      }
    } catch (e) {
      if (e instanceof ChargebeeOperationNotAllowedError) throw e; // a guard refusal is a defect in this module, not report data
      check("provider_reread", "blocker", `the independent provider re-read failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    const summary = summarizeTransportLog(log);
    report.transport = { ...summary, updateForItemsDispatched: log.filter((e) => e.dispatched && e.operation === "update_for_items").length };
  }

  // PF2: if the run never reached the multiset validation (refused
  // before reads, or the re-read failed), coherence is reported as
  // NOT established — it can never default to a pass.
  if (stored && previewInput && !proposalCoherenceSettled) {
    check("request_matches_proposal", "unknown", "request coherence was not validated against an independent provider baseline (the run was refused before reads, or the re-read did not complete) — it cannot be reported as matching the authorized change");
  }

  // --- Capabilities, classified honestly ----------------------------------
  const okReads = !report.refused && report.providerState !== null && report.transport.mutatingCalls === 0;
  const successfulReads = observedSuccessfulOps(runLog, "retrieve_subscription");
  report.evidence.capabilities = [
    {
      capability: "exact-commit preflight evidence (this run)",
      // PF1: classification rests on STRUCTURAL provenance + the
      // observed log. "real" is reachable only via the internally
      // constructed transport; a caller-supplied transport is
      // "injected" and caps at SIMULATED_PASS, however it is labeled.
      result: classifyRunCapability("live", okReads, successfulReads, provenance),
      detail: provenance === "real"
        ? "internally constructed guarded real-network transport: observed operations were allowlisted reads/estimates only"
        : "caller-supplied (injected) transport: this evidence validates procedure and code paths, never live provider behavior — provenance is structural and cannot be upgraded by a caller-supplied label",
    },
    {
      capability: "zero observed mutations",
      result: report.transport.mutatingCalls === 0 && report.transport.updateForItemsDispatched === 0 ? "established from the observed transport log" : "VIOLATED",
      detail: `observed ${report.transport.totalCalls} dispatched call(s): ${report.transport.totalCalls - report.transport.mutatingCalls} read-only/estimate, ${report.transport.mutatingCalls} mutating, ${report.transport.rejectedAttempts} rejected pre-dispatch; update_for_items dispatched ${report.transport.updateForItemsDispatched} time(s)`,
    },
  ];

  // --- Readiness conditions -------------------------------------------------
  const rehearsal = input.rehearsal;
  const owner = input.humanInputs?.reconciliationOwner;
  const release = input.humanInputs?.releaseApproval;
  const authz = input.humanInputs?.commitAuthorization;
  // Condition 3 requirements (PF1 + PF3), enumerated so the report
  // names exactly what is missing rather than failing opaquely.
  const cond3Unmet: string[] = [];
  if (provenance !== "real") cond3Unmet.push("the transport was caller-supplied (injected/simulated evidence): only the preflight's own internally constructed guarded real-network transport produces real-tenant evidence, and no caller-supplied label changes that");
  if (!attestation?.testTenantAttested) cond3Unmet.push("operator attestation of actual test-tenant ownership/mode was not supplied (tenant mode UNVERIFIED)");
  if (report.durableReadiness.originBinding !== "ESTABLISHED") cond3Unmet.push("quote-origin site/subscription binding is not established by an issuance record");
  if (report.providerState === null) cond3Unmet.push("the independent provider re-read did not complete");
  else if (!identityVerified) cond3Unmet.push("the re-read subscription identity was not verified against the bound subscription id");
  // PF5: safety-critical UNKNOWN checks gate Condition 3 explicitly.
  // An "unknown" check is not a blocker, so the blocker count alone
  // let a structurally real, otherwise complete run PASS Condition 3
  // without establishing whether outstanding scheduled changes or
  // advance invoices would be disturbed — uncertainty silently
  // treated as clearance. While any safety-critical check is
  // unresolved, Condition 3 stays UNVERIFIED (BLOCKED only when
  // blockers also stand) and each unresolved fact is named here.
  // (The remaining safety-critical unknowns are gated by their
  // dedicated requirements above: operator attestation, and provider
  // subscription identity via identityVerified.)
  const COND3_UNKNOWN_GATES: ReadonlyArray<{ id: string; unmet: string }> = [
    { id: "scheduled_changes", unmet: "scheduled-change status is UNKNOWN — the provider read did not establish whether outstanding scheduled changes exist that this change would disturb; uncertainty is not clearance" },
    { id: "scheduled_advance_invoices", unmet: "scheduled-advance-invoice status is UNKNOWN — the provider read did not establish whether scheduled advance invoices are outstanding; uncertainty is not clearance" },
    { id: "request_matches_proposal", unmet: "request coherence is not established — the exact request was not validated against an independent provider baseline (the request_matches_proposal check is unresolved/UNKNOWN)" },
  ];
  for (const gate of COND3_UNKNOWN_GATES) {
    const c = checks.find((x) => x.id === gate.id);
    if (c && c.status === "unknown") cond3Unmet.push(gate.unmet);
  }
  if (report.refused) cond3Unmet.push("the run was refused before provider reads");
  if (blockers.length > 0) cond3Unmet.push(`${blockers.length} blocker(s) stand (see checks)`);
  const cond3Status: ReadinessCondition["status"] = cond3Unmet.length === 0 ? "PASS" : blockers.length > 0 ? "BLOCKED" : "UNVERIFIED";
  report.conditions = [
    {
      condition: 1, name: CONDITION_NAMES[1],
      status: release?.approved ? "PASS" : "UNVERIFIED",
      evidence: release?.approved ? `operator-supplied release-approval record${release.reference ? `: ${release.reference}` : ""}` : "no release-approval record supplied",
      reason: release?.approved
        ? "recorded from operator-supplied input; merged pull requests (PRs #17–#19) are migration evidence only and were NOT treated as specification/release approval"
        : "specification/release approval is a human act separate from code merges; it cannot be inferred from PRs #17–#19 being merged, and none was supplied",
    },
    {
      condition: 2, name: CONDITION_NAMES[2],
      status: rehearsal?.completed && rehearsal.scenariosPassed === rehearsal.scenariosTotal && rehearsal.scenariosTotal > 0 ? "PASS" : "BLOCKED",
      evidence: rehearsal?.completed ? `mocked rehearsal ${rehearsal.scenariosPassed}/${rehearsal.scenariosTotal} scenarios${rehearsal.reference ? ` (${rehearsal.reference})` : ""}` : "no completed rehearsal supplied",
      reason: rehearsal?.completed
        ? "durable storage and recovery are implemented (PR #17) and rehearsed end to end over mocked transports — SIMULATED evidence; it does not prove durable exactly-once provider execution"
        : "the recovery procedure is unrehearsed: run the mocked rehearsal before any commit can be considered",
    },
    {
      condition: 3, name: CONDITION_NAMES[3],
      status: cond3Status,
      evidence: provenance === "real" ? "this report, produced over the internally constructed guarded real-network transport" : "this report was produced over a caller-supplied (injected) transport",
      reason: cond3Unmet.length === 0
        ? "the exact commit was preflighted against the real tenant: structural real-network provenance, test-tenant attestation supplied, quote-origin binding established, provider identity verified, scheduled-change and scheduled-advance-invoice status established, request coherence validated, no blockers"
        : `Condition 3 is not met — ${cond3Unmet.join("; ")}`,
    },
    {
      condition: 4, name: CONDITION_NAMES[4],
      status: owner?.name && owner?.rehearsalReference ? "PASS" : "BLOCKED",
      evidence: owner?.name ? `operator-supplied owner record: ${owner.name}${owner.backupName ? ` (backup: ${owner.backupName})` : ""}` : "no reconciliation owner named",
      reason: owner?.name
        ? (owner.rehearsalReference ? "owner and backup recorded from operator-supplied input with a rehearsal reference; this software does not assign owners" : "an owner name without a completed-rehearsal reference does not satisfy the condition")
        : "software cannot name a reconciliation owner; the field stays blank until a human supplies one who has accepted the runbook",
    },
    {
      condition: 5, name: CONDITION_NAMES[5],
      status: authz?.granted ? "PASS" : "BLOCKED",
      evidence: authz?.granted ? `operator-supplied authorization record${authz.reference ? `: ${authz.reference}` : ""}` : "no commit authorization supplied",
      reason: authz?.granted
        ? "recorded from operator-supplied input; this software does not grant authorization and this report is not itself an authorization"
        : "the controlled test-site commit requires its own separate authorization; none was supplied and none can be inferred from this preflight",
    },
  ];
  report.overall = assessReadiness(report.conditions, blockers);

  const secrets = [input.apiKey ?? "", ...(input.redactionSecrets ?? [])];
  return sanitize(report, secrets) as PreflightReport;
}

// ---------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------

function finLine(f: FinancialQuantity): string {
  const amount = f.amountMinorUnits === null ? "not established" : `${f.amountMinorUnits} minor units (${f.currency ?? "currency unestablished"})`;
  return `- **${f.quantity}**: ${amount} — ${f.determinacy}, ${f.basis}; source: ${f.providerSource}.${f.missingData ? ` Missing: ${f.missingData}.` : ""}`;
}

export function renderPreflightMarkdown(report: PreflightReport): string {
  const lines: string[] = [];
  lines.push(`# Chargebee exact-commit preflight — ${report.identity.quoteId}`);
  lines.push("");
  lines.push(`Generated: ${report.generatedAt} · Transport origin: ${report.evidence.transportOrigin} · **Overall: ${report.overall}**`);
  if (report.refused) {
    lines.push("");
    lines.push("## REFUSED before provider reads");
    for (const r of report.refusalReasons) lines.push(`- ${r}`);
  }
  lines.push("");
  lines.push("## Identity and binding");
  lines.push(`- Provider/site: ${report.identity.provider} / ${report.identity.site} (approved for read-only validation: ${report.identity.siteApprovedForReadOnly ? "yes — per-run entry, configuration validation only" : "no"})`);
  lines.push(`- Tenant mode: ${report.identity.tenantModeEstablished}${report.identity.operatorAttestation?.attestedBy ? ` (attested by ${report.identity.operatorAttestation.attestedBy})` : ""}`);
  lines.push(`- Subscription: ${report.identity.subscriptionId ?? "unknown"} (synthetic-fixture designation: ${report.identity.syntheticFixtureDesignation ? "yes" : "no"})`);
  lines.push(`- Quote: ${report.identity.quoteId}, created ${report.identity.quoteCreatedAt ?? "?"}, expires ${report.identity.quoteExpiresAt ?? "?"}, status ${report.identity.quoteStatus ?? "?"}`);
  lines.push(`- Quote-origin binding (issuance record): ${report.durableReadiness.originBinding ?? "not applicable"}${report.durableReadiness.originSite ? ` (issued against site ${report.durableReadiness.originSite}, subscription ${report.durableReadiness.originSubscriptionId})` : ""}`);
  lines.push(`- Fingerprint: stored ${report.identity.storedFingerprint ?? "?"} · current ${report.identity.currentFingerprint ?? "?"} (resource_version ${report.identity.currentResourceVersion ?? "?"})`);
  lines.push(`- Action: ${report.identity.action ?? "?"} → target items ${report.identity.targetItems.map((i) => `${i.itemPriceId}×${i.quantity}`).join(", ") || "none recorded"}`);
  if (report.exactRequest) {
    lines.push("");
    lines.push("## Hypothetical mutation (the exact request a future commit would issue)");
    lines.push(`- Parameters (derived by the adapter's own request builder): replace_items_list=${report.exactRequest.replaceItemsList}, prorate=${report.exactRequest.prorate}, invoice_immediately=${report.exactRequest.invoiceImmediately}, change_option=${report.exactRequest.changeOption}`);
    lines.push(`- Idempotency key (original, stored): ${report.exactRequest.idempotencyKey}`);
    lines.push(`- Canonical request hash: ${report.exactRequest.requestHash}`);
    lines.push(`- Matches the authorized resulting item set (full multiset vs the independent re-read): ${report.durableReadiness.requestCoherence === true ? "yes" : report.durableReadiness.requestCoherence === false ? "NO — blocker" : "not established (no independent baseline)"}`);
    lines.push("");
    lines.push("```");
    lines.push(report.exactRequest.formEncodedBody);
    lines.push("```");
  }
  if (report.providerState) {
    lines.push("");
    lines.push("## Independent provider re-read");
    lines.push(`- Status ${report.providerState.subscriptionStatus ?? "?"} · currency ${report.providerState.currency ?? "?"} · item set complete: ${report.providerState.itemSetComplete ? "yes" : "NO"}`);
    lines.push(`- Scheduled changes: ${report.providerState.scheduledChanges} · scheduled advance invoices: ${report.providerState.scheduledAdvanceInvoices} (UNKNOWN means the read carried no such data — not an affirmative none)`);
    lines.push(`- Unbilled-charge visibility: ${report.providerState.unbilledChargeVisibility} · credit visibility: ${report.providerState.creditVisibility} (the read-only allowlist exposes no enumeration)`);
  }
  lines.push("");
  lines.push("## Financial report (four distinct quantities — never substituted for one another)");
  if (report.financials.length === 0) lines.push("- Not produced: the run was refused or the durable record was unusable.");
  for (const f of report.financials) lines.push(finLine(f));
  lines.push("");
  lines.push("## Side effects and limits");
  for (const s of report.sideEffects) lines.push(`- ${s}`);
  lines.push("");
  lines.push("## Checks");
  for (const c of report.checks) lines.push(`- [${c.status.toUpperCase()}] ${c.id}: ${c.detail}`);
  lines.push("");
  lines.push("## Observed transport");
  for (const cap of report.evidence.capabilities) lines.push(`- ${cap.capability}: ${cap.result} — ${cap.detail}`);
  lines.push(`- Running this preflight persisted no mutation intent (read-only store lookups only).`);
  lines.push("");
  lines.push("## Readiness (COMMIT-RECOVERY-SAFETY conditions)");
  for (const c of report.conditions) lines.push(`- Condition ${c.condition} — ${c.name}: **${c.status}** — ${c.reason} (evidence: ${c.evidence})`);
  lines.push("");
  lines.push(`## Overall: ${report.overall}`);
  lines.push(report.overall === "NO-GO"
    ? "NO-GO: at least one condition is unmet or a blocker stands. This report never issues GO; even a fully green preflight yields at most READY_FOR_HUMAN_REVIEW."
    : "READY_FOR_HUMAN_REVIEW: every condition is met on the evidence assembled here. The commit decision itself remains a human act requiring the separate authorization of condition 5.");
  return lines.join("\n");
}

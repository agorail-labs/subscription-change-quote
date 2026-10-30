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
 */

import { ChargebeeClient, formEncode, type HttpTransport } from "../chargebee-http.js";
import {
  buildChargebeeUpdateParams,
  chargebeeEffectWithDeterminacy,
  chargebeeSubscriptionFingerprint,
  interpretChargebeeEstimate,
  type CbSubscription,
} from "../chargebee-scq-adapter.js";
import { ChargebeeOperationNotAllowedError, createGuardedLiveTransport, isApprovedTestSite, isSyntheticSubscriptionId, summarizeTransportLog, type TransportLogEntry, type TransportSummary } from "./live-guard.js";
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
// Report types
// ---------------------------------------------------------------------------

export type PreflightTransportOrigin = "mocked" | "injected" | "real";

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
    subscriptionMatch: boolean | null;
    siteBindingOk: boolean | null;
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
  transport: HttpTransport;
  transportOrigin: PreflightTransportOrigin;
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

export async function runPreflight(input: PreflightInput): Promise<PreflightReport> {
  const now = input.now ?? (() => new Date());
  const env = input.env ?? {};
  const checks: PreflightCheck[] = [];
  const blockers: string[] = [];
  const check = (id: string, status: PreflightCheck["status"], detail: string) => {
    checks.push({ id, status, detail });
    if (status === "blocker") blockers.push(`${id}: ${detail}`);
  };

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
      requestCoherence: null,
      unresolvedAttempts: [],
      recordedReceiptPresent: false,
      wouldReplay: false,
      recoverySummary: null,
    },
    checks,
    blockers,
    transport: emptyTransportSummary(),
    evidence: { transportOrigin: input.transportOrigin, capabilities: [] },
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
    if (input.expectedSubscriptionId !== undefined) {
      report.durableReadiness.subscriptionMatch = stored.subscription_id === input.expectedSubscriptionId;
      check("subscription_binding", report.durableReadiness.subscriptionMatch ? "pass" : "blocker",
        report.durableReadiness.subscriptionMatch ? "stored subscription matches the expected subscription" : `stored subscription "${stored.subscription_id}" does not match the expected "${input.expectedSubscriptionId}"`);
    }
    if (input.expectedSite !== undefined) {
      report.durableReadiness.siteBindingOk = input.expectedSite === input.site;
      check("site_binding", report.durableReadiness.siteBindingOk ? "pass" : "blocker",
        report.durableReadiness.siteBindingOk ? "the run's site matches the expected site binding" : `the run's site "${input.site}" does not match the expected site binding "${input.expectedSite}"`);
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
      matchesStoredPreviewInput: true, // refined by the proposal coherence check below
      matchesStoredAttempts: null,
    };
    if (pii.idempotencyKey !== expectedKey) {
      check("idempotency_key_coherence", "blocker", `the stored idempotency key is not the key the adapter derives for this quote ("scq-<quoteId>") — the key has changed or was not adapter-issued`);
    } else {
      check("idempotency_key_coherence", "pass", "the stored idempotency key is the original adapter-derived key for this quote; it is reported, never regenerated");
    }
    // Proposal coherence: the stored target set must be exactly what the
    // recorded proposal authorizes.
    const changes = stored.proposal.changes;
    let coherent = changes.length === 1;
    if (coherent) {
      const change = changes[0];
      if (change.action === "CHANGE_QUANTITY") {
        const target = pii.items.find((i) => i.itemPriceId === change.itemId);
        coherent = target !== undefined && target.quantity === change.quantity;
      } else if (change.action === "CHANGE_PLAN") {
        coherent = change.offeringRef !== undefined && pii.items.some((i) => i.itemPriceId === change.offeringRef);
      }
    }
    report.exactRequest.matchesStoredPreviewInput = coherent;
    report.durableReadiness.requestCoherence = coherent;
    check("request_matches_proposal", coherent ? "pass" : "blocker",
      coherent ? "the stored target item set is exactly what the recorded proposal authorizes" : "the stored target item set diverges from the recorded proposal (item ids/quantities) — the request a commit would send is not the authorized change");
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
  if (!report.refused && stored && derivedParams) {
    const { transport: guarded, log } = createPreflightTransport(input.transport);
    const client = new ChargebeeClient({ site: input.site, apiKey: input.apiKey ?? "" }, guarded);
    try {
      const subRes = await client.getSubscription(stored.subscription_id);
      const sub = ((subRes.json as any)?.subscription ?? {}) as CbSubscription;
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

  // --- Capabilities, classified honestly ----------------------------------
  const okReads = !report.refused && report.providerState !== null && report.transport.mutatingCalls === 0;
  report.evidence.capabilities = [
    {
      capability: "exact-commit preflight evidence (this run)",
      // The pilot's classifier takes origin "real" | "injected"; a
      // mocked origin is fully decided by the mode argument, which
      // short-circuits before the origin is consulted.
      result: classifyRunCapability(input.transportOrigin === "real" ? "live" : "mocked", okReads, report.transport.totalCalls, input.transportOrigin === "injected" ? "injected" : "real"),
      detail: input.transportOrigin === "real"
        ? "real read-only transport: observed operations were allowlisted reads/estimates only"
        : `${input.transportOrigin} transport: this evidence validates procedure and code paths, never live provider behavior`,
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
      status: input.transportOrigin === "real" && !report.refused && blockers.length === 0 ? "PASS" : "UNVERIFIED",
      evidence: input.transportOrigin === "real" ? "this report, produced against the real test tenant's read-only endpoints" : `this report was produced over a ${input.transportOrigin} transport`,
      reason: input.transportOrigin === "real"
        ? (blockers.length === 0 ? "the exact commit was preflighted against the real tenant with no blockers" : "the real-tenant preflight found blockers (see checks)")
        : "no real-tenant preflight evidence exists: mocked/injected runs validate the procedure, not the actual commit against the actual tenant",
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
  lines.push(`- Fingerprint: stored ${report.identity.storedFingerprint ?? "?"} · current ${report.identity.currentFingerprint ?? "?"} (resource_version ${report.identity.currentResourceVersion ?? "?"})`);
  lines.push(`- Action: ${report.identity.action ?? "?"} → target items ${report.identity.targetItems.map((i) => `${i.itemPriceId}×${i.quantity}`).join(", ") || "none recorded"}`);
  if (report.exactRequest) {
    lines.push("");
    lines.push("## Hypothetical mutation (the exact request a future commit would issue)");
    lines.push(`- Parameters (derived by the adapter's own request builder): replace_items_list=${report.exactRequest.replaceItemsList}, prorate=${report.exactRequest.prorate}, invoice_immediately=${report.exactRequest.invoiceImmediately}, change_option=${report.exactRequest.changeOption}`);
    lines.push(`- Idempotency key (original, stored): ${report.exactRequest.idempotencyKey}`);
    lines.push(`- Canonical request hash: ${report.exactRequest.requestHash}`);
    lines.push(`- Matches stored preview input / proposal: ${report.exactRequest.matchesStoredPreviewInput ? "yes" : "NO — blocker"}`);
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

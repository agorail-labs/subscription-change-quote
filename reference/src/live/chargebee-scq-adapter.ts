// EXPERIMENTAL — SCQ Live Chargebee Validation (v1), NOT a production SDK.
//
// A Chargebee (Product Catalog 2.0) adapter for SCQ v0.6.1 backed by the
// real HTTP API shape (via chargebee-http.ts), isolated from the four
// simulator-backed adapters. It exists to test SCQ's claims against
// Chargebee's documented contract, not to be deployed.
//
// HONEST CAPABILITY POSTURE (see research/chargebee-live-v1/API-CONTRACT-AUDIT.md):
//   - No documented pinning mechanism (no proration_date equivalent, no
//     effective-date-pinned estimate token) exists that would let an
//     estimate be replayed verbatim at commit. Financial coverage is
//     therefore REVALIDATE, never EXACT, in this adapter. Requesting
//     EXACT is refused, naming the failing dimension.
//   - termEffect is UNKNOWN: term reset (force_term_reset / billing-period
//     change), contract terms, and scheduled-change interactions are not
//     deterministically derivable from the estimate/update responses.
//   - Scheduling taxonomy (Phase 2B, 2026-10-27 — canonical table in
//     spec/ERRATA-v0.6.1.md §6): IMMEDIATE in this adapter is
//     "Supported and tested" (mocked-transport tests; live execution
//     BLOCKED). TERM_END and DATE via update_for_items are
//     "Unsupported by the current adapter" (mechanisms documented but
//     deprecated). DATE/TERM_END via Ramps is "Site-feature-dependent
//     or early-access" (not implemented). Committed-term CANCEL is
//     "Site-feature-dependent" (Contract Terms; UNVERIFIED).
//   - Only IMMEDIATE is supported. Rationale (Phase 2A, Task 3 — kept
//     explicit so a future reader does not "fix" this by wiring the
//     deprecated parameters back in): scheduling on update_for_items
//     exists in current docs ONLY as deprecated-but-documented paths —
//     the `end_of_term` boolean / `change_option=end_of_term`, and
//     `change_option=specific_date` + `changes_scheduled_at` for a
//     future date (deprecated for scheduling; still documented for
//     backdating) — all deprecated in favor of Ramps. Ramps is Early
//     Access, site-gated, and a separate resource with its own
//     semantics (effective_from required, future-only, >=24h between
//     ramps, max 12 upcoming) that this experiment does not implement
//     and no site-specific validation has covered. Deprecated-but-
//     documented is therefore treated as NOT SUPPORTED by this
//     adapter: TERM_END and DATE are refused with UNSUPPORTED_CHANGE
//     before any provider call, not silently mapped onto a deprecated
//     parameter, and they stay refused until a Ramps implementation
//     is validated against a specific site's configuration.
//   - consistencyGuarantee is BEST_EFFORT: resource_version is a
//     millisecond timestamp useful for stale-state DETECTION, but no
//     documented compare-and-swap precondition exists on
//     update_for_items, so the check-then-mutate TOCTOU window is real.
//   - Commit is DISABLED unless liveCommitEnabled is explicitly true
//     (SCQ_LIVE_COMMIT_ENABLED=true in the demo/driver). When disabled,
//     commitChangeQuote refuses BEFORE any mutating call.
//   - The mutating call always sends invoice_immediately=false (charges
//     land as unbilled charges; no invoice collection is triggered by
//     default) and replace_items_list=true with the FULL intended item
//     list (without it, Chargebee's documented default is additive —
//     see the audit).
//   - Native idempotency: the mutating call carries
//     chargebee-idempotency-key = a deterministic key derived from the
//     SCQ quote id, so a legitimate retry of the SAME commit within
//     Chargebee's documented 30-minute window replays instead of
//     re-applying. SCQ's own receipt replay (checkIdempotentReplay) is
//     checked first and has no 30-minute limit, but it lives in the
//     in-memory QuoteStore: after a process restart it cannot prove
//     exactly-once anything (see LIMITATIONS-AND-GAPS.md).
//   - DURABILITY LIMIT (Phase 2A, Task 6 — do not soften): there is NO
//     indefinitely-safe idempotency in this stack. Receipt replay
//     depends on volatile in-memory state (lost on restart; T13 fails
//     closed rather than proving exactly-once), and the native
//     backstop expires after 30 minutes, rejects same-key/different-
//     parameters retries with 422, returns 409 while the original is
//     in flight, and CACHES 5xx responses under the key (a 5xx retry
//     needs a NEW key, which re-opens double-mutation risk unless
//     state is reconciled by re-reading first). A conforming live
//     deployment requires a durable transactional quote/receipt
//     store plus retention of the native key and exact request
//     parameters — neither is provided here.
//   - PHASE 3 (2026-10-27, live-verified on a Chargebee TEST site; see
//     ~/workspace/scq-live-validation-evidence/PHASE3-RUN-2026-10-27.md):
//     * The estimate endpoint requires the nested subscription[id]
//       field; a flat subscription_id is ignored and the call 400s.
//     * The field-GROUPED array encoding (subscription_items[field][i])
//       is the server's real format. The item-INDEXED shape
//       (subscription_items[i][field]) is silently ignored — HTTP 200
//       describing a different item set. (An Oct 27 interim report
//       concluded the opposite from a single 200; the isolation matrix
//       in Phase 3 reversed that conclusion. The grouped encoder was
//       never the bug.)
//     * The server VALIDATES quantity per item pricing model: changing
//       the quantity of the observed flat_fee plan item is rejected
//       (HTTP 400, "This param should not be sent for on_off addon
//       type" — Chargebee's wording for a non-quantity-priced item).
//       This adapter therefore refuses CHANGE_QUANTITY on flat_fee
//       items BEFORE any provider call, and never computes flat_fee
//       effects as price × quantity.
//     * Estimate responses are SPARSE in ways the pre-Phase-3 code did
//       not survive: a priced per_unit change returns ONLY
//       unbilled_charge_estimates + a subscription_estimate with NO
//       subscription_items and NO next_invoice_estimate; an unchanged
//       baseline returns ONLY next_invoice_estimate. Financial
//       interpretation below is per-source with recorded provenance,
//       never cross-mapped: next_invoice_estimate figures (total,
//       amount_due after credits, date) are NOT the immediate charge
//       and NOT the recurring amount, and SCQ v0.6.1 has no field that
//       can hold them — they are surfaced in providerMetadata only.
//     * FAIL-CLOSED RULE: when a financial dimension (immediate /
//       recurring) cannot be determined from an authoritative provider
//       field or a pricing-model-justified computation, the dimension
//       is ABSENT (never zero, never fabricated) and the quote is
//       REFUSED (QUOTE_NOT_DETERMINISTIC), because the mandatory
//       REVALIDATE acceptance envelope cannot be enforced on an
//       unknown dimension. The frozen core engine's
//       checkAcceptanceEnvelope treats absent dimensions as 0
//       (`?? 0`); this adapter never feeds it an effect with an absent
//       bounded dimension — it refuses first, at quote time and again
//       at commit revalidation time. (Protocol gap, recorded for
//       future spec work; the frozen engine is NOT modified here.)
//     * PR #4 REVIEW FIXES (2026-10-28, mocked — no live calls):
//       (a) a provider-stated subscription_estimate item list is used
//       as the recurring result ONLY after verifying it is the ENTIRE
//       intended item set (same items, no duplicates, matching
//       quantities, stated amount on every item) — a partial stated
//       list is never summed as the result; (b) the committed effect
//       is built from ACTUALS ONLY (the update response plus the
//       re-read post-commit state) — the pre-mutation estimate never
//       supplies committed figures, and an undeterminable actual
//       outcome (incomplete update response, post-commit items
//       without stated amounts, or a lost update response) fails
//       closed as INDETERMINATE with NO receipt recorded, because the
//       frozen receipt type cannot represent "committed but
//       financially unverified" and a missing resultingAmount fed to
//       reconciliation could read as a misleading OK. A consequence:
//       lost-response commits no longer yield receipts in this
//       adapter (state landing is verified and reported in the
//       error). Live commit remains disabled throughout.
//       [PR-7 SUPERSESSION, 2026-10-29: the v0.6.2 receipt type
//       (PR #8) DOES represent "committed but unverified" —
//       COMMITTED_UNVERIFIED + the UNVERIFIED reconciliation
//       variant — so this fail-closed-as-INDETERMINATE posture is
//       replaced by the outcome taxonomy in the PR-7 block below.
//       The "never feed reconciliation an unmeasured figure" rule
//       is unchanged: unverified receipts carry UNKNOWN dimensions,
//       never figures reconciliation could read as measured.]
//     * PR #4 FINAL REVIEW FIXES (2026-10-28, mocked — no live
//       calls): (c) an ABSENT post-commit subscription_items member
//       (or an explicitly empty collection, or an incomplete item
//       entry) makes the committed recurring dimension UNDETERMINED
//       — the earlier `?? []` default summed an absent collection
//       vacuously to a verified-looking recurringAmount of 0.
//       Explicitly observed zeros are preserved: an item whose
//       stated amount is literally 0 contributes a legitimate 0.
//       (d) A COMMITTED receipt is issued ONLY after the re-read
//       post-commit item set is verified to establish the intended
//       target set (same item_price_id multiset, equal quantities)
//       AND the actual financial outcome is determined. A provider
//       response of HTTP 200 that silently ignores or partially
//       applies the requested item change therefore yields an
//       indeterminate refusal and no receipt, even when the
//       financial figures would satisfy the envelope.
//   - PR-7 MIGRATION TO v0.6.2 SEMANTICS (2026-10-29, mocked
//     transports only — no live calls; see
//     research/chargebee-live-v062-migration.md):
//     * Every effect this adapter produces now carries the v0.6.2
//       determinacy record (DETERMINED / UNKNOWN per financial
//       dimension) and field-level provenance. NOT_APPLICABLE is
//       never asserted: the applicability table licenses it only
//       for CANCEL's immediate dimension, and this adapter does not
//       implement CANCEL. A determined zero is emitted present
//       ({ net: 0 } / resultingAmount 0) — including on committed
//       effects, where the pre-migration code dropped a zero net
//       from the effect entirely.
//     * Snapshots price recurring STRICTLY from provider-stated
//       item amounts and label the result (CORE-7
//       recurringAmountState). The pre-migration fallback
//       (unit_price × quantity, absent collection ⇒ 0) fabricated
//       figures — for a flat_fee item it was also arithmetically
//       wrong — and is removed: an absent items member, or any
//       item without a stated amount, yields NO recurringAmount
//       and state UNKNOWN.
//     * Commit outcomes use the v0.6.2 taxonomy (CORE-5):
//       COMMITTED_AND_VERIFIED (receipt status COMMITTED;
//       reconciliation OK, or VIOLATED where independently
//       attributable evidence contradicts the quote — Decision
//       D3), COMMITTED_UNVERIFIED (typed receipt, UNKNOWN
//       dimensions honestly labeled — this closes protocol
//       Defect 3), INDETERMINATE (no receipt; the outcome is
//       recorded in the store and any later commit attempt on the
//       quote is refused before any read or mutation — no blind
//       retry), CONFIRMED_NON_EXECUTION (restricted, per the PR-7
//       review corrections L2/L3, to DEMONSTRABLE pre-effect
//       failures — an HTTP 400 carrying a specifically allowlisted
//       documented validation api_error_code (see
//       PRE_EFFECT_VALIDATION_ERROR_CODES); status 400 alone is
//       not proof, since Chargebee also assigns 400 to payment and
//       operation-stage failures. A blanket 4xx rule is
//       unsupported: 408 timeouts, ambiguous 429s, unclassified
//       4xx, non-allowlisted or code-less 400s, and 422 idempotency
//       conflicts carry no proof the request was never applied and
//       classify as INDETERMINATE). HTTP 200 alone never verifies: the
//       intended item set must be established by an independent
//       post-commit re-read, the financial actuals must be
//       established (immediate from the mutating call's own
//       response; recurring from the re-read items' stated
//       amounts), and attribution must close (below).
//     * ATTRIBUTION (PR #14 doctrine Z1–Z3, adapted to the real
//       API's surfaces): the mutating call's response is bound to
//       this commit by the HTTP exchange itself and by the
//       deterministic native idempotency key (same key + different
//       parameters is a provider 422; a replayed response IS the
//       original operation's response). The response's subscription
//       fingerprint must equal the independent re-read's
//       fingerprint — the bracket — for the observed state to be
//       attributed to this commit alone. A broken bracket (an
//       intervening write between the mutating call and the
//       re-read, detectable because resource_version moves on
//       every write) caps the outcome at COMMITTED_UNVERIFIED and,
//       per Z3, records NO recurring figure for this commit: the
//       observed level is third-party-influenced and survives only
//       as unattributed context (the resulting snapshot and the
//       reconciliation reason). The response's own immediate actual
//       survives a broken bracket — its scope is this operation,
//       exactly as PR #15's bound-artifact immediate did. The
//       bracket is fingerprint equality (resource_version when the
//       payloads carry it), i.e. DETECTION within resource_version's
//       millisecond resolution — it is NOT a provider-enforced
//       compare-and-swap, NOT a durable operation identity, and it
//       cannot see a write that lands between this commit's
//       validation read and the mutating call (that window is
//       mitigated, as before, by the pre-mutation envelope gate and
//       post-commit reconciliation reporting — see test13 T08/T09).
//       Chargebee offers NO operation-level financial read-back (no
//       unbilled-charge retrieval in this adapter's validated
//       surface), so a lost response's immediate actual is
//       UNRECOVERABLE from provider data. [PR-7 REVIEW CORRECTION
//       L1, 2026-10-29: as first delivered, this adapter treated a
//       re-read showing the intended set in effect on a moved
//       fingerprint as establishing the landing, and recorded a
//       COMMITTED_UNVERIFIED receipt. The review established that
//       this proves only that the intended STATE is in effect, not
//       that THIS request landed it — an independent actor applying
//       the same item set is observationally indistinguishable
//       (test26-12b), an idempotency key sent with a lost request
//       does not establish execution, and no operation-bound
//       provider landing signal was identified in Chargebee's
//       validated surface. LOST-response outcomes are therefore
//       INDETERMINATE whether or not the intended set is observed:
//       outcome recorded (observed state retained as diagnostic
//       context), NO receipt, blind retry refused.
//       COMMITTED_UNVERIFIED is reserved for cases where a response
//       WAS received — including a native idempotency REPLAY, whose
//       returned response is the original operation's own response
//       — and landing is thereby established while verification
//       remains incomplete.]
//     * Live commit remains DISABLED by default throughout; the
//       commit path is exercised only against injected mocked
//       transports. No real-network mutation is dispatched by any
//       test or by the pilot harness.
//   - SCHEDULED CHANGES / MANDATORY ADDONS (Phase 2A recovery audit):
//     a forward update_for_items call can delete or override a
//     subscription's pre-existing scheduled changes (documented
//     product behavior: a new change overrides the scheduled one;
//     even unrelated subscription changes can remove a scheduled
//     cancellation), and NOTHING in this adapter snapshots or
//     restores them. Likewise the adapter sends no
//     `mandatory_items_to_remove`, so mandatory addons auto-attached
//     to a plan are outside its item-set guarantee. See
//     research/chargebee-live-v1/RECOVERY-AUDIT.md before treating
//     any forward-then-reverse procedure as a complete recovery.

import crypto from "node:crypto";
import {
  SCQError,
  type CommercialEffect,
  type CommittedFigureSource,
  type DimensionState,
  type GuaranteeCoverage,
  type MutationOutcome,
  type ProviderCapabilities,
  type ReconciliationResult,
  type SubscriptionChangeProposal,
  type SubscriptionChangeQuote,
  type SubscriptionChangeReceipt,
  type SubscriptionProvider,
  type SubscriptionSnapshot,
} from "../core/types.js";
import {
  checkIdempotentReplay,
  determinacyOf,
  enforceEffectiveIntent,
  enforceGuaranteeRequest,
  reconcileCommittedEffect,
  resolveGuaranteeMode,
  validateCommit,
  checkAcceptanceEnvelope,
} from "../core/scq-engine.js";
import { QuoteStore, type StoredQuote } from "../store/quote-store.js";
import { ChargebeeClient, ChargebeeHttpError } from "./chargebee-http.js";

const QUOTE_TTL_MS = 5 * 60 * 1000;

/**
 * PR-7 review correction L3: the ONLY Chargebee api_error_codes for
 * which an HTTP 400 on the mutating call establishes
 * CONFIRMED_NON_EXECUTION. HTTP status 400 alone is NOT evidence of
 * pre-effect rejection: Chargebee's official error-handling
 * documentation (apidocs chargebee.com/docs/api/error-handling)
 * assigns 400 to payment errors (type `payment`) and other
 * operation-stage failures as well as to request-validation errors.
 * A 400 qualifies here only when its api_error_code is one of these
 * specifically documented REQUEST-VALIDATION codes — both are
 * grouped by that documentation under "Invalid Request Errors"
 * (type `invalid_request`, HTTP 400), and the documentation states
 * that API calls fail at the first error encountered while
 * VALIDATING them, i.e. before the operation is processed:
 *
 *   - `param_required`    — a required parameter is absent; the
 *                           request cannot enter processing at all.
 *   - `param_wrong_value` — a parameter value does not meet its
 *                           required specification; rejected at
 *                           request validation.
 *
 * Both codes describe defects in THIS request's own shape/values,
 * so neither carries prior-operation ambiguity: an idempotency key
 * previously consumed by a processed request surfaces as HTTP 422
 * (`duplicate_request` / `unable_to_process_request`), never as one
 * of these 400 validation codes.
 *
 * Deliberately EXCLUDED (they fail closed to INDETERMINATE):
 *   - payment-type 400s (`payment_processing_failed`,
 *     `payment_method_verification_failed`, `payment_intent_invalid`,
 *     `payment_intent_invalid_amount`, `payment_method_not_present`,
 *     `payment_gateway_currency_incompatible`): payment/operation
 *     stage — the provider may already have applied subscription or
 *     ancillary financial effects;
 *   - the generic `invalid_request` code: Chargebee documents it as
 *     a generic code whose handling is recommended only in
 *     combination with the `param` attribute, so the code alone
 *     does not specifically establish a validation-stage rejection;
 *   - state/configuration-dependent 400s (`duplicate_entry`,
 *     `resource_limit_exhausted`, `resource_limit_exceeded`,
 *     `configuration_incompatible`): not pure request validation;
 *   - any unknown or MISSING api_error_code: no documented basis
 *     exists for placing the failure at the validation stage.
 */
const PRE_EFFECT_VALIDATION_ERROR_CODES: ReadonlySet<string> = new Set([
  "param_required",
  "param_wrong_value",
]);

const COVERAGE: GuaranteeCoverage = {
  immediateFinancialEffect: "REVALIDATE",
  recurringFinancialEffect: "REVALIDATE",
  termEffect: "UNKNOWN",
  effectiveAt: "REVALIDATE",
};

type LivePreviewInput = {
  items: Array<{ itemPriceId: string; quantity: number }>;
  idempotencyKey: string;
};

type CbSubscription = {
  id: string;
  status: string;
  currency_code?: string;
  resource_version?: number;
  current_term_start?: number;
  current_term_end?: number;
  next_billing_at?: number;
  has_scheduled_changes?: boolean;
  has_scheduled_advance_invoices?: boolean;
  subscription_items?: Array<{ item_price_id: string; quantity: number; unit_price?: number; amount?: number; free_quantity?: number }>;
};

function fingerprintOf(sub: CbSubscription): string {
  if (typeof sub.resource_version === "number") return `rv:${sub.resource_version}`;
  const material = JSON.stringify({
    status: sub.status,
    items: (sub.subscription_items ?? []).map((i) => ({ p: i.item_price_id, q: i.quantity, u: i.unit_price })),
    termEnd: sub.current_term_end ?? null,
    sched: sub.has_scheduled_changes ?? false,
  });
  return "hash:" + crypto.createHash("sha256").update(material).digest("hex").slice(0, 16);
}

/**
 * The strict recurring level of a provider item list: the sum of the
 * items' provider-STATED amounts, or undefined when the level cannot
 * be established — the collection member is absent, or any entry is
 * incomplete (missing item_price_id, quantity, or a stated amount).
 * An explicitly EMPTY collection is a provider-stated zero level
 * (the complete list, with nothing on it). Nothing is ever
 * reconstructed as unit_price × quantity: that multiplication is
 * unjustified in general and arithmetically wrong for flat_fee.
 * Shared by snapshot construction and committed-effect establishment.
 */
function strictRecurringFromItems(
  rawItems: CbSubscription["subscription_items"],
): { amount: number } | { undetermined: string } {
  if (!Array.isArray(rawItems)) {
    return { undetermined: "the payload carries no subscription_items member — an absent collection is undetermined, never a verified zero" };
  }
  if (rawItems.length === 0) return { amount: 0 };
  if (!rawItems.every((i) => typeof i.item_price_id === "string" && typeof i.quantity === "number" && typeof i.amount === "number")) {
    return { undetermined: "a subscription item is incomplete — missing item_price_id, quantity, or a stated amount" };
  }
  return { amount: rawItems.reduce((s, i) => s + (i.amount as number), 0) };
}

function snapshotFrom(sub: CbSubscription): SubscriptionSnapshot {
  const items = sub.subscription_items ?? [];
  // v0.6.2 (PR-7, CORE-7): the snapshot's recurring figure is priced
  // STRICTLY from provider-stated amounts and labeled with its
  // determinacy. Pre-migration this summed `amount ?? unit_price ×
  // quantity` and read an absent collection as 0 — a fabricated
  // figure (and, for flat_fee, a wrong one). Now an unestablishable
  // level is OMITTED and labeled UNKNOWN instead.
  const strict = strictRecurringFromItems(sub.subscription_items);
  const recurringAmount = "amount" in strict ? strict.amount : undefined;
  return {
    id: sub.id,
    version: fingerprintOf(sub),
    status: sub.status === "cancelled" ? "canceled" : sub.status,
    // For the live API, the stable per-item identifier available in every
    // payload is item_price_id; SCQ itemId in this adapter IS the
    // item_price_id. (Simulator adapters use synthetic line ids instead.)
    items: items.map((i) => ({ id: i.item_price_id, offeringRef: i.item_price_id, quantity: i.quantity })),
    billing: {
      currency: sub.currency_code ?? "USD",
      ...(recurringAmount !== undefined ? { recurringAmount } : {}),
      recurringAmountState: (recurringAmount !== undefined ? "DETERMINED" : "UNKNOWN") as DimensionState,
      cadence: "MONTHLY",
      nextBillingAt: sub.next_billing_at ? new Date(sub.next_billing_at * 1000).toISOString() : undefined,
    },
    term: { commitmentUntil: "UNKNOWN", autoRenew: undefined },
  };
}

/** Authoritative item-price metadata (GET /item_prices/{id}). */
export type CbItemPriceInfo = {
  itemPriceId: string;
  pricingModel?: string;
  /** Catalog price in minor units. Subscription-level unit_price overrides take precedence for existing items. */
  price?: number;
  freeQuantity?: number;
  itemType?: string;
};

export type InterpretedEstimate = {
  effect: CommercialEffect;
  /** Per-dimension provenance: which provider field (or justified computation) each SCQ value came from, or why it is absent. */
  provenance: {
    immediate: string;
    recurring: string;
  };
  /**
   * next_invoice_estimate facts, carried SEPARATELY because SCQ v0.6.1
   * has no CommercialEffect field whose semantics match them: the total
   * is a next-cycle figure (not the recurring subscription amount —
   * lines can be missing), amount_due is net of credits (credits do not
   * reduce the underlying price), and neither is an immediate charge.
   */
  nextInvoice?: {
    total?: number;
    amountDue?: number;
    creditsApplied?: number;
    /** ISO date of the next invoice, from next_invoice_estimate.date (epoch seconds at the provider). */
    date?: string;
    lineCount: number;
  };
};

type ItemState = { itemPriceId: string; quantity: number; unitPrice?: number; amount?: number; freeQuantity?: number };

/**
 * Effective free_quantity for a per_unit item, from authoritative data
 * only: (1) the subscription item's explicit free_quantity; (2) solved
 * arithmetically from the item's own amount = (quantity − fq) ×
 * unit_price when that yields an exact non-negative integer; (3) the
 * catalog free_quantity when the observed amount is exactly consistent
 * with it. Otherwise undefined (terms incomplete — fail closed).
 */
function resolveFreeQuantity(item: ItemState, catalog?: CbItemPriceInfo): number | undefined {
  if (typeof item.freeQuantity === "number") return item.freeQuantity;
  const up = item.unitPrice;
  if (typeof up === "number" && up > 0 && typeof item.amount === "number") {
    const fq = item.quantity - item.amount / up;
    if (Number.isInteger(fq) && fq >= 0) return fq;
    if (typeof catalog?.freeQuantity === "number" && item.amount === Math.max(0, item.quantity - catalog.freeQuantity) * up) return catalog.freeQuantity;
  }
  return undefined;
}

/**
 * Contribution of ONE item to a recurring amount, or undefined when it
 * cannot be justified. Rules (Phase 3, Task 3):
 *   - unchanged item: its observed subscription `amount` (provider-stated).
 *   - flat_fee: the fixed unit price ONCE — quantity is never multiplied.
 *   - per_unit: (quantity − free_quantity) × unit price, only when unit
 *     price and free_quantity are both known from authoritative data.
 *   - tiered / volume / stairstep / anything else: undefined — no
 *     computation is justified; only a provider-stated amount may be used.
 */
function itemRecurringContribution(
  target: { itemPriceId: string; quantity: number },
  current: ItemState | undefined,
  model: CbItemPriceInfo | undefined,
): number | undefined {
  const changed = !current || current.quantity !== target.quantity || current.itemPriceId !== target.itemPriceId;
  if (!changed && current) return typeof current.amount === "number" ? current.amount : undefined;
  const pricingModel = model?.pricingModel;
  if (pricingModel === "flat_fee") {
    // The fixed price: the subscription's own unit_price for an existing
    // item, else the catalog price for a newly targeted item price.
    const fixed = current?.unitPrice ?? model?.price;
    return typeof fixed === "number" ? fixed : undefined;
  }
  if (pricingModel === "per_unit") {
    const unitPrice = current?.unitPrice ?? model?.price;
    if (typeof unitPrice !== "number") return undefined;
    // For a quantity change on an existing item, resolve fq from the
    // CURRENT item state (its amount/price/quantity are observed facts).
    const fq = current ? resolveFreeQuantity(current, model) : model?.freeQuantity;
    if (typeof fq !== "number") return undefined;
    return Math.max(0, target.quantity - fq) * unitPrice;
  }
  return undefined;
}

type StatedItem = { item_price_id: string; quantity: number; unit_price?: number; amount?: number };

/**
 * Verifies that a provider-stated subscription_estimate item list
 * represents the ENTIRE intended item set (PR #4 review fix): the
 * same item_price_id multiset as the intended target items — no
 * missing item, no extra item, no duplicate entry — with matching
 * quantities per item and a numeric stated `amount` on EVERY item.
 * Only a list passing this check may be summed as the complete
 * resulting recurring amount. A nonempty list that fails it is a
 * PARTIAL view of the result (the provider may state only the items
 * it repriced): its partial sum must never be reported as the
 * resulting amount, so the caller falls through to the per-item
 * pricing-model computation instead.
 */
function statedItemsAreComplete(stated: StatedItem[], targetItems: Array<{ itemPriceId: string; quantity: number }>): boolean {
  if (stated.length === 0 || stated.length !== targetItems.length) return false;
  const targetQty = new Map<string, number>();
  for (const t of targetItems) {
    if (targetQty.has(t.itemPriceId)) return false; // the intended set itself must not carry duplicates
    targetQty.set(t.itemPriceId, t.quantity);
  }
  const seen = new Set<string>();
  for (const s of stated) {
    if (typeof s.amount !== "number") return false;
    if (seen.has(s.item_price_id)) return false; // duplicate stated entry
    seen.add(s.item_price_id);
    if (targetQty.get(s.item_price_id) !== s.quantity) return false; // missing/extra item, or quantity mismatch
  }
  return seen.size === targetQty.size;
}

/**
 * Compares an ACTUAL provider item list (a re-read subscription's
 * items) against the intended target item set and returns
 * human-readable mismatch descriptions — item ids and quantities
 * only, never payloads. An empty result means the actual set
 * establishes the intended set EXACTLY: the same item_price_id
 * multiset (no missing item, no extra item, no duplicate entry)
 * with equal quantities per item. Used post-commit (PR #4 final
 * review, Fix B) to verify that a successful update_for_items
 * response actually landed the intended mutation before any
 * COMMITTED receipt is issued, and in the lost-response path to
 * decide whether the intended set landed. Incomplete actual entries
 * (missing id or quantity) are mismatches, never silently skipped.
 */
function itemSetMismatches(
  actual: Array<{ item_price_id?: unknown; quantity?: unknown }>,
  targetItems: Array<{ itemPriceId: string; quantity: number }>,
): string[] {
  const mismatches: string[] = [];
  const targetQty = new Map<string, number>();
  for (const t of targetItems) targetQty.set(t.itemPriceId, t.quantity);
  const actualCount = new Map<string, number>();
  const actualQty = new Map<string, number>();
  for (const a of actual) {
    if (typeof a.item_price_id !== "string" || typeof a.quantity !== "number") {
      mismatches.push("an actual item entry is incomplete (missing item_price_id or quantity)");
      continue;
    }
    actualCount.set(a.item_price_id, (actualCount.get(a.item_price_id) ?? 0) + 1);
    actualQty.set(a.item_price_id, a.quantity);
  }
  for (const [id, count] of actualCount) {
    if (count > 1) mismatches.push(`duplicate entries for item ${id} (×${count})`);
  }
  for (const [id, qty] of targetQty) {
    if (!actualCount.has(id)) { mismatches.push(`missing item ${id} (intended quantity ${qty})`); continue; }
    if (actualCount.get(id) === 1 && actualQty.get(id) !== qty) {
      mismatches.push(`quantity mismatch for item ${id}: intended ${qty}, actual ${actualQty.get(id)}`);
    }
  }
  for (const [id, qty] of actualQty) {
    if (!targetQty.has(id)) mismatches.push(`extra item ${id} (actual quantity ${qty})`);
  }
  return mismatches;
}

/**
 * Interprets a Chargebee update-estimate response into an SCQ
 * CommercialEffect with per-dimension provenance. Sources are kept
 * strictly separate (Phase 3, Task 2):
 *   - immediate: invoice_estimate.total when present; else the SUM of
 *     unbilled_charge_estimates[].amount when that member is present
 *     (an empty array is a provider-stated zero); in both cases minus
 *     credit_note_estimates[].total (member must be present for the net
 *     to be final). Absent sources => immediate ABSENT, never zero.
 *     Member ELEMENTS are held to the same standard: an unbilled-charge
 *     element without a numeric `amount`, or a credit-note element
 *     without a numeric `total`, makes the dimension ABSENT rather
 *     than silently counting that element as 0.
 *     SEMANTICS of the resulting figure (what SCQ `immediate` means
 *     for this adapter): the net obligation the change itself incurs
 *     at effect time. Sourced from unbilled_charge_estimates, it is a
 *     newly incurred UNBILLED obligation — under this adapter's commit
 *     parameters (invoice_immediately=false) it is NOT invoiced at
 *     commit, NOT a payment due at commit, and NOT cash collected; it
 *     is invoiced at the next billing cycle. The ESTIMATE itself
 *     incurs nothing: this obligation would be incurred ONLY upon a
 *     successful commit that actually applies the change. An
 *     estimate-only run (like the Phase 3 live experiment) creates
 *     no obligation and no mutation. Sourced from
 *     invoice_estimate.total, it is the provider's estimate of the
 *     total of the invoice that WOULD be issued for the change — an
 *     estimated invoice total, still not a payment or a collection.
 *   - recurring: subscription_estimate.subscription_items amounts when
 *     the provider states them AND the stated list verifies as the
 *     ENTIRE intended item set (see statedItemsAreComplete — a
 *     partial stated list is never summed as the result); else a
 *     per-item computation in which every item's contribution must be
 *     justified (see itemRecurringContribution). Any unjustifiable
 *     item => recurring ABSENT. next_invoice_estimate is NEVER used
 *     for recurring.
 *   - previousAmount: the sum of the CURRENT subscription items'
 *     provider-stated amounts, when all are present.
 */
export function interpretChargebeeEstimate(
  estimate: any,
  ctx: {
    currency: string;
    currentItems: ItemState[];
    targetItems: Array<{ itemPriceId: string; quantity: number }>;
    priceInfo: Map<string, CbItemPriceInfo>;
  },
): InterpretedEstimate {
  const provenance = { immediate: "absent", recurring: "absent" };
  const effect: CommercialEffect = {};

  // --- immediate ---
  const inv = estimate?.invoice_estimate;
  const unbilled = estimate?.unbilled_charge_estimates as Array<{ amount?: number }> | undefined;
  const creditNotes = estimate?.credit_note_estimates as Array<{ total?: number }> | undefined;
  let base: number | undefined;
  let baseSource = "";
  let baseBlocked = "";
  if (inv && typeof inv.total === "number") { base = inv.total; baseSource = "invoice_estimate.total"; }
  else if (Array.isArray(unbilled)) {
    // Strict member-element rule: an element without a numeric amount
    // is NOT a zero — it makes the sum undeterminable (absent).
    if (unbilled.every((u) => typeof u.amount === "number")) {
      base = unbilled.reduce((s, u) => s + (u.amount as number), 0);
      baseSource = "sum(unbilled_charge_estimates[].amount)";
    } else {
      baseBlocked = "an unbilled_charge_estimates element lacks a numeric amount — the sum cannot be determined (an element is never counted as 0)";
    }
  }
  if (base !== undefined) {
    if (!Array.isArray(creditNotes)) {
      provenance.immediate = `absent: ${baseSource} present but credit_note_estimates member absent — net cannot be finalized`;
    } else if (!creditNotes.every((c) => typeof c.total === "number")) {
      provenance.immediate = "absent: a credit_note_estimates element lacks a numeric total — the net cannot be finalized (an element is never counted as 0)";
    } else {
      const credits = creditNotes.reduce((s, c) => s + (c.total as number), 0);
      const net = base - credits;
      effect.immediate = { charge: net > 0 ? net : undefined, credit: net < 0 ? -net : undefined, net };
      provenance.immediate = `${baseSource} − sum(credit_note_estimates[].total)`;
    }
  } else {
    provenance.immediate = `absent: ${baseBlocked || "neither invoice_estimate nor unbilled_charge_estimates present in the estimate"}`;
  }

  // --- recurring ---
  const subEstItems = estimate?.subscription_estimate?.subscription_items as StatedItem[] | undefined;
  let resulting: number | undefined;
  // A stated list that is present but fails completeness verification
  // is recorded in the computed path's provenance when that path also
  // cannot determine the amount — a partial stated sum is never used.
  const statedUnverified = Array.isArray(subEstItems) && subEstItems.length > 0 && !statedItemsAreComplete(subEstItems, ctx.targetItems)
    ? " (a provider-stated item list was present but did NOT verify as the complete intended item set — its partial sum was not used)"
    : "";
  if (Array.isArray(subEstItems) && statedItemsAreComplete(subEstItems, ctx.targetItems)) {
    // Provider-stated path: the stated list verifies as the ENTIRE
    // intended item set (same items, no duplicates, matching
    // quantities) and EVERY item carries its own stated amount. An
    // item with only a unit_price is NOT summed as unit_price ×
    // quantity here — that multiplication is justified only per
    // pricing model (a flat_fee item would be overstated), so such a
    // payload falls through to the per-item computation below.
    resulting = subEstItems.reduce((s, i) => s + (i.amount as number), 0);
    provenance.recurring = "subscription_estimate.subscription_items[].amount (provider-stated; verified complete against the intended item set)";
  } else {
    const currentById = new Map(ctx.currentItems.map((i) => [i.itemPriceId, i]));
    let sum = 0;
    let ok = true;
    for (const t of ctx.targetItems) {
      const c = itemRecurringContribution(t, currentById.get(t.itemPriceId), ctx.priceInfo.get(t.itemPriceId));
      if (c === undefined) { ok = false; break; }
      sum += c;
    }
    if (ok) {
      resulting = sum;
      provenance.recurring = "computed per item: unchanged items at provider-stated amount; flat_fee at fixed price (quantity never multiplied); per_unit at (quantity − free_quantity) × unit price — all terms from the subscription payload and item-price metadata" + statedUnverified;
    } else {
      provenance.recurring = "absent: no complete verified provider-stated subscription_estimate item list, and at least one target item's contribution cannot be justified from its pricing model/terms" + statedUnverified;
    }
  }
  const previous = ctx.currentItems.every((i) => typeof i.amount === "number")
    ? ctx.currentItems.reduce((s, i) => s + (i.amount ?? 0), 0)
    : undefined;
  if (resulting !== undefined) {
    effect.recurring = { resultingAmount: resulting, currency: ctx.currency, ...(previous !== undefined ? { previousAmount: previous } : {}) };
  }

  // --- next invoice (metadata only; never mapped into the effect) ---
  let nextInvoice: InterpretedEstimate["nextInvoice"];
  const ni = estimate?.next_invoice_estimate;
  if (ni && typeof ni === "object") {
    nextInvoice = {
      total: typeof ni.total === "number" ? ni.total : undefined,
      amountDue: typeof ni.amount_due === "number" ? ni.amount_due : undefined,
      creditsApplied: typeof ni.credits_applied === "number" ? ni.credits_applied : undefined,
      date: typeof ni.date === "number" ? new Date(ni.date * 1000).toISOString() : undefined,
      lineCount: Array.isArray(ni.line_items) ? ni.line_items.length : 0,
    };
  }
  return { effect, provenance, nextInvoice };
}

/**
 * v0.6.2 (PR-7): attaches the three-state determinacy record and the
 * field-level provenance to an interpreted estimate effect. A
 * dimension is DETERMINED exactly when the interpretation
 * established a finite figure for it (a present zero included);
 * otherwise UNKNOWN. This adapter asserts NOT_APPLICABLE for no
 * dimension: the v0.6.2 applicability table licenses it only for
 * CANCEL's immediate dimension, and CANCEL is not implemented here.
 * `committedSource` is set only for commit-side roles (the
 * revalidated gate effect); quote-side effects assert none.
 */
function withDeterminacy(
  interpreted: InterpretedEstimate,
  opts: { committedSource?: CommittedFigureSource } = {},
): CommercialEffect {
  const effect = interpreted.effect;
  const immediateDetermined = typeof effect.immediate?.net === "number" && Number.isFinite(effect.immediate.net);
  const recurringDetermined = typeof effect.recurring?.resultingAmount === "number" && Number.isFinite(effect.recurring.resultingAmount);
  effect.determinacy = {
    immediateFinancialEffect: immediateDetermined ? "DETERMINED" : "UNKNOWN",
    recurringFinancialEffect: recurringDetermined ? "DETERMINED" : "UNKNOWN",
  };
  effect.provenance = {
    immediate: interpreted.provenance.immediate,
    recurring: interpreted.provenance.recurring,
    ...(opts.committedSource !== undefined ? { committedSource: opts.committedSource } : {}),
  };
  return effect;
}

/**
 * v0.6.2 (PR-7, M2 pattern): the fail-closed determinacy gate for
 * commits. The frozen v0.6.1 acceptance envelope coerces absent
 * figures to 0, so an effect whose bounded dimensions are not
 * DETERMINED must never reach the envelope — and never reach the
 * mutating call. (This replaces the pre-migration presence checks,
 * which encoded the same rule without the determinacy record.)
 */
function assertEffectDeterminateForCommit(effect: CommercialEffect, role: "quoted" | "revalidated"): void {
  const states = determinacyOf(effect);
  const unknown = (Object.entries(states) as Array<[string, DimensionState]>).filter(([, s]) => s === "UNKNOWN").map(([d]) => d);
  if (unknown.length > 0) {
    throw new SCQError(
      "QUOTE_NOT_DETERMINISTIC",
      `The ${role} effect does not determine every financial dimension the acceptance envelope bounds ` +
        `(UNKNOWN: ${unknown.join(", ")}), so the envelope cannot be enforced. No mutation was performed.`,
      { blocked: "ENVELOPE_UNENFORCEABLE_ON_UNKNOWN_DETERMINACY", role, determinacy: states, provenance: effect.provenance },
    );
  }
}

/**
 * The mutating call's OWN actual immediate figure, from its response
 * only: the invoice total when the response carries an invoice,
 * else the sum of its unbilled_charges member when that member is
 * present and complete (a present member states its total, including
 * a genuine 0). Absent or incomplete => undefined (UNDETERMINED).
 * This response is provider data returned BY the mutating call for
 * THIS operation — never the pre-mutation estimate.
 */
function committedImmediateFromResponse(updateJson: any): { net: number; source: string } | { undetermined: string } {
  const invoiceTotal = updateJson?.invoice?.total;
  if (typeof invoiceTotal === "number" && Number.isFinite(invoiceTotal)) {
    return { net: invoiceTotal, source: "the mutating call's response invoice.total (provider actual for this operation)" };
  }
  const unbilledMember = updateJson?.unbilled_charges as Array<{ amount?: number }> | undefined;
  if (Array.isArray(unbilledMember)) {
    if (unbilledMember.every((u) => typeof u.amount === "number" && Number.isFinite(u.amount))) {
      return { net: unbilledMember.reduce((s, u) => s + (u.amount as number), 0), source: "the mutating call's response unbilled_charges (provider actual for this operation)" };
    }
    return { undetermined: "immediate (the update response's unbilled_charges member is incomplete — an element lacks a numeric amount)" };
  }
  return { undetermined: "immediate (the update response carried neither an invoice total nor an unbilled_charges member)" };
}

/** Shapes a determined immediate net into the CommercialEffect form, preserving a determined zero as present. */
function immediateEffect(net: number): { charge?: number; credit?: number; net: number } {
  return { charge: net > 0 ? net : undefined, credit: net < 0 ? -net : undefined, net };
}

export type ChargebeeLiveAdapterOptions = {
  /** Default false. When false, commitChangeQuote refuses before any mutating call. */
  liveCommitEnabled?: boolean;
  now?: () => Date;
};

export class ChargebeeLiveAdapter implements SubscriptionProvider {
  private now: () => Date;
  constructor(
    private client: ChargebeeClient,
    private store: QuoteStore,
    private opts: ChargebeeLiveAdapterOptions = {},
  ) { this.now = opts.now ?? (() => new Date()); }

  getCapabilities(): ProviderCapabilities {
    const caps = { guaranteeCoverage: { ...COVERAGE }, supportedEffectiveIntents: ["IMMEDIATE"] as Array<"IMMEDIATE"> };
    return {
      quoteCapabilities: {
        CHANGE_QUANTITY: caps,
        CHANGE_PLAN: caps,
        // CHANGE_CADENCE and CANCEL are refused by this experimental
        // adapter (term-reset and cancel_for_items semantics are outside
        // the validated scope) — they are intentionally absent here
        // rather than advertised and then mishandled.
      },
      consistencyGuarantee: "BEST_EFFORT",
    };
  }

  private async readSubscription(id: string): Promise<CbSubscription> {
    try {
      const { json } = await this.client.getSubscription(id);
      const sub = (json as any)?.subscription as CbSubscription | undefined;
      if (!sub) throw new SCQError("PROVIDER_ERROR", `Chargebee retrieve for subscription ${id} returned no subscription object`);
      return sub;
    } catch (e) {
      throw this.toSCQ(e, id);
    }
  }

  async getSubscription(subscriptionId: string): Promise<SubscriptionSnapshot> {
    return snapshotFrom(await this.readSubscription(subscriptionId));
  }

  /**
   * Fetches authoritative item-price metadata for the given item price
   * ids. A failed lookup leaves the id ABSENT from the map (pricing
   * model unknown): interpretation then fails closed for any item whose
   * contribution would need that metadata, rather than guessing.
   */
  private async fetchPriceInfo(itemPriceIds: string[]): Promise<Map<string, CbItemPriceInfo>> {
    const out = new Map<string, CbItemPriceInfo>();
    for (const id of [...new Set(itemPriceIds)]) {
      try {
        const { json } = await this.client.getItemPrice(id);
        const ip = (json as any)?.item_price;
        if (ip) out.set(id, { itemPriceId: id, pricingModel: ip.pricing_model, price: ip.price, freeQuantity: ip.free_quantity, itemType: ip.item_type });
      } catch { /* unknown metadata — interpretation fails closed where it matters */ }
    }
    return out;
  }

  private itemStatesOf(sub: CbSubscription): ItemState[] {
    return (sub.subscription_items ?? []).map((i) => ({ itemPriceId: i.item_price_id, quantity: i.quantity, unitPrice: i.unit_price, amount: i.amount, freeQuantity: i.free_quantity }));
  }

  private updateParams(items: Array<{ itemPriceId: string; quantity: number }>): Record<string, unknown> {
    return {
      subscription_items: items.map((i) => ({ item_price_id: i.itemPriceId, quantity: i.quantity })),
      // Full-list replacement semantics are REQUIRED for the SCQ intent
      // ("the item list becomes exactly this") — Chargebee's documented
      // default (false) is additive and would silently retain addons.
      // Documented caveat (Phase 2A re-verified on the update page):
      // with a plan in the list, replace_items_list=true replaces the
      // ENTIRE list; with an addons-only list the plan is always
      // retained and mandatory addons survive replacement unless named
      // in `mandatory_items_to_remove`. This adapter sends no
      // mandatory_items_to_remove and targets plan-inclusive lists, so
      // it does NOT claim the resulting item set is exact for
      // subscriptions carrying mandatory addons auto-attached to the
      // target plan — post-commit reconciliation reads the ACTUAL
      // state rather than assuming the sent list is the final list.
      replace_items_list: true,
      prorate: true,
      // No default invoice collection: charges land as unbilled charges.
      invoice_immediately: false,
      change_option: "immediately",
    };
  }

  async createChangeQuote(subscriptionId: string, proposal: SubscriptionChangeProposal): Promise<SubscriptionChangeQuote> {
    if (proposal.changes.length === 0) throw new SCQError("INVALID_PROPOSAL", "proposal.changes must contain at least one change");
    if (proposal.changes.length > 1) {
      throw new SCQError("UNSUPPORTED_CHANGE", "The experimental live Chargebee adapter validates single-change proposals only; multi-change live behavior is UNVERIFIED and is refused before any provider call.", { changes: proposal.changes.map((c) => c.action).join("+") });
    }
    const change = proposal.changes[0];
    if (change.action !== "CHANGE_QUANTITY" && change.action !== "CHANGE_PLAN") {
      throw new SCQError("UNSUPPORTED_CHANGE", `The experimental live Chargebee adapter does not implement ${change.action} (outside the validated scope); refused before any provider call.`);
    }
    // Refuse unsupported effective intents BEFORE any provider call at all
    // (stronger than the spec's "before preview/mutation" floor).
    enforceEffectiveIntent(proposal.effectiveIntent, ["IMMEDIATE"]);

    const sub = await this.readSubscription(subscriptionId);
    const effectiveMode = resolveGuaranteeMode(proposal);
    // EXACT is refused here, before the estimate call, naming the failing
    // dimension — this adapter cannot back EXACT on any financial dim.
    enforceGuaranteeRequest(proposal.changes, effectiveMode, COVERAGE, proposal.acceptanceEnvelope);

    const currentItems = (sub.subscription_items ?? []).map((i) => ({ itemPriceId: i.item_price_id, quantity: i.quantity }));
    let targetItems: Array<{ itemPriceId: string; quantity: number }>;
    if (change.action === "CHANGE_QUANTITY") {
      if (!currentItems.some((i) => i.itemPriceId === change.itemId)) throw new SCQError("INVALID_PROPOSAL", `Item ${change.itemId} (item_price_id) not found on subscription`);
      targetItems = currentItems.map((i) => (i.itemPriceId === change.itemId ? { ...i, quantity: change.quantity } : i));
    } else {
      if (!currentItems.some((i) => i.itemPriceId === change.itemId)) throw new SCQError("INVALID_PROPOSAL", `Item ${change.itemId} (item_price_id) not found on subscription`);
      targetItems = currentItems.map((i) => (i.itemPriceId === change.itemId ? { ...i, itemPriceId: change.offeringRef } : i));
    }

    // Authoritative pricing metadata BEFORE the estimate: it decides
    // both a pre-call refusal (flat_fee quantity change) and how the
    // estimate response may lawfully be interpreted.
    const priceInfo = await this.fetchPriceInfo([...currentItems.map((i) => i.itemPriceId), ...targetItems.map((i) => i.itemPriceId)]);

    if (change.action === "CHANGE_QUANTITY") {
      const model = priceInfo.get(change.itemId)?.pricingModel;
      const currentQty = currentItems.find((i) => i.itemPriceId === change.itemId)?.quantity;
      if (model === "flat_fee" && change.quantity !== currentQty) {
        // Live-verified (Phase 3 isolation matrix, test site): the
        // provider rejects a quantity change on a flat_fee item with
        // HTTP 400 "This param should not be sent for on_off addon
        // type" — quantity is not a priced (or settable) dimension of
        // a flat_fee item. Refuse here, before any estimate call,
        // rather than forwarding a request the provider will reject
        // or, worse, computing price × quantity for it.
        throw new SCQError("UNSUPPORTED_CHANGE", `CHANGE_QUANTITY on ${change.itemId} is refused: item-price metadata reports pricing_model "flat_fee", for which quantity is not a settable dimension (the provider rejects such a change with a validation error). A flat_fee item's price does not vary with quantity, so no honest quote can be built on a quantity change for it.`, { itemPriceId: change.itemId, pricingModel: model, currentQuantity: currentQty, requestedQuantity: change.quantity });
      }
    }

    let estimate: any;
    try {
      const { json } = await this.client.estimateUpdateForItems(subscriptionId, this.updateParams(targetItems));
      estimate = (json as any)?.estimate;
    } catch (e) { throw this.toSCQ(e, subscriptionId); }
    if (!estimate) throw new SCQError("PROVIDER_ERROR", "Chargebee estimate returned no estimate object");

    const currency = sub.currency_code ?? "USD";
    const interpreted = interpretChargebeeEstimate(estimate, { currency, currentItems: this.itemStatesOf(sub), targetItems, priceInfo });
    // v0.6.2 (PR-7): the quoted effect carries the three-state
    // determinacy record and field-level provenance (CORE-1/CORE-2).
    const commercialEffect = withDeterminacy(interpreted);
    commercialEffect.effectiveAt = this.now().toISOString();
    // FAIL CLOSED: the REVALIDATE acceptance envelope (mandatory for
    // these actions) is enforced by comparing immediate.net and
    // recurring.resultingAmount. A dimension the provider data cannot
    // determine reads UNKNOWN under the determinacy record — and the
    // frozen core engine treats an absent figure as 0 — so an
    // UNKNOWN dimension makes the envelope unenforceable. Refuse
    // rather than quote it.
    {
      const states = determinacyOf(commercialEffect);
      if (states.immediateFinancialEffect === "UNKNOWN" || states.recurringFinancialEffect === "UNKNOWN") {
        const missing = [
          ...(states.immediateFinancialEffect === "UNKNOWN" ? [`immediate (${interpreted.provenance.immediate})`] : []),
          ...(states.recurringFinancialEffect === "UNKNOWN" ? [`recurring (${interpreted.provenance.recurring})`] : []),
        ];
        throw new SCQError("QUOTE_NOT_DETERMINISTIC", `The provider's estimate does not determine the ${missing.join(" and ")} financial dimension(s) from any authoritative field or justified computation, so the acceptance envelope cannot be enforced for this proposal. Refusing to quote an invented number.`, { provenance: interpreted.provenance, determinacy: states, nextInvoicePresent: interpreted.nextInvoice !== undefined });
      }
    }

    const quoteId = `scq_cblive_${crypto.randomBytes(8).toString("hex")}`;
    const expiresAt = new Date(this.now().getTime() + QUOTE_TTL_MS).toISOString();
    const stored: StoredQuote<LivePreviewInput> = {
      quote_id: quoteId,
      provider: "chargebee",
      subscription_id: subscriptionId,
      subscription_version_at_quote: fingerprintOf(sub),
      proposal,
      effective_guarantee_mode: effectiveMode,
      guarantee_coverage: { ...COVERAGE },
      multi_change_consistency: "ATOMIC",
      provider_preview_input: { items: targetItems, idempotencyKey: `scq-${quoteId}`.slice(0, 100) },
      quoted_effect: commercialEffect,
      created_at: this.now().toISOString(),
      expires_at: expiresAt,
      status: "ACTIVE",
    };
    this.store.put(stored as StoredQuote);
    return {
      id: quoteId,
      subscriptionRef: subscriptionId,
      preconditions: { subscriptionVersion: fingerprintOf(sub) },
      proposal,
      guaranteeMode: effectiveMode,
      guaranteeCoverage: { ...COVERAGE },
      multiChangeConsistency: "ATOMIC",
      commercialEffect,
      validUntil: expiresAt,
      providerMetadata: {
        source: "chargebee-live-experimental",
        resourceVersion: sub.resource_version ?? null,
        hasScheduledChanges: sub.has_scheduled_changes ?? false,
        hasScheduledAdvanceInvoices: sub.has_scheduled_advance_invoices ?? false,
        scheduledChangesWarning: sub.has_scheduled_changes
          ? "Subscription has scheduled changes (has_scheduled_changes=true). An immediate update can interact with / supersede scheduled changes per Chargebee's documented 'impacts on existing scheduled changes'; SCQ does not model that interaction — termEffect is UNKNOWN and no scheduled-change guarantee is made."
          : undefined,
        rampsNote: "TERM_END/DATE scheduling via the deprecated change_option paths and via Ramps (early access) is NOT implemented or validated by this adapter.",
        // Phase 3: exact financial-field provenance for this quote.
        financialProvenance: interpreted.provenance,
        pricingModels: Object.fromEntries([...priceInfo.values()].map((p) => [p.itemPriceId, p.pricingModel ?? "unknown"])),
        // next_invoice_estimate is reported here ONLY: SCQ v0.6.1 has
        // no CommercialEffect field whose semantics match it (it is
        // neither the immediate charge nor the recurring amount, and
        // its amount_due is net of credits). null when the provider
        // did not return one for this estimate.
        nextInvoiceEstimate: interpreted.nextInvoice ?? null,
        nextInvoiceNote: "next_invoice_estimate figures were NOT mapped into commercialEffect: its total is a next-cycle figure whose line set can be incomplete, and its amount_due is net of credits_applied (credits do not change the underlying subscription price).",
      },
    };
  }

  async commitChangeQuote(quoteId: string): Promise<SubscriptionChangeReceipt> {
    // SCQ receipt replay first — before any provider read or mutation
    // (spec §6.10). Bounded by the in-memory store's lifetime; see T13.
    const cached = checkIdempotentReplay(this.store, quoteId);
    if (cached) return cached;
    const stored0 = this.store.get(quoteId);
    if (!stored0) throw new SCQError("QUOTE_STALE", `No quote found for id ${quoteId}; if the process restarted, the in-memory quote store lost this quote and exactly-once cannot be proven — refusing rather than re-mutating blindly.`);

    // v0.6.2 (PR-7, CORE-8): a prior attempt on this quote whose
    // outcome was INDETERMINATE (the mutation was dispatched but its
    // landing was not established) must never be blindly retried: the
    // operation may already have landed, and a second dispatch would
    // double-apply it. Refuse here, before any state read or
    // mutation. (Pre-migration, a retry was stopped only incidentally
    // — by staleness when the change had in fact landed; a lost
    // dispatch that never landed left the quote valid and a retry
    // would have re-mutated.)
    if (stored0.commit_outcome?.outcome === "INDETERMINATE") {
      throw new SCQError(
        "PROVIDER_ERROR",
        `Commit outcome for quote ${quoteId} is INDETERMINATE: a previous commit attempt's mutation was ` +
          `dispatched but its landing was not established. No second mutation was issued. Reconcile the ` +
          `provider state manually before any retry.`,
        { outcome: "INDETERMINATE", indeterminate: true, reconciled: false },
      );
    }

    const input = stored0.provider_preview_input as LivePreviewInput;
    const current = await this.readSubscription(stored0.subscription_id);
    const validated = validateCommit(this.store, quoteId, fingerprintOf(current), this.now);
    const proposal = validated.proposal;
    const preDispatchFingerprint = fingerprintOf(current);

    // Final pre-mutation preview (REVALIDATE): envelope is enforced
    // against THIS preview, before mutation (spec §4.2 clarification 1).
    let freshEstimate: any;
    try {
      const { json } = await this.client.estimateUpdateForItems(validated.subscription_id, this.updateParams(input.items));
      freshEstimate = (json as any)?.estimate;
    } catch (e) { throw this.toSCQ(e, validated.subscription_id); }
    if (!freshEstimate) throw new SCQError("PROVIDER_ERROR", "Chargebee revalidation estimate returned no estimate object");
    const currency = current.currency_code ?? "USD";
    const priceInfo = await this.fetchPriceInfo(input.items.map((i) => i.itemPriceId));
    const revalidated = withDeterminacy(
      interpretChargebeeEstimate(freshEstimate, { currency, currentItems: this.itemStatesOf(current), targetItems: input.items, priceInfo }),
      { committedSource: "revalidated_preview" },
    );
    revalidated.effectiveAt = validated.quoted_effect.effectiveAt;
    // FAIL CLOSED (Phase 3 rule, v0.6.2 form): never feed an effect
    // with an UNKNOWN bounded dimension into checkAcceptanceEnvelope —
    // the frozen core engine compares absent dimensions as 0, which
    // would silently "enforce" the envelope against an invented zero.
    assertEffectDeterminateForCommit(validated.quoted_effect, "quoted");
    assertEffectDeterminateForCommit(revalidated, "revalidated");
    const violation = checkAcceptanceEnvelope(validated.quoted_effect, revalidated, proposal.acceptanceEnvelope!);
    if (violation) {
      throw new SCQError("QUOTE_DRIFTED", `Recomputed commercial effect fell outside the caller's acceptance envelope: ${violation}. No mutation was performed.`, { quoted: validated.quoted_effect, revalidated, envelope: proposal.acceptanceEnvelope });
    }

    if (!this.opts.liveCommitEnabled) {
      throw new SCQError("PROVIDER_ERROR", "BLOCKED — LIVE COMMIT DISABLED (SCQ_LIVE_COMMIT_ENABLED is not 'true'). Quote and pre-mutation revalidation completed; no mutating call was made.", { blocked: "LIVE_COMMIT_DISABLED" });
    }

    let updateJson: any;
    let idempotencyReplayed = false;
    try {
      const res = await this.client.updateForItems(validated.subscription_id, this.updateParams(input.items), input.idempotencyKey);
      updateJson = res.json;
      idempotencyReplayed = res.idempotencyReplayed;
    } catch (e) {
      if (e instanceof ChargebeeHttpError && e.httpStatus === 400 && e.apiErrorCode !== undefined && PRE_EFFECT_VALIDATION_ERROR_CODES.has(e.apiErrorCode)) {
        // Demonstrable pre-effect rejection (CORE-5, restricted per
        // PR-7 review corrections L2/L3): the provider refused the
        // request at VALIDATION, before anything was applied, with
        // no prior-operation ambiguity — non-execution is
        // demonstrable from the provider's documented semantics for
        // the SPECIFIC api_error_code (see
        // PRE_EFFECT_VALIDATION_ERROR_CODES). HTTP 400 ALONE does
        // not qualify: Chargebee also assigns 400 to payment and
        // operation-stage failures (e.g. payment_processing_failed),
        // which may follow partial effects, so a 400 with a
        // payment-stage, unknown, or MISSING code falls through to
        // the unknown-dispatch branch below and classifies
        // INDETERMINATE. Record a qualifying rejection distinctly
        // from the indeterminate class; it carries the opposite
        // retry rule (a fresh attempt may be made; nothing landed).
        this.store.recordCommitOutcome(quoteId, {
          outcome: "CONFIRMED_NON_EXECUTION",
          at: this.now().toISOString(),
          details: { httpStatus: e.httpStatus, apiErrorCode: e.apiErrorCode, reason: "the mutating request was rejected by the provider before effect (documented pre-effect validation rejection: HTTP 400 with an allowlisted validation api_error_code)" },
        });
        const mapped = this.toSCQ(e, validated.subscription_id);
        throw new SCQError(mapped.code, mapped.message, { outcome: "CONFIRMED_NON_EXECUTION", httpStatus: e.httpStatus, apiErrorCode: e.apiErrorCode });
      }
      if (e instanceof ChargebeeHttpError) {
        // Unknown-dispatch path: the request may have been processed
        // and its execution cannot be established or excluded. This
        // covers transport failures after dispatch (indeterminate),
        // 5xx (cached under the idempotency key without establishing
        // application), 409, HTTP 408 (a timeout is not evidence the
        // request was never applied), ambiguous 429 rate-limit
        // responses, unclassified 4xx, HTTP 400 WITHOUT an allowlisted
        // pre-effect validation code (payment-stage, unknown, or
        // missing api_error_code — review L3), and 422 idempotency conflicts
        // (duplicate_request establishes that THIS attempt was
        // rejected — NOT that the operation that originally consumed
        // the key did not execute; an earlier landing remains
        // possible and re-dispatch is blocked pending
        // reconciliation). DO NOT re-issue the mutation. Reconcile
        // from an independent state re-read; every outcome on this
        // path is INDETERMINATE with the outcome recorded and blind
        // retry refused (PR-7 review corrections L1/L2).
        return this.reconcileAfterUnknownDispatch(validated, input, preDispatchFingerprint, e);
      }
      throw this.toSCQ(e, validated.subscription_id);
    }
    return this.establishLiveCommit(validated, input, preDispatchFingerprint, updateJson, idempotencyReplayed);
  }

  /**
   * v0.6.2 (PR-7, as corrected by review L1/L2): reconciles a
   * dispatch whose execution cannot be established (lost response,
   * transport failure, 408, ambiguous 429, 409, 5xx, 422 idempotency
   * conflict, unclassified 4xx, HTTP 400 without an allowlisted
   * pre-effect validation code) from an independent post-dispatch
   * state re-read, WITHOUT re-issuing the mutation.
   *
   * EVERY outcome on this path is INDETERMINATE. The re-read is
   * diagnostic only: it can show that the intended state is (or is
   * not) in effect, but it cannot establish that THIS request landed
   * it. A changed subscription matching the intended result is
   * observationally identical to an independent actor applying the
   * same item set while our request never applied (test26-12b); an
   * idempotency key sent with a lost request does not establish
   * execution; and no operation-bound provider signal proving
   * landing was identified in Chargebee's validated surface (no
   * per-operation read-back artifact exists here). The outcome is
   * recorded in the store with the observed state as diagnostic
   * context, NO committed receipt is recorded, and the guard at the
   * top of commitChangeQuote refuses any later blind retry of this
   * quote pending manual reconciliation.
   *
   * The response-received / response-lost line: COMMITTED_UNVERIFIED
   * is reachable ONLY from establishLiveCommit, where the mutating
   * call's response WAS received (a native idempotency replay
   * returns the original operation's own response and counts as
   * received). Nothing on this unknown-dispatch path produces a
   * committed receipt.
   */
  private async reconcileAfterUnknownDispatch(
    validated: StoredQuote,
    input: LivePreviewInput,
    preDispatchFingerprint: string,
    cause: ChargebeeHttpError,
  ): Promise<SubscriptionChangeReceipt> {
    const quoteId = validated.quote_id;
    let after: CbSubscription | undefined;
    try { after = await this.readSubscription(validated.subscription_id); } catch { after = undefined; }
    const intendedSetObserved =
      after !== undefined && itemSetMismatches(after.subscription_items ?? [], input.items).length === 0;
    const fingerprintMoved = after !== undefined && fingerprintOf(after) !== preDispatchFingerprint;
    this.store.recordCommitOutcome(quoteId, {
      outcome: "INDETERMINATE",
      at: this.now().toISOString(),
      details: {
        reason: after === undefined
          ? "the dispatch's execution could not be established and the post-dispatch state re-read failed"
          : intendedSetObserved && fingerprintMoved
            ? "the dispatch's execution could not be established; the re-read shows the intended item set in effect on a moved fingerprint, but that observation does not establish that THIS request landed it (an independent actor's identical write is observationally indistinguishable)"
            : "the dispatch's execution could not be established and provider state does not show the intended change",
        // Observed state retained as DIAGNOSTIC CONTEXT only — it is
        // not a committed effect and grounds no receipt.
        observedIntendedSetInEffect: intendedSetObserved,
        observedFingerprintMoved: fingerprintMoved,
        observedResourceVersion: after?.resource_version ?? null,
        cause: cause.message,
      },
    });
    if (after === undefined) {
      throw new SCQError("PROVIDER_ERROR", "Commit outcome is INDETERMINATE: the mutating dispatch's execution could not be established and the post-dispatch provider state could not be re-read. No receipt was recorded and no second mutation was issued. Reconcile manually from provider records before any retry.", { outcome: "INDETERMINATE", indeterminate: true, reconciled: false });
    }
    if (intendedSetObserved && fingerprintMoved) {
      throw new SCQError("PROVIDER_ERROR", "Commit outcome is INDETERMINATE: the mutating dispatch's execution could not be established. Provider state shows the intended item set in effect, but a matching changed state does not establish that THIS request caused the change — the same observations arise if another actor applied the identical change while this request never landed, and Chargebee provides no operation-bound execution evidence in this adapter's validated surface. No receipt was recorded and no second mutation was issued. Reconcile manually from provider records before any retry.", { outcome: "INDETERMINATE", indeterminate: true, reconciled: false, observedIntendedSetInEffect: true });
    }
    throw new SCQError("PROVIDER_ERROR", "Commit outcome is INDETERMINATE: the mutating dispatch's execution could not be established and provider state does not show the intended change. No receipt was recorded and no second mutation was issued. Reconcile manually before any retry.", { outcome: "INDETERMINATE", indeterminate: true, reconciled: false, observedIntendedSetInEffect: false });
  }

  /**
   * v0.6.2 (PR-7): establishes a commit whose mutating call RETURNED,
   * from independent evidence — never from the pre-mutation estimate.
   *
   * The evidence surfaces, kept distinct:
   *   - the MUTATION RESPONSE (bound to this commit by the HTTP
   *     exchange and the deterministic native idempotency key): the
   *     only source of the immediate incurred actual, and the
   *     state this operation itself produced (its subscription
   *     payload anchors the attribution bracket);
   *   - the independent post-commit RE-READ (a fresh GET): the
   *     complete intended item set is verified against it, and the
   *     recurring actual is the strict sum of its items' stated
   *     amounts.
   *
   * Classification order (PR #14 Z1: attribution BEFORE any
   * contradiction is classified):
   *   1. Re-read unavailable: the mutation is known landed (its
   *      response was received) but nothing can be independently
   *      verified => COMMITTED_UNVERIFIED, recorded entirely from
   *      data already in hand (PR #11 P1) — the response's figures
   *      present in the committed effect as candidates under
   *      UNKNOWN determinacy (the PR #10/#11 construction).
   *   2. Intended set established by the re-read:
   *      - bracket broken (an intervening write landed between the
   *        mutating call and the re-read) => COMMITTED_UNVERIFIED;
   *        per Z3 NO recurring figure is recorded for this commit.
   *        The response's immediate actual survives — its scope is
   *        this operation alone.
   *      - bracket closed, a financial dimension unestablished
   *        (response without financials; re-read items without
   *        stated amounts) => COMMITTED_UNVERIFIED (protocol
   *        Defect 3), the established dimension keeping its figure.
   *      - bracket closed, both dimensions established =>
   *        COMMITTED_AND_VERIFIED; reconciliation is the core's
   *        verdict over the established actuals (OK, or VIOLATED
   *        when the actuals fall outside the envelope).
   *   3. Intended set NOT established by the re-read:
   *      - the re-read data itself is incomplete (absent items
   *        member, empty collection, incomplete entries) =>
   *        verification unavailable => COMMITTED_UNVERIFIED.
   *      - the re-read fingerprint equals the pre-dispatch
   *        fingerprint: nothing landed, despite the success-shaped
   *        response. Execution cannot be established either way
   *        (the response claims success the state contradicts) =>
   *        INDETERMINATE, outcome recorded, no receipt.
   *      - bracket closed and both financial dimensions established
   *        from the presented state => the contradiction is this
   *        operation's own wrong landing => COMMITTED_AND_VERIFIED
   *        with a VIOLATED reconciliation (Decision D3).
   *      - otherwise => COMMITTED_UNVERIFIED, the contradiction
   *        recorded as context (unattributed when the bracket is
   *        broken; financially incomplete when it is closed).
   */
  private async establishLiveCommit(
    validated: StoredQuote,
    input: LivePreviewInput,
    preDispatchFingerprint: string,
    updateJson: any,
    idempotencyReplayed: boolean,
  ): Promise<SubscriptionChangeReceipt> {
    const quoteId = validated.quote_id;
    const quoted = validated.quoted_effect;
    const proposal = validated.proposal;
    const respSub = (updateJson as any)?.subscription as CbSubscription | undefined;
    const immediateActual = committedImmediateFromResponse(updateJson);
    const immediateNet = "net" in immediateActual ? immediateActual.net : undefined;
    const immediateSource = "net" in immediateActual ? immediateActual.source : undefined;
    const immediateUndetermined = "net" in immediateActual ? undefined : (immediateActual as { undetermined: string }).undetermined;
    const replayNote = idempotencyReplayed
      ? " The response was a native idempotency replay of this commit's original operation (same key, same parameters), so its figures are the original operation's own."
      : "";

    let after: CbSubscription | undefined;
    try { after = await this.readSubscription(validated.subscription_id); } catch { after = undefined; }

    if (!after) {
      if (!respSub) {
        // No state evidence exists at all: the success response
        // carried no subscription and the re-read failed. Nothing
        // can be recorded honestly — not even a resulting snapshot.
        this.store.recordCommitOutcome(quoteId, {
          outcome: "INDETERMINATE",
          at: this.now().toISOString(),
          details: { reason: "the mutating call returned success without any subscription state, and the post-commit re-read failed" },
        });
        throw new SCQError("PROVIDER_ERROR", "Commit outcome is INDETERMINATE: the mutating call returned success without any subscription state, and the post-commit re-read failed, so neither the landed state nor the financial outcome can be established. No receipt was recorded. Reconcile manually from provider records before any retry.", { outcome: "INDETERMINATE", indeterminate: true, reconciled: false });
      }
      // Known landed, verification read unavailable (P1): record
      // the mutation response's candidate figures as UNVERIFIED —
      // present in the committed effect (so a later verification
      // has a record to verify against) but labeled unestablished
      // under UNKNOWN determinacy, built entirely from data
      // already in hand. This is the merged PR #10/#11 candidate
      // construction, verbatim in structure.
      const candRecurring = strictRecurringFromItems(respSub.subscription_items);
      const candRecurringAmount = "amount" in candRecurring ? candRecurring.amount : undefined;
      const effect: CommercialEffect = {
        ...(immediateNet !== undefined ? { immediate: immediateEffect(immediateNet) } : {}),
        recurring: {
          ...(candRecurringAmount !== undefined ? { resultingAmount: candRecurringAmount } : {}),
          currency: respSub.currency_code ?? quoted.recurring?.currency ?? "USD",
          ...(quoted.recurring?.previousAmount !== undefined ? { previousAmount: quoted.recurring.previousAmount } : {}),
        },
        effectiveAt: quoted.effectiveAt,
        determinacy: { immediateFinancialEffect: "UNKNOWN", recurringFinancialEffect: "UNKNOWN" },
        provenance: {
          immediate: immediateNet !== undefined
            ? `candidate figure reported by the mutating call's own response (${immediateSource}); the independent post-commit re-read was unavailable, so this is NOT an established actual`
            : "unestablished: the update response carried no financial actual and the post-commit re-read was unavailable",
          recurring: candRecurringAmount !== undefined
            ? "candidate figure from the mutating call's returned subscription items' stated amounts; not independently re-read — NOT an established actual"
            : "unestablished: the response's subscription items cannot be strictly priced and the post-commit re-read was unavailable",
          committedSource: "unestablished",
        },
      };
      return this.recordOutcomeReceipt(validated, {
        effect,
        reconciliation: {
          status: "UNVERIFIED",
          reason:
            "the update landed (its response was received, bound to this commit by its native idempotency key) but the independent " +
            "post-commit re-read was unavailable, so neither the landed item set nor the financial outcome could be independently " +
            "verified; the recorded figures are the mutation response's candidates, pending a later verification",
          undeterminedDimensions: ["immediateFinancialEffect", "recurringFinancialEffect"],
        },
        status: "COMMITTED_UNVERIFIED",
        outcome: "COMMITTED_UNVERIFIED",
        snapshot: snapshotFrom(respSub),
      });
    }

    const snap = snapshotFrom(after);
    const mismatches = itemSetMismatches(after.subscription_items ?? [], input.items);
    const afterFingerprint = fingerprintOf(after);
    const respFingerprint = respSub ? fingerprintOf(respSub) : undefined;
    const bracketClosed = respFingerprint !== undefined && respFingerprint === afterFingerprint;
    const strictRecurring = strictRecurringFromItems(after.subscription_items);
    const recurringAmount = "amount" in strictRecurring ? strictRecurring.amount : undefined;
    const recurringUndetermined = "amount" in strictRecurring ? undefined : (strictRecurring as { undetermined: string }).undetermined;
    // State-verification data completeness: ids + quantities present
    // on a non-empty collection. (Amounts are a separate, financial
    // completeness question, carried by strictRecurring.)
    const stateDataComplete =
      Array.isArray(after.subscription_items) &&
      after.subscription_items.length > 0 &&
      after.subscription_items.every((i) => typeof i.item_price_id === "string" && typeof i.quantity === "number");

    const currencyOf = after.currency_code ?? quoted.recurring?.currency ?? "USD";
    const recurringShell = {
      currency: currencyOf,
      ...(quoted.recurring?.previousAmount !== undefined ? { previousAmount: quoted.recurring.previousAmount } : {}),
    };
    const provImmediateDetermined = `${immediateSource}${replayNote}`;
    const provRecurringDetermined =
      "post-commit subscription re-read: strict sum of provider-stated subscription_items[].amount over the re-read item set";

    if (mismatches.length === 0) {
      // The independent re-read establishes the complete intended
      // item set. Attribution and financial establishment decide.
      if (!bracketClosed) {
        // Z1/Z3: an intervening write (or an unanchorable response)
        // breaks attribution. The response's immediate actual is
        // this operation's own and survives; NO recurring figure is
        // recorded for this commit.
        const dims: string[] = [...(immediateNet === undefined ? ["immediateFinancialEffect"] : []), "recurringFinancialEffect"];
        const effect: CommercialEffect = {
          ...(immediateNet !== undefined ? { immediate: immediateEffect(immediateNet) } : {}),
          recurring: { ...recurringShell },
          effectiveAt: quoted.effectiveAt,
          determinacy: {
            immediateFinancialEffect: immediateNet !== undefined ? "DETERMINED" : "UNKNOWN",
            recurringFinancialEffect: "UNKNOWN",
          },
          provenance: {
            immediate: immediateNet !== undefined ? provImmediateDetermined : `unestablished: ${immediateUndetermined}`,
            recurring:
              "unestablished for this commit: an intervening write landed between the mutating call and the post-commit re-read " +
              "(the response state's fingerprint does not equal the re-read state's), so the observed recurring level was not " +
              "produced by this commit alone (PR #14 Z3) — it is retained only as unattributed context in the resulting snapshot",
            committedSource: "unestablished",
          },
        };
        return this.recordOutcomeReceipt(validated, {
          effect,
          reconciliation: {
            status: "UNVERIFIED",
            reason:
              `the intended item set is in effect, but attribution does not close around this commit: the mutating call's response ` +
              `state fingerprints ${respFingerprint ?? "(no subscription in the response)"} while the independent re-read fingerprints ` +
              `${afterFingerprint} — a competing write intervened between the mutating call and the re-read, so the observed state ` +
              `cannot be attributed to this commit alone. No committed recurring figure is recorded for this commit (PR #14 Z3).`,
            undeterminedDimensions: dims,
          },
          status: "COMMITTED_UNVERIFIED",
          outcome: "COMMITTED_UNVERIFIED",
          snapshot: snap,
        });
      }
      if (immediateNet === undefined || recurringAmount === undefined) {
        // Defect 3: known landed, state verified, attribution
        // closed — but a financial dimension is unestablished.
        const dims: string[] = [
          ...(immediateNet === undefined ? ["immediateFinancialEffect"] : []),
          ...(recurringAmount === undefined ? ["recurringFinancialEffect"] : []),
        ];
        const effect: CommercialEffect = {
          ...(immediateNet !== undefined ? { immediate: immediateEffect(immediateNet) } : {}),
          recurring: { ...(recurringAmount !== undefined ? { resultingAmount: recurringAmount } : {}), ...recurringShell },
          effectiveAt: quoted.effectiveAt,
          determinacy: {
            immediateFinancialEffect: immediateNet !== undefined ? "DETERMINED" : "UNKNOWN",
            recurringFinancialEffect: recurringAmount !== undefined ? "DETERMINED" : "UNKNOWN",
          },
          provenance: {
            immediate: immediateNet !== undefined ? provImmediateDetermined : `unestablished: ${immediateUndetermined}`,
            recurring: recurringAmount !== undefined ? provRecurringDetermined : `unestablished: ${recurringUndetermined}`,
            committedSource: "unestablished",
          },
        };
        return this.recordOutcomeReceipt(validated, {
          effect,
          reconciliation: {
            status: "UNVERIFIED",
            reason:
              `the mutation landed and the independent re-read establishes the intended item set with attribution closed, but the ` +
              `financial outcome is not fully established (${dims.join(", ")} UNKNOWN) — the pre-mutation estimate is never ` +
              `substituted for an actual, so the commit is recorded as committed-but-unverified rather than failing closed ` +
              `as indeterminate (protocol Defect 3, closed by this migration)`,
            undeterminedDimensions: dims,
          },
          status: "COMMITTED_UNVERIFIED",
          outcome: "COMMITTED_UNVERIFIED",
          snapshot: snap,
        });
      }
      // Fully established: verified success or verified-with-
      // violation, per the core reconciliation over actuals.
      const effect: CommercialEffect = {
        immediate: immediateEffect(immediateNet),
        recurring: { resultingAmount: recurringAmount, ...recurringShell },
        effectiveAt: quoted.effectiveAt,
        determinacy: { immediateFinancialEffect: "DETERMINED", recurringFinancialEffect: "DETERMINED" },
        provenance: { immediate: provImmediateDetermined, recurring: provRecurringDetermined, committedSource: "provider_actual" },
      };
      return this.recordOutcomeReceipt(validated, {
        effect,
        reconciliation: reconcileCommittedEffect(quoted, effect, proposal.acceptanceEnvelope),
        status: "COMMITTED",
        outcome: "COMMITTED_AND_VERIFIED",
        snapshot: snap,
      });
    }

    // The re-read does NOT establish the intended item set.
    if (!stateDataComplete) {
      // The re-read data itself is incomplete (absent member, empty
      // collection, incomplete entries): verification is unavailable,
      // which is a different claim from an established contradiction.
      const dims: string[] = [...(immediateNet === undefined ? ["immediateFinancialEffect"] : []), "recurringFinancialEffect"];
      const effect: CommercialEffect = {
        ...(immediateNet !== undefined ? { immediate: immediateEffect(immediateNet) } : {}),
        recurring: { ...recurringShell },
        effectiveAt: quoted.effectiveAt,
        determinacy: {
          immediateFinancialEffect: immediateNet !== undefined ? "DETERMINED" : "UNKNOWN",
          recurringFinancialEffect: "UNKNOWN",
        },
        provenance: {
          immediate: immediateNet !== undefined ? provImmediateDetermined : `unestablished: ${immediateUndetermined}`,
          recurring:
            "unestablished: the post-commit re-read's subscription_items data is incomplete (absent member, empty collection, or " +
            "incomplete entries), so neither the landed item set nor the recurring level can be established from it — an absent " +
            "collection is never summed as a verified zero",
          committedSource: "unestablished",
        },
      };
      return this.recordOutcomeReceipt(validated, {
        effect,
        reconciliation: {
          status: "UNVERIFIED",
          reason:
            "the update landed (its response was received) but the post-commit re-read's item data is incomplete, so the landed " +
            "state and the recurring outcome cannot be established from provider data; no figure was derived from the incomplete read",
          undeterminedDimensions: dims,
        },
        status: "COMMITTED_UNVERIFIED",
        outcome: "COMMITTED_UNVERIFIED",
        snapshot: snap,
      });
    }

    if (afterFingerprint === preDispatchFingerprint) {
      // Nothing landed: the re-read state is byte-identical (same
      // fingerprint) to the state this commit validated, despite the
      // success-shaped response. Execution cannot be established
      // either way — the response claims a success the state
      // contradicts — so the outcome is INDETERMINATE, recorded in
      // the store, with no receipt and no blind retry.
      this.store.recordCommitOutcome(quoteId, {
        outcome: "INDETERMINATE",
        at: this.now().toISOString(),
        details: { reason: "the mutating call returned success but the re-read state is identical to the pre-dispatch state — the intended change did not land", itemSetMismatches: mismatches },
      });
      throw new SCQError("PROVIDER_ERROR", `Commit outcome is INDETERMINATE: the mutating call returned success, but the re-read provider state does NOT establish the intended item set (${mismatches.join("; ")}) and is identical to the pre-dispatch state — the change did not land, and the success response cannot be reconciled with the state. No receipt was recorded. Reconcile manually from provider state before any retry.`, { outcome: "INDETERMINATE", indeterminate: true, reconciled: false, itemSetMismatches: mismatches });
    }

    if (bracketClosed && immediateNet !== undefined && recurringAmount !== undefined) {
      // D3: the contradiction is attributable to this commit — the
      // response state's fingerprint equals the re-read's, so no
      // intervening write can account for the wrong landing. A
      // determined negative verification: VIOLATED, with the actual
      // figures as presented by the provider.
      const effect: CommercialEffect = {
        immediate: immediateEffect(immediateNet),
        recurring: { resultingAmount: recurringAmount, ...recurringShell },
        effectiveAt: quoted.effectiveAt,
        determinacy: { immediateFinancialEffect: "DETERMINED", recurringFinancialEffect: "DETERMINED" },
        provenance: { immediate: provImmediateDetermined, recurring: provRecurringDetermined, committedSource: "provider_actual" },
      };
      return this.recordOutcomeReceipt(validated, {
        effect,
        reconciliation: {
          status: "VIOLATED",
          reason:
            `Post-commit state verification MISMATCH — a determined negative verification (Decision D3): the re-read item set does ` +
            `not establish the intended set (${mismatches.join("; ")}). The contradiction is attributable to this commit: the ` +
            `mutating call's response state and the independent re-read agree (fingerprint ${afterFingerprint}), so no intervening ` +
            `write can account for the wrong landing. The committed figures report the provider's actuals as presented; the ` +
            `mutation has already occurred and cannot be rolled back by this reconciliation.`,
        },
        status: "COMMITTED",
        outcome: "COMMITTED_AND_VERIFIED",
        snapshot: snap,
      });
    }

    // Landed wrong, but the outcome cannot be fully established:
    // attribution is broken (the mismatch is unattributed context
    // only) and/or a financial dimension is unestablished.
    const dims: string[] = [
      ...(immediateNet === undefined ? ["immediateFinancialEffect"] : []),
      ...(!bracketClosed || recurringAmount === undefined ? ["recurringFinancialEffect"] : []),
    ];
    const recurringFigure = bracketClosed && recurringAmount !== undefined ? recurringAmount : undefined;
    const effect: CommercialEffect = {
      ...(immediateNet !== undefined ? { immediate: immediateEffect(immediateNet) } : {}),
      recurring: { ...(recurringFigure !== undefined ? { resultingAmount: recurringFigure } : {}), ...recurringShell },
      effectiveAt: quoted.effectiveAt,
      determinacy: {
        immediateFinancialEffect: immediateNet !== undefined ? "DETERMINED" : "UNKNOWN",
        recurringFinancialEffect: recurringFigure !== undefined ? "DETERMINED" : "UNKNOWN",
      },
      provenance: {
        immediate: immediateNet !== undefined ? provImmediateDetermined : `unestablished: ${immediateUndetermined}`,
        recurring: recurringFigure !== undefined
          ? provRecurringDetermined
          : !bracketClosed
            ? "unestablished for this commit: attribution is broken (the response state's fingerprint does not equal the re-read state's), so no recurring figure is recorded for this commit (PR #14 Z3)"
            : `unestablished: ${recurringUndetermined}`,
        committedSource: "unestablished",
      },
    };
    return this.recordOutcomeReceipt(validated, {
      effect,
      reconciliation: {
        status: "UNVERIFIED",
        reason:
          `the re-read item set does not establish the intended set (${mismatches.join("; ")})` +
          (!bracketClosed
            ? `, but attribution does not close around this commit (response state fingerprints ${respFingerprint ?? "(no subscription in the response)"}, re-read ${afterFingerprint}), so the contradiction is recorded as unattributed context only — it is NOT classified as a verified failure of this commit, since an intervening change may have caused it`
            : `, and although attribution closes, the financial outcome is not fully established (${dims.join(", ")} UNKNOWN), so the contradiction cannot be carried as a verified violation over established actuals`),
        undeterminedDimensions: dims,
      },
      status: "COMMITTED_UNVERIFIED",
      outcome: "COMMITTED_UNVERIFIED",
      snapshot: snap,
    });
  }

  /** Records a v0.6.2 commit receipt (verified or unverified) for an established commit outcome. */
  private recordOutcomeReceipt(
    validated: StoredQuote,
    established: {
      effect: CommercialEffect;
      reconciliation: ReconciliationResult;
      status: SubscriptionChangeReceipt["status"];
      outcome: MutationOutcome;
      snapshot: SubscriptionSnapshot;
    },
  ): SubscriptionChangeReceipt {
    const receipt: SubscriptionChangeReceipt = {
      quoteId: validated.quote_id,
      subscriptionRef: validated.subscription_id,
      status: established.status,
      outcome: established.outcome,
      resultingSnapshot: established.snapshot,
      quotedEffect: validated.quoted_effect,
      committedEffect: established.effect,
      guaranteeMode: validated.effective_guarantee_mode,
      consistencyGuarantee: "BEST_EFFORT",
      multiChangeConsistency: validated.multi_change_consistency,
      reconciliation: established.reconciliation,
      committedAt: this.now().toISOString(),
    };
    this.store.recordCommitReceipt(validated.quote_id, receipt);
    return receipt;
  }

  private toSCQ(e: unknown, subscriptionId: string): SCQError {
    if (e instanceof SCQError) return e;
    if (e instanceof ChargebeeHttpError) {
      if (e.httpStatus === 404) return new SCQError("SUBSCRIPTION_NOT_FOUND", `Subscription ${subscriptionId} not found`, { httpStatus: e.httpStatus, apiErrorCode: e.apiErrorCode });
      return new SCQError("PROVIDER_ERROR", e.message, { httpStatus: e.httpStatus, apiErrorCode: e.apiErrorCode, indeterminate: e.indeterminate, retryAfterSeconds: e.retryAfterSeconds });
    }
    return new SCQError("PROVIDER_ERROR", String(e));
  }
}

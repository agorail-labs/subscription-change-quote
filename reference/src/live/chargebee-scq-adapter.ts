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
  type GuaranteeCoverage,
  type ProviderCapabilities,
  type SubscriptionChangeProposal,
  type SubscriptionChangeQuote,
  type SubscriptionChangeReceipt,
  type SubscriptionProvider,
  type SubscriptionSnapshot,
} from "../core/types.js";
import {
  checkIdempotentReplay,
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

function snapshotFrom(sub: CbSubscription): SubscriptionSnapshot {
  const items = sub.subscription_items ?? [];
  const recurring = items.reduce((s, i) => s + (i.amount ?? (i.unit_price ?? 0) * i.quantity), 0);
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
      recurringAmount: recurring,
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
 *     is invoiced at the next billing cycle. Sourced from
 *     invoice_estimate.total, it is the provider's estimate of the
 *     total of the invoice that WOULD be issued for the change — an
 *     estimated invoice total, still not a payment or a collection.
 *   - recurring: subscription_estimate.subscription_items amounts when
 *     the provider states them; else a per-item computation in which
 *     every item's contribution must be justified (see
 *     itemRecurringContribution). Any unjustifiable item => recurring
 *     ABSENT. next_invoice_estimate is NEVER used for recurring.
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
  const subEstItems = estimate?.subscription_estimate?.subscription_items as Array<{ item_price_id: string; quantity: number; unit_price?: number; amount?: number }> | undefined;
  let resulting: number | undefined;
  if (Array.isArray(subEstItems) && subEstItems.length > 0 && subEstItems.every((i) => typeof i.amount === "number")) {
    // Provider-stated path: EVERY item carries its own stated amount.
    // An item with only a unit_price is NOT summed as unit_price ×
    // quantity here — that multiplication is justified only per
    // pricing model (a flat_fee item would be overstated), so such a
    // payload falls through to the per-item computation below.
    resulting = subEstItems.reduce((s, i) => s + (i.amount as number), 0);
    provenance.recurring = "subscription_estimate.subscription_items[].amount (provider-stated)";
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
      provenance.recurring = "computed per item: unchanged items at provider-stated amount; flat_fee at fixed price (quantity never multiplied); per_unit at (quantity − free_quantity) × unit price — all terms from the subscription payload and item-price metadata";
    } else {
      provenance.recurring = "absent: no fully provider-stated subscription_estimate item amounts, and at least one target item's contribution cannot be justified from its pricing model/terms";
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
    const commercialEffect = interpreted.effect;
    commercialEffect.effectiveAt = this.now().toISOString();
    // FAIL CLOSED: the REVALIDATE acceptance envelope (mandatory for
    // these actions) is enforced by comparing immediate.net and
    // recurring.resultingAmount. A dimension the provider data cannot
    // determine would be compared as absent — and the frozen core
    // engine treats absent as 0 — so an undetermined dimension makes
    // the envelope unenforceable. Refuse rather than quote it.
    if (!commercialEffect.immediate || !commercialEffect.recurring) {
      const missing = [
        ...(!commercialEffect.immediate ? [`immediate (${interpreted.provenance.immediate})`] : []),
        ...(!commercialEffect.recurring ? [`recurring (${interpreted.provenance.recurring})`] : []),
      ];
      throw new SCQError("QUOTE_NOT_DETERMINISTIC", `The provider's estimate does not determine the ${missing.join(" and ")} financial dimension(s) from any authoritative field or justified computation, so the acceptance envelope cannot be enforced for this proposal. Refusing to quote an invented number.`, { provenance: interpreted.provenance, nextInvoicePresent: interpreted.nextInvoice !== undefined });
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

    const input = stored0.provider_preview_input as LivePreviewInput;
    const current = await this.readSubscription(stored0.subscription_id);
    const validated = validateCommit(this.store, quoteId, fingerprintOf(current), this.now);
    const proposal = validated.proposal;

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
    const revalidated = interpretChargebeeEstimate(freshEstimate, { currency, currentItems: this.itemStatesOf(current), targetItems: input.items, priceInfo }).effect;
    revalidated.effectiveAt = validated.quoted_effect.effectiveAt;
    // FAIL CLOSED (Phase 3): never feed an effect with an absent
    // bounded dimension into checkAcceptanceEnvelope — the frozen core
    // engine compares absent dimensions as 0, which would silently
    // "enforce" the envelope against an invented zero.
    if (!revalidated.immediate || !revalidated.recurring || !validated.quoted_effect.immediate || !validated.quoted_effect.recurring) {
      throw new SCQError("QUOTE_NOT_DETERMINISTIC", "The pre-commit revalidation estimate does not determine every financial dimension the acceptance envelope bounds, so the envelope cannot be enforced. No mutation was performed.", { blocked: "ENVELOPE_UNENFORCEABLE_ON_REVALIDATION" });
    }
    const violation = checkAcceptanceEnvelope(validated.quoted_effect, revalidated, proposal.acceptanceEnvelope!);
    if (violation) {
      throw new SCQError("QUOTE_DRIFTED", `Recomputed commercial effect fell outside the caller's acceptance envelope: ${violation}. No mutation was performed.`, { quoted: validated.quoted_effect, revalidated, envelope: proposal.acceptanceEnvelope });
    }

    if (!this.opts.liveCommitEnabled) {
      throw new SCQError("PROVIDER_ERROR", "BLOCKED — LIVE COMMIT DISABLED (SCQ_LIVE_COMMIT_ENABLED is not 'true'). Quote and pre-mutation revalidation completed; no mutating call was made.", { blocked: "LIVE_COMMIT_DISABLED" });
    }

    let updateJson: any;
    try {
      const { json } = await this.client.updateForItems(validated.subscription_id, this.updateParams(input.items), input.idempotencyKey);
      updateJson = json;
    } catch (e) {
      if (e instanceof ChargebeeHttpError && e.indeterminate) {
        // Lost-response path: DO NOT re-issue the mutation. Reconcile by
        // re-reading provider state. If the intended item set is exactly
        // present, the mutation landed — record the receipt from actual
        // state. Otherwise fail closed as indeterminate.
        const after = await this.readSubscription(validated.subscription_id);
        const actualItems = (after.subscription_items ?? []).map((i) => ({ itemPriceId: i.item_price_id, quantity: i.quantity }));
        const landed = JSON.stringify(actualItems) === JSON.stringify(input.items);
        if (!landed) {
          throw new SCQError("PROVIDER_ERROR", "Commit outcome is INDETERMINATE: the mutating request's response was lost and provider state does not show the intended change. No second mutation was issued. Reconcile manually before any retry.", { indeterminate: true, reconciled: false });
        }
        const committedEffect = this.committedEffectFromState(validated.quoted_effect, after, revalidated);
        return this.recordReceipt(validated, snapshotFrom(after), committedEffect, proposal);
      }
      throw this.toSCQ(e, validated.subscription_id);
    }

    // Post-commit reconciliation (§6.11): committedEffect is derived from
    // ACTUAL post-commit state (re-read) plus the invoice/unbilled total
    // the mutating call itself returned — not from the pre-mutation
    // preview — so a concurrent write landing in the TOCTOU window is
    // reported as VIOLATED, never silently absorbed.
    const after = await this.readSubscription(validated.subscription_id);
    const committedEffect = this.committedEffectFromState(validated.quoted_effect, after, revalidated, updateJson);
    return this.recordReceipt(validated, snapshotFrom(after), committedEffect, proposal);
  }

  private committedEffectFromState(quoted: CommercialEffect, after: CbSubscription, fallback: CommercialEffect, updateJson?: any): CommercialEffect {
    const items = after.subscription_items ?? [];
    // Recurring from provider-stated item amounts ONLY. An item without
    // a stated amount is never reconstructed as unit_price × quantity
    // (unjustified for flat_fee and unproven in general): the dimension
    // is then left absent rather than fabricated. (The frozen snapshot/
    // effect types force a number in some sibling paths — see the
    // protocol-defect proposal — but this reconciliation input does
    // not have to invent one.)
    const recurringAmount = items.every((i) => typeof i.amount === "number")
      ? items.reduce((s, i) => s + (i.amount as number), 0)
      : undefined;
    const invoiceTotal = updateJson?.invoice?.total;
    const unbilledMember = updateJson?.unbilled_charges as Array<{ amount?: number }> | undefined;
    // A present unbilled_charges member states the committed unbilled
    // total — including a genuine 0 (empty array). An element without a
    // numeric amount makes the member unusable, never a 0.
    const unbilledTotal = Array.isArray(unbilledMember) && unbilledMember.every((u) => typeof u.amount === "number")
      ? unbilledMember.reduce((s, u) => s + (u.amount as number), 0)
      : undefined;
    const net = typeof invoiceTotal === "number" ? invoiceTotal : unbilledTotal !== undefined ? unbilledTotal : fallback.immediate?.net;
    const effect: CommercialEffect = {
      recurring: { ...(recurringAmount !== undefined ? { resultingAmount: recurringAmount } : {}), currency: after.currency_code ?? quoted.recurring?.currency ?? "USD", ...(quoted.recurring?.previousAmount !== undefined ? { previousAmount: quoted.recurring.previousAmount } : {}) },
      effectiveAt: quoted.effectiveAt,
    };
    if (net !== undefined && net !== 0) effect.immediate = { charge: net > 0 ? net : undefined, credit: net < 0 ? -net : undefined, net };
    return effect;
  }

  private recordReceipt(validated: StoredQuote, snap: SubscriptionSnapshot, committedEffect: CommercialEffect, proposal: SubscriptionChangeProposal): SubscriptionChangeReceipt {
    const reconciliation = reconcileCommittedEffect(validated.quoted_effect, committedEffect, proposal.acceptanceEnvelope);
    const receipt: SubscriptionChangeReceipt = {
      quoteId: validated.quote_id,
      subscriptionRef: validated.subscription_id,
      status: "COMMITTED",
      resultingSnapshot: snap,
      quotedEffect: validated.quoted_effect,
      committedEffect,
      guaranteeMode: validated.effective_guarantee_mode,
      consistencyGuarantee: "BEST_EFFORT",
      multiChangeConsistency: validated.multi_change_consistency,
      reconciliation,
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

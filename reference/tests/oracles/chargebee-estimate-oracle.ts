// TEST-ONLY independent oracle for Chargebee estimate interpretation
// (PR #13 review correction R1).
//
// WHY THIS EXISTS: the pilot harness's field comparison
// (run-pilot.ts compareQuoteToRawEstimate) re-applies the adapter's
// OWN interpretChargebeeEstimate to the raw response. A systematic
// defect inside that shared function would corrupt the adapter's
// quote AND the comparison identically, and the comparison would
// still report a match — correlated defects are undetectable that
// way. This oracle is the independent check: it computes the expected
// effect (values AND provenance) directly from the raw provider
// response and the proposal context, from the documented semantics
// in research/chargebee-pilot/PROVENANCE-MATRIX.md.
//
// INDEPENDENCE RULES (do not weaken):
//   - This file must NOT import interpretChargebeeEstimate, the live
//     adapter, or any adapter interpretation code. Its input types
//     are defined locally for the same reason.
//   - It lives under tests/ and is never imported by src/ code.
//   - The rules below are re-derived from the provenance matrix, not
//     copied from the adapter: stated sources first, justified
//     per-item computation second, absence (UNKNOWN) whenever a term
//     cannot be established. next_invoice_estimate is NEVER a source
//     for any effect figure.

import type { SubscriptionChangeQuote } from "../../src/core/types.js";

export type OracleItemState = {
  itemPriceId: string;
  quantity: number;
  unitPrice?: number;
  amount?: number;
  freeQuantity?: number;
};

export type OraclePriceInfo = {
  itemPriceId: string;
  pricingModel?: string;
  price?: number;
  freeQuantity?: number;
};

export type OracleContext = {
  currency: string;
  currentItems: OracleItemState[];
  targetItems: Array<{ itemPriceId: string; quantity: number }>;
  priceInfo: ReadonlyMap<string, OraclePriceInfo>;
};

export type ImmediateSource = "invoice_estimate.total" | "unbilled_charge_estimates" | "absent";
export type RecurringSource = "subscription_estimate.subscription_items" | "per_item_computation" | "absent";

export type OracleExpectation = {
  /** Expected CommercialEffect.immediate.net; undefined = the dimension must be ABSENT (undeterminable). */
  immediateNet?: number;
  immediateSource: ImmediateSource;
  /** Expected CommercialEffect.recurring.resultingAmount; undefined = ABSENT. */
  recurringResulting?: number;
  /** Expected recurring.previousAmount; undefined = must be omitted. */
  recurringPrevious?: number;
  recurringSource: RecurringSource;
  /** Expected metadata-only next-invoice figures (never effect sources). */
  nextInvoice?: { total?: number; amountDue?: number };
};

function sumStatedElements(elements: unknown, field: "amount" | "total"): number | undefined {
  // A present member whose every element states a numeric figure sums
  // to that figure (an empty member is a provider-stated 0). A member
  // that is absent, not an array, or has ANY element without a numeric
  // figure is undeterminable — an element is never counted as 0.
  if (!Array.isArray(elements)) return undefined;
  let sum = 0;
  for (const el of elements) {
    const v = (el as Record<string, unknown>)?.[field];
    if (typeof v !== "number") return undefined;
    sum += v;
  }
  return sum;
}

function oracleImmediate(estimate: any): { net?: number; source: ImmediateSource } {
  // Base: invoice_estimate.total when the provider states it;
  // otherwise the unbilled-charge sum. Credits (credit_note_estimates)
  // must be stated for the net to be final.
  let base: number | undefined;
  let source: ImmediateSource = "absent";
  const inv = estimate?.invoice_estimate;
  if (inv && typeof inv.total === "number") {
    base = inv.total;
    source = "invoice_estimate.total";
  } else if (Array.isArray(estimate?.unbilled_charge_estimates)) {
    const s = sumStatedElements(estimate.unbilled_charge_estimates, "amount");
    if (s !== undefined) { base = s; source = "unbilled_charge_estimates"; }
  }
  if (base === undefined) return { source: "absent" };
  const credits = sumStatedElements(estimate?.credit_note_estimates, "total");
  if (credits === undefined) return { source: "absent" };
  return { net: base - credits, source };
}

function statedListIsComplete(stated: any, targetItems: OracleContext["targetItems"]): boolean {
  // The provider-stated recurring list may be summed ONLY when it
  // verifies as the ENTIRE intended item set: same ids, each exactly
  // once, matching quantities, a numeric amount on every element.
  if (!Array.isArray(stated) || stated.length === 0 || stated.length !== targetItems.length) return false;
  const wanted = new Map(targetItems.map((t) => [t.itemPriceId, t.quantity]));
  if (wanted.size !== targetItems.length) return false; // duplicated target ids
  const seen = new Set<string>();
  for (const s of stated) {
    if (typeof s?.amount !== "number") return false;
    if (seen.has(s.item_price_id)) return false;
    seen.add(s.item_price_id);
    if (wanted.get(s.item_price_id) !== s.quantity) return false;
  }
  return seen.size === wanted.size;
}

function oracleFreeQuantity(current: OracleItemState, catalog?: OraclePriceInfo): number | undefined {
  // free_quantity from authoritative data: the subscription item's own
  // statement; else the unique value consistent with its stated
  // amount at its unit price; else the catalog value when the stated
  // amount is exactly consistent with it.
  if (typeof current.freeQuantity === "number") return current.freeQuantity;
  const up = current.unitPrice;
  if (typeof up === "number" && up > 0 && typeof current.amount === "number") {
    const solved = current.quantity - current.amount / up;
    if (Number.isInteger(solved) && solved >= 0) return solved;
    if (typeof catalog?.freeQuantity === "number" && current.amount === Math.max(0, current.quantity - catalog.freeQuantity) * up) return catalog.freeQuantity;
  }
  return undefined;
}

function oracleItemContribution(
  target: { itemPriceId: string; quantity: number },
  current: OracleItemState | undefined,
  catalog: OraclePriceInfo | undefined,
): number | undefined {
  // Unchanged item: its provider-stated amount. flat_fee: the fixed
  // price ONCE (quantity is never multiplied). per_unit:
  // (quantity − free_quantity) × unit price with all terms
  // established. tiered / volume / stairstep / unknown: NOT
  // justifiable — undefined.
  if (current && current.itemPriceId === target.itemPriceId && current.quantity === target.quantity) {
    return typeof current.amount === "number" ? current.amount : undefined;
  }
  const model = catalog?.pricingModel;
  if (model === "flat_fee") {
    const fixed = current?.unitPrice ?? catalog?.price;
    return typeof fixed === "number" ? fixed : undefined;
  }
  if (model === "per_unit") {
    const unitPrice = current?.unitPrice ?? catalog?.price;
    if (typeof unitPrice !== "number") return undefined;
    const fq = current ? oracleFreeQuantity(current, catalog) : catalog?.freeQuantity;
    if (typeof fq !== "number") return undefined;
    return Math.max(0, target.quantity - fq) * unitPrice;
  }
  return undefined;
}

function oracleRecurring(estimate: any, ctx: OracleContext): { resulting?: number; previous?: number; source: RecurringSource } {
  const stated = estimate?.subscription_estimate?.subscription_items;
  let resulting: number | undefined;
  let source: RecurringSource = "absent";
  if (statedListIsComplete(stated, ctx.targetItems)) {
    resulting = (stated as Array<{ amount: number }>).reduce((s, i) => s + i.amount, 0);
    source = "subscription_estimate.subscription_items";
  } else {
    const currentById = new Map(ctx.currentItems.map((i) => [i.itemPriceId, i]));
    let sum = 0;
    let ok = true;
    for (const t of ctx.targetItems) {
      const c = oracleItemContribution(t, currentById.get(t.itemPriceId), ctx.priceInfo.get(t.itemPriceId));
      if (c === undefined) { ok = false; break; }
      sum += c;
    }
    if (ok) { resulting = sum; source = "per_item_computation"; }
  }
  const previous = ctx.currentItems.every((i) => typeof i.amount === "number")
    ? ctx.currentItems.reduce((s, i) => s + (i.amount as number), 0)
    : undefined;
  return { resulting, previous, source: resulting === undefined ? "absent" : source };
}

/** Computes the expected quote outcome from the RAW estimate response alone (plus proposal context). */
export function oracleExpectation(rawEstimateJson: any, ctx: OracleContext): OracleExpectation {
  const estimate = rawEstimateJson?.estimate ?? rawEstimateJson;
  const imm = oracleImmediate(estimate);
  const rec = oracleRecurring(estimate, ctx);
  const ni = estimate?.next_invoice_estimate;
  return {
    immediateNet: imm.net,
    immediateSource: imm.source,
    recurringResulting: rec.resulting,
    recurringPrevious: rec.previous,
    recurringSource: rec.source,
    nextInvoice: ni && typeof ni === "object"
      ? { total: typeof ni.total === "number" ? ni.total : undefined, amountDue: typeof ni.amount_due === "number" ? ni.amount_due : undefined }
      : undefined,
  };
}

export type OracleCheck = { dimension: string; ok: boolean; expected: unknown; actual: unknown; reason: string };

const SOURCE_TOKENS: Record<Exclude<ImmediateSource, "absent"> | Exclude<RecurringSource, "absent">, string> = {
  "invoice_estimate.total": "invoice_estimate.total",
  unbilled_charge_estimates: "unbilled_charge_estimates",
  "subscription_estimate.subscription_items": "subscription_estimate",
  per_item_computation: "computed per item",
};

/**
 * Checks an adapter-produced quote against the independent oracle:
 * VALUES (each effect figure equals the oracle's expectation) and
 * PROVENANCE (the adapter's recorded provenance cites the source the
 * oracle derived the figure from, and never cites
 * next_invoice_estimate for an effect figure). `rawEstimateJson` is
 * the raw provider response (the `{ estimate: … }` envelope or the
 * estimate object itself).
 */
export function checkQuoteAgainstOracle(quote: SubscriptionChangeQuote, rawEstimateJson: any, ctx: OracleContext): OracleCheck[] {
  const exp = oracleExpectation(rawEstimateJson, ctx);
  const eff = quote.commercialEffect;
  const md = (quote.providerMetadata ?? {}) as Record<string, any>;
  const prov = (md.financialProvenance ?? {}) as Record<string, string>;
  const checks: OracleCheck[] = [];
  const push = (dimension: string, ok: boolean, expected: unknown, actual: unknown, reason: string) => checks.push({ dimension, ok, expected, actual, reason });

  push("immediate.net (value)", exp.immediateNet !== undefined && eff.immediate?.net === exp.immediateNet, exp.immediateNet, eff.immediate?.net,
    exp.immediateNet === undefined ? "oracle: immediate is undeterminable from the raw response — no figure may be quoted" : `oracle derived the incurred figure from ${exp.immediateSource}`);
  push("immediate (provenance)", exp.immediateSource !== "absent" && typeof prov.immediate === "string" && prov.immediate.includes(SOURCE_TOKENS[exp.immediateSource as Exclude<ImmediateSource, "absent">]) && !prov.immediate.includes("next_invoice_estimate"),
    exp.immediateSource, prov.immediate,
    "the adapter's recorded provenance must cite the oracle's source field and never next_invoice_estimate");
  push("recurring.resultingAmount (value)", exp.recurringResulting !== undefined && eff.recurring?.resultingAmount === exp.recurringResulting, exp.recurringResulting, eff.recurring?.resultingAmount,
    exp.recurringResulting === undefined ? "oracle: recurring is undeterminable from the raw response — no figure may be quoted" : `oracle derived the post-change price level via ${exp.recurringSource}`);
  push("recurring.previousAmount (value)", eff.recurring?.previousAmount === exp.recurringPrevious, exp.recurringPrevious, eff.recurring?.previousAmount,
    "sum of the current items' provider-stated amounts (omitted when any is unstated)");
  push("recurring (provenance)", exp.recurringSource !== "absent" && typeof prov.recurring === "string" && prov.recurring.includes(SOURCE_TOKENS[exp.recurringSource as Exclude<RecurringSource, "absent">]) && !prov.recurring.includes("next_invoice_estimate"),
    exp.recurringSource, prov.recurring,
    "the adapter's recorded provenance must cite the oracle's source and never next_invoice_estimate");
  push("currency", eff.recurring?.currency === ctx.currency, ctx.currency, eff.recurring?.currency, "the subscription's currency_code");
  const mdNi = (md.nextInvoiceEstimate ?? null) as { total?: number; amountDue?: number } | null;
  const niExpected = exp.nextInvoice ? { total: exp.nextInvoice.total, amountDue: exp.nextInvoice.amountDue } : null;
  const niActual = mdNi ? { total: mdNi.total, amountDue: mdNi.amountDue } : null;
  push("nextInvoiceEstimate (metadata only)", JSON.stringify(niExpected) === JSON.stringify(niActual), niExpected, niActual,
    "next-invoice figures must be carried in metadata with raw values intact — and (per the provenance checks above) never serve as an effect source");
  return checks;
}

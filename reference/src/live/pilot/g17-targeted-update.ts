// SCQ G-17 PROTOTYPE — isolated proof of concept for an
// authorization-preserving Chargebee update mechanism (Issue #30).
//
// *** THIS MODULE IS NOT WIRED INTO THE LIVE ADAPTER. ***
// `reference/src/live/chargebee-scq-adapter.ts` is byte-untouched by
// this work: its module-private capability remains
// FULL_REPLACEMENT_ONLY, its dispatch remains `update_for_items`
// with `replace_items_list=true` built from the quote-time list, and
// its PR #24 gate still refuses every OPERATION-authorized update
// commit before dispatch. Nothing here relaxes G-17. This prototype
// exists to determine what evidence a FUTURE, separately reviewed
// adapter change would need — and, where the evidence is not
// available, to fail closed and say exactly why.
//
// Candidate mechanism under test: a MINIMAL additive dispatch —
// `update_for_items` with `replace_items_list=false` and ONLY the
// authorized target item in `subscription_items` — for exactly two
// operation classes:
//   - ADD_ADDON of a new item price (provider-documented additive
//     behavior), and
//   - CHANGE_QUANTITY of an existing per-unit item to an absolute
//     target quantity (documented only as "add or update" wording;
//     same-ID semantics are ASSUMED, never guaranteed — see the
//     mock's rule A1 and the research package §2/§4).
// Every other operation class (REMOVE_ADDON, CHANGE_PLAN,
// CHANGE_CADENCE, CANCEL) is UNSUPPORTED by this prototype and fails
// closed before any transport call, each for a documented reason
// recorded in buildTargetedUpdateParams.
//
// Execution protocol (T0/T2/T3/T4, mirroring Issue #30's threat
// matrix):
//   T0  quote-time snapshot supplied by the caller (the state the
//       authorization was granted against).
//   T2  pre-dispatch re-read. ANY drift from T0 — items, currency,
//       status, plan — refuses before dispatch
//       (REFUSED_PRE_DISPATCH_DRIFT, CONFIRMED_NON_EXECUTION
//       semantics: zero mutating calls). A subscription carrying
//       scheduled changes refuses separately
//       (REFUSED_SCHEDULED_CHANGE_AT_RISK) because the vendor docs
//       state an update DELETES / drafts existing scheduled changes:
//       item preservation alone is not preservation.
//   T3  the minimal additive dispatch, with a native idempotency
//       key. A lost response classifies INDETERMINATE and is never
//       blindly re-dispatched: a later re-read that shows the target
//       in effect is observationally identical to another actor
//       making the same change (the PR #16 L1 lesson).
//   T4  independent re-read (retrieve, not list — Chargebee's own
//       docs warn list APIs are eventually consistent). The verdict
//       compares T4 against T2 + the authorized delta — never
//       against the target set alone (the Issue #22 Finding 1
//       lesson) — and uses the resource_version delta as evidence:
//       exactly one provider change is attributable to this
//       dispatch; a larger delta means interleaved activity whose
//       effect on the target cannot be excluded
//       (PRESERVATION_UNVERIFIABLE), while interleaved activity that
//       is still fully visible and intact at T4 is reported as
//       PRESERVED_WITH_CONCURRENT_CHANGE rather than silently
//       absorbed into a clean verdict.
//
// Every verdict produced against the G-17 mock is SIMULATED
// evidence. No verdict in this module is a live-provider claim.

import { ChargebeeClient, ChargebeeHttpError } from "../chargebee-http.js";

export type G17Operation =
  | { kind: "ADD_ADDON"; itemPriceId: string; quantity: number }
  | { kind: "CHANGE_QUANTITY"; itemPriceId: string; quantity: number }
  | { kind: "REMOVE_ADDON"; itemPriceId: string }
  | { kind: "CHANGE_PLAN"; itemPriceId: string }
  | { kind: "CHANGE_CADENCE"; itemPriceId: string }
  | { kind: "CANCEL" };

export type G17ItemState = {
  itemPriceId: string;
  itemType: string;
  quantity: number;
  unitPrice: number;
  amount: number;
};

export type G17Snapshot = {
  subscriptionId: string;
  status: string;
  currencyCode: string;
  resourceVersion: number;
  hasScheduledChanges: boolean;
  items: G17ItemState[];
};

export type G17Classification =
  | "REFUSED_UNSUPPORTED_OPERATION"
  | "REFUSED_PRE_DISPATCH_DRIFT"
  | "REFUSED_SCHEDULED_CHANGE_AT_RISK"
  | "DISPATCH_REJECTED"
  | "INDETERMINATE"
  | "PRESERVED_VERIFIED"
  | "PRESERVED_WITH_CONCURRENT_CHANGE"
  | "PRESERVATION_UNVERIFIABLE"
  | "PRESERVATION_VIOLATED"
  | "TARGET_NOT_ESTABLISHED";

export type G17Verdict = {
  classification: G17Classification;
  operation: G17Operation["kind"];
  /** True only when a mutating provider request was actually sent. */
  dispatched: boolean;
  /** Human-readable grounds, naming the evidence compared. */
  details: string[];
  /** Evidence class of this verdict. Always SIMULATED in this package. */
  evidence: "SIMULATED";
};

export type G17Prepared = {
  operation: G17Operation;
  params: Record<string, unknown>;
  idempotencyKey: string;
  t2: G17Snapshot;
};

export function snapshotFromSubscriptionJson(json: any, subscriptionId: string): G17Snapshot {
  const sub = json?.subscription;
  if (!sub || typeof sub !== "object") throw new Error("G-17 prototype: subscription response missing `subscription` object");
  return {
    subscriptionId: sub.id ?? subscriptionId,
    status: String(sub.status ?? ""),
    currencyCode: String(sub.currency_code ?? ""),
    resourceVersion: Number(sub.resource_version ?? 0),
    hasScheduledChanges: sub.has_scheduled_changes === true,
    items: (Array.isArray(sub.subscription_items) ? sub.subscription_items : []).map((i: any) => ({
      itemPriceId: String(i.item_price_id),
      itemType: String(i.item_type ?? ""),
      quantity: Number(i.quantity ?? 1),
      unitPrice: Number(i.unit_price ?? 0),
      amount: Number(i.amount ?? 0),
    })),
  };
}

const UNSUPPORTED_REASONS: Record<string, string> = {
  REMOVE_ADDON:
    "Chargebee's own removal guidance requires replace_items_list=true with the retained set (a full-replacement dispatch): additive mode documents no removal semantics, so a targeted removal is not available on this endpoint.",
  CHANGE_PLAN:
    "Additive plan behavior is site-configuration-dependent (multi-plan disabled: existing plan price replaced; enabled: existing plan retained alongside) and plan updates can auto-remove the old plan's mandatory addons under a site setting. Not an operation-preserving targeted mechanism.",
  CHANGE_CADENCE:
    "Cadence is a property of the plan item price (its period); a cadence change IS a plan change on this provider and inherits the CHANGE_PLAN refusal.",
  CANCEL:
    "Cancellation is a different endpoint family (cancel_for_items) with its own documented side effects (deletion of ramps effective on/after the cancellation time; contract-term branches). It is a separate operation class requiring its own assessment; this prototype does not dispatch it.",
};

/**
 * Builds the minimal additive wire parameters for a supported
 * operation, or refuses (throws G17Refusal) for an unsupported one.
 * The payload names ONLY the authorized target item — never the
 * plan, never the retained set — and pins `replace_items_list` to
 * false and `invoice_immediately` to false, matching the current
 * adapter's no-immediate-invoice posture.
 */
export class G17Refusal extends Error {
  constructor(public classification: G17Classification, message: string) { super(message); this.name = "G17Refusal"; }
}

export function buildTargetedUpdateParams(operation: G17Operation): Record<string, unknown> {
  switch (operation.kind) {
    case "ADD_ADDON":
    case "CHANGE_QUANTITY":
      return {
        replace_items_list: false,
        invoice_immediately: false,
        prorate: true,
        subscription_items: [{ item_price_id: operation.itemPriceId, quantity: operation.quantity }],
      };
    default:
      throw new G17Refusal("REFUSED_UNSUPPORTED_OPERATION", UNSUPPORTED_REASONS[operation.kind] ?? `Unsupported operation ${operation.kind}`);
  }
}

function itemMap(items: G17ItemState[]): Map<string, G17ItemState[]> {
  const m = new Map<string, G17ItemState[]>();
  for (const i of items) { const a = m.get(i.itemPriceId) ?? []; a.push(i); m.set(i.itemPriceId, a); }
  return m;
}

function diffSnapshots(base: G17Snapshot, other: G17Snapshot): string[] {
  const diffs: string[] = [];
  if (base.subscriptionId !== other.subscriptionId) diffs.push(`subscription id differs (${base.subscriptionId} -> ${other.subscriptionId})`);
  if (base.status !== other.status) diffs.push(`status differs (${base.status} -> ${other.status})`);
  if (base.currencyCode !== other.currencyCode) diffs.push(`currency differs (${base.currencyCode} -> ${other.currencyCode})`);
  const a = itemMap(base.items); const b = itemMap(other.items);
  for (const id of new Set([...a.keys(), ...b.keys()])) {
    const ai = a.get(id); const bi = b.get(id);
    if (!ai && bi) { diffs.push(`item added: ${id} x${bi[0].quantity}`); continue; }
    if (ai && !bi) { diffs.push(`item removed: ${id}`); continue; }
    if (ai!.length !== bi!.length) { diffs.push(`item entry count differs for ${id} (${ai!.length} -> ${bi!.length})`); continue; }
    if (ai![0].quantity !== bi![0].quantity) diffs.push(`item quantity differs for ${id} (${ai![0].quantity} -> ${bi![0].quantity})`);
    if (ai![0].unitPrice !== bi![0].unitPrice) diffs.push(`item unit price differs for ${id} (${ai![0].unitPrice} -> ${bi![0].unitPrice})`);
  }
  return diffs;
}

export class G17TargetedUpdatePrototype {
  constructor(private client: ChargebeeClient, private subscriptionId: string) {}

  async readSnapshot(): Promise<G17Snapshot> {
    const { json } = await this.client.getSubscription(this.subscriptionId);
    return snapshotFromSubscriptionJson(json, this.subscriptionId);
  }

  /**
   * T2 stage. Throws G17Refusal for every pre-dispatch refusal; a
   * refusal here guarantees ZERO mutating calls were made.
   */
  async prepare(operation: G17Operation, t0: G17Snapshot, idempotencyKey: string): Promise<G17Prepared> {
    const params = buildTargetedUpdateParams(operation); // throws for unsupported ops, before any transport call
    if (operation.kind === "ADD_ADDON" && t0.items.some((i) => i.itemPriceId === operation.itemPriceId)) {
      throw new G17Refusal("REFUSED_UNSUPPORTED_OPERATION", `ADD_ADDON target ${operation.itemPriceId} already exists on the T0 snapshot; adding an existing item price is the CHANGE_QUANTITY class, whose same-ID semantics are separately assumed, not documented.`);
    }
    if (operation.kind === "CHANGE_QUANTITY" && !t0.items.some((i) => i.itemPriceId === operation.itemPriceId)) {
      throw new G17Refusal("REFUSED_UNSUPPORTED_OPERATION", `CHANGE_QUANTITY target ${operation.itemPriceId} is absent from the T0 snapshot; a quantity change for a non-existent item is the ADD_ADDON class.`);
    }
    const t2 = await this.readSnapshot();
    if (t2.hasScheduledChanges) {
      throw new G17Refusal("REFUSED_SCHEDULED_CHANGE_AT_RISK", "T2 re-read shows has_scheduled_changes=true. Chargebee documents that an update deletes an existing scheduled change (Ramps disabled) or deletes/drafts ramps (compatibility mode); dispatching would change state outside the authorized operation even if every item survived.");
    }
    const diffs = diffSnapshots(t0, t2);
    if (diffs.length > 0) {
      throw new G17Refusal("REFUSED_PRE_DISPATCH_DRIFT", `Pre-dispatch re-read (T2) differs from the quote-time snapshot (T0); the authorization and its financial basis no longer describe current state. Drift: ${diffs.join("; ")}`);
    }
    return { operation, params, idempotencyKey, t2 };
  }

  /** T3 stage. Never throws for provider outcomes; classifies them. */
  async dispatch(prepared: G17Prepared): Promise<{ ok: boolean; classification?: G17Classification; details: string[] }> {
    try {
      await this.client.updateForItems(this.subscriptionId, prepared.params, prepared.idempotencyKey);
      return { ok: true, details: ["dispatch returned a success response"] };
    } catch (e) {
      if (e instanceof ChargebeeHttpError && e.indeterminate) {
        return { ok: false, classification: "INDETERMINATE", details: [`dispatch outcome unknown (transport failure after the request may have been processed): ${e.message}. No re-dispatch is attempted; a matching T4 state would be observationally identical to another actor's identical change and cannot promote this verdict.`] };
      }
      if (e instanceof ChargebeeHttpError && e.httpStatus !== undefined && e.httpStatus >= 400 && e.httpStatus < 500) {
        return { ok: false, classification: "DISPATCH_REJECTED", details: [`provider rejected the dispatch (HTTP ${e.httpStatus}${e.apiErrorCode ? `, ${e.apiErrorCode}` : ""}); under the mock's reject behavior no state was applied. Live non-execution would still require the PR-7 allowlist analysis per error code.`] };
      }
      return { ok: false, classification: "INDETERMINATE", details: [`dispatch failed without a classifiable provider rejection: ${e instanceof Error ? e.message : String(e)}`] };
    }
  }

  /** T4 stage: independent re-read and preservation verdict. */
  async verify(prepared: G17Prepared): Promise<G17Verdict> {
    const { operation, t2 } = prepared;
    let t4: G17Snapshot;
    try {
      t4 = await this.readSnapshot();
    } catch (e) {
      return { classification: "INDETERMINATE", operation: operation.kind, dispatched: true, evidence: "SIMULATED", details: [`T4 re-read failed (${e instanceof Error ? e.message : String(e)}); the committed state is unestablishable.`] };
    }
    const details: string[] = [];
    const targetId = operation.kind === "CANCEL" ? undefined : operation.itemPriceId;

    // Target establishment.
    const t4Target = t4.items.filter((i) => i.itemPriceId === targetId);
    if (t4Target.length === 0) {
      return { classification: "TARGET_NOT_ESTABLISHED", operation: operation.kind, dispatched: true, evidence: "SIMULATED", details: [`target item ${targetId} is absent at T4; the dispatch did not establish the authorized change.`] };
    }
    if (t4Target.length > 1) {
      return { classification: "PRESERVATION_VIOLATED", operation: operation.kind, dispatched: true, evidence: "SIMULATED", details: [`target item ${targetId} appears ${t4Target.length} times at T4: additive dispatch duplicated the item instead of updating it in place. The authorized absolute quantity was not the effect.`] };
    }
    if ((operation.kind === "ADD_ADDON" || operation.kind === "CHANGE_QUANTITY") && t4Target[0].quantity !== operation.quantity) {
      if (operation.kind === "CHANGE_QUANTITY" && t4Target[0].quantity === t2.items.find((i) => i.itemPriceId === targetId)?.quantity) {
        return { classification: "TARGET_NOT_ESTABLISHED", operation: operation.kind, dispatched: true, evidence: "SIMULATED", details: [`target item ${targetId} still has its T2 quantity ${t4Target[0].quantity} at T4 despite a success response: the dispatch was silently not applied.`] };
      }
      const summed = operation.kind === "CHANGE_QUANTITY" ? (t2.items.find((i) => i.itemPriceId === targetId)?.quantity ?? 0) + operation.quantity : undefined;
      details.push(`target quantity at T4 is ${t4Target[0].quantity}, not the authorized absolute quantity ${operation.quantity}${summed !== undefined && t4Target[0].quantity === summed ? " — it equals T2 quantity + requested quantity, i.e. the provider SUMMED rather than set (ASSUMED rule A1 alternative)" : ""}.`);
      return { classification: "PRESERVATION_VIOLATED", operation: operation.kind, dispatched: true, evidence: "SIMULATED", details };
    }

    // Unrelated-state preservation: every non-target T2 item must be
    // present at T4 with identical quantity and unit price.
    const violations: string[] = [];
    for (const base of t2.items) {
      if (base.itemPriceId === targetId) continue;
      const now = t4.items.filter((i) => i.itemPriceId === base.itemPriceId);
      if (now.length === 0) violations.push(`unrelated item ${base.itemPriceId} is missing at T4`);
      else if (now.length > 1) violations.push(`unrelated item ${base.itemPriceId} is duplicated at T4`);
      else if (now[0].quantity !== base.quantity || now[0].unitPrice !== base.unitPrice) violations.push(`unrelated item ${base.itemPriceId} changed (${base.quantity}x${base.unitPrice} -> ${now[0].quantity}x${now[0].unitPrice})`);
    }
    if (t4.currencyCode !== t2.currencyCode) violations.push(`currency changed (${t2.currencyCode} -> ${t4.currencyCode})`);
    if (t4.status !== t2.status) violations.push(`status changed (${t2.status} -> ${t4.status})`);
    const t2Plan = t2.items.find((i) => i.itemType === "plan")?.itemPriceId;
    const t4Plan = t4.items.find((i) => i.itemType === "plan")?.itemPriceId;
    if (t2Plan !== t4Plan) violations.push(`plan changed (${t2Plan} -> ${t4Plan})`);
    if (violations.length > 0) {
      return { classification: "PRESERVATION_VIOLATED", operation: operation.kind, dispatched: true, evidence: "SIMULATED", details: violations };
    }

    // Concurrent additions that survived intact: visible at T4,
    // not in T2, not the target. Their survival is the preservation
    // WIN over full replacement — reported, not absorbed.
    const extras = t4.items.filter((i) => i.itemPriceId !== targetId && !t2.items.some((b) => b.itemPriceId === i.itemPriceId));
    const rvDelta = t4.resourceVersion - t2.resourceVersion;
    if (extras.length > 0) {
      details.push(`concurrent item(s) added by another actor are intact at T4: ${extras.map((i) => `${i.itemPriceId} x${i.quantity}`).join(", ")}. Under the current adapter's full replacement they would have been deleted.`);
      if (t4.hasScheduledChanges !== t2.hasScheduledChanges) details.push("scheduled-change flag also changed concurrently (false -> true); the concurrent schedule itself was not deleted by this dispatch.");
      return { classification: "PRESERVED_WITH_CONCURRENT_CHANGE", operation: operation.kind, dispatched: true, evidence: "SIMULATED", details };
    }
    if (t4.hasScheduledChanges !== t2.hasScheduledChanges) {
      details.push(`scheduled-change flag changed (${t2.hasScheduledChanges} -> ${t4.hasScheduledChanges}) with no item evidence; the schedule state the authorization relied on no longer holds.`);
      return { classification: "PRESERVATION_UNVERIFIABLE", operation: operation.kind, dispatched: true, evidence: "SIMULATED", details };
    }
    if (rvDelta !== 1000) {
      // The mock bumps resource_version by exactly 1000 per change
      // (D6 model). Anything else means interleaved activity that
      // left no net item trace — e.g. a same-item change that this
      // dispatch then overwrote. In live terms the exact step is a
      // mock artifact; the transferable claim is only that a
      // version delta beyond the dispatch's own change is positive
      // evidence of unobserved interleaved activity.
      details.push(`resource_version advanced by ${rvDelta} (mock units), more than this dispatch alone explains: interleaved activity occurred in the T2->T4 window and left no net item trace. Whether it touched the target item cannot be excluded — under the mock's set semantics a same-item interleaved change WAS overwritten by this dispatch.`);
      return { classification: "PRESERVATION_UNVERIFIABLE", operation: operation.kind, dispatched: true, evidence: "SIMULATED", details };
    }
    details.push("T4 equals T2 + exactly the authorized delta; resource_version advanced by exactly the dispatch's own step; no scheduled changes existed at T2 and none were affected.");
    return { classification: "PRESERVED_VERIFIED", operation: operation.kind, dispatched: true, evidence: "SIMULATED", details };
  }

  /** Full T0->T4 run. Refusals return verdicts; they never throw. */
  async execute(operation: G17Operation, t0: G17Snapshot, idempotencyKey: string): Promise<G17Verdict> {
    let prepared: G17Prepared;
    try {
      prepared = await this.prepare(operation, t0, idempotencyKey);
    } catch (e) {
      if (e instanceof G17Refusal) return { classification: e.classification, operation: operation.kind, dispatched: false, evidence: "SIMULATED", details: [e.message] };
      throw e;
    }
    const outcome = await this.dispatch(prepared);
    if (!outcome.ok) {
      return { classification: outcome.classification ?? "INDETERMINATE", operation: operation.kind, dispatched: true, evidence: "SIMULATED", details: outcome.details };
    }
    return this.verify(prepared);
  }
}

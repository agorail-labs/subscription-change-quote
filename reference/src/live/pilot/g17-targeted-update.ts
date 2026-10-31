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
// PROVIDER operation classes:
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
// SCOPE CORRECTION (G17-R1, independent review of PR #38): the
// operation labels above are PROVIDER operation classes, not SCQ
// actions. The SCQ action schema (core/types.ts `ChangeAction`)
// contains exactly CHANGE_QUANTITY, CHANGE_PLAN, CHANGE_CADENCE and
// CANCEL — there is NO ADD_ADDON (or REMOVE_ADDON) SCQ action. The
// positive ADD_ADDON result therefore demonstrates a provider
// capability only; it is not currently a path by which any SCQ
// proposal can execute, and making it one would require separately
// approved normative / schema / capability / adapter / conformance
// work. Every verdict carries `inScqActionSchema` so this cannot be
// misread downstream. Among the actions SCQ does have,
// CHANGE_QUANTITY remains unproven (ASSUMED A1 + the G17-R2
// evidence ceiling below).
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
//       lesson).
//
// EVIDENCE CORRECTIONS (G17-R2/R3/R4, independent review of
// PR #38 — these supersede the first version's T4 treatment):
//   R2. `resource_version` is a millisecond TIMESTAMP, not a change
//       counter and not a causal token. A timestamp delta measures
//       elapsed time: it cannot count changes (same-millisecond
//       changes collide at one version), cannot attribute them, and
//       its magnitude carries no evidentiary weight. The first
//       version of this prototype classified on a synthetic +1000
//       mock step; that inference is REMOVED. The version is now
//       recorded only as changed/unchanged colour in the details.
//       Consequence: for CHANGE_QUANTITY, whose target item already
//       exists, an interleaved same-item change overwritten by this
//       dispatch is observationally indistinguishable from a clean
//       run — so the verdict ceiling for that class is
//       PRESERVATION_UNVERIFIABLE absent independent
//       operation-bound proof, even when the target state is
//       observed in effect.
//   R3. The scheduled-change dimension is NOT verifiable from a
//       Boolean flag: a schedule created after T2 and deleted by
//       the T3 dispatch leaves T4's flag identical to the
//       no-schedule baseline. ADD_ADDON is therefore NOT
//       authorization-preserving under all authorized-state
//       dimensions merely because its item list is additive; the
//       schedule-history dimension is declared unverifiable in
//       every post-dispatch verdict.
//   R4. The verdict inspects ONLY a mock-visible subset: item IDs,
//       quantities, unit prices, currency, status, plan identity,
//       and the scheduling flag. It does NOT establish preservation
//       of discounts/coupons, billing timing, mandatory-addon
//       associations, contractual terms, or provider-side financial
//       effects (see G17_UNOBSERVABLE_DIMENSIONS). The positive
//       classifications are named ITEM_PRESERVED_* and every
//       verdict carries scope "MOCK_VISIBLE_ITEM_SUBSET_ONLY" and
//       interleavingExcluded: false. No verdict here is, or may be
//       translated into, a general SCQ verified-receipt claim.
//
// SAFETY CORRECTIONS (G17-R5/R6, independent re-review of PR #38):
//   R5. MOCK-ONLY BY CONSTRUCTION. The first version accepted any
//       ChargebeeClient — including one backed by the default fetch
//       transport and real credentials — which would have made this
//       research module a live-mutation path bypassing the live
//       adapter's guard. The constructor now accepts ONLY a
//       G17MockChargebee instance (checked at runtime, so casts and
//       plain-JS consumers are also refused) and builds its own
//       client over the mock's transport. There is no environment
//       flag or configuration that makes a real client eligible.
//   R6. FAIL-CLOSED ON MISSING PROVIDER EVIDENCE. Snapshot parsing
//       used to manufacture reassuring defaults (expected id when
//       the provider id was absent, `false` for a missing
//       scheduling flag, 0/1 for missing item fields). Absent or
//       invalid REQUIRED evidence — subscription identity, status,
//       currency, resource_version, has_scheduled_changes,
//       has_scheduled_advance_invoices, and per-item identity /
//       quantity / unit price / amount — is now a pre-dispatch
//       refusal (REFUSED_MISSING_PROVIDER_EVIDENCE), the expected
//       subscription identity is checked on every read, and
//       scheduled advance invoices must be present AND false
//       (mirroring the pilot preflight's requirement) or the
//       dispatch refuses as a scheduled-effect risk.
//
// Every verdict produced against the G-17 mock is SIMULATED
// evidence. No verdict in this module is a live-provider claim.

import { ChargebeeClient, ChargebeeHttpError } from "../chargebee-http.js";
import { G17MockChargebee } from "./g17-mock-transport.js";

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
  hasScheduledAdvanceInvoices: boolean;
  items: G17ItemState[];
};

export type G17Classification =
  | "REFUSED_UNSUPPORTED_OPERATION"
  | "REFUSED_MISSING_PROVIDER_EVIDENCE"
  | "REFUSED_PRE_DISPATCH_DRIFT"
  | "REFUSED_SCHEDULED_CHANGE_AT_RISK"
  | "DISPATCH_REJECTED"
  | "INDETERMINATE"
  | "ITEM_PRESERVED_OBSERVED"
  | "ITEM_PRESERVED_WITH_CONCURRENT_CHANGE"
  | "PRESERVATION_UNVERIFIABLE"
  | "PRESERVATION_VIOLATED"
  | "TARGET_NOT_ESTABLISHED";

/**
 * The SCQ action schema, mirrored from core/types.ts `ChangeAction`
 * (pinned against the source by test 57.31). ADD_ADDON and
 * REMOVE_ADDON are provider operation classes with NO counterpart
 * here (G17-R1).
 */
export const SCQ_CHANGE_ACTIONS = ["CHANGE_QUANTITY", "CHANGE_PLAN", "CHANGE_CADENCE", "CANCEL"] as const;

export function isScqChangeAction(kind: G17Operation["kind"]): boolean {
  return (SCQ_CHANGE_ACTIONS as readonly string[]).includes(kind);
}

/**
 * Authorized-state dimensions this prototype's T4 comparison does
 * NOT observe and therefore never certifies (G17-R3/R4). Carried on
 * every post-dispatch verdict so the scope limit travels with the
 * result instead of living only in prose.
 */
export const G17_UNOBSERVABLE_DIMENSIONS = [
  "discounts and coupons (applied, removed, or repriced)",
  "billing timing (next_billing_at, term boundaries, proration timing)",
  "mandatory-addon associations beyond item presence",
  "contractual terms and contract-term state",
  "credits, unbilled charges and invoice effects beyond the response shape",
  "payment method, metadata and other subscription attributes",
  "scheduled-change history (a schedule created and deleted inside the window leaves the T4 flag identical to baseline)",
] as const;

export type G17Verdict = {
  classification: G17Classification;
  operation: G17Operation["kind"];
  /** True only when a mutating provider request was actually sent. */
  dispatched: boolean;
  /** Human-readable grounds, naming the evidence compared. */
  details: string[];
  /** Evidence class of this verdict. Always SIMULATED in this package. */
  evidence: "SIMULATED";
  /** G17-R4: the ONLY state this verdict speaks for. */
  scope: "MOCK_VISIBLE_ITEM_SUBSET_ONLY";
  /** G17-R1: whether this operation class exists in the SCQ action schema. */
  inScqActionSchema: boolean;
  /** G17-R2/R3: this prototype NEVER excludes interleaved activity. Always false. */
  interleavingExcluded: false;
  /** G17-R3/R4: dimensions never certified by any verdict here. */
  unobservableDimensions: readonly string[];
};

function mkVerdict(classification: G17Classification, operation: G17Operation["kind"], dispatched: boolean, details: string[]): G17Verdict {
  return {
    classification,
    operation,
    dispatched,
    details,
    evidence: "SIMULATED",
    scope: "MOCK_VISIBLE_ITEM_SUBSET_ONLY",
    inScqActionSchema: isScqChangeAction(operation),
    interleavingExcluded: false,
    unobservableDimensions: G17_UNOBSERVABLE_DIMENSIONS,
  };
}

export type G17Prepared = {
  operation: G17Operation;
  params: Record<string, unknown>;
  idempotencyKey: string;
  t2: G17Snapshot;
};

/** Thrown when a provider read lacks REQUIRED evidence (G17-R6). */
export class G17MissingEvidenceError extends Error {
  constructor(message: string) { super(message); this.name = "G17MissingEvidenceError"; }
}

function reqString(v: unknown, field: string): string {
  if (typeof v !== "string" || v.trim() === "") throw new G17MissingEvidenceError(`required provider evidence missing or invalid: ${field}`);
  return v;
}
function reqBool(v: unknown, field: string): boolean {
  if (typeof v !== "boolean") throw new G17MissingEvidenceError(`required provider evidence missing or invalid: ${field} (a missing/unknown scheduling flag is NOT read as false)`);
  return v;
}
function reqNumber(v: unknown, field: string, opts: { min?: number; exclusiveMin?: boolean } = {}): number {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new G17MissingEvidenceError(`required provider evidence missing or invalid: ${field} (no value is fabricated)`);
  if (opts.min !== undefined && (opts.exclusiveMin ? v <= opts.min : v < opts.min)) throw new G17MissingEvidenceError(`required provider evidence out of range: ${field}=${v}`);
  return v;
}

/**
 * Strict snapshot parser (G17-R6). NOTHING is defaulted: the
 * provider's own subscription id is required (never replaced by the
 * expected id), both scheduling flags are required booleans, and
 * every item must carry identity, type, quantity, unit price and
 * amount. Any gap throws G17MissingEvidenceError, which the
 * prototype converts into a pre-dispatch refusal.
 */
export function snapshotFromSubscriptionJson(json: any): G17Snapshot {
  const sub = json?.subscription;
  if (!sub || typeof sub !== "object") throw new G17MissingEvidenceError("provider response missing the `subscription` object entirely");
  if (!Array.isArray(sub.subscription_items) || sub.subscription_items.length === 0) {
    throw new G17MissingEvidenceError("required provider evidence missing or invalid: subscription.subscription_items (absent or empty item evidence cannot ground a preservation claim)");
  }
  return {
    subscriptionId: reqString(sub.id, "subscription.id"),
    status: reqString(sub.status, "subscription.status"),
    currencyCode: reqString(sub.currency_code, "subscription.currency_code"),
    resourceVersion: reqNumber(sub.resource_version, "subscription.resource_version"),
    hasScheduledChanges: reqBool(sub.has_scheduled_changes, "subscription.has_scheduled_changes"),
    hasScheduledAdvanceInvoices: reqBool(sub.has_scheduled_advance_invoices, "subscription.has_scheduled_advance_invoices"),
    items: sub.subscription_items.map((i: any, idx: number) => ({
      itemPriceId: reqString(i?.item_price_id, `subscription_items[${idx}].item_price_id`),
      itemType: reqString(i?.item_type, `subscription_items[${idx}].item_type`),
      quantity: reqNumber(i?.quantity, `subscription_items[${idx}].quantity`, { min: 0, exclusiveMin: true }),
      unitPrice: reqNumber(i?.unit_price, `subscription_items[${idx}].unit_price`, { min: 0 }),
      amount: reqNumber(i?.amount, `subscription_items[${idx}].amount`, { min: 0 }),
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
  private client: ChargebeeClient;

  /**
   * G17-R5: mock-only BY CONSTRUCTION. The only accepted first
   * argument is a G17MockChargebee instance; the prototype builds
   * its own ChargebeeClient over the mock's transport and never
   * sees caller-supplied credentials, sites, or transports. A
   * ChargebeeClient — default (real fetch) or otherwise — is
   * ineligible, and the runtime instanceof check refuses casts and
   * plain-JS consumers as well. No flag re-enables a real client.
   */
  constructor(mock: G17MockChargebee, private subscriptionId: string) {
    if (!(mock instanceof G17MockChargebee)) {
      throw new Error("G17TargetedUpdatePrototype is mock-only by construction (G17-R5): its first argument must be a G17MockChargebee instance. A ChargebeeClient (default real-HTTP or otherwise), a raw transport, or any live-capable object is ineligible, and no configuration makes it eligible.");
    }
    this.client = new ChargebeeClient({ site: "g17-mock", apiKey: "g17-mock-key" }, mock.transport);
  }

  async readSnapshot(): Promise<G17Snapshot> {
    const { json } = await this.client.getSubscription(this.subscriptionId);
    let snap: G17Snapshot;
    try {
      snap = snapshotFromSubscriptionJson(json);
    } catch (e) {
      if (e instanceof G17MissingEvidenceError) throw new G17Refusal("REFUSED_MISSING_PROVIDER_EVIDENCE", `${e.message}. Missing provider evidence is unknown, not a reassuring default; the prototype refuses before any dispatch.`);
      throw e;
    }
    if (snap.subscriptionId !== this.subscriptionId) {
      throw new G17Refusal("REFUSED_MISSING_PROVIDER_EVIDENCE", `provider read identified subscription "${snap.subscriptionId}", not the expected "${this.subscriptionId}". Identity is established from the provider response, never manufactured from the request.`);
    }
    return snap;
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
    if (t0.subscriptionId !== this.subscriptionId) {
      throw new G17Refusal("REFUSED_MISSING_PROVIDER_EVIDENCE", `the T0 snapshot identifies subscription "${t0.subscriptionId}", not the expected "${this.subscriptionId}". Two matching foreign or identity-less reads do not establish identity (G17-R6).`);
    }
    const t2 = await this.readSnapshot();
    if (t0.hasScheduledAdvanceInvoices || t2.hasScheduledAdvanceInvoices) {
      throw new G17Refusal("REFUSED_SCHEDULED_CHANGE_AT_RISK", "scheduled advance invoices are present (has_scheduled_advance_invoices=true). The pilot preflight requires this flag present AND false for the same reason as scheduled changes: an update interacts with scheduled financial effects outside the authorized operation.");
    }
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

  /** T4 stage: independent re-read and preservation verdict.
   * The verdict covers ONLY the mock-visible item subset (R4);
   * `resource_version` is reported as changed/unchanged colour and
   * is NEVER used to count or attribute changes (R2). */
  async verify(prepared: G17Prepared): Promise<G17Verdict> {
    const { operation, t2 } = prepared;
    let t4: G17Snapshot;
    try {
      t4 = await this.readSnapshot();
    } catch (e) {
      return mkVerdict("INDETERMINATE", operation.kind, true, [`T4 re-read failed (${e instanceof Error ? e.message : String(e)}); the committed state is unestablishable.`]);
    }
    const details: string[] = [];
    details.push(`resource_version ${t4.resourceVersion === t2.resourceVersion ? "is UNCHANGED" : "changed"} between T2 and T4 (${t2.resourceVersion} -> ${t4.resourceVersion}). It is a millisecond timestamp: this fact counts no changes and attributes none (G17-R2).`);
    const targetId = operation.kind === "CANCEL" ? undefined : operation.itemPriceId;

    // Target establishment.
    const t4Target = t4.items.filter((i) => i.itemPriceId === targetId);
    if (t4Target.length === 0) {
      return mkVerdict("TARGET_NOT_ESTABLISHED", operation.kind, true, [...details, `target item ${targetId} is absent at T4; the dispatch did not establish the authorized change.`]);
    }
    if (t4Target.length > 1) {
      return mkVerdict("PRESERVATION_VIOLATED", operation.kind, true, [...details, `target item ${targetId} appears ${t4Target.length} times at T4: additive dispatch duplicated the item instead of updating it in place. The authorized absolute quantity was not the effect.`]);
    }
    if ((operation.kind === "ADD_ADDON" || operation.kind === "CHANGE_QUANTITY") && t4Target[0].quantity !== operation.quantity) {
      if (operation.kind === "CHANGE_QUANTITY" && t4Target[0].quantity === t2.items.find((i) => i.itemPriceId === targetId)?.quantity) {
        return mkVerdict("TARGET_NOT_ESTABLISHED", operation.kind, true, [...details, `target item ${targetId} still has its T2 quantity ${t4Target[0].quantity} at T4 despite a success response: the dispatch was silently not applied.`]);
      }
      const summed = operation.kind === "CHANGE_QUANTITY" ? (t2.items.find((i) => i.itemPriceId === targetId)?.quantity ?? 0) + operation.quantity : undefined;
      details.push(`target quantity at T4 is ${t4Target[0].quantity}, not the authorized absolute quantity ${operation.quantity}${summed !== undefined && t4Target[0].quantity === summed ? " — it equals T2 quantity + requested quantity, i.e. the provider SUMMED rather than set (ASSUMED rule A1 alternative)" : ""}.`);
      return mkVerdict("PRESERVATION_VIOLATED", operation.kind, true, details);
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
      return mkVerdict("PRESERVATION_VIOLATED", operation.kind, true, [...details, ...violations]);
    }

    // Concurrent additions that survived intact: visible at T4,
    // not in T2, not the target. Their survival is the item-list
    // WIN over full replacement — reported, not absorbed.
    const extras = t4.items.filter((i) => i.itemPriceId !== targetId && !t2.items.some((b) => b.itemPriceId === i.itemPriceId));

    // G17-R2 ceiling: for CHANGE_QUANTITY the target item already
    // existed, so an interleaved same-item change overwritten by
    // this dispatch is observationally indistinguishable from a
    // clean run under timestamp-only evidence. The target state
    // being observed in effect does NOT lift the ceiling: absent
    // independent operation-bound proof, this class is UNVERIFIABLE
    // even on its happiest path.
    if (operation.kind === "CHANGE_QUANTITY") {
      details.push(`target item ${targetId} is observed at T4 with the authorized quantity ${operation.quantity} and no unrelated item in the visible subset is contradicted. CEILING (G17-R2): an interleaved change to the SAME item inside the T2->T4 window, overwritten by this dispatch, would leave exactly this T4 state; timestamp evidence cannot exclude it and there is no provider-enforced before/after causal token for this mutation. Verdict is therefore capped at PRESERVATION_UNVERIFIABLE.`);
      if (extras.length > 0) details.push(`concurrent item(s) intact at T4: ${extras.map((i) => `${i.itemPriceId} x${i.quantity}`).join(", ")} — observed, but they do not lift the same-item ceiling.`);
      return mkVerdict("PRESERVATION_UNVERIFIABLE", operation.kind, true, details);
    }

    if (extras.length > 0) {
      details.push(`concurrent item(s) added by another actor are intact at T4: ${extras.map((i) => `${i.itemPriceId} x${i.quantity}`).join(", ")}. Under the current adapter's full replacement they would have been deleted.`);
      if (t4.hasScheduledChanges !== t2.hasScheduledChanges) details.push("scheduled-change flag also changed concurrently (false -> true); that schedule's own history is outside the verified subset.");
      details.push("Scope: ITEM subset only. Interleaved histories that leave no net item trace (add-then-remove, schedule created-then-deleted) are NOT excluded by this verdict (G17-R2/R3).");
      return mkVerdict("ITEM_PRESERVED_WITH_CONCURRENT_CHANGE", operation.kind, true, details);
    }
    if (t4.hasScheduledChanges !== t2.hasScheduledChanges) {
      details.push(`scheduled-change flag changed (${t2.hasScheduledChanges} -> ${t4.hasScheduledChanges}) with no item evidence; the schedule state the authorization relied on no longer holds, and schedule history is not reconstructible from the flag.`);
      return mkVerdict("PRESERVATION_UNVERIFIABLE", operation.kind, true, details);
    }
    details.push("T4's visible item subset equals T2 + exactly the authorized delta, and no concurrent item change is visible. Scope limits (G17-R2/R3/R4): this is an ITEM-subset observation only — interleaving is NOT excluded (an add-then-remove or a same-millisecond change leaves this exact trace), scheduled-change HISTORY is unverifiable (a schedule created after T2 and deleted by this dispatch leaves the T4 flag identical to baseline), and the unobservable dimensions carried on this verdict are not certified.");
    return mkVerdict("ITEM_PRESERVED_OBSERVED", operation.kind, true, details);
  }

  /** Full T0->T4 run. Refusals return verdicts; they never throw. */
  async execute(operation: G17Operation, t0: G17Snapshot, idempotencyKey: string): Promise<G17Verdict> {
    let prepared: G17Prepared;
    try {
      prepared = await this.prepare(operation, t0, idempotencyKey);
    } catch (e) {
      if (e instanceof G17Refusal) return mkVerdict(e.classification, operation.kind, false, [e.message]);
      throw e;
    }
    const outcome = await this.dispatch(prepared);
    if (!outcome.ok) {
      return mkVerdict(outcome.classification ?? "INDETERMINATE", operation.kind, true, outcome.details);
    }
    return this.verify(prepared);
  }
}

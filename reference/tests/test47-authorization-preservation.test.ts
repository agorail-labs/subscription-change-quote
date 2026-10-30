/**
 * Test 47 — SCQ PR-14: fail-closed authorization preservation for the
 * experimental Chargebee-LIVE adapter (Issue #22, Finding 1 / P0;
 * research evidence: PR #23, repro43 + AUTHORIZATION-PRESERVATION-
 * CONTRACT.md).
 *
 * The defect (CONFIRMED in PR #23): an OPERATION-authorized commit
 * whose dispatch is a full-list replacement (`update_for_items` with
 * `replace_items_list=true`, built from the quote-time item list)
 * can silently delete unrelated subscription state that changed
 * after the quote — and the receipt reported COMMITTED_AND_VERIFIED
 * / OK, because every verification compared the landed state against
 * the intended target set, never against baseline + authorized
 * delta. Chargebee's documented surface offers this adapter no
 * conditional write and no targeted update for this operation class
 * (PR #23 capability assessment): the dispatch mechanism is
 * FULL_REPLACEMENT_ONLY, so preservation of unrelated state cannot
 * be enforced atomically — and a non-atomic replacement is not made
 * safe by the absence of OBSERVED concurrency.
 *
 * PR-14's correction (this suite is its production regression
 * coverage):
 *  - Authorization scope is explicit and defaults to OPERATION:
 *    only the requested mutation is authorized; unrelated items and
 *    quantities are protected; target-state equality never proves
 *    preservation; consent to full-list replacement is never
 *    inferred. A proposal declaring TARGET_REPLACEMENT is refused
 *    at quote creation as unsupported in this PR — never honored,
 *    never silently downgraded, and no configuration flag, option,
 *    or environment variable bypasses the gate.
 *  - The adapter declares its mutation capability FROM its actual
 *    mechanism (FULL_REPLACEMENT_ONLY), records scope + capability
 *    on every quote it creates, and discloses at quote time that
 *    OPERATION-authorized update commits will be refused.
 *  - The commit gate sits after the existing expiry / fingerprint /
 *    revalidation-envelope / live-commit-enabled checks and BEFORE
 *    the durable write-ahead gate (`beginDispatch`) and before any
 *    mutating HTTP request: an OPERATION-authorized commit on a
 *    FULL_REPLACEMENT_ONLY capability refuses with
 *    AUTHORIZATION_PRESERVATION_UNENFORCEABLE and
 *    CONFIRMED_NON_EXECUTION outcome semantics — a distinct
 *    pre-dispatch refusal, never INDETERMINATE, no receipt, no
 *    durable DISPATCHING attempt, and a retry returns the identical
 *    refusal deterministically. The commit consults the ADAPTER's
 *    authoritative capability: a quote record claiming a stronger
 *    capability (forged or merely mismatched) cannot bypass the
 *    gate, and an absent/unknown recorded capability classifies as
 *    the weakest. Legacy stored quotes (no authorization metadata)
 *    are OPERATION + adapter capability by default and refuse too.
 *
 * Relationship to repro43 (kept byte-unchanged as historical
 * research evidence): 47.1 converts 43.1's scenario to the refusal
 * behavior; 47.2 DELIBERATELY REPLACES 43.2's control expectation —
 * 43.2 asserted that the same commit with NO concurrent write
 * verifies cleanly, which encoded exactly the unsafe assumption
 * this PR removes (an unobserved race is still a race); 47.3
 * preserves 43.3's stale-quote refusal.
 *
 * Note on the classification-distinction control (47.10): after
 * this PR, the live adapter has NO reachable dispatched-failure
 * path for update quotes — every update commit refuses
 * pre-dispatch, by design. The unknown-dispatch INDETERMINATE
 * machinery is preserved unmodified for a future permitting
 * capability; 47.10 proves the two classes remain distinct in the
 * store's semantics (a recorded INDETERMINATE still blocks blind
 * retry through its own guard; the preservation refusal does not
 * record one and re-refuses deterministically). The live adapter
 * also has no CANCEL dispatch at all (47.12): CANCEL quotes are
 * refused at creation, so there is no cancel commit path to gate —
 * the brief's example of a dispatched-failure control on a cancel
 * path does not exist in this adapter and is covered instead by
 * 47.10's store-level distinction plus the untouched durable
 * recovery suites (test27, rehearsal rh-04/05).
 *
 * Every mutation-path exercise here uses an injected mocked
 * transport. No network, no credentials, SCQ_LIVE_COMMIT_ENABLED
 * never set. Evidence class: SIMULATED.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QuoteStore } from "../src/store/quote-store.js";
import { DurableQuoteStore } from "../src/store/durable-store.js";
import { DurableMutationCoordinator } from "../src/store/mutation-coordinator.js";
import { SCQError } from "../src/core/types.js";
import { ChargebeeClient, type HttpRequest, type HttpResponse, type HttpTransport } from "../src/live/chargebee-http.js";
import { ChargebeeLiveAdapter } from "../src/live/chargebee-scq-adapter.js";
import { ChargebeeAdapter } from "../src/adapters/chargebee-adapter.js";
import { ChargebeeSim, type ChargebeeSubscription } from "../src/adapters/chargebee-sim.js";

const SUB = "pilot-sub-001";
const PLAN = "pilot-plan-business";
const ADDON = "pilot-addon-vision";
const CONCURRENT = "pilot-addon-concurrent";
const SITE = "pilot-test";

const CATALOG: Record<string, { price: number; pricing_model: string; item_type: string }> = {
  [PLAN]: { price: 59900, pricing_model: "flat_fee", item_type: "plan" },
  [ADDON]: { price: 10000, pricing_model: "per_unit", item_type: "addon" },
  [CONCURRENT]: { price: 2500, pricing_model: "flat_fee", item_type: "addon" },
};

type MockItem = { item_price_id: string; item_type: string; quantity: number; unit_price: number; amount: number; free_quantity?: number };

function amountOf(itemPriceId: string, quantity: number, unitPrice: number): number {
  return CATALOG[itemPriceId]?.pricing_model === "flat_fee" ? unitPrice : unitPrice * quantity;
}

/**
 * Self-contained scripted mock (a copy of repro43's fixture, kept
 * independent so repro43 stays byte-unchanged as historical
 * evidence): `update_for_items` applies `replace_items_list=true`
 * as a wholesale replacement — Chargebee's documented semantics
 * for a plan-inclusive list.
 */
class PreservationMockChargebee {
  calls: Array<{ seq: number; method: string; path: string; body?: string }> = [];
  updateDispatches: Array<{ params: Record<string, string>; rawBody: string }> = [];
  concurrentAddAt: { afterCallSeq: number; stateAfterAdd: string[] } | undefined;
  private seq = 0;
  private resourceVersion = 1700000000000;
  private items: MockItem[] = [
    { item_price_id: PLAN, item_type: "plan", quantity: 1, unit_price: 59900, amount: 59900 },
    { item_price_id: ADDON, item_type: "addon", quantity: 1, unit_price: 1000, amount: 1000, free_quantity: 0 },
  ];
  private armed = false;

  armConcurrentAddOnNextEstimate(): void { this.armed = true; }
  applyConcurrentAddNow(): void { this.addConcurrent(); }

  private addConcurrent(): void {
    if (!this.items.some((i) => i.item_price_id === CONCURRENT)) {
      this.items.push({ item_price_id: CONCURRENT, item_type: "addon", quantity: 1, unit_price: 2500, amount: 2500 });
    }
    this.resourceVersion += 1000;
    this.concurrentAddAt = {
      afterCallSeq: this.seq,
      stateAfterAdd: this.items.map((i) => `${i.item_price_id} x${i.quantity}`),
    };
  }

  itemIds(): string[] { return this.items.map((i) => i.item_price_id); }

  private subscriptionJson(): any {
    return {
      subscription: {
        id: SUB,
        status: "active",
        currency_code: "USD",
        resource_version: this.resourceVersion,
        current_term_start: 1700000000,
        current_term_end: 1702592000,
        next_billing_at: 1702592000,
        has_scheduled_changes: false,
        has_scheduled_advance_invoices: false,
        subscription_items: this.items.map((i) => ({ ...i })),
      },
    };
  }

  private parseItems(body: string): Array<{ item_price_id: string; quantity: number }> {
    const params = new URLSearchParams(body);
    const byIndex = new Map<number, { item_price_id?: string; quantity?: number }>();
    for (const [k, v] of params.entries()) {
      const m = k.match(/^subscription_items\[(item_price_id|quantity)\]\[(\d+)\]$/);
      if (!m) continue;
      const idx = Number(m[2]);
      const entry = byIndex.get(idx) ?? {};
      if (m[1] === "item_price_id") entry.item_price_id = v; else entry.quantity = Number(v);
      byIndex.set(idx, entry);
    }
    return [...byIndex.entries()].sort((a, b) => a[0] - b[0]).map(([, e]) => ({ item_price_id: e.item_price_id!, quantity: e.quantity ?? 1 }));
  }

  private buildEstimate(requested: Array<{ item_price_id: string; quantity: number }>): any {
    const currentAddon = this.items.find((i) => i.item_price_id === ADDON)!;
    const targetAddon = requested.find((i) => i.item_price_id === ADDON);
    const delta = (targetAddon?.quantity ?? currentAddon.quantity) - currentAddon.quantity;
    const incurred = delta * currentAddon.unit_price;
    const stated = requested.map((r) => {
      const cur = this.items.find((i) => i.item_price_id === r.item_price_id);
      const unitPrice = cur?.unit_price ?? CATALOG[r.item_price_id]?.price ?? 0;
      return { item_price_id: r.item_price_id, quantity: r.quantity, unit_price: unitPrice, amount: amountOf(r.item_price_id, r.quantity, unitPrice) };
    });
    return {
      estimate: {
        unbilled_charge_estimates: incurred !== 0 ? [{ amount: incurred }] : [],
        credit_note_estimates: [],
        subscription_estimate: { subscription_items: stated },
      },
    };
  }

  private applyUpdate(requested: Array<{ item_price_id: string; quantity: number }>): any {
    const beforeVision = this.items.find((i) => i.item_price_id === ADDON)?.quantity ?? 0;
    this.items = requested.map((r) => {
      const cur = this.items.find((i) => i.item_price_id === r.item_price_id);
      const unitPrice = cur?.unit_price ?? CATALOG[r.item_price_id]?.price ?? 0;
      return {
        item_price_id: r.item_price_id,
        item_type: CATALOG[r.item_price_id]?.item_type ?? "addon",
        quantity: r.quantity,
        unit_price: unitPrice,
        amount: amountOf(r.item_price_id, r.quantity, unitPrice),
        ...(CATALOG[r.item_price_id]?.pricing_model === "per_unit" ? { free_quantity: 0 } : {}),
      };
    });
    this.resourceVersion += 1000;
    const afterVision = this.items.find((i) => i.item_price_id === ADDON)?.quantity ?? 0;
    const incurred = (afterVision - beforeVision) * 1000;
    return { subscription: this.subscriptionJson().subscription, unbilled_charges: [{ amount: incurred }] };
  }

  transport: HttpTransport = async (req: HttpRequest): Promise<HttpResponse> => {
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/api\/v2/, "");
    this.seq += 1;
    this.calls.push({ seq: this.seq, method: req.method, path, body: req.body });
    const json = (status: number, body: any): HttpResponse => ({ status, headers: {}, json: body });

    if (req.method === "GET" && path.startsWith("/subscriptions/")) return json(200, this.subscriptionJson());
    if (req.method === "GET" && path.startsWith("/item_prices/")) {
      const id = decodeURIComponent(path.slice("/item_prices/".length));
      const meta = CATALOG[id];
      if (!meta) return json(404, { api_error_code: "resource_not_found" });
      return json(200, { item_price: { id, pricing_model: meta.pricing_model, price: meta.price, free_quantity: 0, item_type: meta.item_type } });
    }
    if (req.method === "POST" && path === "/estimates/update_subscription_for_items") {
      if (this.armed) { this.armed = false; this.addConcurrent(); }
      return json(200, this.buildEstimate(this.parseItems(req.body ?? "")));
    }
    if (req.method === "POST" && path.includes("/update_for_items")) {
      const params: Record<string, string> = {};
      for (const [k, v] of new URLSearchParams(req.body ?? "").entries()) params[k] = v;
      this.updateDispatches.push({ params, rawBody: req.body ?? "" });
      return json(200, this.applyUpdate(this.parseItems(req.body ?? "")));
    }
    return json(404, { api_error_code: "resource_not_found" });
  };
}

const PROPOSAL = (qty: number) => ({
  changes: [{ action: "CHANGE_QUANTITY" as const, itemId: ADDON, quantity: qty }],
  effectiveIntent: { type: "IMMEDIATE" as const },
  acceptanceEnvelope: {},
});

function codeOf(e: unknown): string {
  return e instanceof SCQError ? String(e.code) : `non-SCQError: ${String(e)}`;
}

function detailsOf(e: unknown): any {
  return e instanceof SCQError ? (e.details as any) : undefined;
}

/** Asserts the full preservation-refusal shape and returns the error for further checks. */
async function expectPreservationRefusal(p: () => Promise<unknown>): Promise<SCQError> {
  let err: unknown;
  try {
    await p();
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof SCQError, `expected an SCQError refusal, got: ${String(err)}`);
  assert.equal(codeOf(err), "AUTHORIZATION_PRESERVATION_UNENFORCEABLE", `expected the preservation refusal code, got ${codeOf(err)}`);
  const d = detailsOf(err);
  assert.equal(d?.outcome, "CONFIRMED_NON_EXECUTION", "a pre-dispatch refusal is CONFIRMED_NON_EXECUTION — nothing was dispatched");
  assert.notEqual(d?.indeterminate, true, "a pre-dispatch refusal must never be classified INDETERMINATE");
  return err as SCQError;
}

function makeAdapter(mock: PreservationMockChargebee, store: QuoteStore = new QuoteStore()) {
  const client = new ChargebeeClient({ site: SITE, apiKey: "pilot-mock-key" }, mock.transport);
  const adapter = new ChargebeeLiveAdapter(client, store, { liveCommitEnabled: true });
  return { adapter, store };
}

function tmpDbPath(): string {
  return join(mkdtempSync(join(tmpdir(), "scq-pr14-")), "scq.db");
}

function makeDurableAdapter(mock: PreservationMockChargebee, path: string, store?: DurableQuoteStore) {
  const durable = store ?? new DurableQuoteStore(path, { recoveryGraceMs: 0 });
  const client = new ChargebeeClient({ site: SITE, apiKey: "pilot-mock-key" }, mock.transport);
  const adapter = new ChargebeeLiveAdapter(client, durable, {
    liveCommitEnabled: true,
    durableCoordinator: new DurableMutationCoordinator(durable),
    providerSite: SITE,
  });
  return { adapter, store: durable };
}

// ---------------------------------------------------------------------------
// 47.1 — repro43.1 converted: the concurrent unrelated addition in
// the validate->dispatch window. The commit must REFUSE; nothing is
// dispatched; the concurrent item is never erased; no durable
// DISPATCHING attempt exists; the refusal is not INDETERMINATE.
// ---------------------------------------------------------------------------

test("Test 47.1 (PR-14, repro43.1 converted): concurrent unrelated addition in the validate->dispatch window — commit refuses, zero dispatches, item survives, no DISPATCHING attempt", async () => {
  const mock = new PreservationMockChargebee();
  const path = tmpDbPath();
  const { adapter, store } = makeDurableAdapter(mock, path);
  const quote = await adapter.createChangeQuote(SUB, PROPOSAL(21));
  assert.equal(quote.commercialEffect.recurring?.resultingAmount, 80900);

  mock.armConcurrentAddOnNextEstimate();
  await expectPreservationRefusal(() => adapter.commitChangeQuote(quote.id));

  assert.equal(mock.updateDispatches.length, 0, "zero mutating requests were dispatched");
  assert.ok(mock.concurrentAddAt, "the concurrent add landed inside the commit flow (on the revalidation estimate)");
  assert.deepEqual(mock.itemIds(), [PLAN, ADDON, CONCURRENT], "the concurrent item survives — no SCQ dispatch erased it");
  assert.equal(store.allAttempts().length, 0, "no durable attempt of any state was created for a pre-dispatch refusal");
  const stored = store.get(quote.id);
  assert.equal(stored?.commit_receipt, undefined, "no receipt was recorded");
  assert.equal(stored?.commit_outcome?.outcome, "CONFIRMED_NON_EXECUTION", "the recorded outcome is the refusal's own class");
  store.close();
});

// ---------------------------------------------------------------------------
// 47.2 — repro43.2 REVISITED: no concurrency at all. The old control
// asserted this commit verifies cleanly; that expectation encoded
// the unsafe assumption that an unobserved race is safe. A
// non-atomic full-list replacement under OPERATION authorization
// refuses whether or not concurrency was observed.
// ---------------------------------------------------------------------------

test("Test 47.2 (PR-14, repro43.2 revisited): NO concurrency — an OPERATION-authorized full-replacement commit still refuses (absence of observed concurrency is not safety)", async () => {
  const mock = new PreservationMockChargebee();
  const { adapter, store } = makeAdapter(mock);
  const quote = await adapter.createChangeQuote(SUB, PROPOSAL(21));
  await expectPreservationRefusal(() => adapter.commitChangeQuote(quote.id));
  assert.equal(mock.updateDispatches.length, 0, "zero mutating requests were dispatched");
  assert.deepEqual(mock.itemIds(), [PLAN, ADDON], "provider state is untouched");
  assert.equal(store.get(quote.id)?.commit_receipt, undefined, "no receipt was recorded");
});

// ---------------------------------------------------------------------------
// 47.3 — repro43.3 preserved: the fingerprint/staleness guard is
// not weakened by the new gate.
// ---------------------------------------------------------------------------

test("Test 47.3 (PR-14, repro43.3 preserved): a concurrent addition landing BEFORE the commit-phase read still refuses QUOTE_STALE with zero dispatches", async () => {
  const mock = new PreservationMockChargebee();
  const { adapter } = makeAdapter(mock);
  const quote = await adapter.createChangeQuote(SUB, PROPOSAL(21));
  mock.applyConcurrentAddNow();
  await assert.rejects(
    () => adapter.commitChangeQuote(quote.id),
    (e: unknown) => e instanceof SCQError && e.code === "QUOTE_STALE",
  );
  assert.equal(mock.updateDispatches.length, 0, "no mutating dispatch occurred");
  assert.deepEqual(mock.itemIds(), [PLAN, ADDON, CONCURRENT], "the concurrent item survives — the staleness refusal protected it");
});

// ---------------------------------------------------------------------------
// 47.4 — legacy stored quote: persisted before authorization
// metadata existed. OPERATION + the adapter's capability by
// default => the update commit refuses at the gate.
// ---------------------------------------------------------------------------

test("Test 47.4 (PR-14): a legacy stored quote with NO authorization metadata refuses at the gate (OPERATION + adapter capability by default)", async () => {
  const mock = new PreservationMockChargebee();
  const path = tmpDbPath();
  const { adapter, store } = makeDurableAdapter(mock, path);
  const quote = await adapter.createChangeQuote(SUB, PROPOSAL(21));
  // Simulate a pre-PR-14 persisted record: strip every authorization
  // field from the stored quote and persist it back.
  const legacy = store.get(quote.id) as any;
  delete legacy.authorization_scope;
  delete legacy.authorization_capability;
  store.put(legacy);
  const reread = store.get(quote.id) as any;
  assert.equal(reread.authorization_scope, undefined, "fixture check: the stored record carries no scope");
  assert.equal(reread.authorization_capability, undefined, "fixture check: the stored record carries no capability");

  await expectPreservationRefusal(() => adapter.commitChangeQuote(quote.id));
  assert.equal(mock.updateDispatches.length, 0, "zero mutating requests were dispatched");
  assert.equal(store.allAttempts().length, 0, "no durable attempt was created");
  store.close();
});

// ---------------------------------------------------------------------------
// 47.5 — unknown recorded capability classifies as the weakest.
// ---------------------------------------------------------------------------

test("Test 47.5 (PR-14): a quote recording an UNKNOWN capability value refuses (unknown classifies as FULL_REPLACEMENT_ONLY)", async () => {
  const mock = new PreservationMockChargebee();
  const { adapter, store } = makeAdapter(mock);
  const quote = await adapter.createChangeQuote(SUB, PROPOSAL(21));
  const tampered = store.get(quote.id) as any;
  tampered.authorization_capability = "SIDEWAYS_WRITE";
  store.put(tampered);
  await expectPreservationRefusal(() => adapter.commitChangeQuote(quote.id));
  assert.equal(mock.updateDispatches.length, 0, "zero mutating requests were dispatched");
});

// ---------------------------------------------------------------------------
// 47.6 — quote/commit capability mismatch refuses.
// ---------------------------------------------------------------------------

test("Test 47.6 (PR-14): a quote whose recorded capability differs from the adapter's declared capability refuses as a mismatch", async () => {
  const mock = new PreservationMockChargebee();
  const { adapter, store } = makeAdapter(mock);
  const quote = await adapter.createChangeQuote(SUB, PROPOSAL(21));
  const tampered = store.get(quote.id) as any;
  tampered.authorization_capability = "TARGETED_UPDATE";
  store.put(tampered);
  const err = await expectPreservationRefusal(() => adapter.commitChangeQuote(quote.id));
  assert.equal(detailsOf(err)?.recordedCapability, "TARGETED_UPDATE", "the refusal names the recorded capability it refused to honor");
  assert.equal(detailsOf(err)?.mutationCapability, "FULL_REPLACEMENT_ONLY", "the refusal names the adapter's authoritative capability");
  assert.equal(mock.updateDispatches.length, 0, "zero mutating requests were dispatched");
});

// ---------------------------------------------------------------------------
// 47.7 — forged capability + no escape hatch: a caller-crafted
// stored quote claiming CONDITIONAL_WRITE cannot bypass the gate
// (the ADAPTER's capability is authoritative), and a proposal
// declaring TARGET_REPLACEMENT is refused at quote creation as
// unsupported — never honored, never downgraded. There is no
// config/option/env surface that disables the gate: the adapter
// constructed with every enable option it exposes still refuses
// (proven by every test in this file, all of which run with
// liveCommitEnabled: true).
// ---------------------------------------------------------------------------

test("Test 47.7 (PR-14): a forged CONDITIONAL_WRITE capability cannot bypass the gate; TARGET_REPLACEMENT is refused at quote creation as unsupported", async () => {
  const mock = new PreservationMockChargebee();
  const { adapter, store } = makeAdapter(mock);
  const quote = await adapter.createChangeQuote(SUB, PROPOSAL(21));
  const forged = store.get(quote.id) as any;
  forged.authorization_capability = "CONDITIONAL_WRITE";
  store.put(forged);
  const err = await expectPreservationRefusal(() => adapter.commitChangeQuote(quote.id));
  assert.equal(detailsOf(err)?.recordedCapability, "CONDITIONAL_WRITE");
  assert.equal(detailsOf(err)?.mutationCapability, "FULL_REPLACEMENT_ONLY", "the adapter's declared capability governs — the record's claim is never consulted as authority");
  assert.equal(mock.updateDispatches.length, 0, "zero mutating requests were dispatched");

  // TARGET_REPLACEMENT: refused before ANY provider call — the
  // declaration is unsupported in this PR, not an opt-out.
  const callsBefore = mock.calls.length;
  await assert.rejects(
    () => adapter.createChangeQuote(SUB, { ...(PROPOSAL(21) as any), authorizationScope: "TARGET_REPLACEMENT" } as any),
    (e: unknown) => e instanceof SCQError && e.code === "UNSUPPORTED_CHANGE",
  );
  assert.equal(mock.calls.length, callsBefore, "the TARGET_REPLACEMENT refusal precedes every provider call");
});

// ---------------------------------------------------------------------------
// 47.8 — quote-time recording + disclosure: every Chargebee-live
// quote records scope (default OPERATION) and the adapter's
// capability, on the returned quote, in provider metadata with the
// commit-consequence disclosure, and on the stored record.
// ---------------------------------------------------------------------------

test("Test 47.8 (PR-14): quote creation records OPERATION scope + FULL_REPLACEMENT_ONLY capability and discloses the commit consequence", async () => {
  const mock = new PreservationMockChargebee();
  const { adapter, store } = makeAdapter(mock);
  const quote = await adapter.createChangeQuote(SUB, PROPOSAL(21));
  assert.equal((quote as any).authorizationScope, "OPERATION", "an undeclared scope defaults to OPERATION");
  assert.equal((quote as any).mutationCapability, "FULL_REPLACEMENT_ONLY", "the capability is the adapter's own declaration, recorded at creation");
  const meta = (quote as any).providerMetadata as any;
  assert.equal(meta?.authorizationScope, "OPERATION");
  assert.equal(meta?.mutationCapability, "FULL_REPLACEMENT_ONLY");
  assert.match(String(meta?.authorizationPreservation ?? ""), /refused/i, "the quote discloses that OPERATION-authorized update commits will be refused on this capability");
  const stored = store.get(quote.id) as any;
  assert.equal(stored.authorization_scope, "OPERATION", "the stored record carries the scope");
  assert.equal(stored.authorization_capability, "FULL_REPLACEMENT_ONLY", "the stored record carries the capability");
});

// ---------------------------------------------------------------------------
// 47.9 — retry + restart/recovery after a refusal: the identical
// refusal, zero attempts accumulate, and a reopened durable store
// reports no phantom INDETERMINATE for the quote.
// ---------------------------------------------------------------------------

test("Test 47.9 (PR-14): retry and restart after a preservation refusal — deterministic identical refusal, zero attempts, clean recovery", async () => {
  const path = tmpDbPath();
  const mock = new PreservationMockChargebee();
  const first = makeDurableAdapter(mock, path);
  const quote = await first.adapter.createChangeQuote(SUB, PROPOSAL(21));
  const e1 = await expectPreservationRefusal(() => first.adapter.commitChangeQuote(quote.id));
  const e2 = await expectPreservationRefusal(() => first.adapter.commitChangeQuote(quote.id));
  assert.equal(codeOf(e2), codeOf(e1), "a retry returns the identical refusal");
  assert.equal(detailsOf(e2)?.outcome, detailsOf(e1)?.outcome);
  assert.equal(first.store.allAttempts().length, 0, "retries created no attempts");
  assert.equal(mock.updateDispatches.length, 0);
  first.store.close();

  const reopened = new DurableQuoteStore(path, { recoveryGraceMs: 0 });
  const report = reopened.recoveryReport();
  assert.equal(report.indeterminateOutcomes.find((a) => a.quoteId === quote.id), undefined, "recovery reports no INDETERMINATE outcome for the refused quote");
  assert.equal(reopened.allAttempts().length, 0, "no phantom attempt survived the restart");
  const second = makeDurableAdapter(mock, path, reopened);
  await expectPreservationRefusal(() => second.adapter.commitChangeQuote(quote.id));
  assert.equal(reopened.allAttempts().length, 0, "the post-restart refusal still created no attempt");
  reopened.close();
});

// ---------------------------------------------------------------------------
// 47.10 — classification distinction: the preservation refusal is
// NOT INDETERMINATE, and a genuinely recorded INDETERMINATE (the
// exact outcome the unknown-dispatch path records) still engages
// its own distinct no-blind-retry guard. The two classes coexist;
// neither collapses into the other.
// ---------------------------------------------------------------------------

test("Test 47.10 (PR-14): pre-dispatch refusal stays distinct from a genuine INDETERMINATE classification", async () => {
  const mock = new PreservationMockChargebee();
  const { adapter, store } = makeAdapter(mock);

  // (a) The preservation refusal: CONFIRMED_NON_EXECUTION, and the
  // quote is NOT poisoned as INDETERMINATE — a subsequent commit
  // re-refuses with the preservation code (47.9 proves the retry
  // determinism end-to-end; here the stored record is the point).
  const q1 = await adapter.createChangeQuote(SUB, PROPOSAL(21));
  const refusal = await expectPreservationRefusal(() => adapter.commitChangeQuote(q1.id));
  assert.notEqual(detailsOf(refusal)?.outcome, "INDETERMINATE");
  assert.equal(store.get(q1.id)?.commit_outcome?.outcome, "CONFIRMED_NON_EXECUTION");

  // (b) A quote carrying a genuinely recorded INDETERMINATE
  // outcome — recorded through the store's own outcome API, exactly
  // as the unknown-dispatch path records it — engages the distinct
  // INDETERMINATE no-blind-retry guard, not the preservation gate.
  const q2 = await adapter.createChangeQuote(SUB, PROPOSAL(22));
  store.recordCommitOutcome(q2.id, {
    outcome: "INDETERMINATE",
    at: new Date().toISOString(),
    details: { reason: "test47.10: seeded exactly as reconcileAfterUnknownDispatch records an unresolved dispatch" },
  });
  await assert.rejects(
    () => adapter.commitChangeQuote(q2.id),
    (e: unknown) =>
      e instanceof SCQError &&
      e.code === "PROVIDER_ERROR" &&
      (e.details as any)?.outcome === "INDETERMINATE" &&
      (e.details as any)?.indeterminate === true,
  );
  assert.equal(store.get(q2.id)?.commit_outcome?.outcome, "INDETERMINATE", "the genuine classification is untouched by the gate");
  assert.equal(mock.updateDispatches.length, 0, "neither path dispatched a mutation");
});

// ---------------------------------------------------------------------------
// 47.11 — positive controls: read-only flows and the pre-existing
// live-commit-disabled refusal are unchanged; the out-of-scope
// Chargebee SIMULATOR adapter (in-model mechanism, not the live
// full-replacement path) still commits successfully.
// ---------------------------------------------------------------------------

test("Test 47.11 (PR-14 controls): read-only flows work; LIVE_COMMIT_DISABLED posture unchanged; the Chargebee simulator adapter still commits", async () => {
  const mock = new PreservationMockChargebee();
  const client = new ChargebeeClient({ site: SITE, apiKey: "pilot-mock-key" }, mock.transport);
  const disabled = new ChargebeeLiveAdapter(client, new QuoteStore(), { liveCommitEnabled: false });
  const snapshot = await disabled.getSubscription(SUB);
  assert.equal(snapshot.id, SUB, "read-only snapshot flow works");
  const quote = await disabled.createChangeQuote(SUB, PROPOSAL(21));
  assert.equal(quote.commercialEffect.recurring?.resultingAmount, 80900, "quote creation + estimate flow works");
  await assert.rejects(
    () => disabled.commitChangeQuote(quote.id),
    (e: unknown) =>
      e instanceof SCQError &&
      e.code === "PROVIDER_ERROR" &&
      (e.details as any)?.blocked === "LIVE_COMMIT_DISABLED",
    "with live commits disabled, the pre-existing BLOCKED refusal still takes its original precedence",
  );
  assert.equal(mock.updateDispatches.length, 0);

  // Out-of-scope control: the simulator-backed Chargebee adapter's
  // commit path is unchanged by PR-14.
  const sim = new ChargebeeSim(new Date("2026-08-01T00:00:00.000Z"));
  const sub: ChargebeeSubscription = {
    id: "cb_pr14_control",
    status: "active",
    subscriptionItems: [{ id: "item_1", itemPriceId: "ip_seat_basic_monthly", quantity: 100 }],
    currentTermStart: "2026-08-01T00:00:00.000Z",
    currentTermEnd: "2026-08-31T00:00:00.000Z",
    nextBillingAt: "2026-08-31T00:00:00.000Z",
  };
  sim.seedSubscription(sub);
  const simAdapter = new ChargebeeAdapter(sim, new QuoteStore());
  const simQuote = await simAdapter.createChangeQuote("cb_pr14_control", {
    changes: [{ action: "CHANGE_QUANTITY", itemId: "item_1", quantity: 120 }],
    effectiveIntent: { type: "IMMEDIATE" },
    acceptanceEnvelope: {},
  });
  const simReceipt = await simAdapter.commitChangeQuote(simQuote.id);
  assert.equal(simReceipt.outcome, "COMMITTED_AND_VERIFIED", "simulator commits are out of scope and unchanged");
});

// ---------------------------------------------------------------------------
// 47.12 — CANCEL posture: the live adapter has never dispatched a
// cancellation (createChangeQuote refuses CANCEL before any
// provider call); PR-14 changes nothing there. There is no
// live-adapter cancel commit path to gate.
// ---------------------------------------------------------------------------

test("Test 47.12 (PR-14): the live adapter's CANCEL posture is unchanged — refused at quote creation, before any provider call", async () => {
  const mock = new PreservationMockChargebee();
  const { adapter } = makeAdapter(mock);
  await assert.rejects(
    () =>
      adapter.createChangeQuote(SUB, {
        changes: [{ action: "CANCEL" }],
        effectiveIntent: { type: "IMMEDIATE" },
        acceptanceEnvelope: {},
      }),
    (e: unknown) => e instanceof SCQError && e.code === "UNSUPPORTED_CHANGE",
  );
  assert.equal(mock.calls.length, 0, "the refusal precedes every provider call — unchanged by PR-14");
});

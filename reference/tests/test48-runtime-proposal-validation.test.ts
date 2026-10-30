/**
 * Test 48 — SCQ PR-15: fail-closed RUNTIME proposal and
 * financial-envelope validation (Issue #22, Finding 2 / F2;
 * research evidence: PR #23, repro44-runtime-validation).
 *
 * The defect (CONFIRMED in PR #23): TypeScript unions do not
 * validate runtime input. A proposal arriving as parsed JSON, a
 * deserialized record, or an unsafe cast could carry:
 *   - a misspelled guaranteeMode ("REVALDIATE") — resolveGuarantee
 *     Mode returned it verbatim and enforceGuaranteeRequest
 *     branched only on the literals "EXACT"/"REVALIDATE", so the
 *     typo satisfied NEITHER branch: EXACT's coverage check was
 *     skipped AND REVALIDATE's acceptanceEnvelope requirement was
 *     skipped; the commit path's mode branches fell through the
 *     same way, so the commit ran with no envelope gate at all;
 *   - malformed acceptance-envelope bounds (NaN, negative, string)
 *     — compareDeterminedDimensions read bounds with `?? 0` and
 *     compared numerically: every comparison against NaN is false,
 *     so a drifted revalidation silently PASSED;
 *   - an authorizationScope the build does not implement — PR #24
 *     validated the declaration inside the Chargebee-live adapter
 *     only; the four simulator adapters never read the field at
 *     all, so an unimplemented broader authorization was silently
 *     accepted there;
 *   - and the same malformed values could be seeded into a STORED
 *     quote record, bypassing quote-creation checks at commit.
 *
 * PR-15's correction: ONE shared, provider-neutral runtime
 * validator in core/scq-engine.ts — validateProposalRuntime —
 * applied at the entry of every adapter's createChangeQuote
 * (before any provider read, preview, estimate, or mutation) and,
 * via validateStoredQuoteRuntime, at every adapter's commit path
 * (after §6.10 replay and the recorded-INDETERMINATE guard, after
 * validateCommit, before any mutating dispatch and before any
 * durable DISPATCHING attempt). resolveGuaranteeMode and
 * enforceGuaranteeRequest are hardened for direct callers;
 * checkAcceptanceEnvelope refuses a malformed envelope as
 * INVALID_PROPOSAL before comparing; reconcileCommittedEffect
 * NEVER throws — a malformed envelope encountered post-commit
 * classifies (UNVERIFIED, or VIOLATED where a violation is
 * established through the envelope's interpretable bounds), so an
 * executed mutation's receipt is always recorded truthfully.
 *
 * Relationship to repro44 (kept byte-unchanged as historical
 * research evidence): 48.1–48.6 convert 44.1–44.6 into production
 * regressions. After this PR, repro44's defect tests pass against
 * the fixed code (they assert the refusal behavior); the research
 * suite accounting is reported in the PR body.
 *
 * Deliberate non-restrictions (recorded in
 * research/pr-15-runtime-proposal-validation.md): envelope bounds
 * are NOT required to be integers or safe integers (a finite
 * nonnegative fractional bound is valid input — the minor-unit
 * integer question is a normative decision for the v0.6.2
 * candidate, not something this PR imposes); a CHANGE_QUANTITY
 * quantity of zero is left to provider semantics (negative,
 * non-finite, and non-numeric quantities are malformed); unknown
 * fields are rejected ONLY inside the acceptance envelope, whose
 * field set the protocol closes — unknown top-level or per-change
 * fields are not this PR's concern.
 *
 * Every mutation-path exercise uses in-memory simulators or an
 * injected mocked transport. No network, no credentials,
 * SCQ_LIVE_COMMIT_ENABLED never set. Evidence class: SIMULATED.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QuoteStore } from "../src/store/quote-store.js";
import { DurableQuoteStore } from "../src/store/durable-store.js";
import { DurableMutationCoordinator } from "../src/store/mutation-coordinator.js";
import { SCQError, type CommercialEffect, type SubscriptionChangeProposal } from "../src/core/types.js";
import {
  checkAcceptanceEnvelope,
  enforceGuaranteeRequest,
  reconcileCommittedEffect,
  resolveGuaranteeMode,
  validateProposalRuntime,
} from "../src/core/scq-engine.js";
import { StripeAdapter } from "../src/adapters/stripe-adapter.js";
import { PaddleAdapter } from "../src/adapters/paddle-adapter.js";
import { ZuoraAdapter } from "../src/adapters/zuora-adapter.js";
import { ChargebeeAdapter } from "../src/adapters/chargebee-adapter.js";
import { ChargebeeClient, type HttpRequest, type HttpResponse, type HttpTransport } from "../src/live/chargebee-http.js";
import { ChargebeeLiveAdapter } from "../src/live/chargebee-scq-adapter.js";
import {
  freshChargebeeFixture,
  freshPaddleFixture,
  freshStripeFixture,
  freshZuoraFixture,
} from "./fixtures.js";

const ZERO_ENVELOPE = { maxImmediateNetIncrease: 0, maxImmediateCreditDecrease: 0, maxRecurringIncrease: 0 };

function codeOf(e: unknown): string {
  return e instanceof SCQError ? String(e.code) : `non-SCQError: ${String(e)}`;
}

async function expectRefusal(p: () => Promise<unknown>, code: string, label: string): Promise<SCQError> {
  let err: unknown;
  try {
    await p();
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof SCQError, `${label}: expected an SCQError refusal, got: ${String(err)}`);
  assert.equal(codeOf(err), code, `${label}: expected refusal code ${code}, got ${codeOf(err)}`);
  return err as SCQError;
}

// ---------------------------------------------------------------------------
// Per-adapter harnesses. `reads()` counts provider READ calls the
// adapter makes through its simulator/transport AFTER setup, so a
// creation refusal can be shown to precede every provider read —
// not merely every mutation.
// ---------------------------------------------------------------------------

type Harness = {
  name: string;
  adapter: { createChangeQuote(id: string, p: any): Promise<any>; commitChangeQuote(id: string): Promise<any> };
  store: QuoteStore;
  subId: string;
  validProposal: () => any;
  reads: () => number;
  /** A state fingerprint that changes iff a mutation landed. */
  stateMark: () => Promise<string>;
};

function counted<T extends object>(obj: T, method: string): () => number {
  let n = 0;
  const orig = (obj as any)[method].bind(obj);
  (obj as any)[method] = (...args: any[]) => {
    n += 1;
    return orig(...args);
  };
  return () => n;
}

function stripeHarness(): Harness {
  const { sim, sub } = freshStripeFixture();
  const store = new QuoteStore();
  const adapter = new StripeAdapter(sim, store);
  const reads = counted(sim, "retrieve");
  return {
    name: "stripe-sim",
    adapter, store, subId: sub.id,
    validProposal: () => ({
      changes: [{ action: "CHANGE_QUANTITY", itemId: "si_1", quantity: 120 }],
      effectiveIntent: { type: "IMMEDIATE" },
      guaranteeMode: "REVALIDATE",
      acceptanceEnvelope: { ...ZERO_ENVELOPE },
    }),
    reads,
    stateMark: async () => sim.fingerprint(sub.id),
  };
}

function paddleHarness(): Harness {
  const { sim, sub } = freshPaddleFixture();
  const store = new QuoteStore();
  const adapter = new PaddleAdapter(sim, store);
  const reads = counted(sim, "get");
  return {
    name: "paddle-sim",
    adapter, store, subId: sub.id,
    validProposal: () => ({
      // Paddle items carry no independent id in the sim's shape;
      // the adapter addresses them by the synthesized snapshot id
      // (`${sub.id}_item_${idx}` — see snapshotFrom in
      // paddle-adapter.ts, and test19's `before.items[0].id`).
      changes: [{ action: "CHANGE_QUANTITY", itemId: `${sub.id}_item_0`, quantity: 120 }],
      effectiveIntent: { type: "IMMEDIATE" },
      guaranteeMode: "REVALIDATE",
      acceptanceEnvelope: { ...ZERO_ENVELOPE },
    }),
    reads,
    stateMark: async () => sim.fingerprint(sub.id),
  };
}

function zuoraHarness(): Harness {
  const { sim, sub } = freshZuoraFixture();
  const store = new QuoteStore();
  const adapter = new ZuoraAdapter(sim, store);
  const reads = counted(sim, "get");
  return {
    name: "zuora-sim",
    adapter, store, subId: sub.id,
    validProposal: () => ({
      changes: [{ action: "CHANGE_QUANTITY", itemId: "rpc_1", quantity: 120 }],
      effectiveIntent: { type: "IMMEDIATE" },
      guaranteeMode: "REVALIDATE",
      acceptanceEnvelope: { ...ZERO_ENVELOPE },
    }),
    reads,
    stateMark: async () => String(sim.get(sub.id).version),
  };
}

function chargebeeSimHarness(): Harness {
  const { sim, sub } = freshChargebeeFixture();
  const store = new QuoteStore();
  const adapter = new ChargebeeAdapter(sim, store);
  const reads = counted(sim, "get");
  return {
    name: "chargebee-sim",
    adapter, store, subId: sub.id,
    validProposal: () => ({
      changes: [{ action: "CHANGE_QUANTITY", itemId: "item_1", quantity: 120 }],
      effectiveIntent: { type: "IMMEDIATE" },
      guaranteeMode: "REVALIDATE",
      acceptanceEnvelope: { ...ZERO_ENVELOPE },
    }),
    reads,
    stateMark: async () => sim.fingerprint(sub.id),
  };
}

// --- Chargebee-live harness: a compact scripted mock in the
// shape of test47's (kept independent; test47 stays untouched). ---
const LIVE_SUB = "pilot-sub-001";
const LIVE_PLAN = "pilot-plan-business";
const LIVE_ADDON = "pilot-addon-vision";
const LIVE_SITE = "pilot-test";
const LIVE_CATALOG: Record<string, { price: number; pricing_model: string; item_type: string }> = {
  [LIVE_PLAN]: { price: 59900, pricing_model: "flat_fee", item_type: "plan" },
  [LIVE_ADDON]: { price: 1000, pricing_model: "per_unit", item_type: "addon" },
};

class LiveMock {
  calls: Array<{ method: string; path: string }> = [];
  updateDispatches = 0;
  private resourceVersion = 1700000000000;
  private items = [
    { item_price_id: LIVE_PLAN, item_type: "plan", quantity: 1, unit_price: 59900, amount: 59900 },
    { item_price_id: LIVE_ADDON, item_type: "addon", quantity: 1, unit_price: 1000, amount: 1000, free_quantity: 0 },
  ];

  private subscriptionJson(): any {
    return {
      subscription: {
        id: LIVE_SUB, status: "active", currency_code: "USD",
        resource_version: this.resourceVersion,
        current_term_start: 1700000000, current_term_end: 1702592000, next_billing_at: 1702592000,
        has_scheduled_changes: false, has_scheduled_advance_invoices: false,
        subscription_items: this.items.map((i) => ({ ...i })),
      },
    };
  }

  private parseItems(body: string): Array<{ item_price_id: string; quantity: number }> {
    const byIndex = new Map<number, { item_price_id?: string; quantity?: number }>();
    for (const [k, v] of new URLSearchParams(body).entries()) {
      const m = k.match(/^subscription_items\[(item_price_id|quantity)\]\[(\d+)\]$/);
      if (!m) continue;
      const idx = Number(m[2]);
      const entry = byIndex.get(idx) ?? {};
      if (m[1] === "item_price_id") entry.item_price_id = v; else entry.quantity = Number(v);
      byIndex.set(idx, entry);
    }
    return [...byIndex.entries()].sort((a, b) => a[0] - b[0]).map(([, e]) => ({ item_price_id: e.item_price_id!, quantity: e.quantity ?? 1 }));
  }

  transport: HttpTransport = async (req: HttpRequest): Promise<HttpResponse> => {
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/api\/v2/, "");
    this.calls.push({ method: req.method, path });
    const json = (status: number, body: any): HttpResponse => ({ status, headers: {}, json: body });
    if (req.method === "GET" && path.startsWith("/subscriptions/")) return json(200, this.subscriptionJson());
    if (req.method === "GET" && path.startsWith("/item_prices/")) {
      const id = decodeURIComponent(path.slice("/item_prices/".length));
      const meta = LIVE_CATALOG[id];
      if (!meta) return json(404, { api_error_code: "resource_not_found" });
      return json(200, { item_price: { id, pricing_model: meta.pricing_model, price: meta.price, free_quantity: 0, item_type: meta.item_type } });
    }
    if (req.method === "POST" && path === "/estimates/update_subscription_for_items") {
      const requested = this.parseItems(req.body ?? "");
      const stated = requested.map((r) => {
        const cur = this.items.find((i) => i.item_price_id === r.item_price_id);
        const unitPrice = cur?.unit_price ?? LIVE_CATALOG[r.item_price_id]?.price ?? 0;
        const amount = LIVE_CATALOG[r.item_price_id]?.pricing_model === "flat_fee" ? unitPrice : unitPrice * r.quantity;
        return { item_price_id: r.item_price_id, quantity: r.quantity, unit_price: unitPrice, amount };
      });
      const currentAddon = this.items.find((i) => i.item_price_id === LIVE_ADDON)!;
      const targetAddon = requested.find((i) => i.item_price_id === LIVE_ADDON);
      const incurred = ((targetAddon?.quantity ?? currentAddon.quantity) - currentAddon.quantity) * currentAddon.unit_price;
      return json(200, {
        estimate: {
          unbilled_charge_estimates: incurred !== 0 ? [{ amount: incurred }] : [],
          credit_note_estimates: [],
          subscription_estimate: { subscription_items: stated },
        },
      });
    }
    if (req.method === "POST" && path.includes("/update_for_items")) {
      this.updateDispatches += 1;
      return json(200, { subscription: this.subscriptionJson().subscription, unbilled_charges: [] });
    }
    return json(404, { api_error_code: "resource_not_found" });
  };
}

function liveHarness(store: QuoteStore = new QuoteStore()): Harness & { mock: LiveMock } {
  const mock = new LiveMock();
  const client = new ChargebeeClient({ site: LIVE_SITE, apiKey: "pilot-mock-key" }, mock.transport);
  const adapter = new ChargebeeLiveAdapter(client, store, { liveCommitEnabled: true });
  return {
    name: "chargebee-live",
    adapter, store, subId: LIVE_SUB, mock,
    validProposal: () => ({
      changes: [{ action: "CHANGE_QUANTITY", itemId: LIVE_ADDON, quantity: 21 }],
      effectiveIntent: { type: "IMMEDIATE" },
      acceptanceEnvelope: {},
    }),
    reads: () => mock.calls.length,
    stateMark: async () => `dispatches:${mock.updateDispatches}`,
  };
}

function allHarnesses(): Harness[] {
  return [stripeHarness(), paddleHarness(), zuoraHarness(), chargebeeSimHarness(), liveHarness()];
}

/** Runs a creation case over every harness and collects ALL failures before asserting (full matrix in one run). */
async function creationMatrix(
  label: string,
  mutate: (proposal: any) => any,
  expectedCode: string,
): Promise<void> {
  const failures: string[] = [];
  for (const h of allHarnesses()) {
    const readsBefore = h.reads();
    let err: unknown;
    try {
      await h.adapter.createChangeQuote(h.subId, mutate(h.validProposal()));
    } catch (e) {
      err = e;
    }
    if (!(err instanceof SCQError) || codeOf(err) !== expectedCode) {
      failures.push(`${h.name}: expected ${expectedCode}, got ${err ? codeOf(err) : "NO REFUSAL (quote created)"}`);
      continue;
    }
    if (h.reads() !== readsBefore) failures.push(`${h.name}: refusal happened only after ${h.reads() - readsBefore} provider read(s)`);
    if (h.store.all().length !== 0) failures.push(`${h.name}: a quote was stored despite the refusal`);
  }
  assert.deepEqual(failures, [], `${label} — per-adapter failures:\n${failures.join("\n")}`);
}

// ---------------------------------------------------------------------------
// 48.1–48.6 — repro44 conversions (Stripe harness, repro44's own
// adapter), now as production regressions.
// ---------------------------------------------------------------------------

const stripeProposal = (overrides: Record<string, unknown>): any => ({
  changes: [{ action: "CHANGE_QUANTITY", itemId: "si_1", quantity: 120 }],
  effectiveIntent: { type: "IMMEDIATE" },
  ...overrides,
});

test("Test 48.1 (repro44.1 converted): guaranteeMode \"REVALDIATE\" with NO acceptanceEnvelope is refused at quote creation, before any provider read", async () => {
  const h = stripeHarness();
  const readsBefore = h.reads();
  await expectRefusal(
    () => h.adapter.createChangeQuote(h.subId, stripeProposal({ guaranteeMode: "REVALDIATE" })),
    "INVALID_PROPOSAL",
    "48.1",
  );
  assert.equal(h.reads(), readsBefore, "the refusal precedes every provider read");
  assert.equal(h.store.all().length, 0, "no quote was stored");
});

test("Test 48.2 (repro44.2 converted): a NaN envelope bound is refused at quote creation", async () => {
  const h = stripeHarness();
  await expectRefusal(
    () => h.adapter.createChangeQuote(h.subId, stripeProposal({ guaranteeMode: "REVALIDATE", acceptanceEnvelope: { maxImmediateNetIncrease: NaN } })),
    "INVALID_PROPOSAL",
    "48.2",
  );
  assert.equal(h.store.all().length, 0);
});

test("Test 48.3 (repro44.3 converted): a negative envelope bound is refused at quote creation", async () => {
  const h = stripeHarness();
  await expectRefusal(
    () => h.adapter.createChangeQuote(h.subId, stripeProposal({ guaranteeMode: "REVALIDATE", acceptanceEnvelope: { maxRecurringIncrease: -5 } })),
    "INVALID_PROPOSAL",
    "48.3",
  );
  assert.equal(h.store.all().length, 0);
});

test("Test 48.4 (repro44.4 converted): a string-typed envelope bound is refused at quote creation", async () => {
  const h = stripeHarness();
  await expectRefusal(
    () => h.adapter.createChangeQuote(h.subId, stripeProposal({ guaranteeMode: "REVALIDATE", acceptanceEnvelope: { maxImmediateNetIncrease: "abc" } })),
    "INVALID_PROPOSAL",
    "48.4",
  );
  assert.equal(h.store.all().length, 0);
});

test("Test 48.5 (repro44.5 converted): checkAcceptanceEnvelope with a NaN bound does not silently pass a drifted revalidation", () => {
  const quoted: CommercialEffect = {
    immediate: { net: 20000 },
    recurring: { resultingAmount: 80900, currency: "USD" },
    determinacy: { immediateFinancialEffect: "DETERMINED", recurringFinancialEffect: "DETERMINED" },
    provenance: { immediate: "test48 fixture (quoted)", recurring: "test48 fixture (quoted)" },
  };
  const revalidated: CommercialEffect = {
    immediate: { net: 25000 },
    recurring: { resultingAmount: 80900, currency: "USD" },
    determinacy: { immediateFinancialEffect: "DETERMINED", recurringFinancialEffect: "DETERMINED" },
    provenance: { immediate: "test48 fixture (revalidated)", recurring: "test48 fixture (revalidated)", committedSource: "revalidated_preview" },
  };
  const proposal = stripeProposal({ guaranteeMode: "REVALIDATE", acceptanceEnvelope: { maxImmediateNetIncrease: NaN } });
  // PR-15 tightens repro44.5's disjunction (threw OR violation) to
  // the specific behavior: a malformed envelope is invalid caller
  // input at this pre-dispatch entry point and refuses as
  // INVALID_PROPOSAL — it never reaches the comparison.
  assert.throws(
    () => checkAcceptanceEnvelope(quoted, revalidated, { maxImmediateNetIncrease: NaN }, proposal),
    (e: unknown) => e instanceof SCQError && e.code === "INVALID_PROPOSAL",
  );
});

test("Test 48.6 (repro44.6 converted, control): a well-formed REVALIDATE proposal with finite nonnegative bounds quotes and commits cleanly", async () => {
  const h = stripeHarness();
  const quote = await h.adapter.createChangeQuote(h.subId, h.validProposal());
  const receipt = await h.adapter.commitChangeQuote(quote.id);
  assert.equal(receipt.outcome, "COMMITTED_AND_VERIFIED");
  assert.equal(receipt.reconciliation?.status, "OK");
});

// ---------------------------------------------------------------------------
// 48.7 — envelope-shape matrix (Stripe): every malformed shape
// refuses as INVALID_PROPOSAL at creation.
// ---------------------------------------------------------------------------

test("Test 48.7: malformed envelope shapes refuse at quote creation (Infinity, numeric string, null bound, unknown field, array, non-object)", async () => {
  const cases: Array<{ label: string; envelope: unknown }> = [
    { label: "+Infinity bound", envelope: { maxRecurringIncrease: Infinity } },
    { label: "-Infinity bound", envelope: { maxImmediateCreditDecrease: -Infinity } },
    { label: "numeric-string bound", envelope: { maxImmediateNetIncrease: "100" } },
    { label: "null bound", envelope: { maxRecurringIncrease: null } },
    { label: "object bound", envelope: { maxRecurringIncrease: { value: 5 } } },
    { label: "unknown field (misspelled bound)", envelope: { maxRecurringIncreases: 100 } },
    { label: "array envelope", envelope: [0, 0, 0] },
    { label: "string envelope", envelope: "zero-tolerance" },
    { label: "null envelope", envelope: null },
  ];
  const failures: string[] = [];
  for (const { label, envelope } of cases) {
    const h = stripeHarness();
    let err: unknown;
    try {
      await h.adapter.createChangeQuote(h.subId, stripeProposal({ guaranteeMode: "REVALIDATE", acceptanceEnvelope: envelope }));
    } catch (e) {
      err = e;
    }
    if (!(err instanceof SCQError) || codeOf(err) !== "INVALID_PROPOSAL") {
      failures.push(`${label}: expected INVALID_PROPOSAL, got ${err ? codeOf(err) : "NO REFUSAL (quote created)"}`);
    } else if (h.store.all().length !== 0) {
      failures.push(`${label}: a quote was stored despite the refusal`);
    }
  }
  assert.deepEqual(failures, [], `48.7 failures:\n${failures.join("\n")}`);
});

// ---------------------------------------------------------------------------
// 48.8 — authorization scope on EVERY adapter: unknown values are
// invalid input; TARGET_REPLACEMENT is recognized but unsupported
// in this release on every adapter (PR #24 enforced this only in
// the live adapter; the field was inert in the simulators).
// ---------------------------------------------------------------------------

test("Test 48.8a: authorizationScope \"UNRESTRICTED\" refuses as INVALID_PROPOSAL on all five adapters, before provider reads, nothing stored", async () => {
  await creationMatrix("48.8a unknown scope", (p) => ({ ...p, authorizationScope: "UNRESTRICTED" }), "INVALID_PROPOSAL");
});

test("Test 48.8b: authorizationScope TARGET_REPLACEMENT refuses as UNSUPPORTED_CHANGE on all five adapters (recognized, unimplemented — never silently accepted, never executed)", async () => {
  await creationMatrix("48.8b target replacement", (p) => ({ ...p, authorizationScope: "TARGET_REPLACEMENT" }), "UNSUPPORTED_CHANGE");
});

test("Test 48.8c: wrong-typed authorization scopes refuse as INVALID_PROPOSAL (numeric, object, wrong case)", async () => {
  for (const value of [42, { scope: "OPERATION" }, "operation"]) {
    const h = stripeHarness();
    await expectRefusal(
      () => h.adapter.createChangeQuote(h.subId, { ...h.validProposal(), authorizationScope: value }),
      "INVALID_PROPOSAL",
      `48.8c scope=${JSON.stringify(value)}`,
    );
  }
});

test("Test 48.8d (controls): absent scope and explicit OPERATION create quotes on all five adapters", async () => {
  for (const h of allHarnesses()) {
    const q1 = await h.adapter.createChangeQuote(h.subId, h.validProposal());
    assert.ok(q1.id, `${h.name}: absent-scope control quote created`);
    const q2 = await h.adapter.createChangeQuote(h.subId, { ...h.validProposal(), authorizationScope: "OPERATION" });
    assert.ok(q2.id, `${h.name}: explicit-OPERATION control quote created`);
  }
});

// ---------------------------------------------------------------------------
// 48.9 — the guaranteeMode typo refuses on every adapter (48.1
// covers Stripe; this is the remaining four), before provider
// reads. The live adapter fell through both branches exactly like
// the simulators did.
// ---------------------------------------------------------------------------

test("Test 48.9: guaranteeMode \"REVALDIATE\" refuses as INVALID_PROPOSAL on paddle/zuora/chargebee-sim/chargebee-live, before provider reads", async () => {
  const failures: string[] = [];
  for (const h of [paddleHarness(), zuoraHarness(), chargebeeSimHarness(), liveHarness()]) {
    const readsBefore = h.reads();
    let err: unknown;
    try {
      await h.adapter.createChangeQuote(h.subId, { ...h.validProposal(), guaranteeMode: "REVALDIATE", acceptanceEnvelope: { ...ZERO_ENVELOPE } });
    } catch (e) {
      err = e;
    }
    if (!(err instanceof SCQError) || codeOf(err) !== "INVALID_PROPOSAL") {
      failures.push(`${h.name}: expected INVALID_PROPOSAL, got ${err ? codeOf(err) : "NO REFUSAL (quote created)"}`);
      continue;
    }
    if (h.reads() !== readsBefore) failures.push(`${h.name}: refusal followed ${h.reads() - readsBefore} provider read(s)`);
    if (h.store.all().length !== 0) failures.push(`${h.name}: a quote was stored despite the refusal`);
  }
  assert.deepEqual(failures, [], `48.9 failures:\n${failures.join("\n")}`);
});

// ---------------------------------------------------------------------------
// 48.10 — malformed proposal/action structures (Stripe).
// ---------------------------------------------------------------------------

test("Test 48.10: malformed proposal structures refuse as INVALID_PROPOSAL at quote creation", async () => {
  const cases: Array<{ label: string; proposal: unknown }> = [
    { label: "null proposal", proposal: null },
    { label: "string proposal", proposal: "change quantity" },
    { label: "missing changes", proposal: { effectiveIntent: { type: "IMMEDIATE" } } },
    { label: "changes not an array", proposal: { changes: { action: "CHANGE_QUANTITY" }, effectiveIntent: { type: "IMMEDIATE" } } },
    { label: "empty changes", proposal: { changes: [], effectiveIntent: { type: "IMMEDIATE" }, guaranteeMode: "REVALIDATE", acceptanceEnvelope: {} } },
    { label: "unknown action", proposal: { changes: [{ action: "REFUND", itemId: "si_1", quantity: 5 }], effectiveIntent: { type: "IMMEDIATE" }, guaranteeMode: "REVALIDATE", acceptanceEnvelope: {} } },
    { label: "change entry not an object", proposal: { changes: ["CHANGE_QUANTITY"], effectiveIntent: { type: "IMMEDIATE" }, guaranteeMode: "REVALIDATE", acceptanceEnvelope: {} } },
    { label: "CHANGE_QUANTITY missing itemId", proposal: { changes: [{ action: "CHANGE_QUANTITY", quantity: 5 }], effectiveIntent: { type: "IMMEDIATE" }, guaranteeMode: "REVALIDATE", acceptanceEnvelope: {} } },
    { label: "CHANGE_QUANTITY empty itemId", proposal: { changes: [{ action: "CHANGE_QUANTITY", itemId: "", quantity: 5 }], effectiveIntent: { type: "IMMEDIATE" }, guaranteeMode: "REVALIDATE", acceptanceEnvelope: {} } },
    { label: "CHANGE_QUANTITY negative quantity", proposal: { changes: [{ action: "CHANGE_QUANTITY", itemId: "si_1", quantity: -5 }], effectiveIntent: { type: "IMMEDIATE" }, guaranteeMode: "REVALIDATE", acceptanceEnvelope: {} } },
    { label: "CHANGE_QUANTITY NaN quantity", proposal: { changes: [{ action: "CHANGE_QUANTITY", itemId: "si_1", quantity: NaN }], effectiveIntent: { type: "IMMEDIATE" }, guaranteeMode: "REVALIDATE", acceptanceEnvelope: {} } },
    { label: "CHANGE_QUANTITY string quantity", proposal: { changes: [{ action: "CHANGE_QUANTITY", itemId: "si_1", quantity: "120" }], effectiveIntent: { type: "IMMEDIATE" }, guaranteeMode: "REVALIDATE", acceptanceEnvelope: {} } },
    { label: "CHANGE_PLAN missing offeringRef", proposal: { changes: [{ action: "CHANGE_PLAN", itemId: "si_1" }], effectiveIntent: { type: "IMMEDIATE" }, guaranteeMode: "REVALIDATE", acceptanceEnvelope: {} } },
    { label: "CHANGE_CADENCE unsupported cadence literal", proposal: { changes: [{ action: "CHANGE_CADENCE", cadence: "WEEKLY" }], effectiveIntent: { type: "IMMEDIATE" }, guaranteeMode: "REVALIDATE", acceptanceEnvelope: {} } },
    { label: "missing effectiveIntent", proposal: { changes: [{ action: "CHANGE_QUANTITY", itemId: "si_1", quantity: 5 }], guaranteeMode: "REVALIDATE", acceptanceEnvelope: {} } },
    { label: "unknown effectiveIntent type", proposal: { changes: [{ action: "CHANGE_QUANTITY", itemId: "si_1", quantity: 5 }], effectiveIntent: { type: "WHENEVER" }, guaranteeMode: "REVALIDATE", acceptanceEnvelope: {} } },
    { label: "DATE intent with unparseable timestamp", proposal: { changes: [{ action: "CHANGE_QUANTITY", itemId: "si_1", quantity: 5 }], effectiveIntent: { type: "DATE", at: "next Tuesday-ish" }, guaranteeMode: "REVALIDATE", acceptanceEnvelope: {} } },
    { label: "DATE intent with numeric timestamp", proposal: { changes: [{ action: "CHANGE_QUANTITY", itemId: "si_1", quantity: 5 }], effectiveIntent: { type: "DATE", at: 20260901 }, guaranteeMode: "REVALIDATE", acceptanceEnvelope: {} } },
    { label: "DATE intent missing timestamp", proposal: { changes: [{ action: "CHANGE_QUANTITY", itemId: "si_1", quantity: 5 }], effectiveIntent: { type: "DATE" }, guaranteeMode: "REVALIDATE", acceptanceEnvelope: {} } },
  ];
  const failures: string[] = [];
  for (const { label, proposal } of cases) {
    const h = stripeHarness();
    let err: unknown;
    try {
      await h.adapter.createChangeQuote(h.subId, proposal as any);
    } catch (e) {
      err = e;
    }
    if (!(err instanceof SCQError) || codeOf(err) !== "INVALID_PROPOSAL") {
      failures.push(`${label}: expected INVALID_PROPOSAL, got ${err ? codeOf(err) : "NO REFUSAL (quote created)"}`);
    }
  }
  assert.deepEqual(failures, [], `48.10 failures:\n${failures.join("\n")}`);
});

// ---------------------------------------------------------------------------
// 48.11 — envelope-presence rules preserved: REVALIDATE (explicit
// or defaulted) requires an envelope for non-CANCEL changes; the
// all-CANCEL exception stands. The presence rule itself predates
// PR-15 and STAYS in enforceGuaranteeRequest — deliberately not
// duplicated in the shared validator: every adapter calls
// enforceGuaranteeRequest after its effectiveIntent support
// checks, and a proposal that is both envelope-less and
// intent-unsupported refuses UNSUPPORTED_CHANGE for the intent
// (test25.19 pins that precedence). This case pins the refusal
// code at quote creation, not the read ordering.
// ---------------------------------------------------------------------------

test("Test 48.11: REVALIDATE without an envelope refuses for non-CANCEL; the all-CANCEL exception still quotes and commits", async () => {
  const h = stripeHarness();
  const noEnvelope = h.validProposal();
  delete noEnvelope.acceptanceEnvelope;
  await expectRefusal(() => h.adapter.createChangeQuote(h.subId, noEnvelope), "INVALID_PROPOSAL", "48.11 missing envelope (explicit REVALIDATE)");
  const defaulted = h.validProposal();
  delete defaulted.acceptanceEnvelope;
  delete defaulted.guaranteeMode;
  await expectRefusal(() => h.adapter.createChangeQuote(h.subId, defaulted), "INVALID_PROPOSAL", "48.11 missing envelope (defaulted REVALIDATE)");

  const cancel = await h.adapter.createChangeQuote(h.subId, {
    changes: [{ action: "CANCEL" }],
    effectiveIntent: { type: "TERM_END" },
    guaranteeMode: "REVALIDATE",
  });
  const receipt = await h.adapter.commitChangeQuote(cancel.id);
  assert.equal(receipt.status, "COMMITTED", "the all-CANCEL no-envelope exception still commits");
});

// ---------------------------------------------------------------------------
// 48.12 — valid EXACT control: legitimate EXACT requests and
// their coverage requirements are unchanged.
// ---------------------------------------------------------------------------

test("Test 48.12 (control): a valid EXACT request (Stripe CANCEL, EXACT on every dimension) quotes and commits exactly as before", async () => {
  const h = stripeHarness();
  const quote = await h.adapter.createChangeQuote(h.subId, {
    changes: [{ action: "CANCEL" }],
    effectiveIntent: { type: "TERM_END" },
    guaranteeMode: "EXACT",
  });
  assert.equal(quote.guaranteeMode, "EXACT");
  const receipt = await h.adapter.commitChangeQuote(quote.id);
  assert.equal(receipt.status, "COMMITTED");
  assert.equal(receipt.committedEffect.provenance?.committedSource, "defined_equal_exact");
});

// ---------------------------------------------------------------------------
// 48.13 — direct core API hardening: resolveGuaranteeMode and
// enforceGuaranteeRequest refuse invalid runtime values instead
// of falling through both enforcement branches.
// ---------------------------------------------------------------------------

test("Test 48.13: direct engine entry points refuse invalid guarantee modes and malformed envelopes", () => {
  const base = { changes: [{ action: "CHANGE_QUANTITY", itemId: "si_1", quantity: 120 }], effectiveIntent: { type: "IMMEDIATE" } } as any;
  assert.equal(resolveGuaranteeMode(base), "REVALIDATE", "omitted mode still defaults to REVALIDATE");
  assert.equal(resolveGuaranteeMode({ ...base, guaranteeMode: "EXACT" }), "EXACT");
  assert.equal(resolveGuaranteeMode({ ...base, guaranteeMode: "REVALIDATE" }), "REVALIDATE");
  for (const bad of ["REVALDIATE", "EXACTLY", "", "revalidate", 42, null, { mode: "EXACT" }]) {
    assert.throws(
      () => resolveGuaranteeMode({ ...base, guaranteeMode: bad }),
      (e: unknown) => e instanceof SCQError && e.code === "INVALID_PROPOSAL",
      `resolveGuaranteeMode(${JSON.stringify(bad)}) must refuse as INVALID_PROPOSAL`,
    );
  }
  const coverage = { immediateFinancialEffect: "EXACT", recurringFinancialEffect: "EXACT", termEffect: "EXACT", effectiveAt: "EXACT" } as const;
  // A direct caller passing a typo'd mode must not fall through
  // BOTH branches of enforceGuaranteeRequest (the original hole).
  assert.throws(
    () => enforceGuaranteeRequest(base.changes, "REVALDIATE" as any, coverage as any, undefined),
    (e: unknown) => e instanceof SCQError && e.code === "INVALID_PROPOSAL",
  );
  // A malformed envelope bound refuses at this entry point too.
  assert.throws(
    () => enforceGuaranteeRequest(base.changes, "REVALIDATE", coverage as any, { maxImmediateNetIncrease: NaN } as any),
    (e: unknown) => e instanceof SCQError && e.code === "INVALID_PROPOSAL",
  );
  // Valid direct calls are unchanged.
  enforceGuaranteeRequest(base.changes, "EXACT", coverage as any, undefined);
  enforceGuaranteeRequest(base.changes, "REVALIDATE", coverage as any, { ...ZERO_ENVELOPE });
});

// ---------------------------------------------------------------------------
// 48.14 — reconcileCommittedEffect NEVER throws on a malformed
// envelope: post-commit it classifies truthfully. A violation
// established through the envelope's interpretable bounds still
// reports VIOLATED; otherwise the malformed envelope yields
// UNVERIFIED, never a silent OK.
// ---------------------------------------------------------------------------

const detEffect = (net: number, recurring: number, committed: boolean): CommercialEffect => ({
  immediate: { net },
  recurring: { resultingAmount: recurring, currency: "USD" },
  determinacy: { immediateFinancialEffect: "DETERMINED", recurringFinancialEffect: "DETERMINED" },
  provenance: {
    immediate: "test48 fixture",
    recurring: "test48 fixture",
    ...(committed ? { committedSource: "provider_actual" as const } : {}),
  },
});
const QTY_PROPOSAL = { changes: [{ action: "CHANGE_QUANTITY", itemId: "si_1", quantity: 120 }], effectiveIntent: { type: "IMMEDIATE" } } as unknown as SubscriptionChangeProposal;

test("Test 48.14: reconcileCommittedEffect classifies (never throws) on malformed envelopes", () => {
  const quoted = detEffect(20000, 80900, false);
  const within = detEffect(20000, 80900, true);
  // NaN bound + figures that match the quote exactly: today this
  // reads OK (NaN comparisons are false). The envelope cannot be
  // interpreted, so compliance is UNVERIFIED — not OK.
  const r1 = reconcileCommittedEffect(quoted, within, { maxImmediateNetIncrease: NaN }, QTY_PROPOSAL);
  assert.equal(r1.status, "UNVERIFIED", `a NaN bound must not let matching figures read as verified compliance, got ${r1.status}`);
  assert.match(r1.reason ?? "", /envelope/i);
  // Malformed bound on immediate + an ESTABLISHED recurring
  // violation through a valid zero bound: VIOLATED stands (a
  // proven violation is never downgraded by an unrelated
  // uninterpretable term).
  const violated = detEffect(20000, 90000, true);
  const r2 = reconcileCommittedEffect(quoted, violated, { maxImmediateNetIncrease: NaN, maxRecurringIncrease: 0 }, QTY_PROPOSAL);
  assert.equal(r2.status, "VIOLATED", `an established violation via a valid bound must report VIOLATED, got ${r2.status}`);
  // Unknown field only: comparisons run on the interpretable
  // terms, but OK is unavailable — the recorded envelope is not
  // fully interpretable.
  const r3 = reconcileCommittedEffect(quoted, within, { maxRecurringIncreases: 500 } as any, QTY_PROPOSAL);
  assert.equal(r3.status, "UNVERIFIED", `an uninterpretable envelope field must not read OK, got ${r3.status}`);
  // Controls: valid envelopes behave exactly as before.
  assert.equal(reconcileCommittedEffect(quoted, within, { ...ZERO_ENVELOPE }, QTY_PROPOSAL).status, "OK");
  assert.equal(reconcileCommittedEffect(quoted, violated, { ...ZERO_ENVELOPE }, QTY_PROPOSAL).status, "VIOLATED");
});

// ---------------------------------------------------------------------------
// 48.15 — persisted-quote validation (Stripe): a stored record
// tampered after creation cannot bypass the financial or
// authorization gates at commit. Zero mutations, no receipt.
// ---------------------------------------------------------------------------

async function tamperedCommit(h: Harness, tamper: (stored: any) => void): Promise<{ err: unknown; markBefore: string }> {
  const quote = await h.adapter.createChangeQuote(h.subId, h.validProposal());
  const stored = h.store.get(quote.id) as any;
  tamper(stored);
  h.store.put(stored);
  const markBefore = await h.stateMark();
  let err: unknown;
  try {
    await h.adapter.commitChangeQuote(quote.id);
  } catch (e) {
    err = e;
  }
  return { err, markBefore };
}

test("Test 48.15: tampered stored records refuse at commit as INVALID_PROPOSAL with zero mutations (Stripe)", async () => {
  const cases: Array<{ label: string; tamper: (s: any) => void; code: string }> = [
    { label: "stored proposal guaranteeMode typo", tamper: (s) => { s.proposal = { ...s.proposal, guaranteeMode: "REVALDIATE" }; }, code: "INVALID_PROPOSAL" },
    { label: "stored effective_guarantee_mode typo (proposal clean)", tamper: (s) => { s.effective_guarantee_mode = "REVALDIATE"; }, code: "INVALID_PROPOSAL" },
    { label: "stored effective mode desynchronized from proposal (EXACT stored, REVALIDATE proposal)", tamper: (s) => { s.effective_guarantee_mode = "EXACT"; }, code: "INVALID_PROPOSAL" },
    { label: "stored envelope NaN bound", tamper: (s) => { s.proposal = { ...s.proposal, acceptanceEnvelope: { maxRecurringIncrease: NaN } }; }, code: "INVALID_PROPOSAL" },
    { label: "stored envelope negative bound", tamper: (s) => { s.proposal = { ...s.proposal, acceptanceEnvelope: { maxImmediateNetIncrease: -1 } }; }, code: "INVALID_PROPOSAL" },
    { label: "stored proposal unknown scope", tamper: (s) => { s.proposal = { ...s.proposal, authorizationScope: "UNRESTRICTED" }; }, code: "INVALID_PROPOSAL" },
    { label: "stored proposal TARGET_REPLACEMENT scope", tamper: (s) => { s.proposal = { ...s.proposal, authorizationScope: "TARGET_REPLACEMENT" }; }, code: "UNSUPPORTED_CHANGE" },
    { label: "stored proposal malformed DATE intent", tamper: (s) => { s.proposal = { ...s.proposal, effectiveIntent: { type: "DATE", at: "garbage" } }; }, code: "INVALID_PROPOSAL" },
  ];
  for (const { label, tamper, code } of cases) {
    const h = stripeHarness();
    const { err, markBefore } = await tamperedCommit(h, tamper);
    assert.ok(err instanceof SCQError, `${label}: expected an SCQError refusal, got: ${String(err)}`);
    assert.equal(codeOf(err), code, `${label}: expected ${code}, got ${codeOf(err)}`);
    assert.equal(await h.stateMark(), markBefore, `${label}: provider state must be untouched (zero mutations)`);
    assert.equal(h.store.all()[0]?.commit_receipt, undefined, `${label}: no receipt was recorded`);
  }
});

// ---------------------------------------------------------------------------
// 48.16 — persisted-quote validation (Chargebee-live, durable):
// the refusal fires before the durable write-ahead gate — zero
// dispatches AND zero durable attempts. (Stored-scope handling on
// this adapter remains PR #24's gate — test47.17/47.18 — and is
// not re-litigated here; these cases tamper the financial fields
// PR-15 owns.)
// ---------------------------------------------------------------------------

test("Test 48.16: tampered stored financial fields refuse at commit before dispatch and before any durable attempt (Chargebee-live)", async () => {
  const cases: Array<{ label: string; tamper: (s: any) => void }> = [
    { label: "stored envelope NaN bound", tamper: (s) => { s.proposal = { ...s.proposal, acceptanceEnvelope: { maxRecurringIncrease: NaN } }; } },
    { label: "stored effective_guarantee_mode typo", tamper: (s) => { s.effective_guarantee_mode = "REVALDIATE"; } },
    { label: "stored proposal guaranteeMode typo", tamper: (s) => { s.proposal = { ...s.proposal, guaranteeMode: "EXACTLY" }; } },
  ];
  for (const { label, tamper } of cases) {
    const path = join(mkdtempSync(join(tmpdir(), "scq-pr15-")), "scq.db");
    const durable = new DurableQuoteStore(path, { recoveryGraceMs: 0 });
    const h = liveHarness(durable);
    const adapter = new ChargebeeLiveAdapter(
      new ChargebeeClient({ site: LIVE_SITE, apiKey: "pilot-mock-key" }, (h as any).mock.transport),
      durable,
      { liveCommitEnabled: true, durableCoordinator: new DurableMutationCoordinator(durable), providerSite: LIVE_SITE },
    );
    const quote = await adapter.createChangeQuote(LIVE_SUB, h.validProposal());
    const stored = durable.get(quote.id) as any;
    tamper(stored);
    durable.put(stored);
    let err: unknown;
    try {
      await adapter.commitChangeQuote(quote.id);
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof SCQError, `${label}: expected an SCQError refusal, got: ${String(err)}`);
    assert.equal(codeOf(err), "INVALID_PROPOSAL", `${label}: expected INVALID_PROPOSAL, got ${codeOf(err)}`);
    assert.equal((h as any).mock.updateDispatches, 0, `${label}: zero mutating dispatches`);
    assert.equal(durable.allAttempts().length, 0, `${label}: zero durable dispatch attempts were created`);
    durable.close();
  }
});

// ---------------------------------------------------------------------------
// 48.19 — the shared validator itself, called directly: it is the
// single authoritative entry point every adapter applies, so its
// own contract is pinned here (including the deliberate
// non-restrictions: fractional bounds are valid — no integer-only
// rule is imposed by this PR).
// ---------------------------------------------------------------------------

test("Test 48.19: validateProposalRuntime accepts well-formed proposals and refuses each malformed class directly", () => {
  const valid: any = {
    changes: [{ action: "CHANGE_QUANTITY", itemId: "si_1", quantity: 120 }],
    effectiveIntent: { type: "IMMEDIATE" },
    guaranteeMode: "REVALIDATE",
    acceptanceEnvelope: { maxImmediateNetIncrease: 0.5, maxRecurringIncrease: 100 },
  };
  validateProposalRuntime(valid); // fractional bound: finite + nonnegative is valid (no integer-only restriction)
  validateProposalRuntime({ changes: [{ action: "CANCEL" }], effectiveIntent: { type: "TERM_END" } }); // all-CANCEL: no envelope required
  // Envelope PRESENCE is not the validator's rule: it stays in
  // enforceGuaranteeRequest, which the adapters call after their
  // effectiveIntent support checks — a proposal that is both
  // envelope-less and intent-unsupported must refuse
  // UNSUPPORTED_CHANGE for the intent (test25.19's pinned
  // precedence), so a shape-valid envelope-less proposal passes
  // THIS validator and is refused at creation by
  // enforceGuaranteeRequest instead (pinned at adapter level by
  // 48.11).
  validateProposalRuntime({ changes: valid.changes, effectiveIntent: valid.effectiveIntent, guaranteeMode: "REVALIDATE" });
  validateProposalRuntime({ changes: [{ action: "CHANGE_QUANTITY", itemId: "si_1", quantity: 5 }], effectiveIntent: { type: "DATE", at: "2026-09-01T00:00:00Z" }, guaranteeMode: "EXACT" }); // DATE shape is valid; provider support is the adapters' separate question
  const invalid: Array<{ label: string; proposal: unknown; code: string }> = [
    { label: "guaranteeMode typo", proposal: { ...valid, guaranteeMode: "REVALDIATE" }, code: "INVALID_PROPOSAL" },
    { label: "guaranteeMode null", proposal: { ...valid, guaranteeMode: null }, code: "INVALID_PROPOSAL" },
    { label: "envelope NaN bound", proposal: { ...valid, acceptanceEnvelope: { maxRecurringIncrease: NaN } }, code: "INVALID_PROPOSAL" },
    { label: "unknown scope", proposal: { ...valid, authorizationScope: "UNRESTRICTED" }, code: "INVALID_PROPOSAL" },
    { label: "TARGET_REPLACEMENT scope", proposal: { ...valid, authorizationScope: "TARGET_REPLACEMENT" }, code: "UNSUPPORTED_CHANGE" },
    { label: "non-object proposal", proposal: 42, code: "INVALID_PROPOSAL" },
  ];
  for (const { label, proposal, code } of invalid) {
    assert.throws(
      () => validateProposalRuntime(proposal),
      (e: unknown) => e instanceof SCQError && e.code === code,
      `validateProposalRuntime must refuse "${label}" as ${code}`,
    );
  }
});

// ---------------------------------------------------------------------------
// 48.17 — zero-tolerance pins for VALID envelopes (unchanged
// semantics): any drift beyond a stated zero bound is a
// violation; omitted bounds keep zero-tolerance meaning.
// ---------------------------------------------------------------------------

test("Test 48.17: zero-tolerance semantics for valid envelopes are unchanged", () => {
  const quoted = detEffect(20000, 80900, false);
  const drifted = detEffect(20001, 80900, false);
  drifted.provenance = { ...drifted.provenance, committedSource: "revalidated_preview" };
  const violation = checkAcceptanceEnvelope(quoted, drifted, { ...ZERO_ENVELOPE }, QTY_PROPOSAL);
  assert.ok(violation !== null && /maxImmediateNetIncrease=0/.test(violation), `a +1 drift against a zero bound must violate, got: ${violation}`);
  assert.equal(checkAcceptanceEnvelope(quoted, detEffect(20000, 80900, false), {}, QTY_PROPOSAL), null, "an empty envelope is valid (zero tolerance on every dimension) and matching figures pass");
});

// ---------------------------------------------------------------------------
// 48.18 — replay wins over validation: a quote that COMMITTED
// legitimately returns its original receipt on a repeated commit
// even if the stored proposal is tampered with afterwards —
// §6.10 replay is checked before any validation, exactly as it
// precedes the other gates.
// ---------------------------------------------------------------------------

test("Test 48.18: idempotent replay of a recorded receipt is not refused by post-commit record tampering", async () => {
  const h = stripeHarness();
  const quote = await h.adapter.createChangeQuote(h.subId, h.validProposal());
  const receipt = await h.adapter.commitChangeQuote(quote.id);
  assert.equal(receipt.outcome, "COMMITTED_AND_VERIFIED");
  const stored = h.store.get(quote.id) as any;
  stored.proposal = { ...stored.proposal, guaranteeMode: "REVALDIATE", acceptanceEnvelope: { maxRecurringIncrease: NaN } };
  h.store.put(stored);
  const replayed = await h.adapter.commitChangeQuote(quote.id);
  assert.equal(replayed.receiptId, receipt.receiptId, "the repeated commit returns the ORIGINAL receipt (§6.10), unvalidated and unrecomputed");
  assert.equal(replayed.outcome, "COMMITTED_AND_VERIFIED");
});

// ---------------------------------------------------------------------------
// 48.20 — PR-15 review correction P15-1: a SUPPLIED-but-falsy
// envelope (null, false, 0, "") is MALFORMED input, not an omitted
// envelope. reconcileCommittedEffect's `if (!envelope)` conflated
// the two: with committed figures otherwise established, the
// no-envelope path returned OK for a malformed supplied envelope.
// Only `undefined` means omission; a supplied malformed envelope
// must classify (never throw, never OK) — UNVERIFIED here, because
// a non-object envelope carries no interpretable bound through
// which a violation could be established.
// ---------------------------------------------------------------------------

test("Test 48.20 (P15-1): falsy supplied envelopes classify as malformed post-commit, never as omitted", () => {
  const quoted = detEffect(20000, 80900, false);
  const within = detEffect(20000, 80900, true);
  const violated = detEffect(20000, 90000, true);
  for (const bad of [null, false, 0, ""] as unknown[]) {
    const label = `envelope=${JSON.stringify(bad) ?? String(bad)}`;
    let r;
    assert.doesNotThrow(() => { r = reconcileCommittedEffect(quoted, within, bad as any, QTY_PROPOSAL); }, `${label}: reconcile must never throw`);
    assert.equal(r!.status, "UNVERIFIED", `${label}: a supplied malformed envelope must not read as the no-envelope OK, got ${r!.status}`);
    assert.match(r!.reason ?? "", /malformed/i, `${label}: the classification must name the malformed envelope`);
    // Even with drifted figures, a non-object envelope establishes
    // no interpretable bound — still classified, still never OK.
    const rv = reconcileCommittedEffect(quoted, violated, bad as any, QTY_PROPOSAL);
    assert.notEqual(rv.status, "OK", `${label}: drifted figures + malformed envelope must not read OK, got ${rv.status}`);
  }
  // Control: a genuinely OMITTED envelope (undefined) keeps its
  // established no-envelope semantics — established committed
  // actuals with nothing to compare against reconcile OK.
  assert.equal(reconcileCommittedEffect(quoted, within, undefined, QTY_PROPOSAL).status, "OK", "undefined remains omission: established actuals reconcile OK with no envelope");
});

// ---------------------------------------------------------------------------
// 48.21 — PR-15 review correction P15-2: envelope bounds are read
// through OWN properties only. The validator checked own field
// NAMES (Object.keys) but read bound VALUES through ordinary
// property access, so a bound inherited through the prototype
// chain passed validation AND drove comparisons — an inherited
// maxRecurringIncrease silently enlarged the permitted drift
// without any explicitly supplied bound. Inherited properties are
// not part of the envelope: they neither validate, nor tolerate,
// nor fire — an envelope whose bounds are all inherited behaves
// exactly like an envelope with those bounds omitted (zero
// tolerance), at quote time and at reconcile time alike.
// ---------------------------------------------------------------------------

test("Test 48.21 (P15-2): inherited envelope bounds never influence validation or comparison", () => {
  const quoted = detEffect(20000, 80900, false);
  const drifted = detEffect(20000, 85900, false); // recurring +5000
  const committedDrift = detEffect(20000, 85900, true);
  const HUGE = 1_000_000;

  // Envelope whose ONLY bound arrives via the prototype chain.
  const inheritedOnly: Record<string, unknown> = Object.create({ maxRecurringIncrease: HUGE });
  assert.deepEqual(Object.keys(inheritedOnly), [], "fixture check: the bound is inherited, not own");

  // Validation: an inherited valid value states no bound at all —
  // the envelope is shape-valid (equivalent to an empty envelope).
  assert.doesNotThrow(
    () => validateProposalRuntime({ changes: QTY_PROPOSAL.changes, effectiveIntent: QTY_PROPOSAL.effectiveIntent, guaranteeMode: "REVALIDATE", acceptanceEnvelope: inheritedOnly }),
    "an inherited bound must not fail validation — it simply is not part of the envelope",
  );
  // An inherited MALFORMED value is likewise not part of the
  // envelope: it must not make a shape-valid (empty) envelope
  // refuse as malformed.
  const inheritedNaN: Record<string, unknown> = Object.create({ maxRecurringIncrease: NaN });
  assert.doesNotThrow(
    () => validateProposalRuntime({ changes: QTY_PROPOSAL.changes, effectiveIntent: QTY_PROPOSAL.effectiveIntent, guaranteeMode: "REVALIDATE", acceptanceEnvelope: inheritedNaN }),
    "an inherited NaN bound is not the caller's bound and must not refuse the proposal",
  );

  // Quote time: the +5000 recurring drift must violate ZERO
  // tolerance (the inherited 1,000,000 must not enlarge it).
  const violation = checkAcceptanceEnvelope(quoted, drifted, inheritedOnly as any, QTY_PROPOSAL);
  assert.ok(violation !== null && /maxRecurringIncrease=0/.test(violation), `inherited tolerance must not pass a +5000 drift at quote time, got: ${violation}`);

  // Mixed: an OWN zero bound alongside an inherited huge one —
  // the own fields govern; the inherited field stays inert.
  const mixed: Record<string, unknown> = Object.create({ maxRecurringIncrease: HUGE });
  mixed.maxImmediateNetIncrease = 0;
  const mixedViolation = checkAcceptanceEnvelope(quoted, drifted, mixed as any, QTY_PROPOSAL);
  assert.ok(mixedViolation !== null && /maxRecurringIncrease=0/.test(mixedViolation), `own fields only: inherited maxRecurringIncrease must stay inert, got: ${mixedViolation}`);

  // Commit time (reconcile): the same inherited envelope must not
  // turn an established out-of-tolerance commit into OK.
  const r = reconcileCommittedEffect(quoted, committedDrift, inheritedOnly as any, QTY_PROPOSAL);
  assert.equal(r.status, "VIOLATED", `inherited tolerance must not reconcile a +5000 drift OK, got ${r.status}`);

  // Control: an OWN stated bound behaves exactly as before — a
  // +5000 drift inside an own 10000 bound passes both gates.
  assert.equal(checkAcceptanceEnvelope(quoted, drifted, { maxRecurringIncrease: 10000 }, QTY_PROPOSAL), null, "an own bound of 10000 still tolerates a +5000 drift at quote time");
  assert.equal(reconcileCommittedEffect(quoted, committedDrift, { maxRecurringIncrease: 10000 }, QTY_PROPOSAL).status, "OK", "an own bound of 10000 still reconciles a +5000 drift OK");
});

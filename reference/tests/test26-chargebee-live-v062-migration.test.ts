import { test } from "node:test";
import assert from "node:assert/strict";
import { QuoteStore, establishVerification } from "../src/store/quote-store.js";
import { SCQError } from "../src/core/types.js";
import { determinacyOf } from "../src/core/scq-engine.js";
import {
  ChargebeeClient,
  chargebeeConfigFromEnv,
  type HttpRequest,
  type HttpResponse,
  type HttpTransport,
} from "../src/live/chargebee-http.js";
import { ChargebeeLiveAdapter, interpretChargebeeEstimate } from "../src/live/chargebee-scq-adapter.js";
import { PilotMockChargebee, type PilotMockFaults } from "../src/live/pilot/mock-transport.js";
import {
  ChargebeeOperationNotAllowedError,
  classifyChargebeeOperation,
  createGuardedLiveTransport,
} from "../src/live/pilot/live-guard.js";
import { runPilot } from "../src/live/pilot/run-pilot.js";

// Test 26 — Chargebee LIVE adapter v0.6.2 migration (PR-7) regression
// matrix: the assignment's 20 rows.
//
// EVERY test runs against injected mocked transports. No real
// Chargebee call of any kind is made anywhere in this file: every
// ChargebeeClient is constructed with an explicit in-memory
// transport, and the audit wrapper below accounts for 100% of
// dispatches (test 26.21 proves the accounting identity on a full
// quote+commit+replay flow). Results are SIMULATED_PASS at best —
// never LIVE_PASS. Commit is enabled ONLY against the mocked
// transport; the real-network gate stays disabled (test 26.19).
//
// Migration doctrine (see research/chargebee-live-v062-migration.md):
// determinacy + provenance on every effect; committed effects from
// actuals only (mutation response + independent re-read), never the
// pre-mutation estimate; attribution via the response/re-read
// fingerprint bracket (resource_version movement is DETECTION, not
// a provider CAS); PR #14 Z1–Z3 discipline throughout.

const SUB = "pilot-sub-001";
const ADDON = "pilot-addon-vision";
const PLAN = "pilot-plan-business";
const MANDATORY = "pilot-addon-mandatory";
const PROPOSAL = (qty: number, itemId = ADDON) => ({
  changes: [{ action: "CHANGE_QUANTITY" as const, itemId, quantity: qty }],
  effectiveIntent: { type: "IMMEDIATE" as const },
  acceptanceEnvelope: {},
});

type Dispatch = { method: string; path: string; operation: string; mutating: boolean };

/** Wraps a transport with a dispatch audit log (operation classification via the pilot live-guard's classifier). */
function audited(inner: HttpTransport): { transport: HttpTransport; dispatches: Dispatch[] } {
  const dispatches: Dispatch[] = [];
  const transport: HttpTransport = async (req) => {
    const cls = classifyChargebeeOperation(req.method, req.url);
    dispatches.push({ method: req.method, path: new URL(req.url).pathname, operation: cls.operation, mutating: cls.mutating });
    return inner(req);
  };
  return { transport, dispatches };
}

function makeAdapter(
  faults: PilotMockFaults = {},
  opts: {
    commitEnabled?: boolean;
    now?: () => Date;
    store?: QuoteStore;
    /** Builds the transport the adapter's client will use, from the pilot mock (default: the mock's own transport). */
    wrap?: (mock: PilotMockChargebee) => HttpTransport;
  } = {},
) {
  const mock = new PilotMockChargebee(faults);
  const base = opts.wrap ? opts.wrap(mock) : mock.transport;
  const { transport, dispatches } = audited(base);
  const client = new ChargebeeClient({ site: "pilot-test", apiKey: "pilot-mock-key" }, transport);
  const store = opts.store ?? new QuoteStore();
  const adapter = new ChargebeeLiveAdapter(client, store, { liveCommitEnabled: opts.commitEnabled ?? true, now: opts.now });
  return { mock, client, store, adapter, dispatches };
}

const updateDispatches = (d: Dispatch[]) => d.filter((x) => x.operation === "update_for_items");
const isCode = (code: string) => (e: unknown) => e instanceof SCQError && e.code === code;

// ---------------------------------------------------------------------------
// 26.1 — Determined immediate zero vs missing immediate amount
// ---------------------------------------------------------------------------

test("Test 26.1a: a provider-stated zero immediate is a present DETERMINED zero — on the quote AND on the committed receipt", async () => {
  const { adapter, mock } = makeAdapter();
  const quote = await adapter.createChangeQuote(SUB, PROPOSAL(1)); // unchanged quantity: both estimate members present and empty
  assert.ok(quote.commercialEffect.immediate !== undefined && quote.commercialEffect.immediate.net === 0, "the stated zero is present, not absent");
  assert.deepEqual(quote.commercialEffect.determinacy, { immediateFinancialEffect: "DETERMINED", recurringFinancialEffect: "DETERMINED" });
  const receipt = await adapter.commitChangeQuote(quote.id);
  assert.equal(receipt.status, "COMMITTED");
  assert.equal(receipt.outcome, "COMMITTED_AND_VERIFIED");
  assert.equal(receipt.reconciliation.status, "OK");
  // Pre-migration the committed zero was re-encoded as ABSENT (the
  // `net !== 0` drop in the old committed-effect builder).
  assert.ok(receipt.committedEffect.immediate !== undefined && receipt.committedEffect.immediate.net === 0, "the committed determined zero stays present with net 0");
  assert.equal(receipt.committedEffect.determinacy?.immediateFinancialEffect, "DETERMINED");
  assert.equal(mock.mutationCount, 1);
});

test("Test 26.1b: a missing immediate amount (unbilled element without amount) reads UNKNOWN and refuses the quote — never zero-filled", async () => {
  const { adapter, dispatches } = makeAdapter({ omitUnbilledAmount: true });
  await assert.rejects(
    () => adapter.createChangeQuote(SUB, PROPOSAL(21)),
    (e: unknown) =>
      e instanceof SCQError && e.code === "QUOTE_NOT_DETERMINISTIC" &&
      (e.details as any)?.determinacy?.immediateFinancialEffect === "UNKNOWN",
  );
  assert.equal(updateDispatches(dispatches).length, 0);
});

// ---------------------------------------------------------------------------
// 26.2 — Sparse estimate with absent recurring figures => UNKNOWN
// ---------------------------------------------------------------------------

test("Test 26.2: sparse estimate whose recurring cannot be established (partial stated list + unjustifiable model) — recurring UNKNOWN, quote refused", async () => {
  const { adapter, dispatches } = makeAdapter({ partialStatedItems: true, pricingModelOverride: { [ADDON]: "tiered" } });
  await assert.rejects(
    () => adapter.createChangeQuote(SUB, PROPOSAL(21)),
    (e: unknown) =>
      e instanceof SCQError && e.code === "QUOTE_NOT_DETERMINISTIC" &&
      (e.details as any)?.determinacy?.recurringFinancialEffect === "UNKNOWN",
  );
  assert.equal(updateDispatches(dispatches).length, 0);
});

// ---------------------------------------------------------------------------
// 26.3 — Partial subscription-item lists: no fabricated totals
// ---------------------------------------------------------------------------

test("Test 26.3a: a partial stated estimate list is never summed as the recurring total — the justified per-item computation carries the quote, labeled", async () => {
  const { adapter } = makeAdapter({ partialStatedItems: true });
  const quote = await adapter.createChangeQuote(SUB, PROPOSAL(21));
  assert.equal(quote.commercialEffect.recurring?.resultingAmount, 80900, "the complete computed level — not the partial stated sum (21000)");
  const prov = quote.commercialEffect.provenance?.recurring ?? "";
  assert.ok(prov.startsWith("computed per item"), prov);
  assert.ok(prov.includes("did NOT verify as the complete intended item set"), prov);
  assert.equal(quote.commercialEffect.determinacy?.recurringFinancialEffect, "DETERMINED", "established by the justified computation, with its provenance saying so");
});

test("Test 26.3b: snapshot pricing is strict — an absent items member, or one item without a stated amount, yields NO recurring figure (UNKNOWN), never a reconstruction", async () => {
  const doctor = (mode: "absentMember" | "stripAmount") => (mock: PilotMockChargebee): HttpTransport => async (req) => {
    const res = await mock.transport(req);
    if (req.method === "GET" && req.url.includes("/subscriptions/") && res.json) {
      const j = structuredClone(res.json) as any;
      if (mode === "absentMember") delete j.subscription.subscription_items;
      else delete j.subscription.subscription_items[1].amount;
      return { ...res, json: j };
    }
    return res;
  };
  for (const mode of ["absentMember", "stripAmount"] as const) {
    const { adapter } = makeAdapter({}, { wrap: doctor(mode) });
    const snap = await adapter.getSubscription(SUB);
    assert.equal(snap.billing.recurringAmount, undefined, `${mode}: no figure is emitted — pre-migration the fallback computed unit_price x quantity (and 0 for an absent member)`);
    assert.equal(snap.billing.recurringAmountState, "UNKNOWN", `${mode}: the snapshot labels its own determinacy (CORE-7)`);
  }
  // Positive control: the undoctored read prices strictly and labels DETERMINED.
  const { adapter } = makeAdapter();
  const snap = await adapter.getSubscription(SUB);
  assert.equal(snap.billing.recurringAmount, 60900);
  assert.equal(snap.billing.recurringAmountState, "DETERMINED");
});

// ---------------------------------------------------------------------------
// 26.4 — Flat-fee quantity misuse
// ---------------------------------------------------------------------------

test("Test 26.4a: CHANGE_QUANTITY on a flat_fee item is refused BEFORE any estimate or mutation — quantity is never multiplied into a price", async () => {
  const { adapter, mock, dispatches } = makeAdapter();
  await assert.rejects(() => adapter.createChangeQuote(SUB, PROPOSAL(2, PLAN)), isCode("UNSUPPORTED_CHANGE"));
  assert.equal(mock.estimateCount, 0, "the refusal happens on item-price metadata, before the estimate call");
  assert.equal(updateDispatches(dispatches).length, 0);
});

test("Test 26.4b: a flat_fee item's recurring contribution is its fixed price ONCE (CHANGE_PLAN onto a flat_fee addon)", async () => {
  const { adapter } = makeAdapter();
  const quote = await adapter.createChangeQuote(SUB, {
    changes: [{ action: "CHANGE_PLAN" as const, itemId: ADDON, offeringRef: MANDATORY }],
    effectiveIntent: { type: "IMMEDIATE" as const },
    acceptanceEnvelope: {},
  });
  assert.equal(quote.commercialEffect.recurring?.resultingAmount, 62400, "59900 plan + the flat_fee addon's fixed 2500 — once, at quantity 1");
  assert.equal(quote.commercialEffect.determinacy?.recurringFinancialEffect, "DETERMINED");
});

// ---------------------------------------------------------------------------
// 26.5 — Unjustified recurring-price reconstruction refused
// ---------------------------------------------------------------------------

test("Test 26.5: with no provider-stated amount and no pricing-model justification, recurring is ABSENT (UNKNOWN under the v0.6.2 reading) — never reconstructed", () => {
  const r = interpretChargebeeEstimate(
    { subscription_estimate: { id: "s", status: "active" }, unbilled_charge_estimates: [{ amount: 5000 }], credit_note_estimates: [] },
    {
      currency: "USD",
      currentItems: [{ itemPriceId: ADDON, quantity: 5 }],
      targetItems: [{ itemPriceId: ADDON, quantity: 9 }],
      priceInfo: new Map(),
    },
  );
  assert.equal(r.effect.recurring, undefined, "no unit price, no amount, no free_quantity: nothing justifies a quantity computation");
  const det = determinacyOf({ ...r.effect, determinacy: { immediateFinancialEffect: "DETERMINED", recurringFinancialEffect: "UNKNOWN" } });
  assert.equal(det.recurringFinancialEffect, "UNKNOWN");
  assert.ok(r.provenance.recurring.startsWith("absent"));
});

// ---------------------------------------------------------------------------
// 26.6 — Next-invoice amount / credits kept out of incurred obligations
// ---------------------------------------------------------------------------

test("Test 26.6: next-invoice figures never enter the effect — varying ONLY the credits leaves the quote identical, even when amount_due coincides with the incurred figure", async () => {
  const effects: unknown[] = [];
  for (const credits of [300, 0, 60900]) {
    const { adapter } = makeAdapter({ nextInvoiceCredits: credits });
    const quote = await adapter.createChangeQuote(SUB, PROPOSAL(21));
    const ni = (quote.providerMetadata as any).nextInvoiceEstimate;
    assert.equal(ni.total, 80900);
    assert.equal(ni.amountDue, 80900 - credits, "amount_due lives in metadata, net of credits");
    assert.equal(quote.commercialEffect.immediate?.net, 20000, "the incurred obligation is the unbilled-charge sum, whatever the credits are");
    assert.equal(quote.commercialEffect.recurring?.resultingAmount, 80900, "credits never reduce the subscription price level");
    effects.push({ immediate: quote.commercialEffect.immediate, recurring: quote.commercialEffect.recurring, determinacy: quote.commercialEffect.determinacy });
  }
  // credits = 60900 makes amount_due exactly 20000 — the incurred
  // figure. The quote is STILL sourced from the unbilled charges:
  // all three quotes are identical in effect and determinacy.
  assert.deepEqual(effects[1], effects[0]);
  assert.deepEqual(effects[2], effects[0]);
  const { adapter } = makeAdapter({ nextInvoiceCredits: 60900 });
  const quote = await adapter.createChangeQuote(SUB, PROPOSAL(21));
  assert.ok((quote.commercialEffect.provenance?.immediate ?? "").includes("unbilled_charge_estimates"), quote.commercialEffect.provenance?.immediate);
});

// ---------------------------------------------------------------------------
// 26.7 — Stale resource versions and quote expiration
// ---------------------------------------------------------------------------

test("Test 26.7a: a resource_version move after the quote (concurrent change) refuses the commit as QUOTE_STALE before any mutation", async () => {
  const { adapter, mock, dispatches } = makeAdapter();
  const quote = await adapter.createChangeQuote(SUB, PROPOSAL(21));
  assert.equal(quote.preconditions.subscriptionVersion, "rv:1700000000000", "the precondition is the provider resource_version");
  mock.applyExternalChange(ADDON, 5);
  await assert.rejects(() => adapter.commitChangeQuote(quote.id), isCode("QUOTE_STALE"));
  assert.equal(updateDispatches(dispatches).length, 0);
});

test("Test 26.7b: an expired quote refuses the commit before any mutation", async () => {
  let clock = new Date("2026-08-01T00:00:00Z");
  const { adapter, dispatches } = makeAdapter({}, { now: () => clock });
  const quote = await adapter.createChangeQuote(SUB, PROPOSAL(21));
  clock = new Date(clock.getTime() + 6 * 60 * 1000); // past the 5-minute TTL
  await assert.rejects(() => adapter.commitChangeQuote(quote.id), isCode("QUOTE_EXPIRED"));
  assert.equal(updateDispatches(dispatches).length, 0);
});

// ---------------------------------------------------------------------------
// 26.8 — Revalidation drift with zero mutations
// ---------------------------------------------------------------------------

test("Test 26.8: commit-time revalidation drift (estimate moves outside the envelope) refuses with QUOTE_DRIFTED and dispatches zero mutations", async () => {
  let estimateCalls = 0;
  const { adapter, store, dispatches } = makeAdapter({}, {
    wrap: (mock) => async (req) => {
      const res = await mock.transport(req);
      if (req.method === "POST" && req.url.includes("/estimates/")) {
        estimateCalls++;
        if (estimateCalls >= 2 && res.json) {
          const j = structuredClone(res.json) as any;
          j.estimate.unbilled_charge_estimates = [{ amount: 25000 }]; // drift: +5000 vs the quoted 20000
          return { ...res, json: j };
        }
      }
      return res;
    },
  });
  const quote = await adapter.createChangeQuote(SUB, PROPOSAL(21));
  await assert.rejects(() => adapter.commitChangeQuote(quote.id), isCode("QUOTE_DRIFTED"));
  assert.equal(updateDispatches(dispatches).length, 0, "the envelope gate fires before the mutating call");
  assert.equal(store.get(quote.id)?.commit_receipt, undefined);
  assert.equal(store.get(quote.id)?.commit_outcome, undefined, "a pre-mutation refusal is not a commit outcome");
});

// ---------------------------------------------------------------------------
// 26.9 — Wrong final item set after HTTP 200 (attributable) => VIOLATED
// ---------------------------------------------------------------------------

test("Test 26.9: the provider lands the WRONG quantity (11 of 21) with attribution closed — VIOLATED over the presented actuals, never a verified success", async () => {
  const { adapter, mock } = makeAdapter({}, {
    wrap: (mock) => async (req) => {
      if (req.method === "POST" && req.url.includes("/update_for_items")) {
        const body = new URLSearchParams(req.body ?? "");
        body.set("subscription_items[quantity][1]", "11"); // the provider applies a different quantity than dispatched
        return mock.transport({ ...req, body: body.toString() });
      }
      return mock.transport(req);
    },
  });
  const quote = await adapter.createChangeQuote(SUB, PROPOSAL(21));
  const receipt = await adapter.commitChangeQuote(quote.id);
  assert.equal(receipt.status, "COMMITTED");
  assert.equal(receipt.outcome, "COMMITTED_AND_VERIFIED", "verified-with-violation: the figures ARE established — they establish a contradiction");
  assert.equal(receipt.reconciliation.status, "VIOLATED");
  assert.match((receipt.reconciliation as any).reason, /quantity mismatch for item pilot-addon-vision: intended 21, actual 11/);
  assert.equal(receipt.committedEffect.recurring?.resultingAmount, 70900, "the observed actual level (59900 + 11000), not the intended 80900");
  assert.equal(receipt.committedEffect.immediate?.net, 10000, "the actual incurred for the 10-unit delta that really landed");
  assert.equal(mock.mutationCount, 1);
});

// ---------------------------------------------------------------------------
// 26.10 — Known landed mutation with financial actuals unavailable (Defect 3)
// ---------------------------------------------------------------------------

test("Test 26.10a: response received but carrying NO financials — COMMITTED_UNVERIFIED typed receipt; the established recurring survives, the immediate is UNKNOWN", async () => {
  const { adapter, mock, store } = makeAdapter({ incompleteUpdateResponse: true });
  const quote = await adapter.createChangeQuote(SUB, PROPOSAL(21));
  const receipt = await adapter.commitChangeQuote(quote.id);
  assert.equal(receipt.status, "COMMITTED_UNVERIFIED");
  assert.equal(receipt.outcome, "COMMITTED_UNVERIFIED");
  assert.equal(receipt.reconciliation.status, "UNVERIFIED");
  assert.deepEqual((receipt.reconciliation as any).undeterminedDimensions, ["immediateFinancialEffect"]);
  assert.equal(receipt.committedEffect.immediate, undefined, "never the pre-mutation estimate substituted as an actual");
  assert.equal(receipt.committedEffect.recurring?.resultingAmount, 80900, "established from the independent re-read");
  assert.equal(receipt.committedEffect.provenance?.committedSource, "unestablished", "the effect AS A WHOLE is not an established set of actuals");
  assert.equal(store.get(quote.id)?.commit_receipt?.status, "COMMITTED_UNVERIFIED");
  assert.equal(mock.mutationCount, 1);
});

test("Test 26.10b: the update RESPONSE's items carry no amounts, but the independent re-read establishes the recurring — verified (the response's item list is never the recurring source)", async () => {
  const { adapter } = makeAdapter({ postUpdateItemsMissingAmounts: true });
  const quote = await adapter.createChangeQuote(SUB, PROPOSAL(21));
  const receipt = await adapter.commitChangeQuote(quote.id);
  assert.equal(receipt.status, "COMMITTED");
  assert.equal(receipt.outcome, "COMMITTED_AND_VERIFIED");
  assert.equal(receipt.reconciliation.status, "OK");
  assert.equal(receipt.committedEffect.recurring?.resultingAmount, 80900, "established from the re-read's stated amounts — the amount-less response items are simply not used for this dimension");
  assert.equal(receipt.committedEffect.immediate?.net, 20000);
});

test("Test 26.10c: the post-commit RE-READ's items lack stated amounts — recurring UNKNOWN (never reconstructed), immediate DETERMINED from the response, outcome COMMITTED_UNVERIFIED", async () => {
  let updated = false;
  const { adapter } = makeAdapter({}, {
    wrap: (mock) => async (req) => {
      const res = await mock.transport(req);
      if (req.method === "POST" && req.url.includes("/update_for_items")) {
        updated = true;
        return res;
      }
      if (updated && req.method === "GET" && req.url.includes("/subscriptions/") && res.json) {
        const j = structuredClone(res.json) as any;
        for (const it of j.subscription.subscription_items ?? []) delete it.amount;
        return { ...res, json: j };
      }
      return res;
    },
  });
  const quote = await adapter.createChangeQuote(SUB, PROPOSAL(21));
  const receipt = await adapter.commitChangeQuote(quote.id);
  assert.equal(receipt.status, "COMMITTED_UNVERIFIED");
  assert.equal(receipt.reconciliation.status, "UNVERIFIED");
  assert.deepEqual((receipt.reconciliation as any).undeterminedDimensions, ["recurringFinancialEffect"]);
  assert.equal(receipt.committedEffect.immediate?.net, 20000, "the response's own actual is established");
  assert.equal(receipt.committedEffect.determinacy?.immediateFinancialEffect, "DETERMINED");
  assert.equal(receipt.committedEffect.recurring?.resultingAmount, undefined, "amounts the re-read does not state are never reconstructed from unit prices");
  assert.equal(receipt.committedEffect.determinacy?.recurringFinancialEffect, "UNKNOWN");
});

// ---------------------------------------------------------------------------
// 26.11 — Mutation response lost and landing unknown => INDETERMINATE
// ---------------------------------------------------------------------------

test("Test 26.11: the dispatch is lost BEFORE reaching the provider — INDETERMINATE, outcome recorded, no receipt, and the retry guard refuses any second dispatch", async () => {
  const { adapter, mock, store, dispatches } = makeAdapter({}, {
    wrap: (mock) => async (req) => {
      if (req.method === "POST" && req.url.includes("/update_for_items")) throw new Error("connection reset before send");
      return mock.transport(req);
    },
  });
  const quote = await adapter.createChangeQuote(SUB, PROPOSAL(21));
  await assert.rejects(
    () => adapter.commitChangeQuote(quote.id),
    (e: unknown) => e instanceof SCQError && (e.details as any)?.outcome === "INDETERMINATE" && (e.details as any)?.indeterminate === true,
  );
  assert.equal(store.get(quote.id)?.commit_outcome?.outcome, "INDETERMINATE", "the attempt leaves a typed outcome record, not just a thrown error");
  assert.equal(store.get(quote.id)?.commit_receipt, undefined);
  assert.equal(mock.mutationCount, 0, "the request never reached the provider");
  assert.equal(updateDispatches(dispatches).length, 1, "exactly one dispatch was ATTEMPTED");
  // The recorded INDETERMINATE outcome refuses a blind retry BEFORE
  // any read or mutation — pre-migration this retry would have
  // re-dispatched, because the unchanged state kept the quote valid.
  await assert.rejects(
    () => adapter.commitChangeQuote(quote.id),
    (e: unknown) => e instanceof SCQError && (e.details as any)?.outcome === "INDETERMINATE",
  );
  assert.equal(updateDispatches(dispatches).length, 1, "no second dispatch — the guard fired first");
  assert.equal(mock.mutationCount, 0);
});

// ---------------------------------------------------------------------------
// 26.12 — Lost response, final state matches, attribution unresolved
// ---------------------------------------------------------------------------

test("Test 26.12: lost response with the intended set in effect — INDETERMINATE (PR-7 review L1): matching state does not establish that THIS request landed", async () => {
  // DISCLOSED CHANGE (PR-7 review L1): this test previously asserted
  // a COMMITTED_UNVERIFIED receipt. The review established that a
  // changed subscription matching the intended result does not prove
  // THIS request caused the change: the observations are identical
  // if another actor applied the same item set while our request
  // never landed (see 26.12b). An idempotency key sent with a lost
  // request does not establish execution, and Chargebee supplies no
  // per-operation read-back artifact in this adapter's validated
  // surface — so with no successful response and no operation-bound
  // execution evidence, the outcome is INDETERMINATE: the outcome is
  // persisted (with the observed state as diagnostic context), NO
  // committed receipt is recorded, and blind retry is refused.
  // COMMITTED_UNVERIFIED remains for cases where a response WAS
  // received (e.g. test21-c8, 26.10, 26.17).
  const { adapter, mock, store, dispatches } = makeAdapter({ loseUpdateResponse: true });
  const quote = await adapter.createChangeQuote(SUB, PROPOSAL(21));
  await assert.rejects(
    () => adapter.commitChangeQuote(quote.id),
    (e: unknown) => e instanceof SCQError && (e.details as any)?.outcome === "INDETERMINATE" && (e.details as any)?.indeterminate === true,
  );
  assert.equal(store.get(quote.id)?.commit_outcome?.outcome, "INDETERMINATE", "the attempt leaves a typed outcome record");
  assert.equal(store.get(quote.id)?.commit_receipt, undefined, "no committed receipt — landing by THIS request is not established");
  assert.equal(mock.mutationCount, 1, "the mock did apply the update before losing the response — and the classification is still INDETERMINATE");
  await assert.rejects(
    () => adapter.commitChangeQuote(quote.id),
    (e: unknown) => e instanceof SCQError && (e.details as any)?.outcome === "INDETERMINATE",
  );
  assert.equal(updateDispatches(dispatches).length, 1, "no second dispatch — the recorded INDETERMINATE refuses blind retry");
  assert.equal(mock.mutationCount, 1);
});

test("Test 26.12b: observational equivalence — the request fails BEFORE application while an independent actor writes the SAME target state: INDETERMINATE, indistinguishable from 26.12", async () => {
  // The mirror image of 26.12: our dispatch never reaches the
  // provider's mutation path, but a separate actor applies exactly
  // the intended item set, advancing resource_version. Every
  // observation available to the adapter (intended set in effect,
  // fingerprint moved) is identical to the applied-but-lost case —
  // so both must classify INDETERMINATE with no committed receipt.
  const { adapter, mock, store, dispatches } = makeAdapter({}, {
    wrap: (mock) => async (req) => {
      if (req.method === "POST" && req.url.includes("/update_for_items")) {
        mock.applyExternalChange(ADDON, 21); // the independent actor lands the identical change
        throw new Error("connection reset before provider application"); // our request never applied
      }
      return mock.transport(req);
    },
  });
  const quote = await adapter.createChangeQuote(SUB, PROPOSAL(21));
  await assert.rejects(
    () => adapter.commitChangeQuote(quote.id),
    (e: unknown) => e instanceof SCQError && (e.details as any)?.outcome === "INDETERMINATE" && (e.details as any)?.indeterminate === true,
  );
  assert.equal(store.get(quote.id)?.commit_outcome?.outcome, "INDETERMINATE");
  assert.equal(store.get(quote.id)?.commit_receipt, undefined, "no committed receipt — the matching state is another actor's work");
  assert.equal(mock.mutationCount, 0, "our request never reached the provider's mutation path");
  await assert.rejects(
    () => adapter.commitChangeQuote(quote.id),
    (e: unknown) => e instanceof SCQError && (e.details as any)?.outcome === "INDETERMINATE",
  );
  assert.equal(updateDispatches(dispatches).length, 1, "no blind retry");
});

// ---------------------------------------------------------------------------
// 26.13 — Provider-side contradiction with established attribution
// ---------------------------------------------------------------------------

test("Test 26.13: the item set lands correctly but the response's actual incurred (25000) contradicts the quoted envelope — VIOLATED over established actuals", async () => {
  const { adapter } = makeAdapter({}, {
    wrap: (mock) => async (req) => {
      const res = await mock.transport(req);
      if (req.method === "POST" && req.url.includes("/update_for_items") && res.json) {
        const j = structuredClone(res.json) as any;
        j.unbilled_charges = [{ amount: 25000 }]; // the provider's actual for THIS operation, vs the estimate's 20000
        return { ...res, json: j };
      }
      return res;
    },
  });
  const quote = await adapter.createChangeQuote(SUB, PROPOSAL(21));
  const receipt = await adapter.commitChangeQuote(quote.id);
  assert.equal(receipt.status, "COMMITTED");
  assert.equal(receipt.outcome, "COMMITTED_AND_VERIFIED");
  assert.equal(receipt.reconciliation.status, "VIOLATED", "actual 25000 exceeds the zero-tolerance envelope vs quoted 20000");
  assert.equal(receipt.committedEffect.immediate?.net, 25000, "the receipt carries the ACTUAL — not the estimate's 20000");
  assert.equal(receipt.committedEffect.recurring?.resultingAmount, 80900);
});

// ---------------------------------------------------------------------------
// 26.14 — Intervening external mutation (Z1–Z3)
// ---------------------------------------------------------------------------

test("Test 26.14a: an intervening write after our mutation lands a DIFFERENT state — COMMITTED_UNVERIFIED, the contradiction is unattributed context, no recurring figure recorded", async () => {
  const { adapter } = makeAdapter({}, {
    wrap: (mock) => async (req) => {
      const res = await mock.transport(req);
      if (req.method === "POST" && req.url.includes("/update_for_items")) mock.applyExternalChange(ADDON, 5);
      return res;
    },
  });
  const quote = await adapter.createChangeQuote(SUB, PROPOSAL(21));
  const receipt = await adapter.commitChangeQuote(quote.id);
  assert.equal(receipt.status, "COMMITTED_UNVERIFIED");
  assert.equal(receipt.outcome, "COMMITTED_UNVERIFIED", "Z1: a contradiction behind a broken attribution chain is never this commit's verified VIOLATED");
  assert.equal(receipt.reconciliation.status, "UNVERIFIED");
  assert.match((receipt.reconciliation as any).reason, /unattributed context/);
  assert.equal(receipt.committedEffect.recurring?.resultingAmount, undefined, "Z3: the intervening actor's level (64900) is NOT recorded as this commit's actual");
  assert.equal(receipt.committedEffect.immediate?.net, 20000, "the response's own immediate actual survives — its scope is this operation alone");
  assert.equal(receipt.resultingSnapshot.items.find((i) => i.id === ADDON)?.quantity, 5, "the observed state is context in the snapshot");
});

test("Test 26.14b: an intervening round-trip write restores the intended set — still COMMITTED_UNVERIFIED: matching state under a broken bracket does not verify", async () => {
  const { adapter } = makeAdapter({}, {
    wrap: (mock) => async (req) => {
      const res = await mock.transport(req);
      if (req.method === "POST" && req.url.includes("/update_for_items")) {
        mock.applyExternalChange(ADDON, 7);
        mock.applyExternalChange(ADDON, 21); // final visible state matches intent — but two writes intervened
      }
      return res;
    },
  });
  const quote = await adapter.createChangeQuote(SUB, PROPOSAL(21));
  const receipt = await adapter.commitChangeQuote(quote.id);
  assert.equal(receipt.status, "COMMITTED_UNVERIFIED");
  assert.equal(receipt.reconciliation.status, "UNVERIFIED");
  assert.equal(receipt.committedEffect.recurring?.resultingAmount, undefined, "no recurring figure under a broken bracket, even when the level coincides with intent");
  assert.equal(receipt.committedEffect.determinacy?.recurringFinancialEffect, "UNKNOWN");
  assert.equal(receipt.committedEffect.immediate?.net, 20000);
});

// ---------------------------------------------------------------------------
// 26.15 — Idempotency evidence: replay, conflict, expiry, absence
// ---------------------------------------------------------------------------

test("Test 26.15a: concurrent duplicate commits replay natively — the provider applies the mutation exactly once and the replayed response counts as the original operation's actuals", async () => {
  const { adapter, mock, store, client } = makeAdapter();
  const quote = await adapter.createChangeQuote(SUB, PROPOSAL(21));
  const [r1, r2] = await Promise.all([adapter.commitChangeQuote(quote.id), adapter.commitChangeQuote(quote.id)]);
  assert.equal(r1.status, "COMMITTED");
  assert.equal(r2.status, "COMMITTED");
  assert.equal(r1.reconciliation.status, "OK");
  assert.equal(r2.reconciliation.status, "OK");
  // Exactly one provider-side application: the resource_version
  // moved by exactly one write (+1000 in the mock's write model).
  const after = await client.getSubscription(SUB);
  assert.equal((after.json.subscription as any).resource_version, 1700000001000, "two dispatches, ONE application — the second was a native idempotency replay");
  assert.equal(mock.mutationCount, 2, "two dispatches reached the (mocked) provider; the replay is a read of the first operation");
  assert.ok(
    [r1, r2].some((r) => (r.committedEffect.provenance?.immediate ?? "").includes("idempotency replay")),
    "one of the two receipts records the replayed provenance",
  );
  assert.equal(store.get(quote.id)?.commit_receipt?.committedEffect?.immediate?.net, 20000);
});

test("Test 26.15b: a 422 duplicate_request where the key was already consumed by a PRIOR processed request with different parameters — INDETERMINATE (PR-7 review L2), re-dispatch blocked pending reconciliation", async () => {
  // DISCLOSED CHANGE (PR-7 review L2): this test previously asserted
  // CONFIRMED_NON_EXECUTION. A 422 idempotency conflict establishes
  // only that THIS attempt was rejected; it does NOT establish that
  // the operation that originally consumed the key did not execute —
  // here that prior request (different parameters: quantity 99) DID
  // land. The quote therefore preserves the possibility of an
  // earlier landing: the outcome is INDETERMINATE, no receipt is
  // recorded, and a new dispatch is blocked pending reconciliation
  // (the same guard as a recorded lost-dispatch INDETERMINATE).
  const { adapter, mock, store, dispatches } = makeAdapter({}, {
    wrap: (mock) => async (req) => {
      if (req.method === "POST" && req.url.includes("/update_for_items")) {
        mock.applyExternalChange(ADDON, 99); // the prior processed request that consumed this key, with different parameters
        return {
          status: 422,
          headers: {},
          json: {
            type: "invalid_request",
            api_error_code: "duplicate_request",
            message: "Request already processed with different parameters.",
            http_status_code: 422,
          },
        };
      }
      return mock.transport(req);
    },
  });
  const quote = await adapter.createChangeQuote(SUB, PROPOSAL(21));
  await assert.rejects(
    () => adapter.commitChangeQuote(quote.id),
    (e: unknown) => e instanceof SCQError && e.code === "PROVIDER_ERROR" && (e.details as any)?.outcome === "INDETERMINATE",
  );
  assert.equal(store.get(quote.id)?.commit_outcome?.outcome, "INDETERMINATE", "NOT confirmed non-execution — the key's original operation may have executed");
  assert.equal(store.get(quote.id)?.commit_receipt, undefined);
  assert.equal(mock.mutationCount, 0, "this attempt never reached the provider's mutation path — but the prior key-holder's change is in effect");
  await assert.rejects(
    () => adapter.commitChangeQuote(quote.id),
    (e: unknown) => e instanceof SCQError && (e.details as any)?.outcome === "INDETERMINATE",
  );
  assert.equal(updateDispatches(dispatches).length, 1, "no re-dispatch pending reconciliation");
});

test("Test 26.15e: an HTTP 408 (request timeout) on the mutation is INDETERMINATE (PR-7 review L2) — a timeout is not evidence the request was never applied", async () => {
  const { adapter, mock, store, dispatches } = makeAdapter({}, {
    wrap: (mock) => async (req) => {
      if (req.method === "POST" && req.url.includes("/update_for_items")) {
        return { status: 408, headers: {}, json: { type: "invalid_request", api_error_code: "request_timeout", message: "request timed out", http_status_code: 408 } };
      }
      return mock.transport(req);
    },
  });
  const quote = await adapter.createChangeQuote(SUB, PROPOSAL(21));
  await assert.rejects(
    () => adapter.commitChangeQuote(quote.id),
    (e: unknown) => e instanceof SCQError && (e.details as any)?.outcome === "INDETERMINATE",
  );
  assert.equal(store.get(quote.id)?.commit_outcome?.outcome, "INDETERMINATE", "NOT confirmed non-execution — the request may have been applied before the timeout");
  assert.equal(store.get(quote.id)?.commit_receipt, undefined);
  assert.equal(mock.mutationCount, 0);
  await assert.rejects(
    () => adapter.commitChangeQuote(quote.id),
    (e: unknown) => e instanceof SCQError && (e.details as any)?.outcome === "INDETERMINATE",
  );
  assert.equal(updateDispatches(dispatches).length, 1, "no blind retry after an ambiguous timeout");
});

test("Test 26.15f: an ambiguous HTTP 429 (rate limiting) on the mutation is INDETERMINATE (PR-7 review L2) — rate limiting does not establish non-execution", async () => {
  const { adapter, mock, store, dispatches } = makeAdapter({}, {
    wrap: (mock) => async (req) => {
      if (req.method === "POST" && req.url.includes("/update_for_items")) {
        return { status: 429, headers: {}, json: { type: "invalid_request", api_error_code: "too_many_requests", message: "rate limit exceeded", http_status_code: 429 } };
      }
      return mock.transport(req);
    },
  });
  const quote = await adapter.createChangeQuote(SUB, PROPOSAL(21));
  await assert.rejects(
    () => adapter.commitChangeQuote(quote.id),
    (e: unknown) => e instanceof SCQError && (e.details as any)?.outcome === "INDETERMINATE",
  );
  assert.equal(store.get(quote.id)?.commit_outcome?.outcome, "INDETERMINATE", "NOT confirmed non-execution — an ambiguous 429 carries no proof the request was never applied");
  assert.equal(store.get(quote.id)?.commit_receipt, undefined);
  assert.equal(mock.mutationCount, 0);
  await assert.rejects(
    () => adapter.commitChangeQuote(quote.id),
    (e: unknown) => e instanceof SCQError && (e.details as any)?.outcome === "INDETERMINATE",
  );
  assert.equal(updateDispatches(dispatches).length, 1, "no blind retry after an ambiguous 429");
});

test("Test 26.15c: after the native 30-minute window the provider REPROCESSES the same key (client-level hazard) — which is why the adapter's own guards, not the native window, carry exactly-once", async () => {
  // A minimal update_for_items-only transport with Chargebee's
  // documented window semantics (cf. test13-http3's full fake):
  // same key + same params inside 30 minutes replays the cached
  // response; after expiry the same key is processed again.
  let clock = Date.parse("2026-08-01T00:00:00Z");
  let applications = 0;
  const seen = new Map<string, { paramsHash: string; at: number; response: HttpResponse }>();
  const transport: HttpTransport = async (req: HttpRequest): Promise<HttpResponse> => {
    const key = req.headers["chargebee-idempotency-key"];
    const params = new URLSearchParams(req.body ?? "");
    params.delete("idempotency_key");
    const paramsHash = [...params.entries()].map(([k, v]) => `${k}=${v}`).join("&");
    const prior = seen.get(key);
    if (prior && clock - prior.at < 30 * 60 * 1000) {
      if (prior.paramsHash !== paramsHash) {
        return { status: 422, headers: {}, json: { type: "invalid_request", api_error_code: "duplicate_request", message: "same key, different parameters", http_status_code: 422 } };
      }
      return { ...prior.response, headers: { ...prior.response.headers, "chargebee-idempotency-replayed": "true" } };
    }
    applications++;
    const response: HttpResponse = {
      status: 200,
      headers: {},
      json: { subscription: { id: SUB, status: "active", resource_version: 1700000000000 + applications }, unbilled_charges: [{ amount: 20000 }] },
    };
    seen.set(key, { paramsHash, at: clock, response });
    return response;
  };
  const client = new ChargebeeClient({ site: "pilot-test", apiKey: "pilot-mock-key" }, transport);
  const params = { subscription_items: [{ itemPriceId: ADDON, quantity: 21 }], replace_items_list: true, prorate: true, invoice_immediately: false };
  const first = await client.updateForItems(SUB, params, "fixed-key");
  assert.equal(first.idempotencyReplayed, false);
  const replay = await client.updateForItems(SUB, params, "fixed-key");
  assert.equal(replay.idempotencyReplayed, true, "inside the window the same key+params replays");
  assert.equal(applications, 1);
  clock += 31 * 60 * 1000; // past the documented 30-minute window
  const reprocessed = await client.updateForItems(SUB, params, "fixed-key");
  assert.equal(reprocessed.idempotencyReplayed, false);
  assert.equal(applications, 2, "after expiry the native layer reprocesses — adapter-level receipt/outcome guards (26.11, 26.12, 26.17) are the actual protection");
});

test("Test 26.15d: a 200 response with NO subscription body and a failing re-read leaves no usable evidence — INDETERMINATE, outcome recorded, no receipt", async () => {
  let dispatched = false;
  const { adapter, store } = makeAdapter({}, {
    wrap: (mock) => async (req) => {
      if (req.method === "POST" && req.url.includes("/update_for_items")) {
        dispatched = true;
        return { status: 200, headers: {}, json: {} }; // nothing establishing landing, state, or financials
      }
      if (dispatched && req.method === "GET") throw new Error("read path down");
      return mock.transport(req);
    },
  });
  const quote = await adapter.createChangeQuote(SUB, PROPOSAL(21));
  await assert.rejects(
    () => adapter.commitChangeQuote(quote.id),
    (e: unknown) => e instanceof SCQError && (e.details as any)?.outcome === "INDETERMINATE",
  );
  assert.equal(store.get(quote.id)?.commit_outcome?.outcome, "INDETERMINATE");
  assert.equal(store.get(quote.id)?.commit_receipt, undefined);
});

// ---------------------------------------------------------------------------
// 26.16 — Confirmed pre-effect rejection => CONFIRMED_NON_EXECUTION
// (PR-7 review L3: status 400 alone is NOT evidence — only a 400
// carrying a specifically allowlisted pre-effect validation
// api_error_code qualifies; payment-stage and unknown/missing codes
// fail closed to INDETERMINATE, tests 26.16b/26.16c.)
// ---------------------------------------------------------------------------

test("Test 26.16: a 400 carrying an allowlisted pre-effect validation code (param_wrong_value) records CONFIRMED_NON_EXECUTION and leaves provider state untouched", async () => {
  // DISCLOSED CHANGE (PR-7 review L3): this test previously mocked a
  // bare HTTP 400 with the generic api_error_code "invalid_request"
  // and asserted CONFIRMED_NON_EXECUTION — i.e. it encoded the rule
  // L3 rejects (status code alone as proof of non-execution). The
  // mocked error now carries `param_wrong_value`, one of the narrow
  // documented request-validation codes on the adapter's allowlist:
  // Chargebee's error-handling documentation groups it under
  // Invalid Request Errors (type invalid_request, HTTP 400) — a
  // parameter value that does not meet its required specification,
  // rejected while validating the request, before the operation is
  // processed. The generic `invalid_request` code is deliberately
  // NOT allowlisted (Chargebee documents it as a generic code whose
  // handling is recommended only in combination with `param`), and
  // a 400 with that code now classifies INDETERMINATE like any
  // other non-allowlisted code. Scenario and all outcome/retry
  // assertions are otherwise unchanged.
  const { adapter, mock, store, dispatches } = makeAdapter({}, {
    wrap: (mock) => async (req) => {
      if (req.method === "POST" && req.url.includes("/update_for_items")) {
        return { status: 400, headers: {}, json: { type: "invalid_request", api_error_code: "param_wrong_value", message: "subscription_items[item_price_id][0] : value does not meet the required specification", http_status_code: 400 } };
      }
      return mock.transport(req);
    },
  });
  const quote = await adapter.createChangeQuote(SUB, PROPOSAL(21));
  await assert.rejects(
    () => adapter.commitChangeQuote(quote.id),
    (e: unknown) => e instanceof SCQError && (e.details as any)?.outcome === "CONFIRMED_NON_EXECUTION",
  );
  assert.equal(store.get(quote.id)?.commit_outcome?.outcome, "CONFIRMED_NON_EXECUTION");
  assert.equal(store.get(quote.id)?.commit_receipt, undefined);
  assert.equal(mock.mutationCount, 0);
  assert.equal(updateDispatches(dispatches).length, 1);
  const snap = await adapter.getSubscription(SUB);
  assert.equal(snap.items.find((i) => i.id === ADDON)?.quantity, 1, "provider state is untouched");
  // Positive control for the L2/L3 line: a demonstrable pre-effect
  // rejection does NOT block a later attempt — the retry guard is
  // reserved for INDETERMINATE outcomes. A second attempt dispatches
  // again (and is again refused pre-effect by the provider).
  await assert.rejects(
    () => adapter.commitChangeQuote(quote.id),
    (e: unknown) => e instanceof SCQError && (e.details as any)?.outcome === "CONFIRMED_NON_EXECUTION",
  );
  assert.equal(updateDispatches(dispatches).length, 2, "a confirmed non-execution leaves a later attempt unblocked");
  assert.equal(mock.mutationCount, 0);
});

test("Test 26.16b: a payment-stage HTTP 400 (payment_processing_failed) is INDETERMINATE (PR-7 review L3) — a payment failure does not prove rejection before any subscription or financial effect", async () => {
  // Chargebee's error-handling documentation assigns HTTP 400 to
  // payment errors (type `payment`) as well as to validation
  // errors: payment_processing_failed is returned when payment
  // collection fails DURING the operation. By then the provider
  // may already have applied subscription changes or ancillary
  // financial effects, so status 400 + a payment code establishes
  // neither pre-effect rejection nor non-execution. The outcome
  // fails closed: INDETERMINATE, outcome recorded, no receipt, and
  // the recorded outcome blocks any blind re-dispatch.
  const { adapter, mock, store, dispatches } = makeAdapter({}, {
    wrap: (mock) => async (req) => {
      if (req.method === "POST" && req.url.includes("/update_for_items")) {
        return { status: 400, headers: {}, json: { type: "payment", api_error_code: "payment_processing_failed", message: "Subscription cannot be updated as the payment collection failed. Gateway Error: Card declined.", http_status_code: 400 } };
      }
      return mock.transport(req);
    },
  });
  const quote = await adapter.createChangeQuote(SUB, PROPOSAL(21));
  await assert.rejects(
    () => adapter.commitChangeQuote(quote.id),
    (e: unknown) => e instanceof SCQError && e.code === "PROVIDER_ERROR" && (e.details as any)?.outcome === "INDETERMINATE"
      && (e.details as any)?.observedIntendedSetInEffect === false,
  );
  assert.equal(store.get(quote.id)?.commit_outcome?.outcome, "INDETERMINATE", "NOT confirmed non-execution — a payment-stage 400 may follow partial provider-side effects");
  assert.equal(store.get(quote.id)?.commit_receipt, undefined);
  assert.equal(mock.mutationCount, 0);
  await assert.rejects(
    () => adapter.commitChangeQuote(quote.id),
    (e: unknown) => e instanceof SCQError && (e.details as any)?.outcome === "INDETERMINATE",
  );
  assert.equal(updateDispatches(dispatches).length, 1, "no blind retry after an ambiguous payment-stage 400");
});

test("Test 26.16c: an HTTP 400 with a MISSING api_error_code is INDETERMINATE (PR-7 review L3) — an unidentified 400 fails closed", async () => {
  // Without a specifically recognized api_error_code there is no
  // documented basis for placing the failure at the validation
  // stage: the same bare 400 shape is used for payment and
  // operation-stage failures. Unknown or missing codes therefore
  // fail closed to INDETERMINATE with the no-blind-retry guard,
  // exactly like the 408/429 ambiguities of review L2.
  const { adapter, mock, store, dispatches } = makeAdapter({}, {
    wrap: (mock) => async (req) => {
      if (req.method === "POST" && req.url.includes("/update_for_items")) {
        return { status: 400, headers: {}, json: { message: "bad request", http_status_code: 400 } };
      }
      return mock.transport(req);
    },
  });
  const quote = await adapter.createChangeQuote(SUB, PROPOSAL(21));
  await assert.rejects(
    () => adapter.commitChangeQuote(quote.id),
    (e: unknown) => e instanceof SCQError && e.code === "PROVIDER_ERROR" && (e.details as any)?.outcome === "INDETERMINATE",
  );
  assert.equal(store.get(quote.id)?.commit_outcome?.outcome, "INDETERMINATE", "NOT confirmed non-execution — a missing api_error_code cannot establish a pre-effect validation rejection");
  assert.equal(store.get(quote.id)?.commit_receipt, undefined);
  assert.equal(mock.mutationCount, 0);
  await assert.rejects(
    () => adapter.commitChangeQuote(quote.id),
    (e: unknown) => e instanceof SCQError && (e.details as any)?.outcome === "INDETERMINATE",
  );
  assert.equal(updateDispatches(dispatches).length, 1, "no blind retry after an unidentified 400");
});

// ---------------------------------------------------------------------------
// 26.17 — §6.10 replay vs later verification
// ---------------------------------------------------------------------------

test("Test 26.17: §6.10 — replay always returns the ORIGINAL receipt, while a later independent verification transitions the current view to verified", async () => {
  let failReads = false;
  const { adapter, mock, store, client } = makeAdapter({}, {
    wrap: (mock) => async (req) => {
      if (failReads && req.method === "GET") throw new Error("read path down");
      const res = await mock.transport(req);
      if (req.method === "POST" && req.url.includes("/update_for_items")) failReads = true; // reads die right after the mutation lands
      return res;
    },
  });
  const quote = await adapter.createChangeQuote(SUB, PROPOSAL(21));
  const receipt = await adapter.commitChangeQuote(quote.id);
  // The mutation response was received (landing known) but the
  // independent re-read failed. Following the merged PR #10/#11
  // candidate construction, the response's figures are PRESENT in
  // the committed effect — so a later verification has a record to
  // verify against — but labeled unestablished: UNKNOWN determinacy
  // on both dimensions and committedSource "unestablished". The
  // receipt is honestly unverified; nothing about the figures'
  // presence upgrades them.
  assert.equal(receipt.status, "COMMITTED_UNVERIFIED");
  assert.equal(receipt.reconciliation.status, "UNVERIFIED");
  assert.equal(receipt.committedEffect.immediate?.net, 20000, "the response's candidate immediate, present but unestablished");
  assert.equal(receipt.committedEffect.recurring?.resultingAmount, 80900, "the response's candidate recurring, present but unestablished");
  assert.deepEqual(receipt.committedEffect.determinacy, { immediateFinancialEffect: "UNKNOWN", recurringFinancialEffect: "UNKNOWN" });
  assert.equal(receipt.committedEffect.provenance?.committedSource, "unestablished");

  const replay1 = await adapter.commitChangeQuote(quote.id);
  assert.deepEqual(replay1, receipt, "§6.10: replay returns the recorded receipt while it is the only one on file");
  assert.equal(mock.mutationCount, 1);

  // The read path recovers. Independent verification from
  // provider-side records: the recorded mutation response (retained
  // by the transport) for the incurred actual, and a fresh
  // authoritative read for state + recurring.
  failReads = false;
  const updateJson = mock.lastUpdateJson as any;
  const incurred = (updateJson.unbilled_charges as { amount: number }[]).reduce((s, c) => s + c.amount, 0);
  const rawAfter = await client.getSubscription(SUB);
  const itemsAfter = ((rawAfter.json.subscription as any).subscription_items ?? []) as { item_price_id: string; amount: number }[];
  const recurringActual = itemsAfter.reduce((s, i) => s + i.amount, 0);
  assert.equal(incurred, 20000);
  assert.equal(recurringActual, 80900);
  const snapshot = await adapter.getSubscription(SUB);
  const stored = store.get(quote.id)!;
  const evidence = establishVerification(stored, {
    subscriptionRef: SUB,
    committedEffect: {
      immediate: { net: incurred },
      recurring: { resultingAmount: recurringActual, currency: "USD" },
      determinacy: { immediateFinancialEffect: "DETERMINED", recurringFinancialEffect: "DETERMINED" },
      provenance: {
        immediate: "independent post-commit record: the retained mutation response's unbilled_charges sum (mocked provider record)",
        recurring: "independent post-commit GET: sum of the subscription items' stated amounts (mocked provider read)",
        committedSource: "provider_actual",
      },
    },
    resultingSnapshot: snapshot,
    source: "test26: independent post-commit reads through the mocked provider's records",
  });
  const verified = store.verifyCommitReceipt(quote.id, evidence);
  assert.equal(verified.status, "COMMITTED", "the current view transitions once the identity figures match the recorded candidates");
  assert.equal(verified.outcome, "COMMITTED_AND_VERIFIED");
  assert.equal(verified.reconciliation.status, "OK");

  const replay2 = await adapter.commitChangeQuote(quote.id);
  assert.deepEqual(replay2, receipt, "§6.10: replay STILL returns the ORIGINAL unverified receipt, not the transitioned view");
  assert.equal(store.get(quote.id)?.commit_receipt?.status, "COMMITTED", "the store's current view is the verified one");
  assert.equal(mock.mutationCount, 1, "verification never re-mutates");
});

// ---------------------------------------------------------------------------
// 26.18 — Missing durable ledger after restart (honest handling)
// ---------------------------------------------------------------------------

test("Test 26.18: after a process restart the in-memory ledger is gone — the adapter says so (QUOTE_STALE restart path), fabricates no recovery, and never re-mutates on the strength of a vanished record", async () => {
  const store1 = new QuoteStore();
  const first = makeAdapter({}, { store: store1 });
  const quote = await first.adapter.createChangeQuote(SUB, PROPOSAL(21));
  const receipt = await first.adapter.commitChangeQuote(quote.id);
  assert.equal(receipt.status, "COMMITTED");
  assert.equal(first.mock.mutationCount, 1);

  // Restart: a new store (and adapter) over the SAME provider state.
  const store2 = new QuoteStore();
  const second = makeAdapter({}, { store: store2, wrap: () => first.mock.transport });
  assert.equal(store2.get(quote.id), undefined, "the quote, its receipt, and any outcome record are volatile — nothing is recovered because nothing was persisted");
  await assert.rejects(
    () => second.adapter.commitChangeQuote(quote.id),
    (e: unknown) => e instanceof SCQError && e.code === "QUOTE_STALE" && /restarted/.test(e.message),
  );
  assert.equal(first.mock.mutationCount, 1, "no re-mutation: a stale-quote refusal, not a second commit");
  // Reads are unaffected by the lost ledger.
  const snap = await second.adapter.getSubscription(SUB);
  assert.equal(snap.items.find((i) => i.id === ADDON)?.quantity, 21);
});

// ---------------------------------------------------------------------------
// 26.19 — Production / test-site mutation dispatch prohibited by default
// ---------------------------------------------------------------------------

test("Test 26.19a: the live-commit gate stays closed by default — adapter constructed without the flag refuses before any dispatch", async () => {
  const { adapter, store, dispatches } = makeAdapter({}, { commitEnabled: false });
  const quote = await adapter.createChangeQuote(SUB, PROPOSAL(21));
  await assert.rejects(
    () => adapter.commitChangeQuote(quote.id),
    (e: unknown) => e instanceof SCQError && (e.details as any)?.blocked === "LIVE_COMMIT_DISABLED",
  );
  assert.equal(updateDispatches(dispatches).length, 0);
  assert.equal(store.get(quote.id)?.commit_receipt, undefined);
});

test("Test 26.19b: the environment gate defaults to disabled for every value except the exact opt-in (which this suite never sets)", () => {
  const gate = (env: Record<string, string>) => {
    const st = chargebeeConfigFromEnv(env);
    assert.equal(st.ok, true);
    return st.ok ? st.liveCommitEnabled : undefined;
  };
  assert.equal(gate({ CHARGEBEE_SITE: "x-test", CHARGEBEE_API_KEY: "k" }), false);
  assert.equal(gate({ CHARGEBEE_SITE: "x-test", CHARGEBEE_API_KEY: "k", SCQ_LIVE_COMMIT_ENABLED: "yes" }), false);
  assert.equal(gate({ CHARGEBEE_SITE: "x-test", CHARGEBEE_API_KEY: "k", SCQ_LIVE_COMMIT_ENABLED: "TRUE" }), false);
  assert.equal(gate({ CHARGEBEE_SITE: "x-test", CHARGEBEE_API_KEY: "k", SCQ_LIVE_COMMIT_ENABLED: "1" }), false);
});

test("Test 26.19c: the pilot live-guard still refuses a mutating operation pre-dispatch (safeguard unmodified by this migration)", async () => {
  let innerInvocations = 0;
  const inner: HttpTransport = async () => {
    innerInvocations++;
    return { status: 200, headers: {}, json: {} };
  };
  const guarded = createGuardedLiveTransport(inner);
  await assert.rejects(
    () =>
      guarded.transport({
        method: "POST",
        url: "https://pilot-test.chargebee.com/api/v2/subscriptions/pilot-sub-001/update_for_items",
        headers: {},
        body: "subscription_items[item_price_id][0]=x",
      }),
    (e: unknown) => e instanceof ChargebeeOperationNotAllowedError,
  );
  assert.equal(innerInvocations, 0, "the guard refuses before the inner transport is invoked");
  assert.equal(guarded.log.at(-1)?.dispatched, false);
});

// ---------------------------------------------------------------------------
// 26.20 — Pilot read/estimate behavior unchanged
// ---------------------------------------------------------------------------

test("Test 26.20: the pilot harness report is unchanged in behavior — mocked read + estimate SIMULATED_PASS, live commit BLOCKED, zero mutating calls, no LIVE_PASS anywhere", async () => {
  const report = await runPilot({ mode: "mocked" });
  assert.ok(report.steps.every((s) => s.status === "pass"), JSON.stringify(report.steps));
  assert.equal(report.quote?.immediateNet, 20000);
  assert.equal(report.quote?.recurringResulting, 80900);
  assert.equal(report.quote?.recurringPrevious, 60900);
  assert.equal(report.transport.mutatingCalls, 0);
  assert.equal(report.transportOrigin, "mocked");
  assert.ok(report.capabilities.every((c) => c.classification !== "LIVE_PASS"), "mocked evidence is never relabeled live");
  assert.equal(report.capabilities.find((c) => c.capability === "live commit")?.classification, "BLOCKED");
});

// ---------------------------------------------------------------------------
// 26.21 — Zero-real-mutation transport audit
// ---------------------------------------------------------------------------

test("Test 26.21: transport audit — every dispatch in a full quote+commit+replay flow is accounted for by the injected mocked transport; the single mutating dispatch was served by the mock", async () => {
  const { adapter, mock, dispatches } = makeAdapter();
  const quote = await adapter.createChangeQuote(SUB, PROPOSAL(21));
  const receipt = await adapter.commitChangeQuote(quote.id);
  assert.equal(receipt.status, "COMMITTED");
  await adapter.commitChangeQuote(quote.id); // §6.10 replay — no dispatch at all
  // Accounting identity: every audited dispatch reached the mocked
  // transport exactly once, and vice versa. No dispatch escaped to
  // any other transport — the client was constructed with ONLY this
  // injected transport, so there is no real-network path in the flow.
  assert.equal(dispatches.length, mock.calls.length, "audited dispatches == mocked-transport calls");
  assert.equal(updateDispatches(dispatches).length, 1, "exactly one mutating dispatch in the whole flow");
  assert.equal(mock.mutationCount, 1);
  assert.ok(dispatches.every((d) => d.path.startsWith("/api/v2/")), "all dispatches are Chargebee API paths on the configured (mocked) site base");
  assert.deepEqual(
    dispatches.map((d) => d.operation),
    ["retrieve_subscription", "get_item_price", "get_item_price", "estimate_update_for_items", "retrieve_subscription", "estimate_update_for_items", "get_item_price", "get_item_price", "update_for_items", "retrieve_subscription"],
    "the flow's full operation sequence: quote (read, price metadata, estimate), validation read, revalidation (estimate + price metadata), ONE mutation, one verification re-read",
  );
});

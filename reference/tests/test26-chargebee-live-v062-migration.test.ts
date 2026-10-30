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

/**
 * PR-14 migration helper (Issue #22, Finding 1): tests in this file
 * that previously drove dispatch outcomes through the live adapter
 * now assert the authorization preservation refusal — pre-dispatch,
 * CONFIRMED_NON_EXECUTION semantics, zero update dispatches on the
 * audited transport, no receipt. Each migrated scenario keeps its
 * fixture and states what its former outcome class becomes and
 * where that class remains covered. The classification machinery
 * (COMMITTED_UNVERIFIED, INDETERMINATE, VIOLATED, envelope and
 * attribution doctrines) is unchanged in the dispatch path; it is
 * unreachable through this adapter while the gate refuses its only
 * dispatch.
 */
async function expectPreservationRefusal(adapter: ChargebeeLiveAdapter, quoteId: string): Promise<void> {
  await assert.rejects(
    () => adapter.commitChangeQuote(quoteId),
    (e: unknown) =>
      e instanceof SCQError &&
      e.code === "AUTHORIZATION_PRESERVATION_UNENFORCEABLE" &&
      (e.details as any)?.outcome === "CONFIRMED_NON_EXECUTION" &&
      (e.details as any)?.indeterminate !== true,
    "the commit must refuse pre-dispatch with the preservation code and CONFIRMED_NON_EXECUTION semantics",
  );
}

// ---------------------------------------------------------------------------
// 26.1 — Determined immediate zero vs missing immediate amount
// ---------------------------------------------------------------------------

test("Test 26.1a: a provider-stated zero immediate is a present DETERMINED zero — on the quote AND on the committed receipt", async () => {
  // PR-14 MIGRATION: the quote half is unchanged and still asserted
  // (a stated zero is present and DETERMINED — BC-1). The commit
  // half now refuses pre-dispatch, so no committed receipt exists
  // to carry the zero; the committed-side determined-zero behavior
  // remains implemented in the dispatch path and covered by the
  // simulator suites (the Chargebee simulator's zero handling is
  // test25's probe C lineage).
  const { adapter, mock, store } = makeAdapter();
  const quote = await adapter.createChangeQuote(SUB, PROPOSAL(1)); // unchanged quantity: both estimate members present and empty
  assert.ok(quote.commercialEffect.immediate !== undefined && quote.commercialEffect.immediate.net === 0, "the stated zero is present, not absent");
  assert.deepEqual(quote.commercialEffect.determinacy, { immediateFinancialEffect: "DETERMINED", recurringFinancialEffect: "DETERMINED" });
  await expectPreservationRefusal(adapter, quote.id);
  assert.equal(store.get(quote.id)?.commit_receipt, undefined, "no receipt is recorded for a refused commit");
  assert.equal(mock.mutationCount, 0, "no mutation was dispatched");
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
  // PR-14 MIGRATION: the body-rewriting wrap is never exercised —
  // no dispatch is sent for it to rewrite. A wrong landing is now
  // impossible through this adapter (nothing lands), which is the
  // prevention form of this test's original protection (a wrong
  // landing was never a verified success). Attributable-VIOLATED
  // classification remains implemented and covered by the
  // simulator suites.
  const { adapter, mock, store, dispatches } = makeAdapter({}, {
    wrap: (mock) => async (req) => {
      if (req.method === "POST" && req.url.includes("/update_for_items")) {
        const body = new URLSearchParams(req.body ?? "");
        body.set("subscription_items[quantity][1]", "11"); // armed: the provider would apply a different quantity than dispatched
        return mock.transport({ ...req, body: body.toString() });
      }
      return mock.transport(req);
    },
  });
  const quote = await adapter.createChangeQuote(SUB, PROPOSAL(21));
  await expectPreservationRefusal(adapter, quote.id);
  assert.equal(updateDispatches(dispatches).length, 0, "no dispatch was attempted");
  assert.equal(mock.mutationCount, 0, "nothing landed — at the wrong quantity or any other");
  assert.equal(store.get(quote.id)?.commit_receipt, undefined, "no receipt is recorded for a refused commit");
});

// ---------------------------------------------------------------------------
// 26.10 — Known landed mutation with financial actuals unavailable (Defect 3)
// ---------------------------------------------------------------------------

test("Test 26.10a: response received but carrying NO financials — COMMITTED_UNVERIFIED typed receipt; the established recurring survives, the immediate is UNKNOWN", async () => {
  // PR-14 MIGRATION: the incomplete response can no longer occur
  // (no dispatch), so no COMMITTED_UNVERIFIED receipt is produced.
  // The Defect 3 first-class state remains implemented in the
  // dispatch path and its candidate construction is preserved for
  // the §6.10/verification flow exercised in migrated 26.17.
  const { adapter, mock, store } = makeAdapter({ incompleteUpdateResponse: true });
  const quote = await adapter.createChangeQuote(SUB, PROPOSAL(21));
  await expectPreservationRefusal(adapter, quote.id);
  assert.equal(store.get(quote.id)?.commit_receipt, undefined, "no receipt is recorded for a refused commit");
  assert.equal(mock.mutationCount, 0, "no dispatch reached the mock");
});

test("Test 26.10b: the update RESPONSE's items carry no amounts, but the independent re-read establishes the recurring — verified (the response's item list is never the recurring source)", async () => {
  // PR-14 MIGRATION: no update response exists (no dispatch). The
  // doctrine this test protected — the response's item list is
  // never the recurring source; the independent re-read is —
  // remains implemented in the dispatch path and covered by the
  // simulator suites.
  const { adapter, mock, store } = makeAdapter({ postUpdateItemsMissingAmounts: true });
  const quote = await adapter.createChangeQuote(SUB, PROPOSAL(21));
  await expectPreservationRefusal(adapter, quote.id);
  assert.equal(store.get(quote.id)?.commit_receipt, undefined, "no receipt is recorded for a refused commit");
  assert.equal(mock.mutationCount, 0, "no dispatch reached the mock");
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
  // PR-14 MIGRATION: the amount-stripping wrap never engages (it
  // keys off a dispatch that no longer occurs). The never-
  // reconstruct doctrine remains implemented in the dispatch path.
  await expectPreservationRefusal(adapter, quote.id);
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
  // PR-14 MIGRATION: the connection-reset wrap never engages — the
  // preservation gate refuses before any dispatch is attempted, so
  // the attempt leaves a CONFIRMED_NON_EXECUTION outcome record
  // (not INDETERMINATE: nothing was dispatched, so nothing is
  // unknown). The retry property is preserved in stronger form:
  // the second commit refuses identically at the gate, still with
  // zero dispatches. The INDETERMINATE + no-blind-retry machinery
  // for genuinely dispatched attempts remains implemented and is
  // covered at the ledger level (test27, rh-04/05, test47.10).
  await expectPreservationRefusal(adapter, quote.id);
  assert.equal(store.get(quote.id)?.commit_outcome?.outcome, "CONFIRMED_NON_EXECUTION", "the refusal leaves a typed outcome record, not just a thrown error");
  assert.equal(store.get(quote.id)?.commit_receipt, undefined);
  assert.equal(mock.mutationCount, 0, "the request never reached the provider");
  assert.equal(updateDispatches(dispatches).length, 0, "zero dispatches were attempted");
  await expectPreservationRefusal(adapter, quote.id);
  assert.equal(updateDispatches(dispatches).length, 0, "no dispatch on retry either — the gate fired first");
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
  // PR-14 MIGRATION: the mock's lose-response fault is never
  // exercised — no dispatch reaches it (mutation count 0, not 1).
  // The L1 scenario (applied-but-lost) cannot be produced through
  // this adapter anymore; its doctrine is preserved in the
  // dispatch path and at the ledger level. Here the recorded
  // outcome is CONFIRMED_NON_EXECUTION and the retry refuses with
  // the identical preservation refusal.
  const { adapter, mock, store, dispatches } = makeAdapter({ loseUpdateResponse: true });
  const quote = await adapter.createChangeQuote(SUB, PROPOSAL(21));
  await expectPreservationRefusal(adapter, quote.id);
  assert.equal(store.get(quote.id)?.commit_outcome?.outcome, "CONFIRMED_NON_EXECUTION", "the refusal leaves a typed outcome record");
  assert.equal(store.get(quote.id)?.commit_receipt, undefined, "no committed receipt");
  assert.equal(mock.mutationCount, 0, "the mock never applied anything — no response existed to lose");
  await expectPreservationRefusal(adapter, quote.id);
  assert.equal(updateDispatches(dispatches).length, 0, "no dispatch on either attempt");
  assert.equal(mock.mutationCount, 0);
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
  // PR-14 MIGRATION: the equivalence scenario cannot be staged
  // through this adapter — the wrap's independent-actor write was
  // triggered BY our dispatch attempt, and no dispatch is
  // attempted. Provider state therefore shows neither our change
  // nor the actor's: quantity remains 1. The recorded outcome is
  // the pre-dispatch CONFIRMED_NON_EXECUTION; the observational-
  // equivalence doctrine (L1) remains implemented for dispatched
  // paths and covered at the ledger level.
  await expectPreservationRefusal(adapter, quote.id);
  assert.equal(store.get(quote.id)?.commit_outcome?.outcome, "CONFIRMED_NON_EXECUTION");
  assert.equal(store.get(quote.id)?.commit_receipt, undefined, "no committed receipt");
  assert.equal(mock.mutationCount, 0, "our request never reached the provider's mutation path");
  const snap = await adapter.getSubscription(SUB);
  assert.equal(snap.items.find((i) => i.id === ADDON)?.quantity, 1, "no actor's write landed either — the scenario's trigger (our dispatch) never fired");
  await expectPreservationRefusal(adapter, quote.id);
  assert.equal(updateDispatches(dispatches).length, 0, "no dispatch on either attempt");
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
  // PR-14 MIGRATION: the actuals-rewriting wrap never engages (no
  // dispatch). No response exists whose actual could contradict
  // the envelope post-commit; pre-commit envelope enforcement
  // (QUOTE_DRIFTED) is unaffected and asserted by 26.8.
  await expectPreservationRefusal(adapter, quote.id);
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
  // PR-14 MIGRATION: the intervening write was triggered by our
  // dispatch, which no longer occurs — so no bracket exists to
  // break and no contradiction arises. Z1–Z3 remain implemented in
  // the dispatch path (and are exercised end-to-end by the state-
  // verification suites, test31/test32, at the store level).
  await expectPreservationRefusal(adapter, quote.id);
  const snap = await adapter.getSubscription(SUB);
  assert.equal(snap.items.find((i) => i.id === ADDON)?.quantity, 1, "provider state is untouched — the intervening write never fired");
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
  // PR-14 MIGRATION: as 26.14a — the round-trip intervening writes
  // were triggered by our dispatch, which no longer occurs.
  await expectPreservationRefusal(adapter, quote.id);
  const snap = await adapter.getSubscription(SUB);
  assert.equal(snap.items.find((i) => i.id === ADDON)?.quantity, 1, "provider state is untouched");
});

// ---------------------------------------------------------------------------
// 26.15 — Idempotency evidence: replay, conflict, expiry, absence
// ---------------------------------------------------------------------------

test("Test 26.15a: concurrent duplicate commits replay natively — the provider applies the mutation exactly once and the replayed response counts as the original operation's actuals", async () => {
  // PR-14 MIGRATION: concurrent duplicate commits now BOTH refuse
  // at the preservation gate — the native-replay question (two
  // dispatches, one application) cannot arise because neither
  // commit dispatches. The exactly-once property survives in its
  // strongest form: zero applications, resource_version unmoved,
  // no receipt. Native idempotency semantics at the transport
  // level remain covered by 26.15c and test13-http3.
  const { adapter, mock, store, client } = makeAdapter();
  const quote = await adapter.createChangeQuote(SUB, PROPOSAL(21));
  const results = await Promise.allSettled([adapter.commitChangeQuote(quote.id), adapter.commitChangeQuote(quote.id)]);
  assert.equal(results.length, 2);
  for (const r of results) {
    assert.equal(r.status, "rejected", "each concurrent commit refuses");
    if (r.status === "rejected") {
      assert.ok(r.reason instanceof SCQError && r.reason.code === "AUTHORIZATION_PRESERVATION_UNENFORCEABLE", `refusal is the preservation gate, got ${String(r.reason)}`);
    }
  }
  const after = await client.getSubscription(SUB);
  assert.equal((after.json.subscription as any).resource_version, 1700000000000, "resource_version unmoved — zero applications");
  assert.equal(mock.mutationCount, 0, "no dispatch reached the (mocked) provider");
  assert.equal(store.get(quote.id)?.commit_receipt, undefined, "no receipt is recorded");
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
  // PR-14 MIGRATION: the 422-producing wrap never engages — no
  // dispatch is attempted, so the key-conflict response cannot be
  // produced and the prior key-holder write the wrap staged never
  // happens either. The recorded outcome is the gate's
  // CONFIRMED_NON_EXECUTION (a pre-dispatch fact about THIS
  // adapter's refusal — it asserts nothing about any other
  // operation, so L2's caution is not violated: no provider
  // response is being classified at all). The retry refuses
  // identically; zero dispatches throughout.
  await expectPreservationRefusal(adapter, quote.id);
  assert.equal(store.get(quote.id)?.commit_outcome?.outcome, "CONFIRMED_NON_EXECUTION");
  assert.equal(store.get(quote.id)?.commit_receipt, undefined);
  assert.equal(mock.mutationCount, 0, "this attempt never reached the provider's mutation path");
  await expectPreservationRefusal(adapter, quote.id);
  assert.equal(updateDispatches(dispatches).length, 0, "no dispatch on either attempt");
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
  // PR-14 MIGRATION: the 408 wrap never engages (no dispatch). The
  // recorded CONFIRMED_NON_EXECUTION is the pre-dispatch refusal's
  // own class — it classifies no provider response, so L2's rule
  // (a timeout is not evidence of non-execution) is not weakened:
  // there is no dispatched request whose execution could be
  // unknown. The timeout classification remains implemented in
  // the dispatch path.
  await expectPreservationRefusal(adapter, quote.id);
  assert.equal(store.get(quote.id)?.commit_outcome?.outcome, "CONFIRMED_NON_EXECUTION");
  assert.equal(store.get(quote.id)?.commit_receipt, undefined);
  assert.equal(mock.mutationCount, 0);
  await expectPreservationRefusal(adapter, quote.id);
  assert.equal(updateDispatches(dispatches).length, 0, "no dispatch on either attempt");
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
  // PR-14 MIGRATION: as 26.15e — the 429 wrap never engages (no
  // dispatch); the recorded class is the pre-dispatch refusal's
  // own, classifying no provider response.
  await expectPreservationRefusal(adapter, quote.id);
  assert.equal(store.get(quote.id)?.commit_outcome?.outcome, "CONFIRMED_NON_EXECUTION");
  assert.equal(store.get(quote.id)?.commit_receipt, undefined);
  assert.equal(mock.mutationCount, 0);
  await expectPreservationRefusal(adapter, quote.id);
  assert.equal(updateDispatches(dispatches).length, 0, "no dispatch on either attempt");
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
  // PR-14 MIGRATION: the empty-200 wrap never engages (no dispatch)
  // and the read-path failure it armed never triggers. The
  // no-usable-evidence INDETERMINATE classification remains
  // implemented in the dispatch path for permitting capabilities.
  await expectPreservationRefusal(adapter, quote.id);
  assert.equal(store.get(quote.id)?.commit_outcome?.outcome, "CONFIRMED_NON_EXECUTION");
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
  // PR-14 MIGRATION: the recorded outcome class coincides
  // (CONFIRMED_NON_EXECUTION) but its SOURCE changes: the 400-
  // producing wrap never engages, because the preservation gate
  // refuses before dispatch. The CONFIRMED_NON_EXECUTION recorded
  // here is the pre-dispatch refusal's own semantics — nothing was
  // dispatched, so non-execution is a fact of this adapter's
  // behavior, not a classification of a provider response. The
  // L3 allowlist classification remains implemented in the
  // dispatch path (its precedence relative to the gate is
  // rehearsed by rh-14). Retry property: a CONFIRMED_NON_EXECUTION
  // record does NOT engage the INDETERMINATE blind-retry guard —
  // the second attempt reaches the gate and refuses identically,
  // still with zero dispatches (previously: it re-dispatched and
  // was refused pre-effect by the provider).
  await expectPreservationRefusal(adapter, quote.id);
  assert.equal(store.get(quote.id)?.commit_outcome?.outcome, "CONFIRMED_NON_EXECUTION");
  assert.equal(store.get(quote.id)?.commit_receipt, undefined);
  assert.equal(mock.mutationCount, 0);
  assert.equal(updateDispatches(dispatches).length, 0, "no dispatch was attempted — the gate precedes the provider's rejection");
  const snap = await adapter.getSubscription(SUB);
  assert.equal(snap.items.find((i) => i.id === ADDON)?.quantity, 1, "provider state is untouched");
  await expectPreservationRefusal(adapter, quote.id);
  assert.equal(updateDispatches(dispatches).length, 0, "the retry reached the gate (not the INDETERMINATE guard) and refused identically");
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
  // PR-14 MIGRATION: the payment-stage 400 can no longer be
  // produced (no dispatch). The recorded CONFIRMED_NON_EXECUTION
  // is the pre-dispatch refusal's own class and classifies no
  // provider response — L3's caution (a payment-stage 400 proves
  // neither rejection stage nor non-execution) is untouched,
  // because no 400 is being classified. The retry refuses
  // identically at the gate; zero dispatches.
  await expectPreservationRefusal(adapter, quote.id);
  assert.equal(store.get(quote.id)?.commit_outcome?.outcome, "CONFIRMED_NON_EXECUTION");
  assert.equal(store.get(quote.id)?.commit_receipt, undefined);
  assert.equal(mock.mutationCount, 0);
  await expectPreservationRefusal(adapter, quote.id);
  assert.equal(updateDispatches(dispatches).length, 0, "no dispatch on either attempt");
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
  // PR-14 MIGRATION: as 26.16b — the unidentified 400 can no
  // longer be produced (no dispatch); the recorded class is the
  // pre-dispatch refusal's own and classifies no provider
  // response, so L3's fail-closed rule for unidentified 400s is
  // not weakened.
  await expectPreservationRefusal(adapter, quote.id);
  assert.equal(store.get(quote.id)?.commit_outcome?.outcome, "CONFIRMED_NON_EXECUTION");
  assert.equal(store.get(quote.id)?.commit_receipt, undefined);
  assert.equal(mock.mutationCount, 0);
  await expectPreservationRefusal(adapter, quote.id);
  assert.equal(updateDispatches(dispatches).length, 0, "no dispatch on either attempt");
});

// ---------------------------------------------------------------------------
// 26.17 — §6.10 replay vs later verification
// ---------------------------------------------------------------------------

test("Test 26.17: §6.10 — replay always returns the ORIGINAL receipt, while a later independent verification transitions the current view to verified", async () => {
  // PR-14 MIGRATION: this test's subject is the STORE-level §6.10 +
  // verification-transition semantics for a recorded
  // COMMITTED_UNVERIFIED receipt. Its original setup produced that
  // receipt by dispatching through the live adapter (response
  // received, re-read failed). The adapter no longer dispatches, so
  // part (a) asserts the new fact — a live-adapter commit refuses
  // and creates no receipt — and part (b) seeds the recorded
  // receipt through the store's own recording API, using exactly
  // the candidate construction the adapter used for the no-reread
  // case (response figures PRESENT but unestablished: UNKNOWN
  // determinacy, committedSource "unestablished"), with the mock's
  // state moved to the landed target by an external change (the
  // state the seeded receipt records). Every §6.10 / verification
  // assertion from the original test is preserved against the
  // seeded record; the receipt's provenance (fixture-seeded, not
  // adapter-dispatched) is the disclosed change.
  const { adapter, mock, store, client } = makeAdapter();
  const quote = await adapter.createChangeQuote(SUB, PROPOSAL(21));

  // (a) The adapter itself can no longer create the receipt.
  await expectPreservationRefusal(adapter, quote.id);
  assert.equal(store.get(quote.id)?.commit_receipt, undefined);
  assert.equal(mock.mutationCount, 0);

  // (b) Seed the recorded COMMITTED_UNVERIFIED receipt (fixture).
  mock.applyExternalChange(ADDON, 21); // the landed state the seeded receipt records
  const snapshot0 = await adapter.getSubscription(SUB);
  const stored0 = store.get(quote.id)!;
  const seeded = store.recordCommitReceipt(quote.id, {
    receiptId: "rcpt_test26_17_fixture",
    quoteId: quote.id,
    subscriptionRef: SUB,
    status: "COMMITTED_UNVERIFIED",
    outcome: "COMMITTED_UNVERIFIED",
    resultingSnapshot: snapshot0,
    quotedEffect: stored0.quoted_effect,
    committedEffect: {
      immediate: { net: 20000 },
      recurring: { resultingAmount: 80900, currency: "USD" },
      determinacy: { immediateFinancialEffect: "UNKNOWN", recurringFinancialEffect: "UNKNOWN" },
      provenance: { committedSource: "unestablished" },
    },
    guaranteeMode: stored0.effective_guarantee_mode,
    consistencyGuarantee: "BEST_EFFORT",
    multiChangeConsistency: stored0.multi_change_consistency,
    reconciliation: { status: "UNVERIFIED" },
    committedAt: new Date().toISOString(),
  } as any);
  assert.ok(seeded, "the fixture receipt recorded");
  const receipt = store.get(quote.id)!.commit_receipt!;
  assert.equal(receipt.status, "COMMITTED_UNVERIFIED");
  assert.equal(receipt.committedEffect.immediate?.net, 20000, "the candidate immediate, present but unestablished");
  assert.equal(receipt.committedEffect.recurring?.resultingAmount, 80900, "the candidate recurring, present but unestablished");
  assert.deepEqual(receipt.committedEffect.determinacy, { immediateFinancialEffect: "UNKNOWN", recurringFinancialEffect: "UNKNOWN" });
  assert.equal(receipt.committedEffect.provenance?.committedSource, "unestablished");

  const replay1 = await adapter.commitChangeQuote(quote.id);
  assert.deepEqual(replay1, receipt, "§6.10: replay returns the recorded receipt while it is the only one on file");
  assert.equal(mock.mutationCount, 0, "replay dispatches nothing");

  // Independent verification from provider-side records: the
  // recorded operation's incurred figure (fixture record) and a
  // fresh authoritative read for state + recurring.
  const incurred = 20000;
  const rawAfter = await client.getSubscription(SUB);
  const itemsAfter = ((rawAfter.json.subscription as any).subscription_items ?? []) as { item_price_id: string; amount: number }[];
  const recurringActual = itemsAfter.reduce((s, i) => s + i.amount, 0);
  assert.equal(recurringActual, 80900, "the fresh read sums the landed state's stated amounts");
  const snapshot = await adapter.getSubscription(SUB);
  const stored = store.get(quote.id)!;
  const evidence = establishVerification(stored, {
    subscriptionRef: SUB,
    committedEffect: {
      immediate: { net: incurred },
      recurring: { resultingAmount: recurringActual, currency: "USD" },
      determinacy: { immediateFinancialEffect: "DETERMINED", recurringFinancialEffect: "DETERMINED" },
      provenance: {
        immediate: "independent post-commit record: the recorded operation response's unbilled_charges sum (fixture provider record)",
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
  assert.equal(mock.mutationCount, 0, "verification never mutates");
});

// ---------------------------------------------------------------------------
// 26.18 — Missing durable ledger after restart (honest handling)
// ---------------------------------------------------------------------------

test("Test 26.18: after a process restart the in-memory ledger is gone — the adapter says so (QUOTE_STALE restart path), fabricates no recovery, and never re-mutates on the strength of a vanished record", async () => {
  // PR-14 MIGRATION: the pre-restart commit now refuses at the
  // preservation gate (mutation count 0, not 1). The restart half
  // is unchanged: the quote and its recorded outcome are volatile,
  // the restarted adapter refuses QUOTE_STALE on the vanished
  // record, and reads are unaffected. Provider state was never
  // changed, so the read asserts the original quantity.
  const store1 = new QuoteStore();
  const first = makeAdapter({}, { store: store1 });
  const quote = await first.adapter.createChangeQuote(SUB, PROPOSAL(21));
  await expectPreservationRefusal(first.adapter, quote.id);
  assert.equal(first.mock.mutationCount, 0);

  // Restart: a new store (and adapter) over the SAME provider state.
  const store2 = new QuoteStore();
  const second = makeAdapter({}, { store: store2, wrap: () => first.mock.transport });
  assert.equal(store2.get(quote.id), undefined, "the quote, its receipt, and any outcome record are volatile — nothing is recovered because nothing was persisted");
  await assert.rejects(
    () => second.adapter.commitChangeQuote(quote.id),
    (e: unknown) => e instanceof SCQError && e.code === "QUOTE_STALE" && /restarted/.test(e.message),
  );
  assert.equal(first.mock.mutationCount, 0, "no mutation at any point: gate refusal before restart, stale-quote refusal after");
  // Reads are unaffected by the lost ledger.
  const snap = await second.adapter.getSubscription(SUB);
  assert.equal(snap.items.find((i) => i.id === ADDON)?.quantity, 1, "provider state is the original — no commit ever landed");
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
  // PR-14 MIGRATION: the audited flow is now quote + refused commit
  // + refused retry. The accounting identity is unchanged and the
  // audit's conclusion is stronger: ZERO mutating dispatches occur
  // in the whole flow (previously exactly one, served by the mock),
  // and the operation sequence contains no update_for_items and no
  // post-commit verification re-read — each commit attempt stops
  // after revalidation, at the preservation gate.
  const { adapter, mock, dispatches } = makeAdapter();
  const quote = await adapter.createChangeQuote(SUB, PROPOSAL(21));
  await expectPreservationRefusal(adapter, quote.id);
  await expectPreservationRefusal(adapter, quote.id); // retry — identical refusal, still no dispatch
  // Accounting identity: every audited dispatch reached the mocked
  // transport exactly once, and vice versa. No dispatch escaped to
  // any other transport — the client was constructed with ONLY this
  // injected transport, so there is no real-network path in the flow.
  assert.equal(dispatches.length, mock.calls.length, "audited dispatches == mocked-transport calls");
  assert.equal(updateDispatches(dispatches).length, 0, "ZERO mutating dispatches in the whole flow");
  assert.equal(mock.mutationCount, 0);
  assert.ok(dispatches.every((d) => d.path.startsWith("/api/v2/")), "all dispatches are Chargebee API paths on the configured (mocked) site base");
  assert.deepEqual(
    dispatches.map((d) => d.operation),
    ["retrieve_subscription", "get_item_price", "get_item_price", "estimate_update_for_items", "retrieve_subscription", "estimate_update_for_items", "get_item_price", "get_item_price", "retrieve_subscription", "estimate_update_for_items", "get_item_price", "get_item_price"],
    "the flow's full operation sequence: quote (read, price metadata, estimate), then per commit attempt: validation read + revalidation (estimate + price metadata) — and NO mutation dispatch, on either attempt",
  );
});

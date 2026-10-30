import { test } from "node:test";
import assert from "node:assert/strict";
import { QuoteStore, establishVerification } from "../src/store/quote-store.js";
import { ChargebeeClient, type HttpTransport } from "../src/live/chargebee-http.js";
import { ChargebeeLiveAdapter } from "../src/live/chargebee-scq-adapter.js";
import { PilotMockChargebee, type PilotMockFaults } from "../src/live/pilot/mock-transport.js";

// Test 46 — Issue #22, Finding 5 (P1): receipt verification and
// independent later actuals. Independent local rerun against
// CURRENT main, built on the merged candidate construction
// (PR #10/#11, pinned by test26.17): a COMMITTED_UNVERIFIED
// receipt records the mutation response's figures as CANDIDATES
// (UNKNOWN determinacy, committedSource "unestablished") so a
// later independent verification has a record to verify against.
//
// QuoteStore.verifyCommitReceipt validates later evidence by
// EXACT figure equality with the recorded candidates
// (assertEvidenceValid: evidence figures must equal
// receiptIdentityFields, else CONFLICTING_RECEIPT_IDENTITY).
// Three consequences, one test each — all EXPECTED TO FAIL on
// unmodified main (they assert the safe behavior); controls for
// original-receipt immutability are included and pass:
//
//   46.1 a dimension the original receipt left candidate-LESS
//        can never be filled by later establishing evidence;
//   46.2 a candidate that turns out to be WRONG can never be
//        corrected by evidence establishing a different actual;
//   46.3 when evidence CONFIRMS the candidates, the current view
//        flips to COMMITTED_AND_VERIFIED / OK — but its displayed
//        committedEffect still carries determinacy UNKNOWN and
//        committedSource "unestablished": the presented
//        provenance contradicts the presented verdict.
//
// The immutable recorded original must NOT be rewritten (that
// constraint is correct and is asserted as a control). The fix
// direction — an append-only, identity-bound evidence record
// plus a separately DERIVED current verified view whose
// displayed provenance is the establishing evidence's — is
// analysis only (research/issue-22/FINDINGS.md); nothing here
// implements it. Simulated evidence only (mocked transport).
//
// PR #23 REVIEW CORRECTION (REVIEW-2, evidence provenance): as
// first delivered, 46.1/46.2 built the verification observation
// from literal figures chosen by this file, and in 46.2 the
// mock's GET record still showed the original 80900 — so the
// pair demonstrated the store's strict-equality upgrade
// restriction against a caller-constructed observation, not
// against independently established provider actuals. The
// harness below now persists the divergence PROVIDER-SIDE: in
// 46.2 the provider's authoritative subscription record carries
// the plan at a corrected unit price (62400) from the moment the
// update lands, so the independent post-commit read genuinely
// establishes recurring = 83400 while the mutation RESPONSE (and
// therefore the recorded candidate) still states 80900; the
// observation's recurring is DERIVED from that read
// (snapshot.billing.recurringAmount, itself the adapter's strict
// sum of the record's stated item amounts), and its immediate is
// read from the provider's operation-bound record of THIS update
// (the persisted update response's unbilled_charges). No
// contested figure is a hand-picked literal anymore. In 46.1 the
// recurring figure is likewise read-derived; its immediate
// figure remains a STATED observation figure, disclosed here
// because the incomplete-response fault models a provider record
// whose update response carries no charge and the fixture has no
// post-commit charge-read — the missing-dimension restriction
// 46.1 demonstrates does not depend on that figure's provenance
// (ANY established immediate contradicts the receipt's absent
// immediate identity field). 46.3 is unchanged in substance.
// Recording contradictory evidence for investigation is not the
// same as marking it verified: the safe behavior asserted below
// is that differing actuals be RECORDABLE (as verified-with-
// violation), which is exactly what the store refuses today.
//
// RESEARCH SUITE (PR #23 REVIEW-1): this file is NOT part of the
// default `npm test` discovery (`dist/tests/*.test.js`). Build,
// then invoke the research suite explicitly:
// `node --test dist/tests/*.repro.js`.

const SUB = "pilot-sub-001";
const ADDON = "pilot-addon-vision";
const PROPOSAL = (qty: number) => ({
  changes: [{ action: "CHANGE_QUANTITY" as const, itemId: ADDON, quantity: qty }],
  effectiveIntent: { type: "IMMEDIATE" as const },
  acceptanceEnvelope: {},
});

/**
 * Adapter whose post-update GET reads fail until `recover()` is
 * called (the 26.17 shape).
 *
 * `authoritativePlanUnitPrice` (REVIEW-2): when set, the harness
 * models a provider whose AUTHORITATIVE subscription record
 * diverges from what the update response stated — from the
 * moment the update lands, the record persists the plan item at
 * this unit price, so every subsequent GET of the subscription
 * serves the corrected price/amount while the already-returned
 * update response (the source of the receipt's candidates) is
 * untouched. The divergence therefore lives in the provider-side
 * record the independent verification later reads, not in any
 * figure this file hands to the store.
 */
function makeAdapterWithDyingReads(faults: PilotMockFaults = {}, opts: { authoritativePlanUnitPrice?: number } = {}) {
  const mock = new PilotMockChargebee(faults);
  let failReads = false;
  let recordDiverged = false;
  const transport: HttpTransport = async (req) => {
    if (failReads && req.method === "GET") throw new Error("read path down");
    const res = await mock.transport(req);
    if (req.method === "POST" && req.url.includes("/update_for_items")) {
      failReads = true;
      if (opts.authoritativePlanUnitPrice !== undefined) recordDiverged = true;
      return res;
    }
    if (recordDiverged && req.method === "GET" && req.url.includes("/subscriptions/") && res.json) {
      // Serve the provider's persisted authoritative record: the
      // plan item carries the corrected unit price (flat_fee, so
      // amount == unit_price). Deep-copied; the mock's own state
      // and the already-returned update response are not mutated.
      const json = JSON.parse(JSON.stringify(res.json));
      const items = json?.subscription?.subscription_items as Array<any> | undefined;
      const plan = items?.find((i) => i.item_price_id === "pilot-plan-business");
      if (plan) {
        plan.unit_price = opts.authoritativePlanUnitPrice;
        plan.amount = opts.authoritativePlanUnitPrice;
      }
      return { ...res, json };
    }
    return res;
  };
  const client = new ChargebeeClient({ site: "pilot-test", apiKey: "pilot-mock-key" }, transport);
  const store = new QuoteStore();
  const adapter = new ChargebeeLiveAdapter(client, store, { liveCommitEnabled: true });
  return { mock, client, store, adapter, recover: () => { failReads = false; } };
}

function observationEffect(immediateNet: number | undefined, recurringAmount: number) {
  return {
    ...(immediateNet !== undefined ? { immediate: { net: immediateNet } } : {}),
    recurring: { resultingAmount: recurringAmount, currency: "USD" },
    determinacy: { immediateFinancialEffect: "DETERMINED" as const, recurringFinancialEffect: "DETERMINED" as const },
    provenance: {
      immediate: "test46: independent post-commit provider record (mocked)",
      recurring: "test46: independent post-commit GET, sum of stated item amounts (mocked)",
      committedSource: "provider_actual" as const,
    },
  };
}

/**
 * REVIEW-2: an observation whose RECURRING figure is derived from
 * an independent read of the provider record — the snapshot's
 * `billing.recurringAmount`, which the adapter computes strictly
 * from the record's stated item amounts — never from a literal
 * chosen by this file. The immediate figure is supplied by the
 * caller from whatever provider record its scenario establishes
 * (46.2: the operation-bound update record; 46.1: stated, as
 * disclosed in the header).
 */
function observationFromRead(snapshot: { billing: { recurringAmount?: number } }, immediateNet: number | undefined) {
  assert.notEqual(snapshot.billing.recurringAmount, undefined, "fixture check: the independent read establishes a recurring figure");
  return {
    ...(immediateNet !== undefined ? { immediate: { net: immediateNet } } : {}),
    recurring: { resultingAmount: snapshot.billing.recurringAmount!, currency: "USD" },
    determinacy: { immediateFinancialEffect: "DETERMINED" as const, recurringFinancialEffect: "DETERMINED" as const },
    provenance: {
      immediate: "test46: provider record of the committed operation (mocked)",
      recurring: "test46: derived from the independent post-commit GET — the record's stated item amounts, summed by the adapter's snapshot derivation (mocked)",
      committedSource: "provider_actual" as const,
    },
  };
}

// ---------------------------------------------------------------------------
// 46.1 — a missing candidate cannot be filled (expected FAIL)
// ---------------------------------------------------------------------------

test("Test 46.1 (Issue #22 F5a): later evidence establishing a dimension the receipt left candidate-less must be recordable, not refused as an identity conflict", async () => {
  const { adapter, store, recover } = makeAdapterWithDyingReads({ incompleteUpdateResponse: true });
  const quote = await adapter.createChangeQuote(SUB, PROPOSAL(21));
  const receipt = await adapter.commitChangeQuote(quote.id);
  // The update response carried NO financials and the re-read was
  // down: the receipt records a recurring candidate (from the
  // response's subscription items) but NO immediate candidate.
  assert.equal(receipt.status, "COMMITTED_UNVERIFIED");
  assert.equal(receipt.committedEffect.immediate, undefined, "fixture check: the immediate dimension recorded no candidate figure");
  assert.equal(receipt.committedEffect.recurring?.resultingAmount, 80900, "fixture check: the recurring candidate was recorded");

  recover();
  const snapshot = await adapter.getSubscription(SUB);
  // REVIEW-2: the observation's recurring is DERIVED from this
  // independent read of the provider record (80900 — it agrees
  // with the recorded candidate; nothing here is contested). The
  // immediate figure (20000) is a STATED observation figure, as
  // disclosed in the file header: the incomplete-response fault
  // leaves the provider's operation record with no charge figure
  // to read back. The restriction demonstrated below does not
  // depend on its provenance — any established immediate
  // contradicts the receipt's absent immediate identity field.
  assert.equal(snapshot.billing.recurringAmount, 80900, "fixture check: the independent read establishes the same recurring the candidate recorded");
  const stored = store.get(quote.id)!;
  const evidence = establishVerification(stored, {
    subscriptionRef: SUB,
    committedEffect: observationFromRead(snapshot, 20000),
    resultingSnapshot: snapshot,
    source: "test46: independent post-commit reads through the mocked provider's records",
  });
  let verifyError: unknown;
  let verified: ReturnType<typeof store.verifyCommitReceipt> | undefined;
  try {
    verified = store.verifyCommitReceipt(quote.id, evidence);
  } catch (e) {
    verifyError = e;
  }
  console.log("=== TEST46 EVIDENCE 46.1 (observed on unmodified main) ===");
  console.log(JSON.stringify({
    recordedCandidates: { immediate: null, recurring: 80900 },
    evidenceEstablishes: { immediate: 20000, recurring: 80900 },
    evidenceFigureSources: { recurring: "derived from the independent post-commit GET of the provider record", immediate: "stated observation figure (the incomplete-response record carries no charge to read back — see file header)" },
    verifyRefused: verifyError ? String((verifyError as Error).message).slice(0, 200) : null,
    verifiedViewImmediate: verified?.committedEffect.immediate?.net ?? null,
  }, null, 2));
  console.log("=== END TEST46 EVIDENCE ===");
  assert.equal(verifyError, undefined, "establishing a previously-missing dimension must be recordable as appended evidence, not refused as CONFLICTING_RECEIPT_IDENTITY");
  assert.equal(verified?.committedEffect.immediate?.net, 20000, "the derived current view must carry the established immediate actual");
});

// ---------------------------------------------------------------------------
// 46.2 — an incorrect candidate cannot be corrected (expected FAIL)
// ---------------------------------------------------------------------------

test("Test 46.2 (Issue #22 F5b): evidence establishing a DIFFERENT actual than the recorded candidate must be recordable (verified-with-violation), not refused as an identity conflict", async () => {
  // REVIEW-2: the provider's authoritative record persists the
  // plan at a corrected unit price (62400) from the moment the
  // update lands. The mutation RESPONSE still states the plan at
  // 59900, so the receipt records candidate recurring 80900 —
  // while the provider record an independent read sees sums to
  // 83400. The differing actual is established BY THE RECORD,
  // not picked by this file.
  const { mock, client, adapter, store, recover } = makeAdapterWithDyingReads({}, { authoritativePlanUnitPrice: 62400 });
  const quote = await adapter.createChangeQuote(SUB, PROPOSAL(21));
  const receipt = await adapter.commitChangeQuote(quote.id);
  assert.equal(receipt.status, "COMMITTED_UNVERIFIED");
  assert.equal(receipt.committedEffect.recurring?.resultingAmount, 80900, "fixture check: candidate recurring recorded from the response (plan stated at 59900 there)");

  recover();
  // The independent establishment reads the provider record back:
  // the raw record shows the plan persisted at 62400, and the
  // adapter's snapshot derivation sums the record's stated item
  // amounts to recurring 83400. The candidate was WRONG — the
  // response's item amounts did not survive contact with the
  // authoritative record. Against the {} envelope that is an
  // established VIOLATED, never an OK — but it must be RECORDABLE
  // (recording contradictory evidence for investigation is not
  // the same as marking it verified).
  const { json: rawRecord } = await client.getSubscription(SUB);
  const recordItems = (rawRecord as any).subscription.subscription_items as Array<{ item_price_id: string; unit_price: number; amount: number }>;
  const recordRecurring = recordItems.reduce((s, i) => s + i.amount, 0);
  assert.equal(recordRecurring, 83400, "fixture check: the provider record's stated item amounts sum to 83400");
  const snapshot = await adapter.getSubscription(SUB);
  assert.equal(snapshot.id, SUB, "association: the read names the quote's own subscription");
  assert.equal(snapshot.billing.recurringAmount, recordRecurring, "fixture check: the snapshot's recurring is the record's stated amounts, summed");
  // The immediate actual comes from the provider's operation-
  // bound record of THIS update — the persisted update response's
  // unbilled charge, created by the very mutation under
  // verification (identity/attribution binding), not from a
  // literal and not from a later unrelated read.
  const operationCharge = (mock.lastUpdateJson as any)?.unbilled_charges?.[0]?.amount as number | undefined;
  assert.equal(operationCharge, 20000, "fixture check: the update's own provider record carries the incurred charge");
  const stored = store.get(quote.id)!;
  const evidence = establishVerification(stored, {
    subscriptionRef: SUB,
    committedEffect: observationFromRead(snapshot, operationCharge),
    resultingSnapshot: snapshot,
    source: "test46: independent post-commit GET of the provider's authoritative record + the update operation's own persisted charge record (mocked)",
  });
  let verifyError: unknown;
  let verified: ReturnType<typeof store.verifyCommitReceipt> | undefined;
  try {
    verified = store.verifyCommitReceipt(quote.id, evidence);
  } catch (e) {
    verifyError = e;
  }
  console.log("=== TEST46 EVIDENCE 46.2 (observed on unmodified main) ===");
  console.log(JSON.stringify({
    recordedCandidateRecurring: 80900,
    providerRecordItems: recordItems.map((i) => ({ item_price_id: i.item_price_id, unit_price: i.unit_price, amount: i.amount })),
    establishedActualRecurring: snapshot.billing.recurringAmount,
    establishedActualImmediate: operationCharge,
    evidenceFigureSources: { recurring: "derived from the independent post-commit GET — provider record persisted at the corrected plan price", immediate: "the update operation's own persisted unbilled-charge record" },
    verifyRefused: verifyError ? String((verifyError as Error).message).slice(0, 200) : null,
    verifiedViewRecurring: verified?.committedEffect.recurring?.resultingAmount ?? null,
    verifiedViewReconciliation: verified?.reconciliation?.status ?? null,
  }, null, 2));
  console.log("=== END TEST46 EVIDENCE ===");
  assert.equal(verifyError, undefined, "a differing established actual must be recordable as appended evidence, not refused as CONFLICTING_RECEIPT_IDENTITY");
  assert.equal(verified?.reconciliation?.status, "VIOLATED", "the derived view must report the established actual as a violation of the envelope, never a silent OK");
  // Control (passes on main): the recorded ORIGINAL is immutable —
  // replay still returns it verbatim, candidates and all.
  const replay = await adapter.commitChangeQuote(quote.id);
  assert.deepEqual(replay, receipt, "the recorded original receipt must never be rewritten");
});

// ---------------------------------------------------------------------------
// 46.3 — confirming evidence: the verified view's displayed
// provenance contradicts its verdict (expected FAIL)
// ---------------------------------------------------------------------------

test("Test 46.3 (Issue #22 F5c): after a confirming verification, the current view must not present VERIFIED/OK over figures still labeled UNKNOWN / \"unestablished\"", async () => {
  const { adapter, store, recover } = makeAdapterWithDyingReads();
  const quote = await adapter.createChangeQuote(SUB, PROPOSAL(21));
  const receipt = await adapter.commitChangeQuote(quote.id);
  assert.equal(receipt.status, "COMMITTED_UNVERIFIED");
  assert.equal(receipt.committedEffect.immediate?.net, 20000);
  assert.equal(receipt.committedEffect.recurring?.resultingAmount, 80900);

  recover();
  const snapshot = await adapter.getSubscription(SUB);
  const stored = store.get(quote.id)!;
  const evidence = establishVerification(stored, {
    subscriptionRef: SUB,
    committedEffect: observationEffect(20000, 80900),
    resultingSnapshot: snapshot,
    source: "test46: independent post-commit reads through the mocked provider's records",
  });
  const verified = store.verifyCommitReceipt(quote.id, evidence);
  assert.equal(verified.outcome, "COMMITTED_AND_VERIFIED", "fixture check: the confirming transition itself succeeds on main");
  assert.equal(verified.reconciliation.status, "OK", "fixture check: reconciliation flips to OK on main");

  console.log("=== TEST46 EVIDENCE 46.3 (observed on unmodified main) ===");
  console.log(JSON.stringify({
    viewOutcome: verified.outcome,
    viewReconciliation: verified.reconciliation?.status,
    viewCommittedDeterminacy: verified.committedEffect.determinacy,
    viewCommittedSource: verified.committedEffect.provenance?.committedSource,
  }, null, 2));
  console.log("=== END TEST46 EVIDENCE ===");

  assert.ok(
    !(verified.committedEffect.determinacy?.immediateFinancialEffect === "UNKNOWN" && verified.committedEffect.provenance?.committedSource === "unestablished"),
    "the verified view presents COMMITTED_AND_VERIFIED/OK while its displayed committed figures remain determinacy UNKNOWN " +
      "with committedSource \"unestablished\" — the displayed provenance contradicts the verdict; the derived view must carry " +
      "the establishing evidence's provenance (or an explicit verified-view marker) rather than the candidate's labels",
  );
  // Control (passes on main): the recorded ORIGINAL keeps its
  // candidate labels — immutability of the original is correct.
  const replay = await adapter.commitChangeQuote(quote.id);
  assert.deepEqual(replay, receipt, "the recorded original receipt must never be rewritten");
});

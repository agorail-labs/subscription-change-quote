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

const SUB = "pilot-sub-001";
const ADDON = "pilot-addon-vision";
const PROPOSAL = (qty: number) => ({
  changes: [{ action: "CHANGE_QUANTITY" as const, itemId: ADDON, quantity: qty }],
  effectiveIntent: { type: "IMMEDIATE" as const },
  acceptanceEnvelope: {},
});

/** Adapter whose post-update GET reads fail until `recover()` is called (the 26.17 shape). */
function makeAdapterWithDyingReads(faults: PilotMockFaults = {}) {
  const mock = new PilotMockChargebee(faults);
  let failReads = false;
  const transport: HttpTransport = async (req) => {
    if (failReads && req.method === "GET") throw new Error("read path down");
    const res = await mock.transport(req);
    if (req.method === "POST" && req.url.includes("/update_for_items")) failReads = true;
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
  const stored = store.get(quote.id)!;
  const evidence = establishVerification(stored, {
    subscriptionRef: SUB,
    committedEffect: observationEffect(20000, 80900),
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
  const { adapter, store, recover } = makeAdapterWithDyingReads();
  const quote = await adapter.createChangeQuote(SUB, PROPOSAL(21));
  const receipt = await adapter.commitChangeQuote(quote.id);
  assert.equal(receipt.status, "COMMITTED_UNVERIFIED");
  assert.equal(receipt.committedEffect.recurring?.resultingAmount, 80900, "fixture check: candidate recurring recorded from the response");

  recover();
  const snapshot = await adapter.getSubscription(SUB);
  const stored = store.get(quote.id)!;
  // The independent establishment finds the candidate WRONG: the
  // actual recurring level is 83400, not the candidate's 80900
  // (e.g. the response's item amounts did not survive contact with
  // the authoritative read). Against the {} envelope that is an
  // established VIOLATED, never an OK — but it must be RECORDABLE.
  const evidence = establishVerification(stored, {
    subscriptionRef: SUB,
    committedEffect: observationEffect(20000, 83400),
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
  console.log("=== TEST46 EVIDENCE 46.2 (observed on unmodified main) ===");
  console.log(JSON.stringify({
    recordedCandidateRecurring: 80900,
    establishedActualRecurring: 83400,
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

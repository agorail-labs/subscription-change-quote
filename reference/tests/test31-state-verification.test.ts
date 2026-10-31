import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";

// ---------------------------------------------------------------------------
// Temp-dir cleanup (test infrastructure): every directory handed out via
// trackTempDir is removed when this file's tests finish — pass or fail —
// so repeated suite runs do not accumulate scq-* litter in the OS temp
// dir. Cleanup runs only after the owning tests complete; durable-store
// tests that reopen a store across simulated restarts within one test
// are unaffected.
// ---------------------------------------------------------------------------
const tempDirs: string[] = [];
function trackTempDir(dir: string): string {
  tempDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCQError } from "../src/core/types.js";
import type {
  PostCommitObservedSnapshot,
  ProviderObservation,
  SubscriptionChangeProposal,
} from "../src/core/types.js";
import { verifyPostCommitState } from "../src/core/state-verification.js";
import { QuoteStore, establishVerification, receiptIdentityDigest } from "../src/store/quote-store.js";
import { DurableQuoteStore, DispatchBlockedError } from "../src/store/durable-store.js";
import { DurableMutationCoordinator } from "../src/store/mutation-coordinator.js";
import { ChargebeeClient, type HttpTransport } from "../src/live/chargebee-http.js";
import { ChargebeeLiveAdapter } from "../src/live/chargebee-scq-adapter.js";
import { PilotMockChargebee, type PilotMockFaults } from "../src/live/pilot/mock-transport.js";
import { makeObservation, makeStoredQuote, makeUnverifiedReceipt } from "./helpers/durable-fixtures.js";

// Test 31 — SCQ v0.6.2 PR-9: the provider-neutral post-commit
// state-verification hook (`verifyPostCommitState`, core) and its
// two integrations — `establishVerification` (store) refactored to
// consume it, and the Chargebee-live adapter's post-commit
// establishment consuming it in FULL_ITEM_SET mode.
//
// The assignment's 28-row matrix; each test names its row. Rows are
// classified in research/core-state-verification.md §8 as NEW
// (behavior that did not exist before PR-9), EXTRACTION (behavior
// the store's private observedStateVerification already computed —
// now pinned against the shared core API), or COMPATIBILITY
// (pre-existing integration behavior that must survive the
// refactor). Written before the implementation: on the pre-PR-9
// tree this file does not compile (the core module does not
// exist), and row 16's scheduled-cancellation establishment is
// inexpressible through any pre-PR-9 API.
//
// ALL provider interaction is mocked/synthetic (PilotMockChargebee).
// No real Chargebee call is made; SCQ_LIVE_COMMIT_ENABLED is never
// set. Results are SIMULATED_PASS at best.

// ---------------------------------------------------------------------------
// Hook-level fixtures
// ---------------------------------------------------------------------------

const SRC = "test31 fixture: simulated post-commit provider read";
const AT = "2026-10-29T00:06:00.000Z";

function snap(
  items: PostCommitObservedSnapshot["items"],
  overrides: Partial<PostCommitObservedSnapshot> = {}
): PostCommitObservedSnapshot {
  return {
    id: "sub_1",
    version: "v2",
    status: "active",
    items,
    billing: { currency: "usd", cadence: "MONTHLY" },
    ...overrides,
  };
}

function observe(
  snapshot: PostCommitObservedSnapshot | undefined,
  extra: { itemsComplete?: boolean; cancellationSchedule?: { kind?: "TERM_END" | "DATE" | "IMMEDIATE"; effectiveAt?: string } } = {}
) {
  return { snapshot, source: SRC, observedAt: AT, ...extra };
}

const qtyProposal = (itemId: string, quantity: number): SubscriptionChangeProposal => ({
  changes: [{ action: "CHANGE_QUANTITY", itemId, quantity }],
  effectiveIntent: { type: "IMMEDIATE" },
});

// The standard two-item world: item_a (plan, qty 1) + item_b (addon, qty 2).
const ITEMS_BEFORE = [
  { id: "item_a", offeringRef: "plan:basic", quantity: 1 },
  { id: "item_b", offeringRef: "addon:extra", quantity: 2 },
];
// After CHANGE_QUANTITY item_b -> 5 (the full resulting set).
const ITEMS_AFTER_QTY5 = [
  { id: "item_a", offeringRef: "plan:basic", quantity: 1 },
  { id: "item_b", offeringRef: "addon:extra", quantity: 5 },
];
const EXPECTED_AFTER_QTY5 = [
  { id: "item_a", quantity: 1 },
  { id: "item_b", quantity: 5 },
];

// ---------------------------------------------------------------------------
// Rows 1–8: item-set verification (FULL_ITEM_SET coverage)
// ---------------------------------------------------------------------------

test("Test 31.1 (row 1, NEW): exact expected item set matches — VERIFIED at FULL_ITEM_SET coverage", () => {
  const result = verifyPostCommitState(
    { proposal: qtyProposal("item_b", 5), expectedItems: EXPECTED_AFTER_QTY5 },
    observe(snap(ITEMS_AFTER_QTY5))
  );
  assert.equal(result.verdict, "VERIFIED");
  assert.equal(result.coverage, "FULL_ITEM_SET");
  assert.ok(result.verifiedDimensions.includes("state:itemSet"));
  assert.deepEqual(result.contradictions, []);
  const itemSetCheck = result.checks.find((c) => c.dimension === "state:itemSet");
  assert.equal(itemSetCheck?.outcome, "VERIFIED");
});

test("Test 31.2 (row 2, NEW): target item matches but an unexpected extra item exists — MISMATCH", () => {
  // The pre-PR-9 shared verifier was action-level: it checked only
  // the targeted item and would have reported this state VERIFIED.
  const result = verifyPostCommitState(
    { proposal: qtyProposal("item_b", 5), expectedItems: EXPECTED_AFTER_QTY5 },
    observe(snap([...ITEMS_AFTER_QTY5, { id: "item_c", offeringRef: "addon:sneaky", quantity: 1 }]))
  );
  assert.equal(result.verdict, "MISMATCH");
  assert.ok(result.contradictions.some((c) => c.includes("extra item item_c")), JSON.stringify(result.contradictions));
});

test("Test 31.3 (row 3, NEW): target item matches but another item is missing — MISMATCH", () => {
  const result = verifyPostCommitState(
    { proposal: qtyProposal("item_b", 5), expectedItems: EXPECTED_AFTER_QTY5 },
    observe(snap([{ id: "item_b", offeringRef: "addon:extra", quantity: 5 }]))
  );
  assert.equal(result.verdict, "MISMATCH");
  assert.ok(
    result.contradictions.some((c) => c.includes("missing item item_a (intended quantity 1)")),
    JSON.stringify(result.contradictions)
  );
});

test("Test 31.4 (row 4, EXTRACTION + NEW): wrong quantity — MISMATCH at action level (extracted semantics) and at full-set coverage", () => {
  const actionLevel = verifyPostCommitState(
    { proposal: qtyProposal("item_b", 5) },
    observe(snap([{ id: "item_a", offeringRef: "plan:basic", quantity: 1 }, { id: "item_b", offeringRef: "addon:extra", quantity: 4 }]))
  );
  assert.equal(actionLevel.verdict, "MISMATCH");
  assert.equal(actionLevel.coverage, "ACTION_LEVEL");
  assert.ok(actionLevel.contradictions.some((c) => c === "quantity mismatch for item item_b: intended 5, actual 4"));

  const fullSet = verifyPostCommitState(
    { proposal: qtyProposal("item_b", 5), expectedItems: EXPECTED_AFTER_QTY5 },
    observe(snap([{ id: "item_a", offeringRef: "plan:basic", quantity: 1 }, { id: "item_b", offeringRef: "addon:extra", quantity: 4 }]))
  );
  assert.equal(fullSet.verdict, "MISMATCH");
  assert.ok(fullSet.contradictions.some((c) => c === "quantity mismatch for item item_b: intended 5, actual 4"));
});

test("Test 31.5 (row 5, NEW): duplicate item identifiers in the observed collection — MISMATCH", () => {
  const result = verifyPostCommitState(
    { proposal: qtyProposal("item_b", 5), expectedItems: EXPECTED_AFTER_QTY5 },
    observe(snap([...ITEMS_AFTER_QTY5, { id: "item_b", offeringRef: "addon:extra", quantity: 5 }]))
  );
  assert.equal(result.verdict, "MISMATCH");
  assert.ok(result.contradictions.some((c) => /duplicate entries for item item_b/.test(c)), JSON.stringify(result.contradictions));
});

test("Test 31.6a (row 6, NEW): partial item collection — an absent item is NOT established as missing (UNVERIFIABLE)", () => {
  // Stated partial rule: with itemsComplete === false, absence-based
  // contradictions are not established — the item may be unreturned.
  const result = verifyPostCommitState(
    { proposal: qtyProposal("item_b", 5), expectedItems: EXPECTED_AFTER_QTY5 },
    observe(snap([{ id: "item_a", offeringRef: "plan:basic", quantity: 1 }]), { itemsComplete: false })
  );
  assert.equal(result.verdict, "UNVERIFIABLE");
  assert.deepEqual(result.contradictions, []);
  assert.ok(result.unverifiableDimensions.includes("state:itemSet"));
});

test("Test 31.6b (row 6, NEW): partial item collection — a contradiction established by a PRESENT entry stands (MISMATCH)", () => {
  const result = verifyPostCommitState(
    { proposal: qtyProposal("item_b", 5), expectedItems: EXPECTED_AFTER_QTY5 },
    observe(snap(ITEMS_BEFORE), { itemsComplete: false }) // item_b present at the OLD quantity 2
  );
  assert.equal(result.verdict, "MISMATCH");
  assert.ok(result.contradictions.some((c) => c === "quantity mismatch for item item_b: intended 5, actual 2"));
});

test("Test 31.7 (row 7, EXTRACTION + NEW): the entire item collection is absent — UNVERIFIABLE, never an empty set", () => {
  const noItems = snap(undefined);
  assert.ok(!("items" in noItems) || noItems.items === undefined, "fixture: the collection member is omitted");
  const fullSet = verifyPostCommitState(
    { proposal: qtyProposal("item_b", 5), expectedItems: EXPECTED_AFTER_QTY5 },
    observe(noItems)
  );
  assert.equal(fullSet.verdict, "UNVERIFIABLE");
  assert.equal(fullSet.stateObserved, true, "a snapshot was observed — only its item collection is absent");
  assert.ok(fullSet.unverifiableDimensions.includes("state:itemSet"));

  const actionLevel = verifyPostCommitState({ proposal: qtyProposal("item_b", 5) }, observe(noItems));
  assert.equal(actionLevel.verdict, "UNVERIFIABLE");
});

test("Test 31.8 (row 8, NEW): a present EMPTY collection against a nonempty expectation — MISMATCH (a stated empty set, not missing data)", () => {
  const result = verifyPostCommitState(
    { proposal: qtyProposal("item_b", 5), expectedItems: EXPECTED_AFTER_QTY5 },
    observe(snap([]))
  );
  assert.equal(result.verdict, "MISMATCH");
  assert.ok(result.contradictions.length >= 2, "both expected items are established as missing from a complete stated set");
});

// ---------------------------------------------------------------------------
// Rows 9–13: plan and cadence
// ---------------------------------------------------------------------------

test("Test 31.9 (row 9, EXTRACTION + NEW): correct plan replacement — VERIFIED at action level and at full-set coverage", () => {
  const proposal: SubscriptionChangeProposal = {
    changes: [{ action: "CHANGE_PLAN", itemId: "item_a", offeringRef: "plan:pro" }],
    effectiveIntent: { type: "IMMEDIATE" },
  };
  const observed = snap([
    { id: "item_a", offeringRef: "plan:pro", quantity: 1 },
    { id: "item_b", offeringRef: "addon:extra", quantity: 2 },
  ]);
  const actionLevel = verifyPostCommitState({ proposal }, observe(observed));
  assert.equal(actionLevel.verdict, "VERIFIED");

  const fullSet = verifyPostCommitState(
    { proposal, expectedItems: [{ id: "item_a", quantity: 1, offeringRef: "plan:pro" }, { id: "item_b", quantity: 2 }] },
    observe(observed)
  );
  assert.equal(fullSet.verdict, "VERIFIED");
  assert.equal(fullSet.coverage, "FULL_ITEM_SET");
});

test("Test 31.10 (row 10, EXTRACTION): wrong offering — MISMATCH", () => {
  const proposal: SubscriptionChangeProposal = {
    changes: [{ action: "CHANGE_PLAN", itemId: "item_a", offeringRef: "plan:pro" }],
    effectiveIntent: { type: "IMMEDIATE" },
  };
  const result = verifyPostCommitState({ proposal }, observe(snap(ITEMS_BEFORE)));
  assert.equal(result.verdict, "MISMATCH");
  assert.ok(result.contradictions.some((c) => c.includes("item_a")), JSON.stringify(result.contradictions));
});

test("Test 31.11 (row 11, EXTRACTION): correct cadence — VERIFIED (case-insensitive, as the extracted semantics)", () => {
  const proposal: SubscriptionChangeProposal = {
    changes: [{ action: "CHANGE_CADENCE", cadence: "ANNUAL" }],
    effectiveIntent: { type: "IMMEDIATE" },
  };
  const result = verifyPostCommitState(
    { proposal },
    observe(snap(ITEMS_BEFORE, { billing: { currency: "usd", cadence: "annual" } }))
  );
  assert.equal(result.verdict, "VERIFIED");
  assert.ok(result.verifiedDimensions.includes("state:cadence"));
});

test("Test 31.12 (row 12, EXTRACTION): missing cadence — UNVERIFIABLE", () => {
  const proposal: SubscriptionChangeProposal = {
    changes: [{ action: "CHANGE_CADENCE", cadence: "ANNUAL" }],
    effectiveIntent: { type: "IMMEDIATE" },
  };
  const result = verifyPostCommitState(
    { proposal },
    observe(snap(ITEMS_BEFORE, { billing: { currency: "usd" } }))
  );
  assert.equal(result.verdict, "UNVERIFIABLE");
  assert.ok(result.unverifiableDimensions.includes("state:cadence"));
});

test("Test 31.13 (row 13, EXTRACTION): wrong cadence — MISMATCH", () => {
  const proposal: SubscriptionChangeProposal = {
    changes: [{ action: "CHANGE_CADENCE", cadence: "ANNUAL" }],
    effectiveIntent: { type: "IMMEDIATE" },
  };
  const result = verifyPostCommitState({ proposal }, observe(snap(ITEMS_BEFORE))); // cadence MONTHLY
  assert.equal(result.verdict, "MISMATCH");
  assert.ok(result.contradictions.some((c) => c.includes("cadence")), JSON.stringify(result.contradictions));
});

// ---------------------------------------------------------------------------
// Rows 14–17: cancellation
// ---------------------------------------------------------------------------

const cancelProposal = (intent: SubscriptionChangeProposal["effectiveIntent"]): SubscriptionChangeProposal => ({
  changes: [{ action: "CANCEL" }],
  effectiveIntent: intent,
});

test("Test 31.14 (row 14, EXTRACTION): immediate cancellation verified from a terminal state", () => {
  const result = verifyPostCommitState(
    { proposal: cancelProposal({ type: "IMMEDIATE" }) },
    observe(snap([], { status: "cancelled" }))
  );
  assert.equal(result.verdict, "VERIFIED");
  assert.ok(result.verifiedDimensions.includes("state:cancellation"));
});

test("Test 31.15 (row 15, EXTRACTION + NEW): immediate cancellation with an ACTIVE status — MISMATCH; an established TERM_END schedule does not rescue it", () => {
  const plain = verifyPostCommitState(
    { proposal: cancelProposal({ type: "IMMEDIATE" }) },
    observe(snap(ITEMS_BEFORE, { status: "active" }))
  );
  assert.equal(plain.verdict, "MISMATCH");

  // NEW pin: a scheduled cancellation is a different outcome from an
  // immediate termination — schedule evidence must not convert an
  // unmet IMMEDIATE intent into anything but a contradiction.
  const scheduled = verifyPostCommitState(
    { proposal: cancelProposal({ type: "IMMEDIATE" }) },
    observe(snap(ITEMS_BEFORE, { status: "active" }), {
      cancellationSchedule: { effectiveAt: "2026-11-01T00:00:00.000Z" },
    })
  );
  assert.equal(scheduled.verdict, "MISMATCH");
});

test("Test 31.16 (row 16, NEW): scheduled cancellation with an independently established schedule — VERIFIED", () => {
  // Inexpressible before PR-9: the snapshot carries no schedule, so
  // the private verifier computed UNVERIFIABLE for every
  // non-terminal scheduled cancel (cf. row 17).
  // SV2 review correction (PR #18): a bare schedule effectiveAt no
  // longer verifies a TERM_END intent — the schedule must align
  // with the authorized term end, via provider schedule-KIND
  // evidence (as here) or an established instant equal to the
  // authorized boundary on the expectation. This fixture now
  // supplies the kind evidence; the assertion is unchanged.
  const termEnd = verifyPostCommitState(
    { proposal: cancelProposal({ type: "TERM_END" }) },
    observe(snap(ITEMS_BEFORE, { status: "active" }), {
      cancellationSchedule: { kind: "TERM_END", effectiveAt: "2026-11-01T00:00:00.000Z" },
    })
  );
  assert.equal(termEnd.verdict, "VERIFIED");
  assert.ok(termEnd.verifiedDimensions.includes("state:cancellation"));

  const dated = verifyPostCommitState(
    { proposal: cancelProposal({ type: "DATE", at: "2026-11-15T00:00:00.000Z" }) },
    observe(snap(ITEMS_BEFORE, { status: "active" }), {
      cancellationSchedule: { effectiveAt: "2026-11-15T00:00:00.000Z" },
    })
  );
  assert.equal(dated.verdict, "VERIFIED");

  const wrongDate = verifyPostCommitState(
    { proposal: cancelProposal({ type: "DATE", at: "2026-11-15T00:00:00.000Z" }) },
    observe(snap(ITEMS_BEFORE, { status: "active" }), {
      cancellationSchedule: { effectiveAt: "2026-11-01T00:00:00.000Z" },
    })
  );
  assert.equal(wrongDate.verdict, "MISMATCH", "an established schedule on a different date contradicts a DATE intent");
});

test("Test 31.17 (row 17, EXTRACTION): scheduled cancellation with missing schedule evidence — UNVERIFIABLE (never invented)", () => {
  const result = verifyPostCommitState(
    { proposal: cancelProposal({ type: "TERM_END" }) },
    observe(snap(ITEMS_BEFORE, { status: "active" }))
  );
  assert.equal(result.verdict, "UNVERIFIABLE");
  assert.ok(result.unverifiableDimensions.includes("state:cancellation"));
});

// ---------------------------------------------------------------------------
// Rows 18–19: multi-change composition and precedence
// ---------------------------------------------------------------------------

test("Test 31.18 (row 18, NEW): multi-change with one contradiction and one unverifiable dimension — MISMATCH (contradiction precedence)", () => {
  const proposal: SubscriptionChangeProposal = {
    changes: [
      { action: "CHANGE_QUANTITY", itemId: "item_b", quantity: 5 }, // contradicted: observed 4
      { action: "CHANGE_CADENCE", cadence: "ANNUAL" }, // unverifiable: cadence absent
    ],
    effectiveIntent: { type: "IMMEDIATE" },
  };
  const observed = snap(
    [
      { id: "item_a", offeringRef: "plan:basic", quantity: 1 },
      { id: "item_b", offeringRef: "addon:extra", quantity: 4 },
    ],
    { billing: { currency: "usd" } }
  );
  const result = verifyPostCommitState({ proposal }, observe(observed));
  assert.equal(result.verdict, "MISMATCH", "an established contradiction is never masked as merely unverifiable");
  assert.ok(result.unverifiableDimensions.includes("state:cadence"), "the unverifiable dimension is still reported");
});

test("Test 31.19 (row 19, EXTRACTION): multi-change with one unverifiable dimension — not VERIFIED, and the dimension is labeled", () => {
  const proposal: SubscriptionChangeProposal = {
    changes: [
      { action: "CHANGE_QUANTITY", itemId: "item_b", quantity: 5 }, // verified
      { action: "CHANGE_CADENCE", cadence: "ANNUAL" }, // unverifiable: cadence absent
    ],
    effectiveIntent: { type: "IMMEDIATE" },
  };
  const observed = snap(ITEMS_AFTER_QTY5, { billing: { currency: "usd" } });
  const result = verifyPostCommitState({ proposal }, observe(observed));
  assert.equal(result.verdict, "UNVERIFIABLE");
  assert.ok(result.verifiedDimensions.includes("state:item:item_b:quantity"));
  assert.ok(result.unverifiableDimensions.includes("state:cadence"));
});

// ---------------------------------------------------------------------------
// Rows 20–21: state verification and financial establishment are separate
// ---------------------------------------------------------------------------

test("Test 31.20 (row 20, COMPATIBILITY): correct financial figures but WRONG resulting state — establishment computes MISMATCH and the transition is refused", () => {
  const store = new QuoteStore();
  store.put(makeStoredQuote("q1"));
  store.recordCommitReceipt("q1", makeUnverifiedReceipt("q1"));
  // Independent observation: the recorded figures are exactly
  // right, but the post-commit state contradicts the intent
  // (item_1 at quantity 3; the proposal intends 2).
  const observation = makeObservation();
  observation.resultingSnapshot = {
    ...observation.resultingSnapshot!,
    items: [{ id: "item_1", offeringRef: "plan", quantity: 3 }],
  };
  const evidence = establishVerification(store.get("q1")!, observation);
  assert.equal(evidence.stateVerification, "MISMATCH", "financial correctness does not rescue a contradicted state");
  assert.equal(evidence.reconciliation.status, "OK", "the financial reconciliation over the figures is separately OK — the two requirements are independent");
  assert.throws(() => store.verifyCommitReceipt("q1", evidence), /state verification is MISMATCH/);
  assert.equal(store.get("q1")?.commit_receipt?.outcome, "COMMITTED_UNVERIFIED");
});

test("Test 31.21 (row 21, NEW + COMPATIBILITY): correct resulting state but UNKNOWN financials — the state verdict establishes no financial outcome", () => {
  // The hook verifies the state on state evidence alone...
  const stateResult = verifyPostCommitState(
    { proposal: qtyProposal("item_1", 2) },
    observe(snap([{ id: "item_1", offeringRef: "plan", quantity: 2 }]))
  );
  assert.equal(stateResult.verdict, "VERIFIED");
  assert.equal(stateResult.financialOutcomeEstablished, false, "structurally: a state verdict never establishes financials");

  // ...and establishment still refuses an observation whose figures
  // are unestablished: a correct state cannot manufacture evidence.
  const store = new QuoteStore();
  store.put(makeStoredQuote("q1"));
  store.recordCommitReceipt("q1", makeUnverifiedReceipt("q1"));
  const observation: ProviderObservation = {
    ...makeObservation(),
    committedEffect: {
      immediate: { net: 1000 },
      recurring: { resultingAmount: 5000, currency: "usd" },
      provenance: { committedSource: "unestablished" },
    },
  };
  assert.throws(() => establishVerification(store.get("q1")!, observation), /Establishment refused/);
  assert.equal(store.get("q1")?.commit_receipt?.outcome, "COMMITTED_UNVERIFIED");
});

// ---------------------------------------------------------------------------
// Rows 22–23: attribution separation in the live-adapter integration
// (mocked transports only)
// ---------------------------------------------------------------------------

const SUB = "pilot-sub-001";
const ADDON = "pilot-addon-vision";
const PLAN = "pilot-plan-business";
const LIVE_PROPOSAL = (qty: number) => ({
  changes: [{ action: "CHANGE_QUANTITY" as const, itemId: ADDON, quantity: qty }],
  effectiveIntent: { type: "IMMEDIATE" as const },
  acceptanceEnvelope: {},
});

function liveAdapter(faults: PilotMockFaults = {}, opts: { commitEnabled?: boolean; store?: QuoteStore; wrap?: (m: PilotMockChargebee) => HttpTransport } = {}) {
  const mock = new PilotMockChargebee(faults);
  const client = new ChargebeeClient({ site: "pilot-test", apiKey: "pilot-mock-key" }, opts.wrap ? opts.wrap(mock) : mock.transport);
  const store = opts.store ?? new QuoteStore();
  const adapter = new ChargebeeLiveAdapter(client, store, { liveCommitEnabled: opts.commitEnabled ?? true });
  return { mock, client, store, adapter };
}

test("Test 31.22 (row 22, NEW + COMPATIBILITY): lost response followed by a matching state — the hook reports the state observed, and the attempt STAYS INDETERMINATE with no receipt (L1)", async () => {
  // PR-14 MIGRATION: the live adapter no longer dispatches, so the
  // lost-response attempt this row exercised cannot be produced
  // through it (the commit refuses at the preservation gate —
  // asserted first). The row's subject is the SEPARATION between
  // the hook's state verdict and the attempt's classification, so
  // the unresolved attempt is seeded through the store's own
  // outcome API — the exact write the unknown-dispatch path
  // performs — and the provider state is moved to the matching
  // target by an external change (which is precisely L1's point:
  // the observations are identical whether our dispatch or another
  // actor landed them). Every hook and classification assertion
  // below is the original one.
  const { adapter, mock, store } = liveAdapter({ loseUpdateResponse: true });
  const quote = await adapter.createChangeQuote(SUB, LIVE_PROPOSAL(21));
  await assert.rejects(
    () => adapter.commitChangeQuote(quote.id),
    (e: unknown) => e instanceof SCQError && e.code === "AUTHORIZATION_PRESERVATION_UNENFORCEABLE",
    "PR-14: the adapter commit itself refuses pre-dispatch",
  );
  mock.applyExternalChange(ADDON, 21); // the matching state — provenance deliberately ambiguous (L1)
  store.recordCommitOutcome(quote.id, {
    outcome: "INDETERMINATE",
    at: new Date().toISOString(),
    details: { reason: "test31.22 (PR-14 fixture): seeded exactly as the unknown-dispatch path records an unresolved attempt" },
  });
  assert.equal(mock.mutationCount, 0, "no SCQ dispatch occurred — the state change is the external fixture's");
  assert.equal(store.recordedReceipt(quote.id), undefined, "no receipt exists for the unresolved attempt");
  assert.equal(store.get(quote.id)?.commit_outcome?.outcome, "INDETERMINATE");

  // The provider state now matches the intent exactly. Run the
  // shared hook over that independently read state:
  const observedSnap = await adapter.getSubscription(SUB);
  const stored = store.get(quote.id)!;
  const stateResult = verifyPostCommitState(
    {
      proposal: stored.proposal,
      expectedItems: [
        { id: PLAN, quantity: 1 },
        { id: ADDON, quantity: 21 },
      ],
    },
    { snapshot: observedSnap, source: "test31: post-hoc independent re-read after the lost response" }
  );
  assert.equal(stateResult.verdict, "VERIFIED", "question 1 of 4: the intended state IS currently observed");
  assert.equal(stateResult.executionEstablished, false);
  assert.equal(stateResult.stateAttributableToThisOperation, false);

  // …and nothing about the attempt changes: observational
  // equivalence (PR #16 L1) — the same observations arise if
  // another actor applied the identical change.
  assert.equal(store.recordedReceipt(quote.id), undefined, "a matching state does not create a receipt");
  assert.equal(store.get(quote.id)?.commit_outcome?.outcome, "INDETERMINATE");
  await assert.rejects(() => adapter.commitChangeQuote(quote.id), /INDETERMINATE/, "blind retry remains refused — the INDETERMINATE guard, not the preservation gate, answers a retry of an unresolved attempt");
  assert.equal(mock.mutationCount, 0, "no dispatch occurred at any point");
});

test("Test 31.23 (row 23, COMPATIBILITY): an intervening actor breaks the attribution bracket — the hook's state MISMATCH is NOT translated into a financial VIOLATED", async () => {
  // PR-14 MIGRATION: the intervening write was formerly triggered
  // by our own dispatch; the adapter no longer dispatches (the
  // commit refuses at the preservation gate — asserted first), so
  // the actor's write is applied directly and the hook is run over
  // an independent re-read of the resulting state. The row's point
  // is preserved in its strongest form: the hook still reports the
  // state contradiction (MISMATCH, unattributed), and there is no
  // committed receipt at all for the contradiction to be
  // mistranslated into a financial VIOLATED on — the quote's only
  // recorded outcome is the pre-dispatch CONFIRMED_NON_EXECUTION.
  // Z1–Z3 bracket semantics remain implemented in the dispatch
  // path and covered at the store level.
  const { adapter, mock, store } = liveAdapter();
  const quote = await adapter.createChangeQuote(SUB, LIVE_PROPOSAL(21));
  await assert.rejects(
    () => adapter.commitChangeQuote(quote.id),
    (e: unknown) => e instanceof SCQError && e.code === "AUTHORIZATION_PRESERVATION_UNENFORCEABLE",
  );
  assert.equal(store.get(quote.id)?.commit_receipt, undefined, "no committed receipt exists — nothing carries a financial classification for this quote");
  assert.equal(store.get(quote.id)?.commit_outcome?.outcome, "CONFIRMED_NON_EXECUTION");
  mock.applyExternalChange(ADDON, 5); // the intervening actor's write
  const observedSnap = await adapter.getSubscription(SUB);

  // The shared hook, run over the observed state, DOES report the
  // state contradiction — state truth and financial classification
  // are separate questions, and only operation-bound bracket
  // evidence may connect them.
  const stateResult = verifyPostCommitState(
    {
      proposal: store.get(quote.id)!.proposal,
      expectedItems: [
        { id: PLAN, quantity: 1 },
        { id: ADDON, quantity: 21 },
      ],
    },
    { snapshot: observedSnap, source: "test31: independent re-read after the intervening actor's write" }
  );
  assert.equal(stateResult.verdict, "MISMATCH");
  assert.equal(stateResult.stateAttributableToThisOperation, false);
});

// ---------------------------------------------------------------------------
// Rows 24–25: absent snapshot; evidence discipline after the refactor
// ---------------------------------------------------------------------------

test("Test 31.24 (row 24, EXTRACTION): provider snapshot absent — UNVERIFIABLE, with stateObserved false", () => {
  const result = verifyPostCommitState(
    { proposal: qtyProposal("item_b", 5), expectedItems: EXPECTED_AFTER_QTY5 },
    observe(undefined)
  );
  assert.equal(result.verdict, "UNVERIFIABLE");
  assert.equal(result.stateObserved, false);
  assert.ok(result.unverifiableDimensions.includes("state:itemSet"));
});

test("Test 31.25 (row 25, COMPATIBILITY): receipt verification still rejects self-asserted evidence after the refactor — including a hook RESULT presented as evidence", () => {
  const store = new QuoteStore();
  store.put(makeStoredQuote("q1"));
  store.recordCommitReceipt("q1", makeUnverifiedReceipt("q1"));
  // A hand-built evidence-shaped object (the round-1 defect class):
  const handBuilt = {
    committedEffect: {
      immediate: { net: 1000 },
      recurring: { resultingAmount: 5000, currency: "usd" },
      provenance: { committedSource: "provider_actual" },
    },
    committedSource: "provider_actual",
    stateVerification: "VERIFIED",
    reconciliation: { status: "OK" },
  };
  assert.throws(() => store.verifyCommitReceipt("q1", handBuilt as never), /not an established evidence token/);
  // A verifyPostCommitState RESULT is a computed value, not a
  // branded token: presenting one must fail the same way. The
  // hook's return type does not launder anything into evidence.
  const hookResult = verifyPostCommitState(
    { proposal: qtyProposal("item_1", 2) },
    observe(snap([{ id: "item_1", offeringRef: "plan", quantity: 2 }]))
  );
  assert.equal(hookResult.verdict, "VERIFIED");
  assert.throws(() => store.verifyCommitReceipt("q1", hookResult as never), /not an established evidence token/);
  assert.equal(store.get("q1")?.commit_receipt?.outcome, "COMMITTED_UNVERIFIED");
});

// ---------------------------------------------------------------------------
// Rows 26–27: durable compatibility
// ---------------------------------------------------------------------------

function tmpDb(): string {
  return join(trackTempDir(mkdtempSync(join(tmpdir(), "scq-pr9-"))), "scq.db");
}

test("Test 31.26 (row 26, COMPATIBILITY): original receipt replay is unchanged after verification through the refactored establishment AND a durable restart", () => {
  const path = tmpDb();
  const a = new DurableQuoteStore(path, { recoveryGraceMs: 0 });
  a.put(makeStoredQuote("q1"));
  const recorded = a.recordCommitReceipt("q1", makeUnverifiedReceipt("q1"));
  const evidence = establishVerification(a.get("q1")!, makeObservation());
  assert.equal(evidence.stateVerification, "VERIFIED", "the refactored establishment computes via the shared hook");
  a.verifyCommitReceipt("q1", evidence);
  assert.equal(a.get("q1")?.commit_receipt?.outcome, "COMMITTED_AND_VERIFIED");
  a.close();

  const b = new DurableQuoteStore(path, { recoveryGraceMs: 0 });
  const replayed = b.recordedReceipt("q1");
  assert.deepEqual(replayed, recorded, "§6.10: replay after verification + restart returns the ORIGINAL recorded receipt");
  assert.equal(replayed?.outcome, "COMMITTED_UNVERIFIED");
  assert.equal(b.get("q1")?.commit_receipt?.outcome, "COMMITTED_AND_VERIFIED", "the current view carries the transition");
  assert.equal(b.get("q1")?.commit_receipt_identity_digest, receiptIdentityDigest(replayed!));
  b.close();
});

test("Test 31.27 (row 27, COMPATIBILITY): the durable mutation ledger remains intact after an INDETERMINATE outcome — a VERIFIED state verdict does not unblock it", async () => {
  const path = tmpDb();
  const intent = {
    quoteId: "q1",
    subscriptionId: "sub_1",
    provider: "chargebee",
    site: "test-site",
    request: { subscription_items: [{ item_price_id: "item_1", quantity: 2 }], replace_items_list: true },
    idempotencyKey: "scq-q1",
    preDispatchFingerprint: "fp-1",
  };
  const a = new DurableQuoteStore(path, { recoveryGraceMs: 0 });
  a.put(makeStoredQuote("q1"));
  const coordinatorA = new DurableMutationCoordinator(a);
  await assert.rejects(
    () => coordinatorA.execute(intent, async () => { throw new Error("lost response (mocked)"); }),
    /lost response/
  );
  assert.equal(a.attemptsForQuote("q1")[0]?.state, "INDETERMINATE");
  a.close();

  // Restart: the ledger entry survives, still blocks, no receipt.
  const b = new DurableQuoteStore(path, { recoveryGraceMs: 0 });
  assert.equal(b.attemptsForQuote("q1").length, 1);
  assert.equal(b.attemptsForQuote("q1")[0].state, "INDETERMINATE");
  assert.equal(b.recordedReceipt("q1"), undefined);
  const report = b.recoveryReport();
  assert.ok(JSON.stringify(report).includes("INDETERMINATE"), "the operator report enumerates the indeterminate attempt");

  // A state verdict over a matching hypothetical read changes
  // nothing in the ledger (L1 at the durable layer):
  const stateResult = verifyPostCommitState(
    { proposal: qtyProposal("item_1", 2), expectedItems: [{ id: "item_1", quantity: 2 }] },
    observe(snap([{ id: "item_1", offeringRef: "plan", quantity: 2 }]))
  );
  assert.equal(stateResult.verdict, "VERIFIED");
  const coordinatorB = new DurableMutationCoordinator(b);
  await assert.rejects(
    () => coordinatorB.execute(intent, async () => ({ type: "outcome" as const, outcome: "CONFIRMED_NON_EXECUTION" as const })),
    DispatchBlockedError,
    "the INDETERMINATE attempt still blocks any re-dispatch after restart"
  );
  assert.equal(b.attemptsForQuote("q1").length, 1, "no second attempt was recorded");
  b.close();
});

// ---------------------------------------------------------------------------
// Row 28 + the result contract
// ---------------------------------------------------------------------------

test("Test 31.28 (row 28, COMPATIBILITY): the Chargebee-live safety gate still refuses real dispatch after the integration", async () => {
  const { adapter, mock } = liveAdapter({}, { commitEnabled: false });
  const quote = await adapter.createChangeQuote(SUB, LIVE_PROPOSAL(21));
  await assert.rejects(() => adapter.commitChangeQuote(quote.id), /LIVE COMMIT DISABLED/);
  assert.equal(mock.mutationCount, 0, "zero mutating dispatches reached the (mocked) provider");
});

test("Test 31.29 (contract, NEW): the result is a structured computation — checks, coverage, provenance, limitations, and the attribution non-claims are all in the value", () => {
  const result = verifyPostCommitState(
    { proposal: qtyProposal("item_b", 5), expectedItems: EXPECTED_AFTER_QTY5 },
    observe(snap(ITEMS_AFTER_QTY5))
  );
  assert.ok(Array.isArray(result.checks) && result.checks.length > 0, "checks performed are reported, not just a boolean");
  for (const c of result.checks) {
    assert.equal(typeof c.check, "string");
    assert.equal(typeof c.dimension, "string");
    assert.ok(["VERIFIED", "CONTRADICTED", "UNVERIFIABLE"].includes(c.outcome));
    assert.equal(typeof c.detail, "string");
  }
  assert.equal(result.provenance.source, SRC);
  assert.equal(result.provenance.observedAt, AT);
  assert.equal(result.stateObserved, true);
  assert.equal(result.executionEstablished, false);
  assert.equal(result.stateAttributableToThisOperation, false);
  assert.equal(result.financialOutcomeEstablished, false);
  assert.ok(
    result.limitations.some((l) => /does not establish/i.test(l) && /attribut/i.test(l)),
    "the limitations state the attribution boundary in the result itself"
  );

  const actionLevel = verifyPostCommitState({ proposal: qtyProposal("item_b", 5) }, observe(snap(ITEMS_AFTER_QTY5)));
  assert.equal(actionLevel.coverage, "ACTION_LEVEL");
  assert.ok(
    actionLevel.limitations.some((l) => /action-level/i.test(l)),
    "narrower coverage is reported as narrower — never dressed as full-set verification"
  );
});

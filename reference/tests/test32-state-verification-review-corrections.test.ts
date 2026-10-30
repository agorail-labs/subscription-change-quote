import { test } from "node:test";
import assert from "node:assert/strict";
import type {
  ExpectedItemState,
  PostCommitObservedSnapshot,
  PostCommitStateExpectation,
  PostCommitStateObservation,
  SubscriptionChangeProposal,
} from "../src/core/types.js";
import { verifyPostCommitState } from "../src/core/state-verification.js";

// Test 32 — SCQ v0.6.2 PR-9 review corrections SV1–SV3.
//
// Written failing-first against PR #18 head 3bbf4ff:
//   SV1: FULL_ITEM_SET compared quantities and offerings as
//        independent per-identifier multisets, so a quantity /
//        offering pairing swap verified a configuration that does
//        not exist.
//   SV2: scheduled CANCEL verification ignored effective-time
//        semantics — any schedule verified TERM_END, and any
//        terminal state verified a future DATE (premature
//        termination included).
//   SV3: a null item entry reached `entry.id` unguarded in the
//        grouping pass and threw a TypeError instead of computing
//        UNVERIFIABLE.
//
// Local input shapes deliberately use casts at the fixture
// boundary: several cases are malformed provider data (null
// entries), which the static types rightly forbid but the hook's
// totality contract must survive at runtime. All data is
// synthetic; no provider is contacted.

const SRC = "test32 fixture: simulated post-commit provider read";
const AT = "2026-10-29T00:06:00.000Z";

type ScheduleInput = { kind?: "TERM_END" | "DATE" | "IMMEDIATE"; effectiveAt?: string };
type ExpectationInput = PostCommitStateExpectation & { termBoundaryAt?: string };

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
  extra: { itemsComplete?: boolean; cancellationSchedule?: ScheduleInput; observedAt?: string } = {}
): PostCommitStateObservation {
  const { observedAt, ...rest } = extra;
  return {
    snapshot,
    source: SRC,
    observedAt: observedAt ?? AT,
    ...rest,
  } as unknown as PostCommitStateObservation;
}

function verify(expectation: ExpectationInput, observation: PostCommitStateObservation) {
  return verifyPostCommitState(expectation as PostCommitStateExpectation, observation);
}

const qtyProposal = (itemId: string, quantity: number): SubscriptionChangeProposal => ({
  changes: [{ action: "CHANGE_QUANTITY", itemId, quantity }],
  effectiveIntent: { type: "IMMEDIATE" },
});

const cancelProposal = (intent: SubscriptionChangeProposal["effectiveIntent"]): SubscriptionChangeProposal => ({
  changes: [{ action: "CANCEL" }],
  effectiveIntent: intent,
});

// ---------------------------------------------------------------------------
// SV1 — full tuples, not independent quantity / offering lists
// ---------------------------------------------------------------------------

test("Test 32.1 (SV1): the quantity/offering pairing swap is a MISMATCH — neither expected tuple exists", () => {
  const result = verify(
    {
      proposal: qtyProposal("item_x", 1),
      expectedItems: [
        { id: "item_x", quantity: 1, offeringRef: "basic" },
        { id: "item_x", quantity: 2, offeringRef: "pro" },
      ],
    },
    observe(
      snap([
        { id: "item_x", quantity: 1, offeringRef: "pro" },
        { id: "item_x", quantity: 2, offeringRef: "basic" },
      ])
    )
  );
  assert.equal(result.verdict, "MISMATCH");
  assert.ok(
    result.contradictions.some((c) => /pairing|configuration/.test(c) && c.includes("item_x")),
    JSON.stringify(result.contradictions)
  );
});

test("Test 32.2 (SV1, control): identical tuples in a different order — VERIFIED", () => {
  const result = verify(
    {
      proposal: qtyProposal("item_x", 1),
      expectedItems: [
        { id: "item_x", quantity: 1, offeringRef: "basic" },
        { id: "item_x", quantity: 2, offeringRef: "pro" },
      ],
    },
    observe(
      snap([
        { id: "item_x", quantity: 2, offeringRef: "pro" },
        { id: "item_x", quantity: 1, offeringRef: "basic" },
      ])
    )
  );
  assert.equal(result.verdict, "VERIFIED");
  assert.deepEqual(result.contradictions, []);
});

test("Test 32.3 (SV1): duplicate identifier with matching independent quantity and offering lists but wrong pairings — MISMATCH", () => {
  // Quantities are [1, 1, 2] on both sides and offerings are
  // [basic, basic, pro] on both sides; only the PAIRINGS differ.
  const result = verify(
    {
      proposal: qtyProposal("item_x", 1),
      expectedItems: [
        { id: "item_x", quantity: 1, offeringRef: "basic" },
        { id: "item_x", quantity: 1, offeringRef: "pro" },
        { id: "item_x", quantity: 2, offeringRef: "basic" },
      ],
    },
    observe(
      snap([
        { id: "item_x", quantity: 1, offeringRef: "basic" },
        { id: "item_x", quantity: 2, offeringRef: "pro" },
        { id: "item_x", quantity: 1, offeringRef: "basic" },
      ])
    )
  );
  assert.equal(result.verdict, "MISMATCH");
  assert.ok(result.contradictions.some((c) => /pairing|configuration/.test(c)), JSON.stringify(result.contradictions));
});

test("Test 32.4 (SV1): a partial return containing a contradictory present tuple — MISMATCH, with the partial limitation recorded", () => {
  // The observed collection is partial and BELOW the expected
  // multiplicity for item_x, but the one present entry is a tuple
  // that exists nowhere in the expected set: (1, pro) pairs the
  // quantity of the basic entry with the offering of the qty-2
  // entry. A present-entry contradiction stands under the partial
  // rule; it must not be skipped for low multiplicity.
  const result = verify(
    {
      proposal: qtyProposal("item_x", 1),
      expectedItems: [
        { id: "item_x", quantity: 1, offeringRef: "basic" },
        { id: "item_x", quantity: 2, offeringRef: "pro" },
        { id: "item_y", quantity: 1, offeringRef: "extra" },
      ],
    },
    observe(snap([{ id: "item_x", quantity: 1, offeringRef: "pro" }]), { itemsComplete: false })
  );
  assert.equal(result.verdict, "MISMATCH");
  assert.ok(result.contradictions.some((c) => c.includes("item_x")), JSON.stringify(result.contradictions));
  assert.ok(
    result.limitations.some((l) => /partial/i.test(l)) ||
      result.checks.some((c) => c.outcome === "UNVERIFIABLE" && /partial/i.test(c.detail)),
    "the partial-return limitation is recorded alongside the contradiction"
  );
});

// ---------------------------------------------------------------------------
// SV2 — scheduled cancellation effective-time semantics
// ---------------------------------------------------------------------------

const TERM_BOUNDARY = "2026-11-01T00:00:00.000Z";
const OFF_TERM = "2026-10-15T00:00:00.000Z";
const FUTURE_DATE = "2026-11-15T00:00:00.000Z";

test("Test 32.5 (SV2): TERM_END with an arbitrary off-term scheduled date and no alignment evidence — NOT VERIFIED (UNVERIFIABLE)", () => {
  const result = verify(
    { proposal: cancelProposal({ type: "TERM_END" }) },
    observe(snap([], { status: "active" }), { cancellationSchedule: { effectiveAt: OFF_TERM } })
  );
  assert.equal(result.verdict, "UNVERIFIABLE");
  assert.ok(result.unverifiableDimensions.includes("state:cancellation"));
});

test("Test 32.6 (SV2): TERM_END with a schedule whose kind and time cannot be aligned — UNVERIFIABLE", () => {
  const result = verify(
    { proposal: cancelProposal({ type: "TERM_END" }) },
    observe(snap([], { status: "active" }), { cancellationSchedule: {} })
  );
  assert.equal(result.verdict, "UNVERIFIABLE");
  assert.ok(result.unverifiableDimensions.includes("state:cancellation"));
});

test("Test 32.7 (SV2): TERM_END schedule date contradicting the authorized term boundary — MISMATCH", () => {
  const result = verify(
    { proposal: cancelProposal({ type: "TERM_END" }), termBoundaryAt: TERM_BOUNDARY },
    observe(snap([], { status: "active" }), { cancellationSchedule: { effectiveAt: OFF_TERM } })
  );
  assert.equal(result.verdict, "MISMATCH");
  assert.ok(result.contradictions.some((c) => /term/i.test(c)), JSON.stringify(result.contradictions));
});

test("Test 32.8 (SV2, control): TERM_END with provider schedule-kind evidence — VERIFIED", () => {
  const result = verify(
    { proposal: cancelProposal({ type: "TERM_END" }) },
    observe(snap([], { status: "active" }), { cancellationSchedule: { kind: "TERM_END" } })
  );
  assert.equal(result.verdict, "VERIFIED");
  assert.ok(result.verifiedDimensions.includes("state:cancellation"));
});

test("Test 32.9 (SV2, control): TERM_END schedule effective at the authorized term boundary — VERIFIED", () => {
  const result = verify(
    { proposal: cancelProposal({ type: "TERM_END" }), termBoundaryAt: TERM_BOUNDARY },
    observe(snap([], { status: "active" }), { cancellationSchedule: { effectiveAt: TERM_BOUNDARY } })
  );
  assert.equal(result.verdict, "VERIFIED");
});

test("Test 32.10 (SV2): DATE in the future with an already-terminal state observed before that date — MISMATCH (premature termination)", () => {
  const result = verify(
    { proposal: cancelProposal({ type: "DATE", at: FUTURE_DATE }) },
    observe(snap([], { status: "cancelled" }), { observedAt: AT }) // AT (Oct 29) precedes FUTURE_DATE (Nov 15)
  );
  assert.equal(result.verdict, "MISMATCH");
  assert.ok(result.contradictions.some((c) => /premature/i.test(c)), JSON.stringify(result.contradictions));
});

test("Test 32.11 (SV2): DATE with an independently established cancellation time before the requested date — MISMATCH (premature)", () => {
  const result = verify(
    { proposal: cancelProposal({ type: "DATE", at: FUTURE_DATE }) },
    observe(snap([], { status: "cancelled" }), {
      cancellationSchedule: { kind: "DATE", effectiveAt: OFF_TERM },
      observedAt: "2026-11-20T00:00:00.000Z",
    })
  );
  assert.equal(result.verdict, "MISMATCH");
  assert.ok(result.contradictions.some((c) => /premature/i.test(c)), JSON.stringify(result.contradictions));
});

test("Test 32.12 (SV2): DATE terminal state carrying no cancellation time, read after the date — UNVERIFIABLE (premature cannot be distinguished from compliant)", () => {
  const result = verify(
    { proposal: cancelProposal({ type: "DATE", at: FUTURE_DATE }) },
    observe(snap([], { status: "cancelled" }), { observedAt: "2026-11-20T00:00:00.000Z" })
  );
  assert.equal(result.verdict, "UNVERIFIABLE");
  assert.ok(result.unverifiableDimensions.includes("state:cancellation"));
});

test("Test 32.13 (SV2, control): DATE terminal state with an established cancellation time equal to the requested date — VERIFIED", () => {
  const result = verify(
    { proposal: cancelProposal({ type: "DATE", at: FUTURE_DATE }) },
    observe(snap([], { status: "cancelled" }), {
      cancellationSchedule: { kind: "DATE", effectiveAt: FUTURE_DATE },
      observedAt: "2026-11-20T00:00:00.000Z",
    })
  );
  assert.equal(result.verdict, "VERIFIED");
});

test("Test 32.14 (SV2): TERM_END terminal state with no kind, boundary, or cancellation-time evidence — UNVERIFIABLE", () => {
  const result = verify(
    { proposal: cancelProposal({ type: "TERM_END" }) },
    observe(snap([], { status: "cancelled" }))
  );
  assert.equal(result.verdict, "UNVERIFIABLE");
  assert.ok(result.unverifiableDimensions.includes("state:cancellation"));
});

test("Test 32.15 (SV2): TERM_END terminal state with an established cancellation time before the authorized boundary — MISMATCH (premature)", () => {
  const result = verify(
    { proposal: cancelProposal({ type: "TERM_END" }), termBoundaryAt: TERM_BOUNDARY },
    observe(snap([], { status: "cancelled" }), {
      cancellationSchedule: { effectiveAt: OFF_TERM },
      observedAt: "2026-11-20T00:00:00.000Z",
    })
  );
  assert.equal(result.verdict, "MISMATCH");
  assert.ok(result.contradictions.some((c) => /premature/i.test(c)), JSON.stringify(result.contradictions));
});

test("Test 32.16 (SV2, control): TERM_END terminal state with provider term-end kind evidence — VERIFIED", () => {
  const result = verify(
    { proposal: cancelProposal({ type: "TERM_END" }) },
    observe(snap([], { status: "cancelled" }), { cancellationSchedule: { kind: "TERM_END" } })
  );
  assert.equal(result.verdict, "VERIFIED");
});

// ---------------------------------------------------------------------------
// SV3 — totality under malformed item entries
// ---------------------------------------------------------------------------

test("Test 32.17 (SV3): an observed item collection containing null — no throw, UNVERIFIABLE", () => {
  const items = [null] as unknown as PostCommitObservedSnapshot["items"];
  let result: ReturnType<typeof verifyPostCommitState> | undefined;
  assert.doesNotThrow(() => {
    result = verify(
      { proposal: qtyProposal("item_b", 5), expectedItems: [{ id: "item_b", quantity: 5 }] },
      observe(snap(items))
    );
  });
  assert.equal(result?.verdict, "UNVERIFIABLE");
  assert.ok(result?.unverifiableDimensions.includes("state:itemSet"));
});

test("Test 32.18 (SV3): a null entry alongside an entry establishing a contradiction — the contradiction still stands (MISMATCH)", () => {
  const items = [null, { id: "item_b", offeringRef: "addon:extra", quantity: 4 }] as unknown as PostCommitObservedSnapshot["items"];
  const result = verify(
    {
      proposal: qtyProposal("item_b", 5),
      expectedItems: [
        { id: "item_a", quantity: 1 },
        { id: "item_b", quantity: 5 },
      ],
    },
    observe(snap(items))
  );
  assert.equal(result.verdict, "MISMATCH");
  assert.ok(
    result.contradictions.some((c) => c === "quantity mismatch for item item_b: intended 5, actual 4"),
    JSON.stringify(result.contradictions)
  );
  assert.ok(result.unverifiableDimensions.includes("state:itemSet"), "the malformed entry is still reported unverifiable");
});

test("Test 32.19 (SV3): a null entry in the EXPECTED collection — no throw, UNVERIFIABLE", () => {
  const expectedItems = [null] as unknown as ExpectedItemState[];
  let result: ReturnType<typeof verifyPostCommitState> | undefined;
  assert.doesNotThrow(() => {
    result = verify(
      { proposal: qtyProposal("item_b", 5), expectedItems },
      observe(snap([{ id: "item_b", offeringRef: "addon:extra", quantity: 5 }]))
    );
  });
  assert.equal(result?.verdict, "UNVERIFIABLE");
  assert.ok(result?.unverifiableDimensions.includes("state:itemSet"));
});

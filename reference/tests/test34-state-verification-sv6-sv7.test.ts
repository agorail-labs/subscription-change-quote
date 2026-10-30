import { test } from "node:test";
import assert from "node:assert/strict";
import type {
  PostCommitObservedSnapshot,
  PostCommitStateExpectation,
  PostCommitStateObservation,
  SubscriptionChangeProposal,
} from "../src/core/types.js";
import { verifyPostCommitState } from "../src/core/state-verification.js";

// Test 34 — SCQ v0.6.2 PR-9 final review corrections SV6–SV7.
//
// Written failing-first against PR #18 head a79cb91 (the
// SV4–SV5 corrections round). SV1–SV5 are accepted and are NOT
// re-opened here.
//
//   SV6 (SV2 follow-up): a terminal DATE cancellation could
//        still be VERIFIED on schedule KIND evidence alone —
//        the terminal path fell through to "kind matches the
//        intent" whenever no established instant could be
//        compared, and the equal-instant branch verified even
//        when the established kind CONTRADICTED the DATE
//        intent. A DATE kind establishes the schedule TYPE, not
//        when the termination took effect: a Nov 15 DATE intent
//        read as cancelled on Nov 20 with {kind: "DATE"} and no
//        instant is consistent with a termination on Nov 1.
//        Terminal DATE verification now requires an
//        independently established cancellation instant equal
//        to the intended date AND no contradictory schedule
//        kind. (TERM_END kind evidence is different in kind: a
//        term-end attestation is the provider's own statement
//        that the termination is the term-end one, and its
//        accepted behavior is preserved.)
//   SV7 (SV5 follow-up): at ACTION_LEVEL, a target PRESENT and
//        agreeing could still be VERIFIED from a PARTIAL
//        collection (itemsComplete: false) — although the
//        unreturned portion could contain a conflicting
//        duplicate entry for the same item. SV5 withheld
//        VERIFIED beside UNIDENTIFIABLE entries for exactly
//        that reason; a partial return presents the same
//        unexcluded duplicate. The full-item-set path never
//        establishes VERIFIED from a partial collection; the
//        action-level item checks now match that discipline.
//        Established contradictions from present entries keep
//        precedence (MISMATCH).

const SRC = "test34 fixture: simulated post-commit provider read";
// A read time AFTER the authorized instants below (no SV4
// read-time prematurity is in play in the SV6 cases).
const LATE = "2026-11-20T00:00:00.000Z";
const AUTHORIZED = "2026-11-15T00:00:00.000Z";

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
    ...(observedAt === undefined ? {} : { observedAt }),
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

const planProposal = (itemId: string, offeringRef: string): SubscriptionChangeProposal => ({
  changes: [{ action: "CHANGE_PLAN", itemId, offeringRef }],
  effectiveIntent: { type: "IMMEDIATE" },
});

const cancelProposal = (intent: SubscriptionChangeProposal["effectiveIntent"]): SubscriptionChangeProposal => ({
  changes: [{ action: "CANCEL" }],
  effectiveIntent: intent,
});

// ---------------------------------------------------------------------------
// SV6 — terminal DATE verification requires an established
// cancellation instant equal to the intended date, and no
// contradictory schedule kind; kind evidence alone is not an
// effective date
// ---------------------------------------------------------------------------

test("Test 34.1 (SV6, counterexample): DATE terminal read AFTER the date, kind-only schedule (no effectiveAt) — UNVERIFIABLE, not VERIFIED (termination could have occurred Nov 1)", () => {
  const result = verify(
    { proposal: cancelProposal({ type: "DATE", at: AUTHORIZED }) },
    observe(snap([], { status: "cancelled" }), { cancellationSchedule: { kind: "DATE" }, observedAt: LATE })
  );
  assert.equal(result.verdict, "UNVERIFIABLE");
  assert.deepEqual(result.contradictions, []);
  assert.ok(result.unverifiableDimensions.includes("state:cancellation"));
});

test("Test 34.2 (SV6): DATE terminal with NO read time, kind-only schedule — UNVERIFIABLE (kind is not an instant, and no read-time evidence substitutes for one)", () => {
  const result = verify(
    { proposal: cancelProposal({ type: "DATE", at: AUTHORIZED }) },
    observe(snap([], { status: "cancelled" }), { cancellationSchedule: { kind: "DATE" } })
  );
  assert.equal(result.verdict, "UNVERIFIABLE");
  assert.deepEqual(result.contradictions, []);
  assert.ok(result.unverifiableDimensions.includes("state:cancellation"));
});

test("Test 34.3 (SV6): DATE terminal with an unparseable read time, kind-only schedule — UNVERIFIABLE (the corrected test33.7 shape, pinned standalone)", () => {
  const result = verify(
    { proposal: cancelProposal({ type: "DATE", at: AUTHORIZED }) },
    observe(snap([], { status: "cancelled" }), { cancellationSchedule: { kind: "DATE" }, observedAt: "not-a-timestamp" })
  );
  assert.equal(result.verdict, "UNVERIFIABLE");
  assert.deepEqual(result.contradictions, []);
});

test("Test 34.4 (SV6): DATE terminal with an established instant EQUAL to the date but a CONTRADICTORY kind (TERM_END) — UNVERIFIABLE, not VERIFIED", () => {
  // The instant matches the authorized date, so the effective
  // time is not contradicted; but the provider's kind evidence
  // classifies the schedule as a term-end schedule, not the
  // authorized DATE schedule. The two pieces of established
  // evidence disagree about which schedule the termination
  // belongs to, and neither can be preferred without inventing
  // a precedence — ambiguity, not an established contradiction
  // of the outcome — so the conservative verdict is
  // UNVERIFIABLE (see research/core-state-verification.md §12).
  const result = verify(
    { proposal: cancelProposal({ type: "DATE", at: AUTHORIZED }) },
    observe(snap([], { status: "cancelled" }), {
      cancellationSchedule: { kind: "TERM_END", effectiveAt: AUTHORIZED },
      observedAt: LATE,
    })
  );
  assert.equal(result.verdict, "UNVERIFIABLE");
  assert.deepEqual(result.contradictions, []);
  assert.ok(result.unverifiableDimensions.includes("state:cancellation"));
});

test("Test 34.5 (SV6, symmetric): TERM_END terminal with an established instant equal to the boundary but a CONTRADICTORY kind (DATE) — UNVERIFIABLE, not VERIFIED", () => {
  // The same evidence-inconsistency rule, applied symmetrically:
  // an equal instant does not rescue a kind that contradicts
  // the intent, for either scheduled intent.
  const result = verify(
    { proposal: cancelProposal({ type: "TERM_END" }), termBoundaryAt: AUTHORIZED },
    observe(snap([], { status: "cancelled" }), {
      cancellationSchedule: { kind: "DATE", effectiveAt: AUTHORIZED },
      observedAt: LATE,
    })
  );
  assert.equal(result.verdict, "UNVERIFIABLE");
  assert.deepEqual(result.contradictions, []);
  assert.ok(result.unverifiableDimensions.includes("state:cancellation"));
});

test("Test 34.6 (SV6): DATE terminal with an UNPARSEABLE established instant and DATE kind — UNVERIFIABLE (an unalignable instant is not an established one)", () => {
  const result = verify(
    { proposal: cancelProposal({ type: "DATE", at: AUTHORIZED }) },
    observe(snap([], { status: "cancelled" }), {
      cancellationSchedule: { kind: "DATE", effectiveAt: "not-a-date" },
      observedAt: LATE,
    })
  );
  assert.equal(result.verdict, "UNVERIFIABLE");
  assert.deepEqual(result.contradictions, []);
});

test("Test 34.7 (SV6, control): DATE terminal with an established instant equal to the date and matching DATE kind — VERIFIED", () => {
  const result = verify(
    { proposal: cancelProposal({ type: "DATE", at: AUTHORIZED }) },
    observe(snap([], { status: "cancelled" }), {
      cancellationSchedule: { kind: "DATE", effectiveAt: AUTHORIZED },
      observedAt: LATE,
    })
  );
  assert.equal(result.verdict, "VERIFIED");
  assert.ok(result.verifiedDimensions.includes("state:cancellation"));
});

test("Test 34.8 (SV6, control): DATE terminal with an established instant equal to the date and NO kind evidence — VERIFIED (the instant alone establishes the effective date)", () => {
  const result = verify(
    { proposal: cancelProposal({ type: "DATE", at: AUTHORIZED }) },
    observe(snap([], { status: "cancelled" }), {
      cancellationSchedule: { effectiveAt: AUTHORIZED },
      observedAt: LATE,
    })
  );
  assert.equal(result.verdict, "VERIFIED");
  assert.ok(result.verifiedDimensions.includes("state:cancellation"));
});

test("Test 34.9 (SV6, control): TERM_END terminal with kind evidence only (no boundary, no instant) — VERIFIED (the accepted TERM_END kind attestation is preserved)", () => {
  const result = verify(
    { proposal: cancelProposal({ type: "TERM_END" }) },
    observe(snap([], { status: "cancelled" }), { cancellationSchedule: { kind: "TERM_END" } })
  );
  assert.equal(result.verdict, "VERIFIED");
  assert.ok(result.verifiedDimensions.includes("state:cancellation"));
});

// ---------------------------------------------------------------------------
// SV7 — a present, agreeing target in a PARTIAL collection is
// not VERIFIED: the unreturned portion could contain a
// conflicting duplicate
// ---------------------------------------------------------------------------

test("Test 34.10 (SV7, counterexample): CHANGE_QUANTITY target present at the intended quantity in a PARTIAL collection — UNVERIFIABLE, not VERIFIED", () => {
  const result = verify(
    { proposal: qtyProposal("item_x", 5) },
    observe(snap([{ id: "item_x", offeringRef: "addon:extra", quantity: 5 }]), { itemsComplete: false })
  );
  assert.equal(result.verdict, "UNVERIFIABLE");
  assert.deepEqual(result.contradictions, []);
  assert.ok(result.unverifiableDimensions.includes("state:item:item_x:quantity"));
  assert.ok(
    result.checks.some((c) => c.outcome === "UNVERIFIABLE" && /partial/i.test(c.detail)),
    "the partial-return limitation is stated in the check detail"
  );
});

test("Test 34.11 (SV7): CHANGE_PLAN target present with the intended offering in a PARTIAL collection — UNVERIFIABLE, not VERIFIED", () => {
  const result = verify(
    { proposal: planProposal("item_a", "plan:pro") },
    observe(snap([{ id: "item_a", offeringRef: "plan:pro", quantity: 1 }]), { itemsComplete: false })
  );
  assert.equal(result.verdict, "UNVERIFIABLE");
  assert.deepEqual(result.contradictions, []);
  assert.ok(result.unverifiableDimensions.includes("state:item:item_a:offering"));
});

test("Test 34.12 (SV7): CHANGE_QUANTITY duplicate entries BOTH matching in a PARTIAL collection — still UNVERIFIABLE (agreement among returned entries does not exclude an unreturned conflicting entry)", () => {
  const result = verify(
    { proposal: qtyProposal("item_x", 5) },
    observe(
      snap([
        { id: "item_x", offeringRef: "addon:extra", quantity: 5 },
        { id: "item_x", offeringRef: "addon:extra", quantity: 5 },
      ]),
      { itemsComplete: false }
    )
  );
  assert.equal(result.verdict, "UNVERIFIABLE");
  assert.deepEqual(result.contradictions, []);
});

test("Test 34.13 (SV7, control): present matching target in a COMPLETE collection — VERIFIED for both CHANGE_QUANTITY and CHANGE_PLAN", () => {
  const qty = verify(
    { proposal: qtyProposal("item_x", 5) },
    observe(snap([{ id: "item_x", offeringRef: "addon:extra", quantity: 5 }]))
  );
  assert.equal(qty.verdict, "VERIFIED");

  const plan = verify(
    { proposal: planProposal("item_a", "plan:pro") },
    observe(snap([{ id: "item_a", offeringRef: "plan:pro", quantity: 1 }]))
  );
  assert.equal(plan.verdict, "VERIFIED");
});

test("Test 34.14 (SV7, control): CHANGE_PLAN present CONTRADICTION in a PARTIAL collection — MISMATCH (established contradictions keep precedence over the partial-return limit)", () => {
  const result = verify(
    { proposal: planProposal("item_a", "plan:pro") },
    observe(snap([{ id: "item_a", offeringRef: "plan:basic", quantity: 1 }]), { itemsComplete: false })
  );
  assert.equal(result.verdict, "MISMATCH");
  assert.ok(
    result.contradictions.some((c) => c === "offering mismatch for item item_a: intended plan:pro, actual plan:basic"),
    JSON.stringify(result.contradictions)
  );
});

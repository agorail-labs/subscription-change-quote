import { test } from "node:test";
import assert from "node:assert/strict";
import type {
  PostCommitObservedSnapshot,
  PostCommitStateExpectation,
  PostCommitStateObservation,
  SubscriptionChangeProposal,
} from "../src/core/types.js";
import { verifyPostCommitState } from "../src/core/state-verification.js";

// Test 33 — SCQ v0.6.2 PR-9 re-review corrections SV4–SV5.
//
// Written failing-first against PR #18 head 1dd215b (the
// SV1–SV3 corrections round). SV1 and the full-item-set half of
// SV3 are accepted and are NOT re-opened here.
//
//   SV4 (SV2 follow-up): in the TERMINAL scheduled-CANCEL path,
//        schedule-kind evidence and a stated schedule effectiveAt
//        were consulted BEFORE the read-time prematurity test, so
//        a subscription already terminal when read BEFORE the
//        authorized instant verified as the scheduled
//        cancellation whenever the schedule CLAIMED that future
//        date (or carried the matching kind). A future schedule
//        cannot explain an already-terminal subscription: the
//        earlier terminal observation takes precedence.
//   SV5 (SV3 follow-up): at ACTION_LEVEL, CHANGE_QUANTITY /
//        CHANGE_PLAN returned CONTRADICTED whenever the target
//        was absent from snapshot.items — even for a partial
//        return (itemsComplete: false), where the target may
//        merely be unreturned, and even when the collection
//        contained unidentifiable entries, one of which could BE
//        the target. Absence is a contradiction only from a
//        complete collection with no unidentified entries. The
//        same first-match lookup also let a contradictory
//        DUPLICATE entry for the target pass unnoticed.
//
// Local input shapes deliberately use casts at the fixture
// boundary for malformed provider data (null entries), which the
// static types rightly forbid but the hook's totality contract
// must survive at runtime. All data is synthetic; no provider is
// contacted.

const SRC = "test33 fixture: simulated post-commit provider read";
// The SV4 read time: BEFORE every authorized instant used below.
const EARLY = "2026-10-29T00:06:00.000Z";
// A read time at/after the authorized instants below.
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

function observeAt(
  snapshot: PostCommitObservedSnapshot | undefined,
  observedAt: string | undefined,
  extra: { itemsComplete?: boolean; cancellationSchedule?: ScheduleInput } = {}
): PostCommitStateObservation {
  return observe(snapshot, { ...extra, observedAt });
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
// SV4 — an earlier terminal observation takes precedence over any
// schedule claim in the terminal scheduled-CANCEL path
// ---------------------------------------------------------------------------

test("Test 33.1 (SV4, counterexample A): DATE terminal read BEFORE the authorized date, schedule claiming exactly that date — MISMATCH (premature), not VERIFIED", () => {
  const result = verify(
    { proposal: cancelProposal({ type: "DATE", at: AUTHORIZED }) },
    observeAt(snap([], { status: "cancelled" }), EARLY, {
      cancellationSchedule: { kind: "DATE", effectiveAt: AUTHORIZED },
    })
  );
  assert.equal(result.verdict, "MISMATCH");
  assert.ok(result.contradictions.some((c) => /premature/i.test(c)), JSON.stringify(result.contradictions));
});

test("Test 33.2 (SV4, counterexample B): DATE terminal read BEFORE the authorized date, kind-only schedule (no effectiveAt) — MISMATCH (premature), not VERIFIED", () => {
  // Kind evidence alone establishes nothing about WHEN the
  // termination took effect; it cannot rescue a terminal state
  // observed before the authorized date.
  const result = verify(
    { proposal: cancelProposal({ type: "DATE", at: AUTHORIZED }) },
    observeAt(snap([], { status: "cancelled" }), EARLY, { cancellationSchedule: { kind: "DATE" } })
  );
  assert.equal(result.verdict, "MISMATCH");
  assert.ok(result.contradictions.some((c) => /premature/i.test(c)), JSON.stringify(result.contradictions));
});

test("Test 33.3 (SV4, counterexample C): TERM_END terminal read BEFORE the authorized term boundary, kind-only schedule — MISMATCH (premature), not VERIFIED", () => {
  const result = verify(
    { proposal: cancelProposal({ type: "TERM_END" }), termBoundaryAt: AUTHORIZED },
    observeAt(snap([], { status: "cancelled" }), EARLY, { cancellationSchedule: { kind: "TERM_END" } })
  );
  assert.equal(result.verdict, "MISMATCH");
  assert.ok(result.contradictions.some((c) => /premature/i.test(c)), JSON.stringify(result.contradictions));
});

test("Test 33.4 (SV4): TERM_END terminal read BEFORE the boundary, schedule claiming exactly the boundary date — MISMATCH: a future schedule cannot explain an already-terminal subscription", () => {
  const result = verify(
    { proposal: cancelProposal({ type: "TERM_END" }), termBoundaryAt: AUTHORIZED },
    observeAt(snap([], { status: "cancelled" }), EARLY, {
      cancellationSchedule: { kind: "TERM_END", effectiveAt: AUTHORIZED },
    })
  );
  assert.equal(result.verdict, "MISMATCH");
  assert.ok(result.contradictions.some((c) => /premature/i.test(c)), JSON.stringify(result.contradictions));
});

test("Test 33.5 (SV4, control): DATE terminal read AFTER the authorized date with matching established schedule evidence — VERIFIED", () => {
  const result = verify(
    { proposal: cancelProposal({ type: "DATE", at: AUTHORIZED }) },
    observeAt(snap([], { status: "cancelled" }), LATE, {
      cancellationSchedule: { kind: "DATE", effectiveAt: AUTHORIZED },
    })
  );
  assert.equal(result.verdict, "VERIFIED");
  assert.ok(result.verifiedDimensions.includes("state:cancellation"));
});

test("Test 33.6 (SV4, control): TERM_END terminal read AFTER the authorized boundary with aligning evidence — VERIFIED (kind evidence; and established instant equal to the boundary)", () => {
  const byKind = verify(
    { proposal: cancelProposal({ type: "TERM_END" }), termBoundaryAt: AUTHORIZED },
    observeAt(snap([], { status: "cancelled" }), LATE, { cancellationSchedule: { kind: "TERM_END" } })
  );
  assert.equal(byKind.verdict, "VERIFIED");

  const byInstant = verify(
    { proposal: cancelProposal({ type: "TERM_END" }), termBoundaryAt: AUTHORIZED },
    observeAt(snap([], { status: "cancelled" }), LATE, {
      cancellationSchedule: { kind: "TERM_END", effectiveAt: AUTHORIZED },
    })
  );
  assert.equal(byInstant.verdict, "VERIFIED");
});

test("Test 33.7 (SV4): absent or unparseable observedAt — prematurity is NOT invented on the read-time ground", () => {
  // No read time at all: the established-instant equality is
  // independent effective-time evidence and still verifies.
  const absent = verify(
    { proposal: cancelProposal({ type: "DATE", at: AUTHORIZED }) },
    observe(snap([], { status: "cancelled" }), { cancellationSchedule: { kind: "DATE", effectiveAt: AUTHORIZED } })
  );
  assert.equal(absent.verdict, "VERIFIED", "absent observedAt: no read-time prematurity is invented");

  // An unparseable read time is not evidence of prematurity
  // either.
  //
  // SV6 CORRECTION (PR #18 final review round, head a79cb91):
  // this sub-case previously asserted VERIFIED here, on the
  // reasoning that "kind evidence decides" — that pinned
  // exactly the overclaim SV6 removes. Schedule KIND evidence
  // establishes the schedule TYPE, not when the termination
  // took effect; with no established cancellation instant, a
  // terminal DATE state cannot be verified as the authorized
  // DATE cancellation (the termination could predate the
  // intended date). The assertion is therefore corrected to
  // UNVERIFIABLE. This is a disclosed pre-existing test
  // modification: the fixture is unchanged, the expected
  // verdict changes because the behavior it pinned was the
  // defect under correction. The SV4 point of this test —
  // an unparseable read time invents no prematurity (no
  // MISMATCH) — is preserved and is now the assertion's focus.
  const unparseable = verify(
    { proposal: cancelProposal({ type: "DATE", at: AUTHORIZED }) },
    observeAt(snap([], { status: "cancelled" }), "not-a-timestamp", { cancellationSchedule: { kind: "DATE" } })
  );
  assert.equal(
    unparseable.verdict,
    "UNVERIFIABLE",
    "unparseable observedAt: no prematurity is invented, and kind-only DATE evidence establishes no effective instant (SV6)"
  );
  assert.deepEqual(unparseable.contradictions, []);

  // Absent read time AND no schedule evidence at all: the bare
  // terminal state stays UNVERIFIABLE, as before.
  const bare = verify(
    { proposal: cancelProposal({ type: "DATE", at: AUTHORIZED }) },
    observe(snap([], { status: "cancelled" }))
  );
  assert.equal(bare.verdict, "UNVERIFIABLE");
  assert.ok(bare.unverifiableDimensions.includes("state:cancellation"));
});

// ---------------------------------------------------------------------------
// SV5 — action-level absence is a contradiction only from a
// complete, fully identified collection; duplicate target entries
// must all agree
// ---------------------------------------------------------------------------

test("Test 33.8 (SV5): CHANGE_QUANTITY target absent from a PARTIAL collection — UNVERIFIABLE, not MISMATCH (the target may be unreturned)", () => {
  const result = verify(
    { proposal: qtyProposal("item_x", 5) },
    observe(snap([{ id: "item_other", offeringRef: "addon:other", quantity: 1 }]), { itemsComplete: false })
  );
  assert.equal(result.verdict, "UNVERIFIABLE");
  assert.deepEqual(result.contradictions, []);
  assert.ok(result.unverifiableDimensions.includes("state:item:item_x:quantity"));
});

test("Test 33.9 (SV5): CHANGE_QUANTITY target absent, collection claimed complete but containing a null entry — UNVERIFIABLE (the unidentifiable entry could be the target)", () => {
  const items = [null] as unknown as PostCommitObservedSnapshot["items"];
  let result: ReturnType<typeof verifyPostCommitState> | undefined;
  assert.doesNotThrow(() => {
    result = verify({ proposal: qtyProposal("item_x", 5) }, observe(snap(items)));
  });
  assert.equal(result?.verdict, "UNVERIFIABLE");
  assert.deepEqual(result?.contradictions, []);
  assert.ok(result?.unverifiableDimensions.includes("state:item:item_x:quantity"));
});

test("Test 33.10 (SV5, control): CHANGE_QUANTITY target absent from a complete, fully identified collection — MISMATCH (absence is established)", () => {
  const result = verify(
    { proposal: qtyProposal("item_x", 5) },
    observe(snap([{ id: "item_other", offeringRef: "addon:other", quantity: 1 }]))
  );
  assert.equal(result.verdict, "MISMATCH");
  assert.ok(
    result.contradictions.some((c) => c === "item item_x is absent from the observed post-commit state (intended quantity 5)"),
    JSON.stringify(result.contradictions)
  );
});

test("Test 33.11 (SV5): duplicate target entries, one matching and one contradicting — MISMATCH (a first-match VERIFIED must not ignore the contradictory duplicate)", () => {
  const result = verify(
    { proposal: qtyProposal("item_x", 5) },
    observe(
      snap([
        { id: "item_x", offeringRef: "addon:extra", quantity: 5 },
        { id: "item_x", offeringRef: "addon:extra", quantity: 3 },
      ])
    )
  );
  assert.equal(result.verdict, "MISMATCH");
  assert.ok(
    result.contradictions.some((c) => c === "quantity mismatch for item item_x: intended 5, actual 3"),
    JSON.stringify(result.contradictions)
  );
});

test("Test 33.12 (SV5, control): duplicate target entries that both match — VERIFIED (identical duplicates are consistent)", () => {
  const result = verify(
    { proposal: qtyProposal("item_x", 5) },
    observe(
      snap([
        { id: "item_x", offeringRef: "addon:extra", quantity: 5 },
        { id: "item_x", offeringRef: "addon:extra", quantity: 5 },
      ])
    )
  );
  assert.equal(result.verdict, "VERIFIED");
  assert.deepEqual(result.contradictions, []);
});

test("Test 33.13 (SV5): a matching target alongside an unidentifiable entry — UNVERIFIABLE (a contradictory duplicate of the target cannot be ruled out)", () => {
  const items = [null, { id: "item_x", offeringRef: "addon:extra", quantity: 5 }] as unknown as PostCommitObservedSnapshot["items"];
  const result = verify({ proposal: qtyProposal("item_x", 5) }, observe(snap(items)));
  assert.equal(result.verdict, "UNVERIFIABLE");
  assert.deepEqual(result.contradictions, []);
  assert.ok(result.unverifiableDimensions.includes("state:item:item_x:quantity"));
});

test("Test 33.14 (SV5): duplicate target entries where one carries no quantity — UNVERIFIABLE (not every entry for the target is verified)", () => {
  const items = [
    { id: "item_x", offeringRef: "addon:extra", quantity: 5 },
    { id: "item_x", offeringRef: "addon:extra" },
  ] as unknown as PostCommitObservedSnapshot["items"];
  const result = verify({ proposal: qtyProposal("item_x", 5) }, observe(snap(items)));
  assert.equal(result.verdict, "UNVERIFIABLE");
  assert.ok(result.unverifiableDimensions.includes("state:item:item_x:quantity"));
});

test("Test 33.15 (SV5, control): CHANGE_QUANTITY target present at the WRONG quantity in a partial collection — MISMATCH (present-entry contradictions stand)", () => {
  const result = verify(
    { proposal: qtyProposal("item_x", 5) },
    observe(snap([{ id: "item_x", offeringRef: "addon:extra", quantity: 3 }]), { itemsComplete: false })
  );
  assert.equal(result.verdict, "MISMATCH");
  assert.ok(result.contradictions.some((c) => c === "quantity mismatch for item item_x: intended 5, actual 3"));
});

test("Test 33.16 (SV5): CHANGE_PLAN target absent from a PARTIAL collection — UNVERIFIABLE, not MISMATCH", () => {
  const result = verify(
    { proposal: planProposal("item_a", "plan:pro") },
    observe(snap([{ id: "item_b", offeringRef: "addon:extra", quantity: 2 }]), { itemsComplete: false })
  );
  assert.equal(result.verdict, "UNVERIFIABLE");
  assert.deepEqual(result.contradictions, []);
  assert.ok(result.unverifiableDimensions.includes("state:item:item_a:offering"));
});

test("Test 33.17 (SV5): CHANGE_PLAN target absent, collection containing a null entry — UNVERIFIABLE, not MISMATCH", () => {
  const items = [null] as unknown as PostCommitObservedSnapshot["items"];
  const result = verify({ proposal: planProposal("item_a", "plan:pro") }, observe(snap(items)));
  assert.equal(result.verdict, "UNVERIFIABLE");
  assert.deepEqual(result.contradictions, []);
  assert.ok(result.unverifiableDimensions.includes("state:item:item_a:offering"));
});

test("Test 33.18 (SV5, control): CHANGE_PLAN target absent from a complete, fully identified collection — MISMATCH", () => {
  const result = verify(
    { proposal: planProposal("item_a", "plan:pro") },
    observe(snap([{ id: "item_b", offeringRef: "addon:extra", quantity: 2 }]))
  );
  assert.equal(result.verdict, "MISMATCH");
  assert.ok(
    result.contradictions.some((c) => c === "item item_a is absent from the observed post-commit state (intended offering plan:pro)"),
    JSON.stringify(result.contradictions)
  );
});

test("Test 33.19 (SV5): CHANGE_PLAN duplicate target entries, one matching and one contradicting — MISMATCH", () => {
  const result = verify(
    { proposal: planProposal("item_a", "plan:pro") },
    observe(
      snap([
        { id: "item_a", offeringRef: "plan:pro", quantity: 1 },
        { id: "item_a", offeringRef: "plan:basic", quantity: 1 },
      ])
    )
  );
  assert.equal(result.verdict, "MISMATCH");
  assert.ok(
    result.contradictions.some((c) => c === "offering mismatch for item item_a: intended plan:pro, actual plan:basic"),
    JSON.stringify(result.contradictions)
  );
});

test("Test 33.20 (SV5, control): CHANGE_PLAN duplicate target entries that both match — VERIFIED", () => {
  const result = verify(
    { proposal: planProposal("item_a", "plan:pro") },
    observe(
      snap([
        { id: "item_a", offeringRef: "plan:pro", quantity: 1 },
        { id: "item_a", offeringRef: "plan:pro", quantity: 1 },
      ])
    )
  );
  assert.equal(result.verdict, "VERIFIED");
  assert.deepEqual(result.contradictions, []);
});

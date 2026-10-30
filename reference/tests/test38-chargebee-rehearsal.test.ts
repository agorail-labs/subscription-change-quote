import { test } from "node:test";
import assert from "node:assert/strict";
import { runRehearsal, type RehearsalResult } from "../src/live/pilot/rehearsal.js";

// Test 38 — PR-11: mocked recovery rehearsal. The rehearsal drives
// the REAL DurableQuoteStore + DurableMutationCoordinator + live
// adapter over mocked Chargebee transports and temporary databases.
// It is procedural evidence only (SIMULATED): it never establishes a
// named operator's acceptance, never proves durable exactly-once
// provider execution, and never turns INDETERMINATE into a safe
// retry. Individual scenario invariants are asserted against the
// rehearsal's own per-scenario evidence.

let cached: RehearsalResult | undefined;
async function rehearsal(): Promise<RehearsalResult> {
  if (!cached) cached = await runRehearsal();
  return cached;
}

function scenario(r: RehearsalResult, id: string) {
  const s = r.scenarios.find((x) => x.id === id);
  assert.ok(s, `scenario ${id} present`);
  return s!;
}

test("Test 38.1: rehearsal completes with honestly classified evidence", async () => {
  const r = await rehearsal();
  assert.equal(r.evidenceClass, "SIMULATED_PASS");
  assert.ok(r.scenariosTotal >= 13, `expected at least 13 scenarios, got ${r.scenariosTotal}`);
  assert.equal(r.allPassed, true, JSON.stringify(r.scenarios.filter((s) => !s.pass), null, 2));
});

// PR-14 migration (Tests 38.2–38.4, 38.7–38.10): the adapter-level
// scenarios rh-01/02/03/06/07/08/09 previously rehearsed dispatch
// outcomes of the live adapter. PR-14's preservation gate refuses
// those commits pre-dispatch, so the scenarios now rehearse the
// refusal; scenario ids are retained for evidence continuity and
// these assertions state the CURRENT expected behavior. The
// INDETERMINATE ledger scenarios (38.5, 38.6, 38.14) are unchanged.

test("Test 38.2 (PR-14): the update commit refuses pre-dispatch — no dispatch, no attempt, no receipt; outcome CONFIRMED_NON_EXECUTION", async () => {
  const s = scenario(await rehearsal(), "rh-01-successful-dispatch");
  assert.equal(s.expectedOutcome, "CONFIRMED_NON_EXECUTION");
  assert.equal(s.observedOutcome, "CONFIRMED_NON_EXECUTION");
  assert.equal(s.pass, true);
  assert.match(s.evidence, /AUTHORIZATION_PRESERVATION_UNENFORCEABLE/);
  assert.match(s.evidence, /no dispatch was made/i);
});

test("Test 38.3 (PR-14): the preservation refusal is deterministic after restart — no receipt exists to replay, no second dispatch", async () => {
  const s = scenario(await rehearsal(), "rh-02-exact-receipt-replay");
  assert.equal(s.pass, true);
  assert.match(s.evidence, /mutation count 0/i);
});

test("Test 38.4 (PR-14): the armed lost-response fault is never exercised — a pre-dispatch refusal is CONFIRMED_NON_EXECUTION, never INDETERMINATE", async () => {
  const s = scenario(await rehearsal(), "rh-03-lost-response");
  assert.equal(s.expectedOutcome, "CONFIRMED_NON_EXECUTION");
  assert.equal(s.observedOutcome, "CONFIRMED_NON_EXECUTION");
  assert.equal(s.pass, true);
  assert.match(s.evidence, /no receipt/i);
  assert.match(s.evidence, /never exercised/i);
});

test("Test 38.5: crash after write-ahead intent recovers the attempt as INDETERMINATE and dispatch never ran", async () => {
  const s = scenario(await rehearsal(), "rh-04-crash-after-intent");
  assert.equal(s.pass, true);
  assert.match(s.evidence, /dispatch/i);
});

test("Test 38.6: crash after dispatch, before receipt persistence, is INDETERMINATE even though the provider-side effect occurred", async () => {
  const s = scenario(await rehearsal(), "rh-05-crash-after-dispatch");
  assert.equal(s.expectedOutcome, "INDETERMINATE");
  assert.equal(s.pass, true);
});

test("Test 38.7 (PR-14): the armed silent-ignore fault is never exercised — the refusal precedes any success-shaped response", async () => {
  const s = scenario(await rehearsal(), "rh-06-wrong-item-set");
  assert.equal(s.expectedOutcome, "CONFIRMED_NON_EXECUTION");
  assert.equal(s.observedOutcome, "CONFIRMED_NON_EXECUTION");
  assert.equal(s.pass, true);
});

test("Test 38.8 (PR-14): the provider-attached-item hazard class is removed by refusal — no landed set exists to violate reconciliation", async () => {
  const s = scenario(await rehearsal(), "rh-07-mandatory-addon");
  assert.equal(s.pass, true);
  assert.equal(s.observedOutcome, "CONFIRMED_NON_EXECUTION");
  assert.match(s.evidence, /AUTHORIZATION_PRESERVATION_UNENFORCEABLE/);
});

test("Test 38.9 (PR-14): the unknown-financials response class is unreachable — the refusal precedes dispatch", async () => {
  const s = scenario(await rehearsal(), "rh-08-unknown-financials");
  assert.equal(s.expectedOutcome, "CONFIRMED_NON_EXECUTION");
  assert.equal(s.observedOutcome, "CONFIRMED_NON_EXECUTION");
  assert.equal(s.pass, true);
});

test("Test 38.10 (PR-14): the post-commit envelope-violation class is unreachable — no committed receipt exists to violate", async () => {
  const s = scenario(await rehearsal(), "rh-09-envelope-violation");
  assert.equal(s.pass, true);
  assert.match(s.evidence, /AUTHORIZATION_PRESERVATION_UNENFORCEABLE/);
});

test("Test 38.11: concurrent attempts on the same subscription — the second is refused, exactly one attempt proceeds", async () => {
  const s = scenario(await rehearsal(), "rh-10-concurrent-same-subscription");
  assert.equal(s.pass, true);
  assert.match(s.evidence, /refused|blocked/i);
});

test("Test 38.12: idempotency-key conflict (same key, different request) is refused by the ledger", async () => {
  const s = scenario(await rehearsal(), "rh-11-idempotency-key-conflict");
  assert.equal(s.pass, true);
  assert.match(s.evidence, /refused/i);
});

test("Test 38.13: corrupted durable records refuse adoption — nothing is silently recovered", async () => {
  const s = scenario(await rehearsal(), "rh-12-corrupted-records");
  assert.equal(s.pass, true);
  assert.match(s.evidence, /corrupt|refus/i);
});

test("Test 38.14: operator review surfaces an unresolved attempt as requiring intervention — the report does not resolve it", async () => {
  const s = scenario(await rehearsal(), "rh-13-operator-review-unresolved");
  assert.equal(s.pass, true);
  assert.match(s.evidence, /intervention/i);
});

test("Test 38.15: a pre-effect provider rejection (documented param error) is CONFIRMED_NON_EXECUTION", async () => {
  const s = scenario(await rehearsal(), "rh-14-pre-effect-rejection");
  assert.equal(s.expectedOutcome, "CONFIRMED_NON_EXECUTION");
  assert.equal(s.observedOutcome, "CONFIRMED_NON_EXECUTION");
  assert.equal(s.pass, true);
});

test("Test 38.16: no scenario ever claims LIVE evidence", async () => {
  const r = await rehearsal();
  assert.ok(!JSON.stringify(r).includes("LIVE_PASS"), "mocked rehearsal evidence must never be labeled LIVE_PASS");
});

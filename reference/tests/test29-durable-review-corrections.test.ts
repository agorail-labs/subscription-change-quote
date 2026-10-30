import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCQError, type SubscriptionChangeReceipt } from "../src/core/types.js";
import { establishVerification } from "../src/store/quote-store.js";
import {
  DispatchBlockedError,
  DurableStoreError,
  DurableQuoteStore,
} from "../src/store/durable-store.js";
import { DurableMutationCoordinator } from "../src/store/mutation-coordinator.js";
import { ChargebeeClient, type HttpTransport } from "../src/live/chargebee-http.js";
import { ChargebeeLiveAdapter } from "../src/live/chargebee-scq-adapter.js";
import { PilotMockChargebee } from "../src/live/pilot/mock-transport.js";
import { makeObservation, makeReceipt, makeStoredQuote, makeUnverifiedReceipt } from "./helpers/durable-fixtures.js";

// Test 29 — PR-17 review corrections D1–D4. Each test is a
// regression for a path the owner's review reproduced against
// 55c8af2; they were written failing-first against that head.
// All databases are real temporary SQLite files; all provider
// traffic is the pilot mocked transport — SIMULATED_PASS at best.

function tmpDb(name = "scq.db"): string {
  const dir = mkdtempSync(join(tmpdir(), "scq-pr8-review-"));
  return join(dir, name);
}
function openStore(path: string, opts: Record<string, unknown> = {}): DurableQuoteStore {
  return new DurableQuoteStore(path, { recoveryGraceMs: 0, ...opts });
}
const INTENT = (quoteId = "q1", subscriptionId = "sub_1", key?: string) => ({
  quoteId,
  subscriptionId,
  provider: "chargebee",
  site: "test-site",
  request: { subscription_items: [{ item_price_id: "item_1", quantity: 2 }], replace_items_list: true },
  idempotencyKey: key ?? `scq-${quoteId}`,
  preDispatchFingerprint: "fp-1",
});

const SUB = "pilot-sub-001";
const ADDON = "pilot-addon-vision";
const PROPOSAL = (qty: number) => ({
  changes: [{ action: "CHANGE_QUANTITY" as const, itemId: ADDON, quantity: qty }],
  effectiveIntent: { type: "IMMEDIATE" as const },
  acceptanceEnvelope: {},
});
function pilotClient(mock: PilotMockChargebee): ChargebeeClient {
  return new ChargebeeClient({ site: "pilot-test", apiKey: "pilot-mock-key" }, mock.transport as HttpTransport);
}

// --- D1: a failed receipt persistence must never be replayed from memory -----

test("Test 29.1 (D1): recordCommitReceipt failing at beforePersist poisons the store — no read exposes the volatile receipt while the failed store is alive, and a reopen has no receipt", () => {
  const path = tmpDb();
  const store = openStore(path, {
    faults: { beforePersist: (op: string) => { if (op === "recordCommitReceipt") throw new Error("simulated pre-persist failure"); } },
  });
  store.put(makeStoredQuote("q1"));
  assert.throws(() => store.recordCommitReceipt("q1", makeReceipt("q1")), (e: unknown) => e instanceof DurableStoreError);
  assert.throws(() => store.recordedReceipt("q1"), (e: unknown) => e instanceof DurableStoreError, "replay read must fail closed, not serve the unpersisted receipt");
  assert.throws(() => store.get("q1"), (e: unknown) => e instanceof DurableStoreError, "get must not expose the volatile COMMITTED quote");
  assert.throws(() => store.all(), (e: unknown) => e instanceof DurableStoreError);
  store.close();
  const b = openStore(path);
  assert.equal(b.recordedReceipt("q1"), undefined, "the receipt was never persisted; a restart has nothing to replay");
  assert.notEqual(b.get("q1")?.status, "COMMITTED");
  b.close();
});

test("Test 29.2 (D1): recordCommitReceipt failing INSIDE the persist transaction — the volatile receipt is not readable from the failed store, and a reopen has no receipt", () => {
  const path = tmpDb();
  const store = openStore(path, {
    faults: { insidePersistTx: (op: string) => { if (op === "recordCommitReceipt") throw new Error("simulated mid-transaction failure"); } },
  });
  store.put(makeStoredQuote("q1"));
  assert.throws(() => store.recordCommitReceipt("q1", makeReceipt("q1")), (e: unknown) => e instanceof DurableStoreError);
  assert.throws(() => store.recordedReceipt("q1"), (e: unknown) => e instanceof DurableStoreError, "poisoning writes is not enough: replay reads must fail closed too");
  assert.throws(() => store.get("q1"), (e: unknown) => e instanceof DurableStoreError);
  store.close();
  const b = openStore(path);
  assert.equal(b.recordedReceipt("q1"), undefined);
  assert.notEqual(b.get("q1")?.status, "COMMITTED");
  b.close();
});

test("Test 29.3 (D1, adapter replay path): a commit whose receipt persistence fails cannot be replayed by a second commitChangeQuote on the failed store; after restart the unresolved attempt blocks any further mutation", async () => {
  // PR-14 MIGRATION: the original scenario drove a dispatched
  // commit whose RECEIPT recording failed mid-flow. The adapter no
  // longer dispatches, so the adapter-level durable write a commit
  // now performs is the preservation gate's outcome recording —
  // the fault is re-aimed at `recordCommitOutcome`, and every D1
  // protection is asserted in its new form: the persistence
  // failure surfaces (never absorbed), the poisoned store serves
  // no volatile record to a second commit (reads fail closed —
  // the §6.10-replay protection), nothing survives the restart,
  // no ledger attempt exists (the gate precedes the ledger), and
  // the reopened adapter's commit refuses at the gate with zero
  // mutations throughout. The receipt-recording failure semantics
  // themselves remain covered at the store level by 29.1/29.2.
  const path = tmpDb();
  const mock = new PilotMockChargebee();
  const store = new DurableQuoteStore(path, {
    recoveryGraceMs: 0,
    faults: { beforePersist: (op: string) => { if (op === "recordCommitOutcome") throw new Error("simulated disk failure at outcome recording"); } },
  });
  const adapter = new ChargebeeLiveAdapter(pilotClient(mock), store, {
    liveCommitEnabled: true,
    durableCoordinator: new DurableMutationCoordinator(store),
    providerSite: "pilot-test",
  });
  const quote = await adapter.createChangeQuote(SUB, PROPOSAL(21));
  await assert.rejects(
    () => adapter.commitChangeQuote(quote.id),
    (e: unknown) => e instanceof DurableStoreError,
    "the refusal's outcome-persistence failure surfaces from the commit as a store error — never silently absorbed",
  );
  assert.equal(mock.mutationCount, 0, "no dispatch occurred — the failure is at the gate's durable outcome write");
  await assert.rejects(
    () => adapter.commitChangeQuote(quote.id),
    (e: unknown) => e instanceof DurableStoreError,
    "a second commit must NOT be served volatile, unpersisted state — the poisoned store fails its reads closed",
  );
  assert.equal(mock.mutationCount, 0);
  store.close();

  const reopened = new DurableQuoteStore(path, { recoveryGraceMs: 0 });
  assert.equal(reopened.recordedReceipt(quote.id), undefined, "no fabricated receipt survives the restart");
  assert.equal(reopened.get(quote.id)?.commit_outcome, undefined, "the failed outcome recording was never persisted — a restart has nothing volatile to expose");
  assert.equal(reopened.attemptsForQuote(quote.id).length, 0, "no ledger attempt exists — the gate precedes the ledger");
  const reopenedAdapter = new ChargebeeLiveAdapter(pilotClient(mock), reopened, {
    liveCommitEnabled: true,
    durableCoordinator: new DurableMutationCoordinator(reopened),
    providerSite: "pilot-test",
  });
  await assert.rejects(
    () => reopenedAdapter.commitChangeQuote(quote.id),
    (e: unknown) => e instanceof SCQError && e.code === "AUTHORIZATION_PRESERVATION_UNENFORCEABLE",
    "the reopened adapter refuses at the preservation gate",
  );
  assert.equal(mock.mutationCount, 0, "no mutation after restart");
  reopened.close();
});

test("Test 29.4 (D1 audit): recordCommitOutcome write-through failures (both fault points) poison reads — the volatile outcome is not exposed while the failed store is alive, nor after reopen", () => {
  for (const faultPoint of ["beforePersist", "insidePersistTx"] as const) {
    const path = tmpDb();
    const faults = faultPoint === "beforePersist"
      ? { beforePersist: (op: string) => { if (op === "recordCommitOutcome") throw new Error("simulated failure"); } }
      : { insidePersistTx: (op: string) => { if (op === "recordCommitOutcome") throw new Error("simulated failure"); } };
    const store = openStore(path, { faults });
    store.put(makeStoredQuote("q1"));
    assert.throws(() => store.recordCommitOutcome("q1", { outcome: "INDETERMINATE" }), (e: unknown) => e instanceof DurableStoreError, faultPoint);
    assert.throws(() => store.get("q1"), (e: unknown) => e instanceof DurableStoreError, `${faultPoint}: get must not expose the volatile commit_outcome`);
    store.close();
    const b = openStore(path);
    assert.equal(b.get("q1")?.commit_outcome, undefined, faultPoint);
    b.close();
  }
});

test("Test 29.5 (D1 audit): verifyCommitReceipt write-through failures (both fault points) poison reads — the volatile verified view is not exposed while the failed store is alive; a reopen keeps the original unverified view", () => {
  for (const faultPoint of ["beforePersist", "insidePersistTx"] as const) {
    const path = tmpDb();
    const setup = openStore(path);
    setup.put(makeStoredQuote("q1"));
    setup.recordCommitReceipt("q1", makeUnverifiedReceipt("q1"));
    setup.close();
    const faults = faultPoint === "beforePersist"
      ? { beforePersist: (op: string) => { if (op === "verifyCommitReceipt") throw new Error("simulated failure"); } }
      : { insidePersistTx: (op: string) => { if (op === "verifyCommitReceipt") throw new Error("simulated failure"); } };
    const crashing = openStore(path, { faults });
    const evidence = establishVerification(crashing.get("q1")!, makeObservation());
    assert.throws(() => crashing.verifyCommitReceipt("q1", evidence), (e: unknown) => e instanceof DurableStoreError, faultPoint);
    assert.throws(() => crashing.get("q1"), (e: unknown) => e instanceof DurableStoreError, `${faultPoint}: the unverified→verified transition must not be visible from the failed store`);
    assert.throws(() => crashing.recordedReceipt("q1"), (e: unknown) => e instanceof DurableStoreError, faultPoint);
    crashing.close();
    const b = openStore(path);
    assert.equal(b.get("q1")?.commit_receipt?.outcome, "COMMITTED_UNVERIFIED", faultPoint);
    b.close();
  }
});

test("Test 29.6 (D1): recordAttemptReceipt failing at beforePersist — coordinator execute rejects, the volatile receipt is not replayable from the failed store, and a reopen recovers the attempt INDETERMINATE with no receipt", async () => {
  const path = tmpDb();
  const store = openStore(path, {
    faults: { beforePersist: (op: string) => { if (op === "recordAttemptReceipt") throw new Error("simulated failure"); } },
  });
  store.put(makeStoredQuote("q1"));
  const coordinator = new DurableMutationCoordinator(store);
  await assert.rejects(
    () => coordinator.execute(INTENT(), async () => ({ type: "receipt", receipt: makeReceipt("q1") })),
    (e: unknown) => e instanceof DurableStoreError,
  );
  assert.throws(() => store.recordedReceipt("q1"), (e: unknown) => e instanceof DurableStoreError);
  store.close();
  const b = openStore(path);
  assert.equal(b.recordedReceipt("q1"), undefined);
  assert.equal(b.attemptsForQuote("q1")[0].state, "INDETERMINATE");
  b.close();
});

test("Test 29.7 (D1): recordAttemptReceipt failing INSIDE its transaction — rollback (27.15) plus no volatile replay from the failed store while it is alive", async () => {
  const path = tmpDb();
  const store = openStore(path, {
    faults: { insidePersistTx: (op: string) => { if (op === "recordAttemptReceipt") throw new Error("simulated mid-transaction failure"); } },
  });
  store.put(makeStoredQuote("q1"));
  const coordinator = new DurableMutationCoordinator(store);
  await assert.rejects(
    () => coordinator.execute(INTENT(), async () => ({ type: "receipt", receipt: makeReceipt("q1") })),
    (e: unknown) => e instanceof DurableStoreError,
  );
  assert.throws(() => store.recordedReceipt("q1"), (e: unknown) => e instanceof DurableStoreError, "the receipt exists only in the failed store's memory; replay must fail closed");
  assert.throws(() => store.get("q1"), (e: unknown) => e instanceof DurableStoreError);
  store.close();
  const b = openStore(path);
  assert.equal(b.recordedReceipt("q1"), undefined);
  assert.equal(b.attemptsForQuote("q1")[0].state, "INDETERMINATE");
  b.close();
});

// --- D2: CONFIRMED_NON_EXECUTION re-dispatch must respect exclusion -----------

test("Test 29.8 (D2a): retrying a CONFIRMED_NON_EXECUTION attempt is BLOCKED while another quote's attempt on the same subscription is unresolved — zero additional dispatches", async () => {
  const path = tmpDb();
  const store = openStore(path);
  store.put(makeStoredQuote("q1", "sub_shared"));
  store.put(makeStoredQuote("q2", "sub_shared"));
  const coordinator = new DurableMutationCoordinator(store);
  // Q1's attempt demonstrably did not execute.
  const first = await coordinator.execute(INTENT("q1", "sub_shared", "key-q1"), async () => ({ type: "outcome", outcome: "CONFIRMED_NON_EXECUTION" }));
  assert.equal(first.type, "settled");
  assert.equal(store.attemptsForQuote("q1")[0].state, "CONFIRMED_NON_EXECUTION");
  // Q2's attempt on the SAME subscription is now DISPATCHING (unresolved).
  const attempt2 = store.beginDispatch(INTENT("q2", "sub_shared", "key-q2"));
  assert.equal(attempt2.state, "DISPATCHING");
  // Q1 retries with its ORIGINAL key + identical request: the
  // same-subscription exclusion must be re-checked before re-arming.
  let dispatches = 0;
  await assert.rejects(
    () => coordinator.execute(INTENT("q1", "sub_shared", "key-q1"), async () => { dispatches++; return { type: "outcome", outcome: "CONFIRMED_NON_EXECUTION" }; }),
    (e: unknown) => e instanceof DispatchBlockedError,
  );
  assert.equal(dispatches, 0, "no concurrent mutation of the subscription was authorized");
  assert.equal(store.attemptsForQuote("q1")[0].state, "CONFIRMED_NON_EXECUTION", "the blocked retry did not re-arm Q1's attempt");
  store.close();
});

test("Test 29.9 (D2b): the legitimate CONFIRMED_NON_EXECUTION retry succeeds once the other attempt on the subscription resolves", async () => {
  const path = tmpDb();
  const store = openStore(path);
  store.put(makeStoredQuote("q1", "sub_shared"));
  store.put(makeStoredQuote("q2", "sub_shared"));
  const coordinator = new DurableMutationCoordinator(store);
  await coordinator.execute(INTENT("q1", "sub_shared", "key-q1"), async () => ({ type: "outcome", outcome: "CONFIRMED_NON_EXECUTION" }));
  const attempt2 = store.beginDispatch(INTENT("q2", "sub_shared", "key-q2"));
  let dispatches = 0;
  await assert.rejects(
    () => coordinator.execute(INTENT("q1", "sub_shared", "key-q1"), async () => { dispatches++; return { type: "outcome", outcome: "CONFIRMED_NON_EXECUTION" }; }),
    (e: unknown) => e instanceof DispatchBlockedError,
  );
  assert.equal(dispatches, 0);
  // Q2's attempt resolves (also confirmed non-execution).
  store.recordAttemptOutcome(attempt2.attemptId, "CONFIRMED_NON_EXECUTION");
  // Now Q1's retry with its original key + identical request proceeds.
  const retried = await coordinator.execute(INTENT("q1", "sub_shared", "key-q1"), async () => {
    dispatches++;
    return { type: "receipt", receipt: makeReceipt("q1", "sub_shared") };
  });
  assert.equal(retried.type, "settled");
  assert.equal(dispatches, 1, "exactly one dispatch for the legitimate retry");
  const attempts = store.attemptsForQuote("q1");
  assert.equal(attempts.length, 1, "the retry re-arms the original attempt row — the key stays bound to the same request");
  assert.equal(attempts[0].state, "COMMITTED_AND_VERIFIED");
  store.close();
});

test("Test 29.10 (D2c): an idempotency key bound to one quote/subscription/site is never re-associated with another — collision under a different quote or a different site is refused", async () => {
  const path = tmpDb();
  const store = openStore(path);
  store.put(makeStoredQuote("q1"));
  store.put(makeStoredQuote("q3", "sub_3"));
  const coordinator = new DurableMutationCoordinator(store);
  await coordinator.execute(INTENT("q1", "sub_1", "shared-key"), async () => ({ type: "outcome", outcome: "CONFIRMED_NON_EXECUTION" }));
  // Same key + identical request, DIFFERENT quote/subscription/site.
  assert.throws(
    () => store.beginDispatch({ ...INTENT("q3", "sub_3", "shared-key"), site: "other-site" }),
    (e: unknown) => e instanceof DispatchBlockedError && /bound to a different/.test(e.message),
  );
  assert.equal(store.attemptsForQuote("q3").length, 0, "no attempt was created or re-associated for the colliding quote");
  assert.equal(store.attemptsForQuote("q1")[0].state, "CONFIRMED_NON_EXECUTION", "the original attempt was not re-armed by another quote's presentation of its key");
  // Same quote + key, DIFFERENT site: also a re-association, refused.
  assert.throws(
    () => store.beginDispatch({ ...INTENT("q1", "sub_1", "shared-key"), site: "other-site" }),
    (e: unknown) => e instanceof DispatchBlockedError && /bound to a different/.test(e.message),
  );
  // A COMMITTED attempt's key cannot be re-associated either.
  await coordinator.execute(INTENT("q1", "sub_1", "committed-key"), async () => ({ type: "receipt", receipt: makeReceipt("q1") }));
  assert.throws(
    () => store.beginDispatch(INTENT("q3", "sub_3", "committed-key")),
    (e: unknown) => e instanceof DispatchBlockedError && /bound to a different/.test(e.message),
  );
  assert.equal(store.attemptsForQuote("q1").find((a) => a.idempotencyKey === "committed-key")?.state, "COMMITTED_AND_VERIFIED");
  store.close();
});

// --- D3: recovery report attribution is derived from the recorded evidence ----

test("Test 29.11 (D3): a broken-bracket COMMITTED_UNVERIFIED receipt (PR #16 Z3 shape) is reported with stateAttributableToThisMutation = false", () => {
  const path = tmpDb();
  const store = openStore(path);
  store.put(makeStoredQuote("q1"));
  // The PR #16 broken-bracket shape (test 26.14a/b): the mutation's
  // own immediate actual survives, but an intervening write broke
  // the response→re-read fingerprint bracket, so NO recurring
  // figure is recorded as this commit's and the observed state is
  // explicitly unattributed context.
  const brokenBracket: SubscriptionChangeReceipt = makeReceipt("q1", "sub_1", {
    status: "COMMITTED_UNVERIFIED",
    outcome: "COMMITTED_UNVERIFIED",
    reconciliation: {
      status: "UNVERIFIED",
      reason: "the post-commit state is unattributed context: an intervening write broke the fingerprint bracket, so the observed recurring state is not established as this commit's effect",
      undeterminedDimensions: ["recurringFinancialEffect"],
    },
    committedEffect: {
      immediate: { charge: 1000, credit: undefined, net: 1000 },
      recurring: { currency: "usd" },
      determinacy: { immediateFinancialEffect: "DETERMINED", recurringFinancialEffect: "UNKNOWN" },
      provenance: {
        committedSource: "unestablished",
        recurring: "unestablished for this commit: attribution is broken (the response state's fingerprint does not equal the re-read state's), so no recurring figure is recorded for this commit",
      },
    },
  });
  store.recordCommitReceipt("q1", brokenBracket);
  const report = store.recoveryReport();
  const entry = report.unverifiedReceipts.find((r) => r.quoteId === "q1");
  assert.ok(entry, "the unverified receipt is enumerated");
  const established = entry.established as Record<string, unknown>;
  assert.equal(established.stateAttributableToThisMutation, false, "broken attribution must NOT be reported as attributable");
  assert.equal(established.mutationExecutionEstablished, true, "execution IS established — the receipt was recorded from the received response");
  assert.equal(established.financialResultEstablished, false);
  store.close();
});

test("Test 29.12 (D3 controls): attribution follows the recorded evidence — bound provider actuals report true; an effect with no establishing provenance reports explicit unknown", () => {
  const path = tmpDb();
  const store = openStore(path);
  store.put(makeStoredQuote("q1"));
  store.put(makeStoredQuote("q2", "sub_2"));
  // Unverified, but its figures are this operation's bound provider
  // actuals (the PR #11 candidate shape): attributable.
  store.recordCommitReceipt("q1", makeUnverifiedReceipt("q1"));
  // Unverified with NO provenance at all: attribution is genuinely
  // unknown and must be reported as such, never defaulted to true.
  const noProvenance = makeUnverifiedReceipt("q2", "sub_2");
  delete (noProvenance.committedEffect as { provenance?: unknown }).provenance;
  store.recordCommitReceipt("q2", noProvenance);
  const report = store.recoveryReport();
  const attributable = report.unverifiedReceipts.find((r) => r.quoteId === "q1");
  assert.equal((attributable?.established as Record<string, unknown>).stateAttributableToThisMutation, true);
  const unknown = report.unverifiedReceipts.find((r) => r.quoteId === "q2");
  assert.equal((unknown?.established as Record<string, unknown>).stateAttributableToThisMutation, "unknown", "absent evidence is reported as unknown, not defaulted to true");
  store.close();
});

// --- D4: durable store without its coordinator must refuse before dispatch ----

test("Test 29.13 (D4): a Chargebee adapter given a DurableQuoteStore and liveCommitEnabled but NO durableCoordinator refuses the commit before any mutating call", async () => {
  // PR-14 MIGRATION (refusal precedence): the preservation gate
  // sits ahead of the write-ahead gate by design, so a commit
  // through this misconfigured adapter now refuses with the
  // preservation code before beginDurableAttempt's coordinator
  // check is reached. D4's safety property is preserved verbatim —
  // the misconfiguration still results in refusal before any
  // mutating call, with zero attempts — and the DURABLE_COORDINATOR_
  // REQUIRED check remains implemented in beginDurableAttempt,
  // guarding the dispatch path for any future permitting
  // capability. What changed is only WHICH refusal fires first.
  const path = tmpDb();
  const mock = new PilotMockChargebee();
  const store = new DurableQuoteStore(path, { recoveryGraceMs: 0 });
  const adapter = new ChargebeeLiveAdapter(pilotClient(mock), store, { liveCommitEnabled: true });
  const quote = await adapter.createChangeQuote(SUB, PROPOSAL(21));
  await assert.rejects(
    () => adapter.commitChangeQuote(quote.id),
    (e: unknown) => e instanceof SCQError && e.code === "AUTHORIZATION_PRESERVATION_UNENFORCEABLE",
    "the earlier preservation gate refuses the commit (precedence over the coordinator check behind it)",
  );
  assert.equal(mock.mutationCount, 0, "no mutating call may occur without a write-ahead attempt");
  assert.equal(store.attemptsForQuote(quote.id).length, 0, "no attempt was created");
  store.close();
});

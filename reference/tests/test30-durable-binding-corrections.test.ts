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
import { QuoteStore } from "../src/store/quote-store.js";
import {
  DispatchBlockedError,
  DurableQuoteStore,
} from "../src/store/durable-store.js";
import { DurableMutationCoordinator } from "../src/store/mutation-coordinator.js";
import { ChargebeeClient, type HttpTransport } from "../src/live/chargebee-http.js";
import { ChargebeeLiveAdapter } from "../src/live/chargebee-scq-adapter.js";
import { PilotMockChargebee } from "../src/live/pilot/mock-transport.js";
import { makeStoredQuote } from "./helpers/durable-fixtures.js";

// Test 30 — PR-17 review correction D5: coordinator↔store binding
// and store-side quote association. D1–D4 (test29) are accepted and
// untouched. D5 closes the split-ledger configuration gap:
// beginDurableAttempt checked only that a coordinator was PRESENT
// (D4), not that it was bound to the adapter's own durable store;
// and DurableQuoteStore.beginDispatch accepted a write-ahead
// attempt for a quote the database does not hold. Together those
// allowed one database to record the dispatch intent while another
// recorded the receipt — each database individually coherent, the
// atomic intent↔receipt association void.
// Written failing-first against head 454de24. All databases are
// real temporary SQLite files; all provider traffic is the pilot
// mocked transport — SIMULATED_PASS at best.

function tmpDb(name = "scq.db"): string {
  const dir = trackTempDir(mkdtempSync(join(tmpdir(), "scq-pr8-d5-")));
  return join(dir, name);
}
function openStore(path: string): DurableQuoteStore {
  return new DurableQuoteStore(path, { recoveryGraceMs: 0 });
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

const isMismatchRefusal = (e: unknown): boolean =>
  e instanceof SCQError &&
  (e.details as { blocked?: string } | undefined)?.blocked === "DURABLE_COORDINATOR_STORE_MISMATCH";

// --- D5 (adapter binding): coordinator bound to a DIFFERENT durable store ---

test("Test 30.1 (D5): an adapter whose coordinator is bound to a different durable store refuses before any mutation, and the other database records zero orphan attempts", async () => {
  const pathA = tmpDb("a.db");
  const pathB = tmpDb("b.db");
  const mock = new PilotMockChargebee();
  const storeA = openStore(pathA);
  const storeB = openStore(pathB);
  // The quote is created — and durably stored — in Store A only,
  // through a correctly bound adapter.
  const setupAdapter = new ChargebeeLiveAdapter(pilotClient(mock), storeA, {
    liveCommitEnabled: true,
    durableCoordinator: new DurableMutationCoordinator(storeA),
    providerSite: "pilot-test",
  });
  const quote = await setupAdapter.createChangeQuote(SUB, PROPOSAL(21));

  // The misbound adapter: Store A (holds the quote) + a coordinator
  // bound to Store B (which has never seen the quote).
  const misbound = new ChargebeeLiveAdapter(pilotClient(mock), storeA, {
    liveCommitEnabled: true,
    durableCoordinator: new DurableMutationCoordinator(storeB),
    providerSite: "pilot-test",
  });
  // PR-14 MIGRATION (refusal precedence): the preservation gate
  // sits ahead of the write-ahead gate, so the misbound adapter's
  // commit refuses with the preservation code before the binding
  // check is reached. D5's safety properties are preserved
  // verbatim (refusal before any mutation; zero orphan attempts in
  // either database — asserted below), and the binding checks
  // remain implemented in beginDispatch/beginDurableAttempt and
  // exercised directly at the store/coordinator level by
  // 30.3/30.4/30.5.
  await assert.rejects(
    () => misbound.commitChangeQuote(quote.id),
    (e: unknown) => e instanceof SCQError && e.code === "AUTHORIZATION_PRESERVATION_UNENFORCEABLE",
    "the earlier preservation gate refuses the commit (precedence over the binding check behind it)",
  );
  assert.equal(mock.mutationCount, 0, "no mutating call may occur under a split-ledger configuration");
  assert.equal(storeB.attemptsForQuote(quote.id).length, 0, "Store B must contain zero orphan attempts for a quote it does not hold");
  assert.equal(storeB.recoveryReport().unresolvedAttempts.length, 0, "Store B's recovery report must show no unresolved attempt");
  assert.equal(storeA.attemptsForQuote(quote.id).length, 0, "Store A must contain no attempt either — the refusal precedes any beginDispatch");
  storeA.close();
  storeB.close();
});

test("Test 30.2 (D5): a coordinator bound to a plain in-memory QuoteStore, supplied to an adapter with a DurableQuoteStore, is refused before any mutation", async () => {
  const pathA = tmpDb("a.db");
  const mock = new PilotMockChargebee();
  const storeA = openStore(pathA);
  const setupAdapter = new ChargebeeLiveAdapter(pilotClient(mock), storeA, {
    liveCommitEnabled: true,
    durableCoordinator: new DurableMutationCoordinator(storeA),
    providerSite: "pilot-test",
  });
  const quote = await setupAdapter.createChangeQuote(SUB, PROPOSAL(21));

  // A coordinator constructed (via the cast a JavaScript consumer
  // could equally make) over a plain in-memory QuoteStore: the
  // durable-mode configuration must refuse it — its "ledger" would
  // authorize dispatches with no durable intent at all.
  const inMemoryCoordinator = new DurableMutationCoordinator(
    new QuoteStore() as unknown as DurableQuoteStore,
  );
  const misbound = new ChargebeeLiveAdapter(pilotClient(mock), storeA, {
    liveCommitEnabled: true,
    durableCoordinator: inMemoryCoordinator,
    providerSite: "pilot-test",
  });
  // PR-14 MIGRATION (refusal precedence): as 30.1 — the
  // preservation gate refuses before the binding check is reached;
  // the zero-mutation / zero-attempt properties below are D5's and
  // are preserved verbatim.
  await assert.rejects(
    () => misbound.commitChangeQuote(quote.id),
    (e: unknown) => e instanceof SCQError && e.code === "AUTHORIZATION_PRESERVATION_UNENFORCEABLE",
    "the earlier preservation gate refuses the commit (precedence over the binding check behind it)",
  );
  assert.equal(mock.mutationCount, 0, "no mutating call may occur with a non-durable coordinator store");
  assert.equal(storeA.attemptsForQuote(quote.id).length, 0);
  storeA.close();
});

// --- D5 (store-side association): beginDispatch validates the quote row ---

test("Test 30.3 (D5): beginDispatch for a quote that is not durably stored in this database is refused and records zero attempts", async () => {
  const store = openStore(tmpDb());
  assert.throws(
    () => store.beginDispatch(INTENT("ghost-quote")),
    (e: unknown) => e instanceof DispatchBlockedError && /not durably stored/.test(e.message),
    "an attempt for a quote this database does not hold must be refused",
  );
  assert.equal(store.attemptsForQuote("ghost-quote").length, 0, "the refusal must leave zero attempt rows");

  // Same refusal through the coordinator's execute path: the
  // dispatch function is never invoked.
  const coordinator = new DurableMutationCoordinator(store);
  let dispatches = 0;
  await assert.rejects(
    () => coordinator.execute(INTENT("ghost-quote", "sub_1", "ghost-key"), async () => { dispatches++; return { type: "outcome" as const, outcome: "CONFIRMED_NON_EXECUTION" as const }; }),
    (e: unknown) => e instanceof DispatchBlockedError && /not durably stored/.test(e.message),
  );
  assert.equal(dispatches, 0, "no dispatch may be authorized for an unstored quote");
  assert.equal(store.attemptsForQuote("ghost-quote").length, 0);
  store.close();
});

test("Test 30.4 (D5): beginDispatch whose subscription does not match the durably stored quote is refused and records zero attempts", () => {
  const store = openStore(tmpDb());
  store.put(makeStoredQuote("q1", "sub_1"));
  assert.throws(
    () => store.beginDispatch(INTENT("q1", "sub_other")),
    (e: unknown) => e instanceof DispatchBlockedError && /subscription/.test(e.message),
    "an intent naming a different subscription than the stored quote's must be refused",
  );
  assert.equal(store.attemptsForQuote("q1").length, 0, "the refusal must leave zero attempt rows");
  store.close();
});

test("Test 30.5 (D5): beginDispatch whose provider does not match the durably stored quote is refused and records zero attempts", () => {
  const store = openStore(tmpDb());
  store.put(makeStoredQuote("q1", "sub_1")); // fixture quote is provider "chargebee"
  assert.throws(
    () => store.beginDispatch({ ...INTENT("q1", "sub_1"), provider: "stripe" }),
    (e: unknown) => e instanceof DispatchBlockedError && /provider/.test(e.message),
    "an intent naming a different provider than the stored quote's must be refused",
  );
  assert.equal(store.attemptsForQuote("q1").length, 0, "the refusal must leave zero attempt rows");
  store.close();
});

// --- D5 positive control: the correctly bound configuration still commits ---

test("Test 30.6 (D5 control): a coordinator bound to the SAME DurableQuoteStore object as the adapter commits end-to-end under the write-ahead ledger", async () => {
  // PR-14 MIGRATION: the positive control's premise — a correctly
  // bound adapter committing end-to-end — is superseded for
  // OPERATION-authorized update commits: correct binding no longer
  // leads to a dispatch, because the preservation gate refuses
  // first. The control now proves the complementary fact: the
  // refusal is NOT a binding artifact — the correctly bound
  // configuration refuses identically, with zero attempts in the
  // shared database. End-to-end ledger behavior under correct
  // binding remains covered at the coordinator level (test27,
  // rh-04/05/10/11).
  const path = tmpDb();
  const mock = new PilotMockChargebee();
  const store = openStore(path);
  const coordinator = new DurableMutationCoordinator(store);
  const adapter = new ChargebeeLiveAdapter(pilotClient(mock), store, {
    liveCommitEnabled: true,
    durableCoordinator: coordinator,
    providerSite: "pilot-test",
  });
  const quote = await adapter.createChangeQuote(SUB, PROPOSAL(21));
  await assert.rejects(
    () => adapter.commitChangeQuote(quote.id),
    (e: unknown) => e instanceof SCQError && e.code === "AUTHORIZATION_PRESERVATION_UNENFORCEABLE",
    "even the correctly bound configuration refuses at the preservation gate",
  );
  assert.equal(mock.mutationCount, 0);
  assert.equal(store.attemptsForQuote(quote.id).length, 0, "no attempt was created in the shared database");
  store.close();
});

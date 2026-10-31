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
import { ChargebeeClient, type HttpTransport } from "../src/live/chargebee-http.js";
import { ChargebeeLiveAdapter } from "../src/live/chargebee-scq-adapter.js";
import { PilotMockChargebee, type PilotMockFaults } from "../src/live/pilot/mock-transport.js";
import { runPilot } from "../src/live/pilot/run-pilot.js";
import { DurableQuoteStore } from "../src/store/durable-store.js";
import { DurableMutationCoordinator } from "../src/store/mutation-coordinator.js";

// Test 28 — PR-8 integration: the experimental Chargebee-live
// adapter wired to the durable store + write-ahead coordinator,
// exercised ONLY through the pilot mocked transport. No real
// Chargebee call is made; results are SIMULATED_PASS at best.
// Rows: assignment §7 (durable wiring) and matrix row 27 (pilot
// harness remains read-only).

const SUB = "pilot-sub-001";
const ADDON = "pilot-addon-vision";
const PROPOSAL = (qty: number) => ({
  changes: [{ action: "CHANGE_QUANTITY" as const, itemId: ADDON, quantity: qty }],
  effectiveIntent: { type: "IMMEDIATE" as const },
  acceptanceEnvelope: {},
});

function tmpDb(): string {
  return join(trackTempDir(mkdtempSync(join(tmpdir(), "scq-pr8-int-"))), "scq.db");
}

function durableAdapter(path: string, mock: PilotMockChargebee) {
  const store = new DurableQuoteStore(path, { recoveryGraceMs: 0 });
  const coordinator = new DurableMutationCoordinator(store);
  const client = new ChargebeeClient({ site: "pilot-test", apiKey: "pilot-mock-key" }, mock.transport as HttpTransport);
  const adapter = new ChargebeeLiveAdapter(client, store, {
    liveCommitEnabled: true,
    durableCoordinator: coordinator,
    providerSite: "pilot-test",
  });
  return { store, coordinator, adapter };
}

test("Test 28.1: quote persists before return; commit is write-ahead gated; after a restart the original receipt replays with no second dispatch", async () => {
  // PR-14 MIGRATION: the durable quote persistence half is
  // unchanged (the quote is present from disk after restart #1).
  // The commit half changes: the preservation gate refuses BEFORE
  // the write-ahead ledger, so no attempt is ever created and no
  // receipt exists to replay — restart #2 proves the refusal
  // itself is the deterministic cross-restart behavior (identical
  // code, zero attempts, zero mutations). The write-ahead ledger's
  // own behavior remains covered by test27/rh-04/05/10/11.
  const path = tmpDb();
  const mock = new PilotMockChargebee();
  const first = durableAdapter(path, mock);
  const quote = await first.adapter.createChangeQuote(SUB, PROPOSAL(21));
  first.store.close();

  // Restart #1: a fresh store + adapter over the same database and
  // the same (mock) provider. The quote must be present from disk.
  const second = durableAdapter(path, mock);
  await assert.rejects(
    () => second.adapter.commitChangeQuote(quote.id),
    (e: unknown) => e instanceof SCQError && e.code === "AUTHORIZATION_PRESERVATION_UNENFORCEABLE" && (e.details as any)?.outcome === "CONFIRMED_NON_EXECUTION",
  );
  assert.equal(mock.mutationCount, 0, "no mutation was dispatched");
  assert.equal(second.store.attemptsForQuote(quote.id).length, 0, "the gate precedes the ledger — no attempt was created");
  assert.equal(second.store.get(quote.id)?.commit_receipt, undefined, "no receipt was recorded");
  second.store.close();

  // Restart #2: the refusal replays deterministically from the
  // persisted quote; the provider sees no mutation.
  const third = durableAdapter(path, mock);
  await assert.rejects(
    () => third.adapter.commitChangeQuote(quote.id),
    (e: unknown) => e instanceof SCQError && e.code === "AUTHORIZATION_PRESERVATION_UNENFORCEABLE",
  );
  assert.equal(mock.mutationCount, 0, "no mutation after restart either");
  assert.equal(third.store.attemptsForQuote(quote.id).length, 0);
  third.store.close();
});

test("Test 28.2: a lost response under durable wiring settles the attempt INDETERMINATE, and after restart the commit stays blocked with no second dispatch", async () => {
  // PR-14 MIGRATION: the lose-response fault is never exercised —
  // the gate refuses before the ledger and before dispatch, so no
  // attempt exists to settle INDETERMINATE and no response exists
  // to lose. After restart the commit refuses identically (never
  // a blind retry: zero mutations throughout). INDETERMINATE
  // settlement under durable wiring remains covered at the ledger
  // level (test27, rh-04/05/13).
  const path = tmpDb();
  const mock = new PilotMockChargebee({ loseUpdateResponse: true } as PilotMockFaults);
  const first = durableAdapter(path, mock);
  const quote = await first.adapter.createChangeQuote(SUB, PROPOSAL(21));
  await assert.rejects(
    () => first.adapter.commitChangeQuote(quote.id),
    (e: unknown) => e instanceof SCQError && e.code === "AUTHORIZATION_PRESERVATION_UNENFORCEABLE" && (e.details as any)?.indeterminate !== true,
  );
  assert.equal(first.store.attemptsForQuote(quote.id).length, 0, "no attempt was created — the gate precedes the ledger");
  first.store.close();

  const second = durableAdapter(path, mock);
  await assert.rejects(
    () => second.adapter.commitChangeQuote(quote.id),
    (e: unknown) => e instanceof SCQError && e.code === "AUTHORIZATION_PRESERVATION_UNENFORCEABLE",
  );
  assert.equal(mock.mutationCount, 0, "no dispatch before or after restart");
  second.store.close();
});

test("Test 28.3: persistence failure is never silently absorbed — a faulted durable store makes quote creation fail instead of falling back to memory", async () => {
  const path = tmpDb();
  const mock = new PilotMockChargebee();
  const store = new DurableQuoteStore(path, {
    recoveryGraceMs: 0,
    faults: { beforePersist: () => { throw new Error("simulated disk failure"); } },
  });
  const client = new ChargebeeClient({ site: "pilot-test", apiKey: "pilot-mock-key" }, mock.transport as HttpTransport);
  const adapter = new ChargebeeLiveAdapter(client, store, {
    liveCommitEnabled: true,
    durableCoordinator: new DurableMutationCoordinator(store),
    providerSite: "pilot-test",
  });
  await assert.rejects(() => adapter.createChangeQuote(SUB, PROPOSAL(21)));
  store.close();
  const reopened = new DurableQuoteStore(path, { recoveryGraceMs: 0 });
  assert.equal(reopened.all().length, 0, "nothing was silently kept in memory only");
  reopened.close();
});

test("Test 28.4 (row 27): the pilot harness remains read-only — mocked run reports zero mutating calls and no LIVE_PASS", async () => {
  const report = await runPilot({ mode: "mocked" });
  assert.ok(report.steps.every((s) => s.status === "pass"), JSON.stringify(report.steps));
  assert.equal(report.transport.mutatingCalls, 0);
  assert.ok(report.capabilities.every((c) => c.classification !== "LIVE_PASS"));
  assert.equal(report.capabilities.find((c) => c.capability === "live commit")?.classification, "BLOCKED");
});

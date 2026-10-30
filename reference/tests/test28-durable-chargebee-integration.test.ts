import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  return join(mkdtempSync(join(tmpdir(), "scq-pr8-int-")), "scq.db");
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
  const path = tmpDb();
  const mock = new PilotMockChargebee();
  const first = durableAdapter(path, mock);
  const quote = await first.adapter.createChangeQuote(SUB, PROPOSAL(21));
  first.store.close();

  // Restart #1: a fresh store + adapter over the same database and
  // the same (mock) provider. The quote must be present from disk.
  const second = durableAdapter(path, mock);
  const receipt = await second.adapter.commitChangeQuote(quote.id);
  assert.equal(receipt.outcome, "COMMITTED_AND_VERIFIED");
  assert.equal(mock.mutationCount, 1);
  const attempts = second.store.attemptsForQuote(quote.id);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].state, "COMMITTED_AND_VERIFIED");
  assert.equal(attempts[0].site, "pilot-test");
  assert.ok(attempts[0].requestHash.length === 64);
  second.store.close();

  // Restart #2: replay serves the ORIGINAL receipt from disk; the
  // provider sees no second mutation.
  const third = durableAdapter(path, mock);
  const replayed = await third.adapter.commitChangeQuote(quote.id);
  assert.deepEqual(replayed, receipt);
  assert.equal(mock.mutationCount, 1, "replay after restart dispatched nothing");
  third.store.close();
});

test("Test 28.2: a lost response under durable wiring settles the attempt INDETERMINATE, and after restart the commit stays blocked with no second dispatch", async () => {
  const path = tmpDb();
  const mock = new PilotMockChargebee({ loseUpdateResponse: true } as PilotMockFaults);
  const first = durableAdapter(path, mock);
  const quote = await first.adapter.createChangeQuote(SUB, PROPOSAL(21));
  await assert.rejects(() => first.adapter.commitChangeQuote(quote.id), /INDETERMINATE/);
  assert.equal(first.store.attemptsForQuote(quote.id)[0].state, "INDETERMINATE");
  first.store.close();

  const second = durableAdapter(path, mock);
  await assert.rejects(() => second.adapter.commitChangeQuote(quote.id), /INDETERMINATE/);
  assert.equal(mock.mutationCount, 1, "no blind retry after restart");
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

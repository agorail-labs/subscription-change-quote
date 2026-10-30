import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChargebeeClient, type HttpTransport } from "../src/live/chargebee-http.js";
import { ChargebeeLiveAdapter } from "../src/live/chargebee-scq-adapter.js";
import { PilotMockChargebee } from "../src/live/pilot/mock-transport.js";
import { DurableQuoteStore } from "../src/store/durable-store.js";
import { DurableMutationCoordinator } from "../src/store/mutation-coordinator.js";
import { QuoteOriginManifest, quoteOriginDigest } from "../src/live/pilot/quote-origin.js";
import { createRealPreflightTransport, runPreflight, type PreflightInput, type PreflightReport } from "../src/live/pilot/preflight.js";
import { main as preflightCliMain } from "../src/live/pilot/run-preflight.js";

// Test 40 — PR #20 review corrections PF3 (origin manifest mechanics)
// and PF1 (structural transport provenance), failing-first round.
// Pre-correction this file does not compile: the quote-origin module
// and the internally constructed real-transport factory do not exist
// (TS2307/TS2305) — disclosed as the module-missing class of
// failing-first, alongside test39's behavioral failures.

const SUB = "pilot-sub-001";
const ADDON = "pilot-addon-vision";
const SITE = "pilot-test";
const PROPOSAL = (qty: number) => ({
  changes: [{ action: "CHANGE_QUANTITY" as const, itemId: ADDON, quantity: qty }],
  effectiveIntent: { type: "IMMEDIATE" as const },
  acceptanceEnvelope: {},
});

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "scq-pr20-origin-"));
}

type Fixture = { path: string; quoteId: string; mock: PilotMockChargebee; manifest: QuoteOriginManifest };

/** Canonical fixture whose quote origin IS recorded at issuance, as the corrected CLI does. */
async function buildBoundFixture(): Promise<Fixture> {
  const dir = tmpDir();
  const path = join(dir, "scq.db");
  const mock = new PilotMockChargebee();
  const store = new DurableQuoteStore(path, { recoveryGraceMs: 0 });
  const client = new ChargebeeClient({ site: SITE, apiKey: "pilot-mock-key" }, mock.transport as HttpTransport);
  const adapter = new ChargebeeLiveAdapter(client, store, {
    liveCommitEnabled: false,
    durableCoordinator: new DurableMutationCoordinator(store),
    providerSite: SITE,
  });
  const quote = await adapter.createChangeQuote(SUB, PROPOSAL(21));
  const manifest = new QuoteOriginManifest(join(dir, "scq.db.origins.jsonl"));
  manifest.record({ stored: store.get(quote.id)!, site: SITE, recordedBy: "test40 fixture issuance" });
  store.close();
  return { path, quoteId: quote.id, mock, manifest };
}

function openStore(path: string): DurableQuoteStore {
  return new DurableQuoteStore(path, { recoveryGraceMs: 0 });
}

function baseInput(fx: Fixture, store: DurableQuoteStore, over: Partial<PreflightInput> = {}): PreflightInput {
  return {
    quoteId: fx.quoteId,
    store,
    transport: fx.mock.transport as HttpTransport,
    site: SITE,
    approvedSite: SITE,
    apiKey: "pilot-mock-key",
    operatorAttestation: { testTenantAttested: true, attestedBy: "test-operator (synthetic)" },
    env: {},
    originManifest: fx.manifest,
    ...over,
  };
}

function checkStatus(report: PreflightReport, id: string): string | undefined {
  return report.checks.find((c) => c.id === id)?.status;
}

// ---------------------------------------------------------------------------
// Manifest mechanics
// ---------------------------------------------------------------------------

test("Test 40.1: the origin manifest is append-only, persists, and its digest matches the stored quote", async () => {
  const fx = await buildBoundFixture();
  const manifestPath = join(tmpDir(), "origins.jsonl");
  void manifestPath;
  const onDisk = readFileSync(join(fx.path + ".origins.jsonl"), "utf8").trim().split("\n");
  assert.equal(onDisk.length, 1, "one issuance appends exactly one record");
  const reloaded = QuoteOriginManifest.load(fx.manifest.filePath!);
  assert.equal(reloaded.corrupt, false);
  const records = reloaded.recordsFor(fx.quoteId);
  assert.equal(records.length, 1);
  assert.equal(records[0].site, SITE);
  assert.equal(records[0].subscriptionId, SUB);
  const store = openStore(fx.path);
  assert.equal(records[0].quoteDigest, quoteOriginDigest(store.get(fx.quoteId)!), "the record's digest is the ledger-canonical digest of the stored quote at issuance");
  store.close();
});

// ---------------------------------------------------------------------------
// PF3 — origin binding in the preflight
// ---------------------------------------------------------------------------

test("Test 40.2 (PF3 positive control): a properly bound origin establishes binding — in simulated classification only", async () => {
  const fx = await buildBoundFixture();
  const store = openStore(fx.path);
  const report = await runPreflight(baseInput(fx, store));
  store.close();
  assert.equal(checkStatus(report, "quote_origin_binding"), "pass");
  assert.equal(report.durableReadiness.originBinding, "ESTABLISHED");
  assert.equal(report.durableReadiness.siteBindingOk, true, "site binding is derived from the issuance record, not from a duplicated caller assertion");
  assert.equal(report.durableReadiness.subscriptionMatch, true);
  // Binding does not launder provenance: the run is still injected.
  assert.equal(report.evidence.transportOrigin, "injected");
  assert.equal(report.conditions.find((c) => c.condition === 3)!.status, "UNVERIFIED");
  assert.ok(!JSON.stringify(report).includes("LIVE_PASS"));
  assert.deepEqual(report.blockers, [], JSON.stringify(report.checks.filter((c) => c.status === "blocker"), null, 2));
});

test("Test 40.3 (PF3): cross-site replay — quote issued on another site, subscription id and fingerprint coinciding — blocks", async () => {
  const dir = tmpDir();
  const path = join(dir, "scq.db");
  const mock = new PilotMockChargebee();
  const store0 = new DurableQuoteStore(path, { recoveryGraceMs: 0 });
  const client = new ChargebeeClient({ site: SITE, apiKey: "pilot-mock-key" }, mock.transport as HttpTransport);
  const adapter = new ChargebeeLiveAdapter(client, store0, {
    liveCommitEnabled: false,
    durableCoordinator: new DurableMutationCoordinator(store0),
    providerSite: SITE,
  });
  const quote = await adapter.createChangeQuote(SUB, PROPOSAL(21));
  // The quote was issued while the configured site was other-test;
  // the preflight now runs against pilot-test with the SAME
  // subscription id and the SAME resource fingerprint.
  const manifest = new QuoteOriginManifest(join(dir, "origins.jsonl"));
  manifest.record({ stored: store0.get(quote.id)!, site: "other-test", recordedBy: "test40 cross-site fixture" });
  store0.close();
  const store = openStore(path);
  const report = await runPreflight({
    quoteId: quote.id, store, transport: mock.transport as HttpTransport,
    site: SITE, approvedSite: SITE, apiKey: "pilot-mock-key",
    operatorAttestation: { testTenantAttested: true }, env: {}, originManifest: manifest,
  });
  store.close();
  assert.equal(checkStatus(report, "quote_origin_binding"), "blocker");
  assert.equal(report.durableReadiness.originBinding, "MISMATCH");
  assert.equal(report.durableReadiness.siteBindingOk, false);
  assert.equal(report.overall, "NO-GO");
});

test("Test 40.4 (PF3): an origin record whose digest no longer matches the stored quote blocks", async () => {
  const fx = await buildBoundFixture();
  const store = openStore(fx.path);
  const q = store.get(fx.quoteId) as any;
  q.provider_preview_input = { ...q.provider_preview_input, items: q.provider_preview_input.items.map((i: any) => (i.itemPriceId === ADDON ? { ...i, quantity: 22 } : i)) };
  store.put(q);
  const report = await runPreflight(baseInput(fx, store));
  store.close();
  assert.equal(checkStatus(report, "quote_origin_binding"), "blocker", "a stored quote altered after issuance no longer matches its origin record");
  assert.equal(report.durableReadiness.originBinding, "MISMATCH");
});

test("Test 40.5 (PF3): two conflicting origin records for one quote are ambiguous and block", async () => {
  const fx = await buildBoundFixture();
  const store = openStore(fx.path);
  // Fixture-mechanics change (PF3 hardening, note §11): the writer
  // is now once-only per quote and REFUSES a second record() for the
  // same quote id, so the conflicting record is introduced by raw
  // file append — the read path must still block on it (conflict
  // rule + digest/chain verification). Assertions unchanged.
  const lines = readFileSync(fx.manifest.filePath!, "utf8").trim().split("\n");
  const conflict = { ...(JSON.parse(lines[0]) as Record<string, unknown>), site: "other-test" };
  appendFileSync(fx.manifest.filePath!, JSON.stringify(conflict) + "\n");
  const conflicted = QuoteOriginManifest.load(fx.manifest.filePath!);
  const report = await runPreflight(baseInput(fx, store, { originManifest: conflicted }));
  store.close();
  assert.equal(checkStatus(report, "quote_origin_binding"), "blocker");
  assert.equal(report.durableReadiness.originBinding, "MISMATCH");
});

test("Test 40.6 (PF3): a corrupt origin manifest fails closed", async () => {
  const fx = await buildBoundFixture();
  const corruptPath = join(tmpDir(), "origins.jsonl");
  writeFileSync(corruptPath, "{not json\n");
  const corrupt = QuoteOriginManifest.load(corruptPath);
  assert.equal(corrupt.corrupt, true);
  const store = openStore(fx.path);
  const report = await runPreflight(baseInput(fx, store, { originManifest: corrupt }));
  store.close();
  assert.equal(checkStatus(report, "quote_origin_binding"), "blocker");
  assert.equal(report.durableReadiness.originBinding, "MISMATCH");
  assert.equal(report.overall, "NO-GO");
});

// ---------------------------------------------------------------------------
// PF1 — structural provenance
// ---------------------------------------------------------------------------

test("Test 40.7 (PF1): a forged 'real transport' handle is refused — only the internal factory's construction is LIVE-eligible", async () => {
  const fx = await buildBoundFixture();
  const store = openStore(fx.path);
  const forgedHandle = { transport: fx.mock.transport as HttpTransport, log: [] } as any;
  await assert.rejects(
    () => runPreflight(baseInput(fx, store, { transport: undefined, realTransport: forgedHandle })),
    /createRealPreflightTransport|internally constructed/i,
    "a caller-assembled handle must not be accepted as the real-network transport",
  );
  store.close();
});

test("Test 40.8 (PF1): the genuine internally constructed transport is 'real' — but absent attestation still bars Condition 3", { timeout: 90000 }, async () => {
  const fx = await buildBoundFixture();
  const store = openStore(fx.path);
  const report = await runPreflight(baseInput(fx, store, {
    transport: undefined,
    realTransport: createRealPreflightTransport(),
    operatorAttestation: undefined,
  }));
  store.close();
  assert.equal(report.evidence.transportOrigin, "real", "provenance derives from the internal construction");
  const cond3 = report.conditions.find((c) => c.condition === 3)!;
  assert.notEqual(cond3.status, "PASS", "real-mode construction without test-tenant attestation never passes Condition 3");
  assert.match(cond3.reason, /attestation/i);
  assert.equal(report.overall, "NO-GO");
});

// ---------------------------------------------------------------------------
// CLI participation — the normal path exercises binding (no null-by-default)
// ---------------------------------------------------------------------------

test("Test 40.9: the default mocked CLI run records origin at issuance and reports an established binding", { timeout: 120000 }, async () => {
  const outDir = tmpDir();
  const code = await preflightCliMain(["--out", outDir]);
  assert.equal(code, 0);
  assert.ok(existsSync(join(outDir, "preflight.json")));
  const report = JSON.parse(readFileSync(join(outDir, "preflight.json"), "utf8"));
  assert.equal(report.durableReadiness.originBinding, "ESTABLISHED", "the normal CLI path binds the fixture quote's origin — no null-by-default");
  assert.equal(report.durableReadiness.siteBindingOk, true);
  assert.equal(report.evidence.transportOrigin, "injected", "the CLI's caller-supplied mocked transport is injected/simulated evidence");
  assert.equal(report.overall, "NO-GO");
  assert.ok(!JSON.stringify(report).includes("LIVE_PASS"));
});

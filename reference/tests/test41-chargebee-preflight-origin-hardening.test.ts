import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChargebeeClient, type HttpTransport } from "../src/live/chargebee-http.js";
import { ChargebeeLiveAdapter } from "../src/live/chargebee-scq-adapter.js";
import { PilotMockChargebee } from "../src/live/pilot/mock-transport.js";
import { DurableQuoteStore } from "../src/store/durable-store.js";
import { DurableMutationCoordinator } from "../src/store/mutation-coordinator.js";
import { QuoteOriginManifest, quoteOriginDigest } from "../src/live/pilot/quote-origin.js";
import { runPreflight, type PreflightInput, type PreflightReport } from "../src/live/pilot/preflight.js";

// Test 41 — PF3 hardening (PR #20 re-review requirement): the
// quote-origin manifest must be created at quote issuance AND
// protected against later substitution. At fce79d3 the record's own
// fields are not digest-bound (the record's `site` can be edited in
// the JSONL line and every check stays green), the writer accepts a
// second record for the same quote id, and the file carries no
// integrity chain. Written failing-first against fce79d3:
//   - 41.1 (site substitution) FAILS pre-fix on the merits: binding
//     wrongly ESTABLISHES for the substituted site.
//   - 41.4 (one-time writer) FAILS pre-fix: record() does not throw.
//   - 41.6 / 41.7 (deletion / reorder) FAIL pre-fix: the tampering
//     is invisible and the surviving record still binds.
//   - 41.8 (v1 record) FAILS pre-fix: a version-1 record is trusted.
//   - 41.2 / 41.3 / 41.5 / 41.9 are CONTROLS: they already block /
//     hold pre-fix (via the quote-digest comparison, the
//     record-belongs-to-quote check, the conflict rule, and the
//     preflight's read-only use of the manifest) and must keep
//     doing so.
//   - 41.10 is the positive control: binding assertions hold
//     pre-fix; the v2 integrity-field assertions are new-format
//     checks that cannot pass pre-fix by construction.

const SUB = "pilot-sub-001";
const ADDON = "pilot-addon-vision";
const SITE = "pilot-test";
const OTHER_SITE = "other-test";
const PROPOSAL = (qty: number) => ({
  changes: [{ action: "CHANGE_QUANTITY" as const, itemId: ADDON, quantity: qty }],
  effectiveIntent: { type: "IMMEDIATE" as const },
  acceptanceEnvelope: {},
});

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "scq-pr20-origin-hardening-"));
}

type Fixture = { path: string; quoteId: string; mock: PilotMockChargebee; manifest: QuoteOriginManifest };

/** Canonical fixture whose quote origin IS recorded at issuance (as in test40). */
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
  manifest.record({ stored: store.get(quote.id)!, site: SITE, recordedBy: "test41 fixture issuance" });
  store.close();
  return { path, quoteId: quote.id, mock, manifest };
}

type TwoQuoteFixture = { path: string; manifestPath: string; quoteId1: string; quoteId2: string; mock: PilotMockChargebee };

/** Two quotes issued into ONE manifest (two chained issuance records). */
async function buildTwoQuoteFixture(): Promise<TwoQuoteFixture> {
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
  const manifestPath = join(dir, "scq.db.origins.jsonl");
  const manifest = new QuoteOriginManifest(manifestPath);
  const q1 = await adapter.createChangeQuote(SUB, PROPOSAL(21));
  manifest.record({ stored: store.get(q1.id)!, site: SITE, recordedBy: "test41 fixture issuance (first)" });
  const q2 = await adapter.createChangeQuote(SUB, PROPOSAL(22));
  manifest.record({ stored: store.get(q2.id)!, site: SITE, recordedBy: "test41 fixture issuance (second)" });
  store.close();
  return { path, manifestPath, quoteId1: q1.id, quoteId2: q2.id, mock };
}

function openStore(path: string): DurableQuoteStore {
  return new DurableQuoteStore(path, { recoveryGraceMs: 0 });
}

function baseInput(fx: { quoteId: string; mock: PilotMockChargebee; manifest: QuoteOriginManifest }, store: DurableQuoteStore, over: Partial<PreflightInput> = {}): PreflightInput {
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

/** Rewrites the manifest file with `fn` applied to its parsed lines, returns the path. */
function rewriteManifestLines(manifestPath: string, fn: (lines: Record<string, unknown>[]) => Record<string, unknown>[]): string {
  const lines = readFileSync(manifestPath, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
  writeFileSync(manifestPath, fn(lines).map((l) => JSON.stringify(l)).join("\n") + "\n");
  return manifestPath;
}

// ---------------------------------------------------------------------------
// The substitution attack (GAP 1) — must FAIL pre-fix on the merits
// ---------------------------------------------------------------------------

test("Test 41.1 (PF3 hardening): site substitution in a written line (A→B) does NOT establish binding for site B", async () => {
  const fx = await buildBoundFixture();
  // The quote was issued on pilot-test. An attacker (or a careless
  // operator) edits the manifest line after issuance so the record
  // claims the quote originated on other-test, then runs the
  // preflight configured for the approved site other-test with the
  // same (coinciding) subscription id.
  const tamperedPath = rewriteManifestLines(fx.manifest.filePath!, (lines) => {
    lines[0].site = OTHER_SITE;
    return lines;
  });
  const tampered = QuoteOriginManifest.load(tamperedPath);
  const store = openStore(fx.path);
  const report = await runPreflight(baseInput(fx, store, {
    site: OTHER_SITE,
    approvedSite: OTHER_SITE,
    originManifest: tampered,
  }));
  store.close();
  assert.equal(tampered.corrupt, true, "a record whose fields were edited after issuance must fail integrity verification");
  assert.equal(checkStatus(report, "quote_origin_binding"), "blocker",
    "substituting the record's site must block, not establish binding for the substituted site");
  assert.notEqual(report.durableReadiness.originBinding, "ESTABLISHED");
  assert.equal(report.durableReadiness.siteBindingOk, false);
  assert.notEqual(report.conditions.find((c) => c.condition === 3)!.status, "PASS");
  assert.equal(report.overall, "NO-GO");
});

test("Test 41.2 (PF3 hardening, control): quoteDigest substitution in a written line blocks", async () => {
  const fx = await buildBoundFixture();
  const tamperedPath = rewriteManifestLines(fx.manifest.filePath!, (lines) => {
    lines[0].quoteDigest = "f".repeat(64);
    return lines;
  });
  const tampered = QuoteOriginManifest.load(tamperedPath);
  const store = openStore(fx.path);
  const report = await runPreflight(baseInput(fx, store, { originManifest: tampered }));
  store.close();
  assert.equal(checkStatus(report, "quote_origin_binding"), "blocker");
  assert.notEqual(report.durableReadiness.originBinding, "ESTABLISHED");
  assert.equal(report.overall, "NO-GO");
});

test("Test 41.3 (PF3 hardening, control): subscriptionId substitution in a written line blocks", async () => {
  const fx = await buildBoundFixture();
  const tamperedPath = rewriteManifestLines(fx.manifest.filePath!, (lines) => {
    lines[0].subscriptionId = "pilot-sub-999";
    return lines;
  });
  const tampered = QuoteOriginManifest.load(tamperedPath);
  const store = openStore(fx.path);
  const report = await runPreflight(baseInput(fx, store, { originManifest: tampered }));
  store.close();
  assert.equal(checkStatus(report, "quote_origin_binding"), "blocker");
  assert.notEqual(report.durableReadiness.originBinding, "ESTABLISHED");
  assert.equal(report.overall, "NO-GO");
});

// ---------------------------------------------------------------------------
// One-time writer (GAP 2) — must FAIL pre-fix
// ---------------------------------------------------------------------------

test("Test 41.4 (PF3 hardening): the writer refuses a second record for the same quote id (issuance is once-only)", async () => {
  const fx = await buildBoundFixture();
  const store = openStore(fx.path);
  assert.throws(
    () => fx.manifest.record({ stored: store.get(fx.quoteId)!, site: OTHER_SITE, recordedBy: "test41 substitution-by-append attempt" }),
    /already|once-only/i,
    "substitution-by-append must be refused at write time, not merely blocked at read",
  );
  store.close();
  assert.equal(fx.manifest.recordsFor(fx.quoteId).length, 1, "the refused append leaves the original record alone");
  const onDisk = readFileSync(fx.manifest.filePath!, "utf8").trim().split("\n");
  assert.equal(onDisk.length, 1, "the refused append writes nothing to the manifest file");
});

test("Test 41.5 (PF3 hardening, control): a conflicting record appended by raw file edit still blocks at read", async () => {
  const fx = await buildBoundFixture();
  const lines = readFileSync(fx.manifest.filePath!, "utf8").trim().split("\n");
  const conflict = { ...(JSON.parse(lines[0]) as Record<string, unknown>), site: OTHER_SITE };
  appendFileSync(fx.manifest.filePath!, JSON.stringify(conflict) + "\n");
  const reloaded = QuoteOriginManifest.load(fx.manifest.filePath!);
  const store = openStore(fx.path);
  const report = await runPreflight(baseInput(fx, store, { originManifest: reloaded }));
  store.close();
  assert.equal(checkStatus(report, "quote_origin_binding"), "blocker");
  assert.equal(report.durableReadiness.originBinding, "MISMATCH");
  assert.equal(report.overall, "NO-GO");
});

// ---------------------------------------------------------------------------
// Hash chain (GAP 3) — deletion / reorder must FAIL pre-fix
// ---------------------------------------------------------------------------

test("Test 41.6 (PF3 hardening): deleting a non-final line breaks the chain — the surviving record no longer binds", async () => {
  const fx = await buildTwoQuoteFixture();
  // Delete the FIRST quote's record; the second quote's record is
  // untouched and, pre-fix, still binds — the deletion is invisible.
  const tamperedPath = rewriteManifestLines(fx.manifestPath, (lines) => lines.slice(1));
  const tampered = QuoteOriginManifest.load(tamperedPath);
  assert.equal(tampered.corrupt, true, "a broken hash chain must mark the manifest corrupt");
  const store = openStore(fx.path);
  const report = await runPreflight({
    quoteId: fx.quoteId2,
    store,
    transport: fx.mock.transport as HttpTransport,
    site: SITE,
    approvedSite: SITE,
    apiKey: "pilot-mock-key",
    operatorAttestation: { testTenantAttested: true, attestedBy: "test-operator (synthetic)" },
    env: {},
    originManifest: tampered,
  });
  store.close();
  assert.equal(checkStatus(report, "quote_origin_binding"), "blocker");
  assert.notEqual(report.durableReadiness.originBinding, "ESTABLISHED");
  assert.equal(report.overall, "NO-GO");
});

test("Test 41.7 (PF3 hardening): reordering lines breaks the chain and blocks", async () => {
  const fx = await buildTwoQuoteFixture();
  const tamperedPath = rewriteManifestLines(fx.manifestPath, (lines) => [lines[1], lines[0]]);
  const tampered = QuoteOriginManifest.load(tamperedPath);
  assert.equal(tampered.corrupt, true, "reordered records must fail chain verification");
  const store = openStore(fx.path);
  const report = await runPreflight({
    quoteId: fx.quoteId1,
    store,
    transport: fx.mock.transport as HttpTransport,
    site: SITE,
    approvedSite: SITE,
    apiKey: "pilot-mock-key",
    operatorAttestation: { testTenantAttested: true, attestedBy: "test-operator (synthetic)" },
    env: {},
    originManifest: tampered,
  });
  store.close();
  assert.equal(checkStatus(report, "quote_origin_binding"), "blocker");
  assert.notEqual(report.durableReadiness.originBinding, "ESTABLISHED");
  assert.equal(report.overall, "NO-GO");
});

// ---------------------------------------------------------------------------
// Version policy — v1 records are untrustworthy
// ---------------------------------------------------------------------------

test("Test 41.8 (PF3 hardening): a version-1 origin record fails closed", async () => {
  const fx = await buildBoundFixture();
  const store = openStore(fx.path);
  const v1Path = join(tmpDir(), "origins-v1.jsonl");
  const v1Record = {
    kind: "scq-quote-origin",
    version: 1,
    quoteId: fx.quoteId,
    provider: "chargebee",
    site: SITE,
    subscriptionId: SUB,
    quoteDigest: quoteOriginDigest(store.get(fx.quoteId)!),
    recordedAt: new Date().toISOString(),
    recordedBy: "test41 hand-built v1 record",
  };
  writeFileSync(v1Path, JSON.stringify(v1Record) + "\n");
  const v1Manifest = QuoteOriginManifest.load(v1Path);
  assert.equal(v1Manifest.corrupt, true, "version-1 records predate digest/chain binding and are untrustworthy");
  const report = await runPreflight(baseInput(fx, store, { originManifest: v1Manifest }));
  store.close();
  assert.equal(checkStatus(report, "quote_origin_binding"), "blocker");
  assert.notEqual(report.durableReadiness.originBinding, "ESTABLISHED");
  assert.equal(report.overall, "NO-GO");
});

// ---------------------------------------------------------------------------
// Consumption stays read-only (control)
// ---------------------------------------------------------------------------

test("Test 41.9 (PF3 hardening, control): a preflight run leaves the manifest file byte-identical", async () => {
  const fx = await buildBoundFixture();
  const manifestPath = fx.manifest.filePath!;
  const before = readFileSync(manifestPath);
  const loaded = QuoteOriginManifest.load(manifestPath);
  const store = openStore(fx.path);
  const report = await runPreflight(baseInput(fx, store, { originManifest: loaded }));
  store.close();
  assert.equal(checkStatus(report, "quote_origin_binding"), "pass");
  const after = readFileSync(manifestPath);
  assert.ok(before.equals(after), "the preflight only LOADS the manifest — it never records, appends, or rewrites");
});

// ---------------------------------------------------------------------------
// Positive control — legitimate untouched issuance record binds end-to-end
// ---------------------------------------------------------------------------

test("Test 41.10 (PF3 hardening, positive control): an untouched v2 issuance record binds end-to-end (simulated classification only)", async () => {
  const fx = await buildBoundFixture();
  const reloaded = QuoteOriginManifest.load(fx.manifest.filePath!);
  assert.equal(reloaded.corrupt, false, "an untouched manifest verifies: self-digests and chain intact");
  const records = reloaded.recordsFor(fx.quoteId);
  assert.equal(records.length, 1);
  const rec = records[0] as unknown as Record<string, unknown>;
  assert.equal(rec.version, 2);
  assert.equal(typeof rec.recordDigest, "string", "the record carries a self-digest over its complete content");
  assert.ok((rec.recordDigest as string).length > 0);
  assert.equal(typeof rec.prevRecordDigest, "string", "the record carries its hash-chain link");
  assert.ok((rec.prevRecordDigest as string).length > 0);
  const store = openStore(fx.path);
  const report = await runPreflight(baseInput(fx, store, { originManifest: reloaded }));
  store.close();
  assert.equal(checkStatus(report, "quote_origin_binding"), "pass");
  assert.equal(report.durableReadiness.originBinding, "ESTABLISHED");
  assert.equal(report.durableReadiness.siteBindingOk, true);
  assert.equal(report.durableReadiness.subscriptionMatch, true);
  // Binding never launders provenance: still simulated evidence.
  assert.equal(report.evidence.transportOrigin, "injected");
  assert.ok(!JSON.stringify(report).includes("LIVE_PASS"));
});

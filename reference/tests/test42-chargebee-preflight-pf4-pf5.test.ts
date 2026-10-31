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
import { ChargebeeClient, type HttpTransport } from "../src/live/chargebee-http.js";
import { ChargebeeLiveAdapter } from "../src/live/chargebee-scq-adapter.js";
import { PilotMockChargebee } from "../src/live/pilot/mock-transport.js";
import { DurableQuoteStore } from "../src/store/durable-store.js";
import { DurableMutationCoordinator } from "../src/store/mutation-coordinator.js";
import { QuoteOriginManifest } from "../src/live/pilot/quote-origin.js";
import { createPreflightTransport, createRealPreflightTransport, runPreflight, type PreflightInput, type PreflightReport } from "../src/live/pilot/preflight.js";

// Test 42 — PR #20 re-review corrections PF4 + PF5 (failing-first).
//
// PF4: PF1 made provenance structural via a module-private brand on
// the handle returned by createRealPreflightTransport() — but the
// handle exposed WRITABLE `transport` and `log` properties, and
// runPreflight trusted them. A caller could take a genuine handle,
// overwrite both properties with a mocked transport and its log,
// and obtain LIVE_PASS + a Condition 3 PASS from simulated
// responses. (A private Symbol does not fix this class: the symbol
// is readable off a genuine handle via Object.getOwnPropertySymbols,
// and test40.7 exercised only a wholly caller-assembled object.)
// The correction makes the handle OPAQUE and binds the authoritative
// transport + observed log to a module-private registry keyed by the
// handle; runPreflight resolves real-mode only through that
// registry and never reads handle properties.
//
// PF5: the independent read correctly reports UNKNOWN when the
// provider response omits has_scheduled_changes /
// has_scheduled_advance_invoices — but Condition 3's gate counted
// only blockers, so a structurally real, otherwise complete run
// could PASS Condition 3 without establishing whether outstanding
// scheduled changes or advance invoices would be disturbed. The
// correction makes Condition 3 evaluate safety-critical UNKNOWN
// checks explicitly: while any is unresolved, Condition 3 stays
// UNVERIFIED (or BLOCKED when blockers also stand) and the reason
// names each unresolved fact.
//
// The PF5 "structurally real" runs below obtain their transport from
// createRealPreflightTransport() — the module's own guarded
// fetchTransport — with the platform `fetch` beneath it stubbed
// in-process to a synthetic provider (no network I/O occurs; the
// stub is restored after each test). Provenance is a property of
// the module's construction, which the stub does not touch: it sits
// BELOW fetchTransport exactly where a proxy or DNS override would
// sit in a real deployment. LIVE_PASS classifications appearing
// inside these synthetic harness runs classify the module's
// structural path only; they are not evidence about any real tenant.

const SUB = "pilot-sub-001";
const ADDON = "pilot-addon-vision";
const SITE = "pilot-test";
const PROPOSAL = (qty: number) => ({
  changes: [{ action: "CHANGE_QUANTITY" as const, itemId: ADDON, quantity: qty }],
  effectiveIntent: { type: "IMMEDIATE" as const },
  acceptanceEnvelope: {},
});

type Fixture = { path: string; quoteId: string; mock: PilotMockChargebee; manifest: QuoteOriginManifest };

async function buildFixture(mock: PilotMockChargebee = new PilotMockChargebee()): Promise<Fixture> {
  const path = join(trackTempDir(mkdtempSync(join(tmpdir(), "scq-pr20-pf4pf5-"))), "scq.db");
  const store = new DurableQuoteStore(path, { recoveryGraceMs: 0 });
  const client = new ChargebeeClient({ site: SITE, apiKey: "pilot-mock-key" }, mock.transport as HttpTransport);
  const adapter = new ChargebeeLiveAdapter(client, store, {
    liveCommitEnabled: false,
    durableCoordinator: new DurableMutationCoordinator(store),
    providerSite: SITE,
  });
  const quote = await adapter.createChangeQuote(SUB, PROPOSAL(21));
  const manifest = new QuoteOriginManifest(path + ".origins.jsonl");
  manifest.record({ stored: store.get(quote.id)!, site: SITE, recordedBy: "test42 fixture issuance" });
  store.close();
  return { path, quoteId: quote.id, mock, manifest };
}

function openStore(path: string): DurableQuoteStore {
  return new DurableQuoteStore(path, { recoveryGraceMs: 0 });
}

function baseInput(fx: Fixture, store: DurableQuoteStore, over: Record<string, unknown> = {}): PreflightInput {
  return {
    quoteId: fx.quoteId,
    store,
    site: SITE,
    approvedSite: SITE,
    apiKey: "pilot-mock-key",
    operatorAttestation: { testTenantAttested: true, attestedBy: "test-operator (synthetic)" },
    env: {},
    originManifest: fx.manifest,
    ...over,
  } as PreflightInput;
}

function checkStatus(report: PreflightReport, id: string): string | undefined {
  return report.checks.find((c) => c.id === id)?.status;
}

function cond3(report: PreflightReport) {
  return report.conditions.find((c) => c.condition === 3)!;
}

/** Rewrites the subscription member of GET-subscription responses from an inner transport. */
function transformSubscription(inner: HttpTransport, mutate: (sub: any) => void): HttpTransport {
  return async (req) => {
    const res = await inner(req);
    if (req.method === "GET" && /\/subscriptions\/[^/]+$/.test(new URL(req.url).pathname) && res.json) {
      const json = JSON.parse(JSON.stringify(res.json));
      if (json.subscription) mutate(json.subscription);
      return { ...res, json };
    }
    return res;
  };
}

/**
 * Replaces the platform fetch beneath the module's fetchTransport
 * with an in-process delegate for the duration of `fn` (restored
 * afterwards, even on failure). No network I/O occurs.
 */
async function withStubbedFetch<T>(inner: HttpTransport, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
    const res = await inner({
      method: (init?.method as "GET" | "POST") ?? "GET",
      url: String(url),
      headers: init?.headers ?? {},
      body: init?.body,
    });
    const text = res.text ?? (res.json !== undefined ? JSON.stringify(res.json) : "");
    return { status: res.status, headers: new Headers(res.headers), text: async () => text };
  }) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

// ---------------------------------------------------------------------------
// PF4 — the genuine handle must be opaque; authority lives in the registry
// ---------------------------------------------------------------------------

test("Test 42.1 (PF4): the reviewer's counterexample — genuine handle with transport AND log overwritten by a mock's — obtains no live evidence", { timeout: 90000 }, async () => {
  const fx = await buildFixture();
  const store = openStore(fx.path);
  // The reviewer's construction, verbatim in shape: obtain a genuine
  // handle (no network request needed), then substitute a mocked
  // guarded transport and its log into the handle's properties.
  // Attestation and a v2 origin manifest are supplied, so provenance
  // is the only thing standing between this run and full PASS.
  const genuine: any = createRealPreflightTransport();
  const fake = createPreflightTransport(fx.mock.transport as HttpTransport);
  genuine.transport = fake.transport;
  genuine.log = fake.log;
  const callsBefore = fx.mock.calls.length; // fixture issuance already used the mock; the RUN must not
  const report = await runPreflight(baseInput(fx, store, { transport: undefined, realTransport: genuine }));
  store.close();
  assert.equal(fx.mock.calls.length, callsBefore, "the substituted mock transport must never be invoked by the run: handle properties are not the real transport");
  assert.ok(!JSON.stringify(report).includes("LIVE_PASS"), "substituted simulated responses must never be classified LIVE_PASS");
  assert.notEqual(cond3(report).status, "PASS", "Condition 3 must not PASS on substituted simulated evidence");
  assert.equal(report.providerState, null, "no provider state may be taken from the substituted mock");
  assert.equal(report.transport.updateForItemsDispatched, 0);
  assert.equal(report.overall, "NO-GO");
});

test("Test 42.2 (PF4): a forged handle copying every own property (symbols included) from a genuine handle is refused", { timeout: 90000 }, async () => {
  const fx = await buildFixture();
  const store = openStore(fx.path);
  const genuine = createRealPreflightTransport();
  const forged: Record<PropertyKey, unknown> = {};
  for (const k of Reflect.ownKeys(genuine)) forged[k] = (genuine as any)[k];
  await assert.rejects(
    () => runPreflight(baseInput(fx, store, { transport: undefined, realTransport: forged as any })),
    /createRealPreflightTransport|internally constructed/i,
    "a property-copied handle is not the factory's construction and must be refused, not classified",
  );
  store.close();
});

test("Test 42.3 (PF4): a genuine handle with ONLY its log replaced — the report's evidence is the registry's log, not the substituted one", { timeout: 90000 }, async () => {
  const fx = await buildFixture();
  const store = openStore(fx.path);
  const genuine: any = createRealPreflightTransport();
  // A fabricated log claiming a DISPATCHED update_for_items and a
  // successful subscription read. Pre-correction, runPreflight
  // summarized THIS log into the report's transport evidence.
  genuine.log = [
    { method: "GET", path: "/subscriptions/pilot-sub-001", operation: "retrieve_subscription", mutating: false, dispatched: true, status: 200 },
    { method: "POST", path: "/subscriptions/pilot-sub-001/update_for_items", operation: "update_for_items", mutating: true, dispatched: true, status: 200 },
  ];
  const report = await runPreflight(baseInput(fx, store, { transport: undefined, realTransport: genuine }));
  store.close();
  assert.equal(report.transport.updateForItemsDispatched, 0, "a substituted log must not become the report's observed-transport evidence");
  assert.equal(report.transport.mutatingCalls, 0, "the fabricated dispatched mutation in the substituted log must not appear in the report");
  assert.equal(report.transport.byOperation.update_for_items, undefined);
  const zeroMut = report.evidence.capabilities.find((c) => /zero observed mutations/.test(c.capability))!;
  assert.notEqual(zeroMut.result, "VIOLATED", "the zero-mutation statement is computed from the authoritative log only");
});

test("Test 42.4 (PF4): a genuine handle with ONLY its transport replaced — the mock's responses are never observed", { timeout: 90000 }, async () => {
  const fx = await buildFixture();
  const store = openStore(fx.path);
  const genuine: any = createRealPreflightTransport();
  const fake = createPreflightTransport(fx.mock.transport as HttpTransport);
  genuine.transport = fake.transport; // log left as the genuine handle's own
  const callsBefore = fx.mock.calls.length; // fixture issuance already used the mock; the RUN must not
  const report = await runPreflight(baseInput(fx, store, { transport: undefined, realTransport: genuine }));
  store.close();
  assert.equal(fx.mock.calls.length, callsBefore, "the substituted mock transport must never be invoked by the run");
  assert.equal(report.providerState, null, "provider state must not be taken from the substituted mock's responses");
  assert.notEqual(cond3(report).status, "PASS");
  assert.ok(!JSON.stringify(report).includes("LIVE_PASS"));
});

test("Test 42.5 (PF4 control): an unmutated genuine handle still resolves as provenance 'real' through the registry and fails closed without a network", { timeout: 90000 }, async () => {
  const fx = await buildFixture();
  const store = openStore(fx.path);
  const report = await runPreflight(baseInput(fx, store, { transport: undefined, realTransport: createRealPreflightTransport() }));
  store.close();
  // Control: this behavior is identical pre- and post-correction —
  // the genuine construction is recognized, and with no reachable
  // provider the read fails closed rather than fabricating evidence.
  assert.equal(report.evidence.transportOrigin, "real", "provenance derives from the internal construction");
  assert.equal(report.providerState, null, "no provider state is fabricated when the real read cannot complete");
  assert.equal(checkStatus(report, "provider_reread"), "blocker");
  assert.notEqual(cond3(report).status, "PASS");
  assert.equal(report.overall, "NO-GO");
  assert.ok(!JSON.stringify(report).includes("LIVE_PASS"));
});

test("Test 42.6 (PF4): the genuine handle is opaque — it exposes no transport and no log", () => {
  const handle: any = createRealPreflightTransport();
  assert.equal(handle.transport, undefined, "no transport may be reachable (or replaceable) through the handle");
  assert.equal(handle.log, undefined, "no log may be reachable (or replaceable) through the handle — the authoritative log never leaves the module");
});

// ---------------------------------------------------------------------------
// PF5 — safety-critical UNKNOWNs gate Condition 3
// ---------------------------------------------------------------------------

test("Test 42.7 (PF5): provider omits has_scheduled_changes on an otherwise complete real-path run — Condition 3 does not PASS and names the unknown", { timeout: 90000 }, async () => {
  const fx = await buildFixture();
  const store = openStore(fx.path);
  const omitting = transformSubscription(fx.mock.transport as HttpTransport, (sub) => { delete sub.has_scheduled_changes; });
  const report = await withStubbedFetch(omitting, () =>
    runPreflight(baseInput(fx, store, { transport: undefined, realTransport: createRealPreflightTransport() })));
  store.close();
  assert.equal(report.evidence.transportOrigin, "real");
  assert.equal(report.providerState!.scheduledChanges, "UNKNOWN", "absent data is reported UNKNOWN, never fabricated as 'none'");
  assert.equal(checkStatus(report, "scheduled_changes"), "unknown");
  assert.deepEqual(report.blockers, [], "an UNKNOWN is not a blocker — the gate, not the blocker count, must stop the PASS");
  assert.equal(cond3(report).status, "UNVERIFIED", "Condition 3 cannot PASS while scheduled-change status is UNKNOWN");
  assert.match(cond3(report).reason, /scheduled/i, "the unmet reason names the unresolved scheduled-change status");
  assert.match(cond3(report).reason, /UNKNOWN/, "the unmet reason states the status is UNKNOWN — uncertainty is not clearance");
  assert.equal(report.overall, "NO-GO");
});

test("Test 42.8 (PF5): provider omits has_scheduled_advance_invoices on an otherwise complete real-path run — Condition 3 does not PASS and names the unknown", { timeout: 90000 }, async () => {
  const fx = await buildFixture();
  const store = openStore(fx.path);
  const omitting = transformSubscription(fx.mock.transport as HttpTransport, (sub) => { delete sub.has_scheduled_advance_invoices; });
  const report = await withStubbedFetch(omitting, () =>
    runPreflight(baseInput(fx, store, { transport: undefined, realTransport: createRealPreflightTransport() })));
  store.close();
  assert.equal(report.evidence.transportOrigin, "real");
  assert.equal(report.providerState!.scheduledAdvanceInvoices, "UNKNOWN");
  assert.equal(checkStatus(report, "scheduled_advance_invoices"), "unknown");
  assert.deepEqual(report.blockers, []);
  assert.equal(cond3(report).status, "UNVERIFIED", "Condition 3 cannot PASS while scheduled-advance-invoice status is UNKNOWN");
  assert.match(cond3(report).reason, /advance/i, "the unmet reason names the unresolved scheduled-advance-invoice status");
  assert.match(cond3(report).reason, /UNKNOWN/);
  assert.equal(report.overall, "NO-GO");
});

test("Test 42.9 (PF5 control): both scheduled flags present and false on an injected run — Condition 3 stays UNVERIFIED for provenance, with NO scheduled-change reason", async () => {
  const fx = await buildFixture();
  const store = openStore(fx.path);
  const report = await runPreflight(baseInput(fx, store, { transport: fx.mock.transport as HttpTransport }));
  store.close();
  assert.equal(checkStatus(report, "scheduled_changes"), "pass");
  assert.equal(checkStatus(report, "scheduled_advance_invoices"), "pass");
  assert.equal(cond3(report).status, "UNVERIFIED", "injected evidence cannot pass Condition 3 (provenance) — control unchanged");
  assert.ok(!/scheduled/i.test(cond3(report).reason), "when both flags are established false, the unmet reasons must not name scheduled changes");
});

test("Test 42.10 (PF5 positive control): both scheduled flags present and false on the structurally real path — the gate permits Condition 3 PASS", { timeout: 90000 }, async () => {
  const fx = await buildFixture();
  const store = openStore(fx.path);
  const report = await withStubbedFetch(fx.mock.transport as HttpTransport, () =>
    runPreflight(baseInput(fx, store, { transport: undefined, realTransport: createRealPreflightTransport() })));
  store.close();
  // Positive control: when every safety-critical fact IS established
  // (both flags provider-reported false, full-multiset coherence,
  // verified identity, established origin, attestation supplied),
  // the PF5 gate must not over-block. The read flows over the
  // factory's own guarded fetchTransport with the platform fetch
  // stubbed in-process — no network request occurred; the LIVE_PASS
  // classification below classifies that structural path only.
  assert.equal(report.evidence.transportOrigin, "real");
  assert.deepEqual(report.blockers, [], JSON.stringify(report.checks.filter((c) => c.status === "blocker"), null, 2));
  assert.equal(checkStatus(report, "scheduled_changes"), "pass");
  assert.equal(checkStatus(report, "scheduled_advance_invoices"), "pass");
  assert.equal(cond3(report).status, "PASS", "with scheduled-change and advance-invoice status established false, this gate permits Condition 3");
  assert.ok(JSON.stringify(report).includes("LIVE_PASS"), "the structurally real path was genuinely exercised (fetch stubbed below fetchTransport; no network I/O)");
});

test("Test 42.11 (PF5 control): scheduled changes / advance invoices present and TRUE still block, as before", async () => {
  const fx = await buildFixture();
  fx.mock.hasScheduledChanges = true;
  const advancing = transformSubscription(fx.mock.transport as HttpTransport, (sub) => { sub.has_scheduled_advance_invoices = true; });
  const store = openStore(fx.path);
  const report = await runPreflight(baseInput(fx, store, { transport: advancing }));
  store.close();
  assert.equal(checkStatus(report, "scheduled_changes"), "blocker");
  assert.equal(checkStatus(report, "scheduled_advance_invoices"), "blocker");
  assert.equal(cond3(report).status, "BLOCKED");
  assert.equal(report.overall, "NO-GO");
});

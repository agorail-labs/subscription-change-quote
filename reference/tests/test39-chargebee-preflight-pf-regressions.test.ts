import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChargebeeClient, type HttpTransport } from "../src/live/chargebee-http.js";
import { ChargebeeLiveAdapter } from "../src/live/chargebee-scq-adapter.js";
import { PilotMockChargebee } from "../src/live/pilot/mock-transport.js";
import { DurableQuoteStore } from "../src/store/durable-store.js";
import { DurableMutationCoordinator } from "../src/store/mutation-coordinator.js";
import { QuoteOriginManifest } from "../src/live/pilot/quote-origin.js";
import { runPreflight, type PreflightInput, type PreflightReport } from "../src/live/pilot/preflight.js";

// Test 39 — PR #20 review corrections PF1–PF3 (failing-first round).
//
// PF1: transport provenance was a caller-asserted `transportOrigin`
// string: a mocked transport labeled "real" produced LIVE_PASS and a
// Condition 3 PASS. Provenance must be STRUCTURAL — derived from how
// the transport was obtained, never from a caller-supplied label.
// PF2: the "exact request matches proposal" check verified only the
// changed item; the FULL resulting (itemPriceId, quantity) multiset
// must be validated against the independent provider re-read.
// PF3: site/subscription binding rested on optional caller-supplied
// expectations (null in the normal CLI path, zero blockers); quote
// origin must come from a trustworthy issuance record and its
// absence must BLOCK.
//
// These tests use only the pre-correction exports, with the PF1
// attack expressed by smuggling the old label through a cast — the
// exact input shape the reviewer demonstrated. Against the
// pre-correction code the PF1/PF2/PF3 assertions below FAIL on the
// merits (not on missing modules); PF1c and the PF2 canonical case
// are disclosed controls that already passed.

const SUB = "pilot-sub-001";
const ADDON = "pilot-addon-vision";
const PLAN = "pilot-plan-business";
const SITE = "pilot-test";
const PROPOSAL = (qty: number) => ({
  changes: [{ action: "CHANGE_QUANTITY" as const, itemId: ADDON, quantity: qty }],
  effectiveIntent: { type: "IMMEDIATE" as const },
  acceptanceEnvelope: {},
});

function tmpDb(): string {
  return join(mkdtempSync(join(tmpdir(), "scq-pr20-pf-")), "scq.db");
}

type Fixture = { path: string; quoteId: string; mock: PilotMockChargebee; manifest: QuoteOriginManifest };

async function buildFixture(mock: PilotMockChargebee = new PilotMockChargebee()): Promise<Fixture> {
  const path = tmpDb();
  const store = new DurableQuoteStore(path, { recoveryGraceMs: 0 });
  const client = new ChargebeeClient({ site: SITE, apiKey: "pilot-mock-key" }, mock.transport as HttpTransport);
  const adapter = new ChargebeeLiveAdapter(client, store, {
    liveCommitEnabled: false,
    durableCoordinator: new DurableMutationCoordinator(store),
    providerSite: SITE,
  });
  const quote = await adapter.createChangeQuote(SUB, PROPOSAL(21));
  // Origin recorded at issuance, as the corrected issuance path
  // does; test 39.9 withholds the manifest explicitly. (The
  // pre-correction code has no origin concept, so this wiring did
  // not change any failing-first outcome recorded against it.)
  const manifest = new QuoteOriginManifest(path + ".origins.jsonl");
  manifest.record({ stored: store.get(quote.id)!, site: SITE, recordedBy: "test39 fixture issuance" });
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
    transport: fx.mock.transport as HttpTransport,
    originManifest: fx.manifest,
    site: SITE,
    approvedSite: SITE,
    apiKey: "pilot-mock-key",
    operatorAttestation: { testTenantAttested: true, attestedBy: "test-operator (synthetic)" },
    env: {},
    ...over,
  } as PreflightInput;
}

function checkStatus(report: PreflightReport, id: string): string | undefined {
  return report.checks.find((c) => c.id === id)?.status;
}

function condition(report: PreflightReport, n: number) {
  return report.conditions.find((c) => c.condition === n)!;
}

function tamperStoredQuote(fx: Fixture, mutate: (q: any) => void): DurableQuoteStore {
  const store = openStore(fx.path);
  const q = store.get(fx.quoteId) as any;
  mutate(q);
  store.put(q);
  return store;
}

// ---------------------------------------------------------------------------
// PF1 — self-asserted transport origin
// ---------------------------------------------------------------------------

test("Test 39.1 (PF1): a mocked transport labeled 'real' by the caller yields neither LIVE_PASS nor Condition 3 PASS", async () => {
  const fx = await buildFixture();
  const store = openStore(fx.path);
  // The reviewer's counterexample, verbatim in shape: mocked transport
  // + caller-claimed origin "real" + every human input supplied, so
  // nothing but provenance stands between this run and full PASS.
  const forged = baseInput(fx, store, {
    transportOrigin: "real",
    rehearsal: { completed: true, scenariosPassed: 14, scenariosTotal: 14, reference: "synthetic test input" },
    humanInputs: {
      releaseApproval: { approved: true, reference: "synthetic test input" },
      reconciliationOwner: { name: "Synthetic Owner", backupName: "Synthetic Backup", rehearsalReference: "synthetic test input" },
      commitAuthorization: { granted: true, reference: "synthetic test input" },
    },
  });
  const report = await runPreflight(forged);
  store.close();
  assert.ok(!JSON.stringify(report).includes("LIVE_PASS"), "a caller-labeled mocked run must never produce LIVE_PASS");
  assert.notEqual(report.evidence.transportOrigin, "real", "provenance is structural: a caller-supplied transport is never 'real'");
  assert.notEqual(condition(report, 3).status, "PASS", "Condition 3 must not PASS on injected/simulated evidence");
  assert.equal(report.overall, "NO-GO");
  assert.equal(report.transport.mutatingCalls, 0);
  assert.equal(report.transport.updateForItemsDispatched, 0);
});

test("Test 39.2 (PF1): even a 'real'-labeled run without operator attestation never passes Condition 3", async () => {
  const fx = await buildFixture();
  const store = openStore(fx.path);
  const report = await runPreflight(baseInput(fx, store, {
    transportOrigin: "real",
    operatorAttestation: undefined,
  }));
  store.close();
  assert.equal(report.identity.tenantModeEstablished, "UNVERIFIED");
  assert.notEqual(condition(report, 3).status, "PASS", "Condition 3 requires actual test-tenant attestation");
  assert.match(condition(report, 3).reason, /attestation/i, "the unmet attestation requirement is named");
});

test("Test 39.3 (PF1 control): a plainly mocked run classifies SIMULATED_PASS and leaves Condition 3 UNVERIFIED", async () => {
  const fx = await buildFixture();
  const store = openStore(fx.path);
  const report = await runPreflight(baseInput(fx, store));
  store.close();
  const cap = report.evidence.capabilities.find((c) => /preflight evidence/.test(c.capability))!;
  assert.equal(cap.result, "SIMULATED_PASS", "legitimate injected evidence remains SIMULATED_PASS-classified");
  assert.equal(condition(report, 3).status, "UNVERIFIED");
  assert.ok(!JSON.stringify(report).includes("LIVE_PASS"));
});

// ---------------------------------------------------------------------------
// PF2 — full resulting item multiset validation
// ---------------------------------------------------------------------------

test("Test 39.4 (PF2): the reviewer's counterexample — flat-fee plan quantity tampered 1→2 in the stored target — blocks", async () => {
  const fx = await buildFixture();
  // Canonical addon-only quantity change (addon 1→21); the stored
  // preview input keeps addon=21 but changes the PLAN quantity 1→2.
  // Pre-correction, the changed-item check, ID coverage, fingerprint,
  // and even the fresh estimate (flat_fee amount is quantity-
  // independent) all passed while the exact request would change a
  // second, unauthorized item.
  const store = tamperStoredQuote(fx, (q) => {
    q.provider_preview_input = {
      ...q.provider_preview_input,
      items: q.provider_preview_input.items.map((i: any) => (i.itemPriceId === PLAN ? { ...i, quantity: 2 } : i)),
    };
  });
  const report = await runPreflight(baseInput(fx, store));
  store.close();
  assert.equal(checkStatus(report, "request_matches_proposal"), "blocker",
    "the full resulting item multiset must be validated: a non-target quantity change is a blocker");
  assert.equal(report.exactRequest!.matchesStoredPreviewInput, false);
  assert.equal(report.durableReadiness.requestCoherence, false);
});

test("Test 39.5 (PF2): an extra item in the stored target blocks", async () => {
  const fx = await buildFixture();
  const store = tamperStoredQuote(fx, (q) => {
    q.provider_preview_input = {
      ...q.provider_preview_input,
      items: [...q.provider_preview_input.items, { itemPriceId: "pilot-addon-extra", quantity: 1 }],
    };
  });
  const report = await runPreflight(baseInput(fx, store));
  store.close();
  assert.equal(checkStatus(report, "request_matches_proposal"), "blocker");
  assert.equal(report.exactRequest!.matchesStoredPreviewInput, false);
});

test("Test 39.6 (PF2): a duplicated item id in the stored target blocks", async () => {
  const fx = await buildFixture();
  const store = tamperStoredQuote(fx, (q) => {
    q.provider_preview_input = {
      ...q.provider_preview_input,
      items: [...q.provider_preview_input.items, { itemPriceId: ADDON, quantity: 21 }],
    };
  });
  const report = await runPreflight(baseInput(fx, store));
  store.close();
  assert.equal(checkStatus(report, "request_matches_proposal"), "blocker");
  assert.equal(report.exactRequest!.matchesStoredPreviewInput, false);
});

test("Test 39.7 (PF2): an item omitted from the stored target blocks the coherence check", async () => {
  const fx = await buildFixture();
  const store = tamperStoredQuote(fx, (q) => {
    q.provider_preview_input = {
      ...q.provider_preview_input,
      items: q.provider_preview_input.items.filter((i: any) => i.itemPriceId !== PLAN),
    };
  });
  const report = await runPreflight(baseInput(fx, store));
  store.close();
  // Disclosure: pre-correction this RUN was already blocked by the
  // ID-coverage check (target_covers_current_items); the regression
  // here is that the exact-request coherence check itself must judge
  // the full multiset, not just the changed item.
  assert.equal(checkStatus(report, "request_matches_proposal"), "blocker");
  assert.equal(report.exactRequest!.matchesStoredPreviewInput, false);
});

test("Test 39.8 (PF2 control): the legitimate unchanged target set passes full-multiset validation", async () => {
  const fx = await buildFixture();
  const store = openStore(fx.path);
  const report = await runPreflight(baseInput(fx, store));
  store.close();
  assert.equal(checkStatus(report, "request_matches_proposal"), "pass");
  assert.equal(report.exactRequest!.matchesStoredPreviewInput, true);
  assert.equal(report.durableReadiness.requestCoherence, true);
});

// ---------------------------------------------------------------------------
// PF3 — quote-origin binding (behavioral core; manifest mechanics in test40)
// ---------------------------------------------------------------------------

test("Test 39.9 (PF3): with no independently established quote-origin record, binding BLOCKS instead of sitting null", async () => {
  const fx = await buildFixture();
  const store = openStore(fx.path);
  // The normal pre-correction CLI shape: no origin evidence is
  // supplied for this quote (the manifest is withheld). Pre-
  // correction this produced siteBindingOk:null /
  // subscriptionMatch:null with ZERO blockers.
  const report = await runPreflight(baseInput(fx, store, { originManifest: undefined }));
  store.close();
  assert.equal(checkStatus(report, "quote_origin_binding"), "blocker",
    "absence of origin evidence must block, not sit null with zero blockers");
  assert.equal((report.durableReadiness as any).originBinding, "MISSING");
  assert.notEqual(condition(report, 3).status, "PASS");
  assert.equal(report.overall, "NO-GO");
});

test("Test 39.10 (PF3): a provider re-read returning a DIFFERENT subscription id blocks on identity", async () => {
  const fx = await buildFixture();
  const rewriting: HttpTransport = async (req) => {
    const res = await fx.mock.transport(req as any);
    if (req.method === "GET" && req.url.includes("/subscriptions/") && res.json) {
      const json = JSON.parse(JSON.stringify(res.json));
      json.subscription.id = "pilot-sub-999";
      return { ...res, json };
    }
    return res;
  };
  const store = openStore(fx.path);
  const report = await runPreflight(baseInput(fx, store, { transport: rewriting }));
  store.close();
  assert.equal(checkStatus(report, "provider_subscription_identity"), "blocker",
    "the re-read subscription id must equal the bound subscription id");
  assert.equal(report.overall, "NO-GO");
});

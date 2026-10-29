import { test } from "node:test";
import assert from "node:assert/strict";
import type { HttpTransport } from "../src/live/chargebee-http.js";
import { PilotMockChargebee } from "../src/live/pilot/mock-transport.js";
import { classifyRunCapability, renderMarkdown, runPilot } from "../src/live/pilot/run-pilot.js";
import {
  PilotLivePreflightError,
  assertLivePilotPreflight,
  isApprovedTestSite,
} from "../src/live/pilot/live-guard.js";

// Test 23 — Chargebee PILOT re-review corrections (PR #13, round 2):
//
//   F1 — explicit site approval vs suffix heuristic. At 36a50d6,
//        isApprovedTestSite("sneaky-test") returned true and
//        assertLivePilotPreflight passed for ANY `-test`-suffixed
//        slug with no explicit approval at all (failing-first probe
//        recorded in EVIDENCE-REPORT.md). A naming convention is not
//        proof of tenant approval or test mode. Preflight now
//        requires an explicit per-run approved-site entry EXACTLY
//        matching CHARGEBEE_SITE (SCQ_PILOT_APPROVED_TEST_SITES or an
//        approved-site parameter); the `-test` suffix remains only
//        as an additional sanity property. The check is reported as
//        configuration/approval validation, not provider attestation.
//   F2 — stubbed live-path results must not be labeled LIVE_PASS.
//        At 36a50d6, test 22-g4 asserted LIVE_PASS from
//        runPilot({ mode: "live", networkTransport: mock.transport })
//        — that assertion IS the pre-fix evidence. Classification now
//        distinguishes transport origin: injected ⇒ SIMULATED_PASS /
//        UNVERIFIED, never LIVE_*; LIVE_PASS is issuable only on the
//        real configured network path (no injected transport) after
//        preflight, with observed successful operations.
//
// Everything here is mocked/stubbed — SIMULATED evidence only. No
// live call is made and no credential exists in this environment.

const SUB = "pilot-sub-001";

function countingStubTransport() {
  let count = 0;
  const transport: HttpTransport = async () => { count++; return { status: 200, headers: {}, json: {} }; };
  return { transport, count: () => count };
}

test("Test 23-f1a: a -test-suffixed site that is NOT explicitly approved fails preflight — zero dispatch", async () => {
  // Unit level: suffix alone is not approval.
  assert.equal(isApprovedTestSite("sneaky-test"), false);
  assert.equal(isApprovedTestSite("sneaky-test", []), false);
  assert.equal(isApprovedTestSite("sneaky-test", ["other-test"]), false);
  assert.throws(
    () => assertLivePilotPreflight({ site: "sneaky-test", apiKeyPresent: true, subscriptionId: SUB }),
    (e: unknown) => e instanceof PilotLivePreflightError && (e as PilotLivePreflightError).code === "LIVE_PREFLIGHT_FAILED",
  );
  // Run level: BLOCKED report, preflight step, stub never invoked.
  const stub = countingStubTransport();
  const report = await runPilot({
    mode: "live",
    env: { CHARGEBEE_SITE: "sneaky-test", CHARGEBEE_API_KEY: "k", CHARGEBEE_TEST_SUBSCRIPTION_ID: SUB },
    networkTransport: stub.transport,
  });
  assert.equal(stub.count(), 0, "no request may be dispatched for a non-approved site");
  assert.equal(report.transport.totalCalls, 0);
  assert.equal(report.steps[0].step, "live preflight");
  assert.equal(report.steps[0].status, "blocked");
  assert.ok(report.steps[0].detail.includes("LIVE_PREFLIGHT_FAILED"), report.steps[0].detail);
  assert.ok(report.steps[0].detail.includes("not an approved test site"), report.steps[0].detail);
  assert.ok(report.capabilities.every((c) => c.classification === "BLOCKED"));
});

test("Test 23-f1b: an explicitly approved exact site + synthetic subscription id passes preflight", () => {
  assert.equal(isApprovedTestSite("acme-test", ["acme-test"]), true);
  assert.doesNotThrow(() =>
    assertLivePilotPreflight({ site: "acme-test", apiKeyPresent: true, subscriptionId: SUB, approvedTestSites: ["acme-test"] }),
  );
  // Single-site parameter form, and approval parsed among several entries.
  assert.doesNotThrow(() =>
    assertLivePilotPreflight({ site: "acme-test", apiKeyPresent: true, subscriptionId: SUB, approvedSite: "acme-test" }),
  );
  assert.doesNotThrow(() =>
    assertLivePilotPreflight({ site: "acme-test", apiKeyPresent: true, subscriptionId: "cbdemo_demo123", approvedTestSites: ["other-test", "acme-test"] }),
  );
});

test("Test 23-f1c: an approved-list entry that does not match the configured site fails — zero dispatch; approved non-test slug still fails the sanity property", async () => {
  assert.throws(
    () => assertLivePilotPreflight({ site: "acme-test", apiKeyPresent: true, subscriptionId: SUB, approvedTestSites: ["other-test"] }),
    (e: unknown) => e instanceof PilotLivePreflightError,
  );
  // The `-test` sanity property is additional, not replaced: explicit
  // approval of a production-shaped slug does not approve it.
  assert.throws(
    () => assertLivePilotPreflight({ site: "acme-production", apiKeyPresent: true, subscriptionId: SUB, approvedTestSites: ["acme-production"] }),
    (e: unknown) => e instanceof PilotLivePreflightError,
  );
  const stub = countingStubTransport();
  const report = await runPilot({
    mode: "live",
    env: {
      CHARGEBEE_SITE: "acme-test",
      CHARGEBEE_API_KEY: "k",
      CHARGEBEE_TEST_SUBSCRIPTION_ID: SUB,
      SCQ_PILOT_APPROVED_TEST_SITES: "other-test",
    },
    networkTransport: stub.transport,
  });
  assert.equal(stub.count(), 0);
  assert.equal(report.transport.totalCalls, 0);
  assert.equal(report.steps[0].status, "blocked");
});

test("Test 23-f2a: a successful injected mock run produces SIMULATED_PASS and LIVE_PASS appears NOWHERE in the returned report", async () => {
  const mock = new PilotMockChargebee();
  const report = await runPilot({
    mode: "live",
    env: {
      CHARGEBEE_SITE: "pilot-test",
      CHARGEBEE_API_KEY: "pilot-mock-key",
      CHARGEBEE_TEST_SUBSCRIPTION_ID: SUB,
      SCQ_PILOT_APPROVED_TEST_SITES: "pilot-test",
    },
    networkTransport: mock.transport,
  });
  assert.ok(report.steps.every((s) => s.status === "pass"), JSON.stringify(report.steps));
  assert.equal(report.transportOrigin, "injected");
  // Observed counts are still verified against the mock's own log.
  assert.equal(report.transport.totalCalls, mock.calls.length);
  assert.equal(report.transport.estimateCalls, mock.estimateCount);
  assert.equal(report.transport.mutatingCalls, 0);
  const byCap = Object.fromEntries(report.capabilities.map((c) => [c.capability, c.classification]));
  assert.equal(byCap["retrieve subscription + snapshot"], "SIMULATED_PASS");
  assert.equal(byCap["estimate-backed quote"], "SIMULATED_PASS");
  assert.equal(byCap["live commit"], "BLOCKED");
  // The explicit scan: neither the JSON report nor its Markdown
  // rendering may carry a live-evidence label for an injected run.
  const serialized = JSON.stringify(report);
  assert.ok(!serialized.includes("LIVE_PASS"), serialized);
  assert.ok(!serialized.includes("LIVE_FAIL"), serialized);
  const md = renderMarkdown(report);
  assert.ok(!md.includes("LIVE_PASS"), md);
  assert.ok(!md.includes("LIVE_FAIL"), md);
});

test("Test 23-f2b: LIVE_PASS remains issuable ONLY for the real transport origin with observed operations (classification-logic unit)", () => {
  // Logic-level only — this asserts the gate, it is not live evidence.
  assert.equal(classifyRunCapability("live", true, 1, "real"), "LIVE_PASS");
  assert.equal(classifyRunCapability("live", true, 0, "real"), "UNVERIFIED");
  assert.equal(classifyRunCapability("live", false, 1, "real"), "LIVE_FAIL");
  for (const ok of [true, false]) {
    for (const n of [0, 1, 5]) {
      const cls = classifyRunCapability("live", ok, n, "injected");
      assert.ok(cls === "SIMULATED_PASS" || cls === "UNVERIFIED", `injected origin must never classify live, got ${cls}`);
    }
  }
});

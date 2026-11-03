import { test } from "node:test";
import assert from "node:assert/strict";
import { QuoteStore } from "../src/store/quote-store.js";
import { ChargebeeClient, type HttpTransport } from "../src/live/chargebee-http.js";
import { ChargebeeLiveAdapter } from "../src/live/chargebee-scq-adapter.js";
import { PilotMockChargebee } from "../src/live/pilot/mock-transport.js";
import { checkAcceptanceEnvelope, reconcileCommittedEffect } from "../src/core/scq-engine.js";
import type { CommercialEffect, SubscriptionChangeProposal } from "../src/core/types.js";

// Test 45 — Issue #22, Finding 3 (identity binding) and Finding 4
// (currency / cadence comparability). Independent local reruns
// against CURRENT main. REPRODUCTION file: the defect tests assert
// the SAFE behavior and are EXPECTED TO FAIL on unmodified main;
// controls pass. Simulated evidence only (mocked transports /
// in-memory engine calls) — never LIVE.
//
// 2026-11 RECONCILIATION RERUN (Issue #22 closure audit, main
// 62744ee): Findings 3 and 4 were FIXED by PR #26 (default-suite
// regression home: test49). The F4 tests (45.3–45.6) pass
// unmodified. The F3 scenario's original shape — a post-commit
// re-read naming another subscription — is no longer reachable on
// this adapter, because (a) identity is now checked at quote
// creation, at the commit-phase validation read, on the mutation
// response, and on the post-commit re-read (a foreign read is
// treated as unavailable evidence, never consumed), and (b) the
// authorization-preservation gate refuses this adapter's
// full-replacement commits before dispatch, so no post-commit
// phase is reached. Tests 45.1/45.2 were therefore updated to the
// earliest reachable identity boundary — the commit-phase
// validation read — which is also where test49.1 pins the
// behavior in the default suite. The original failing-first text
// is preserved in research/external-review-reconciliation-2026-11.md.
//
// RESEARCH SUITE (PR #23 REVIEW-1): this file is NOT part of the
// default `npm test` discovery (`dist/tests/*.test.js`). Build,
// then invoke the research suite explicitly:
// `node --test dist/tests/*.repro.js`.
//
// Finding 3 (historical, at 963be0b/6f56b05): the Chargebee-live
// adapter never checked that the post-commit re-read names the
// SAME subscription the quote was for, and the rv-only fingerprint
// could not catch a wrong-record read. Fixed by PR #26 — identity
// is now bound at every read the mutating path consumes (see the
// reconciliation note above).
//
// Finding 4: compareDeterminedDimensions (core/scq-engine.ts)
// compares raw numbers only. CommercialEffect.recurring HAS a
// currency field (types.ts) — the comparison never reads it.
// CommercialEffect.immediate has NO currency field at all: an
// immediate-side currency mismatch is not even expressible in the
// schema, let alone checked. recurring.cadence is likewise
// carried and never compared. Numerically equal cross-currency
// (or cross-cadence) amounts reconcile OK.

const SUB = "pilot-sub-001";
const ADDON = "pilot-addon-vision";
const PROPOSAL = (qty: number) => ({
  changes: [{ action: "CHANGE_QUANTITY" as const, itemId: ADDON, quantity: qty }],
  effectiveIntent: { type: "IMMEDIATE" as const },
  acceptanceEnvelope: {},
});

// ---------------------------------------------------------------------------
// 45.1 — F3: the commit-phase validation read names a DIFFERENT
// subscription (resource_version preserved, so the rv-only
// fingerprint cannot catch it). The commit must refuse before
// dispatch with SUBSCRIPTION_IDENTITY_MISMATCH.
// ---------------------------------------------------------------------------

test("Test 45.1 (Issue #22 F3): a commit-phase validation read naming a different subscription.id refuses before dispatch", async () => {
  const mock = new PilotMockChargebee();
  let armed = false;
  const transport: HttpTransport = async (req) => {
    const res = await mock.transport(req);
    if (armed && req.method === "GET" && (res.json as any)?.subscription) {
      // The commit-phase read returns ANOTHER subscription's
      // record (same item values and resource_version, different
      // id) — a wrong-record read the rv fingerprint cannot catch.
      return { ...res, json: { subscription: { ...(res.json as any).subscription, id: "pilot-sub-999" } } };
    }
    return res;
  };
  const client = new ChargebeeClient({ site: "pilot-test", apiKey: "pilot-mock-key" }, transport);
  const adapter = new ChargebeeLiveAdapter(client, new QuoteStore(), { liveCommitEnabled: true });

  const quote = await adapter.createChangeQuote(SUB, PROPOSAL(21));
  armed = true;
  const err = await adapter.commitChangeQuote(quote.id).then(
    () => null,
    (e: unknown) => e,
  );

  console.log("=== TEST45 EVIDENCE 45.1 (observed on current main, 2026-11 reconciliation) ===");
  console.log(JSON.stringify({
    quotedSubscriptionRef: SUB,
    commitPhaseReadNamed: "pilot-sub-999",
    commitRefused: err !== null,
    blocked: (err as any)?.details?.blocked ?? null,
    outcome: (err as any)?.details?.outcome ?? null,
    mutatingDispatches: mock.mutationCount,
  }, null, 2));
  console.log("=== END TEST45 EVIDENCE ===");

  assert.ok(err !== null, "the commit must refuse when the validation read names another subscription");
  assert.equal((err as any)?.details?.blocked, "SUBSCRIPTION_IDENTITY_MISMATCH");
  assert.equal((err as any)?.details?.outcome, "CONFIRMED_NON_EXECUTION");
  assert.equal(mock.mutationCount, 0, "no mutating dispatch occurred");
});

test("Test 45.2 (Issue #22 F3 control): the identical flow with every read naming the SAME subscription passes the identity boundary (and is then refused by the authorization-preservation gate)", async () => {
  const mock = new PilotMockChargebee();
  const client = new ChargebeeClient({ site: "pilot-test", apiKey: "pilot-mock-key" }, mock.transport);
  const adapter = new ChargebeeLiveAdapter(client, new QuoteStore(), { liveCommitEnabled: true });
  const quote = await adapter.createChangeQuote(SUB, PROPOSAL(21));
  const err = await adapter.commitChangeQuote(quote.id).then(
    () => null,
    (e: unknown) => e,
  );
  // Identity is satisfied, so the flow proceeds to the next gate:
  // the preservation gate refuses this FULL_REPLACEMENT_ONLY
  // adapter's commit before dispatch (Finding 1's fix). No
  // dispatch occurs and no receipt is produced — the adapter has
  // no clean-commit path for item changes in this build.
  assert.ok(err !== null, "the commit must be refused by the preservation gate");
  assert.equal((err as any)?.details?.blocked, "AUTHORIZATION_PRESERVATION_UNENFORCEABLE");
  assert.equal(mock.mutationCount, 0, "no mutating dispatch occurred");
});

// ---------------------------------------------------------------------------
// 45.3–45.6 — F4: currency / cadence comparability (engine level)
// ---------------------------------------------------------------------------

const PROPOSAL_OBJ = {
  changes: [{ action: "CHANGE_QUANTITY", itemId: "item-x", quantity: 21 }],
  effectiveIntent: { type: "IMMEDIATE" },
} as unknown as SubscriptionChangeProposal;

function effect(opts: { currency: string; cadence?: string; source?: string }): CommercialEffect {
  return {
    immediate: { net: 20000 },
    recurring: { resultingAmount: 80900, currency: opts.currency, ...(opts.cadence ? { cadence: opts.cadence } : {}) },
    determinacy: { immediateFinancialEffect: "DETERMINED", recurringFinancialEffect: "DETERMINED" },
    provenance: {
      immediate: "test45 fixture",
      recurring: "test45 fixture",
      ...(opts.source ? { committedSource: opts.source } : {}),
    } as CommercialEffect["provenance"],
  };
}

test("Test 45.3 (Issue #22 F4): quoted USD vs committed EUR at the same numeric value must NOT reconcile OK", () => {
  const quoted = effect({ currency: "USD", cadence: "MONTHLY" });
  const committed = effect({ currency: "EUR", cadence: "MONTHLY", source: "provider_actual" });
  const result = reconcileCommittedEffect(quoted, committed, {}, PROPOSAL_OBJ);
  console.log("=== TEST45 EVIDENCE 45.3 (observed on unmodified main) ===");
  console.log(JSON.stringify({ quotedCurrency: "USD", committedCurrency: "EUR", amounts: "identical numbers", reconciliation: result.status }));
  console.log("=== END TEST45 EVIDENCE ===");
  assert.notEqual(result.status, "OK", "numerically equal amounts in DIFFERENT currencies are not equal; reconciliation must not report OK");
});

test("Test 45.4 (Issue #22 F4): the pre-mutation envelope gate likewise refuses a cross-currency revalidation", () => {
  const quoted = effect({ currency: "USD", cadence: "MONTHLY" });
  const revalidated = effect({ currency: "EUR", cadence: "MONTHLY", source: "revalidated_preview" });
  let violation: string | null = null;
  let threw = false;
  try {
    violation = checkAcceptanceEnvelope(quoted, revalidated, {}, PROPOSAL_OBJ);
  } catch {
    threw = true;
  }
  console.log("=== TEST45 EVIDENCE 45.4 (observed on unmodified main) ===");
  console.log(JSON.stringify({ violationReturned: violation, threw }));
  console.log("=== END TEST45 EVIDENCE ===");
  assert.ok(threw || violation !== null, "a revalidated effect in a different currency than the quote must not pass the acceptance envelope silently");
});

test("Test 45.5 (Issue #22 F4): quoted MONTHLY vs committed ANNUAL cadence at the same amount must NOT reconcile OK", () => {
  const quoted = effect({ currency: "USD", cadence: "MONTHLY" });
  const committed = effect({ currency: "USD", cadence: "ANNUAL", source: "provider_actual" });
  const result = reconcileCommittedEffect(quoted, committed, {}, PROPOSAL_OBJ);
  console.log("=== TEST45 EVIDENCE 45.5 (observed on unmodified main) ===");
  console.log(JSON.stringify({ quotedCadence: "MONTHLY", committedCadence: "ANNUAL", amounts: "identical numbers", reconciliation: result.status }));
  console.log("=== END TEST45 EVIDENCE ===");
  assert.notEqual(result.status, "OK", "the same amount at a different cadence is a different recurring obligation; reconciliation must not report OK");
});

test("Test 45.6 (Issue #22 F4 control): same currency, same cadence, same amounts reconcile OK", () => {
  const quoted = effect({ currency: "USD", cadence: "MONTHLY" });
  const committed = effect({ currency: "USD", cadence: "MONTHLY", source: "provider_actual" });
  const result = reconcileCommittedEffect(quoted, committed, {}, PROPOSAL_OBJ);
  assert.equal(result.status, "OK");
});

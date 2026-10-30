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
// Finding 3: the Chargebee-live adapter never checks that the
// post-commit re-read names the SAME subscription the quote was
// for. establishLiveCommit consumes the re-read's items and
// fingerprint — and chargebeeSubscriptionFingerprint is
// `rv:<resource_version>` when a resource_version is present, so
// the subscription ID is not even an input to the bracket. A
// post-commit GET returning a DIFFERENT subscription.id with
// matching item values therefore verifies VERIFIED/OK, and the
// receipt's resultingSnapshot names the other subscription while
// subscriptionRef names the quoted one. (PR #20's identity check
// covers the read-only PREFLIGHT path, not this mutating path.)
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
// 45.1 — F3: post-commit GET names a DIFFERENT subscription
// (expected FAIL on main)
// ---------------------------------------------------------------------------

test("Test 45.1 (Issue #22 F3): a post-commit re-read naming a different subscription.id must not verify VERIFIED/OK", async () => {
  const mock = new PilotMockChargebee();
  let mutated = false;
  const transport: HttpTransport = async (req) => {
    const res = await mock.transport(req);
    if (req.method === "POST" && req.url.includes("/update_for_items")) mutated = true;
    if (mutated && req.method === "GET" && (res.json as any)?.subscription) {
      // The provider read now returns ANOTHER subscription's record
      // (same item values, different id) — e.g. a wrong-record read
      // or an account mix-up on the provider side.
      return { ...res, json: { subscription: { ...(res.json as any).subscription, id: "pilot-sub-999" } } };
    }
    return res;
  };
  const client = new ChargebeeClient({ site: "pilot-test", apiKey: "pilot-mock-key" }, transport);
  const adapter = new ChargebeeLiveAdapter(client, new QuoteStore(), { liveCommitEnabled: true });

  const quote = await adapter.createChangeQuote(SUB, PROPOSAL(21));
  const receipt = await adapter.commitChangeQuote(quote.id);

  console.log("=== TEST45 EVIDENCE 45.1 (observed on unmodified main) ===");
  console.log(JSON.stringify({
    quotedSubscriptionRef: SUB,
    receiptSubscriptionRef: receipt.subscriptionRef,
    resultingSnapshotId: (receipt.resultingSnapshot as any)?.id,
    receiptOutcome: receipt.outcome,
    receiptReconciliation: receipt.reconciliation?.status,
  }, null, 2));
  console.log("=== END TEST45 EVIDENCE ===");

  assert.ok(
    !(receipt.outcome === "COMMITTED_AND_VERIFIED" && receipt.reconciliation.status === "OK"),
    `identity mismatch silently verified: the post-commit read named subscription "pilot-sub-999" but the receipt for ` +
      `"${SUB}" reports ${receipt.outcome}/${receipt.reconciliation.status} with resultingSnapshot.id="${(receipt.resultingSnapshot as any)?.id}"`,
  );
});

test("Test 45.2 (Issue #22 F3 control): the identical flow with the re-read naming the SAME subscription verifies cleanly", async () => {
  const mock = new PilotMockChargebee();
  const client = new ChargebeeClient({ site: "pilot-test", apiKey: "pilot-mock-key" }, mock.transport);
  const adapter = new ChargebeeLiveAdapter(client, new QuoteStore(), { liveCommitEnabled: true });
  const quote = await adapter.createChangeQuote(SUB, PROPOSAL(21));
  const receipt = await adapter.commitChangeQuote(quote.id);
  assert.equal(receipt.outcome, "COMMITTED_AND_VERIFIED");
  assert.equal(receipt.reconciliation.status, "OK");
  assert.equal((receipt.resultingSnapshot as any)?.id, SUB);
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

test("Test 45.3 (Issue #22 F4): quoted USD vs committed EUR at the same numeric value must NOT reconcile OK (expected FAIL)", () => {
  const quoted = effect({ currency: "USD", cadence: "MONTHLY" });
  const committed = effect({ currency: "EUR", cadence: "MONTHLY", source: "provider_actual" });
  const result = reconcileCommittedEffect(quoted, committed, {}, PROPOSAL_OBJ);
  console.log("=== TEST45 EVIDENCE 45.3 (observed on unmodified main) ===");
  console.log(JSON.stringify({ quotedCurrency: "USD", committedCurrency: "EUR", amounts: "identical numbers", reconciliation: result.status }));
  console.log("=== END TEST45 EVIDENCE ===");
  assert.notEqual(result.status, "OK", "numerically equal amounts in DIFFERENT currencies are not equal; reconciliation must not report OK");
});

test("Test 45.4 (Issue #22 F4): the pre-mutation envelope gate likewise ignores currency (expected FAIL)", () => {
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

test("Test 45.5 (Issue #22 F4): quoted MONTHLY vs committed ANNUAL cadence at the same amount must NOT reconcile OK (expected FAIL)", () => {
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

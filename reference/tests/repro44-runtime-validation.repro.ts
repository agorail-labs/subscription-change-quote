import { test } from "node:test";
import assert from "node:assert/strict";
import { QuoteStore } from "../src/store/quote-store.js";
import { StripeAdapter } from "../src/adapters/stripe-adapter.js";
import { checkAcceptanceEnvelope } from "../src/core/scq-engine.js";
import type { CommercialEffect, SubscriptionChangeProposal } from "../src/core/types.js";
import { freshStripeFixture } from "./fixtures.js";

// Test 44 — Issue #22, Finding 2 (P1): runtime proposal validation.
//
// Independent local rerun of Fabio's externally reported Finding 2
// against CURRENT main. TypeScript types do not validate JSON: a
// proposal arriving as parsed JSON can carry a misspelled
// guaranteeMode ("REVALDIATE") or malformed envelope bounds (NaN,
// negative, string-typed), and nothing at runtime refuses them.
//
//   resolveGuaranteeMode (core/scq-engine.ts) returns
//   proposal.guaranteeMode verbatim when present; enforceGuarantee
//   Request branches only on the literals "EXACT" and "REVALIDATE",
//   so a typo'd mode satisfies NEITHER branch: EXACT's coverage
//   check is skipped AND REVALIDATE's acceptanceEnvelope
//   requirement is skipped. The commit path's mode branches
//   (stripe-adapter.ts: `effectiveMode === "REVALIDATE"`,
//   `=== "EXACT"`) likewise fall through, so the commit runs with
//   no envelope gate at all and reconciles OK in the no-envelope
//   case. compareDeterminedDimensions reads envelope bounds with
//   `?? 0` and compares numerically: a NaN bound makes every
//   comparison false (silent pass); a string bound coerces or
//   NaNs out the same way.
//
// REPRODUCTION file: tests assert the SAFE behavior (runtime
// refusal of malformed mode/bounds, before any provider
// read/preview) and are EXPECTED TO FAIL on unmodified main. Do
// not weaken them; the fix belongs in a separate implementation PR.
//
// RESEARCH SUITE (PR #23 REVIEW-1): this file is NOT part of the
// default `npm test` discovery (`dist/tests/*.test.js`). Build,
// then invoke the research suite explicitly:
// `node --test dist/tests/*.repro.js`.
// Everything runs against the in-memory Stripe simulator
// (SIMULATED evidence only).

const baseProposal = (overrides: Record<string, unknown>): SubscriptionChangeProposal =>
  ({
    changes: [{ action: "CHANGE_QUANTITY", itemId: "si_1", quantity: 120 }],
    effectiveIntent: { type: "IMMEDIATE" },
    ...overrides,
  }) as SubscriptionChangeProposal;

/** Runs quote (+commit when the quote was accepted) and reports what happened instead of throwing. */
async function attemptFlow(proposal: SubscriptionChangeProposal) {
  const { sim, sub } = freshStripeFixture();
  const adapter = new StripeAdapter(sim, new QuoteStore());
  let quoteError: unknown;
  let quote: Awaited<ReturnType<typeof adapter.createChangeQuote>> | undefined;
  try {
    quote = await adapter.createChangeQuote(sub.id, proposal);
  } catch (e) {
    quoteError = e;
  }
  let receipt: Awaited<ReturnType<typeof adapter.commitChangeQuote>> | undefined;
  let commitError: unknown;
  if (quote) {
    try {
      receipt = await adapter.commitChangeQuote(quote.id);
    } catch (e) {
      commitError = e;
    }
  }
  return { quoteError, quote, receipt, commitError };
}

function evidence(label: string, r: Awaited<ReturnType<typeof attemptFlow>>): void {
  console.log(`=== TEST44 EVIDENCE ${label} (observed on unmodified main) ===`);
  console.log(JSON.stringify({
    quoteRefused: r.quoteError ? String((r.quoteError as Error).message ?? r.quoteError).slice(0, 160) : null,
    quoteCreated: r.quote !== undefined,
    effectiveGuaranteeModeOnQuote: (r.quote as any)?.guaranteeMode,
    commitRefused: r.commitError ? String((r.commitError as Error).message ?? r.commitError).slice(0, 160) : null,
    receiptOutcome: r.receipt?.outcome,
    receiptReconciliation: r.receipt?.reconciliation?.status,
  }, null, 2));
  console.log("=== END TEST44 EVIDENCE ===");
}

// ---------------------------------------------------------------------------
// 44.1 — Misspelled guaranteeMode + absent envelope (expected FAIL)
// ---------------------------------------------------------------------------

test("Test 44.1 (Issue #22 F2): guaranteeMode \"REVALDIATE\" (typo) with NO acceptanceEnvelope must be refused at quote creation", async () => {
  const r = await attemptFlow(baseProposal({ guaranteeMode: "REVALDIATE" }));
  evidence("44.1 typo mode, no envelope", r);
  assert.ok(
    r.quoteError,
    `a misspelled guaranteeMode must be refused at runtime (no refusal occurred; the flow produced ` +
      `outcome=${r.receipt?.outcome}, reconciliation=${r.receipt?.reconciliation?.status})`,
  );
});

// ---------------------------------------------------------------------------
// 44.2 — NaN envelope bound (expected FAIL)
// ---------------------------------------------------------------------------

test("Test 44.2 (Issue #22 F2): a NaN envelope bound must be refused at quote creation", async () => {
  const r = await attemptFlow(baseProposal({
    guaranteeMode: "REVALIDATE",
    acceptanceEnvelope: { maxImmediateNetIncrease: NaN },
  }));
  evidence("44.2 NaN bound", r);
  assert.ok(r.quoteError, "a NaN acceptance-envelope bound is malformed input and must be refused, not silently compared as never-exceedable");
});

// ---------------------------------------------------------------------------
// 44.3 — Negative envelope bound (expected FAIL)
// ---------------------------------------------------------------------------

test("Test 44.3 (Issue #22 F2): a negative envelope bound must be refused at quote creation", async () => {
  const r = await attemptFlow(baseProposal({
    guaranteeMode: "REVALIDATE",
    acceptanceEnvelope: { maxRecurringIncrease: -5 },
  }));
  evidence("44.3 negative bound", r);
  assert.ok(r.quoteError, "a negative acceptance-envelope bound is malformed input and must be refused at quote creation with a validation error");
});

// ---------------------------------------------------------------------------
// 44.4 — String-typed envelope bound (expected FAIL)
// ---------------------------------------------------------------------------

test("Test 44.4 (Issue #22 F2): a string-typed envelope bound must be refused at quote creation", async () => {
  const r = await attemptFlow(baseProposal({
    guaranteeMode: "REVALIDATE",
    acceptanceEnvelope: { maxImmediateNetIncrease: "abc" },
  }));
  evidence("44.4 string bound", r);
  assert.ok(r.quoteError, "a non-numeric acceptance-envelope bound (JSON can carry one) must be refused, not coerced/NaN-compared into a silent pass");
});

// ---------------------------------------------------------------------------
// 44.5 — Engine level: a NaN bound neutralizes the envelope gate
// itself (expected FAIL). A drift of +5000 against a NaN
// maxImmediateNetIncrease must not read as "within envelope".
// ---------------------------------------------------------------------------

test("Test 44.5 (Issue #22 F2): checkAcceptanceEnvelope with a NaN bound must not silently pass a drifted revalidation", () => {
  const quoted: CommercialEffect = {
    immediate: { net: 20000 },
    recurring: { resultingAmount: 80900, currency: "USD" },
    determinacy: { immediateFinancialEffect: "DETERMINED", recurringFinancialEffect: "DETERMINED" },
    provenance: { immediate: "test44 fixture (quoted)", recurring: "test44 fixture (quoted)" },
  };
  const revalidated: CommercialEffect = {
    immediate: { net: 25000 },
    recurring: { resultingAmount: 80900, currency: "USD" },
    determinacy: { immediateFinancialEffect: "DETERMINED", recurringFinancialEffect: "DETERMINED" },
    provenance: { immediate: "test44 fixture (revalidated)", recurring: "test44 fixture (revalidated)", committedSource: "revalidated_preview" },
  };
  const proposal = baseProposal({ guaranteeMode: "REVALIDATE", acceptanceEnvelope: { maxImmediateNetIncrease: NaN } });
  let violation: string | null = null;
  let threw = false;
  try {
    violation = checkAcceptanceEnvelope(quoted, revalidated, { maxImmediateNetIncrease: NaN }, proposal);
  } catch {
    threw = true; // a fail-closed refusal of the malformed bound is a safe outcome
  }
  console.log("=== TEST44 EVIDENCE 44.5 (observed on unmodified main) ===");
  console.log(JSON.stringify({ drift: "+5000 immediate.net", bound: "NaN", violationReturned: violation, threw }));
  console.log("=== END TEST44 EVIDENCE ===");
  assert.ok(threw || violation !== null, "a NaN bound must not make a +5000 drift read as within-envelope (NaN comparisons are always false)");
});

// ---------------------------------------------------------------------------
// 44.6 — CONTROL: a well-formed REVALIDATE proposal with a valid
// envelope quotes and commits cleanly (passes on main).
// ---------------------------------------------------------------------------

test("Test 44.6 (Issue #22 F2 control): well-formed REVALIDATE proposal with finite nonnegative bounds works", async () => {
  const r = await attemptFlow(baseProposal({
    guaranteeMode: "REVALIDATE",
    acceptanceEnvelope: { maxImmediateNetIncrease: 0, maxImmediateCreditDecrease: 0, maxRecurringIncrease: 0 },
  }));
  assert.equal(r.quoteError, undefined);
  assert.equal(r.receipt?.outcome, "COMMITTED_AND_VERIFIED");
  assert.equal(r.receipt?.reconciliation?.status, "OK");
});

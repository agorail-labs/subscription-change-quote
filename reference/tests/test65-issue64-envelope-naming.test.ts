import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Temp-dir cleanup (same discipline as test56/test63/test64).
// ---------------------------------------------------------------------------
const tempDirs: string[] = [];
after(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tmpDb(name = "scq.db"): string {
  const dir = mkdtempSync(join(tmpdir(), "scq-i64-"));
  tempDirs.push(dir);
  return join(dir, name);
}

import {
  checkAcceptanceEnvelope,
  envelopeShapeProblem,
  reconcileCommittedEffect,
  validateProposalRuntime,
  validateStoredQuoteRuntime,
} from "../src/core/scq-engine.js";
import { SCQError, type CommercialEffect } from "../src/core/types.js";
import { DurableQuoteStore } from "../src/store/durable-store.js";
import { makeStoredQuote } from "./helpers/durable-fixtures.js";

// Test 65 — Issue #64 (v0.7): immediate net-decrease envelope naming.
//
// v0.6.2 names the negative-delta immediate bound
// maxImmediateCreditDecrease ("decrease in an immediate credit
// magnitude"). The name is arithmetically wrong for the quantity it
// bounds: immediate.net is SIGNED (positive = net charge, negative =
// net credit), and a negative delta is a decrease of that signed
// quantity whether the quote was a charge (+1000 -> +800), a credit
// that grew (-500 -> -700), or a move across zero (+100 -> -100).
// v0.7's canonical name is maxImmediateNetDecrease — parallel to
// maxImmediateNetIncrease, naming the arithmetic and nothing else.
// maxImmediateFavorableNetMovement was rejected: it names a presumed
// desirability instead of the arithmetic and conceals the direction
// (a "favorable movement" IS a net decrease). See
// spec/scq-v0.7-envelope-naming-proposal.md.
//
// The mathematics does NOT change: delta > 0 is bounded by
// maxImmediateNetIncrease, delta < 0 by the decrease bound, delta = 0
// by neither; absent bound = zero tolerance; equality at the bound
// passes. Compatibility: the legacy spelling remains an indefinitely
// supported alias with identical semantics; BOTH spellings in one
// envelope are refused as ambiguous (no precedence, no silent
// choice, no widening); the closed field set and no-coercion rules
// are unchanged; stored records are never rewritten.
//
// FAILING-FIRST provenance: against the unmodified engine, every
// canonical-name case fails (the closed field set refuses
// maxImmediateNetDecrease as an unknown field), while the legacy
// cases pass as controls — the before/after equivalence of the
// legacy spelling IS the compatibility claim. All evidence is
// simulator/engine-level; no live provider is touched.

const NEW = "maxImmediateNetDecrease";
const OLD = "maxImmediateCreditDecrease";

const quoted = (net: number, currency = "usd"): CommercialEffect => ({
  immediate: { net },
  recurring: { resultingAmount: 5000, currency },
  determinacy: { immediateFinancialEffect: "DETERMINED", recurringFinancialEffect: "DETERMINED" },
  provenance: { immediate: "test65 fixture: quote preview", recurring: "test65 fixture: quote preview" },
});
const committed = (net: number, currency: string | undefined = "usd"): CommercialEffect => ({
  immediate: { net },
  // currency is a required string in the typed shape; a record whose
  // currency is ABSENT is the unestablishable-unit case the engine
  // must classify (never OK), so the fixture builds it as data.
  recurring: { resultingAmount: 5000, ...(currency !== undefined ? { currency } : {}) } as CommercialEffect["recurring"],
  determinacy: { immediateFinancialEffect: "DETERMINED", recurringFinancialEffect: "DETERMINED" },
  provenance: { committedSource: "provider_actual" },
});

// The mandated truth table: [quotedNet, comparedNet].
const ROWS: Array<[number, number]> = [
  [1000, 1200], // +200 net increase
  [1000, 800], //  -200 net decrease
  [-500, -700], // -200 net decrease (credit grew)
  [-500, -300], // +200 net increase (credit shrank)
  [100, -100], //  -200 net decrease across zero
  [-100, 100], //  +200 net increase across zero
  [0, 0], //        no drift
];

/** Runs one truth-table cell at the quote/revalidation gate. Returns true when accepted. */
function gateAccepts(quotedNet: number, comparedNet: number, envelope: Record<string, unknown>): boolean {
  return checkAcceptanceEnvelope(quoted(quotedNet), quoted(comparedNet), envelope as never) === null;
}

/** The tolerance matrix for one governing bound spelling. */
function assertTruthTable(spelling: string): void {
  for (const [q, c] of ROWS) {
    const delta = c - q;
    const governing = delta > 0 ? "maxImmediateNetIncrease" : spelling;
    if (delta === 0) {
      assert.equal(gateAccepts(q, c, {}), true, `row ${q}->${c}: no drift passes with an empty envelope`);
      assert.equal(gateAccepts(q, c, { [spelling]: 0 }), true, `row ${q}->${c}: no drift passes with a zero decrease bound`);
      continue;
    }
    const mag = Math.abs(delta);
    assert.equal(gateAccepts(q, c, {}), false, `row ${q}->${c}: absent bound = zero tolerance, drift ${delta} refuses`);
    assert.equal(gateAccepts(q, c, { [governing]: 0 }), false, `row ${q}->${c}: zero tolerance refuses drift ${delta}`);
    assert.equal(gateAccepts(q, c, { [governing]: mag }), true, `row ${q}->${c}: tolerance exactly |delta| passes (boundary equality)`);
    assert.equal(gateAccepts(q, c, { [governing]: mag - 1 }), false, `row ${q}->${c}: tolerance one minor unit below |delta| refuses`);
    assert.equal(gateAccepts(q, c, { [governing]: mag + 50 }), true, `row ${q}->${c}: tolerance above |delta| passes`);
    if (delta < 0) {
      // The increase bound never governs a decrease, and vice versa:
      // a generous WRONG-direction bound must not rescue the drift.
      assert.equal(gateAccepts(q, c, { maxImmediateNetIncrease: 100_000, [spelling]: mag - 1 }), false, `row ${q}->${c}: a generous increase bound does not govern a decrease`);
    } else {
      assert.equal(gateAccepts(q, c, { [spelling]: 100_000, maxImmediateNetIncrease: mag - 1 }), false, `row ${q}->${c}: a generous decrease bound (${spelling}) does not govern an increase`);
    }
  }
}

// ---------------------------------------------------------------------------
// 65.1 / 65.2 — the truth table under each spelling (equivalence)
// ---------------------------------------------------------------------------

test("Test 65.1 (Issue #64): the full truth table under the canonical maxImmediateNetDecrease, at the quote/revalidation gate", () => {
  assertTruthTable(NEW);
});

test("Test 65.2 (Issue #64): the full truth table under the legacy maxImmediateCreditDecrease — outcomes identical to the canonical spelling", () => {
  assertTruthTable(OLD);
});

// ---------------------------------------------------------------------------
// 65.3 — post-commit reconciliation under both spellings
// ---------------------------------------------------------------------------

test("Test 65.3 (Issue #64): post-commit reconciliation honors both spellings identically and names the supplying spelling in violations", () => {
  for (const spelling of [NEW, OLD]) {
    // Decrease within bound -> OK; over bound -> VIOLATED naming the spelling.
    assert.equal(reconcileCommittedEffect(quoted(1000), committed(800), { [spelling]: 200 } as never).status, "OK", `${spelling}: -200 within bound 200 reconciles OK (boundary equality)`);
    const over = reconcileCommittedEffect(quoted(1000), committed(800), { [spelling]: 199 } as never);
    assert.equal(over.status, "VIOLATED", `${spelling}: -200 over bound 199 is VIOLATED`);
    assert.match((over as { reason?: string }).reason ?? "", new RegExp(spelling), `${spelling}: the violation names the spelling that supplied the bound`);
    // Credit growth is a net decrease and is governed by this bound.
    assert.equal(reconcileCommittedEffect(quoted(-500), committed(-700), { [spelling]: 200 } as never).status, "OK", `${spelling}: -500 -> -700 (credit grew) is a net decrease within bound`);
    assert.equal(reconcileCommittedEffect(quoted(-500), committed(-700), { [spelling]: 0 } as never).status, "VIOLATED", `${spelling}: credit growth with zero tolerance is VIOLATED — the case the old name described backwards`);
    // Cross-zero decrease.
    assert.equal(reconcileCommittedEffect(quoted(100), committed(-100), { [spelling]: 200 } as never).status, "OK", `${spelling}: +100 -> -100 within bound`);
    // No drift needs no bound at all.
    assert.equal(reconcileCommittedEffect(quoted(0), committed(0), {} as never).status, "OK", `${spelling}: 0 -> 0 reconciles OK with an empty envelope`);
  }
});

// ---------------------------------------------------------------------------
// 65.4 — both spellings present: refused as ambiguous
// ---------------------------------------------------------------------------

test("Test 65.4 (Issue #64): an envelope carrying BOTH spellings is refused as ambiguous — equal values included, at shape, gate, and proposal validation", () => {
  const both = { [NEW]: 200, [OLD]: 200 };
  const problem = envelopeShapeProblem(both);
  assert.ok(problem !== null, "both spellings with values is a shape problem");
  assert.match(problem, /both/, "the problem names the ambiguity");
  assert.ok(problem.includes(NEW) && problem.includes(OLD), "the problem names both fields");
  assert.throws(
    () => checkAcceptanceEnvelope(quoted(1000), quoted(800), both as never),
    (e: unknown) => e instanceof SCQError && (e as SCQError).code === "INVALID_PROPOSAL",
    "the pre-dispatch gate refuses the ambiguous envelope as INVALID_PROPOSAL",
  );
  assert.throws(
    () => validateProposalRuntime({ changes: [{ action: "CHANGE_QUANTITY", itemId: "item_1", quantity: 2 }], effectiveIntent: { type: "IMMEDIATE" }, guaranteeMode: "REVALIDATE", acceptanceEnvelope: both }),
    (e: unknown) => e instanceof SCQError && (e as SCQError).code === "INVALID_PROPOSAL",
    "proposal validation refuses the ambiguous envelope",
  );
  // Unequal values are equally ambiguous — no max/min merge, no winner.
  assert.ok(envelopeShapeProblem({ [NEW]: 500, [OLD]: 100 }) !== null, "unequal dual spellings are refused, not merged");
  // A spelling present with value undefined is omission, not coexistence.
  assert.equal(envelopeShapeProblem({ [NEW]: 200, [OLD]: undefined }), null, "an undefined-valued spelling is omission (existing doctrine), not ambiguity");
  assert.equal(gateAccepts(1000, 800, { [NEW]: 200, [OLD]: undefined }), true, "the single valued spelling governs");
});

// ---------------------------------------------------------------------------
// 65.5 — invalid values on either spelling: never coerced
// ---------------------------------------------------------------------------

test("Test 65.5 (Issue #64): malformed bounds refuse on both spellings — NaN, Infinity, negative, string, null", () => {
  for (const spelling of [NEW, OLD]) {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1, "200", null, {}, []] as unknown[]) {
      const problem = envelopeShapeProblem({ [spelling]: bad });
      assert.ok(problem !== null, `${spelling} = ${String(bad)} must be a shape problem`);
      assert.ok(problem.includes(spelling), "the problem names the malformed field");
    }
    assert.equal(envelopeShapeProblem({ [spelling]: 0 }), null, `${spelling} = 0 is a valid zero tolerance`);
    assert.equal(envelopeShapeProblem({ [spelling]: 200 }), null, `${spelling} = 200 is valid`);
  }
  // One valid + one malformed across the pair still refuses.
  assert.ok(envelopeShapeProblem({ [NEW]: 200, [OLD]: "200" }) !== null, "a malformed legacy value refuses even beside a valid canonical one");
});

// ---------------------------------------------------------------------------
// 65.6 — unknown and misspelled fields still fail closed
// ---------------------------------------------------------------------------

test("Test 65.6 (Issue #64): misspellings and unknown fields refuse; the supported-fields message lists the canonical name", () => {
  for (const typo of ["maxImmediateNetDecrese", "maxImmediateNetDecreaseX", "maxImmediateCreditDecrese", "maxImmediateNetDecreas"]) {
    const problem = envelopeShapeProblem({ [typo]: 200 });
    assert.ok(problem !== null, `${typo} must refuse as an unsupported field`);
    assert.match(problem, /unsupported field/, "refused under the closed-field-set rule");
    assert.ok(problem.includes(NEW), "the supported-fields list includes the canonical name");
  }
});

// ---------------------------------------------------------------------------
// 65.7 — prototype pollution and inherited properties
// ---------------------------------------------------------------------------

test("Test 65.7 (Issue #64): a polluted or inherited canonical bound states no bound — same posture as the legacy spelling", () => {
  const proto = Object.prototype as unknown as Record<string, unknown>;
  proto[NEW] = 1_000_000;
  try {
    assert.equal(gateAccepts(1000, 800, {}), false, "a polluted Object.prototype canonical bound does not widen tolerance: absent still means zero");
    assert.equal(envelopeShapeProblem({}), null, "an empty envelope is shape-valid even under pollution (the pollution is not the caller's field)");
  } finally {
    delete proto[NEW];
  }
  const inheritedOnly = Object.create({ [NEW]: 500 }) as Record<string, unknown>;
  assert.equal(gateAccepts(1000, 800, inheritedOnly), false, "an inherited canonical bound is ignored — drift 200 refuses");
  const inheritedLegacy = Object.create({ [OLD]: 500 }) as Record<string, unknown>;
  assert.equal(gateAccepts(1000, 800, inheritedLegacy), false, "control: an inherited legacy bound is likewise ignored");
});

// ---------------------------------------------------------------------------
// 65.8 — currency comparability is not bypassed by the rename
// ---------------------------------------------------------------------------

test("Test 65.8 (Issue #64): established currency contradiction still refuses/violates and unestablishable currency still classifies UNVERIFIED under the canonical spelling", () => {
  // Quoted USD vs compared EUR: numbers within the decrease bound,
  // units contradict — not a pass.
  const violation = checkAcceptanceEnvelope(quoted(1000, "usd"), quoted(900, "eur"), { [NEW]: 200 } as never);
  assert.ok(violation !== null, "a within-bound decrease across contradicting currencies is not acceptable");
  assert.match(violation, /not comparable/, "the refusal is the unit contradiction, not the numeric drift");
  const rec = reconcileCommittedEffect(quoted(1000, "usd"), committed(900, "eur"), { [NEW]: 200 } as never);
  assert.equal(rec.status, "VIOLATED", "post-commit, the contradiction classifies VIOLATED");
  // Committed currency unestablishable: compliance unprovable.
  // (Construction mirrors test49.10: cadence stated, proposal
  // context supplied — the recurring dimension participates and
  // its unit cannot be established.)
  const PROPOSAL = {
    changes: [{ action: "CHANGE_QUANTITY" as const, itemId: "item_1", quantity: 2 }],
    effectiveIntent: { type: "IMMEDIATE" as const },
    guaranteeMode: "REVALIDATE" as const,
    acceptanceEnvelope: {},
  };
  const qU = { ...quoted(1000, "usd"), recurring: { resultingAmount: 5000, currency: "usd", cadence: "MONTHLY" } };
  const cU = {
    immediate: { net: 900 },
    recurring: { resultingAmount: 5000, cadence: "MONTHLY" },
    determinacy: { immediateFinancialEffect: "DETERMINED", recurringFinancialEffect: "DETERMINED" },
    provenance: { committedSource: "provider_actual" },
  } as unknown as CommercialEffect;
  const unv = reconcileCommittedEffect(qU, cU, { [NEW]: 200 } as never, PROPOSAL as never);
  assert.equal(unv.status, "UNVERIFIED", "an unestablishable participating currency classifies UNVERIFIED — never OK");
});

// ---------------------------------------------------------------------------
// 65.9 — serialized quote recovery across spellings (no rewriting)
// ---------------------------------------------------------------------------

function storeWithEnvelope(spelling: string, bound: number): string {
  const path = tmpDb();
  const store = new DurableQuoteStore(path, { recoveryGraceMs: 0 });
  const base = makeStoredQuote("q-i64", "sub_i64");
  const quote = {
    ...base,
    proposal: {
      ...base.proposal,
      guaranteeMode: "REVALIDATE",
      acceptanceEnvelope: { [spelling]: bound },
    } as typeof base.proposal,
  };
  store.put(quote);
  store.close();
  return path;
}

test("Test 65.9 (Issue #64): a persisted quote keeps its written spelling across restart and governs identically — records are never rewritten", () => {
  for (const spelling of [OLD, NEW]) {
    const path = storeWithEnvelope(spelling, 200);
    const reopened = new DurableQuoteStore(path, { recoveryGraceMs: 0 });
    const recovered = reopened.get("q-i64")!;
    const serialized = JSON.stringify(recovered.proposal.acceptanceEnvelope);
    assert.ok(serialized.includes(`"${spelling}"`), `${spelling}: the stored envelope still carries its written spelling after restart`);
    assert.ok(!serialized.includes(spelling === OLD ? `"${NEW}"` : `"${OLD}"`), `${spelling}: the other spelling was not introduced — no silent rewrite`);
    assert.doesNotThrow(() => validateStoredQuoteRuntime(recovered), `${spelling}: the recovered record validates at the commit-path validator`);
    const env = recovered.proposal.acceptanceEnvelope as Record<string, unknown>;
    assert.equal(gateAccepts(1000, 800, env), true, `${spelling}: the recovered bound 200 still admits a 200 decrease`);
    assert.equal(gateAccepts(1000, 799, env), false, `${spelling}: the recovered bound 200 still refuses a 201 decrease`);
    reopened.close();
  }
});

// ---------------------------------------------------------------------------
// 65.10 — historical replay: recorded envelopes classify as recorded
// ---------------------------------------------------------------------------

test("Test 65.10 (Issue #64): envelopes read back from serialized records (JSON round-trip) classify exactly as their in-memory forms", () => {
  for (const spelling of [OLD, NEW]) {
    const recorded = JSON.parse(`{"${spelling}": 200}`) as Record<string, unknown>;
    assert.equal(envelopeShapeProblem(recorded), null, `${spelling}: a serialized record carrying the spelling is shape-valid`);
    assert.equal(reconcileCommittedEffect(quoted(1000), committed(800), recorded as never).status, "OK", `${spelling}: recorded bound 200, decrease 200 -> OK`);
    assert.equal(reconcileCommittedEffect(quoted(1000), committed(799), recorded as never).status, "VIOLATED", `${spelling}: recorded bound 200, decrease 201 -> VIOLATED`);
  }
  // A recorded envelope carrying BOTH spellings can never classify OK
  // through the ambiguous bound (post-commit doctrine: uninterpretable
  // bounds cannot fire, and the classification is never OK on their
  // account) — and reconcile never throws on it.
  const bothRecorded = JSON.parse(`{"${NEW}": 100000, "${OLD}": 100000}`) as Record<string, unknown>;
  const res = reconcileCommittedEffect(quoted(1000), committed(800), bothRecorded as never);
  assert.notEqual(res.status, "OK", "a recorded both-spellings envelope never reconciles OK through the ambiguous bound");
});

// ---------------------------------------------------------------------------
// 65.11 — wire-level payloads: no string coercion, no widening
// ---------------------------------------------------------------------------

test("Test 65.11 (Issue #64): JSON wire payloads — string bounds are not coerced on either spelling; fractional bounds are not rounded into tolerance", () => {
  for (const spelling of [NEW, OLD]) {
    assert.ok(envelopeShapeProblem(JSON.parse(`{"${spelling}": "200"}`)) !== null, `${spelling}: a string bound from the wire refuses`);
    assert.equal(envelopeShapeProblem(JSON.parse(`{"${spelling}": 200}`)), null, `${spelling}: a numeric bound from the wire is accepted`);
  }
  // A fractional bound keeps its exact value: 199.5 does not become 200.
  assert.equal(gateAccepts(1000, 800, { [NEW]: 199.5 }), false, "bound 199.5 refuses a 200 decrease — no rounding up into tolerance");
  assert.equal(gateAccepts(1000, 801, { [NEW]: 199.5 }), true, "bound 199.5 admits a 199 decrease");
});

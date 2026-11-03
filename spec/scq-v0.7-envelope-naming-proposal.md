# SCQ v0.7 Proposal — Immediate Net-Decrease Tolerance: Naming and Compatibility

**Status: PROPOSAL for v0.7. Not ratified. This document does not amend
`spec/scq-v0.6.2-spec.md`, which remains frozen.**

Origin: Issue #64, carrying the disposition of Issue #22 Finding F6
(decision recorded 2026-11-02: defer the nomenclature correction to
v0.7; no retroactive normative amendment to frozen v0.6.2).

## 1. Problem

The acceptance envelope bounds quote-relative drift of `immediate.net`
with two tolerances. For a positive delta the bound is
`maxImmediateNetIncrease`. For a negative delta, v0.6.2 names the bound
`maxImmediateCreditDecrease`, documented as "Max decrease in an
immediate credit magnitude."

That name describes the arithmetic incorrectly. `immediate.net` is a
signed quantity (positive = net charge, negative = net credit, minor
units). A negative delta is a decrease of that signed quantity in
every case:

- a charge that shrinks (+1000 → +800) involves no credit at all;
- a credit that grows (−500 → −700) is a credit *increase* in
  magnitude, yet it is this bound that governs it;
- a move across zero (+100 → −100) is neither a charge change nor a
  credit-magnitude change in isolation — it is a net decrease of 200.

An integrator reading the v0.6.2 name can reasonably set the wrong
bound, or fail to set the bound that governs the case they care about.
This is a naming/documentation risk (F6's classification), not a
runtime defect: the comparator's established mathematics is correct
and is **not** changed by this proposal.

## 2. Terminology evaluation

Candidates were scored against five criteria: (1) mathematical
correctness over the signed quantity; (2) intelligibility to an
integrating developer; (3) validity for charge, zero, and credit
starting points; (4) unambiguity across zero; (5) consistency with the
minor-unit accounting convention and the existing sibling bound.

| Candidate | Verdict |
|---|---|
| `maxImmediateNetDecrease` | **Selected.** A negative delta *is* a decrease of `immediate.net` in every truth-table row. Exactly parallel to `maxImmediateNetIncrease`: the pair names the two directions of one signed quantity, so the API reads as a single concept. States arithmetic only — no presumed desirability. |
| `maxImmediateFavorableNetMovement` | Rejected. Names a presumed business desirability ("favorable") instead of the arithmetic — the same framing defect as the current code comment ("moved in the caller's favor"). "Movement" does not encode direction: a favorable movement *is* a net decrease, which the name conceals. Asymmetric with `maxImmediateNetIncrease`. Desirability is also caller-relative — an unexpectedly large credit can be an accounting defect, which is precisely why this bound exists. |
| `maxImmediateNetReduction` | Rejected. Arithmetically defensible, but "reduction" pairs less cleanly with the existing `Increase` sibling and carries a charge-side connotation in billing usage. No advantage over the selected name. |
| `maxImmediateNegativeNetDrift` | Rejected. "Drift" names the failure condition (the refusal code's vocabulary), not the bounded quantity; "negative" describes the delta's sign rather than the quantity's direction of change. |

## 3. Formal definition (proposed normative)

Amounts are signed minor units; positive `immediate.net` is a net
charge, negative is a net credit. Let
`delta = compared.immediate.net − quoted.immediate.net`, evaluated
only over dimensions established as comparable under the determinacy
and unit-comparability rules (unchanged from v0.6.2).

- `delta > 0`: the recomputation is acceptable iff
  `delta ≤ maxImmediateNetIncrease` (absent bound = zero tolerance).
- `delta < 0`: the recomputation is acceptable iff
  `−delta ≤ maxImmediateNetDecrease` (absent bound = zero tolerance).
- `delta = 0`: no immediate net drift; neither bound is consulted.

Equality at the bound passes; exceeding the bound refuses
(pre-dispatch) or classifies VIOLATED (post-commit), exactly as in
v0.6.2. `maxImmediateCreditDecrease` is the legacy alias of
`maxImmediateNetDecrease`: the same bound, the same mathematics, a
deprecated spelling.

### Truth table (normative examples)

| Quoted net | Compared net | Delta | Movement | Governing bound |
|---|---|---|---|---|
| +1000 | +1200 | +200 | Net increase | `maxImmediateNetIncrease` |
| +1000 | +800 | −200 | Net decrease | `maxImmediateNetDecrease` |
| −500 | −700 | −200 | Net decrease | `maxImmediateNetDecrease` |
| −500 | −300 | +200 | Net increase | `maxImmediateNetIncrease` |
| +100 | −100 | −200 | Net decrease across zero | `maxImmediateNetDecrease` |
| −100 | +100 | +200 | Net increase across zero | `maxImmediateNetIncrease` |
| 0 | 0 | 0 | No drift | — |

## 4. Compatibility requirements (proposed normative)

1. **Legacy payloads keep their semantics.** A v0.6.2 envelope
   carrying `maxImmediateCreditDecrease` is accepted and bounds
   negative deltas exactly as under v0.6.2. Nothing is reinterpreted.
2. **Canonical spelling.** v0.7 writers emit
   `maxImmediateNetDecrease`. Readers accept both spellings
   indefinitely; removing the alias is a separate future decision
   (no earlier than a major-version boundary), not part of v0.7.
3. **No precedence rule — coexistence is an error.** An envelope
   carrying *both* spellings with values is refused as malformed
   (pre-dispatch: `INVALID_PROPOSAL`; the shape error names both
   fields). There is no silent choice, no max/min merge, and no
   widening: ambiguity about a financial tolerance is refused, not
   resolved. (A spelling present with value `undefined` is omission,
   per the existing only-`undefined`-is-omission doctrine.)
4. **Closed field set, unchanged.** Any own enumerable key outside
   the supported set refuses the envelope, as in v0.6.2 §6.18 —
   misspellings of either spelling fail closed.
5. **No coercion, no defaulting.** Each spelling's value must be a
   finite, non-negative number, read as an own property only;
   malformed values refuse pre-dispatch and are never coerced.
6. **Stored records are never rewritten.** Persisted quotes,
   receipts, and replay records keep the spelling they were written
   with. The alias is resolved at read/compare time, in the
   sanitized-envelope step every comparison path already shares.
7. **Post-commit classification.** `reconcileCommittedEffect` never
   throws (v0.6.2 §6.18). A recorded envelope carrying both spellings
   is ambiguous recorded input: that bound is uninterpretable in the
   fireable projection (it cannot fire), and the classification is
   never OK on its account — the same treatment malformed bounds
   already receive. A recorded envelope carrying either single
   spelling classifies exactly as its v0.6.2 counterpart.
8. **Downgrade is fail-closed.** A v0.6.2 reader rejects a v0.7
   envelope carrying `maxImmediateNetDecrease` as an unknown field
   (its field set is closed). v0.7 envelopes are therefore not
   downgrade-compatible; this one-way property is stated, not
   papered over — the same posture as durable-store schema upgrades.

## 5. Proposed normative wording (for the v0.7 text)

- *Types documentation:* "`maxImmediateNetDecrease?: number` — Max
  decrease in `immediate.net` (signed minor units) the caller will
  accept without reconfirming. Bounds any negative delta of
  `immediate.net`, whether the quoted net is a charge, zero, or a
  credit. `maxImmediateCreditDecrease` is its deprecated v0.6.2
  alias with identical semantics; supplying both spellings in one
  envelope is a validation error."
- *§6.18 successor bullet:* "Only the named bounds
  (`maxImmediateNetIncrease`, `maxImmediateNetDecrease`,
  `maxRecurringIncrease`, and the legacy alias
  `maxImmediateCreditDecrease`) are read… An envelope carrying both
  `maxImmediateNetDecrease` and `maxImmediateCreditDecrease` with
  values is malformed."
- *Diagnostic wording:* the decrease-dimension violation message is
  reworded from the v0.6.2 "moved in the caller's favor" framing to
  arithmetic language — "immediate.net decreased by N (quoted A ->
  revalidated B), exceeding \<field\>=M" — naming the spelling that
  supplied the bound. Refusal codes and reconciliation
  classifications are unchanged; messages are diagnostics, not
  protocol codes.

## 6. Migration strategy

No data migration exists or is needed: no store schema change, no
record rewriting, no flag day. The version boundary is the envelope
field set defined here plus reader behavior. Old durable stores open
under v0.7 unchanged; in-flight quotes carrying the legacy spelling
validate, commit, reconcile, and replay identically. Rollout is:
ratify this proposal → land the implementation (companion PR) →
integrators adopt the canonical spelling at their own pace.

## 7. Security and interoperability implications

- The both-spellings refusal closes a tolerance-smuggling vector:
  without it, a proxy or serializer emitting both names could have
  the wider one silently honored.
- Own-property reads, the null-prototype sanitized envelope, and
  prototype-pollution posture are unchanged; the new spelling
  receives exactly the same treatment (an inherited canonical bound
  states no bound).
- Interoperability cost is one additional accepted field name and
  one documented alias; the wire semantics of every v0.6.2 payload
  are bit-identical.

## 8. Explicit non-goals

- No change to acceptance mathematics, determinacy, unit
  comparability, or any other envelope dimension
  (`maxRecurringIncrease` has no naming defect and is untouched).
- No amendment to frozen v0.6.2 text or to the published
  `0.6.2-experimental.1` artifact; no republication.
- No removal of the legacy alias.
- No claim that an acceptance envelope is an absolute spending cap
  or an authorization grant — it remains a quote-relative drift
  tolerance, as in v0.6.2.

## 9. Decisions required for ratification

1. Ratify the selected name (`maxImmediateNetDecrease`) and §4's
   compatibility rules as v0.7 normative text.
2. Ratify the §5 diagnostic rewording (message text only; codes
   unchanged).
3. Authorize the companion implementation PR's frozen-surface edits
   (`reference/src/core/types.ts`, `reference/src/core/scq-engine.ts`)
   through the protocol freeze guard (`protocol-change-approved`)
   once this proposal is accepted.

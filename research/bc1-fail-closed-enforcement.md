# BC-1 fail-closed financial enforcement and truthful reconciliation (PR-10)

Implements issue #7's BC-1 row (with BC-2's reconciliation leg): the
fail-closed activation the v0.6.2 program deferred at every earlier
step. Core invariant: **UNKNOWN is never zero; missing evidence is
never proof of compliance; an explicitly established zero remains
valid.**

Baseline: main `25ba49f` (483/483, fresh clean build, Node 22.14).
Result: **518/518** (+35 new tests, test35). No live billing mutation
is authorized or performed; `SCQ_LIVE_COMMIT_ENABLED` is never set;
every mutation scenario runs through mocked transports
(**SIMULATED_PASS** at best).

## 1. Audit (performed before coding)

### 1.1 The defect

`checkAcceptanceEnvelope` (core, `scq-engine.ts`) carried the four
v0.6.1 zero-coercions — quoted/revalidated × `immediate.net` /
`recurring.resultingAmount`, each read with `?? 0`. A dimension a
provider could not determine compared as 0: two UNKNOWNs "matched",
and an UNKNOWN revalidation against a quoted 1000 read as a
1000-credit drift or as compliance, depending on direction.
`reconcileCommittedEffect` delegated to the same check, so a
committed effect with UNKNOWN dimensions reconciled **OK** whenever
the coerced arithmetic happened to fit — verified live against the
Oct 2026 Chargebee test site (Defect 1, HIGH, in
`~/workspace/scq-live-validation-evidence/`).

The v0.6.2 machinery to fix this existed but was report-only:
`determinacyOf` (absent ⇒ UNKNOWN), `auditDeterminacy`
(WOULD_REFUSE_UNKNOWN / INVALID_DETERMINED_VALUE /
MISSING_PROVENANCE / PROVENANCE_NOT_ESTABLISHING /
UNJUSTIFIED_NOT_APPLICABLE / MISSING_ACTION_CONTEXT /
MISSING_APPLICABILITY_PROVENANCE; applicability table licensing
only CANCEL × immediateFinancialEffect), the branded
`establishVerification`, and adapter-local M2 gates
(`assertEffectDeterminateForCommit` and equivalents) that refused
UNKNOWN before mutation inside each adapter. Research note
`research/core-state-verification.md` §7 named the connection
points; PR-10 is the activation they pointed at.

### 1.2 Call-site table

`checkAcceptanceEnvelope` — every site has the `proposal` in scope
and is preceded by an adapter-local M2 gate refusing UNKNOWN on
both effects:

| Site | Flow | Pre-existing guarantee | BC-1 impact |
|---|---|---|---|
| stripe-adapter (commit) | REVALIDATE re-preview check | local gate on quoted + revalidated | core gate is a stricter backstop (provenance + N/A justification); no behavior change for adapter-produced effects |
| paddle-adapter (commit) | same | same | same |
| zuora-adapter (commit) | same | same | same |
| chargebee-adapter (commit) | same | same | same |
| chargebee-adapter (cancel) | envelope checked only when the proposal states one | local gate on both effects | same backstop, cancel path only |
| chargebee-live (commit) | after local gate, BEFORE `beginDurableAttempt` | local gate; durable intent not yet created | a core refusal also precedes durable intent — no DISPATCHING record can be created by an unenforceable commit (test35.20) |
| tests (test14) | behavior pin | pinned v0.6.1 coercion "until the activation" | pin superseded by this PR (disclosed, §7) |

`reconcileCommittedEffect` — receipt construction and store
verification:

| Site | Committed-effect source | BC-1 impact |
|---|---|---|
| stripe / paddle / zuora / chargebee-sim receipt construction | adapter-built actuals with establishing `committedSource`, or adapter-constructed UNVERIFIED on the COMMITTED_UNVERIFIED path | established effects reconcile exactly as before (suite-verified); an unestablished effect routed here now yields UNVERIFIED instead of a zero-comparison OK/VIOLATED |
| chargebee-live `establishLiveCommit` | response-bound actuals (PR-7 doctrine) | same |
| quote-store `verifyCommitReceipt` (recompute) | recorded quoted effect + evidence's committed effect | now receives the quote's proposal (action context); evidence over a legacy quoted effect with an envelope recomputes UNVERIFIED (§6) |
| quote-store `establishVerification` | independent observation | same propagation |

### 1.3 Adapter-local gates (M2) — retained

All five adapters refuse UNKNOWN dimensions locally before any
mutating call, with adapter-specific error detail. BC-1 does not
remove them: they are the earlier, stage-naming refusal; the core
gate is the protocol-level backstop that also covers direct core
consumers, the store's recomputation, and any future adapter that
forgets its local gate. The stale "activation is a later step"
comments in the five adapters were updated to record the
composition.

## 2. Design

One shared per-dimension, per-side assessment in `scq-engine.ts`
drives both functions — the gate and reconciliation can never
develop parallel interpretations of the three-state model. The
state machine mirrors `auditDeterminacy`'s exactly (same
`determinacyOf` reading, same finite-value rule, same
applicability license and citation validation order: context →
license → citation). `auditDeterminacy` itself is untouched and
stays the report-only diagnostic; test35.17 pins gate/audit
agreement on UNKNOWN, legacy, invalid-value, N/A-failure, and
committed-side estimate-source cases.

A side is **determined** (finite numeric value + role provenance),
**not-applicable** (justified), or **unenforceable**. A dimension
is **comparable** iff both sides are determined, **skipped** iff
both sides are justified NOT_APPLICABLE, and otherwise
**unenforceable** — including a one-sided NOT_APPLICABLE: a value
is never compared against an absence, and a skip is never a zero.

Two role differences from the audit are deliberate:

- **Quote role** (quoted effect in both functions; revalidated
  effect in the gate): quote-side figures are estimates by nature,
  so DETERMINED requires the dimension's provenance **note** (the
  audit's C4 basis record). `provenance.committedSource` is
  meaningless quote-side (types.ts) and ignored — a revalidated
  effect's `revalidated_preview` label is lineage, not a claim of
  actuals, so the gate is not confused by it.
- **Committed role** (committed effect in reconciliation):
  DETERMINED establishes actuals only through an establishing
  `committedSource` — `provider_actual` or `defined_equal_exact`.
  Estimate-derived sources report PROVENANCE_NOT_ESTABLISHING; an
  absent or `unestablished` source reports MISSING_PROVENANCE even
  when a free-form note exists (types.ts: an absent committedSource
  *reads* as "unestablished" for reconciliation; a provenance
  string is not authentication — adapters remain responsible for
  binding figures to operation-bound provider reads).

### 2.1 Pre-mutation enforcement

`assertEnvelopeEnforceable(quoted, compared, proposal?)` (new,
exported) throws `SCQError` **QUOTE_NOT_DETERMINISTIC** naming each
unenforceable dimension with both sides' states and findings;
`details.outcome` is `CONFIRMED_NON_EXECUTION`.
`checkAcceptanceEnvelope(quoted, revalidated, envelope, proposal?)`
calls it before comparing, then runs the v0.6.1 numeric comparison
— extracted unchanged as `compareDeterminedDimensions`, identical
violation strings — restricted to comparable dimensions. Missing
envelope bounds keep zero tolerance (fail-closed governs the
values compared, not the caller's tolerances). `proposal` is an
optional fourth argument (the smallest safe signature change): it
carries the authoritative action context — the proposal's single
change action; a multi-change proposal has no single action
context, so NOT_APPLICABLE cannot be licensed for it (combined
effects genuinely arise), and a caller supplying no proposal
supplies no context, so a self-asserted citation is never
validated. All 15 production call sites (6 envelope, 9 reconcile,
across the five adapters and the store) propagate it.

### 2.2 Post-commit reconciliation

`reconcileCommittedEffect(quoted, committed, envelope, proposal?)`
never throws. Verdict precedence, defined here and pinned in
test35:

1. **VIOLATED** — a comparable dimension's established committed
   value exceeds the envelope. An established violation is never
   downgraded because another dimension is unestablished
   (test35.26).
2. **UNVERIFIED** — no established violation, but at least one
   dimension is unenforceable on either side. Carries
   `undeterminedDimensions`. An UNKNOWN committed dimension cannot
   produce OK by absence, by numeric coincidence, or by sharing
   the quote's number (test35.21/22/23).
3. **OK** — every dimension comparable-and-within, or skipped as
   justified NOT_APPLICABLE on both sides.

**No-envelope case.** With no envelope there is nothing to
*compare*, and OK keeps its v0.6.1 meaning of "no comparison
applies" — but only when the committed figures the receipt reports
are themselves established (committed side judged alone: every
dimension determined-establishing or justified NOT_APPLICABLE).
An unestablished committed dimension yields UNVERIFIED. The
distinction: "nothing to reconcile against" (no envelope) is a
statement about comparison; "the figures were established" is a
statement about provenance. OK requires the former to be the only
gap. This is the one place BC-1 changes a v0.6.1 verdict without
an envelope present, and it is the assignment's core rule: an
unknown financial outcome must not masquerade as verified
actuals.

## 3. Before / after behavior matrix

| Case | Before (v0.6.1 core) | After BC-1 |
|---|---|---|
| quoted or revalidated dim UNKNOWN, envelope check | compared as 0 (silent pass or spurious drift) | throws QUOTE_NOT_DETERMINISTIC before any mutation; CONFIRMED_NON_EXECUTION; no receipt, no durable intent |
| legacy effect (no determinacy), either side | compared as its numbers (absent = 0) | refuses pre-mutation; post-commit UNVERIFIED |
| DETERMINED, value absent / NaN / infinite | coerced or NaN-compared | refuses (INVALID_DETERMINED_VALUE) |
| DETERMINED 0 with provenance | accepted as 0 | accepted as 0 (unchanged) |
| N/A CANCEL/immediate, citation valid vs proposal | compared as 0 | skipped — never compared (verdict-equivalent, semantically distinct) |
| N/A without context / citation / license | compared as 0 | refuses |
| committed UNKNOWN vs quoted 120000 | OK (0 fits any bound) | UNVERIFIED |
| committed copied from revalidated preview / pre-mutation estimate, numerically equal | OK | UNVERIFIED (provenance does not establish) |
| committed provider_actual beyond envelope | VIOLATED | VIOLATED (unchanged verdict, now established-only) |
| established violation + UNKNOWN elsewhere | VIOLATED or OK by coercion | VIOLATED (precedence, pinned) |
| no envelope + established committed figures | OK | OK (unchanged) |
| no envelope + unestablished committed figures | OK | UNVERIFIED |
| recorded receipt replay (§6.10) | original verbatim | original verbatim — replay performs no revalidation (unchanged) |

## 4. Per-adapter migration audit

BC-1 required **no adapter production-logic change**. Every
adapter already stamps determinacy + provenance notes on quoted
and revalidated effects (`withDeterminacy`) and an establishing or
explicitly unestablished `committedSource` on committed effects
(PRs #10/#11/#14/#15/#16 construction), and every adapter's local
M2 gate already refused what the core now refuses. The only
adapter edits are (a) propagating the `proposal` argument at the
envelope/reconcile call sites and (b) comments recording that
BC-1 is active and how the local gate composes with it. Evidence:
the adapter suites test17–test26 and test28 pass **unmodified** —
including test26's 20-row Chargebee-live matrix and the PR-10/11/14/15
correction suites — and test35.33 adds targeted end-to-end
enforcement coverage per simulator family (a doctored revalidation
losing its recurring figure now refuses pre-mutation in all four
families). No simulator estimate is labeled a provider actual; no
revalidated preview is copied into a committed effect; no
determinacy was stamped anywhere to silence a failure.

Known simulator limitation (disclosed, unchanged): simulator
"provider actuals" are the simulator's own persisted post-mutation
reads — SIMULATED_PASS evidence about protocol behavior, not about
any real provider.

## 5. Failing-first evidence

test35 was written and run against **unmodified main** first:
**21 fail / 14 pass**. The 21 failures are the defect cases: all
seven core-gate refusal cases (35.1–35.7), DETERMINED-without-value
(35.11), NaN/infinity (35.12), 35.13's negative sub-case,
unauthorized N/A (35.14),
multi-change N/A (35.15), no-context N/A (35.16), both-sides-
UNKNOWN with gate/audit agreement (35.17), the reconciliation
UNVERIFIED cases (35.21, 35.22, 35.23), EXACT-without-determinacy
(35.29: a bare `defined_equal_exact` label reconciled OK on the
baseline), state/finance separation (35.34: a state VERIFIED
transitioned a receipt whose figures were UNKNOWN), legacy
restore (35.35), and 35.31's final fresh-reconcile assertion (its
restart-preservation assertions already passed). The 14 passes are
disclosed **controls** — behavior that already failed closed (or
already held) before BC-1 via the M2 gates and store rules: 35.8
(DETERMINED 0), 35.9 (within tolerance), 35.10 (QUOTE_DRIFTED),
35.18 (zero-tolerance bounds), 35.19 (no mutation after a
local-gate refusal), 35.20 (no durable DISPATCHING left), 35.24
(provider_actual OK), 35.25 (VIOLATED), 35.26 (precedence — the
baseline's coercion happened to preserve the established
violation), 35.27 (UNVERIFIED ≠ INDETERMINATE), 35.28 (EXACT
established), 35.30 (verbatim replay), 35.32 (live gate blocks),
35.33 (simulator-family refusals via local gates). They are pinned
so the activation cannot regress them — not claimed as defects
found. After implementation: **35/35**, and the full suite is
518/518.

## 6. Legacy migration impact

BC-1 is intentionally breaking for legacy payloads:

- A legacy quote/revalidation (no determinacy) can no longer
  commit under an envelope: QUOTE_NOT_DETERMINISTIC. The remedy is
  re-derivation from provider evidence or a re-quote — never a
  stamped label.
- A legacy recorded receipt is **immutable history**: replay
  returns it verbatim (§6.10), restore round-trips it byte-for-byte,
  and nothing re-reconciles it (test35.30/35.31/35.35). But a
  *fresh* reconciliation over legacy figures reports UNVERIFIED,
  and a verification *transition* for a legacy COMMITTED_UNVERIFIED
  receipt whose quote states an envelope can no longer be minted
  from an observation alone — the recompute judges the recorded
  quoted effect too, and an unenforceable quote cannot establish
  compliance. Envelope-less legacy quotes are unaffected (the
  committed side alone is judged). This is the honest consequence
  of issue #7's migration rule: legacy reads UNKNOWN in every
  bounded dimension, receipts stay historical, and legacy is never
  re-reported OK.

## 7. Pre-existing test modifications (complete list, each justified)

No adapter suite (test17–test26, test28, test30, test32–test34)
was modified. The modifications are confined to direct engine
pins that named this activation, and store-suite fixtures whose
own narratives claim determined provider-actual figures:

1. **test12a/12b** — fixtures rebuilt as established-effect shapes
   (quoted DETERMINED + basis notes; committed DETERMINED +
   provider_actual). Verdicts (OK / VIOLATED incl. the BEST_EFFORT
   reason) unchanged. A bare legacy pair reconciles UNVERIFIED
   under BC-1; that verdict is pinned in test35, so these tests
   keep exercising the established-verdict path they exist for.
2. **test12c** — expectation OK → UNVERIFIED for the term-only
   pair, with the original safety purpose retained verbatim in the
   assertion message (never a fabricated VIOLATED), plus a new
   positive assertion: no envelope + established committed figures
   ⇒ OK. Justification: §2.2's no-envelope rule.
3. **test14.4** — the PR-1 pin "the engine keeps its v0.6.1
   behavior in this PR" (legacy pair, no envelope ⇒ OK) is
   superseded by the activation it deferred to: now UNVERIFIED.
   The test's CORE-4 purpose (UNVERIFIED constructible via the
   re-export) is retained — the engine now also *produces* it.
4. **test14.6** — the pin titled "byte-for-byte v0.6.1 in PR-1
   (missing values still coerce; activation is a later gate)" is
   superseded by that gate. Retained: for comparable dimensions
   the comparison and violation strings are byte-for-byte v0.6.1
   (asserted, including the 1000 credit-drift string for a
   DETERMINED 1000 → 0 move). Changed: absent/legacy dimensions
   refuse instead of coercing.
5. **test14 `mintEvidenceFor`, test15 `observationFor`, test16
   `standardObservation` + restore-evidence literal + 16.15's
   override, test27/29/31's shared `makeObservation`** — each
   fixture's committed effect gains
   `determinacy: { DETERMINED, DETERMINED }`. Justification: these
   fixtures *are* independent simulated provider reads whose two
   figures are literal read values asserted `provider_actual` —
   the read determines both dimensions, and the determinacy record
   now says what the fixture already claimed. Without it, BC-1
   (correctly) computes UNVERIFIED and the store transitions these
   suites exist to test cannot be minted. No assertion changed.
6. **test15 `makeQuote` quoted_effect / `makeReceipt`
   quotedEffect** — gain determinacy + basis provenance notes,
   modeling the current-shape quote a receipt records (only 15.5's
   envelope recompute reads the quoted side; elsewhere the shape
   round-trips through the same fixture).

## 8. Refusal behavior spec (pre-mutation)

Error: `SCQError` code `QUOTE_NOT_DETERMINISTIC`; message names
each unenforceable dimension with both sides' states/findings and
states that no mutation was performed; `details` =
`{ outcome: "CONFIRMED_NON_EXECUTION", dimensions: [{ dimension,
quoted: {state, findings}, revalidated: {state, findings} }] }`.
Guarantees at every call site: thrown before any mutating provider
call; provider state unchanged; no receipt recorded; never
classified INDETERMINATE (nothing was dispatched); on the durable
path it precedes `beginDurableAttempt`, so no dispatch
authorization is created, no DISPATCHING attempt is left
unresolved, and no previous unresolved attempt is retried
(test35.19/35.20). Recorded-receipt replay is untouched and
performs no revalidation.

## 9. Limitations and spec dependencies

- The committed role's rule (absent `committedSource` ⇒
  MISSING_PROVENANCE even with a basis note) is stricter than the
  audit's C4 note-or-source basis rule. It follows types.ts's
  normative reading ("absent committedSource reads as
  *unestablished* for reconciliation") and the establishment
  procedure's existing enforcement. If the v0.6.2 specification
  ultimately licenses note-established committed actuals, the
  relaxation is one branch in `assessDimensionSide`.
- `defined_equal_exact` establishes where the committed effect
  asserts it; the core cannot authenticate the EXACT contract
  behind the label. Adapters and the store's branding remain
  responsible for only asserting it under a provider-backed
  equality guarantee (test35.28/35.29 pin the boundary: no
  determinacy ⇒ no establishment; assertion + determinacy ⇒
  established).
- A caller-supplied provenance string is never treated as
  authentication anywhere in the gate; the gate judges shape and
  classification only.
- Multi-change proposals cannot license NOT_APPLICABLE (no single
  action context). Their determined flows are unaffected.
- State verification (PR-9 hook) and financial reconciliation
  remain independent: a VERIFIED state verdict never establishes
  figures, and establishment still refuses a transition whose
  reconciliation is UNVERIFIED (test35.34).
- Neither spec file is modified; BC-1's normative text remains
  issue #7's draft pending the v0.6.2 specification step.
  `types.ts` is untouched (one stale doc comment there still
  describes BC-1 as "a later step" — left untouched deliberately;
  the freeze guard already trips on `scq-engine.ts`).

## 10. Controlled test-site pilot: GO / NO-GO

**NO-GO (unchanged).** PR-10 closes the core enforcement gap; it
does not advance the pilot conditions. Still open: (3) an executed
preflight for the exact commit, (4) a named reconciliation owner,
(5) separate authorization for a test-site commit. No real
Chargebee call was made for this PR; the mocked pilot harness
remains SIMULATED_PASS with live commit BLOCKED and 0 mutating
calls.

## 11. Review correction BC1-R1 — NOT_APPLICABLE field-absence purity

Owner review of head `1df747f` accepted the principal BC-1
behavior and found one remaining three-state purity defect, fixed
in this section's round (new suite: test36).

**The defect.** The N/A branches of the shared assessment
(`assessDimensionSide`) and of the audit (`auditOneEffect`)
validated an assertion's action context, license, and citation —
but never whether the dimension's financial field was actually
absent. Issue #7 Topic 1 (and the `DimensionState` contract in
types.ts) defines NOT_APPLICABLE as the dimension *not arising*,
with its field absent; a verified zero is DETERMINED, present as
0. Counterexample at `1df747f`: quoted = revalidated =
CANCEL effect carrying `immediate: { net: 50000 }` AND
`immediateFinancialEffect: "NOT_APPLICABLE"` with a valid CANCEL
citation — `checkAcceptanceEnvelope` returned null (the dimension
was skipped; the present 50000 was discarded by relabeling), and
the matching committed shape could reconcile OK.

**The rule.** For a NOT_APPLICABLE assertion, the dimension's
whole field (`effect.immediate` / `effect.recurring`) must be
genuinely absent (`undefined`). Present in ANY shape — a nonzero
amount, an explicit zero, or a partial shape such as
`{ charge: 50000 }` without `net` — the assertion is internally
inconsistent: the dimension is unenforceable with the new finding
**`INCONSISTENT_NOT_APPLICABLE_VALUE`** (added to the
`DeterminacyAuditFinding` union in scq-engine.ts). Consequences
flow through the existing machinery unchanged: pre-mutation, the
dimension is not skipped, so the gate throws
QUOTE_NOT_DETERMINISTIC (CONFIRMED_NON_EXECUTION) before any
dispatch; post-commit, the dimension is unenforceable, so
reconciliation reports UNVERIFIED — unless another dimension
independently establishes a violation, which keeps precedence
(VIOLATED, pinned in test36.7). A present amount is never
discarded by treating it as N/A.

**Order of findings (decided here, pinned in test36.10/36.11).**
Within the N/A branch of both implementations the checks run:
(0) **field-absence purity**, then (1) action context, (2)
applicability license, (3) citation — the first failing check is
the side's finding, identically in gate and audit. Rationale:
purity is a property of the payload itself, independent of any
context — the assertion contradicts the effect's own contents —
so it is judged before any question of justification arises,
mirroring the DETERMINED branch, where value validity dominates
provenance findings. A side effect of the order: an impure
*recurring* N/A reports INCONSISTENT_NOT_APPLICABLE_VALUE rather
than the license failure (test36.11); recurring remains
unlicensable either way, so no verdict changes — only the named
reason is the more fundamental one.

**Failing-first evidence.** test36 (11 tests) was written against
unmodified `1df747f` and run before the fix: **9 fail / 2 pass**.
The failures are the impure shapes (nonzero net, explicit zero,
charge-without-net, one-sided, committed envelope and no-envelope
reconciliation, audit agreement, order, recurring symmetry). The
2 passes are disclosed controls: 36.7 (an independently
established recurring violation reports VIOLATED beside an impure
committed N/A — true before and after) and 36.8 (a pure N/A —
field genuinely absent, valid citation — still skips pre-commit
and reconciles OK post-commit). After the fix: test36 11/11, full
suite **529/529** on a fresh clean build (518 baseline + 11).

**Fixture audit (no flips).** Every NOT_APPLICABLE assertion in
the repository was checked for a present field on the asserted
dimension: test14's audit fixtures (14.9–14.13), test17.5, and
test35's `cancelEffect` uses (all invoke it with the field
absent); the adapter constructions — Stripe's CANCEL quote,
Paddle's CANCEL quote, mismatch-observed committed effect, and
verified-cancel committed effect (a spread of the pure quote),
Zuora's `buildCommercialEffect` (the `immediate` field is set
only in the DETERMINED branch) — are pure by construction; the
Chargebee simulator and live adapters assert NOT_APPLICABLE for
no dimension; store-suite fixtures assert none. Result: **no
pre-existing test was modified in this round and no verdict
flipped** — the 518 baseline passes unmodified alongside test36.
No fixture in the tree was itself encoding the impurity.

**Composition note.** The adapters' local determinacy gates (M2)
were not changed: they remain the earlier, adapter-specific
refusal, and their own produced effects are pure. The core gate —
now purity-enforcing — remains the protocol-level backstop at
every envelope/reconciliation call site behind them.

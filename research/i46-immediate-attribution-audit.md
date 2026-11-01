# Issue #46 — Concurrent-Mutation Financial Attribution Audit

**Question.** When a Chargebee-simulator update dispatches after a concurrent
third-party item addition lands in the validate → dispatch gap (test55.2 /
G-20), the receipt is correctly `COMMITTED_UNVERIFIED` / `UNVERIFIED` with no
committed recurring figure — but the immediate net amount **12500** was still
recorded as **DETERMINED**, while the validated state's authorized delta alone
was 20000. Is the operation-bound artifact sufficient to establish that figure
as a fact about THIS dispatched operation, or does the broken fingerprint
bracket make the immediate component unattributable to the quoted
authorization?

**Decision: B — NARROW.** The establishing condition for the artifact's
immediate figure under a broken bracket is the artifact's **begin binding**:
its recorded request is the dispatched request AND the state it began on is
exactly the state this commit validated (`fingerprintBefore ===
validatedFingerprint`). Begin-bound (only the bracket's end equality failed)
→ the figure is priced exclusively from (validated state, dispatched request)
and stays DETERMINED. Begin-unbound → the figure is recorded as a §3.10
**candidate**: figure retained verbatim, determinacy UNKNOWN,
`committedSource: "unestablished"`, candidate source disclosed in the
provenance, reconciliation UNVERIFIED naming both financial dimensions.

All evidence in this note is **SIMULATED** — the Chargebee simulator's own
pricing and fingerprint mechanics, exercised through the simulator adapter.
No live provider behavior is claimed anywhere in this audit.

Baseline: origin/main `b00e74b`. Suite baseline measured before any change:
**829/829 on Node 22.14 and Node 20.19.5; research 11 pass / 7 fail.**

---

## 1. Mechanism — what the 12500 actually is (proven from code + instrumented runs)

The simulator prices an update in `computeUpdateEffect`
(`reference/src/adapters/chargebee-sim.ts`):

```
netImmediate = round((recurringPrice(dispatched item list)
                    − recurringPrice(BEGIN-state item list)) × fractionRemaining)
```

`fractionRemaining` is 1.0 at term start (the scenario clock sits at the term
start, 2026-08-01). The begin state is whatever the subscription holds **when
execution starts** — not the state the commit validated. Catalog prices:
`ip_seat_basic_monthly` = 1000, `ip_seat_pro_monthly` = 1500.

Original scenario (test55.2 geometry), measured on unmodified main:

| Quantity | Value |
|---|---|
| Validated state | `item_1` basic ×100 → recurring 100000; fingerprint `6567073335055222` |
| Authorized change | `item_1` ×100 → ×120; validated immediate delta **20000** |
| Third-party write (validate → dispatch gap) | adds `item_2` pro ×5 |
| Artifact begin state | 100×1000 + 5×1500 = **107500**; `fingerprintBefore` `336534ee52fb3a95` ≠ validated |
| Artifact end state (dispatched full-replacement list) | `item_1` ×120 = 120000 |
| Artifact `netImmediate` | 120000 − 107500 = **12500**, as a single netted line `"Prorated charge": 12500` |

So the 12500 is **+20000 of authorized change netted against −7500 for
deleting the third party's item** (the full-replacement dispatch removes the
concurrent addition, and the artifact prices that removal into the same
single netted line). The third-party component is inseparable from the
authorized component in the artifact's own record: one line, one number.

### Invariance disproof (the decisive experiment)

Same quote, same dispatched operation, third-party quantity 10 instead of 5:
the recorded "determined actual" becomes **5000** (20000 − 10×1500). The
figure is a 1:1 function of the third party's input. A figure that moves with
a third party's write is not independently attributable to the dispatched
operation — Decision A is disproved by executable evidence, not by
preference for a stricter output.

### Contrast geometry (why the answer is B, not C)

Same write placed in the mutate → verify window (test25.9's geometry): the
artifact's `fingerprintBefore` equals the validated fingerprint exactly; the
figure is 20000 — the operation's own transition from the validated baseline;
the third party contributed nothing to it, because execution had already
completed when the write landed. §3.12 expressly contemplates a dimension
being fully established while the receipt is unverified "for attribution/state
reasons." Removing the establishing claim in THIS geometry (Decision C) would
destroy a legitimately established figure. The two windows differ in exactly
one property — whether the artifact began on the validated state — and the
classification must turn on that property.

---

## 2. Phase-2 semantic analysis — six questions, answered separately

Scenario: the original test55.2 geometry (third-party pro ×5 addition in the
validate → dispatch window), under the published v0.6.2 text.

**(1) Did the specific mutation execute?**
Yes. Exactly one dispatch occurred; the dispatched full-replacement list
landed (`item_1` ×120, concurrent item removed). Execution is not in doubt;
only the financial attribution of its artifact is.

**(2) What financial obligation did THAT operation actually incur?**
The operation's execution, as priced by the provider-side artifact from its
actual begin state, netted +12500: it simultaneously (a) applied the
authorized +20000 change and (b) deleted a third party's 7500 item. The
obligation the *operation* incurred and the obligation the *authorization*
covers are different quantities, and the artifact reports only their net.

**(3) Was it within the shopper's authorization?**
The dispatched request was within the authorization (it is the validated
request; the envelope was generous). But the *effect* was computed against a
baseline the shopper never saw: the authorization priced a change from the
validated state (delta 20000), not a change that also absorbs a third party's
item deletion (−7500). The receipt correctly refuses to call this verified
(`COMMITTED_UNVERIFIED`); the question is only whether one dimension of it
was nevertheless established.

**(4) Did a third-party mutation change the financial baseline?**
Yes — measurably. The artifact's begin fingerprint (`336534ee52fb3a95`)
differs from the validated fingerprint (`6567073335055222`), and its begin
recurring level (107500) differs from the validated level (100000) by exactly
the third party's contribution (5 × 1500).

**(5) Can the reported immediate amount be attributed to the specific
dispatched operation?**
Not independently. The amount is a function of two inputs — the dispatched
request and the third party's write — and varying only the second moves it
1:1 (12500 → 5000 for quantity 5 → 10). Attribution of a netted figure to one
of its two causes, with no priced decomposition in the artifact, is not
possible from the available evidence. (In the mutate → verify geometry the
answer is yes: the figure's inputs are exactly (validated state, dispatched
request).)

**(6) Is the amount an estimate, an operation-returned claim, or an
independently established provider actual?**
It is an **operation-bound provider record**: the persisted mutation
artifact's own execution figure, read back by id after the mutation — more
than a bare response claim, less than an independent observation of this
commit's effect. Under §3.11 such a record CAN establish (the artifact is
this operation's own record, not a caller's label) — but what it establishes
is the net of everything its pricing basis contained. Where the basis is the
validated state, that net is this commit's effect. Where the basis includes
an unvalidated third-party write, the net is a third-party-influenced figure,
and §6.15's rule applies verbatim: "**no third-party or unattributed figure
may be recorded as this commit's determined actual**." §3.10 gives such a
figure its correct home: a **candidate** (figure retained under UNKNOWN
determinacy, `committedSource: "unestablished"`, source disclosed — the
mutating call's own record is an enumerated candidate source) that a later
independent verification under §6.15 judges.

Spec anchors: §3.10 (determinacy; candidates; "the label is not itself the
authentication" belongs to §3.11), §3.11 (establishing sources:
`provider_actual` / `defined_equal_exact` only), §3.12 (a dimension can be
fully established while the receipt is unverified for attribution/state
reasons — the begin-bound case), §6.14 (candidate presence changes nothing;
UNVERIFIED stands), §6.15 (original figures retained; determination judged
against independent evidence; the no-third-party-figure rule).

No v0.6.3 amendment is needed: the published text already represents the
correct outcome. The defect was in the adapter's classification, not in the
specification. The internal inconsistency this removes: the cancel path's
establishment already confines broken-bracket figures to candidates under
UNKNOWN; the update path's Z3 carve-out was the anomaly.

---

## 3. Before / after records (original scenario, verbatim fields)

Artifact ids are random per run; fingerprints are deterministic and identical
across runs. BEFORE = unmodified main `b00e74b`; AFTER = this branch.

**R1 — validate → dispatch window, third party adds pro ×5**

```
BEFORE
artifact.fingerprintBefore: 336534ee52fb3a95   (validated: 6567073335055222)
artifact.fingerprintAfter:  f2eb7016ab01734a   (== re-read state fingerprint)
artifact.netImmediate: 12500   lineItems: [{"description":"Prorated charge","amount":12500}]
receipt.status / outcome: COMMITTED_UNVERIFIED
receipt.committedEffect.immediate: {"charge":12500,"net":12500}
receipt.committedEffect.determinacy: {"immediateFinancialEffect":"DETERMINED","recurringFinancialEffect":"UNKNOWN"}
receipt.committedEffect.provenance.committedSource: "unestablished"
receipt.committedEffect.provenance.immediate: "post-commit actual: netImmediate recorded on persisted
  mutation artifact <id> — the update operation THIS mutation dispatched, bound by its id and read back
  via retrieveMutation after the mutation (a provider-side read, not an estimate and not the mutation
  response); no latest-mutation pointer was used"
receipt.reconciliation: UNVERIFIED, undeterminedDimensions: ["recurringFinancialEffect"]

AFTER
artifact fields: unchanged (12500; same fingerprints)
receipt.status / outcome: COMMITTED_UNVERIFIED            (unchanged)
receipt.committedEffect.immediate: {"charge":12500,"net":12500}   (figure RETAINED)
receipt.committedEffect.determinacy: {"immediateFinancialEffect":"UNKNOWN","recurringFinancialEffect":"UNKNOWN"}
receipt.committedEffect.provenance.committedSource: "unestablished"   (unchanged)
receipt.committedEffect.provenance.immediate: "CANDIDATE (not an established actual): netImmediate
  recorded on persisted mutation artifact <id> — the mutating call's own persisted execution figure,
  read by id via retrieveMutation. The artifact priced its execution from the state it began on,
  which is NOT the state this commit validated (begin binding failed: ...), so the figure nets the
  effects of state this commit never authorized and is not attributable to this commit as a
  determined actual. Recorded under §3.10's candidate carve-out (committedSource: unestablished)
  so a later independent verification (§6.15) has the original figure to judge"
receipt.reconciliation: UNVERIFIED, undeterminedDimensions: ["immediateFinancialEffect","recurringFinancialEffect"],
  reason retains the phrase "fingerprint bracket does not close" and now states the immediate is a
  candidate because the operation did not begin on the validated state.
```

**R2 — invariance probe (pro ×10):** BEFORE: 5000 recorded DETERMINED.
AFTER: 5000 retained as candidate (UNKNOWN).
**R3 — mutate → verify window (contrast):** BEFORE and AFTER identical:
20000 DETERMINED, undeterminedDimensions `["recurringFinancialEffect"]`.

---

## 4. Adversarial suite — test60 (12 cases)

Failing-first record, measured against unmodified main `b00e74b`:
**FAIL (defect reproductions):** 60.1, 60.2, 60.3, 60.4, 60.5, 60.7, 60.9,
60.10 — each on its classification assertions.
**PASS (characterization pins):** 60.6, 60.8.
**PASS (positive controls):** 60.11, 60.12.
After the fix: **12/12 pass**, pins and controls unchanged.

| Case | Scenario | Before (main) | After (this branch) |
|---|---|---|---|
| 60.1 (a) | Third-party item added, validate → dispatch | 12500 **DETERMINED** | 12500 candidate (UNKNOWN, unestablished, source disclosed); COMMITTED_UNVERIFIED / UNVERIFIED; both dimensions undetermined |
| 60.2 (a2) | Same, third-party quantity 10 | 5000 **DETERMINED** | 5000 candidate — figure tracks the third party's input, retained for later verification |
| 60.3 (b) | Concurrent price-id swap (monthly → annual) in the gap | −880000 credit **DETERMINED** | −880000 candidate, full shape retained (credit 880000) |
| 60.4 (c) | Two different third-party configurations, equal begin totals (107500) | Both record 12500 **DETERMINED** | Both record 12500 as candidates — identical figure, different third-party facts |
| 60.5 (d) | Mutating call's response carries a DIFFERENT operation's id (artifact read-back is operation A's) | A's figure 20000 recorded **DETERMINED** on B's receipt | 20000 candidate on B's receipt — a different operation's figure establishes nothing for this commit |
| 60.6 (e) | Preview-sourcing probe [PIN] | Recorded figure is the artifact's (12500 ≠ preview's 20000); figureless artifact → response candidates UNKNOWN | Unchanged — previews are never the committed source |
| 60.7 (f) | Foreign post-commit record (different subscription id) + broken begin bracket | Artifact figure 12500 **DETERMINED** | 12500 candidate; the foreign record contributes no figure and verifies nothing |
| 60.8 (g) | Artifact persists a net figure but NO line items [PIN] | Verification-unavailable branch: response candidates only, both dimensions UNKNOWN | Unchanged |
| 60.9 (h) | Evidence lifecycle over the candidate receipt | Recorded immediate labeled DETERMINED (fails at the audit classification) | Independent evidence establishes the dimension in the derived view (receipt stays COMMITTED_UNVERIFIED — recurring unestablished); a conflicting established actual is appended and flagged (view UNVERIFIED naming the conflict; accepted actual stays 12500); `commit_receipt_recorded` never rewritten |
| 60.10 (i) | Bundled change, wrong-quantity partial application, begin-window write | UNVERIFIED but figure 36000 **DETERMINED** | UNVERIFIED (explicitly NOT VIOLATED — an unattributable contradiction is context, Z1) with 36000 as candidate |
| 60.11 (j) | **Positive control:** clean bracket, wrong landing (×130) exceeding the envelope (max 25000) | 30000 DETERMINED + VIOLATED, `provider_actual` | **Unchanged** — independently established violations are never suppressed |
| 60.12 | **Positive control:** mutate → verify window interference only | 20000 DETERMINED, undetermined = [recurring] | **Unchanged** — the narrowing does not overcorrect |

For every case the recorded tuple (mutation attribution, immediate
determinacy, committed source, state verification, reconciliation
classification, receipt outcome) is asserted in the test body.

---

## 5. Implementation

One file of implementation: `reference/src/adapters/chargebee-adapter.ts`
(**not** a freeze-guarded path; no spec file, `core/types.ts`, or
`core/scq-engine.ts` is touched). In `establishCommittedEffect`'s broken-
bracket handling, the existing Z3 branch is split on
`beginBound = requestMatches && fingerprintBefore === validatedFingerprint`:

- **Begin-bound** (pre-existing branch, byte-identical outputs): immediate
  DETERMINED, recurring UNKNOWN, receipt COMMITTED_UNVERIFIED.
- **Begin-unbound** (new branch): same figure construction
  (`immediateFromLineItems`), determinacy immediate → UNKNOWN, a
  candidate-disclosing immediate provenance, a recurring-provenance variant
  (the existing constant's trailing clause — "the bound mutation artifact
  establishes this commit's IMMEDIATE actual only" — is false here),
  `committedSource` stays `"unestablished"`, reconciliation UNVERIFIED with
  both dimensions undetermined; the reason keeps the phrase "fingerprint
  bracket does not close" and states why the immediate is a candidate.
- The Z3 doctrine comments (method header and in-code) now state the
  narrowed rule and cite this audit.

**Pre-existing test modification (one, disclosed):** `test55.2`'s
immediate-determinacy assertion (DETERMINED → UNKNOWN) plus candidate
assertions, with the justification recorded in test55's file header and at
the assertion. Scenario mechanics, the figure's value (12500), status,
UNVERIFIED, and no-recurring-figure assertions are unchanged; the test's
original safety purpose (a concurrently-affected execution is never reported
verified) is retained and strengthened — its own header had flagged the
figure "recorded, not endorsed… flagged for maintainer attention," and this
audit is that review. No other pre-existing test is modified.

---

## 6. Phase-5 downstream audit

| # | Property | Evidence |
|---|---|---|
| (i) | Quote-side estimates never treated as committed actuals | test60.6 pin: recorded figure is the artifact's, never the preview's; figureless artifacts yield labeled response candidates only |
| (ii) | UNKNOWN never reclassified as zero | Candidates retain their figures verbatim (60.1: net 12500 present under UNKNOWN; 60.3: credit 880000 retained) |
| (iii) | Recorded receipts never rewritten | test50 family green; 60.9 asserts `commit_receipt_recorded` unchanged after two evidence appends |
| (iv) | Append-only verification unbroken | 60.9: establishment composes over the candidate (judged, not matched — A-17-1); conflicts appended + flagged, accepted actual not replaced; test50 family green |
| (v) | Unauthorized ≠ unknown | 60.10: unattributable contradiction stays UNVERIFIED, explicitly not VIOLATED; 60.11: attributable exceedance is VIOLATED |
| (vi) | Independently established violations not suppressed | 60.11 positive control (30000 DETERMINED + VIOLATED) before and after |
| (vii) | Authorization-preservation refusal unloosened | test47 family green; the live adapter is untouched (the fix is in the simulator adapter only) |
| (viii) | No duplicate dispatch after uncertain outcomes | 60.1 asserts exactly one mutation; test27/test29 families green in the full suite |

Validation: full suite **841/841 on Node 22.14 and Node 20.19.5** (fresh
per-toolchain `npm ci` + build on Node 20); research **11 pass / 7 fail**
(unchanged, by design). Targeted families run individually: test25, test47,
test49, test50, test55, test57, test60 — all green. Spec integrity:
`scq-v0.6.2-spec.md` sha256 identical to main
(`4100d2492a92ab430fd0190382ddadd287d25cf07edbf3f5d40df2e27bb4951f`);
`scq-v0.6.1-spec.md` sha256
`0d32e584deeaa575838abdbee5ad9b4afd0757fdcec15c7969e04dff21aed5de`
(unchanged). No `package.json` change.

Conformance reconciliation (one item): `research/g20-guard-blocked-evidence.md`
gains an appended resolution note under its test55.2 nuance (the flag this
audit answers). No other register claim changes: the register already
recorded the classification as "flagged, not fixed… a maintainer should
decide."

---

## 7. Remaining assumptions / unresolved provider questions

- **Operation-id binding rests on the mutating call's response id**
  (§3.11: the label is not itself the authentication). test60.5 shows the
  consequence when that id is wrong: the read-back artifact's figure becomes
  a candidate for the receiving commit rather than its determined actual —
  fail-closed, but a real provider's artifact-identity guarantees remain a
  provider question this audit does not answer.
- **Partial attribution is not attempted.** A future provider artifact with
  per-item priced lines, or a priced begin-state record, could in principle
  support decomposing the net into authorized and third-party components.
  The simulator's artifact carries a single netted line, so no decomposition
  is possible from the available evidence; the candidate treatment is the
  strongest claim the evidence supports.
- The recurring dimension's treatment under a broken bracket is unchanged
  (UNKNOWN, no figure) in both sub-branches; this audit concerned the
  immediate dimension only.
- All mechanics above are simulator mechanics. Whether a real provider
  prices a full-replacement update against its execution-time begin state,
  and what its persisted artifacts record, are live-provider questions —
  unexamined here by design (no live mutation is authorized).

---

## 8. Correction — §3.10 candidate-source compliance (PR #53 maintainer review, 2026-10-31)

The sections above are the audit as delivered (branch head `5d8f4df`,
Draft PR #53). The maintainer's independent review of PR #53 confirmed
decision B — NARROW and the validation results, but identified one
remaining defect **in the audit's own fix**. This section records the
correction; the original analysis is not rewritten.

### 8.1 The defect

Published §3.10 ("Candidates (committed role only)") restricts a
committed candidate's source to exactly two: the mutating call's own
response, or — for cancellation constructions — the stored quote's
post-cancellation level, and states verbatim: *"a candidate is never
derived from a further provider read performed after the mutation
landed."* The delivered begin-unbound branch built
`candidateEffect.immediate` from `readArtifact`
(`invoiceEstimateLineItems` / `netImmediate`) obtained via
`this.sim.retrieveMutation(mutation.operationId)` — a separate
post-mutation read, not `mutation.result`. The classification
(UNKNOWN / UNVERIFIED / candidate) was correct; the value's SOURCE
was forbidden. Test 60.5 (delivered as 58.5) proved it observably:
operation B's receipt retained the 20000 figure retrieved from
operation A's artifact.

### 8.2 The fix (adapter-local, begin-unbound branch only)

- The candidate is now derived ONLY from the already-held
  `mutation.result` (`netImmediate` / `invoiceEstimateLineItems`),
  and its provenance names the mutating call's own response as the
  source (`provImmediateCandidateBeginUnbound` rewritten; the
  reconciliation reason states the same, conditionally).
- If the response cannot supply an admissible finite figure, the
  candidate number is ABSENT (§3.10: candidates are optional) —
  never filled from `retrieveMutation` or any preview.
- `readArtifact` remains in service for state/attribution
  diagnostics and the begin-bound vs begin-unbound determination;
  it no longer populates any UNKNOWN candidate. COMMITTED_UNVERIFIED,
  both undetermined dimensions, source disclosure, and immutable
  recorded-receipt semantics are preserved. The begin-BOUND branch's
  outputs are byte-identical (established actuals from bound
  post-commit evidence are a different, permitted path — untouched).

### 8.3 Response-object facts (probe-verified against the simulator)

The mutating call's response (`mutation.result`, an `EstimateResult`)
carries `netImmediate` and `invoiceEstimateLineItems` computed at
execution from the operation's begin state; the sim persists the
artifact FROM that same result. Consequently:

- 60.1's **12500** and 60.2's **5000** survive unchanged as
  RESPONSE-sourced figures (values identical; source corrected).
- In 60.5's geometry, B's own response carries **10000** (B's
  execution priced from its begin state: level 120000 → dispatched
  130000). The delivered test's aside "(30000 priced off B's begin
  state...)" was wrong and is corrected in the test. The amended
  expectation is therefore the exact B-response candidate, 10000 —
  not A's 20000, and not absence.
- test55.2's candidate assertions are unaffected (its response
  reports the same 12500); only its comments naming the figure's
  source and the suite references were corrected — disclosed in
  that file's header.

### 8.4 Test deltas

- **Renumber:** the suite was delivered as `test58`, colliding with
  PR #50's `test58-indeterminate-recovery-evidence.test.ts`; test59
  was also taken. The suite is renamed
  `test60-i46-immediate-attribution.test.ts`, IDs 58.x → 60.x, and
  references renumbered in this note, the G-20 resolution note,
  test55, and the adapter comments. (Sections 1–7 above were
  renumbered token-wise only; their substance stands as delivered,
  except where this section supersedes it — notably §4's row for
  case (d), whose delivered "After" cell read "20000 candidate on
  B's receipt" and is superseded by §8.3/8.4 below.)
- **Amended 60.5:** expects B's response candidate 10000, asserts
  A's 20000 appears nowhere on B's receipt, and asserts the §3.10
  source restriction via the shared candidate assertions
  (provenance names the mutating call's own response; never names
  the artifact read).
- **New 60.13 (case k):** response-versus-artifact disagreement —
  the artifact read is corrupted to claim 999999 (attribution data
  intact); the candidate must be the response's 12500.
- **New 60.14 (case l):** response figure omitted, and separately
  nonfinite (NaN) — the candidate stays ABSENT although the
  retrievable artifact carries a finite 12500 (asserted in the
  test as a scenario check).
- **60.6 (pin) amended:** its Part 1 provenance assertion now names
  the response as the governing source; the pin's substance
  (never a preview) is unchanged, as is the figure's value.
- `assertCandidate` now carries the §3.10 source assertions for
  every candidate case.

### 8.5 Failing-first record for the correction (against `5d8f4df`)

The amended suite was run against the unmodified delivered code
before the source fix: **11 fail / 3 pass**.

- 60.5 FAILS on value: expected 10000, actual 20000 (A's artifact
  figure).
- 60.13 FAILS on value: expected 12500, actual 999999 (the artifact
  read's substituted figure).
- 60.14 FAILS on presence: candidate recorded (12500, backfilled
  from the artifact) where absence is required.
- 60.1, 60.2, 60.3, 60.4, 60.7, 60.9, 60.10 FAIL on the new §3.10
  source assertions only (provenance named the artifact read via
  `retrieveMutation`); their figure values and classifications
  already passed — the B — NARROW decision was never in question.
- 60.6 FAILS on its amended provenance assertion.
- PASS throughout: 60.8 (pin), 60.11 and 60.12 (positive controls —
  the begin-bound DETERMINED outputs are untouched by the defect
  and by the correction).

After the fix: test60 **14/14**; full suite **843/843 on Node 22.14
and Node 20.19.5** (fresh per-toolchain `npm ci` + clean build on
both; baseline at `5d8f4df` was 841/841 — the delta is exactly the
two new tests); research **11 pass / 7 fail** unchanged; targeted
families test25, test47, test49, test50, test55, test57, test60 all
green individually. Spec integrity unchanged: v0.6.2 sha256
`4100d249…`, v0.6.1 sha256 `0d32e584…`; zero freeze-guarded paths
touched; no `package.json` change.

### 8.6 Disclosed pre-existing-test modifications in this correction

- `test55-g20-guard-blocked-evidence.test.ts`: comments only —
  suite references (test58 → test60) and the candidate-source
  wording in test55.2's comment block and file header. NO assertion
  changed (verified: the suite passed before and after with
  identical assertions; the figure 12500 is response-sourced with
  the same value).
- This note (§§1–7): suite-number tokens renumbered; §4's case-(d)
  "After" cell and §5's implementation description are superseded
  by this section, not edited.
- `research/g20-guard-blocked-evidence.md`: the resolution note's
  "(suite test58)" reference renumbered to test60.

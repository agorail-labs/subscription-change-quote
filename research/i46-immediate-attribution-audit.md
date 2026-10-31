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

## 4. Adversarial suite — test58 (12 cases)

Failing-first record, measured against unmodified main `b00e74b`:
**FAIL (defect reproductions):** 58.1, 58.2, 58.3, 58.4, 58.5, 58.7, 58.9,
58.10 — each on its classification assertions.
**PASS (characterization pins):** 58.6, 58.8.
**PASS (positive controls):** 58.11, 58.12.
After the fix: **12/12 pass**, pins and controls unchanged.

| Case | Scenario | Before (main) | After (this branch) |
|---|---|---|---|
| 58.1 (a) | Third-party item added, validate → dispatch | 12500 **DETERMINED** | 12500 candidate (UNKNOWN, unestablished, source disclosed); COMMITTED_UNVERIFIED / UNVERIFIED; both dimensions undetermined |
| 58.2 (a2) | Same, third-party quantity 10 | 5000 **DETERMINED** | 5000 candidate — figure tracks the third party's input, retained for later verification |
| 58.3 (b) | Concurrent price-id swap (monthly → annual) in the gap | −880000 credit **DETERMINED** | −880000 candidate, full shape retained (credit 880000) |
| 58.4 (c) | Two different third-party configurations, equal begin totals (107500) | Both record 12500 **DETERMINED** | Both record 12500 as candidates — identical figure, different third-party facts |
| 58.5 (d) | Mutating call's response carries a DIFFERENT operation's id (artifact read-back is operation A's) | A's figure 20000 recorded **DETERMINED** on B's receipt | 20000 candidate on B's receipt — a different operation's figure establishes nothing for this commit |
| 58.6 (e) | Preview-sourcing probe [PIN] | Recorded figure is the artifact's (12500 ≠ preview's 20000); figureless artifact → response candidates UNKNOWN | Unchanged — previews are never the committed source |
| 58.7 (f) | Foreign post-commit record (different subscription id) + broken begin bracket | Artifact figure 12500 **DETERMINED** | 12500 candidate; the foreign record contributes no figure and verifies nothing |
| 58.8 (g) | Artifact persists a net figure but NO line items [PIN] | Verification-unavailable branch: response candidates only, both dimensions UNKNOWN | Unchanged |
| 58.9 (h) | Evidence lifecycle over the candidate receipt | Recorded immediate labeled DETERMINED (fails at the audit classification) | Independent evidence establishes the dimension in the derived view (receipt stays COMMITTED_UNVERIFIED — recurring unestablished); a conflicting established actual is appended and flagged (view UNVERIFIED naming the conflict; accepted actual stays 12500); `commit_receipt_recorded` never rewritten |
| 58.10 (i) | Bundled change, wrong-quantity partial application, begin-window write | UNVERIFIED but figure 36000 **DETERMINED** | UNVERIFIED (explicitly NOT VIOLATED — an unattributable contradiction is context, Z1) with 36000 as candidate |
| 58.11 (j) | **Positive control:** clean bracket, wrong landing (×130) exceeding the envelope (max 25000) | 30000 DETERMINED + VIOLATED, `provider_actual` | **Unchanged** — independently established violations are never suppressed |
| 58.12 | **Positive control:** mutate → verify window interference only | 20000 DETERMINED, undetermined = [recurring] | **Unchanged** — the narrowing does not overcorrect |

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
| (i) | Quote-side estimates never treated as committed actuals | test58.6 pin: recorded figure is the artifact's, never the preview's; figureless artifacts yield labeled response candidates only |
| (ii) | UNKNOWN never reclassified as zero | Candidates retain their figures verbatim (58.1: net 12500 present under UNKNOWN; 58.3: credit 880000 retained) |
| (iii) | Recorded receipts never rewritten | test50 family green; 58.9 asserts `commit_receipt_recorded` unchanged after two evidence appends |
| (iv) | Append-only verification unbroken | 58.9: establishment composes over the candidate (judged, not matched — A-17-1); conflicts appended + flagged, accepted actual not replaced; test50 family green |
| (v) | Unauthorized ≠ unknown | 58.10: unattributable contradiction stays UNVERIFIED, explicitly not VIOLATED; 58.11: attributable exceedance is VIOLATED |
| (vi) | Independently established violations not suppressed | 58.11 positive control (30000 DETERMINED + VIOLATED) before and after |
| (vii) | Authorization-preservation refusal unloosened | test47 family green; the live adapter is untouched (the fix is in the simulator adapter only) |
| (viii) | No duplicate dispatch after uncertain outcomes | 58.1 asserts exactly one mutation; test27/test29 families green in the full suite |

Validation: full suite **841/841 on Node 22.14 and Node 20.19.5** (fresh
per-toolchain `npm ci` + build on Node 20); research **11 pass / 7 fail**
(unchanged, by design). Targeted families run individually: test25, test47,
test49, test50, test55, test57, test58 — all green. Spec integrity:
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
  (§3.11: the label is not itself the authentication). test58.5 shows the
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

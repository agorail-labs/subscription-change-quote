# External review reconciliation — Issue #22 (2026-11)

**Scope.** Current-state reconciliation of Fabio's independent external
review (Discussion #2, reported against `main` at `963be0b`, Oct 30, 2026)
against **current main `62744ee`** (Nov 2, 2026). Every result below was
reproduced locally in this audit. All evidence is **SIMULATED** (mocked
transports, in-memory simulators, engine/store calls). No live provider
call was made, no credential was used, `SCQ_LIVE_COMMIT_ENABLED` was never
set, and nothing here claims a defect in any real provider: the
full-replacement behavior exercised is Chargebee's *documented* semantics
(see `research/issue-22/CHARGEBEE-CAPABILITY-ASSESSMENT.md`).

**Baseline.** Default suite at `62744ee`: **872/872 on Node 22.14.0**
(`npm test` in `reference/`). The PR #23 research suite
(`node --test dist/tests/*.repro.js` after a build) reported **13 fail /
5 pass** at its original baseline (`6f56b05`); at `62744ee` with its
original harnesses it reported **7 fail / 11 pass**, where all 7 failures
were the same stale-harness artifact — the harnesses' setup commits are
now refused pre-dispatch by Finding 1's fix. After the harness
modernization described below, the research suite reports
**18 pass / 0 fail** (verbatim output:
`research/issue-22/evidence/repro-rerun-2026-11.txt`).

**Method.** For each finding: the exact current code path was identified,
the smallest deterministic counterexample from the PR #23 research suite
was re-run against current main, and the finding was classified
CONFIRMED / FIXED / NOT REPRODUCIBLE / OPEN DESIGN QUESTION. Where a
merged fix made the original harness unreachable, the harness was updated
to the earliest reachable boundary asserting the same safe behavior; every
such change is listed in §8 and no assertion was weakened — in each case
the current safe behavior is *stronger* (refusal before dispatch) than
the behavior the original test asserted (no VERIFIED/OK receipt).

## Summary

| # | Finding | Classification | Fix / regression home | Repro today |
|---|---|---|---|---|
| 1 | Authorization-preserving execution (P0) | **FIXED** | PR #24; `test47` | repro43 updated, passes |
| 2 | Runtime proposal validation (P1) | **FIXED** | PR #25; `test48` | repro44 unmodified, passes |
| 3 | Identity binding (P1) | **FIXED** | PR #26; `test49` | repro45.1/45.2 updated, pass |
| 4 | Currency/cadence comparability (P1) | **FIXED** (schema limitation recorded) | PR #26; `test49` | repro45.3–45.6 unmodified, pass |
| 5 | Receipt verification / verified view (P1) | **FIXED** | PR #27, PR #53; `test50` | repro46 rebuilt at store level, passes |
| 6 | Envelope nomenclature (P2) | **OPEN DESIGN QUESTION** | — (frozen file) | substantiated by inspection |
| 7 | Adapter verification & recovery evidence (P1/P2) | **FIXED** via #43/#44; residual items owned by #45/#51 | PR #50, #52, #53; `test58`–`test61` | see §7 |

Closed issues #43, #44, #46 are reconciled in §9: all FIXED by their
merged PRs, their regression files pass in the 872-test baseline, and no
new failing evidence was found against any of them. **None is reopened.**

## 1. Finding 1 — Authorization-preserving execution — FIXED

**Original counterexample (Fabio; locally reproduced in PR #23, test
43.1).** OPERATION-authorized `CHANGE_QUANTITY pilot-addon-vision 1→21`;
a third party adds an ordinary unrelated addon after the adapter's final
pre-commit read; the adapter dispatches `update_for_items` with
`replace_items_list=true` and the quote-time list, deleting the
concurrent item; the receipt reports `COMMITTED_AND_VERIFIED` /
reconciliation `OK` because the landed state equals the intended target.

**Current code path.** `ChargebeeLiveAdapter.commitChangeQuote`
(`reference/src/live/chargebee-scq-adapter.ts`): the authorization scope
recorded on the quote (default OPERATION) is checked against the
adapter's compile-time capability constant (`FULL_REPLACEMENT_ONLY`; the
`mutationCapability` getter reads the constant directly, so no instance
assignment can widen it — pinned by test47.13–47.15). An OPERATION commit
through a full-replacement mechanism is refused before dispatch with
`AUTHORIZATION_PRESERVATION_UNENFORCEABLE`
(`details.outcome = CONFIRMED_NON_EXECUTION`, no durable attempt
created). A quote claiming `TARGET_REPLACEMENT` scope is likewise
refused as unsupported in this build.

**Current-state run (repro43, modernized).** 43.1: the original scenario
now ends in that pre-dispatch refusal — zero mutating dispatches, the
concurrent item is never deleted. 43.2 (control): the same refusal
occurs with no concurrent write, proving the gate is capability-based,
not race-dependent. 43.3 (unmodified control): a concurrent add landing
*before* the commit-phase read still refuses `QUOTE_STALE` with zero
dispatches.

**Honest consequence.** The fix is refusal-complete: in this build the
Chargebee-live adapter has **no** dispatch path for item changes at all.
That is an availability limitation, accepted as the fail-closed posture;
a preservation-capable mechanism (targeted update / conditional write)
remains research (G-17 prototype, `test57`) and is not implemented in the
adapter. Classification: FIXED (safety), with the availability
consequence recorded here rather than hidden.

## 2. Finding 2 — Runtime proposal validation — FIXED

**Original counterexample.** `guaranteeMode: "REVALDIATE"` (typo) with
no envelope accepted on Stripe-sim, receipt OK; NaN / negative /
string-typed envelope bounds accepted; a NaN bound silently never binds
in `checkAcceptanceEnvelope`.

**Current-state run.** repro44 **unmodified**: 44.1–44.5 pass (typo
mode, NaN, negative, and string bounds refused at quote creation; NaN
bound no longer silently passes drifted revalidation) and the 44.6
well-formed control passes. Fix: PR #25 (runtime validation before any
provider read/preview); regression home `test48`. Classification: FIXED.

## 3. Finding 3 — Operation and subscription identity binding — FIXED

**Original counterexample.** A post-commit GET returning a different
`subscription.id` with matching item values verified VERIFIED/OK; the
receipt's snapshot named the other subscription. The rv-only fingerprint
could not catch a wrong-record read.

**Current code path.** Identity is bound at every read the mutating path
consumes (`reference/src/live/chargebee-scq-adapter.ts`):
`subscriptionIdentityMismatchError` (`details.blocked =
SUBSCRIPTION_IDENTITY_MISMATCH`, CONFIRMED_NON_EXECUTION semantics) is
raised at quote creation (creation read naming another subscription) and
at the commit-phase validation read; the mutation *response* naming
another subscription is not consumed as evidence; a post-commit re-read
naming another subscription is treated as unavailable evidence and named
in the classification reasons — it can never verify the record.

**Current-state run.** The original post-commit shape is unreachable
(the preservation gate refuses dispatch first), so repro45.1/45.2 were
moved to the earliest reachable boundary — the commit-phase validation
read, with `resource_version` preserved so the fingerprint cannot catch
it: 45.1 refuses `SUBSCRIPTION_IDENTITY_MISMATCH` with zero dispatches;
45.2 (same-id control) passes the identity boundary and is then refused
by the preservation gate. The full boundary set (quote creation,
pre-dispatch, store-level verification binding, simulator path) is
pinned in the default suite by test49.1–49.6. Fix: PR #26.
Classification: FIXED.

## 4. Finding 4 — Currency and cadence comparability — FIXED, with a recorded schema limitation

**Original counterexample.** Quoted USD vs committed EUR at identical
numbers reconciled OK; MONTHLY vs ANNUAL at the same amount reconciled
OK; the pre-mutation envelope gate ignored currency.

**Current-state run.** repro45.3–45.6 **unmodified** pass: cross-currency
and cross-cadence pairs no longer reconcile OK (the default suite pins
the precise outcomes — VIOLATED where units are established and
contradict, UNVERIFIED where a participating unit cannot be established,
never OK; test49.7–49.27), and the envelope gate refuses a
cross-currency revalidation. Fix: PR #26. Classification: FIXED.

**Recorded limitation.** `CommercialEffect.immediate` (frozen
`reference/src/core/types.ts`) has **no currency field**, so an
immediate-side currency is expressible only where unit context
establishes it (pinned by test49.11); where it cannot be established the
dimension reconciles UNVERIFIED, never OK. Giving `immediate` a currency
field is a schema change to a frozen file and belongs to a future
normative revision (see §6's governance note); it is not an open
behavioral defect, because the fail-closed UNVERIFIED outcome already
prevents the original harm (silent OK).

## 5. Finding 5 — Receipt verification and independent later actuals — FIXED

**Original counterexamples.** (a) A dimension the receipt left
candidate-less could never be filled by later evidence; (b) a wrong
candidate could never be corrected — differing established actuals were
refused as `CONFLICTING_RECEIPT_IDENTITY`; (c) confirming evidence
flipped the view to VERIFIED/OK while the displayed figures still
carried determinacy UNKNOWN / committedSource "unestablished".

**Current model (PR #27; candidate sourcing corrected by PR #53).**
Three layers in `reference/src/store/quote-store.ts`: (1) the recorded
receipt (`commit_receipt_recorded`) — immutable, its identity digest
includes the recorded candidates forever; (2) an append-only,
identity-bound evidence trail (`commit_receipt_verifications`) —
admissibility, per-dimension establishment, and promotion are separate
questions; (3) a derived current view (`commit_receipt`) computed from
(1) + (2), displaying established actuals with the establishing
evidence's provenance.

**Current-state run.** repro46 rebuilt on the store-level candidate
construction (the live-adapter construction is unreachable since
Finding 1's fix; the construction mirrors `test50`, with every
established figure derived from a mock provider record): 46.1 — a
candidate-less immediate dimension is filled by established evidence;
46.2 — evidence establishing recurring 83400 against a recorded 80900
candidate is recorded, the derived view carries 83400 with
reconciliation VIOLATED, and `commit_receipt_recorded` still carries the
candidate verbatim; 46.3 — confirming evidence yields VERIFIED/OK with
the view's provenance `provider_actual` / DETERMINED, while the recorded
original keeps its candidate labels. Classification: FIXED.

## 6. Finding 6 — Envelope nomenclature — OPEN DESIGN QUESTION

Substantiated by inspection, unchanged today:
`AcceptanceEnvelope.maxImmediateCreditDecrease` is documented in frozen
`reference/src/core/types.ts` (line 242) as "Max decrease in an immediate
credit magnitude the caller will accept", but the comparison applies it
to **any** favorable net movement (a smaller charge with no credit
involved consumes the same budget). The name/doc describe
credit-magnitude reduction; the semantics are favorable-movement
magnitude. The v0.6.2 spec's own text does not carry the misleading
prose (it names the field among the envelope bounds read as finite,
non-negative values).

**Disposition.** No behavior change is proposed — the mathematics are
the protocol's, and silently changing them would be worse than the name.
The correction is documentation/schema-level and the field's doc lives
in a **frozen** file, so it cannot be made in this audit. Recommended
for the next normative revision (v0.7): re-document the field as
bounding favorable net movement of either kind, or rename it with a
migration note. Until then this document is the recorded clarification:
**`maxImmediateCreditDecrease` bounds the magnitude of any favorable
immediate net movement, whether or not a credit is involved.**

## 7. Finding 7 — Adapter verification and recovery evidence — FIXED via #43/#44; residuals owned by #45/#51

- **Stripe-sim EXACT/CANCEL verification source** (the shared
  `isCancel || EXACT` branch claimed VERIFIED from the mutation result
  without reading state back). This became **Issue #44** and was FIXED
  by PR #52 (operation-bound journal evidence; wrong-state,
  never-landed, and intervening-change cases classify
  COMMITTED_UNVERIFIED/UNVERIFIED, never VERIFIED/OK) as corrected by
  PR #53; regression home `test61` (with `test60` for the #46
  attribution narrowing). Not reopened: `test61` passes in the baseline
  and this audit produced no new failing evidence.
- **Operator `resolveAttempt` (free-text note as sole precondition).**
  This became part of **Issue #43** and was FIXED by PR #50: durable
  INDETERMINATE resolution now requires a branded token minted by a
  trusted provider-evidence verifier (`resolveAttempt` accepts
  `ResolveAttemptInput` — an established token plus the operator's
  recorded decision; raw evidence objects are refused); regression
  homes `test58`, `test59`. **Residual:** the replay query's
  VERIFIED-only scoping and the migrated-legacy-evidence upgrade path
  are owned by **Issue #51** (separate workstream; not a #22 item).
- **Concurrency keying across sites** (`findBlockingAttempt` matches
  `(quote_id OR subscription_id)` with no provider/site predicate).
  Owned by **Issue #45** (separate workstream, including its §6.16
  governance question).
- **test27 Windows subprocess path.** NOT REPRODUCIBLE in this
  environment (Linux); it is an OS/CI-hardening track, not a protocol
  safety finding, and remains separate, as Issue #22 itself records.

## 8. Research-suite harness changes made by this audit (disclosed)

No pre-existing **default-suite** test was modified. The research suite
is separately invoked and outside CI discovery; its changes:

- `repro43` — 43.1/43.2 rewritten to assert the current safe behavior
  (pre-dispatch preservation refusal; §1). Scenario fixture, wire
  capture, and 43.3 unchanged. Justification: the asserted defect
  behavior was eliminated by PR #24; the old assertions are
  unreachable because the commit they drove is now refused earlier.
- `repro45` — 45.1/45.2 moved from the post-commit re-read (unreachable
  since PR #24) to the commit-phase validation read (§3); stale
  "(expected FAIL)" markers removed from the passing 45.3/45.4 titles.
  45.3–45.6 assertions unchanged.
- `repro46` — rebuilt on the store-level candidate construction (§5)
  because the live-adapter construction is unreachable since PR #24;
  the three scenarios assert the same safe behaviors as the originals,
  plus the immutability control now compares against
  `commit_receipt_recorded` (the PR #27 model's recorded-original
  field) instead of the derived view.

## 9. Closed-issue reconciliation

| Issue | Subject | Disposition then | Current state |
|---|---|---|---|
| #43 | Durable INDETERMINATE resolution evidence (P0) | PR #50 merged | FIXED; `test58`/`test59` pass; not reopened |
| #44 | Stripe-sim wrong-state EXACT/CANCEL verification | PR #52 + PR #53 merged | FIXED; `test61` passes; not reopened |
| #46 | Immediate-attribution narrowing (§3.10 candidates) | PR #53 + PR #54 merged | FIXED; `test60` passes; not reopened |

No new failing evidence against any of the three was produced by this
audit; per the mission ground rules none is reopened.

## 10. Acknowledgement

Fabio's external review (Discussion #2) reported five concrete,
reproducible defects and two further substantiated findings against
this codebase, with counterexamples precise enough to be re-run
verbatim locally. Findings 1–5 each drove a merged fix (PRs #24–#27,
with #43/#44/#46 follow-ons), and this reconciliation confirms those
fixes hold on current main. The review materially improved the safety
of this reference implementation, and this document's classifications
rest on his reported reproductions as their starting point.

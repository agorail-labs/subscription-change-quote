# Stripe-simulator EXACT / CANCEL wrong-state verification (Issue #44, G-21 item 1)

**Scope.** Whether the Stripe reference adapter's EXACT and CANCEL commits can
record `COMMITTED_AND_VERIFIED` / reconciliation `OK` when the state that
actually persisted differs from the authorized state — and, where they could,
the minimal correction. All evidence is from the in-memory Stripe simulator;
every result is **SIMULATED_PASS-class**: no live Stripe API was called and
nothing here certifies a real provider integration.

**Baseline.** `origin/main` at `b00e74b1c8fda18f95be2a31f2f155fc87963a14`
(PR #49 publication + PR #50 squash-merge).

---

## 1. Phase-1 findings — how each operation established its receipt (baseline)

The Stripe adapter's `commitChangeQuote` has three arms: a shared
`isCancel || effectiveMode === "EXACT"` arm, and the REVALIDATE arm
(`establishCommittedEffect`). Only the REVALIDATE arm read anything back.

### 1a. CANCEL (TERM_END or IMMEDIATE, EXACT mode — the live EXACT surface)

| Question | Baseline behaviour |
| --- | --- |
| 1. Execution attribution | The `sim.cancel()` return value was taken as the operation's result. No operation-keyed read distinguished this cancellation from any other actor's write. |
| 2. Intended-state preservation | **Not checked at all.** No post-commit `retrieve`, no `verifyPostCommitState`. The receipt snapshot was built from the mutation **return** — so even the record of the resulting state was the response's own claim. |
| 3. Financial figures | Quoted figures verbatim (recurring 0; immediate NOT_APPLICABLE under the §3.10 CANCEL license), relabelled `defined_equal_exact`. |
| 4. Verification status | `COMMITTED_AND_VERIFIED` asserted **unconditionally**. |
| 5. Receipt reconciliation | `reconcileCommittedEffect(quoted, quoted-copy)` — the quote compared against itself; structurally always `OK`. |

### 1b. EXACT update arm (CHANGE_QUANTITY / CHANGE_PLAN / CHANGE_CADENCE with `effectiveMode === "EXACT"`)

Identical shape to 1a (the arms are one branch): `sim.update()` with the
quote's `proration_date` replayed, then figures := quoted
(`defined_equal_exact`), reconciliation := self-comparison, outcome
`COMMITTED_AND_VERIFIED` unconditionally, snapshot from the return value.

**Reachability boundary (pinned executably, test61.13).** This arm is **not
reachable from adapter-minted quotes today**: Stripe's advertised coverage
for non-CANCEL actions carries `termEffect: "UNKNOWN"`, so
`enforceGuaranteeRequest` refuses an overall-EXACT update quote at creation
(`UNSUPPORTED_CHANGE`). Every merged Stripe EXACT test is a CANCEL for this
reason. The live defect surface is therefore CANCEL; the update arm is a
defensive path (shared branch, proration-replay machinery) that must still
not be an unverified path if a stored EXACT record ever reaches it — the
counterexamples exercise it through a store-seeded EXACT record built from a
genuine adapter-minted quote (see test61's helper; only the commit path is
under test, no verification is bypassed by the seeding).

### 1c. REVALIDATE arm (contrast — the correct discipline, already present)

Independent `retrieve` + the mutation's own invoice read back **by id**
(never `latest_invoice`); the verdict **computed** by `establishVerification`
(§6.12 hook over the read-back snapshot against the folded intent):
state MISMATCH ⇒ `COMMITTED_AND_VERIFIED` + `VIOLATED` (Decision D3);
UNVERIFIABLE or read failure ⇒ `COMMITTED_UNVERIFIED` with candidate figures
labelled `unestablished`; an intervening invoice ⇒ `COMMITTED_UNVERIFIED`
(attribution, M3). §6.12 ("Before a verified receipt is recorded … the
committed STATE MUST be verified") and §6.15 ("COMMITTED_AND_VERIFIED
requires … state VERIFIED under §6.12 … A successful HTTP response is not
sufficient evidence") state this as a requirement, not a REVALIDATE-only
nicety — the EXACT/CANCEL arm simply never implemented it.

### 1d. The contract distinction the branch conflated

`defined_equal_exact` (§3.9/§3.11) is **contract-defined equality of the
committed FIGURES**: under EXACT, committed := quoted *by protocol
definition*, and that label establishes the figures where the EXACT contract
justifies it. It says nothing about whether the intended **state** landed —
state is a separate question with its own contract (§6.12). The baseline
branch treated defined-equal figures as if they discharged the state
question too: no read, no verdict, verified receipt. The ratified **G-01
trust limitation** is preserved by the correction: the label remains an
adapter-recorded classification, not authentication of provider origin.

---

## 2. The fault model (Phase 2)

New opt-in, one-shot misexecution hooks on the **public StripeSim API**,
modelled on the Chargebee simulator's (`_debugWrongQuantityOnNextUpdate`,
`_debugCancelImmediatelyOnNextCancel`, …). Shared shape: the mutation's
**response artifact reports the requested state** while the **persisted
record diverges** — a provider that applied the wrong change but answered as
if it had applied the right one. The fault alters persisted simulator state
only; it touches no adapter code and injects no verdict. The generated
invoice keeps the figures computed for the dispatched request (what the
provider charged for the call it received — the state, not the billing,
diverged).

- `_debugWrongQuantityOnNextUpdate` / `_debugWrongPriceOnNextUpdate` —
  persisted quantity/price differ from the requested ones.
- `_debugCancelImmediatelyOnNextCancel` — a TERM_END cancel lands terminal.
- `_debugShiftPeriodEndOnNextCancel` — persisted `current_period_end`
  shifted (wrong effective date for the schedule).
- `_debugSkipCancelOnNextCancel` — success returned, nothing persisted.
- `_debugDropSubscriptionOnNextMutation` — mutation lands, then the
  persisted subscription record is removed (post-mutation state missing).
- `_debugLoseNextCancelResponse` — cancel-side symmetry for the existing
  `_debugLoseNextUpdateResponse` (lands, then `api_connection_error`).

## 3. Failing-first results (test61 vs the baseline adapter)

14 tests: **7 pass / 7 fail** on the unmodified adapter (full output in the
delivery record). Exact baseline classifications:

| Case | Baseline | Required |
| --- | --- | --- |
| 61.1 EXACT qty 120→persisted 130 | `COMMITTED_AND_VERIFIED` / `OK` | VIOLATED |
| 61.2 EXACT plan, persisted price unchanged | `COMMITTED_AND_VERIFIED` / `OK` | VIOLATED |
| 61.3 TERM_END cancel lands immediate | `COMMITTED_AND_VERIFIED` / `OK` (snapshot showed the *scheduled* shape from the return) | VIOLATED |
| 61.4 TERM_END cancel, period end +7d | `COMMITTED_AND_VERIFIED` / `OK` | VIOLATED |
| 61.5 TERM_END cancel never lands | `COMMITTED_AND_VERIFIED` / `OK` | `COMMITTED_UNVERIFIED` / `UNVERIFIED` |
| 61.6 EXACT update, post-mutation state missing | commit **threw** `No such subscription` (unguarded `fingerprint()` after the mutation); no receipt recorded | `COMMITTED_UNVERIFIED` receipt with unestablished candidates |
| 61.12 replay of the (would-be) VIOLATED receipt | first commit `OK` — nothing to replay | VIOLATED receipt, verbatim replay |

Passing on baseline, by design (pins/controls): 61.0 fault shape; 61.7/61.8
lost response ⇒ `INDETERMINATE` + no blind retry (the recorded-outcome guard
already refused a second commit, state landed exactly once); 61.9/61.10/61.11
happy paths; 61.13 the EXACT-update reachability boundary.

## 4. Root cause

One branch, three compounding choices: (i) figures assigned from the quote
under `defined_equal_exact` — legitimate for figures, silently extended to
state; (ii) reconciliation computed over the quote against its own copy, so
the one post-commit check that existed could never fire; (iii) outcome and
snapshot taken from the mutation return, so the response's claim became the
record. No §6.12 verification existed on the branch at all.

## 5. The correction (Phase 3)

`commitChangeQuote`'s EXACT/CANCEL arm now delegates to
`establishExactOrCancelEffect` (adapter-private, mirroring the REVALIDATE
arm's `establishCommittedEffect`):

1. **Independent read.** A fresh `sim.retrieve(subscriptionId)` after the
   mutation — never the return value. The receipt snapshot is built from
   the read-back state (fingerprint guarded: a missing record no longer
   throws out of the commit).
2. **Computed verdict.** `verifyPostCommitState` over the read-back
   snapshot against the **folded** intent (ACTION_LEVEL, subscription
   identity bound). For CANCEL, schedule evidence is derived from the
   persisted record itself (`cancel_at_period_end` + `current_period_end`,
   or `canceled_at`) — the fields the provider record carries, read back
   after the mutation; a schedule is never invented when the record
   carries none. The authorized TERM_END boundary comes from the
   expectation side only (the quoted effect's `effectiveAt`), per §6.12.
   The adapter calls the hook directly rather than through
   `establishVerification` because the frozen `ProviderObservation` type
   carries no `cancellationSchedule` field — the same reason the Chargebee
   paths consume the hook directly (V62-SV-02).
3. **Verdict mapping.**
   - VERIFIED ⇒ the historical construction, unchanged: figures :=
     quoted, `defined_equal_exact`, envelope reconciliation, `COMMITTED` /
     `COMMITTED_AND_VERIFIED` — now *gated* on the verified state.
   - MISMATCH ⇒ `COMMITTED_AND_VERIFIED` + **VIOLATED** (D3: execution
     established, state contradicts intent — never non-execution, never
     INDETERMINATE), recording the **observed actuals**
     (`provider_actual`; EXACT immediate from the mutation's bound invoice
     read by id where readable, else that dimension stays UNKNOWN — an
     unestablished financial dimension never downgrades the established
     state violation, §6.14 precedence).
   - UNVERIFIABLE, read unavailable/missing, or (EXACT updates) an
     intervening invoice breaking attribution (the M3 rule) ⇒
     `COMMITTED_UNVERIFIED` + `UNVERIFIED`, figures recorded as the
     mutation response's **candidates** under UNKNOWN determinacy /
     `unestablished` (or, in the attribution case, this commit's own
     bound-invoice actuals — never the intervening invoice's).
4. Nothing else moved: quote creation, the REVALIDATE arm, the
   INDETERMINATE/lost-response handling, and the durable-recovery gates
   (PR #50) are untouched in behaviour; no frozen file was edited
   (spec v0.6.1/v0.6.2, `core/types.ts`, `core/scq-engine.ts` — footprint
   empty). `describeStateMismatch`'s CANCEL case gained schedule-aware
   reason fragments (its only caller context for CANCEL is this path).

### Before / after matrix

| Case | Before | After |
| --- | --- | --- |
| EXACT wrong quantity/price persisted | VERIFIED / OK, snapshot = return's claim | VERIFIED outcome / **VIOLATED**, snapshot + figures = observed actuals |
| TERM_END lands immediate | VERIFIED / OK | VERIFIED outcome / **VIOLATED** (premature termination) |
| TERM_END wrong effective date | VERIFIED / OK | VERIFIED outcome / **VIOLATED** |
| TERM_END schedule absent | VERIFIED / OK | **COMMITTED_UNVERIFIED** / UNVERIFIED |
| Post-mutation state missing | commit threw; no receipt | **COMMITTED_UNVERIFIED** / UNVERIFIED, candidates labelled |
| Lost response (update/cancel) | INDETERMINATE, no retry | unchanged (pinned) |
| Happy paths (EXACT, TERM_END, IMMEDIATE cancel) | VERIFIED / OK, `defined_equal_exact` | unchanged (pinned by 61.9–61.11 + test17.12) |

## 6. Validation (Phase 4)

- Full suite: **861/861 on Node v22.14.0** and **861/861 on Node
  v20.19.5** (better-sqlite3 rebuilt per Node version; Node 22 binding
  restored last, suite re-run 861/861; all final runs from a clean
  `dist/`). Composition, each figure measured on its own tree: 829
  at the original baseline (`b00e74b`); main at `e2a44f2` is 843
  (PR #53 added 14); the original PR head was 843 (829 + this
  suite's 14); the integrated baseline is 857 (843 + this suite's
  14, renumbered test60 → test61 to avoid the identifier collision
  with main's own test60-i46 suite); the correction round (§8)
  adds tests 61.14–61.17 for 861.
- test61: **18/18**. Existing Stripe regressions (test17 incl. 17.12,
  test4, test12, test35, test49, test54) all pass unmodified, as does
  the REVALIDATE arm's pinned concurrent-write discipline
  (test17.9 — that arm's establishment is out of this round's scope).
- Receipt replay / idempotency: pinned by 61.6 (UNVERIFIED receipt replays
  verbatim, no re-dispatch against missing state) and 61.12 (VIOLATED
  receipt replays verbatim), and by the unmodified suite (test17.10
  family, test50, durable-store test58/test59 — PR #50's machinery
  untouched).
- Provider-neutrality check: OK. Freeze footprint
  (`git diff main...HEAD` over both specs, `core/types.ts`,
  `core/scq-engine.ts`): **empty**.

## 7. Remaining limitations

- **Simulator only.** The sim's persisted record carries the cancellation
  schedule on the subscription object itself, so schedule evidence here is
  a read of that record. A real provider's schedule may live on a separate
  object; binding it is the live adapter's work, not demonstrated here.
- **ACTION_LEVEL coverage.** State outside the proposal's targeted
  items/dimensions is not examined on this path (the hook reports this
  limitation itself); FULL_ITEM_SET would require the expected resulting
  set on the expectation side.
- **G-01 stands.** `defined_equal_exact` remains a classification the core
  trusts from the adapter; nothing here authenticates provider origin, and
  the no-verifier fail-closed posture of the durable store (PR #50) is
  unaffected.
- **The EXACT-update arm** remains unreachable from adapter-minted quotes
  (quote-time coverage refusal, test61.13); it is verified defensively via
  a store-seeded record because the branch is shared with CANCEL.
- G-21 stays OPEN for its other items per the gap register; this note
  resolves item 1's *implementation* question only.
- **The transition journal is a simulator model.** It is complete
  and ordered by construction (every modeled mutation path
  journals). A live Stripe adapter would need the provider's real
  event/artifact binding — webhook delivery is neither complete
  nor ordered by default — so the attribution chain demonstrates
  the *discipline*, not a live capability. SIMULATED_PASS.

## 8. Correction round (PR #52 review — R1, R2, R3)

The independent review of the original delivery verified the
central finding and the corrected classifications, and returned
three corrections. Dispositions:

**R3 — integration.** PR #53 (issue #46) merged while this PR was
in review and added its own `test60` suite on main. The branch
merged `origin/main` (`e2a44f2`; merge commit, no rebase — the PR
carries review history) and this suite renumbered
**test60 → test61** (file, test names, traceability and this
note). Integrated baseline before the R1/R2 work: **857 tests,
all passing** (main's 843 + this suite's 14).

**R1 — UNVERIFIABLE receipts must name the undetermined
dimensions (§3.10/§6.15).** The state-UNVERIFIABLE branch of
`establishExactOrCancelEffect` recorded `candidateFromResponse()`
figures (both determinacies UNKNOWN) but returned
`undeterminedDimensions: []` — an empty list falsely implying
every dimension had been determined. Fixed: the branch now names
`["immediateFinancialEffect", "recurringFinancialEffect"]`, the
same order as the missing-read branch. Failing-first: test61.5
(extended) and test61.14 both failed on exactly this assertion
against the integrated unfixed code. Test61.14's shape is
deliberate: a seeded item entry with **no identifier** — under
§6.12 (SV3/SV5) an unidentifiable observed entry could be a
contradictory duplicate, so the verdict is UNVERIFIABLE while
the identified entry lands exactly as authorized and no third
party intervenes. (Test61.6's missing-state shape takes the
missing-read branch, which already named both dimensions, so it
could not pin this branch.)

**R2 — attribution before classification (§6.15).** The original
correction classified the *observed* state without establishing
that this operation produced it: a third party's rewrite between
dispatch and verification was recorded as this operation's
VIOLATED actuals, a third-party-installed matching schedule
verified a cancel that never landed, and the EXACT arm's M3
`latest_invoice` check sat *behind* the MISMATCH branch. The
correction builds an operation-attribution chain on the
simulator's public surface and consumes it in the establishment
**before** any classification:

- *Transition journal (sim, additive).* The sim now journals
  every state transition per subscription — its model of
  Stripe's `customer.subscription.updated` event stream:
  `update()`/`cancel()` applications append
  `{ seq, subscriptionId, kind, at, resultingFingerprint }`,
  and `_debugMutateDirectly` appends `kind: "external"`.
  Fault-skipped effects journal **nothing** (a skipped cancel
  leaves no transition — its absence is the evidence), while
  wrong landings journal their **wrong** fingerprint (the wrong
  landing is the operation's own transition, so attribution
  convicts rather than excuses it: tests 61.1–61.4 are
  unchanged). The journal never enters `fingerprint()` material
  and changes no existing behaviour. Public reads:
  `transitionSeq(id)` (watermark) and `listTransitions(id,
  afterSeq)`.
- *Adapter consumption.* `commitChangeQuote` captures the
  watermark immediately before dispatch and passes it to the
  establishment. The observed state is attributed to this
  operation only when the window since the watermark holds
  **exactly one** transition, of the dispatched kind, whose
  journaled resulting fingerprint equals the verification
  read's fingerprint. Otherwise the commit is
  `COMMITTED_UNVERIFIED` / `UNVERIFIED`: the observed state is
  recorded as context, the figures as candidates with both
  undetermined dimensions named — never VIOLATED, never
  VERIFIED/OK. The M3 `latest_invoice` check is retained,
  now evaluated only for attributed states (the journal gate
  precedes it).

After-fix matrix for the reviewer's three scenarios (all three
failed failing-first against the integrated unfixed code —
13 pass / 5 fail across the extended test61, the other two
failures being R1's pair):

| Scenario | Before (round-1 correction) | After (this round) |
| --- | --- | --- |
| S1 (61.15): cancel lands correct TERM_END schedule; third party rewrites the date before the read | `COMMITTED_AND_VERIFIED` / **VIOLATED** over the third party's state | `COMMITTED_UNVERIFIED` / UNVERIFIED, observed state as context |
| S2 (61.16): cancel skipped (never lands); third party installs the intended schedule before the read | `COMMITTED_AND_VERIFIED` / **OK**, `defined_equal_exact` | `COMMITTED_UNVERIFIED` / UNVERIFIED — a matching state this operation did not produce cannot verify it |
| S3 (61.17): intervening update lands a mismatch and replaces `latest_invoice` (EXACT arm) | `COMMITTED_AND_VERIFIED` / **VIOLATED** (MISMATCH fired before the M3 check) | `COMMITTED_UNVERIFIED` / UNVERIFIED — attribution gate precedes classification |
| Controls: provider's own wrong landing (61.1–61.4) | VIOLATED | **unchanged** — VIOLATED over observed actuals |
| Controls: happy paths (61.9–61.11), lost response (61.7/61.8), replay (61.12) | as pinned | **unchanged** |

No scenario required a downgrade: the journal binds all three
honestly — each interposition is a journaled transition (or a
journaled absence), so the attribution verdict is computed from
the modeled event stream rather than asserted.

Validation for this round: failing-first record
`P1-52-R12-FAILING-FIRST` (test61 vs the integrated unfixed
code: 18 tests, 13 pass / 5 fail — 61.5 and 61.14 for R1;
61.15–61.17 for R2); after the fix, test61 **18/18** and the
full suite **861/861 on Node v22.14.0 and v20.19.5**, all runs
against the committed tree. Freeze footprint empty; neutrality
OK. All results SIMULATED_PASS.

**Count-integrity note.** This round's first full-suite runs
read 871 (integrated) and 875 (final): the worktree's `dist/`
still held the pre-rename compiled `test60` suite alongside
`test61`, so the Stripe suite ran twice under two names. `dist/`
is gitignored build output — the committed tree was never
affected, and CI (clean checkout) never saw the phantom suite.
The discrepancy was caught by measuring each baseline tree
separately (829 / 843 / 843 / 857) before anything was posted;
the binding figures above are from clean-`dist/` rebuilds of
the committed tree. Lesson recorded with the original delivery's
slip: validate the committed tree *as a clean checkout*, not
the worktree.

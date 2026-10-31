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

**Reachability boundary (pinned executably, test60.13).** This arm is **not
reachable from adapter-minted quotes today**: Stripe's advertised coverage
for non-CANCEL actions carries `termEffect: "UNKNOWN"`, so
`enforceGuaranteeRequest` refuses an overall-EXACT update quote at creation
(`UNSUPPORTED_CHANGE`). Every merged Stripe EXACT test is a CANCEL for this
reason. The live defect surface is therefore CANCEL; the update arm is a
defensive path (shared branch, proration-replay machinery) that must still
not be an unverified path if a stored EXACT record ever reaches it — the
counterexamples exercise it through a store-seeded EXACT record built from a
genuine adapter-minted quote (see test60's helper; only the commit path is
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

## 3. Failing-first results (test60 vs the baseline adapter)

14 tests: **7 pass / 7 fail** on the unmodified adapter (full output in the
delivery record). Exact baseline classifications:

| Case | Baseline | Required |
| --- | --- | --- |
| 60.1 EXACT qty 120→persisted 130 | `COMMITTED_AND_VERIFIED` / `OK` | VIOLATED |
| 60.2 EXACT plan, persisted price unchanged | `COMMITTED_AND_VERIFIED` / `OK` | VIOLATED |
| 60.3 TERM_END cancel lands immediate | `COMMITTED_AND_VERIFIED` / `OK` (snapshot showed the *scheduled* shape from the return) | VIOLATED |
| 60.4 TERM_END cancel, period end +7d | `COMMITTED_AND_VERIFIED` / `OK` | VIOLATED |
| 60.5 TERM_END cancel never lands | `COMMITTED_AND_VERIFIED` / `OK` | `COMMITTED_UNVERIFIED` / `UNVERIFIED` |
| 60.6 EXACT update, post-mutation state missing | commit **threw** `No such subscription` (unguarded `fingerprint()` after the mutation); no receipt recorded | `COMMITTED_UNVERIFIED` receipt with unestablished candidates |
| 60.12 replay of the (would-be) VIOLATED receipt | first commit `OK` — nothing to replay | VIOLATED receipt, verbatim replay |

Passing on baseline, by design (pins/controls): 60.0 fault shape; 60.7/60.8
lost response ⇒ `INDETERMINATE` + no blind retry (the recorded-outcome guard
already refused a second commit, state landed exactly once); 60.9/60.10/60.11
happy paths; 60.13 the EXACT-update reachability boundary.

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
| Happy paths (EXACT, TERM_END, IMMEDIATE cancel) | VERIFIED / OK, `defined_equal_exact` | unchanged (pinned by 60.9–60.11 + test17.12) |

## 6. Validation (Phase 4)

- Full suite: **843/843 on Node v22.14.0** and **843/843 on Node
  v20.19.5** (baseline 829 + test60's 14; better-sqlite3 rebuilt per Node
  version; Node 22 binding restored last, suite re-run 843/843).
- test60: **14/14**. Existing Stripe regressions (test17 incl. 17.12,
  test4, test12, test35, test49, test54) all pass unmodified.
- Receipt replay / idempotency: pinned by 60.6 (UNVERIFIED receipt replays
  verbatim, no re-dispatch against missing state) and 60.12 (VIOLATED
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
  (quote-time coverage refusal, test60.13); it is verified defensively via
  a store-seeded record because the branch is shared with CANCEL.
- G-21 stays OPEN for its other items per the gap register; this note
  resolves item 1's *implementation* question only.

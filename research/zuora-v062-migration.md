# Zuora simulator migration to v0.6.2 (PR-5)

Scope: `reference/src/adapters/zuora-sim.ts`, `reference/src/adapters/zuora-adapter.ts`,
Zuora tests (`test9-zuora.test.ts` disclosed updates; new `test24-zuora-v062-migration.test.ts`).
No frozen files changed (`spec/`, `reference/src/core/`, `reference/src/store/` untouched);
no other adapter changed; BC-1 core fail-closed activation is **not** part of this migration —
the adapter protects itself (M2 pattern from PRs #10/#11). Everything here is validated against
the in-memory simulator only: **SIMULATED_PASS**, never LIVE_PASS.

## What was wrong (failing-first probes against main `cdde2fa`)

- **Probe A — overlapping-change double count.** `[quantity 100→120, →150]` on one item quoted
  `immediate.net = 70000` (correct: 50000). Each change was previewed against the *same original*
  subscription and the per-change deltas summed.
- **Probe B — dropped recurring contribution.** Quantity changes on two different items quoted
  recurring `130000` (correct: 150000): the combined effect kept only the *last* change's preview.
- **Probe C — zero re-encoded as absent (F-2).** A plan swap whose preview established net 0
  produced a quote with `immediate` absent and no determinacy record anywhere; `combineEffects`
  additionally zero-filled absent dimensions with `?? 0`.
- **Probe D — committed effect was the revalidated preview (F-1).** With the provider landing at
  quantity 130 against a 120 preview, the receipt reported committed recurring `120000` with
  reconciliation `OK` and no `committedSource` — reconciliation compared the quote against the
  preview that gated the commit, so a wrong landing was undetectable.
- **Probe E — no order identity.** `createOrder` returned only `{subscription, result}` (the
  adapter destructured the result away); the sim had no persisted, readable order artifact.

## The migration

**Quote construction (ordered sequence, one preview).** The proposal resolves into ONE ordered
order-action sequence (`resolveSequence`): later actions see earlier actions' results — a plan
removed earlier in the sequence cannot be targeted again (refused `INVALID_PROPOSAL` at quote
time, never silently re-targeted), and a swap carries forward the quantity an earlier in-sequence
change established. ONE preview of that exact sequence produces the combined effect; the stored
sequence is verbatim what commit dispatches (test 24.1 asserts the persisted order's actions
equal the quote's). The sim's preview computation was rewritten to price the sequence in order
against an evolving working state.

**Financial semantics.** Every effect carries `determinacy` + `provenance`. `immediate` is the
order's invoice-item net (the obligation the sequence incurs), with charge/credit parts summed
from the invoice items themselves. An established zero is a present `{ net: 0 }` (DETERMINED).
A preview that omits a figure yields UNKNOWN — no value emitted, never zero-filled. A sequence
containing a mid-committed-term cancellation yields UNKNOWN immediate: whether an
early-termination charge applies is decided outside the order (`earlyTerminationChargeUnknown`),
so the total incurred obligation is not established — never a fabricated zero, never
NOT_APPLICABLE. Pure CANCEL with the termination question settled asserts immediate
NOT_APPLICABLE under the §3.10 license with its citation; recurring is a DETERMINED zero.
Snapshots label `billing.recurringAmountState: "DETERMINED"` (CORE-7).

**Fail-closed before mutation (M2, adapter-level).** Quoted and revalidated effects must be
DETERMINED (finite) in both bounded dimensions, or licensed NOT_APPLICABLE (pure CANCEL
immediate only), else `QUOTE_NOT_DETERMINISTIC` before any mutating call — in EXACT and
REVALIDATE modes, for single, multi-change, and cancellation-bearing proposals alike. Refusals
are proven with persisted-order counts (0) and byte-identical state (tests 24.5–24.7, 24.9; the
updated test 9f).

**Committed effects independently established (M3).** The sim now persists every order as an
identifiable artifact (`ZuoraOrder`) readable via `retrieveOrder(id)`; `createOrder` returns the
`orderId`. The adapter binds verification to *that* order — never a latest-order pointer (kept
only as a divergence signal) and never a preview. Committed immediate comes from the persisted
order's financials; recurring from the re-read subscription state (0 when a verified
sequence-contained cancellation ends the subscription). State verification compares the re-read
state against the result the *complete intended sequence* implies (`expectedStateAfter`),
including a contained cancellation's scheduled-vs-terminal kind against the **quoted** date
(premature termination ⇒ MISMATCH — the PR #11 P3 lesson). Attribution requires the version
sequence to be the unbroken +1 from the validated version through the bound order's recorded
`subscriptionVersionAfter` to the re-read version; any intervening order ⇒ COMMITTED_UNVERIFIED
with the bound order's figures. Post-mutation read failure / unavailable order / missing order
financials ⇒ COMMITTED_UNVERIFIED whose candidate record is built entirely from the mutation
response (PR #11 P1) — recording never depends on a further successful read.

**Adapter-level establishment — a deliberate deviation from PRs #10/#11, with the reason.**
Stripe/Paddle route post-commit verification through PR-1's `establishVerification`, whose
generic snapshot check keys state by item identity. Zuora plan swaps *replace* the rate plan, so
the targeted item's instance id does not survive a correct landing (the generic check would
report MISMATCH for every correct CHANGE_PLAN), and the generic check cannot see a scheduled
cancellation (the F3 limitation Paddle already hit for CANCEL). Zuora therefore establishes at
the adapter level for all commit shapes — the Paddle-cancellation precedent generalized — while
still using the core's `reconcileCommittedEffect`, `determinacyOf`, `validateCommit`, and
`checkIdempotentReplay`. §6.10 replay and deferred `verifyCommitReceipt` transitions work
unchanged (test 24.20). **Later core work this implies:** the establishment machinery needs an
adapter-supplied state-verification hook so ordered-action providers can route through it
instead of beside it.

**Outcome classes.** Verified success (COMMITTED / COMMITTED_AND_VERIFIED, core-computed
reconciliation); verified contradiction (VIOLATED, D3 — committed figures report the observed
state); COMMITTED_UNVERIFIED (attribution or verification unavailable); INDETERMINATE on a lost
order response (outcome recorded, no receipt invented, retry refused, no second order);
CONFIRMED_NON_EXECUTION on a pre-effect rejection (recorded distinctly, state untouched).

**Preserved Zuora guarantees.** Native monotonic version drives staleness detection;
`consistencyGuarantee` stays **BEST_EFFORT** — one atomic multi-action *order* is a property of
the provider operation and is never conflated with atomicity of SCQ's read-check-mutate
sequence (test 24.21 pins both on one receipt). IMMEDIATE / TERM_END / DATE intents with the
pinned order effective date replayed verbatim; contract-term reporting unchanged; evergreen vs
committed-term cancellation semantics distinct (settled ⇒ licensed N/A; mid-term ⇒ UNKNOWN +
refusal); future-dated cancellation verified as SCHEDULED, never by demanding a terminal state.

## Remaining limitations

- The persisted-order model is a minimal sim-only artifact; real Zuora order/invoice retrieval
  semantics (asynchronous order processing, invoice posting states) are not modeled and nothing
  here is evidence about the real API.
- A sequence containing a mid-term cancellation cannot be committed at all until the
  early-termination question becomes establishable; the quote is creatable and honestly
  UNKNOWN. This is the fail-closed consequence of the sim's modeled gap, not a resolution of it.
- EXACT-mode commits are verified from post-commit actuals like REVALIDATE ones; where the
  actuals contradict the quote the receipt reports VIOLATED/COMMITTED_UNVERIFIED rather than the
  v0.6.1 deep-equal-by-definition shape — the disclosed test9 expectation changes record this.
- Adapter-level establishment (above) awaits a core state-verification hook to converge with
  the Stripe/Paddle path; BC-1 (fail-closed envelope in the core) remains a separate PR.

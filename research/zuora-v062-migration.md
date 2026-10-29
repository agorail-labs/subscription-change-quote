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

## Review corrections Z1/Z2 (PR #14) — attribution before classification

Two merge-blocking findings from the PR #14 review, both about *who an observed post-commit
state may be blamed on*. Failing-first probes against the branch tip `f96b957`:

- **Probe Z1 — contradiction classified before attribution.** A quantity order landed correctly;
  another actor then changed the quantity to 130 out-of-band (version 2 → 3). The receipt was
  `COMMITTED / COMMITTED_AND_VERIFIED / VIOLATED`: `establishCommittedEffect` evaluated
  `stateContradictions(...)` *before* the `attributable` chain check, so the intervening actor's
  mismatch was recorded as this commit's verified failure.
- **Probe Z2 — cancel path had no attribution at all.** A pure CANCEL (future DATE) landed as
  quoted; an intervening change then bumped the version while leaving the cancellation fields
  untouched. The receipt was `COMMITTED / COMMITTED_AND_VERIFIED / OK`: `establishCancelCommit`
  re-read only the subscription — never the bound order, never the version chain — so any
  matching cancelledDate/status verified as this commit's result.

**Fix — one classification order in both paths:** (1) retrieve the bound order and establish
the unbroken attribution chain (validated version → the bound order's `subscriptionVersionAfter`
== validated + 1 → re-read version == the order's version-after); (2) only if attribution holds,
evaluate state contradictions → VIOLATED (D3) or verified OK; (3) if attribution is broken or
unestablishable, COMMITTED_UNVERIFIED / UNVERIFIED — the bound order's immediate observation
is retained, and any observed mismatch is recorded in the reconciliation
reason as *unattributed context*, its cause not assigned to this commit (what "retained" means
for the recurring dimension was narrowed by Z3, next section). The pure-CANCEL path
additionally checks the bound order's **action identity** against the sequence this commit
dispatched (canonical comparison), and an unreadable bound order ⇒ COMMITTED_UNVERIFIED with
the candidate built from data already in hand (P1). The scheduled-vs-terminal and quoted-date
rules (P3) are unchanged and now run only behind the attribution gate; D3's VIOLATED is
preserved for provably attributable wrong landings.

**Regressions** (test24; suite 283 → 286):

- 24.13 (**reworked, required**): the attributable wrong landing now comes from this order's own
  misapplication — new sim-only one-shot hooks `_debugWrongQuantityOnNextOrder` /
  `_debugWrongRatePlanOnNextOrder` transform only the *applied* actions (the persisted order
  keeps the dispatched actions/figures; the version advances by exactly this order's +1) ⇒
  VIOLATED. Its previous construction (`_debugMutateDirectly` after the order landed) encoded
  the Z1 defect and moved to 24.23.
- 24.19 (**reworked, required**): the attributable premature termination now comes from our own
  order terminating immediately (`_debugCancelEffectiveNowOnNextOrder`; cancelledDate = today ≠
  quoted date, chain unbroken) ⇒ VIOLATED. The previous direct-mutation construction became a
  third case in the same test ⇒ UNVERIFIED.
- 24.23 (new): intervening change after our order, mismatching state ⇒ COMMITTED_UNVERIFIED /
  UNVERIFIED, observed mismatch recorded as unattributed context, immediate still the bound
  order's own figure. The matching-final-state counterpart remains 24.12 (UNVERIFIED).
- 24.24 (new): intervening *order* after our cancel order, cancellation state matching the
  quoted schedule, chain broken ⇒ UNVERIFIED — never a verified OK.
- 24.25 (new): bound order unreadable (`_debugFailOrderReads`) ⇒ COMMITTED_UNVERIFIED,
  candidate from data in hand, never OK/VIOLATED.

Note on deferred verification: the Zuora adapter exposes no deferred-verify entry point of its
own; `verifyCommitReceipt` remains the store-level PR-1 machinery driven by caller-built
observations (test 24.20, unchanged). The Z1/Z2 fixes govern the adapter's *initial*
classification, so a cancellation receipt can no longer be *born* verified-OK/VIOLATED without
attribution; the frozen store machinery itself is untouched.

## Review correction Z3 (PR #14) — financial attribution follows the same rule

A third merge-blocking finding from the PR #14 review, one layer below Z1: the *verdict* was
fixed, but the *figures* were not. Failing-first evidence against the Z1/Z2 head `9efc4a5`:

- **Probe Z3 — the broken-chain branch returned the intervening actor's recurring figure as
  this commit's determined actual.** `establishCommittedEffect` built `committedEffect` with
  `resultingAmount: recurringTotalOf(readSub)` labeled DETERMINED / `committedSource:
  "provider_actual"` *before* the `if (!attributable)` branch, and the broken-chain branch
  returned that same effect. Probe (24.23's construction: this order changed quantity
  100 → 120; another actor then changed it 120 → 130, version 2 → 3): status/outcome
  COMMITTED_UNVERIFIED, reconciliation UNVERIFIED — but `committedEffect.recurring` was
  `{ previousAmount: 100000, resultingAmount: 130000 }` with `recurringFinancialEffect:
  "DETERMINED"` and `undeterminedDimensions: []`. The 130000 was the intervening actor's
  result, not this order's (120000); an UNVERIFIED verdict and an explanatory reason do not
  change the financial figure's attribution. Test 24.23 at `9efc4a5` explicitly expected the
  130000 — the expectation itself encoded the defect.

**Fix (option (b), the safer minimum):** the broken-chain branch of `establishCommittedEffect`
now builds its own effect instead of returning the fully-determined one:

- **Immediate stays** — it is the bound order's own persisted actual, read by id: exactly the
  scope the persisted order establishes, with its DETERMINED determinacy and order-naming
  provenance unchanged.
- **Recurring is UNKNOWN with NO `resultingAmount`** — no committed recurring figure is
  established for this commit. (No unestablished candidate figure is carried either; the
  observed level is not this commit's number in any labeling.) The effect-level
  `committedSource` is `"unestablished"` — the committed effect as a whole is not an
  established set of actuals; the immediate dimension's own determinacy/provenance carry its
  narrower claim.
- **The observed state remains context**: the third-party-influenced post-commit state —
  including its recurring level — stays visible in the resulting snapshot and in the
  reconciliation reason, labeled unattributed.
- **The reconciliation matches the determinacy**: `undeterminedDimensions` is now
  `["recurringFinancialEffect"]` (was `[]`).
- The attributable branches are untouched: verified OK and D3 VIOLATED receipts keep their
  re-read-derived recurring figures as DETERMINED provider actuals — behind the unbroken
  chain, that state *is* this commit's own result (24.13, 24.19 attributable cases unchanged).

**Cancel-path audit:** `establishCancelCommit` was audited for the same pattern and is
**clean** — no change. Its unverified branches (re-read unavailable; bound order unreadable /
action-identity mismatch / broken chain) record only the shared `candidateEffect`: the
*quoted* post-cancellation level under UNKNOWN determinacy with `committedSource:
"unestablished"` and candidate provenance — never a figure sourced from the re-read state,
and never a zero asserted from an observed terminal state. Its one re-read-derived
DETERMINED figure (the D3 mismatch branch's observed recurring) is reachable only after the
Z2 attribution gate, which is precisely the attributable case Z3 preserves.

**Regressions** (test24; suite stays 286 — assertion-level reworks, no count change):

- 24.23 (**reworked, required**): the 130000-as-determined-actual expectation replaced by the
  Z3 discipline — recurring determinacy UNKNOWN, `resultingAmount` absent,
  `undeterminedDimensions` includes `recurringFinancialEffect`, committed source
  `unestablished`, and the observed 130000/quantity-130 asserted present ONLY in the
  resulting snapshot (context). The second case (intervening wrong rate plan) gained the
  same recurring assertions. Outcome assertions (COMMITTED_UNVERIFIED / UNVERIFIED) unchanged.
- 24.12 (**assertions added**): the matching-state chain break (check→mutate window). No
  prior 24.12 expectation asserted the committed recurring figure, so nothing was reversed;
  the test now pins that even the coincidentally matching observed level (the intended
  120000) is NOT recorded as this commit's determined actual — determinacy
  `{ immediate: DETERMINED, recurring: UNKNOWN }`, no `resultingAmount`, undetermined
  dimensions naming recurring. Its title/comment were narrowed accordingly ("figures still
  the bound order's" now refers to the immediate alone).

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

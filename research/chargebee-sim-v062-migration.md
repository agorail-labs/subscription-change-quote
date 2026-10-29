# Chargebee simulator migration to v0.6.2 (PR-6)

Scope: the SIMULATOR pair only — `reference/src/adapters/chargebee-sim.ts` and
`reference/src/adapters/chargebee-adapter.ts`, their tests, and this note. The
EXPERIMENTAL LIVE adapter under `reference/src/live/**` (including the pilot
harness, live-guard, and tests 21–23) is untouched and out of scope. Every
result in this migration is **SIMULATED_PASS**. The live-commit gate remains
**NO-GO** (see the Chargebee pilot record, `research/chargebee-pilot/`);
nothing here changes that, and this PR contains no live call of any kind.

Baseline: main `5ef572f`, fresh clean build **286/286**. After: **309/309**.
After the PR #15 review correction C1 (below): **313/313**.

## What was wrong (failing-first probes against main `5ef572f`)

Six probes were written against the pre-migration code first, each encoding
one defect as an assertion of the defective behavior. All six reproduced:

- **Probe A — per-change double-count, repeated quantity changes.** A
  proposal `[100→120, →150]` on one item quoted immediate **70000**: the
  adapter previewed each change separately against the ORIGINAL
  subscription and summed the per-change deltas (20000 + 50000). The
  correct single-request figure is 50000.
- **Probe B — per-change double-count, different items.** Changes on two
  items quoted immediate **55000** where the final combined state prices
  at 35000, for the same reason.
- **Probe C (F-2) — established zero re-encoded as absent.** A change
  whose established immediate is 0 produced `immediate === undefined`:
  the builder dropped a zero net into absence in every branch, and no
  determinacy record existed anywhere on the effect.
- **Probe D (F-1) — committedEffect was the revalidated preview.** With
  the sim landing a wrong quantity (130 vs the previewed 120), the
  receipt still reported committed recurring **120000** with
  reconciliation **OK** and no `committedSource`: the committed effect
  was assigned from the commit-time re-estimate, so post-commit
  reconciliation compared the quote against the estimate that gated the
  commit and could never detect a wrong landing.
- **Probe E — catalog-miss silent 0.** An existing subscription item
  whose `item_price_id` is missing from the modeled catalog contributed
  a silent 0 to the snapshot's recurring total (a partial sum presented
  as the level, with no determinacy label).
- **Probe F — invented cancellation fee quoted as established.** A
  committed-term CANCEL quoted the simulator's invented pro-rata
  early-termination formula as a plain figure (immediate net
  **1000000**), although the sim already carried an
  `earlyTerminationChargeKnown` determinacy signal the adapter never
  read.

## The migration

### One final request, one estimate (quote construction)

`createChangeQuote` now resolves the whole proposal against a coherent
EVOLVING item state (`resolveFinalItems`): each change applies to the
result of the previous ones, so a plan swap carries an earlier quantity
change's quantity, and unchanged items are carried through at their
current price/quantity. The resolved list becomes the single
`update_for_items` request; exactly ONE estimate of that exact request
is taken, and the whole quoted effect is derived from it. The stored
`provider_preview_input` is verbatim what commit dispatches — quoted
request == dispatched request by construction, asserted in test 25.1
against the persisted mutation artifact's recorded request.

### Determinacy and provenance (§3.10/§3.11 discipline)

Every quoted, revalidated, and committed effect now carries
`determinacy` and `provenance` under the same three-state discipline as
PRs #10/#11/#14:

- A finite estimate figure is DETERMINED — including an established 0,
  emitted as a present `{ net: 0 }`, never re-encoded as absent.
- A figure the estimate withholds is UNKNOWN with no figure emitted.
  The simulator now withholds a figure when ANY priced item (existing
  or requested) is missing from its modeled catalog — previously an
  existing catalog-miss item silently contributed 0 (probe E) while an
  unknown requested price threw; both wrong answers to the same gap are
  now the one honest answer: the figure is absent.
- The committed-term cancellation consequence is UNKNOWN by the sim's
  own signal: `previewCancel` now reports `earlyTerminationChargeKnown:
  false` for the committed-term/early case and retains the formula's
  output only as the clearly-labeled `earlyTerminationCharge`
  candidate. The adapter never quotes the candidate as a figure
  (probe F). Evergreen / settled cancellations quote an established
  `{ net: 0 }`.
- `immediate` is only the incurred obligation: the estimate's invoice
  line-item net for the exact final request. The model contains no
  amount-due, customer-balance, or next-invoice figure, and the
  adapter invents none (test 25.5 pins the estimate surface and the
  effect shape).
- Snapshots label the recurring total with CORE-7 determinacy
  (`recurringAmountState`): DETERMINED with the figure, or UNKNOWN
  with the figure withheld — never a partial sum (probe E).
- This adapter asserts NOT_APPLICABLE for no Chargebee dimension: the
  cancel estimate always either establishes the immediate amount or
  leaves it UNKNOWN, so the §3.10 license is never invoked here.

### Fail-closed commits (M2)

`assertEffectDeterminateForCommit` refuses the commit with
`QUOTE_NOT_DETERMINISTIC` whenever a required dimension of the QUOTED
or the REVALIDATED effect is not DETERMINED-with-a-finite-value,
before any mutating call (tests 25.4, 25.6, 25.16 prove zero mutation
artifacts and byte-identical state). This is the adapter-local guard
the Stripe/Paddle/Zuora migrations established; the frozen v0.6.1
envelope's absent→0 coercion is unchanged, and fail-closed treatment
inside the shared envelope remains BC-1, separately gated and NOT part
of this PR.

### Independent committed verification (M3) and the persisted mutation artifact

The simulator now persists a **mutation artifact** for every mutation:
operation id (`cbupd_…` for updates, `cbcxl_…` for cancels — the two
operations' identities are kept distinct), kind, the exact dispatched
request, the financial evidence computed AT EXECUTION (over the items
actually applied, so a misexecution's artifact records what the
execution produced while its `request` records what was asked), the
state fingerprints bracketing execution, and the resulting status.
Artifacts are retrievable by id (`retrieveMutation`) and enumerable
per subscription (`mutationsFor`).

The adapter's committed effect comes ONLY from the retrieved artifact
(bound by the id the mutation returned — never a latest-mutation
pointer) plus the re-read subscription state:

- committed immediate = the artifact's persisted line items / net,
  with provenance naming the artifact id;
- committed recurring = the strictly-priced sum over the re-read
  subscription, behind the attribution bracket (below);
- a mutation response or a preview alone is never sufficient — test
  25.7 corrupts the revalidation preview and the committed figures
  still come from the artifact.

### Attribution: the fingerprint bracket, and where it caps (Z1–Z3)

Chargebee has no native monotonic version like Zuora's, so attribution
rests on the artifact's **fingerprint bracket**: the state fingerprint
the operation observed when it began must equal the fingerprint the
commit validated, and the state fingerprint read back at verification
must equal the fingerprint the operation produced; the artifact's
recorded request must also canonically equal the dispatched request.

The fingerprint itself models the real API's `resource_version`
semantics (a millisecond timestamp that changes on EVERY write): the
sim mixes a per-subscription **write sequence** into the fingerprint
material, so a write that restores identical content still yields a
new fingerprint — "never touched" is distinguishable from "touched
and restored". The sequence is detection evidence only; it is not a
compare-and-swap precondition and nothing enforces it.

Per PR #14 doctrine:

- **Z1 — attribution precedes classification.** A state contradiction
  is a verified VIOLATED of this commit only behind a closed bracket
  (test 25.8: wrong quantity landing, committed immediate 30000 =
  the artifact's actual for the landing that occurred). Under a
  broken bracket the outcome is COMMITTED_UNVERIFIED whether the
  observed state contradicts (test 25.9) or coincidentally matches
  (test 25.10) the intent.
- **Z2 — the cancel path is gated identically.** The pre-migration
  cancel path carried the quoted effect through with no post-commit
  read at all. It now reads back the bound cancel artifact, checks
  kind + recorded `end_of_term` request, and requires the same
  bracket before any verdict. The scheduled-vs-immediate verdicts
  compare against the **QUOTED** effective date (P3): TERM_END
  verifies SCHEDULED (`non_renewing` with `scheduledCancellationAt`
  == the quoted date); a terminal landing is a premature-termination
  VIOLATED (test 25.17b). Verified cancels are
  `defined_equal_exact`, as the figures are protocol-defined.
- **Z3 — financial attribution follows the same rule.** On a broken
  bracket the committed recurring dimension is UNKNOWN with NO
  figure; the observed level survives only as unattributed context
  (resulting snapshot, reconciliation reason). The bound artifact's
  immediate stays — exactly the scope that operation establishes.
  The cancel path was audited for the same pattern and is clean: its
  unverified branches carry only the QUOTED candidate level under
  UNKNOWN determinacy, never a figure sourced from the re-read state.

### C1 correction (PR #15 review): the cancellation financial-evidence gate

The initial PR-6 cancel path verified the bound artifact's identity,
recorded request, fingerprint bracket, and the re-read subscription
state (status / scheduled date), then returned the quoted effect as
`defined_equal_exact` — without inspecting the artifact's financial
evidence. With the sim's `_debugOmitMutationFinancials` fault deleting
the artifact's `cancelNetImmediate`, a correct evergreen TERM_END
cancel still returned COMMITTED / COMMITTED_AND_VERIFIED / OK with a
DETERMINED immediate `{ net: 0 }` copied from the quote: financial
verification was claimed with no financial evidence. (Failing-first:
test 25.20 reproduced exactly that outcome on the pre-correction head;
test 25.22 showed an established artifact actual of 5000 being
reported as the quoted zero.)

The correction adds a financial-evidence gate inside
`establishCancelCommit`, evaluated after attribution is established
and before any financially verified outcome, entirely from the bound
artifact already read back — no further provider/simulator read
follows a landed mutation (P1):

- A financially verified cancellation requires the artifact's
  ESTABLISHED actual: `earlyTerminationChargeKnown === true` AND a
  finite `cancelNetImmediate` on the bound artifact.
- A figureless/unreadable-as-financial-evidence artifact, or an
  artifact whose `earlyTerminationChargeKnown !== true` at
  verification time (the mirrored committed-term edge: the artifact's
  own execution signal, not just the quote-time signal, must
  establish the consequence), caps the outcome at
  COMMITTED_UNVERIFIED / UNVERIFIED. The committed immediate is
  UNKNOWN with no determined figure; the quoted figure survives only
  as an unestablished candidate under `committedSource:
  "unestablished"`, and the reconciliation names
  `immediateFinancialEffect` among its undetermined dimensions.
  The known landing (the cancellation did execute and schedule) is
  retained in the reason and snapshot as context — only the
  financial verification is withheld.
- An established artifact actual that DIFFERS from the quoted
  figure is carried as the committed actual
  (`committedSource: "provider_actual"`) with a VIOLATED
  reconciliation — a determined negative verification (D3) — never
  reported as a verified quoted figure. The sim gained one sim-only
  hook, `_debugCancelNetImmediateOnNextCancel`, which makes the next
  cancel's execution establish an injected figure so this case is
  exercisable (test 25.22: quoted 0, artifact actual 5000, receipt
  carries 5000 / VIOLATED).
- A normal evergreen cancel whose artifact establishes the quoted
  figure stays COMMITTED_AND_VERIFIED / OK, still labeled
  `defined_equal_exact`, with its committed-immediate provenance now
  naming the bound artifact's establishing evidence (test 25.21;
  test 25.17a unchanged in outcome).
- The state-mismatch (D3) branch is behind the same gate, so its
  carried immediate is now always the artifact's established actual.

Regression tests (all in test25, no new file): 25.20 figureless
artifact → COMMITTED_UNVERIFIED, immediate UNKNOWN; 25.21 normal
evergreen cancel stays verified OK; 25.22 established differing
actual carried + VIOLATED; 25.23 artifact signal
`earlyTerminationChargeKnown !== true` at verification (figure
present on the read-back) → COMMITTED_UNVERIFIED.

### Outcome taxonomy

- Verified success: COMMITTED / COMMITTED_AND_VERIFIED.
- Attributable wrong landing: COMMITTED / COMMITTED_AND_VERIFIED with
  VIOLATED (D3).
- Broken attribution, unreadable/figureless artifact, or post-commit
  re-read failure: COMMITTED_UNVERIFIED with candidate figures built
  WITHOUT further provider reads (P1 — tests 25.11, 25.11b, 25.12).
- Lost mutation response: INDETERMINATE recorded, no receipt, and any
  later commit attempt on the quote refuses rather than blind-retry
  (test 25.13 — the operation landed exactly once).
- A rejection raised before any effect: CONFIRMED_NON_EXECUTION,
  recorded distinctly and retryable (test 25.14).
- §6.10 replay returns the ORIGINAL recorded receipt, including after
  a `verifyCommitReceipt` transition; the verified state is the
  store's separate current view (test 25.18, per the PR #8 R1
  correction).

### Chargebee-specific behavior preserved

- `update_for_items` and `cancel_for_items` remain SEPARATE
  operations with separate artifacts; CANCEL combined with any other
  change is refused (multi-change consistency UNSUPPORTED → refused
  at quote).
- Supported intents unchanged: IMMEDIATE for all actions; TERM_END
  for CANCEL only. DATE and update-backed TERM_END remain refused.
  The sim's `effectiveFrom` scheduling remains a simulator-only model
  and is never described as documented Chargebee endpoint behavior.
- Contract Terms remain OPTIONAL (absence = evergreen).
- No server-side CAS is claimed anywhere: consistencyGuarantee stays
  **BEST_EFFORT**, financial coverage stays REVALIDATE, termEffect
  stays UNKNOWN at the coarse level (evergreen-CANCEL quote-level
  EXACT on termEffect only, as before).

### Sim fault hooks added (sim-only, `_debug*`)

`_debugOmitPreviewImmediate`, `_debugOmitPreviewRecurring` (estimate
withholds a figure), `_debugOmitMutationFinancials` (artifact persists
figureless), `_debugFailMutationReads` (artifact read-back fails),
`_debugFailSubscriptionReadsAfterMutation` (post-landing read outage),
`_debugLoseNextMutationResponse` (apply + persist, then lose the
response), `_debugWrongQuantityOnNextUpdate`,
`_debugWrongItemPriceOnNextUpdate` (misexecution landings),
`_debugCancelImmediatelyOnNextCancel` (premature terminal landing),
`_debugCancelNetImmediateOnNextCancel` (C1: the next cancel's
execution establishes an injected immediate figure).

## Disclosed pre-existing test changes

Only `reference/tests/test11-chargebee.test.ts` changed, in two
places, each marked in-file:

- **11a** — the whole-effect `deepEqual(committedEffect,
  quotedEffect)` was replaced by figure+determinacy equality plus a
  `committedSource === "provider_actual"` assertion (the PR #10
  pattern). Under the migration the figures still agree at the same
  instant, but the committed provenance is now — correctly — the
  bound artifact's provider-actual provenance, not the estimate's;
  whole-object equality cannot hold for any correctly-implemented
  commit. The drift sub-scenario is unchanged and still yields
  QUOTE_DRIFTED with no mutation.
- **11j** — a strengthening ADDITION (no assertion changed or
  removed): the TOCTOU scenario previously asserted no receipt
  status. It now also asserts `COMMITTED_UNVERIFIED` /
  reconciliation `UNVERIFIED`, because the injected competing write
  lands inside the mutate window and breaks the fingerprint bracket
  (Z1) — where the pre-migration code, whose committed effect was
  the revalidated preview (F-1), would have reported COMMITTED/OK
  for the same race. The landing assertions (quantity 120,
  BEST_EFFORT) are unchanged.

No other pre-existing test changed. Files under `spec/`,
`reference/src/core/`, `reference/src/store/`, other adapters, and
`reference/src/live/**` are byte-identical to main `5ef572f`.

## Remaining limitations

- **Attribution is modeled, not native.** The fingerprint bracket is
  the strongest attribution evidence this provider model can
  honestly provide: artifact identity + request binding + a
  write-sensitive state fingerprint. It detects intervening writes
  (including content-restoring ones, via the write sequence), but it
  is not a provider-enforced precondition, and the sim's synchronous
  execution means nothing can interleave INSIDE one operation's
  execution window — the window a real concurrent API would expose
  between an operation's own before/after observations. Consistency
  remains BEST_EFFORT. Where the bracket does not close, outcomes
  cap at COMMITTED_UNVERIFIED by design.
- **Mid-flight states the sim cannot price stay UNKNOWN.** A
  subscription containing an item outside the modeled catalog cannot
  produce established recurring figures anywhere in this adapter
  (quote, snapshot, committed) — fail-closed, by design.
- **The simulator's proration and cancellation arithmetic remain
  simulator inventions** (fraction-of-term delta; the
  early-termination candidate formula). The migration makes their
  epistemic status explicit — established in-sim, candidate, or
  UNKNOWN — but validates nothing about the real API.
- **Deferred:** the experimental LIVE adapter's v0.6.2 migration
  (its post-commit financial uncertainty currently fails closed as
  INDETERMINATE with no receipt — pilot Defect 3 — until it can
  adopt this artifact model against real reads); the core
  state-verification hook generalization noted in PR #14 (the
  generic `establishVerification` path keys state by item identity,
  which Chargebee plan swaps do not preserve either — establishment
  here is adapter-level, as in PR #14); BC-1 core fail-closed
  envelope activation (separately gated); a durable store (the
  in-memory QuoteStore still cannot prove durable exactly-once, and
  no claim here says otherwise).

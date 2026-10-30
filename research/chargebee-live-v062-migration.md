# Chargebee LIVE adapter — v0.6.2 migration note (PR-7)

Parent issues: #7 (v0.6.2 design), #12 (Chargebee pilot). Branch
`v062/pr-7-chargebee-live-migration` from main `c2f0031` (post-PR-#15;
clean baseline 313/313).

This PR migrates the **experimental Chargebee-live adapter**
(`reference/src/live/chargebee-scq-adapter.ts`) to the v0.6.2
semantics already merged for the core (PR #8/#9) and the Stripe
(PR #10), Paddle (PR #11), Zuora (PR #14), and Chargebee-simulator
(PR #15) adapters: three-state determinacy with field-level
provenance, the four-class commit-outcome taxonomy, committed
effects established only from post-commit actuals, attribution
before classification (PR #14 Z1–Z3), and §6.10 original-receipt
replay.

**Evidence discipline.** Every result in this note is from mocked
transports. No real Chargebee call of any kind was made; no
credentials exist in the environment; `SCQ_LIVE_COMMIT_ENABLED` was
never set. All classifications herein are `SIMULATED_PASS` at best.
The Oct 27, 2026 real-world read/estimate evidence (L-GET/L-QUOTE
`LIVE_PASS`) is untouched history and is not reclassified by this
PR. The pilot harness, live-guard, and mock transport are
**unmodified** — no pilot-safeguard change proved necessary, so none
was made.

## What changed (adapter only)

- **Quotes** now carry v0.6.2 determinacy (`DETERMINED`/`UNKNOWN`;
  this adapter never asserts `NOT_APPLICABLE`) and field-level
  provenance for both financial dimensions, on the quote and on the
  commit-time revalidation. An established zero stays present as a
  zero. Absent/partial/unsupported figures are `UNKNOWN`, and quote
  creation **and** commit-time revalidation refuse
  (`QUOTE_NOT_DETERMINISTIC`) when a required dimension is UNKNOWN —
  the adapter-level M2 fail-closed posture, since BC-1 is not yet
  active in the frozen core.
- **Strict pricing everywhere.** Recurring figures come only from
  provider-stated per-item amounts or the justified per-item
  computation (per_unit × quantity; flat_fee at quantity 1). The
  snapshot path's old fallback — reconstructing a missing amount as
  `unit_price × quantity`, and pricing an absent item collection as
  0 — is removed: snapshots now omit the figure and label
  `billing.recurringAmountState: "UNKNOWN"` (snapshot determinacy,
  CORE-7).
- **Commit establishment** is rebuilt around three distinct
  surfaces (matrix below): the pre-mutation estimate is never a
  committed source; the mutation response supplies this operation's
  immediate actual and anchors the attribution bracket; an
  independent post-mutation re-read supplies the landed item set
  and the recurring actual. The bracket is the client-computed
  fingerprint (resource_version + item set) of the response's
  subscription vs the re-read's: equality closes attribution,
  movement is intervening-change **detection** — never presented as
  provider CAS or durable operation identity.
- **Outcomes.** `COMMITTED_AND_VERIFIED` (OK or VIOLATED over
  established actuals), `COMMITTED_UNVERIFIED` (typed receipt;
  protocol Defect 3 closed for this adapter), `INDETERMINATE`
  (thrown, outcome recorded in the store, **no receipt**, and a
  recorded INDETERMINATE refuses any later dispatch for that quote
  before reads or mutations — no blind retry), and
  `CONFIRMED_NON_EXECUTION` (restricted to demonstrable pre-effect
  refusals — an HTTP 400 carrying a specifically allowlisted
  documented validation `api_error_code`; status 400 alone is not
  proof — recorded as outcomes; see the L2/L3 review corrections
  below).
  Candidates follow the merged PR #10/#11 construction:
  present in the committed effect under UNKNOWN determinacy with
  `committedSource: "unestablished"` provenance, so a later
  identity-bound verification has a record to verify against.
- **Preserved safeguards:** BEST_EFFORT only; REVALIDATE coverage
  (no EXACT); existing intent restrictions; unsupported
  pricing-model rejection; flat-fee quantity refusal before any
  estimate; full item-list replacement; mandatory-addon and
  scheduled-change handling; deterministic idempotency keys; native
  idempotency semantics (30-minute window, 422-on-conflict,
  cached-error replay); the disabled-by-default live-commit gate.

## Evidence provenance matrix

Which surface establishes which fact. "—" means the surface is
never used for that fact.

| Fact | Pre-mutation estimate | Mutation response | Post-mutation re-read (fresh GET) |
|---|---|---|---|
| Quoted immediate (incurred) | **Yes** — sum of `unbilled_charge_estimates[].amount` − `credit_note_estimates[].total` | — | — |
| Quoted recurring | **Yes** — stated `subscription_estimate` item amounts verified complete against the intended set; else the justified per-item computation, labeled as computed | — | — |
| Next-invoice projection (`total`, `amount_due` net of credits/balance) | Metadata only — never mapped into any effect | — | — |
| Committed immediate actual | — (never reused) | **Yes** — response `invoice.total`, else the complete sum of response `unbilled_charges`; determined zero stays present | — (no operation-level financial read-back exists; see below) |
| Committed recurring actual | — | Candidates only (when the re-read is unavailable) | **Yes** — strict sum of the re-read items' stated amounts |
| Landed item set (ids + quantities) | — | Response subscription anchors the bracket | **Yes** — verified complete against the intended set |
| Attribution (this commit vs an intervening writer) | — | Bracket anchor (fingerprint of the response subscription) | Bracket close (fingerprint equality with the re-read) |
| Landing known at all (lost-response case) | — | Absent by definition | **Never establishes landing by this request** (review L1): intended set in effect is observationally equivalent to an independent actor's identical write ⇒ INDETERMINATE, observed state retained as diagnostic context only |
| Pre-dispatch state / staleness | — | — | The validation read (resource_version precondition) |

## Failing-first evidence (pre-migration probes)

Probes run against the un-migrated adapter on the pilot mocked
transport, proposal `CHANGE_QUANTITY pilot-addon-vision 1 → 21`:

| Probe | Scenario | Pre-migration behavior |
|---|---|---|
| P1 | Update response with no financials (`incompleteUpdateResponse`) | Threw INDETERMINATE; **no receipt, no outcome record** (Defect 3) |
| P2 | Update response lost, change landed (`loseUpdateResponse`) | Threw INDETERMINATE; no receipt, no outcome record (Defect 3) |
| P3 | Provider attaches mandatory addon on update | Threw INDETERMINATE; no receipt |
| P4 | Provider silently ignores the update | Threw INDETERMINATE; no outcome record either |
| P5 | Quote shape | No determinacy, no provenance on any effect (next-invoice leakage: **not present** — incurred already sourced from unbilled charges; next-invoice confined to metadata) |
| P6 | Snapshot with an item amount stripped / items member absent | Recurring **fabricated** as `unit_price × quantity`; absent member priced as 0 |
| P7 | No-op commit (determined zero immediate) | Committed zero **re-encoded as absent** on the receipt |
| — | Estimate reused as committedEffect | **Not present** (displaced in PR #4; test13-rec4 already pinned actuals-only) |

## Before / after outcome classification

| Scenario | Before | After (PR-7) |
|---|---|---|
| Landed, response without financials | INDETERMINATE, no receipt | `COMMITTED_UNVERIFIED` receipt; recurring established from re-read, immediate UNKNOWN (test21-c8, test26.10a) |
| Lost response, intended set in effect | INDETERMINATE, no receipt | INDETERMINATE, **outcome recorded** with the observed state as diagnostic context; no receipt — matching state does not establish that THIS request landed (review L1; test21-c6, test13-rec2, test13-T07, test26.12, equivalence case test26.12b) |
| Lost response, landing unestablishable | INDETERMINATE, no record | INDETERMINATE, **outcome recorded**; retry refused pre-dispatch (test26.11, test26.15d) |
| Provider silently ignores a dispatched update | INDETERMINATE, no record | INDETERMINATE with outcome record (response claims success the unchanged state contradicts) |
| Mandatory addon attached by provider | INDETERMINATE, no receipt | `COMMITTED_AND_VERIFIED` + VIOLATED receipt over the presented actuals (83400 incl. the addon's stated 2500) (test21-c9, test13-rec9 pattern) |
| Wrong quantity landed, attribution closed | INDETERMINATE, no receipt | VIOLATED receipt with actual figures (test13-rec8, test26.9) |
| Re-read omits items after landing | INDETERMINATE, no receipt | `COMMITTED_UNVERIFIED`; immediate established from response, recurring UNKNOWN — never a verified zero (test13-rec5) |
| Re-read unavailable after response received | INDETERMINATE, no receipt | `COMMITTED_UNVERIFIED` with candidate figures (UNKNOWN determinacy); §6.10 replay + later identity-bound verification (test26.17) |
| Intervening write (incl. round-trip restore) | n/a (misclassified or indeterminate) | `COMMITTED_UNVERIFIED`; no recurring figure recorded for this commit (Z3); response immediate survives (test26.14a/b) |
| Definitive pre-effect rejection (HTTP 400 with an allowlisted validation `api_error_code`) | Generic provider error | `CONFIRMED_NON_EXECUTION` recorded; does not block a later attempt (test26.16, positive control) |
| Ambiguous dispatch failure (408 timeout / 429 rate-limit / 422 idempotency conflict / unclassified 4xx / 400 without an allowlisted validation code — payment-stage, unknown, or missing `api_error_code`) | Generic provider error (as first delivered: blanket 4xx ⇒ CONFIRMED_NON_EXECUTION; after L2: any 400 ⇒ CONFIRMED_NON_EXECUTION) | INDETERMINATE, outcome recorded, re-dispatch blocked pending reconciliation (reviews L2/L3; test26.15b, test26.15e, test26.15f, test26.16b, test26.16c) |
| Committed determined zero | Absent | Present, DETERMINED (test26.1a) |
| Quote / revalidation determinacy | Absent; drift checked without determinacy | Three-state + provenance; UNKNOWN refuses pre-mutation (test26.1b, 26.2, 26.8) |

## Regression matrix

New file `reference/tests/test26-chargebee-live-v062-migration.test.ts`
(38 tests) covers all 20 assignment rows through mocked transports
with a dispatch audit: rows 1 (26.1a/b), 2 (26.2), 3 (26.3a/b),
4 (26.4a/b), 5 (26.5), 6 (26.6, incl. the amount_due == incurred
coincidence), 7 (26.7a/b), 8 (26.8), 9 (26.9), 10 (26.10a/b/c),
11 (26.11: lost dispatch, landing unknown ⇒ INDETERMINATE),
12 (26.12 + 26.12b: lost response with matching state ⇒
INDETERMINATE — attribution unresolved, observational-equivalence
regression, review L1), 13 (26.13), 14 (26.14a/b), 15 (26.15a–f:
concurrent-dispatch native replay, 422 preexisting-key conflict ⇒
INDETERMINATE, post-window reprocessing hazard, evidence-free 200,
408 ⇒ INDETERMINATE, ambiguous 429 ⇒ INDETERMINATE — review L2),
16 (26.16: HTTP 400 with the allowlisted validation code
`param_wrong_value` ⇒ CONFIRMED_NON_EXECUTION, later attempt
unblocked — positive control; 26.16b: payment-stage 400
`payment_processing_failed` ⇒ INDETERMINATE; 26.16c: 400 with a
missing `api_error_code` ⇒ INDETERMINATE — review L3), 17 (26.17),
18 (26.18), 19 (26.19a/b/c), 20 (26.20 + the unmodified pilot
suites), audit (26.21: audited dispatches == mocked-transport
calls; exactly one mutating dispatch in a quote+commit+replay
flow).

## Disclosed changes to pre-existing tests

Every changed assertion is also marked in-file with a
`DISCLOSED CHANGE (PR-7, v0.6.2)` note. 303 of 313 pre-existing
tests pass **unmodified**; 10 were updated, all of them
classification updates of the kind the v0.6.2 migration exists to
make (figures and scenarios preserved):

- `test13-chargebee-http.test.ts` (7): the PR #4 "Fix 2" section
  preamble (supersession note); T03 (whole-effect deep-equality →
  figure + determinacy + `provider_actual` source assertions —
  figures identical); T07 (lost response → INDETERMINATE with the
  outcome recorded and blind retry refused; PR-7 as first
  delivered asserted COMMITTED_UNVERIFIED here — flipped back by
  review correction L1, see below); rec1 (re-read failure
  → candidate-bearing COMMITTED_UNVERIFIED); rec2 (lost response +
  amount-stripped re-read → INDETERMINATE, outcome recorded, no
  receipt; likewise flipped by L1 from PR-7's first-delivered
  COMMITTED_UNVERIFIED); rec5
  (items omitted → COMMITTED_UNVERIFIED, recurring UNKNOWN, never
  verified zero); rec8 (quantity mismatch → VIOLATED over actuals);
  rec9 (mandatory addon → VIOLATED over actuals).
- `test21-chargebee-pilot.test.ts` (3): c6 (lost response →
  INDETERMINATE, outcome recorded, no receipt, retry refused;
  flipped by L1 from PR-7's first-delivered COMMITTED_UNVERIFIED);
  c8 (the Defect-3 case its own
  note pre-declared would change → COMMITTED_UNVERIFIED typed
  receipt, recurring DETERMINED 80900, immediate UNKNOWN); c9
  (mandatory addon → attributable VIOLATED receipt, recurring
  83400).
- `test22` (oracle) and `test23` (live-guard): **unmodified**.

## Review corrections L1 / L2 (2026-10-29, at head after `afc2a18`)

The independent review of PR-7 as first delivered (`afc2a18`)
accepted the successful-response migration but blocked merge on
two classification corrections. Both are implemented in the
adapter, with failing-first evidence: the new/changed tests were
run against `afc2a18` first and exactly the 8 targeted tests failed
(26.12, 26.12b, 26.15b, 26.15e, 26.15f, 21-c6, 13-rec2, 13-T07) —
26.12b's commit *resolved* with the buggy COMMITTED_UNVERIFIED
receipt, and 408/429/422 recorded the buggy
CONFIRMED_NON_EXECUTION.

- **L1 — lost-response attribution.** A changed subscription
  matching the intended result does not establish that THIS
  request caused the change. The unknown-dispatch reconciliation
  no longer converts a matching re-read into a committed receipt:
  with no successful response and no independently bound
  operation-level execution evidence, lost-response outcomes are
  INDETERMINATE — outcome persisted with the observed state as
  diagnostic context, NO committed receipt, blind retry refused.
  **No operation-bound provider landing signal was identified**:
  Chargebee's validated surface for this adapter offers no
  per-operation read-back artifact, no operation identity on the
  subscription resource, and `resource_version` is a millisecond
  timestamp that any writer advances; an idempotency key sent with
  a lost request does not establish execution. The
  response-received / response-lost line: COMMITTED_UNVERIFIED is
  retained ONLY where a response was received — the successful-
  response financially-unverified cases (test21-c8, 26.10, 26.17,
  test13-rec1/rec5). A native idempotency REPLAY returns the
  original operation's own response and therefore counts as
  response-received (26.15a stays verified-eligible); a lost
  dispatch, a 409, a 5xx, and every L2 ambiguity below are
  response-lost / execution-unestablished.
- **L2 — non-execution classification.** CONFIRMED_NON_EXECUTION
  is restricted to demonstrable pre-effect failures. (As first
  corrected, this bullet named an explicit provider validation
  rejection — HTTP 400 — as the criterion; the L3 correction below
  narrows that further to the code-based rule now in force: HTTP
  400 carrying a specifically allowlisted documented validation
  `api_error_code`, which carries no prior-operation ambiguity.
  26.16 remains the positive control, and a later attempt is not
  blocked.) HTTP 408, ambiguous 429,
  unclassified 4xx, and 422 `duplicate_request` classify as
  INDETERMINATE with the no-blind-retry guard: a 422 conflict
  establishes rejection of the CURRENT attempt only — the key may
  already belong to a prior processed request with different
  parameters that DID execute (26.15b) — so re-dispatch for that
  quote is blocked pending reconciliation, in the same spirit as
  the recorded-INDETERMINATE dispatch refusal.

## Review correction L3 (2026-10-29, at head after `c339d91`)

The re-review of the L1/L2 round (`c339d91`) accepted L1 and the
remaining L2 corrections but blocked merge on one residual: the
mutation catch branch classified by status alone — every
HTTP 400 recorded CONFIRMED_NON_EXECUTION — while its own comment
called the branch an "explicit validation rejection" without the
code ever inspecting `apiErrorCode`. Chargebee's official
error-handling documentation assigns HTTP 400 to payment and
operation-stage failures as well (`payment_processing_failed`,
`payment_method_verification_failed`, `payment_intent_invalid` —
type `payment`), and those responses do not, by status code alone,
establish that no subscription or ancillary financial effect
occurred.

- **Code-based rule.** CONFIRMED_NON_EXECUTION now requires BOTH
  HTTP 400 AND an `api_error_code` on the narrow allowlist
  `PRE_EFFECT_VALIDATION_ERROR_CODES` in the adapter:
  `param_wrong_value` only. Documentary basis
  (Chargebee error-handling documentation,
  apidocs.chargebee.com/docs/api/error-handling): this code is
  grouped under "Invalid Request Errors" (type `invalid_request`,
  HTTP 400) — a parameter value not meeting its required
  specification — and the documentation
  states that API calls fail at the first error encountered while
  VALIDATING them, i.e. before the operation is processed. Both
  code describes invalid request parameters, so it carries
  no prior idempotency-key ambiguity (a consumed key
  reused with a different payload surfaces as HTTP 422, not as one
  this code).
- **Fail closed.** A 400 carrying a payment-stage code
  (`payment_processing_failed`, `payment_method_verification_failed`,
  `payment_intent_invalid`, and the other payment-type codes), the
  generic `invalid_request` code (documented as generic; handling
  recommended only in combination with `param`), a
  state/configuration-dependent code (`duplicate_entry`,
  `resource_limit_exhausted`, `resource_limit_exceeded`,
  `configuration_incompatible`), any unknown code, or NO code at
  all classifies INDETERMINATE — outcome recorded, no receipt, no
  blind retry — absent independent proof of no effect.
- **Regressions.** Failing-first on `c339d91`: the two new tests
  failed (both recorded the buggy CONFIRMED_NON_EXECUTION) while
  the reworked positive control passed on both heads, as a control
  should. New: 26.16b (payment-stage 400 `payment_processing_failed`
  ⇒ INDETERMINATE, re-dispatch blocked), 26.16c (400 with a missing
  `api_error_code` ⇒ INDETERMINATE, re-dispatch blocked). Reworked:
  26.16's mocked error now carries the allowlisted
  `param_wrong_value` instead of the generic `invalid_request`
  code (disclosed in-file); its CONFIRMED_NON_EXECUTION and
  later-attempt-unblocked assertions are unchanged. The L2 tests
  26.15b (422), 26.15e (408), and 26.15f (429) pass unchanged.
- **Minor L1 cleanup.** The thrown INDETERMINATE errors from
  `reconcileAfterUnknownDispatch` carried a detail key
  `intendedItemsLanded`, while the persisted outcome record
  correctly names the same observation `observedIntendedSetInEffect`.
  The thrown-error detail is renamed to
  `observedIntendedSetInEffect` in both branches, so no consumer
  can mistake an observed state for a proven landing. A grep over
  the adapter, HTTP layer, tests, and pilot found no other
  producer or consumer of the old key; no test assertions
  referenced it.

## Outcomes that remain UNVERIFIABLE through the real Chargebee API

1. **Whether a mutation whose response was lost landed at all —
   and, a fortiori, its incurred financial result.** Chargebee
   exposes no operation-level read-back bound to an
   `update_for_items` call (no per-operation invoice/charge
   retrieval keyed to the mutation, no operation identity on the
   subscription). A later state read shows subscription state, not
   who caused it or the proration actually incurred. Such commits
   are INDETERMINATE (review L1) — not merely unverified: no
   operation-bound provider landing signal exists to upgrade them.
2. **Exclusive attribution of a landed state to this commit.**
   `resource_version` is a millisecond timestamp, not a CAS token
   or operation identity. Writes inside the same millisecond, and
   write-and-restore round trips within the resolution, are
   invisible to the fingerprint bracket. The bracket *detects*
   intervening change; it cannot prove none occurred.
3. **The validate→dispatch window.** A write landing between the
   final validation read and the dispatch is visible only through
   the post-commit bracket, subject to the same resolution limits.
4. **Promotion of a figure-less UNVERIFIED receipt by later figures
   alone.** The store's verification is identity-bound: later
   evidence figures must equal the recorded receipt's identity
   figures. A receipt that records no figures (null identity)
   cannot be promoted by later figures — it requires manual
   reconciliation (or a future core state-verification hook).
   Candidate-bearing receipts (response received) *can* be
   promoted, and test26.17 proves that path. (Lost-response
   attempts record no receipt at all after L1 — item 1.)
5. **A simulator-style per-operation mutation artifact.** The
   Chargebee API has no persisted per-operation record carrying
   execution financials + a state bracket (the simulator's
   `cbupd_` artifact is a fixture affordance). None was invented
   for the live path; the response + re-read surfaces above are
   all the live path honestly has.

## Remaining blockers for a controlled test-site commit

From the pilot's NO-GO conditions (issue #12):

1. v0.6.2 Chargebee migration — **done for the live adapter by
   this PR** (simulator: PR #15), subject to review.
2. Durable store + restart test — **open**. The in-memory
   QuoteStore loses quotes, receipts, and outcome records on
   restart; test26.18 pins the honest behavior (stale-quote
   refusal, no fabricated recovery, no re-mutation), which is a
   limitation statement, not a fix.
3. Executed preflight for the exact commit — **open**.
4. Named reconciliation owner — **open**.
5. Separate authorization for any live mutation — **open**; none
   was given or used for this PR.

## Verification (this branch)

- Clean build (`rm -rf dist`): **351/351** tests pass (baseline
  313 + 38 new; includes the L1/L2 review-correction round: +3
  tests — 26.12b, 26.15e, 26.15f — and 5 flipped expectations
  across test26/test21/test13, each disclosed in-file; and the L3
  review-correction round: +2 tests — 26.16b, 26.16c — plus the
  disclosed 26.16 mocked-error-code change). The 10
  pre-migration failures observed mid-work were exactly the 10
  tests carrying disclosed updates.
- `npm run smoke:pack`: OK. `npm run demo`: OK.
  `npm run demo:commit`: OK.
- Provider-neutrality check (workflow grep): OK — core untouched.
- Freeze guard: `git diff` vs main over `spec/scq-v0.6.1-spec.md`,
  `spec/scq-v0.6.2-spec.md`, `reference/src/core/types.ts`,
  `reference/src/core/scq-engine.ts` is **empty**.
- Pilot mocked harness (`npm run pilot:chargebee`): unchanged —
  quote 20000 / 80900 / 60900, comparison 6/6, classifications
  SIMULATED_PASS / SIMULATED_PASS / SIMULATED_PASS / BLOCKED /
  DOCUMENTATION_SUPPORTED, 0 mutating calls.
- Full diff scope vs main: `reference/src/live/chargebee-scq-adapter.ts`,
  `reference/tests/test13-chargebee-http.test.ts`,
  `reference/tests/test21-chargebee-pilot.test.ts`,
  `reference/tests/test26-chargebee-live-v062-migration.test.ts` (new),
  this note. No spec, core, store, simulator-adapter, or pilot
  changes.

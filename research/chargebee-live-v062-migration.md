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
  `CONFIRMED_NON_EXECUTION` (definitive pre-effect provider
  refusals — HTTP 400, and 422 `duplicate_request` — recorded as
  outcomes). Candidates follow the merged PR #10/#11 construction:
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
| Landing known at all (lost-response case) | — | Absent by definition | Intended set in effect after a lost response ⇒ known landed, **unverified** (financials and exclusive attribution unproven) |
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
| Lost response, intended set in effect | INDETERMINATE, no receipt | `COMMITTED_UNVERIFIED`, no figures recorded; state retained as snapshot context only (test21-c6, test13-rec2, test26.12) |
| Lost response, landing unestablishable | INDETERMINATE, no record | INDETERMINATE, **outcome recorded**; retry refused pre-dispatch (test26.11, test26.15d) |
| Provider silently ignores a dispatched update | INDETERMINATE, no record | INDETERMINATE with outcome record (response claims success the unchanged state contradicts) |
| Mandatory addon attached by provider | INDETERMINATE, no receipt | `COMMITTED_AND_VERIFIED` + VIOLATED receipt over the presented actuals (83400 incl. the addon's stated 2500) (test21-c9, test13-rec9 pattern) |
| Wrong quantity landed, attribution closed | INDETERMINATE, no receipt | VIOLATED receipt with actual figures (test13-rec8, test26.9) |
| Re-read omits items after landing | INDETERMINATE, no receipt | `COMMITTED_UNVERIFIED`; immediate established from response, recurring UNKNOWN — never a verified zero (test13-rec5) |
| Re-read unavailable after response received | INDETERMINATE, no receipt | `COMMITTED_UNVERIFIED` with candidate figures (UNKNOWN determinacy); §6.10 replay + later identity-bound verification (test26.17) |
| Intervening write (incl. round-trip restore) | n/a (misclassified or indeterminate) | `COMMITTED_UNVERIFIED`; no recurring figure recorded for this commit (Z3); response immediate survives (test26.14a/b) |
| Definitive pre-effect rejection (400 / 422 conflict) | Generic provider error | `CONFIRMED_NON_EXECUTION` recorded; does not block a later attempt (test26.15b, test26.16) |
| Committed determined zero | Absent | Present, DETERMINED (test26.1a) |
| Quote / revalidation determinacy | Absent; drift checked without determinacy | Three-state + provenance; UNKNOWN refuses pre-mutation (test26.1b, 26.2, 26.8) |

## Regression matrix

New file `reference/tests/test26-chargebee-live-v062-migration.test.ts`
(33 tests) covers all 20 assignment rows through mocked transports
with a dispatch audit: rows 1 (26.1a/b), 2 (26.2), 3 (26.3a/b),
4 (26.4a/b), 5 (26.5), 6 (26.6, incl. the amount_due == incurred
coincidence), 7 (26.7a/b), 8 (26.8), 9 (26.9), 10 (26.10a/b/c),
11 (26.11), 12 (26.12), 13 (26.13), 14 (26.14a/b), 15 (26.15a–d:
concurrent-dispatch native replay, 422 conflict, post-window
reprocessing hazard, evidence-free 200), 16 (26.16), 17 (26.17),
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
  figures identical); T07 (lost-response INDETERMINATE →
  COMMITTED_UNVERIFIED + §6.10 replay of it); rec1 (re-read failure
  → candidate-bearing COMMITTED_UNVERIFIED); rec2 (lost response +
  amount-stripped re-read → COMMITTED_UNVERIFIED, no figures,
  never OK); rec5
  (items omitted → COMMITTED_UNVERIFIED, recurring UNKNOWN, never
  verified zero); rec8 (quantity mismatch → VIOLATED over actuals);
  rec9 (mandatory addon → VIOLATED over actuals).
- `test21-chargebee-pilot.test.ts` (3): c6 (lost response →
  COMMITTED_UNVERIFIED, no figures); c8 (the Defect-3 case its own
  note pre-declared would change → COMMITTED_UNVERIFIED typed
  receipt, recurring DETERMINED 80900, immediate UNKNOWN); c9
  (mandatory addon → attributable VIOLATED receipt, recurring
  83400).
- `test22` (oracle) and `test23` (live-guard): **unmodified**.

## Outcomes that remain UNVERIFIABLE through the real Chargebee API

1. **The incurred financial result of a mutation whose response was
   lost.** Chargebee exposes no operation-level financial read-back
   bound to an `update_for_items` call (no per-operation
   invoice/charge retrieval keyed to the mutation). A later state
   read shows subscription state, not the proration actually
   incurred. Such commits cap at `COMMITTED_UNVERIFIED`.
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
   figures. A lost-response receipt records no figures (null
   identity), so later figures cannot promote it — it requires
   manual reconciliation (or a future core state-verification
   hook). Candidate-bearing receipts (case 1's sibling, response
   received) *can* be promoted, and test26.17 proves that path.
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

- Clean build (`rm -rf dist`): **346/346** tests pass (baseline
  313 + 33 new). The 10 pre-migration failures observed mid-work
  were exactly the 10 tests carrying disclosed updates.
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

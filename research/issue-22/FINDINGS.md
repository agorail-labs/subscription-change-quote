# Issue #22 — Independent reproduction findings (PR-13)

**Scope.** Independent local reruns of Fabio's external review (Discussion #2,
reported by him against `main` at `963be0b`, simulators/mocks only) against
**current main `6f56b05a2dd42b48b44a0b3014332d9c737e23cb`** (baseline suite
612/612). All evidence here is **SIMULATED** (injected mocked transports /
in-memory simulators / engine calls). No live Chargebee call was made, no
credential was used, `SCQ_LIVE_COMMIT_ENABLED` was never set, and nothing in
this document claims a real Chargebee defect: the provider behaviors exercised
(full-list replacement semantics) are Chargebee's *documented* semantics — see
`CHARGEBEE-CAPABILITY-ASSESSMENT.md`.

**Method.** Each finding has a new failing-first regression file asserting the
SAFE behavior. Defect tests are **expected to fail on unmodified main**; the
failure is the reproduction. Controls in the same files pass and bound each
defect. Nothing in the implementation was changed.

**Suite accounting (after the PR #23 review corrections, REVIEW-1).** The
four reproduction files are a separately invoked RESEARCH suite
(`reference/tests/repro43–46-*.repro.ts`), deliberately outside the default
test discovery. The **default suite is 612/612 GREEN** (`npm test`, which
discovers only `dist/tests/*.test.js`). The research suite is run explicitly
after a build:

```
node --test dist/tests/*.repro.js
```

and reports **18 tests: 13 fail, 5 pass** — the 13 failures are exactly the
defect-demonstrating tests listed below; every control passes, and every
pre-existing test still passes in the default suite. (As first delivered,
the repro files were named `*.test.ts` and ran inside the default suite —
630 tests, 617 pass, 13 fail. REVIEW-1 isolated them so ordinary CI is
green while the failing-first evidence remains one explicit command away;
no assertion was changed by the isolation. Verbatim research-suite output
is preserved under `evidence/`.)

| # | Finding | Verdict | Defect tests (fail on main) | Controls (pass) |
|---|---|---|---|---|
| 1 | Authorization-preserving execution (P0) | **CONFIRMED** | 43.1 | 43.2, 43.3 |
| 2 | Runtime proposal validation | **CONFIRMED** | 44.1–44.5 | 44.6 |
| 3 | Operation/subscription identity binding | **CONFIRMED** | 45.1 | 45.2 |
| 4 | Currency & cadence comparability | **CONFIRMED** | 45.3–45.5 | 45.6 |
| 5 | Receipt verification / verified view | **CONFIRMED** (a, b, c) | 46.1–46.3 | immutability controls inside 46.2/46.3 |
| 6 | Envelope nomenclature | Disposition only (substantiated by inspection) | — | — |
| 7 | Adapter verification & recovery evidence | Disposition only (see below) | — | — |

---

## Finding 1 (P0) — Target-state verification does not imply authorization-preserving execution — **CONFIRMED**

**Fabio's claim.** Quote `pilot-addon-vision` 1→21 against a mocked Chargebee;
a third party adds an unrelated addon after the final pre-commit read; SCQ
dispatches a full `replace_items_list=true` update built against the stale
list; the unrelated addon disappears; the post-commit state matches the old
intended full item list, so the receipt reports `COMMITTED_AND_VERIFIED` /
reconciliation `OK`. (The local fixture names the added item
`pilot-addon-concurrent` — renamed from `pilot-addon-mandatory` in the
PR #23 review corrections, REVIEW-3; see the naming note at the end of
this finding.)

**Reproduction.** `reference/tests/repro43-authorization.repro.ts`,
test 43.1: the Chargebee-live adapter over a self-contained scripted mocked
transport (modeled on the pilot fixture's wire shapes). The scripted
third-party write lands on the commit-phase revalidation estimate — i.e.
strictly **after** the adapter's final pre-commit subscription GET and
fingerprint validation, **before** dispatch (wire-log ordering asserted in the
test). Full output: `evidence/repro43-failing-output.txt`.

**Captured evidence (verbatim from the failing run).**

(a) *Authorized change set* — the only authorized change:
`CHANGE_QUANTITY pilot-addon-vision 1 -> 21`.

(b) *Concurrent mutation* — third party adds `pilot-addon-concurrent x1`
(flat_fee, 2500) after the final pre-commit read/validation, before dispatch.
State after the add, before dispatch:
`[pilot-plan-business x1, pilot-addon-vision x1, pilot-addon-concurrent x1]`.

(c) *Exact dispatched Chargebee request* —
`POST /subscriptions/{subscriptionId}/update_for_items` with
`replace_items_list=true`, `prorate=true`, `invoice_immediately=false`,
`change_option=immediately`, and exactly two items
(`pilot-plan-business x1`, `pilot-addon-vision x21`). Raw body:

```
subscription_items%5Bitem_price_id%5D%5B0%5D=pilot-plan-business&subscription_items%5Bitem_price_id%5D%5B1%5D=pilot-addon-vision&subscription_items%5Bquantity%5D%5B0%5D=1&subscription_items%5Bquantity%5D%5B1%5D=21&replace_items_list=true&prorate=true&invoice_immediately=false&change_option=immediately
```

(d) *Resulting subscription state* — `[pilot-plan-business, pilot-addon-vision]`.
**`pilot-addon-concurrent` is gone**: deleted by the replacement although it was
never part of the authorized change.

(e) *Receipt* — `status: COMMITTED`, `outcome: COMMITTED_AND_VERIFIED`,
`reconciliation: { status: "OK" }`, committed immediate net 20000, committed
recurring 80900, resulting snapshot items `[pilot-plan-business,
pilot-addon-vision]`.

**Determination.** Yes — on current main, SCQ returns
**COMMITTED_AND_VERIFIED / reconciliation OK** for an execution that deleted
an unauthorized, concurrently added item. The deletion is invisible to every
check the adapter runs, because every check compares against the *intended
target set derived from the stale snapshot*, never against the *pre-dispatch
baseline plus authorized delta*.

**Code path (file/line, current main).**

- The dispatched list is the **quote-time** stored input, not a re-derived
  list: `commitChangeQuote` dispatches `this.updateParams(input.items)` where
  `input = stored0.provider_preview_input`
  (`reference/src/live/chargebee-scq-adapter.ts`, dispatch at L1170).
- `buildChargebeeUpdateParams` (L873–897) always sends
  `replace_items_list: true` (L889) with the full intended list.
- The only pre-dispatch freshness check is against the **last read**:
  `readSubscription` + `validateCommit(... chargebeeSubscriptionFingerprint(current) ...)`
  at L1120–1121. Nothing re-reads or conditions the dispatch after that point;
  the validate→dispatch window is unprotected (control 43.3 proves the
  fingerprint *does* catch a concurrent write that lands before that read —
  `QUOTE_STALE`, zero dispatches, item survives — so the unprotected window is
  precisely post-read/pre-dispatch).
- Post-commit, `verifyLandedItemSet` (L597–620, called at L1547) feeds the
  shared hook `verifyPostCommitState` an expectation of **the authorized
  dispatched target** (`input.items`) — per its own comment, "the expected set
  is the AUTHORIZED dispatched target (`input.items`), never the
  post-mutation state". The landed set equals that target, so the verdict is
  VERIFIED; the fingerprint bracket (response state == re-read state) closes;
  both financial dimensions establish; `establishLiveCommit` records
  `COMMITTED_AND_VERIFIED` with `reconcileCommittedEffect(...)` → OK.
- The adapter honestly declares `consistencyGuarantee: "BEST_EFFORT"`
  (L916) and its header (L45–49) acknowledges "no documented
  compare-and-swap precondition exists on update_for_items, so the
  check-then-mutate TOCTOU window is real". But BEST_EFFORT is a
  *consistency* label; nothing in the receipt distinguishes "the target
  state was reached" from "only the authorized changes were applied".
  Target-state verification is being read — by the receipt's
  VERIFIED/OK — as authorization preservation. It is not.

**What would have caught it.** A preservation check comparing the landed
state against the *pre-dispatch baseline with the authorized delta applied*
(baseline items ∪ authorized changes, with everything else required to be
unchanged) — or a provider conditional write. Neither exists today; see
`AUTHORIZATION-PRESERVATION-CONTRACT.md` for the proposed contract and
refusal conditions, and `CHARGEBEE-CAPABILITY-ASSESSMENT.md` for what
Chargebee documents. Note the mock models documented replacement semantics.

**Naming / scope note (REVIEW-3).** The concurrently added item is an
ORDINARY unrelated addon in this fixture (`pilot-addon-concurrent`, a
plain flat_fee item price). Nothing provider-enforced-mandatory is
simulated: the item carries no catalog mandatory flag, and the mock
implements none of Chargebee's mandatory-addon preservation mechanics.
What this reproduction proves is the GENERIC full-list overwrite race —
an ordinary item added inside the validate→dispatch window is deleted
by the replacement and the loss is invisible to the receipt. It does
NOT establish that a genuinely provider-enforced mandatory addon could
be deleted on real Chargebee: Chargebee's docs state a preservation
exception for *mandatory* (catalog-flagged) addons — they survive
replacement unless named in `mandatory_items_to_remove` (the adapter
sends none) — but state it explicitly for the addons-only replacement
case; whether the exception also applies inside a plan-included
replacement is NOT documented in the sources checked (see the
capability assessment, §1.5 and "What remains UNVERIFIED"), so
deletability of a real mandatory addon remains UNVERIFIED. An ordinary
concurrently added item has no such documented protection on any
reading, which is all this finding claims.

---

## Finding 2 (P1) — Runtime proposal validation — **CONFIRMED**

**Fabio's claim.** Misspelled `guaranteeMode: "REVALDIATE"` with no envelope
is accepted on Stripe-sim and the receipt is `OK`; malformed / nonfinite /
negative envelope bounds are not rejected.

**Reproduction.** `reference/tests/repro44-runtime-validation.repro.ts`
(Stripe simulator + engine-level). Full output:
`evidence/repro44-failing-output.txt`. Observed on main:

- **44.1** — `guaranteeMode: "REVALDIATE"`, no envelope: quote created with
  the typo preserved verbatim as the quote's effective mode
  (`"REVALDIATE"`), commit returns `COMMITTED_AND_VERIFIED` / `OK`.
- **44.2** — `maxImmediateNetIncrease: NaN`: accepted; receipt OK.
- **44.3** — `maxRecurringIncrease: -5`: accepted at quote creation; no
  validation error anywhere.
- **44.4** — `maxImmediateNetIncrease: "abc"` (string): accepted; receipt OK.
- **44.5** — engine level: `checkAcceptanceEnvelope` with a NaN bound and a
  +5000 immediate drift returns `null` (no violation) and does not throw —
  NaN comparisons are always false, so the bound silently never binds.

**Code path.** `resolveGuaranteeMode` (`reference/src/core/scq-engine.ts`
L556–558) returns `proposal.guaranteeMode ?? "REVALIDATE"` verbatim.
`enforceGuaranteeRequest` (L613–645) branches only on the literals `"EXACT"`
and `"REVALIDATE"`: a typo satisfies neither, skipping both EXACT's coverage
check and REVALIDATE's envelope requirement. Adapter commit paths branch on
the same literals (e.g. `stripe-adapter.ts`: the REVALIDATE re-preview gate,
the EXACT replay branch), so a typo'd mode also skips the pre-mutation
envelope gate at commit and lands in the no-envelope reconciliation case.
`compareDeterminedDimensions` (L360–408) reads bounds via `?? 0` and compares
numerically with no finiteness/type/sign validation — and no runtime
validation of the envelope exists at any layer before provider
read/preview (in `stripe-adapter.ts` the provider `retrieve` at L447
precedes even the existing guarantee checks at L472–473). TypeScript types
do not validate JSON; there is no runtime schema anywhere on this path.

---

## Finding 3 (P1) — Operation and subscription identity binding — **CONFIRMED**

**Fabio's claim.** A post-commit GET returning a different `subscription.id`
with matching item values still yields a VERIFIED/OK receipt; the original
subscriptionRef remains `pilot-sub-001` while the snapshot names another
subscription. PR #20's preflight identity check does not cover the mutating
commit/verification path.

**Reproduction.** `reference/tests/repro45-identity-currency.repro.ts`, test
45.1: Chargebee-live adapter over the pilot mock, wrapped so that every GET
after the mutating dispatch returns the same payload with
`subscription.id = "pilot-sub-999"`. Full output:
`evidence/repro45-failing-output.txt`. Observed receipt:
`subscriptionRef: "pilot-sub-001"`, `resultingSnapshot.id: "pilot-sub-999"`,
`outcome: COMMITTED_AND_VERIFIED`, `reconciliation: OK`.

**Code path.** `establishLiveCommit`
(`reference/src/live/chargebee-scq-adapter.ts`, from L1451) consumes the
re-read's items and fingerprint but never compares `after.id` to
`validated.subscription_id`. The omission is structural:
`chargebeeSubscriptionFingerprint` (L382–384) returns `rv:<resource_version>`
whenever a resource_version is present, so the subscription identity is not
even an input to the attribution bracket — a wrong-record read with the same
resource_version sequence brackets perfectly. By contrast, PR #20's preflight
(`reference/src/live/pilot/preflight.ts` L836–841) implements exactly this
check (`provider_subscription_identity`: blocker on mismatch) — for the
read-only preflight only. The mutating path has no equivalent.

---

## Finding 4 (P1) — Currency and cadence comparability — **CONFIRMED**

**Fabio's claim.** A quoted USD amount and a committed EUR amount at the same
numeric value reconcile OK; `compareDeterminedDimensions` compares numbers
without currency; `CommercialEffect.immediate` has no currency field.

**Reproduction.** `reference/tests/repro45-identity-currency.repro.ts`, tests
45.3–45.5 (engine level). Observed on main: USD→EUR at identical numbers
reconciles **OK** (45.3); the pre-mutation envelope gate also passes the
cross-currency pair silently (45.4); MONTHLY→ANNUAL cadence at the same
amount reconciles **OK** (45.5). Same-currency/same-cadence control (45.6)
reconciles OK as expected.

**Code path.** `compareDeterminedDimensions`
(`reference/src/core/scq-engine.ts` L360–408) compares
`immediate.net` and `recurring.resultingAmount` as bare numbers.
`CommercialEffect.recurring` **has** a `currency: string` field
(`reference/src/core/types.ts` L303) — the comparison never reads it.
`CommercialEffect.immediate` (types.ts, same type) has **no currency field
at all**: an immediate-side currency mismatch is inexpressible in the
schema, so any fix there is a schema change and must be recorded as such
(per Issue #22's action item). `recurring.cadence` is likewise carried
(types.ts L303) and never compared. Nothing anywhere in the
quote/commit/reconcile path validates that quoted and committed currencies
(or cadences) are the same dimension.

---

## Finding 5 (P1) — Receipt verification and independent later actuals — **CONFIRMED** (all three sub-cases)

**Fabio's claim.** (a) A missing candidate cannot be filled after new
evidence; (b) an incorrect candidate cannot be corrected; (c) when a
candidate is independently confirmed with an equal amount, the receipt flips
to VERIFIED/OK while `committedEffect.determinacy` remains UNKNOWN and
`committedSource` remains `"unestablished"`.

**Reproduction.** `reference/tests/repro46-receipt-verification.repro.ts`,
built on the merged candidate construction (mutation response received,
independent re-read down → COMMITTED_UNVERIFIED with recorded candidates;
the test26.17 shape). Full output: `evidence/repro46-failing-output.txt`.

**Evidence provenance (PR #23 review correction, REVIEW-2).** As first
delivered, 46.1/46.2 built the verification observation from literal
figures chosen by the test file, and in 46.2 the mock's GET record still
showed 80900 — so the pair demonstrated the store's strict-equality
upgrade restriction against a *caller-constructed* observation, not
against independently established provider actuals. The harness now
persists the divergence provider-side and derives the observation from
the read:

- In **46.2**, the harness's provider record carries the plan item at a
  corrected unit price (62400) from the moment the update lands. The
  mutation response still states the plan at 59900, so the receipt
  records candidate recurring **80900** from the response — while the
  independent post-commit GET of the provider record shows stated item
  amounts 62400 + 21000, and the observation's recurring (**83400**) is
  derived from that read (the adapter's own snapshot derivation sums
  the record's stated amounts). The observation's immediate (20000) is
  read from the provider's operation-bound record of this very update —
  the persisted update response's `unbilled_charges` — so both figures
  are bound to provider records (the subscription record for recurring;
  the operation's own charge record for immediate), not picked by the
  test. The store refuses this genuinely provider-established,
  differing actual with the same identity error.
- In **46.1**, the observation's recurring is likewise derived from the
  independent read (80900; it agrees with the candidate — nothing about
  it is contested). Its immediate figure remains a *stated* observation
  figure, disclosed as such in the test: the incomplete-response fault
  models a provider operation record whose response carries no charge
  figure and the fixture has no post-commit charge-read endpoint. The
  missing-dimension restriction 46.1 demonstrates does not depend on
  that figure's provenance — any established immediate contradicts the
  receipt's absent immediate identity field.
- **46.3** is unchanged in substance.

A distinction the corrected evidence makes precise: *recording*
contradictory evidence for investigation (append it, bound to the
receipt's identity, marked as establishing a VIOLATED actual) is not
the same as *marking it verified*. The safe behavior asserted is only
the former; the store today permits neither — differing evidence is
refused at the door, so the contradiction cannot even be recorded.

- **46.1 (a) CONFIRMED.** Receipt recorded with a recurring candidate
  (80900) but **no** immediate candidate (the update response carried no
  financials). Later evidence establishing immediate = 20000 (and recurring
  = the recorded 80900, read-derived as above) is refused:
  *"Verification refused: the evidence's committed figures
  (immediate.net=20000, recurring.resultingAmount=80900) contradict the
  figures recorded on the receipt…"* (`CONFLICTING_RECEIPT_IDENTITY`).
- **46.2 (b) CONFIRMED.** Receipt recorded with candidate recurring 80900.
  Independent evidence establishing the actual recurring as **83400** —
  persisted in and read back from the provider record, per the
  provenance note above — is refused with the same identity error. There
  is no path by which a wrong candidate can be corrected: the record can
  only ever be confirmed verbatim or stay unverified forever.
- **46.3 (c) CONFIRMED.** With confirming evidence (20000 / 80900), the
  transition succeeds: current view `outcome: COMMITTED_AND_VERIFIED`,
  `reconciliation: OK` — while the same view's `committedEffect.determinacy`
  remains `{ UNKNOWN, UNKNOWN }` and
  `committedEffect.provenance.committedSource` remains `"unestablished"`.
  The displayed provenance contradicts the displayed verdict.

**Code path.** `QuoteStore.assertEvidenceValid`
(`reference/src/store/quote-store.ts` L491) requires the evidence's figures
to **equal** the recorded receipt's identity fields, else
`CONFLICTING_RECEIPT_IDENTITY` — figure equality with the candidates is the
*only* verification relation the store admits. `verifyCommitReceipt`
(L606–612) then builds the current view as
`{ ...deepCopy(recorded), status: "COMMITTED", outcome:
"COMMITTED_AND_VERIFIED", reconciliation: evidence.reconciliation }` —
status/outcome/reconciliation advance, but the copied `committedEffect` is
the recorded candidate effect, labels and all. The PR #21 candidate's §6.15
currently *codifies* the equality rule ("requires the evidence's committed
figures to equal the amounts RECORDED on the receipt at commit time… a
candidate that independent evidence contradicts can never be upgraded on
this record") — so (a) and (b) are not merely implementation behavior; the
candidate text blesses them. See the recommended candidate corrections in
`AUTHORIZATION-PRESERVATION-CONTRACT.md`.

**What is NOT wrong.** The recorded original is never rewritten:
`checkIdempotentReplay` keeps returning the original receipt verbatim after
a transition (asserted as passing controls inside 46.2/46.3), and recovery
coherence (restore validation) is intact. The defect is in the *transition
relation and the derived view*, not in immutability — the fix direction is
an append-only, identity-bound evidence record plus a separately derived
current verified view whose displayed figures/provenance are the
*establishing evidence's*, with differing actuals expressed as
verified-with-violation rather than refused (analysis only; not
implemented here).

---

## Finding 6 (P2) — Envelope nomenclature — disposition (no repro in scope)

Substantiated by inspection. `AcceptanceEnvelope.maxImmediateCreditDecrease`
is documented (`reference/src/core/types.ts` L242) as the "Max decrease in an
immediate credit magnitude the caller will accept", but
`compareDeterminedDimensions` (`scq-engine.ts` L378–392) applies it to **any**
favorable net movement (`netIncrease < 0`): a smaller charge with no credit
involved consumes the "credit decrease" budget exactly as a larger credit
does. The name and doc describe credit-magnitude reduction; the semantics
are favorable-movement magnitude. Disposition: record as a
documentation/nomenclature defect — either rename (a breaking change for
envelope authors; needs a migration note) or re-document the field as
bounding favorable net movement of either kind, without silently changing
the mathematics. The receipt reading table requested by the issue
(attribution / state / preserved invariants / financial compliance /
unknowns, as separate receipt claims) is folded into the contract proposal
in `AUTHORIZATION-PRESERVATION-CONTRACT.md`.

## Finding 7 (P1/P2) — Adapter verification and recovery evidence — dispositions (no new repros in scope)

- **Stripe-sim EXACT/CANCEL verification source.** Substantiated by
  inspection: in `stripe-adapter.ts` (commit path, the
  `isCancel || effectiveMode === "EXACT"` branch), the committed effect is
  the quoted effect re-labeled `defined_equal_exact` and the receipt is
  recorded `COMMITTED_AND_VERIFIED` directly from the mutation call's
  return value (`resultingSub`) — there is no independent post-commit
  re-read of provider state on that branch (contrast the REVALIDATE branch,
  which establishes from read-back state). The SPEC1/PR #21 record already
  establishes that defined-equality is definitional for EXACT on this
  simulator (proration_date pinning); the open evidentiary gap is the
  *state* side: a mutation result claiming the wrong state would be
  carried into the snapshot unverified. Wrong-state/success-response
  negative tests are recommended for the follow-up implementation PR;
  not reproduced here per scope.
- **Operator `resolveAttempt`.** Inspected (`durable-store.ts` L954–965):
  resolution takes a free-text `note`, sets
  `operator_review_state='RESOLVED'`, and thereby unblocks future dispatch
  (`findBlockingAttempt`, L688–697, excludes resolved INDETERMINATE
  attempts). The code is explicit that resolution is an operator action
  never invoked by recovery paths, and resolution itself dispatches
  nothing. The residual concern stands as a design note: the *sole*
  precondition for unblocking is an unstructured attestation — no
  structured evidence (observed state, provider reference) is required or
  recorded beyond the note. Recommend a structured resolution record in
  the follow-up design; no repro in scope.
- **Concurrency keying across sites.** Inspected: the blocking-attempt
  query (L691) matches `(quote_id = ? OR subscription_id = ?)` with no
  provider/site predicate, while attempts do record provider/site at
  intent time. Two consequences, both availability-side rather than
  safety-side: the same subscription id on two different Chargebee sites
  would mutually block (over-broad exclusion), and the ledger's notion of
  "same subscription" is narrower than the real identity
  (site + subscription). Recommend keying exclusion by
  (provider, site, subscription_id) in the follow-up design; no repro in
  scope.
- **test27 Windows subprocess path.** Per Issue #22, kept **separate**:
  OS/CI hardening (the `URL.pathname` vs `fileURLToPath` class of issue),
  not protocol safety. Not investigated here. (Separately, this repo's CI
  already carries the known intermittent test27.22b Node 20
  lock-contention flake — also a separate track, unchanged by this PR.)

---

## Evidence index

| Artifact | Contents |
|---|---|
| `reference/tests/repro43-authorization.repro.ts` | F1 repro + 2 controls; prints the full (a)–(e) capture |
| `reference/tests/repro44-runtime-validation.repro.ts` | F2 repro (5 defect tests) + control |
| `reference/tests/repro45-identity-currency.repro.ts` | F3 repro + control; F4 repro (3) + control |
| `reference/tests/repro46-receipt-verification.repro.ts` | F5 repro (3 sub-cases) + immutability controls |
| `evidence/repro43-failing-output.txt` | Verbatim failing run, repro43 (incl. the EVIDENCE block) |
| `evidence/repro44-failing-output.txt` | Verbatim failing run, repro44 |
| `evidence/repro45-failing-output.txt` | Verbatim failing run, repro45 |
| `evidence/repro46-failing-output.txt` | Verbatim failing run, repro46 |

The four repro files are the research suite (REVIEW-1): after a build,
run `node --test dist/tests/*.repro.js` from `reference/`. They are not
part of the default `npm test` discovery.
| `CHARGEBEE-CAPABILITY-ASSESSMENT.md` | Provider capability research (Phase 2) |
| `AUTHORIZATION-PRESERVATION-CONTRACT.md` | MSE comparison, minimal contract, refusal conditions, recommended v0.6.2 corrections (Phase 3) |

*Classification reminder: every result above is SIMULATED_PASS-grade
evidence about SCQ's own code obtained through mocked transports and
simulators. No finding here is evidence about a live Chargebee tenant.*

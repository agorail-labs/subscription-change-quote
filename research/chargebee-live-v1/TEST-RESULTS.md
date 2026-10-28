# Test Results — SCQ Live Chargebee Validation v1

- **Baseline commit:** `79200fa4cbcf955c618428c0fca74fd2abce7c9d` (verified HEAD before branching)
- **Branch:** `experiment/chargebee-live-validation-v1` (local only)
- **Environment:** Node 20+, TypeScript, `node --test`. **No Chargebee credentials in the
  environment** — every test below runs with no live credentials and must pass that way
  (Phase 7 gate, verified).

## Baseline (Phase 0, before any changes)

| Command | Result |
|---|---|
| `cd reference && npm ci` | OK (3 packages) |
| `npm test` | **66 tests, 66 pass, 0 fail** — the conformance doc's "66 test cases" claim is accurate for the baseline |
| `npm run smoke:pack` | OK — external ESM import OK, external TS consumer OK, tarball smoke OK (nothing published) |

## New deterministic tests (Phase 4) — `reference/tests/test13-chargebee-http.test.ts`

18 tests, all passing, all against a mocked transport implementing the *documented*
Chargebee wire shape (see API-CONTRACT-AUDIT.md A10 for why the fake does not copy the
simulator's assumptions). Mock-backed results are SIMULATED_PASS, never LIVE_PASS —
enforced by `Test 13-classifications` inside the suite itself.

| ID | Test | Classification (mocked) | Live classification |
|---|---|---|---|
| T01 | Initial subscription read → accurate normalized snapshot (qty 100, recurring 100000 USD, version = provider `resource_version`) | SIMULATED_PASS | BLOCKED — CREDENTIALS NOT AVAILABLE |
| T02 | Quote 100→120: retrieve + estimate only; mutation count 0; version unchanged; coverage REVALIDATE/UNKNOWN (no EXACT claim) | SIMULATED_PASS | BLOCKED |
| T03 | Normal quote + commit: COMMITTED, qty 120, quoted == committed, reconciliation OK, exactly 1 mutation, `replace_items_list=true` and `invoice_immediately=false` observed on the wire, quote-derived idempotency key present | SIMULATED_PASS | BLOCKED |
| T04 | Out-of-band change after quote (resource_version bump) → QUOTE_STALE, no mutation | SIMULATED_PASS | BLOCKED |
| T05 | Estimate drift outside the subscription fingerprint (balances/tax-style) → envelope enforced against last pre-mutation preview → QUOTE_DRIFTED, no mutation | SIMULATED_PASS | BLOCKED |
| T06 | Commit repeated with same quote ID → identical historical receipt, still 1 mutation | SIMULATED_PASS | BLOCKED |
| T07 | Mutation applied, response lost (transport throw) → indeterminate → reconcile-by-read → recovered receipt, exactly 1 mutation, no blind retry **(BEHAVIOR CHANGED in the PR #4 review round: the recovered receipt substituted the pre-mutation estimate for the unverifiable actual outcome; the adapter now fails closed as INDETERMINATE and records NO receipt — see the PR #4 review addendum)** | SIMULATED_PASS | BLOCKED |
| T08 | Concurrent reprice lands between final preview and commit → commit proceeds (BEST_EFFORT), outcome detected via post-commit state | SIMULATED_PASS (combined with T09) | BLOCKED |
| T09 | Committed effect exceeds envelope → receipt returned as COMMITTED with `reconciliation: VIOLATED`; no exception pretending no mutation; no rollback claimed | SIMULATED_PASS (combined with T08) | BLOCKED |
| T10 | Unsupported combined change (multi-change; CANCEL on the live adapter) → UNSUPPORTED_CHANGE before any estimate or mutation | SIMULATED_PASS | BLOCKED |
| T11 | Quote expires before commit (injected clock, +6 min vs 5-min TTL) → QUOTE_EXPIRED, no mutation. Contrast in same file: overall EXACT request refused naming `immediateFinancialEffect` | SIMULATED_PASS | BLOCKED |
| T12 | Provider 500 at estimate → PROVIDER_ERROR with HTTP status recorded, nothing committed or fabricated; 404 path classified as an SCQ error, not success | SIMULATED_PASS | BLOCKED |
| T13 | Process restart after commit (fresh in-memory store) → commit replay **fails closed** with QUOTE_STALE and no re-mutation. This validates the *limitation*, not exactly-once: a conforming live deployment requires a durable transactional quote/receipt store (LIMITATIONS D-3) | SIMULATED_PASS (for the limitation) | BLOCKED |
| T14 | `has_scheduled_changes=true` → surfaced in quote metadata with an explicit warning, termEffect UNKNOWN; TERM_END and DATE refused (deprecated update paths / early-access Ramps not implemented); zero Ramps calls made | SIMULATED_PASS (for reporting) | BLOCKED (Ramps behavior itself UNVERIFIED) |

Supporting unit tests in the same file:

| Test | Result | Classification |
|---|---|---|
| 13-http1 form encoding (Chargebee field-then-index bracket notation), Basic auth sent, redaction strips credentials | pass | SIMULATED_PASS |
| 13-http2 missing env credentials → BLOCKED — CREDENTIALS NOT AVAILABLE; live commit defaults to disabled | pass | SIMULATED_PASS |
| 13-http3 native idempotency vs fake: same key+params ≤30 min replays (`chargebee-idempotency-replayed`), different params → 422, +31 min → reprocesses | pass | SIMULATED_PASS (semantics DOCUMENTATION_SUPPORTED per audit A7) |
| 13-gate live commit disabled by default → quote + revalidation complete, mutating call never fires | pass | SIMULATED_PASS |
| 13-classifications no mock-backed row may be labeled LIVE_*; all labels in the allowed set | pass | — (meta-test) |

## Final totals (Phase 7 re-run)

| Suite | Count |
|---|---|
| Original suite (baseline files) | 66 pass / 0 fail |
| New file (test13) run separately | 18 pass / 0 fail |
| **Full `npm test`** | **84 pass / 0 fail — no regression** |
| `npm run smoke:pack` | OK |

## Live API observations (this run)

**None.** No credentials were provided, no live endpoint was called, and the demo
driver (`reference/demo/chargebee-live-validation.ts`) correctly reports
`BLOCKED — CREDENTIALS NOT AVAILABLE` and exits without claiming any result.
Documentation observations are in API-CONTRACT-AUDIT.md; prior-cycle live observations
remain recorded, as historical evidence only, in `research/EVIDENCE.md`.

*(Phase 1 record, preserved as written. SUPERSEDED for the
read/estimate scope by the Phase 3 addendum below: a later,
separately approved run DID exercise the live read/estimate paths —
L-GET LIVE_PASS, L-QUOTE LIVE_PASS, flat_fee refusal live-verified,
L-COMMIT still BLOCKED.)*

## Approval needed — proposed live mutations NOT executed

If a future run is approved, the smallest live experiment is, in order:

1. **Read/estimate only (no mutation approval needed beyond credentials):** provision a
   Chargebee **test** site; create one synthetic customer + subscription via the
   Chargebee console/API (100 seats on a monthly item price, no real payment method —
   test gateway only); set `CHARGEBEE_SITE`, `CHARGEBEE_API_KEY` (test-site key),
   `CHARGEBEE_TEST_SUBSCRIPTION_ID`; run the demo driver. Expected provider effects:
   **none** (one GET, one estimate POST).
2. **Single commit (separate explicit approval required):** with
   `SCQ_LIVE_COMMIT_ENABLED=true`, commit exactly one quote: subscription
   `CHARGEBEE_TEST_SUBSCRIPTION_ID`, CHANGE_QUANTITY 100 → 120 seats, IMMEDIATE,
   `replace_items_list=true`, `prorate=true`, `invoice_immediately=false` (charges land
   as **unbilled charges**; no invoice is issued and nothing is collected), native
   idempotency key `scq-<quoteId>`. Intended billing effect: subscription items become
   120 seats; a prorated unbilled charge for the seat delta is created.
   **Recovery/cleanup — CORRECTED IN PHASE 2A (see RECOVERY-AUDIT.md): the
   procedure originally proposed here (a second update back to 100 seats,
   void/delete unbilled charges in the console, confirm quantity and
   `has_scheduled_changes` via GET) was audited against current documented
   Chargebee behavior and found NOT COMPLETE: the downgrade does not remove
   the forward period's unbilled charges (they auto-invoice at renewal),
   scheduled changes deleted by the forward update are not restored,
   mandatory addons are not covered by a quantity check, the reverse
   proration is not symmetric, and the recovery window closes at renewal.
   Do NOT rely on the original wording. The corrected recovery plan —
   pre-state snapshot, fresh-fixture preconditions, per-charge unbilled
   deletion with an empty-list verification, full item/term comparison,
   and wholesale site discard as the only unconditionally complete
   fallback — is in RECOVERY-AUDIT.md §"Corrected recovery plan".
3. Everything else in T01–T14 stays mocked until step 2's evidence exists.

## Phase 3 addendum (2026-10-27) — live quoting repaired and revalidated

Phase 3 ran WITH test-site credentials (read/estimate only; commit
disabled; zero mutations — subscription `resource_version` and item
state verified identical before and after every live step). Sanitized
evidence: **in this repo** at
`research/chargebee-live-v1/evidence/PHASE3-EVIDENCE-SUMMARY.md`;
the full run report also exists outside the repo at
`~/workspace/scq-live-validation-evidence/PHASE3-RUN-2026-10-27.md`.

What changed and why (all findings live-verified on the test site
`<test-site>`, demo subscription
`<subscription-id>`):

- **L-GET: LIVE_PASS** (unchanged from the first live run — the
  adapter's snapshot matched the raw API).
- **Root causes of the original estimate HTTP 400s, isolated by a
  18-cell matrix holding all other parameters constant:** (1) the
  client sent a flat `subscription_id`; the endpoint requires the
  nested `subscription[id]` — FIXED. (2) The remaining 400 was NOT an
  encoding error: the field-grouped array encoding is the server's
  real format (it is also the documented one), and the
  item-indexed shape is silently IGNORED (HTTP 200 describing a
  different item set). The 400 is the server's per-item validation:
  a quantity CHANGE on a flat_fee item is rejected ("This param
  should not be sent for on_off addon type"). An interim Oct 27
  report concluded the opposite on encoding from a single 200; the
  matrix reversed that conclusion, and the resolution also explains
  the earlier "addon change produced no estimate delta" observation
  (the change had never reached the server).
- **Adapter behavior now:** CHANGE_QUANTITY on a flat_fee item is
  refused before any provider call (UNSUPPORTED_CHANGE);
  interpretation is per-source with provenance (unbilled/invoice
  minus credit notes for immediate; provider-stated items or
  pricing-model-justified computation for recurring — flat_fee never
  × quantity); next_invoice_estimate is never mapped into the effect
  (no SCQ v0.6.1 field matches its semantics) and is reported in
  providerMetadata only; undeterminable dimensions fail closed
  (QUOTE_NOT_DETERMINISTIC) at quote and commit-revalidation time.
- **L-QUOTE (per_unit addon 1→21, through the adapter, real API):
  LIVE_PASS** — immediate 185240 from
  `unbilled_charge_estimates` (provider proration; time-dependent),
  recurring 60900 → 80900 (flat_fee 59900 once + per_unit 21 × 1000),
  coverage REVALIDATE/UNKNOWN (no EXACT). Semantics of that immediate
  figure: a **newly incurred unbilled obligation** — not an issued
  invoice, not a payment due at commit, not cash collected; the
  adapter commits with `invoice_immediately=false`, so such charges
  are invoiced at the next billing cycle. The estimate itself
  incurred nothing: this obligation would be incurred only upon a
  successful commit, and the completed live experiment was
  estimate-only — it caused no mutation and no obligation.
- **L-REFUSAL (flat_fee plan quantity 1→21, through the adapter):
  LIVE-verified refusal** — UNSUPPORTED_CHANGE before any estimate
  call; the raw provider validation error was reproduced separately
  in the matrix.
- **Updated live classifications:** T01-live → LIVE_PASS;
  T02-live → LIVE_PASS (adapter quote through the real API, addon
  scenario); T03-live (commit) and T14-live (scheduling) remain
  BLOCKED — commit and mutations were not authorized or executed.
- **Tests:** test13 rebuilt from the captured wire shapes (the old
  fake accepted the client's own encoding and always returned a rich
  estimate — the reason both bugs were invisible) + 11 Phase 3
  regression tests. Full clean build: **95 pass / 0 fail** (84 on the
  rebased pre-fix branch), smoke OK. Frozen files unchanged.

## Final pre-PR checks addendum (2026-10-28) — semantics + unknown-vs-zero

Two focused audits ran against this branch before PR submission. No
live API calls were made in these checks; all results below are
mock-backed (SIMULATED_PASS) or document audits.

**Check 1 — financial-effect semantics.** The 185240 immediate figure
is, and is now documented everywhere in this branch as, a newly
incurred **unbilled** obligation (see the L-QUOTE bullet above and
the adapter's `interpretChargebeeEstimate` documentation): not an
invoice, not a payment due, not a collection. The three estimate
sources (`invoice_estimate`, `unbilled_charge_estimates`,
`next_invoice_estimate`) are kept strictly distinct in code, tests,
and docs. One normative gap was found and recorded OUTSIDE this repo
as a protocol-defect proposal: the frozen spec never defines
`CommercialEffect.immediate` semantics at all (it references the type
without defining it), so "incurred vs invoiced vs due" is currently
adapter convention, not protocol. The frozen spec was NOT edited.

**Check 2 — unknown-versus-zero.** `checkAcceptanceEnvelope` (frozen
core) coerces absent dimensions to 0 (`?? 0`, scq-engine.ts:130-152).
The live adapter's remaining silent-zero sites were fixed:
member ELEMENTS are now strict (an unbilled element without
`amount`, or a credit-note element without `total`, makes the
dimension ABSENT, never 0); the provider-stated recurring path now
requires a stated `amount` on every item (a unit_price-only item is
never summed as unit_price × quantity — it falls through to the
pricing-model computation); the post-commit effect builder uses
stated amounts only. New negative regression tests (all in test13;
neg1–neg4 verified to FAIL against the pre-fix adapter):

| Test | Result | Classification |
|---|---|---|
| 13-neg1 unbilled element without amount → quote refused (QUOTE_NOT_DETERMINISTIC) | pass | SIMULATED_PASS |
| 13-neg2 credit_note_estimates member absent / element without total → refused / immediate absent | pass | SIMULATED_PASS |
| 13-neg3 commit revalidation turns unknown → commit refuses; the mutating endpoint is never invoked (transport log asserted) | pass | SIMULATED_PASS |
| 13-neg4 stated items with unit_price but no amount → flat_fee never unit_price × quantity | pass | SIMULATED_PASS |
| 13-zero1 provider-STATED zero (both members present, empty) → accepted as actual zero; quote succeeds | pass | SIMULATED_PASS |

The four simulator-backed adapters were audited and NOT changed:
their per-change effects are built from deterministic in-repo
simulator previews whose net is always a computed number, and
`immediate` is omitted only when that number is exactly 0 (or, for
Paddle, when no immediate transaction exists) — absence there encodes
a computed zero / not-applicable by construction, not unknown
provider data. The general protocol defect (absent is indistinguishable
from zero to the frozen envelope function) is recorded in the same
external proposal; any future adapter combining effects from a real
provider must not copy the combine pattern without the live adapter's
fail-closed discipline.

**Updated totals:** test13 = 34 tests; full clean build
**100 pass / 0 fail**; smoke OK; provider-neutrality check OK;
freeze guard: 0-line diff on the frozen files vs merged main
`cde8faa`; secrets/unsanitized-data scan over the full branch diff:
clean.

## Phase 2A re-run (2026-10-27) — claim corrections applied

Phase 2A corrected the simulator-backed Chargebee adapter and Test 11 to
the posture this document's live-adapter rows already used. No test was
added or removed; assertions changed (see
CLAIM-CORRECTION-MATRIX.md §A/§C for the per-assertion record):

| Suite | Result |
|---|---|
| Full `npm test` after Phase 2A | **84 pass / 0 fail** (same total as Phase 1 final: 66 baseline incl. corrected Test 11 + 18 test13) |
| Test 11 file | 10 tests, all passing with corrected assertions (EXACT refused for every Chargebee action; DATE/update-TERM_END refused; evergreen CANCEL termEffect-only EXACT) |
| `npm run smoke:pack` | re-run in Phase 2A — see PUBLICATION-READINESS.md for the recorded result |
| Live rows | unchanged: all BLOCKED, no credentials, no live calls in Phase 2A either |

## PR #4 review addendum (2026-10-28) — stated-items completeness, committed-actuals honesty

An independent review of draft PR #4 requested five corrections.
This addendum records the two code changes and the new tests; the
others (identifier redaction, reproduction docs, obligation-timing
wording) are recorded in the files they touch. **No live API calls
were made in this round** — all new tests are mocked.

### Fix 1 — stated-items completeness (quote-time recurring)

`interpretChargebeeEstimate` previously summed ANY nonempty
`subscription_estimate.subscription_items` list carrying numeric
amounts as the complete resulting recurring amount. A partial
provider-stated list (only the repriced items, for example) would
have been reported as the full result. Now a stated list is used
only after verifying it is the ENTIRE intended item set: same
`item_price_id` multiset as the intended target items (no missing,
no extra, no duplicate), matching quantities per item, and a
numeric stated amount on every item. A list failing verification
falls through to the per-item pricing-model computation; if that
cannot determine the amount either, recurring is ABSENT and the
quote fails closed (`QUOTE_NOT_DETERMINISTIC`), as before.

New tests (mocked, `reference/tests/test13-chargebee-http.test.ts`):
13-fix11a (stated list missing the addon), 13-fix11b (duplicate
stated entry), 13-fix11c (quantity mismatch), 13-fix11d (stated
list is a partial subset), 13-fix11e (adapter level: estimate whose
stated list omits an intended item). Each asserts the partial
stated sum is NOT reported as `resultingAmount` and that the
verified computation (80900 / 120500 in the fixtures) is used
instead. **Spot-check:** all five FAIL against the pre-fix code
(scratch worktree at the pre-fix commit, new test file only).

### Fix 2 — committed effect from ACTUALS only (post-commit honesty)

`committedEffectFromState` previously fell back to the pre-mutation
revalidated estimate when the update response carried neither an
invoice total nor an unbilled total — an unavailable ACTUAL outcome
was replaced by the estimate, and reconciliation could then report
OK against unverified numbers. Now:

- committed immediate comes ONLY from the update response (invoice
  total, or a complete `unbilled_charges` member actually returned);
- committed recurring comes ONLY from the re-read post-commit
  subscription items' stated amounts (any item without one makes
  the dimension UNDETERMINED — never reconstructed);
- if either actual dimension is undetermined,
  `commitChangeQuote` fails closed with an indeterminate
  `PROVIDER_ERROR` and records NO receipt (a missing
  `resultingAmount` never reaches `reconcileCommittedEffect`, whose
  frozen comparison would treat it as 0 and could report a
  misleading OK);
- in the lost-response path the item-set landing is still verified
  by re-read (and reported in the error), but no receipt is
  recorded: without the update response the actual immediate
  outcome is unverifiable. **This changes T07's mocked behavior**
  (row updated above): previously "recovered receipt"; now
  indeterminate refusal, store shows no committed receipt, exactly
  one provider mutation, no blind retry. The underlying limitation —
  the frozen receipt type cannot represent "committed but
  financially unverified" — is recorded as an addendum in the
  protocol-defect proposal.

New tests (mocked): 13-rec1 (incomplete post-update response →
indeterminate, no receipt), 13-rec2 (lost response; landed items
without determinable amounts → indeterminate, no OK receipt),
13-rec3 (lost response; change did not land → existing refusal
preserved), 13-rec4 (complete actual response: receipt carries the
ACTUAL figures — 25000, not the estimate's 20000 — and
reconciliation reports VIOLATED against the zero-tolerance
envelope). **Spot-check:** 13-rec1, 13-rec2, and the updated T07
FAIL against the pre-fix code; 13-rec3 (preservation) and 13-rec4
(positive control) pass there, as designed.

### Totals after this round

| Suite | Result |
|---|---|
| Full clean build (`rm -rf dist node_modules`, `npm ci`, `npm test`) | **109 pass / 0 fail** (66 baseline + 43 test13) |
| test13 file | 43 tests (34 pre-existing incl. the updated T07 + 9 new) |
| `npm run smoke:pack` | OK |
| Provider-neutrality scan | clean |
| Freeze guard (frozen files vs merged main) | 0 differing lines |
| Live rows | unchanged: L-GET LIVE_PASS, L-QUOTE LIVE_PASS, flat_fee refusal live-verified (Phase 3), L-COMMIT BLOCKED — no live calls in this round |

## PR #4 final review addendum (2026-10-28) — absent collection is not zero; receipts require a verified item set

A final review of draft PR #4 at `3fad741` found two remaining
post-commit correctness issues in the experimental live adapter.
Both are fixed in this round. **No live API calls were made** — all
new tests are mocked, and live commit remains disabled.

### Fix A — an absent post-commit item collection is UNDETERMINED, never a verified zero

`committedEffectFromState` read the re-read post-commit items via
`after.subscription_items ?? []`. When the `subscription_items`
member was ABSENT from the re-read response, the empty default made
the stated-amount check vacuously true and produced
`recurringAmount = 0` — an invented figure indistinguishable from a
verified zero, which could then anchor a receipt's reconciliation.
Now: an absent member, an explicitly empty collection (the intended
item set is never empty), or any incomplete item entry (missing
`item_price_id`, `quantity`, or a stated `amount`) makes the
recurring dimension UNDETERMINED, and the commit fails closed as
indeterminate with no receipt — the same mechanism as the other
undetermined dimensions. Explicitly observed zeros are preserved:
an item whose stated amount is literally 0 contributes 0, and a
verified sum of 0 is a determined zero.

### Fix B — a COMMITTED receipt requires the intended item set to be established

The success path previously recorded a receipt after a 2xx update
response plus a financial re-read, without ever verifying that the
ACTUAL post-commit item IDs and quantities equal the quote's
intended target set. A provider that returns HTTP 200 while
silently ignoring or partially applying the requested change would
have been reported as a verified COMMITTED — amounts computed on
the wrong item set can still satisfy the financial envelope. Now,
before any receipt is recorded, the re-read items are compared
against the intended set (same `item_price_id` multiset — no
missing, extra, or duplicated entries — with equal quantities per
item, via a shared `itemSetMismatches` comparison also used by the
lost-response landing check). Any mismatch ⇒ indeterminate
`PROVIDER_ERROR` carrying the mismatch detail, and NO receipt —
even if the envelope would pass.

New tests (mocked): 13-rec5 (re-read omits `subscription_items`
entirely → indeterminate, no receipt), 13-rec6 (an item with a
stated amount of exactly 0 in a complete, matching set → receipt
records the determined zero), 13-rec7 (update returns 200 with
envelope-satisfying financials but the provider silently ignored
the change → indeterminate, no receipt), 13-rec8 (partial apply:
re-read quantity 110 of the intended 120 → indeterminate, no
receipt), 13-rec9 (extra item; duplicated entry → indeterminate,
no receipt), 13-rec10 (positive control: exact match → receipt
records as before, reconciliation OK). **Spot-check:** 13-rec5,
13-rec7, 13-rec8, and 13-rec9 FAIL against the pre-fix code
(scratch worktree at `3fad741`, new test file only — 49 tests,
45 pass / 4 fail there); 13-rec6 and 13-rec10 are preservation
controls and pass on both, as designed.

### Totals after this round

| Suite | Result |
|---|---|
| Full clean build (`rm -rf dist node_modules`, `npm ci`, `npm test`) | **115 pass / 0 fail** (66 baseline + 49 test13) |
| test13 file | 49 tests (43 pre-existing + 6 new) |
| `npm run smoke:pack` | OK |
| Provider-neutrality scan | clean |
| Freeze guard (frozen files vs merged main) | 0 differing lines |
| Live rows | unchanged: L-GET LIVE_PASS, L-QUOTE LIVE_PASS, flat_fee refusal live-verified (Phase 3), L-COMMIT BLOCKED — no live calls in this round |

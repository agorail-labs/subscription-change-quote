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
| T07 | Mutation applied, response lost (transport throw) → indeterminate → reconcile-by-read → recovered receipt, exactly 1 mutation, no blind retry | SIMULATED_PASS | BLOCKED |
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
state verified identical before and after every live step). Full
sanitized evidence:
`~/workspace/scq-live-validation-evidence/PHASE3-RUN-2026-10-27.md`
(outside this repo).

What changed and why (all findings live-verified on the test site
`arjunsamplecompany-test`, demo subscription
`cbdemo__XpbKpmKUbu8d2cPS`):

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
  coverage REVALIDATE/UNKNOWN (no EXACT).
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

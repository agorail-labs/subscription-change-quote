# Chargebee pilot — sanitized evidence report

Two evidence sets, kept strictly separate: **(A)** this pilot's own run
(simulated, Oct 28, 2026) and **(B)** the historical live run of
Oct 27, 2026 (cited, not re-claimed). Identifiers are placeholders
(`<test-site>`, `<subscription-id>`) except the pilot fixture's
synthetic ids, which identify no real tenant or customer.

## A. This pilot's run — SIMULATED

Command: `npm run pilot:chargebee -- --out research/chargebee-pilot/runs/mocked-2026-10-28`
(artifacts: `runs/mocked-2026-10-28/pilot-report.json` + `pilot-report.md`)

| Capability | Classification | Evidence |
|---|---|---|
| Retrieve subscription (mocked transport) | SIMULATED_PASS | Harness step pass; snapshot status active, 2 items, version `rv:1700000000000` |
| SCQ snapshot normalization | SIMULATED_PASS | recurring 60900 USD from provider-stated item amounts |
| Estimate-backed quote (addon qty 1 → 21) | SIMULATED_PASS | immediate.net 20000 (unbilled − credits); recurring 60900 → 80900 |
| Normalized-vs-raw field comparison | SIMULATED_PASS | 6/6 fields match, incl. next-invoice isolation and provenance presence (test 21-p3 proves the comparison *fails* on a divergent raw estimate) |
| Next-invoice separation (amount_due ≠ incurred; credits don't reduce recurring) | SIMULATED_PASS | Test 21-p4: total 80900 / amount_due 80600 in metadata only; effect immediate 20000, recurring 80900 |
| Sparse/missing estimate fields refuse (unknown ≠ zero) | SIMULATED_PASS | Tests 21-n1, 21-n2 (`QUOTE_NOT_DETERMINISTIC`); no mutating call |
| Provider-stated zero preserved | SIMULATED_PASS | Test 21-z1: unchanged quantity ⇒ immediate.net exactly 0, present |
| Partial stated item list never summed | SIMULATED_PASS | Test 21-n3: falls back to justified per-item computation; provenance records the partial list was not used |
| Unsupported pricing model (tiered) refused | SIMULATED_PASS | Test 21-n4 |
| flat_fee quantity change refused pre-call | SIMULATED_PASS | Test 21-n5: refusal on metadata; 0 estimate calls, 0 mutating calls |
| Scheduled-change interference surfaced | SIMULATED_PASS | Test 21-n6: warning in metadata; termEffect UNKNOWN |
| Commit gate (flag disabled) | SIMULATED_PASS | Test 21-c1: quote + revalidation complete; `LIVE_COMMIT_DISABLED`; 0 mutating calls |
| Stale version / expired quote refusal | SIMULATED_PASS | Tests 21-c2 (`QUOTE_STALE`), 21-c3 (`QUOTE_EXPIRED`); 0 mutating calls |
| Mocked commit + §6.10 replay | SIMULATED_PASS | Test 21-c4: COMMITTED/OK from actuals; duplicate commit replays original receipt; exactly 1 mutating call |
| Conflicting native idempotency (same key, different params) | SIMULATED_PASS | Test 21-c5: provider 422; state unchanged |
| Lost mutation response | SIMULATED_PASS | Test 21-c6: INDETERMINATE, no receipt, retry refuses, still 1 mutating call |
| Silent-ignore 200 (state ≠ intent) | SIMULATED_PASS | Test 21-c7: INDETERMINATE with item-set mismatches; no receipt |
| Post-commit financial uncertainty | SIMULATED_PASS | Test 21-c8: INDETERMINATE, no receipt (frozen-type fail-closed posture; see safety design §5 gap note) |
| Mandatory-addon interference | SIMULATED_PASS | Test 21-c9: landed set ≠ quoted set ⇒ no verified receipt |
| **Live retrieve / live quote (this run)** | **BLOCKED** | No credentials in the run environment: `CHARGEBEE_SITE` / `CHARGEBEE_API_KEY` absent (names checked only). Harness live mode performs no network call without them (test 21-p2). Requirement: a Full-Access API key for a synthetic **test** site, supplied via env at run time, plus `CHARGEBEE_TEST_SUBSCRIPTION_ID`. |
| **Live commit** | **BLOCKED** | Prohibited: `SCQ_LIVE_COMMIT_ENABLED` untouched (false); no live mutation of any kind was executed or attempted. |

Full suite at this evidence point: **247/247** (227 pre-pilot baseline +
20 test21), fresh clean build; smoke pack OK; neutrality OK; freeze
scope clean. After the PR #13 review corrections (§C) the suite
stands at **256/256** (test22 added 9 tests).

## B. Historical live evidence — Oct 27, 2026 (cited)

Source: `research/chargebee-live-v1/` (TEST-RESULTS.md, evidence/) and
the Phase 3 run record. Scope: a synthetic subscription on a Chargebee
**test** site (`<test-site>`, `<subscription-id>`), under a
read/estimate-only authorization for that run.

| Capability | Classification (historical) | Note |
|---|---|---|
| L-GET — retrieve subscription | LIVE_PASS | Real test-site GET |
| L-QUOTE — estimate-backed quote (per_unit addon qty 1 → 21) | LIVE_PASS | Real estimate; immediate 185240 as a newly incurred *unbilled* obligation (provider-computed proration 20 × 9262); recurring 60900 → 80900. Mocked fixture uses a full-period rule (20000) and does not reproduce the time-dependent proration figure. |
| L-COMMIT | BLOCKED | Never attempted; remains blocked (see GO-NO-GO.md) |

These classifications belong to that run and its authorization. This
pilot does not extend them: in the pilot's own environment, live
capabilities are BLOCKED as recorded in §A.

## C. Review corrections (PR #13) — R1, R2, R3

Three defects from review of this PR were corrected. All correction
evidence is SIMULATED_PASS against mocked/stub transports (test22,
9 tests) — no live calls were made; no credentials exist in this
environment.

**R1 — the harness comparison was not independent of the code it
checks.** `compareQuoteToRawEstimate` re-applies the adapter's own
`interpretChargebeeEstimate`, so a systematic defect inside that
function would corrupt the quote and the comparison identically, and
the comparison would still report a match. Resolution: a genuinely
independent, **test-only oracle**
(`reference/tests/oracles/chargebee-estimate-oracle.ts`) computes the
expected effect — values AND provenance (which raw fields each figure
must come from; `next_invoice_estimate` is never a source) — directly
from the raw provider response, from PROVENANCE-MATRIX.md semantics,
importing no adapter interpretation code. Test evidence now rests on
the oracle (22-o1 validates a real adapter quote against it, values
and provenance). The harness keeps its internal comparison for the
CLI report, relabeled honestly as a consistency check (see the
regenerated run artifact's basis text). 22-o2 is the new regression:
a quote embodying the systematic error (recurring taken from
`next_invoice_estimate.amount_due`, provenance citing it) FAILS the
oracle on value and on provenance, while a comparison driven by the
same defective mapping "passes" it — the correlated blind spot,
demonstrated; the shipped comparison catches the doctored quote only
because the shipped interpretation is currently correct. (21-p3's
raw-divergence regression is preserved untouched.)

**R2 — next-invoice isolation was asserted by numeric inequality.**
The harness's isolation row required the incurred figure to DIFFER
numerically from `next_invoice_estimate.amount_due` — a bogus
requirement, since the figures may legitimately coincide.
Failing-first evidence: on the pre-correction code, a fixture with
amount_due legitimately equal to the incurred 20000 produced matching
raw and normalized figures, yet the row reported mismatch — solely
from the inequality conjunct. The requirement was removed (disclosed
in-file in run-pilot.ts); isolation is now a SOURCE property, tested
by 22-i1 (vary only the raw next-invoice figures — credits 300 vs
900 vs absent — and the quoted effect is byte-identical) and 22-i2
(the coincidence case: amount_due exactly 20000 — quote accepted,
oracle passes in full, and the recorded provenance still sources the
incurred figure from `unbilled_charge_estimates`, never from
`next_invoice_estimate`). Test 21-p4's fixture description in §A is
unchanged; it never asserted the inequality — the requirement lived
in the harness comparison.

**R3 — live-read safeguards are now enforced, not described.** (a)
Preflight: before any live request, the harness requires an approved
test-site configuration (`-test` designation or explicit allowlist)
AND a synthetic-designated test subscription id, failing closed with
the named error `LIVE_PREFLIGHT_FAILED`; 22-g1 covers the failure
modes (production-looking site, missing id, non-synthetic id) with a
recording stub — zero requests attempted, BLOCKED report, no
LIVE_PASS. (b) Allowlist at the transport boundary: a guarded live
transport (`reference/src/live/pilot/live-guard.ts`) permits only GET
subscription retrieve, GET item_price, and POST subscription
estimate; everything else (update_for_items, create, cancel,
invoice/payment paths, arbitrary reads) is rejected pre-dispatch
with the named error `OPERATION_NOT_ALLOWED` (22-g2, including
through the adapter's client path — nothing dispatches). (c)
Observed counts: report transport counts now derive from the
transport's observed call log — the previously hardcoded
mutating/total figures are removed — and live classifications derive
from observed successful operations (`classifyRunCapability`); an
empty log can never emit LIVE_PASS. 22-g3: mocked-mode counts match
the fixture's own call log exactly. 22-g4: the live counting/
classification logic exercised against the stubbed network (a logic
test, not live evidence). 22-g5 pins the classification gate.

## Classification discipline

No capability in this report is labeled LIVE_* on the basis of mocked
evidence, and no simulated result is presented as a live result. Where
behavior is asserted from documentation rather than execution (e.g.
native idempotency window semantics), the safety design says so and
the classification is DOCUMENTATION_SUPPORTED there, not PASS.

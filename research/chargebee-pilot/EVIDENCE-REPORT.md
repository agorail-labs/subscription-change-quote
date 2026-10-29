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
scope clean.

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

## Classification discipline

No capability in this report is labeled LIVE_* on the basis of mocked
evidence, and no simulated result is presented as a live result. Where
behavior is asserted from documentation rather than execution (e.g.
native idempotency window semantics), the safety design says so and
the classification is DOCUMENTATION_SUPPORTED there, not PASS.

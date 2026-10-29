# SCQ Chargebee Pilot — reproducible read-only validation

A developer-executable pilot that advances the experimental Chargebee
integration (PR #4, merged) from one-off test-site validation toward a
reproducible, independently reviewable workflow. Tracking issue: #12.
Protocol design: #7.

## What this pilot is — and is not

- It exercises the existing live adapter (`reference/src/live/`) through a
  documented workflow: **retrieve → snapshot → proposal → estimate-backed
  quote → field-by-field comparison → structured report**.
- It is **read/estimate only**. The harness never enables live commit in
  either mode, and `SCQ_LIVE_COMMIT_ENABLED` is never touched.
- Mocked results are classified **SIMULATED_PASS**; live results are
  classified only when a run actually reaches a verified test site.
  Nothing here claims production compatibility or provider endorsement.

## Layout

| Path | Content |
|---|---|
| `reference/src/live/pilot/run-pilot.ts` | The harness (library + CLI) and the field-comparison engine |
| `reference/src/live/pilot/mock-transport.ts` | Fixture-driven mocked Chargebee transport with scriptable faults |
| `reference/tests/test21-chargebee-pilot.test.ts` | Harness, negative, and recovery tests (all mocked) |
| `research/chargebee-pilot/PROVENANCE-MATRIX.md` | Field-level financial provenance matrix |
| `research/chargebee-pilot/COMMIT-RECOVERY-SAFETY.md` | Commit/recovery safety design + go/no-go inputs |
| `research/chargebee-pilot/EVIDENCE-REPORT.md` | Sanitized evidence: this run (simulated) vs the Oct 27 live run (historical) |
| `research/chargebee-pilot/VALIDATION-CHECKLIST.md` | Independent reproduction checklist |
| `research/chargebee-pilot/GO-NO-GO.md` | Pilot go/no-go report |
| `research/chargebee-pilot/runs/` | Sanitized harness run outputs (JSON + Markdown) |

## Commands

From `reference/`:

```bash
npm test                                   # full suite (247 tests at pilot baseline)
npm run pilot:chargebee                    # mocked run, printed report
npm run pilot:chargebee -- --out ../research/chargebee-pilot/runs/<name>   # also write JSON + MD
npm run pilot:chargebee -- --live          # live read/estimate run (see below)
```

Mocked mode needs **no credentials and no network**. It runs against the
fixture subscription (flat_fee plan 59900 + per_unit addon at a
subscription unit_price override of 1000, baseline recurring 60900) and
the canonical proposal (addon quantity 1 → 21): expected quote
`immediate.net = 20000`, `recurring 60900 → 80900`, **0 mutating calls**.

Live mode requires `--live` **and** all of the following in the
environment at run time:

- `CHARGEBEE_SITE` — a **test** site slug (never a production tenant)
- `CHARGEBEE_API_KEY` — a Full-Access key **for that test site**
- `CHARGEBEE_TEST_SUBSCRIPTION_ID` — a synthetic test subscription

Without them the run classifies live capabilities **BLOCKED**, lists the
missing variables, and performs **no network call** (test 21-p2). With
them, the harness runs retrieve + snapshot + quote + comparison against
the real test site — still read/estimate only; commit stays BLOCKED.

## Evidence discipline

Classifications used: `LIVE_PASS`, `LIVE_FAIL`, `SIMULATED_PASS`,
`DOCUMENTATION_SUPPORTED`, `BLOCKED`, `UNVERIFIED`. A mocked result is
never relabeled live; the historical Oct 27, 2026 live evidence
(L-GET / L-QUOTE LIVE_PASS under read/estimate-only authorization) is
cited as historical in EVIDENCE-REPORT.md and is not re-claimed by this
pilot's runs.

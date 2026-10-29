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
- Mocked results are classified **SIMULATED_PASS**. A run over an
  injected (stubbed) transport is likewise simulated evidence and can
  never classify LIVE_PASS; live classifications are issued only on
  the real configured network path, after preflight, with observed
  successful operations.
  Nothing here claims production compatibility or provider endorsement.

## Layout

| Path | Content |
|---|---|
| `reference/src/live/pilot/run-pilot.ts` | The harness (library + CLI) and the field-comparison engine |
| `reference/src/live/pilot/live-guard.ts` | Live safeguards: preflight contract (explicit per-run approved site + synthetic subscription id) and the read/estimate operation allowlist enforced at the transport |
| `reference/src/live/pilot/mock-transport.ts` | Fixture-driven mocked Chargebee transport with scriptable faults |
| `reference/tests/test21-chargebee-pilot.test.ts` | Harness, negative, and recovery tests (all mocked) |
| `reference/tests/test22-chargebee-pilot-corrections.test.ts` | PR #13 review-correction tests: independent oracle, source separation, live safeguards (all mocked/stubbed) |
| `reference/tests/test23-chargebee-pilot-rereview.test.ts` | PR #13 re-review tests (F1/F2): explicit site approval, transport-origin classification (all mocked/stubbed) |
| `reference/tests/oracles/chargebee-estimate-oracle.ts` | Test-only independent interpretation oracle (imports no adapter code) |
| `research/chargebee-pilot/PROVENANCE-MATRIX.md` | Field-level financial provenance matrix |
| `research/chargebee-pilot/COMMIT-RECOVERY-SAFETY.md` | Commit/recovery safety design + go/no-go inputs |
| `research/chargebee-pilot/EVIDENCE-REPORT.md` | Sanitized evidence: this run (simulated) vs the Oct 27 live run (historical) |
| `research/chargebee-pilot/VALIDATION-CHECKLIST.md` | Independent reproduction checklist |
| `research/chargebee-pilot/GO-NO-GO.md` | Pilot go/no-go report |
| `research/chargebee-pilot/runs/` | Sanitized harness run outputs (JSON + Markdown) |

## Commands

From `reference/`:

```bash
npm test                                   # full suite (261 tests after the PR #13 corrections + re-review; 247 at pilot delivery)
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

- `CHARGEBEE_SITE` — a **test** site slug (never a production tenant):
  it must carry the `-test` designation (a sanity property only)
- `SCQ_PILOT_APPROVED_TEST_SITES` — the explicit per-run approval:
  a comma-separated list of exact site slugs, one of which must
  EXACTLY equal `CHARGEBEE_SITE`. A `-test` suffix alone is not
  approval, and there is no default approved site.
- `CHARGEBEE_API_KEY` — a Full-Access key **for that test site**
- `CHARGEBEE_TEST_SUBSCRIPTION_ID` — a synthetic test subscription,
  carrying a synthetic designation (`cbdemo_`, `pilot-`, `synthetic-`,
  or `test-` prefix)

Without them the run classifies live capabilities **BLOCKED**, lists the
missing variables, and performs **no network call** (test 21-p2). A
configuration that is present but fails configuration/approval
validation (production-looking site, a `-test` site with no explicit
per-run approval entry exactly matching it, a mismatched approval
entry, or a non-synthetic subscription id) fails the live preflight
closed with `LIVE_PREFLIGHT_FAILED` before any request is constructed
(tests 22-g1, 23-f1a–f1c). This validation checks the operator's
configuration; it is not independent provider attestation that the
tenant is a test tenant. With a configuration that passes it,
requests flow through a guarded
transport that permits only subscription retrieve, item-price reads,
and the subscription estimate — any other operation is rejected with
`OPERATION_NOT_ALLOWED` before dispatch (test 22-g2) — and the
harness runs retrieve + snapshot + quote + comparison against the
real test site, still read/estimate only; commit stays BLOCKED.
Report transport counts are the counts observed in that transport's
call log, and a `LIVE_PASS` classification requires the corresponding
operations to appear in it AND the transport origin to be the real
configured network path: a run over an injected transport (as in the
safeguard tests) classifies SIMULATED_PASS, never LIVE_PASS (tests
22-g3–g5, 23-f2a/f2b).

## Evidence discipline

Classifications used: `LIVE_PASS`, `LIVE_FAIL`, `SIMULATED_PASS`,
`DOCUMENTATION_SUPPORTED`, `BLOCKED`, `UNVERIFIED`. A mocked result is
never relabeled live; the historical Oct 27, 2026 live evidence
(L-GET / L-QUOTE LIVE_PASS under read/estimate-only authorization) is
cited as historical in EVIDENCE-REPORT.md and is not re-claimed by this
pilot's runs.

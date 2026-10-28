# Reproduction — Chargebee implementation validation (live adapter work)

How to reproduce the findings in this directory: the Chargebee SCQ
adapter, its mocked test suite, and the classifications recorded in
TEST-RESULTS.md and `evidence/PHASE3-EVIDENCE-SUMMARY.md`.

> **Current state (updated 2026-10-28, PR #4 review round).** The
> work lives on branch `review/change-b-live-validation-tooling`
> (draft PR #4 against `main`). An earlier version of this file
> described the Phase 1 setup (branch
> `experiment/chargebee-live-validation-v1`, 84 tests, no live
> evidence) — that text is superseded; the current facts are below.

## Setup

```
git clone <this repository>
git checkout review/change-b-live-validation-tooling
cd reference
npm ci
npm test
```

Environment: Node.js ≥ 20, npm, TypeScript (repo-pinned via
`reference/package-lock.json`).

Baseline: `main` at the merge of Change A (PR #3). The branch adds
the live adapter (`reference/src/live/`), its test file
(`reference/tests/test13-chargebee-http.test.ts`), the demo driver
(`reference/demo/chargebee-live-validation.ts`), and this research
directory. The frozen protocol files (spec, core types, engine) are
byte-identical to `main`.

## Expected results (verified 2026-10-28, clean build)

| Check | Expected |
|---|---|
| `npm test` (after `rm -rf dist node_modules && npm ci`) | **115 tests, 115 pass / 0 fail** (66 baseline suite + 49 test13) |
| test13 alone (`node --test dist/tests/test13-chargebee-http.test.js`) | 49 pass / 0 fail |
| `npm run smoke:pack` | OK — protocol simulation package faithful |
| Provider-neutrality scan (`.github/workflows/ci.yml`) | clean under `reference/src/core` |
| Freeze guard | 0 differing lines in the three frozen files vs `main` |
| Demo driver, no credentials | prints `BLOCKED — CREDENTIALS NOT AVAILABLE` and exits without claiming any result |

All 49 test13 tests run against a mocked transport; no credentials
are needed and no network calls are made. Mocked results are
classified SIMULATED_PASS only — never live.

## Live classifications (Phase 3, 2026-10-27 — separate approval, test site only)

These were produced by a separately approved live run, NOT by
`npm test`, and are recorded with sanitized evidence in
`evidence/PHASE3-EVIDENCE-SUMMARY.md` (identifiers redacted to
placeholders):

| Live row | Classification |
|---|---|
| L-GET (snapshot via real GET) | LIVE_PASS |
| L-QUOTE (estimate → quote, per-unit addon quantity change) | LIVE_PASS |
| flat_fee quantity change | refused pre-call by the adapter (UNSUPPORTED_CHANGE); provider rejection live-verified in the Phase 3 isolation matrix |
| L-COMMIT | BLOCKED — live commit disabled by design (`SCQ_LIVE_COMMIT_ENABLED` defaults to false); never exercised |

To re-run the live read/estimate path (requires the maintainer's
own test-site credentials and explicit approval; estimate-only):

```
cd reference
CHARGEBEE_SITE=<your-test-site> CHARGEBEE_API_KEY=<test-site-key> npx tsx demo/chargebee-live-validation.ts
# SCQ_LIVE_COMMIT_ENABLED stays unset/false — the driver never commits.
```

Do not point the driver at a production site. The live experiment
to date was estimate-only: it caused no mutation and incurred no
obligation (see the obligation-timing note in
`evidence/PHASE3-EVIDENCE-SUMMARY.md`).

## Historical note

Phase 1 (2026-10-27) ran on branch
`experiment/chargebee-live-validation-v1` with 84 tests and all live
rows BLOCKED (no credentials). That branch is retained for history;
Phase 2B split it into Change A (merged as PR #3) and this Change B
branch. Phase 1 statements in this directory that say "all live
BLOCKED" describe that run and are superseded for the read/estimate
scope by the Phase 3 classifications above.

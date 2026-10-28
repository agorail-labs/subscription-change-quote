# Reproduction

## Environment

- Node.js ≥ 20, npm, TypeScript (repo-pinned via `reference/package-lock.json`).
- **No Chargebee account, credentials, or network access to Chargebee is required**
  for everything except the explicitly BLOCKED live rows.

## Steps

```bash
git clone https://github.com/arjun2075/subscription-change-quote
cd subscription-change-quote
git checkout experiment/chargebee-live-validation-v1   # local branch of this experiment
# (baseline for comparison: main @ 79200fa4cbcf955c618428c0fca74fd2abce7c9d)

cd reference
npm ci

# Full suite: baseline 66 + new 18 = 84 tests, all passing, no credentials needed
npm test

# New tests only
npx tsc -p tsconfig.json && node --test dist/tests/test13-chargebee-http.test.js

# Package smoke (publishes nothing)
npm run smoke:pack

# Live driver without credentials: must print the BLOCKED line and claim nothing
node dist/demo/chargebee-live-validation.js
# -> BLOCKED — CREDENTIALS NOT AVAILABLE (missing: CHARGEBEE_SITE, CHARGEBEE_API_KEY)
```

## Verifying the safety gates

```bash
# 1. Tests pass with live credentials explicitly absent:
env -u CHARGEBEE_SITE -u CHARGEBEE_API_KEY -u CHARGEBEE_TEST_SUBSCRIPTION_ID npm test

# 2. Live mutation is disabled by default (also covered by Test 13-gate):
grep -n "SCQ_LIVE_COMMIT_ENABLED" src/live/chargebee-http.ts demo/chargebee-live-validation.ts

# 3. No normative changes in the experiment diff:
git diff main -- spec/                     # must be empty (normative spec is frozen;
                                           # Phase 2A also left spec/ untouched — Chargebee
                                           # attribution fixes are proposals in
                                           # research/chargebee-live-v1/ERRATA-PROPOSAL.md)
git diff main --stat                       # reference/src/live/, reference/demo/,
                                           # reference/tests/test13-* (Phase 1), plus the
                                           # Phase 2A correction files listed in
                                           # PUBLICATION-READINESS.md

# 4. No secrets / PII in tracked files:
git grep -nEi "test_[a-z0-9]{16,}|live_[a-z0-9]{16,}|api[_-]?key\s*[:=]\s*['\"][^'\"]{8,}" -- . ':!research/chargebee-live-v1/*' || echo "clean"
```

## Per-test evidence map

| Evidence | Location |
|---|---|
| Baseline + final counts | TEST-RESULTS.md |
| Doc claim → endpoint → evidence level | API-CONTRACT-AUDIT.md (docs re-read 2026-10-27; Chargebee docs change — re-read before citing) |
| T01–T14 implementations | `reference/tests/test13-chargebee-http.test.ts` (fake transport is in-file and deterministic; fixed clock 2026-08-01, fixed prices 1000/1500 minor units) |
| Live adapter behavior | `reference/src/live/chargebee-http.ts`, `reference/src/live/chargebee-scq-adapter.ts` |
| Sanitized fixtures / run metadata | `research/chargebee-live-v1/evidence/` (gitignored; see its README) |
| Historical (prior-cycle) live observations | `research/EVIDENCE.md` — **not** produced by this run |

## Expected results

- `npm test`: 84 pass, 0 fail (unchanged total after the Phase 2A claim corrections — assertions changed in Test 11, no tests added or removed).
- test13 alone: 18 pass, 0 fail.
- Demo without credentials: BLOCKED line, exit 0, no other claims.
- Any LIVE_* classification anywhere in this package would be a defect: report it.

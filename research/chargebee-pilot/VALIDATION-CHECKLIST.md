# Chargebee pilot — independent validation checklist

For a technically independent engineer to reproduce and evaluate the
pilot without trusting this report. Expected values are exact at the
pilot baseline (branch `scq/chargebee-pilot-readiness`).

## 1. Environment

- [ ] Node 20 or 22; repo checked out at the pilot branch.
- [ ] No Chargebee credentials are needed (or used) for steps 2–4.
      Confirm none are required: the mocked run must succeed with
      `CHARGEBEE_SITE` / `CHARGEBEE_API_KEY` unset.
- [ ] Confirm `SCQ_LIVE_COMMIT_ENABLED` is unset (or not `"true"`) in
      your environment. Nothing in this checklist may set it.

## 2. Full suite

```bash
cd reference
rm -rf dist && npm test
```

- [ ] **256/256 pass, 0 fail** (227 pre-pilot baseline + 20 in
      `tests/test21-chargebee-pilot.test.ts` + 9 in
      `tests/test22-chargebee-pilot-corrections.test.ts`; 247/247 was
      the count at pilot delivery, before the PR #13 corrections).
- [ ] `npm run smoke:pack` → ESM import OK, TS consumer OK, tarball OK.
- [ ] Freeze scope: `git diff main --stat` shows NO changes under
      `spec/`, `reference/src/core/`, or `reference/src/store/`.

## 3. Harness run (mocked)

```bash
npm run pilot:chargebee -- --out /tmp/pilot-check
```

- [ ] Steps all `[pass]`: retrieve, snapshot, proposal, quote, compare.
- [ ] Quote figures: `immediate.net = 20000`,
      `recurring 60900 → 80900`, currency USD.
- [ ] Comparison table: **6/6 match**, including the next-invoice
      isolation row and the provenance row.
- [ ] Classifications: retrieve/snapshot/quote/compare =
      `SIMULATED_PASS`; live commit = `BLOCKED`. No `LIVE_*` label
      appears anywhere in `pilot-report.json`.
- [ ] Transport line: counts are **observed** in the transport log —
      8 calls total (3 subscription retrieves, 4 item-price reads,
      1 estimate), **0 mutating calls** — not hardcoded figures.
- [ ] Open `/tmp/pilot-check/pilot-report.json` and confirm the
      provenance strings name provider fields
      (`unbilled_charge_estimates…`, `subscription_estimate…`), not
      bare numbers.

## 4. Negative behavior spot-checks (from test21 — read the tests, then re-run only that file)

```bash
npm run build && node --test dist/tests/test21-chargebee-pilot.test.js
```

- [ ] 20/20 pass.
- [ ] 21-n1/n2: remove an amount / a member → quote refuses; confirm
      in the mock's call log (`mock.calls`) that no `update_for_items`
      POST occurred.
- [ ] 21-z1: unchanged quantity → `immediate.net` is exactly `0` and
      present (determined zero ≠ absent).
- [ ] 21-c6: lost response → INDETERMINATE, `commit_receipt` undefined,
      mutation count stays 1 after a second attempt.
- [ ] 21-c7/c9: success-shaped 200 with wrong landed state → no
      receipt. This is the check that a "successful" provider response
      is not treated as proof of the intended state.
- [ ] 21-p2: `runPilot({mode:"live", env:{}})` returns BLOCKED with
      both missing variable names and `totalCalls: 0` (no network).

## 4b. Correction spot-checks (test22 — PR #13 review corrections)

```bash
npm run build && node --test dist/tests/test22-chargebee-pilot-corrections.test.js
```

- [ ] 9/9 pass.
- [ ] 22-o1/o2: the independent oracle
      (`tests/oracles/chargebee-estimate-oracle.ts` — imports no
      adapter code) validates a real adapter quote, and FAILS a quote
      whose recurring figure/provenance come from
      `next_invoice_estimate.amount_due`.
- [ ] 22-i1/i2: varying only the raw next-invoice figures leaves the
      quoted effect identical, and the coincidence case
      (amount_due == incurred 20000) passes with source-separated
      provenance. (The harness previously required the two figures to
      DIFFER numerically — removed; see EVIDENCE-REPORT.md §C.)
- [ ] 22-g1: live preflight failures (production-looking site,
      missing/non-synthetic subscription id) → BLOCKED report and a
      recording stub shows **zero** requests attempted.
- [ ] 22-g2: driving `update_for_items` / create / cancel / invoice
      paths through the guarded live transport → rejected with
      `OPERATION_NOT_ALLOWED` before dispatch; allowed reads pass.
- [ ] 22-g3/g4/g5: report counts equal the transport's own call log;
      an empty observed log never classifies `LIVE_PASS`.

## 5. Optional live read/estimate reproduction (separate, optional)

Only with a synthetic **test** site you control:

- [ ] Create a Full-Access key for the test site; export
      `CHARGEBEE_SITE`, `CHARGEBEE_API_KEY`,
      `CHARGEBEE_TEST_SUBSCRIPTION_ID` (a synthetic subscription with a
      flat_fee plan + per_unit addon). The site slug must carry the
      `-test` designation (or be on the harness's explicit allowlist)
      and the subscription id must carry a synthetic designation
      (`cbdemo_`, `pilot-`, `synthetic-`, `test-` prefix); otherwise
      the live preflight fails closed with `LIVE_PREFLIGHT_FAILED`
      before any request is made (test 22-g1).
- [ ] `npm run pilot:chargebee -- --live --out <dir>` → retrieve/quote
      classify `LIVE_PASS` only if the steps actually pass against the
      real site; commit still classifies `BLOCKED`.
- [ ] Sanitize before sharing: replace site slug and subscription id
      with `<test-site>` / `<subscription-id>`; never share the key.
- [ ] Note: live proration is time-dependent (Oct 27 observed
      20 × 9262); do not expect the mocked fixture's 20000.

## 6. What to inspect for the go/no-go

- [ ] `GO-NO-GO.md` — pilot GO rationale and commit NO-GO conditions.
- [ ] `COMMIT-RECOVERY-SAFETY.md` §8 — the five conditions that must
      ALL hold before a controlled test-site commit may even be
      proposed for separate authorization.
- [ ] `PROVENANCE-MATRIX.md` — confirm no row maps
      `next_invoice_estimate` figures into a financial effect.

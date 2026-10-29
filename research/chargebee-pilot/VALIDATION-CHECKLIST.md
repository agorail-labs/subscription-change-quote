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

- [ ] **261/261 pass, 0 fail** (227 pre-pilot baseline + 20 in
      `tests/test21-chargebee-pilot.test.ts` + 9 in
      `tests/test22-chargebee-pilot-corrections.test.ts` + 5 in
      `tests/test23-chargebee-pilot-rereview.test.ts`; 247/247 was
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
      an empty observed log never classifies `LIVE_PASS`. (22-g4 was
      reworked in re-review round 2 — see §4c: it now asserts
      SIMULATED_PASS for the injected run, not LIVE_PASS.)

## 4c. Re-review correction spot-checks (test23 — F1/F2)

```bash
npm run build && node --test dist/tests/test23-chargebee-pilot-rereview.test.js
```

- [ ] 5/5 pass.
- [ ] 23-f1a: a site ending in `-test` but NOT explicitly approved
      for the run → preflight fails (`LIVE_PREFLIGHT_FAILED`) and a
      recording stub shows **zero** requests dispatched.
- [ ] 23-f1b: an explicit per-run approved-site entry exactly equal
      to the configured site + a synthetic subscription id → preflight
      passes.
- [ ] 23-f1c: an approved-list entry that does not match the
      configured site → fails, zero dispatch; approving a
      production-shaped slug still fails the `-test` sanity property.
- [ ] 23-f2a: a successful run over an INJECTED transport classifies
      SIMULATED_PASS, and the string `LIVE_PASS` appears **nowhere**
      in the serialized JSON report or its Markdown rendering.
- [ ] 23-f2b: `LIVE_PASS` is gated to transport origin `real` with
      observed successful operations; injected origin yields only
      SIMULATED_PASS / UNVERIFIED.

## 5. Optional live read/estimate reproduction (separate, optional)

Only with a synthetic **test** site you control:

- [ ] Create a Full-Access key for the test site; export
      `CHARGEBEE_SITE`, `CHARGEBEE_API_KEY`,
      `CHARGEBEE_TEST_SUBSCRIPTION_ID` (a synthetic subscription with a
      flat_fee plan + per_unit addon) AND
      `SCQ_PILOT_APPROVED_TEST_SITES` naming the exact
      `CHARGEBEE_SITE` slug. Live preflight performs
      configuration/approval validation: it requires BOTH the `-test`
      designation (a sanity property — a suffix alone is NOT
      approval) AND that explicit per-run approved-site entry exactly
      matching the site, and the subscription id must carry a
      synthetic designation (`cbdemo_`, `pilot-`, `synthetic-`,
      `test-` prefix); otherwise preflight fails closed with
      `LIVE_PREFLIGHT_FAILED` before any request is made (tests
      22-g1, 23-f1a–f1c). This validates operator configuration; it
      is not independent provider attestation of the tenant.
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

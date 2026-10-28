# SCQ Live Chargebee Validation v1 — Validation Plan

> **SUPERSEDED IN PART (2026-10-28, PR #4 review round).** This is
> the Phase 1 plan, preserved as written. Its scope statements —
> local-only branch, no credentials, all live rows BLOCKED —
> describe Phase 1 only. The work has since been split and
> published for review (this branch:
> `review/change-b-live-validation-tooling`, draft PR #4), and a
> separately approved Phase 3 run exercised the live read/estimate
> paths on a test site: **L-GET LIVE_PASS, L-QUOTE LIVE_PASS,
> flat_fee quantity refusal live-verified, L-COMMIT still
> BLOCKED** (see `evidence/PHASE3-EVIDENCE-SUMMARY.md` and the
> Phase 3 addendum in TEST-RESULTS.md). The plan's safety
> constraints (test site only, commit disabled by default, no
> production access, no live mutation without separate approval)
> remain in force.

- **Repository:** subscription-change-quote, base `main`
- **Baseline commit (verified HEAD before work began):** `79200fa4cbcf955c618428c0fca74fd2abce7c9d` — matches the mission's reference starting commit exactly.
- **Working branch (local only, never pushed):** `experiment/chargebee-live-validation-v1`
- **SCQ version under test:** v0.6.1 (frozen normative spec — NOT modified by this experiment)
- **Chargebee API:** v2, Product Catalog 2.0, per https://apidocs.chargebee.com/docs/api/getting-started
- **Date of this run:** 2026-10-27 (docs re-read live the same day)

## Purpose

Determine, with evidence, whether SCQ v0.6.1 offers useful guarantees, portability, or
integration structure **beyond Chargebee's native capabilities** — not merely whether an
integration can be made to work. A negative or narrowing answer is a successful outcome
if it is falsifiable and reproducible.

## Scope and safety boundaries

- Local work only. No push, no PR, no release, no external posts, no normative-spec edits.
- No live Chargebee credentials were provided for this run. **All live cases are therefore
  BLOCKED — CREDENTIALS NOT AVAILABLE.** Nothing live was exercised; no live result is
  claimed anywhere in this package. Prior-cycle live observations recorded in
  `research/EVIDENCE.md` (v0.5-LIVE) are cited as *historical* evidence, clearly labeled,
  and are not re-presented as observations of this run.
- The live adapter implements read/estimate paths and a commit path that is **disabled by
  default** (`SCQ_LIVE_COMMIT_ENABLED` must be the literal string `true`). Even when
  enabled in code, no live mutation was performed in this run and none may be performed
  without separate explicit approval naming the exact operations (see TEST-RESULTS.md,
  "Approval needed").
- Synthetic subscriptions only; no production site; no real payment method; no real
  customer data anywhere, including in fixtures (see `evidence/README.md`).

## Method

1. **Phase 0 — Baseline.** Inspect the normative spec, security considerations,
   conformance doc, evidence register, core types/engine, quote store, Chargebee
   simulator + adapter, and Tests 11/12. Run `npm ci`, `npm test`, `npm run smoke:pack`
   and record actual counts (66/66 pass — see TEST-RESULTS.md).
2. **Phase 1 — Contract audit.** Re-read the current official Chargebee Product Catalog
   2.0 documentation for retrieve / estimate-update / update-for-items / idempotency /
   ramps, and audit every load-bearing SCQ/simulator assumption against it
   (API-CONTRACT-AUDIT.md). Documentation claims are evidence level
   DOCUMENTATION_SUPPORTED, never LIVE.
3. **Phase 2 — Live-shaped adapter.** Implement an isolated HTTP adapter
   (`reference/src/live/`) against the documented wire contract, with injected
   transport, env-only credentials, redacted diagnostics, and honest capability
   reporting (REVALIDATE/UNKNOWN, IMMEDIATE-only).
4. **Phase 3 — Comparison.** Native Chargebee (with reasonable application safeguards,
   not a strawman) vs SCQ for the 100→120 seats IMMEDIATE scenario (NATIVE-VS-SCQ.md).
5. **Phase 4 — Test matrix T01–T14.** Deterministic mocked-transport tests
   (`reference/tests/test13-chargebee-http.test.ts`). Classifications are restricted to
   LIVE_PASS / LIVE_FAIL / SIMULATED_PASS / DOCUMENTATION_SUPPORTED / BLOCKED /
   UNVERIFIED, and a test in the suite itself (`Test 13-classifications`) fails if any
   mock-backed row is labeled LIVE_*.
6. **Phase 5 — Evidence hygiene.** Sanitized fixtures only under the gitignored
   `evidence/` directory; tracked files scanned for credentials/PII before commit.
7. **Phase 6 — Assessment.** Native-solved / SCQ-added / not-solved / second-provider /
   recommendation (NATIVE-VS-SCQ.md §Assessment; LIMITATIONS-AND-GAPS.md).
8. **Phase 7 — Gates.** Full original suite re-run, new tests run separately, tests
   verified to pass with no live credentials in the environment, commit-disabled-by-
   default verified, full diff inspected for normative changes, secrets scan.

## Failure-handling rules applied throughout

- **Idempotency:** native window is 30 minutes (documented). Keys + parameters are
  preserved for legitimate retries inside the window only. After an uncertain outcome,
  provider state is reconciled by re-reading before any further mutation is even
  considered; if safe resolution cannot be demonstrated, fail closed.
- **Durability:** the in-memory QuoteStore cannot prove durable exactly-once behavior.
  A conforming live deployment requires a durable, transactional quote/receipt store
  (e.g. a relational DB row written atomically with the COMMITTED transition, keyed by
  quote id, surviving process restart) — see LIMITATIONS-AND-GAPS.md. A mock of
  persistence does not count.
- **Concurrency:** ATOMIC is never claimed. A passed staleness check does not close the
  TOCTOU window; only a server-enforced precondition would, and none is documented.
- **Reconciliation:** a VIOLATED reconciliation is reporting, not prevention or
  rollback, and is never hidden behind an exception implying no mutation occurred.
- **Unknowns:** no EXACT is advertised for any dimension the documentation does not
  independently support.

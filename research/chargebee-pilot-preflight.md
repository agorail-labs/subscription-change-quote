# PR-11 — Read-only exact-commit preflight and durable reconciliation rehearsal

Implements the preflight/rehearsal package of the pilot readiness
program (issues #12, #7): the machinery COMMIT-RECOVERY-SAFETY
conditions 2 and 3 require before a controlled Chargebee TEST-site
commit can even be proposed. **Overall readiness remains NO-GO**:
this PR builds evidence machinery; it grants nothing, names no
operator, and executes no real-tenant preflight (no credentials were
present, per GO-NO-GO Decision 3). No real Chargebee mutation was
performed or attempted; `SCQ_LIVE_COMMIT_ENABLED` was never set;
every mutation behavior below is exercised over mocked transports
and temporary databases.

## 1. Audit — what exists, what is simulated, what is still unverified

Read in full before designing: `src/live/chargebee-scq-adapter.ts`,
`src/live/chargebee-http.ts`, `src/live/pilot/{run-pilot,live-guard,mock-transport}.ts`,
`src/store/{durable-store,mutation-coordinator}.ts`,
`research/chargebee-pilot/COMMIT-RECOVERY-SAFETY.md`,
`research/chargebee-live-v1/RECOVERY-AUDIT.md`, and the pilot / HTTP /
durable / BC-1 suites (test13, test21–23, test26–28, test35–36).

**Implemented and relied on (not re-implemented):**

- The guarded read-only transport (`createGuardedLiveTransport`):
  allowlist = GET subscription, GET item_price, POST
  estimate-update; everything else — `update_for_items` included —
  is rejected BEFORE dispatch and logged. The preflight wraps the
  caller's transport in this same guard; it does not define its own.
- The F1 site model (`isApprovedTestSite`): a configured site is
  approved only by an exactly-matching per-run approved-site entry.
  It is configuration validation, not provider attestation; the
  preflight keeps the two separate (see §2).
- The durable ledger (`DurableQuoteStore`): write-ahead attempts,
  same-subscription exclusion inside the ledger transaction,
  idempotency-key/request-hash binding, recovery of stale
  DISPATCHING attempts as INDETERMINATE, corruption-refusing
  adoption with per-record integrity hashes, and the read-only
  `recoveryReport()` operator surface. PR-11 adds no ledger
  semantics and clears nothing.
- The adapter's commit pipeline (PR-7/PR-9/PR-10 state): quote-time
  fingerprint, stored `provider_preview_input` + original
  idempotency key, BC-1 fail-closed envelope gates, post-commit
  state verification, three-outcome reconciliation. The preflight
  consumes these artifacts; the durable adapter is not rewritten.

**Extracted and shared (zero behavior change):** the exact-commit
derivation must not re-implement the request the commit would send.
Three adapter internals are now exported unchanged and used by both
sides: `buildChargebeeUpdateParams` (the `updateParams` body, moved
verbatim; the private method delegates), `chargebeeSubscriptionFingerprint`
(the stored-fingerprint function), and `chargebeeEffectWithDeterminacy`
(determinacy attachment for the fresh-estimate drift check). The
`CbSubscription` type is exported alongside. Every pre-existing
adapter suite passes unmodified, which is the behavioral proof.

**Simulated (honestly classified):** everything the rehearsal and
the sample preflight produce. Mocked transports, temporary SQLite
databases, synthetic fixture data. Classifications use the
repository vocabulary: SIMULATED_PASS at best, never LIVE_PASS.

**Still unverified after this PR:** any real-tenant behavior
(Decision 3 stands — live read/estimate re-validation is BLOCKED
without credentials); durable exactly-once provider execution (not
claimed anywhere: durable storage + idempotency keys bound dispatch
from this ledger, and Chargebee's native idempotency window is
time-limited — neither is server-enforced exactly-once); unbilled
charge and credit enumeration (the read-only allowlist exposes
none — reported as standing UNKNOWN, see §4).

## 2. Design — the preflight (`src/live/pilot/preflight.ts`)

`runPreflight(input)` takes an identified quote id, the
AUTHORITATIVE `DurableQuoteStore`, a transport, its origin
(`mocked` / `injected` / `real`), the configured site, and
operator-supplied records. It returns a structured report (JSON) and
`renderPreflightMarkdown` renders the same content for humans.

**Gates before any provider read.** The run is refused — report
still produced, zero observed transport calls — when:
`SCQ_LIVE_COMMIT_ENABLED=true` is present in the preflight
environment; the configured site has no exactly-matching per-run
approved-site entry (F1 — a `-test` suffix alone is not approval);
or the stored subscription id carries no synthetic-fixture
designation (`cbdemo_` / `pilot-` / `synthetic-` / `test-`). A
designation is a scoping signal, never proof of tenant safety.

**Tenant mode is an attestation, not an inference.** The report
carries a separate operator-attestation input (test-tenant
ownership/mode, attested by whom). Absent or false, tenant mode is
UNVERIFIED — including on test-looking site names.

**Durable readiness (read-only).** Quote exists durably (a
memory-only quote is a blocker); provider/subscription/site binding;
expiry; no unresolved attempt (PREPARED / DISPATCHING /
INDETERMINATE) for the quote OR the subscription — a hard blocker
the report never clears, reclassifies, or overrides; a recorded
receipt flips the posture to "would replay, not recommit" and
blocks readiness for a new commit; a recorded INDETERMINATE commit
outcome blocks (blind-retry guard). Running the preflight persists
NO intent: only `get` / `allAttempts` / `recoveryReport` / `all`
reads are made (test37.13 pins attempt-count invariance).

**Exact request.** The hypothetical mutation is derived from the
stored `provider_preview_input` items via the shared
`buildChargebeeUpdateParams`, rendered as the exact form-encoded
body, and hashed with the ledger's own `requestHashOf`. The report
shows `replace_items_list=true`, `prorate=true`,
`invoice_immediately=false`, `change_option=immediately`, the exact
target item set, and the ORIGINAL stored idempotency key (never
regenerated; a key that is not the adapter-derived `scq-<quoteId>`
is a blocker). Coherence checks: target set vs the recorded
proposal (item ids/quantities/offering), and the derived hash vs
every recorded attempt's request hash for the quote.

**Independent re-read.** Through the guarded transport: subscription
status, `resource_version` + fingerprint stability (same shared
function the commit path uses), the FULL current item collection
(id/quantity/amount completeness), target-set coverage (an existing
item the target omits is a blocker — replacement would drop it, or,
for a mandatory addon, it survives and falsifies the resulting
set), item prices + pricing models for every involved item
(supported: `flat_fee`, `per_unit`; anything else blocks), currency
consistency, amount-unit consistency (non-integer minor units
block), scheduled changes / scheduled advance invoices (flag true
blocks; flag ABSENT is UNKNOWN — never an affirmative "none"), and
a fresh estimate of the exact request, checked against the quote's
acceptance envelope via the core `checkAcceptanceEnvelope` under
BC-1 rules (a non-deterministic fresh estimate blocks).

**Sanitization.** Provider payloads are reduced to named fields —
no raw responses, headers, or PII are emitted. The API key (used
only to construct the client) and any caller-supplied secret strings
are scrubbed from every string in the report, and Basic/Bearer
credential patterns are redacted structurally (test37.27 plants the
key inside a provider field and an attestation note and asserts its
absence from JSON and Markdown alike).

## 3. Financial provenance matrix

Four quantities, kept strictly distinct; each carries amount (minor
units) only when its own source establishes it, plus currency,
DETERMINED/UNKNOWN, provider source, evidence, missing data, and an
estimated-vs-observed flag (preflight figures are always estimates).

| Quantity | Source | Fixture result | When UNKNOWN |
|---|---|---|---|
| Incurred immediate obligation | estimate `unbilled_charge_estimates` (prorated charges landing as unbilled) | 20000 DETERMINED | estimate establishes no complete unbilled figure (e.g. amount member omitted) |
| Post-change recurring price | estimate stated item amounts, else implemented per-item pricing | 80900 DETERMINED | stated list incomplete AND an involved model is unimplemented |
| Next-invoice estimate | estimate `next_invoice_estimate.total` | UNKNOWN in the plain fixture; 80900 DETERMINED when the member is present | member absent — never back-filled from recurring |
| Amount due after credits | estimate `next_invoice_estimate.amount_due` (net of `credits_applied`) | UNKNOWN in the plain fixture; 80600 DETERMINED (80900 − 300 credits) when present | member absent; unbilled/credit visibility through the allowlist is insufficient to derive it |

Zero is reported only when the source establishes zero. The report
also states, verbatim in every run: proration terms;
`invoice_immediately=false` does not mean no financial consequence
(charges land as unbilled charges invoiced at next renewal);
unbilled charges are invoiced next cycle and are not enumerable
here; credits affect amounts due, never incurred obligations or
prices; scheduled changes are a blocker, not a detail; mandatory
addons survive replacement (no `mandatory_items_to_remove` is sent);
and there is NO atomic rollback — reversal is a new, separately
authorized transaction that may incur further consequences, and
reconciliation reporting a violation undoes nothing.

## 4. Blocker matrix (all pinned by test37)

| Condition | Check | Evidence class |
|---|---|---|
| Production / unapproved site | refused pre-read, 0 calls | test37.5 |
| `SCQ_LIVE_COMMIT_ENABLED=true` in env | refused pre-read | test37.6 |
| Undesignated subscription id | refused pre-read | test37.7 |
| No operator attestation | tenant mode UNVERIFIED (not a refusal; blocks readiness) | test37.8, sample |
| Quote memory-only / absent durably | blocker | test37.9 |
| Quote expired | blocker | test37.10 |
| Wrong provider / subscription / site binding | blocker | test37.11–12 |
| Stored request diverges from proposal | blocker | test37.14 |
| Changed stored idempotency key | blocker | test37.15 |
| Recorded attempt with different request hash | blocker (settled attempts are not "unresolved") | test37.16 |
| Unresolved attempt (DISPATCHING / INDETERMINATE) | hard blocker | test37.17 |
| Receipt already recorded | replay posture, blocker for new commit | test37.18 |
| Fingerprint stale | blocker | test37.19 |
| Scheduled changes present / flag absent | blocker / UNKNOWN | test37.20 |
| Current item omitted from target set | blocker | test37.21 |
| Unsupported pricing model / unreadable item price | blocker | test37.22 |
| Currency mismatch / non-integer amounts | blocker | test37.23 |
| Immediate or recurring not established | UNKNOWN quantities, NO-GO | test37.24 |
| Mutation endpoint via preflight transport | rejected pre-dispatch, inner transport never invoked | test37.26 |
| Credentials in output | sanitized (planted-key test) | test37.27 |

## 5. Rehearsal (`src/live/pilot/rehearsal.ts`)

`runRehearsal()` runs 14 scenarios against the REAL durable store,
coordinator, and adapter over mocked transports, each in its own
temporary database, and returns per-scenario expected vs observed
outcome classes with evidence strings. Results at delivery: **14/14
pass, evidence class SIMULATED_PASS** (pinned by test38).

| # | Scenario | Required → observed |
|---|---|---|
| rh-01 | Successful dispatch + durable recording | COMMITTED_AND_VERIFIED |
| rh-02 | Exact original-receipt replay after restart | COMMITTED_AND_VERIFIED, provider mutation count 1 |
| rh-03 | Lost response after provider-side effect | INDETERMINATE, no receipt (execution never inferred from state) |
| rh-04 | Crash after write-ahead intent (coordinator hook; writer abandoned unclosed) | attempt recovered INDETERMINATE; dispatch ran 0 times |
| rh-05 | Crash after dispatch, before receipt persistence | INDETERMINATE; provider-side effect occurred (mock mutation 1), no receipt — a landed effect without a durable record is uncertainty |
| rh-06 | Success-shaped response, wrong resulting item set | INDETERMINATE, no receipt |
| rh-07 | Unexpected mandatory addon | COMMITTED_AND_VERIFIED with reconciliation VIOLATED (landing attributable; the violation is reported, not rolled back) |
| rh-08 | Unknown financial actuals | COMMITTED_UNVERIFIED, reconciliation UNVERIFIED |
| rh-09 | Established envelope violation (inflated post-commit actuals) | reconciliation VIOLATED on the committed receipt |
| rh-10 | Concurrent attempts, same subscription | second `beginDispatch` refused (DispatchBlockedError); exactly one unresolved attempt |
| rh-11 | Idempotency-key conflict (same key, different request) | refused by the ledger |
| rh-12 | Corrupted durable record (integrity-hash tamper) | adoption refused on open; `inspect()` reports the record corrupt |
| rh-13 | Operator review of an unresolved attempt | `recoveryReport()` lists it INDETERMINATE with intervention required; reporting resolves nothing |
| rh-14 | Pre-effect rejection (400 + `param_wrong_value`) | CONFIRMED_NON_EXECUTION; provider state untouched |

## 6. Readiness model

Conditions 1–5 each report PASS / BLOCKED / UNVERIFIED with evidence
and reasons. Rules enforced by construction (and pinned by
test37.3/37.4): the aggregate can be at most
READY_FOR_HUMAN_REVIEW, and only with all five PASS and zero
blockers; condition 1 is PASS only from an operator-supplied
release-approval record (merged PRs #17–#19 are explicitly not
evidence); condition 2 may cite the rehearsal — labeled SIMULATED;
condition 3 is PASS only for a `real`-origin run with no blockers
(mocked/injected evidence leaves it UNVERIFIED); conditions 4 and 5
record operator-supplied inputs — the software grants neither.
On the evidence that exists today the assessment is **NO-GO**
(1 UNVERIFIED, 2 PASS-simulated, 3 UNVERIFIED, 4 BLOCKED, 5
BLOCKED), matching GO-NO-GO Decision 2, which PR-11 does not change
(see the dated addendum in `research/chargebee-pilot/GO-NO-GO.md`).

## 7. Failing-first evidence

test37 + test38 were written against unmodified main (`963be0b`)
before any implementation. `npm run build` failed with 33
TypeScript errors, ALL inside the two new test files (30 in test37,
3 in test38): TS2307 (the `preflight.js` / `rehearsal.js` modules
did not exist) plus the cascading implicit-any errors that follow
from unresolved imports. Zero errors in any pre-existing file; the
pre-existing suite stood at the parent's verified 529/529 baseline.
(The count is the measured one, reproduced post-delivery in a clean
worktree at `963be0b` with the two test files copied in: 33.) After implementation:
572/572 (529 + 43 new: test37 ×27, test38 ×16). No pre-existing test
file was modified in this PR. One expectation was corrected during
development on the code's own evidence, not weakened: the mandatory
-addon rehearsal scenario — the shipped PR-7/PR-9 doctrine records
an attributable landing with reconciliation VIOLATED rather than
INDETERMINATE (probe-verified against the adapter before the
expectation was changed; rh-07/test38.8 now pin the doctrine).

## 8. Deliverables and verification

- `src/live/pilot/preflight.ts` — the preflight (report + Markdown +
  readiness model + guarded transport factory).
- `src/live/pilot/rehearsal.ts` — `runRehearsal()`.
- `src/live/pilot/run-preflight.ts` + `preflight:chargebee` npm
  script — CLI consistent with `pilot:chargebee` (same build-then-run
  shape; mocked by default; `--live` requires env credentials +
  `--db`/`--quote` and otherwise reports BLOCKED, never fabricates).
- `research/chargebee-pilot/runs/preflight-mocked-2026-10-29/` —
  sample sanitized JSON + Markdown from an actual mocked CLI run,
  labeled SIMULATED in its README.
- `research/chargebee-pilot/OPERATOR-RECONCILIATION-RUNBOOK.md` —
  the 10-step reconciliation procedure with BLANK owner/backup/
  timestamp/evidence/decision/uncertainty/sign-off fields. Nothing
  is filled in; a rehearsal does not constitute acceptance.
- `research/chargebee-pilot/GO-NO-GO.md` — dated addendum appended;
  the 2026-10-28 decisions are unrewritten and stand.
- Verification at delivery: fresh clean build + full suite 572/572;
  cold-cache `smoke:pack` OK; demo OK; demo:commit OK; existing
  pilot harness SIMULATED_PASS with 0 observed mutating calls;
  neutrality grep clean (core untouched); frozen-surface diff empty
  (no spec, `types.ts`, or `scq-engine.ts` change — the freeze guard
  is not expected to trip and no label is needed or applied).

## 9. Remaining human / spec approvals (unchanged by this PR)

1. v0.6.2 specification/release approval (condition 1) — a human
   act, separate from all merges to date.
2. An executed preflight against the real test tenant for a
   specific proposed commit (condition 3) — requires credentials
   and the F1 per-run site approval at that time.
3. A named reconciliation owner (+ backup) who accepts the runbook
   (condition 4).
4. A separate authorization for the exact controlled test-site
   commit (condition 5), naming tenant, resource, action, and
   billable effect.

Until all four exist, the controlled test-site commit remains
NO-GO, and nothing in this PR performs, schedules, or simulates
authorization for one.

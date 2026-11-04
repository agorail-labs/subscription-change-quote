# SCQ v0.7 experimental release — decision gate and launch sequence

**Status (2026-11-03): NO-GO for new npm publication; GO for source-only
review and independent reproduction.** This is a planning record,
**not** a version ratification, protocol approval label, a release
authorization, or a claim of live-provider conformance.

## Current, verified release boundary

| Artifact or feature | State | Evidence boundary |
| --- | --- | --- |
| SCQ v0.6.2 experimental specification | Published as [`spec-v0.6.2`](https://github.com/agorail-labs/subscription-change-quote/releases/tag/spec-v0.6.2) | Frozen normative text; not a live-provider safety approval |
| `@agorail-labs/scq-reference@0.6.2-experimental.1` | Published; pin exact version | Simulator-backed consumers only; package excludes `dist/src/live/**` and `dist/src/integration/**` |
| `@agorail-labs/mse-reference@0.4.0-experimental.1` | Published; pin exact version | Admission, quote and reference-provider semantics; no guaranteed merchant/provider dispatch |
| SCQ v0.7 `maxImmediateNetDecrease` + backwards-compatible legacy alias | Merged in PRs #66/#67, test65 | **Source behavior**; not silently part of the already-published v0.6.2 tarball |
| MSE–SCQ durable business-intent bridge | Experimental repository source, tests 62/67 | SQLite-based intent exclusion; the intent and SCQ attempt ledgers are separate non-atomic transactions; excluded from published SCQ npm artifact |
| Provider-safe Chargebee operation-scoped dispatch | **Not proven**; G-17 / Issue #30 open | Remains fail-closed; no live commit permission |
| Independent adoption | No verified external install/integration recorded as of this record | See `docs/ADOPTION-TRACKER.md` |

## Decision: what does v0.7 actually ship?

**Resolve this *before* bumping `package.json` or cutting a release.**

- **Option A: naming/semantics-only v0.7 experimental source/spec milestone.**
  Scope the v0.7 specification to the approved arithmetic net-decrease
  field alias and any separately ratified changes; keep the
  business-intent bridge explicitly `experimental source only`.
  This is the lower-risk release shape.
- **Option B: publish a versioned bridge API as an npm consumer feature.**
  Requires new explicit API review: who issues and authenticates
  `businessIntentId` and `authorizationRef`; admission evidence
  well-formedness and quote binding; tenant/provider/site namespace;
  database path/lifetime and transaction ownership; two-ledger orphan
  recovery; exact outcome/replay semantics; and whether the bridge should
  live in SCQ, a separate integration package, or neither.
  **Do not export it merely because the source tests pass.**

Neither option enables a real Chargebee update, or supersedes the
provider-safety refusal. MSE's published package is independently
versioned; source pinned by CI is not automatically the same artifact
as the MSE npm package.

## Required gates before any release

| Gate | Required evidence | Current disposition |
| --- | --- | --- |
| Normative scope and compatibility | Full versioned v0.7 spec or explicit addendum, acceptance tables, unknown-field downgrade, alias migration and diagnostic wording, migration notes | PARTIAL: PR #66 design plus #67 implementation, no complete v0.7 release yet |
| Public API / packaging | Explicit decision A/B, exports, package version, dependency/peer relationships, no accidental pilot files or credentials | NOT APPROVED |
| Crash/duplicate intent | Test62 + test67 simulated multi-process replay/crash, intent-id and namespace boundaries; disclose orphan claim indefinite-block policy | SOURCE TESTED, NOT PROVIDER-ESTABLISHED |
| MSE integration | Pinned MSE CI on Node20/22 and independently runnable, published-package consumer; no unsupported conformance or atomic multi-unit claim | EXPERIMENTAL |
| Full suite and release artifact | Exact-head Node20/22 tests, provider-neutrality, freeze guard approval if protected spec/core changes, `smoke:pack`, clean-room install, reproducible tarball and SHA-256, inspect exported surface | NEW EXACT-HEAD RELEASE CANDIDATE NOT BUILT |
| Security/operations | External auth validator and approval checks, persistence failure policy, operator runbook for orphan claim and indeterminate provider outcomes; secrets/PII inspection | PARTIAL; not production ready |
| External validation | Reviewer can reproduce the counterexample matrix, including negative outcomes; record actual report with source commit | PENDING |
| Release authority | Explicit maintainer ratification of v0.7 scope, merge, tag, exact tarball checksum, npm dist-tag and publish action | NOT GIVEN |

## Execution sequence

1. Close the remaining pilot-owned temp hygiene (#48) **after** the
   exact-head two-suite residue test passes on Node 20/22.
2. Publish the **review instructions**, not new npm bytes:
   `docs/INDEPENDENT-MSE-SCQ-REVIEW.md`. Invite a bounded adversarial
   reproduction of the existing implementation and note unresolved
   provider guarantees. An invitation is not an independent validation.
3. Resolve Option A versus B and create a **separate design PR** for
   the versioned surface. Do not mix a v0.7 npm export with a naming
   correction by accident.
4. Prepare release candidate as a **separate draft PR**, pinned to a
   reviewed commit. Update spec status, migration guide, package
   identity and README only within the approved scope.
5. On both Node 20/22 build, test, pack and install the **exact**
   artifact in a fresh consumer. Diff the tarball against
   `0.6.2-experimental.1` and explicitly verify that no live adapter
   or credentials ship. Capture the full SHA-256, exact sizes and
   source commit, not carried-over historical results.
6. Seek an explicit maintainer authorization for a specific tag,
   GitHub Release and npm publication. Registry upload is a separate
   action; none occurs from this plan.

## Claim discipline

The only defensible technical headline today is: *MSE's experimental
read-only admission model and SCQ's simulator-backed quote/durable
reconciliation can be composed; the repository implements and tests
a fail-closed business-intent fence against duplicate dispatch
authorization, with deliberately conservative crash recovery*.

This is **not** the same as atomic cross-ledger recovery, exactly-once
provider effects, real Chargebee safe updates, external adoption,
production readiness, or vendor certification. Reviewers should focus
on falsifying these narrower invariants before any stronger claim.

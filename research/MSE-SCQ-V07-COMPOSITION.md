# Agorail v0.7 integration experiment: MSE admission + SCQ execution

Status: **draft integration experiment, not a conformance claim, publication authorization or provider-certified implementation**. This work is additive in `reference/src/integration/` and does **not** change frozen SCQ v0.6.2 normative semantics, provider adapters, or npm release PR #56.

## Five identities that must not be collapsed

| Identity | Purpose | Binding/authority |
|---|---|---|
| `businessIntentId` | One independently authorized customer instruction | Issued by a trusted authorization service; scoped by tenant; bound durably to actor, authorization reference, provider/site, subscription and canonical operation |
| `authorizationRef` | The specific external approval that permits that instruction | Validated by the deployment on *every* call; an ID alone is not permission |
| `SCQ quoteId` | An expiring financial/commercial proposal | Different quotes may represent one intent; one intent always replays the original quote's receipt or blocking state |
| `attemptId` / `idempotencyKey` | One write-ahead dispatch attempt/provider replay binding | SCQ's preexisting durable coordinator/ledger, not MSE's optional wire key |
| Provider operation / financial effect | A provider-attributed operation and actual downstream consequence | Only provider evidence/reconciliation can establish landing/finality, not payload equality or a subscription snapshot alone |

**Non-goal:** infer two distinct business-intent IDs represent the same instruction by hashing the payload. Two truly independently approved identical actions are possible. Preventing a malicious agent from minting a new intent ID for an existing instruction requires the **upstream authorization service** to issue/reuse IDs reliably; this library cannot authenticate or deduplicate arbitrary customer conversations.

## Execution ordering and crash policy

```text
Trustworthy authorization on every invocation (including replay)
      |
Business-intent lookup:
  same binding -> original SCQ receipt (if recorded) OR BLOCKED
  conflicting identity -> BUSINESS_INTENT_CONFLICT
  absent -> MSE admission evaluation + v0.4 quote-aware report validation
      |
    FAILED -> admission refusal + repair evidence; ZERO SCQ dispatches
    PASSED -> SCQ quote, financial, and provider-preservation preflight
      |
    unsafe/unknown provider operation -> refuse; ZERO dispatches
      |
Durable business-intent claim (SQLite transaction, unique tenant + intent)
      |
SCQ DurableMutationCoordinator.execute
      |-- existing receipt -> replay
      |-- write-ahead attempt -> at-most-one authorized dispatch
      |-- lost response -> INDETERMINATE, never automatic re-dispatch
      +-- receipt / reconciled outcome -> SCQ's evidence and recovery rules
```

The separate business-intent and SCQ ledgers are **not one atomic transaction**. The fence is written first, so a crash between claim and SCQ attempt can leave an intent **blocked without an SCQ attempt**. This is a conservative availability limitation, not proof the provider did or did not execute. Reconciliation and any re-authorization policy are deployment concerns. Do **not** delete the claim merely because no SCQ attempt is visible. A future fully transactional same-database extension could eliminate this gap; until then do not advertise exactly-once execution or guaranteed automatic recovery.

The MSE `ReferenceProvider.commit()` is a **simulated commit that may run its own mutation hooks**. It MUST NOT be called as an admission-only preflight in front of SCQ. Use the MSE admission evaluator + `assertAdmissionReportWellFormed` for quote/proposal-aware validation, and ensure binding-specific historical assertions are verified against trusted final-state records. The bridge accepts those functions as trusted callbacks; **the current integration suite stubs them**, so it does not yet prove an actual MSE evaluator running with SCQ in one executable. A no-side-effect MSE admission API or cross-repository fixture is the next integration gate.

## Keep outcome vocabularies distinct

| Observation | SCQ interpretation | MSE interpretation |
|---|---|---|
| Admission relation fails before any commercial dispatch | No SCQ attempt; preserve MSE refusal and witness | `ADMISSION_REFUSED`; **not** an MSE unit `REFUSED` |
| Unit applied but approved amount/preservation violated | `VIOLATED` or applicable recorded SCQ verification state | `APPLIED` is possible for the unit; not pre-dispatch `REFUSED` |
| SCQ receipt says committed but financial outcome cannot be established | `COMMITTED_UNVERIFIED` | Do **not** infer `INDETERMINATE` merely from finance being unverified |
| Execution not known after lost response | SCQ `INDETERMINATE` attempt, blocking | Per-unit `INDETERMINATE` only if MSE has equivalent direct unit evidence; do not invent one |
| A downstream effect is still pending or unknown | No SCQ finality inference | `PENDING` / `UNKNOWN`; only independently established finality permits `FINAL` |

Retain **both original records** with quote/unit/effect correlations. No automatic result-code conversion or invented all-or-nothing multi-unit conclusion.

## Provider safety still blocks live dispatch

An MSE `PASSED` report does not mean a full-list Chargebee replacement is safe. No run may silently delete an unrelated addon or assert a conditional write that the provider does not support. Issue #30 remains open for targeted-update semantics, race windows, and provider evidence. Mocked targeted dispatch is not provider certification. The SCQ `validateCommercial` callback must refuse unsafe commercial mechanisms before the claim/dispatch.

For multiple committing units, an MSE dependency gate is **admission only**. The bridge must not claim atomicity, apply after-the-fact retroactive refusals, or manufacture downstream `FINAL` events.

## Implemented negative gates in test62

- Concurrent calls for one approved intent authorize at most one mock dispatch.
- New quote/new idempotency key for the same intent replays the original receipt, including after restart.
- Altered actor, authorization, resource or operation conflicts.
- Lost response stays blocked across restart despite a fresh quote/key.
- MSE refusal and SCQ unsafe-provider preflight cause zero dispatches.
- Two distinct approved intent IDs for the same payload remain distinct.
- Invalid/ambiguous operation serialization refuses.

All tests use real local SQLite persistence and fake provider dispatch, never live provider writes. The tests do not establish cross-process kill-point coverage, genuine MSE quote-aware validation, multi-unit partial outcomes, provider-side exactly-once effects, or an independent external reproduction.

## Release gates

1. Review MSE PR #6 on its exact head and reconcile with main. It introduces an unreleased, breaking `v0.4.0-dev.0` wire contract. Confirm real admission report satisfaction and temporal finality evidence; pass all MSE CI and baseline tests.
2. Build an **admission-only** validated MSE evaluation handoff and a cross-repository one-unit executable fixture; then a multi-unit partial/uncertain one. The current callback seam is **not sufficient** to claim full MSE-SCQ integration.
3. Extend the suite with process-kill and cross-process contention against the fence; verify provider limitations and MSE effect finality are preserved without relabeling.
4. Independently review SCQ PR #56; keep it draft until the coordinated release narrative is honest. npm publishing, release tags, and live-provider mutations require separate decisions. The SCQ simulator-only experimental artifact may be published separately once expressly approved; do not delay indefinitely for MSE provider features.
5. Prepare an **independent** MSE experimental npm package only after agreeing its export/packaging contract and the v0.4 break, then run clean-room install and external reproduction gates for each artifact.

**No package has been published by this branch.**

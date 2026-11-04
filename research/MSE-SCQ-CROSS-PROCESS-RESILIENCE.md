# Agorail MSE–SCQ combined bridge: process-boundary evidence

**Scope:** v0.7 experimental integration; simulation only. This work adds no
production API, authorization mechanism, Chargebee dispatch path, normative
claim, release, or package publication. It neither changes nor bypasses the
v0.6.2 provider-preservation refusal.

## What was already proven (do not double count)

- SCQ test27: coordinator-only WAL/restart, child crash, and concurrent
  dispatch tests.
- SCQ test62: in-process bridge replay/refusal, business-intent binding,
  two child-process SQLite claim collision, and a manually constructed
  claim-before-SCQ gap.
- SCQ test64: provider/site namespace exclusion across SQLite processes.
- MSE/SCQ cross-repository CI: pinned MSE admission-only evaluator and
  SCQ simulated durable execution on Node 20/22.

These do NOT directly prove that a full MSE–SCQ bridge invocation survives
an actual SIGKILL at the two-ledger boundary or that two whole bridge
invocations from distinct processes emit one simulated effect.

## Additional experiment: Test 67

`reference/tests/helpers/mse-scq-bridge-child.ts` is a new executable
child process that calls `MseScqIntentBridge.execute()` with a real
`BusinessIntentLedger` and a real SCQ `DurableQuoteStore`. A local append-only
file stands in for a provider effect. It never sends an HTTP request.

| Case | Crash/fault boundary | Required observation |
| --- | --- | --- |
| 67.1 | Two full bridge invocations race on one approved intent across separate processes | One synthetic dispatch, exactly one durable SCQ receipt; other worker returns BLOCKED or EXISTING_RECEIPT |
| 67.2 | SIGKILL after business-intent claim, before SCQ attempt exists | Orphan claim persists; no SCQ attempt or simulated effect; new quote/key blocked |
| 67.3 | SIGKILL after SCQ write-ahead attempt, before simulated effect | On reopen unresolved attempt becomes INDETERMINATE; no effect; new quote/key blocked |
| 67.4 | SIGKILL after synthetic effect, before receipt recording | One effect, no invented receipt, INDETERMINATE attempt; new quote/key blocked with no second effect |
| 67.5 | Completed original attempt, then process restart and new quote/key | Replays original receipt and emits no new effect |

The `kill-after-claim` stage deliberately uses the ledger claim API
directly: the bridge has no injection hook in the gap. The other kill stages
use the real coordinator hooks supplied to the bridge. This is the precise
boundary of the test, not a claim that a single real bridge call was
instrumented at every bytecode point.

These are **crash/replay refusal tests**. They establish fail-closed
behavior for the modeled windows; they do **not** establish automatic
safe recovery from an orphan business-intent claim. The intent fence and
SCQ attempt ledger still use separate transactions/databases. A crash can
block an intent permanently until independent evidence and a future
explicit operator recovery protocol are designed. Do not delete an orphan
claim simply because SCQ has no visible attempt.

## Limits and next evidence gates

1. Synthetic authorization/admission callbacks are trusted by the
   fixture; they do not prove authorization issuance, binding-history truth,
   or correct tenant-scoped customer identity.
2. A local file effect is not a provider operation. These tests cannot
   prove exactly-once Chargebee execution, atomic conditional writes,
   reliable native idempotency, or provider-side state preservation.
3. Multi-unit partial effect execution and terminal effect-finality remain
   their own conformance/evidence boundaries; the existing negative
   integration fixture must remain green but is not replaced by test67.
4. The combined tests run on Linux CI Node 20/22. SIGKILL-specific cases
   are skipped on Windows; portability must be evaluated separately.
5. Do not enable SCQ live commits. Chargebee Issue #30 still requires
   written vendor evidence for same-item semantics, write-side
   preconditions, and schedule effects; a read-only pilot alone cannot
   close the read/dispatch race.
6. No MSE package/API or SCQ npm artifact was changed. A future
   published bridge, if proposed, requires its own API design and
   independently reviewed authorization/recovery contract.

**Completion threshold for this experimental test PR:** all added cases
and existing SCQ/MSE cross-repository checks pass on both supported Node
CI versions; no frozen surface or provider adapter is modified. This is
not a production-readiness approval.

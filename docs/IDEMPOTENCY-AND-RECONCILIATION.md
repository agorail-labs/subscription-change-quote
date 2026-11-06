# Idempotency and Reconciliation Guide

## The model

- An **intent** is identified by its idempotency key plus the exact
  request (bound by hash). The key is *intent identity*, generated
  once by the caller; amounts and terms participate as a
  fingerprint, not as the key.
- The durable store claims an intent exactly once
  (`beginDispatch`). A second claim — same process, another
  process, or after a restart — returns the existing attempt; it
  never creates a parallel dispatch path. This is fenced in SQLite
  (WAL), and Phase 3 tests exercise it across OS processes.
- A settled intent **replays**: `execute` returns
  `{ type: "replay", receipt }` — the *original recorded receipt* —
  with zero dispatch invocations. Replay is a statement about
  SCQ's own records. It is **not** a claim that the provider
  executed anything exactly once; it is the mechanism by which
  *your* system avoids asking twice.

## Outcomes

| Outcome | Meaning | Automatic retry? |
|---|---|---|
| `COMMITTED` (+ verification state) | Dispatch returned and the receipt was recorded durably | Never — replay instead |
| Refusal (envelope, determinacy, expiry, stale) | Nothing was dispatched | Safe to re-quote; do not resubmit the same quote |
| `INDETERMINATE` | Dispatch was attempted; whether the provider executed **cannot be established** from the dispatch itself | **NEVER automatically.** Resolve with evidence (below) or escalate to an operator |

## Resolving INDETERMINATE

Resolution requires **trusted provider evidence**: a provider
record that is operation-bound (keyed to this attempt's
idempotency key and request hash), attributable, and fresh
(observed after settlement, within
`RESOLUTION_EVIDENCE_MAX_AGE_MS`). `createProviderEvidenceVerifier`
establishes either `CONFIRMED_LANDING` (with the observed state
digest) or `CONFIRMED_NON_EXECUTION` from such a record. Anything
weaker — an operator's assertion, a free-text note, a record about
a *similar* operation, identical-looking subscription state — is
recorded as an unresolved resolution for audit and **lifts
nothing**. Identical observed state is never proof that a specific
operation executed (attribution precedes classification).

While an attempt is INDETERMINATE:

- the intent stays fenced — no new dispatch for it can begin;
- `recoveryReport()` lists it under `unresolvedAttempts`;
- the safe operator actions are: gather provider evidence and
  resolve, or leave it blocked. There is no supported "force
  retry," and adding one would defeat the fence.

## Reconciliation

After a commit, `receipt.reconciliation` compares the committed
effect against the quote and the observed provider state:
`OK`, or `VIOLATED` with the diverged dimensions named (the demo's
scenario B shows a diverged outcome). Reconciliation is
provider-neutral: it consumes adapter-translated records, and a
`VIOLATED` result is a report for your workflow — SCQ does not
roll anything back, and a `BEST_EFFORT` consistency outcome can
mean the provider already mutated before the divergence was
detected.

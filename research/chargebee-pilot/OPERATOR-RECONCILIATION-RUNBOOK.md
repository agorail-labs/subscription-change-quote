# Operator Reconciliation Runbook — Unresolved Chargebee Commit Attempts

**Status: TEMPLATE.** This runbook is procedure, prepared in advance
(PR-11). It names no operator and authorizes nothing. A completed
mocked rehearsal (`runRehearsal()`, PR-11) demonstrates that the
machinery behaves as this procedure expects; it does **not**
establish that any named person has accepted this role, and it does
not satisfy COMMIT-RECOVERY-SAFETY condition 4 until a human fills
in the fields below and accepts them.

## Assignment record (BLANK — to be completed by a human)

| Field | Value |
|---|---|
| Named reconciliation owner | _(blank)_ |
| Backup owner | _(blank)_ |
| Owner acceptance (signature / dated record) | _(blank)_ |
| Rehearsal reference (date + run) | _(blank)_ |
| Runbook version accepted | _(blank)_ |

## Per-incident record (BLANK — one per unresolved attempt)

| Field | Value |
|---|---|
| Review timestamp | _(blank)_ |
| Attempt id / quote id | _(blank)_ |
| Provider / site / subscription | _(blank)_ |
| Stored request hash / idempotency key | _(blank)_ |
| Evidence references (provider console, API reads, ledger report) | _(blank)_ |
| Operator decision | _(blank)_ |
| Remaining uncertainty | _(blank)_ |
| Approval / sign-off | _(blank)_ |

## Procedure

1. **Freeze further attempts.** Stop: no new commit for the affected
   subscription, no retry of the unresolved one. In the durable
   ledger, an unresolved attempt already blocks `beginDispatch` for
   the same subscription — do not clear, delete, reclassify, or
   override it to get around the block. A blocked dispatch is the
   safety mechanism working, not an error to bypass.
2. **Locate the attempt.** From the durable store's
   `recoveryReport()`, find the attempt (state `DISPATCHING` or
   `INDETERMINATE`) and its quote. The report is read-only: producing
   it resolves nothing.
3. **Identify the exact authorized change.** Record the quote id,
   the canonical request hash, the site, and the ORIGINAL idempotency
   key from the durable record. This — not anyone's recollection —
   is what was authorized. Note the key verbatim; Chargebee's native
   idempotency window is time-limited and is never, by itself, proof
   that a retry is safe.
4. **Independently read current provider state.** Through read-only
   means (provider console or the guarded read-only transport),
   obtain the subscription's current status, full item set,
   `resource_version`, and any scheduled changes. Record what was
   observed, with timestamps, separately from what it might mean.
5. **Compare against the authorized change.** Item ids, quantities,
   prices: does current state match the target set, the pre-change
   set, neither, or a mixture? A match with the target set is
   *consistent with* execution — it is NOT proof this operation
   executed it (another actor, or the provider itself, can produce
   identical state). Never convert "state matches" into "the commit
   succeeded."
6. **Inspect the financial consequences.** Incurred immediate
   obligation, recurring price, next-invoice figures, credits —
   each from its own provider source. A figure the source does not
   establish stays UNKNOWN; it is never filled in with zero and
   never borrowed from a different quantity.
7. **Separate established from insufficient evidence.** Write down,
   explicitly: (a) what is established (a recorded receipt; provider
   records that bind the effect to this operation), (b) what is
   merely observed (current state), (c) what remains unknown.
   If execution cannot be established, the attempt stays
   INDETERMINATE — that is a terminal classification for retry
   purposes, not a problem to argue away.
8. **Append the reconciliation outcome to history.** The ledger's
   record is append-only: an operator resolution
   (`resolveAttempt`) appends the reconciliation outcome with the
   evidence references from this record. Never rewrite, delete, or
   backdate entries. If the evidence is insufficient, the appended
   entry says so.
9. **Escalate without blind retry.** If the outcome cannot be
   established from provider records, escalate to the backup owner /
   provider support with the incident record attached. Under no
   circumstances re-dispatch the change "to see what happens": a
   blind retry can double-apply the change, and the ledger will
   refuse it while the attempt is unresolved in any case.
10. **Decide on any compensating change separately.** If the change
    landed wrongly or partially, correction is a NEW transaction
    with its own quote, preflight, and authorization — it is not a
    rollback (no atomic rollback exists), it may itself prorate or
    incur charges, and it is never dispatched as part of closing
    this incident without that separate approval.

## Standing prohibitions

- No automatic retry, no automatic compensation — ever. Both are
  human decisions taken on the record above.
- No editing of the durable ledger outside the operator actions it
  exposes (`resolveAttempt` with an appended outcome).
- No treating a rehearsed procedure as an executed one: rehearsal
  evidence is SIMULATED, classified as such, and cited as such.

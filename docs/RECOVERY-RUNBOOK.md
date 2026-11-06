# Persistence Lifecycle and Failure-Recovery Runbook

## Lifecycle

- One SQLite database file (WAL mode) per store instance scope.
  The file path, its directory permissions, backup, and retention
  are the operator's.
- Schema version: **v5**. Opening an older database migrates
  evidence append-only (see the migration guide §3). Opening a
  database from a *newer* schema is refused.
- Quotes, attempts, receipts, and evidence entries are append-only
  records; receipt identity is immutable once recorded.

## Failure modes and responses

| Failure | Behavior | Operator action |
|---|---|---|
| Process killed before dispatch (after intent persisted) | Attempt remains in `DISPATCHING`/prepared state; the fence holds | Restart; call `recoveryReport()`; the attempt is recoverable per the store's recovery posture — do not delete rows |
| Process killed during/after dispatch, before receipt persisted | Attempt settles **INDETERMINATE** on recovery | Resolve with provider evidence (see the idempotency guide) or leave blocked; **never re-dispatch the intent** |
| SQLite binding missing (e.g. published package on Node 26) | `DurableStoreError` at store construction; nothing is written | Fix the runtime/dependency (migration guide §1); do not fall back to the in-memory store for durable intents |
| Database file corrupted | Store construction throws; no silent repair, no fallback | Restore from backup into a *new* path and reconcile against provider records; a corrupted store never authorizes a retry by itself |
| Database unavailable (permissions, disk) | Operations throw `DurableStoreError`; dispatches do not proceed without the write-ahead record | Restore availability; in-flight intents remain fenced |
| Evidence too old / unattributable at resolution | `ResolutionEvidenceError`; attempt stays INDETERMINATE | Obtain fresher, operation-bound provider evidence |

## What recovery will never do

- Fabricate or "repair" a verified receipt. Verification is
  established from evidence, or it does not exist.
- Rewrite a recorded receipt with later actuals. Later actuals are
  appended as evidence entries; the receipt stands.
- Release the attempt fence on a timer. There is no TTL on an
  INDETERMINATE attempt, by design: an unbounded block is the safe
  failure mode, and releasing it is a human decision made with
  provider evidence in hand.

## Routine operations

- **Backups:** copy the database together with its `-wal`/`-shm`
  files, or use SQLite's online backup; a bare file copy of a live
  WAL database can miss the newest committed records.
- **Inspection:** `recoveryReport()` (unresolved attempts, by age)
  is the health check. A non-empty unresolved list is a work queue,
  not an error state.
- **Upgrades:** open the production database with the new version
  only after a backup; the v5 migration is append-only but not
  reversible by the older build.

# Durable quote/receipt store — write-ahead mutation ledger and crash-safe recovery (PR-8)

Parent issues: #7 (v0.6.2 design), #12 (Chargebee pilot readiness). Branch
`v062/pr-8-durable-store-recovery` from main `996ee27` (clean baseline 351/351).

This PR implements NO-GO condition 2 of the Chargebee pilot: a durable,
transactional store and write-ahead mutation ledger. It is a persistence and
recovery implementation only — **no live billing mutation is authorized or
performed**; `SCQ_LIVE_COMMIT_ENABLED` is never set; every mutation scenario
is exercised through mocked transports (SIMULATED_PASS at best).

## 1. Audit: the persistence gaps found

The pre-PR-8 `QuoteStore` is an in-process `Map`. Its own header states the
limit plainly: nothing survives a restart, §6.10 replay is bounded by process
lifetime, and exactly-once cannot be proven from it. Concretely:

- **Quotes** exist only in memory. After a restart the Chargebee-live adapter
  fails closed (`QUOTE_STALE`) rather than re-mutating — safe, but every
  in-flight quote is lost.
- **Receipts**: `serializeReceiptRecords` / `restoreReceiptRecords` persist
  only receipt-related data (recorded receipt, current view, identity digest,
  verification trail) and validate them as coherent units on restore (PR #8
  of the v0.6.2 program, C1–C3) — but there is no durable backend behind
  them, no quote/attempt persistence, and no transaction spanning related
  records.
- **Commit outcomes** (INDETERMINATE / CONFIRMED_NON_EXECUTION) are recorded
  on the in-memory quote only: after a restart, the adapter's blind-retry
  guard for an indeterminate attempt is gone with the process.
- **No write-ahead record exists at all**: nothing durably binds a quote to
  the exact request and idempotency key *before* dispatch, so a crash
  mid-commit leaves no recoverable trace of whether dispatch was authorized,
  let alone what was sent.
- **No concurrency control**: two processes share nothing; duplicate dispatch
  authorization cannot be detected, let alone refused.

The existing identity/coherence machinery is sound and is **reused, not
replaced**: receipt identity digest (`receiptIdentityDigest`), the binding
checks in `recordCommitReceipt`, the established-evidence requirement in
`verifyCommitReceipt`, and the whole-set coherence validation in
`restoreReceiptRecords` all remain the only paths by which receipts are
recorded, verified, or adopted.

## 2. Design

### Backend

**SQLite via `better-sqlite3`, WAL journal mode, `synchronous = FULL`.**

- Real transactions with `BEGIN IMMEDIATE` semantics across related records;
  WAL + FULL sync makes a committed transaction durable across process crash
  and OS-level process death on the same host.
- Prebuilds install cleanly on Node 20 and 22 (verified on the Node 22.14
  toolchain used for this PR's verification; CI exercises both).
- The binding loads **lazily** — only when a `DurableQuoteStore` is
  constructed — so the pre-existing suite and unrelated modules never touch
  the native module. If the binding cannot load, construction throws; there
  is **no silent in-memory fallback** anywhere in this PR.
- It is declared under `optionalDependencies`, not `dependencies`: the
  package core installs with zero required runtime dependencies (and the
  offline consumer smoke passes with a cold npm cache), while `npm ci` in
  CI still installs the binding so the durable suites exercise it for real.
  The durable backend is an opt-in capability of the package, not a
  requirement imposed on every consumer.
- Single-host file store (see Limitations).

### Shape

`DurableQuoteStore extends QuoteStore`. Every parent write method
(`put`, `updateStatus`, `recordCommitReceipt`, `recordCommitOutcome`,
`verifyCommitReceipt`, `supersedeOthersFor`, `restoreReceiptRecords`) runs
the parent's validation/mutation first, then writes the affected quote row +
receipt record through to SQLite in one transaction with a per-quote
**version CAS** (a stale writer's `UPDATE … WHERE version = ?` matches zero
rows and is refused; the store then poisons itself rather than diverging
from durable state). Receipt recording for a mutation attempt goes through
dedicated methods (`recordAttemptReceipt` / `recordAttemptOutcome`) that
commit the quote row, the receipt record, and the attempt's terminal state
in **one** SQLite transaction.

On open, persisted data is adopted only after, in order: schema-version
check → per-record SHA-256 integrity check → the parent's
`restoreReceiptRecords` coherence validation (digest re-computation,
quote association, legal record shapes, trail evidence validation). Any
failure refuses the whole set and the store does not open
(`DurableRecoveryError`). One representation subtlety: JSON drops
`undefined`-valued members, and recorded receipts deliberately carry them,
so the persistence encoding stores `undefined` as an explicit sentinel; a
recovered recorded receipt deep-equals the pre-restart one member-for-member
(the JSON-based validation is unaffected — digest and canonical coherence
both drop those members deterministically).

### Data model

| Table | Contents |
|---|---|
| `meta` | `schema_version` (= 1), `created_at`. Unsupported/corrupt version ⇒ open refused. |
| `quotes` | quote_id PK, subscription_id, provider, status, version (CAS), `record_json` (the complete `StoredQuote`: proposal, quoted effect, determinacy, provenance, expiration, status, provider preview input with the exact request parameters + deterministic idempotency key, recorded outcome), `record_sha` integrity checksum, updated_at. |
| `receipt_records` | quote_id PK, recorded receipt JSON (original), current-view JSON, identity digest, verification trail JSON (with established evidence). |
| `attempts` | attempt_id PK, quote_id, subscription_id, provider, site, state, **idempotency_key UNIQUE**, request_hash (SHA-256 of the canonical request), request_json (exact canonical request), pre-dispatch fingerprint, recovery classification, terminal outcome, details, operator review state, version, timestamps. |
| `attempt_history` | append-only state transitions per attempt. |

No credentials or authorization headers are stored anywhere — records
contain quotes, requests, receipts, and outcomes only.

### Migration strategy

Schema v1 is created by explicit DDL statements on first open under a
`meta.schema_version` marker. A database whose version is missing,
non-integer, or not equal to the supported version is refused at open
(fail closed); there are no silent in-place upgrades. Future versions are
expected to add explicit, ordered migration steps keyed off that marker.

### Mutation lifecycle

```
                 beginDispatch (ONE immediate transaction)
  (no attempt) ─────────────────────────────────► PREPARED ──► DISPATCHING
                                                                      │
        ┌──────────────────────┬──────────────────┬──────────────────┤
        ▼                      ▼                  ▼                  ▼
 COMMITTED_AND_VERIFIED  COMMITTED_UNVERIFIED  INDETERMINATE   CONFIRMED_NON_EXECUTION
 (receipt recorded)      (receipt recorded)    (no receipt;    (no receipt;
                                                blocks retry    fresh attempt
                                                until operator  permitted)
                                                resolves)
  PREPARED ──(superseded by a later beginDispatch)──► SUPERSEDED
```

PREPARED and DISPATCHING are written in the same transaction (both appear in
`attempt_history`): the invariant is that **dispatch is authorized only
after that transaction commits**, so a persisted PREPARED-without-DISPATCHING
state is unobservable in practice, and a recovered PREPARED attempt provably
never dispatched. Terminal transitions for receipt/outcome recording are
atomic with the records themselves (§1, `recordAttemptReceipt`).

### Write-ahead protocol (`DurableMutationCoordinator`)

1. **Replay check** — a recorded receipt is returned verbatim (§6.10); no
   dispatch is authorized.
2. **beginDispatch** — one immediate transaction: idempotency-key binding
   check (same key + different request hash ⇒ refused), blocking-attempt
   check (same quote *or same subscription*: a DISPATCHING attempt, or an
   unresolved INDETERMINATE attempt), then intent insert + DISPATCHING.
   If this throws, **zero provider mutations may occur**.
3. **Dispatch** — the caller's dispatch function runs at most once.
4. **Settle** — receipt or outcome recorded atomically with the attempt's
   terminal state. A dispatch that throws settles INDETERMINATE and the
   error re-throws.

This yields **exactly-once recording and at-most-once dispatch
authorization**. It does not yield exactly-once provider execution, and
nothing here claims it does: Chargebee's native idempotency remains a
limited backstop (30-minute window), while SCQ's durable INDETERMINATE
record keeps blocking blind retry long after that window expires (test
27.12).

### Adapter wiring

`ChargebeeLiveAdapter` gains two options: `durableCoordinator` and
`providerSite`. With a coordinator configured (and a `DurableQuoteStore` as
the store — quote persistence is then automatic via write-through `put`,
before `createChangeQuote` returns):

- after revalidation and the (unchanged) live-commit gate check, the
  adapter calls `beginDispatch` with the exact `update_for_items`
  parameters, the deterministic idempotency key, and the pre-dispatch
  fingerprint — a blocked attempt or persistence failure throws **before**
  any provider mutation;
- every exit path (established commit, CONFIRMED_NON_EXECUTION,
  unknown-dispatch reconciliation) settles the attempt from the quote's
  durable terminal record.

Without a coordinator, adapter behavior is byte-for-byte the pre-PR-8
behavior (all pre-existing adapter tests pass unmodified). The live-commit
gate is untouched.

### Recovery (deterministic, on open)

After quote/receipt adoption, attempts are recovered:

- attempt + recorded receipt exists ⇒ attempt completed **from the
  receipt** (the receipt record is the authority);
- DISPATCHING attempt, no receipt/outcome ⇒ **INDETERMINATE**; the outcome
  is also recorded on the quote so the adapter's in-process blind-retry
  guard engages identically after restart. Observed provider state is
  never consulted as execution proof (PR #16 L1);
- PREPARED attempt ⇒ classified `PREPARED_NOT_DISPATCHED` (dispatch was
  never authorized); it does not block a future attempt;
- a grace window (default 30 s, `recoveryGraceMs`) protects a *live*
  writer's in-flight attempt from being recovered by a second process
  merely opening the database; the deployment model is a single writer
  service, and crash tests pass grace 0 because the writer is provably
  dead.

### Reconciliation / operator interface (read-only)

`recoveryReport()` enumerates unresolved attempts, INDETERMINATE outcomes,
COMMITTED_UNVERIFIED receipts, and receipts requiring verification. Each
item separates **observed** (diagnostic context recorded with the outcome)
from **established** (execution established / financial result established /
state attributable), flags whether operator intervention is required, and
names the next *permitted* action — which the report does not perform. The
one explicit operator action, `resolveAttempt`, is a separate method that
no recovery or reporting path calls. `DurableQuoteStore.inspect(path)`
statically reports corrupt records and identity conflicts for a database
whose store refused to open, without adopting anything.

## 3. Crash-window fault matrix

| Window | Recovery outcome | Proven by |
|---|---|---|
| Crash before intent write | No attempt, no mutation; later commit proceeds normally | 27.8 |
| Persistence failure at the write-ahead gate | Zero dispatches; failure thrown, never hidden; store poisoned rather than divergent | 27.9, 28.3 |
| Crash after intent, before dispatch | Attempt recovered INDETERMINATE (potentially dispatched); re-dispatch blocked | 27.10 (child process exits between beginDispatch and dispatch) |
| Crash immediately after dispatch | INDETERMINATE, no receipt, no re-dispatch | 27.11 (child exits mid-dispatch) |
| Lost response, then restart | INDETERMINATE persists across restart; blind retry blocked indefinitely (native window irrelevant) | 27.12 |
| Lost response + an independent actor produces the intended final state | Still INDETERMINATE; no receipt; execution reported **not established** (L1) | 27.13 |
| Crash after response, before receipt persistence | No fabricated receipt; INDETERMINATE | 27.14 (child exits in `afterDispatchBeforePersist`) |
| Crash during receipt recording | Transaction rolls back: no partial receipt, attempt not half-completed, quote not COMMITTED | 27.15 (fault inside the persist transaction) |
| Crash after receipt persistence | Exact original receipt replays; no further dispatch | 27.2, 28.1 (two restarts) |
| Crash during verification transition | Original unverified view + empty trail, or the complete transition — never torn | 27.16 |
| Database locked (second writer holds EXCLUSIVE) | Write surfaces as a persistence failure before any dispatch | 27.22b (child process holds the lock) |
| Database unavailable (bad path) | Construction throws; no fallback | 27.22a |
| Corrupt / unsupported schema version | Open refused; `inspect` reports version 999 | 27.23 |
| One corrupted record in a set | Whole set refused — no partial adoption; `inspect` names the record | 27.24 |

## 4. Concurrency evidence

- **Same quote, two processes** (27.17): two child processes race
  `coordinator.execute` against one database; the marker file records
  **exactly one** dispatch; the loser replays or is blocked; the recorded
  receipt exists afterward.
- **Same subscription, two quotes** (27.18): while the first attempt is
  DISPATCHING, a second quote's dispatch for the same subscription is
  refused (`DispatchBlockedError`); serialization is by the durable
  unresolved-attempt rule, not by timing.
- **Duplicate receipt identity** (27.19): the parent's
  CONFLICTING_RECEIPT_IDENTITY refusal, durable across restart.
- **Idempotency-key reuse with a different request** (27.20): refused at
  the write-ahead gate by request-hash comparison.
- **Stale writers** (27.26): two open instances; the second instance's
  newer write wins and the stale instance's write is refused by version
  CAS rather than overwriting it.
- **Concurrent verification transitions** serialize through the same
  write-through path and version CAS; the parent already admits exactly
  one legal transition per record, and a crashed transition leaves the
  original view (27.16).

## 5. Original-receipt replay evidence

27.2 (receipt survives restart member-for-member, `undefined`-valued
members included), 27.3 (transition + restart: replay returns the recorded
COMMITTED_UNVERIFIED original while the current view shows
COMMITTED_AND_VERIFIED with its trail), and 28.1 (full adapter flow across
two restarts: the second restart's commit returns a receipt deep-equal to
the first commit's, with the mock's mutation count still 1).

## 6. Verification (this branch)

- Clean build via a fresh `npm ci` (lockfile-complete, native prebuild
  installed from the lockfile) then `npm test`: **381/381** (baseline 351 +
  30 new: test27 ×26, test28 ×4). New suites re-run 3× for stability.
- `npm run smoke:pack`: OK. `npm run demo`: OK. `npm run demo:commit`: OK
  (COMMITTED / BEST_EFFORT / reconciliation OK).
- Provider-neutrality: OK (core untouched). Freeze guard: `git diff` vs
  main over `spec/scq-v0.6.1-spec.md`, `spec/scq-v0.6.2-spec.md`,
  `reference/src/core/types.ts`, `reference/src/core/scq-engine.ts` is
  **empty**.
- Pilot mocked harness: unchanged — SIMULATED_PASS classifications, live
  commit BLOCKED, **0 mutating calls** (also asserted as test 28.4).
- Zero-real-mutation audit: every dispatch in the new suites is accounted
  for by injected mocked transports or the coordinator's dispatch counters;
  no network transport is constructed anywhere in test27/test28.
- Disclosed pre-existing test changes: **none**. 351/351 pre-existing tests
  pass unmodified.

## 7. Known limitations

- **Single-host file store.** SQLite on a local file gives one-host
  durability; it is not a replicated/network store, and the deployment
  model is a single writer service (plus the recovery grace window
  documented above).
- **No true exactly-once provider execution.** Durability gives
  exactly-once recording + at-most-once dispatch authorization; a dispatch
  whose response is lost is INDETERMINATE by design.
- **Native-module dependency.** `better-sqlite3` needs its prebuild (or a
  toolchain) for the target platform/Node version; it loads lazily and its
  absence fails loudly at durable-store construction, never silently.
- **Recovery adoption reaches the parent record map directly** for one
  narrow fix-up: after the parent's JSON-shaped restore validates and
  adopts a record set, the adopted in-memory records are replaced with the
  fully decoded persisted values so undefined-valued members survive
  verbatim. Validation decisions are entirely the parent's; the fix-up
  changes nothing they decided.
- The four simulator adapters are intentionally not wired to the durable
  store in this PR; the coordinator boundary is provider-neutral and they
  can adopt it under their own authorizations.

## 8. Updated GO/NO-GO (issue #12 conditions)

1. v0.6.2 Chargebee migration — **done** (simulator PR #15, live adapter
   PR #16, both merged).
2. Durable store implemented + restart-tested — **satisfied by this PR,
   subject to review** (this note, test27/test28).
3. Executed preflight for the exact commit — **open**.
4. Named reconciliation owner — **open**.
5. Separate authorization for any live mutation — **open**; none was given
   or used here.

**Overall: the controlled Chargebee test-site commit remains NO-GO.**

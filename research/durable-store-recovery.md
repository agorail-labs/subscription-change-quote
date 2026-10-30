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

Because write-through mutates memory before it persists, a persistence
failure leaves the instance holding state that may not be on disk. Two
rules make that fail closed (PR-17 review correction D1, §9): **every**
step of the persistence path (fault hooks, encoding, transaction) is
inside the poison-on-failure coverage, and **every** read/replay
egress (`get`, `all`, `recordedReceipt`, `receiptsWithReconciliation`,
`serializeReceiptRecords`, `recoveryReport`) is poison-guarded — after
any persistence failure the instance serves nothing, and the only
recovery is a restart from the database file, whose contents are
exactly what actually committed.

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
| Receipt persistence fails AFTER the in-memory record (pre-persist hook or mid-transaction) | Store poisoned AND reads poison-guarded: no volatile receipt via `recordedReceipt` / `get` / adapter replay while the failed instance is alive; reopen has no receipt (D1) | 29.1, 29.2, 29.3, 29.6, 29.7 |
| Outcome / verification-transition persistence fails after the in-memory mutation | Same fail-closed rule on the `recordCommitOutcome` / `verifyCommitReceipt` write-through paths (D1 audit) | 29.4, 29.5 |
| Retry of a CONFIRMED_NON_EXECUTION attempt while another attempt on the subscription is unresolved | Blocked under the same transaction before re-arming; zero additional dispatches (D2) | 29.8; legitimate retry after resolution: 29.9 |
| Idempotency key presented under a different quote/subscription/site | Refused as a collision in any attempt state; the bound attempt is never re-associated (D2) | 29.10 |
| Adapter configured with a durable store but no coordinator | Commit refused before any mutating call; zero mutations (D4) | 29.13 |
| Coordinator bound to a different store than the adapter's (or to an in-memory store); attempt for a quote the database does not hold, or with a mismatched subscription/provider binding | Refused before any mutating call (adapter binding check) / inside the beginDispatch transaction (store-side association); zero orphan attempt rows in the wrong database (D5) | 30.1, 30.2 (adapter), 30.3, 30.4, 30.5 (store); correctly bound control: 30.6 |

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
  installed from the lockfile) then `npm test`: **400/400** (baseline 351 +
  49 new: test27 ×26, test28 ×4, test29 ×13 — the PR-17 D1–D4
  review-correction regressions, §9 — and test30 ×6, the D5 regressions,
  §10). New suites re-run for stability.
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
  no network transport is constructed anywhere in test27–test30.
- Disclosed pre-existing test changes: **none** (including the §9 and §10
  corrections rounds). 351/351 pre-existing tests pass unmodified.

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
   subject to review** (this note, test27/test28/test29).
3. Executed preflight for the exact commit — **open**.
4. Named reconciliation owner — **open**.
5. Separate authorization for any live mutation — **open**; none was given
   or used here.

**Overall: the controlled Chargebee test-site commit remains NO-GO.**

## 9. PR-17 review corrections (D1–D4)

The owner's independent review of this PR at `55c8af2` found four paths
that undermined the guarantees above. Each was reproduced first by a
new regression in `test29-durable-review-corrections.test.ts` (all 13
failed against `55c8af2` behavior), then fixed on this branch. No
pre-existing test was modified.

### D1 — A failed receipt persistence could be replayed from volatile memory

**Defect.** `recordCommitReceipt` ran the parent's in-memory mutation
first and persisted second. `persistQuote` invoked the
`beforePersist` fault hook (and the persistence encoding) OUTSIDE the
try/catch that poisons on failure, so a hook failure did not even
poison the store; and the inherited reads (`recordedReceipt`, `get`)
had no poison guard at all, so even a properly poisoned write failure
left the volatile receipt readable. `checkIdempotentReplay` in the
adapter could then serve that receipt on a second commit call as a
§6.10 replay although it was never persisted — a restart lost it.

**Fix (uniform across every parent-mutating write-through path —
`recordCommitReceipt`, `recordCommitOutcome`, `verifyCommitReceipt`,
`recordAttemptReceipt`/`recordAttemptOutcome`, and the rest).**
(1) Complete exception coverage: hooks, encoding, and the
transaction all sit inside the fail-closed region of `persistQuote`
and `persistQuoteInTx`; any failure poisons. (2) Poison-guarded
reads: `get`, `all`, `recordedReceipt`,
`receiptsWithReconciliation`, and `serializeReceiptRecords` are
overridden to refuse on a poisoned store, and `recoveryReport`
asserts health at entry. After any persistence failure the instance
serves nothing through any read, replay, enumeration, or
dispatch-authorizing API; the only recovery is a restart from the
database, whose contents are exactly what committed.

**Why poison + guards rather than snapshot/rollback of memory.**
Rolling back the parent's in-memory state would require reproducing
the parent's transition semantics (identity-keyed record/replay,
verification-trail append, status changes) inside the durable layer
— a second implementation of the very validation surface this PR is
required not to weaken, with its own divergence risk if the two ever
disagree. Poison-and-restart keeps the parent's semantics single and
authoritative, makes the failure boundary explicit (a failed
instance is unusable, not quietly approximate), and loses nothing:
every state the instance could legitimately serve after a failure
is, by construction, already on disk and re-adopted through the
coherence-validated open path.

**Regressions.** 29.1/29.2 (both fault points on
`recordCommitReceipt`: reads throw while the failed store is alive;
reopen has no receipt), 29.3 (the adapter replay path end-to-end:
second `commitChangeQuote` is refused, not served the volatile
receipt; after restart the recovered INDETERMINATE attempt blocks
any further mutation — mock mutation count stays 1), 29.4/29.5 (the
same audit on `recordCommitOutcome` and `verifyCommitReceipt`, both
fault points), 29.6/29.7 (`recordAttemptReceipt` at both fault
points, complementing 27.15's rollback-only coverage).

### D2 — CONFIRMED_NON_EXECUTION re-dispatch bypassed same-subscription exclusion

**Defect.** In `beginDispatch`, the by-key branch for an existing
CONFIRMED_NON_EXECUTION attempt reset the row to DISPATCHING and
returned BEFORE — and instead of — the `findBlockingAttempt`
exclusion query. Sequence: Q1 on subscription S terminates
CONFIRMED_NON_EXECUTION; Q2 on S goes DISPATCHING; Q1 retries with
its original key + request → a concurrent mutation of S was
authorized.

**Fix.** Inside the same `BEGIN IMMEDIATE` transaction, the CNE
re-arm now re-runs the exclusion query (excluding only that specific
terminal row) and refuses if any other attempt for the quote or the
subscription is DISPATCHING or unresolved-INDETERMINATE. The same
branch now also verifies the key's binding — quote, subscription,
provider, AND site, not merely the request hash — in every state of
the bound attempt: a key collision under a different quote or site
is refused as a collision and never re-associates the attempt.

**Regressions.** 29.8 (the review's exact sequence: blocked, zero
additional dispatches, the CNE row is not re-armed), 29.9 (the
legitimate retry succeeds after Q2 resolves — one dispatch, the
original row re-armed), 29.10 (key collision under a different
quote, under a different site, and against a committed attempt).

### D3 — The operator report claimed attribution by outcome class

**Defect.** `recoveryReport()` set
`stateAttributableToThisMutation: true` for EVERY
COMMITTED_UNVERIFIED attempt and unverified receipt. But PR #16
returns COMMITTED_UNVERIFIED precisely for broken-bracket commits
(Z3) whose observed recurring state is explicitly UNATTRIBUTED — no
recurring figure is recorded as that commit's.

**Fix.** Attribution is now derived from the recorded evidence by
`attributionFromReceipt(receipt)`, and the report's representation
is honest about the third case: the field is
`boolean | "unknown"`. Derivation: a completed verification
transition (verified outcome + OK reconciliation) ⇒ true; bound
provider actuals (`provider_actual` / `defined_equal_exact`) ⇒
true; quote-side provenance (`revalidated_preview` /
`pre_mutation_estimate`) ⇒ false; `unestablished` source ⇒ the
recurring evidence decides — a DETERMINED recurring figure
established from a bracket-closed re-read (PR #16 test 26.10a
shape) ⇒ true, NO recurring figure recorded (the Z3 broken-bracket
shape, tests 26.14a/b) ⇒ false, candidates under UNKNOWN
determinacy with no independent observation (test 26.17 shape) ⇒
"unknown"; no provenance at all ⇒ "unknown". The sibling fields
were audited for the same shortcut: execution-established now
requires the recorded receipt's existence (response-received side,
L1), and financial-established a verified recorded outcome.

**Regressions.** 29.11 (a faithful broken-bracket receipt reports
`stateAttributableToThisMutation: false` while execution stays
established and financial stays unestablished), 29.12 (controls:
bound provider actuals report true; a receipt with no provenance
reports `"unknown"`, never a defaulted true).

### D4 — A durable store without its coordinator could still dispatch

**Defect.** The adapter gated write-ahead only through
`opts.durableCoordinator` when provided. A `DurableQuoteStore` +
`liveCommitEnabled: true` with the coordinator omitted reached
`update_for_items` with NO write-ahead attempt.

**Fix.** `beginDurableAttempt` now refuses explicitly when the
adapter's store is a `DurableQuoteStore` (instanceof check, which
also covers subclasses) but no coordinator was supplied: an
`SCQError` naming the missing coordinator, thrown after the
live-commit gate and before any mutating call. The default
configuration (in-memory `QuoteStore`, no coordinator) and the
existing live-commit gate are unchanged.

**Regression.** 29.13 (mocked transport: the misconfigured commit is
refused with the coordinator named in the error; the mock's mutation
count stays 0).

## 10. PR-17 re-review correction (D5)

The owner's re-review at `454de24` accepted D1–D4 and found one
remaining configuration-level gap. It was reproduced first by the
new regressions in `test30-durable-binding-corrections.test.ts`
(30.1–30.5 failed against `454de24`; 30.6 is the positive control),
then fixed on this branch. No pre-existing test was modified.

### D5 — A coordinator bound to the wrong database still authorized dispatch

**Defect.** D4 made `beginDurableAttempt` refuse a MISSING
coordinator, but it never checked that the coordinator present was
bound to the adapter's own store: `durableCoordinator.store ===
this.store` was verified nowhere, and the constructor performed no
binding check either. Meanwhile `DurableQuoteStore.beginDispatch`
inserted a write-ahead attempt without checking that
`intent.quoteId` named a quote durably stored in that same
database, or that the stored quote's subscription/provider matched
the intent. Split-ledger scenario: quote Q lives in Store A; the
adapter is configured with Store A + Coordinator B (bound to Store
B, which has no Q). B's `beginDispatch` accepted an attempt for the
non-existent Q and authorized the mutation; the receipt landed in
A (which had no intent) while B's settle found no quote evidence
and settled INDETERMINATE. Each database stayed individually
coherent; the atomic intent↔receipt association was void.

**Fix (two composing layers).** (1) Adapter binding:
`beginDurableAttempt` now refuses — after the unchanged live-commit
gate and the D4 missing-coordinator check, before any mutating
call — unless the configured coordinator's store IS this adapter's
store object and is a `DurableQuoteStore`. A coordinator over a
different durable store, or over a plain in-memory `QuoteStore`
(a cast away in TypeScript, a plain mistake in JavaScript),
is refused with `blocked: "DURABLE_COORDINATOR_STORE_MISMATCH"`,
distinctly from D4's `DURABLE_COORDINATOR_REQUIRED`. (2)
Store-side association: `beginDispatch` validates, inside the same
`BEGIN IMMEDIATE` transaction as its existing request-hash,
key-binding, and D2 exclusion checks, that `intent.quoteId` names
a quote durably stored in this database (a row in the `quotes`
table) and that the stored row's `subscription_id` / `provider`
match the intent. A refusal throws `DispatchBlockedError` inside
the transaction, so it rolls back and leaves zero new attempt
rows — no orphan attempts, whatever entry point (adapter or direct
coordinator) presented the intent. The two layers compose: the
adapter check catches the misconfiguration at the integration
boundary with a configuration error, and the store check makes
the invariant hold for every caller of the ledger, not only the
Chargebee adapter.

**Regressions.** 30.1 (the review's scenario end-to-end on two
separate temporary SQLite databases: quote created via Store A;
adapter = Store A + `liveCommitEnabled: true` + coordinator bound
to Store B ⇒ the commit is refused as a binding mismatch before
any mutation — mock mutation count 0 — Store B contains zero
attempts for the quote and its recovery report shows no unresolved
attempt, and Store A contains no attempt either), 30.2 (a
coordinator bound to a plain in-memory `QuoteStore` supplied to an
adapter with a `DurableQuoteStore` ⇒ the same named refusal, zero
mutations), 30.3 (direct `beginDispatch` for a quote the database
does not hold ⇒ `DispatchBlockedError`, zero attempt rows; the
same refusal through `coordinator.execute`, whose dispatch
function is never invoked), 30.4 (`beginDispatch` whose
subscription differs from the stored quote's ⇒ refused, zero
attempts), 30.5 (`beginDispatch` whose provider differs ⇒
refused, zero attempts), 30.6 (positive control: coordinator
bound to the SAME store object as the adapter commits end-to-end —
COMMITTED_AND_VERIFIED, one mutation, the settled attempt in the
same database; the restarted cross-instance flow remains pinned
by 28.1).

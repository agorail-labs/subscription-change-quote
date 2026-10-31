# Durable INDETERMINATE Recovery Evidence (P0, Issue #43)

Status: implementation record for the `fix/p0-durable-indeterminate-evidence`
change. Mock / durable-store evidence only — no live provider was touched.
Related: G-21(2), PR #41, spec §6.15 / §6.16 (both FROZEN; nothing in the
spec files is changed by this work).

## 1. The original vulnerability (exact)

`DurableQuoteStore.resolveAttempt(attemptId, note: string)` (schema v1):

- accepted a **free-text string** as its only evidence input;
- performed **no state check** (any attempt, in any state, could be
  "resolved") and **no evidence validation** of any kind;
- in one transaction set `operator_review_state = 'RESOLVED'` and appended
  the note to `attempt_history` — a table the store exposes **no reader**
  for. `StoredAttempt` carried no structured resolution-evidence field
  (pinned as a limitation by test56.4).

`findBlockingAttempt` blocked on `DISPATCHING`, or on `INDETERMINATE`
with `operator_review_state != 'RESOLVED'` — so **the flag alone lifted
the block**. `beginDispatch`'s same-key branch correctly returned the
standing INDETERMINATE attempt once resolved (never re-armed), but a
**new idempotency key then dispatched freely** (test56.5 semantics).

Net effect: an operator assertion — with no persisted, structured,
operation-bound evidence of what happened at the provider — was converted
into dispatch eligibility for a different key against the same
subscription. If the original mutation had in fact landed, the new
dispatch could execute a duplicate change. The recovery process turned
an operator assertion into proof of non-execution, which §6.15 forbids:
reconciliation must establish what landed, and state matching alone is
never landing proof.

## 2. Failing-first evidence

`reference/tests/test58-indeterminate-recovery-evidence.test.ts` was
written against the new contract first and run against the **unmodified
main** implementation (Node 22, local):

- **16 tests, 0 pass, 16 fail.**
- Failure modes were the vulnerability itself, not environment errors:
  the free-text call succeeded instead of refusing ("Missing expected
  exception: a string note is not resolution evidence"); empty /
  operator-assertion / snapshot sources were accepted; foreign binding
  fields and foreign request hashes were accepted; replayed evidence was
  accepted; stale observations were accepted; no resolution record
  existed after a "resolution" ("a structured resolution record
  exists"); no v2 migration occurred.

After the implementation: **test58 16/16 pass**, test56 9/9 pass,
full suite **819/819** (baseline main: 803/803; +16 net new tests, no
pre-existing test count changed).

## 3. Proposed recovery state machine

An INDETERMINATE attempt's dispatch effect, by resolution state:

| Resolution state | Same key (standing attempt) | New key, SAME quote | New key, OTHER quote, same subscription |
| --- | --- | --- | --- |
| No evidence (incl. legacy flag-only `RESOLVED`) | Blocked (blind-retry prohibition) | Blocked | Blocked |
| UNRESOLVED record only | Blocked | Blocked | Blocked |
| CONFIRMED_NON_EXECUTION | Returns standing attempt, never re-armed | **Permitted** (all other gates still apply) | **Permitted** |
| CONFIRMED_LANDING | Returns standing attempt, never re-armed | Blocked (would duplicate the landed operation) | **Permitted** (new, separately authorized change on the reconciled state) |

DISPATCHING attempts always block, in every row. No resolution ever
re-arms the INDETERMINATE attempt itself, and no path retries it
automatically.

Classifications:

- **CONFIRMED_NON_EXECUTION** — the specific attempted operation is
  independently established not to have executed, by operation-bound
  provider evidence (below). Any subsequently permitted dispatch must
  still satisfy all existing authorization, idempotency, freshness,
  and exclusion gates.
- **CONFIRMED_LANDING** — operation-bound evidence establishes the
  operation landed, with its provider operation id. This does not
  authorize blind re-dispatch; the landed state and its financial
  consequences are reconciled (decision
  `RECONCILE_LANDED_STATE_NO_REDISPATCH`).
- **UNRESOLVED** — evidence is absent, ambiguous, stale, or
  insufficiently bound to the attempted operation. The record is
  appended for audit; the blocking condition remains.

A provider-state snapshot that merely **matches** the intended final
state is never proof that the specific attempt executed (or did not):
`PROVIDER_STATE_SNAPSHOT` / `STATE_SNAPSHOT_MATCH` refuses for both
terminal classifications.

## 4. Structured evidence model

New append-only table `attempt_resolutions` (schema v2). No code path
updates or deletes from it. The binding fields are **copied from the
attempt row**, never accepted from the caller; a caller-supplied binding
assertion (attemptId / quoteId / subscriptionId / provider / site /
requestHash / idempotencyKey) that disagrees with the attempt refuses.

| Field | Source / rule |
| --- | --- |
| `resolution_id` | Store-minted primary key |
| `attempt_id`, `quote_id`, `subscription_id`, `provider`, `site`, `request_hash`, `idempotency_key` | Copied from the attempt row |
| `classification` | `CONFIRMED_NON_EXECUTION` \| `CONFIRMED_LANDING` \| `UNRESOLVED` |
| `operator_id` | Caller; non-empty (asserted identity — see Limitations) |
| `resolved_at` | Store clock (`nowFn`) at resolution |
| `evidence_source` | Terminal only: `PROVIDER_OPERATION_LOG` \| `PROVIDER_IDEMPOTENCY_REGISTRY` \| `PROVIDER_AUDIT_EXPORT` |
| `evidence_kind` | Terminal only, operation-bound per classification: non-execution ∈ {`OPERATION_LOG_NO_RECORD_FOR_KEY`, `IDEMPOTENCY_REGISTRY_NO_RECORD_FOR_KEY`}; landing ∈ {`OPERATION_LOG_RECORD_FOR_KEY`, `PROVIDER_OPERATION_RECEIPT_FOR_KEY`} |
| `evidence_reference` | Non-empty for terminal; one (source, reference) pair establishes exactly one attempt's terminal resolution (replay refuses; partial unique index backstop) |
| `observed_at` | Terminal only: parseable ISO, ≥ attempt creation, ≤ resolution time, ≤ 24h old at resolution (`RESOLUTION_EVIDENCE_MAX_AGE_MS`) |
| `observed_provider_state_digest` | Terminal only: 64-char lowercase hex sha256 of the observed provider state |
| `provider_operation_id` | Landing only: required non-empty; must be absent for non-execution |
| `reconciliation_decision` | Non-execution: `PERMIT_NEW_DISPATCH`; landing: `RECONCILE_LANDED_STATE_NO_REDISPATCH` |
| `justification` | Caller; non-empty |
| `evidence_payload_json` / `evidence_hash` | Canonical payload of every binding + evidence field; `evidence_hash = sha256(canonicalStringify(payload))`, UNIQUE |

Integrity on open: `loadAndRecover` re-verifies **every** resolution
row — hash recomputed from the payload, payload binding equal to the
row columns, referenced attempt present with matching identity fields.
Any mismatch throws `DurableRecoveryError` and the store does not open
(fail closed, the same discipline as receipt corruption).

Atomicity: validation that can refuse runs inside one
`BEGIN IMMEDIATE` transaction together with the insert, the
`operator_review_state` flip (terminal classifications only), and the
history entry. `faults.beforePersist("resolveAttempt")` /
`faults.insidePersistTx("resolveAttempt")` follow the existing
persistQuote poison discipline: non-evidence errors poison the store;
`ResolutionEvidenceError` / `DispatchBlockedError` do not. A refusal
persists zero resolution rows and leaves the attempt blocked.

## 5. Migration and compatibility findings

- `DURABLE_SCHEMA_VERSION` 1 → 2.
- Fresh database: all v1 tables plus `attempt_resolutions` and its
  indexes, version marker `'2'`, one transaction.
- v1 database: **one transaction** creates the table and indexes and
  sets the marker to `'2'`. No existing row is created, altered, or
  deleted (test58.14b builds a hand-made v1 database and verifies the
  pre-existing INDETERMINATE attempt survives intact and blocking, and
  that the resolutions table starts empty).
- Any other version (0, 3+, non-numeric, missing) refuses the open, as
  before.
- **Legacy flag-only records**: a v1 attempt with
  `operator_review_state = 'RESOLVED'` and no resolution row is
  preserved verbatim but **remains blocking** under the
  evidence-derived rules (test58.14a). It is never silently upgraded
  into a resolved record; an operator must supply structured evidence
  through the new path to lift its block.
- API compatibility: `resolveAttempt`'s signature changed from
  `(attemptId, note: string)` to `(attemptId, evidence:
  ResolutionEvidenceInput)` — a deliberate breaking change to the
  unsafe call shape; a runtime non-object argument refuses with
  `ResolutionEvidenceError` (`RESOLUTION_EVIDENCE_REFUSED`).
  `StoredAttempt` is unchanged. New exports: `ResolutionEvidenceError`,
  `RESOLUTION_EVIDENCE_MAX_AGE_MS`, `ResolutionClassification`,
  `ResolutionEvidenceInput`, `StoredResolution`,
  `DurableQuoteStore.getResolution`, `resolutionsForAttempt`.
- `recoveryReport()` INDETERMINATE items now carry
  `resolution: { classification, evidenceHash }` and name structured
  evidence in `nextPermittedAction` (the sentence "No automatic
  re-dispatch is permitted." is retained verbatim).
- Untouched, by design: G-17 authorization-preservation refusal paths,
  live adapters, `scq-engine.ts`, `types.ts`, `quote-store.ts`, the
  CONFIRMED_NON_EXECUTION **attempt-state** same-key re-arm in
  `beginDispatch`, and both spec files (freeze guard footprint empty).

## 6. Remaining limitations

- **Operator identity is asserted, not authenticated.** The store
  records `operatorId` for audit; authenticating the operator is the
  embedding service's responsibility.
- **Evidence authenticity rests on the operator's provider lookup.**
  The store binds, timestamps, hashes, and preserves the evidence
  record and refuses structurally insufficient evidence — it cannot
  itself verify that a provider operation log actually says what the
  record claims. That is precisely why the record is immutable and
  hash-verified: a false record is permanently attributable, never
  silently editable.
- **Snapshot evidence is deliberately insufficient.** A matching
  provider state can arise from another actor's identical change
  (§6.15); only operation-bound records (operation log / idempotency
  registry / audit export, keyed to this attempt) can terminate an
  INDETERMINATE block.
- The 24h freshness window is a policy constant of this
  implementation, not a spec value.
- UNRESOLVED records are audit-only and carry optional evidence
  fields; they are shape-validated when present but establish
  nothing.

## 7. PROPOSED normative change — NOT enacted (governance decision required)

The spec files are frozen and are **not** changed by this work. The
following §6.16 amendment is proposed for separate review; enacting it
requires explicit protocol freeze approval (`protocol-change-approved`)
through the normal maintainer process:

> **Proposed §6.16 addition (for maintainer review only):** An
> INDETERMINATE attempt's dispatch block MUST NOT lift on an operator
> assertion alone. Lifting the block requires a durable, append-only
> resolution record bound to the attempt (quote, subscription,
> provider, site, request hash, and idempotency key), classifying the
> outcome as CONFIRMED_NON_EXECUTION or CONFIRMED_LANDING on the basis
> of independently obtained, operation-bound provider evidence
> (provider operation log, idempotency registry, or audit export,
> referenced and freshly observed), with the operator identity,
> observation digest, and reconciliation decision recorded. A record
> classifying the outcome UNRESOLVED, a free-text note, or an observed
> provider state that merely matches the intended outcome MUST NOT
> lift the block; a CONFIRMED_LANDING record MUST NOT authorize
> re-dispatch against its own quote.

Until that amendment is approved, this implementation is stricter
than the current §6.16 text where they differ (the implemented
same-subscription keying divergence tracked in G-21 is unchanged).

## 8. Security / regression audit summary

- **Transaction atomicity**: insert + flag flip + history in one
  immediate transaction; crash-in-transaction test (58.8) leaves no
  row and a still-blocked attempt after reopen.
- **SQLite persistence / migration**: v1→v2 single-transaction
  migration (58.14b); unsupported versions still refuse.
- **Crash consistency**: fault-injection at both persist boundaries;
  non-evidence failures poison the instance rather than serving
  volatile state.
- **Authorization / identity binding**: binding copied from the
  attempt row; disagreeing caller assertions refuse (58.3, 58.4);
  cross-subscription isolation control (58.3).
- **Concurrency / exclusion**: terminal-resolution existence is
  checked inside the immediate transaction (58.9: a second terminal
  resolution refuses with exactly one row persisted); DISPATCHING
  still always blocks.
- **Evidence immutability**: no update/delete code paths for
  `attempt_resolutions`; tampered payloads refuse the whole open
  (58.5b); replayed (source, reference) refuses (58.5a).
- **Receipt replay semantics**: unchanged — same-key terminal
  resolutions return the standing attempt (58.7, 58.13); the
  attempt-state CONFIRMED_NON_EXECUTION re-arm path is untouched.
- **Operator identity / auditability**: operator id, justification,
  timestamps, and the evidence hash are recorded for every record,
  including UNRESOLVED ones; the attempt history notes the
  classification, evidence reference, and hash prefix.
- **Fail-closed behaviour**: every refusal path persists nothing and
  leaves the block in place; legacy flag-only records remain blocked.

## 9. Test results (local)

- Node v22.14.0 (locally installed toolchain; system node is v24):
  build clean; full suite **819/819 pass** (baseline main 803/803).
- Node v20.18.1 (locally installed toolchain + matching prebuilt
  better-sqlite3 binding): full suite **819/819 pass**.
- test56: 9/9; test58: 16/16 (failing-first on baseline: 0/16).
- Provider neutrality check (workflow script run locally): OK.
- Protocol freeze guard footprint:
  `git diff --name-only main...HEAD -- spec/scq-v0.6.1-spec.md
  spec/scq-v0.6.2-spec.md reference/src/core/types.ts
  reference/src/core/scq-engine.ts` → **empty**.
- CI (GitHub Actions, Node 20 + 22) is the authoritative record for
  the PR head; see the PR for exact run results.

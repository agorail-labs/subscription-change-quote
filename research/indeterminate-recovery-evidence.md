# Durable INDETERMINATE Recovery Evidence (P0, Issue #43)

Status: implementation record for the `fix/p0-durable-indeterminate-evidence`
change. Mock / durable-store evidence only — no live provider was touched.
Related: G-21(2), PR #41, spec §6.15 / §6.16 (both FROZEN; nothing in the
spec files is changed by this work).

**Correction round (PR #50 independent review, findings R1–R4 + two
documentation-accuracy items)** is incorporated throughout: §3 states
the corrected blocking matrix (R1), §4 the branded establishment
trust boundary (R2), the provider-finality rule (R3), and the landing
reconciliation barrier + stale-quote rule (R4); §5 the schema v3
migration and the v2 compatibility rule; §9 the correction-round
failing-first and final counts.

**Correction round 3 (PR #50 second-round security review, findings
R2′ and R4′)** is incorporated throughout: the round-2 establishment
procedure was a *public* export that branded caller-supplied records
(the brand proved processing, not provider origin), and the landing
barrier accepted caller digests. Round 3 removes the public minting
path entirely: evidence tokens are minted only by a capability
object — a provider-evidence **verifier** created over a
deployment-supplied record **source** that *retrieves* the record —
and a store accepts only its own configured verifier's tokens
(§4.1); the landing barrier is satisfied through the same boundary
with both digests computed from a fetched reconciliation record
(§4.3); operator claims without verified evidence are recorded at an
explicit ASSERTED trust tier that never lifts (§4.4); schema v4
backfills every pre-v4 evidence row to ASSERTED — preserved,
readable, non-lifting (§5); §9 the round-3 failing-first and final
counts.

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

Correction round: test58 was rewritten around the establishment flow
and test56.4/56.5 migrated, then run against the round-1 head
(`d0f35c8`) before any production change: **29 tests, 10 pass, 19
fail** (record: `P0-43-R234-FAILING-FIRST.txt` in the delivery
package). The failures are the findings themselves — e.g. 58.15
fails with "the removed raw-evidence acceptance refuses" *missing*
because the round-1 head accepts the flat raw evidence object; the
R1 assertions invert round-1's own 58.12 scenario B, which asserted
same-quote/new-key dispatch as permitted. After the correction:
**test58 20/20, test56 9/9, full suite 823/823** on both Node
versions (§9).

Correction round 3: test59 (the trust-boundary matrix, including
both reviewer counterexamples) was written and test58/test56
migrated to the verifier flow, then run against the round-2 head
(`2010e73`) before any production change: **35 tests, 11 pass, 24
fail** (record: `P0-43-R3-FAILING-FIRST.txt` in the delivery
package). Both counterexamples were additionally demonstrated live
against the round-2 build by a throwaway PoC: a fabricated final
"no record for key" record, minted through the then-public
`establishResolutionEvidence`, freed another quote on the
subscription (R2′); and `reconcileLandedAttempt` accepted
sha256("not actually reconciled") as the financial-outcome digest
and unblocked a fresh quote (R4′). After the correction: **test59
6/6, test58 20/20, test56 9/9, full suite 829/829** on both Node
versions (§9).

## 3. Proposed recovery state machine

An INDETERMINATE attempt's dispatch effect, by resolution state:

| Resolution state | Same key (standing attempt) | New key, SAME quote | New key, OTHER quote, same subscription |
| --- | --- | --- | --- |
| No evidence (incl. legacy flag-only `RESOLVED`, v2-era terminal records without provider finality, and pre-v4 ASSERTED-tier records — §5) | Blocked (blind-retry prohibition) | Blocked | Blocked |
| UNRESOLVED record only | Blocked | Blocked | Blocked |
| ASSERTED terminal claim recorded (`recordAssertedResolution`, unverified — round 3) | Blocked | Blocked | Blocked |
| CONFIRMED_NON_EXECUTION (VERIFIED: established through the store's configured verifier, with finality) | Returns standing attempt, never re-armed | **Blocked** (R1: §6.15 new-quote rule) | **Permitted** (a genuinely new quote; all other gates still apply) |
| CONFIRMED_LANDING (VERIFIED), reconciliation NOT recorded | Returns standing attempt, never re-armed | Blocked | **Blocked** (R4: unreconciled landing blocks the whole subscription) |
| CONFIRMED_LANDING (VERIFIED), reconciliation recorded (VERIFIED, through the same verifier boundary) | Returns standing attempt, never re-armed | Blocked (would duplicate the landed operation) | **Permitted only for a fresh, non-stale quote** (issued after the landing resolution AND computed against the landed state version; stale quotes refuse) |

Round 3 adds the trust dimension to every row: only VERIFIED
records — established through the verifier instance the store was
configured with — can lift anything. A store with **no verifier
configured** (the production default: the library ships no record
source) can record only UNRESOLVED audit records and ASSERTED
claims, so every INDETERMINATE attempt stays in the blocked rows
above until a deployment configures a verifier over a record
source it trusts.

DISPATCHING attempts always block, in every row. No resolution ever
re-arms the INDETERMINATE attempt itself, and no path retries it
automatically.

**R1 correction.** Round 1 permitted a new key on the resolved
attempt's OWN quote after CONFIRMED_NON_EXECUTION. The review found
this conflicts with frozen §6.15: re-authorization after
INDETERMINATE proceeds as a **new quote**, never as a re-issue of
the indeterminate attempt. The same-quote/same-key re-arm exception
in `beginDispatch` applies only to attempts that were ORIGINALLY
terminal CONFIRMED_NON_EXECUTION (an attempt-state path, untouched
by this change) — it does not extend to a retroactively resolved
INDETERMINATE attempt. Both terminal classes therefore keep the old
quote blocked for any key.

Classifications:

- **CONFIRMED_NON_EXECUTION** — the specific attempted operation is
  established not to have executed, by an established provider
  record with provider finality (§4), recorded at the VERIFIED
  trust tier. Any subsequently permitted dispatch is a new quote
  and must still satisfy all existing authorization, idempotency,
  freshness, and exclusion gates.
- **CONFIRMED_LANDING** — an established provider record establishes
  the operation landed, with its provider operation id, recorded at
  the VERIFIED trust tier. This does not authorize blind
  re-dispatch (decision `RECONCILE_LANDED_STATE_NO_REDISPATCH`),
  and it does not by itself unblock anything: the landed state and
  its financial consequences must be reconciled through the
  separate recorded barrier (§4) before other quotes may proceed,
  and then only fresh quotes validated against the landed state.
- **UNRESOLVED** — evidence is absent, ambiguous, stale, premature
  (finality unavailable), or insufficiently bound to the attempted
  operation. Recorded via `recordUnresolvedResolution` for audit;
  the blocking condition remains.
- **ASSERTED claim** (round 3, not a resolution) — an operator's
  terminal claim (either classification) recorded via
  `recordAssertedResolution` WITHOUT verified evidence, at the
  ASSERTED trust tier. It is an explicitly labelled human claim —
  never presented as independently verified provider evidence —
  and it lifts nothing: the attempt keeps blocking, and the
  recovery report surfaces it as `ASSERTED_UNVERIFIED` with
  intervention still required. A later VERIFIED resolution
  supersedes it.

A provider-state snapshot that merely **matches** the intended final
state is never proof that the specific attempt executed (or did not):
`PROVIDER_STATE_SNAPSHOT` / `STATE_SNAPSHOT_MATCH` refuses for both
terminal classifications.

## 4. Structured evidence model

### 4.1 The trust boundary: capability-gated verification (R2, hardened R2′)

Round 1's `resolveAttempt` accepted a raw caller-asserted evidence
object — enum strings, an arbitrary reference, a caller-supplied
digest. Round 2 adopted the codebase's branded-verifier pattern
(quote-store's `establishVerification`, PR #8 R3 / PR-17): a
module-level establishment procedure validated a provider-record
object and minted a branded token, and `resolveAttempt` accepted
only branded tokens. The second-round review (R2′) found the
remaining gap: that procedure was **publicly exported** and took
the record **from the caller** — so the brand proved the record had
been *processed*, not that it came from a provider, and a developer
with `getAttempt()` but no provider access could fabricate a final
"no record for key" record, mint a genuine token, and free another
quote (demonstrated live against the round-2 build, §2).

Round 3 closes the boundary with a capability shape:

- **No public minting path.** The establishment computation is now
  a **private core** inside the store module. There is no exported
  function that mints a token from a caller-supplied record.
- **Verifier + source.** `createProviderEvidenceVerifier(source)`
  creates a verifier over an injected `ProviderRecordSource`. Its
  `establish(attempt, classification, now)` **builds the lookup
  query from the attempt binding** (provider, site, subscription,
  quote, idempotency key, request hash), calls
  `source.fetchOperationRecord(query)`, and runs the round-2
  validation/finality core over the **fetched** record. The caller
  never supplies a record in the lifting path. The library ships
  **no** `ProviderRecordSource` implementation.
- **Instance-bound acceptance.** The token's minting-time binding
  now also stamps the **verifier instance identity**. The store is
  configured with one verifier (`DurableStoreOptions.evidenceVerifier`)
  and `resolveAttempt` accepts a token **only** if it was minted by
  that instance: unbranded, altered, cross-attempt, and
  foreign-verifier tokens all refuse.
- **Fail-closed default.** A store with **no configured verifier**
  refuses every terminal resolution — there is no capability to
  establish lifting evidence. Operators can still record
  UNRESOLVED audit records (`recordUnresolvedResolution`) and
  ASSERTED claims (`recordAssertedResolution`), neither of which
  lifts anything.

**The residual trust decision is explicit and deployment-side:**
whoever configures the record source behind a store's verifier
decides what counts as a provider read (e.g. an adapter performing
an authenticated provider operation-log lookup, or an internal
reconciliation service). That decision is made in deployment
configuration, reviewed as such — it is not smuggled into a library
call by whoever happens to hold a store handle. Out of the box,
with no source configured anywhere, **nothing can lift a block** —
that is the production-facing default, and no production unblock
path is claimed by this PR: no live adapter produces these records,
and no `ProviderRecordSource` ships.

Establishment (inside the verifier) validates:

- **Binding** — provider, site, subscription, quote, idempotency
  key, and request hash all equal the attempt's. A record about a
  different operation establishes nothing about this one.
- **Source / kind pairing** — source ∈ {`PROVIDER_OPERATION_LOG`,
  `PROVIDER_IDEMPOTENCY_REGISTRY`, `PROVIDER_AUDIT_EXPORT`}; kind is
  the classification's operation-bound kind (non-execution ∈
  {`OPERATION_LOG_NO_RECORD_FOR_KEY`,
  `IDEMPOTENCY_REGISTRY_NO_RECORD_FOR_KEY`}; landing ∈
  {`OPERATION_LOG_RECORD_FOR_KEY`,
  `PROVIDER_OPERATION_RECEIPT_FOR_KEY`}). A state snapshot refuses:
  matching state is not operation attribution.
- **Outcome coherence** — non-execution requires
  `operationFound === false` and no provider operation id; landing
  requires `operationFound === true`, the non-empty operation id,
  and an observed state that is the landed subscription state
  carrying a non-empty string `version` (extracted as
  `landedStateVersion`; the stale-quote rule keys on it).
- **Digest** — computed at establishment from the record's
  `observedState` (`sha256(canonicalStringify(observedState))`);
  callers never supply one.
- **Finality (R3, below).**

### 4.2 Provider finality (R3)

"No record for key" may be premature: a provider's log or registry
can lag the dispatch. Absence becomes CONFIRMED_NON_EXECUTION only
when the provider record is final past the settlement:

- `observedAt` is **strictly after** the attempt settled
  INDETERMINATE (`attempt.updatedAt`);
- the log/registry is declared final (`logFinal === true`);
- its completeness watermark `completeThrough` **covers the
  settlement** (`completeThrough >= attempt.updatedAt`);
- an idempotency-registry record declares `registryCoverage ===
  "FULL"` (PARTIAL / UNKNOWN refuse);
- the observation is not future-dated.

If finality is unavailable, the outcome stays UNRESOLVED. Negative
pins: pre-settlement (or at-settlement) observation, not-yet-final
log, incomplete watermark, partial/unknown coverage (test58.16).

### 4.3 The landing reconciliation barrier and stale-quote rule (R4, hardened R4′)

A CONFIRMED_LANDING resolution is a classification, not an unblock.
Unblocking requires a separate recorded barrier. Round 2's barrier
took caller-supplied digests (`landedStateDigest` +
`financialOutcomeDigest`): the first merely had to equal the
resolution's (publicly readable) digest and the second merely had
to *look like* a sha256 — sha256("not actually reconciled")
satisfied it (R4′; demonstrated live, §2). A correctly formatted
hash is not reconciliation. Round 3 removes every caller-supplied
digest and record input from the path:

- `reconcileLandedAttempt(attemptId, { operatorId, justification })`
  — the caller supplies only attribution. The store invokes **its
  own configured verifier's** `establishReconciliation(attempt,
  resolution)`, which builds a reconciliation query bound to the
  attempt **and to the resolution's evidence reference**, calls the
  source's `fetchFinancialReconciliation(query)`, and validates the
  fetched `FinancialReconciliationRecord`: every binding field
  equals the attempt's; `resolutionReference` equals the
  resolution's evidence reference; the record's `landedState`
  object **digests — computed by the verifier — to exactly the
  resolution's established observed-state digest** (the
  reconciliation must be *of* the established landed state); the
  financial-outcome digest is **computed by the verifier from the
  record's `financialOutcome` object**, never supplied. An input
  carrying the old digest fields refuses explicitly.
- The resulting row (append-only `landing_reconciliations`, schema
  v4) persists at the **VERIFIED** tier with the reconciliation
  record's own reference as `evidenceReference`. One reconciliation
  per attempt; a second refuses.
- A store with no verifier, or whose source lacks
  `fetchFinancialReconciliation`, **refuses** — the barrier cannot
  be satisfied until an independent reconciliation source is
  configured (fail closed). An ASSERTED landing claim satisfies
  nothing here: there is no established landing to reconcile.
- Without the (VERIFIED) row, the landed attempt blocks the
  **whole subscription**. With it, other quotes unblock subject to
  the stale-quote rule, enforced inside the `beginDispatch`
  transaction from the stored quote row: a candidate quote refuses
  as **stale** if it was issued at or before the landing resolution
  (`created_at <= resolvedAt`) or was computed against a different
  subscription version than the landed state
  (`subscription_version_at_quote !== landedStateVersion`). Only a
  fresh quote validated against the landed state may dispatch. The
  landed attempt's own quote remains blocked regardless (R1).

### 4.4 Persisted records

Append-only table `attempt_resolutions` (schema v2; v3/v4 columns
below). No code path updates or deletes from it. The binding fields
are **copied from the attempt row via the established token**, never
accepted as free caller fields. Since round 3 every row also
carries a **trust tier**: `VERIFIED` only for records established
through a store-configured verifier (the only tier any blocking
lookup consults); `ASSERTED` for operator claims, UNRESOLVED audit
records, and — by migration backfill — every pre-v4 row.

| Field | Source / rule |
| --- | --- |
| `resolution_id` | Store-minted primary key |
| `attempt_id`, `quote_id`, `subscription_id`, `provider`, `site`, `request_hash`, `idempotency_key` | Copied from the attempt row (via the token the establishment procedure bound to it) |
| `classification` | `CONFIRMED_NON_EXECUTION` \| `CONFIRMED_LANDING` \| `UNRESOLVED` |
| `operator_id` | Caller; non-empty (asserted identity — see Limitations) |
| `resolved_at` | Store clock (`nowFn`) at resolution |
| `evidence_source` | Terminal only: `PROVIDER_OPERATION_LOG` \| `PROVIDER_IDEMPOTENCY_REGISTRY` \| `PROVIDER_AUDIT_EXPORT` |
| `evidence_kind` | Terminal only, operation-bound per classification (see §4.1) |
| `evidence_reference` | Non-empty for terminal; one (source, reference) pair establishes exactly one attempt's terminal resolution (replay refuses; partial unique index backstop) |
| `observed_at` | Terminal only: the established observation; post-settlement by establishment; ≤ 24h old at resolution (`RESOLUTION_EVIDENCE_MAX_AGE_MS`) |
| `observed_provider_state_digest` | Terminal only: computed at establishment from the record's observed state |
| `provider_operation_id` | Landing only: required non-empty; must be absent for non-execution |
| `reconciliation_decision` | Non-execution: `PERMIT_NEW_DISPATCH`; landing: `RECONCILE_LANDED_STATE_NO_REDISPATCH` |
| `justification` | Caller; non-empty |
| `log_final`, `complete_through`, `registry_coverage`, `landed_state_version` | **v3**: the finality and landed-version facts attested at establishment, persisted with the record (v4 payloads record `establishmentProcedure: "createProviderEvidenceVerifier"`; v3-era payloads name the removed round-2 procedure) |
| `trust_tier` | **v4**: `VERIFIED` (established through the store's configured verifier; the only lifting tier) \| `ASSERTED` (operator claim, UNRESOLVED audit record, or pre-v4 backfill) |
| `evidence_payload_json` / `evidence_hash` | Canonical payload of every binding + evidence field; `evidence_hash = sha256(canonicalStringify(payload))`, UNIQUE |

**Checksum language (documentation-accuracy item a).** The stored
hashes are **internal-consistency checksums**, not anti-tamper
authentication: on open, `loadAndRecover` re-computes each row's
checksum from its payload and checks the payload's binding against
the row columns and the referenced attempt's identity fields, and
any mismatch refuses the whole open (fail closed, the same
discipline as receipt corruption). This detects mismatched or
transplanted edits. It is an *unkeyed* digest: a writer who can
rewrite both the payload and the digest consistently can recompute
it, and is outside this mechanism's threat model — the same
disclosed posture as the quote/receipt record checksums.

Atomicity: validation that can refuse runs inside one
`BEGIN IMMEDIATE` transaction together with the insert, the
`operator_review_state` flip (terminal classifications only), and
the history entry. `faults.beforePersist("resolveAttempt")` /
`faults.insidePersistTx("resolveAttempt")` follow the existing
persistQuote poison discipline: non-evidence errors poison the
store; `ResolutionEvidenceError` / `DispatchBlockedError` do not. A
refusal persists zero resolution rows and leaves the attempt
blocked. The same discipline applies to
`recordUnresolvedResolution`, `recordAssertedResolution`, and
`reconcileLandedAttempt` (own fault keys), and
landing-reconciliation rows are checksum-verified and
resolution-bound on open exactly like resolution rows (round 3:
their payloads also carry `trust_tier` and `evidence_reference`,
verified against the columns with the pre-v4 defaults ASSERTED /
null).

## 5. Migration and compatibility findings

- `DURABLE_SCHEMA_VERSION` 1 → 2 (round 1) → 3 (correction round)
  → **4** (correction round 3).
- Fresh database: all v1 tables plus `attempt_resolutions` (v4
  shape) and `landing_reconciliations` (v4 shape) with their
  indexes, version marker `'4'`, one transaction.
- v1 database: **one transaction** creates both tables at their v4
  shape and sets the marker to `'4'`. No existing row is created,
  altered, or deleted (test58.14b builds a hand-made v1 database and
  verifies the pre-existing INDETERMINATE attempt survives intact
  and blocking, and that the resolutions table starts empty).
- v2 database: **one transaction** adds the four v3 columns to
  `attempt_resolutions` (`log_final`, `complete_through`,
  `registry_coverage`, `landed_state_version`), creates
  `landing_reconciliations` at its v4 shape, adds `trust_tier`,
  backfills it (below), re-scopes the replay index, and sets the
  marker to `'4'`. No existing row is altered in content.
- v3 database: **one transaction** adds `trust_tier` to
  `attempt_resolutions` and `trust_tier` + `evidence_reference` to
  `landing_reconciliations`, backfills, re-scopes the replay index
  to VERIFIED rows, and sets the marker to `'4'`.
- **v4 trust backfill rule**: EVERY pre-v4 resolution and
  reconciliation row backfills `trust_tier = 'ASSERTED'`. The rule
  is deliberately conservative: pre-v4 terminal evidence was minted
  through the now-removed public establishment function (R2′) and
  pre-v4 barrier records rested on caller digests (R4′) — under
  the round-3 boundary neither is trusted, so no pre-v4 row may
  keep lifting. Rows remain **preserved and readable**
  (`getResolution` / `resolutionsForAttempt` /
  `landingReconciliationRecordFor`); `terminalResolutionFor` and
  `landingReconciliationFor` — the only lookups the blocking paths
  consult — return **VERIFIED rows only** (with finality on
  record), so migrated attempts return to blocking until a fresh
  v4 resolution is established through a configured verifier from a
  fresh provider record (the ASSERTED row does not trigger
  `ALREADY_RESOLVED`, which reads through the same VERIFIED-only
  lookup; re-presenting a pre-v4 record's own (source, reference)
  still refuses as replay under `resolveAttempt`'s explicit check,
  so the fresh resolution rests on a fresh provider record with a
  fresh reference). test59.5 builds a
  hand-made v3 database whose terminal resolution + reconciliation
  *were* lifting under v3 and verifies they are preserved,
  ASSERTED, and non-lifting under v4, and that a fresh v4 VERIFIED
  resolution lifts.
- **v2 compatibility rule** (unchanged, subsumed by the tier
  rule): a v2-era terminal resolution row migrates with
  `log_final` NULL — provider finality was never attested for it
  under the v3 rules — so it is **preserved as a record but
  NON-LIFTING** on that ground too (test58.14c).
- Any other version (0, 5+, non-numeric, missing) refuses the open,
  as before.
- **Legacy flag-only records**: a v1 attempt with
  `operator_review_state = 'RESOLVED'` and no resolution row is
  preserved verbatim but **remains blocking** under the
  evidence-derived rules (test58.14a). It is never silently upgraded
  into a resolved record; an operator must supply structured evidence
  through the new path to lift its block.
- API compatibility: `resolveAttempt` was re-signed twice, each time
  deliberately breaking the unsafe call shape: `(attemptId, note:
  string)` → round 1 `(attemptId, evidence:
  ResolutionEvidenceInput)` → correction round `(attemptId, {
  evidence: EstablishedResolutionEvidence, operatorId,
  reconciliationDecision, justification })`. A runtime non-object
  argument, or any raw (unbranded) evidence, refuses with
  `ResolutionEvidenceError` (`RESOLUTION_EVIDENCE_REFUSED`).
  `StoredAttempt` is unchanged. New in the correction round:
  `establishResolutionEvidence`, `recordUnresolvedResolution`,
  `reconcileLandedAttempt`, `landingReconciliationFor`, and the
  types `ResolutionProviderRecord`, `EstablishedResolutionEvidence`,
  `ResolveAttemptInput`, `ResolutionEvidenceSource`,
  `StoredLandingReconciliation`; `StoredResolution` gains
  `logFinal`, `completeThrough`, `registryCoverage`,
  `landedStateVersion`, `establishmentProcedure`. The round-1 export
  `ResolutionEvidenceInput` is removed (nothing in the repo consumed
  it outside the store and its tests).
- **Round-3 API changes**: the export `establishResolutionEvidence`
  is **removed** (the computation is now the verifier's private
  core). New exports: `createProviderEvidenceVerifier` and the
  types `ProviderRecordSource`, `ProviderOperationRecordQuery`,
  `ProviderReconciliationQuery`, `FinancialReconciliationRecord`,
  `ResolutionEvidenceVerifier`, `EstablishedLandingReconciliation`,
  `ResolutionTrustTier`. `DurableStoreOptions` gains
  `evidenceVerifier`. New store methods: `recordAssertedResolution`
  and `landingReconciliationRecordFor` (the raw, any-tier barrier
  reader; `landingReconciliationFor` is now VERIFIED-only).
  `reconcileLandedAttempt` is re-signed `(attemptId, { operatorId,
  justification })` — the digest inputs are removed, and an input
  carrying them refuses explicitly. `StoredResolution` gains
  `trustTier`; `StoredLandingReconciliation` gains `trustTier` and
  `evidenceReference`. Persisted v4 resolution payloads record
  `establishmentProcedure: "createProviderEvidenceVerifier"`.
- `recoveryReport()` INDETERMINATE items carry
  `resolution: { classification, evidenceHash }`, and — correction
  round, documentation-accuracy item (b) —
  `operatorInterventionRequired` / `nextPermittedAction` are now
  **derived from the attempt's actual terminal record**: a
  CONFIRMED_NON_EXECUTION resolution reports no intervention
  required and names the new-quote rule; an unreconciled
  CONFIRMED_LANDING reports intervention required and names the
  reconciliation barrier; a reconciled landing reports no
  intervention and the fresh-quote-only unblock; an unresolved
  attempt keeps the manual-reconciliation text verbatim
  (test27.25's `/Reconcile manually/` expectation preserved, and
  "No automatic re-dispatch is permitted." appears in every
  INDETERMINATE action). The historical INDETERMINATE outcome
  itself is never rewritten by a resolution. Round 3: the
  `resolution` object also carries `trustTier` (`"VERIFIED"` for a
  VERIFIED terminal record, `"ASSERTED_UNVERIFIED"` when only an
  asserted claim exists, `null` otherwise); an ASSERTED claim
  derives intervention-required with a next action that names the
  claim as unverified and the attempt as still blocked
  (test59.1/59.6), while the VERIFIED derivations above are
  unchanged.
- Untouched, by design: G-17 authorization-preservation refusal paths,
  live adapters, `scq-engine.ts`, `types.ts`, `quote-store.ts`, the
  CONFIRMED_NON_EXECUTION **attempt-state** same-key re-arm in
  `beginDispatch`, and both spec files (freeze guard footprint empty).

## 6. Remaining limitations

- **Operator identity is asserted, not authenticated.** The store
  records `operatorId` for audit; authenticating the operator is the
  embedding service's responsibility.
- **Evidence authenticity rests on the deployment's configuration
  of the record source.** Round 3 enforces the boundary the library
  *can* enforce: no public minting path, source-fetched records
  only, instance-bound token acceptance, and a fail-closed default
  with no verifier (§4.1). What the library cannot decide is
  whether a deployment's `ProviderRecordSource` genuinely reads an
  authenticated provider system — that is the deployment's explicit
  trust decision, made when it configures the verifier. The
  library ships **no** source implementation and **no live adapter
  produces these records in this PR**, so the production-facing
  default is that **nothing lifts** and no production unblock path
  is claimed. A false record served by a deployment's own source,
  once resolved from, is permanently attributable in the
  append-only record — never silently editable.
- **The persisted hashes are checksums, not authentication**
  (§4.4): they detect mismatched edits between payload and digest;
  a writer able to rewrite both consistently is outside the threat
  model.
- **The financial half of the landing barrier rests on the
  deployment's reconciliation source.** Round 3 removed the
  caller-digest shape entirely: the barrier's digests are computed
  from a reconciliation record fetched through the same verifier
  boundary and bound to the attempt and the resolution (§4.3). The
  store still cannot recompute a deployment's books — it verifies
  that the reconciliation evidence it was configured to trust is
  present, bound, and digest-consistent with the established
  landed state; whether that source is a real reconciliation
  service is the deployment's configuration decision, exactly as
  for operation records.
- **Snapshot evidence is deliberately insufficient.** A matching
  provider state can arise from another actor's identical change
  (§6.15); only operation-bound records (operation log / idempotency
  registry / audit export, keyed to this attempt) can terminate an
  INDETERMINATE block.
- The 24h freshness window is a policy constant of this
  implementation, not a spec value.
- UNRESOLVED records (via `recordUnresolvedResolution`) are
  audit-only: operator id + justification, no evidence fields; they
  establish nothing.

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
> observation digest, and reconciliation decision recorded. An
> absence establishes CONFIRMED_NON_EXECUTION only with provider
> finality: the observation postdates the settlement, the provider
> record is declared final, and its completeness covers the
> settlement. A record classifying the outcome UNRESOLVED, a
> free-text note, or an observed provider state that merely matches
> the intended outcome MUST NOT lift the block. A terminal resolution
> of either class MUST NOT authorize re-dispatch against its own
> quote — re-authorization proceeds as a NEW quote (§6.15); a
> CONFIRMED_LANDING record additionally MUST NOT unblock the
> subscription until the landed state and its financial consequences
> are reconciled in a separate recorded barrier, after which only
> quotes issued after the landing and computed against the landed
> state version may dispatch.

Until that amendment is approved, this implementation is stricter
than the current §6.16 text where they differ (the implemented
same-subscription keying divergence tracked in G-21 is unchanged).
Correction round 3 does not change the proposed text: its
"independently obtained" evidence is now embodied in the
implementation as records fetched through a deployment-configured
verifier boundary (§4.1), and any normative adoption of the
amendment would need to decide how much of that capability model
the spec itself mandates — a maintainer governance question, not
one this implementation pre-empts.

## 8. Security / regression audit summary

- **Transaction atomicity**: insert + flag flip + history in one
  immediate transaction; crash-in-transaction test (58.8) leaves no
  row and a still-blocked attempt after reopen.
- **SQLite persistence / migration**: v1→v4, v2→v4, and v3→v4
  single-transaction migrations (58.14b, 58.14c, 59.5); unsupported
  versions still refuse; v2-era terminal rows preserved but
  non-lifting, and every pre-v4 evidence row backfilled ASSERTED
  and non-lifting (§5).
- **Crash consistency**: fault-injection at both persist boundaries;
  non-evidence failures poison the instance rather than serving
  volatile state.
- **Trust boundary (R2)**: resolveAttempt accepts only branded
  established tokens; fabricated raw evidence, post-minting token
  alteration, and cross-attempt tokens refuse (58.15); records bound
  to a foreign identity refuse at establishment (58.3, 58.4);
  cross-subscription isolation control (58.3).
- **Trust boundary enforcement (R2′)**: no public minting path —
  `establishResolutionEvidence` is no longer exported; tokens are
  minted only by a verifier from source-fetched records; a store
  accepts only its own configured verifier's tokens (a foreign
  verifier's genuine token refuses — 59.2); a store with no
  verifier refuses every terminal resolution, and the reviewer's
  exact counterexample — fabricated final no-operation record, no
  provider access — leaves another quote blocked (59.1); the
  verifier's query is binding-built and its fetched record is
  re-validated (missing / foreign / non-final records refuse —
  59.3); asserted claims are recorded at the ASSERTED tier and
  lift nothing (59.1, 59.6).
- **Provider finality (R3)**: pre-settlement observation, non-final
  log, incomplete watermark, and PARTIAL/UNKNOWN registry coverage
  all refuse at establishment (58.16).
- **New-quote rule (R1)**: after either terminal class, the old
  quote is blocked for any key; the positive case is a genuinely
  new quote (58.12, 56.5). The originally-terminal
  CONFIRMED_NON_EXECUTION attempt-state re-arm path is untouched.
- **Landing barrier (R4)**: a landing alone unblocks nothing; the
  reconciliation refuses a wrong landed-state digest; pre-landing
  and wrong-version quotes refuse as stale after the barrier; a
  second reconciliation refuses (58.13).
- **Verified reconciliation (R4′)**: the barrier takes no caller
  digests or records — the reviewer's exact counterexample (correct
  landed digest + sha256("not actually reconciled")) refuses, as
  does a store whose source lacks the reconciliation capability;
  the barrier records only from a fetched, bound reconciliation
  record whose landed state digests to the established state
  (59.4).
- **Concurrency / exclusion**: terminal-resolution existence is
  checked inside the immediate transaction (58.9: a second terminal
  resolution refuses with exactly one row persisted); DISPATCHING
  still always blocks.
- **Evidence immutability**: no update/delete code paths for
  `attempt_resolutions` or `landing_reconciliations`; a payload
  whose checksum no longer matches refuses the whole open (58.5b);
  replayed (source, reference) refuses (58.5a).
- **Receipt replay semantics**: unchanged — same-key terminal
  resolutions return the standing attempt (58.7, 58.12); the
  attempt-state CONFIRMED_NON_EXECUTION re-arm path is untouched.
- **Report derivation**: recoveryReport status follows the actual
  terminal record (58.17), the historical INDETERMINATE outcome is
  preserved, and the unresolved text is unchanged (test27.25).
- **Operator identity / auditability**: operator id, justification,
  timestamps, and the evidence checksum are recorded for every
  record, including UNRESOLVED ones; the attempt history notes the
  classification, evidence reference, and checksum prefix.
- **Fail-closed behaviour**: every refusal path persists nothing and
  leaves the block in place; legacy flag-only records remain blocked.

## 9. Test results (local)

Round 1 (head `d0f35c8`):

- Node v22.14.0 and Node v20.19.5: full suite **819/819 pass**
  (baseline main 803/803); test56 9/9; test58 16/16 (failing-first
  on baseline: 0/16).

Correction round (head `2010e73`):

- Failing-first against `d0f35c8`: test58 + test56 = 29 tests,
  **19 fail / 10 pass** (the 10 passes are pins whose behaviour was
  already correct; see §2).
- Node v22.14.0 (locally installed toolchain; system node is v24):
  build clean; full suite **823/823 pass**.
- Node v20.19.5 (locally installed toolchain + matching rebuilt
  better-sqlite3 binding): full suite **823/823 pass**.
- test56: 9/9; test58: 20/20. No pre-existing test file other than
  test56/test58 was modified.
- Provider neutrality check (workflow script run locally): OK.
- Protocol freeze guard footprint:
  `git diff --name-only main...HEAD -- spec/scq-v0.6.1-spec.md
  spec/scq-v0.6.2-spec.md reference/src/core/types.ts
  reference/src/core/scq-engine.ts` → **empty**.
- CI (GitHub Actions, Node 20 + 22) is the authoritative record for
  the PR head; see the PR for exact run results.

Correction round 3 (this head):

- Failing-first against `2010e73`: test59 + test58 + test56 = 35
  tests, **24 fail / 11 pass** (the 11 passes are pins whose
  behaviour round 3 does not change; see §2), plus both reviewer
  counterexamples demonstrated live against the round-2 build by a
  throwaway PoC (record: `P0-43-R3-FAILING-FIRST.txt`).
- Node v22.14.0 (locally installed toolchain; system node is v24):
  build clean; full suite **829/829 pass**.
- Node v20.19.5 (locally installed toolchain + matching rebuilt
  better-sqlite3 binding; Node 22 binding restored afterwards and
  suite re-run): full suite **829/829 pass**.
- test56: 9/9; test58: 20/20; test59: 6/6 (new). No pre-existing
  test file other than test56/test58 was modified; test27.25's
  unresolved report text and every VERIFIED report derivation are
  unchanged.
- Provider neutrality check (workflow script run locally): OK.
- Protocol freeze guard footprint: **empty** (same command as
  above).
- CI (GitHub Actions, Node 20 + 22) is the authoritative record for
  the PR head; see the PR for exact run results.

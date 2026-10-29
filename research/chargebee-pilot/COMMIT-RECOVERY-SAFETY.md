# Chargebee pilot — commit & recovery safety design

Status: **design + mocked evidence only.** No live commit is authorized
by this document, by issue #12, or by the pilot. `SCQ_LIVE_COMMIT_ENABLED`
remains false; the harness never enables it. Everything in §2–§5 is a
requirement set for a *future, separately authorized* controlled
test-site commit.

## 1. What is established today (mocked unless stated)

- The commit path, when enabled **against a mocked transport only**:
  re-reads state, revalidates the estimate, enforces the acceptance
  envelope, verifies the landed item set against intent, and builds the
  committed effect from actuals only (test13 T03/rec4/rec10; test21-c4).
- Duplicate commit of the same quote replays the original receipt with
  exactly one mutating call (§6.10; 21-c4).
- A lost mutation response yields INDETERMINATE, no receipt, and a
  second attempt refuses without re-mutating (21-c6; test13 T07/rec2/rec3).
- A provider 200 that silently ignores or partially applies the change,
  or that attaches an unrequested (mandatory) item, yields INDETERMINATE
  with **no verified receipt** (21-c7, 21-c9; test13 rec7/rec8/rec9).
- Stale version and expired quote refuse **before** any mutating call
  (21-c2, 21-c3).

## 2. Pre-commit safety checklist (required before any future live commit)

1. **Tenant check**: site is a verified **test** site; the subscription
   is the named synthetic fixture; no production tenant is reachable
   from the run environment.
2. **Exact change parameters**: subscription id, item price ids,
   quantities, `replace_items_list=true`, `invoice_immediately=false`,
   `change_option=immediately`, proration on — printed and diffed
   against the quote's stored `provider_preview_input`.
3. **Preflight state report**: current resource_version + item set;
   `has_scheduled_changes` (an immediate update can supersede scheduled
   changes — if true, STOP and assess separately); scheduled advance
   invoices; outstanding credits/unbilled charges that the change could
   interact with.
4. **Billable-effect statement**: the incurred figure the commit is
   expected to create (from the quote), stated as an *unbilled*
   obligation under `invoice_immediately=false`; no invoice or payment
   is triggered by the commit itself.
5. **Idempotency key**: the deterministic key derived from the quote id
   is recorded with the exact request parameters (see §4).
6. **Durable ledger in place** (§3) — the in-memory store is NOT
   sufficient; a live commit without the durable ledger is a no-go.
7. **Reconciliation owner**: a named human reviews the post-commit
   reconciliation output (§5) before any further action.
8. **Separate written authorization** naming tenant, resource, action,
   and the expected billable effect (issue #12 alone does not grant it).

## 3. Durable quote/receipt storage design (replaces the in-memory QuoteStore)

The current `QuoteStore` is process memory: a restart loses quotes,
receipts, and the receipt-identity digests, so §6.10 replay cannot be
proven after restart (test13 T13 fails closed rather than proving
exactly-once). A conforming deployment needs:

- **Durable records** (transactional store, e.g. Postgres/SQLite with
  WAL): StoredQuote (including `provider_preview_input` and the native
  idempotency key + exact request parameters), the recorded receipt
  (`commit_receipt_recorded`), the current receipt view, and the
  verification trail — the same coherent unit PR #8's store validates
  on restore (association + recorded-state legality + trail coherence),
  with `receiptIdentityDigest` recomputed and verified on load.
- **Write-ahead commit intent**: before dispatching a mutation, persist
  `{quoteId, idempotencyKey, requestHash, state: DISPATCHING}` in the
  same transaction that marks the quote COMMITTING. On restart, any
  DISPATCHING record is an *indeterminate candidate* (§5), never an
  automatic retry.
- **Atomic receipt recording**: the receipt + identity digest + trail
  entry are written in one transaction; a crash mid-write leaves the
  DISPATCHING record, not a partial receipt.
- **Retention**: records retained at least as long as the provider's
  reconciliation horizon; the native 30-minute idempotency window is
  NOT the retention bound (see §4).

## 4. Idempotency & restart recovery requirements

- **SCQ layer (primary)**: `checkIdempotentReplay` against the durable
  store — no time limit; replay returns the ORIGINAL recorded receipt
  (§6.10), including after a later verification transition.
- **Provider layer (backstop only)**: Chargebee's native
  `chargebee-idempotency-key`, 30-minute window. It is insufficient as
  the sole mechanism: it expires; the same key with different
  parameters is a 422; a concurrent in-flight request returns 409; and
  5xx responses are *cached under the key*, so recovering from a 5xx
  needs a new key — which is only safe after state reconciliation
  proves the original did not land.
- **Restart rule**: after any restart, DISPATCHING records are resolved
  by §5 reconciliation (read provider state; compare item set + actual
  figures) before ANY new mutation on that subscription is attempted.
  Blind retry after restart is prohibited.

## 5. Post-commit reconciliation procedure

1. Re-read the subscription (independent GET — never the mutation
   response alone, never a pre-commit preview).
2. Verify the landed item set equals the intended target set exactly
   (ids, quantities, no extras/duplicates) — the adapter's
   `itemSetMismatches` check. Mismatch ⇒ the outcome is reported as an
   established negative / indeterminate per what was read; a verified
   receipt is never issued on mismatched state.
3. Build committed figures from **actuals only**: update-response
   invoice/unbilled figures plus the re-read items' stated amounts.
   The pre-mutation estimate is never substituted for an actual.
4. Compare against the quoted effect under the acceptance envelope;
   record the reconciliation on the receipt (OK / VIOLATED) or, where
   actuals cannot be determined, record the outcome as indeterminate.
5. Bind the evidence to the artifact identity: quote id, native
   idempotency key, post-commit resource_version.

**Known gap (protocol Defect 3)**: the frozen v0.6.1 receipt type has
no "committed but financially unverified" state, so this adapter fails
closed — INDETERMINATE, no receipt — when a mutation lands but its
financial actuals cannot be determined (21-c8). The v0.6.2 machinery
(PR #8: `COMMITTED_UNVERIFIED` + UNVERIFIED reconciliation) can
represent that state; adopting it for the live adapter is part of the
future Chargebee migration gate, not this pilot.

## 6. Identifying indeterminate outcomes without blind retries

An outcome is INDETERMINATE when the mutation may have landed but its
effect is unproven: transport failure after dispatch, lost response,
5xx with unknown application, or landed state whose financial actuals
are undeterminable. Procedure: (1) mark the durable record
INDETERMINATE with the evidence gathered; (2) reconcile by reading
provider state (item set first, figures second); (3) only if the
intended set provably did NOT land may a human authorize a fresh
attempt — with a NEW quote (the old quote is stale by then), never a
re-issue of the same mutation. Automated blind retry is prohibited in
all paths.

## 7. Rollback & recovery LIMITS (explicit)

- **There is no rollback.** A landed `update_for_items` cannot be
  undone atomically. A reverse update is a *new* change with its own
  proration, its own incurred figures, and its own failure modes —
  compensation, not rollback.
- A forward update can **delete or override pre-existing scheduled
  changes** (documented provider behavior); nothing in this stack
  snapshots or restores them, so a "reversed" subscription may still
  differ from its pre-commit state (see RECOVERY-AUDIT.md in
  research/chargebee-live-v1).
- **Mandatory add-ons** auto-attached to a plan are outside the item-set
  guarantee unless named in `mandatory_items_to_remove` (this adapter
  sends none); a landed set can legitimately contain items the quote
  did not list, which reconciliation reports rather than "fixes".
- Unbilled charges already incurred are provider records; removing them
  is a separate provider operation outside this design.
- Recovery therefore means: detect, reconcile, report, and compensate
  by a new explicitly authorized change — never rewrite history.

## 8. Test-site commit go/no-go assessment

**NO-GO at this time.** A controlled test-site commit may be *proposed*
for separate authorization only when ALL of the following hold:

1. The v0.6.2 Chargebee adapter migration + release gates are complete
   (issue #7 track) — including a receipt representation for
   committed-but-unverified outcomes (Defect 3) or an accepted
   fail-closed posture.
2. The durable store of §3 is implemented and restart-tested.
3. The §2 checklist is executed for the exact tenant/resource/action,
   with the anticipated billable effect stated.
4. A reconciliation owner is named and the §5 procedure is rehearsed
   against the mocked transport.
5. Separate explicit authorization is granted for that specific commit.

Until then: live commit remains BLOCKED, and any guarantee that would
require a mutation to establish is classified BLOCKED, not simulated
into existence.

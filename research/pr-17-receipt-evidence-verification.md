# PR-17 — Append-only receipt evidence and truthful verified views (Issue #22, Finding 5)

Branch `fix/pr-17-receipt-evidence-verification` from main
`bda3ea27` (PR #26 merged). Finding 5 is the last open finding of
Issue #22. Reproduced by `research/issue-22` repro46 (harness-level
accounting in §9).

## 1. The three confirmed failures

- **F5a — a missing candidate could never be filled.** A receipt
  recorded with no immediate candidate (immediate absent/UNKNOWN)
  could not later incorporate independently established immediate
  actuals: the store's evidence validator required the evidence's
  figures to EQUAL the recorded candidates, so an establishing
  figure where the record had none was refused as an identity
  conflict.
- **F5b — an incorrect candidate could never be corrected.** A
  recorded recurring candidate of 80,900 could not incorporate
  established actuals of 83,400: `assertEvidenceValid` rejected
  differing figures with `CONFLICTING_RECEIPT_IDENTITY`. Strict
  candidate equality was mistaken for identity preservation.
- **F5c — the verified view lied about its own figures.** Confirming
  evidence promoted a receipt to `COMMITTED_AND_VERIFIED` while the
  receipt it displayed still carried the recorded candidates'
  committed effect — determinacy UNKNOWN, `committedSource:
  "unestablished"`. The promotion relabeled the record; it did not
  show what the evidence had established.

## 2. The three-layer state model

PR-17 separates what the pre-PR-17 store fused into one mutable
receipt object:

1. **The recorded receipt** (`commit_receipt_recorded`) — immutable
   forever. Its canonical identity is exactly the pre-existing one:
   `receiptId`, `quoteId`, `subscriptionId`, recorded outcome,
   recorded reconciliation status, recorded `immediate.net`,
   recorded `recurring.resultingAmount`
   (`receiptIdentityFields` / `receiptIdentityDigest`). A recorded
   candidate remains part of that identity even when later evidence
   establishes a different actual. New actuals never rewrite the
   recorded receipt and never move its digest; the recorded receipt
   stays byte-equivalent in observable content through replay,
   verification, persistence, and recovery.
2. **The append-only evidence record**
   (`commit_receipt_verifications`, entries of type
   `ReceiptEvidenceEntry`) — provider-neutral, identity-bound,
   provenance-aware. Each entry carries: `at` (event timestamp);
   `identityDigest` (the recorded identity it appends to);
   `evidenceId` (content-derived: sha256 over the canonical
   `{identityDigest, evidence}` pair — see §5); the minted
   `VerificationEvidence` itself (establishing source /
   provider-operation correlation via its provenance, the
   post-commit state-verification result, the observed committed
   effect with per-dimension determinacy, provenance, currency and
   cadence, and the reconciliation SCQ computed from it at minting);
   `disposition` (per-dimension: `ESTABLISHES` /
   `CONFIRMS` / `CONTRADICTS_CANDIDATE` / `UNRESOLVED`, judged
   against the recorded candidates); and `conflicts` (per-dimension
   contradictions against the trail-so-far's already-accepted
   actuals — see §4). Entries are deep-copied on ingress and on
   every read; recorded history cannot be rewritten by mutating a
   caller's token afterwards.
3. **The derived current view** (`commit_receipt`) — computed from
   the recorded receipt + the accepted evidence trail by
   `deriveCurrentView`, never authored independently. It displays
   the established actuals (not stale candidates), with the
   establishing evidence's per-dimension determinacy and provenance,
   and it is explicit about differing from the recorded receipt:
   the recorded layer remains separately readable, byte-for-byte.

With an empty trail the derived view IS the recorded receipt
(deep-equal), so every pre-PR-17 observable behavior for
never-verified records is unchanged.

## 3. Three questions, kept separate

The pre-PR-17 validator answered one fused question ("does this
evidence match the record?"). PR-17 answers three:

- **Admissibility** — may this evidence be recorded at all?
  (`recordReceiptEvidence` / `assertEvidenceAdmissible`): the token
  must be an `establishVerification`-minted token (brand), bound to
  this quote and subscription (minting-time binding), unaltered
  since minting (minting-time content digest —
  `assertTokenUnaltered`), presented (if a receipt is presented)
  under the recorded identity, of establishing provenance
  (`provider_actual` / `defined_equal_exact`; estimate lineage and
  self-asserted verdicts refused, unchanged), internally
  consistent, and its claimed reconciliation must equal the store's
  recomputation from the recorded quoted effect + envelope + the
  PR-16 unit context. **Candidate equality is not an admissibility
  condition.** Evidence whose computed state is MISMATCH is refused
  at recording too: figures observed against a state that
  contradicts the operation's intent (including a foreign
  subscription's state, PR-16) are not attributable to this
  operation. UNVERIFIABLE-state evidence is admissible — it can
  establish figures observed independently — but cannot satisfy
  the state limb of promotion.
- **Establishment** — which dimensions does the trail independently
  establish? Per dimension, an entry establishes the dimension iff
  its committed effect carries a figure for it with determinacy
  DETERMINED (or the dimension is NOT_APPLICABLE, for zero-effect
  changes). UNKNOWN figures establish nothing (test50.11). This is
  a property of the evidence's own determinacy, never of agreement
  with the candidate.
- **Promotion** — is there enough trustworthy evidence for the view
  to read verified? (`deriveCurrentView`): the view promotes to
  `COMMITTED_AND_VERIFIED` iff the trail is non-empty, contains NO
  unresolved conflict, at least one entry's state verification is
  VERIFIED, and the reconciliation recomputed over the COMPOSED
  established effect (against the original quoted effect + envelope,
  never against the candidate as baseline) is determined (OK or
  VIOLATED). Verified-with-violation is therefore a first-class,
  distinguishable outcome (tests 50.2, 50.17). Partial evidence
  records without promoting (50.15, 50.16). A view may never show
  `COMMITTED_AND_VERIFIED` while any field it relies on is still
  UNKNOWN/`unestablished` — structurally: the promoted view's
  committed effect IS the composed established effect, and its
  composed `committedSource` claims an establishing source only
  when every participating non-N/A dimension is established,
  otherwise it stays `"unestablished"` and the view does not
  promote (F5c closed by construction, test50.3).

`verifyCommitReceipt` remains the single-shot promotion entry
point: the presented token must additionally be PROMOTABLE
(admissible + state VERIFIED + determined reconciliation —
`assertEvidencePromotable`, refusal order preserved from the
pre-PR-17 validator) and unaltered; the token is appended and the
transition's result is the derived view over the whole trail. If
the composed trail still does not promote (e.g. an earlier entry's
unresolved conflict stands), the transition is refused and NOTHING
is appended — the transition stays atomic exactly as before.

`CONFLICTING_RECEIPT_IDENTITY` is retained for what it names: a
presented receipt whose identity differs from the recorded one, a
token minted for a different quote/subscription, tampered recovery
sets. Candidate ≠ actual is no longer an identity conflict.

## 4. Composition and conflict rules

- **Composition (per dimension):** the FIRST establishing entry in
  the trail sets the accepted actual for that dimension; a later
  entry establishing the SAME value confirms it; entries compose
  across dimensions, so partial evidence accumulates (Case D,
  test50.16). The composed effect's non-participating dimensions
  fall back to the recorded candidates for display only — never as
  established figures.
- **Conflict:** a later entry establishing a DIFFERENT value for an
  already-established dimension is APPENDED and flagged
  (`entry.conflicts`, disposition `CONTRADICTS_CANDIDATE` where it
  also departs from the candidate); it never silently replaces the
  accepted actual. While any conflict stands unresolved, the
  derived view reads `COMMITTED_UNVERIFIED` with an UNVERIFIED
  reconciliation whose reason names the conflict — conflict takes
  precedence over the state-unverified reason, and no view over a
  conflicted trail is ever an unqualified OK (test50.13).
  Resolution is an operator/investigation act outside this PR;
  the record preserves both claims and their provenance.

## 5. Evidence identity, duplication, tamper

- `evidenceId` = sha256 hex of `canonical({identityDigest,
  evidence})`. Identical evidence resubmitted is idempotent — no
  duplicate append, the current view is returned unchanged
  (test50.14). The same id with different contents cannot exist by
  construction (the id is derived from the contents); a persisted
  trail stating a wrong id, or duplicate ids, fails recovery
  coherence (test50.23).
- Post-minting alteration of a token is detected two ways: the
  recomputation check (an altered verdict/figure set usually no
  longer recomputes to its claimed reconciliation) and the
  minting-time content digest stamped in the module-private binding
  map (`assertTokenUnaltered`), which catches alterations
  recomputation cannot see — e.g. a figure change under a
  no-envelope reconciliation, where the engine judges establishment
  rather than amount equality (test50.9). The digest check runs
  AFTER content validation so alterations the older, more specific
  checks name keep their historical refusal messages (tests 14.20,
  15.7 unmodified).
- A descriptive source string is not cryptographic proof of
  provider authenticity — unchanged doctrine: the brand attests the
  token was computed by `establishVerification` from an observation;
  the adapter binds real provider evidence; the store does not
  authenticate arbitrary caller observations; actuals are never
  generated from quote-side estimates (estimate-lineage tokens are
  refused at establishment and again at ingestion, test50.10).

## 6. Recovery coherence extension and atomicity boundary

Pre-PR-17 recovery (`assertRestoredRecordCoherent`) expected at
most one verification transition and required the persisted current
view to equal the recorded receipt with exactly the transition's
effect/reconciliation substituted. That model cannot represent an
evidence trail. PR-17 extends it rather than relaxing it:

- The recorded receipt must still restore verbatim (digest fields
  intact; altered recorded candidates refused — test50.25).
- Every trail entry is re-validated: its `identityDigest` must
  equal the record's digest (wrong binding refused — 50.22); its
  evidence must pass the same admissibility validation as live
  ingestion (content validation; the brand is a runtime property
  and, as before, is not required at recovery); its entry-level
  reconciliation must equal its evidence's; its derived fields
  (`evidenceId`, `disposition`, `conflicts`) must equal the values
  recomputed from the trail-so-far (a tampered entry refuses the
  whole set — 50.20); evidence ids must be unique (50.23).
- The persisted current view is NEVER trusted: it must deep-equal
  the view derived from the recorded receipt + trail. A forged
  promoted view without supporting evidence refuses restore
  (50.21). On adoption the store installs the DERIVED view, not
  the persisted one.
- **Legacy exception, narrow:** a one-entry trail in the historical
  entry shape (no derived fields) whose single entry is promotable
  is accepted and normalized on adoption — its view is still
  re-derived, so a legacy trail whose historical view carried the
  F5c defect (verified label over UNKNOWN/`unestablished` figures)
  restores with a truthful derived view instead of the persisted
  one (50.24).
- Rejection is ATOMIC at both restore paths
  (`restoreReceiptRecords` validates the whole set before adopting
  any of it; `DurableQuoteStore.loadAndRecover` likewise), so an
  incoherent set adopts nothing.

**Atomicity boundary.** In-memory: evidence append + view
derivation is a single synchronous step — there is no interleaving
in which a view exists without its supporting entry. Durable:
`DurableQuoteStore` persists the quote row and its receipt record
in ONE SQLite transaction per `persistQuote`; a persistence failure
poisons the store instance (the pre-existing D1 rule), so
un-persisted state is never served. A crash therefore recovers
exactly the pre-append or the post-append record — never a promoted
view without its evidence (fault-injected at both persist points,
test50.27). `recordReceiptEvidence` is a write-through operation on
the durable store with the same poison-on-failure semantics.

## 7. Compatibility

- **Recorded candidate vs established actual:** the candidate stays
  in the recorded identity forever; the actual lives in the evidence
  record and the derived view. Neither overwrites the other.
- **Recorded receipt vs current view:** with no evidence they are
  deep-equal; after evidence they differ exactly where the evidence
  establishes, and both remain readable.
- **Evidence acceptance vs promotion:** recording is not verifying.
  Admissible-but-partial, admissible-but-state-unverifiable, and
  admissi
...[truncated]
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
  admissible-but-conflicted evidence is recorded without
  promoting: the trail grows, the view updates only where the
  evidence establishes, and the outcome changes only when the
  promotion rule (§3) is satisfied over the whole trail.
- **Partial evidence:** establishment is per-dimension, so a
  partial trail is represented exactly. A dimension an accepted
  entry establishes shows its established actual in the view;
  a dimension no entry has established stays UNKNOWN in the
  view — it is never filled in from the recorded candidate as
  though established (the candidate remains in the recorded
  layer, and in the composed effect for display only, §4).
  Entries compose across dimensions, so later admissible
  evidence completes the missing dimensions without disturbing
  the ones already established.
- **Later contradictory evidence:** an entry that contradicts
  an already-accepted actual is appended and flagged
  (`entry.conflicts`); the accepted actual is never silently
  replaced — first-established stands. While any conflict
  stands unresolved, the derived view reads
  `COMMITTED_UNVERIFIED` with an UNVERIFIED reconciliation
  naming the conflict, so contradictory evidence never rides
  an unqualified OK. Resolution is an
  operator/investigation act outside this PR (§4).
- **Receipt-view / evidence API surface:** no new versioned
  API was introduced. The model is exposed on the existing
  store surface: `recordReceiptEvidence` appends admissible
  evidence and returns the derived view; `verifyCommitReceipt`
  remains the single-shot promotion transition; the three
  layers stay separately readable on the quote record
  (recorded receipt, evidence trail, derived view); and the
  evidence-entry and disposition types are exported with the
  store. Recommendation for the specification (§9): name the
  three layers and the evidence-recording operation
  normatively in the candidate rather than versioning a new
  API. This is a recommendation, recorded here — not a
  decision taken by this PR.
- **Legacy records and trails:** receipts recorded before
  PR-17 restore unchanged at layer 1 — the recorded identity
  did not change. A legacy one-transition trail (an entry in
  the historical shape, without the PR-17 derived fields) is
  accepted under the narrow legacy exception of §6: its
  derived fields are recomputed from its contents and filled
  in on adoption, and its current view is re-derived — never
  trusted — so a legacy record whose historical view carried
  the F5c defect restores truthfully instead of refusing or
  persisting the defect.

## 8. Independent-review correction: cross-observation coherence

**The question (independent review of `4cad3c4`).** Composition
composes financial dimensions per dimension across entries, and
the promotion rule required only that SOME entry carry a
VERIFIED state. Can dimensions established by mutually
incompatible provider observations — different post-commit
states — compose into a promoted COMMITTED_AND_VERIFIED/OK
view, using a VERIFIED state from only one of them?

**What the implementation retained (the gap).** An evidence
entry retained the minted token (figures, committedSource, the
computed state-verdict string, the computed reconciliation) —
but NOT the identity of the observation's resulting snapshot
that the verdict and figures were computed from. The snapshot
was consumed inside `establishVerification` and discarded.
`analyzeEvidenceTrail` compared entries only on the SAME
dimension (the conflict rule); cross-dimension, cross-state
coherence was never examined, and `stateVerified` was
`entries.some(VERIFIED)`. No invariant bound the VERIFIED
entry's observation to the establishing entries' observations.

**The attack (failing-first, test50.28/50.29/50.30).** Seed a
COMMITTED_UNVERIFIED receipt. Entry A establishes the immediate
actual from an observation of state revision v2 (its read omits
the item collection; the state verdict for v2 is UNVERIFIABLE).
Entry B establishes the recurring actual from an observation of
state revision v3 — a different, later state (an extra item has
landed) — and carries the VERIFIED verdict FOR v3. Each entry
is individually admissible (branded, bound, establishing
provenance, internally consistent). On unmodified `4cad3c4`
the composed view promoted: outcome COMMITTED_AND_VERIFIED,
reconciliation OK — although no single observation ever
supported the composed figures together with the verified
state. The variant (50.29) is stronger: the VERIFIED entry
establishes NO dimension, and the two financial entries come
from two further distinct revisions (v2, v3, verdict from v4).
The false promotion reproduced in both forms (test50 on
`4cad3c4`: 28 pass / 3 fail, the three new coherence tests
failing with the view at COMMITTED_AND_VERIFIED).

**The correction (smallest fail-closed rule).** Promotion now
requires CROSS-OBSERVATION COHERENCE of its basis:

- At minting, `establishVerification` stamps the token's
  binding with the observed-state identity of its observation:
  a digest of the resulting snapshot's (subscription id, state
  revision `version`) pair — the state identity the protocol's
  own staleness semantics already use. Two reads of the same
  revision share the identity however much of the state each
  presented; different revisions never share it. An observation
  with no resulting snapshot stamps no identity.
- `buildEvidenceEntry` carries the identity onto the entry as
  `observedStateDigest`, bound into the entry's content-derived
  `evidenceId` (so the live and recovery derivations agree, and
  an inconsistently altered identity fails the same id checks
  as any other entry content). It is a coherence key, not an
  authenticity proof — recovery's trust posture is unchanged.
- `analyzeEvidenceTrail` computes the PROMOTION BASIS: the
  accepted establisher of each dimension, plus the first
  VERIFIED entry when no establisher carries the verdict. The
  basis is coherent iff it is a single entry, or every basis
  entry carries the SAME observed-state identity. A basis entry
  with no identity cannot take part in a cross-entry promotion.
- `deriveCurrentView` (the one derivation shared by the live
  paths and both recovery paths) refuses promotion on an
  incoherent basis: the view stays COMMITTED_UNVERIFIED with an
  UNVERIFIED reconciliation naming the incoherence. Recording
  and display are unaffected — the actuals are still appended
  and shown; only the verified claim is withheld.

Legitimate composition is preserved: partial entries observing
the SAME state revision compose and promote (50.16 unmodified;
50.31 pins the three-read form — two financial reads of one
revision whose collections were omitted, plus a state-only
read of the same revision carrying the verdict). Single-entry
promotions (the `verifyCommitReceipt` transition, legacy
one-transition trails) are coherent by construction.

**Accounting.** test50 grows 27 → 31 (append-only: 50.28 attack,
50.29 variant, 50.30 recovery — the incoherent trail stays
unpromoted after restart and a forged promoted view over it
refuses the whole restore set, 50.31 same-revision control).
No pre-existing test was modified. Full suite 710 → 714;
research suite unchanged (11 pass / 7 fail; repro46 still 0/3
at the PR-14 gate, unaffected).

**Documentation note on this file.** As committed at `4cad3c4`
this note ended mid-sentence in §7, at a literal truncation
marker, and the paste-ready PR #21 amendment list was absent
from the file; the §7 completion above and the §9 amendment
list below were restored by a documentation-only commit on
this branch.

## 9. Proposed PR #21 amendments (paste-ready)

The texts below are drafted for direct insertion into the
v0.6.2 specification candidate (PR #21). They state the model
as implemented and pinned by PR-17; adopting them is the
reconciliation's decision, not this PR's.

**A-17-1 — Replace §6.15's actuals-equal-candidates
requirement.** Delete the requirement that verification
evidence's figures equal the receipt's recorded committed
figures, and substitute:

> §6.15 Later establishment of committed figures.
> Verification evidence presented for a recorded receipt MUST
> establish the committed figures independently of the
> recorded receipt. The figures recorded on a receipt at
> commit time are CANDIDATES: figures recorded before
> independent establishment. A candidate is a claim to be
> judged, not an identity element to be matched. Evidence
> whose independently established actuals differ from the
> recorded candidates MUST NOT be refused on that ground,
> and MUST NOT be reported as a receipt-identity conflict.
> Receipt identity is the recorded tuple — receiptId,
> quoteId, subscriptionId, recorded outcome, recorded
> reconciliation status, and the recorded candidate figures
> themselves — bound by the recorded identity digest. That
> identity is fixed when the receipt is recorded and is
> never revised by later evidence. A receipt-identity
> conflict (CONFLICTING_RECEIPT_IDENTITY) arises only when
> presented material names a different recorded identity: a
> different receipt, a different quote or subscription
> binding, or a record whose identity digest does not match
> its recorded contents.

**A-17-2 — Append-only, receipt-identity-bound evidence.**
Add a definition of the evidence record:

> For each recorded receipt, an implementation MUST
> maintain an append-only evidence record. Each entry MUST
> carry: (a) the recorded identity digest of the receipt it
> appends to; (b) an evidence identity derived from the
> entry's contents and that digest, such that resubmitting
> identical evidence is an idempotent no-op and an entry
> whose stated identity does not match its contents is
> invalid; (c) the establishing evidence itself — the
> post-commit state-verification result, the observed
> committed effect with per-dimension determinacy,
> provenance, currency and cadence, and the reconciliation
> computed from it; (d) a per-dimension disposition toward
> the recorded candidates (ESTABLISHES / CONFIRMS /
> CONTRADICTS_CANDIDATE / UNRESOLVED); and (e) conflict
> flags recording, per dimension, contradiction with an
> actual accepted from an earlier entry. Entries are
> immutable once appended and MUST be defensively copied on
> ingress and on read, so later mutation of a presented
> token cannot rewrite recorded history. Three
> determinations MUST be kept distinct: ADMISSIBILITY —
> whether an entry may be recorded at all (minted
> establishing evidence, bound to the receipt's quote and
> subscription, unaltered since minting, of establishing
> provenance); ESTABLISHMENT — which dimensions an entry
> independently establishes (exactly those carrying a
> DETERMINED figure, or NOT_APPLICABLE); and PROMOTION —
> whether the derived view may read verified (A-17-5).
> Evidence that is admissible but partial, admissible but
> state-unverifiable, or admissible but conflicted MUST be
> recordable without promoting.

**A-17-3 — Actual-vs-candidate precedence for the current
view:**

> The current view of a commit is DERIVED from the recorded
> receipt and its evidence record; it is never authored
> independently, and verification MUST NOT rewrite the
> recorded receipt. For each financial dimension, the view
> MUST display the accepted established actual where one
> exists, with the establishing evidence's determinacy and
> provenance. A dimension no accepted evidence establishes
> MUST be shown as recorded — the candidate, for display
> only — and MUST NOT be presented as established.
> Reconciliation for a verified view MUST be computed
> against the original quoted effect and the proposal's
> acceptance envelope, never against the recorded candidate
> as the financial baseline, so an established actual
> outside the envelope reads VIOLATED, never OK.

**A-17-4 — Per-dimension determinacy and provenance after
establishment:**

> The composed committed effect of a derived view takes,
> per dimension, the accepted established figure,
> determinacy and provenance of the entry that established
> it. The composed effect's committed-source claim MUST
> name an establishing source (provider actuals, or
> defined-equal under the EXACT guarantee) only when every
> participating dimension of the effect is established;
> while any participating dimension remains unestablished,
> the composed source MUST read "unestablished" and the
> view MUST NOT be promoted. A view MUST NOT display
> COMMITTED_AND_VERIFIED — with an OK or a VIOLATED
> reconciliation — over financial fields still labeled
> UNKNOWN or sourced "unestablished".

**A-17-5 — Reconciliation and conflicting-evidence
handling, including cross-observation coherence:**

> Promotion of a derived view to COMMITTED_AND_VERIFIED
> requires, conjunctively: a non-empty evidence record; no
> unresolved conflict; a reconciliation over the composed
> established effect that is determined — OK
> (verified-with-compliance) or VIOLATED
> (verified-with-violation), which MUST remain
> distinguishable outcomes; a VERIFIED post-commit state
> result within the promotion basis; and cross-observation
> coherence of that basis. The promotion basis is the set
> of entries the verified claim rests on: the accepted
> establisher of each established dimension, together with
> the entry carrying the VERIFIED state result when no
> establisher carries it. An entry established against an
> observed post-commit state carries that state's identity:
> the observed snapshot's subscription id and state-revision
> version. The basis is coherent if and only if it consists
> of a single entry, or every entry in it carries the SAME
> observed-state identity. An entry carrying no
> observed-state identity MUST NOT take part in a promotion
> basis of more than one entry. Composition for display is
> unrestricted — actuals established against different
> revisions are still recorded and shown — but an
> incoherent basis MUST leave the view COMMITTED_UNVERIFIED
> with an UNVERIFIED reconciliation whose reason names the
> incoherence. Conflicting evidence: where a later
> admissible entry establishes a different actual for an
> already-established dimension, the entry MUST be appended
> and flagged, the previously accepted actual MUST NOT be
> replaced, and while the conflict stands the view MUST
> read COMMITTED_UNVERIFIED with an UNVERIFIED
> reconciliation naming the conflict. Conflict resolution
> is an operator act outside the protocol's automatic
> rules.

**A-17-6 — Migration, recovery coherence, and conformance
mappings:**

> Migration: receipt records written before this evidence
> model remain valid. A legacy verification trail of one
> transition, in the historical entry shape, MUST be
> accepted at recovery and normalized: the entry's derived
> fields (evidence identity, dispositions, conflicts, and
> observed-state identity where derivable) are recomputed
> from its contents, and the current view is re-derived
> under these rules — so a legacy view that displayed a
> verified label over unestablished figures restores
> truthfully rather than being refused or preserved.
> Recovery coherence: recovery MUST re-validate every
> evidence entry (digest binding,
> admissibility-equivalent content validation, entry-level
> reconciliation agreement, derived fields recomputed and
> compared, evidence-identity uniqueness) and MUST NOT
> trust a persisted current view: a persisted view is
> adopted only if it equals the derived view, and the
> derived view is what is installed. An incoherent restore
> set MUST be rejected atomically; no record of the set is
> adopted. Conformance: the conformance suite pins these
> rules as follows (reference implementation test50) —
> missing-candidate establishment and incorrect-candidate
> correction (50.1, 50.2); truthful verified provenance
> (50.3); replay byte-equivalence after verification
> (50.4); evidence binding, tamper and source refusals
> (50.5–50.12); composition, partial evidence and conflict
> handling (50.13–50.16); verified-with-violation
> distinguishability (50.17); recovery coherence, atomic
> rejection, legacy normalization and interrupted-append
> behavior (50.19–50.27); and cross-observation coherence
> (50.28–50.31).

### Carried forward undecided: the F3/F4 schema decisions (A-16-1…A-16-4)

The PR #21 reconciliation also carries the F3/F4 schema
decisions recorded by PR-16: A-16-1, the identity-binding
rule as normative text; A-16-2, unit comparability as a
comparison precondition, as normative text; A-16-3, the
immediate-currency schema extension (an optional `currency`
on `CommercialEffect.immediate`, adapter-populated, with
stored-record compatibility); and A-16-4, the Chargebee-live
committed-effect currency-defaulting question. PR-17 does
not decide any of them: its evidence model is compatible
with each outcome and prejudges none.

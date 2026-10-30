# Authorization preservation — MSE v0.3.0 comparison, minimal joint contract, refusal conditions, and recommended v0.6.2 corrections (PR-13, Phase 3)

**Status: PROPOSAL AND ANALYSIS ONLY.** Nothing here is implemented, and
nothing here amends any specification. PR #21 (the v0.6.2 candidate) is
**not** modified by this document; §6 below lists *recommended* corrections
for the maintainer to disposition.

**Grounding.** MSE claims are grounded exclusively in the verified MSE
v0.3.0 text: repo `arjun2075/mutation-safety-envelope`, tag `v0.3.0`
(commit `b39cc8f9cb599f2550dc177a98f9f26eeae1d3b1`), `spec/normative-spec.md`
and `schema/mse-core.schema.json` at that tag — located, retrieved, and
excerpted verbatim in `MSE-V030-SOURCE.md` (same directory). The later
0.4.0-dev.0 draft material (PR #6 / `f0339c2` line: satisfaction evidence,
`passEvidence`, required `AdmissionReport`) is **not** v0.3.0 and is not
used anywhere below. SCQ claims are grounded in current main `6f56b05` and
the reproductions in `FINDINGS.md`. Chargebee capability claims are
grounded in `CHARGEBEE-CAPABILITY-ASSESSMENT.md` (official docs, cited;
negatives are "not documented in the sources checked", never proofs of
nonexistence).

**The scenario (Finding 1, restated).** Authorized operation: change the
quantity of one addon, 1→21. Between the adapter's final pre-commit read
(fingerprint validation) and dispatch, a third party adds an unrelated
item. The commit mechanism — Chargebee `update_for_items` with
`replace_items_list=true` and the full item list derived from the
quote-time snapshot — deletes the unrelated item. Post-commit verification
compares the landed state against the *intended target set* and passes;
the receipt reports COMMITTED_AND_VERIFIED / OK. Reproduced
deterministically on current main (`FINDINGS.md` Finding 1, test 43.1).

A note on names, to prevent a real confusion: Chargebee's "mandatory
addon" (a catalog flag with a documented preservation exception) and
MSE's `REQUIRES_COINCLUSION` admission relation are unrelated concepts
that happen to share vocabulary. The fixture item
`pilot-addon-concurrent` (renamed from `pilot-addon-mandatory` in the
PR #23 review corrections, REVIEW-3) is an ordinary item price id —
nothing provider-enforced-mandatory is simulated, and the Finding 1
reproduction establishes the generic full-list overwrite race only.
Nothing below relies on either concept standing in for the other.

---

## 1. What MSE v0.3.0's contracts would have required or refused in this scenario

MSE v0.3.0 was checked contract by contract. The honest headline first:
**MSE v0.3.0, as written, does not prevent this scenario either** — it has
no protected-state concept (the word "protected" does not occur in the
v0.3.0 spec, schema, or source at the tag; verified in
`MSE-V030-SOURCE.md` §4). What MSE contributes is a set of disciplines
that would have forced the weakness to be *declared and visible* rather
than silently absorbed into a VERIFIED/OK — and one structural rule
(amendment discipline) that forbids the natural "just resubmit with a
fresher list" repair. SCQ contributes the provider-truth machinery MSE
deliberately leaves to bindings. The joint contract in §3 is built from
exactly that division.

### 1.1 Transition contract (MSE §1a, §3, §3.1, §3.2)

MSE fixes the committing set at quote time: a `MutationQuote` carries
`CommittingUnit[]` — "the complete set of independently committing units
this quote proposes, known no later than quote time" — each with a stable
`unitRef`, a `unitLocator`, an opaque `transition`, and its own effects; a
provider "MUST NOT invent a unit identity only after execution", so the
caller can check result coverage against a set it saw *before* committing.
Per-unit outcomes are `APPLIED` / `REFUSED` / `INDETERMINATE`; for
`APPLIED`, "`committedEffects` MUST be present and MUST NOT differ from
this unit's quoted effects for any effect whose `guarantee.mode` was
`EXACT`", and "One unit's outcome MUST NOT be inferred from another's."

Applied to the scenario: SCQ's single change maps to a single unit, and
its quoted effects (immediate 20000, recurring 80900) do match the landed
figures — so MSE's transition contract, evaluated on the quoted units,
passes exactly as SCQ's verification did. The deleted item is an effect
on **no quoted unit**: it lives entirely in the binding's dispatch
mechanism (full-list replacement), which MSE treats as opaque. MSE's
transition contract therefore does not detect the loss — but it does
locate responsibility precisely: the side effect belongs to the binding's
implementation of the transition, not to the quoted transition itself,
and MSE's model gives the caller no outcome under which "the unit
applied" silently means "and unrelated state was discarded". SCQ's
receipt, by contrast, lets COMMITTED_AND_VERIFIED be read that way.

### 1.2 Admission contract (MSE §1d, §2, §3.2)

MSE v0.3.0's admission is "an additional **pre-dispatch gate**, not a
fourth commit outcome and not a fourth effect guarantee", evaluated
"after quote-level safety checks and before dispatching any commercial
mutation … against the submitted transitions and current binding state",
under the constraint that "a binding MUST NOT dispatch any quoted
transition from inside an admission evaluator". A known
`ADMISSION_REFUSED` "proves that this submission dispatched no commercial
mutation"; conversely, "if dispatch may have occurred, the provider MUST
use the per-unit determinacy model … instead of reporting a clean
admission refusal". The one relation type, `REQUIRES_COINCLUSION`, is
about co-submission of required units and "does **not** make the units an
atomic transaction".

Applied to the scenario: admission is the one MSE checkpoint that sits
where SCQ's race lives — immediately before dispatch, against *current*
binding state. An SCQ binding that declared a preservation-oriented
relation and evaluated it at admission would have a defined place to
refuse. But v0.3.0's only relation type does not express preservation,
and MSE itself refuses to overclaim the checkpoint: the refusal's
`stateRef` and `evaluatedAt` are "opaque evidence of the state the
binding evaluated; neither it nor `evaluatedAt` is a lock", and §8.6
lists "How external-state bindings close the admission-to-dispatch gap"
as an **open, non-normative issue**, noting the reference provider's
synchronous in-process boundary "does not prove that a distributed
provider can offer the same boundary without a binding-specific
transaction or final revalidation mechanism". So MSE would require the
SCQ binding to *document* that its admission/validation is not atomic
with dispatch — the declaration SCQ's BEST_EFFORT label gestures at
without specifying — and would forbid reporting a clean refusal once
dispatch may have occurred. It would not, as specified, have refused
this commit.

One further MSE rule binds the repair path: a `COMPLETE` admission
witness obliges the caller to "construct a new `MutationProposal` and
obtain a new `MutationQuote`. It MUST NOT append an unquoted unit to the
old `CommitRequest`." Translated: when state has moved, the remedy is a
new quote against the new state — never silently re-deriving the
dispatch payload from fresher state under the old authorization. SCQ's
control 43.3 (pre-read drift → QUOTE_STALE, re-quote required) already
honors this; any fix for Finding 1 must preserve it, i.e. must not
"repair" the race by rebuilding the replacement list from a last-second
read under the original quote.

### 1.3 Snapshot contract (MSE §6, schema)

MSE's `snapshot` is "Opaque, provider-defined precondition material"; the
core does not require "a single, shared snapshot/token scheme across
providers" nor "that every write path into a resource (not only
MSE-issued commits) update the same tracked value". What it standardizes
is the *declaration*: `commitConsistency` ∈ {`SNAPSHOT_REQUIRED`,
`SNAPSHOT_ADVISORY`, `NONE`}, where `SNAPSHOT_REQUIRED` means "commit
MUST be refused if the resource's current state does not match snapshot,
by whatever provider-defined comparison the adapter documents", and any
adapter declaring other than `NONE` "MUST document … what `snapshot`
actually contains and what mechanism detects drift against it".

Applied to the scenario: SCQ's Chargebee fingerprint
(`rv:<resource_version>`, or a hash of items/status/term/scheduled flags)
is an MSE-style snapshot, and the adapter behaves as `SNAPSHOT_REQUIRED`
— at the moment of its last check. Finding 1's write lands *after* that
check, and MSE's contract, by its own §6 scope boundary, has nothing to
say about the interval between the last comparison and the write: drift
detection is defined at check time, and no documented Chargebee mechanism
(see §2) lets the snapshot travel with the write as a precondition. MSE
would classify SCQ's posture honestly only if the adapter documented —
as §6 requires — that its "required" comparison is a last-read
comparison, not a dispatch-bound one. SCQ's current documentation says
the TOCTOU window is real (adapter header), which is the right instinct;
the receipt, however, does not carry the consequence (see §3.4).

### 1.4 Guarantee contract (MSE §4, §3.1, §3.2)

MSE guarantees are per-effect, three modes: `EXACT` ("Provider
guarantees this value will hold at commit"), `REVALIDATE` ("may need to
re-check it at commit time"), `UNKNOWN` ("No guarantee offered"). Two
disciplines matter here. First, honesty of marking: "A provider MUST
NOT mark an effect `EXACT` unless it is actually prepared to honor that
exact value at commit time … Marking an effect `EXACT` when the provider
cannot actually guarantee it is a conformance violation, not an
implementation detail". Second, fail-closed evaluation: if the matching
effect's guarantee is `UNKNOWN`, an AcceptanceConstraint "is violated,
because the value cannot be relied on".

Applied to the scenario: SCQ's REVALIDATE mode + BEST_EFFORT consistency
is roughly MSE's REVALIDATE + a snapshot declaration. MSE's marking
discipline generalizes beyond effect values to the *claim the receipt
makes*: a verification claim is a promise. SCQ's COMMITTED_AND_VERIFIED
/ OK, read as "the authorized change was applied and nothing else was",
is a promise the full-replacement mechanism cannot keep under
concurrency — the direct analog of marking EXACT what is only
REVALIDATE-grade. SCQ's own BC-1 work already adopted the fail-closed
half of this discipline for financial dimensions (UNKNOWN never
reconciles OK); Finding 1 shows the same discipline has not been
extended to the *state/preservation* dimension, where an unestablishable
property is currently not reported at all.

### 1.5 Summary of the comparison

| MSE v0.3.0 contract | In this scenario it would have… |
|---|---|
| Transition (§1a/§3/§3.2) | Passed on the quoted unit, as SCQ did; located the side effect in the binding's mechanism, outside the quoted transition set; forbidden inferring more than the unit's own outcome |
| Admission (§1d/§2/§3.2) | Provided the defined pre-dispatch checkpoint and refusal semantics (refusal ⇒ provably zero dispatch); required documenting that evaluation is not a lock; forbidden absorbing drift into the old request (new proposal + new quote for any amendment) |
| Snapshot (§6) | Required the adapter to declare its consistency level and document what the snapshot is and how drift is detected — including, honestly, that the comparison is at last-read, not dispatch-bound |
| Guarantee (§3.1/§3.2/§4) | Forbidden presenting an unkeepable claim as verified: claim strength must match mechanism strength, and unestablishable dimensions fail closed rather than passing silently |
| *(absent)* Protected state | **No counterpart exists in v0.3.0.** Preservation of out-of-scope state is neither required, defined, nor claimable — the gap is shared by both specifications and is what §3 proposes to fill |

---

## 2. The Chargebee capability facts the contract must fit

From `CHARGEBEE-CAPABILITY-ASSESSMENT.md` (official documentation;
classifications as recorded there):

- **Full-list replacement is the documented removal mechanism.**
  `update_for_items` with `replace_items_list=true` and a plan in the
  list: "The entire subscription item list (plan and addons) is replaced
  by the provided list" (DOCUMENTATION_SUPPORTED). Removing an item is
  documented only as `true` + a retained list of everything else.
- **No documented conditional write.** No `resource_version` write
  precondition, no ETag/`If-Match`, no "update only if unchanged"
  parameter appears on the endpoint or in the sources checked
  (NOT DOCUMENTED IN SOURCES CHECKED). `resource_version` is an
  output attribute, documented for webhook ordering / change sync.
- **Additive mode cannot express the general case.**
  `replace_items_list=false` is documented as additive; a targeted
  in-place quantity change of an existing item via `false` is NOT
  DOCUMENTED IN SOURCES CHECKED, and removal via `false` is not
  possible on the documented surface. So even SCQ's canonical change
  (a quantity change) has no clearly documented targeted form, and any
  change set containing a removal forces full replacement.
- **Idempotency is not a CAS.** The `chargebee-idempotency-key`
  (30-minute window, replay returns the stored response, 422 on
  same-key/different-params, 409 while in flight) deduplicates SCQ's
  own retries; it is keyed to the request, not to resource state, and
  says nothing about third-party writes.
- **`lock_timeout` (429) does not cover the window.** It is a
  simultaneous-access lock with a "please retry" remedy; the scenario's
  third-party change has already *completed* before dispatch, so there
  is nothing concurrent left to lock against.
- **Ramps are targeted but unusable for this.** `items_to_add /
  items_to_update / items_to_remove` are genuinely targeted lists, but
  Ramps are future-dated scheduling (`effective_from` required, not in
  the past), early-access, and carry no documented precondition.
- **Another pre-dispatch read does not close the race.** It narrows
  the window; the write can still land between that read and the
  dispatch, and under full replacement the post-commit state contains
  no trace of what was destroyed. Any contract whose enforcement is
  "read closer to dispatch" is a probability reduction, not a
  guarantee, and must not be specified as one.

Net: on the documented surface, Chargebee today offers exactly one
mechanism class for SCQ's change sets — **full-list replacement only** —
for anything beyond pure additions. The contract below is written
provider-neutrally, but this is the capability reality it must classify
honestly.

---

## 3. The minimal provider-neutral authorization-preservation contract (PROPOSAL)

The smallest joint contract that closes Finding 1 without pretending
any provider offers what it does not. Five elements; everything else in
this document is commentary on them.

### 3.1 Two kinds of authorization, named distinctly

- **OPERATION authorization** (the default, and what an SCQ proposal /
  MSE quote expresses today): the caller authorizes a *delta* — the
  named changes to the named items/dimensions. Everything else about
  the target is **protected-unchanged** (§3.2). A commit under
  OPERATION authorization must not alter protected state; if it does,
  or if whether it did cannot be established, the receipt must say so
  (§3.4) and the adapter must refuse where §4 requires.
- **TARGET-REPLACEMENT authorization** (explicit opt-in only, never
  inferred, never a default): the caller authorizes the *resulting
  state itself* — "the item list becomes exactly this" — accepting
  that concurrent out-of-scope state may be discarded by the
  replacement. Under this authorization, preservation is
  NOT_APPLICABLE *by the caller's own waiver, recorded on the quote*,
  and the receipt may claim target-state verification without a
  preservation claim.

The Finding 1 defect, in these terms: SCQ executed an
OPERATION-authorized change through a target-replacement mechanism and
reported the result with a claim strength appropriate only to
TARGET-REPLACEMENT authorization (or to a preservation-enforcing
mechanism). The mechanism is not the bug; the unmarked substitution of
one authorization kind for the other is.

### 3.2 Authorized scope and protected-unchanged dimensions

At quote time, immutably, the quote records:

- **scope**: the set of (target, item/dimension) the proposal may
  modify — in SCQ terms, exactly the proposal's changes, projected
  onto the target's state dimensions (item membership and quantity
  for named items; the financial dimensions the envelope bounds).
- **protected-unchanged**: everything else about the target at the
  pre-dispatch baseline — membership and quantity of unnamed items,
  and the currency/cadence of untouched dimensions (the Finding 4
  dimensions are preservation dimensions too: a commit that silently
  re-denominates an untouched dimension has altered protected state).

"Protected" is a claim discipline, not a promise of physics: §3.3
determines what may be *claimed* about protected state, and §4 when
the commit must not proceed at all.

### 3.3 Provider capability declaration

Each adapter declares, per provider/operation, at quote time — and the
declaration is carried on the quote and the receipt — exactly one
dispatch-mechanism class:

- **`CONDITIONAL_WRITE`** — the provider enforces a state precondition
  atomically with the write (compare-and-swap, version- or
  ETag-conditioned update). Preservation is *enforced*: any
  intervening change fails the precondition and no mutation occurs.
- **`TARGETED_UPDATE`** — the dispatch can express exactly the
  authorized delta without enumerating out-of-scope state (targeted
  add/update/remove operations). Preservation is *structural* for
  every dimension the targeted form cannot name.
- **`FULL_REPLACEMENT_ONLY`** — the only available mechanism
  enumerates the entire target state; the enumerated list is derived
  from a read, and the provider enforces no binding between that read
  and the write. Preservation across the read→dispatch interval is
  *unenforceable* by the adapter.

(Chargebee on today's documented surface: `FULL_REPLACEMENT_ONLY` for
any change set containing a removal or a quantity change;
`TARGETED_UPDATE`-shaped only for pure additions via the additive mode.
MSE alignment: this declaration is the preservation analog of MSE §6's
`commitConsistency` declaration — a small closed enum, adapter-documented
meaning, no universal mechanism mandated.)

### 3.4 The receipt's claims are separate, and preservation is one of them

A committed receipt reports five independent claims, each VERIFIED /
VIOLATED / UNVERIFIED / NOT_APPLICABLE on its own evidence — this is
also the receipt reading table Issue #22 Finding 6 asks for:

| Claim | Question it answers | In Finding 1, honestly reported |
|---|---|---|
| Attribution | Did *this* operation land? | VERIFIED (response + bracket) |
| Target state | Is the intended resulting state in effect? | VERIFIED |
| **Authorization preservation** | **Did anything outside the authorized scope change?** | **UNVERIFIED** (mechanism cannot establish it) |
| Financial compliance | Do established actuals satisfy the envelope? | OK over established actuals |
| Unknowns | What could not be established? | The preservation dimension, named |

Claim discipline by capability (what a receipt MAY claim):

- `CONDITIONAL_WRITE`, write accepted: preservation **VERIFIED** —
  the provider's atomic precondition is the evidence.
- `TARGETED_UPDATE`: preservation **VERIFIED** for dimensions the
  dispatched form cannot name, *provided* the post-commit verification
  also compares the protected set against the pre-dispatch baseline;
  dimensions the form can name but the proposal did not authorize are
  checked the same way. Without that comparison, preservation is
  UNVERIFIED (structural safety is a property of the request, but the
  *claim* still needs its check).
- `FULL_REPLACEMENT_ONLY`: preservation may be claimed **VERIFIED
  only when the authorization is TARGET-REPLACEMENT** (where it is in
  fact NOT_APPLICABLE-by-waiver and should be recorded as such). Under
  OPERATION authorization the preservation claim is **UNVERIFIED** —
  always, not as a matter of adapter diligence — because the mechanism
  destroys the evidence a verification would need. A post-commit
  comparison against the baseline can still *detect* some violations
  (a protected item whose post-commit state differs while remaining
  observable, a concurrent change landing between dispatch and
  re-read); detection upgrades specific cases to VIOLATED, but a
  clean comparison never upgrades the general claim to VERIFIED.
- In all classes: an unqualified overall VERIFIED/OK must not be
  presented when any claim the caller did not explicitly waive is
  UNVERIFIED. (SCQ's existing outcome vocabulary can carry this as:
  target/financial verification as today, with the preservation claim
  recorded alongside and the headline outcome capped — the exact
  encoding is an implementation decision for the follow-up PR, not
  this proposal.)

### 3.5 Amendment discipline (from MSE, adopted unchanged)

When pre-dispatch checks detect that state has moved, the remedy is a
new proposal and a new quote against the new state (MSE §3.2 witness
discipline). Rebuilding the dispatch payload from a fresher read under
the original authorization is forbidden: it converts the caller's
OPERATION authorization into a TARGET-REPLACEMENT of whatever the
fresher read happens to show, without the caller ever seeing the new
baseline. SCQ's QUOTE_STALE behavior already implements this; the
contract states it so a Finding 1 fix cannot "solve" the race by
re-reading inside the commit.

---

## 4. Refusal conditions — when the adapter must refuse instead of claiming protection it cannot enforce

Each condition is stated so it can be implemented and tested. "Refuse"
means: no dispatch occurs, and the refusal is classifiable as
provably-zero-dispatch (MSE's admission-refusal semantics; SCQ's
CONFIRMED_NON_EXECUTION shape).

- **R1 — Unenforceable preservation, not waived.** Mechanism is
  `FULL_REPLACEMENT_ONLY`, authorization is OPERATION, and the caller
  has not explicitly accepted an UNVERIFIED preservation claim at
  quote time → the adapter MUST refuse (at quote time where the
  capability is known then; in all cases before dispatch). The
  caller's alternatives are exactly two: widen the authorization to
  TARGET-REPLACEMENT, or accept the UNVERIFIED preservation claim
  explicitly, on the quote, before commit. Silent acceptance is not
  available; today's behavior — proceed and report unqualified
  VERIFIED/OK — is the prohibited case.
- **R2 — Precondition failure is a refusal, not a re-derivation.**
  Under `CONDITIONAL_WRITE`, if the provider rejects the precondition
  at dispatch, the adapter MUST surface that refusal and MUST NOT
  retry with a re-derived payload under the same quote (see §3.5).
- **R3 — No silent mechanism downgrade.** If the authorized delta
  cannot be expressed in the declared mechanism class (e.g. a removal
  under a provider whose targeted form cannot remove), the adapter
  MUST NOT silently fall back to full replacement under OPERATION
  authorization; it refuses, or escalates to the caller for
  TARGET-REPLACEMENT authorization.
- **R4 — Detected preservation violation caps the receipt.** Where a
  preservation comparison is performable and shows an out-of-scope
  difference attributable to the execution window, the receipt MUST
  report preservation VIOLATED and MUST NOT present an unqualified
  VERIFIED/OK headline, however clean the target-state and financial
  claims are.
- **R5 — No baseline, no replacement.** Under `FULL_REPLACEMENT_ONLY`,
  if no pre-dispatch baseline read can be obtained at all, an
  OPERATION-authorized dispatch MUST be refused outright: the
  replacement list would be derived from nothing the caller or the
  adapter ever saw.
- **R6 — Unknown capability is the weakest capability.** If an
  adapter cannot establish which mechanism class a provider/operation
  belongs to (undocumented surface, untested path), it MUST classify
  it `FULL_REPLACEMENT_ONLY` for claim purposes. (Chargebee's
  quantity-change-via-additive-mode is exactly this case today:
  undocumented ⇒ not TARGETED_UPDATE.)

Non-refusal honesty rule (the complement of R1): where the caller
*has* explicitly accepted an UNVERIFIED preservation claim, the commit
may proceed, but the quote, the commit-time record, and the receipt
must each carry the capability declaration and the UNVERIFIED
preservation claim — the acceptance must be reconstructible from the
record, not from the caller's memory.

---

## 5. Proposed MSE integration boundary

Which layer owns what, stated as a proposal only:

**MSE owns the authorization vocabulary and the checkpoint.**
- The quote-level declarations: authorization kind (OPERATION /
  TARGET-REPLACEMENT — MSE-side, this is a property of what the
  caller's proposal means), authorized scope, and the requirement
  that preservation is a separately reported claim.
- The admission checkpoint as the place preservation *feasibility* is
  evaluated: admission already evaluates quote-declared relations
  against current binding state pre-dispatch; a preservation relation
  ("this binding's mechanism can honor the declared scope under the
  declared capability") fits that shape without changing admission's
  semantics (gate, not outcome; refusal ⇒ zero dispatch; witnesses
  for repair — where a COMPLETE witness here means: re-quote against
  current state, or widen authorization).
- The per-unit outcome discipline consumers use to read results:
  preservation reported per unit/target alongside APPLIED / REFUSED /
  INDETERMINATE, never folded into APPLIED.

**SCQ owns the provider truth and the evidence machinery.**
- The per-adapter capability declaration (`CONDITIONAL_WRITE` /
  `TARGETED_UPDATE` / `FULL_REPLACEMENT_ONLY`), derived from
  documented provider surface and adapter validation — the
  preservation analog of the drift-mechanism documentation MSE §6
  already requires of adapters.
- Quote/commit/receipt mechanics: baseline capture, fingerprint /
  snapshot checks, determinacy, reconciliation, the durable
  write-ahead ledger, and the five-claim receipt record (§3.4).
- The refusal implementations R1–R6 inside the commit path.

**The boundary itself.** MSE never learns provider mechanics (it does
not know what `replace_items_list` is, exactly as its core "MUST NOT
parse transition/domain state vocabulary"); SCQ never invents
authorization semantics (it does not decide what the caller authorized;
it reports capability and claims). The interface between them is two
artifacts: the *capability declaration* flowing down (binding → quote
→ receipt), and the *five-claim outcome record* flowing up, of which
MSE's coverage check consumes the preservation claim the same way it
consumes any per-unit outcome. Neither layer's conformance depends on
the other's internals: an MSE-conformant caller can read an SCQ
receipt's claims without SCQ knowledge, and an SCQ adapter can
implement R1–R6 without implementing MSE.

---

## 6. Recommended v0.6.2 candidate corrections (recommendations only — PR #21 is not edited here)

For the maintainer's disposition before candidate approval, mapped to
the findings. Locations refer to the candidate at PR #21 head
`2975926`.

1. **§6.12 (state verification) — add the preservation dimension.**
   The clause currently defines verification as committed state
   against quoted intent, with the expected resulting item set as the
   expectation side. Add: target-state conformance is not
   authorization preservation; where the commit mechanism enumerates
   the full target state (full-list replacement), a VERIFIED
   FULL_ITEM_SET verdict MUST NOT be presented as evidence that
   out-of-scope state was preserved, and the candidate must state
   what preservation claim, if any, each dispatch-mechanism class
   supports (per §3.3/§3.4 above). (Finding 1.)
2. **§6.15 (outcomes) — cap the headline claim.** COMMITTED_AND_VERIFIED
   currently requires landing evidence, §6.12 VERIFIED, and
   reconciliation OK/VIOLATED. Add: where a preservation claim
   applies and is UNVERIFIED, the receipt MUST record it as such
   alongside the outcome; the candidate should state explicitly that
   the outcome does not subsume preservation. (Finding 1.)
3. **§6.15 (upgrade rule) — replace figure-equality as the sole
   verification relation.** The clause currently requires "the
   evidence's committed figures to equal the amounts RECORDED on the
   receipt at commit time" and states a contradicted candidate "can
   never be upgraded on this record" — codifying Finding 5(a)/(b).
   Recommend: evidence binds to the receipt's *identity* (quote,
   subscription, operation), not to its candidate figures; evidence
   establishing a dimension the record left candidate-less is
   appendable; evidence establishing a *different* actual produces a
   verified-with-violation derived view, not an identity refusal;
   and the derived current view MUST present the establishing
   evidence's determinacy and provenance (not the candidate's
   UNKNOWN / `"unestablished"` labels) — Finding 5(c). The recorded
   original remains immutable throughout (that part of the current
   text is correct and must be preserved).
4. **§6.2 (fingerprint precondition) — state its temporal scope.**
   Add one sentence: the precondition is evaluated against the last
   pre-dispatch read; it does not bind the dispatch unless the
   provider enforces a conditional write; cross-reference the
   capability declaration (new, per item 1) so BEST_EFFORT's content
   is specified rather than implied. (Finding 1.)
5. **New runtime-validation clause (candidate §3.3 or §6.13-adjacent)
   — validate proposals at runtime.** `guaranteeMode` MUST be a
   supported literal; acceptance-envelope bounds MUST be finite,
   nonnegative numbers; violations refuse with INVALID_PROPOSAL
   before any provider read or preview. State explicitly that the
   type definitions are not runtime validation. (Finding 2.)
6. **§6.12 / §6.15 — identity binding for commit-path reads.** The
   upgrade path already requires the observation to name the quote's
   subscription; extend the same requirement to every provider read
   consumed as commit evidence (post-commit re-read in the first
   instance): provider/site/subscription identity MUST be verified
   against the quote's binding, and a mismatch yields UNVERIFIED or
   refusal — never a verified receipt over another subscription's
   state. (Finding 3.)
7. **§3.8 / §6.14 — currency and cadence comparability.** Numeric
   comparison MUST be preceded by equality of currency (both
   dimensions) and comparability of cadence; a mismatch is UNVERIFIED
   or VIOLATED, never OK. `CommercialEffect.immediate` has no currency
   field: adding one is a schema change and should be recorded as a
   new breaking-change item (BC-7 candidate) in the migration guide,
   not slipped into the candidate as a clarification. (Finding 4.)
8. **§3.12 (outcome taxonomy) — name the preservation claim.** Add
   authorization preservation to the receipt's reported dimensions
   (per §3.4), or explicitly scope COMMITTED_AND_VERIFIED to exclude
   preservation where the mechanism cannot support the claim. Silence
   — the current text — is what let Finding 1's receipt be read as
   covering it. (Findings 1, 6.)

None of items 1–8 is a documentation-only fix for a runtime defect,
and the candidate must not be approved on the basis that these
corrections make the *implementation* conform: each needs its own
implementation PR with failing-first tests (the PR-13 test files are
the starting set).

---

## 7. What this proposal deliberately does not do

- It does not require providers to offer a conditional write; it
  requires adapters to *declare* the absence and callers to see the
  consequence before commit.
- It does not make another pre-dispatch read a conformance mechanism
  (§2, §3.5).
- It does not retro-fit MSE v0.3.0 with a protected-state concept it
  does not have; §3 is a joint proposal, attributed to neither
  existing specification.
- It does not change any SCQ behavior: implementation is a separate,
  gated step after the maintainer dispositions these recommendations.

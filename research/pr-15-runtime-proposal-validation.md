# PR-15 — Fail-closed runtime proposal and financial-envelope validation

Issue #22 (Fabio's external review), Finding 2. Branch
`fix/pr-15-runtime-proposal-validation` from main `652e7f1`
(PR #24 merged). Tests: `reference/tests/test48-runtime-proposal-validation.test.ts`
(22 tests). This note records the validator's design and placement,
the per-adapter refusal matrix, the persisted-quote audit, the
safe-integer assessment, and the amendments PR #21 (the v0.6.2
specification candidate) needs to absorb. No live Chargebee call
was made; all mutation behavior is exercised through injected
mocked transports and the simulators. `SCQ_LIVE_COMMIT_ENABLED`
was never set.

## The defect (as reproduced by repro44 on main)

TypeScript unions do not exist at runtime. Before this PR:

- A misspelled `guaranteeMode` (`"REVALDIATE"`) satisfied neither
  the EXACT nor the REVALIDATE branch anywhere it was consumed, so
  a proposal with no acceptance envelope quoted with **no guarantee
  enforcement at all** (repro44.1).
- Envelope bounds were compared without any runtime shape check:
  a `NaN` bound makes every comparison against it `false`, which
  the gates read as compliance — drift passed silently (44.2,
  44.5); negative and string-typed bounds were likewise accepted
  (44.3, 44.4).
- `resolveGuaranteeMode` returned the stored/caller value verbatim
  (`?? "REVALIDATE"`), so the fall-through reached every consumer.
- PR #24 added exhaustive scope validation **only** inside the
  Chargebee-live adapter's creation path. The four simulator
  adapters never read `authorizationScope`: a stored `"UNRESTRICTED"`
  declaration was accepted verbatim (confirmed by test48's
  failing-first run: all four simulators created quotes with it).

## Design: one validator, two call shapes

All rules live in `reference/src/core/scq-engine.ts` (provider-neutral;
no adapter carries a divergent copy):

- `validateProposalRuntime(proposal: unknown)` (engine, ~L380) —
  asserts a caller-controlled proposal is a well-formed
  `SubscriptionChangeProposal` **at runtime**: plain-object top
  level; `changes` a non-empty array of plain objects with a
  recognized `action`; per-action required fields
  (CHANGE_QUANTITY: non-empty string `itemId`, finite number
  `quantity >= 0`; CHANGE_PLAN: non-empty string `itemId` and
  `offeringRef`; CHANGE_CADENCE: `cadence` ∈ {MONTHLY, ANNUAL};
  CANCEL: no required fields); `effectiveIntent` one of the three
  established shapes, with DATE requiring `at` to be a **string**
  that `Date.parse` accepts; `guaranteeMode` per the mode rules
  below; envelope **shape** per the envelope rules below;
  `authorizationScope` per the scope rules below. Unknown fields
  are rejected **only inside the envelope** (where a misspelling
  silently changes a tolerance); the wider proposal object is not
  closed — no new business restriction is invented here.
- `validateStoredQuoteRuntime(quote, options?)` (engine, ~L415) —
  the commit-time counterpart: runs the same proposal validation
  over the **stored** proposal, then requires the record's stored
  `effective_guarantee_mode` to be a recognized literal **and**
  equal to `resolveGuaranteeMode(stored proposal)` — a desync
  between the mode a quote was created under and the mode its
  record claims refuses as INVALID_PROPOSAL rather than being
  reinterpreted. An option defers the scope check to an adapter
  gate (used only by Chargebee-live; see below).
- `envelopeShapeProblem(envelope)` (engine, ~L213) — the single
  shape predicate both paths share: returns a human-readable
  problem string or `null`. Consumed by the validator (refuse),
  by `checkAcceptanceEnvelope` (refuse), and by
  `reconcileCommittedEffect` (classify).

### Mode rules

Omitted (`undefined`) ⇒ REVALIDATE (the established default,
unchanged). `EXACT` / `REVALIDATE` accepted. **Everything else —
misspellings, wrong case, `""`, numbers, objects, and explicit
`null` — is INVALID_PROPOSAL.** `null` is invalid input here, not
an omission: the field was supplied, with a value outside the
union. `resolveGuaranteeMode` and `enforceGuaranteeRequest` are
hardened to the same rule, so a direct engine caller cannot fall
through both branches (an unrecognized mode previously satisfied
neither the coverage check nor the envelope requirement;
`enforceGuaranteeRequest` also refuses an empty change set, whose
vacuous `every` previously read as all-CANCEL).

### Envelope rules

A supplied envelope must be a plain object containing **only**
`maxImmediateNetIncrease` / `maxImmediateCreditDecrease` /
`maxRecurringIncrease`; each supplied bound must be a finite,
non-negative JS number. NaN, ±Infinity, negatives, numeric or
non-numeric strings, `null`/array/object bounds, unknown or
misspelled fields, and non-object envelopes all refuse as
INVALID_PROPOSAL. Zero is valid; an omitted bound keeps its
established zero-tolerance meaning; malformed bounds are **never
coerced to zero**. `maxImmediateCreditDecrease` mathematics is
untouched (its nomenclature is tracked separately).

**Presence is deliberately NOT in the validator.** The established
rule "REVALIDATE requires an envelope unless every change is
CANCEL" stays in `enforceGuaranteeRequest`, which every adapter
calls during `createChangeQuote` **after** its effectiveIntent
support checks. A proposal that is both envelope-less and
intent-unsupported refuses UNSUPPORTED_CHANGE for the intent —
test25.19 pins that precedence, and an early draft of this PR
that duplicated presence into the validator inverted it and
failed 25.19; the duplication was removed for exactly that
reason. Presence is still enforced at quote creation with the
same INVALID_PROPOSAL code, and at commit the envelope gates
refuse a missing envelope themselves (`checkAcceptanceEnvelope`
now throws INVALID_PROPOSAL on an absent envelope before any
BC-1 assessment — previously that path was reachable only via a
non-null assertion at the call sites).

### Scope rules (now shared by all five adapters)

Absent (or explicit `null`, PR #24's pinned reading) ⇒ OPERATION.
`OPERATION` accepted. `TARGET_REPLACEMENT` ⇒ UNSUPPORTED_CHANGE on
**all five** adapters — recognized but unimplemented in this
release; never honored, never silently downgraded, never executed
(matching PR #24's live-adapter creation semantics exactly).
Unknown value or wrong runtime type ⇒ INVALID_PROPOSAL. The live
adapter's local `validateScopeDeclarationAtCreation` is deleted;
its creation path derives the effective scope from the validated
proposal (`proposal.authorizationScope ?? "OPERATION"`).

This PR does **not** make simulator mutations concurrency-safe and
does not extend PR #24's preservation gate: OPERATION-scope
preservation enforcement stays Chargebee-live-specific. What
changes for the simulators is only that an unimplemented scope
declaration is no longer silently accepted.

## Pre-dispatch refusal vs post-dispatch classification

The distinction is stated in the code at both sites and is the
organizing rule of the financial-entry-point changes:

- **Before dispatch, invalid input refuses.** `checkAcceptanceEnvelope`
  throws INVALID_PROPOSAL on an absent or malformed envelope before
  the BC-1 enforceability assessment. Nothing has happened yet;
  refusing costs nothing and loses nothing.
- **After dispatch, invalid input classifies.**
  `reconcileCommittedEffect` **never throws** (unchanged contract):
  a malformed envelope encountered post-commit runs the
  comparisons on the envelope's *fireable projection* — each
  malformed bound replaced by a +Infinity "this check cannot fire"
  sentinel for that field only (an internal sentinel, never a
  caller-stated tolerance and never reported as one); valid bounds
  keep their values; absent bounds keep zero tolerance; a
  non-object envelope projects to no fireable checks. A violation
  established through the interpretable bounds reports **VIOLATED**
  (a proven violation is never downgraded by an unrelated
  uninterpretable term); otherwise the result is **UNVERIFIED**
  with the envelope problem named in the reason. A malformed bound
  can therefore never make a comparison "pass", and an executed
  mutation's receipt is always recorded with a truthful status.
  BC-1 is preserved throughout: UNKNOWN is never coerced to zero,
  NOT_APPLICABLE still requires its field-absent + license +
  citation conditions, and every established comparison is
  byte-for-byte the same code path for well-formed envelopes.

## Placement map

Creation — `validateProposalRuntime(proposal)` is the **first
statement** of `createChangeQuote` in all five adapters, before
any provider read, preview, estimate, or local shape check:

| Adapter | File | Creation | Commit-time stored validation |
|---|---|---|---|
| Stripe sim | `src/adapters/stripe-adapter.ts` | L450 | L659 |
| Paddle sim | `src/adapters/paddle-adapter.ts` | L464 | L663 |
| Zuora sim | `src/adapters/zuora-adapter.ts` | L701 | L866 |
| Chargebee sim | `src/adapters/chargebee-adapter.ts` | L605 | L814 |
| Chargebee live | `src/live/chargebee-scq-adapter.ts` | L1052 | L1261 (scope deferred to the PR-14 gate) |

Commit — `validateStoredQuoteRuntime(validated)` runs in every
adapter immediately after `validateCommit`, i.e. **after** §6.10
idempotent replay, the recorded-INDETERMINATE guard, and
expiry/fingerprint validation (their precedence is preserved: a
stored quote carrying a receipt replays it — replay wins over
validation, pinned by test48.18), and **before** any re-preview,
any durable DISPATCHING attempt, and any dispatch. On
Chargebee-live it additionally sits before the estimate block,
the revalidation gate, the live-commit-enabled check, and the
PR-14 preservation gate. Its refusals are plain INVALID_PROPOSAL /
UNSUPPORTED_CHANGE throws at that point — pre-dispatch, so no
outcome recording is owed (nothing was dispatched and no durable
attempt exists yet); where the codebase records outcomes for
commit-path refusals (the live adapter's PR-14 gate), that gate
remains the scope authority: the shared commit validation passes
`deferAuthorizationScopeToAdapterGate: true` there, and the gate
still validates **both** stored declaration sites (record field
and stored proposal) with CONFIRMED_NON_EXECUTION recording —
test47.16–47.18 pass unmodified.

## Per-adapter input-refusal matrix (honest read/dispatch ordering)

| Refusal | Stripe | Paddle | Zuora | CB-sim | CB-live |
|---|---|---|---|---|---|
| Malformed structure / mode / envelope shape / scope (creation) | before read | before read | before read | before read | before read (before estimate) |
| Envelope presence (creation) | after read, after intent+coverage checks, before preview | same | same | same | after estimate read, after intent checks, before preview |
| Provider-unsupported shape (e.g. multi-change on live, CANCEL on live) | n/a (multi supported where capable) | — | — | — | after validator, before estimate |
| Malformed stored record (commit) | after current-state read + replay/INDETERMINATE/expiry/fingerprint; before re-preview and dispatch | same | same | same | after current-state read + replay/INDETERMINATE/`validateCommit`; before estimate, gates, durable attempt, dispatch |
| Stored scope (commit) | via shared validation (record-field site) | same | same | same | via PR-14 gate, both sites, with outcome recording |

"Before read" for creation is asserted by read counters on the
Stripe harness in test48 and is structural (first statement) on
the other four. Commit paths necessarily read current provider
state first (the fingerprint input); no commit-path refusal in
this PR claims to precede that read.

## Persisted-quote findings (what commit paths consumed before PR-15)

- **All five adapters** resolved the stored proposal's mode via
  the verbatim `resolveGuaranteeMode` and passed the stored
  envelope into the gates/reconciliation with no shape validation:
  a tampered or legacy record carrying `"REVALDIATE"`, a NaN
  bound, or a desynced stored effective mode was consumed as-is
  (mode fell through; NaN read as compliance).
- **The four simulators** never read the stored `authorizationScope`
  at all — any value persisted at creation rode along unchecked to
  commit.
- **Chargebee-live** was the exception only for scope (PR #24's
  gate). Its stored mode and envelope were as unvalidated as the
  simulators'.
- No adapter compared the record's stored `effective_guarantee_mode`
  against the mode its stored proposal resolves to; that desync
  check is new in this PR.

## Safe-integer assessment (normative decision left open)

Envelope bounds denominate money in the same minor units as every
figure they are compared against, and all protocol money elsewhere
is integral. Two defensible rules:

- **Finite non-negative doubles (this PR).** Fractional bounds are
  accepted and compare exactly as JS numbers. Maximally compatible:
  no previously-accepted input becomes refused. The cost is that a
  fractional bound — almost certainly a caller bug, since minor
  units are integral — is honored literally instead of refused,
  and bounds beyond 2^53 lose integer precision (practically
  inert: real tolerances are small, and an over-large bound is
  permissive in the direction the caller stated).
- **Safe integers only.** Matches the protocol's money
  representation and refuses a probable bug class at the border.
  The cost is a new refusal for any existing caller passing
  fractional bounds, and it is a **normative** restriction: the
  frozen spec does not state it, so imposing it unilaterally from
  the reference implementation would invert the spec/implementation
  relationship this repo's freeze policy exists to protect.

PR-15 implements the first and records the question. Recommendation
for PR #21: adopt safe-integer bounds in the normative
runtime-validation clause (money is integral throughout the
protocol), with the reference implementation following the spec.

## Rules recorded as needing a normative decision

1. Safe-integer envelope bounds (above).
2. CHANGE_QUANTITY `quantity: 0` — the validator accepts it
   (finite, ≥ 0) and leaves its meaning to provider semantics;
   whether zero-quantity is malformed, provider-unsupported, or a
   legitimate no-op belongs to the spec.
3. DATE intent `at` — the validator requires a string that
   `Date.parse` accepts; the spec should state the representation
   requirement (and whether non-string timestamps are ever valid).
4. `guaranteeMode: null` is invalid input while
   `authorizationScope: null` reads as absent — an asymmetry
   inherited from PR #24's pinned scope reading vs the mode
   field's stricter treatment here. The spec should state both
   explicitly rather than leave them as implementation folklore.

## Required PR #21 (v0.6.2 candidate) amendments

1. A normative **runtime-validation clause** (per PR #23's
   recommendation): adapters MUST validate caller-controlled
   proposals at runtime before provider interaction, enumerating
   the malformed classes and their codes — INVALID_PROPOSAL for
   malformed input (structure, mode, envelope shape, unknown
   scope), UNSUPPORTED_CHANGE for the recognized-but-unimplemented
   TARGET_REPLACEMENT declaration — on creation **and** over the
   stored record before any commit dispatch or durable attempt,
   with §6.10 replay precedence stated (a recorded receipt
   replays; validation never refuses a legitimate replay).
2. The **safe-integer decision** for envelope bounds (above).
3. **Error-taxonomy notes**: pre-dispatch invalid input refuses
   (INVALID_PROPOSAL); post-dispatch malformed input classifies
   (VIOLATED through interpretable bounds, else UNVERIFIED — never
   OK, never an exception that loses a receipt). Stored-scope
   refusals at the Chargebee-live commit gate record
   CONFIRMED_NON_EXECUTION.
4. The **envelope-presence precedence**: presence is enforced at
   quote creation after effectiveIntent support checks, so an
   intent-unsupported proposal refuses UNSUPPORTED_CHANGE even
   when it is also envelope-less (test25.19).
5. Explicit statements of the two null readings and the DATE
   representation requirement (normative-decision items 3–4
   above), and a ruling on zero quantity (item 2).

## Compatibility and defaults preserved

- Omitted `guaranteeMode` ⇒ REVALIDATE; omitted `authorizationScope`
  ⇒ OPERATION; omitted envelope bound ⇒ zero tolerance.
- EXACT requests and their coverage requirements unchanged;
  all-CANCEL envelope exception unchanged; §6.10 replay, durable
  recovery, and recorded-INDETERMINATE handling unchanged.
- `maxImmediateCreditDecrease` mathematics unchanged.
- PR #24 behavior unweakened: creation-time scope codes identical
  (now via the shared path); the commit-time preservation gate,
  its dual-site stored-scope validation, and its outcome recording
  untouched (test47 passes unmodified, 18/18).
- **No pre-existing test was modified.** One design correction was
  forced by a pre-existing test during development: the validator
  initially duplicated the envelope-presence rule, which inverted
  the UNSUPPORTED_CHANGE precedence test25.19 pins; the
  duplication was removed (presence stays in
  `enforceGuaranteeRequest`) and test48's own expectations were
  written to the preserved architecture. No test was weakened to
  accommodate this PR.

## Verification (Node 22.14 local; CI covers Node 20 + 22)

- Baseline on the branch before changes: default suite 630/630;
  research suite 3 pass / 15 fail (repro44: 5 fail / 1 pass).
- test48 failing-first against the unmodified baseline: 6 pass /
  15 fail of 21 blocks (passes were exactly the intended controls:
  valid REVALIDATE, scope controls, envelope-presence/CANCEL,
  EXACT control, zero-tolerance, replay-wins), plus a TS2305 build
  failure for the then-nonexistent `validateProposalRuntime`
  export once the direct-contract test was added.
- After the fix: **default suite 652/652** (630 + 22 new);
  **research suite 8 pass / 10 fail** — repro44 is 6/6 green
  (44.1–44.5 now pass on refusal behavior; 44.6 control
  unchanged); the remaining failures are repro43 (2, F1's
  post-gate-refusal expectations), repro45 (4, F3/F4 — still open
  findings), and repro46 (3, F5 — still open), exactly the
  pre-existing state minus repro44.
- Provider-neutrality check: OK. Package smoke (`smoke:pack`) and
  demo: OK. Freeze guard: this PR changes exactly one gated file,
  `reference/src/core/scq-engine.ts` (`types.ts` and both specs
  untouched), so `check-frozen-surface` fails by design until the
  `protocol-change-approved` label is applied by a maintainer.

## Final correction (P15-2 completion): prototype pollution through engine-constructed envelopes

The maintainer's re-review of `326c51a` confirmed P15-1 fixed and
P15-2 *partially* fixed. One residual bypass remained: P15-2 made
validation and comparison read the CALLER's envelope
own-properties-only, but `sanitizedEnvelope()` built its copy as
an ordinary `{}` — an object that inherits from
`Object.prototype`. If that prototype is polluted
(`Object.prototype.maxRecurringIncrease = 1_000_000`), a caller
envelope with no own bound for a dimension sanitizes to a copy
with no own bound either, and the comparison's ordinary read of
the absent field returned the polluted inherited value: the
drift was treated as tolerated. The caller's prototype chain was
never the only chain in the room — the engine's own constructed
objects carried one too. The fireable projection
(`fireableEnvelopeProjection`) had the same construction.

**Failing-first profile** (regression appended as test48.22,
run against the unmodified `326c51a`; a probe exercised each
assertion individually because the test stops at the first
failure). Under temporary `Object.prototype` pollution
(`maxRecurringIncrease` and `maxImmediateNetIncrease` set to
1,000,000), with a caller envelope of `{}`:

- (a) `checkAcceptanceEnvelope` returned `null` for a +5000
  recurring drift and for a +5000 immediate drift — zero
  tolerance silently enlarged to the polluted million.
- (b) `reconcileCommittedEffect` returned **OK** for both
  drifts with established committed figures.
- (c) End-to-end (Stripe simulator): a quote with huge own
  immediate tolerances and no recurring bound, plus a concurrent
  price change landing inside the mutation (committed recurring
  121200 vs quoted 120000), produced a COMMITTED receipt whose
  reconciliation read **OK**.
- (d) The projection path: a malformed envelope carrying only an
  unknown field classified the +5000 drift UNVERIFIED (its
  bound-less projection absorbed the drift through the polluted
  read) instead of VIOLATED. The 48.20 falsy-envelope family was
  NOT pollution-sensitive (UNVERIFIED before and after).

**Fix (two layers, both applied).** (1) Construction: every
envelope-shaped object the engine constructs is now a
NULL-PROTOTYPE object (`Object.create(null)`) — the sanitized
envelope and both fireable-projection constructions (the
per-field projection and the non-object all-NEVER fallback).
(2) Reads: `compareDeterminedDimensions` reads bounds through
`ownEnvelopeBound` (own-properties-only) instead of ordinary
property access, so the rule holds at the point of use even for
a future envelope-shaped object that is not null-prototype.
Semantics are otherwise identical: same three fields, zero is
valid, omitted means zero tolerance, projection sentinel behavior
unchanged, reconcile never throws, P15-1's undefined-only
omission unchanged. `sanitizedEnvelope` is internal (not
exported), so the regression pins the behavior through the
exported gates rather than the construction directly.

**Audit (complete).** Envelope-shaped constructions in
`src/core/scq-engine.ts`: `sanitizedEnvelope` (hardened),
`fireableEnvelopeProjection` main + fallback (hardened). No
envelope spreads (`{...env}`) exist anywhere in `src/`. Bound
read sites: `compareDeterminedDimensions` — the only ordinary
reads, now own-only; `envelopeShapeProblem`,
`sanitizedEnvelope`, and `fireableEnvelopeProjection` already
read their source own-only (P15-2); `assertEnvelopeEnforceable`
takes no envelope; `checkAcceptanceEnvelope` and
`enforceGuaranteeRequest` read no bound fields (shape/presence
via the own-only helpers). Adapters: a full-tree grep finds NO
reads of individual envelope fields outside the engine — all
five adapters (and the live preflight) pass
`proposal.acceptanceEnvelope` wholesale into the engine entry
points; the field is embedded in some error `details` objects,
which is not a comparison read and is outside this defect path.

**Regression.** test48.22 pollutes `Object.prototype` inside a
try/finally that ALWAYS deletes exactly the two properties it
set, then asserts restoration; test48.23 is a standing
prototype-cleanliness guard for the rest of the file. On the
failing-first run, test48.22 failed at assertion (a) and
test48.23 still passed — the restoration held even on the
throwing path.

**Verification after the fix** (Node 22.14 local; CI covers
Node 20 + 22): default suite **656/656** (654 + 2 new);
research suite unchanged at 8 pass / 10 fail with repro44 still
6/6; provider neutrality OK; package smoke and demo OK. Gated
surface unchanged in kind: this correction modifies only
`reference/src/core/scq-engine.ts` among gated files (`types.ts`
and both specs untouched), so the freeze guard continues to fail
by design until a maintainer applies `protocol-change-approved`.

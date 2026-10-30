# PR-14 — Fail-closed authorization preservation for unsafe subscription replacement

Implements the smallest safe correction for Issue #22 Finding 1 (P0, confirmed in PR #23).
Tracking issue: #22. Companion evidence: `research/issue-22/FINDINGS.md` (Finding 1),
`research/issue-22/CHARGEBEE-CAPABILITY-ASSESSMENT.md`,
`research/issue-22/AUTHORIZATION-PRESERVATION-CONTRACT.md`. Production regression coverage:
`reference/tests/test47-authorization-preservation.test.ts`.

## 1. Root cause (recap of the PR #23 evidence)

The experimental Chargebee-live adapter's only mutating dispatch is `update_for_items`
with `replace_items_list=true`, built from the **quote-time** item list
(`buildChargebeeUpdateParams`). Commit-time verification — pre-dispatch fingerprint
validation and post-commit state verification — compares the landed state against the
**intended target set**. An unrelated item added by another actor after the final
pre-commit read is therefore deleted by the replacement dispatch, and nothing in the
verification path can see the loss: the target set never contained the item. PR #23's
repro43 demonstrated the end-to-end result on unmodified main: the concurrent item
(`pilot-addon-concurrent`) was deleted and the receipt reported
`COMMITTED_AND_VERIFIED` / reconciliation `OK`.

The unprotected interval is exactly **validate → dispatch**. Everything before the
final read is covered by fingerprint validation (a change landing before the
commit-phase read refuses `QUOTE_STALE` — preserved, test47.3); everything after
dispatch is too late.

## 2. Semantics implemented

**Authorization scope (core, provider-neutral, additive).** `AuthorizationScope =
"OPERATION" | "TARGET_REPLACEMENT"` (`reference/src/core/types.ts`). OPERATION is the
default: any proposal or quote without an explicit scope declaration is
OPERATION-authorized. Under OPERATION only the requested mutation is authorized;
unrelated items, quantities, and terms are **protected state**; target-state equality
never by itself proves preservation; consent to full-list replacement is never
inferred. `TARGET_REPLACEMENT` exists as a type value only — no adapter honors it in
this PR (see §5).

**Mutation capability (declared by the adapter, never by the caller).**
`MutationCapability = "CONDITIONAL_WRITE" | "TARGETED_UPDATE" | "FULL_REPLACEMENT_ONLY"`.
The Chargebee-live adapter's capability is declared in a module-private constant,
`ADAPTER_MUTATION_CAPABILITY = "FULL_REPLACEMENT_ONLY"`, grounded in its actual
mechanism (sole dispatch = `update_for_items`, always `replace_items_list=true`) and
in the PR #23 capability assessment (no documented conditional write; no documented
targeted update for this operation class). (As first delivered this was a
`readonly` instance field; the review correction in §10 moved it to the
module-private constant after demonstrating the field was runtime-mutable.) The declaration covers the adapter's two
update operations, `CHANGE_QUANTITY` and `CHANGE_PLAN`. It does **not** cover a cancel
path: this adapter has none — `CANCEL` (and `CHANGE_CADENCE`) quotes are refused at
creation with `UNSUPPORTED_CHANGE` before any provider call, a pre-existing posture
this PR does not change (test47.12). Out-of-scope paths are byte-identical in
behavior.

**Recording + disclosure at quote time.** Every Chargebee-live quote records the
effective scope (proposal's declaration, else OPERATION) and the adapter's capability
on the returned quote object, in `providerMetadata` (with an `authorizationPreservation`
note stating that OPERATION-authorized update commits will be refused at commit on
this capability), and on the stored quote record (`StoredQuote.authorization_scope` /
`authorization_capability`, both optional/additive — pre-existing persisted records
remain valid). Quotes are **disclosed, not refused, at creation**: a quote remains a
useful read-only artifact (estimate, preflight derivation, rehearsal fixture) even
though its commit will refuse; refusing at creation would destroy that read-only
value without adding safety, because the enforcement point that matters is the
dispatch. The commit-time gate is the enforcement; the quote-time record is the
disclosure.

**The gate (commit path).** Inside `commitChangeQuote`, after — in order — idempotent
replay, the recorded-INDETERMINATE guard, expiry/fingerprint validation, revalidation
determinacy and acceptance-envelope checks, and the live-commit-enabled check, and
**immediately before** the durable write-ahead gate (`beginDurableAttempt`) and any
mutating HTTP request:

- the stored scope is validated first (review correction, §10): both places a scope
  can be declared on the record (stored `authorization_scope`, stored proposal) must
  hold a recognized value — an unknown value in either refuses as INVALID_PROPOSAL
  before any gate logic; absent in both defaults to OPERATION (legacy quotes);
- a TARGET_REPLACEMENT scope declared in either place refuses as unsupported (it
  could only have been crafted outside `createChangeQuote`, which refuses the
  declaration at creation) — the record field cannot downgrade it;
- a recorded capability that is a known value **different** from the adapter's
  declared capability refuses as a mismatch — the adapter's declaration is
  authoritative, so a forged record claiming `CONDITIONAL_WRITE` cannot bypass;
- an absent or unknown recorded capability classifies as the weakest
  (FULL_REPLACEMENT_ONLY);
- on a FULL_REPLACEMENT_ONLY capability, an OPERATION-authorized commit refuses.

**Refusal shape.** New error code `AUTHORIZATION_PRESERVATION_UNENFORCEABLE`. The
refusal records a commit outcome of `CONFIRMED_NON_EXECUTION` on the quote (the same
outcome class as a demonstrable pre-effect provider rejection: nothing was
dispatched), carries `details.outcome = "CONFIRMED_NON_EXECUTION"`, and is **never**
INDETERMINATE — no dispatch was attempted, so there is nothing whose execution is
unknown. No receipt is recorded, no durable DISPATCHING attempt is created, no extra
provider read is made, and there is no fallback: a retry of the same commit reaches
the gate and refuses identically (test47.9 proves determinism across retries and a
durable-store restart; the recovery report shows no phantom INDETERMINATE).

**No escape hatch.** There is no configuration flag, adapter option, or environment
variable that disables or weakens the gate (test47.7 asserts the refusal under the
adapter's full enable-option set, and that a TARGET_REPLACEMENT proposal is refused
at quote creation before any provider call — never honored, never downgraded).

## 3. The capability boundary — why nothing documented closes the race

For an immediate removal-affecting commit via full-list replacement, preservation of
concurrently-changed unrelated state would require one of:

- a **server-enforced conditional write** (the dispatch conditional on the recorded
  state — e.g. a compare-and-swap precondition). Chargebee documents none for
  `update_for_items`: `resource_version` is an output-only millisecond timestamp, not
  a documented write precondition (PR #23 assessment, 13 official sources).
- a **targeted update** naming only the authorized mutation, so protected state is
  never part of the request. Chargebee documents no such operation for this class;
  the item-list update is the list-replacement call this adapter uses.

The three mechanisms sometimes proposed as substitutes each fail on the same
interval:

- **Idempotency** (native `chargebee-idempotency-key`, 30-minute window) deduplicates
  *our own* retries. It says nothing about another actor's write landing between our
  validation and our dispatch, and it expires.
- **An extra pre-dispatch GET** shrinks the validate → dispatch window but cannot
  close it: the check and the mutation remain two non-atomic operations, so the race
  survives any number of re-reads. It also creates pressure to treat a fresh read as
  consent to a fresh replacement list — re-deriving the target from current state
  would silently absorb the concurrent change into the "authorized" set.
- **Post-commit state verification** compares landed state to the intended target
  set. The deleted item was never in the target set, so the comparison passes — this
  is precisely how the P0 receipt came to read VERIFIED/OK. Verification against
  baseline + authorized delta would *detect* the loss after the fact, but detection
  is not preservation: the item is already deleted, and SCQ has no authorized
  compensating action to restore it.

`lock_timeout` (documented) covers simultaneous access contention, not a conditional
write; it does not convert the replacement into a state-conditional operation.

## 4. What becomes unavailable — precisely

- `commitChangeQuote` for **CHANGE_QUANTITY** quotes on `ChargebeeLiveAdapter`:
  refuses pre-dispatch (AUTHORIZATION_PRESERVATION_UNENFORCEABLE).
- `commitChangeQuote` for **CHANGE_PLAN** quotes on `ChargebeeLiveAdapter`: same.

That is every commit the adapter supports. Everything else is unchanged: quote
creation, estimates, snapshots, the read-only preflight (which derives the would-be
request from `buildChargebeeUpdateParams` without dispatching), and the pilot
harness (which never commits). CANCEL / CHANGE_CADENCE were already refused at quote
creation and remain so. The four simulator adapters (Stripe/Paddle/Zuora/Chargebee-sim)
are untouched and their behavior is unchanged — their mechanisms are in-model, not
the live full-replacement path; no shared code path changed their behavior (the core
and store additions are optional fields only, and their suites are green unmodified).
Consequence for existing Chargebee workflows: any consumer that was committing
updates through this experimental adapter must now treat those quotes as read-only
artifacts; there is no configuration that restores the old dispatch behavior, by
design.

## 5. What would permit OPERATION commits in future; what needs broader consent

**Permitting capability (technical, independently verifiable):** a documented
Chargebee **conditional write** for the update operation (a server-enforced
precondition on the recorded state) or a documented **targeted update** for the
operation class that mutates only the named item(s). Either would let the adapter
re-declare its capability (CONDITIONAL_WRITE / TARGETED_UPDATE) with its own review
and test-site evidence, at which point OPERATION-authorized commits could dispatch
with preservation enforced by the mechanism rather than assumed. Documentation
claims alone would not suffice — the capability re-declaration needs the same
evidence discipline as PR #23's assessment.

**Broader consent (authorization semantics, unreviewed here):**
TARGET_REPLACEMENT authorization — a caller knowingly authorizing wholesale
replacement including removal of unnamed state — requires reviewed semantics for
consent capture, quote migration, and what a receipt may claim, none of which this
PR designs. The same applies to any preservation-risk waiver or opt-in: this PR
deliberately provides none.

## 6. Consumer migration (deliberate, per test)

Every default-suite flow that dispatched an update through the live adapter encoded
the unsafe behavior; each was migrated individually (fixture preserved, expectation
replaced with the refusal, justification recorded in the test/rehearsal source).
No security assertion was weakened: in every case the migrated form asserts zero
dispatches and no receipt — strictly stronger than the original one-dispatch
expectations. Post-dispatch classification machinery (COMMITTED_UNVERIFIED,
INDETERMINATE, VIOLATED, attribution Z1–Z3, L1–L3) is **not deleted** — it remains
implemented in the dispatch path for a future permitting capability and remains
covered at the store/ledger/simulator level (test25, test27, test29.1/29.2,
test30.3–30.5, test31 rows 1–21, test32+).

| Area | Migrated | New expectation |
|---|---|---|
| Rehearsal (`rehearsal.ts`, ids retained) | rh-01, rh-02, rh-03, rh-06, rh-07, rh-08, rh-09 | Gate refusal (CONFIRMED_NON_EXECUTION, zero dispatches/attempts); armed fault classes recorded as never exercised |
| Rehearsal | rh-13 | Unresolved attempt now constructed at coordinator/ledger level (as rh-04/05); operator-review semantics unchanged |
| Rehearsal | rh-14 | Gate precedence over the (now unreachable) provider pre-effect rejection; outcome class coincides, zero ledger attempts (gate precedes ledger) |
| test38 | 38.2, 38.3, 38.4, 38.7, 38.8, 38.9, 38.10 | Assert the scenarios' new expected/observed outcomes |
| test13 | rec1–rec10, T03, T06, T07, T08+T09, T13 | Refusal; zero mutations; per-test migration notes |
| test21 | c4, c5, c6, c7, c8, c9 | Refusal; c5's native-idempotency subject preserved via direct client calls |
| test26 | 1a, 9, 10a, 10b, 10c, 11, 12, 12b, 13, 14a, 14b, 15a, 15b, 15d, 15e, 15f, 16, 16b, 16c, 18, 21 | Refusal; audited zero update dispatches; 26.16 records the outcome-class coincidence + precedence explicitly |
| test26 | 17 | §6.10 + verification-transition semantics preserved against a disclosed store-seeded COMMITTED_UNVERIFIED receipt (adapter part asserts the refusal) |
| test28 | 28.1, 28.2 | Durable quote persistence unchanged; refusal deterministic across restarts; zero attempts |
| test29 | 29.3, 29.13 | 29.3's D1 fault re-aimed at the gate's `recordCommitOutcome` write (poisoned-read/replay protections preserved); 29.13 records gate precedence over the coordinator-required check |
| test30 | 30.1, 30.2, 30.6 | Gate precedence over binding checks; D5 zero-mutation/zero-attempt properties verbatim; 30.6 control inverts (correct binding refuses identically) |
| test31 | 31.22, 31.23 | INDETERMINATE attempt seeded via the store's outcome API (31.22) / actor write applied directly (31.23); all hook assertions original |
| test35 | 35.20 (tail), 35.31 | 35.20: unpoisoned quote now reaches the gate after restart; 35.31: durable verbatim-preservation asserted against a disclosed seeded receipt (26.10c construction) |
| test37 | 37.18 | Receipt seeded via the durable store's recording API; preflight replay-posture assertions unchanged. (37.3 was fixed transitively by the rehearsal migration.) |

Unchanged and still green, deliberately: quote expiry + fingerprint refusals
(QUOTE_EXPIRED / QUOTE_STALE keep precedence — the gate is after them), BC-1
determinacy/envelope refusals (before the gate), the LIVE_COMMIT_DISABLED refusal
(before the gate), durable write-ahead recovery at the ledger level (test27,
rh-04/05/10/11/12), §6.10 replay for recorded receipts (26.17, sim suites), the
INDETERMINATE no-blind-retry guard (test47.10), and the PR #17 D2 ledger re-dispatch
semantics (store-level, pinned by test29.8–29.10 / test27 — untouched).

## 7. Research-suite result change (honest accounting)

The repro43–46 files are byte-unchanged (historical evidence). Their results change
because their scenarios drive the now-refusing adapter:

- repro43: 43.1 and 43.2 now **fail with the gate refusal itself**
  (`AUTHORIZATION_PRESERVATION_UNENFORCEABLE` thrown before any receipt exists —
  the defect behavior, silent deletion + VERIFIED/OK, no longer occurs; the repro's
  receipt-awaiting mechanics are superseded by test47's converted assertions, and
  43.2's "no concurrency verifies cleanly" expectation is the unsafe assumption this
  PR removes). 43.3 still passes.
- repro44 (F2): unchanged — 5 fail / 1 control pass (later PR in the sequence).
- repro45 (F3/F4): 45.1/45.3/45.4/45.5 still fail (defects unaddressed; 45.1's flow
  now stops at the gate refusal before the identity defect can manifest); control
  45.2 now fails because its live-adapter commit refuses; engine-level control 45.6
  still passes.
- repro46 (F5): unchanged — 3 fail (later PR).

Totals: baseline 18 tests / 5 pass / 13 fail → now 18 / 3 pass / 15 fail. The pass
count falls because two former *controls* asserted successful live-adapter commits;
the P0 defect itself is prevented, and its production regression coverage is test47.

## 8. Required PR #21 specification amendments (recommendations only — PR #21 not edited)

1. **New normative material on authorization scope and preservation**: define
   OPERATION / TARGET_REPLACEMENT, the adapter-declared mutation capability
   (CONDITIONAL_WRITE / TARGETED_UPDATE / FULL_REPLACEMENT_ONLY), the rule that an
   OPERATION-authorized commit through a FULL_REPLACEMENT_ONLY mechanism MUST refuse
   pre-dispatch, and the refusal's classification (CONFIRMED_NON_EXECUTION semantics;
   never INDETERMINATE; no receipt; no durable dispatch attempt).
2. **Error-code registration**: add `AUTHORIZATION_PRESERVATION_UNENFORCEABLE` to the
   candidate's error taxonomy alongside the existing codes.
3. **Preservation-claim rule for receipts** (extends PR #23's recommended §6.15
   upgrade rule): a receipt MUST NOT claim or imply preservation of unnamed state
   for a commit dispatched as a full-list replacement under OPERATION authorization;
   target-state equality is not preservation evidence.
4. **Gap register**: record TARGET_REPLACEMENT semantics (consent, migration,
   receipt claims) as an OPEN DECISION for a future revision, and note that the
   adapter-level D2 re-dispatch behavior is subsumed by the gate for this adapter
   while the ledger semantics (SPEC2/U-13) remain as implemented.
5. **Conformance/traceability**: add the preservation gate to the v0.6.2 traceability
   matrix with test47 as the reference implementation evidence (SIMULATED).

## 9. Verification (this branch)

- Baseline (main `f4a411c`): default suite 612/612; research suite 18 (5 pass / 13 fail).
- test47 failing-first on unmodified main: 12 tests, **9 fail / 3 pass** (the 3 passes
  are the intended controls: 47.3 staleness, 47.11 controls, 47.12 CANCEL posture).
- After implementation: **default suite 624/624** (Node 22.14 local; CI covers
  Node 20 + 22); research suite 18 (3 pass / 15 fail, §7); provider-neutrality check
  passes; package smoke passes; demo unchanged.
- Gated files: `reference/src/core/types.ts` changed **additively only** (two new
  types, two optional quote fields, one error-code variant). `spec/scq-v0.6.1-spec.md`,
  `spec/scq-v0.6.2-spec.md`, and `reference/src/core/scq-engine.ts` are untouched, so
  the freeze guard fails on types.ts alone — by design, pending the maintainer's
  label decision.
- **Zero live mutation**: no Chargebee live call of any kind was made, no credentials
  were used, `SCQ_LIVE_COMMIT_ENABLED` was never set; every mutation-path test uses
  injected mocked transports. Evidence class: SIMULATED.
- Review corrections (§10): default suite **630/630** (624 + test47.13–47.18);
  research suite unchanged (18; 3 pass / 15 fail); the correction commits touch no
  gated file (types.ts needed no change — `INVALID_PROPOSAL` already existed).

## 10. Review corrections — runtime integrity of the gate

Independent review of the first delivered head found the gate's safety correction
sound but identified two runtime-integrity holes in its implementation. Both are
fixed on this branch; the regressions are test47.13–47.18, written failing-first
against the pre-correction head.

### Finding 1 — the capability declaration was runtime-mutable (blocking)

As delivered, the capability was `readonly mutationCapability =
"FULL_REPLACEMENT_ONLY"` on the adapter class. `readonly` is a compile-time
annotation only: at JavaScript runtime the field is an ordinary writable property.
A caller holding the adapter instance could assign
`(adapter as any).mutationCapability = "TARGETED_UPDATE"` **before** quote creation;
the quote then recorded the false capability, quote and commit agreed on the lie,
and the commit dispatched the full-list replacement.

**Failing-first record (pre-correction head).** test47.13 failed at the read-back
assertion (the assignment silently took effect; the property read
`"TARGETED_UPDATE"`). An end-to-end probe of the same scenario (mocked transport,
not part of the suite) showed the complete bypass: the quote recorded
`TARGETED_UPDATE`, the commit dispatched `update_for_items` once, and the receipt
returned was `COMMITTED_AND_VERIFIED`. test47.14 (assign after creation) refused,
but only via the capability-*mismatch* branch, and the refusal reported the mutated
value as the adapter's capability (`details.mutationCapability =
"TARGETED_UPDATE"`). test47.15 failed because the quote recorded the
`Object.defineProperty`-installed value.

**Fix — private, immutable mechanism declaration.** The capability now lives in a
module-private constant, `ADAPTER_MUTATION_CAPABILITY`, in the adapter module. The
module constant was chosen over an ECMAScript `#private` field deliberately: the
capability is a fact about the adapter's single dispatch **mechanism** — code in
this module — not per-instance state. A `#private` field would still model it as
instance state (initialized per construction, in principle variable per instance),
inviting exactly the configuration drift the finding warns about; the module
constant is shared by all instances because the mechanism is, and it is unreachable
from outside the module — not exported, not on the prototype, not on any instance —
so there is no reference a caller can obtain and mutate. The gate, quote creation,
preflight derivation, rehearsal, and pilot paths were audited: the only consumers
of the capability were inside the adapter itself, and every one now reads the
constant (a full-tree grep confirms no remaining `this.mutationCapability` read).
The public property remains as a **getter over the constant** for disclosure:
assignment to it throws a `TypeError` in strict mode (verified — the pre-correction
attack probe now dies at the assignment line), and an `Object.defineProperty`
shadow on a single instance is inert because nothing security-relevant reads the
instance property (test47.15 installs the shadow, asserts it is really there, and
shows quote and gate ignoring it).

### Finding 2 — invalid authorization scopes were accepted (blocking)

As delivered, quote creation refused only the exact string `"TARGET_REPLACEMENT"`.
Any other unknown runtime value — `"UNRESTRICTED"`, a wrong-case string, an empty
string, a number, an object — was accepted and recorded verbatim. At commit, the
stored scope was never validated: the gate's derivation
(`authorization_scope ?? proposal.authorizationScope ?? "OPERATION"`) passed the
bogus value through, and it was refused only incidentally, because the capability
branch fires for every scope — not because the scope was ever checked. Composed
with Finding 1 (or with any future permitting capability), a non-OPERATION scope
slips past the scope logic entirely: it is "not TARGET_REPLACEMENT", and nothing
else examines it.

**Failing-first record (pre-correction head).** test47.16 failed with "Missing
expected rejection" on the first case: `"UNRESTRICTED"` created and stored a quote
with no refusal (probe: the returned quote carried `authorizationScope:
"UNRESTRICTED"` verbatim). test47.17 (stored record seeded with `"UNRESTRICTED"`)
refused at commit under `AUTHORIZATION_PRESERVATION_UNENFORCEABLE` — the
incidental capability-branch refusal — not as invalid input. test47.18's composed
case likewise refused via the mismatch branch under the preservation code; the
probe in the review's ordering (mutate the instance first, then create a quote
declaring `"UNRESTRICTED"`) **dispatched and returned COMMITTED_AND_VERIFIED**.

**Fix — explicit runtime validation, both ends.**

- *Quote creation* (`validateScopeDeclarationAtCreation`, at the position the
  TARGET_REPLACEMENT check occupied — after the proposal shape/action checks,
  before any provider call): absent (undefined/null) ⇒ OPERATION; `"OPERATION"` ⇒
  accepted; `"TARGET_REPLACEMENT"` ⇒ refused `UNSUPPORTED_CHANGE` (unchanged);
  **any other value ⇒ refused `INVALID_PROPOSAL`**, no quote stored, no provider
  call made. Only the validated result is recorded.
- *Commit* (first step inside the gate block, before the TARGET_REPLACEMENT /
  capability logic): the stored record's scope is validated from **both**
  declaration sites — the `authorization_scope` field and the stored proposal. An
  unknown value in either refuses as `INVALID_PROPOSAL` with
  `CONFIRMED_NON_EXECUTION` recorded (never INDETERMINATE; zero dispatches; no
  receipt; no durable attempt). Only a validated scope reaches the capability gate,
  and a `TARGET_REPLACEMENT` in either site is effective — the record field cannot
  silently downgrade a proposal that declared it. Placement preserves the existing
  precedence exactly: replay, the INDETERMINATE guard, expiry/fingerprint
  (QUOTE_STALE/QUOTE_EXPIRED), determinacy, envelope (QUOTE_DRIFTED), and
  LIVE_COMMIT_DISABLED all still refuse first, and none of them consults the scope,
  so validating here cannot weaken them — while no gate decision is ever made on an
  unvalidated scope.

**Error-code choice.** `INVALID_PROPOSAL` is the codebase's invalid-caller-input
refusal at quote creation (every adapter throws it for malformed proposals; this
adapter already threw it for an empty change list and an unknown item). A scope
value outside the recognized set is malformed proposal input at creation, and the
same defect on the stored record at commit. `UNSUPPORTED_CHANGE` was not used: it
means "recognized but not implemented", which is exactly TARGET_REPLACEMENT's
classification and is preserved for it. No new error-code variant was needed, so
the corrections change no gated file (`INVALID_PROPOSAL` already exists in
types.ts; `scq-engine.ts` untouched).

**Simulator scope note (not hidden, not expanded).** The four simulator adapters
and the core engine never read `authorizationScope` at all (verified by grep): the
field is inert on those paths — a bogus scope there is neither honored nor refused,
because no simulator has a scope gate. Runtime validation of proposal fields in
general is Issue #22's Finding 2 (F2) territory, sequenced for the follow-up
runtime-validation PR; this correction deliberately does not expand into it. If
scope semantics are ever extended to the simulators, they need the same validation
— today a caller can pass a bogus scope to a simulator adapter with no refusal.

**After the corrections.** test47 is 18/18 (47.13–47.18 green; 47.1–47.12
unchanged and green); default suite 630/630; research suite unchanged (18; 3
pass / 15 fail — repro43 still fails with the gate refusal itself, as in §7); the
composed attack refuses as INVALID_PROPOSAL with zero dispatches (test47.18), and
the pre-correction end-to-end bypass no longer reproduces.

# PR-16 — Subscription identity binding (F3) + currency/cadence comparability (F4)

Issue #22 (Fabio's external review, Discussion #2), Findings 3 and 4.
Branch `fix/pr-16-identity-currency-comparability` from main `3839a10d`
(PR #25 merged). Evidence classes: SIMULATED_PASS and in-memory engine
calls only — mocked Chargebee transport (PilotMockChargebee), in-process
simulators, direct store/engine calls. No live Chargebee call was made,
no credential was used, `SCQ_LIVE_COMMIT_ENABLED` was never set in this
work's environment (the live adapter is exercised only against the mock
transport, as in test26/test28). Reproduction:
`reference/tests/repro45-identity-currency.repro.ts` (unchanged by this
PR). Regression suite: `reference/tests/test49-identity-currency-comparability.test.ts`.

## 1. Boundary audit (performed before any fix)

Every boundary where subscription identity or financial units are — or
should be — checked. "After" states what this PR changed; boundaries
that needed no change are listed with the reason.

### Identity boundaries

| # | Boundary | Checked before | After this PR |
|---|---|---|---|
| B1 | Chargebee-live `createChangeQuote` subscription read | Read keyed by the requested id; the returned record's `id` never compared. The quote records this read's fingerprint as `subscription_version_at_quote`, and the fingerprint is resource-version-based — identity is not a fingerprint input — so a foreign record was not reliably caught downstream. | **Fixed at the seam**: a returned record naming a different id refuses creation (`PROVIDER_ERROR`, `blocked: SUBSCRIPTION_IDENTITY_MISMATCH`) before any estimate. (Model: preflight PF3, B12.) Fixture fallout: test37.7 — see §5. |
| B2 | Chargebee-live commit-phase validation re-read (+ fingerprint input) | Same gap, on the read every commit decision (staleness, envelope, gates, dispatch) is based on. | **Fixed at the seam**: immediately after the read — after §6.10 replay and the recorded-INDETERMINATE guard, before `validateCommit`, the estimate, every gate, and the durable write-ahead — a foreign id records `CONFIRMED_NON_EXECUTION` (`blocked: SUBSCRIPTION_IDENTITY_MISMATCH`) and throws. Zero dispatches, zero durable attempts (test49.1). |
| B3 | Chargebee-live commit-phase estimate | Request keyed by the bound id; the consumed estimate surface carries no subscription id. | No change — no identity is present in the consumed surface to check; the read the estimate accompanies (B2) is identity-bound, and the estimate is addressed to the bound id. Recorded as a non-decidable surface, not a gap. |
| B4 | Chargebee-live mutating-call response (`establishLiveCommit`) | The response's subscription payload was consumed (candidate figures, attribution-bracket anchor, resulting snapshot) without comparing its `id` to the quote's. | **Fixed at the seam**: a present-but-foreign response subscription makes the response unusable as evidence — no state anchor, no candidate figures, its financial actuals not consumed (the immediate is recorded unestablished with the identity reason). Classification flows through the existing branches (see §2). |
| B5 | Chargebee-live post-commit re-read (`establishLiveCommit`) | Consumed without an id comparison — repro45.1's defect: items + rv-only fingerprint from a different subscription verified VERIFIED/OK. | **Fixed at two layers**: (a) the adapter treats a foreign re-read as an unavailable re-read for establishment (its items/fingerprint/figures are never consumed), naming the identity failure in the branch reasons; (b) the shared hook verdict (B7) independently computes MISMATCH for a foreign snapshot, so the landed-set verdict can never be VERIFIED on foreign state. |
| B6 | Chargebee-live unknown-dispatch re-read (`reconcileAfterUnknownDispatch`) | Diagnostic-only re-read; a foreign record would have been recorded as this subscription's observed state. Outcome is INDETERMINATE either way. | **Fixed (diagnostic integrity)**: a foreign re-read is treated as unavailable; the recorded outcome names the identity mismatch (`rereadIdentityMismatch` detail). Classification unchanged (INDETERMINATE, per L1). |
| B7 | Core state-verification hook (`verifyPostCommitState`) | The expectation carried no subscription identity; the observed snapshot's `id` was never compared to anything. An item-set match on another subscription's record verified VERIFIED. | **Fixed (shared layer)**: additive optional `PostCommitStateExpectation.expectedSubscriptionRef`; when supplied, a `state:subscriptionIdentity` check is computed — match VERIFIED, foreign id CONTRADICTED (⇒ MISMATCH), missing id / missing snapshot UNVERIFIABLE. Absent field ⇒ byte-identical historical behavior (test31 untouched). |
| B8 | Store `establishVerification` (evidence minting) | Checked `observation.subscriptionRef === quote.subscription_id` (the observation's *claim*); the observation's resulting *snapshot* association was unchecked (via B7). Stripe/Paddle observations assert the ref from a local variable while the snapshot comes from a read — the exposed pattern. | **Fixed via B7**: establishment now passes `expectedSubscriptionRef: quote.subscription_id` to the hook, so a foreign snapshot mints a MISMATCH token, and `verifyCommitReceipt` refuses it (its state-verification gate). The record stands COMMITTED_UNVERIFIED — history preserved (test49.3). |
| B9 | Store `recordCommitReceipt` | Already binds `receipt.quoteId` and `receipt.subscriptionRef` to the stored quote (`CONFLICTING_RECEIPT_IDENTITY`), plus restore-coherence checks in the durable store. | No change — already enforced. |
| B10 | Store `verifyCommitReceipt` / `assertEvidenceValid` | Recomputed identity *figures* only; state token gating already refused non-VERIFIED verdicts. | No direct change — inherits B7/B8 (state association) and U4 (unit comparability in the recomputation). |
| B11 | §6.10 replay (`checkIdempotentReplay`, `recordedReceipt`) | Returns the recorded receipt before any provider read or check. | No change, by design: identity/unit checks never interpose on replay (ordering stated in §3; pinned by test49.6). |
| B12 | Read-only preflight (PR #20, PF3) | Explicit `provider_subscription_identity` check on its re-read. | No change — the model for B1/B2; not regressed (test37–42 green). |
| B13 | Stripe adapter post-commit observation | `subscriptionRef` asserted from the adapter's local variable; the snapshot (from `sim.retrieve`) carried whatever record the read returned — a foreign record's state could verify the quote through B7/B8. | **Fixed via B7/B8** (no adapter-local change): a foreign post-commit record now computes hook MISMATCH and lands in the adapter's existing D3 translation — COMMITTED_AND_VERIFIED outcome with a VIOLATED reconciliation (verified-with-violation), never OK (test49.5). |
| B14 | Paddle adapter post-commit observation | Identical construction to B13. | **Fixed via B7/B8**, identically; the Stripe case is the pinned representative (same observation construction, same minting path). |
| B15 | Zuora adapter establishment | Its post-commit *artifact* read already binds identity (`order.subscriptionId === subscriptionId`, both establishment functions); the subscription read is a keyed in-process simulator retrieval — the record is stored under its own id, so no cross-subscription payload surface exists in the simulator's own implementation. | No change (reasoning recorded here). Later `verifyCommitReceipt` flows for its quotes are protected by B7/B8/B10 regardless of adapter. |
| B16 | Chargebee-simulator adapter establishment | Same as B15: artifact read binds `artifact.subscriptionId === subscriptionId && kind === "update"`; keyed in-process subscription retrieval. | No change (same reasoning). |
| B17 | Simulator adapters' commit-phase validation reads (all four) | Keyed in-process retrievals; no provider payload whose id could diverge within the simulators' own implementations. | No change (same reasoning as B15/B16). The live adapter's HTTP payload surface (B2) is the boundary where a read can name another subscription. |
| B18 | Chargebee-live `getSubscription` (public read API) | Returns the payload's own snapshot (its `id` is the payload's); consumers compare (preflight uses the raw client + PF3). | No change — a pass-through read that does not assert an association. |

### Unit-comparability boundaries

| # | Site | Before | After this PR |
|---|---|---|---|
| U1 | `reconcileCommittedEffect` — recurring dimension | `compareDeterminedDimensions` compared numbers only; `recurring.currency` / `recurring.cadence` were carried and never read. | Currency + cadence are comparability preconditions over the BC-1-comparable dimensions (see §4). |
| U2 | `reconcileCommittedEffect` — immediate dimension | No currency exists on `CommercialEffect.immediate` in the schema; nothing compared. | The immediate currency is established from threaded snapshot context, falling back to the side's recurring currency; same precondition rules (§4, §6). |
| U3 | `checkAcceptanceEnvelope` (pre-dispatch gates, all adapters + preflight) | Numbers only — a cross-currency revalidation passed the gate (repro45.4). | Same shared assessment: a unit contradiction or an unestablishable participating currency returns a violation string (the gate refuses pre-dispatch, as with numeric drift). |
| U4 | Store recomputation (`assertEvidenceValid`) | Recomputed figures only — a unit-blind recomputation would re-admit the defect even with U1 fixed. | Threads the recorded receipt's `resultingSnapshot.billing` as the compared side's unit context; the recomputation classifies identically to establishment (test49.12). |
| U5 | Establishment minting (`establishVerification`) | Reconciled without unit context. | Threads the observation's `resultingSnapshot.billing` (currency + cadence). |

## 2. F3 — identity enforcement design

**Pre-dispatch (B1, B2).** A read the quote or commit path relies on
that names a different subscription than the one it was addressed to
refuses before dispatch and before any durable DISPATCHING attempt.
The commit-path refusal is recorded with `CONFIRMED_NON_EXECUTION`
semantics — the same outcome class as the PR-14 preservation gate and
demonstrable pre-effect provider rejections: nothing was dispatched,
no receipt exists, a retry re-reads and refuses identically while the
provider misnames the record. It is never INDETERMINATE (that class is
reserved for dispatched-but-unestablished). Placement precedence in
`commitChangeQuote`: §6.10 replay → recorded-INDETERMINATE guard →
**identity check on the validation read** → `validateCommit`
(expiry/fingerprint) → PR-15 stored-proposal validation → revalidation
envelope → live-commit-enabled → PR-14 preservation gate → durable
write-ahead → dispatch. Replay and the INDETERMINATE guard keep their
precedence because both are decisions about *recorded* state that must
not be re-litigated by a fresh read.

**Post-dispatch (B4, B5, B6, B7/B8).** A dispatched commit's history
stands. A foreign post-commit read or response is a *verification
failure*, classified by the existing taxonomy at each seam:

- Live establishment (B4/B5): foreign response ⇒ its state and
  financials are not consumed (immediate unestablished, bracket
  unanchored); foreign re-read ⇒ treated as an unavailable re-read.
  The branches then classify exactly as they do for a missing
  response/re-read today: response received + no usable re-read ⇒
  COMMITTED_UNVERIFIED with candidate figures (or INDETERMINATE when
  no state evidence exists at all); re-read present + response
  unusable ⇒ attribution cannot close ⇒ COMMITTED_UNVERIFIED.
  Every branch's reason names the identity failure (and only then —
  same-subscription flows are byte-identical, suffix empty). Never
  VERIFIED/OK, never CONFIRMED_NON_EXECUTION.
- Unknown-dispatch path (B6): INDETERMINATE as before (L1), with
  foreign state never recorded as this subscription's observation.
- Store/hook (B7/B8): a foreign resulting snapshot computes MISMATCH;
  `verifyCommitReceipt` refuses the transition; the
  COMMITTED_UNVERIFIED record stands. Stripe/Paddle surface the same
  MISMATCH through their existing D3 translation
  (verified-with-violation).

**Reachability note (post-PR-14).** Since PR #24, every
Chargebee-live `commitChangeQuote` refuses at the preservation gate,
so the dispatch → establishment path (B4/B5 code) is not reachable
through the public commit API on current main — PR-14's own migration
recorded the same status for the establishment branches generally
(test26.9/26.10 headers). The B4/B5 normalization is implemented at
the seam where the defect class lives (it becomes live the moment a
conditional-write/targeted-update capability lifts the gate), and the
verdict layer it relies on — the shared hook (B7) — is pinned
end-to-end through the reachable store path (test49.3). The
pre-dispatch checks (B1/B2) are reachable and pinned directly
(test49.1/49.2).

## 3. Classification discipline and replay ordering

- Pre-dispatch identity mismatch = refusal (no dispatch, no durable
  attempt, `CONFIRMED_NON_EXECUTION` where outcomes are recorded).
- Post-dispatch identity mismatch = verification failure on a recorded
  outcome (COMMITTED_UNVERIFIED, verified-with-violation, or
  INDETERMINATE on the unknown-dispatch path) — never
  CONFIRMED_NON_EXECUTION for anything that dispatched.
- Unit contradiction (post-dispatch) = VIOLATED-class; unit
  unestablishable = UNVERIFIED-class; pre-dispatch, both refuse at
  the envelope gate (there is no committed outcome to classify yet).
- Replay: recorded receipts replay exactly as recorded, before any
  identity or unit check runs (B11; test49.6). Recovery/restore paths
  are untouched — no check was added to the durable store's restore
  coherence beyond what already existed (B9).

## 4. F4 — unit comparability design

One shared assessment (`assessUnitComparability` in
`core/scq-engine.ts`) serves both engine entry points, over exactly
the dimensions BC-1 established as comparable — a dimension that does
not participate in the numeric comparison raises no unit question,
and BC-1's own refusals keep their precedence.

- **Recurring currency**: established from the effect's
  `recurring.currency`, falling back to threaded snapshot context.
  Both established + differing (case-insensitive; adapters emit both
  `USD` and `usd`) ⇒ contradiction. Either side unestablishable ⇒
  unestablishable (currency is a required field, so its runtime
  absence is missing unit evidence, not a legacy shape).
- **Recurring cadence**: contradiction only where **both** sides
  state a cadence (effect field, then context). One-sided omission
  raises no problem — see the rationale and the PR #21 proposal in §6;
  pinned as a deliberate rule by test49.14.
- **Immediate currency**: the schema has no field (§6). Established
  from threaded context (the snapshot billing currency of the state
  the figures were observed with) first, then the side's recurring
  currency. Both established + differing ⇒ contradiction; a
  participating immediate whose currency cannot be established on
  one side ⇒ unestablishable.

**Precedence inside `reconcileCommittedEffect`** (envelope-bearing
paths): an established numeric violation reports first (unchanged
strings); then a unit contradiction ⇒ VIOLATED (envelope-independent,
outranking unverifiability — the same precedence PR-15 gives an
established violation under a malformed envelope, where the unit
check also runs); then unit-unestablishable ⇒ UNVERIFIED (merged
with any BC-1 undetermined dimensions); then the existing UNVERIFIED
/ OK outcomes. The no-envelope path is unchanged (with nothing to
compare against, a comparison precondition does not arise; that path
judges figure establishment, as before).

**Unit-context threading** (compared side unless noted): store
minting — the observation's snapshot billing (U5); store
recomputation — the recorded receipt's resulting-snapshot billing
(U4); Chargebee-live commit revalidation — the identity-checked
commit-phase read's `currency_code`; Chargebee-live establishment —
the post-commit re-read's `currency_code`; Zuora and Chargebee-sim
establishments — their re-read snapshot's billing. **Cadence is
deliberately not threaded on the Chargebee-live path**: its
`snapshotFrom` states `cadence: "MONTHLY"` as a construction
placeholder, not provider evidence — threading it would fabricate a
unit. Live-path cadence comparability therefore rests on the
effects' own recorded cadences (both currently omit it), a stated
limitation (§7). Sites whose committed effect is the quoted effect
by construction (defined-equal/EXACT paths in Stripe, Paddle, Zuora
cancel, Chargebee-sim cancel) thread nothing: their units are
identical by construction.

**Known limit (disclosed, not changed)**: the live adapter's
committed-effect construction defaults a missing `currency_code` to
the quoted currency / `"USD"` (`currencyOf`). A provider response
omitting the currency is thereby *denominated by construction*, and
the comparability rule governs stated units. Removing the default
would change effect construction across the live suite; it is
recorded here as a follow-up candidate for PR #21 discussion, not
silently altered.

## 5. The one pre-existing test modification

`reference/tests/test37-chargebee-preflight.test.ts`, test 37.7 only:
the fixture built its quote against `"cust_9f8e7d6c5b"` with a
transport that, by its own comment, "serves the fixture regardless
of the id asked" — i.e., a creation read addressed to
`cust_9f8e7d6c5b` answered with `pilot-sub-001`'s record, the exact
cross-identity assumption F3 removes (B1). The fixture now re-labels
the double's served record with the addressed id for the creation
call (the double answers *as* the addressed subscription — the
conventional meaning of a single-subscription double). The stored
quote binds to the undesignated id exactly as before; the preflight
run itself still uses the raw mock transport and refuses before
reads; **every assertion in test 37.7 is unchanged**, and the
preflight suite is 27/27. No other pre-existing test file is
modified; test47 (PR-14 pins) and test48 (PR-15 pins) are untouched,
and the repro43–46 files are byte-unchanged.

## 6. The immediate-currency schema gap — investigation and proposal

**What the implementation uses today.** `CommercialEffect.immediate`
carries `charge`/`credit`/`net` and no currency. In every adapter,
immediate figures are produced from provider records of the same
subscription whose recurring figures are denominated in the
subscription's billing currency — the only in-schema denomination an
immediate figure has. PR-16 therefore sources the immediate currency
as: threaded snapshot billing currency (the state the figures were
observed with), else the side's own recurring currency. **Limits**:
(a) it is inferential — a change that itself altered the billing
currency between quote and commit would be denominated from the
snapshots, which is the best the current schema can state, and no
adapter in this codebase offers a currency change; (b) where
neither source exists, the dimension classifies UNVERIFIED rather
than passing silently — the honest failure mode, and the pressure
that motivates the schema fix.

**Proposal for PR #21 (normative; NOT implemented here)**:

- Shape: add `currency?: string` to `CommercialEffect.immediate`
  (types.ts), populated by adapters from the same provider field
  that denominates the immediate actual (invoice/estimate currency)
  at construction time, on both quoted and committed effects.
- Semantics: when present on both sides of a comparison, it is the
  immediate dimension's established currency and takes precedence
  over the snapshot/recurring fallbacks in §4; the fallbacks remain
  for records that predate the field.
- Migration: the field is additive and optional, so stored quotes
  and receipts remain valid as recorded; no stored record is
  rewritten. Recomputation over historical records uses the
  fallbacks exactly as PR-16 does. A future major version may make
  the field required on newly constructed effects (adapter
  construction gate), which is a spec decision for the v0.6.2
  amendment process, not for this PR.
- Compatibility: consumers reading `immediate` today are unaffected
  (additive optional field); the freeze-guard surface is the same
  types.ts the amendment already touches for other PR #21 items.
- Companion proposals (same amendment batch): (i) make the
  resulting cadence a **required** recorded dimension on
  `CommercialEffect.recurring` for newly constructed effects, so
  cadence comparability stops depending on both-sides-stated
  (§4's cadence rule is a record-completeness limit, not a
  semantic preference); (ii) decide whether the Chargebee-live
  committed-effect currency defaulting (§4, known limit) should be
  replaced by an explicit unestablished-currency construction.

## 7. Compatibility impact

- All type/signature changes are additive and optional:
  `PostCommitStateExpectation.expectedSubscriptionRef`,
  `ComparisonUnitContext`, and the optional fifth parameter on
  `checkAcceptanceEnvelope` / `reconcileCommittedEffect`. Callers
  that pass nothing get the historical behavior **except** where
  the effects themselves state contradicting units (U1/U3 fire on
  effect fields alone — that behavior change is the fix).
- Behavior changes, exhaustively: (1) Chargebee-live creation and
  commit refuse foreign-id reads (B1/B2) — previously accepted;
  (2) hook verdicts change only for callers who supply
  `expectedSubscriptionRef` (the store now does; adapters' direct
  hook use via `verifyLandedItemSet` now does); (3) reconciliations
  and envelope gates that previously returned OK/null over
  cross-unit or currency-less participating dimensions now classify
  VIOLATED/UNVERIFIED or refuse; (4) same-subscription,
  same-unit flows are byte-identical in outcome (controls:
  test49.4/49.6/49.13/49.14, full suite 670/670).
- Gated footprint: `reference/src/core/types.ts` and
  `reference/src/core/scq-engine.ts` are freeze-guarded; the freeze
  guard fails by design until the `protocol-change-approved` label
  is applied by the maintainer. Neither spec file is touched.

## 8. Test evidence

Baselines on main `3839a10d` (Node 22.14, local): default suite
656/656; research suite 18 tests, 8 pass / 10 fail (repro43 1/2,
repro44 6/0, repro45 1/5, repro46 0/3).

Failing-first (test49 on unmodified main): **4 pass / 10 fail** —
all ten F3/F4 conversion tests fail (49.1, 49.2, 49.3, 49.5,
49.7–49.12); all four controls/rule-pins pass (49.4, 49.6, 49.13,
49.14).

After this PR: **default suite 670/670** (656 + 14 new); test49
14/14; test37 27/27; provider-neutrality check OK; packaging smoke
OK. **Research suite: 11 pass / 7 fail** — repro43 1/2 (unchanged;
F1 remains gated by PR-14's refusal, as recorded for PR #23/#25),
repro44 6/0 (unchanged), repro46 0/3 (unchanged; F5 is a later PR),
repro45 **4 pass / 2 fail**:

- 45.3, 45.4, 45.5 now PASS (the F4 conversions).
- 45.6 control passes (unchanged).
- 45.2 fails **only** because its live-adapter commit refuses at
  the PR-14 preservation gate (`AUTHORIZATION_PRESERVATION_UNENFORCEABLE`)
  — expected; the gate is intact and this PR does not reactivate
  full-list replacement.
- 45.1 fails for **the same gate reason, identically**: its commit
  also refuses at the PR-14 gate before any dispatch, so its
  post-dispatch identity scenario never reaches the mutating path.
  This contradicts the PR-16 assignment's expectation that 45.1
  would pass while 45.2 keeps failing at the gate — the two tests
  differ only in a transport rewrite that arms *after* a dispatch
  neither test reaches, so no implementation that keeps the PR-14
  gate intact (as required) can separate them. The defect 45.1
  targets is fixed at B4/B5/B7/B8 and its reachable forms are
  pinned by test49.1/49.2 (pre-dispatch) and test49.3/49.5
  (verification binding); 45.1 itself becomes reachable only when
  a future capability lifts the preservation gate. Reported
  exactly, per the assignment's accounting requirement; the repro
  file is byte-unchanged.

CI covers Node 20 + 22; local verification is Node 22.14. The known
intermittent test27.22b Node 20 timing flake did not appear in this
work's runs and the test is untouched.

## 9. Required PR #21 amendments and unresolved decisions

Amendments to fold into the PR #21 reconciliation (v0.6.2 spec
candidate):

1. **A-16-1 (F3 normative)**: state the identity-binding rule —
   verification boundaries must bind observed state/evidence to
   the quote's subscription; pre-dispatch foreign reads refuse as
   non-execution; post-dispatch foreign evidence is a verification
   failure, never a verified success.
2. **A-16-2 (F4 normative)**: state unit comparability as a
   precondition of financial comparison, with the
   contradiction/unestablishable classification split.
3. **A-16-3 (schema)**: the immediate-currency extension and the
   required-resulting-cadence proposal (§6), including the
   stored-record migration note.
4. **A-16-4 (construction)**: decide the Chargebee-live
   currency-defaulting question (§4 known limit).

Unresolved schema decisions (for Arjun / PR #21, not decided here):

- Whether `expectedSubscriptionRef`-style binding should become a
  **required** expectation field in the next major version (PR-16
  keeps it optional so existing callers and stored expectations
  are unaffected).
- Whether cadence comparison should normalize beyond case
  (e.g., provider cadence vocabularies like `monthly` vs
  `MONTHLY` vs `per_month`): PR-16 compares case-insensitively
  only; a canonical cadence vocabulary is a spec decision.
- The §6 migration question of whether historical receipts should
  be *annotated* (not rewritten) with derived unit context when
  next verified — PR-16 takes no position; recomputation already
  threads the recorded snapshot.

## 10. Correction round — P16-1 / P16-2 (independent review of `120f6cc`)

Arjun's independent review verified 670/670 on both Nodes and
accepted F3, but withheld approval on two F4 classification-order
defects. Both are fixed in this round; this section supersedes the
two §4 statements it names (the original precedence paragraph and
"the no-envelope path is unchanged").

**P16-1 — unknown currency could produce a false VIOLATED.** As
delivered, `reconcileCommittedEffect` compared numbers before
units: quoted USD 80,900 vs committed 90,000 in an unestablishable
currency classified VIOLATED on the +9,100 difference. Amounts in
unestablished units cannot be meaningfully compared, so that
difference is not evidence. **Rule now: unit comparability is a
per-dimension PRECONDITION for numeric evidence.** Classification
order in `reconcileCommittedEffect` (well-formed envelope): (1) an
established unit contradiction ⇒ VIOLATED (the contradiction is
itself the established evidence, and it is no longer displaced by
a numeric difference computed across the very units in question);
(2) a numeric violation on a dimension whose units are
established-and-compatible ⇒ VIOLATED (unchanged strings);
(3) unestablishable participating units ⇒ UNVERIFIED (a masked
numeric difference on such a dimension is reported here, never as
a violation); (4) BC-1 undetermined ⇒ UNVERIFIED; (5) OK. The
malformed-envelope (fireable-projection) path applies the same
per-dimension precondition to its numeric evidence; PR-15's
classification shape is otherwise unchanged. At
`checkAcceptanceEnvelope` (pre-dispatch), the gate still refuses
every one of these cases — nothing dispatches on an unproven
comparison — but the returned reason is now truthful in kind:
contradiction ⇒ "unit comparability precondition failed";
established-units numeric drift ⇒ the drift string;
unestablishable units ⇒ "unit comparability cannot be
established", never a proven-drift claim.

One coupling is recorded honestly: in the current schema the
immediate dimension's currency is sourced from the same two
inputs as the recurring dimension's (threaded billing context,
then the side's recurring currency), so currency-unestablishability
on a participating dimension is correlated across dimensions —
an unknown-currency dimension cannot coexist with an
established-currency sibling dimension until the A-16-3 schema
extension gives the immediate dimension its own currency field.
Per-dimension independence is therefore pinned where the current
schema can express it: a masked unknown-currency numeric
difference does not mask an independently established cadence
contradiction (test49.16), and an established contradiction at
differing numbers classifies on the contradiction, not the
numbers (test49.17).

**P16-2 — the no-envelope path bypassed unit comparisons.** As
delivered, `reconcileCommittedEffect` returned OK on the
no-envelope path whenever the committed figures were established,
without any unit check — so an established USD/EUR or
MONTHLY/ANNUAL contradiction silently reconciled OK on
envelope-less workflows (the valid cancellation exception). The
cancellation exception is preserved (no envelope is required);
what changes is that unit comparability is now computed before
any path returns and applies there too. **Per-path unit behavior
as implemented:**

| Path | Unit behavior |
|---|---|
| Envelope present, well-formed | Contradiction ⇒ VIOLATED; numeric violation on established-units dimension ⇒ VIOLATED; unestablishable participating currency ⇒ UNVERIFIED; else BC-1 outcomes / OK. |
| No envelope (cancellation exception; REVALIDATE CANCEL or any envelope-less call) | Contradiction ⇒ VIOLATED (established evidence is envelope-independent); unestablishable participating currency ⇒ UNVERIFIED (a commit whose units cannot be established cannot be verified as matching); same established units + established figures ⇒ OK exactly as before. Non-participating dimensions (justified NOT_APPLICABLE / unestablished figures) raise no unit question; unestablished committed figures remain UNVERIFIED as before. |
| No envelope, EXACT defined_equal_exact | Unit checks do not arise: the committed figures ARE the quoted figures by protocol construction, so their units are the quote's units identically — OK exactly as before, including where a unit is unstated on both sides (pinned by test49.23). |
| Malformed envelope (fireable projection, PR-15) | A violation through interpretable bounds establishes VIOLATED only on an established-units dimension (P16-1 masking); an established contradiction ⇒ VIOLATED (as PR-16 already held); otherwise UNVERIFIED, never OK. PR-15's shape is otherwise unchanged. |

**Failing-first (new tests on unmodified `120f6cc`):** test49
16 pass / 7 fail — the seven new pins fail (49.15 P16-1
conversion, 49.16 independence reason-pin, 49.17 contradiction
reason-pin, 49.18 pre-dispatch reason-pin, 49.19/49.20 P16-2
conversions, 49.21 P16-2 unestablishable pin); the two
preservation controls (49.22, 49.23) pass, as do all fourteen
pre-existing tests. **After the fix:** test49 23/23; default
suite **679/679** (670 + 9 new, zero regressions); research suite
unchanged at 11 pass / 7 fail with identical per-file accounting
(repro43 1/2, repro44 6/0, repro45 4/2, repro46 0/3 — repro files
byte-unchanged). Changes are confined to
`reference/src/core/scq-engine.ts` (gated, as before) plus
append-only test49 growth and this section; no pre-existing test
was modified.

## 11. Second correction round — P16-3 (independent re-review of `cf13c99`)

Arjun's re-review verified 679/679 on both Nodes and confirmed
P16-1 fixed and P16-2 fixed with one exception: the
defined_equal_exact exception added for P16-2 was implemented as
a **label-based skip** — on the no-envelope path,
`reconcileCommittedEffect` checked
`committed.provenance?.committedSource === "defined_equal_exact"`
and skipped BOTH unit branches (contradiction and
unestablishable) for a labeled record. A committed record
explicitly stating EUR against a USD quote — or ANNUAL against
MONTHLY — therefore still reconciled OK behind the label. This
section supersedes the "No envelope, EXACT defined_equal_exact"
row of §10's per-path table.

**Rule now: the label may excuse ABSENT unit statements; it may
never excuse CONTRADICTING unit statements.** The
defined_equal_exact label is an assertion that committed :=
quoted by protocol definition. Where the record states no unit,
that assertion is the only evidence and the construction holds —
the unstated unit IS the quote's unit, identically (test49.23,
unchanged, passes unmodified). But where the record explicitly
states a currency or cadence that contradicts the quote's
established units, the record's own explicit statements are
evidence that outranks the label: a record that states different
units is, on its face, not the quoted figures. Implementation:
the no-envelope path's unit-contradiction return is no longer
gated on provenance — it fires for any committed source
(`provider_actual`, `defined_equal_exact`, or any other) — and
its reason names the precedence when the label is present. The
unestablishable branch remains label-excused, exactly as before:
absent statements are the case the construction legitimately
covers. No other behavior changed.

**Per-path audit for the same label-based skip:**

| Path | Bypass present? | Disposition |
|---|---|---|
| No-envelope path (`reconcileCommittedEffect`, `envelope === undefined`) | **Yes** — the finding. | Fixed here: contradiction check ungated from the label; unestablishable remains label-excused (absent statements only). |
| Envelope-present path (well-formed envelope) | No — the contradiction return precedes all classification, with no provenance condition anywhere in the branch. | Unchanged. |
| Malformed-envelope path (fireable projection) | No — the contradiction return is unconditional there too. | Unchanged. |
| Store `verifyCommitReceipt` recomputation (`quote-store.ts`) | No skip of its own — the store admits `defined_equal_exact` only as an *establishing source* for the evidence's figures (an admissibility check on provenance, not a unit exemption) and then recomputes through `reconcileCommittedEffect`. It routed through the no-envelope bypass whenever the stored quote carried no envelope, and it inherits this fix by the same route. | Fixed transitively; no store change. |
| Store `establishVerification` minting (`quote-store.ts`) | Same as above — computes its reconciliation through `reconcileCommittedEffect`; no label-based pre-branch. | Fixed transitively; no store change. |
| Adapter establishments (Stripe, Paddle, Zuora, Chargebee simulator, Chargebee-live) | No — every adapter that produces a defined_equal_exact committed effect constructs it as a copy of the quoted effect (units identical by construction) and still passes it through `reconcileCommittedEffect`; none substitutes a hardcoded OK or branches on the label before reconciling. The engine's no-envelope branch was the only label-based skip in the codebase. | Unchanged. |

**Failing-first (new tests on unmodified `cf13c99`):** test49
24 pass / 3 fail — the three P16-3 conversions fail (49.24
currency contradiction behind the label; 49.25 cadence
contradiction behind the label; 49.26 the cancellation-shaped
currency case), each returning OK pre-fix; the preservation
control 49.27 (label + units restated identically ⇒ OK) passes,
as do all 23 pre-existing tests, test49.23 included and
unmodified. **After the fix:** test49 27/27; default suite
**683/683** (679 + 4 new, zero regressions); research suite
unchanged at 11 pass / 7 fail with identical per-file accounting
(repro43 1/2, repro44 6/0, repro45 4/2, repro46 0/3 — repro files
byte-unchanged). Changes are confined to
`reference/src/core/scq-engine.ts` (gated, as before) plus
append-only test49 growth and this section; no pre-existing test
was modified.

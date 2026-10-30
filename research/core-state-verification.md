# SCQ v0.6.2 PR-9 — Provider-neutral post-commit state verification

Implements issue #7 Topic 5's state-vs-intent verification as a shared,
provider-neutral core hook: `verifyPostCommitState` in
`reference/src/core/state-verification.ts`. The store's
`establishVerification` is refactored to consume it (one implementation,
not two), and the experimental Chargebee-live adapter's post-commit
establishment consumes it for its full item-set verification.

This PR does **not** activate BC-1 (the fail-closed financial gate is
PR-10), does **not** change any spec text, does **not** change receipt
identity semantics, and performs no real Chargebee call of any kind.

**Freeze-guard status (stated plainly):** this PR additively extends
`reference/src/core/types.ts` (new types only — no existing type is
modified), which is inside the freeze-guard pathspec. The
`check-frozen-surface` CI check will therefore FAIL on this PR until
the owner applies the `protocol-change-approved` label — the designed
behavior, the same as PR #8. Neither spec file is touched.

---

## 1. Audit of the pre-existing verification landscape

### 1.1 The store's private verifier (`quote-store.ts`, pre-PR-9)

`observedStateVerification(quote, observation)` — module-private,
consumed only by `establishVerification`, which mints branded
`VerificationEvidence` tokens from a `ProviderObservation`
(WeakSet brand; `verifyCommitReceipt` refuses unbranded evidence,
re-validates contents, enforces identity-digest binding and the
one-time legal transition). Per action, against the observation's
`resultingSnapshot`:

| Action | Check (pre-PR-9) | Contradiction | Insufficient evidence |
|---|---|---|---|
| CHANGE_QUANTITY | targeted item present, quantity exactly intended | item absent; quantity differs | items list absent; quantity member absent |
| CHANGE_PLAN | targeted item present, `offeringRef` equals intended | item absent; offering differs | items list absent |
| CHANGE_CADENCE | `snapshot.billing.cadence` equals intended (case-insensitive) | cadence differs | cadence absent/empty |
| CANCEL | subscription status in {cancelled, canceled, terminated} | non-terminal status **only** under an IMMEDIATE intent | non-terminal status under TERM_END/DATE intent (the snapshot carries no cancellation schedule — the F3 read-time distinction); status absent |

Composition: any contradiction ⇒ MISMATCH (a determined negative —
never collapsed into UNVERIFIABLE, Decision D3); else any
insufficient-evidence check ⇒ UNVERIFIABLE; else VERIFIED. No
snapshot, or an empty change list, ⇒ UNVERIFIABLE.

**Limits of the private implementation** (what PR-9 adds):

- **Action-level only.** It checks the *targeted* item of each change.
  An unexpected extra item, a missing unrelated item, or a duplicated
  identifier in the observed collection is invisible to it. The
  §6.12/Topic-5 contract — "the actual resulting state establishes
  the proposal's intended item set (identifiers and quantities, as a
  multiset)" — is not implemented anywhere in the shared layer.
- **Boolean-shaped output.** It returns only the verdict string: no
  checks performed, no dimensions, no coverage statement, no
  provenance. A consumer cannot tell a full-set verification from a
  targeted-item spot check.
- **No scheduled-cancellation establishment.** An ACTIVE subscription
  with an independently established TERM_END schedule can never
  verify: the snapshot type carries no schedule, so the check
  computes UNVERIFIABLE even when the caller holds schedule evidence
  from a richer provider read (Paddle's `scheduledChange` record —
  §1.3).
- **Store-bound.** Being private to `quote-store.ts`, no adapter can
  consume it; adapters that need state verification re-implement it
  (§1.2–§1.4).

### 1.2 Stripe / Paddle simulator adapters — consume the store path

`stripe-adapter.ts` / `paddle-adapter.ts` `establishCommittedEffect`
builds a `ProviderObservation` from a post-commit read bound to the
mutation's own invoice/transaction id (M3) and calls
`establishVerification` — so they inherit the private verifier's
action-level semantics exactly, including its limits. Both verify
against the **folded** proposal (M1: repeated changes to one target
collapse to the last stated value — the executed intent), and both
layer adapter-side attribution on top: an intervening
invoice/transaction pointer supersedes ⇒ COMMITTED_UNVERIFIED even
when the state verdict is VERIFIED (the state was not produced by
this commit alone).

### 1.3 Paddle CANCEL — adapter-owned establishment (contract differs)

`paddle-adapter.ts` `establishCancelCommit` does **not** use
`establishVerification`: the generic snapshot check cannot see a
cancellation schedule (the F3 limitation), and the sim's subscription
record carries `scheduledChange`, so the adapter reads it directly:

- IMMEDIATE intent: re-read status must be terminal ("canceled"),
  else MISMATCH.
- TERM_END intent: re-read must carry `scheduledChange.action ===
  "cancel"` with its effective date equal to the **quoted** effective
  date, subscription still active (kind SCHEDULED); a terminal read
  establishes the cancellation only once the quoted boundary is
  reached — a terminal read *before* it is a premature termination,
  an established contradiction (PR #11 correction P3).

This is the one place in the codebase where a scheduled cancellation
is verifiable from schedule evidence — the behavior PR-9's hook
generalizes into the core contract (an observation may carry
independently established `cancellationSchedule` evidence; §3).

### 1.4 Zuora simulator adapter — adapter-owned expected-state comparison

`zuora-adapter.ts` cannot use the snapshot check at all: a plan swap
**replaces** the rate plan, so the targeted item's instance id does
not survive and an identity-keyed check would report a correct
landing as a mismatch; the generic check also cannot see a scheduled
cancellation. The adapter computes the expected FINAL state from the
complete ordered action sequence applied to the known pre-state
(`expectedStateAfter`: charge multiset over catalog ids +
`cancelledDate` + status) and compares it against the independently
re-read observed state (`observedStateOf` / `stateContradictions`,
sorted-multiset JSON equality). Attribution is a version bracket
(validated version → the bound order's `subscriptionVersionAfter`
= +1 → re-read version): attributable + no contradictions ⇒
verified; attributable + contradictions ⇒ VIOLATED (D3); broken
bracket ⇒ COMMITTED_UNVERIFIED with the contradiction recorded as
unattributed context only (Z1–Z3). This is a genuinely different
state model (catalog-keyed, sequence-derived expectation) and stays
adapter-owned; PR-9 does not rewrite it. Its *contract* — multiset
comparison of the complete resulting state, attribution before
classification — is the same contract the core hook now states for
the snapshot-shaped providers.

### 1.5 Chargebee simulator adapter — full-set comparison, adapter-owned

`chargebee-adapter.ts` `establishCommittedEffect` compares the
re-read item list against the result the **complete dispatched
request** implies (`sortedItems` multiset over the stored request's
items, changed and unchanged, plus a status-stability check) —
the full-set semantics, implemented locally. Attribution is the
persisted mutation artifact's fingerprint bracket + recorded-request
identity; the cancel path (`establishCancelCommit`) additionally
requires the artifact's established financial evidence (PR #15 C1).
Stays adapter-owned in PR-9 (its expectation derives from the
provider-specific stored request and its attribution from the
artifact model, neither of which the provider-neutral hook can
see); the hook's FULL_ITEM_SET mode states the same multiset
contract for adapters whose expectation is expressible as a
resulting item set.

### 1.6 Chargebee-live adapter — full-set comparison, adapter-owned (integrated in PR-9)

`live/chargebee-scq-adapter.ts` `establishLiveCommit` verified the
intended set with a local helper, `itemSetMismatches` (multiset over
item_price_id + quantities against the dispatched request's
`input.items`, used both in the response-received establishment and
in the lost-response reconciliation probe
`reconcileAfterUnknownDispatch`), and layered on top: the
response↔re-read fingerprint bracket (attribution; resource_version
movement is detection, never CAS), strict provider-stated-amount
pricing (never `unit_price × quantity` reconstruction), and the
Defect-3 COMMITTED_UNVERIFIED construction. **PR-9 replaces both
`itemSetMismatches` call sites with `verifyPostCommitState`** in
FULL_ITEM_SET mode (expected set = the dispatched request's items);
the adapter keeps the bracket, the financial establishment, and
every outcome classification. The hook's contradiction phrasings
mirror the retired helper's for the cases that surface in
reconciliation reasons (quantity mismatch / missing / extra /
duplicate), so recorded reason text keeps its established shape.

### 1.7 What pins current behavior

`test15`/`test16` (establishment, branding, self-assertion refusal,
one-time transition, restore coherence), `test17`–`test20` (Stripe /
Paddle migrations incl. M1–M3, P1–P3), `test24` (Zuora Z1–Z3),
`test25` (Chargebee-sim), `test26` (Chargebee-live 20-row matrix +
zero-real-mutation audit), `test27`–`test30` (durable store,
coordinator, D1–D5). PR-9 must keep every one of these green
unmodified, except where an integration's call site legitimately
changes (none were needed — see §6).

---

## 2. Design

### 2.1 Placement

`verifyPostCommitState` lives in a **new core module**,
`reference/src/core/state-verification.ts`, importing **types only**
from `core/types.ts`. It takes the proposal and the expected state
as plain inputs — never a `StoredQuote` — so core does not depend
on the store layer (the existing dependency direction is preserved:
`quote-store.ts` already value-imports from core; `scq-engine.ts`
type-imports from the store; a core→store dependency, even
type-only, would add a second, opposite edge for no benefit).
`quote-store.ts` and the adapters adapt their records into the
hook's inputs. New types are declared in `core/types.ts` (additive
exports only), alongside the other protocol types.

### 2.2 The hook computes; nobody asserts

The signature accepts **no verdict input**. Callers supply (a) the
authorized intent (the stored quote's proposal), (b) optionally the
expected resulting item set derived from the authorized request,
and (c) a normalized observation. The verdict, checks, and
dimension lists are computed from those inputs alone. The
establishment brand is **not** extended to the hook's result: the
result is a plain computed value, and the only path from an
observation to receipt-verification evidence remains
`establishVerification`, which consumes the hook's verdict and
brands the token it mints. A caller holding a
`PostCommitStateVerification` holds no evidence token and cannot
present one to `verifyCommitReceipt`.

### 2.3 What the result is — and is not

The result answers exactly one of the four questions a commit
raises: **is the intended state currently observed?** It
structurally declines the other three — the result carries
`executionEstablished: false`, `stateAttributableToThisOperation:
false`, and `financialOutcomeEstablished: false` as constant,
typed fields, so a consumer reading a VERIFIED verdict is looking
at the explicit non-claims in the same object. Consequences, held
throughout PR-9's integrations:

- A lost-response attempt stays INDETERMINATE however well a later
  read matches intent (PR #16 L1, observational equivalence). The
  hook has no input that could change an attempt's outcome class.
- A broken attribution bracket still caps the outcome at
  COMMITTED_UNVERIFIED with no established recurring figure (Z3):
  attribution is established by the adapter's operation-bound
  evidence (bracket/artifact/pointer), never by state matching.
- A state MISMATCH is a state contradiction. It becomes a financial
  VIOLATED only where independently attributable financial evidence
  exists (the adapters' existing D3 paths, unchanged).

---

## 3. Contract

```ts
verifyPostCommitState(
  expectation: PostCommitStateExpectation,
  observation: PostCommitStateObservation,
): PostCommitStateVerification
```

**Expectation** (trusted context, from the stored quote / the
authorized request — never from the post-mutation state):

- `proposal: SubscriptionChangeProposal` — the changes and the
  proposal-level `effectiveIntent`.
- `expectedItems?: ReadonlyArray<{ id, quantity?, offeringRef? }>`
  — the expected RESULTING item multiset. Supplying it claims
  FULL_ITEM_SET coverage; omitting it limits the result to
  ACTION_LEVEL coverage, which the result states.

**Observation** (normalized post-commit read; adapters bind it to
actual provider reads — the core cannot authenticate the channel):

- `snapshot?: PostCommitObservedSnapshot` — a `SubscriptionSnapshot`
  whose `items` member may be **absent**: absent means the read
  omitted the collection (UNVERIFIABLE), and is never read as an
  empty collection. A present empty array is a stated empty set.
- `itemsComplete?: boolean` — `false` when the caller knows the
  item collection is a partial return (§4, partial rule).
- `cancellationSchedule?: { effectiveAt?: string }` — a
  cancellation schedule **independently established** from provider
  data (e.g. Paddle's `scheduledChange` record), for scheduled
  CANCEL verification. Never derived from the snapshot's status.
- `source: string`, `observedAt?: string` — provenance of the read,
  carried into the result verbatim.

**Result** (`PostCommitStateVerification`):

- `verdict: "VERIFIED" | "MISMATCH" | "UNVERIFIABLE"`.
- `coverage: "FULL_ITEM_SET" | "ACTION_LEVEL"`.
- `checks: Array<{ check, dimension, outcome, detail }>` — every
  check performed, its dimension, and its individual outcome
  (VERIFIED / CONTRADICTED / UNVERIFIABLE).
- `verifiedDimensions`, `contradictions` (established, human-
  readable), `unverifiableDimensions`.
- `stateObserved: boolean` — whether any snapshot was present.
- `executionEstablished: false`,
  `stateAttributableToThisOperation: false`,
  `financialOutcomeEstablished: false` — the structural
  non-claims (§2.3).
- `provenance: { source, observedAt? }`, `limitations: string[]`.

**Composition rule (precedence):** any established contradiction ⇒
MISMATCH, even when other dimensions are unverifiable (a
contradiction is a determined negative; it is never masked as
merely unverifiable, and never outweighed into VERIFIED). Else any
unverifiable required check ⇒ UNVERIFIABLE. Else VERIFIED. A
multi-change proposal is VERIFIED only when **every** required
check verifies.

---

## 4. Item-set semantics (FULL_ITEM_SET coverage)

Expected and observed collections are compared as **multisets**
over item identifiers, with per-identifier quantity (and
`offeringRef`, where the expectation states it) comparison:

- expected item absent from the observed collection ⇒ contradiction
  (`missing item X (intended quantity Q)`);
- observed item outside the expectation ⇒ contradiction
  (`extra item X (actual quantity Q)`);
- observed identifier count exceeding the expected count ⇒
  contradiction (`duplicate entries for item X (×N)`);
- quantity multiset for an identifier differs ⇒ contradiction
  (`quantity mismatch for item X: intended Q, actual A`);
- an observed entry whose identifier or quantity is absent cannot
  be compared ⇒ the item-set dimension is UNVERIFIABLE from that
  entry (it establishes neither presence nor absence);
- **omitted collection** (`snapshot.items` absent) ⇒ UNVERIFIABLE,
  never an empty set;
- **present empty collection vs a nonempty expectation** ⇒
  MISMATCH (the complete stated set contradicts the intent);
- **partial collection** (`itemsComplete: false`) — the stated
  rule: contradictions established by *present* entries (extra
  item, duplicate, wrong quantity, wrong offering) stand;
  *absence-based* contradictions (missing item) are **not**
  established, because the item may simply be unreturned — the
  item-set dimension is UNVERIFIABLE on that account. Pinned by
  tests 31.6a/31.6b.

In FULL_ITEM_SET mode the per-change CHANGE_QUANTITY / CHANGE_PLAN
checks are subsumed by the item-set comparison (the expected set
*is* the dispatched result, changed and unchanged items alike) and
the result says so in `limitations`; CHANGE_CADENCE and CANCEL
checks still run per-change. In ACTION_LEVEL mode the per-change
checks are the pre-PR-9 semantics, verbatim (§1.1): targeted item
presence/quantity/offering via first-match, cadence, and the
cancel rule below. Action-level coverage never claims the
untargeted items were compared — `limitations` states that
unexpected additions/removals outside the targeted items are not
detected at this coverage.

## 5. Action-by-action matrix

| Action | Verified when | MISMATCH when | UNVERIFIABLE when |
|---|---|---|---|
| CHANGE_QUANTITY (action-level) | targeted item present at the intended quantity | item absent; quantity differs | items omitted; quantity member absent |
| CHANGE_QUANTITY (full-set) | the complete resulting multiset equals the expected set (incl. the target at its intended quantity) | any multiset contradiction (missing / extra / duplicate / wrong quantity) | collection omitted or partial-without-contradiction; an entry unidentifiable |
| CHANGE_PLAN (action-level) | targeted item present carrying the intended offering | item absent; offering differs | items omitted |
| CHANGE_PLAN (full-set) | resulting multiset matches incl. the expected offering for the item | offering differs; any multiset contradiction | as above |
| CHANGE_CADENCE | observed `billing.cadence` equals the intended cadence | cadence present and differs | cadence absent/empty |
| CANCEL, IMMEDIATE intent | status terminal (cancelled/canceled/terminated) | status non-terminal — **including** an active subscription carrying a TERM_END schedule: a scheduled cancellation is not an immediate termination | status absent |
| CANCEL, TERM_END/DATE intent | status terminal; **or** status non-terminal with an independently established cancellation schedule (for DATE, the schedule's date equals the intent's date) | DATE intent with an established schedule on a *different* date | status non-terminal with **no** schedule evidence — the schedule is never invented from the status field |

Notes on the CANCEL rows: the pre-PR-9 snapshot rule is preserved
where the snapshot is the only evidence (terminal ⇒ verified;
non-terminal scheduled-intent ⇒ unverifiable). The schedule-
evidence row is the generalization of Paddle's adapter-level
establishment (§1.3) into the core contract. Paddle's stricter
refinement — a terminal read *before* the quoted boundary is a
premature termination (P3) — remains adapter-level in PR-9: it
needs the quoted effective date and a clock, which are Paddle's
commit-path context, not the hook's inputs.

## 6. Integrations performed in PR-9

1. **`establishVerification` (store) consumes the hook.** The
   private `observedStateVerification` is deleted; establishment
   computes `stateVerification` as
   `verifyPostCommitState({ proposal: quote.proposal }, { snapshot:
   observation.resultingSnapshot, source: observation.source,
   observedAt: observation.observedAt }).verdict` — ACTION_LEVEL
   coverage, identical verdicts on every input the private function
   handled (the per-action logic is the extracted logic, and the
   full pre-existing suite pins it: test15–test25 unmodified and
   green). Branding, provenance refusal, reconciliation
   recomputation, identity binding, the one-time transition, and
   restore coherence are untouched. `DurableQuoteStore` inherits
   the refactored path (its `verifyCommitReceipt` override calls
   the parent's), so durable verification and recovery consume the
   same single implementation.
2. **Chargebee-live adapter consumes the hook in FULL_ITEM_SET
   mode** at both former `itemSetMismatches` call sites
   (`establishLiveCommit`'s establishment branching and
   `reconcileAfterUnknownDispatch`'s "intended set in effect"
   probe — where only a VERIFIED verdict counts as in-effect, so
   the L1 classification is unchanged: matching state informs the
   INDETERMINATE error's context and never produces a receipt).
   The adapter's branching order is preserved (verified-set branch;
   then the incomplete-data branch; then the nothing-landed,
   D3-VIOLATED, and unattributed-context branches), keyed on the
   hook's verdict in place of the helper's list emptiness; reason
   text is built from the hook's `contradictions`. test26/test21
   pin the outcomes and the surfaced phrasings.
3. **No other adapter is rewritten.** Stripe/Paddle consume the
   hook transitively through `establishVerification`; Paddle's
   cancel establishment, Zuora's expected-state establishment, and
   the Chargebee-sim artifact establishment stay adapter-owned for
   the state-model reasons in §1.3–§1.5 — their contracts are the
   ones the hook's documentation now states, and migrating them is
   separable future work, not a PR-9 requirement.

### Taxonomy composition (documentation + pins)

- COMMITTED_AND_VERIFIED requires established landing **and**
  attributable state **and** independently established financials.
  A VERIFIED state verdict supplies at most the first question's
  state half; it satisfies neither attribution nor financial
  establishment (§2.3).
- COMMITTED_UNVERIFIED is established landing with incomplete
  verification, its unverified dimensions labeled — including the
  case "state VERIFIED, attribution broken" (26.14b / 31.23).
- INDETERMINATE is untouched by the hook: no hook result creates,
  upgrades, or clears it (31.22, 31.27).
- No receipt is created by the hook for any outcome; recorded
  receipts are never overwritten — verification status advances
  only through the existing one-time `verifyCommitReceipt`
  transition (31.25, 31.26).

## 7. BC-1 readiness — where PR-10 connects (no code change here)

BC-1 is the separately reviewed fail-closed financial gate. PR-9
changes none of these entry points; it records exactly where PR-10
connects:

- **`checkAcceptanceEnvelope`** (`core/scq-engine.ts`) still
  zero-coerces absent dimensions:
  `quoted.immediate?.net ?? 0`, `revalidated.immediate?.net ?? 0`,
  `quoted.recurring?.resultingAmount ?? 0`,
  `revalidated.recurring?.resultingAmount ?? 0`. An UNKNOWN
  dimension therefore compares as 0 and can pass an envelope it
  should refuse. PR-10 must make the bounded-dimension comparison
  refuse when either side's determinacy is UNKNOWN (reading via
  the existing `determinacyOf`), with NOT_APPLICABLE handled per
  the applicability table (Topic 1) rather than as zero.
- **`reconcileCommittedEffect`** inherits the overstatement: over
  zero-coerced figures it returns `OK`, so a commit whose committed
  dimensions were never established can be reported reconciled-OK.
  PR-10 must make reconciliation over UNKNOWN committed dimensions
  produce `UNVERIFIED` (Topic 4/5: "anything less is UNVERIFIED or
  indeterminate, never OK"), while keeping the determined-figure
  OK/VIOLATED computation and the envelope-less ⇒ OK rule for
  envelope-free proposals.
- **Existing machinery PR-10 builds on:** `determinacyOf` (the
  single reading of determinacy; absent ⇒ UNKNOWN) and
  `auditDeterminacy` (report-only; its `WOULD_REFUSE_UNKNOWN`
  findings enumerate, per dimension, exactly the payloads BC-1
  will refuse — adapter fixtures already audit clean post-
  migration). Adapters already pre-gate commits with
  `assertEffectDeterminateForCommit`-style checks (Chargebee-live)
  or adapter-level UNKNOWN refusals (PR #10/#11 doctrine M2), so
  the core gate lands on migrated paths first.
- **Expected compatibility impact of activation:** payloads with
  absent determinacy (legacy v0.6.1-shaped effects) will newly
  refuse at commit instead of passing as zeros — a deliberate,
  loud break, gated on the remaining adapters emitting determinacy
  on every effect. State verification is **not** a BC-1 input: the
  financial gate and this PR's state hook compose at
  `establishVerification` (state verdict + reconciliation), which
  already keeps them as separate requirements; neither substitutes
  for the other.
- Nothing here modifies `checkAcceptanceEnvelope`,
  `reconcileCommittedEffect`, `determinacyOf`, or
  `auditDeterminacy`, and nothing in PR-9's hook reads financial
  figures at all — the state verdict is computed from state alone
  (pinned by tests 31.20/31.21).

## 8. Test evidence (test31)

New suite `reference/tests/test31-state-verification.test.ts` —
30 tests covering the assignment's 28 rows (rows 4, 6, and 16 are
split into paired tests). **Failing-first record:** the suite was
written before the implementation and run against the unmodified
tree (main @ 99ed629 + test31 only): `npm test` failed at compile
— `Cannot find module '../src/core/state-verification.js'` and
`Module '"../src/core/types.js"' has no exported member
'PostCommitObservedSnapshot'` — i.e. every hook-level assertion
failed because the shared API did not exist; row 16's
scheduled-cancellation establishment was additionally inexpressible
through any pre-PR-9 API (the private verifier had no schedule
input at all). After implementation: **430/430** (400 pre-existing,
unmodified, + 30 new), Node 22.14.

Classification per row — NEW = behavior that did not exist before
PR-9; EXTRACTION = behavior the store's private verifier already
computed, now pinned against the shared core API; COMPATIBILITY =
pre-existing integration behavior that must survive the refactor:

| Row | Test(s) | Class | What it pins |
|---|---|---|---|
| 1 | 31.1 | NEW | Exact full-set match ⇒ VERIFIED at FULL_ITEM_SET coverage. |
| 2 | 31.2 | NEW | Unexpected extra item ⇒ MISMATCH. The private verifier was action-level and would have reported this state VERIFIED — the gap full-set coverage closes. |
| 3 | 31.3 | NEW | Non-target item missing ⇒ MISMATCH (same gap as row 2). |
| 4 | 31.4 | EXTRACTION + NEW | Wrong quantity ⇒ MISMATCH at action level (extracted semantics, exact pre-existing phrasing) and at full-set coverage (new). |
| 5 | 31.5 | NEW | Duplicate observed identifiers ⇒ MISMATCH (full-set; action-level historically used find-first and did not detect this). |
| 6 | 31.6a/31.6b | NEW | The stated partial rule: absent item in a partial collection ⇒ UNVERIFIABLE (not missing); a contradiction from a PRESENT entry ⇒ MISMATCH. |
| 7 | 31.7 | EXTRACTION + NEW | Omitted collection ⇒ UNVERIFIABLE at both coverages — never read as an empty set. |
| 8 | 31.8 | NEW | Present EMPTY collection vs nonempty expectation ⇒ MISMATCH (a stated empty set is data, not missing data). |
| 9 | 31.9 | EXTRACTION + NEW | Correct plan replacement ⇒ VERIFIED at action level (extracted) and at full-set coverage with a stated expected offering (new). |
| 10 | 31.10 | EXTRACTION | Wrong offering ⇒ MISMATCH. |
| 11 | 31.11 | EXTRACTION | Correct cadence ⇒ VERIFIED (case-insensitive, as before). |
| 12 | 31.12 | EXTRACTION | Missing cadence ⇒ UNVERIFIABLE. |
| 13 | 31.13 | EXTRACTION | Wrong cadence ⇒ MISMATCH. |
| 14 | 31.14 | EXTRACTION | Immediate cancel + terminal state ⇒ VERIFIED. |
| 15 | 31.15 | EXTRACTION + NEW | Immediate cancel + active status ⇒ MISMATCH (extracted); active + an established TERM_END schedule still ⇒ MISMATCH (new pin: schedule evidence never rescues an IMMEDIATE intent). |
| 16 | 31.16 | NEW | Scheduled cancel with independently established schedule ⇒ VERIFIED (TERM_END; DATE with matching date); DATE with a different established date ⇒ MISMATCH. Inexpressible pre-PR-9. |
| 17 | 31.17 | EXTRACTION | Scheduled cancel without schedule evidence ⇒ UNVERIFIABLE — never invented. |
| 18 | 31.18 | NEW | Multi-change precedence: one contradiction + one unverifiable dimension ⇒ MISMATCH, with the unverifiable dimension still reported. |
| 19 | 31.19 | EXTRACTION | Multi-change with one unverifiable dimension ⇒ UNVERIFIABLE (not VERIFIED), dimension labeled. |
| 20 | 31.20 | COMPATIBILITY | Correct figures + wrong state (via `establishVerification`): token computes state MISMATCH while reconciliation over the figures is separately OK; the transition is refused. The two requirements are independent. |
| 21 | 31.21 | NEW + COMPATIBILITY | Correct state + UNKNOWN figures: the hook returns VERIFIED with `financialOutcomeEstablished === false`; establishment still refuses the unestablished source — a state verdict manufactures no financial establishment. |
| 22 | 31.22 | NEW + COMPATIBILITY | Lost response + later exactly-matching state (mocked live adapter): the hook reports VERIFIED over the re-read state, and the attempt STAYS INDETERMINATE — no receipt, blind retry still refused, no second dispatch (PR #16 L1). |
| 23 | 31.23 | COMPATIBILITY | Intervening actor breaks the bracket (mocked): receipt stays COMMITTED_UNVERIFIED with no recurring figure; the hook's MISMATCH over the same state is NOT translated into a financial VIOLATED (Z1/Z3). |
| 24 | 31.24 | EXTRACTION | Snapshot absent ⇒ UNVERIFIABLE with `stateObserved === false`. |
| 25 | 31.25 | COMPATIBILITY | `verifyCommitReceipt` still refuses self-asserted evidence post-refactor — including a `verifyPostCommitState` RESULT presented as evidence: the hook's return value is not a branded token and launders nothing. |
| 26 | 31.26 | COMPATIBILITY | Verification through the refactored establishment + durable restart: replay returns the ORIGINAL recorded receipt (deep-equal), the current view carries the transition, the identity digest validates. |
| 27 | 31.27 | COMPATIBILITY | Durable ledger after an INDETERMINATE outcome: attempt survives restart, still blocks re-dispatch, no receipt, recovery report enumerates it — and a VERIFIED state verdict over a matching read changes none of that. |
| 28 | 31.28 | COMPATIBILITY | The live-commit safety gate still refuses dispatch when disabled; zero mutating calls reach the (mocked) transport. |
| — | 31.29 | NEW | Result contract: checks/coverage/provenance/limitations are in the value; the three constant-false establishment fields are structurally false; action-level results state their narrower coverage in their limitations. |

Full-run evidence (Node 22.14, this branch): clean build +
`npm test` **430/430**; `npm run smoke:pack` OK including a
cold-cache run (`npm_config_cache=$(mktemp -d)`); `npm run demo`
OK (refusal posture intact); `npm run demo:commit` OK (COMMITTED,
reconciliation OK); `npm run pilot:chargebee` OK — SIMULATED_PASS,
**0 mutating calls**, live commit BLOCKED. Zero pre-existing test
files were modified. Classification of the whole run:
SIMULATED_PASS (all provider interaction is mocked/synthetic; no
real Chargebee call was made and `SCQ_LIVE_COMMIT_ENABLED` was
never set).

## 9. Limitations

- The hook verifies state as *observed in a normalized snapshot*;
  it cannot authenticate the provider channel (restated from the
  establishment contract — adapters bind observations to real
  reads; mocked integrations demonstrate the wiring, not channel
  authenticity).
- FULL_ITEM_SET coverage is only as strong as the expectation the
  caller derives from the authorized request; an expectation
  derived from post-mutation state would be circular, and the
  contract forbids it — enforcement is by construction at the two
  integration sites (stored proposal; dispatched request) and by
  review, not by the type system.
- Paddle's premature-termination refinement (P3) and Zuora's
  sequence-derived expectation remain adapter-level (§1.3, §1.4).

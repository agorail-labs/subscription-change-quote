# SCQ v0.6.2 — Normative Specification Candidate (Fail-Closed Financial Semantics)

Status: DRAFT — proposed v0.6.2 specification; not approved, published, or released. v0.6.1 remains the current specification.

This document is a specification **candidate** prepared for independent review under the
repository's `protocol-change-approved` process (design: issue #7; pilot readiness: issue #12).
It changes nothing by existing. Until a maintainer reviews this candidate and applies the
approval process, `spec/scq-v0.6.1-spec.md` is the only normative SCQ specification, and no
implementation, release note, or evidence report may cite v0.6.2 as an approved standard.

**What this candidate is.** v0.6.2 is a semantics cycle, not a scope cycle. It adds no
providers, no actions, and no guarantee modes. It corrects three defects that live validation
of the experimental Chargebee adapter exposed in v0.6.1's *financial semantics* — what the
protocol allowed an adapter to claim, not any adapter's arithmetic:

1. **Unknown was indistinguishable from zero** in envelope enforcement (the frozen engine
   coerced every absent financial dimension to 0 via `?? 0`).
2. **`CommercialEffect.immediate` had no normative definition**, and adapters populated it
   with economically different quantities (an incurred unbilled obligation vs. a
   credit-netted amount due).
3. **A committed-but-financially-unverified outcome could not be represented**, and nothing
   required the committed *state* to be verified against the quoted *intent*.

It also normatively describes two capabilities the implementation gained while closing those
defects: a provider-neutral post-commit state-verification contract, and durable
quote/receipt/attempt storage with write-ahead dispatch. The reconciliation round (against
PRs #24–#27) adds normative descriptions of four further merged behaviours: fail-closed
authorization preservation for full-replacement dispatch (§3.15, §6.17), shared runtime
proposal validation (§6.18), subscription identity binding and currency/cadence unit
comparability (§3.16, §6.19), and the append-only receipt-evidence model with derived
current views that replaces every candidate-equals-actual requirement (§3.10, §6.15,
§6.16).

**Relationship to the implementation.** The normative text below was written against the
merged implementation on `main` (PRs #8, #10–#11, #13–#20, and — after the PR #21
reconciliation round — PRs #23–#27, at `main` 82cbd1d) and agrees with it, except where a
discrepancy is recorded inline with a `DISCREPANCY` marker and entered in
`research/v0.6.2-release-gaps.md`. Where this candidate and the code disagree silently, the
code is not thereby conformed and this text is not thereby correct — the gap register is the
authoritative list of known disagreements and open decisions. Conformance evidence is mapped
clause-by-clause in `conformance/v0.6.2-traceability.md`.

**Conventions.** "§n" references without a version qualifier are to this document. Sections
carried over from v0.6.1 unchanged are marked *(v0.6.1, unchanged)*; sections new or modified
in v0.6.2 are marked *(v0.6.2)*. The full clause-by-clause delta is Appendix A. Normative rule
identifiers (`V62-…`) are defined in Appendix B and are the identifiers the traceability
matrix uses.

---

## 1. Scope *(v0.6.1, unchanged)*

SCQ normalizes exactly one lifecycle: **quote → commit** for a bounded set of subscription
change types, across providers that expose subscription billing APIs. It is explicitly NOT:

- A subscription creation protocol (subscriptions must already exist).
- A payment or refund protocol.
- An authorization, consent, or agent-identity protocol.
- A negotiation protocol (proposals are accepted or refused, not counter-offered).
- A usage-billing or metered-consumption protocol.
- A procurement or contract-negotiation protocol.

The four supported change actions are fixed:

```
CHANGE_QUANTITY | CHANGE_PLAN | CHANGE_CADENCE | CANCEL
```

Adding a fifth action, or a fifth provider, is out of scope for this document and would
require a new minor version.

---

## 2. Core Lifecycle *(v0.6.1, unchanged, one addition noted)*

```
getSubscription(id) -> SubscriptionSnapshot
createChangeQuote(id, proposal) -> SubscriptionChangeQuote
commitChangeQuote(quoteId) -> SubscriptionChangeReceipt
getCapabilities() -> ProviderCapabilities
```

- `getSubscription` MUST NOT mutate provider state.
- `createChangeQuote` MUST NOT mutate provider state, in any guarantee mode. (This is stronger
  than "no financial mutation" — it means no state transition of any kind, including
  scheduling a future change, is permitted at quote time.)
- `commitChangeQuote` performs exactly one mutating operation against the provider (or
  refuses with no mutation at all — see §6).
- `getCapabilities()` is pure and provider-instance-scoped, not subscription-scoped (see §4.3
  for the distinction between provider-level and quote-level capability reporting).

*(v0.6.2 addition)* A deployment that commits against a real provider MUST run the commit
path on durable storage (§6.16). The lifecycle above is unchanged; §6.16 states what the
storage underneath it must guarantee for the lifecycle's idempotency and recovery rules to
hold across process restarts.

---

## 3. Types

### 3.1 `EffectiveIntent` *(v0.6.1, unchanged)*

```ts
type EffectiveIntent =
  | { type: "IMMEDIATE" }
  | { type: "TERM_END" }
  | { type: "DATE"; at: string };  // ISO 8601
```

Every `SubscriptionChangeProposal` MUST carry exactly one `EffectiveIntent`, applying to
every change in the proposal's `changes[]` array (SCQ does not support per-change effective
timing within one proposal — see §9, U-3).

- `IMMEDIATE`: apply as soon as the commit call executes.
- `TERM_END`: apply at the current billing term's natural boundary, as determined by the
  provider (the caller does not — and in general cannot — supply the resulting date).
- `DATE`: apply at a caller-specified instant.

A provider adapter MUST reject an `EffectiveIntent` type it cannot honor for the requested
action, via `enforceEffectiveIntent` (§6.7), before any preview or mutating call. It MUST NOT
silently substitute a different intent (e.g. silently treating a rejected `DATE` request as
`IMMEDIATE`).

### 3.2 `ChangeSpec` *(v0.6.1, unchanged)*

```ts
type ChangeSpec =
  | { action: "CHANGE_QUANTITY"; itemId: string; quantity: number }
  | { action: "CHANGE_PLAN"; itemId: string; offeringRef: string }
  | { action: "CHANGE_CADENCE"; cadence: "MONTHLY" | "ANNUAL" }
  | { action: "CANCEL" };
```

No `ChangeSpec` variant carries its own effective-timing field — that concern lives
exclusively on the proposal's `effectiveIntent` (see §9, U-3).

### 3.3 `SubscriptionChangeProposal` *(v0.6.1, unchanged)*

```ts
type SubscriptionChangeProposal = {
  changes: ChangeSpec[];
  effectiveIntent: EffectiveIntent;
  guaranteeMode?: GuaranteeMode;               // default: REVALIDATE
  acceptanceEnvelope?: AcceptanceEnvelope;      // required for REVALIDATE unless all changes are CANCEL
};
```

- `changes` MUST contain at least one entry.
- `changes.length > 1` invokes multi-change consistency rules (§7) and, in v0.6.2, removes
  the single-action context that `NOT_APPLICABLE` licensing requires (§3.10).

### 3.4 `GuaranteeMode` and `GuaranteeCoverage` *(v0.6.1, unchanged)*

```ts
type GuaranteeMode = "EXACT" | "REVALIDATE";

type GuaranteeCoverage = {
  immediateFinancialEffect: "EXACT" | "REVALIDATE";
  recurringFinancialEffect: "EXACT" | "REVALIDATE";
  termEffect: "EXACT" | "UNKNOWN";
  effectiveAt: "EXACT" | "REVALIDATE";
};
```

- `REVALIDATE` is the protocol-wide default when `guaranteeMode` is omitted.
- `EXACT` MUST be capability-scoped: an adapter MUST refuse (not silently downgrade) an
  overall `EXACT` request for any change/action combination where the AUTHORITATIVE coverage
  (§5) does not report `EXACT` on **every** dimension. The refusal error
  (`UNSUPPORTED_CHANGE`) MUST name the specific failing dimension in
  `err.details.failingDimension`.
- `termEffect` has no `REVALIDATE` value, by design: there is no non-mutating way to
  "re-check" a term/contract consequence the way there is for a financial amount. A provider
  that cannot determine term effect deterministically MUST report `UNKNOWN`.

### 3.5 `ActionCapabilities` *(v0.6.1, unchanged)*

```ts
type ActionCapabilities = {
  guaranteeCoverage: GuaranteeCoverage;
  supportedEffectiveIntents: Array<EffectiveIntent["type"]>;
};

type QuoteCapabilities = Partial<Record<ChangeAction, ActionCapabilities>>;
```

### 3.6 `ConsistencyGuarantee` and `MultiChangeConsistency` *(v0.6.1, unchanged)*

```ts
type ConsistencyGuarantee = "ATOMIC" | "BEST_EFFORT";
type MultiChangeConsistency = "ATOMIC" | "BEST_EFFORT" | "UNSUPPORTED";
```

- `ConsistencyGuarantee` describes whether SCQ's own precondition-check-then-mutate sequence
  is provider-backed atomic. **No adapter validated in this research (Stripe, Paddle, Zuora,
  Chargebee — including live Chargebee testing) has ever reported, or may ever report,
  `ATOMIC` for this field.** All four MUST report `BEST_EFFORT`.
- `MultiChangeConsistency` describes whether bundling `changes.length > 1` into one commit
  is atomic, best-effort-sequential, or must be refused outright. It is computed pairwise
  across every pair of changes in a batch, taking the weakest pairwise result (§7).

### 3.7 `SubscriptionChangeQuote` *(v0.6.1, unchanged)*

```ts
type SubscriptionChangeQuote = {
  id: string;
  subscriptionRef: string;
  preconditions: { subscriptionVersion: string };
  proposal: SubscriptionChangeProposal;
  guaranteeMode: GuaranteeMode;
  guaranteeCoverage: GuaranteeCoverage;      // quote-level, authoritative (§5)
  multiChangeConsistency: MultiChangeConsistency;
  commercialEffect: CommercialEffect;
  validUntil: string;
  providerMetadata?: unknown;
};
```

In v0.6.2 the quote's `commercialEffect` carries the determinacy record and provenance of
§3.10–§3.11. A v0.6.2-conforming adapter MUST emit both on every effect it produces.

### 3.8 `CommercialEffect` *(v0.6.2 — defined; v0.6.1 never defined this type normatively)*

```ts
type CommercialEffect = {
  immediate?: { charge?: number; credit?: number; net?: number };
  recurring?: { previousAmount?: number; resultingAmount?: number; currency: string; cadence?: string };
  term?: { createsCommitment?: boolean | "UNKNOWN"; commitmentUntil?: string | "UNKNOWN"; autoRenew?: boolean };
  effectiveAt?: string;
  determinacy?: {
    immediateFinancialEffect: DimensionState;
    recurringFinancialEffect: DimensionState;
  };
  provenance?: {
    immediate?: string;
    recurring?: string;
    committedSource?: CommittedFigureSource;
    applicabilityCitations?: Partial<Record<FinancialDimension, ApplicabilityCitation>>;
  };
};
```

#### 3.8.1 The meaning of `immediate` *(v0.6.2, normative — closes Defect 2)*

`CommercialEffect.immediate` is the net financial obligation **the change itself incurs at
its effective time** — prorations and immediate charges/credits the change generates —
whether or not an invoice has been issued for it, whether or not any amount is presently
due, and whether or not cash has moved.

`immediate` MUST be distinguished from each of the following, none of which may be carried
in `immediate` (or in `recurring`):

- **An invoice total.** An invoiced total may populate `immediate` ONLY insofar as it is
  this same incurred obligation in invoiced form; an invoice total aggregating other charges
  is not `immediate`.
- **An amount presently due.** An amount due is a property of an invoice at a moment in
  time, not of the change.
- **An amount due net of credits.** Credits reduce amounts *due*; they never change
  incurred obligations or prices. A credit-netted figure (e.g. a preview's `amount_due`)
  MUST NOT be mapped into `immediate`.
- **The next-invoice estimate.** Next-invoice facts (next invoice total, its date, its
  amount due after credits, credits applied) describe a future billing event whose line set
  can be incomplete; they are not modeled as effect fields in v0.6.2. They remain in
  `providerMetadata`, surfaced by convention under the key
  `nextInvoiceEstimate: { total, amountDue, creditsApplied, date }` (non-normative
  convention, unchanged from the adapters' existing practice).
- **The post-change recurring amount.** That is `recurring.resultingAmount` (§3.8.2).
- **Cash collected.** Cash collection is not modeled anywhere in SCQ.

An adapter whose provider separates these notions MUST map the incurred-obligation figure
into `immediate`. Where a provider's preview exposes only an amount-due figure and no
incurred figure can be established from authoritative fields or a justified computation,
the adapter MUST report the dimension UNKNOWN (§3.10) rather than substitute the due
figure. (For the one open feasibility question this raises, see §9, U-9 / gap register
G-06 — recorded as an OPEN DECISION, not silently resolved here.)

#### 3.8.2 The meaning of `recurring` *(v0.6.1 definition preserved)*

`recurring` is the underlying subscription price level after the change — never net of
credits. `recurring.resultingAmount` is the post-change price level; for a CANCEL it is a
DETERMINED zero (the price level after cancellation is zero), never a NOT_APPLICABLE
absence (§3.10).

### 3.9 `SubscriptionChangeReceipt` *(v0.6.2 — status widened, outcome added)*

```ts
type ReconciliationResult =
  | { status: "OK" }
  | { status: "VIOLATED"; reason: string }
  | { status: "UNVERIFIED"; reason: string; undeterminedDimensions: string[] };  // v0.6.2 NEW

type SubscriptionChangeReceipt = {
  quoteId: string;
  receiptId?: string;                        // v0.6.2, optional — see §6.16 identity rules
  subscriptionRef: string;
  status: "COMMITTED" | "COMMITTED_UNVERIFIED";   // v0.6.2 widened — see below
  outcome?: MutationOutcome;                  // v0.6.2 NEW — see §3.12
  resultingSnapshot: SubscriptionSnapshot;
  quotedEffect: CommercialEffect;      // immutable historical record from quote time
  committedEffect: CommercialEffect;   // what was actually true at mutation time
  guaranteeMode: GuaranteeMode;
  consistencyGuarantee: ConsistencyGuarantee;
  multiChangeConsistency: MultiChangeConsistency;
  reconciliation: ReconciliationResult;
  committedAt: string;
};
```

- A receipt MUST always carry both `quotedEffect` and `committedEffect`, regardless of
  guarantee mode.
- For `EXACT`: equality between `quotedEffect` and `committedEffect` is defined over the
  **covered, economically relevant effect dimensions** — it is NOT whole-object deep
  equality. For each dimension under the applicable EXACT `GuaranteeCoverage`
  (`immediateFinancialEffect`, `recurringFinancialEffect`, `termEffect`, `effectiveAt`),
  the committed dimension's value, determinacy, and timing/term coverage MUST equal the
  quoted dimension's. `JSON.stringify(quotedEffect) === JSON.stringify(committedEffect)`
  is **not** a conformance criterion. Committed-role provenance
  (`provenance.committedSource`, §3.11) exists only on the committed side: it MAY — and
  where §3.11 applies, MUST — differ from the quoted effect, and per-dimension
  provenance notes on the committed side MAY be refined with post-commit evidence,
  without breaking EXACT equality, provided every covered dimension's value and
  timing/term coverage are unchanged. *(v0.6.2 refinement — SPEC1: v0.6.1 §3.8 stated
  this rule as whole-object deep equality, wording written before role-specific
  committed provenance existed; after §3.11, the two requirements were jointly
  unsatisfiable, because a conforming EXACT committed effect necessarily carries
  committed-side provenance the quote lacks. Delta recorded in Appendix A; the stronger
  question of authenticating the EXACT source remains OPEN — G-01.)*
- For `REVALIDATE`: `quotedEffect` and `committedEffect` MAY legitimately differ; the
  receipt is the audit trail of both, not just the final number.
- A receipt MUST NOT carry any field named `commercialEffect` or `revalidatedEffect`
  (retired v0.2 names — retained only as a negative conformance check, see
  `conformance.md` C-8).
- A receipt MUST always carry a `reconciliation` field, regardless of guarantee mode
  (§6.14). A caller must never need to branch on `guaranteeMode` before reading it.
- A repeated `commitChangeQuote` call against a quote_id that has already been
  successfully committed MUST return the EXACT SAME receipt object/value as the first
  successful commit, and MUST NOT perform a second provider mutation — see §6.10. In
  v0.6.2 this means the **original recorded receipt**: if evidence appended under §6.15
  has since changed the receipt's derived current view, a replaying caller still receives
  the receipt as originally recorded; the current view is exposed only through separate
  store reads, never through replay.
- *(v0.6.2, BREAKING — BC-5/BC-6 companion)* `status` is widened from the single v0.6.1
  literal `"COMMITTED"`. `"COMMITTED"` holds iff the commit's outcome is
  COMMITTED_AND_VERIFIED; `"COMMITTED_UNVERIFIED"` holds iff the outcome is
  COMMITTED_UNVERIFIED (in which case `reconciliation` is the UNVERIFIED variant). The
  widening is deliberate: a consumer matching only `status === "COMMITTED"` must never be
  able to mistake an unverified commit for a verified one. v0.6.1 receipts carry no
  `outcome`; on a v0.6.1 receipt `outcome` reads as COMMITTED_AND_VERIFIED, because its
  status literal could express nothing else.

### 3.10 Financial determinacy *(v0.6.2 NEW — closes Defect 1's type half)*

Every financial dimension of a `CommercialEffect` (`immediateFinancialEffect`,
`recurringFinancialEffect`) is in exactly one of three states:

```ts
type DimensionState = "DETERMINED" | "NOT_APPLICABLE" | "UNKNOWN";
type FinancialDimension = "immediateFinancialEffect" | "recurringFinancialEffect";
```

- **DETERMINED** — a value computed from authoritative provider fields, or from a
  computation the adapter's pricing-model rules justify. A determined value of 0 is a
  *verified zero* and MUST be represented by the field being present with value 0. A
  DETERMINED assertion over an absent, non-numeric, NaN, or infinite value is invalid and
  unenforceable.
- **NOT_APPLICABLE** — the proposal's action set has no such dimension, *by rule of the
  action*. The assertion is valid only when ALL of the following hold:
  1. the dimension's **whole financial field is absent** (`effect.immediate` /
     `effect.recurring` is `undefined`). A field present in ANY shape — a nonzero amount,
     an explicit zero, or a partial shape such as `{ charge }` without `net` —
     contradicts the assertion and makes the dimension unenforceable
     (`INCONSISTENT_NOT_APPLICABLE_VALUE`);
  2. a **licensed action context** exists: the proposal has a single change whose action
     the applicability table licenses for that dimension. The table licenses exactly one
     pair — (CANCEL, immediateFinancialEffect). `recurring` is NEVER NOT_APPLICABLE for
     any action: every supported action leaves a post-change price level (for CANCEL, a
     DETERMINED zero). A multi-change proposal has no single action context, so
     NOT_APPLICABLE cannot be licensed for it at all;
  3. a **valid applicability citation** is recorded in
     `provenance.applicabilityCitations[dimension]`, naming the (action, dimension) pair
     relied upon, with `citation.action` equal to the proposal's authoritative action.
     Agreement between two effects asserting the same NOT_APPLICABLE is not proof of
     applicability; a self-asserted citation without the proposal context validates
     nothing.
- **UNKNOWN** — the dimension applies but its value could not be established from the
  provider's response or a justified computation. An UNKNOWN dimension is not an
  established value in any representation: on quote-side and revalidated effects, and
  in any DETERMINED or NOT_APPLICABLE representation, an UNKNOWN dimension MUST NOT be
  represented by a number. The single bounded exception is the committed-role
  *candidate* defined below. An UNKNOWN dimension MUST NOT be silently omitted where
  omission would be read as NOT_APPLICABLE.

**Candidates (committed role only).** A numerical value recorded on a committed-role
dimension whose determinacy is UNKNOWN is a **candidate**, not an established actual;
the two terms are not interchangeable anywhere in this specification. A candidate MAY
be recorded ONLY when ALL of the following hold: (a) the effect is the committed effect
of a `COMMITTED_UNVERIFIED` receipt (§3.12); (b) the dimension's determinacy is UNKNOWN
and the effect's provenance carries `committedSource: "unestablished"` (§3.11), with
the dimension's provenance note disclosing the candidate's source; and (c) the receipt's
reconciliation is UNVERIFIED, naming the dimension in `undeterminedDimensions`. The
candidate's source is data already in hand at recording time, and is one of exactly
two: the mutating call's own response, or — for cancellation constructions — the
quote's post-cancellation level as recorded in the stored quote. No other source is
permitted: in particular, a candidate is never derived from a further provider read
performed after the mutation landed, and never copied from a pre-mutation estimate or
preview as if it were a committed figure. A candidate is recorded deliberately, so
that a later independent verification has the ORIGINAL figures to verify against: the
candidate is part of the recorded receipt's canonical identity (§6.16) — the recorded
candidate figures themselves are identity elements — and MUST NOT be silently replaced,
recomputed, or dropped. A candidate is NOT compliance evidence: no envelope assessment
(§6.13) and no reconciliation (§6.14) may treat it as DETERMINED or established, and it
can never by itself produce reconciliation OK or a verified promotion. What establishes
the dimension later is the §6.15 evidence procedure — independent post-commit evidence
that establishes the dimension's actual on its own. **A candidate is a claim to be
judged, not an identity element to be matched** (A-17-1): evidence whose independently
established actuals DIFFER from the recorded candidates MUST NOT be refused on that
ground and MUST NOT be reported as a receipt-identity conflict; the differing actual is
recorded in the append-only evidence record, the derived view displays it, and the
reconciliation — computed against the original quoted effect and envelope, never
against the candidate — judges it (an out-of-envelope established actual is
verified-with-violation, §6.15). A receipt-identity conflict
(`CONFLICTING_RECEIPT_IDENTITY`) arises only when presented material names a different
recorded identity: a different receipt, a different quote or subscription binding, or a
record whose identity digest does not match its recorded contents. The recorded receipt
is never rewritten by later evidence.
Consumers MUST NOT present a candidate as a verified, reconciled, or charged amount.
Outside this carve-out the rule remains categorical, and §6.13 enforcement is
unchanged: a number under UNKNOWN determinacy on a quote-side or revalidated effect
establishes nothing and rescues nothing — the fail-closed gate refuses on the
dimension's state, not on its digits. Candidates are permitted, never required: an
implementation MAY instead leave an unestablished committed dimension's figure absent.

**Purity.** The three states are mutually exclusive and exhaustive for every financial
dimension. No implicit conversion between states is permitted, in either direction, at any
layer (adapter, aggregation, engine, receipt): NOT_APPLICABLE MUST NOT be read, summed, or
serialized as 0; UNKNOWN MUST NOT be read as 0 or as NOT_APPLICABLE; a DETERMINED 0 MUST
NOT be reclassified as NOT_APPLICABLE or UNKNOWN. A dimension's state changes only through
an explicit adapter assertion carrying provenance. In particular, the *presence of a
number* is not an assertion of DETERMINED, and the *absence of a number* is not an
assertion of NOT_APPLICABLE. Any code path that needs a number and finds a non-DETERMINED
state MUST stop (fail closed), never coerce.

**Legacy reading.** An effect that carries no determinacy record — including every
v0.6.1-produced effect — reads **UNKNOWN in every dimension** for every enforcement and
reconciliation purpose (`determinacyOf`). Absence of metadata is not evidence of
determinacy, and legacy payloads are explicitly NOT grandfathered as DETERMINED (see §8,
BC-2). An adapter MAY attach determinacy to a legacy payload only by re-deriving it from
provider evidence under this section's rules; determinacy MUST NEVER be inferred from the
mere presence of a number, from the payload's age, or from the adapter that produced it.

**Finding order.** Where several defects afflict one NOT_APPLICABLE assertion, conformance
tooling reports them in this order: (0) field-absence purity, (1) action context,
(2) applicability license, (3) citation. The order is observable in the reference
implementation's findings and is pinned by tests; it changes no verdict — an assertion
failing any step is unenforceable.

**Snapshot determinacy.** `SubscriptionSnapshot.billing.recurringAmount` gains an optional
companion, `recurringAmountState?: DimensionState`, recording whether the figure is a
determined value or the product of a fallback computation whose result is not established.
Absent on a legacy snapshot, the figure reads UNKNOWN under the same legacy reading. A
snapshot figure MUST NOT be used as enforcement input beyond its stated determinacy.

### 3.11 Committed-figure provenance *(v0.6.2 NEW)*

Every effect carries a `provenance` record. For committed effects, `committedSource` states
what the committed figures ARE:

```ts
type CommittedFigureSource =
  | "provider_actual"        // derived from provider state/actuals read after — or returned by — the mutating call
  | "defined_equal_exact"    // EXACT mode: committed := quoted BY PROTOCOL DEFINITION
  | "revalidated_preview"    // a pre-mutation re-preview — quote-side data
  | "pre_mutation_estimate"  // a pre-mutation estimate — quote-side data
  | "unestablished";         // no source could be established (also the reading when absent)
```

- Only `provider_actual` and `defined_equal_exact` can **establish** committed financial
  facts. A revalidated preview and a pre-mutation estimate are quote-side data: they belong
  to pre-mutation enforcement (§6.13) and MUST NOT be promoted into a committed effect as
  its establishing source. Figures byte-identical to the quote but sourced from a preview
  reconcile UNVERIFIED, never OK (§6.14).
- `defined_equal_exact` establishes ONLY where the applicable EXACT contract justifies it:
  EXACT mode, with the dimension's determinacy established. An EXACT-shaped assertion
  without establishing evidence does not verify. **The label excuses ABSENT unit
  statements only, never CONTRADICTING ones** (§3.16, P16-3): a committed effect labelled
  `defined_equal_exact` that explicitly states a currency or cadence contradicting the
  quote's is judged on the contradiction (VIOLATED), on every reconciliation path
  including the no-envelope path; a label never overrides contradictory observed units
  or actuals.
- `unestablished` is the committed-role source of every dimension that could not be
  established. Where such a dimension carries a number on a COMMITTED_UNVERIFIED
  receipt, that number is a **candidate** under §3.10's carve-out — recorded, labeled,
  and identity-bearing, but establishing nothing.
- **A provenance label is not authentication.** A `committedSource` value is an
  adapter-recorded classification; neither the core nor the store treats the string itself
  as proof that a provider event occurred. Adapters remain responsible for binding figures
  to operation-bound provider reads; the store's verification-evidence branding (§6.15) is
  the boundary that keeps self-asserted material from becoming verification evidence.
  > OPEN DECISION (gap register G-01): the core cannot authenticate the contract behind a
  > `defined_equal_exact` label — an adapter asserting it with determinacy established is
  > taken at its classification. Whether v0.6.2 should require stronger evidence for this
  > source is a decision for the approval review, not resolved by this candidate.
- Quote-side effects carry per-dimension provenance notes (`provenance.immediate` /
  `provenance.recurring`): free-form audit strings naming the provider fields or
  computation backing each figure. Under BC-1 enforcement (§6.13), a quote-side DETERMINED
  dimension requires its note; `committedSource` is meaningless on a quote-side effect and
  is ignored there.

### 3.12 Mutation-outcome taxonomy *(v0.6.2 NEW — closes Defect 3's classification half)*

Every commit attempt resolves to exactly one outcome class:

```ts
type MutationOutcome =
  | "COMMITTED_AND_VERIFIED"   // landed; state verified against intent; actuals reconciled
  | "COMMITTED_UNVERIFIED"     // landed (landing established); finances/state not fully verified
  | "INDETERMINATE"            // dispatched; landing/outcome not established
  | "CONFIRMED_NON_EXECUTION"; // provably never dispatched, or provably rejected pre-effect
```

- Receipts are recorded ONLY for the two `COMMITTED_*` classes. The two no-receipt classes
  surface in the thrown error's `details.outcome` and in the store's per-quote outcome
  record.
- **CONFIRMED_NON_EXECUTION** — the mutation provably never took effect: it was never
  dispatched (e.g. a fail-closed `QUOTE_NOT_DETERMINISTIC` refusal, which by construction
  precedes any mutating call and creates no mutation intent), or the provider provably
  rejected it before any effect. Recovery: no provider-state reconciliation is required
  first. For an attempt recorded in the durable ledger, exactly **one re-dispatch under
  the same quote and the same idempotency key** is permitted per
  CONFIRMED_NON_EXECUTION settlement, gated as §6.16 specifies (identical canonical
  request and request hash; unchanged quote/subscription/provider/site binding;
  same-subscription exclusion re-checked inside the authorizing transaction; and the
  ordinary commit preconditions — expiry and subscription-fingerprint validation,
  §6.2/§6.10 — applied to the re-dispatch presentation exactly as to a first dispatch,
  so an expired or stale quote can never reach the re-dispatch gate). A caller MAY
  instead abandon the quote and start a new one; what is prohibited is presenting a
  different request or a different key as the same attempt, and any re-dispatch beyond
  the one a settlement permits (a further re-dispatch requires a further independent
  CONFIRMED_NON_EXECUTION settlement). An adapter MUST NOT report
  CONFIRMED_NON_EXECUTION for a mutation it dispatched unless the provider's rejection is
  demonstrably pre-effect under the adapter's documented classification rule.
  *(Doctrine recorded as OPEN DECISION G-13 / U-13 for ratification at approval: the
  alternative — requiring a fresh quote and key for every retry — is named there with
  its tradeoff.)*
- **INDETERMINATE** — the mutation was dispatched and its outcome cannot be established:
  response lost, landing unverifiable, post-commit read incomplete or contradictory.
  Receipt: **no success receipt** — silence in the receipt log must never be readable as
  "nothing happened." Recovery: **no blind retry** (a retry can double-apply the change);
  provider-state reconciliation FIRST (§6.15), before any further mutation on that
  subscription. If the landing is later established but its finances remain unverifiable,
  the outcome is reclassified COMMITTED_UNVERIFIED with an UNVERIFIED receipt; the
  original indeterminate record stays in the audit trail.
- **COMMITTED_UNVERIFIED** — the landing is established (by operation-bound evidence,
  §6.15), but at least one financial dimension or the state verification could not be
  established. The receipt's committed effect records, per dimension: the established
  actual, where one was established (a dimension can be fully established while the
  receipt is unverified for another dimension, or for attribution/state reasons); a
  labeled **candidate**, where the implementation recorded one under §3.10's carve-out
  (UNKNOWN determinacy, `committedSource: "unestablished"`, source disclosed in the
  dimension's provenance note); and no figure, where neither exists. Every
  unestablished dimension reads UNKNOWN and is named in the reconciliation's
  `undeterminedDimensions`. Such a receipt MUST NOT be reported as, or aggregated with,
  OK, and a candidate on it MUST NOT be presented as a verified or charged amount.
- **COMMITTED_AND_VERIFIED** — the landing is established, the intended state is verified
  (§6.12), and the committed actuals reconcile OK or VIOLATED over established figures
  (a verified-with-violation commit is COMMITTED_AND_VERIFIED with reconciliation
  VIOLATED — "verified" means *measured*, not *within tolerance*). The outcome asserts
  exactly those three things — landing, target state, finances. It makes **no
  authorization-preservation claim**: it does not assert that state outside the
  authorized target was preserved, and target-state equality is not preservation
  evidence (§6.12, §6.17). Where a dispatch mechanism cannot support a preservation
  claim for OPERATION-authorized changes, the commit refuses pre-dispatch instead of
  letting the outcome be misread as covering preservation (§6.17).

Conflating INDETERMINATE with CONFIRMED_NON_EXECUTION is a normative violation: under
v0.6.1 both surfaced as "an error, no receipt," and a caller retrying an INDETERMINATE
outcome as casually as a CONFIRMED_NON_EXECUTION can mutate a subscription twice. The
retry decision is a property of the outcome class, not of caller intuition (BC-6).

### 3.13 Post-commit state verification types *(v0.6.2 NEW)*

```ts
type StateVerificationVerdict = "VERIFIED" | "MISMATCH" | "UNVERIFIABLE";
type StateVerificationCoverage = "FULL_ITEM_SET" | "ACTION_LEVEL";

type PostCommitStateVerification = {
  verdict: StateVerificationVerdict;
  coverage: StateVerificationCoverage;
  checks: StateVerificationCheck[];          // every check performed, with its outcome
  verifiedDimensions: string[];
  contradictions: string[];                  // present iff verdict is MISMATCH
  unverifiableDimensions: string[];
  stateObserved: boolean;
  executionEstablished: false;               // constant — see §6.12
  stateAttributableToThisOperation: false;   // constant — see §6.12
  financialOutcomeEstablished: false;        // constant — see §6.12
  provenance: { source: string; observedAt?: string };
  limitations: string[];
};
```

The normative semantics are §6.12. The three constant-false fields are part of the type so
that the boundary between *state observed* and *execution/attribution/finances established*
is structural, not merely documented.

The expectation side (`PostCommitStateExpectation`) carries an optional
`expectedSubscriptionRef` (v0.6.2, PR #26): when present, the hook performs the
`state:subscriptionIdentity` check — the observed snapshot MUST name that subscription,
and a snapshot naming a different subscription, carrying no id, or absent where the check
applies makes the identity dimension unverifiable/contradicted per §6.19, never verified.
The field is OPTIONAL in this version: whether it becomes a required expectation field in
a future major version is an OPEN DECISION (gap register G-16, A-16 carry-forward).

### 3.14 Error codes *(v0.6.1, one addition)*

```ts
type SCQErrorCode =
  | "SUBSCRIPTION_NOT_FOUND"
  | "UNSUPPORTED_CHANGE"
  | "UNSUPPORTED_CHANGE_SET"
  | "INVALID_PROPOSAL"
  | "QUOTE_NOT_DETERMINISTIC"
  | "QUOTE_EXPIRED"
  | "QUOTE_STALE"
  | "CHANGE_CONFLICT"
  | "PROVIDER_ERROR"
  | "QUOTE_DRIFTED"
  | "CONFLICTING_RECEIPT_IDENTITY"   // v0.6.2 NEW — receipt-identity conflicts (§6.16)
  | "AUTHORIZATION_PRESERVATION_UNENFORCEABLE";  // v0.6.2 NEW — §6.17 (PR #24)
```

### 3.15 Authorization scope and mutation capability *(v0.6.2 NEW — PR #24)*

```ts
type AuthorizationScope = "OPERATION" | "TARGET_REPLACEMENT";
type MutationCapability = "CONDITIONAL_WRITE" | "TARGETED_UPDATE" | "FULL_REPLACEMENT_ONLY";
```

- `authorizationScope` states the breadth of mutation the caller authorized. **OPERATION**
  (the default — an absent scope reads as OPERATION, and a `null` scope likewise reads as
  absent) authorizes exactly the proposed operation: state outside the operation's target
  is not authorized to change. **TARGET_REPLACEMENT** authorizes replacement of the
  subscription's full target state. TARGET_REPLACEMENT is a *recognized* declaration that
  no adapter in this version implements: it MUST be refused at quote creation with
  `UNSUPPORTED_CHANGE` — never silently accepted, downgraded to OPERATION, or executed.
  Its semantics (consent, migration, receipt claims) are an OPEN DECISION for a future
  revision (gap register G-14).
- `mutationCapability` states what the adapter's dispatch mechanism can enforce. It is
  **declared by the adapter, never by the caller and never read from caller-controlled
  state**: in the reference implementation the Chargebee-live declaration is a
  module-private constant (`FULL_REPLACEMENT_ONLY` — its sole update dispatch is
  `update_for_items` with `replace_items_list=true`) exposed through a getter, so runtime
  assignment or `Object.defineProperty` on an instance cannot falsify it. A quote records
  the scope and the adapter's declared capability; at commit, a recorded capability that
  differs from the adapter's declaration, or an unknown recorded capability value,
  refuses at the preservation gate (unknown classifies as FULL_REPLACEMENT_ONLY).
- The preservation rule itself is §6.17: an OPERATION-authorized commit through a
  FULL_REPLACEMENT_ONLY mechanism MUST refuse pre-dispatch.

### 3.16 Units of comparison: currency and cadence *(v0.6.2 NEW — PR #26)*

A financial figure is denominated: a recurring amount carries a `currency` and may carry
a `cadence` (`CommercialEffect.recurring`); comparison contexts may additionally thread
billing currency/cadence per side (`ComparisonUnitContext`). Comparability of units is a
**per-dimension precondition** of numeric comparison (§6.19), not a post-hoc annotation:

- An *established contradiction* (both sides' currency established and different, or both
  sides' cadence established and different — compared case-insensitively) is itself
  established evidence: the dimension classifies VIOLATED on the contradiction.
- A *participating currency that cannot be established* on a side makes the dimension's
  numeric evidence unusable: the dimension classifies UNVERIFIED (pre-dispatch, the gate
  refuses with a truthful unestablishable-units reason — never a proven-drift claim).
  Masked numeric differences on such a dimension are not violations; an independently
  established violation on another dimension still classifies VIOLATED.
- Cadence stated on one side only is not decidable from the record and does not block
  (the schema makes cadence optional — test49.14 pins this reading; see the A-16-3
  carry-forward in gap register G-16).
- `CommercialEffect.immediate` has **no currency field** in this version. The immediate
  dimension's currency is therefore sourced from the same inputs as the recurring
  dimension's (threaded billing context, then the side's recurring currency), so
  currency-unestablishability is currently *correlated* across dimensions. The schema
  extension that would give `immediate` its own currency (A-16-3) is an OPEN DECISION
  (gap register G-16) and is NOT made by this candidate.

---

## 4. Guarantee Semantics

### 4.1 EXACT — scope narrowed *(v0.6.1, unchanged)*

`EXACT` on a given `GuaranteeCoverage` dimension guarantees ONLY that specific named
dimension (`immediateFinancialEffect`, `recurringFinancialEffect`, `termEffect`, or
`effectiveAt`) is reproduced exactly between quote and commit. It is emphatically NOT a
guarantee that the quote's `CommercialEffect` is a complete accounting of every
consequence of the change, and it makes NO claim whatsoever about any dimension
`CommercialEffect` does not model as a field — most importantly **tax, discounts,
currency-conversion effects, or any other commercial adjustment applied by the provider as
a step separate from the pinned computation**.

Mechanically, an adapter achieves this either by pinning a wall-clock-dependent
computation basis at quote time and replaying it verbatim at commit time, or by having
order/estimate math that is inherently a pure function of an explicit, caller-supplied
instant rather than ambient "now."

EXACT MUST be requested and enforced per the full `GuaranteeCoverage` (all four
dimensions), not per financial dimension alone.

*(v0.6.2 note)* In EXACT mode the committed effect is established by definition
(`defined_equal_exact`, §3.11) — committed := quoted — **only** where the quote-level
coverage backs EXACT on every dimension and the commit actually dispatched under that
contract. The authentication limit of that definitional source is recorded in §3.11 and
gap register G-01. "Committed := quoted" is the per-dimension reproduction this section
has always scoped — the equality §3.9 defines over the covered dimensions. v0.6.1
§3.8's whole-object deep-equality sentence does **not** carry forward: it predates
role-specific committed provenance and is unsatisfiable alongside §3.11 (SPEC1,
Appendix A).

### 4.2 REVALIDATE (default) *(v0.6.1 clarifications preserved; v0.6.2 enforcement added)*

The commit re-derives the commercial effect against live state and MUST refuse (with
`QUOTE_DRIFTED`, and **no mutation**) if the re-derived effect falls outside the caller's
supplied `AcceptanceEnvelope`. REVALIDATE is the ONLY mechanism available for actions
where no EXACT-backing mechanism exists.

- **When the envelope check runs** *(v0.6.1)*: the `AcceptanceEnvelope` is enforced
  against the LAST PRE-MUTATION PREVIEW — the freshest non-mutating re-computation the
  adapter can obtain immediately before the mutating call — NOT the original quote-time
  computation and not some later, already-mutated state.
- **What the pre-mutation check does NOT cover** *(v0.6.1)*: because
  `ConsistencyGuarantee` is `BEST_EFFORT` for every provider validated in this research
  (§3.6), SCQ CANNOT guarantee that a concurrent write does not land in the window
  between the last pre-mutation preview and the mutating call itself, and therefore
  cannot guarantee the envelope check performed before mutation still describes what is
  actually true immediately after mutation. Post-commit reconciliation (§6.14) is the
  required mitigation: it reports; it does not undo.
- **Fail-closed determinacy** *(v0.6.2 NEW)*: before the envelope comparison runs — at
  quote revalidation and at post-commit reconciliation — every dimension is assessed
  under §3.10/§3.11, and its units are assessed under §3.16/§6.19: numeric comparison
  runs only where unit comparability is established, an established unit contradiction
  is itself a violation, and an unestablishable participating currency yields UNVERIFIED
  rather than a numeric verdict. An unenforceable dimension (UNKNOWN on either side, an invalid
  DETERMINED value, an unjustified or internally inconsistent NOT_APPLICABLE, or — for
  the committed side — figures without an establishing source) **refuses the commit
  pre-mutation** with `QUOTE_NOT_DETERMINISTIC`, and **reports UNVERIFIED post-commit**
  (§6.13/§6.14). The numeric comparison runs only over dimensions both sides establish
  as DETERMINED; a justified NOT_APPLICABLE dimension is *skipped*, never compared as
  zero. Envelope bounds the caller omits keep their v0.6.1 meaning (zero tolerance):
  fail-closed governs the values compared, not the caller's tolerances.
- A REVALIDATE proposal MUST supply an `AcceptanceEnvelope` unless every change in the
  proposal is `CANCEL`. Omitting the envelope in any other case MUST be refused with
  `INVALID_PROPOSAL`, not silently defaulted to an unbounded envelope. The no-envelope
  case's reconciliation semantics are stated in §6.14.

### 4.3 Quote-level vs. provider-level coverage *(v0.6.1, unchanged)*

`getCapabilities().quoteCapabilities` is coarse and general — "what MIGHT this provider do
for this action, in general." `quote.guaranteeCoverage` is state-aware and authoritative —
"what CAN this specific quote, against this specific subscription's actual state,
guarantee." The two values MAY legitimately diverge. The enforcement gate
(`enforceGuaranteeRequest`) checks ONLY the quote-level value.

An adapter MUST NOT let its coarse provider-level report ever advertise a stronger
guarantee than any individual quote could actually deliver (coarse coverage is always the
*floor*, never optimistic).

---

## 5. Authoritative Coverage Resolution *(v0.6.1, unchanged)*

"Before any provider call" in this specification means *before any call that PREVIEWS or
MUTATES the proposed change*. It does NOT mean before the one non-mutating READ of the
subscription's current state that `createChangeQuote` always performs first, because that
read is what makes the state-aware override in step 2 possible.

For every `createChangeQuote` call, an adapter MUST:

1. Perform ONE non-mutating read of the subscription's current state.
2. Compute per-change `ActionCapabilities` for each entry in `changes[]`, and apply any
   subscription-state-specific override the adapter defines — using ONLY the state read in
   step 1, no further reads yet.
3. Validate `proposal.effectiveIntent.type` against each change's
   `supportedEffectiveIntents` (§6.7) — before any preview or mutating call.
4. Combine per-change `GuaranteeCoverage` values into one quote-level value via
   `computeCombinedCoverage` (weakest-per-dimension across the batch), reflecting any
   override from step 2.
5. Enforce the requested `guaranteeMode` against the resulting quote-level coverage
   (`enforceGuaranteeRequest`), refusing with `UNSUPPORTED_CHANGE` (naming the failing
   dimension) if EXACT was requested but not fully backed — before any preview or
   mutating call.

---

## 6. Normative Rules (MUST / MUST NOT)

Rules 6.1–6.11 are carried from v0.6.1; 6.11 is extended in place by §6.14's precedence
rules. Rules 6.12–6.16 are new in v0.6.2.

**6.1 (v0.1)** `getSubscription` and `createChangeQuote` MUST NOT mutate provider state.

**6.2 (v0.2)** `commitChangeQuote` MUST validate the subscription's current
version/fingerprint against the quote's captured precondition before performing any
mutating call, and MUST refuse with `QUOTE_STALE` (no mutation) if it has changed.
*(v0.6.2 clarification — PR #23 recommendation 4):* the precondition is evaluated
against the last pre-dispatch read; it does not by itself bind the dispatch, which is
bound only where the provider enforces a conditional write (§3.15 capability
declaration). Where no conditional write exists, §6.3's BEST_EFFORT honesty governs the
window between this check and the mutating call.

**6.3 (v0.2)** No adapter MAY use an adapter-local lock, mutex, or semaphore to simulate
atomic state-precondition-then-mutation. The TOCTOU race window between validation and
the mutating call MUST be left genuinely present if the underlying provider API has no
server-side compare-and-swap precondition — SCQ's job is to report `BEST_EFFORT`
honestly, not to hide the race with client-side synchronization.

**6.4 (v0.3, per-dimension)** An overall `EXACT` request MUST be refused, before any
preview or mutating call, for any change/action where the AUTHORITATIVE (quote-level)
`GuaranteeCoverage` does not report `EXACT` on every one of its four dimensions. The
refusal MUST identify the specific failing dimension.

**6.5 (v0.3)** `getCapabilities()` MUST NOT advertise a guarantee that actual enforcement
would refuse for a request built directly from that advertisement.

**6.6 (v0.3)** Every `SubscriptionChangeReceipt` MUST carry `guaranteeMode` and
`consistencyGuarantee`; neither may be omitted regardless of guarantee mode taken. In
v0.6.2 a receipt additionally MUST carry `reconciliation` (§6.14) and, where the store
records one, its outcome classification (§3.12).

**6.7 (v0.6 — EffectiveIntent enforcement)** An adapter MUST validate
`proposal.effectiveIntent.type` against each targeted change's
`supportedEffectiveIntents` before any preview or mutating call, and MUST refuse with
`UNSUPPORTED_CHANGE` (not silently substitute a different intent) if unsupported.

**6.8 (v0.6 — no silent partial execution)** If an adapter accepts a multi-change proposal
(`changes.length > 1`), it MUST NOT submit that proposal to the underlying provider API
if doing so risks the provider silently applying only a SUBSET of the requested changes
while still returning success. Where this risk exists, the adapter MUST refuse with
`UNSUPPORTED_CHANGE_SET` **before any mutating call**.

**6.9 (v0.6)** The Chargebee committed-term `CANCEL` case MUST report
`guaranteeCoverage.termEffect: "UNKNOWN"`, not `"EXACT"`.

**6.10 (v0.6.1 — quote expiration and commit idempotency)** Two related rules:

- **Expiration:** a `commitChangeQuote` call attempted after `validUntil` has passed MUST
  fail with `QUOTE_EXPIRED`, and MUST NOT perform any provider mutation. Expiration
  applies ONLY to a commit ATTEMPT on a quote that was NEVER successfully committed. A
  quote that committed successfully before its `validUntil` passed remains validly
  committed forever after.
- **Idempotency:** a repeated `commitChangeQuote` call against a `quoteId` that has
  ALREADY been successfully committed MUST NOT apply the change a second time, and MUST
  return the ORIGINAL receipt from the first successful commit — not a re-derived,
  re-fetched, or newly-timestamped one. This check MUST be performed BEFORE any read of
  live provider state or any mutating call. Idempotent replay MUST succeed even if (a)
  the subscription has since drifted further out-of-band, or (b) the quote's
  `validUntil` has since passed. In v0.6.2, "the original receipt" means the receipt **as
  recorded at commit time** (§3.9), even if a later verification transition (§6.15) has
  superseded its state in the store's current view.

**Conformance note on 6.10 (v0.6.1 errata ER-4, carried; v0.6.2 position in §6.16):** the
idempotency rule presumes the implementation can retrieve the original receipt on a
repeated commit, including after a process restart and after an indeterminate commit
outcome. A conforming live deployment therefore requires durable persistence (§6.16).
The in-memory `QuoteStore` does NOT establish this guarantee across crashes: after a
restart it can only fail closed, which is safe but is not conformance with the replay
requirement. Provider-native idempotency is not a substitute and is not indefinite
(Chargebee's documented native idempotency window is 30 minutes).

**6.11 (v0.6.1 — post-commit reconciliation)** Every REVALIDATE commit MUST re-check
`committedEffect` against the proposal's `acceptanceEnvelope` (using the SAME envelope
the pre-mutation check used) immediately after the mutating call returns, and MUST
surface the result via the receipt's `reconciliation` field. A `"VIOLATED"`
reconciliation result is a REPORTING obligation, not a re-authorization gate. EXACT
commits and REVALIDATE commits with no applicable envelope (CANCEL-only) report per
§6.14 rather than omitting the field or fabricating a violation with no basis.

**6.12 (v0.6.2 NEW — post-commit state verification)** Before a verified receipt is
recorded, and whenever a COMMITTED_UNVERIFIED receipt is to be upgraded (§6.15), the
committed STATE MUST be verified against the quoted INTENT by the provider-neutral
contract `verifyPostCommitState(expectation, observation)`:

- The expectation side is the stored quote's authorized proposal, plus — where full
  item-set verification is claimed — the expected RESULTING item set derived from the
  authorized quote/dispatched request. The expectation MUST NOT be derived from the
  post-mutation state. An authorized term boundary used to align a TERM_END cancellation
  (`termBoundaryAt`) likewise comes from the expectation side, never from the observed
  snapshot — a boundary read out of the observed state would be the state proving
  itself.
- The observation side is a post-commit provider read, normalized by the adapter.
  Binding the observation to a REAL provider read — and, where attribution matters, to
  the operation — is the adapter's duty; the hook computes over what it is given and
  cannot prove provenance.
- **Verdicts:** VERIFIED (every required check passed), MISMATCH (at least one
  established contradiction), UNVERIFIABLE (no contradiction, but at least one required
  check could not be performed). Precedence: an established contradiction yields
  MISMATCH even when other checks are unverifiable; otherwise any unverifiable required
  check yields UNVERIFIABLE; VERIFIED is reachable only when every required check
  passed.
- **Coverage is reported, never implied.** With an expected resulting item set, coverage
  is FULL_ITEM_SET: expected vs. observed are compared as MULTISETS of complete item
  TUPLES — (identifier, quantity, and offering where the expectation states offerings) —
  never as independent quantity and offering lists. Without it, coverage is
  ACTION_LEVEL (per-change checks against the targeted items/dimensions only), and the
  result MUST state in its limitations that state outside the targeted items was not
  examined.
- **Partial and malformed observations.** An OMITTED item collection is UNVERIFIABLE,
  never an empty set; a present EMPTY collection against a nonempty expectation is a
  MISMATCH. In a PARTIAL collection (`itemsComplete: false`): contradictions established
  by PRESENT entries stand; absence-based contradictions are NOT established; the
  item-set dimension is at best UNVERIFIABLE; and a present, agreeing target cannot be
  VERIFIED (the unreturned portion could contain a conflicting duplicate). Malformed
  (null/non-object) entries never abort the computation: unidentifiable entries block
  absence-based judgments and VERIFIED for affected targets; contradictions established
  by identified present entries stand. At ACTION_LEVEL, ALL entries for a target are
  judged: a disagreeing duplicate is a MISMATCH; a target entry lacking the dimension
  under check is UNVERIFIABLE for that check.
- **Scheduled cancellation timing.** "Terminal now" is not "cancelled at the authorized
  time."
  - A terminal state verifies an IMMEDIATE intent. A non-terminal state contradicts an
    IMMEDIATE intent; an established TERM_END schedule does not rescue it.
  - A TERM_END intent verifies from provider schedule-KIND evidence, or from an
    independently established instant EQUAL to the authorized term boundary. DATE
    verifies ONLY from an independently established instant equal to the intended date
    AND no contradictory schedule kind: kind evidence alone attests the schedule TYPE,
    not the effective instant, so kind-only DATE evidence is UNVERIFIABLE. An equal
    instant paired with a contradictory kind is UNVERIFIABLE (the evidence is
    inconsistent about which schedule the termination belongs to — an ambiguity, not an
    established contradiction of the effective time); this classification applies
    symmetrically to TERM_END.
  - The READ TIME is tested first for a terminal state under a scheduled intent: a
    subscription already terminal when read BEFORE the authorized instant is a
    premature termination — MISMATCH — whatever the schedule claims. An established
    cancellation instant earlier than the authorized boundary/date is likewise a
    premature termination (MISMATCH). With neither a readable read time nor an
    established instant, a bare terminal status cannot distinguish premature from
    compliant and is UNVERIFIABLE. A schedule is never invented.
- **Independence of state and financial evidence.** The result answers exactly one
  question — is the intended state observed? Its `executionEstablished`,
  `stateAttributableToThisOperation`, and `financialOutcomeEstablished` fields are
  constant false BY CONSTRUCTION. Therefore:
  - a VERIFIED state NEVER upgrades a lost-response INDETERMINATE outcome: a matching
    state is observationally identical to another actor's identical change;
  - a VERIFIED state does not establish any financial figure;
  - a state MISMATCH is never, by itself, a financial VIOLATED — that translation
    requires independently attributable financial evidence, which is the establishing
    adapter's burden.
- The hook's result is a VALUE, not evidence: it carries no brand, and the store's
  verification procedure (§6.15) MUST refuse it exactly as it refuses any unbranded,
  caller-asserted verdict.
- **Identity binding (§6.19).** Where the expectation carries `expectedSubscriptionRef`,
  the hook's `state:subscriptionIdentity` check MUST be performed: an observed snapshot
  naming a different subscription is a contradiction of the identity dimension; a
  snapshot carrying no id, or no snapshot where the check applies, leaves the identity
  unverifiable. State read from a different subscription is not evidence about this
  quote's subscription, on any path.
- **Preservation is not verified here.** A VERIFIED verdict — including a FULL_ITEM_SET
  verdict — is target-state conformance against the authorized expectation. It is NOT
  evidence that state outside the authorized target was preserved, and MUST NOT be
  presented as such: where the commit mechanism enumerates the full target state
  (full-list replacement), the verdict says nothing about whether out-of-scope state
  survived, because the mechanism replaced the list wholesale (§6.17 states what each
  dispatch class can claim).

**6.13 (v0.6.2 NEW — fail-closed envelope enforcement; BC-1)** `checkAcceptanceEnvelope`
(pre-mutation) and `reconcileCommittedEffect` (post-commit) share ONE per-dimension,
per-side assessment (`assessEnvelopePair`), so the gate and the reconciliation can never
develop parallel interpretations of §3.10/§3.11. The report-only diagnostic
`auditDeterminacy` applies the same rules and changes no verdict.

- A dimension is **comparable** iff both sides are DETERMINED with finite values and
  role-appropriate provenance: quote-role sides require the dimension's provenance note;
  the committed role additionally requires an establishing `committedSource`
  (`provider_actual` or `defined_equal_exact`). Comparability of *figures* is necessary
  but not sufficient for numeric comparison: the dimension's **units** must also satisfy
  §6.19 — an established unit contradiction classifies the dimension VIOLATED on the
  contradiction itself (pre-mutation, the gate's refusal reason names the failed unit
  precondition rather than a numeric drift), and an unestablishable participating
  currency makes the dimension unenforceable for numeric purposes (pre-mutation refusal
  with an unestablishable-units reason; post-commit UNVERIFIED).
- A dimension is **skipped** iff both sides assert a justified NOT_APPLICABLE (§3.10).
  A skipped dimension is never compared as zero.
- Anything else is **unenforceable**: UNKNOWN on either side (legacy payloads included),
  an invalid DETERMINED value, a missing or non-establishing provenance, an unjustified
  or one-sided NOT_APPLICABLE, or a NOT_APPLICABLE asserted over a present financial
  field.
- **Pre-mutation:** if any dimension is unenforceable, enforcement MUST throw
  `QUOTE_NOT_DETERMINISTIC` **before any mutating call**, with
  `details.outcome = "CONFIRMED_NON_EXECUTION"` and per-dimension findings. The refusal
  creates NO mutation intent: on the durable path it precedes dispatch authorization,
  leaves no unresolved attempt, and retries nothing. Recorded-receipt replay (§6.10)
  performs NO revalidation and is unaffected.
- **Adapter-local gates:** adapters MAY keep earlier, adapter-specific determinacy
  refusals ahead of the core gate; the core gate is the protocol-level backstop at every
  envelope/reconciliation call site. A local gate MUST NOT be weaker than the core gate
  for effects the adapter itself produces.
- **EXACT/REVALIDATE interaction:** the assessment is mode-independent. In EXACT mode the
  committed side is established definitionally (§3.11) and the same comparable/skipped
  logic applies — EXACT equality is the §3.9 covered-dimensions equality evaluated
  through this assessment, never whole-object identity, so the committed side's
  additional provenance (§3.11) is expected and is not a divergence; in REVALIDATE mode
  the revalidated side is assessed in the quote role (its `revalidated_preview` label
  is lineage metadata, not a claim of actuals).

**6.14 (v0.6.2 NEW — committed evidence and reconciliation precedence)** Post-commit,
`reconcileCommittedEffect` NEVER throws a pre-mutation refusal — the mutation has already
landed, so an unenforceable dimension is reported, not refused. The verdict is:

1. **VIOLATED** — an ESTABLISHED violation: at least one dimension both sides establish
   whose committed value exceeds the envelope, **or an established unit contradiction
   (§6.19) on a participating dimension** — the contradiction is itself the established
   evidence and classifies on its own, at differing numbers or equal ones. Precedence:
   an established violation is reported even when another dimension remains
   unestablished — a proven violation is never downgraded by an unrelated unknown, and
   a masked numeric difference on an unestablishable-units dimension never displaces an
   independently established violation on another dimension.
2. **UNVERIFIED** — no established violation, but at least one dimension cannot be
   established (UNKNOWN on either side, an invalid DETERMINED value, committed figures
   of estimate or unestablished provenance, an unjustified NOT_APPLICABLE, or a
   NOT_APPLICABLE over a present field, **or a participating currency that cannot be
   established — numeric differences across unestablished units are not evidence and
   never classify VIOLATED**). Compliance was not proven, so OK is not
   available; an UNKNOWN committed dimension cannot produce OK by absence, by numeric
   coincidence, or by sharing the quote's number. This includes a dimension carrying a
   §3.10 candidate: the candidate is recorded *because* the dimension is unestablished,
   and its presence beside the UNKNOWN label changes nothing.
3. **OK** — every dimension is established and within the envelope, or legitimately
   skipped as justified NOT_APPLICABLE on both sides.

**No-envelope case (explicit).** Where no envelope applies (CANCEL-only REVALIDATE), there
is nothing to compare, and OK keeps its v0.6.1 meaning of "no comparison applies" — but
ONLY when the committed figures the receipt reports are themselves established actuals
(every dimension DETERMINED through an establishing source, or justified
NOT_APPLICABLE). If any committed dimension is unestablished, the result is UNVERIFIED:
an unknown financial outcome must not masquerade as verified actuals merely because no
envelope was stated. A dimension carrying only a §3.10 candidate is unestablished for
this purpose. **Unit comparability applies on this path exactly as on the envelope
paths (§6.19, P16-2/P16-3):** an established unit contradiction classifies VIOLATED
(the CANCEL envelope exception excuses the missing envelope, not contradictory units);
a participating currency that cannot be established classifies UNVERIFIED; and the
`defined_equal_exact` label excuses absent unit statements only — a committed effect
labelled `defined_equal_exact` that explicitly states a contradicting currency or
cadence classifies VIOLATED, while one whose stated units are identical to the quote's
(or unstated on both sides, established by the EXACT construction) reconciles OK as
before.

**Legacy receipts.** Historical receipts recorded under v0.6.1 remain valid historical
records with their original identities. They MUST NOT be re-reconciled under v0.6.2 and
reported OK: a fresh reconciliation over legacy figures (no determinacy, no establishing
source) yields UNVERIFIED. Restoration of a stored record MUST NOT upgrade UNKNOWN
evidence into verified financial actuals (§6.16).

**6.15 (v0.6.2 NEW — outcomes, attribution, and recovery)**

- **Evidence required per outcome.** COMMITTED_AND_VERIFIED requires: landing established
  by operation-bound evidence (a mutation response bound to the operation, or an
  operation-keyed post-commit read — never state matching alone); state VERIFIED under
  §6.12 where state verification applies; and reconciliation OK or VIOLATED over
  established actuals, composed under the evidence-record rules below (append-only
  record, derived view, coherent promotion basis). COMMITTED_UNVERIFIED requires landing established by the same
  standard, with the unestablished dimensions named. INDETERMINATE and
  CONFIRMED_NON_EXECUTION follow §3.12's definitions; in particular, an adapter's rule
  for classifying a dispatched mutation's failure as CONFIRMED_NON_EXECUTION must be
  limited to demonstrably pre-effect rejections and documented per adapter.
- **A successful HTTP response is not sufficient evidence.** A provider success response
  does not by itself establish that the intended state landed or that the finances are
  as quoted: providers in this research silently ignore unrecognized parameters and can
  partially apply bundled changes (§6.8). Committed figures MUST be built from actuals
  obtained under §3.11; intended state MUST be checked under §6.12.
- **Attribution before classification.** Dispatch attribution (was THIS operation's
  effect observed, bound to this operation?) is established before outcome classification
  and figure recording. Where the attribution chain is broken, the outcome is capped at
  UNVERIFIED/INDETERMINATE and no third-party or unattributed figure may be recorded as
  this commit's determined actual; observed state is retained only as unattributed
  context.
- **Blind-retry prohibition.** After an INDETERMINATE outcome, no automated or manual
  retry of the mutation may occur until provider-state reconciliation has established
  what landed. An INDETERMINATE attempt is NEVER re-armed: if reconciliation establishes
  the intended state provably did NOT land and a human authorizes the change again, it
  proceeds as a NEW quote — never as a re-issue of the indeterminate attempt.
  Provider-native idempotency windows do not lift this prohibition: a time-limited
  provider window is not proof a retry is safe. The single bounded exception to
  same-mutation re-issue is not an INDETERMINATE retry at all: a terminal
  CONFIRMED_NON_EXECUTION attempt — whose non-execution was independently confirmed
  pre-effect — may be re-dispatched once under the same quote and key under §6.16's
  gates (§3.12; OPEN DECISION G-13).
- **Later establishment: the append-only evidence record (A-17-1…A-17-5).** A recorded
  receipt's committed figures are established later only through evidence appended to
  its **evidence record** — never by rewriting the receipt, and never by matching its
  recorded candidates. For each recorded receipt the store MUST maintain an append-only
  evidence record. Each entry MUST carry: (a) the recorded identity digest of the
  receipt it appends to; (b) an evidence identity derived from the entry's contents and
  that digest (content-derived evidence id), such that resubmitting identical evidence
  is an idempotent no-op and an entry whose stated identity does not match its contents
  is invalid; (c) the establishing evidence itself — minted from an INDEPENDENT
  post-commit `ProviderObservation` (a read of provider-side state after the commit,
  naming the quote's subscription, whose committed figures carry an establishing
  source, and which is not the quote's own quoted effect relabeled), with the §6.12
  state verification and a reconciliation computed FROM the observation (the caller
  never asserts either verdict), the observed committed effect with per-dimension
  determinacy, provenance, currency and cadence; (d) a per-dimension disposition toward
  the recorded candidates (ESTABLISHES / CONFIRMS / CONTRADICTS_CANDIDATE /
  UNRESOLVED); and (e) conflict flags recording, per dimension, contradiction with an
  actual accepted from an earlier entry. Entries are immutable once appended and MUST
  be defensively copied on ingress and on read, so later mutation of a presented token
  cannot rewrite recorded history. The store's minting procedure
  (`establishVerification`) brands the evidence token (module-private brand); a
  caller-constructed object with identical fields is self-asserted and refused, as is a
  token whose contents were altered after minting (content validation plus a
  minting-time content digest; the store re-validates the token against the recorded
  receipt and quote).
  - **Three determinations are kept distinct.** ADMISSIBILITY — whether an entry may be
    recorded at all (branded/minted, bound to the receipt's quote and subscription,
    unaltered since minting, of establishing provenance — estimate lineage and
    self-asserted verdicts are refused — internally consistent, and recomputed against
    the recorded quote and envelope under §6.19's unit rules; candidate equality is NOT
    an admissibility condition; evidence observed against a MISMATCH state is refused
    at recording, while UNVERIFIABLE-state evidence is admissible but cannot satisfy
    promotion's state limb). ESTABLISHMENT — which dimensions an entry independently
    establishes: exactly those carrying a DETERMINED figure (or NOT_APPLICABLE); an
    UNKNOWN figure establishes nothing. PROMOTION — whether the derived view may read
    verified (below). Evidence that is admissible but partial, admissible but
    state-unverifiable, or admissible but conflicted MUST be recordable without
    promoting (`recordReceiptEvidence`); `verifyCommitReceipt` remains the single-shot
    transition that appends a promotable token and returns the derived view, and
    appends NOTHING when the composed trail does not promote.
  - **The derived current view.** The current view of a commit is DERIVED from the
    recorded receipt plus its evidence record; it is never authored independently, and
    verification MUST NOT rewrite the recorded receipt (A-17-3). Per dimension the view
    displays the accepted established actual where one exists, with the establishing
    evidence's determinacy and provenance; a dimension no accepted evidence establishes
    is shown as recorded — the candidate, for display only — and MUST NOT be presented
    as established. The composed committed effect takes, per dimension, the accepted
    established figure, determinacy and provenance (A-17-4): its whole-effect committed
    source claims an establishing source ONLY when every participating dimension is
    established — while any participating dimension remains unestablished the composed
    source reads `unestablished`, so a view can never display COMMITTED_AND_VERIFIED
    over fields still labelled UNKNOWN/unestablished. Reconciliation for a verified
    view is computed against the ORIGINAL QUOTED effect and the proposal's acceptance
    envelope, never against the recorded candidate as the financial baseline: an
    established actual outside the envelope reads VIOLATED, never OK.
  - **Composition and conflicts.** Per dimension, the first establishing entry sets the
    accepted actual; a later entry with the same value confirms it; partial entries
    compose across the record. Where a later admissible entry establishes a DIFFERENT
    actual for an already-established dimension, the entry MUST be appended and
    flagged, the previously accepted actual MUST NOT be replaced, and while the
    conflict stands the view MUST read COMMITTED_UNVERIFIED with an UNVERIFIED
    reconciliation naming the conflict — never an unqualified OK. Conflict resolution
    is an operator act outside the protocol's automatic rules.
  - **Promotion.** The derived view promotes to COMMITTED_AND_VERIFIED only when ALL of
    the following hold conjunctively: the evidence record is non-empty; no unresolved
    conflict stands; the reconciliation recomputed over the composed established effect
    against the original quoted effect and envelope is DETERMINED — OK
    (verified-with-compliance) or VIOLATED (verified-with-violation), which MUST remain
    distinguishable outcomes; some entry's state result is VERIFIED; and the
    **promotion basis is cross-observation coherent** (next bullet). A promoted outcome
    is therefore exactly one of two terminal shapes, both COMMITTED_AND_VERIFIED:
    reconciliation OK, or reconciliation VIOLATED. INDETERMINATE /
    CONFIRMED_NON_EXECUTION records (no receipt) cannot be verified into existence.
  - **Cross-observation coherence (A-17-5, as completed by the degenerate-revision
    rule).** The promotion basis is the set of entries the verified claim rests on: the
    accepted establisher of each established dimension, together with the entry
    carrying the VERIFIED state result when no establisher carries it. An entry
    established against an observed post-commit state carries that state's identity —
    `observedStateDigest`, a digest of the resulting snapshot's subscription id and
    state-revision `version`, stamped at minting and bound into the entry's
    content-derived evidence id. The basis is coherent iff it consists of a single
    entry, or every entry in it carries the SAME observed-state identity. An entry
    carrying NO observed-state identity MUST NOT take part in a promotion basis of more
    than one entry. Composition for display is unrestricted — actuals established
    against different revisions are still recorded and shown — but an incoherent basis
    MUST leave the view COMMITTED_UNVERIFIED with an UNVERIFIED reconciliation whose
    reason names the incoherence. **Identity existence:** an observed-state identity
    exists ONLY when both components are established — the snapshot is present AND its
    subscription id is a non-empty string AND its `version` is a non-empty string
    (non-empty judged after trimming; non-string runtime values establish nothing).
    Otherwise the observation stamps no identity and the entry is treated exactly like
    a snapshot-less one. Established components are digested verbatim — trimming
    decides existence, never equality. The single-entry basis rule is unchanged: a lone
    entry composes nothing, so there is no cross-observation claim for a degenerate
    revision to falsify.
  - **Identity conflicts, delimited.** `CONFLICTING_RECEIPT_IDENTITY` is retained for
    genuinely different receipts, wrong quote/subscription bindings, and tampered
    recovery sets — never for candidate≠actual (A-17-1).
- **Operator reconciliation.** A conforming deployment MUST be able to enumerate
  receipts in the UNVERIFIED state and attempts in unresolved states
  (DISPATCHING/INDETERMINATE) for operator review, and MUST provide the recovery
  procedure of §6.16 before any further mutation on an affected subscription.
  Reconciliation reporting a violation is not prevention and not rollback: a landed
  change is compensated, if at all, by a new separately authorized change.

**6.16 (v0.6.2 NEW — durable behavior)** A deployment committing against a real provider
MUST persist quotes, receipts, and mutation attempts durably, such that:

- **Original-receipt replay.** A recorded receipt is retrievable verbatim after any
  restart, and §6.10 replay returns it without revalidation (§3.9).
- **Receipt identity.** Each recorded receipt has a canonical identity — the tuple of
  receiptId, quoteId, subscriptionId, recorded outcome, recorded reconciliation status,
  recorded `immediate.net`, and recorded `recurring.resultingAmount` (the recorded
  candidate figures themselves, where present) — with a digest verified at recording
  and at recovery. Reusing an identity under different content, or a persisted record
  whose fields no longer match its recorded digest, is a `CONFLICTING_RECEIPT_IDENTITY`
  refusal. The original record is always preserved; identity is never resolved by
  overwriting, and later evidence never revises the identity (A-17-1).
- **Evidence-record persistence and recovery.** The append-only evidence record (§6.15)
  persists with the receipt. Recovery re-validates EVERY entry (identity-digest
  binding, live-equivalent admissibility, entry/evidence reconciliation agreement,
  derived fields recomputed and compared, evidence-id uniqueness) and NEVER trusts a
  persisted current view: the persisted view is adopted only if it deep-equals the
  derived view, and adoption installs the derived view; an incoherent restore set is
  rejected atomically, as a whole, at both restore paths (in-memory and durable).
  Appends are atomic at the stated boundary: in-memory append + derivation is one
  synchronous step; the durable store persists quote row + receipt record in one SQLite
  transaction and poisons on failure, so an interrupted append recovers exactly the
  pre- or post-append record — never a promoted view without its evidence. Legacy
  one-transition trails in the historical entry shape are accepted and normalized at
  recovery, with their view re-derived under §6.15 — a legacy record carrying a
  verified label over unestablished figures restores truthfully rather than refusing or
  persisting the mislabel (A-17-6).
- **Recovery coherence.** On adoption after restart, the whole recovered set is
  validated for coherence (record↔quote association, recorded-state legality,
  verification-trail coherence, per-record integrity digests). Any failure refuses the
  WHOLE set — partial adoption of a corrupt record set is prohibited — and every read /
  replay egress validates the records it serves. One check is specific to the
  observed-state digest: a persisted entry's stored `observedStateDigest` is a *stated*
  field recovery cannot recompute from source (the originating snapshot is not
  persisted), but the two digest values minted under the pre-correction rule from
  degenerate revisions of a record's subscription — an empty version, and an absent
  version — ARE computable at recovery from the subscription id, and recovery MUST
  refuse any entry carrying either, whole-set, at the shared coherence check: that
  coherence claim was never sound. The residual limitation this leaves is recorded
  non-normatively in §9 (U-14) and gap register G-15.
- **Write-ahead attempts.** Before any dispatch, the mutation intent — quote,
  subscription, provider, site, the exact canonical request, its request hash, the
  idempotency key, attempt identity, and the pre-dispatch fingerprint — is persisted in
  ONE transaction with the attempt's PREPARED → DISPATCHING transition. Only then may
  dispatch occur, at most once per authorization. The dispatch result settles
  atomically (receipt + attempt terminal state in one transaction, or a no-receipt
  outcome).
- **Idempotency-key and request-hash binding.** The idempotency key is unique per
  attempt and bound to ONE quote / subscription / provider / site: the same key
  presented under a different binding is a collision and is refused in any state of the
  bound attempt, and the same key with a different request (hash mismatch) is likewise
  refused. The same key with the identical request whose attempt settled in a terminal
  COMMITTED_* state serves its recorded receipt/outcome without a new dispatch — a
  committed attempt is NEVER re-armed. **Sole exception — confirmed non-execution:**
  where the bound attempt settled CONFIRMED_NON_EXECUTION (non-execution independently
  confirmed pre-effect, §3.12/§6.15), the ledger re-arms that same attempt row and
  authorizes ONE new dispatch under the same quote and key, only when ALL of the
  following hold, each verified inside the same persistence transaction: the canonical
  request and its request hash are identical; the quote/subscription/provider/site
  binding is unchanged and matches the durably stored quote; and the
  same-subscription exclusion is re-checked (excluding only the attempt being
  re-armed), so the re-dispatch cannot run concurrently with another quote's
  unresolved attempt on that subscription. The re-dispatch is recorded in the
  attempt's history. This gate sits BEHIND the ordinary commit preconditions: the
  commit path validates quote expiry and the subscription fingerprint (§6.2/§6.10) on
  every presentation, before dispatch authorization, so an expired or stale quote
  refuses before the ledger is ever consulted for re-arming — a stale quote cannot
  override those checks. A DISPATCHING attempt, or an INDETERMINATE attempt not yet
  operator-resolved, blocks outright; an operator-resolved INDETERMINATE attempt is
  still never re-armed — it authorizes no dispatch. The canonical
  request hash (`requestHashOf` over the canonical form) binds the stored intent to
  the exact request authorized. *(Doctrine: OPEN DECISION G-13 / U-13.)*
- **Same-subscription concurrency.** A second dispatch for a subscription with an
  unresolved attempt MUST be refused; the exclusion is checked inside the persistence
  transaction, not merely asserted by callers beforehand. *(Reconciliation note — code
  governs:* the reference implementation's blocking check keys on (quote_id OR
  subscription_id) and carries no provider/site predicate, so the same subscription id
  on two different sites mutually blocks — an over-broad, availability-side,
  fail-closed-direction divergence from the full-identity keying an earlier draft of
  this clause stated. Recorded as gap register G-21; the normative requirement is the
  in-transaction refusal, and the keying refinement is tracked, not silently claimed.)*
- **Crash/restart recovery.** A DISPATCHING attempt found at recovery is NEVER
  automatically retried. After the deployment's recovery grace window (the reference
  implementation defaults to 30 s, distinguishing a crashed writer from a live one
  under its single-writer model), it recovers as INDETERMINATE and blocks further
  dispatch for that subscription until operator reconciliation (§6.15) resolves it.
- **Coordinator binding.** Where a separate coordinator object mediates dispatch, it
  MUST be bound to the same durable store instance the adapter reads and writes; a
  mismatched binding is refused at wiring time. A durable store presented without its
  coordinator on a commit path that requires one is likewise refused.
- **Historical immutability.** Recorded receipts are immutable historical records.
  Verification transitions (§6.15) supersede the current view; they never rewrite the
  recorded receipt, and replay (§6.10) always serves the recorded original.
- **Exactly-once honesty.** This machinery yields exactly-once RECORDING and
  at-most-once dispatch AUTHORIZATION. It does NOT yield exactly-once provider
  execution, and no conforming text, receipt, or report may claim that it does:
  durable storage alone does not create provider-side exactly-once semantics.

*Informative (non-normative):* the reference implementation realizes this section with
SQLite (WAL mode, `synchronous=FULL`) via an optional native dependency, per-quote
version compare-and-swap write-through, and SHA-256 record digests. Those mechanics are
one conforming realization, not protocol requirements; another store providing the same
guarantees conforms equally.

**6.17 (v0.6.2 NEW — authorization preservation; PR #24)** Where a commit's dispatch
mechanism cannot preserve state outside the authorized operation's target, the
authorization's breadth decides the outcome — before dispatch:

- The adapter's mutation capability is adapter-declared (§3.15) and MUST NOT be read
  from caller-controlled or runtime-mutable state. A quote records the authorization
  scope and the declared capability; a recorded capability that differs from the
  adapter's declaration, or an unknown recorded capability value (classified as
  FULL_REPLACEMENT_ONLY), refuses at this gate.
- An **OPERATION-authorized** update commit dispatched through a **FULL_REPLACEMENT_ONLY**
  mechanism (the dispatch enumerates the complete target item list, e.g.
  `update_for_items` with `replace_items_list=true`) MUST refuse **pre-dispatch** with
  `AUTHORIZATION_PRESERVATION_UNENFORCEABLE`. The refusal carries CONFIRMED_NON_EXECUTION
  semantics: zero dispatches, zero durable dispatch attempts, no receipt, and it is
  never INDETERMINATE. Neither the absence of observed concurrency nor a fresh
  pre-dispatch read lifts the refusal: a read is not a conditional write, and no
  documented Chargebee conditional-write/CAS mechanism closes the window between the
  last read and the replacement dispatch (the concurrent-addition race is Issue #22
  Finding 1: a concurrent item is deleted by the replacement while a target-state check
  still passes). This is a standing limitation of the mechanism, not a transient
  defect (§9 U-15 / gap register G-17).
- **TARGET_REPLACEMENT** scope is refused at quote creation with `UNSUPPORTED_CHANGE`
  (recognized, unimplemented — §3.15); no waiver or configuration bypass exists.
- A quote created through such an adapter SHOULD disclose the commit consequence at
  creation (the recorded scope + capability pair), so the refusal never surprises a
  caller at commit time.
- **Preservation claims.** No receipt, view, or report may claim or imply preservation
  of unnamed/out-of-scope state for a commit dispatched as a full-list replacement;
  target-state equality is not preservation evidence (§6.12). CANCEL quotes on the
  Chargebee-live adapter are refused at creation (the adapter has never dispatched a
  cancellation), unchanged by this rule.

**6.18 (v0.6.2 NEW — runtime proposal validation; PR #25)** Type definitions are not
runtime validation. Adapters MUST validate caller-controlled proposals at runtime
through the shared validator (`validateProposalRuntime` at creation;
`validateStoredQuoteRuntime` over the stored record at commit), as the FIRST statement
of quote creation and, at commit, after §6.10 replay / INDETERMINATE / expiry /
fingerprint handling and before any re-preview, durable attempt, or dispatch:

- **Proposal structure and mode.** A malformed proposal structure refuses with
  `INVALID_PROPOSAL`. `guaranteeMode`: omitted reads as REVALIDATE; only `EXACT` and
  `REVALIDATE` are valid; an explicit `null` is INVALID (the null asymmetry with
  `authorizationScope`, which reads `null` as absent, is deliberate and stated here so
  it is spec, not folklore).
- **Envelope shape.** A supplied `acceptanceEnvelope` MUST be a plain object carrying
  only the three named bounds (`maxImmediateNetIncrease`,
  `maxImmediateCreditDecrease`, `maxRecurringIncrease`), each a finite, non-negative
  number, read via OWN properties
  only (inherited bounds never widen tolerance; engine-constructed envelopes are built
  so a polluted prototype cannot smuggle a bound). Only `undefined` is omission: falsy
  supplied envelopes (`null`, `false`, `0`, `""`) are malformed, not omitted. Whether
  bounds must additionally be *safe integers* is an OPEN DECISION (gap register G-18):
  this candidate specifies the implemented finite-non-negative rule and records the
  recommendation, it does not impose the stricter rule. Envelope *presence* (the
  REVALIDATE-requires-envelope rule and its CANCEL exception, §4.2) is enforced at quote
  creation AFTER effectiveIntent support checks, so an intent-unsupported proposal
  refuses `UNSUPPORTED_CHANGE` even when it is also envelope-less.
- **Scope validation is shared.** The authorization-scope rules of §3.15/§6.17 are
  validated by the same shared path at creation AND at commit, over both stored
  declaration sites (proposal and quote record): an unknown scope value in a stored
  record refuses at commit as `INVALID_PROPOSAL` — never gated-as-OPERATION, never
  INDETERMINATE, zero dispatches.
- **Zero quantity and DATE representation.** `CHANGE_QUANTITY` with `quantity: 0` is
  accepted by the validator (finite, ≥ 0) and its meaning is left to provider
  semantics — a spec ruling is recorded as an open item in gap register G-18. A DATE
  effective intent's `at` MUST be a string that `Date.parse` accepts.
- **Post-commit classification never throws.** `reconcileCommittedEffect` NEVER throws:
  a malformed envelope discovered after the mutation landed classifies — VIOLATED
  through interpretable bounds, else UNVERIFIED — never OK, and never an exception that
  loses the receipt (§6.14). Pre-dispatch, invalid input refuses; post-dispatch, it
  classifies. Recorded-receipt replay (§6.10) precedes stored validation: validation
  never refuses a legitimate replay.

**6.19 (v0.6.2 NEW — subscription identity binding and unit comparability; PR #26)**

- **Identity binding, pre-dispatch.** Every provider read consumed on a commit path
  (creation reads and commit-phase validation reads) MUST be bound to the quote's
  subscription: a read naming a different subscription refuses BEFORE dispatch with
  CONFIRMED_NON_EXECUTION semantics (zero dispatches, zero durable attempts, no
  receipt).
- **Identity binding, post-dispatch.** Provider data naming a foreign subscription,
  returned after dispatch or by a post-commit re-read, MUST NOT be consumed as evidence
  for this commit: it cannot verify the record, cannot reconcile OK, and — the work
  having been dispatched — is never reclassified CONFIRMED_NON_EXECUTION. It classifies
  as a verification failure over dispatched work. The shared §6.12 hook check
  (`state:subscriptionIdentity`, §3.13) applies the same binding inside
  `establishVerification`, so asserted-ref patterns in the simulators are bound through
  the store as well.
- **Unit comparability as a precondition.** Financial comparison (envelope gate,
  reconciliation, store recomputation — one shared assessment,
  `assessUnitComparability`) is per-dimension and runs BEFORE any numeric evidence is
  taken from that dimension: (1) an established unit contradiction (§3.16) classifies
  VIOLATED on the contradiction itself; (2) a numeric violation is available only on
  dimensions whose units are established and compatible; (3) an unestablishable
  participating currency classifies UNVERIFIED, and numeric differences on such a
  dimension are masked there — they are not violations — while an independently
  established violation on another dimension still classifies VIOLATED. The same
  precondition governs the pre-dispatch gate's REASON (§6.13) and the
  malformed-envelope projection's numeric evidence (§6.18), and it applies on the
  no-envelope path exactly as on the envelope paths (§6.14). Unit context is threaded
  through quote creation, stored-quote minting/recomputation, and each adapter's
  establishment path; where an adapter's context is a construction placeholder rather
  than established context, that limit is disclosed in the provider audit rather than
  silently relied on.

---

## 7. Multi-Change Consistency *(v0.6.1, preserved; one v0.6.2 note)*

For `changes.length > 1`:

1. `multiChangeConsistency` is computed pairwise across every pair of changes in the
   batch, taking the WEAKEST pairwise result (`UNSUPPORTED` wins if any pair reports
   it).
2. If the computed value is `UNSUPPORTED`, `createChangeQuote` MUST refuse with
   `UNSUPPORTED_CHANGE` before any preview call — the caller must split the proposal.
3. If `ATOMIC` or `BEST_EFFORT`, the quote and eventual receipt MUST report the computed
   value verbatim; `BEST_EFFORT` is not itself a refusal condition.
4. Per Rule 6.8, an adapter MUST additionally refuse with `UNSUPPORTED_CHANGE_SET` (not
   proceed as `BEST_EFFORT`) if the specific combination risks silent partial
   application rather than a detectable one.

*(v0.6.2 note)* A multi-change proposal has no single action context, so no dimension of
its combined effect can be licensed NOT_APPLICABLE (§3.10). Its dimensions must be
DETERMINED (or UNKNOWN, with §6.13's consequences) — this is a consequence of the
licensing rule, not a new restriction on bundling itself.

---

## 8. Migration from v0.6.1 *(v0.6.2 NEW — summary; full guide is informative)*

The backward-incompatible changes are BC-1…BC-6 (design: issue #7). The complete
migration guide, with verified per-item implementation status, before/after examples,
and affected callers, is `research/v0.6.2-migration-guide.md` (informative). Summary:

| # | Change | Migration position |
|---|---|---|
| BC-1 | Fail-closed envelope enforcement: envelopes v0.6.1 "passed" by comparing coerced zeros now refuse (`QUOTE_NOT_DETERMINISTIC`) on any unenforceable dimension, pre-mutation. | Adapters emit determinacy + provenance (§3.10/§3.11); expect refusals exactly where v0.6.1 compared invented numbers. Refusals are CONFIRMED_NON_EXECUTION — retry-safe after re-derivation or re-quote. |
| BC-2 | Legacy payloads read as UNKNOWN: stored v0.6.1 quotes/effects without determinacy can no longer be enforced or reconciled to OK as-is. | Re-derive determinacy from provider evidence or re-quote. Stored receipts stay valid as historical records; never re-reported OK (§6.14). |
| BC-3 | Stripe simulator `amount_due` mapping removed: `immediate` is now sourced from the preview's incurred figure, distinct from `amount_due`. | Historical Stripe-simulator quotes were recorded under the conflation and are not comparable to post-migration quotes. |
| BC-4 | Paddle reconciliation basis: committed effects must be post-commit actuals bound to the mutation; results previously OK by lineage become UNVERIFIED until an independent actual establishes them. | The simulator exposes a post-commit actual read (persisted transaction retrieval); expect the one-time OK-rate drop to reflect honesty, not regression. |
| BC-5 | `ReconciliationResult` union widened with UNVERIFIED; receipt `status` widened with COMMITTED_UNVERIFIED. | Intentionally loud: exhaustive switches fail to compile. Handle UNVERIFIED / COMMITTED_UNVERIFIED as "landed, finances unverified — operator follow-up," never as OK. |
| BC-6 | Mutation-outcome reporting: failed/incomplete commits are classified INDETERMINATE vs CONFIRMED_NON_EXECUTION, with opposite retry rules. | INDETERMINATE is never re-armed and requires provider-state reconciliation first (§6.15). CONFIRMED_NON_EXECUTION permits ONE same-quote, same-key re-dispatch under §6.16's gates (identical request/hash, unchanged binding, in-transaction exclusion re-check, ordinary expiry/fingerprint preconditions) — doctrine recorded as OPEN DECISION G-13/U-13 for ratification at approval. |

---

## 9. Unresolved Issues (carried into external review)

U-1…U-8 are carried from v0.6.1 §9 unchanged in substance; U-9…U-13 are new in this
candidate and cross-reference the gap register (`research/v0.6.2-release-gaps.md`), which
carries their full entries, severities, and recommended resolutions.

- **U-1 — Committed-term CANCEL on Chargebee is UNVERIFIED.** No test site with Contract
  Terms enabled has been validated against real Chargebee behavior. The type system
  honestly reports `UNKNOWN`. **Unchanged.**
- **U-2 — No adapter reports `ConsistencyGuarantee: "ATOMIC"`.** Zero of four validated
  providers support a server-enforced precondition. Post-commit reconciliation exists
  precisely because U-2 remains open. **Unchanged.**
- **U-3 — `effectiveIntent` is proposal-level, not per-change.** A known modeling
  ceiling. **Unchanged** (and the root of the multi-change NOT_APPLICABLE rule, §3.10).
- **U-4 — Zuora's `CHANGE_CADENCE` term-interaction gap remains open.** **Unchanged.**
- **U-5 — Chargebee scheduling mechanisms.** `end_of_term` is deprecated-but-documented;
  DATE via `update_for_items` is NOT ESTABLISHED in the current documented contract.
  Both reference Chargebee adapters refuse DATE. **Unchanged.**
- **U-6 — RESOLVED in v0.6.1** (`UNSUPPORTED_CHANGE_SET` engine primitive unit-tested;
  no real adapter path reaches it end-to-end). **Unchanged.**
- **U-7 — Post-commit reconciliation cannot prevent a violation, only report it.** By
  design. **Unchanged.**
- **U-8 — Idempotent replay uses `quoteId` as the sole idempotency key.** No cross-quote
  deduplication. v0.6.2's durable attempt ledger keys attempts by provider idempotency
  key and binds them to quotes, but does not add caller-supplied cross-quote
  deduplication. **Unchanged in scope.**
- **U-9 (NEW) — `defined_equal_exact` cannot be authenticated by the core** (gap G-01,
  OPEN DECISION). The label + established determinacy suffice for the committed side to
  establish; whether the spec should demand operation-bound evidence for this source
  too is for the approval review.
- **U-10 (NEW) — Committed-side provenance: absent source vs. basis note** (gap G-02,
  OPEN DECISION). The implementation's committed role treats an absent `committedSource`
  as MISSING_PROVENANCE even when a free-form basis note exists — stricter than the
  report-only audit's basis rule. This candidate specifies the implementation's stricter
  rule (§3.11/§6.13); the alternative (note-established committed actuals) is recorded
  for decision rather than silently adopted.
- **U-11 (NEW) — Scheduled effective-time evidence is provider-shaped** (gap G-04).
  TERM_END kind evidence verifies without an instant; DATE requires an established
  instant. Whether kind-only TERM_END evidence is sufficient for an approved standard —
  and what adapters must do when a provider exposes neither kind nor instant — is
  recorded for decision; the candidate specifies current behavior (§6.12).
- **U-12 (NEW) — Pilot-layer origin evidence is not protocol evidence** (gap G-05). The
  Chargebee pilot's quote-origin manifest (PR #20) is tamper-evident within its file
  (self-digests + hash chain + once-only writer) but has no external trust anchor: it
  does not authenticate its creation time or issuer against a privileged writer. It is a
  pilot-harness control, NOT a protocol mechanism, and nothing in this candidate makes
  origin-manifest evidence a normative input to any §6 rule.
- **U-14 (NEW) — Legacy observed-state digest limitation (residual, disclosed).** A
  persisted evidence entry's stored `observedStateDigest` is a stated field: recovery
  cannot recompute it from source data, because the originating snapshot is not
  persisted. Recovery refuses entries carrying the two enumerable old-rule degenerate
  digests (empty version; absent version — §6.16). **Residual:** digests minted before
  the identity-existence rule from whitespace-only or non-string version components are
  not enumerable at recovery and remain stated fields recovery takes as presented. They
  cannot be minted anymore; closing them at recovery would require persisting the
  originating snapshot — a format change no merged PR makes. Recorded in gap register
  G-15.
- **U-15 (NEW) — Chargebee full-replacement preservation blocker (standing limitation).**
  With `replace_items_list=true` as the sole update dispatch and no documented
  conditional write/CAS, OPERATION-scope authorization preservation is unenforceable on
  Chargebee-live, so such commits refuse pre-dispatch (§6.17). This is a standing
  limitation of the mechanism, recorded in gap register G-17 — not a resolved item, and
  not lifted by any pre-dispatch read.
- **U-16 (NEW) — F3/F4 schema decisions carried undecided (A-16-1…A-16-4 record).** The
  normative rules of A-16-1 (identity binding) and A-16-2 (unit comparability) ARE
  stated in this candidate (§6.19) because merged code decided the behaviours. The
  schema questions remain OPEN and are not resolved by this candidate: A-16-3 (an
  optional `currency` on `CommercialEffect.immediate`, adapter-populated, with
  stored-record compatibility, plus a required-resulting-cadence proposal and its
  stored-record migration note); A-16-4 (the Chargebee-live committed-effect
  currency-defaulting construction — left unchanged in merged code); whether an
  `expectedSubscriptionRef`-style binding becomes a REQUIRED expectation field in a
  future major version (it is optional here, §3.13); cadence vocabulary normalization
  beyond case-insensitivity; and whether historical receipts should be annotated (never
  rewritten) with derived unit context when next verified. All are carried in gap
  register G-16.
- **U-13 (NEW) — Confirmed-non-execution re-dispatch doctrine awaits ratification**
  (gap G-13, OPEN DECISION). This candidate specifies the implemented doctrine
  (§3.12/§6.15/§6.16): one same-quote, same-key re-dispatch per CONFIRMED_NON_EXECUTION
  settlement, gated on identical request/hash, unchanged binding, an in-transaction
  same-subscription exclusion re-check, and the ordinary expiry/fingerprint
  preconditions. The alternative — a fresh quote and key for every retry — buys
  freshness at the cost of a separately reviewed implementation change; the approval
  review ratifies one doctrine or directs the other.

---

## Appendix A — Clause-by-clause delta, v0.6.1 → v0.6.2

| v0.6.1 clause | v0.6.2 disposition |
|---|---|
| Header / status | Replaced: candidate status block; v0.6.1 remains current until approval. |
| §1 Scope | Unchanged. |
| §2 Lifecycle | Unchanged, plus a pointer to §6.16 durable requirements for real-provider commits. |
| §3.1 EffectiveIntent | Unchanged. |
| §3.2 ChangeSpec | Unchanged. |
| §3.3 Proposal | Unchanged (multi-change N/A consequence noted, §3.10/§7). |
| §3.4 GuaranteeMode/Coverage | Unchanged. No new guarantee modes. |
| §3.5 ActionCapabilities | Unchanged. |
| §3.6 Consistency types | Unchanged. ATOMIC still never reported. |
| §3.7 Quote | Unchanged fields; quote effects now carry determinacy + provenance (§3.10/§3.11). |
| §3.8 Receipt | Modified (candidate §3.9): `ReconciliationResult` gains UNVERIFIED; `status` widened with COMMITTED_UNVERIFIED; `outcome` and optional `receiptId` added; replay clarified to the ORIGINAL recorded receipt; **EXACT equality refined (SPEC1)** — v0.6.1 §3.8's whole-object "MUST deep-equal" is replaced by §3.9's covered-dimensions equality, because §3.11's committed-role provenance (committed-side only) makes whole-object equality unsatisfiable for conforming EXACT receipts; whole-object deep equality is explicitly NOT a conformance criterion. |
| §3.9 Error codes | One addition: `CONFLICTING_RECEIPT_IDENTITY`. No code removed or renamed. |
| (v0.6.1 had no CommercialEffect definition) | NEW §3.8: CommercialEffect defined; `immediate` = incurred obligation, distinguished from invoice total / amount due / amount due net of credits / next-invoice estimate / recurring / cash collected; next-invoice facts stay in providerMetadata by convention. |
| (new) | NEW §3.10: three-state determinacy, purity, N/A licensing (field absence + single-action context + citation; recurring never N/A; multi-change unlicensable), legacy UNKNOWN reading, finding order, snapshot determinacy. |
| (new) | NEW §3.11: committed-figure provenance sources; only provider_actual / defined_equal_exact establish; label ≠ authentication (OPEN DECISION G-01). |
| (new) | NEW §3.12: four-class mutation-outcome taxonomy with retry rules — including the confirmed-non-execution re-dispatch doctrine (one same-quote, same-key re-dispatch per CONFIRMED_NON_EXECUTION settlement, §6.16 gates; SPEC2 correction — an earlier draft of this candidate said "as a new quote", contradicting the merged ledger; doctrine is OPEN DECISION G-13/U-13). |
| (new) | §3.10/§3.12 candidate clarification (SPEC3 correction): an UNKNOWN committed dimension on a COMMITTED_UNVERIFIED receipt MAY carry a labeled, non-establishing **candidate** (source disclosed; `committedSource: "unestablished"`; part of the recorded receipt's identity; established later only by §6.15 evidence — as originally corrected, evidence equal to the recorded candidate; that equality requirement was itself superseded in the reconciliation round by A-17-1 (§6.15 as reconciled: evidence establishes independently; differing actuals are judged, not refused). An earlier draft of this candidate stated the no-number rule categorically for UNKNOWN and required committed effects to contain only established figures — wording that declared the merged adapters' deliberate candidate construction (PR #10/#11 doctrine, present in all five adapters) nonconforming. The categorical rule is unchanged for quote/revalidated roles and for §6.13 enforcement. |
| (new) | NEW §3.13/§6.12: provider-neutral post-commit state-verification contract (verdicts, coverage, multiset tuples, partial/malformed handling, scheduled-cancel timing incl. premature-termination and SV6 classification, constant-false boundary fields). |
| §4.1 EXACT scope | Unchanged; v0.6.2 note ties EXACT establishment to §3.11. |
| §4.2 REVALIDATE | Clarifications preserved; NEW fail-closed determinacy paragraph (§6.13 summary). |
| §4.3 Coverage levels | Unchanged. |
| §5 Coverage resolution | Unchanged. |
| §6.1–6.10 | Unchanged (6.10 replay wording aligned to "original recorded receipt"). |
| §6.11 Reconciliation | Extended by §6.14: precedence VIOLATED > UNVERIFIED > OK; no-envelope case stated explicitly; legacy receipts never re-reconciled to OK. |
| (new) | NEW §6.12 state verification; NEW §6.13 fail-closed enforcement (shared assessment, refusal shape, no-intent guarantee); NEW §6.15 outcomes/attribution/recovery/upgrade procedure; NEW §6.16 durable behavior (SQLite/WAL informative only), including the key/hash binding rules with the sole CONFIRMED_NON_EXECUTION re-dispatch exception (SPEC2). |
| §7 Multi-change | Unchanged, plus the N/A-licensing consequence note. |
| (new, reconciliation) | NEW §3.15 authorization scope + mutation capability (PR #24); NEW §3.16 units of comparison (PR #26); §3.13 gains the optional `expectedSubscriptionRef` and the `state:subscriptionIdentity` check (PR #26). |
| (new, reconciliation) | NEW §6.17 authorization preservation (PR #24, incl. PR #23 recommendations 1/2/8 as implemented); NEW §6.18 runtime proposal validation (PR #25, incl. PR #23 recommendation 5); NEW §6.19 identity binding + unit comparability (PR #26, incl. PR #23 recommendations 6/7 as implemented). |
| §3.10/§3.12/§6.14/§6.15/§6.16 (reconciliation) | Candidate-equality ELIMINATED (A-17-1…A-17-6, PR #27): §6.15's upgrade rule replaced by the append-only evidence record + derived current view + promotion/coherence rules; §3.10 candidate redefined as a claim to be judged, not an identity element to be matched; §6.16 gains evidence-record persistence/recovery, legacy-trail normalization, and the degenerate-digest recovery refusal; §6.13/§6.14 gain the §6.19 unit precondition including the no-envelope path and the P16-3 label rule. |
| §3.14 Error codes | One further addition: `AUTHORIZATION_PRESERVATION_UNENFORCEABLE` (PR #24). |
| §6.2 (reconciliation) | Temporal-scope clarification (PR #23 recommendation 4): the fingerprint precondition is evaluated against the last pre-dispatch read and does not itself bind the dispatch. |
| §9 Unresolved | U-14 (digest residual), U-15 (preservation blocker), U-16 (A-16 undecided schema set) added in the reconciliation round. |
| §8 Schema diff | Superseded by this Appendix and §8's BC-1…BC-6 summary. |
| §9 Unresolved | U-1…U-8 carried; U-9…U-13 added, each cross-referencing the gap register. |

## Appendix B — Normative rule index (identifiers used by the traceability matrix)

Determinacy (§3.10): **V62-DET-01** three states mutually exclusive/exhaustive, no implicit
conversion · **V62-DET-02** absent determinacy record ⇒ UNKNOWN (legacy reading) ·
**V62-DET-03** explicit zero is DETERMINED present-with-0 · **V62-DET-04** N/A requires
whole-field absence · **V62-DET-05** N/A requires licensed single-action context (table:
CANCEL/immediate only; recurring never; multi-change none) · **V62-DET-06** N/A requires a
valid applicability citation · **V62-DET-07** DETERMINED requires a finite present value ·
**V62-DET-08** snapshot recurringAmount carries its determinacy state.

Financial meaning (§3.8): **V62-FIN-01** immediate = incurred obligation ·
**V62-FIN-02** amount-due / next-invoice figures never mapped into immediate or recurring ·
**V62-FIN-03** recurring = post-change price level, never net of credits; CANCEL recurring
is DETERMINED 0 · **V62-FIN-04** no new financial dimensions or guarantee modes.

Enforcement (§6.13): **V62-ENV-01** unenforceable dimension ⇒ pre-mutation
QUOTE_NOT_DETERMINISTIC · **V62-ENV-02** refusal creates no mutation intent and precedes
dispatch authorization · **V62-ENV-03** comparable-only comparison; justified N/A skipped,
never zero-compared · **V62-ENV-04** missing envelope bounds default to zero tolerance ·
**V62-ENV-05** quote-role DETERMINED requires the provenance note; committed-role
DETERMINED requires an establishing source · **V62-ENV-06** recorded-receipt replay
performs no revalidation.

Committed evidence (§3.11/§6.14): **V62-EVD-01** only provider_actual /
defined_equal_exact establish · **V62-EVD-07** EXACT equality is covered-dimensions
equality (§3.9): covered values/determinacy/timing must match; whole-object deep
equality is NOT a criterion and committed-side provenance/evidence metadata may — and
where §3.11 requires, must — differ · **V62-EVD-02** preview/estimate sources never establish ·
**V62-EVD-03** precedence: established VIOLATED > UNVERIFIED > OK · **V62-EVD-04**
no-envelope OK only over established actuals · **V62-EVD-05** legacy receipts never
re-reconciled to OK · **V62-EVD-06** provenance label is not authentication ·
**V62-EVD-08** candidate rule (§3.10/§3.12): an UNKNOWN committed dimension on a
COMMITTED_UNVERIFIED receipt MAY carry a labeled candidate (source disclosed in
provenance, `committedSource: "unestablished"`, reconciliation UNVERIFIED); the
candidate is part of the recorded receipt's identity, is never compliance evidence,
never produces OK or a verified transition by itself, and is established later only by
§6.15 evidence that establishes the dimension independently — differing established
actuals are recorded and judged against the quote/envelope, never refused as an
identity conflict (V62-EVD-09); on quote/revalidated roles
an UNKNOWN dimension carries no number, and fail-closed enforcement is unchanged.

Outcomes & recovery (§3.12/§6.15): **V62-OUT-01** four-class taxonomy; receipts only for
COMMITTED_* · **V62-OUT-02** CONFIRMED_NON_EXECUTION only for never-dispatched or
demonstrably pre-effect rejections · **V62-OUT-03** no blind retry after INDETERMINATE ·
**V62-OUT-04** HTTP success alone establishes neither state nor finances ·
**V62-OUT-05** attribution before classification; broken attribution caps outcome and
figures · **V62-OUT-06** COMMITTED_UNVERIFIED upgrade only via branded, recomputed
establishment evidence · **V62-OUT-07** operators can enumerate UNVERIFIED receipts and
unresolved attempts.

State verification (§6.12): **V62-SV-01** verdict precedence (contradiction > unverifiable
> verified) · **V62-SV-02** FULL_ITEM_SET compares complete tuples as multisets ·
**V62-SV-03** omitted collection is UNVERIFIABLE, never empty; present-empty vs nonempty
expectation is MISMATCH · **V62-SV-04** partial collections: present-entry contradictions
stand, absence-based ones don't, no VERIFIED from partial · **V62-SV-05** malformed entries
never abort; all entries for a target judged · **V62-SV-06** scheduled-cancel timing
(IMMEDIATE/TERM_END/DATE rules, read-time prematurity first, DATE instant-required,
kind-contradiction ambiguity = UNVERIFIABLE) · **V62-SV-07** expectation side is
authorized-side only (incl. termBoundaryAt) · **V62-SV-08** state verdict establishes
neither execution, attribution, nor finances (constant-false fields; result refused as
evidence).

Authorization preservation (§3.15/§6.17): **V62-AUTH-01** capability is
adapter-declared and not runtime-mutable; recorded capability differing/unknown refuses
· **V62-AUTH-02** OPERATION-authorized update commit through a FULL_REPLACEMENT_ONLY
mechanism refuses pre-dispatch with AUTHORIZATION_PRESERVATION_UNENFORCEABLE
(CONFIRMED_NON_EXECUTION semantics, zero attempts/dispatches) · **V62-AUTH-03**
TARGET_REPLACEMENT refused at creation (UNSUPPORTED_CHANGE); no waiver/config bypass ·
**V62-AUTH-04** no receipt/view/report claims preservation of unnamed state for a
full-list-replacement dispatch; target-state equality is not preservation evidence ·
**V62-AUTH-05** scope/capability validated at creation AND commit over both stored
declaration sites (shared with §6.18).

Runtime proposal validation (§6.18): **V62-RTV-01** shared runtime validation at
creation (first statement) and over the stored record at commit (after §6.10 replay,
before re-preview/attempts/dispatch) · **V62-RTV-02** guaranteeMode: omitted ⇒
REVALIDATE; only EXACT/REVALIDATE valid; explicit null invalid · **V62-RTV-03**
envelope shape: plain object, only the three named bounds, finite non-negative numbers,
own-property reads only; only undefined is omission · **V62-RTV-04**
reconcileCommittedEffect never throws: malformed envelope post-commit classifies
VIOLATED through interpretable bounds, else UNVERIFIED, never OK · **V62-RTV-05**
envelope-presence enforcement at creation after effectiveIntent support checks
(UNSUPPORTED_CHANGE precedence) · **V62-RTV-06** DATE `at` must be a Date.parse-able
string; quantity 0 accepted and left to provider semantics.

Identity binding & unit comparability (§3.16/§6.19): **V62-IDU-01** pre-dispatch
foreign reads refuse (CONFIRMED_NON_EXECUTION, zero attempts) · **V62-IDU-02**
post-dispatch foreign data is never evidence (never VERIFIED/OK, never
CONFIRMED_NON_EXECUTION for dispatched work) · **V62-IDU-03** shared-hook
expected-subscription check (state:subscriptionIdentity) binds establishment ·
**V62-IDU-04** unit comparability is a per-dimension precondition: established
contradiction ⇒ VIOLATED on the contradiction; numeric violation only on
established-and-compatible dimensions; unestablishable participating currency ⇒
UNVERIFIED (masked numeric differences land there) · **V62-IDU-05** the same
precondition governs the gate's reason, the malformed-envelope projection, the
no-envelope path, and store recomputation · **V62-IDU-06** the defined_equal_exact
label excuses absent unit statements only, never contradicting ones (P16-3).

Receipt evidence (§6.15/§6.16, PR #27): **V62-EVD-09** later establishment is
append-only and identity-bound; candidate equality is NOT an admissibility or identity
condition (A-17-1/A-17-2) · **V62-EVD-10** admissibility / establishment / promotion are
separate determinations; admissible-but-partial/state-unverifiable/conflicted evidence
records without promoting · **V62-EVD-11** the current view is derived, never authored;
recovery never trusts a persisted view (deep-equal or whole-set refusal); appends are
atomic at the stated boundary; legacy one-transition trails normalize and re-derive ·
**V62-EVD-12** conflicts append + flag, never substitute; a standing conflict pins the
view COMMITTED_UNVERIFIED with UNVERIFIED reconciliation · **V62-EVD-13**
verified-with-violation is a first-class, distinguishable promoted outcome (recomputed
vs the original quote + envelope, never the candidate) · **V62-EVD-14**
cross-observation promotion coherence: the promotion basis must share ONE
observed-state identity; identity-less entries cannot join a cross-entry basis;
single-entry basis unchanged · **V62-EVD-15** identity existence: an observed-state
identity exists only when snapshot id AND version are each established non-empty
strings (degenerate revisions stamp no identity); recovery refuses entries carrying
the two enumerable old-rule degenerate digests.

Durable behavior (§6.16): **V62-DUR-01** verbatim original-receipt replay after restart ·
**V62-DUR-02** receipt identity digest; conflicts refuse, originals preserved ·
**V62-DUR-03** whole-set coherence validation at recovery; corrupt sets refused whole ·
**V62-DUR-04** write-ahead intent + DISPATCHING in one transaction; at-most-once dispatch
per authorization · **V62-DUR-05** idempotency-key uniqueness and request-hash binding; terminal COMMITTED_*
serves its recorded outcome and is never re-armed; CONFIRMED_NON_EXECUTION is the sole
bounded re-dispatch exception (one re-dispatch per settlement, §6.16 gates) ·
**V62-DUR-06** same-subscription exclusion enforced in-transaction · **V62-DUR-07**
DISPATCHING recovers INDETERMINATE, never auto-retried · **V62-DUR-08** coordinator/store
binding enforced at wiring · **V62-DUR-09** recorded receipts immutable; transitions
supersede the view only · **V62-DUR-10** no exactly-once provider-execution claim.

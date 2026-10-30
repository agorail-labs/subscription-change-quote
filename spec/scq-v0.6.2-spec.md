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
quote/receipt/attempt storage with write-ahead dispatch.

**Relationship to the implementation.** The normative text below was written against the
merged implementation on `main` (PRs #8, #10–#11, #13–#20) and agrees with it, except where a
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
  v0.6.2 this means the **original recorded receipt**: if the receipt has since been
  superseded by a verification transition (§6.15), a replaying caller still receives the
  receipt as originally recorded; the current verified view is exposed only through
  separate store reads.
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
candidate is part of the recorded receipt's canonical identity (§6.16) and MUST NOT be
silently replaced, recomputed, or dropped before that verification. A candidate is NOT
compliance evidence: no envelope assessment (§6.13) and no reconciliation (§6.14) may
treat it as DETERMINED or established, and it can never by itself produce
reconciliation OK or a verified transition. What establishes the dimension later is
the §6.15 upgrade procedure — independent post-commit evidence whose committed figures
must EQUAL the recorded candidate amounts; evidence about different figures is refused
as a conflicting receipt identity, and the recorded receipt is never rewritten.
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
  without establishing evidence does not verify.
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
  VIOLATED — "verified" means *measured*, not *within tolerance*).

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
  | "CONFLICTING_RECEIPT_IDENTITY";   // v0.6.2 NEW — receipt-identity conflicts (§6.16)
```

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
  under §3.10/§3.11. An unenforceable dimension (UNKNOWN on either side, an invalid
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

**6.13 (v0.6.2 NEW — fail-closed envelope enforcement; BC-1)** `checkAcceptanceEnvelope`
(pre-mutation) and `reconcileCommittedEffect` (post-commit) share ONE per-dimension,
per-side assessment (`assessEnvelopePair`), so the gate and the reconciliation can never
develop parallel interpretations of §3.10/§3.11. The report-only diagnostic
`auditDeterminacy` applies the same rules and changes no verdict.

- A dimension is **comparable** iff both sides are DETERMINED with finite values and
  role-appropriate provenance: quote-role sides require the dimension's provenance note;
  the committed role additionally requires an establishing `committedSource`
  (`provider_actual` or `defined_equal_exact`).
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
   whose committed value exceeds the envelope. Precedence: an established violation is
   reported even when another dimension remains unestablished — a proven violation is
   never downgraded by an unrelated unknown.
2. **UNVERIFIED** — no established violation, but at least one dimension cannot be
   established (UNKNOWN on either side, an invalid DETERMINED value, committed figures
   of estimate or unestablished provenance, an unjustified NOT_APPLICABLE, or a
   NOT_APPLICABLE over a present field). Compliance was not proven, so OK is not
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
this purpose.

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
  established actuals. COMMITTED_UNVERIFIED requires landing established by the same
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
- **Upgrading a COMMITTED_UNVERIFIED receipt.** The transition to COMMITTED_AND_VERIFIED
  happens only through the store's establishment procedure
  (`establishVerification` → `verifyCommitReceipt`), which:
  - accepts only evidence minted from an INDEPENDENT post-commit `ProviderObservation`
    (a read of provider-side state after the commit, naming the quote's subscription,
    whose committed figures carry an establishing source, and which is not the quote's
    own quoted effect relabeled);
  - computes the §6.12 state verification and the §6.14 reconciliation FROM the
    observation — the caller never asserts either verdict;
  - brands the resulting evidence token (module-private brand); a caller-constructed
    object with identical fields is self-asserted and refused, as is a token whose
    contents were altered after minting (the store re-validates the token against the
    recorded receipt);
  - requires the evidence's committed figures to equal the amounts RECORDED on the
    receipt at commit time (a VIOLATED outcome is expressed through reconciliation,
    never by substituting different figures) — where the recorded amount is a §3.10
    candidate, this equality is the comparison the candidate exists for: the
    independent evidence must confirm the candidate's figures exactly, and a candidate
    that independent evidence contradicts can never be upgraded on this record;
  - refuses transitions whose recomputed reconciliation is UNVERIFIED, and refuses
    non-VERIFIED state results.
  A successful transition ends in exactly one of two terminal shapes, both with outcome
  COMMITTED_AND_VERIFIED: reconciliation OK, or reconciliation VIOLATED. The original
  recorded receipt is never overwritten (§3.9 replay rule; §6.16 immutability).
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
- **Receipt identity.** Each recorded receipt has a canonical identity (the tuple of
  receiptId, quoteId, subscriptionId, recorded outcome, recorded reconciliation status,
  and recorded committed figures) with a digest verified at recording and at recovery.
  Reusing an identity under different content, or a persisted record whose fields no
  longer match its recorded digest, is a `CONFLICTING_RECEIPT_IDENTITY` refusal. The
  original record is always preserved; identity is never resolved by overwriting.
- **Recovery coherence.** On adoption after restart, the whole recovered set is
  validated for coherence (record↔quote association, recorded-state legality,
  verification-trail coherence, per-record integrity digests). Any failure refuses the
  WHOLE set — partial adoption of a corrupt record set is prohibited — and every read /
  replay egress validates the records it serves.
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
  transaction, bound to the full identity (provider, site, subscription, quote), not
  merely asserted by callers beforehand.
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
| (new) | §3.10/§3.12 candidate clarification (SPEC3 correction): an UNKNOWN committed dimension on a COMMITTED_UNVERIFIED receipt MAY carry a labeled, non-establishing **candidate** (source disclosed; `committedSource: "unestablished"`; part of the recorded receipt's identity; established later only by §6.15 evidence equal to the recorded candidate). An earlier draft of this candidate stated the no-number rule categorically for UNKNOWN and required committed effects to contain only established figures — wording that declared the merged adapters' deliberate candidate construction (PR #10/#11 doctrine, present in all five adapters) nonconforming. The categorical rule is unchanged for quote/revalidated roles and for §6.13 enforcement. |
| (new) | NEW §3.13/§6.12: provider-neutral post-commit state-verification contract (verdicts, coverage, multiset tuples, partial/malformed handling, scheduled-cancel timing incl. premature-termination and SV6 classification, constant-false boundary fields). |
| §4.1 EXACT scope | Unchanged; v0.6.2 note ties EXACT establishment to §3.11. |
| §4.2 REVALIDATE | Clarifications preserved; NEW fail-closed determinacy paragraph (§6.13 summary). |
| §4.3 Coverage levels | Unchanged. |
| §5 Coverage resolution | Unchanged. |
| §6.1–6.10 | Unchanged (6.10 replay wording aligned to "original recorded receipt"). |
| §6.11 Reconciliation | Extended by §6.14: precedence VIOLATED > UNVERIFIED > OK; no-envelope case stated explicitly; legacy receipts never re-reconciled to OK. |
| (new) | NEW §6.12 state verification; NEW §6.13 fail-closed enforcement (shared assessment, refusal shape, no-intent guarantee); NEW §6.15 outcomes/attribution/recovery/upgrade procedure; NEW §6.16 durable behavior (SQLite/WAL informative only), including the key/hash binding rules with the sole CONFIRMED_NON_EXECUTION re-dispatch exception (SPEC2). |
| §7 Multi-change | Unchanged, plus the N/A-licensing consequence note. |
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
§6.15 evidence whose figures equal the recorded candidate; on quote/revalidated roles
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

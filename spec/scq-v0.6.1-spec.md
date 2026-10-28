# SCQ v0.6.1 — Normative Specification (Standards-Hardening Cycle)

Status: **Review-ready**, pending external protocol review. This document specifies the
Subscription Change Quote (SCQ) protocol as validated against four billing providers (Stripe,
Paddle, Zuora, Chargebee) across seven research cycles (v0.1–v0.6.1) plus one live-API
validation cycle against Chargebee (v0.5-LIVE). It is normative: an implementation that
violates a MUST/MUST NOT below is not a conforming SCQ provider adapter, regardless of whether
its native API would technically allow the violating behavior.

v0.6.1 is a standards-hardening cycle over the v0.6 freeze candidate: it adds no providers, no
actions, and no major schema concepts. It narrows imprecise EXACT wording, clarifies REVALIDATE
semantics under `BEST_EFFORT` consistency, makes quote expiration and commit idempotency
explicit normative rules (both already implemented since earlier cycles, now stated precisely
and — for idempotency — completed with the receipt-replay behavior that was previously
incomplete), closes several conformance-suite gaps, and corrects one internal wording
contradiction in §5. See §8 for the full v0.6→v0.6.1 diff.

This spec describes the protocol as it exists in code today
(`src/core/types.ts`, `src/core/scq-engine.ts`). It does not re-derive rationale already
recorded in `research-findings.md` — that document is the "why," this document is the "what,"
and `conformance.md` is the "how do I know an implementation obeys the what."

---

## 1. Scope

SCQ normalizes exactly one lifecycle: **quote → commit** for a bounded set of subscription
change types, across providers that expose subscription billing APIs. It is explicitly NOT:

- A subscription creation protocol (subscriptions must already exist).
- A payment or refund protocol.
- An authorization, consent, or agent-identity protocol.
- A negotiation protocol (proposals are accepted or refused, not counter-offered).
- A usage-billing or metered-consumption protocol.
- A procurement or contract-negotiation protocol.

The four supported change actions are fixed for this freeze candidate:

```
CHANGE_QUANTITY | CHANGE_PLAN | CHANGE_CADENCE | CANCEL
```

Adding a fifth action, or a fifth provider, is out of scope for this document and would require
a new minor version.

---

## 2. Core Lifecycle

```
getSubscription(id) -> SubscriptionSnapshot
createChangeQuote(id, proposal) -> SubscriptionChangeQuote
commitChangeQuote(quoteId) -> SubscriptionChangeReceipt
getCapabilities() -> ProviderCapabilities
```

- `getSubscription` MUST NOT mutate provider state.
- `createChangeQuote` MUST NOT mutate provider state, in any guarantee mode. (This is stronger
  than "no financial mutation" — it means no state transition of any kind, including scheduling
  a future change, is permitted at quote time.)
- `commitChangeQuote` performs exactly one mutating operation against the provider (or refuses
  with no mutation at all — see §6).
- `getCapabilities()` is pure and provider-instance-scoped, not subscription-scoped (see §5 for
  the distinction between provider-level and quote-level capability reporting).

---

## 3. Types

### 3.1 `EffectiveIntent` (v0.6)

```ts
type EffectiveIntent =
  | { type: "IMMEDIATE" }
  | { type: "TERM_END" }
  | { type: "DATE"; at: string };  // ISO 8601
```

Every `SubscriptionChangeProposal` MUST carry exactly one `EffectiveIntent`, applying to every
change in the proposal's `changes[]` array (SCQ v0.6 does not support per-change effective
timing within one proposal — see §9, unresolved issue U-3).

- `IMMEDIATE`: apply as soon as the commit call executes.
- `TERM_END`: apply at the current billing term's natural boundary, as determined by the
  provider (the caller does not — and in general cannot — supply the resulting date).
- `DATE`: apply at a caller-specified instant.

A provider adapter MUST reject an `EffectiveIntent` type it cannot honor for the requested
action, via `enforceEffectiveIntent` (§6.4), before any preview or mutating call. It MUST NOT
silently substitute a different intent (e.g. silently treating a rejected `DATE` request as
`IMMEDIATE`).

**Rationale for replacing v0.5's `requestedEffectiveAt?: string`:** a bare optional timestamp
could not distinguish "run this now" from "schedule this for a specific future instant" from
"defer this to whenever the current term happens to end" — three semantically and mechanically
different requests that, on Zuora and Chargebee, invoke different native code paths
(`effectiveDate` vs `end_of_term=true` boolean vs `effective_from` timestamp on Chargebee
specifically). v0.5 additionally had a duplicate, inconsistently-populated `effectivePolicy`
field on some `ChangeSpec` variants. v0.6 unifies both into one required, closed-union field.

### 3.2 `ChangeSpec`

```ts
type ChangeSpec =
  | { action: "CHANGE_QUANTITY"; itemId: string; quantity: number }
  | { action: "CHANGE_PLAN"; itemId: string; offeringRef: string }
  | { action: "CHANGE_CADENCE"; cadence: "MONTHLY" | "ANNUAL" }
  | { action: "CANCEL" };
```

No `ChangeSpec` variant carries its own effective-timing field as of v0.6 — that concern lives
exclusively on the proposal's `effectiveIntent` (see §9, U-3, for why this is an accepted
limitation rather than a design defect).

### 3.3 `SubscriptionChangeProposal`

```ts
type SubscriptionChangeProposal = {
  changes: ChangeSpec[];
  effectiveIntent: EffectiveIntent;
  guaranteeMode?: GuaranteeMode;               // default: REVALIDATE
  acceptanceEnvelope?: AcceptanceEnvelope;      // required for REVALIDATE unless all changes are CANCEL
};
```

- `changes` MUST contain at least one entry.
- `changes.length > 1` invokes multi-change consistency rules (§7).

### 3.4 `GuaranteeMode` and `GuaranteeCoverage`

```ts
type GuaranteeMode = "EXACT" | "REVALIDATE";

type GuaranteeCoverage = {
  immediateFinancialEffect: "EXACT" | "REVALIDATE";
  recurringFinancialEffect: "EXACT" | "REVALIDATE";
  termEffect: "EXACT" | "UNKNOWN";
  effectiveAt: "EXACT" | "REVALIDATE";
};
```

- `REVALIDATE` is the protocol-wide default (since v0.3) when `guaranteeMode` is omitted.
- `EXACT` MUST be capability-scoped: an adapter MUST refuse (not silently downgrade) an overall
  `EXACT` request for any change/action combination where the AUTHORITATIVE coverage (§5) does
  not report `EXACT` on **every** dimension. The refusal error (`UNSUPPORTED_CHANGE`) MUST name
  the specific failing dimension in `err.details.failingDimension`.
- `termEffect` has no `REVALIDATE` value, by design: there is no non-mutating way to "re-check"
  a term/contract consequence the way there is for a financial amount. A provider that cannot
  determine term effect deterministically MUST report `UNKNOWN`, not attempt a weaker
  in-between value.

### 3.5 `ActionCapabilities` (v0.6)

```ts
type ActionCapabilities = {
  guaranteeCoverage: GuaranteeCoverage;
  supportedEffectiveIntents: Array<EffectiveIntent["type"]>;
};

type QuoteCapabilities = Partial<Record<ChangeAction, ActionCapabilities>>;
```

v0.6 wraps the v0.4/v0.5 bare `GuaranteeCoverage` value in `ActionCapabilities` so that
per-action `EffectiveIntent` support can be discovered the same way guarantee coverage is
discovered — through `getCapabilities()`, before ever constructing a proposal that would be
refused.

### 3.6 `ConsistencyGuarantee` and `MultiChangeConsistency`

```ts
type ConsistencyGuarantee = "ATOMIC" | "BEST_EFFORT";
type MultiChangeConsistency = "ATOMIC" | "BEST_EFFORT" | "UNSUPPORTED";
```

- `ConsistencyGuarantee` describes whether SCQ's own precondition-check-then-mutate sequence is
  provider-backed atomic. **No adapter validated in this research (Stripe, Paddle, Zuora,
  Chargebee — including live Chargebee testing) has ever reported, or may ever report, `ATOMIC`
  for this field.** All four MUST report `BEST_EFFORT`.
- `MultiChangeConsistency` describes whether bundling `changes.length > 1` into one commit is
  atomic, best-effort-sequential, or must be refused outright. It is computed pairwise across
  every pair of changes in a batch, taking the weakest pairwise result (§7).

### 3.7 `SubscriptionChangeQuote`

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

### 3.8 `SubscriptionChangeReceipt`

```ts
type ReconciliationResult =
  | { status: "OK" }
  | { status: "VIOLATED"; reason: string };

type SubscriptionChangeReceipt = {
  quoteId: string;
  subscriptionRef: string;
  status: "COMMITTED";
  resultingSnapshot: SubscriptionSnapshot;
  quotedEffect: CommercialEffect;      // immutable historical record from quote time
  committedEffect: CommercialEffect;   // what was actually true at mutation time
  guaranteeMode: GuaranteeMode;
  consistencyGuarantee: ConsistencyGuarantee;
  multiChangeConsistency: MultiChangeConsistency;
  reconciliation: ReconciliationResult;  // v0.6.1, NEW — see §6.11
  committedAt: string;
};
```

- A receipt MUST always carry both `quotedEffect` and `committedEffect`, regardless of
  guarantee mode.
- For `EXACT`: `quotedEffect` MUST deep-equal `committedEffect`.
- For `REVALIDATE`: `quotedEffect` and `committedEffect` MAY legitimately differ; the receipt is
  the audit trail of both, not just the final number.
- A receipt MUST NOT carry any field named `commercialEffect` or `revalidatedEffect` (retired
  v0.2 names — retained only as a negative conformance check, see `conformance.md` C-8).
- **(v0.6.1, NEW)** A receipt MUST always carry a `reconciliation` field, regardless of
  guarantee mode — see §6.11. `{status: "OK"}` covers both "REVALIDATE and reconciled cleanly"
  and "nothing to reconcile" (EXACT, or REVALIDATE with no applicable envelope); a caller must
  never need to branch on `guaranteeMode` before reading this field.
- **(v0.6.1, NEW)** A repeated `commitChangeQuote` call against a quote_id that has already been
  successfully committed MUST return the EXACT SAME receipt object/value as the first successful
  commit, and MUST NOT perform a second provider mutation — see §6.10.

### 3.9 Error Codes

```ts
type SCQErrorCode =
  | "SUBSCRIPTION_NOT_FOUND"
  | "UNSUPPORTED_CHANGE"        // single change/action/mode unsupported by this provider
  | "UNSUPPORTED_CHANGE_SET"    // v0.6: bundle risks silent partial application (§6.5)
  | "INVALID_PROPOSAL"
  | "QUOTE_NOT_DETERMINISTIC"
  | "QUOTE_EXPIRED"
  | "QUOTE_STALE"
  | "CHANGE_CONFLICT"
  | "PROVIDER_ERROR"
  | "QUOTE_DRIFTED";
```

`UNSUPPORTED_CHANGE_SET` is new in v0.6 and is distinct from both `UNSUPPORTED_CHANGE` (this
single change, action, or guarantee mode is not supported at all) and
`MultiChangeConsistency: "UNSUPPORTED"` (this specific combination of changes cannot be
attempted together in any form). `UNSUPPORTED_CHANGE_SET` specifically covers: *the provider
might ACCEPT a bundled request that combines these changes, but may silently apply only a
subset of them* — see §6.5.

---

## 4. Guarantee Semantics

### 4.1 EXACT — SCOPE NARROWED (v0.6.1)

**v0.6.1 wording correction (no schema or enforcement-logic change — see §8):** `EXACT` on a
given `GuaranteeCoverage` dimension guarantees ONLY that specific named dimension
(`immediateFinancialEffect`, `recurringFinancialEffect`, `termEffect`, or `effectiveAt`) is
reproduced exactly between quote and commit. It is emphatically NOT a guarantee that the
quote's `CommercialEffect` is a complete accounting of every consequence of the change, and it
makes NO claim whatsoever about any dimension `CommercialEffect` does not model as a field —
most importantly **tax, discounts, currency-conversion effects, or any other commercial
adjustment applied by the provider as a step separate from the pinned computation**. Prior
cycles' prose ("the commit is guaranteed to reproduce the quoted commercial effect exactly")
was broader than what any adapter's mechanism actually backs, and could be misread by an
integrator as a whole-invoice guarantee. This section replaces that prose with the corrected,
narrower claim below. No adapter's actual EXACT mechanism changed — Stripe's, Zuora's, and
Chargebee's `proration_date`/`effectiveDate`/`effective_from` pinning already only ever
computed the specific dimensions `GuaranteeCoverage` models; this correction brings the WORDING
in line with what those mechanisms have always actually done.

The corrected claim: for any dimension where `GuaranteeCoverage` reports `"EXACT"`, the commit
is guaranteed to reproduce EXACTLY the value of THAT DIMENSION as computed at quote time.
Mechanically, an adapter achieves this either by:

- Pinning a wall-clock-dependent computation basis at quote time and replaying it verbatim at
  commit time (Stripe's `proration_date`), or
- Having order/estimate math that is inherently a pure function of an explicit, caller-supplied
  instant rather than ambient "now" (Zuora's `effectiveDate`, Chargebee's `effective_from`).

EXACT MUST be requested and enforced per the full `GuaranteeCoverage` (all four dimensions), not
per financial dimension alone (this was a v0.3→v0.4 correction — see `research-findings.md`
v0.4 for the concrete Stripe termEffect regression this closed). This rule is UNCHANGED by
v0.6.1 — the correction above narrows what "EXACT" on any ONE of those four dimensions means; it
does not relax which dimensions must all read EXACT for an overall EXACT request to be honored.

### 4.2 REVALIDATE (default) — CLARIFIED (v0.6.1)

The commit re-derives the commercial effect against live state and MUST refuse (with
`QUOTE_DRIFTED`, and **no mutation**) if the re-derived effect falls outside the caller's
supplied `AcceptanceEnvelope`. REVALIDATE is the ONLY mechanism available for actions where no
EXACT-backing mechanism exists (e.g. Paddle `CHANGE_QUANTITY`, which has no `proration_date`
equivalent).

**v0.6.1 clarification 1 — WHEN the envelope check runs:** the `AcceptanceEnvelope` is enforced
against the LAST PRE-MUTATION PREVIEW — i.e. the freshest non-mutating re-computation the
adapter can obtain immediately before the mutating call, NOT the original quote-time
computation (that would defeat the purpose of re-validating at all) and not some later,
already-mutated state (there is no non-mutating "preview" of a state that has already changed).
This was always the reference adapters' actual behavior (see the `commitChangeQuote` "Order per
spec: re-preview -> evaluate acceptance envelope -> mutate" comment present in every adapter
since v0.2); this clarification makes it explicit spec text rather than only inferable from the
adapters' comments.

**v0.6.1 clarification 2 — what the pre-mutation check does NOT cover:** because
`ConsistencyGuarantee` is `BEST_EFFORT` for every provider validated in this research (§3.6),
SCQ CANNOT guarantee that a concurrent write does not land in the window between the last
pre-mutation preview and the mutating call itself, and therefore cannot guarantee the envelope
check performed before mutation still describes what is actually true immediately after
mutation. This is the same TOCTOU gap documented since v0.2 (§6.3), applied specifically to the
envelope check rather than only to the fingerprint/staleness check.

**v0.6.1 clarification 3 — post-commit reconciliation is now REQUIRED (NEW normative rule, see
§6.11):** because of clarification 2, an adapter MUST, immediately after a REVALIDATE mutating
call returns, re-check the ACTUALLY-committed effect (`committedEffect`) against the SAME
envelope, and MUST surface a clear reconciliation failure (via the receipt's new
`reconciliation` field, §3.8) if the committed outcome violates it. This is a REPORTING
obligation only — the mutation has already happened by this point and reconciliation cannot
undo it — but the caller MUST be able to distinguish "this REVALIDATE commit's actual outcome
was independently re-confirmed to be within my stated tolerance" from "it was checked before
mutation and I am trusting that nothing changed in between."

A REVALIDATE proposal MUST supply an `AcceptanceEnvelope` unless every change in the proposal is
`CANCEL` (a CANCEL-only batch has no financial envelope to bound, by definition of the four
supported actions — its only field-worthy consequence is `termEffect`, which REVALIDATE cannot
express anyway per §3.4). Omitting the envelope in any other case MUST be refused with
`INVALID_PROPOSAL`, not silently defaulted to an unbounded envelope. Per §6.11, when no envelope
applies (CANCEL-only), post-commit reconciliation reports `{status: "OK"}` rather than a
fabricated violation.

### 4.3 Quote-level vs. provider-level coverage (v0.5, preserved)

`getCapabilities().quoteCapabilities` is coarse and general — "what MIGHT this provider do for
this action, in general." `quote.guaranteeCoverage` is state-aware and authoritative — "what CAN
this specific quote, against this specific subscription's actual state, guarantee." The two
values MAY legitimately diverge (e.g. Zuora's coarse CANCEL report says `termEffect: UNKNOWN`
because a committed-term subscription might exist; a specific quote against an evergreen
subscription resolves `termEffect: EXACT`). This divergence is by design, not drift — the
enforcement gate (`enforceGuaranteeRequest`) checks ONLY the quote-level value.

An adapter MUST NOT let its coarse provider-level report ever advertise a stronger guarantee
than any individual quote could actually deliver (i.e. coarse coverage is always the *floor*,
never optimistic).

---

## 5. Authoritative Coverage Resolution

**v0.6.1 wording clarification (no behavior change — see §9a below):** this spec uses "before
any provider call" loosely in several places (§6.4, §6.7, §6.8, §7.2) to mean, precisely,
*before any call that PREVIEWS or MUTATES the proposed change*. It does NOT mean before the
one non-mutating READ of the subscription's current state that `createChangeQuote` always
performs first (`getSubscription`-equivalent), because that read is exactly what makes the
state-aware override in step 4 below possible at all — a quote-level `guaranteeCoverage` cannot
be authoritative (§4.3) without first reading the actual subscription it is being computed
against. Every normative rule below that says "before any provider call" refers only to the
provider's PREVIEW and MUTATING operations (e.g. Stripe's `previewUpcomingInvoice`/`update`,
Zuora's `previewOrder`/`createOrder`), never to the initial state read. Adapters have always
implemented it this way; this note only makes the spec's wording match what the reference
adapters already do.

For every `createChangeQuote` call, an adapter MUST:

1. Perform ONE non-mutating read of the subscription's current state (this is the "provider
   call" the notes above exclude from every later "before any provider call" rule).
2. Compute per-change `ActionCapabilities` for each entry in `changes[]`, and apply any
   subscription-state-specific override the adapter defines (e.g. Chargebee's and Zuora's
   `CANCEL`-termEffect resolution being conditional on whether the subscription carries a
   committed term) — using ONLY the state read in step 1, no further reads yet.
3. Validate `proposal.effectiveIntent.type` against each change's `supportedEffectiveIntents`
   (§6.4) — before any preview or mutating call.
4. Combine per-change `GuaranteeCoverage` values into one quote-level value via
   `computeCombinedCoverage` (weakest-per-dimension across the batch), reflecting any override
   from step 2.
5. Enforce the requested `guaranteeMode` against the resulting quote-level coverage
   (`enforceGuaranteeRequest`), refusing with `UNSUPPORTED_CHANGE` (naming the failing dimension)
   if EXACT was requested but not fully backed — before any preview or mutating call.

(v0.6.1 renumbers this list solely to put the state-aware override, step 2, explicitly BEFORE
the coverage-combination step that depends on it, and to make the one-time state read in step 1
an explicit, separately-numbered step rather than an implicit precondition. The v0.6 reference
adapters' actual call order was already this order; only the spec's enumeration changes.)

---

## 6. Normative Rules (MUST / MUST NOT)

This section collects every normative rule referenced above plus the two rules new to v0.6, in
one place, for conformance-suite cross-referencing.

**6.1 (v0.1)** `getSubscription` and `createChangeQuote` MUST NOT mutate provider state.

**6.2 (v0.2)** `commitChangeQuote` MUST validate the subscription's current version/fingerprint
against the quote's captured precondition before performing any mutating call, and MUST refuse
with `QUOTE_STALE` (no mutation) if it has changed.

**6.3 (v0.2)** No adapter MAY use an adapter-local lock, mutex, or semaphore to simulate atomic
state-precondition-then-mutation. The TOCTOU race window between validation and the mutating
call MUST be left genuinely present if the underlying provider API has no server-side
compare-and-swap precondition — SCQ's job is to report `BEST_EFFORT` honestly, not to hide the
race with client-side synchronization that a real production deployment (with multiple SCQ
instances) could not replicate.

**6.4 (v0.3, per-dimension)** An overall `EXACT` request MUST be refused, before any provider
call, for any change/action where the AUTHORITATIVE (quote-level) `GuaranteeCoverage` does not
report `EXACT` on every one of its four dimensions. The refusal MUST identify the specific
failing dimension.

**6.5 (v0.3)** `getCapabilities()` MUST NOT advertise a guarantee that actual enforcement would
refuse for a request built directly from that advertisement (checked by direct cross-check
tests — Test 8h, Test 9j, Test 11h).

**6.6 (v0.3)** Every `SubscriptionChangeReceipt` MUST carry `guaranteeMode` and
`consistencyGuarantee`; neither may be omitted regardless of guarantee mode taken.

**6.7 (v0.6, NEW — EffectiveIntent enforcement)** An adapter MUST validate
`proposal.effectiveIntent.type` against each targeted change's `supportedEffectiveIntents`
before any preview or mutating call, and MUST refuse with `UNSUPPORTED_CHANGE` (not silently
substitute a different intent) if unsupported.

**6.8 (v0.6, NEW — no silent partial execution)** If an adapter accepts a multi-change proposal
(`changes.length > 1`), it MUST NOT submit that proposal to the underlying provider API if doing
so risks the provider silently applying only a SUBSET of the requested changes while still
returning success. Where this risk exists, the adapter MUST refuse with `UNSUPPORTED_CHANGE_SET`
**before any mutating call**, rather than let ambiguous partial application occur. This rule was
directly motivated by a live-confirmed Chargebee behavior: `update_for_items`/`cancel_for_items`
silently ignore unrecognized request parameters and still return HTTP 200 — meaning a
malformed or partially-understood bundled request would not surface as an error at all. No
current adapter's normal call construction is capable of reaching this failure mode (each
either bundles into a genuinely atomic single call, or refuses the combination outright via
`MultiChangeConsistency: "UNSUPPORTED"` before ever calling the provider) — see
`conformance.md` C-14 for how this is still tested despite being currently unreachable.

**6.9 (v0.6)** The Chargebee committed-term `CANCEL` case MUST report `guaranteeCoverage.
termEffect: "UNKNOWN"`, not `"EXACT"`. This retracts a v0.5 simulator-only claim (see §8).

**6.10 (v0.6.1, NEW — quote expiration and commit idempotency)** Two related rules:

- **Expiration:** a `commitChangeQuote` call attempted after `validUntil` has passed MUST fail
  with `QUOTE_EXPIRED`, and MUST NOT perform any provider mutation. This was already true of
  every reference adapter's behavior via `validateCommit`'s expiry check (present since v0.2);
  it is elevated to an explicit top-level normative rule here because expiration and idempotency
  interact in a way worth stating precisely: expiration applies ONLY to a commit ATTEMPT on a
  quote that was NEVER successfully committed. A quote that committed successfully before its
  `validUntil` passed remains validly committed forever after — `validUntil` bounds how long a
  quote may sit un-committed, not how long its receipt remains valid once issued.
- **Idempotency:** a repeated `commitChangeQuote` call against a `quoteId` that has ALREADY been
  successfully committed MUST NOT apply the change a second time, and MUST return the ORIGINAL
  receipt from the first successful commit — not a re-derived, re-fetched, or newly-timestamped
  one. This check MUST be performed BEFORE any read of live provider state or any mutating call,
  so that a caller retrying a commit purely out of response-delivery uncertainty (the mutation
  succeeded but the caller never received confirmation) can never cause a second mutation.
  Idempotent replay MUST succeed even if: (a) the subscription has since drifted further
  out-of-band (irrelevant — the receipt already describes a completed, historical commit), or
  (b) the quote's `validUntil` has since passed (per the expiration rule above, this does not
  retroactively un-commit an already-committed quote).

**6.11 (v0.6.1, NEW — post-commit reconciliation)** Every REVALIDATE commit MUST re-check
`committedEffect` against the proposal's `acceptanceEnvelope` (using the SAME envelope the
pre-mutation check used) immediately after the mutating call returns, and MUST surface the
result via the receipt's `reconciliation` field (§3.8/§4.2 clarification 3). A `"VIOLATED"`
reconciliation result is a REPORTING obligation, not a re-authorization gate — the mutation has
already occurred and cannot be rolled back by this check. EXACT commits and REVALIDATE commits
with no applicable envelope (CANCEL-only) report `{status: "OK"}` rather than omitting the
field or fabricating a violation with no basis.

---

## 7. Multi-Change Consistency (v0.5, preserved)

For `changes.length > 1`:

1. `multiChangeConsistency` is computed pairwise across every pair of changes in the batch,
   taking the WEAKEST pairwise result (`ATOMIC` < `BEST_EFFORT` < `UNSUPPORTED` in strength,
   i.e. `UNSUPPORTED` wins if any pair reports it).
2. If the computed value is `UNSUPPORTED`, `createChangeQuote` MUST refuse with
   `UNSUPPORTED_CHANGE` before any preview call — the caller must split the proposal.
3. If `ATOMIC` or `BEST_EFFORT`, the quote and eventual receipt MUST report the computed value
   verbatim; `BEST_EFFORT` is not itself a refusal condition — it is a downgrade the caller is
   entitled to see and decide against.
4. Per Rule 6.8, an adapter MUST additionally refuse with `UNSUPPORTED_CHANGE_SET` (not proceed
   as `BEST_EFFORT`) if the specific combination risks silent partial application rather than
   a detectable one.

---

## 8. Schema Diff

### 8a. v0.5 → v0.6 (unchanged, restated for continuity)

| Change | v0.5 | v0.6 |
|---|---|---|
| Effective timing | `requestedEffectiveAt?: string` on proposal; inconsistent `effectivePolicy` on some `ChangeSpec` variants | Single required `effectiveIntent: EffectiveIntent` (closed union `IMMEDIATE \| TERM_END \| DATE`) on proposal only |
| Capability shape | `QuoteCapabilities = Partial<Record<ChangeAction, GuaranteeCoverage>>` | `QuoteCapabilities = Partial<Record<ChangeAction, ActionCapabilities>>`, where `ActionCapabilities = { guaranteeCoverage, supportedEffectiveIntents }` |
| Error codes | (none for partial-execution risk) | + `UNSUPPORTED_CHANGE_SET` |
| Engine functions | `enforceRequestedEffectiveAt` | Removed; replaced by `enforceEffectiveIntent` + new `enforceNoPartialExecutionRisk` |
| Chargebee committed-term CANCEL | `guaranteeCoverage.termEffect: "EXACT"` (simulator-only claim, never live-verified) | `guaranteeCoverage.termEffect: "UNKNOWN"` (retracted; explicitly `UNVERIFIED`, not designed around) |

### 8b. v0.6 → v0.6.1 (this cycle)

| Change | v0.6 | v0.6.1 |
|---|---|---|
| `SubscriptionChangeReceipt` | No `reconciliation` field | **+ `reconciliation: ReconciliationResult`** (`{status:"OK"}` \| `{status:"VIOLATED"; reason: string}`), always present, regardless of guaranteeMode |
| `ReconciliationResult` (NEW type) | — | `{ status: "OK" } \| { status: "VIOLATED"; reason: string }` |
| Engine functions | — | **+ `checkIdempotentReplay`** (commit idempotency, §6.10) and **+ `reconcileCommittedEffect`** (post-commit reconciliation, §6.11) |
| `StoredQuote` (internal store type, not part of the wire protocol) | No receipt cache | **+ `commit_receipt?: SubscriptionChangeReceipt`**, populated exactly once atomically with the `COMMITTED` status transition |
| EXACT wording (§4.1) | "commit reproduces the quoted commercial effect exactly" (unscoped prose) | Narrowed: EXACT on a dimension guarantees only that dimension; explicitly excludes tax/discounts/currency-conversion or any unmodeled effect. **No type or enforcement-logic change** — wording only. |
| REVALIDATE wording (§4.2) | Described the pre-mutation envelope check only | + 3 clarifications: envelope enforced against the LAST pre-mutation preview; BEST_EFFORT means a concurrent write can still alter the outcome after that check; post-commit reconciliation is now required (§6.11) |
| §5 "Authoritative Coverage Resolution" | Listed state-aware override (step 4) AFTER the "before any provider call" `effectiveIntent` check (step 2), reading as if the override could ignore state | Reordered/clarified: the one-time non-mutating state read is now an explicit step 1; "before any provider call" is defined precisely to mean "before any PREVIEW or MUTATING call," never before that initial read — no adapter behavior changed, only the spec's enumeration and definition |
| Everything else | — | **Unchanged.** No provider added or removed, no change action added or removed, no other type or field changed. |

No provider was added or removed in either diff. No change action was added or removed in
either diff. v0.6.1's schema addition (`reconciliation`) is the only new wire-visible field;
`commit_receipt` is an internal store-side cache, never serialized as part of any SCQ type.

---

## 9. Unresolved Issues (carried into external review)

See `conformance.md` §"Unresolved / Known Gaps" for the corresponding test-level framing. Full
list also duplicated in `research-findings.md`'s v0.6 and v0.6.1 sections.

- **U-1 — Committed-term CANCEL on Chargebee is UNVERIFIED**, not merely undocumented. No test
  site with Contract Terms enabled has been validated against real Chargebee behavior. The type
  system honestly reports `UNKNOWN`; this is not a defect, but it does mean the protocol cannot
  yet claim Chargebee has a genuine coverage advantage over Zuora for this specific case, which
  v0.5's simulator had claimed. **Unchanged by v0.6.1.**
- **U-2 — No adapter has ever reported, or is expected to ever report, `ConsistencyGuarantee:
  "ATOMIC"`.** The type retains both values for forward-compatibility with a hypothetical future
  provider that DOES expose a real compare-and-swap precondition (e.g. an `If-Match` header the
  server genuinely enforces), but as of v0.6.1 this is purely theoretical — zero of four
  validated providers support it, including after live API testing on one of them. v0.6.1's
  post-commit reconciliation rule (§6.11) is a direct, permanent consequence of U-2 remaining
  open: reconciliation exists precisely BECAUSE no provider can offer ATOMIC, so it is the best
  SCQ can do to keep a BEST_EFFORT commit's outcome from silently violating the caller's stated
  tolerance. **Unchanged by v0.6.1 — reconciliation mitigates its consequence, it does not close it.**
- **U-3 — `effectiveIntent` is proposal-level, not per-change.** A multi-change proposal cannot
  express "apply this quantity change immediately, but defer this plan change to term end" in
  one proposal. No real-provider requirement forced this cycle to add per-change effective
  timing (the "do not invent dimensions unless a real provider difference requires them"
  discipline from v0.4 applies here), but it is a known modeling ceiling, not an oversight.
  **Unchanged by v0.6.1.**
- **U-4 — Zuora's `CHANGE_CADENCE` term-interaction gap remains open** (documented since v0.4):
  a bare rate-plan-swap order action does not reliably surface whether it interacts with
  contract-term/renewal-anchor structure without an explicit accompanying
  `TermsAndConditions` order action, which SCQ still does not model. **Unchanged by v0.6.1.**
- **U-5 — Chargebee's `effective_from` vs `end_of_term` distinction is modeled** (via
  `EffectiveIntent.DATE` vs `.TERM_END`), closing the v0.5-LIVE gap — but only ONE of the two
  mechanisms (`end_of_term`) was independently re-verified against a fresh, isolated raw
  request/response pair during v0.5-LIVE; `effective_from` was verified via the original
  Experiment 2 pass only. Treat `DATE` support on Chargebee as verified-once, not
  extensively-verified. **Unchanged by v0.6.1.**
- **U-6 (RESOLVED this cycle, was open since v0.6)** — `UNSUPPORTED_CHANGE_SET` previously had
  no test that triggered it end-to-end, since no adapter's real call construction risks the
  failure mode it guards against. **Closed by a direct unit test against
  `enforceNoPartialExecutionRisk` in isolation** (Test 12h) — this validates the engine-level
  enforcement primitive without requiring a synthetic provider. The underlying absence of a
  REAL adapter code path that reaches this rule end-to-end is unchanged and is not itself a
  defect (see conformance.md).
- **U-7 (NEW, v0.6.1) — Post-commit reconciliation cannot prevent a violation, only report it.**
  This is by design (§6.11 is explicitly a reporting obligation, not a re-authorization gate —
  the mutation has already happened by the time reconciliation runs), but it means a caller
  relying solely on the pre-commit `QUOTE_DRIFTED` refusal path for safety should be aware a
  `reconciliation: {status:"VIOLATED"}` receipt is a DIFFERENT, weaker signal: the change WAS
  applied, and the caller must decide what to do about an already-completed commit that turned
  out to violate their envelope. SCQ does not (and, without a real provider-side
  compare-and-swap primitive per U-2, cannot) offer a mechanism to auto-compensate or reverse
  this.
- **U-8 (NEW, v0.6.1) — Idempotent replay uses `quoteId` as the sole idempotency key.** A caller
  that creates a SECOND, NEW quote for the same effective intent (rather than retrying a commit
  of the FIRST quote) is not protected by §6.10 — SCQ has no cross-quote deduplication
  mechanism, nor was one requested by this cycle's scope. This is a known limitation of
  idempotency as scoped, not an oversight: implementing cross-quote deduplication would require
  either a caller-supplied idempotency key (a new proposal field) or provider-side deduplication
  neither of which any of the four reference providers exposes in a way this research has
  validated, and adding either would exceed this cycle's explicit "no new schema concepts
  beyond the ones listed" scope.

None of U-1 through U-8 are blocking for an external protocol review — they are exactly the
kind of open questions a freeze candidate is expected to carry forward, each with an honest
UNKNOWN/UNVERIFIED marker (or, for U-7/U-8, an honest statement of scope) in the running code
rather than an invented answer.

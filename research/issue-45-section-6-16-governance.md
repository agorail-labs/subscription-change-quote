# Issue #45 — §6.16 governance note: namespace-aware dispatch exclusion

Status: **proposal for maintainer decision**. This note does not amend
`spec/scq-v0.6.2-spec.md`, which remains frozen. It records what the
current specification requires, why the reference implementation's
exclusion keying was over-broad, what the Issue #45 implementation PR
changes, and what remains for a specification decision.

## 1. What §6.16 currently requires

The normative clause (Same-subscription concurrency) reads:

> A second dispatch for a subscription with an unresolved attempt MUST
> be refused; the exclusion is checked inside the persistence
> transaction, not merely asserted by callers beforehand.

The clause's own reconciliation note then records the divergence:

> *(Reconciliation note — code governs: the reference implementation's
> blocking check keys on (quote_id OR subscription_id) and carries no
> provider/site predicate, so the same subscription id on two different
> sites mutually blocks — an over-broad, availability-side,
> fail-closed-direction divergence from the full-identity keying an
> earlier draft of this clause stated. Recorded as gap register G-21;
> the normative requirement is the in-transaction refusal, and the
> keying refinement is tracked, not silently claimed.)*

So the frozen text already establishes three things:

1. The MUST is the **in-transaction refusal** for "a subscription" —
   subscription identity is the clause's subject.
2. The `(quote_id OR subscription_id)` keying is recorded as the
   implementation's current state ("code governs" for v0.6.2), not as
   the clause's ideal.
3. Full-identity keying is named as the direction an earlier draft
   stated; the refinement is "tracked, not silently claimed" (G-21).

## 2. Why the current rule is over-broad

Subscription ids are provider-assigned within an account/site scope.
The same id string routinely denotes different subscriptions on
different providers, and on different sites of one provider. Keying
exclusion on the bare id therefore lets an unresolved attempt in one
unrelated namespace deny dispatch availability in another — an
availability-side interference with no safety benefit: the namespaces
cannot alias the same provider subscription, so no double-dispatch
risk is being prevented. The spec's note already classifies the
divergence as fail-closed-direction (safe, but wrong-grained).

## 3. What the Issue #45 implementation PR does

Branch `fix/issue-45-namespace-exclusion`; evidence suite test64
(9 tests) plus converted test56 pins.

- Exclusion identity becomes the tuple **(provider, site,
  subscription_id)**: a subscription-id-matched row is skipped only
  when the candidate and the row are *provably distinct* — both sides
  carry complete, non-empty provider and site values, and at least one
  of provider or site differs.
- Every other case keeps the historical block: same tuple; any
  missing, empty, or malformed provider/site on either side; legacy
  rows without a recorded site; any row matched by **quote id** (a
  quote's own unresolved attempt blocks it under any namespace claim).
- `assertQuoteNotStaleAfterLanding` applies the same rule: a
  reconciled landing stale-checks only candidates in its own
  namespace; a landing with an incomplete namespace still stale-checks
  everyone (conservative).
- Callers that state no namespace (direct `findBlockingAttempt` calls)
  keep the historical behavior — the refinement is opt-in by supplying
  the identity the caller holds.
- No schema change: attempt rows have always recorded provider and
  site. The persisted quote record carries provider but no site;
  provider disagreement between a dispatch intent and its stored quote
  was already refused pre-dispatch, and the site is intent-declared
  and pinned per idempotency key by the existing key-binding check.
  A same-quote unresolved attempt blocks under any site claim, which
  is what prevents site aliasing from becoming a replay path.

## 4. Proposed specification revision (for decision)

Two options; the implementation is compatible with both readings of
the normative MUST, so this is a text-governance decision, not a
behavior gate:

**Option A — v0.7 clause revision (recommended).** In the next
specification version, (i) replace the §6.16 reconciliation note with
a statement that exclusion is keyed on the full identity
(provider, site, subscription), with incomplete-namespace rows
blocking conservatively, and (ii) optionally promote the full-identity
keying from the note into the clause itself, since "a subscription"
is only well-defined within a provider/site namespace. G-21(3) then
closes as resolved-by-refinement.

**Option B — separately authorized v0.6.2 amendment.** The same note
replacement issued as an amendment to the frozen v0.6.2 text. This
requires the same explicit amendment authorization used for any
frozen-text change; nothing in the implementation PR presumes it.

Until one option is taken, the frozen note's "code governs" sentence
is stale in the divergence direction: the code now implements the
full-identity keying the note said an earlier draft stated. The
implementation PR states this plainly and does **not** claim the
frozen text was updated.

## 5. Consequences for existing durable stores

None structural. No migration is required or performed: the change
reads columns that already exist. Behavior changes only in the
availability direction, and only where two namespaces are provably
distinct; every same-tuple and every not-provably-distinct case
behaves exactly as before, including across restarts and for legacy
NULL-site rows. Published npm artifacts are unaffected (no
republication is proposed by this note).

## 6. Decision requested

Maintainer choice between Option A (fold into v0.7) and Option B
(authorized v0.6.2 amendment), or a decision to retain the broad
keying deliberately — in which case the implementation PR should be
reconsidered rather than merged against the spec's stated direction.

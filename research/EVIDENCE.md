# SCQ v0.6.1 — Evidence and Confidence Register

SCQ's evidence is deliberately split by confidence level. Provider behavior should not be described as live-validated unless it was actually observed against a real API.

## Confidence labels

- **LIVE CONFIRMED** — observed against a real provider test-site API.
- **DOCUMENTATION-BACKED SIMULATION** — implemented in a simulator based on documented provider mechanisms and tested against SCQ, but not exercised against live provider credentials in this project.
- **INFERRED** — architectural conclusion derived from documented surfaces or observed behavior, but not directly exercised end-to-end.
- **UNVERIFIED** — intentionally unresolved; SCQ reports `UNKNOWN`/unsupported rather than inventing an answer.

## Provider evidence summary

| Provider | Evidence level in this project | Important validated/observed areas |
|---|---|---|
| Stripe | Documentation-backed simulation | Preview/update normalization; `proration_date`-style time-basis pinning in the model; EXACT-vs-REVALIDATE distinctions; stale quote and TOCTOU behavior in simulation |
| Paddle | Documentation-backed simulation | Preview/update normalization; no modeled time-basis pin equivalent; REVALIDATE behavior; stale quote and TOCTOU behavior in simulation |
| Zuora | Documentation-backed simulation | Orders-style mutations; native subscription version; explicit effective dates; contract-term vocabulary; multi-action order batching; TOCTOU despite stronger staleness detection |
| Chargebee | **Live test-site API + simulator** | Estimate/commit agreement for tested cases; scheduling; resource-version behavior; absence of atomic conditional write in tested path; multi-change behavior; live silent partial-application hazard |

## Live Chargebee observations

### 1. Quantity change estimate matched commit

A real update estimate and real mutation produced the same immediate invoice total for the tested quantity change: **$840.00**.

The provider did not return a single authoritative “resulting recurring total” field; the adapter had to calculate the normalized recurring total from item-price/quantity data. That matched the existing SCQ adapter design rather than forcing a schema change.

**Confidence: LIVE CONFIRMED for the tested configuration.**

### 2. Estimate response shape varies

Chargebee returned different estimate structures depending on invoice behavior (`invoice_estimate` versus unbilled-charge estimates). SCQ's normalized `CommercialEffect` avoided depending on one provider-specific preview shape.

**Confidence: LIVE CONFIRMED.**

### 3. Term-end scheduling

`end_of_term=true` held a future item change separately from live subscription state; the pending change could be retrieved and removed.

**Confidence: LIVE CONFIRMED.**

Arbitrary-date `effective_from` support has less evidence in this project than term-end scheduling and should be described as **verified once / limited live evidence**, not exhaustively validated.

### 4. Evergreen cancellation

Cancellation estimates for immediate and end-of-term behavior matched observed commit semantics for the tested evergreen subscription.

**Confidence: LIVE CONFIRMED for evergreen subscriptions.**

### 5. Committed-term cancellation

The test site did not have Chargebee Contract Terms enabled. Attempting to create a contract-term subscription returned a provider error requiring the feature to be enabled.

No live evidence was obtained for early-termination consequences under a committed Chargebee contract term.

**Confidence: UNVERIFIED.**

SCQ therefore reports committed-term cancellation `termEffect: UNKNOWN` for Chargebee rather than retaining the simulator's earlier `EXACT` claim.

### 6. No server-enforced compare-and-swap on tested update path

A stale `If-Match` header attached to `update_for_items` was ignored; the request returned success and overwrote a genuine out-of-band mutation without a conflict signal.

Chargebee's observed `resource_version` corresponded to update-time information at millisecond precision rather than an independent compare-and-swap token.

**Confidence: LIVE CONFIRMED for the tested endpoint behavior.**

### 7. Quantity + plan multi-change

A combined quantity/plan update was estimated and committed in one request, with matching totals and a single observed resource-version change.

**Confidence: LIVE CONFIRMED for the tested pair.**

### 8. Cancellation + another mutation can fail dangerously

Malformed attempts to combine cancellation semantics with another change did **not** reliably fail as a request. The provider could return HTTP 200 while applying only the recognized part and ignoring the other part.

This is the strongest live motivation for SCQ's rule that an adapter must refuse a change set before mutation if its provider request shape risks silent subset application.

**Confidence: LIVE CONFIRMED.**

## Stripe evidence

The Stripe adapter is documentation-grounded and simulated; it was not live-tested in this project.

The research model demonstrates why a pinned time basis can make modeled proration repeatable while `REVALIDATE` remains the portable fallback. Tax, discounts, currency conversion, and other effects outside SCQ's modeled `CommercialEffect` are not covered by an `EXACT` claim merely because proration timing can be pinned.

**Confidence: DOCUMENTATION-BACKED SIMULATION, not live API validation.**

## Paddle evidence

The Paddle adapter is documentation-grounded and simulated; it was not live-tested in this project.

The model treats proration-bearing changes as requiring `REVALIDATE` where no provider mechanism is available to replay the exact quote-time time basis.

**Confidence: DOCUMENTATION-BACKED SIMULATION.**

## Zuora evidence

The Zuora adapter is documentation-grounded and simulated; it was not live-tested in this project.

The model exercises a materially different billing architecture: orders, a native version field, explicit effective dates, contract terms, and atomic multi-action orders. The strongest portability result is that SCQ's reporting vocabulary could represent these richer semantics without replacing its core lifecycle.

The model also shows that a stronger version field improves stale-state detection but does not by itself produce atomic compare-and-swap mutation.

**Confidence: DOCUMENTATION-BACKED SIMULATION; atomicity conclusion is documentation-backed/inferred, not live-verified.**

## Protocol-level evidence

The v0.6 freeze candidate had 54 passing tests. The subsequent v0.6.1 hardening cycle reports **66 passing tests**, adding coverage for reconciliation, expiration, quote-level commit idempotency, direct partial-execution enforcement, and Paddle multi-change behavior.

The test suite is strongest as evidence that the normalized contract is internally coherent across the four adapter models. It is not a substitute for live integration testing on every provider.

## What the evidence does not prove

SCQ does not yet prove:

- real Chargebee committed-term cancellation semantics;
- live Stripe, Paddle, or Zuora conformance;
- a provider with `ConsistencyGuarantee: ATOMIC`;
- per-change effective timing inside one multi-change proposal;
- cross-quote semantic deduplication;
- automatic rollback after post-commit reconciliation violation;
- exhaustive behavior for provider tax, discount, foreign-exchange, entitlement, or external contract systems.

These are explicit boundaries, not hidden assumptions.

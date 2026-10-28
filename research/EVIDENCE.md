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
| Chargebee | **Limited historical live test-site observations (v0.5-LIVE, prior cycle) + simulator** | Estimate/commit agreement for ONE tested configuration; scheduling via mechanisms since deprecated in current docs; resource-version behavior; absence of atomic conditional write in tested path; multi-change behavior; live silent partial-application hazard. NOT a validation of the current adapters — see the Phase 2A note below. |

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

The v0.6 freeze candidate had 54 passing tests. The subsequent v0.6.1 hardening cycle reported **66 passing tests** (that cycle's count), adding coverage for reconciliation, expiration, quote-level commit idempotency, direct partial-execution enforcement, and Paddle multi-change behavior. The Chargebee live-validation experiment later added 18 mocked-transport tests on the unpublished combined branch (84 total there; the suite in Change A remains 66); none of those tests is a live API test.

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

## Phase 2A correction note (2026-10-27) — read before citing the Chargebee rows above

The live observations in this register are **historical**: they were made in the
v0.5-LIVE cycle against one test site, before the current adapters existed in
their present form, and only a limited set of Chargebee behaviors was ever
exercised against a real API. Phase 2A re-audited every Chargebee claim in this
repository against the current Product Catalog 2.0 documentation
(`research/chargebee-live-v1/API-CONTRACT-AUDIT.md`) and corrected the
simulator-backed adapter and its tests. Consequences for citing this register:

- Item 1 ($840 estimate/commit agreement) is a **single observation for one
  configuration**. It does NOT establish EXACT financial coverage: no
  estimate-pinning/replay mechanism is documented for the estimate→update
  pair, so both Chargebee adapters now report REVALIDATE for the financial
  dimensions. (Language discipline: the pinning mechanism is NOT ESTABLISHED
  in the documented contract — that is not a claim that no equivalent
  mechanism exists anywhere.)
- Item 3 (term-end scheduling) was observed via `end_of_term`, which current
  documentation marks **deprecated** in favor of Ramps (Early Access).
  "Deprecated but functional when last tested" is the accurate status.
  Arbitrary-date scheduling was never exhaustively validated and the
  `effective_from`-on-`update_for_items` attribution formerly made for it is
  **not established** — `effective_from` is documented as a Create-a-ramp
  parameter. The simulator-backed adapter now refuses DATE, and refuses
  TERM_END for update-backed actions (TERM_END for CANCEL is retained as
  deprecated-but-documented + historically observed).
- Items 2, 4, 6, 7, 8 stand as historical observations of the tested
  configurations/endpoint behavior only. Item 5 (committed-term CANCEL)
  remains UNVERIFIED.
- No live evidence was added by the Phase 1 live-validation run or by
  Phase 2A: all live cases in both were BLOCKED (no credentials). Evidence
  labels: only the v0.5-LIVE items above are historical-live; everything in
  `research/chargebee-live-v1/` from those runs is SIMULATED,
  DOCUMENTATION_SUPPORTED, or BLOCKED — never LIVE_* for those runs.
- Full per-claim record: `research/chargebee-live-v1/CLAIM-CORRECTION-MATRIX.md`.

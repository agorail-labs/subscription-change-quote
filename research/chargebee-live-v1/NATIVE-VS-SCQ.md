# Phase 3 — Native Chargebee vs SCQ, and Phase 6 Assessment

Scenario (identical for both): an **active monthly SaaS subscription, 100 seats →
120 seats, effective intent IMMEDIATE**, zero-tolerance caller tolerance for drift
(envelope: no immediate-net increase, no credit decrease, no recurring increase beyond
what is quoted). Synthetic test-site subscription; amounts in minor units; seat price
1000/mo → quoted immediate net +20000 (full-period proration in the mock; real
proration is fraction-of-term — the comparison is about structure, not the fraction),
recurring 100000 → 120000 USD.

## Implementation A — Chargebee native (done properly, not a strawman)

A competent native integration, using only documented APIs and ordinary safeguards:

1. `GET /subscriptions/{id}` — snapshot; record `resource_version`.
2. `POST /estimates/update_subscription_for_items` with the full item list,
   `replace_items_list=true`, `prorate=true`, `invoice_immediately=false` — preview.
   Read `invoice_estimate.total` (or unbilled/credit-note members when present) and
   compute recurring from `subscription_estimate.subscription_items`.
3. Application check: preview within the caller's tolerance; `resource_version`
   unchanged on a re-read (stale check).
4. `POST /subscriptions/{id}/update_for_items` — same parameters, header
   `chargebee-idempotency-key: <uuid>`; on a lost response, retry the **same** key +
   parameters within 30 minutes, or re-read state before doing anything else.
5. Re-read the subscription and the returned invoice/unbilled charges; compare against
   the preview; alert on mismatch.

Provider calls: **4–5** (read, estimate, re-read, update, re-read). Every safeguard in
steps 3–5 is *application code the integrator must invent and maintain themselves* —
Chargebee provides the primitives, not the composition.

## Implementation B — SCQ (live adapter, this experiment)

1. `adapter.getSubscription(id)` → normalized snapshot (same GET).
2. `adapter.createChangeQuote(id, proposal)` → GET + estimate; returns a quote with
   provider-neutral `CommercialEffect`, quote-level `GuaranteeCoverage`
   (REVALIDATE/REVALIDATE/UNKNOWN/REVALIDATE), `validUntil` (5 min), precondition
   fingerprint (`rv:<resource_version>`), and scheduled-change warnings.
3. `adapter.commitChangeQuote(quoteId)` → receipt replay check → GET (staleness) →
   estimate (envelope vs **last pre-mutation preview**) → update (only if live commit
   enabled; `replace_items_list=true`, `invoice_immediately=false`, idempotency key
   derived from the quote id) → GET (post-commit reconciliation) → receipt carrying
   `quotedEffect`, `committedEffect`, and `reconciliation`.

Provider calls: **5** (read, estimate, read, estimate, update, read = 6 HTTP calls
counting the initial snapshot read separately; the quote/commit pair itself is 5).
SCQ costs roughly **one extra estimate + one extra read** versus the disciplined
native flow. It does not reduce call count.

## Side-by-side

| Dimension | Native (disciplined) | SCQ live adapter | Where the value actually comes from |
|---|---|---|---|
| Previewed immediate effect | `invoice_estimate.total` etc., shape varies by case (audit A4) | Normalized `CommercialEffect.immediate.net` | Chargebee primitive (estimate) + SCQ normalization of its conditional shape |
| Recurring amount / currency | Must be computed from item amounts; no authoritative total field | Normalized `recurring.resultingAmount` + currency | SCQ normalization over a genuine provider gap |
| Quote validity | None natively — the integrator picks a TTL | `validUntil`, QUOTE_EXPIRED for uncommitted quotes, replay exempt for committed ones | **SCQ contract** |
| Stale-state handling | `resource_version` comparison — integrator-written | Fingerprint precondition, QUOTE_STALE before mutation | Chargebee primitive (`resource_version`) + SCQ composition |
| Guarantee strength | Implicit; whatever the integrator believes | Explicit per-dimension coverage; EXACT refused honestly (live adapter), UNKNOWN for term | **SCQ contract** (and, vs the simulator adapter, a *correction*) |
| Acceptance envelope | Integrator-written comparison | Declared envelope enforced against last pre-mutation preview, QUOTE_DRIFTED before mutation | **SCQ contract** (reusable, tested) |
| Idempotency | Native key, 30-min window, 422/409/5xx-cache semantics | Same native key (quote-derived) **plus** quote-level receipt replay with no 30-min limit, checked before any provider read | Chargebee primitive for the mutation; **SCQ** for receipt semantics beyond the window |
| Lost response | Retry same key ≤30 min, else reconcile manually | Indeterminate classification → reconcile-by-read → recover or fail closed; never blind re-mutation (T07) | SCQ composition of native primitives |
| Post-commit reconciliation | Integrator-written | Required by spec §6.11; receipt `reconciliation` VIOLATED reported, mutation not hidden (T08/T09) | **SCQ contract** |
| Unknown contractual effects | Silent unless the integrator knows to ask | `termEffect: UNKNOWN` is a first-class, refusal-triggering value | **SCQ contract** |
| Provider cannot give the requested guarantee | Discovered at runtime, if at all | Refused at quote time, naming the failing dimension | **SCQ contract** |
| Concurrency (TOCTOU) | Unclosable natively (no CAS) | Unclosable; honestly reported BEST_EFFORT | Neither — shared limitation |
| Durable exactly-once | Not provided (30-min window) | Not provided by the in-memory store (T13) | Neither — requires a durable store |

## Phase 6 — Objective assessment

### A. What Chargebee already solves (no SCQ needed)

- Non-mutating preview (estimate family) with immediate/next-invoice/credit-note/
  unbilled member objects.
- The mutating update itself, including full-list replacement semantics
  (`replace_items_list`), proration, and unbilled-charge deferral
  (`invoice_immediately=false`).
- Native idempotency for POSTs: 30-minute replay window, replay signaling, parameter-
  mismatch 422, in-flight 409 + `retry-after`.
- A monotonic-enough change timestamp (`resource_version`) sufficient for stale-state
  detection and webhook ordering.
- Scheduling (with caveats: deprecated update paths; Ramps in early access).

A disciplined integrator gets a *safe-enough single-provider integration* from these
primitives alone. SCQ is not necessary for that.

### B. What SCQ genuinely adds (with evidence from this run)

1. **A reusable, tested composition of those primitives into a quote→commit contract**
   — TTL/expiry, precondition, envelope-against-last-preview, receipt replay,
   post-commit reconciliation — that a native integrator would otherwise re-invent
   per integration. Evidence: T02–T13 pass against the documented wire shape, and the
   same engine/store code already serves four provider models in the baseline suite.
2. **Honest, machine-readable guarantee reporting.** The live adapter's refusal of
   EXACT (naming `immediateFinancialEffect`) and its UNKNOWN termEffect are behaviors
   no native API surface provides. Evidence: T02, T11, T14; audit A8.
3. **Normalization over real provider shape variance** (conditional estimate members,
   computed recurring total). Evidence: audit A3/A4; T01–T03.
4. **Receipt-level idempotency semantics beyond the native window**, including replay
   after out-of-band drift and after expiry. Evidence: T06 (+ baseline Tests 12f/12g
   on other adapters). Bounded by store durability — see C.
5. **A vocabulary for "we cannot know"** (UNKNOWN, UNSUPPORTED_*, reconciliation
   VIOLATED) that keeps an autonomous caller from treating HTTP 200 as semantic
   success — the exact failure the historical live cycle observed with silent
   partial application. Evidence: T09, T10; EVIDENCE.md item 8 (historical).

### C. What SCQ does not solve

- The TOCTOU race: no CAS exists; BEST_EFFORT is a label, not a fix (T08).
- Durable exactly-once: in-memory QuoteStore + 30-min native window leave a real gap
  across restarts and long retries (T13). Requires a durable transactional store and
  a deliberate key-retention policy — neither is in v0.6.1.
- Authorization / absolute spending control: the envelope is quote-relative drift
  tolerance, not a spending cap or an authorization grant (spec security §5, §14).
- Unmodeled money: taxes (conditionally computed), discounts/coupons, balances,
  currency conversion, the prorate-caveat interaction between sequential changes.
- Contract-term semantics: committed-term CANCEL remains UNVERIFIED; term reset
  behavior is documented but not modeled.
- Site-configuration variance: identical calls behave differently across sites
  (defaults, gated features); SCQ capabilities are not site-scoped.
- Scheduling: current Chargebee scheduling is deprecated-path or early-access Ramps;
  SCQ's TERM_END/DATE claims for Chargebee could not be validated and are refused by
  the live adapter.

### D. What would require a second provider

Every portability claim. With Chargebee alone this run can show the contract *fits*
one provider's documented shape and that its honest-reporting machinery catches real
Chargebee-specific hazards. It cannot show that the same contract is *easier or safer
than the next provider's native model*, that GuaranteeCoverage comparisons across
providers are meaningful in practice, or that the envelope/replay/reconciliation
composition survives a provider with a genuinely different mutation model (e.g.
Zuora orders or Stripe's proration_date pinning) against a live API. The other three
adapters remain documentation-backed simulations.

### E. Recommendation — **NARROW_SCOPE**

Some value is demonstrated (B1–B5), but current claims exceed the evidence in specific,
ranked ways (LIMITATIONS-AND-GAPS.md D-1…D-7): the simulator adapter's EXACT financial
coverage for Chargebee is not supported by the current documented contract; TERM_END/
DATE support rests on deprecated or early-access mechanisms; and no live evidence was
added by this run (all live cases BLOCKED). *(Phase 1 statement.
Phase 3 (2026-10-27) later added live READ/ESTIMATE evidence only
— L-GET and L-QUOTE LIVE_PASS; no commit was ever exercised live,
so the NARROW_SCOPE recommendation and the commit-side reasoning
are unchanged.)* Narrowing the Chargebee claims to what the
live adapter honestly reports — REVALIDATE financials, UNKNOWN term, IMMEDIATE-only
until Ramps is implemented and validated — matches the evidence. PROCEED_TO_SECOND_
PROVIDER would be premature until D-1/D-2 are resolved, because a second provider
would inherit the same overstated-claim pattern. No normative spec change is proposed
by this experiment (that would require the PROPOSE_SPEC_CHANGE path with separate
approval); the narrowing can be executed as adapter-level claim corrections and
documentation updates first.
